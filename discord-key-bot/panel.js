const crypto = require("crypto");
const path = require("path");
const panelSchema = require("./panel-schema");

const PANEL_CLIENT_TTL_MS = 45 * 1000;
const PANEL_WEB_TTL_MS = 4 * 60 * 60 * 1000;
const PANEL_MAX_COMMANDS = 200;
const PANEL_MAX_COMMANDS_PER_REQUEST = 64;

/** @type {Map<string, PanelSession>} */
const panelSessions = new Map();

/**
 * @typedef {Object} PanelSession
 * @property {string} keyNorm
 * @property {string} hwid
 * @property {string} clientToken
 * @property {string|null} webToken
 * @property {number} lastClientSeen
 * @property {number|null} lastWebSeen
 * @property {number|null} webExpiresAt
 * @property {object|null} state
 * @property {Array<object>} commands
 */

function createPanelToken() {
  return crypto.randomBytes(24).toString("hex");
}

function maskLicenseKey(key) {
  if (!key || key.length < 8) return key || "";
  return `${key.slice(0, 8)}****${key.slice(-4)}`;
}

function isClientOnline(session) {
  return !!session && Date.now() - session.lastClientSeen <= PANEL_CLIENT_TTL_MS;
}

function getSessionByClientToken(token) {
  if (!token) return null;
  for (const session of panelSessions.values()) {
    if (session.clientToken === token) return session;
  }
  return null;
}

function getSessionByWebToken(token) {
  if (!token) return null;
  for (const session of panelSessions.values()) {
    if (session.webToken === token) return session;
  }
  return null;
}

function ensureSession(keyNorm) {
  let session = panelSessions.get(keyNorm);
  if (!session) {
    session = {
      keyNorm,
      hwid: "",
      clientToken: createPanelToken(),
      webToken: null,
      lastClientSeen: 0,
      lastWebSeen: null,
      webExpiresAt: null,
      state: null,
      commands: []
    };
    panelSessions.set(keyNorm, session);
  }
  return session;
}

function validatePanelKey(deps, key, hwid) {
  const { getKeyRecord, writeDb, readDb } = deps;
  const db = readDb();
  const found = getKeyRecord(db, key);
  if (!found) {
    return { ok: false, message: "Key no existe." };
  }
  if (found.status !== "active") {
    return { ok: false, message: `Key no valida. Estado: ${found.status}` };
  }
  if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) {
    found.status = "expired";
    writeDb(db);
    return { ok: false, message: "Key expirada." };
  }
  if (!found.firstLoginAt) {
    return { ok: false, message: "Activa la key primero en el external." };
  }
  if (found.hwid && hwid && found.hwid !== hwid) {
    return { ok: false, message: "HWID no coincide con la key." };
  }
  return { ok: true, key: found };
}

function queueCommands(session, commands) {
  if (!Array.isArray(commands) || !commands.length) {
    return 0;
  }
  const slice = commands.slice(0, PANEL_MAX_COMMANDS_PER_REQUEST);
  session.commands.push(...slice);
  if (session.commands.length > PANEL_MAX_COMMANDS) {
    session.commands = session.commands.slice(-PANEL_MAX_COMMANDS);
  }
  return slice.length;
}

function cleanupPanelSessions() {
  const now = Date.now();
  for (const [keyNorm, session] of panelSessions.entries()) {
    const clientStale = now - session.lastClientSeen > 10 * 60 * 1000;
    const webExpired = session.webExpiresAt && session.webExpiresAt < now;
    if (clientStale && webExpired) {
      panelSessions.delete(keyNorm);
    }
  }
}

