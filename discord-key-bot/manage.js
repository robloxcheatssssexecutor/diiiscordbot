const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let manageHtmlCached = null;

function getManageHtml() {
  if (manageHtmlCached) return manageHtmlCached;
  const candidates = [
    path.join(__dirname, "manage", "index.html"),
    path.join(__dirname, "public", "manage", "index.html")
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return (manageHtmlCached = fs.readFileSync(candidate, "utf8"));
      }
    } catch (_) {
      /* try next */
    }
  }
  try {
    return (manageHtmlCached = require("./manage-page"));
  } catch (_) {
    return null;
  }
}

const MANAGE_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const MANAGE_COOKIE = "falcao_manage_session";

/** @type {Map<string, { discordId: string, expiresAt: number }>} */
const manageSessions = new Map();
/** @type {Map<string, number>} */
const oauthStates = new Map();
/** @type {Map<string, number>} */
const authRateLimit = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(v.join("="));
  }
  return out;
}

function getAdminIds() {
  const raw = process.env.ADMIN_IDS || "";
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function getBaseUrl(req) {
  const fromEnv = String(process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function createManageToken() {
  return crypto.randomBytes(32).toString("hex");
}

function cleanupManageSessions() {
  const now = Date.now();
  for (const [token, session] of manageSessions.entries()) {
    if (session.expiresAt < now) manageSessions.delete(token);
  }
  for (const [state, expiresAt] of oauthStates.entries()) {
    if (expiresAt < now) oauthStates.delete(state);
  }
}

function setManageCookie(res, token, req) {
  const secure = getBaseUrl(req).startsWith("https");
  const parts = [
    `${MANAGE_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(MANAGE_SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearManageCookie(res, req) {
  const secure = getBaseUrl(req).startsWith("https");
  const parts = [`${MANAGE_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getManageSession(req) {
  const token = parseCookies(req)[MANAGE_COOKIE];
  if (!token) return null;
  const session = manageSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    manageSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + MANAGE_SESSION_TTL_MS;
  return session;
}

function isAdminDiscordId(discordId) {
  return getAdminIds().has(String(discordId));
}

function rateLimitAuth(ip) {
  const now = Date.now();
  const last = authRateLimit.get(ip) || 0;
  if (now - last < 2000) return false;
  authRateLimit.set(ip, now);
  return true;
}

function requireManageAuth(req, res) {
  const session = getManageSession(req);
  if (!session || !isAdminDiscordId(session.discordId)) {
    res.status(401).json({ ok: false, message: "No autorizado." });
    return null;
  }
  return session;
}

function parseDurationInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const asNum = Number(text);
  if (Number.isFinite(asNum) && asNum > 0) return asNum * 24 * 60 * 60 * 1000;
  const match = /^(\d+)([smhdw])$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  const table = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 };
  return value * table[unit];
}

function mountManageApi(app, deps) {
  const {
    express,
    readDb,
    writeDb,
    getKeyRecord,
    normalizeKey,
    generateKey,
    calcExpiresAt,
    normalizePlan
  } = deps;

  setInterval(cleanupManageSessions, 60 * 1000).unref();

  app.get(["/manage", "/manage/"], (_req, res) => {
    const html = getManageHtml();
    if (!html) {
      res.status(503).type("text/plain").send("Manage no disponible.");
      return;
    }
    res.type("html").send(html);
  });

  app.get("/api/manage/auth/status", (req, res) => {
    const session = getManageSession(req);
    if (!session || !isAdminDiscordId(session.discordId)) {
      res.json({ ok: true, authenticated: false });
      return;
    }
    res.json({ ok: true, authenticated: true, discordId: session.discordId });
  });

  app.get("/api/manage/auth/login", (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({ ok: false, message: "OAuth no configurado (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET)." });
      return;
    }
    const ip = deps.getClientIp(req);
    if (!rateLimitAuth(ip)) {
      res.status(429).json({ ok: false, message: "Demasiados intentos." });
      return;
    }
    const state = createManageToken();
    oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    const redirectUri = `${getBaseUrl(req)}/api/manage/auth/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  app.get("/api/manage/auth/callback", async (req, res) => {
    const { code, state } = req.query || {};
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      res.status(400).send("Parametros OAuth invalidos.");
      return;
    }
    const stateExpires = oauthStates.get(state);
    oauthStates.delete(state);
    if (!stateExpires || stateExpires < Date.now()) {
      res.status(400).send("State expirado. Vuelve a intentar.");
      return;
    }
    try {
      const redirectUri = `${getBaseUrl(req)}/api/manage/auth/callback`;
      const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri
        })
      });
      const tokenData = await tokenRes.json();
      if (!tokenRes.ok || !tokenData.access_token) {
        res.status(403).send("No se pudo autenticar con Discord.");
        return;
      }
      const userRes = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      const user = await userRes.json();
      if (!userRes.ok || !user.id) {
        res.status(403).send("No se pudo leer tu usuario de Discord.");
        return;
      }
      if (!isAdminDiscordId(user.id)) {
        res.status(403).send("Acceso denegado. Esta cuenta no tiene permisos de administrador.");
        return;
      }
      const sessionToken = createManageToken();
      manageSessions.set(sessionToken, {
        discordId: String(user.id),
        expiresAt: Date.now() + MANAGE_SESSION_TTL_MS
      });
      setManageCookie(res, sessionToken, req);
      res.redirect("/manage");
    } catch (err) {
      console.error("[manage] OAuth error:", err.message);
      res.status(500).send("Error interno de autenticacion.");
    }
  });

  app.post("/api/manage/auth/logout", (req, res) => {
    const token = parseCookies(req)[MANAGE_COOKIE];
    if (token) manageSessions.delete(token);
    clearManageCookie(res, req);
    res.json({ ok: true });
  });

  app.get("/api/manage/keys", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const db = readDb();
    const q = String(req.query.q || "").trim().toUpperCase();
    let keys = [...db.keys];
    if (q) keys = keys.filter((k) => normalizeKey(k.key).includes(q));
    keys.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 50));
    const start = (page - 1) * limit;
    const slice = keys.slice(start, start + limit).map((k) => ({
      key: k.key,
      plan: normalizePlan(k.plan) || "falcao",
      status: k.status || "active",
      durationDays: k.durationDays ?? null,
      createdAt: k.createdAt || null,
      expiresAt: k.expiresAt || null,
      firstLoginAt: k.firstLoginAt || null,
      hwid: k.hwid || null,
      ip: k.ip || null,
      note: k.note || null
    }));
    res.json({ ok: true, total: keys.length, page, limit, keys: slice });
  });

  app.post("/api/manage/keys", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const { days, plan } = req.body || {};
    const durationDays = Math.max(1, parseInt(days, 10) || 30);
    const normalizedPlan = normalizePlan(plan) || "falcao";
    const db = readDb();
    let key = generateKey();
    while (getKeyRecord(db, key)) key = generateKey();
    const record = {
      key,
      plan: normalizedPlan,
      status: "active",
      createdAt: new Date().toISOString(),
      durationDays,
      expiresAt: calcExpiresAt(durationDays),
      firstLoginAt: null,
      hwid: null,
      ip: null,
      note: null
    };
    db.keys.push(record);
    writeDb(db);
    res.json({ ok: true, key: record });
  });

  app.delete("/api/manage/keys/:key", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const target = normalizeKey(req.params.key);
    const db = readDb();
    const before = db.keys.length;
    db.keys = db.keys.filter((k) => normalizeKey(k.key) !== target);
    if (db.keys.length === before) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    writeDb(db);
    res.json({ ok: true });
  });

  app.post("/api/manage/keys/:key/add-time", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const target = normalizeKey(req.params.key);
    const db = readDb();
    const found = getKeyRecord(db, target);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    const ms = parseDurationInput(req.body?.duration) || (parseInt(req.body?.days, 10) || 0) * 24 * 60 * 60 * 1000;
    if (!ms || ms <= 0) {
      res.status(400).json({ ok: false, message: "Duracion invalida (ej: 7d, 2w, 30)." });
      return;
    }
    const base = found.expiresAt ? new Date(found.expiresAt).getTime() : Date.now();
    const next = Math.max(Date.now(), base) + ms;
    found.expiresAt = new Date(next).toISOString();
    if (found.status === "expired") found.status = "active";
    writeDb(db);
    res.json({ ok: true, expiresAt: found.expiresAt });
  });

  app.post("/api/manage/keys/:key/remove-time", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const target = normalizeKey(req.params.key);
    const db = readDb();
    const found = getKeyRecord(db, target);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    const ms = parseDurationInput(req.body?.duration) || (parseInt(req.body?.days, 10) || 0) * 24 * 60 * 60 * 1000;
    if (!ms || ms <= 0) {
      res.status(400).json({ ok: false, message: "Duracion invalida." });
      return;
    }
    if (!found.expiresAt) {
      res.status(400).json({ ok: false, message: "Key sin fecha de expiracion." });
      return;
    }
    const next = new Date(found.expiresAt).getTime() - ms;
    found.expiresAt = new Date(Math.max(Date.now(), next)).toISOString();
    if (new Date(found.expiresAt).getTime() <= Date.now()) found.status = "expired";
    writeDb(db);
    res.json({ ok: true, expiresAt: found.expiresAt, status: found.status });
  });

  app.post("/api/manage/keys/:key/reset-hwid", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const target = normalizeKey(req.params.key);
    const db = readDb();
    const found = getKeyRecord(db, target);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    found.hwid = null;
    found.ip = null;
    found.firstLoginAt = null;
    writeDb(db);
    res.json({ ok: true });
  });

  app.patch("/api/manage/keys/:key", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const target = normalizeKey(req.params.key);
    const db = readDb();
    const found = getKeyRecord(db, target);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    const { status, note, plan } = req.body || {};
    if (status && ["active", "expired", "paused"].includes(status)) found.status = status;
    if (note !== undefined) found.note = String(note || "").slice(0, 200) || null;
    if (plan) {
      const p = normalizePlan(plan);
      if (p) found.plan = p;
    }
    writeDb(db);
    res.json({ ok: true, key: found });
  });
}

module.exports = { mountManageApi };
