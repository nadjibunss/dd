const { Telegraf } = require("telegraf")
const fs = require("fs")
const path = require("path")
const pino = require("pino")
const fetch = require("node-fetch")
const FormData = require("form-data");
const axios = require("axios");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay,
  WAMessageStubType
} = require("@whiskeysockets/baileys")

const config = require("./config")

const bot = new Telegraf(config.botToken)

const activeSessions = new Map();
const sessionUsers = new Map();

// Verifikasi grup dihapus

// ✅ State tracking untuk autodesc
const waitingForAutodescInput = new Map(); // userId -> true

// ✅ State tracking untuk autosampul (menunggu foto)
const waitingForAutosampulPhoto = new Map(); // userId -> true

// ✅ State tracking untuk bio1, bio2, bio3
const waitingForBio1Input = new Map(); // userId -> true (nunggu nomor)
const waitingForBio2Input = new Map(); // userId -> true (nunggu nomor per baris)
const waitingForBio3Input = new Map(); // userId -> true (nunggu file)

// ✅ State tracking untuk kick member
const waitingForKickMemberLink = new Map(); // userId -> true (nunggu link grup)

// ✅ State tracking untuk auto backup
let needBackup = false; // flag perlu backup
let lastBackupTime = 0; // timestamp backup terakhir
let backupTimeout = null; // timeout scheduler
let changesLog = {
  newUsers: [],
  newPremiums: [],
  expiredPremiums: [],
  removedPremiums: []
};
const BACKUP_COOLDOWN = 60000; // 1 menit dalam ms

const userQueues = new Map();
const processingUsers = new Set();
const callbackQueryQueue = new Map();
const userFastMode = new Map();
const userOtherSpeed = new Map(); // ✅ Untuk mengatur kecepatan listgrup, autodesc, autoresetlink, autosampul

// Runtime tracking
const botStartTime = Date.now();

let sessionData = {}; // ✅ wajib supaya deleteSessionData tidak error

// ==================== FUNGSI HELPER SESSION ====================

// ✅ PERBAIKAN: Fungsi untuk mendapatkan session user dari getpairing
function getUserWASession(userId) {
  const userSessionId = `user_${userId}`;
  const userSession = activeSessions.get(userSessionId);
  
  if (!userSession) {
    return null;
  }
  
  if (!userSession.socket) {
    return null;
  }
  
  return userSession.socket;
}

// ✅ Cek apakah user punya session aktif dari getpairing
function hasUserWASession(userId) {
  return getUserWASession(userId) !== null;
}

// ✅ Fungsi untuk mendapatkan speed settings untuk fitur lainnya
function getOtherSpeedSettings(userId) {
  const speed = userOtherSpeed.get(userId) || "normal";
  
  if (speed === "fast") {
    return {
      batchSize: 8,
      delay: 2000
    };
  } else if (speed === "ultrafast") {
    return {
      batchSize: 8,
      delay: 1000
    };
  } else { // normal
    return {
      batchSize: 5,
      delay: 2500
    };
  }
}

// Fungsi untuk menghitung runtime bot
function getRuntime() {
  const now = Date.now();
  const diff = now - botStartTime;
  
  const totalSeconds = Math.floor(diff / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  return `${hours}h ${minutes}m ${seconds}s`;
}

// Queue system untuk callback queries
function addCallbackToQueue(userId, task) {
  if (!callbackQueryQueue.has(userId)) {
    callbackQueryQueue.set(userId, []);
  }
  callbackQueryQueue.get(userId).push(task);
  processCallbackQueue(userId);
}

async function processCallbackQueue(userId) {
  if (!callbackQueryQueue.has(userId) || callbackQueryQueue.get(userId).length === 0) {
    return;
  }
  
  const task = callbackQueryQueue.get(userId).shift();
  
  try {
    await task();
  } catch (error) {
    console.error(`Callback error for user ${userId}:`, error);
  } finally {
    if (callbackQueryQueue.get(userId).length > 0) {
      setImmediate(() => processCallbackQueue(userId));
    }
  }
}

function addToQueue(userId, task) {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, []);
  }
  userQueues.get(userId).push(task);
  processQueue(userId);
}

async function processQueue(userId) {
  if (processingUsers.has(userId) || !userQueues.has(userId) || userQueues.get(userId).length === 0) {
    return;
  }

  processingUsers.add(userId);
  const task = userQueues.get(userId).shift();

  try {
    await task();
  } catch (error) {
    console.error(`Queue error for user ${userId}:`, error);
  } finally {
    processingUsers.delete(userId);
    if (userQueues.has(userId) && userQueues.get(userId).length > 0) {
      setImmediate(() => processQueue(userId));
    }
  }
}

const usersFile = path.join(__dirname, "users.json");

let usersDb = {};          // object: { "id": { premiumUntil: number, ... } }
let allUsers = new Set();  // untuk total user

function loadUsersDb() {
  try {
    if (!fs.existsSync(usersFile)) {
      usersDb = {};
      allUsers = new Set();
      return;
    }

    const raw = fs.readFileSync(usersFile, "utf8").trim();
    if (!raw) {
      usersDb = {};
      allUsers = new Set();
      return;
    }

    const parsed = JSON.parse(raw);

    // support file lama: [id1,id2,...]
    if (Array.isArray(parsed)) {
      usersDb = {};
      for (const id of parsed) {
        const k = String(id);
        usersDb[k] = { premiumUntil: 0, firstSeen: Date.now(), lastSeen: Date.now() };
      }
    } else if (parsed && typeof parsed === "object") {
      usersDb = parsed;

      // ✅ pastikan settings tetap settings, jangan ketimpa jadi format user
      usersDb[SETTINGS_KEY] = (usersDb[SETTINGS_KEY] && typeof usersDb[SETTINGS_KEY] === "object")
        ? usersDb[SETTINGS_KEY]
        : {};

      // ✅ normalisasi HANYA untuk userId, skip __settings__
      for (const k of Object.keys(usersDb)) {
        if (k === SETTINGS_KEY) continue;

        const u = usersDb[k] || {};
        usersDb[k] = {
          premiumUntil: Number(u.premiumUntil || 0),
          firstSeen: Number(u.firstSeen || Date.now()),
          lastSeen: Number(u.lastSeen || Date.now()),
        };
      }
    } else {
      usersDb = {};
    }

    // ✅ allUsers jangan masukin __settings__
    allUsers = new Set(Object.keys(usersDb).filter(k => k !== SETTINGS_KEY));
  } catch (e) {
    console.error("loadUsersDb error:", e);
    usersDb = {};
    allUsers = new Set();
  }
}

// ==================== FIX BIO1 UNTUK FREE USER ====================

// Tambahkan fungsi getter untuk limit bio1 (di bagian SETTINGS_KEY)
function getFreeBio1Limit() {
  const s = usersDb[SETTINGS_KEY] || {};
  return Number(s.freeBio1Limit) > 0 ? Number(s.freeBio1Limit) : 100; // default 100
}

function setFreeBio1Limit(limit) {
  usersDb[SETTINGS_KEY] = usersDb[SETTINGS_KEY] || {};
  usersDb[SETTINGS_KEY].freeBio1Limit = Number(limit);
  saveUsersDb();
}


function saveUsersDb() {
  try {
    fs.writeFileSync(usersFile, JSON.stringify(usersDb, null, 2));
  } catch (e) {
    console.error("saveUsersDb error:", e);
  }
}

// ✅ FUNGSI AUTO BACKUP USERS.JSON KE OWNER
async function triggerBackup(type, userId) {
  needBackup = true;
  
  // Log perubahan berdasarkan tipe
  if (type === 'new_user' && userId) {
    if (!changesLog.newUsers.includes(userId)) {
      changesLog.newUsers.push(userId);
    }
  } else if (type === 'new_premium' && userId) {
    if (!changesLog.newPremiums.includes(userId)) {
      changesLog.newPremiums.push(userId);
    }
  } else if (type === 'expired_premium' && userId) {
    if (!changesLog.expiredPremiums.includes(userId)) {
      changesLog.expiredPremiums.push(userId);
    }
  } else if (type === 'removed_premium' && userId) {
    if (!changesLog.removedPremiums.includes(userId)) {
      changesLog.removedPremiums.push(userId);
    }
  }
  
  const now = Date.now();
  const timeSinceLastBackup = now - lastBackupTime;
  
  // Jika sudah lewat cooldown, backup langsung
  if (timeSinceLastBackup >= BACKUP_COOLDOWN) {
    await doBackup();
  } else {
    // Jika belum, schedule backup setelah cooldown
    if (!backupTimeout) {
      const remainingTime = BACKUP_COOLDOWN - timeSinceLastBackup;
      backupTimeout = setTimeout(async () => {
        await doBackup();
        backupTimeout = null;
      }, remainingTime);
      
      console.log(`⏰ Backup dijadwalkan dalam ${Math.ceil(remainingTime / 1000)} detik`);
    }
  }
}

async function doBackup() {
  if (!needBackup) return;
  
  try {
    needBackup = false;
    lastBackupTime = Date.now();
    
    // Buat caption detail
    let caption = "📊 *AUTO BACKUP - Users.json*\n\n";
    
    // Detail perubahan
    const totalChanges = changesLog.newUsers.length + 
                        changesLog.newPremiums.length + 
                        changesLog.expiredPremiums.length + 
                        changesLog.removedPremiums.length;
    
    if (totalChanges > 0) {
      caption += "🔔 *Perubahan terdeteksi:*\n";
      
      if (changesLog.newUsers.length > 0) {
        caption += `• ${changesLog.newUsers.length} User baru\n`;
      }
      if (changesLog.newPremiums.length > 0) {
        caption += `• ${changesLog.newPremiums.length} Premium baru\n`;
      }
      if (changesLog.expiredPremiums.length > 0) {
        caption += `• ${changesLog.expiredPremiums.length} Premium expired\n`;
      }
      if (changesLog.removedPremiums.length > 0) {
        caption += `• ${changesLog.removedPremiums.length} Premium dihapus\n`;
      }
      caption += "\n";
    }
    
    // Statistik total
    const totalUsers = allUsers.size;
    let totalPremium = 0;
    const now = Date.now();
    
    for (const userId of allUsers) {
      const u = usersDb[userId];
      if (u && u.premiumUntil && u.premiumUntil > now) {
        totalPremium++;
      }
    }
    
    const totalFree = totalUsers - totalPremium;
    
    caption += "📊 *STATISTIK:*\n";
    caption += `👥 Total User: ${totalUsers}\n`;
    caption += `💎 Total Premium: ${totalPremium}\n`;
    caption += `🆓 Total Free: ${totalFree}\n\n`;
    
    // Timestamp
    caption += `⏰ Backup: ${formatDateID(Date.now())}\n`;
    
    // Ukuran file
    const stats = fs.statSync(usersFile);
    const fileSizeKB = (stats.size / 1024).toFixed(2);
    caption += `💾 File: users.json (${fileSizeKB} KB)`;
    
    // Kirim file ke owner
    await bot.telegram.sendDocument(
      config.ownerId,
      { source: usersFile, filename: `users_backup_${Date.now()}.json` },
      { 
        caption: caption,
        parse_mode: "Markdown"
      }
    );
    
    console.log("✅ Backup berhasil dikirim ke owner!");
    
    // Reset changes log
    changesLog = {
      newUsers: [],
      newPremiums: [],
      expiredPremiums: [],
      removedPremiums: []
    };
    
  } catch (error) {
    console.error("❌ Error saat backup:", error);
    // Jika gagal, reset flag agar bisa retry
    needBackup = true;
  }
}

const SETTINGS_KEY = "__settings__";

function getFreeBio2Limit() {
  const s = usersDb[SETTINGS_KEY] || {};
  return Number(s.freeBio2Limit) > 0 ? Number(s.freeBio2Limit) : 150; // default 150
}

function setFreeBio2Limit(limit) {
  usersDb[SETTINGS_KEY] = usersDb[SETTINGS_KEY] || {};
  usersDb[SETTINGS_KEY].freeBio2Limit = Number(limit);
  saveUsersDb(); // ✅ simpan OBJECT usersDb (settings ikut tersimpan)
}



function touchUser(userId) {
  const k = String(userId);
  let isNewUser = false;
  
  if (!usersDb[k]) {
    usersDb[k] = { premiumUntil: 0, firstSeen: Date.now(), lastSeen: Date.now() };
    isNewUser = true;
  }
  usersDb[k].lastSeen = Date.now();
  allUsers.add(k);
  saveUsersDb();
  
  // ✅ Trigger backup jika user baru
  if (isNewUser) {
    triggerBackup('new_user', k);
  }
  
  return usersDb[k];
}

// EXPIRED dicek saat dipakai
function isPremium(userId) {
  const u = touchUser(userId);
  const now = Date.now();
  if (!u.premiumUntil || u.premiumUntil <= 0) return false;

  if (now >= u.premiumUntil) {
    u.premiumUntil = 0; // auto reset saat user pakai bot
    saveUsersDb();
    
    // ✅ Trigger backup jika premium expired
    triggerBackup('expired_premium', String(userId));
    
    return false;
  }
  return true;
}

function formatRemaining(ms) {
  if (ms <= 0) return "0m";
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return `${d}d ${h}h ${m}m`;
}

const BOT_TZ = "Asia/Jakarta"; // WIB

function formatDateID(ts) {
  try {
    return new Date(ts).toLocaleString("id-ID", {
      timeZone: BOT_TZ,
      hour12: false
    }) + " WIB";
  } catch {
    return String(ts);
  }
}


loadUsersDb();

function parseDurationTokens(tokens) {
  // tokens contoh: ["7d"] atau ["1d","2h","30m"]
  // dukung: d, h, m
  let ms = 0;

  for (const t of tokens) {
    const s = String(t || "").trim().toLowerCase();
    const m = s.match(/^(\d+)\s*([dhm])$/);
    if (!m) continue;

    const val = Number(m[1]);
    const unit = m[2];

    if (unit === "d") ms += val * 24 * 60 * 60 * 1000;
    if (unit === "h") ms += val * 60 * 60 * 1000;
    if (unit === "m") ms += val * 60 * 1000;
  }

  return ms;
}

bot.command("addpremium", async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.reply("❌ Owner only.");

  const args = ctx.message.text.trim().split(/\s+/);
  // /addpremium <id> <durasi...>
  if (args.length < 3) {
    return ctx.reply(
      "❌ Format salah.\n\nContoh:\n/addpremium 6272783 7d\n/addpremium 627727 6h\n/addpremium 6383883 8m\n/addpremium 123 1d 2h 30m"
    );
  }

  const targetId = String(args[1]);
  if (!/^\d+$/.test(targetId)) return ctx.reply("❌ User ID harus angka.");

  const durationTokens = args.slice(2);
  const addMs = parseDurationTokens(durationTokens);

  if (addMs <= 0) {
    return ctx.reply(
      "❌ Durasi tidak valid.\nGunakan: 7d / 6h / 8m atau gabungan: 1d 2h 30m"
    );
  }

  // extend dari yang masih aktif, kalau expired mulai dari sekarang
  const now = Date.now();
  const u = touchUser(targetId);
  const base = (u.premiumUntil && u.premiumUntil > now) ? u.premiumUntil : now;

  u.premiumUntil = base + addMs;
  saveUsersDb();
  
  // ✅ Trigger backup untuk premium baru
  triggerBackup('new_premium', targetId);

  return ctx.reply(
    `✅ Premium ditambahkan!\n\n` +
    `👤 ID: ${targetId}\n` +
    `⏳ Ditambah: ${durationTokens.join(" ")}\n` +
    `📌 Expired: ${formatDateID(u.premiumUntil)}\n` +
    `🕒 Sisa: ${formatRemaining(u.premiumUntil - Date.now())}`
  );
});

bot.command("delpremium", async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.reply("❌ Owner only.");

  const args = ctx.message.text.trim().split(/\s+/);
  // /delpremium <id>
  if (args.length < 2) {
    return ctx.reply(
      "❌ Format salah.\n\nContoh:\n/delpremium 6272783"
    );
  }

  const targetId = String(args[1]);
  if (!/^\d+$/.test(targetId)) return ctx.reply("❌ User ID harus angka.");

  const u = usersDb[targetId];
  
  if (!u) {
    return ctx.reply("❌ User tidak ditemukan di database.");
  }
  
  if (!u.premiumUntil || u.premiumUntil <= 0) {
    return ctx.reply("❌ User ini bukan premium.");
  }

  // Hapus premium
  u.premiumUntil = 0;
  saveUsersDb();
  
  // ✅ Trigger backup untuk premium dihapus
  triggerBackup('removed_premium', targetId);

  return ctx.reply(
    `✅ Premium dihapus!\n\n` +
    `👤 ID: ${targetId}\n` +
    `📌 Status: Free User`
  );
});


function saveUsers() {
  // ✅ biar kompatibel: kalau ada kode lama masih manggil saveUsers(),
  // tetap nyimpan usersDb (termasuk __settings__ dan premium data)
  saveUsersDb();
}

function saveSessions() { 
  fs.writeFileSync(sessionsFile, JSON.stringify(sessionData, null, 2)) 
}

function saveVerifiedUsers() {
  fs.writeFileSync(verifiedUsersFile, JSON.stringify([...verifiedUsers], null, 2))
}

