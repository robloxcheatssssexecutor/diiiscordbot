const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureJsonFile(filePath, defaultObj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultObj, null, 2), "utf8");
  }
}

function readJson(filePath, fallback) {
  ensureJsonFile(filePath, fallback);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function defaultUpdates() {
  return {
    falcao: [
      {
        version: "3.0",
        date: "2026-06-01",
        title: "Falcao External 3.0",
        notes: "Stable online build, bypass updates, and UI refresh."
      }
    ],
    temp: [
      {
        version: "1.0",
        date: "2026-06-01",
        title: "Temp Menu",
        notes: "Initial Spectacle integration with FalcaoProject launcher."
      }
    ]
  };
}

function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  return crypto.scryptSync(String(password), salt, 64).toString("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function normalizeUsername(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
}

function resolveProductsFromKeys(keysDb, claimedKeys, maskKey) {
  let falcao = false;
  let temp = false;
  const licenses = [];
  for (const keyValue of claimedKeys || []) {
    const found = keysDb.keys.find((k) => String(k.key).toUpperCase() === String(keyValue).toUpperCase());
    if (!found) continue;
    const plan = (found.plan || "falcao").toLowerCase();
    const expired = found.status === "expired" || (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now());
    if (expired || found.status !== "active") continue;
    licenses.push({
      license_key_masked: maskKey(found.key),
      plan,
      expires_at: found.expiresAt || "",
      status: found.status
    });
    if (plan === "both") {
      falcao = true;
      temp = true;
    } else if (plan === "temp") {
      temp = true;
    } else {
      falcao = true;
    }
  }
  return { falcao, temp, licenses };
}

function mountUserRoutes(app, deps) {
  const {
    dataDir,
    atomicWriteJsonFile,
    readDb,
    writeDb,
    getKeyRecord,
    validateAndBindKey,
    maskLicenseKey,
    getClientIp,
    normalizePlan
  } = deps;

  const usersPath = path.join(dataDir, "users.json");
  const updatesPath = path.join(dataDir, "updates.json");

  const readUsersDb = () => readJson(usersPath, { users: [] });
  const writeUsersDb = (db) => atomicWriteJsonFile(usersPath, db);
  const readUpdates = () => readJson(updatesPath, defaultUpdates());

  function findUserByUsername(db, username) {
    const needle = normalizeUsername(username);
    return db.users.find((u) => normalizeUsername(u.username) === needle) || null;
  }

  function findUserByToken(db, token) {
    if (!token) return null;
    return db.users.find((u) => u.sessionToken === token) || null;
  }

  app.post("/api/v1/users/register", (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    if (!username || username.length < 3) {
      res.status(400).json({ success: false, message: "Username must be at least 3 characters." });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
      return;
    }

    const db = readUsersDb();
    if (findUserByUsername(db, username)) {
      res.status(409).json({ success: false, message: "Username already exists." });
      return;
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordSalt: salt,
      passwordHash: hashPassword(password, salt),
      claimedKeys: [],
      sessionToken: "",
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    writeUsersDb(db);
    res.json({ success: true, message: "Account created." });
  });

  app.post("/api/v1/users/login", (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const password = String(req.body?.password || "");
    const db = readUsersDb();
    const user = findUserByUsername(db, username);
    if (!user) {
      res.status(401).json({ success: false, message: "Invalid username or password." });
      return;
    }
    const hash = hashPassword(password, user.passwordSalt);
    if (hash !== user.passwordHash) {
      res.status(401).json({ success: false, message: "Invalid username or password." });
      return;
    }

    user.sessionToken = createToken();
    user.lastLoginAt = new Date().toISOString();
    writeUsersDb(db);

    const keysDb = readDb();
    const products = resolveProductsFromKeys(keysDb, user.claimedKeys, maskLicenseKey);
    res.json({
      success: true,
      token: user.sessionToken,
      username: user.username,
      products: { falcao: products.falcao, temp: products.temp },
      licenses: products.licenses
    });
  });

  app.post("/api/v1/users/profile", (req, res) => {
    const token = String(req.body?.token || req.headers["x-session-token"] || "");
    const db = readUsersDb();
    const user = findUserByToken(db, token);
    if (!user) {
      res.status(401).json({ success: false, message: "Invalid session." });
      return;
    }

    const keysDb = readDb();
    const products = resolveProductsFromKeys(keysDb, user.claimedKeys, maskLicenseKey);
    const updates = readUpdates();
    res.json({
      success: true,
      username: user.username,
      products: { falcao: products.falcao, temp: products.temp },
      licenses: products.licenses,
      updates
    });
  });

  app.post("/api/v1/users/claim", (req, res) => {
    const token = String(req.body?.token || "");
    const licenseKey = String(req.body?.license_key || "");
    const hwid = String(req.body?.hwid || "");
    const ipHint = String(req.body?.ip_hint || "");
    const ip = ipHint || getClientIp(req);

    if (!token || !licenseKey || !hwid) {
      res.status(400).json({ success: false, message: "Missing token, license_key or hwid." });
      return;
    }

    const usersDb = readUsersDb();
    const user = findUserByToken(usersDb, token);
    if (!user) {
      res.status(401).json({ success: false, message: "Invalid session." });
      return;
    }

    const keysDb = readDb();
    const found = getKeyRecord(keysDb, licenseKey);
    if (!found) {
      res.status(404).json({ success: false, message: "License key not found." });
      return;
    }
    if (found.status !== "active") {
      res.status(403).json({ success: false, message: `License is not active (${found.status}).` });
      return;
    }
    if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) {
      found.status = "expired";
      writeDb(keysDb);
      res.status(403).json({ success: false, message: "License expired." });
      return;
    }

    const normalizedKey = String(found.key).toUpperCase();
    if (found.claimedByUserId && found.claimedByUserId !== user.id) {
      res.status(403).json({ success: false, message: "This license is already linked to another account." });
      return;
    }

    const bind = validateAndBindKey(keysDb, licenseKey, hwid, ip, "");
    if (!bind.ok) {
      res.status(403).json({ success: false, message: bind.message });
      return;
    }

    if (!user.claimedKeys.includes(normalizedKey)) {
      user.claimedKeys.push(normalizedKey);
    }
    found.claimedByUserId = user.id;
    writeDb(keysDb);
    writeUsersDb(usersDb);

    const products = resolveProductsFromKeys(keysDb, user.claimedKeys, maskLicenseKey);
    res.json({
      success: true,
      message: "License claimed successfully.",
      plan: normalizePlan(found.plan) || "falcao",
      products: { falcao: products.falcao, temp: products.temp },
      licenses: products.licenses
    });
  });

  app.get("/api/v1/updates", (_req, res) => {
    res.json({ success: true, updates: readUpdates() });
  });
}

module.exports = { mountUserRoutes, defaultUpdates };
