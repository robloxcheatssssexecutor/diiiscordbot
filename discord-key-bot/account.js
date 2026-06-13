const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ACCOUNT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ACCOUNT_COOKIE = "falcao_account_session";

/** @type {Map<string, { discordId: string, discordUsername: string, discordAvatar: string, expiresAt: number }>} */
const accountSessions = new Map();
/** @type {Map<string, number>} */
const accountOauthStates = new Map();
/** @type {Map<string, number>} */
const accountRateLimit = new Map();

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (!k) continue;
    out[k.trim()] = decodeURIComponent(v.join("="));
  }
  return out;
}

function getBaseUrl(req) {
  const fromEnv = String(process.env.BASE_URL || process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0)
    return forwarded.split(",")[0].trim();
  return req.ip || "";
}

function setAccountCookie(res, token, req) {
  const secure = getBaseUrl(req).startsWith("https");
  const parts = [
    `${ACCOUNT_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ACCOUNT_SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearAccountCookie(res, req) {
  const secure = getBaseUrl(req).startsWith("https");
  const parts = [`${ACCOUNT_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getAccountSession(req) {
  const token = parseCookies(req)[ACCOUNT_COOKIE];
  if (!token) return null;
  const session = accountSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    accountSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + ACCOUNT_SESSION_TTL_MS;
  return session;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [token, s] of accountSessions.entries()) {
    if (s.expiresAt < now) accountSessions.delete(token);
  }
  for (const [state, exp] of accountOauthStates.entries()) {
    if (exp < now) accountOauthStates.delete(state);
  }
}

function rateLimitAuth(ip) {
  const now = Date.now();
  const last = accountRateLimit.get(ip) || 0;
  if (now - last < 1500) return false;
  accountRateLimit.set(ip, now);
  return true;
}

// ---- Loaders storage ----
// loadersPath is set in mountAccountApi via deps

function mountAccountApi(app, deps) {
  const {
    readDb,
    writeDb,
    getKeyRecord,
    normalizeKey,
    normalizePlan,
    loadersPath
  } = deps;

  setInterval(cleanupSessions, 60 * 1000).unref();

  // ── OAuth login (Discord) ─────────────────────────────────────────────────
  app.get("/api/account/auth/login", (req, res) => {
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(503).json({ ok: false, message: "OAuth no configurado." });
      return;
    }
    const ip = getClientIp(req);
    if (!rateLimitAuth(ip)) {
      res.status(429).json({ ok: false, message: "Demasiados intentos." });
      return;
    }
    const state = createToken();
    accountOauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
    // Reuse the same redirect URI as /manage/auth/callback — it's already registered in Discord.
    // We distinguish account vs manage via the ?type=account query param embedded in state.
    const redirectUri = `${getBaseUrl(req)}/api/manage/auth/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "identify",
      state: "account:" + state
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  app.get("/api/account/auth/callback", async (req, res) => {
    // This handler is here as fallback if the account redirect_uri is ever registered separately.
    // Normally the callback goes through /api/manage/auth/callback (see account login above).
    const { code, state } = req.query || {};
    const clientId = process.env.DISCORD_CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    if (!code || !state || typeof code !== "string" || typeof state !== "string") {
      res.status(400).send("Parámetros OAuth inválidos.");
      return;
    }
    const rawState = state.startsWith("account:") ? state.slice(8) : state;
    const stateExp = accountOauthStates.get(rawState);
    accountOauthStates.delete(rawState);
    if (!stateExp || stateExp < Date.now()) {
      res.status(400).send("State expirado. Vuelve a intentar.");
      return;
    }
    try {
      const redirectUri = `${getBaseUrl(req)}/api/account/auth/callback`;
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
      const sessionToken = createToken();
      accountSessions.set(sessionToken, {
        discordId: String(user.id),
        discordUsername: user.username || user.global_name || "Unknown",
        discordAvatar: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`,
        expiresAt: Date.now() + ACCOUNT_SESSION_TTL_MS
      });
      setAccountCookie(res, sessionToken, req);
      res.redirect("/?tab=account");
    } catch (err) {
      console.error("[account] OAuth error:", err.message);
      res.status(500).send("Error interno de autenticación.");
    }
  });

  app.get("/api/account/auth/status", (req, res) => {
    const session = getAccountSession(req);
    if (!session) {
      res.json({ ok: true, authenticated: false });
      return;
    }
    res.json({
      ok: true,
      authenticated: true,
      discordId: session.discordId,
      discordUsername: session.discordUsername,
      discordAvatar: session.discordAvatar
    });
  });

  app.post("/api/account/auth/logout", (req, res) => {
    const token = parseCookies(req)[ACCOUNT_COOKIE];
    if (token) accountSessions.delete(token);
    clearAccountCookie(res, req);
    res.json({ ok: true });
  });

  // ── My keys ───────────────────────────────────────────────────────────────
  app.get("/api/account/keys", (req, res) => {
    const session = getAccountSession(req);
    if (!session) {
      res.status(401).json({ ok: false, message: "No autenticado." });
      return;
    }
    const db = readDb();
    const myKeys = db.keys
      .filter((k) => k.claimedBy === session.discordId)
      .map((k) => {
        const plan = normalizePlan(k.plan) || "falcao";
        const expired = k.expiresAt && new Date(k.expiresAt).getTime() < Date.now();
        const status = expired ? "expired" : (k.status || "active");
        return {
          key: k.key,
          plan,
          status,
          expiresAt: k.expiresAt || null,
          durationDays: k.durationDays || null,
          firstLoginAt: k.firstLoginAt || null,
          hwid: k.hwid || null,
          // Show download buttons only if key is active and not expired
          canDownload: status === "active" && !expired,
          // Which loaders they can download
          loaders: getAvailableLoaders(plan, loadersPath)
        };
      });
    res.json({ ok: true, keys: myKeys });
  });

  // ── Claim a key ───────────────────────────────────────────────────────────
  app.post("/api/account/claim", (req, res) => {
    const session = getAccountSession(req);
    if (!session) {
      res.status(401).json({ ok: false, message: "Debes iniciar sesión con Discord primero." });
      return;
    }
    const rawKey = String(req.body?.key || "").trim();
    if (!rawKey) {
      res.status(400).json({ ok: false, message: "Debes introducir una key." });
      return;
    }

    const db = readDb();
    const found = getKeyRecord(db, rawKey);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no encontrada." });
      return;
    }
    if (found.claimedBy) {
      if (found.claimedBy === session.discordId) {
        res.status(409).json({ ok: false, message: "Ya tienes esta key reclamada en tu cuenta." });
      } else {
        res.status(409).json({ ok: false, message: "Esta key ya ha sido reclamada por otro usuario." });
      }
      return;
    }
    if (found.status === "expired") {
      res.status(400).json({ ok: false, message: "Esta key ya está expirada y no se puede reclamar." });
      return;
    }

    // Bind the key to this Discord account
    found.claimedBy = session.discordId;
    found.claimedByUsername = session.discordUsername;
    found.claimedAt = new Date().toISOString();
    writeDb(db);

    res.json({
      ok: true,
      message: "Key reclamada correctamente.",
      key: {
        key: found.key,
        plan: normalizePlan(found.plan) || "falcao",
        status: found.status || "active",
        expiresAt: found.expiresAt || null
      }
    });
  });

  // ── Download loader ───────────────────────────────────────────────────────
  app.get("/api/account/download/:loaderType", (req, res) => {
    const session = getAccountSession(req);
    if (!session) {
      res.status(401).json({ ok: false, message: "No autenticado." });
      return;
    }
    const loaderType = req.params.loaderType; // "falcao" or "temp"
    if (loaderType !== "falcao" && loaderType !== "temp") {
      res.status(400).json({ ok: false, message: "Tipo de loader inválido." });
      return;
    }

    // Check the user has at least one active key that grants access to this loader
    const db = readDb();
    const eligibleKey = db.keys.find((k) => {
      if (k.claimedBy !== session.discordId) return false;
      if (k.status !== "active") return false;
      if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return false;
      const plan = normalizePlan(k.plan) || "falcao";
      return plan === loaderType || plan === "both";
    });

    if (!eligibleKey) {
      res.status(403).json({
        ok: false,
        message: `No tienes ninguna key activa con acceso al loader "${loaderType}".`
      });
      return;
    }

    const loaderFile = getLoaderPath(loaderType, loadersPath);
    if (!loaderFile || !fs.existsSync(loaderFile)) {
      res.status(404).json({ ok: false, message: "El loader aún no está disponible. El administrador debe subirlo primero." });
      return;
    }

    const fileName = path.basename(loaderFile);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.sendFile(path.resolve(loaderFile));
  });

  app.get(["/account", "/account/"], (_req, res) => {
    // Redirect to the SPA with the account tab active
    res.redirect("/?tab=account");
  });

  app.get(["/claim", "/claim/"], (_req, res) => {
    // Redirect to the SPA with the claim tab active
    res.redirect("/?tab=claim");
  });
}