async function checkUserInGroup(userId) {
    try {
        const member = await bot.telegram.getChatMember(config.groupChatId, userId);
        const isMember = member.status !== "left" && member.status !== "kicked";
        
        if (isMember) {
            if (!verifiedUsers.has(userId)) {
                verifiedUsers.add(userId);
                saveVerifiedUsers();
            }
        } else {
            if (verifiedUsers.has(userId)) {
                verifiedUsers.delete(userId);
                saveVerifiedUsers();
            }
        }
        
        return isMember;
    } catch (error) {
        console.error("Error checking group membership:", error);
        // Jika error, cek dari verifiedUsers cache
        return verifiedUsers.has(userId);
    }
}

async function isVerified(userId) {
  // owner selalu lolos
  if (String(userId) === String(config.ownerId)) return true;

  // kalau verifikasi OFF
  if (!config.enableVerification) return true;

  // cache
  if (verifiedUsers.has(userId)) return true;

  try {
    const member = await bot.telegram.getChatMember(
      config.verificationGroupId,
      userId
    );

    if (["member", "administrator", "creator"].includes(member.status)) {
      verifiedUsers.add(userId);
      return true;
    }

    return false;
  } catch (e) {
    return false;
  }
}

// Command owner untuk set limit bio1
bot.command("setbio1limit", async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.reply("❌ Owner only.");

  const limit = parseInt((ctx.message.text || "").split(/\s+/)[1], 10);
  if (!Number.isFinite(limit) || limit < 1) {
    return ctx.reply("❌ Format salah.\nContoh: /setbio1limit 100");
  }

  setFreeBio1Limit(limit);
  return ctx.reply(`✅ Bio1 limit tersimpan.\n• freeBio1Limit : ${getFreeBio1Limit()}`);
});



bot.command("setfreelimit", async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.reply("❌ Owner only.");

  const limit = parseInt((ctx.message.text || "").split(/\s+/)[1], 10);
  if (!Number.isFinite(limit) || limit < 1) {
    return ctx.reply("❌ Format salah.\nContoh: /setfreelimit 150");
  }

  setFreeBio2Limit(limit);
  return ctx.reply(`✅ Free limit tersimpan.\n• freeBio2Limit : ${getFreeBio2Limit()}`);
});


async function requireVerification(ctx, next) {
    const userId = ctx.from.id;
    
    if (!(await isVerified(userId))) {
        await sendVerificationMessage(ctx);
        return;
    }
    
    return next();
}

function checkUserWAConnection(userId) {
  const userSessionId = `user_${userId}`;
  const userSession = activeSessions.get(userSessionId);
  
  if (!userSession) {
    return false;
  }
  
  if (!userSession.socket.user) {
    return false;
  }
  
  return true;
}

// Fungsi untuk mendapatkan session aktif berdasarkan nomor telepon (untuk owner)
function getActiveSessionByPhone(phone) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  
  // Cari session yang terhubung dengan nomor ini
  for (const [sessionId, session] of activeSessions) {
    if (session.socket.user && session.socket.user.id) {
      const sessionPhone = session.socket.user.id.replace(/:\d+@s\.whatsapp\.net$/, '');
      if (sessionPhone === cleanPhone) {
        return session.socket;
      }
    }
  }
  
  return null;
}

// Fungsi untuk mendapatkan daftar session aktif dengan nomor telepon
function getActiveSessionsList() {
  const sessions = [];
  
  for (const [sessionId, session] of activeSessions) {
    if (session.socket.user && session.socket.user.id) {
      const phone = session.socket.user.id.replace(/:\d+@s\.whatsapp\.net$/, '');
      const userId = session.userId || 'Unknown';
      sessions.push({
        phone: phone,
        userId: userId,
        sessionId: sessionId,
        connectedAt: session.connectedAt
      });
    }
  }
  
  return sessions;
}

async function restoreUserSessions() {
  const sessionEntries = Object.entries(sessionData);
  
  for (const [phone, data] of sessionEntries) {
    if (data.sessionId && data.userId && data.sessionId.startsWith('user_')) {
      try {
        const sessionDir = `./sessions/${data.sessionId}`;
        if (!fs.existsSync(sessionDir)) {
          continue;
        }
        
        const sessionFiles = fs.readdirSync(sessionDir);
        if (sessionFiles.length === 0) {
          continue;
        }
        
        if (data.userId == config.ownerId) {
          await startWA(data.sessionId, data.userId, true);
        } else {
          const userSessionId = `user_${data.userId}`;
          if (data.sessionId === userSessionId) {
            await startWA(data.sessionId, data.userId, true);
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error("Error restoring session:", error);
      }
    }
  }
}

async function startWA(sessionId = "default", userId = null, silentMode = false) {
  const sessionDir = `./sessions/${sessionId}`
  
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    logger: logger,
    printQRInTerminal: false,
    auth: state,
    version,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
    keepAliveIntervalMs: 20000,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    transactionOpts: {
      maxCommitRetries: 5,
      delayBetweenTriesMs: 3000
    },
    retryRequestDelayMs: 250,
    fireInitQueries: true,
    shouldIgnoreJid: jid => false
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    
    if (connection === "open") {
      activeSessions.set(sessionId, {
        socket: sock,
        connectedAt: Date.now(),
        userId: userId
      })
      
      if (userId) {
        const phone = sock.authState.creds.me?.id?.replace(/:\d+@s\.whatsapp\.net$/, '') || 'unknown';
        sessionUsers.set(phone, userId);
        sessionData[phone] = {
          sessionId: sessionId,
          userId: userId,
          phone: phone,
          pairedAt: Date.now(),
          lastConnected: Date.now()
        }
        saveSessions()
      }
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      
      if (statusCode === DisconnectReason.loggedOut) {
        deleteSessionData(sessionId);
      }
      
      activeSessions.delete(sessionId)
      
      const shouldRestart = statusCode !== DisconnectReason.loggedOut
      if (shouldRestart && userId) {
        setTimeout(() => startWA(sessionId, userId, silentMode), 10000)
      }
    }
  })

  return sock
}

function deleteSessionData(sessionId) {
  // ===== GUARD biar tidak ReferenceError =====
  if (typeof sessionData === "undefined" || !sessionData) sessionData = {};
  if (typeof activeSessions === "undefined" || !activeSessions) {
    // kalau activeSessions belum ada, skip
  } else if (activeSessions?.delete) {
    activeSessions.delete(sessionId);
  }
  if (typeof sessionUsers === "undefined" || !sessionUsers) sessionUsers = new Set();
  // =========================================

  let phoneToDelete = null;
  for (const [phone, data] of Object.entries(sessionData)) {
    if (String(data?.sessionId) === String(sessionId)) {
      phoneToDelete = phone;
      break;
    }
  }

  if (phoneToDelete) {
    delete sessionData[phoneToDelete];
    try { sessionUsers.delete(phoneToDelete); } catch (_) {}
    try { saveSessions(); } catch (e) { console.error("saveSessions error:", e); }
  }

  const sessionDir = `./sessions/${sessionId}`;
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (error) {
      console.error("Error deleting session directory:", error);
    }
  }
}


async function deleteUserSession(userId) {
  let deleted = false;

  const userIdStr = String(userId);
  const userSessionId = `user_${userIdStr}`;

  // ===== hapus dari activeSessions =====
  if (activeSessions && typeof activeSessions[Symbol.iterator] === "function") {
    for (const [sessionId, session] of activeSessions) {
      const sessionUserIdStr = String(session?.userId);

      if (sessionUserIdStr === userIdStr && String(sessionId) === userSessionId) {
        try {
          // Baileys kadang beda method, jadi try-catch aman
          if (session?.socket?.logout) await session.socket.logout();
          if (session?.socket?.end) await session.socket.end(new Error("User requested deletion"));
          if (session?.socket?.ws?.close) session.socket.ws.close();
        } catch (error) {
          console.error("Error deleting session:", error);
        }

        try {
          if (typeof deleteSessionData === "function") deleteSessionData(sessionId);
        } catch (e) {
          console.error("deleteSessionData error:", e);
        }

        try {
          if (activeSessions?.delete) activeSessions.delete(sessionId);
        } catch (_) {}

        deleted = true;
        break;
      }
    }
  }

  // ===== hapus dari sessionData (object) =====
  if (sessionData && typeof sessionData === "object" && !sessionData.get) {
    for (const [phone, data] of Object.entries(sessionData)) {
      if (String(data?.userId) === userIdStr && String(data?.sessionId) === userSessionId) {
        delete sessionData[phone];
        try { sessionUsers?.delete?.(phone); } catch (_) {}
        deleted = true;
      }
    }
  }

  // ===== hapus dari sessionData (Map) =====
  if (sessionData && typeof sessionData.get === "function") {
    for (const [phone, data] of sessionData) {
      if (String(data?.userId) === userIdStr && String(data?.sessionId) === userSessionId) {
        sessionData.delete(phone);
        try { sessionUsers?.delete?.(phone); } catch (_) {}
        deleted = true;
      }
    }
  }

  if (deleted) {
    try {
      if (typeof saveSessions === "function") saveSessions();
    } catch (e) {
      console.error("saveSessions error:", e);
    }
  }

  return deleted;
}

function cleanupOldSessions() {
  const now = Date.now()
  const fiveHours = 5 * 60 * 60 * 1000
  const sessionsToDelete = []

  Object.entries(sessionData).forEach(([phone, data]) => {
    const session = activeSessions.get(data.sessionId)
    if (!session && (now - data.pairedAt) > fiveHours) {
      sessionsToDelete.push({phone, sessionId: data.sessionId})
    }
  })

  sessionsToDelete.forEach(({phone, sessionId}) => {
    deleteSessionData(sessionId);
  })
}

setInterval(cleanupOldSessions, 60 * 60 * 1000)

// Fungsi untuk mengekstrak nomor dari teks
function extractNumbersFromText(text) {
  const numbers = [];
  
  // Regex untuk menemukan nomor telepon
  const regex = /\d{8,15}/g;
  const extendedRegex = /(?:\+?\d{1,4}[-.\s]?)?(?:\(?\d{1,4}\)?[-.\s]?)?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
  
  let matches;
  
  matches = text.match(regex);
  if (matches) {
    numbers.push(...matches);
  }
  
  const extendedMatches = text.match(extendedRegex);
  if (extendedMatches) {
    extendedMatches.forEach(match => {
      const cleanNum = match.replace(/\D/g, '');
      if (cleanNum.length >= 8 && cleanNum.length <= 15) {
        if (!numbers.includes(cleanNum)) {
          numbers.push(cleanNum);
        }
      }
    });
  }
  
  const lines = text.split(/[\n,;\t]+/);
  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed) {
      const lineDigits = trimmed.replace(/\D/g, '');
      if (lineDigits.length >= 8 && lineDigits.length <= 15) {
        if (!numbers.includes(lineDigits)) {
          numbers.push(lineDigits);
        }
      }
    }
  });
  
  const uniqueNumbers = [...new Set(numbers)];
  
  return uniqueNumbers;
}



// ENHANCED checkNumbers() - dengan info Meta Verification & Business Details lengkap

// ENHANCED checkNumbers() - dengan info Meta Verification & Business Details lengkap

// ENHANCED checkNumbers() - dengan info Meta Verification & Business Details lengkap

