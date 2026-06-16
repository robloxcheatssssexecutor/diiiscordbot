/**
 * referrals.js
 * Simple referral program: generate code, track earnings, request withdrawal.
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

let _dataDir = null;
let _refPath = null;

function ensureFile() {
  if (!_refPath) return;
  if (!fs.existsSync(_refPath)) {
    fs.writeFileSync(_refPath, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

function readDb() {
  ensureFile();
  try { return JSON.parse(fs.readFileSync(_refPath, "utf8")); }
  catch (_) { return { users: {} }; }
}

function writeDb(db) {
  ensureFile();
  fs.writeFileSync(_refPath, JSON.stringify(db, null, 2), "utf8");
}

function generateCode() {
  return "REF-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

function getOrCreate(db, discordId) {
  if (!db.users[discordId]) {
    db.users[discordId] = {
      discordId,
      code: null,
      balance: 0,
      totalEarned: 0,
      withdrawn: 0,
      sales: 0,
      payouts: [],
      recentEarnings: []
    };
  }
  return db.users[discordId];
}

function mountReferralsApi(app, deps) {
  const { dataDir } = deps;
  _dataDir = dataDir;
  _refPath = path.join(dataDir, "referrals.json");

  // GET status
  app.get("/api/referrals/status", (req, res) => {
    const { discordId } = req.query;
    if (!discordId) return res.status(400).json({ ok: false, message: "Falta discordId." });
    const db = readDb();
    const user = db.users[discordId];
    if (!user) return res.json({ ok: true, balance: 0, totalEarned: 0, withdrawn: 0, sales: 0, code: null, payouts: [], recentEarnings: [] });
    res.json({ ok: true, ...user });
  });

  // POST generate code
  app.post("/api/referrals/generate", (req, res) => {
    const { discordId } = req.body || {};
    if (!discordId) return res.status(400).json({ ok: false, message: "Falta discordId." });
    const db = readDb();
    const user = getOrCreate(db, discordId);
    if (!user.code) {
      // ensure unique
      let code = generateCode();
      const allCodes = Object.values(db.users).map(u => u.code);
      while (allCodes.includes(code)) code = generateCode();
      user.code = code;
      writeDb(db);
    }
    res.json({ ok: true, code: user.code });
  });

  // POST withdraw request (sends webhook to admin, does not auto-process)
  app.post("/api/referrals/withdraw", async (req, res) => {
    const { discordId, address, amount, crypto: cryptoType } = req.body || {};
    if (!discordId || !address || !amount) return res.status(400).json({ ok: false, message: "Faltan campos." });
    const db = readDb();
    const user = db.users[discordId];
    if (!user) return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
    if (user.balance < 25) return res.status(400).json({ ok: false, message: "Saldo insuficiente. Mínimo $25." });
    if (Number(amount) > user.balance) return res.status(400).json({ ok: false, message: "Cantidad superior al saldo disponible." });

    // Log the request
    user.payouts.push({ date: new Date().toISOString(), amount: Number(amount), crypto: cryptoType || "ltc", address, status: "pending" });
    writeDb(db);

    // Notify admin via webhook if configured
    const webhookUrl = process.env.PAYMENT_DISCORD_WEBHOOK;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `💸 **Referral Withdrawal Request**\nDiscord: <@${discordId}>\nAmount: **$${amount}**\nCrypto: ${cryptoType || "ltc"}\nAddress: \`${address}\`` })
      }).catch(() => {});
    }

    res.json({ ok: true, message: "Solicitud enviada. Se procesará en 72 horas." });
  });

  // POST credit earnings (called internally when a referred sale completes)
  app.post("/api/referrals/credit", (req, res) => {
    const { referrerDiscordId, amount } = req.body || {};
    if (!referrerDiscordId || !amount) return res.status(400).json({ ok: false });
    const db = readDb();
    const user = getOrCreate(db, referrerDiscordId);
    const earned = Number(amount);
    user.balance = Number((user.balance + earned).toFixed(2));
    user.totalEarned = Number((user.totalEarned + earned).toFixed(2));
    user.sales = (user.sales || 0) + 1;
    user.recentEarnings = user.recentEarnings || [];
    user.recentEarnings.unshift({ date: new Date().toISOString(), amount: earned });
    if (user.recentEarnings.length > 20) user.recentEarnings = user.recentEarnings.slice(0, 20);
    writeDb(db);
    res.json({ ok: true });
  });
}

module.exports = { mountReferralsApi };
