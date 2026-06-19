/**
 * referrals.js
 * Stub implementation for the referral system.
 * Prevents MODULE_NOT_FOUND crash on startup.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** @type {Map<string, { discordId: string, code: string, balance: number }>} */
const referrals = new Map();
let referralsPath = null;

function ensureReferralsFile() {
  if (!referralsPath) return;
  if (!fs.existsSync(referralsPath)) {
    fs.writeFileSync(referralsPath, JSON.stringify({ referrals: [] }, null, 2), "utf8");
  }
}

function loadReferrals() {
  if (!referralsPath || !fs.existsSync(referralsPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(referralsPath, "utf8"));
    if (Array.isArray(raw.referrals)) {
      for (const r of raw.referrals) {
        referrals.set(r.discordId, r);
      }
    }
  } catch (_) {}
}

function saveReferrals() {
  if (!referralsPath) return;
  ensureReferralsFile();
  try {
    fs.writeFileSync(referralsPath, JSON.stringify({ referrals: [...referrals.values()] }, null, 2), "utf8");
  } catch (_) {}
}

function getOrCreateReferral(discordId) {
  if (!referrals.has(discordId)) {
    referrals.set(discordId, {
      discordId,
      code: crypto.randomBytes(4).toString("hex").toUpperCase(),
      balance: 0
    });
    saveReferrals();
  }
  return referrals.get(discordId);
}

function mountReferralsApi(app, deps) {
  const { dataDir } = deps;
  referralsPath = path.join(dataDir, "referrals.json");
  loadReferrals();

  // GET /api/referrals/code?discordId=... — get or create referral code
  app.get("/api/referrals/code", (req, res) => {
    const discordId = String(req.query.discordId || "").trim();
    if (!discordId) {
      res.status(400).json({ ok: false, message: "discordId requerido." });
      return;
    }
    const ref = getOrCreateReferral(discordId);
    res.json({ ok: true, code: ref.code, balance: ref.balance });
  });

  // GET /api/referrals/validate?code=...&discordId=... — validate a referral code
  app.get("/api/referrals/validate", (req, res) => {
    const code = String(req.query.code || "").trim().toUpperCase();
    const discordId = String(req.query.discordId || "").trim();
    if (!code) {
      res.json({ ok: false, message: "Código inválido." });
      return;
    }
    const found = [...referrals.values()].find(r => r.code === code);
    if (!found) {
      res.json({ ok: false, message: "Código de referido no encontrado." });
      return;
    }
    if (found.discordId === discordId) {
      res.json({ ok: false, message: "No puedes usar tu propio código de referido." });
      return;
    }
    res.json({ ok: true, referrerId: found.discordId });
  });

  // POST /api/referrals/credit — credit a referrer
  app.post("/api/referrals/credit", (req, res) => {
    const { referrerDiscordId, amount } = req.body || {};
    if (!referrerDiscordId || !amount) {
      res.status(400).json({ ok: false });
      return;
    }
    const ref = getOrCreateReferral(referrerDiscordId);
    ref.balance = Number(((ref.balance || 0) + Number(amount)).toFixed(2));
    saveReferrals();
    res.json({ ok: true, balance: ref.balance });
  });

  // POST /api/referrals/use-balance — apply balance toward a purchase
  app.post("/api/referrals/use-balance", (req, res) => {
    const { discordId, priceEur } = req.body || {};
    if (!discordId || !priceEur) {
      res.status(400).json({ ok: false });
      return;
    }
    const ref = referrals.get(discordId);
    const balance = ref ? (ref.balance || 0) : 0;
    const price = Number(priceEur);
    const applied = Math.min(balance, price);
    const remaining = Number((price - applied).toFixed(2));

    if (applied > 0 && ref) {
      ref.balance = Number((balance - applied).toFixed(2));
      saveReferrals();
    }

    res.json({ ok: true, appliedAmount: applied, remainingPrice: remaining, newBalance: ref ? ref.balance : 0 });
  });

  // GET /api/referrals/balance?discordId=... — get current balance
  app.get("/api/referrals/balance", (req, res) => {
    const discordId = String(req.query.discordId || "").trim();
    if (!discordId) {
      res.status(400).json({ ok: false });
      return;
    }
    const ref = referrals.get(discordId);
    res.json({ ok: true, balance: ref ? (ref.balance || 0) : 0 });
  });
}

module.exports = { mountReferralsApi };