async function checkNumbers(numbers, ctx, userWa) {
  const userId = ctx.from.id;
  const results = {
    withBio: [],
    noBio: [],
    notRegistered: []
  }

  const stats = {
    total: numbers.length,
    registered: 0,
    withBio: 0,
    business: 0,
    verified: 0,
    connectedSocials: 0,
    businessOnly: 0,
    basicMeta: 0,
    verifiedMeta: 0,
    noBioCount: 0,
    withProfilePicture: 0,
    // 🆕 TAMBAHAN STATS META VERIFICATION
    totalMetaVerified: 0,
    totalBusinessWithSocials: 0,
    totalWithEmail: 0,
    totalWithInstagram: 0,
    totalWithFacebook: 0
  }

  if (!numbers || !Array.isArray(numbers)) {
    throw new Error("Format nomor tidak valid");
  }

  const total = numbers.length
  let processed = 0
  
  let progressMsg = await ctx.reply("🔍 *Memproses nomor...*", { parse_mode: "Markdown" });

  const isOwner = (userId == config.ownerId);
  const isFastMode = userFastMode.get(userId) || false;
  
  let batchSize, batchDelay, onWhatsAppTimeout, statusTimeout, businessProfileTimeout, profilePictureTimeout;
  
  if (isOwner) {
    batchSize = 25;
    batchDelay = 10;
    onWhatsAppTimeout = 2000;
    statusTimeout = 1500;
    businessProfileTimeout = 1500;
    profilePictureTimeout = 800;
  } else if (isFastMode) {
    batchSize = 20;
    batchDelay = 30;
    onWhatsAppTimeout = 3000;
    statusTimeout = 2000;
    businessProfileTimeout = 2000;
    profilePictureTimeout = 1000;
  } else {
    batchSize = 15;
    batchDelay = 100;
    onWhatsAppTimeout = 4000;
    statusTimeout = 3000;
    businessProfileTimeout = 3000;
    profilePictureTimeout = 2000;
  }
  
  const totalBatches = Math.ceil(total / batchSize);
  let currentBatch = 0;

  const processSingleNumber = async (num) => {
    try {
      if (!num || typeof num !== 'string') {
        return { type: 'invalid' };
      }
      
      const cleanNum = num.replace(/[^0-9]/g, "").trim()
      if (!cleanNum) {
        return { type: 'invalid' };
      }
      
      const jid = cleanNum + "@s.whatsapp.net"
      
      let user = null;
      try {
        user = await Promise.race([
          userWa.onWhatsApp(jid),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), onWhatsAppTimeout)
          )
        ]);
      } catch (timeoutError) {
        return { 
          type: 'notRegistered', 
          number: `+${cleanNum}` 
        };
      }
      
      if (!user || !Array.isArray(user) || user.length === 0 || !user[0] || !user[0].exists) {
        return { 
          type: 'notRegistered', 
          number: `+${cleanNum}` 
        };
      }

      stats.registered++

      let status = null;
      let businessProfile = null;
      let profilePicture = null;
      
      try {
        [status, businessProfile] = await Promise.all([
          Promise.race([
            userWa.fetchStatus(jid).catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), statusTimeout))
          ]),
          Promise.race([
            userWa.getBusinessProfile(jid).catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), businessProfileTimeout))
          ])
        ]);
        
        if (!isOwner || !isFastMode) {
          profilePicture = await Promise.race([
            userWa.profilePictureUrl(jid).catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), profilePictureTimeout))
          ]);
        }
      } catch (error) {
        console.error("Error checking profile:", error);
      }

      const data = Array.isArray(status) ? status[0] : status;
      
      const isBusiness = user[0]?.isBusiness || false;
      const hasBusinessProfile = businessProfile && Object.keys(businessProfile).length > 0;
      const hasProfilePicture = profilePicture ? true : false;
      
      if (hasProfilePicture) {
        stats.withProfilePicture++;
      }
      
      let isVerified = false;
      let verifiedName = null;
      
      if (data?.verified === true) {
        isVerified = true;
      }
      if (data?.verifiedName) {
        isVerified = true;
        verifiedName = data.verifiedName;
      }
      if (user[0]?.verifiedName) {
        isVerified = true;
        verifiedName = user[0].verifiedName;
      }
      
      const bio = data?.status?.status || null;
      const updateTime = data?.status?.setAt ? new Date(data.status.setAt) : null;

      // 🆕 ENHANCED BUSINESS INFO EXTRACTION
      let businessDetails = {
        email: null,
        website: [],
        instagram: null,
        facebook: null,
        description: null,
        address: null,
        category: null
      };

      let accountType = "👤 Personal";
      let accountDetails = [];
      
      if (businessProfile) {
        // Extract email
        if (businessProfile.email) {
          businessDetails.email = businessProfile.email;
          stats.totalWithEmail++;
          accountDetails.push(`📧 Email: ${businessProfile.email}`);
        }

        // Extract website
        if (businessProfile.website && Array.isArray(businessProfile.website)) {
          businessDetails.website = businessProfile.website;
          if (businessProfile.website.length > 0) {
            accountDetails.push(`🌐 Website: ${businessProfile.website.join(', ')}`);
          }
        }

        // Extract description
        if (businessProfile.description) {
          businessDetails.description = businessProfile.description;
        }

        // Extract address
        if (businessProfile.address) {
          businessDetails.address = businessProfile.address;
          accountDetails.push(`📍 Address: ${businessProfile.address}`);
        }

        // Extract category
        if (businessProfile.category) {
          businessDetails.category = businessProfile.category;
          accountDetails.push(`🏷️ Category: ${businessProfile.category}`);
        }
      }
      
      if (isBusiness || hasBusinessProfile) {
        stats.business++;
        
        if (isVerified) {
          accountType = "✅ Meta Terverifikasi (Business)";
          stats.verified++;
          stats.verifiedMeta++;
          stats.totalMetaVerified++;
        } else {
          accountType = "💼 Akun Bisnis (Basic)";
          stats.businessOnly++;
        }
      } else if (isVerified) {
        stats.verified++;
        stats.verifiedMeta++;
        stats.totalMetaVerified++;
        accountType = "✅ Meta Terverifikasi";
        
        if (verifiedName) {
          accountDetails.push(`🏷️ ${verifiedName}`);
        }
      }
      
      // 🆕 ENHANCED SOCIAL MEDIA DETECTION
      const connectedSocials = [];
      let hasBasicMeta = false;
      
      if (businessProfile) {
        const description = (businessProfile.description || '').toLowerCase();
        const websites = businessProfile.website || [];
        
        // Facebook detection (lebih akurat)
        const facebookPatterns = [
          /facebook\.com\/([a-zA-Z0-9._-]+)/i,
          /fb\.com\/([a-zA-Z0-9._-]+)/i,
          /fb\.me\/([a-zA-Z0-9._-]+)/i,
          /@([a-zA-Z0-9._-]+)\s*facebook/i,
          /facebook\s*:\s*([a-zA-Z0-9._-]+)/i
        ];
        
        let fbUsername = null;
        for (const pattern of facebookPatterns) {
          const descMatch = description.match(pattern);
          if (descMatch) {
            fbUsername = descMatch[1];
            break;
          }
          
          for (const website of websites) {
            const webMatch = website.match(pattern);
            if (webMatch) {
              fbUsername = webMatch[1];
              break;
            }
          }
          if (fbUsername) break;
        }
        
        if (fbUsername || description.includes('facebook') || description.includes('fb page')) {
          businessDetails.facebook = fbUsername || 'Yes (link not found)';
          connectedSocials.push(`Facebook${fbUsername ? `: ${fbUsername}` : ''}`);
          hasBasicMeta = true;
          stats.totalWithFacebook++;
        }
        
        // Instagram detection (lebih akurat)
        const instagramPatterns = [
          /instagram\.com\/([a-zA-Z0-9._]+)/i,
          /instagr\.am\/([a-zA-Z0-9._]+)/i,
          /@([a-zA-Z0-9._]+)\s*instagram/i,
          /ig\s*:\s*@?([a-zA-Z0-9._]+)/i,
          /instagram\s*:\s*@?([a-zA-Z0-9._]+)/i
        ];
        
        let igUsername = null;
        for (const pattern of instagramPatterns) {
          const descMatch = description.match(pattern);
          if (descMatch) {
            igUsername = descMatch[1];
            break;
          }
          
          for (const website of websites) {
            const webMatch = website.match(pattern);
            if (webMatch) {
              igUsername = webMatch[1];
              break;
            }
          }
          if (igUsername) break;
        }
        
        if (igUsername || description.includes('instagram') || description.includes('ig ')) {
          businessDetails.instagram = igUsername || 'Yes (username not found)';
          connectedSocials.push(`Instagram${igUsername ? `: @${igUsername}` : ''}`);
          hasBasicMeta = true;
          stats.totalWithInstagram++;
        }
        
        if (hasBasicMeta && !isVerified && !isBusiness) {
          stats.basicMeta++;
          accountType = "🔗 Basic Meta";
        }
        
        if (connectedSocials.length > 0) {
          accountDetails.push(`🔗 Terhubung: ${connectedSocials.join(', ')}`);
          stats.connectedSocials++;
          stats.totalBusinessWithSocials++;
        }
      }

      let year = "Tidak diketahui";
      if (updateTime && updateTime.getFullYear() > 2000) {
        year = `Tahun ${updateTime.getFullYear()}`;
      }

      let registrationPercent = 75;
      
      if (isBusiness) registrationPercent += 10;
      if (isVerified) registrationPercent += 8;
      if (hasBasicMeta) registrationPercent += 5;
      if (bio) registrationPercent += 7;
      if (hasProfilePicture) registrationPercent += 5;
      if (updateTime && (Date.now() - updateTime.getTime()) < 30 * 24 * 60 * 60 * 1000) {
        registrationPercent += 3;
      }
      
      registrationPercent = Math.min(registrationPercent, 98);
      registrationPercent = Math.max(registrationPercent, 70);

      if (bio) {
        stats.withBio++;
        return {
          type: 'withBio',
          data: {
            number: `+${cleanNum}`,
            bio: bio,
            year: year,
            accountType: accountType,
            accountDetails: accountDetails,
            businessDetails: businessDetails,
            registrationPercent: registrationPercent,
            updateTime: updateTime,
            hasProfilePicture: hasProfilePicture,
            isBusiness: isBusiness,
            isVerified: isVerified,
            hasBasicMeta: hasBasicMeta
          }
        };
      } else {
        stats.noBioCount++;
        return {
          type: 'noBio',
          data: {
            number: `+${cleanNum}`,
            accountType: accountType,
            accountDetails: accountDetails,
            businessDetails: businessDetails,
            registrationPercent: registrationPercent,
            hasProfilePicture: hasProfilePicture,
            isBusiness: isBusiness,
            isVerified: isVerified,
            hasBasicMeta: hasBasicMeta,
            year: year
          }
        };
      }
      
    } catch (err) {
      console.error("Error processing number:", err);
      try {
        const cleanNum = num.replace(/[^0-9]/g, "").trim();
        if (cleanNum) {
          return { 
            type: 'notRegistered', 
            number: `+${cleanNum}` 
          };
        }
      } catch (e) {
        console.error("Error extracting number:", e);
      }
      return { type: 'invalid' };
    }
  };

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, total);
    const batchNumbers = numbers.slice(batchStart, batchEnd);
    
    currentBatch++;
    
    const batchPromises = batchNumbers.map(num => processSingleNumber(num));
    const batchResults = await Promise.allSettled(batchPromises);
    
    batchResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const numberResult = result.value;
        if (numberResult.type === 'withBio') {
          results.withBio.push(numberResult.data);
        } else if (numberResult.type === 'noBio') {
          results.noBio.push(numberResult.data);
        } else if (numberResult.type === 'notRegistered') {
          results.notRegistered.push(numberResult.number || `+${batchNumbers[index]?.replace(/[^0-9]/g, "")?.trim()}`);
        }
      } else {
        const cleanNum = batchNumbers[index]?.replace(/[^0-9]/g, "")?.trim();
        if (cleanNum) {
          results.notRegistered.push(`+${cleanNum}`);
        }
      }
    });
    
    processed += batchNumbers.length;
    
    const percent = Math.round((processed / total) * 100);
    const bar = "█".repeat(Math.floor(percent / 10)) + "░".repeat(10 - Math.floor(percent / 10));
    
    const modeInfo = isOwner ? '🚀 OWNER' : (isFastMode ? '⚡ FAST' : '🐢 NORMAL');
    
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id, 
        progressMsg.message_id, 
        null, 
        `🔍 *Progress:* ${bar} ${percent}%\n*Memproses ${processed}/${total} nomor...*\n*Batch ${currentBatch}/${totalBatches}*\n*Mode:* ${modeInfo}`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      console.error("Error updating progress:", error);
    }
    
    if (batchIndex < totalBatches - 1) {
      await new Promise(resolve => setTimeout(resolve, batchDelay));
    }
  }

  try {
    await ctx.telegram.deleteMessage(ctx.chat.id, progressMsg.message_id);
  } catch (error) {
    console.error("Error deleting progress message:", error);
  }

  // 🆕 ENHANCED OUTPUT FORMAT
  let output = [];
  
  output.push("╔═══════════════════════════════════╗");
  output.push("║   HASIL CEK BIO WHATSAPP          ║");
  output.push("╚═══════════════════════════════════╝");
  output.push("");
  output.push("📊 STATISTIK LENGKAP:");
  output.push(`├─ Total nomor dicek     : ${stats.total}`);
  output.push(`├─ Terdaftar WA          : ${stats.registered}`);
  output.push(`├─ Dengan Bio            : ${stats.withBio}`);
  output.push(`├─ Tanpa Bio             : ${results.noBio.length}`);
  output.push(`└─ Tidak Terdaftar       : ${results.notRegistered.length}`);
  output.push("");
  output.push("🏢 DETAIL AKUN BISNIS:");
  output.push(`├─ Total Bisnis          : ${stats.business}`);
  output.push(`├─ Bisnis Basic          : ${stats.businessOnly}`);
  output.push(`├─ Bisnis + Socials      : ${stats.totalBusinessWithSocials}`);
  output.push(`└─ Bisnis + Email        : ${stats.totalWithEmail}`);
  output.push("");
  output.push("✅ META VERIFICATION:");
  output.push(`├─ Total Terverifikasi   : ${stats.totalMetaVerified}`);
  output.push(`├─ Verified Meta         : ${stats.verifiedMeta}`);
  output.push(`└─ Basic Meta            : ${stats.basicMeta}`);
  output.push("");
  output.push("🔗 CONNECTED SOCIALS:");
  output.push(`├─ Total dengan Socials  : ${stats.connectedSocials}`);
  output.push(`├─ Dengan Instagram      : ${stats.totalWithInstagram}`);
  output.push(`└─ Dengan Facebook       : ${stats.totalWithFacebook}`);
  output.push("");
  output.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  output.push("");

  const groupedByYear = {};
  results.withBio.forEach(item => {
    if (item && item.year) {
      if (!groupedByYear[item.year]) {
        groupedByYear[item.year] = [];
      }
      groupedByYear[item.year].push(item);
    }
  });

  if (results.withBio.length > 0) {
    output.push("✅ NOMOR DENGAN BIO");
    output.push("");

    Object.keys(groupedByYear).sort().forEach(year => {
      output.push(year);
      groupedByYear[year].forEach(item => {
        if (item && item.number) {
          output.push(`└─ ${item.number}`);
          output.push(`   └─ ${item.bio || 'Tidak ada bio'}`);
          output.push(`      └─ ⏰ ${item.updateTime ? item.updateTime.toLocaleDateString('id-ID') + '.' + item.updateTime.getHours().toString().padStart(2, '0') + item.updateTime.getMinutes().toString().padStart(2, '0') : 'Tidak diketahui'}`);
          output.push(`        └─ ${item.accountType || 'Personal'}`);
          
          // 🆕 TAMPILKAN BUSINESS DETAILS
          if (item.businessDetails) {
            if (item.businessDetails.email) {
              output.push(`          └─ 📧 Email: ${item.businessDetails.email}`);
            }
            if (item.businessDetails.instagram) {
              output.push(`          └─ 📸 Instagram: ${item.businessDetails.instagram}`);
            }
            if (item.businessDetails.facebook) {
              output.push(`          └─ 👥 Facebook: ${item.businessDetails.facebook}`);
            }
            if (item.businessDetails.website && item.businessDetails.website.length > 0) {
              output.push(`          └─ 🌐 Website: ${item.businessDetails.website.join(', ')}`);
            }
            if (item.businessDetails.category) {
              output.push(`          └─ 🏷️ Category: ${item.businessDetails.category}`);
            }
            if (item.businessDetails.address) {
              output.push(`          └─ 📍 Address: ${item.businessDetails.address}`);
            }
          }
          
          if (item.accountDetails && item.accountDetails.length > 0) {
            item.accountDetails.forEach(detail => {
              output.push(`          └─ ${detail}`);
            });
          }
          output.push(`          └─ untuk nomor ini 🎰 ${item.registrationPercent || 0}% tidak nge jam`);
          output.push("");
        }
      });
    });
    output.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    output.push("");
  }

  if (results.noBio.length > 0) {
    output.push("🔵 NOMOR TANPA BIO / PRIVASI");
    output.push("");

    results.noBio.forEach(item => {
      if (item && item.number) {
        output.push(`└─ ${item.number}`);
        output.push(`   └─ ${item.accountType || 'Personal'}`);
        
        // 🆕 TAMPILKAN BUSINESS DETAILS (untuk nomor tanpa bio juga)
        if (item.businessDetails) {
          if (item.businessDetails.email) {
            output.push(`     └─ 📧 Email: ${item.businessDetails.email}`);
          }
          if (item.businessDetails.instagram) {
            output.push(`     └─ 📸 Instagram: ${item.businessDetails.instagram}`);
          }
          if (item.businessDetails.facebook) {
            output.push(`     └─ 👥 Facebook: ${item.businessDetails.facebook}`);
          }
          if (item.businessDetails.website && item.businessDetails.website.length > 0) {
            output.push(`     └─ 🌐 Website: ${item.businessDetails.website.join(', ')}`);
          }
        }
        
        if (item.accountDetails && item.accountDetails.length > 0) {
          item.accountDetails.forEach(detail => {
            output.push(`     └─ ${detail}`);
          });
        }
        output.push(`     └─ untuk nomor ini 🎰 ${item.registrationPercent || 0}% tidak nge jam`);
        if (item.year && item.year !== "Tidak diketahui") {
          output.push(`     └─ ${item.year}`);
        }
        output.push("");
      }
    });
    output.push("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    output.push("");
  }

  if (results.notRegistered.length > 0) {
    output.push("🚫 NOMOR TIDAK TERDAFTAR DI WHATSAPP");
    output.push("");

    const maxNotRegisteredDisplay = 100;
    const displayNotRegistered = results.notRegistered.slice(0, maxNotRegisteredDisplay);
    
    displayNotRegistered.forEach(number => {
      if (number) {
        output.push(`└─ ${number}`);
        output.push(`   └─ Tidak terdaftar di WhatsApp`);
        output.push("");
      }
    });

    if (results.notRegistered.length > maxNotRegisteredDisplay) {
      output.push(`... dan ${results.notRegistered.length - maxNotRegisteredDisplay} nomor lainnya`);
      output.push("");
    }
    output.push("");
  }

  const now = new Date();
  const formattedDate = now.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const formattedTime = now.toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  
  output.push(`🕒 ${formattedDate}, ${formattedTime}`);
  
  return {
    text: output.join("\n"),
    stats: {
      withBio: stats.withBio,
      noBio: results.noBio.length,
      notRegistered: results.notRegistered.length,
      total: stats.total,
      registered: stats.registered,
      business: stats.business,
      verified: stats.verified,
      connectedSocials: stats.connectedSocials,
      businessOnly: stats.businessOnly,
      basicMeta: stats.basicMeta,
      verifiedMeta: stats.verifiedMeta,
      withProfilePicture: stats.withProfilePicture,
      // 🆕 STATS TAMBAHAN
      totalMetaVerified: stats.totalMetaVerified,
      totalBusinessWithSocials: stats.totalBusinessWithSocials,
      totalWithEmail: stats.totalWithEmail,
      totalWithInstagram: stats.totalWithInstagram,
      totalWithFacebook: stats.totalWithFacebook
    }
  };
}

// 🆕 ENHANCED CAPTION UNTUK FILE HASIL
// Paste fungsi ini SETELAH checkNumbers() di file lu
function getEnhancedCaption(stats) {
  return `✅ *Hasil Cek Bio WhatsApp*

📊 *Statistik Lengkap:*
📳 Dengan Bio: ${stats.withBio}
🔵 Tanpa Bio: ${stats.noBio}
🚫 Tidak Terdaftar: ${stats.notRegistered}

🏢 *Total Bisnis:* ${stats.business}
✅ *Total Meta Verified:* ${stats.totalMetaVerified}
🔗 *Total dengan Sosmed:* ${stats.connectedSocials}

⏰ *Powered by: ZETA_ZTA*`;
}


async function processBioCommandWithSession(ctx, numbers, userWa) {
  const userId = ctx.from.id;
  
  if (!userWa) {
    await ctx.reply("❌ *Session tidak aktif.*", { parse_mode: "Markdown" });
    return;
  }

  if (!numbers || !Array.isArray(numbers) || numbers.length === 0) {
    await ctx.reply("❌ *Tidak ada nomor yang valid*", { parse_mode: "Markdown" });
    return;
  }

  const validNumbers = numbers.filter(num => 
    num && typeof num === 'string' && num.replace(/[^0-9]/g, "").trim().length >= 8
  );

  if (validNumbers.length === 0) {
    await ctx.reply("❌ *Format nomor tidak valid*", { parse_mode: "Markdown" });
    return;
  }

  if (validNumbers.length > 100000) {
    await ctx.reply(`⚠️ *Terlalu banyak nomor!* Maksimal 100.000 nomor.`, { parse_mode: "Markdown" });
    numbers = validNumbers.slice(0, 100000);
  } else {
    numbers = validNumbers;
  }

  const processingMsg = await ctx.reply(`🚀 *Memproses ${numbers.length} nomor...*`, {
    parse_mode: "Markdown"
  });

  try {
    const { text: output, stats } = await checkNumbers(numbers, ctx, userWa);
    
    const randomId = Math.random().toString(36).substring(2, 15);
    const filename = `hasil_bio_${randomId}.txt`;
    
    const caption =
`RESULT INFORMATION
⚬ with bio  : ${stats.withBio}
⚬ without bio : ${stats.noBio}
⚬ not registered  : ${stats.notRegistered}
⚬ total business  : ${stats.business}
⚬ meta verified : ${stats.totalMetaVerified}
⚬ with social media : ${stats.connectedSocials}
╰─➤ presented by ZETA`;
    
    if (output && output.length > 0) {
      fs.writeFileSync(filename, output);
      await ctx.replyWithDocument({ 
        source: filename, 
        filename: `HASIL_CEKBIO_ZETA_${Date.now()}.txt` 
      }, {
        caption: caption,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📋 Cek Lagi", callback_data: "bio_menu" }],
            [{ text: "📋 Menu", callback_data: "back_menu" }]
          ]
        }
      });
      
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
      } catch (e) {
        console.error("Error deleting processing message:", e);
      }
      
      setTimeout(() => {
        try {
          if (fs.existsSync(filename)) {
            fs.unlinkSync(filename);
          }
        } catch (e) {
          console.error("Error deleting file:", e);
        }
      }, 5000);
    } else {
      await ctx.reply("❌ *Tidak ada data yang dapat ditampilkan*", { parse_mode: "Markdown" });
    }
    
  } catch (error) {
    await ctx.reply(`❌ *Error:* ${error.message}`, { parse_mode: "Markdown" });
    
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id);
    } catch (e) {
      console.error("Error deleting message:", e);
    }
  }
}

