/**
 * referrals.js
 * Referral program in EUR. Balance usable to pay for keys at checkout.
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
      balance: 0,       // EUR
      totalEarned: 0,   // EUR
      sales: 0,
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
    if (!discordId) return res.status(400).json({ ok: false, message: "Missing discordId." });
    const db = readDb();
    const user = db.users[discordId];
    if (!user) return res.json({ ok: true, balance: 0, totalEarned: 0, sales: 0, code: null, recentEarnings: [] });
    res.json({ ok: true, ...user });
  });

  // GET validate ref code
  app.get("/api/referrals/validate", (req, res) => {
    const { code, discordId } = req.query;
    if (!code) return res.status(400).json({ ok: false, message: "Missing code." });
    const db = readDb();
    const owner = Object.values(db.users).find(u => u.code === code.toUpperCase());
    if (!owner) return res.status(404).json({ ok: false, message: "Invalid code." });
    if (discordId && owner.discordId === discordId) {
      return res.status(400).json({ ok: false, message: "You cannot use your own referral code." });
    }
    res.json({ ok: true, code: owner.code, referrerId: owner.discordId });
  });

  // POST generate code
  app.post("/api/referrals/generate", (req, res) => {
    const { discordId } = req.body || {};
    if (!discordId) return res.status(400).json({ ok: false, message: "Missing discordId." });
    const db = readDb();
    const user = getOrCreate(db, discordId);
    if (!user.code) {
      let code = generateCode();
      const allCodes = Object.values(db.users).map(u => u.code);
      while (allCodes.includes(code)) code = generateCode();
      user.code = code;
      writeDb(db);
    }
    res.json({ ok: true, code: user.code });
  });

  // POST credit earnings (called from payments.js after delivery)
  app.post("/api/referrals/credit", (req, res) => {
    const { referrerDiscordId, amount } = req.body || {};
    if (!referrerDiscordId || !amount) return res.status(400).json({ ok: false });
    const db = readDb();
    const user = getOrCreate(db, referrerDiscordId);
    const earned = Number(Number(amount).toFixed(2));
    user.balance = Number((user.balance + earned).toFixed(2));
    user.totalEarned = Number((user.totalEarned + earned).toFixed(2));
    user.sales = (user.sales || 0) + 1;
    user.recentEarnings = user.recentEarnings || [];
    user.recentEarnings.unshift({ date: new Date().toISOString(), amount: earned });
    if (user.recentEarnings.length > 30) user.recentEarnings = user.recentEarnings.slice(0, 30);
    writeDb(db);
    res.json({ ok: true });
  });

  // POST use balance to pay for a key (full or partial)
  // Returns: { ok, appliedAmount, remainingPrice, newBalance }
  app.post("/api/referrals/use-balance", (req, res) => {
    const { discordId, priceEur } = req.body || {};
    if (!discordId || priceEur == null) {
      return res.status(400).json({ ok: false, message: "Missing discordId or priceEur." });
    }
    const price = Number(priceEur);
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ ok: false, message: "Invalid price." });
    }
    const db = readDb();
    const user = db.users[discordId];
    if (!user || user.balance <= 0) {
      return res.json({ ok: true, appliedAmount: 0, remainingPrice: price, newBalance: 0 });
    }
    const applied = Number(Math.min(user.balance, price).toFixed(2));
    const remaining = Number(Math.max(0, price - applied).toFixed(2));
    user.balance = Number((user.balance - applied).toFixed(2));
    writeDb(db);
    res.json({ ok: true, appliedAmount: applied, remainingPrice: remaining, newBalance: user.balance });
  });
}

module.exports = { mountReferralsApi };