function mountPanelApi(app, deps) {
  const {
    normalizeKey,
    getKeyRecord,
    readDb,
    writeDb,
    getClientIp
  } = deps;

  setInterval(cleanupPanelSessions, 60 * 1000).unref();

  app.get("/api/panel/schema", (_req, res) => {
    res.json({ ok: true, schema: panelSchema });
  });

  app.post("/api/panel/client/register", (req, res) => {
    const { key, hwid } = req.body || {};
    if (!key || !hwid) {
      res.status(400).json({ ok: false, message: "Faltan campos: key, hwid." });
      return;
    }

    const validation = validatePanelKey(deps, key, hwid);
    if (!validation.ok) {
      res.status(403).json({ ok: false, message: validation.message });
      return;
    }

    const keyNorm = normalizeKey(key);
    const session = ensureSession(keyNorm);
    session.hwid = hwid;
    session.clientToken = createPanelToken();
    session.lastClientSeen = Date.now();

    res.json({
      ok: true,
      clientToken: session.clientToken,
      keyMasked: maskLicenseKey(keyNorm)
    });
  });

  app.post("/api/panel/client/sync", (req, res) => {
    const clientToken = req.headers["x-panel-client-token"];
    const session = getSessionByClientToken(String(clientToken || ""));
    if (!session) {
      res.status(401).json({ ok: false, message: "Client token invalido." });
      return;
    }

    const { key, hwid, state } = req.body || {};
    if (!key || !hwid) {
      res.status(400).json({ ok: false, message: "Faltan campos: key, hwid." });
      return;
    }

    const keyNorm = normalizeKey(key);
    if (keyNorm !== session.keyNorm) {
      res.status(403).json({ ok: false, message: "Key no coincide con la sesion." });
      return;
    }

    const validation = validatePanelKey(deps, key, hwid);
    if (!validation.ok) {
      res.status(403).json({ ok: false, message: validation.message });
      return;
    }

    session.hwid = hwid;
    session.lastClientSeen = Date.now();
    if (state && typeof state === "object") {
      session.state = state;
    }

    const pending = session.commands.splice(0, PANEL_MAX_COMMANDS_PER_REQUEST);
    res.json({
      ok: true,
      commands: pending,
      webConnected: !!session.webToken && session.webExpiresAt > Date.now()
    });
  });

  app.post("/api/panel/web/login", (req, res) => {
    const { key } = req.body || {};
    if (!key) {
      res.status(400).json({ ok: false, message: "Falta la key." });
      return;
    }

    const db = readDb();
    const found = getKeyRecord(db, key);
    if (!found) {
      res.status(404).json({ ok: false, message: "Key no existe." });
      return;
    }
    if (found.status !== "active") {
      res.status(403).json({ ok: false, message: `Key no valida. Estado: ${found.status}` });
      return;
    }
    if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) {
      found.status = "expired";
      writeDb(db);
      res.status(403).json({ ok: false, message: "Key expirada." });
      return;
    }
    if (!found.firstLoginAt) {
      res.status(403).json({ ok: false, message: "Activa la key primero en el external." });
      return;
    }

    const keyNorm = normalizeKey(key);
    const session = panelSessions.get(keyNorm);
    if (!isClientOnline(session)) {
      res.status(409).json({
        ok: false,
        message: "El external no esta conectado. Abre FiveM + external en tu PC primero."
      });
      return;
    }

    session.webToken = createPanelToken();
    session.webExpiresAt = Date.now() + PANEL_WEB_TTL_MS;
    session.lastWebSeen = Date.now();

    res.json({
      ok: true,
      webToken: session.webToken,
      expiresAt: new Date(session.webExpiresAt).toISOString(),
      keyMasked: maskLicenseKey(keyNorm),
      clientOnline: true,
      expiresAtLicense: found.expiresAt || null
    });
  });

  app.get("/api/panel/web/status", (req, res) => {
    const webToken = String(req.headers["x-panel-web-token"] || req.query.token || "");
    const session = getSessionByWebToken(webToken);
    if (!session || !session.webExpiresAt || session.webExpiresAt < Date.now()) {
      res.status(401).json({ ok: false, message: "Sesion web invalida o expirada." });
      return;
    }

    session.lastWebSeen = Date.now();
    res.json({
      ok: true,
      clientOnline: isClientOnline(session),
      lastClientSeen: session.lastClientSeen ? new Date(session.lastClientSeen).toISOString() : null,
      state: session.state,
      keyMasked: maskLicenseKey(session.keyNorm)
    });
  });

  app.post("/api/panel/web/command", (req, res) => {
    const webToken = String(req.headers["x-panel-web-token"] || "");
    const session = getSessionByWebToken(webToken);
    if (!session || !session.webExpiresAt || session.webExpiresAt < Date.now()) {
      res.status(401).json({ ok: false, message: "Sesion web invalida o expirada." });
      return;
    }
    if (!isClientOnline(session)) {
      res.status(409).json({ ok: false, message: "External desconectado." });
      return;
    }

    session.lastWebSeen = Date.now();
    const body = req.body || {};
    let commands = [];

    if (Array.isArray(body.commands)) {
      commands = body.commands;
    } else if (body.name !== undefined && body.value !== undefined) {
      commands = [{ type: "option", name: body.name, value: body.value }];
    } else if (body.type) {
      commands = [body];
    } else if (body.action) {
      commands = [body];
    } else {
      res.status(400).json({ ok: false, message: "Comando invalido." });
      return;
    }

    const queued = queueCommands(session, commands);
    res.json({ ok: true, queued, clientOnline: true });
  });

  app.post("/api/panel/web/logout", (req, res) => {
    const webToken = String(req.headers["x-panel-web-token"] || "");
    const session = getSessionByWebToken(webToken);
    if (session) {
      session.webToken = null;
      session.webExpiresAt = null;
      session.lastWebSeen = null;
    }
    res.json({ ok: true });
  });

  app.use("/panel", deps.express.static(path.join(__dirname, "public", "panel")));
  app.get("/panel", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "panel", "index.html"));
  });
}

module.exports = {
  mountPanelApi
};