async function processBioCommand(ctx, numbers) {
  const userId = ctx.from.id;
  const userSessionId = `user_${userId}`;
  const userSession = activeSessions.get(userSessionId);
  
  if (!userSession) {
    await ctx.reply("❌ *Anda belum melakukan pairing!*\n\nGunakan /getpairing terlebih dahulu.", { parse_mode: "Markdown" });
    return;
  }

  if (!checkUserWAConnection(userId)) {
    await ctx.reply("❌ *Session tidak aktif.*\n\nSilakan pairing ulang dengan /getpairing.", { parse_mode: "Markdown" });
    return;
  }

  await processBioCommandWithSession(ctx, numbers, userSession.socket);
}

// Fungsi khusus untuk owner menggunakan session mana saja
async function processBioCommandOwner(ctx, args) {
  const userId = ctx.from.id;
  
  // Cek apakah owner
  if (userId != config.ownerId) {
    await ctx.reply("❌ Hanya owner yang dapat menggunakan fitur ini!");
    return;
  }
  
  // Format: /obio <phone> <numbers>
  // atau: /obio <phone> (dengan reply file)
  const parts = args.split(' ');
  if (parts.length < 2) {
    await ctx.reply("❌ *Format:* `/obio <phone> <numbers>`\n*Contoh:* `/obio 628123456789 628111222333,628444555666`", { 
      parse_mode: "Markdown" 
    });
    return;
  }
  
  const targetPhone = parts[0];
  const numbersText = parts.slice(1).join(' ');
  
  // Cari session berdasarkan nomor telepon
  const userWa = getActiveSessionByPhone(targetPhone);
  
  if (!userWa) {
    // Tampilkan daftar session aktif
    const activeSessionsList = getActiveSessionsList();
    if (activeSessionsList.length === 0) {
      await ctx.reply("❌ *Tidak ada session aktif!*", { parse_mode: "Markdown" });
      return;
    }
    
    let message = "📱 *DAFTAR SESSION AKTIF:*\n\n";
    activeSessionsList.forEach((session, index) => {
      message += `${index + 1}. +${session.phone} (User: ${session.userId})\n`;
    });
    
    message += "\n*Gunakan:* `/obio <phone> <numbers>`\n*Contoh:* `/obio 628123456789 628111,628222`";
    
    await ctx.reply(message, { parse_mode: "Markdown" });
    return;
  }
  
  // Ekstrak nomor dari teks
  const numbers = extractNumbersFromText(numbersText);
  
  if (numbers.length === 0) {
    await ctx.reply("❌ *Tidak ditemukan nomor yang valid.*", { parse_mode: "Markdown" });
    return;
  }
  
  await processBioCommandWithSession(ctx, numbers, userWa);
}


// ==================== FUNGSI BANTUAN ====================

 async function sendVerificationMessage(ctx) {
  try {
    const message = `Halo ${ctx.from.first_name}! 👋

Untuk menggunakan bot ini, Anda perlu bergabung dengan grup kami terlebih dahulu.

📋 *Langkah-langkah:*
1. Klik tombol "📲 Bergabung Grup" di bawah
2. Tunggu beberapa detik sampai benar-benar masuk
3. Klik tombol "✅ Sudah Bergabung"

Setelah itu, Anda bisa menggunakan semua fitur bot!`;
    
    // Pastikan config.groupLink ada dan valid
    let inlineKeyboard = [];
    if (config.groupLink && typeof config.groupLink === 'string' && config.groupLink.startsWith('https://')) {
      inlineKeyboard.push([{ text: "📲 Bergabung Grup", url: config.groupLink }]);
    }
    inlineKeyboard.push([{ text: "✅ Sudah Bergabung", callback_data: "refresh_verification" }]);
    
    return await ctx.reply(message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  } catch (error) {
    console.error("Error sending verification message:", error);
    // Fallback tanpa inline keyboard
    await ctx.reply(
      `Halo! Silakan bergabung dengan grup kami terlebih dahulu:\n${config.groupLink || 'Link grup tidak tersedia'}\n\nSetelah bergabung, ketik /start lagi.`,
      { parse_mode: "Markdown" }
    );
  }
}

// Fungsi untuk mengirim menu utama
async function sendMainMenu(ctx) {
  const userId = ctx.from.id;

  // ===== VERIFIKASI JOIN GRUP (NO 4) =====
  if (!(await isVerified(userId))) {
    return ctx.reply(
      "❌ Kamu belum join grup.\n\n" +
      "Silakan join dulu lalu kembali ke bot.\n\n" +
      "👉 https://t.me/USERNAME_GRUP_KAMU",
      { disable_web_page_preview: true }
    );
  }
  // ======================================

  // ✅ tambah ini (tanpa ubah lainnya)
  touchUser(userId);                 // catat user ke users.json
  const premium = isPremium(userId); // auto-expired dicek saat user pakai bot
  const u = usersDb[String(userId)] || {};

  const totalUsers = allUsers.size; 
  const hasActiveSession = checkUserWAConnection(userId);
  const runtime = getRuntime();
  
  const mainButtons = {
    inline_keyboard: [
      [
        { text: "📋 CEK BIO", callback_data: "bio_menu" },
        { text: "📱 PAIRING WA", callback_data: "pairing_menu" }
      ],
      [
        { text: "ℹ️ STATUS BOT", callback_data: "bot_status" },
        { text: "🔧 SETTINGS", callback_data: "settings_menu" }
      ],
      [
        { text: "👨‍💻 DEVELOPER", url: `https://t.me/${(config.ownerUsername || "@owner").replace('@', '')}` }
      ]
    ]
  };
  
  const welcomeMsg = `
\`\`\`
 Hello, ${ctx.from.first_name}! Welcome to the Cek Bio bot.
 Please use the bot properly and do not spam!!

        **BOT INFORMATION**
 ⚬ total users:${totalUsers.toString().padEnd(20)}
 ⚬ status:✅ verified
 ⚬ active sessions:${hasActiveSession ? "✅ connected" : "❌ not connected"}
 ⚬ premium:${
   premium
     ? `✅ active | remaining ${formatRemaining(u.premiumUntil - Date.now())} | exp ${formatDateID(u.premiumUntil)}`
     :"❌ free"
 }
 ⚬ bot name:${config.botName || "Cek Bio Bot"}
 ⚬ uptime:${runtime}
 ⚬ owner: @kahaja888
 ⚬ version:0.2
 ⚬ languages:English

 ╰─➤ To use the bot features, please click the button below.
\`\`\`
`.trim();

  try {
    // Periksa apakah ada URL foto di config
    if (config.welcomePhoto) {
      await ctx.replyWithPhoto(
        config.welcomePhoto,
        {
          caption: welcomeMsg,
          parse_mode: "Markdown",
          reply_markup: mainButtons
        }
      );
    } else {
      // Jika tidak ada URL foto, kirim teks biasa
      await ctx.reply(welcomeMsg, {
        parse_mode: "Markdown",
        reply_markup: mainButtons
      });
    }
  } catch (error) {
    console.error("Error sending main menu:", error);
    // Fallback ke teks sederhana
    await ctx.reply(
      `Halo ${ctx.from.first_name}! Selamat datang di ${config.botName || "Cek Bio Bot"}.\n\nPilih menu di bawah:`,
      {
        parse_mode: "Markdown",
        reply_markup: mainButtons
      }
    );
  }
}

// Fungsi untuk mengirim menu utama dan audio
async function sendMainMenuAndAudio(ctx) {
  try {
    // Kirim menu utama dulu
    await sendMainMenu(ctx);
    
    // Kirim audio setelah menu utama jika audioUrl tersedia
    if (config.audioUrl) {
      try {
        await ctx.replyWithAudio(config.audioUrl, {
          title: '404NotFoud',
          performer: 'Ly',
          caption: '-404NotFoud',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📋 Menu Utama', callback_data: 'back_menu' }]
            ]
          }
        });
      } catch (error) {
        console.error("Error sending audio:", error);
        // Jika gagal kirim audio, tetap lanjutkan
      }
    }
  } catch (error) {
    console.error("Error in sendMainMenuAndAudio:", error);
    throw error;
  }
}

// ==================== HANDLER /START YANG DIPERBAIKI ====================

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    try {
      // Tambahkan user ke database
      allUsers.add(userId);
      saveUsers();

      // Cek apakah user sudah terverifikasi
      const isUserVerified = await isVerified(userId);
      
      if (isUserVerified) {
        // User sudah terverifikasi, kirim menu utama dan audio
        await sendMainMenuAndAudio(ctx);
      } else {
        // User belum terverifikasi, kirim pesan verifikasi
        await sendVerificationMessage(ctx);
      }
    } catch (error) {
      console.error("Error in /start command:", error);
      
      // Fallback jika terjadi error
      await ctx.reply(
        "❌ *Terjadi kesalahan!*\n\nSilakan coba lagi atau hubungi admin.",
        { parse_mode: "Markdown" }
      );
    }
  });
});

// ==================== HANDLER CALLBACK QUERY YANG DIPERBAIKI ====================