// ── Loader helpers ────────────────────────────────────────────────────────────

function getLoaderPath(type, loadersPath) {
  if (!loadersPath) return null;
  const meta = getLoadersMeta(loadersPath);
  if (type === "falcao") return meta.falcao ? path.join(loadersPath, meta.falcao) : null;
  if (type === "temp") return meta.temp ? path.join(loadersPath, meta.temp) : null;
  return null;
}

function getLoadersMeta(loadersPath) {
  if (!loadersPath) return {};
  const metaPath = path.join(loadersPath, "loaders.json");
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveLoadersMeta(loadersPath, meta) {
  if (!loadersPath) return;
  fs.mkdirSync(loadersPath, { recursive: true });
  fs.writeFileSync(path.join(loadersPath, "loaders.json"), JSON.stringify(meta, null, 2), "utf8");
}

function getAvailableLoaders(plan, loadersPath) {
  const meta = getLoadersMeta(loadersPath);
  const out = [];
  if ((plan === "falcao" || plan === "both") && meta.falcao) out.push("falcao");
  if ((plan === "temp" || plan === "both") && meta.temp) out.push("temp");
  return out;
}

// ── Exported OAuth handler (called from manage.js callback when state starts with "account:") ──
async function handleAccountOAuthCallback(req, res, code, rawState) {
  const stateExp = accountOauthStates.get(rawState);
  accountOauthStates.delete(rawState);
  if (!stateExp || stateExp < Date.now()) {
    res.status(400).send("State expirado. Vuelve a intentar.");
    return;
  }
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
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
    const sessionToken = createToken();
    accountSessions.set(sessionToken, {
      discordId: String(user.id),
      discordUsername: user.username || user.global_name || "Unknown",
      discordAvatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`,
      expiresAt: Date.now() + ACCOUNT_SESSION_TTL_MS
    });
    setAccountCookie(res, sessionToken, req);
    res.redirect("/?tab=account");
  } catch (err) {
    console.error("[account] OAuth callback error:", err.message);
    res.status(500).send("Error interno de autenticación.");
  }
}

module.exports = {
  mountAccountApi,
  getLoadersMeta,
  saveLoadersMeta,
  getLoaderPath,
  handleAccountOAuthCallback
};