bot.on("callback_query", async (ctx) => {
  const userId = ctx.from.id;
  
  addCallbackToQueue(userId, async () => {
    try {
      await ctx.answerCbQuery();
      
      const data = ctx.callbackQuery.data;
      
      // Handle refresh verification
      if (data === "refresh_verification") {
  try {
    // Cek apakah user sudah join group
    const isUserVerified = await checkUserInGroup(userId);
    
    if (isUserVerified) {
      // User sudah terverifikasi
      try {
        await ctx.deleteMessage();
      } catch (e) {
        console.error("Error deleting verification message:", e);
      }
      
      await sendMainMenuAndAudio(ctx);
    } else {
      // User belum terverifikasi
      let inlineKeyboard = [];
      if (config.groupLink && typeof config.groupLink === 'string' && config.groupLink.startsWith('https://')) {
        inlineKeyboard.push([{ text: "📲 Bergabung Grup", url: config.groupLink }]);
      }
      inlineKeyboard.push([{ text: "✅ Sudah Bergabung", callback_data: "refresh_verification" }]);
      
      await ctx.editMessageText(
        `❌ *Anda belum bergabung dengan grup!*\n\nSilakan klik tombol di bawah untuk bergabung terlebih dahulu.`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: inlineKeyboard
          }
        }
      );
    }
  } catch (error) {
    console.error("Error in refresh_verification:", error);
    await ctx.editMessageText(
      "❌ *Terjadi kesalahan!*\n\nSilakan coba lagi atau hubungi admin.",
      { parse_mode: "Markdown" }
    );
  }
  return;
}
      
      // Handle back to main menu
      if (data === "back_menu") {
        try {
          await ctx.deleteMessage();
        } catch (e) {
          console.error("Error deleting message:", e);
        }
        
        await sendMainMenu(ctx);
        return;
      }
      
      // Handle tebakan jawaban
      if (data.startsWith("jawaban_")) {
        const index = parseInt(data.split("_")[1]);
        const tebakanList = [
          {
            question: "Apa yang selalu datang tapi tidak pernah sampai?",
            answer: "*Besok!* 😂"
          },
          {
            question: "Kalau ayam jago telur, ayam apa yang jago terbang?",
            answer: "*Ayam betina, soalnya ayam jago gak bisa terbang!* 🐔"
          },
          {
            question: "Kenapa Superman pakai celana dalam di luar?",
            answer: "*Karena dalemannya lagi dicuci!* 🦸‍♂️"
          },
          {
            question: "Apa bedanya hantu sama orang miskin?",
            answer: "*Hantu tak kasat mata, orang miskin tak terlihat!* 👻"
          },
          {
            question: "Kenapa ilmuwan gak pernah main petak umpet?",
            answer: "*Karena gak ada yang bisa sembunyi dari gravitasi!* 🔬"
          }
        ];
        
        if (index >= 0 && index < tebakanList.length) {
          await ctx.editMessageText(
            `*TEBAK-TEBAKAN LUCU* 🤔\n\n${tebakanList[index].question}\n\n${tebakanList[index].answer}`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🤔 Tebakan Lagi", callback_data: "wa_features_menu" }],
                  [{ text: "📋 Menu", callback_data: "back_menu" }]
                ]
              }
            }
          );
        }
        return;
      }
      
      // Handle session refresh (owner only)
      if (data === "refresh_sessions") {
        if (ctx.from.id != config.ownerId) {
          await ctx.answerCbQuery("Hanya owner yang dapat refresh session");
          return;
        }
        
        try {
          await ctx.deleteMessage();
        } catch (e) {
          console.error("Error deleting message:", e);
        }
        
        await ctx.replyWithChatAction("typing");
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Panggil command listsesi
        await module.exports.listsesi(ctx);
        return;
      }
      
      // Handle bot status
      if (data === "bot_status") {
        const totalUsers = allUsers.size;
        const activeSessionsCount = activeSessions.size;
        const runtime = getRuntime();
        
        let message = `📊 *Status Bot*\n\n`;
        message += `🤖 *Nama Bot:* ${config.botName || "Cek Bio Bot"}\n`;
        message += `⏰ *Uptime:* ${runtime}\n`;
        message += `👥 *Total Pengguna:* ${totalUsers}\n`;
        message += `🔐 *Verifikasi:* ON\n`;
        message += `📱 *Session Aktif:* ${activeSessionsCount}\n`;
        
        try {
          await ctx.editMessageText(message, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "bot_status" }],
                [{ text: "📋 Menu Utama", callback_data: "back_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(message, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "bot_status" }],
                [{ text: "📋 Menu Utama", callback_data: "back_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle settings menu
      if (data === "settings_menu") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const settingsMsg = `⚙️ *Settings Menu*\n\nPilih pengaturan yang diinginkan:`;
        
        try {
          await ctx.editMessageText(settingsMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📊 Status Session", callback_data: "session_status" }],
                [{ text: "⚡ Fast Mode", callback_data: "fast_mode" }],
                [{ text: "🚀 Kecepatan Lainnya", callback_data: "other_speed" }],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(settingsMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📊 Status Session", callback_data: "session_status" }],
                [{ text: "⚡ Fast Mode", callback_data: "fast_mode" }],
                [{ text: "🚀 Kecepatan Lainnya", callback_data: "other_speed" }],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle session status
      if (data === "session_status") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const userSessionId = `user_${userId}`;
        const session = activeSessions.get(userSessionId);
        let sessionMsg = "";
        
        if (session) {
          const phone = session.socket.user?.id?.replace(/:\d+@s\.whatsapp\.net$/, '') || 'unknown';
          sessionMsg = `📱 *Status Session*\n\n✅ *Status:* Terhubung\n📞 *Nomor:* +${phone}\n⏰ *Terhubung sejak:* ${new Date(session.connectedAt).toLocaleString('id-ID')}`;
        } else {
          sessionMsg = `📱 *Status Session*\n\n❌ *Status:* Tidak terhubung\n\nSilakan lakukan pairing terlebih dahulu.`;
        }
        
        try {
          await ctx.editMessageText(sessionMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "session_status" }],
                [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(sessionMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔄 Refresh", callback_data: "session_status" }],
                [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle fast mode toggle
      if (data === "fast_mode") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const isFastMode = userFastMode.get(userId) || false;
        
        const fastModeMsg = `⚡ *Fast Mode*\n\nMode cepat untuk pemrosesan nomor.\n*Status:* ${isFastMode ? '✅ Aktif' : '❌ Nonaktif'}\n\nNote: Mode cepat dapat menyebabkan timeout jika terlalu banyak permintaan.`;
        
        try {
          await ctx.editMessageText(fastModeMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Aktifkan", callback_data: "enable_fast" },
                  { text: "❌ Nonaktifkan", callback_data: "disable_fast" }
                ],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(fastModeMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Aktifkan", callback_data: "enable_fast" },
                  { text: "❌ Nonaktifkan", callback_data: "disable_fast" }
                ],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle enable fast mode
      if (data === "enable_fast") {
        userFastMode.set(userId, true);
        try {
          await ctx.editMessageText("✅ *Fast Mode diaktifkan!*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "fast_mode" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("✅ *Fast Mode diaktifkan!*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "fast_mode" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle disable fast mode
      if (data === "disable_fast") {
        userFastMode.set(userId, false);
        try {
          await ctx.editMessageText("❌ *Fast Mode dinonaktifkan!*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "fast_mode" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("❌ *Fast Mode dinonaktifkan!*", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "fast_mode" }]
              ]
            }
          });
        }
        return;
      }
      
      // ==================== KECEPATAN LAINNYA ====================
      // Handle other speed menu
      if (data === "other_speed") {
        const currentSpeed = userOtherSpeed.get(userId) || "normal";
        
        let speedStatus = "";
        if (currentSpeed === "normal") {
          speedStatus = "🐢 Normal (5 batch, 2500ms delay)";
        } else if (currentSpeed === "fast") {
          speedStatus = "⚡ Fast (8 batch, 2000ms delay)";
        } else if (currentSpeed === "ultrafast") {
          speedStatus = "🚀 Ultra Fast (8 batch, 1000ms delay)";
        }
        
        const speedMsg = `🚀 *Kecepatan Lainnya*\n\n` +
          `Status saat ini: ${speedStatus}\n\n` +
          `Pengaturan ini berlaku untuk:\n` +
          `• Listgrup\n` +
          `• Autodesc\n` +
          `• Autoresetlink\n` +
          `• Autosampul\n\n` +
          `Pilih kecepatan:`;
        
        try {
          await ctx.editMessageText(speedMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: currentSpeed === "normal" ? "✅ Normal" : "🐢 Normal", callback_data: "speed_normal" }],
                [{ text: currentSpeed === "fast" ? "✅ Fast" : "⚡ Fast", callback_data: "speed_fast" }],
                [{ text: currentSpeed === "ultrafast" ? "✅ Ultra Fast" : "🚀 Ultra Fast", callback_data: "speed_ultrafast" }],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(speedMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: currentSpeed === "normal" ? "✅ Normal" : "🐢 Normal", callback_data: "speed_normal" }],
                [{ text: currentSpeed === "fast" ? "✅ Fast" : "⚡ Fast", callback_data: "speed_fast" }],
                [{ text: currentSpeed === "ultrafast" ? "✅ Ultra Fast" : "🚀 Ultra Fast", callback_data: "speed_ultrafast" }],
                [{ text: "⬅️ Kembali", callback_data: "settings_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle speed normal
      if (data === "speed_normal") {
        userOtherSpeed.set(userId, "normal");
        try {
          await ctx.editMessageText("✅ *Kecepatan diatur ke Normal!*\n\n🐢 5 batch, 2500ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("✅ *Kecepatan diatur ke Normal!*\n\n🐢 5 batch, 2500ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle speed fast
      if (data === "speed_fast") {
        userOtherSpeed.set(userId, "fast");
        try {
          await ctx.editMessageText("✅ *Kecepatan diatur ke Fast!*\n\n⚡ 8 batch, 2000ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("✅ *Kecepatan diatur ke Fast!*\n\n⚡ 8 batch, 2000ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle speed ultrafast
      if (data === "speed_ultrafast") {
        userOtherSpeed.set(userId, "ultrafast");
        try {
          await ctx.editMessageText("✅ *Kecepatan diatur ke Ultra Fast!*\n\n🚀 8 batch, 1000ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("✅ *Kecepatan diatur ke Ultra Fast!*\n\n🚀 8 batch, 1000ms delay", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: "other_speed" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle delete pairing confirmation
      if (data === "delpairing_confirm") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        try {
          await ctx.editMessageText("🗑 *Yakin ingin menghapus pairing?*\n\nIni akan memutuskan WhatsApp Anda dari bot.", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Ya, Hapus", callback_data: "delpairing_execute" }],
                [{ text: "❌ Batal", callback_data: "pairing_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply("🗑 *Yakin ingin menghapus pairing?*\n\nIni akan memutuskan WhatsApp Anda dari bot.", {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Ya, Hapus", callback_data: "delpairing_execute" }],
                [{ text: "❌ Batal", callback_data: "pairing_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle delete pairing execution
      if (data === "delpairing_execute") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown" 
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown" 
            });
          }
          return;
        }
        
        const deleted = await deleteUserSession(userId);
        
        if (deleted) {
          try {
            await ctx.editMessageText("✅ *Session berhasil dihapus!*\n\nPairing telah dihapus dari sistem.", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing Baru", callback_data: "pairing_menu" }],
                  [{ text: "📋 Menu", callback_data: "back_menu" }]
                ]
              }
            });
          } catch (error) {
            await ctx.reply("✅ *Session berhasil dihapus!*\n\nPairing telah dihapus dari sistem.", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing Baru", callback_data: "pairing_menu" }],
                  [{ text: "📋 Menu", callback_data: "back_menu" }]
                ]
              }
            });
          }
        } else {
          try {
            await ctx.editMessageText("❌ *Tidak ada session aktif.*", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                  [{ text: "📋 Menu", callback_data: "back_menu" }]
                ]
              }
            });
          } catch (error) {
            await ctx.reply("❌ *Tidak ada session aktif.*", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                  [{ text: "📋 Menu", callback_data: "back_menu" }]
                ]
              }
            });
          }
        }
        return;
      }
      
      // Handle fun menu
      
      // Handle bio menu
      if (data === "bio_menu") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const hasActiveSession = checkUserWAConnection(userId);
        
        if (!hasActiveSession && userId != config.ownerId) {
          try {
            await ctx.editMessageText("❌ *Anda belum melakukan pairing!*\n\nGunakan /getpairing terlebih dahulu.", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                  [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
                ]
              }
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum melakukan pairing!*\n\nGunakan /getpairing terlebih dahulu.", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
                  [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
                ]
              }
            });
          }
          return;
        }
        
        const bioMsg = `📋 *CEK BIO WHATSAPP*

*Akurasi: 100%*
✅ *Fitur:*
• Cek bio WhatsApp dengan akurat
• Deteksi akun bisnis & terverifikasi
• Cek status terdaftar/tidak
• Support banyak nomor sekaligus

Pilih cara input nomor:`;

        try {
          await ctx.editMessageText(bioMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📝 Input Koma", callback_data: "execute_bio1" },
                  { text: "📄 Per Baris", callback_data: "execute_bio2" },
                  { text: "📁 File TXT", callback_data: "execute_bio3" }
                ],
                userId == config.ownerId ? [
                  { text: "👑 Owner Mode", callback_data: "owner_bio_menu" }
                ] : [],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(bioMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📝 Input Koma", callback_data: "execute_bio1" },
                  { text: "📄 Per Baris", callback_data: "execute_bio2" },
                  { text: "📁 File TXT", callback_data: "execute_bio3" }
                ],
                userId == config.ownerId ? [
                  { text: "👑 Owner Mode", callback_data: "owner_bio_menu" }
                ] : [],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle owner bio menu
      if (data === "owner_bio_menu") {
        if (ctx.from.id != config.ownerId) {
          await ctx.answerCbQuery("Hanya owner yang dapat mengakses menu ini");
          return;
        }
        
        const activeSessionsList = getActiveSessionsList();
        
        if (activeSessionsList.length === 0) {
          try {
            await ctx.editMessageText("❌ *Tidak ada session aktif!*", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "⬅️ Kembali", callback_data: "bio_menu" }]
                ]
              }
            });
          } catch (error) {
            await ctx.reply("❌ *Tidak ada session aktif!*", {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "⬅️ Kembali", callback_data: "bio_menu" }]
                ]
              }
            });
          }
          return;
        }
        
        let message = "👑 *OWNER BIO MENU*\n\n";
        message += "*Session aktif:*\n";
        
        activeSessionsList.forEach((session, index) => {
          message += `${index + 1}. +${session.phone} (User: ${session.userId})\n`;
        });
        
        message += "\n*Gunakan:*\n";
        message += "`/obio <phone> <numbers>` - Cek bio dengan session tertentu\n";
        message += "`/obiofile <phone>` - Cek bio dengan file (reply .txt)";
        
        try {
          await ctx.editMessageText(message, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Cek Bio Owner", callback_data: "owner_bio_help" }],
                [{ text: "⬅️ Kembali", callback_data: "bio_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(message, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Cek Bio Owner", callback_data: "owner_bio_help" }],
                [{ text: "⬅️ Kembali", callback_data: "bio_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle owner bio help
      if (data === "owner_bio_help") {
        if (ctx.from.id != config.ownerId) {
          await ctx.answerCbQuery("Hanya owner yang dapat mengakses menu ini");
          return;
        }
        
        await ctx.editMessageText(`👑 *OWNER BIO COMMANDS*

*Format 1:* (langsung dengan nomor)
\`/obio <phone> <numbers>\`
*Contoh:*
\`/obio 628123456789 628111222333,628444555666\`

*Format 2:* (dengan file)
1. Kirim file .txt berisi nomor
2. Reply file dengan: \`/obiofile <phone>\`
*Contoh:*
\`/obiofile 628123456789\`

*Catatan:*
• <phone> adalah nomor session yang aktif
• <numbers> bisa dipisah koma atau spasi
• Bot otomatis ekstrak nomor dari teks
• *Akurasi: 100%*`, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "⬅️ Kembali", callback_data: "owner_bio_menu" }]
            ]
          }
        });
        return;
      }
      
      // Handle WA Features menu (List Grup & Autodesc)
      if (data === "wa_features_menu") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const waMsg = `📲 *FITUR WA LAINNYA*

📌 *Fitur Tersedia:*
• List Grup - Lihat daftar grup
• Autodesc - Update deskripsi grup otomatis

Pilih fitur yang ingin digunakan:`;
        
        try {
          await ctx.editMessageText(waMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📋 List Grup", callback_data: "execute_listgrup" },
                  { text: "✏️ Autodesc", callback_data: "execute_autodesc" }
                ],
                [
                  { text: "🔁 Auto Reset Link", callback_data: "execute_autoresetlink" },
                  { text: "🖼️ Auto Sampul", callback_data: "execute_autosampul" }
                ],
                [
                  { text: "👥❌ Kick Member", callback_data: "execute_kickmember" }
                ],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(waMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "📋 List Grup", callback_data: "execute_listgrup" },
                  { text: "✏️ Autodesc", callback_data: "execute_autodesc" }
                ],
                [
                  { text: "🔁 Auto Reset Link", callback_data: "execute_autoresetlink" },
                  { text: "🖼️ Auto Sampul", callback_data: "execute_autosampul" }
                ],
                [
                  { text: "👥❌ Kick Member", callback_data: "execute_kickmember" }
                ],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle execute listgrup
      if (data === "execute_listgrup") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // Hapus message callback query
        try {
          await ctx.deleteMessage();
        } catch (e) {}
        
        // ✅ Panggil fungsi listgrupLogic yang sama dengan command
        addToQueue(userId, async () => {
          await listgrupLogic(ctx, userId);
        });
        
        return;
      }
      
      // Handle execute autodesc  
      if (data === "execute_autodesc") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ Cek role owner/premium
        const isOwner = String(userId) === String(config.ownerId);
        const premium = isPremium(userId);
        
        if (!isOwner && !premium) {
          await ctx.answerCbQuery("❌ Fitur ini hanya untuk Owner dan Premium User!", { show_alert: true });
          await ctx.reply(
            "❌ *Fitur Autodesc hanya untuk Owner dan Premium User!*\n\n" +
            "💎 Upgrade ke Premium untuk akses fitur ini.",
            { parse_mode: "Markdown" }
          );
          return;
        }
        
        // ✅ Set state: user sedang menunggu input
        waitingForAutodescInput.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "✏️ *AUTODESC - Mode Input Aktif*\n\n" +
          "📝 *Kirim teks deskripsi baru* yang ingin diset ke semua grup (bot admin).\n\n" +
          "*Contoh:*\n" +
          "Selamat datang! Welcome my grup\n\n" +
          "💡 Kirim teks biasa (bukan command), bot akan otomatis proses!",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_autodesc" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ Handle cancel autodesc
      if (data === "cancel_autodesc") {
        waitingForAutodescInput.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Autodesc dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER EXECUTE AUTORESETLINK (langsung proses)
      if (data === "execute_autoresetlink") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // Hapus message callback query
        try {
          await ctx.deleteMessage();
        } catch (e) {}
        
        // ✅ Langsung proses autoresetlink
        addToQueue(userId, async () => {
          await autoresetlinkLogic(ctx, userId);
        });
        
        return;
      }
      
      // ✅ HANDLER EXECUTE AUTOSAMPUL (minta foto)
      if (data === "execute_autosampul") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ CEK ROLE: HANYA OWNER DAN PREMIUM
        const isOwner = String(userId) === String(config.ownerId);
        const premium = isPremium(userId);
        
        if (!isOwner && !premium) {
          await ctx.answerCbQuery("❌ Fitur ini hanya untuk Owner dan Premium User!", { show_alert: true });
          await ctx.reply(
            "❌ *Fitur Auto Sampul hanya untuk Owner dan Premium User!*\n\n" +
            "💎 Upgrade ke Premium untuk akses fitur ini.",
            { parse_mode: "Markdown" }
          );
          return;
        }
        
        // ✅ SET WAITING STATE & MINTA FOTO
        waitingForAutosampulPhoto.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "🖼️ *AUTO SAMPUL - Mode Input Aktif*\n\n" +
          "📸 *Kirim foto* yang ingin dijadikan sampul/foto profil grup.\n\n" +
          "Bot akan otomatis update foto ke semua grup (bot admin).\n\n" +
          "💡 Kirim foto biasa, bukan sebagai file dokumen.",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_autosampul" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER BATAL AUTOSAMPUL
      if (data === "cancel_autosampul") {
        waitingForAutosampulPhoto.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Auto Sampul dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER EXECUTE KICK MEMBER
      if (data === "execute_kickmember") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ CEK ROLE: HANYA OWNER DAN PREMIUM
        const isOwner = String(userId) === String(config.ownerId);
        const premium = isPremium(userId);
        
        if (!isOwner && !premium) {
          await ctx.answerCbQuery("❌ Fitur ini hanya untuk Owner dan Premium User!", { show_alert: true });
          await ctx.reply(
            "❌ *Fitur Kick Member hanya untuk Owner dan Premium User!*\n\n" +
            "💎 Upgrade ke Premium untuk akses fitur ini.",
            { parse_mode: "Markdown" }
          );
          return;
        }
        
        // ✅ SET WAITING STATE & MINTA LINK GRUP
        waitingForKickMemberLink.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "👥❌ *KICK MEMBER - Mode Input Aktif*\n\n" +
          "📝 *Kirim link grup WhatsApp* yang ingin di-kick semua membernya.\n\n" +
          "⚠️ *PERHATIAN:*\n" +
          "• Bot akan kick *SEMUA member kecuali admin*\n" +
          "• Bot harus jadi admin di grup tersebut\n" +
          "• Aksi ini tidak dapat dibatalkan\n\n" +
          "*Contoh link:*\n" +
          "`https://chat.whatsapp.com/xxxxx`\n\n" +
          "💡 Kirim teks biasa (bukan command).",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_kickmember" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER BATAL KICK MEMBER
      if (data === "cancel_kickmember") {
        waitingForKickMemberLink.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Kick Member dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER EXECUTE BIO1 (minta input nomor dipisah koma)
      if (data === "execute_bio1") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ SET WAITING STATE & MINTA INPUT
        waitingForBio1Input.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "📝 *BIO1 - Mode Input Aktif*\n\n" +
          "Kirim *nomor WhatsApp dipisah koma*.\n\n" +
          "*Contoh:*\n" +
          "628123456789,628987654321,628111222333\n\n" +
          "💡 Kirim teks biasa (bukan command).",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_bio1" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER BATAL BIO1
      if (data === "cancel_bio1") {
        waitingForBio1Input.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Bio1 dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER EXECUTE BIO2 (minta input nomor per baris)
      if (data === "execute_bio2") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ SET WAITING STATE & MINTA INPUT
        waitingForBio2Input.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "📄 *BIO2 - Mode Input Aktif*\n\n" +
          "Kirim *nomor WhatsApp per baris*.\n\n" +
          "*Contoh:*\n" +
          "628123456789\n" +
          "628987654321\n" +
          "628111222333\n\n" +
          "💡 Satu baris satu nomor.",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_bio2" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER BATAL BIO2
      if (data === "cancel_bio2") {
        waitingForBio2Input.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Bio2 dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER EXECUTE BIO3 (minta file .txt)
      if (data === "execute_bio3") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
            parse_mode: "Markdown"
          });
          return;
        }
        
        // ✅ SET WAITING STATE & MINTA FILE
        waitingForBio3Input.set(userId, true);
        
        await ctx.answerCbQuery();
        await ctx.reply(
          "📁 *BIO3 - Mode Input Aktif*\n\n" +
          "Kirim *file .txt* yang berisi daftar nomor WhatsApp.\n\n" +
          "*Format file:*\n" +
          "• Satu baris satu nomor\n" +
          "• File harus format .txt\n\n" +
          "💡 Upload file biasa (bukan sebagai media).",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Batal", callback_data: "cancel_bio3" }]
              ]
            }
          }
        );
        return;
      }
      
      // ✅ HANDLER BATAL BIO3
      if (data === "cancel_bio3") {
        waitingForBio3Input.delete(userId);
        await ctx.answerCbQuery("❌ Dibatalkan");
        await ctx.editMessageText(
          "❌ *Bio3 dibatalkan.*",
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📋 Menu", callback_data: "back_menu" }]
              ]
            }
          }
        );
        return;
      }
      
      // Handle pairing menu
      if (data === "pairing_menu") {
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        const pairingMsg = `📱 *PAIRING WHATSAPP*

🔧 *Fitur:*  
• /getpairing 
• /delpairing 

*Contoh:*  
\`/getpairing 628123456789\`
`;

        try {
          await ctx.editMessageText(pairingMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📱 Dapatkan Pairing", callback_data: "get_pairing_help" }],
                [{ text: "🗑 Hapus Pairing", callback_data: "delpairing_confirm" }],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(pairingMsg, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📱 Dapatkan Pairing", callback_data: "get_pairing_help" }],
                [{ text: "🗑 Hapus Pairing", callback_data: "delpairing_confirm" }],
                [{ text: "⬅️ Kembali", callback_data: "back_menu" }]
              ]
            }
          });
        }
        return;
      }
      
      // Handle help menus untuk bio dan wa features
      if (data === "bio1_help" || data === "bio2_help" || data === "bio3_help" ||
          data === "get_pairing_help" || data === "autodesc_help" || data === "run_listgrup") {
        
        const isUserVerified = await isVerified(userId);
        
        if (!isUserVerified) {
          try {
            await ctx.editMessageText("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          } catch (error) {
            await ctx.reply("❌ *Anda belum terverifikasi!* Bergabung grup terlebih dahulu.", {
              parse_mode: "Markdown"
            });
          }
          return;
        }
        
        let replyText = "";
        let backButton = "wa_features_menu";
        
        switch(data) {
          case "bio1_help":
            replyText = "📝 *CEK BIO - INPUT DENGAN KOMA*\n\n*Cara pakai:*\n1. Klik button 📝 Input Koma\n2. Kirim nomor dipisah koma\n\n*Contoh:*\n`628123456789,628987654321,628555555555`\n\n💡 Kirim teks biasa, TANPA ketik `/bio1`\n\n*Akurasi: 100%*";
            backButton = "bio_menu";
            break;
          case "bio2_help":
            replyText = "📄 *CEK BIO - INPUT PER BARIS*\n\n*Cara pakai:*\n1. Klik button 📄 Per Baris\n2. Kirim nomor per baris\n\n*Contoh:*\n`628123456789\n628987654321\n628555555555`\n\n💡 Kirim teks biasa, TANPA ketik `/bio2`\n\n*Akurasi: 100%*";
            backButton = "bio_menu";
            break;
          case "bio3_help":
            replyText = "📁 *CEK BIO - UPLOAD FILE TXT*\n\n*Cara pakai:*\n1. Klik button 📁 File TXT\n2. Upload file .txt berisi nomor (satu baris satu nomor)\n\n💡 Upload file langsung, TANPA ketik `/bio3` atau reply\n\n*Akurasi: 100%*";
            backButton = "bio_menu";
            break;
          case "get_pairing_help":
            replyText = "Untuk mendapatkan pairing code, ketik:\n\n`/getpairing 628123456789`\n\nGanti dengan nomor WhatsApp Anda.";
            backButton = "pairing_menu";
            break;
          case "autodesc_help":
            replyText = "📝 *AUTO DESC GRUP*\n\n*Format:* `/autodesc <deskripsi_baru>`\n\n*Contoh:*\n`/autodesc Selamat datang! Welcome my grup`\n\n*Fitur:* Update deskripsi semua grup WhatsApp dimana bot menjadi admin.\n\n⚠️ *Hanya Owner & Premium User*";
            backButton = "wa_features_menu";
            break;
          case "run_listgrup":
            // Langsung jalankan command listgrup
            await ctx.answerCbQuery("⏳ Menjalankan list grup...");
            
            // Panggil command listgrup secara langsung
            addToQueue(userId, async () => {
              try {
                // ✅ PERBAIKAN: Gunakan session user dari getpairing (sama seperti bio1/bio2/bio3)
                const sock = getUserWASession(userId);
                
                if (!sock) {
                  await ctx.reply(
                    "❌ *Anda belum melakukan pairing!*\n\n" +
                    "Gunakan /getpairing terlebih dahulu.",
                    { parse_mode: "Markdown" }
                  );
                  return;
                }

                const isOwner = userId == config.ownerId;
                const isPremiumUser = isPremium(userId);
                
                if (!isOwner && !isPremiumUser) {
                  await ctx.reply("❌ Fitur ini hanya untuk *Owner* dan *Premium User*!", { parse_mode: "Markdown" });
                  return;
                }
                
                if (!sock.user || !sock.user.id) {
                  await ctx.reply(
                    "❌ *Session tidak aktif.*\n\n" +
                    "Silakan pairing ulang dengan /getpairing.",
                    { parse_mode: "Markdown" }
                  );
                  return;
                }
                
                const loadingMsg = await ctx.reply("⏳ *Mengambil daftar grup...*", { parse_mode: "Markdown" });

                const groups = await sock.groupFetchAllParticipating();
                const groupsList = Object.values(groups);

                if (groupsList.length === 0) {
                  try {
                    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
                  } catch (e) {}
                  
                  await ctx.reply("❌ *Bot tidak tergabung di grup manapun!*", { parse_mode: "Markdown" });
                  return;
                }

                console.log(`\n🔍 Total grup bot: ${groupsList.length}`);
                console.log(`Bot JID: ${sock.user.id}\n`);

                try {
                  await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    loadingMsg.message_id,
                    null,
                    `⏳ *Memeriksa status admin di ${groupsList.length} grup...*\n\n_Mohon tunggu sebentar..._`,
                    { parse_mode: "Markdown" }
                  );
                } catch (e) {}

                const groupsByYear = {};
                let processedCount = 0;
                let adminCount = 0;
                let nonAdminCount = 0;

                // Loop semua grup untuk cek admin
                for (const group of groupsList) {
                  try {
                    console.log(`\n🔍 Checking: ${group.subject}`);
                    
                    const checkAdmin = await isBotAdmin(sock, group.id);
                    
                    console.log(`   Result: ${checkAdmin ? '✅ ADMIN' : '❌ NOT ADMIN'}`);
                    
                    if (!checkAdmin) {
                      console.log(`⚠️ Bot bukan admin di: ${group.subject}`);
                      nonAdminCount++;
                    } else {
                      console.log(`✅ Bot admin di: ${group.subject}`);
                      adminCount++;
                      
                      const metadata = await sock.groupMetadata(group.id);
                      
                      const creationDate = new Date(metadata.creation * 1000);
                      const year = creationDate.getFullYear();
                      
                      let creatorInfo = "no creator";
                      let hasCode = false;
                      
                      if (metadata.owner) {
                        const phoneNumber = metadata.owner.split('@')[0];
                        creatorInfo = phoneNumber;
                        hasCode = true;
                        console.log(`   ✅ HAS CODE - Creator: ${phoneNumber}`);
                      } else {
                        const dateStr = creationDate.toLocaleDateString('en-GB', {
                          day: '2-digit',
                          month: '2-digit',
                          year: '2-digit'
                        });
                        creatorInfo = dateStr;
                        hasCode = false;
                        console.log(`   ❌ NO CODE - Date only: ${dateStr}`);
                      }
                      
                      let inviteLink = "Link tidak tersedia";
                      let linkAvailable = false;
                      
                      try {
                        const inviteCode = await sock.groupInviteCode(group.id);
                        if (inviteCode && inviteCode.length > 0) {
                          inviteLink = `https://chat.whatsapp.com/${inviteCode}`;
                          linkAvailable = true;
                          console.log(`   ✅ Got invite link: ${inviteCode}`);
                        }
                      } catch (error1) {
                        console.log(`   ⚠️ Method 1 failed: ${error1.message}`);
                        
                        try {
                          await new Promise(resolve => setTimeout(resolve, 500));
                          const newCode = await sock.groupRevokeInvite(group.id);
                          if (newCode && newCode.length > 0) {
                            inviteLink = `https://chat.whatsapp.com/${newCode}`;
                            linkAvailable = true;
                            console.log(`   ✅ Got link via revoke: ${newCode}`);
                          }
                        } catch (error2) {
                          console.log(`   ⚠️ Method 2 failed: ${error2.message}`);
                          
                          try {
                            await new Promise(resolve => setTimeout(resolve, 500));
                            const queryResult = await sock.query({
                              tag: 'iq',
                              attrs: {
                                type: 'get',
                                xmlns: 'w:g2',
                                to: group.id
                              },
                              content: [{ tag: 'invite', attrs: {} }]
                            });
                            
                            if (queryResult && queryResult.content && queryResult.content[0]) {
                              const code = queryResult.content[0].attrs.code;
                              if (code) {
                                inviteLink = `https://chat.whatsapp.com/${code}`;
                                linkAvailable = true;
                                console.log(`   ✅ Got link via query: ${code}`);
                              }
                            }
                          } catch (error3) {
                            console.log(`   ❌ All methods failed for: ${group.subject}`);
                            if (metadata.announce) {
                              inviteLink = "Link tidak tersedia (grup announcement-only)";
                            } else {
                              inviteLink = `Link tidak tersedia (${error1.message})`;
                            }
                          }
                        }
                      }
                      
                      if (!groupsByYear[year]) {
                        groupsByYear[year] = [];
                      }
                      
                      groupsByYear[year].push({
                        name: metadata.subject,
                        creator: creatorInfo,
                        link: inviteLink,
                        timestamp: metadata.creation,
                        hasCode: hasCode,
                        linkAvailable: linkAvailable
                      });
                      
                      console.log(`   └─ Saved: ${year} - ${hasCode ? 'CODE' : 'NO CODE'} - Link: ${linkAvailable ? 'Available' : 'N/A'}`);
                    }
                    
                    processedCount++;
                    
                    if (processedCount % 3 === 0 || processedCount === groupsList.length) {
                      try {
                        await ctx.telegram.editMessageText(
                          ctx.chat.id,
                          loadingMsg.message_id,
                          null,
                          `⏳ *Memeriksa status admin...*\n\n` +
                            `📊 Progress: ${processedCount}/${groupsList.length}\n` +
                            `✅ Bot admin: ${adminCount}\n` +
                            `⚠️ Bukan admin: ${nonAdminCount}`,
                          { parse_mode: "Markdown" }
                        );
                      } catch (e) {}
                    }
                    
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    
                  } catch (error) {
                    console.error(`❌ Error processing ${group.subject}:`, error.message);
                    processedCount++;
                  }
                }

                try {
                  await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
                } catch (e) {}

                if (adminCount === 0) {
                  await ctx.reply(
                    `❌ *Bot tidak menjadi admin di grup manapun!*\n\n` +
                    `📊 Total grup: ${groupsList.length}\n` +
                    `👮 Bot admin: 0 grup\n` +
                    `⚠️ Bukan admin: ${nonAdminCount} grup`,
                    { parse_mode: "Markdown" }
                  );
                  return;
                }

                // Format hasil untuk file TXT
                let txtContent = `HASIL LINK GRUP (BOT ADMIN)\nTOTAL ${adminCount}\n\n`;
                
                const years = Object.keys(groupsByYear).sort((a, b) => parseInt(a) - parseInt(b));
                
                let totalWithCode = 0;
                let totalNoCode = 0;
                
                for (const year of years) {
                  const groups = groupsByYear[year];
                  for (const group of groups) {
                    if (group.hasCode) {
                      totalWithCode++;
                    } else {
                      totalNoCode++;
                    }
                  }
                }
                
                console.log(`\n📊 SUMMARY:`);
                console.log(`Total admin groups: ${adminCount}`);
                console.log(`Groups with code: ${totalWithCode}`);
                console.log(`Groups without code: ${totalNoCode}`);
                
                txtContent += `-${totalNoCode} no code\n`;
                txtContent += `-${totalWithCode} code\n\n`;
                
                for (const year of years) {
                  const groups = groupsByYear[year];
                  const codeCount = groups.filter(g => g.hasCode).length;
                  const noCodeCount = groups.length - codeCount;
                  
                  txtContent += `${year} ${groups.length} Grup\n`;
                  if (noCodeCount > 0) {
                    txtContent += `-${noCodeCount} no code\n`;
                  }
                  if (codeCount > 0) {
                    txtContent += `-${codeCount} code\n`;
                  }
                }
                
                txtContent += `\n`;
                
                for (const year of years) {
                  const groups = groupsByYear[year];
                  txtContent += `${year} ${groups.length} grup\n`;
                  txtContent += `${'-'.repeat(50)}\n`;
                  
                  groups.sort((a, b) => a.timestamp - b.timestamp);
                  
                  const noCodeGroups = groups.filter(g => !g.hasCode);
                  const codeGroups = groups.filter(g => g.hasCode);
                  
                  let counter = 1;
                  noCodeGroups.forEach((g) => {
                    txtContent += `${counter}.  No Code  ${g.link}\n`;
                    counter++;
                  });
                  
                  codeGroups.forEach((g) => {
                    txtContent += `${counter}.  Code\n${g.link}\n`;
                    counter++;
                  });
                  
                  txtContent += `\n`;
                }

                const fileName = `listgrup_${Date.now()}.txt`;
                const filePath = `./${fileName}`;
                
                fs.writeFileSync(filePath, txtContent, 'utf8');

                const caption = 
                  `📊 *LIST GRUP (BOT ADMIN)*\n\n` +
                  `📈 Total grup bot: ${groupsList.length}\n` +
                  `✅ Bot admin: ${adminCount}\n` +
                  `⚠️ Bukan admin: ${nonAdminCount}\n\n` +
                  `🔗 Dengan code: ${totalWithCode}\n` +
                  `❌ Tanpa code: ${totalNoCode}`;

                await ctx.replyWithDocument(
                  { source: filePath, filename: fileName },
                  { 
                    caption: caption,
                    parse_mode: "Markdown"
                  }
                );

                setTimeout(() => {
                  try {
                    if (fs.existsSync(filePath)) {
                      fs.unlinkSync(filePath);
                    }
                  } catch (e) {
                    console.error("Error deleting file:", e);
                  }
                }, 5000);

              } catch (error) {
                console.error("Error in listgrup command:", error);
                await ctx.reply(`❌ Error: ${error.message}`);
              }
            });
            return;
        }
        
        try {
          await ctx.editMessageText(replyText, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: backButton }]
              ]
            }
          });
        } catch (error) {
          await ctx.reply(replyText, {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Kembali", callback_data: backButton }]
              ]
            }
          });
        }
        return;
      }
      
    } catch (error) {
      console.error("Callback query error:", error);
      try {
        await ctx.answerCbQuery("❌ Error, coba lagi");
      } catch (e) {
        console.error("Error answering callback:", e);
      }
    }
  });
});

// ==================== COMMANDS LAINNYA ====================

bot.command("unpremium", async (ctx) => {
  // owner only
  if (String(ctx.from.id) !== String(config.ownerId)) {
    return ctx.reply("❌ Owner only.");
  }

  const args = ctx.message.text.trim().split(/\s+/);
  if (args.length < 2) {
    return ctx.reply("❌ Format:\n/unpremium <userId>");
  }

  const targetId = String(args[1]);
  if (!/^\d+$/.test(targetId)) {
    return ctx.reply("❌ User ID harus angka.");
  }

  // pastikan user ada di DB
  const u = touchUser(targetId);

  // hapus premium
  u.premiumUntil = 0;
  saveUsersDb();

  return ctx.reply(
    `✅ Premium berhasil DIHAPUS\n\n` +
    `👤 ID: ${targetId}\n` +
    `⭐ Status sekarang: FREE`
  );
});

bot.command("listuser", async (ctx) => {
  // owner only
  if (String(ctx.from.id) !== String(config.ownerId)) {
    return ctx.reply("Owner only.");
  }

  const now = Date.now();
  const entries = Object.entries(usersDb);

  if (entries.length === 0) {
    return ctx.reply("No users.");
  }

  // =====================
  // HITUNG SUMMARY
  // =====================
  let countOwner = 0;
  let countPremium = 0;
  let countFree = 0;

  entries.forEach(([id, u]) => {
    if (String(id) === String(config.ownerId)) {
      countOwner++;
    } else if (u.premiumUntil && u.premiumUntil > now) {
      countPremium++;
    } else {
      countFree++;
    }
  });

  // =====================
  // SORT: OWNER -> PREMIUM -> FREE
  // =====================
  const sorted = entries.sort((a, b) => {
    const [idA, uA] = a;
    const [idB, uB] = b;

    const rank = (id, u) => {
      if (String(id) === String(config.ownerId)) return 0; // OWNER
      if (u.premiumUntil && u.premiumUntil > now) return 1; // PREMIUM
      return 2; // FREE
    };

    return rank(idA, uA) - rank(idB, uB);
  });

  // =====================
  // BUILD TEXT (ALA TXT)
  // =====================
  let text =
    "USER SUMMARY\n" +
    `Owner   : ${countOwner}\n` +
    `Premium : ${countPremium}\n` +
    `Free    : ${countFree}\n` +
    `Total   : ${entries.length}\n\n` +
    "USER LIST\n";

  let no = 1;
  for (const [id, u] of sorted) {
    let line = `${no}. ${id}`;

    if (String(id) === String(config.ownerId)) {
      line += " | OWNER";
    } else if (u.premiumUntil && u.premiumUntil > now) {
      line += ` | PREMIUM | Exp: ${formatDateID(u.premiumUntil)}`;
    } else {
      line += " | FREE";
    }

    text += line + "\n";
    no++;
  }

  return ctx.reply(text);
});


bot.command("listprem", async (ctx) => {
  // owner only
  if (String(ctx.from.id) !== String(config.ownerId)) {
    return ctx.reply("❌ Owner only.");
  }

  const now = Date.now();

  // ambil user yang masih premium
  const premiumUsers = Object.entries(usersDb)
    .filter(([_, u]) => u.premiumUntil && u.premiumUntil > now)
    .sort((a, b) => a[1].premiumUntil - b[1].premiumUntil); // urut exp tercepat

  if (premiumUsers.length === 0) {
    return ctx.reply("📋 *LIST PREMIUM*\n\nTidak ada user premium aktif.", {
      parse_mode: "Markdown",
    });
  }

  let text = `📋 *LIST PREMIUM (${premiumUsers.length})*\n\n`;

  premiumUsers.forEach(([id, u], i) => {
    text +=
      `${i + 1}. 👤 ID: \`${id}\`\n` +
      `   ⏳ Sisa: ${formatRemaining(u.premiumUntil - now)}\n` +
      `   📌 Exp: ${formatDateID(u.premiumUntil)}\n\n`;
  });

  // Telegram limit 4096 char → potong kalau kepanjangan
  if (text.length > 4000) {
    text = text.slice(0, 3950) + "\n…(dipotong)";
  }

  return ctx.reply(text, { parse_mode: "Markdown" });
});


// Command untuk owner menggunakan session file
bot.command("obio", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    // Cek apakah owner
    if (userId != config.ownerId) {
      await ctx.reply("❌ Hanya owner yang dapat menggunakan fitur ini!");
      return;
    }
    
    const text = ctx.message.text;
    const args = text.split(" ").slice(1).join(" ");
    
    if (!args) {
      // Tampilkan daftar session aktif
      const activeSessionsList = getActiveSessionsList();
      if (activeSessionsList.length === 0) {
        await ctx.reply("❌ *Tidak ada session aktif!*", { parse_mode: "Markdown" });
        return;
      }
      
      let message = "📱 *DAFTAR SESSION AKTIF:*\n\n";
      activeSessionsList.forEach((session, index) => {
        message += `${index + 1}. +${session.phone} (User: ${session.userId})\n`;
      });
      
      message += "\n*Gunakan:* `/obio <phone> <numbers>`\n*Contoh:* `/obio 628123456789 628111,628222`";
      
      await ctx.reply(message, { parse_mode: "Markdown" });
      return;
    }
    
    await processBioCommandOwner(ctx, args);
  });
});

// Command untuk owner menggunakan session file dengan reply
bot.command("obiofile", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    // Cek apakah owner
    if (userId != config.ownerId) {
      await ctx.reply("❌ Hanya owner yang dapat menggunakan fitur ini!");
      return;
    }
    
    const text = ctx.message.text;
    const args = text.split(" ").slice(1);
    
    if (args.length < 1) {
      await ctx.reply("❌ *Format:* `/obiofile <phone>`\n*Contoh:* `/obiofile 628123456789` (reply file .txt)", { 
        parse_mode: "Markdown" 
      });
      return;
    }
    
    const targetPhone = args[0];
    const userWa = getActiveSessionByPhone(targetPhone);
    
    if (!userWa) {
      await ctx.reply(`❌ *Session untuk +${targetPhone} tidak aktif!*`, { parse_mode: "Markdown" });
      return;
    }
    
    const msg = ctx.message;
    let numbers = [];

    if (msg.reply_to_message && msg.reply_to_message.document) {
      const file = msg.reply_to_message.document;
      if (!file.file_name.endsWith('.txt')) {
        await ctx.reply("❌ *Hanya file .txt yang didukung!*", { parse_mode: "Markdown" });
        return;
      }
      
      try {
        const link = await ctx.telegram.getFileLink(file.file_id);
        const res = await fetch(link.href);
        const text = await res.text();
        
        // Ekstrak nomor dari file
        numbers = extractNumbersFromText(text);
      } catch (error) {
        await ctx.reply("❌ *Error membaca file!* Pastikan file valid.", { parse_mode: "Markdown" });
        return;
      }
    } else {
      await ctx.reply("❌ *Reply file .txt dengan perintah ini!*", { parse_mode: "Markdown" });
      return;
    }

    if (numbers.length === 0) {
      await ctx.reply("❌ *Tidak ditemukan nomor yang valid.*", { parse_mode: "Markdown" });
      return;
    }

    await processBioCommandWithSession(ctx, numbers, userWa);
  });
});

// ==================== FITUR FUN ====================





bot.command("getpairing", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    try {
      const text = ctx.message.text
      const args = text.split(" ").slice(1)
      if (!args.length) {
        await ctx.reply("❌ *Format:* `/getpairing <nomor>`\n*Contoh:* `/getpairing 628123456789`", { parse_mode: "Markdown" });
        return;
      }

      const num = args[0]
      const cleanNum = num.replace(/[^0-9]/g, "")
      if (!cleanNum.match(/^\d{8,15}$/)) {
        await ctx.reply("❌ *Format nomor tidak valid!*\n\nContoh format:\n• Indonesia: `628123456789`\n• USA: `13151234567`\n• UK: `447123456789`", {
          parse_mode: "Markdown"
        });
        return;
      }

      const sessionId = `user_${userId}`
      let userWa = activeSessions.get(sessionId)?.socket
      
      if (!userWa) {
        await ctx.reply("🔄 *Membuat session baru...*", { parse_mode: "Markdown" })
        userWa = await startWA(sessionId, userId)
        await new Promise(resolve => setTimeout(resolve, 5000))
      }

      const loadingMsg = await ctx.reply("⏳ *Meminta pairing code...*", { parse_mode: "Markdown" })
      
      const code = await userWa.requestPairingCode(cleanNum)
      
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id)
      
      const pairingMessage = `
📱 *PAIRING CODE*

✨ **Nomor:** +${cleanNum}
🔐 **Kode Pairing:** \`${code}\`
      `.trim()

      await ctx.reply(pairingMessage, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Minta Lagi", callback_data: "pairing_menu" }],
            [{ text: "🗑 Hapus", callback_data: "delpairing_confirm" }],
            [{ text: "📋 Menu", callback_data: "back_menu" }]
          ]
        }
      })
    } catch (err) {
      let errorMessage = "❌ *Gagal mendapatkan pairing code!*\n\n"
      
      if (err.message.includes("rate limit")) {
        errorMessage += "⏰ *Terlalu banyak percobaan!* Coba lagi 1-2 menit lagi."
      } else if (err.message.includes("invalid phone number")) {
        errorMessage += "📞 *Nomor tidak valid!* Periksa kembali nomor Anda."
      } else if (err.message.includes("not registered")) {
        errorMessage += "📵 *Nomor tidak terdaftar di WhatsApp!*"
      } else {
        errorMessage += `⚠️ *Error:* ${err.message}`
      }

      await ctx.reply(errorMessage, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔄 Coba Lagi", callback_data: "pairing_menu" }],
            [{ text: "📋 Menu", callback_data: "back_menu" }]
          ]
        }
      })
    }
  });
})

bot.command("delpairing", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    let deleted = false;

    try {
      // pakai String biar konsisten kalau session key kamu string
      deleted = await deleteUserSession(String(userId));
      deleted = !!deleted; // paksa boolean
    } catch (err) {
      console.error("delpairing error:", err);
      deleted = false;
    }
    
    if (deleted) {
      await ctx.reply("✅ *Session berhasil dihapus!*\n\nPairing telah dihapus dari sistem.", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📱 Pairing Baru", callback_data: "pairing_menu" }],
            [{ text: "📋 Menu", callback_data: "back_menu" }]
          ]
        }
      });
    } else {
      await ctx.reply("❌ *Tidak ada session aktif.*\n\nGunakan /getpairing untuk membuat baru.", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "📱 Pairing", callback_data: "pairing_menu" }],
            [{ text: "📋 Menu", callback_data: "back_menu" }]
          ]
        }
      });
    }
  });
});




bot.command("listsesi", async (ctx) => {
  const userId = ctx.from.id;
  
  if (userId != config.ownerId) {
    await ctx.reply("❌ Akses ditolak!");
    return;
  }

  addToQueue(userId, async () => {
    const now = Date.now()
    const fiveHours = 5 * 60 * 60 * 1000
    
    let message = "📱 *DAFTAR SESSION AKTIF:*\n\n"
    let hasSessions = false

    for (const [phone, data] of Object.entries(sessionData)) {
      const session = activeSessions.get(data.sessionId)
      const status = session ? "✅ Aktif" : "❌ Tidak Aktif"
      message += `└─ +${phone} | ${status}\n`
      message += `   └─ User ID: ${data.userId}\n\n`
      hasSessions = true
    }

    const sessionsToDelete = []
    Object.entries(sessionData).forEach(([phone, data]) => {
      const session = activeSessions.get(data.sessionId)
      if (!session && (now - data.pairedAt) > fiveHours) {
        sessionsToDelete.push({phone, sessionId: data.sessionId})
      }
    })

    sessionsToDelete.forEach(({phone, sessionId}) => {
      deleteSessionData(sessionId);
    })
    if (sessionsToDelete.length > 0) {
      saveSessions()
    }

    if (!hasSessions && Object.keys(sessionData).length === 0) {
      message = "❌ *Tidak ada session aktif.*"
    }

    await ctx.reply(message, { 
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "refresh_sessions" }],
          [{ text: "📋 Menu", callback_data: "back_menu" }]
        ]
      }
    })
  });
})

// ==================== FITUR AUTO EDIT SEMUA GRUP (FIXED FOR LID) ====================

// Fungsi untuk cek apakah bot adalah admin
// ==================== DEBUGGING COMMAND - TAMBAHKAN INI ====================

bot.command("debugjid", async (ctx) => {
  const userId = ctx.from.id;
  
  if (userId != config.ownerId) {
    await ctx.reply("❌ Owner only!");
    return;
  }

  addToQueue(userId, async () => {
    try {
      const activeSessionsList = getActiveSessionsList();
      
      if (activeSessionsList.length === 0) {
        await ctx.reply("❌ Tidak ada session aktif!");
        return;
      }

      const sessionId = activeSessionsList[0].sessionId;
      const session = activeSessions.get(sessionId);
      const sock = session.socket;
      
      const loadingMsg = await ctx.reply("⏳ Mengambil info...");
      
      // Ambil info bot
      const botInfo = {
        fullJid: sock.user.id,
        name: sock.user.name || 'No name',
        phone: sock.user.id.split('@')[0].split(':')[0]
      };
      
      console.log("\n=== BOT IDENTITY INFO ===");
      console.log("Full JID:", botInfo.fullJid);
      console.log("Name:", botInfo.name);
      console.log("Phone:", botInfo.phone);
      
      // Ambil daftar grup
      const groups = await sock.groupFetchAllParticipating();
      const groupsList = Object.values(groups).slice(0, 3); // Ambil 3 grup pertama
      
      let debugText = `🤖 *BOT INFO*\n\n`;
      debugText += `📱 Full JID: \`${botInfo.fullJid}\`\n`;
      debugText += `👤 Name: ${botInfo.name}\n`;
      debugText += `📞 Phone: ${botInfo.phone}\n\n`;
      debugText += `📊 Total groups: ${Object.keys(groups).length}\n\n`;
      debugText += `━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Check 3 grup pertama untuk melihat format participant ID
      for (let i = 0; i < Math.min(3, groupsList.length); i++) {
        const group = groupsList[i];
        
        try {
          const metadata = await sock.groupMetadata(group.id);
          
          console.log(`\n--- GROUP ${i+1}: ${metadata.subject} ---`);
          console.log(`Total participants: ${metadata.participants.length}`);
          
          debugText += `📱 *Group ${i+1}: ${metadata.subject}*\n`;
          debugText += `Total participants: ${metadata.participants.length}\n\n`;
          
          // Tampilkan 5 participant pertama dengan format ID mereka
          debugText += `Sample participant IDs:\n`;
          for (let j = 0; j < Math.min(5, metadata.participants.length); j++) {
            const p = metadata.participants[j];
            const role = p.admin || 'member';
            
            debugText += `${j+1}. \`${p.id}\`\n`;
            debugText += `   Role: ${role}\n`;
            
            console.log(`  ${j+1}. ID: ${p.id}`);
            console.log(`     Admin: ${role}`);
            
            // Check apakah ini bot
            const isBot = 
              p.id === botInfo.fullJid ||
              p.id.includes(botInfo.phone) ||
              p.id.split('@')[0].split(':')[0] === botInfo.phone;
            
            if (isBot) {
              debugText += `   ⭐ *THIS IS BOT!*\n`;
              console.log(`     ⭐ THIS IS BOT!`);
            }
            
            debugText += `\n`;
          }
          
          // Cari bot di participants
          const botParticipant = metadata.participants.find(p => {
            return p.id === botInfo.fullJid ||
                   p.id.includes(botInfo.phone) ||
                   p.id.split('@')[0].split(':')[0] === botInfo.phone;
          });
          
          if (botParticipant) {
            debugText += `✅ *Bot found in this group!*\n`;
            debugText += `Bot ID: \`${botParticipant.id}\`\n`;
            debugText += `Role: ${botParticipant.admin || 'member'}\n\n`;
            
            console.log(`✅ Bot found!`);
            console.log(`   Bot ID in group: ${botParticipant.id}`);
            console.log(`   Role: ${botParticipant.admin || 'member'}`);
          } else {
            debugText += `❌ *Bot NOT found in this group*\n\n`;
            console.log(`❌ Bot NOT found in this group`);
          }
          
          debugText += `━━━━━━━━━━━━━━━━━━\n\n`;
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.error(`Error processing group ${i+1}:`, error);
          debugText += `❌ Error: ${error.message}\n\n`;
        }
      }
      
      console.log("\n=== END DEBUG ===\n");
      
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      } catch (e) {}
      
      // Split jika terlalu panjang
      if (debugText.length > 4000) {
        const parts = debugText.match(/[\s\S]{1,3900}/g) || [];
        for (const part of parts) {
          await ctx.reply(part, { parse_mode: "Markdown" });
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        await ctx.reply(debugText, { parse_mode: "Markdown" });
      }
      
    } catch (error) {
      console.error("Error in debugjid:", error);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });
});

// âœ… SOLUSI ULTIMATE: Trial & Error Method
// Langsung coba update, kalau berhasil = admin, gagal = bukan admin
async function isBotAdmin(sock, groupJid) {
  try {
    const groupMetadata = await sock.groupMetadata(groupJid);
    
    console.log(`\nðŸ" Testing admin status: ${groupMetadata.subject}`);
    
    // Simpan deskripsi asli
    const originalDesc = groupMetadata.desc || '';
    
    // Coba update dengan deskripsi yang sama (tidak mengubah apapun)
    // Kalau bot admin, ini akan berhasil tanpa error
    try {
      await sock.groupUpdateDescription(groupJid, originalDesc);
      console.log(`âœ… Bot IS ADMIN in: ${groupMetadata.subject}`);
      return true;
    } catch (error) {
      // Error 403 atau "not-authorized" = bukan admin
      if (error.message.includes('403') || 
          error.message.includes('not-authorized') ||
          error.message.includes('forbidden')) {
        console.log(`âŒ Bot NOT ADMIN in: ${groupMetadata.subject}`);
        return false;
      }
      
      // Error lain (network, etc) - anggap bukan admin untuk safety
      console.log(`âš ï¸ Unknown error in ${groupMetadata.subject}: ${error.message}`);
      return false;
    }
    
  } catch (error) {
    console.error(`Error checking ${groupJid}:`, error.message);
    return false;
  }
}

// Fungsi update deskripsi grup
async function updateGroupDescription(sock, groupJid, description) {
  try {
    await sock.groupUpdateDescription(groupJid, description);
    await new Promise(resolve => setTimeout(resolve, 1000));
    return true;
  } catch (error) {
    console.error(`Error updating group ${groupJid}:`, error.message);
    throw error;
  }
}




bot.command("debugadmin", async (ctx) => {
  const userId = ctx.from.id;
  
  if (userId != config.ownerId) {
    await ctx.reply("❌ Owner only!");
    return;
  }

  addToQueue(userId, async () => {
    try {
      const activeSessionsList = getActiveSessionsList();
      
      if (activeSessionsList.length === 0) {
        await ctx.reply("❌ Tidak ada session aktif!");
        return;
      }

      const sessionId = activeSessionsList[0].sessionId;
      const session = activeSessions.get(sessionId);
      const sock = session.socket;
      
      const loadingMsg = await ctx.reply("⏳ Mengambil info grup...");
      
      const groups = await sock.groupFetchAllParticipating();
      const groupsList = Object.values(groups);
      
      console.log("\n=== DEBUG ADMIN STATUS ===");
      console.log(`Bot JID: ${sock.user.id}`);
      console.log(`Total groups: ${groupsList.length}\n`);
      
      let debugInfo = `🔍 DEBUG INFO\n\n`;
      debugInfo += `Bot JID: ${sock.user.id}\n`;
      debugInfo += `Total groups: ${groupsList.length}\n\n`;
      
      // Ambil 3 grup pertama untuk testing
      const testGroups = groupsList.slice(0, 3);
      
      for (const group of testGroups) {
        try {
          const groupMetadata = await sock.groupMetadata(group.id);
          
          console.log(`\n--- Group: ${groupMetadata.subject} ---`);
          console.log(`Group JID: ${group.id}`);
          console.log(`Participants count: ${groupMetadata.participants.length}`);
          
          debugInfo += `\n📱 Group: ${groupMetadata.subject}\n`;
          debugInfo += `Group JID: ${group.id}\n`;
          
          // Cari bot di participants
          const botParticipant = groupMetadata.participants.find(
            p => p.id === sock.user.id
          );
          
          if (botParticipant) {
            console.log(`✅ Bot found in group!`);
            console.log(`Bot participant:`, JSON.stringify(botParticipant, null, 2));
            
            debugInfo += `✅ Bot found!\n`;
            debugInfo += `Admin status: ${botParticipant.admin || 'member'}\n`;
            debugInfo += `Participant ID: ${botParticipant.id}\n`;
          } else {
            console.log(`❌ Bot NOT found in participants`);
            
            // Tampilkan beberapa participant untuk compare
            console.log(`Sample participants (first 3):`);
            groupMetadata.participants.slice(0, 3).forEach(p => {
              console.log(`  - ID: ${p.id}, Admin: ${p.admin || 'member'}`);
            });
            
            debugInfo += `❌ Bot NOT found in participants!\n`;
            debugInfo += `Sample participant IDs:\n`;
            groupMetadata.participants.slice(0, 3).forEach(p => {
              debugInfo += `  - ${p.id}\n`;
            });
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          console.error(`Error processing group ${group.subject}:`, error);
        }
      }
      
      console.log("\n=== END DEBUG ===\n");
      
      try {
        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
      } catch (e) {}
      
      // Split message jika terlalu panjang
      if (debugInfo.length > 4000) {
        debugInfo = debugInfo.substring(0, 3900) + "\n\n...(truncated)";
      }
      
      await ctx.reply(debugInfo);
      
    } catch (error) {
      console.error("Error in debugadmin:", error);
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  });
});




bot.command("chat", async (ctx) => {
  const userId = ctx.from.id;
  
  if (userId != config.ownerId) {
    await ctx.reply("❌ Hanya owner yang dapat menggunakan fitur ini!");
    return;
  }

  addToQueue(userId, async () => {
    const text = ctx.message.text.split(" ").slice(1).join(" ");
    if (!text) {
      await ctx.reply("❌ *Format:* `/chat <pesan>`\n*Contoh:* `/chat Halo semua user!`", { 
        parse_mode: "Markdown" 
      });
      return;
    }

    const loadingMsg = await ctx.reply("📤 *Mengirim pesan ke semua user...*", { 
      parse_mode: "Markdown" 
    });

    let successCount = 0;
    let failCount = 0;

    for (const user of allUsers) {
      try {
        await bot.telegram.sendMessage(
          user,
          `${text}`,
          { parse_mode: "Markdown" }
        );
        successCount++;
        
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failCount++;
      }
    }

    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
    } catch (e) {
      console.error("Error deleting message:", e);
    }

    await ctx.reply(
      `✅ *Pesan berhasil dikirim!*\n\n` +
      `📤 Berhasil: ${successCount} user\n` +
      `❌ Gagal: ${failCount} user\n\n` +
      `📝 Total user: ${allUsers.size}`,
      { parse_mode: "Markdown" }
    );
  });
});

// ✅ FUNGSI REUSABLE UNTUK BIO1
async function bio1Logic(ctx, userId, inputText) {
  if (!inputText || !inputText.trim()) {
    await ctx.reply(
      "❌ *Format:* Kirim nomor dipisah koma.\n*Contoh:* `628123xxx,628456xxx,...`", 
      { parse_mode: "Markdown" }
    );
    return;
  }
  
  let numbers = extractNumbersFromText(inputText);
  
  if (numbers.length === 0) {
    await ctx.reply(
      "❌ *Tidak ditemukan nomor yang valid.*\n\n" +
      "Pastikan format nomor:\n" +
      "• Minimal 8 digit\n" +
      "• Maksimal 15 digit\n" +
      "• Contoh: 628123456789, 628987654321", 
      { parse_mode: "Markdown" }
    );
    return;
  }

  // ✅ CEK PREMIUM & LIMIT
  touchUser(userId);
  const premium = isPremium(userId);
  const isOwner = String(userId) === String(config.ownerId);
  
  // Owner bypass semua limit
  if (!isOwner) {
    if (premium) {
      // Premium user: max 500 nomor
      if (numbers.length > 500) {
        await ctx.reply(
          `⚠️ Premium user max *500 nomor* per sekali.\n` +
          `Kamu input: *${numbers.length}* nomor.\n` +
          `Yang diproses: *500 nomor pertama*.`,
          { parse_mode: "Markdown" }
        );
        numbers = numbers.slice(0, 500);
      }
    } else {
      // Free user: ambil dari settings (default 100)
      const limit = getFreeBio1Limit();
      
      if (numbers.length > limit) {
        await ctx.reply(
          `⚠️ User FREE max *${limit} nomor* per sekali.\n` +
          `Kamu input: *${numbers.length}* nomor.\n` +
          `Yang diproses: *${limit} nomor pertama*.\n\n` +
          `💎 Upgrade premium untuk limit 500 nomor.`,
          { parse_mode: "Markdown" }
        );
        numbers = numbers.slice(0, limit);
      }
    }
  }
  
  await processBioCommand(ctx, numbers);
}

bot.command("bio1", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    const text = ctx.message.text;
    const args = text.split(" ").slice(1).join(" ");
    await bio1Logic(ctx, userId, args);
  });
});


bot.command("showlimits", async (ctx) => {
  if (String(ctx.from.id) !== String(config.ownerId)) return ctx.reply("❌ Owner only.");

  const bio1Limit = getFreeBio1Limit();
  const bio2Limit = getFreeBio2Limit();

  return ctx.reply(
    `📊 *CURRENT LIMITS SETTINGS*\n\n` +
    `*Free User Limits:*\n` +
    `• Bio1 (Input Koma): ${bio1Limit} nomor\n` +
    `• Bio2 (Per Baris): ${bio2Limit} nomor\n\n` +
    `*Premium User Limits:*\n` +
    `• Bio1: 500 nomor\n` +
    `• Bio2: Unlimited\n\n` +
    `*Owner:* Unlimited for all\n\n` +
    `*Commands:*\n` +
    `• \`/setbio1limit <number>\` - Set bio1 limit\n` +
    `• \`/setfreelimit <number>\` - Set bio2 limit`,
    { parse_mode: "Markdown" }
  );
});



// ✅ FUNGSI REUSABLE UNTUK BIO2
async function bio2Logic(ctx, userId, inputText) {
  if (!inputText || !inputText.trim()) {
    await ctx.reply("❌ *Format:* Kirim nomor per baris.\n*Contoh:*\n628123456789\n628987654321", { parse_mode: "Markdown" });
    return;
  }
  
  let numbers = extractNumbersFromText(inputText);
  
  if (numbers.length === 0) {
    await ctx.reply("❌ *Tidak ditemukan nomor yang valid.*\n\nPastikan format nomor:\n• Minimal 8 digit\n• Maksimal 15 digit\n• Satu baris satu nomor", { 
      parse_mode: "Markdown" 
    });
    return;
  }

  // ✅ CEK PREMIUM & LIMIT
  touchUser(userId);
  const premium = isPremium(userId);
  const isOwner = String(userId) === String(config.ownerId);

  // Owner bypass
  if (!isOwner) {
    // ✅ LIMIT FREE (ambil dari settings)
    const limit = getFreeBio2Limit(); // default 150

    if (!premium && numbers.length > limit) {
      await ctx.reply(
        `⚠️ User FREE max *${limit} nomor* per sekali.\n` +
        `Kamu input: *${numbers.length}* nomor.\n` +
        `Yang diproses: *${limit} nomor pertama*.\n\n` +
        `💎 Upgrade premium untuk tanpa limit.`,
        { parse_mode: "Markdown" }
      );

      numbers = numbers.slice(0, limit);
    }
  }
  
  await processBioCommand(ctx, numbers);
}

bot.command("bio2", async (ctx) => {
  const userId = ctx.from.id;
  
  addToQueue(userId, async () => {
    const text = ctx.message.text;
    const lines = text.split("\n").slice(1).join("\n");
    await bio2Logic(ctx, userId, lines);
  });
});



// ✅ FUNGSI REUSABLE UNTUK BIO3  
async function bio3Logic(ctx, userId, fileBuffer) {
  if (!fileBuffer) {
    await ctx.reply("❌ *File tidak valid!*", { parse_mode: "Markdown" });
    return;
  }
  
  let numbers = extractNumbersFromText(fileBuffer.toString());
  
  if (numbers.length === 0) {
    await ctx.reply("❌ *Tidak ditemukan nomor yang valid dalam file.*", { parse_mode: "Markdown" });
    return;
  }

  await processBioCommand(ctx, numbers);
}

bot.command("bio3", async (ctx) => {
  const userId = ctx.from.id;
  
  // ✅ Pengecekan Premium/Owner
  const premium = isPremium(userId);
  const owner = (userId == config.ownerId);
  
  if (!premium && !owner) {
    await ctx.reply(
      "❌ *Fitur bio3 hanya untuk Premium & Owner!*\n\n" +
      "💎 Upgrade ke Premium untuk akses unlimited!\n" +
      "📝 Ketik /premium untuk info lebih lanjut.",
      { parse_mode: "Markdown" }
    );
    return;
  }
  
  addToQueue(userId, async () => {
    const msg = ctx.message;
    let numbers = [];

    if (msg.reply_to_message && msg.reply_to_message.document) {
      const file = msg.reply_to_message.document;
      if (!file.file_name.endsWith('.txt')) {
        await ctx.reply("❌ *Hanya file .txt yang didukung!*", { parse_mode: "Markdown" });
        return;
      }
      
      try {
        const link = await ctx.telegram.getFileLink(file.file_id);
        const res = await fetch(link.href);
        const fileBuffer = Buffer.from(await res.arrayBuffer());
        
        await bio3Logic(ctx, userId, fileBuffer);
        return;
      } catch (error) {
        await ctx.reply("❌ *Error membaca file!* Pastikan file valid.", { parse_mode: "Markdown" });
        return;
      }
    } else {
      const lines = msg.text.split("\n").slice(1).join("\n");
      numbers = extractNumbersFromText(lines);
    }

    if (numbers.length === 0) {
      await ctx.reply("❌ *Tidak ditemukan nomor yang valid.*", { parse_mode: "Markdown" });
      return;
    }

    await processBioCommand(ctx, numbers);
  });
});


// ✅ HANDLER TEXT MESSAGE UNTUK AUTODESC DAN BIO
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  
  // Cek apakah user sedang menunggu input autodesc
  if (waitingForAutodescInput.has(userId)) {
    waitingForAutodescInput.delete(userId);
    const description = ctx.message.text.trim();
    
    addToQueue(userId, async () => {
      await autodescLogic(ctx, userId, description);
    });
    return;
  }
  
  // ✅ Cek apakah user sedang menunggu input kick member
  if (waitingForKickMemberLink.has(userId)) {
    waitingForKickMemberLink.delete(userId);
    const groupLink = ctx.message.text.trim();
    
    addToQueue(userId, async () => {
      await kickMemberLogic(ctx, userId, groupLink);
    });
    return;
  }
  
  // ✅ Cek apakah user sedang menunggu input bio1
  if (waitingForBio1Input.has(userId)) {
    waitingForBio1Input.delete(userId);
    const inputText = ctx.message.text.trim();
    
    addToQueue(userId, async () => {
      await bio1Logic(ctx, userId, inputText);
    });
    return;
  }
  
  // ✅ Cek apakah user sedang menunggu input bio2
  if (waitingForBio2Input.has(userId)) {
    waitingForBio2Input.delete(userId);
    const inputText = ctx.message.text.trim();
    
    addToQueue(userId, async () => {
      await bio2Logic(ctx, userId, inputText);
    });
    return;
  }
});

// ✅ HANDLER FOTO UNTUK AUTOSAMPUL
bot.on("photo", async (ctx) => {
  const userId = ctx.from.id;
  
  // Cek apakah user sedang menunggu foto autosampul
  if (waitingForAutosampulPhoto.has(userId)) {
    // Hapus state waiting
    waitingForAutosampulPhoto.delete(userId);
    
    try {
      // Ambil foto yang dikirim user
      const photo = ctx.message.photo;
      if (!photo || photo.length === 0) {
        await ctx.reply("❌ *Foto tidak valid!* Coba kirim ulang.", { parse_mode: "Markdown" });
        return;
      }
      
      // Ambil foto terbesar (kualitas terbaik)
      const best = photo[photo.length - 1];
      const fileId = best.file_id;
      
      // Download foto
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const res = await axios.get(String(fileLink), { responseType: "arraybuffer", timeout: 60000 });
      const imageBuffer = Buffer.from(res.data);
      
      // Langsung proses autosampul
      addToQueue(userId, async () => {
        await autosampulLogic(ctx, userId, imageBuffer);
      });
      
    } catch (error) {
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  }
});

// ✅ HANDLER DOCUMENT UNTUK BIO3
bot.on("document", async (ctx) => {
  const userId = ctx.from.id;
  
  // Cek apakah user sedang menunggu file bio3
  if (waitingForBio3Input.has(userId)) {
    waitingForBio3Input.delete(userId);
    
    // ✅ Pengecekan Premium/Owner
    const premium = isPremium(userId);
    const owner = (userId == config.ownerId);
    
    if (!premium && !owner) {
      await ctx.reply(
        "❌ *Fitur bio3 hanya untuk Premium & Owner!*\n\n" +
        "💎 Upgrade ke Premium untuk akses unlimited!\n" +
        "📝 Ketik /premium untuk info lebih lanjut.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    
    try {
      const file = ctx.message.document;
      
      // Validasi file .txt
      if (!file.file_name.endsWith('.txt')) {
        await ctx.reply("❌ *Hanya file .txt yang didukung!* Kirim ulang file yang benar.", { parse_mode: "Markdown" });
        return;
      }
      
      // Download file
      const link = await ctx.telegram.getFileLink(file.file_id);
      const res = await fetch(link.href);
      const fileBuffer = Buffer.from(await res.arrayBuffer());
      
      // Langsung proses bio3
      addToQueue(userId, async () => {
        await bio3Logic(ctx, userId, fileBuffer);
      });
      
    } catch (error) {
      await ctx.reply(`❌ Error: ${error.message}`);
    }
  }
});


let botStarted = false;

async function main() {
  if (botStarted) {
    return;
  }
  
  try {
    await bot.launch();
    botStarted = true;
    
    setTimeout(async () => {
      await restoreUserSessions();
    }, 2000);
    
    console.log('🤖 Bot berhasil dijalankan!');
    console.log('✅ Handler /start sudah diperbaiki');
    console.log('✅ Fitur verifikasi group sudah diperbaiki');
    console.log('✅ User yang belum join tidak akan error');
    console.log('📊 Pengecekan bio WhatsApp dengan akurasi 100% siap digunakan!');
    console.log('🖼️ Welcome photo siap digunakan dengan URL:', config.welcomePhoto || 'Tidak ada URL foto');
    console.log('🎶 Audio URL:', config.audioUrl || 'Tidak ada URL audio');
    console.log('🔥 Bot siap melayani!');
    
  } catch (error) {
    if (error.message && error.message.includes('409')) {
      console.log('Bot sudah berjalan');
      return;
    }
    console.error('Error starting bot:', error);
  }
}

module.exports = {
  startWA,
  deleteUserSession,
  checkUserWAConnection,
  listsesi: async (ctx) => {
    const userId = ctx.from.id;
    
    if (userId != config.ownerId) {
      await ctx.reply("❌ Akses ditolak!");
      return;
    }

    const now = Date.now();
    const fiveHours = 5 * 60 * 60 * 1000;
    
    let message = "📱 *DAFTAR SESSION AKTIF:*\n\n";
    let hasSessions = false;

    for (const [phone, data] of Object.entries(sessionData)) {
      const session = activeSessions.get(data.sessionId)
      const status = session ? "✅ Aktif" : "❌ Tidak Aktif"
      message += `└─ +${phone} | ${status}\n`
      message += `   └─ User ID: ${data.userId}\n\n`
      hasSessions = true
    }

    const sessionsToDelete = []
    Object.entries(sessionData).forEach(([phone, data]) => {
      const session = activeSessions.get(data.sessionId)
      if (!session && (now - data.pairedAt) > fiveHours) {
        sessionsToDelete.push({phone, sessionId: data.sessionId})
      }
    })

    sessionsToDelete.forEach(({phone, sessionId}) => {
      deleteSessionData(sessionId);
    })
    if (sessionsToDelete.length > 0) {
      saveSessions()
    }

    if (!hasSessions && Object.keys(sessionData).length === 0) {
      message = "❌ *Tidak ada session aktif.*"
    }

    await ctx.reply(message, { 
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Refresh", callback_data: "refresh_sessions" }],
          [{ text: "📋 Menu", callback_data: "back_menu" }]
        ]
      }
    });
  }
};

main();

process.once('SIGINT', () => {
  bot.stop('SIGINT');
});

process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
});

process.on('uncaughtException', (error) => {
  if (!error.message.includes('409')) {
    console.error('Uncaught Exception:', error);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  if (!String(reason).includes('409')) {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  }
});