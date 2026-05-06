require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || "!";
const API_PORT = Number(process.env.PORT || process.env.API_PORT || 3000);
const MENU_API_TOKEN = process.env.MENU_API_TOKEN || "";
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (!TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in .env");
}

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "keys.json");

function ensureDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ keys: [] }, null, 2), "utf8");
  }
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function randomAlphaNum(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function generateKey() {
  return `FALCAO-EXTERNAL-${randomAlphaNum(5)}-${randomAlphaNum(5)}`;
}

function calcExpiresAt(days) {
  const now = Date.now();
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

function getKeyRecord(db, key) {
  return db.keys.find((k) => k.key === key);
}

function validateAndBindKey(db, key, hwid, ip) {
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
    found.firstLoginAt = new Date().toISOString();
    found.hwid = hwid;
    found.ip = ip;
    writeDb(db);
    return { ok: true, message: "Primer login registrado. Key vinculada a HWID/IP.", key: found };
  }

  if (found.hwid !== hwid || found.ip !== ip) {
    return { ok: false, message: "Acceso denegado: esta key ya esta vinculada a otro HWID/IP." };
  }

  return { ok: true, message: "Key valida para este HWID/IP.", key: found };
}

function renderKeyTable(rows) {
  const header = ["KEY", "STATUS", "DAYS", "HWID", "IP"];
  const data = rows.map((k) => [
    k.key,
    k.status,
    String(k.durationDays),
    k.hwid || "-",
    k.ip || "-"
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)));
  const line = (arr) => arr.map((v, i) => v.padEnd(widths[i], " ")).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  return [line(header), sep, ...data.map(line)].join("\n");
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "discord-key-bot-api" });
});

function maskLicenseKey(key) {
  if (!key || key.length < 8) return key || "";
  return `${key.slice(0, 8)}****${key.slice(-4)}`;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return String(forwarded[0]).split(",")[0].trim();
  }
  return req.ip || "";
}

// Compatibility endpoint for old menu clients.
app.post("/api/v1/licenses/activate", (req, res) => {
  const { license_key: licenseKey, hwid } = req.body || {};
  const ipHint = (req.body && req.body.ip_hint) || "";
  const ip = ipHint || getClientIp(req);
  if (!licenseKey || !hwid) {
    res.status(400).json({ success: false, message: "Missing fields: license_key, hwid." });
    return;
  }

  const db = readDb();
  const result = validateAndBindKey(db, licenseKey, hwid, ip);
  if (!result.ok) {
    res.status(403).json({ success: false, message: result.message });
    return;
  }

  res.json({
    success: true,
    message: result.message,
    license_id: result.key.key,
    license_key: result.key.key
  });
});

// Compatibility endpoint for old menu clients.
app.post("/api/v1/licenses/validate", (req, res) => {
  const { license_key: licenseKey, hwid } = req.body || {};
  if (!licenseKey || !hwid) {
    res.status(400).json({ success: false, valid: false, message: "Missing fields: license_key, hwid." });
    return;
  }

  const db = readDb();
  const found = getKeyRecord(db, licenseKey);
  if (!found) {
    res.status(404).json({
      success: true,
      valid: false,
      activated: false,
      paused: false,
      banned: false,
      expired: false,
      is_admin: false,
      license_id: "",
      license_key_masked: "",
      plan: "default",
      expires_at: "",
      max_devices: 1,
      active_devices: 0,
      message: "License not found."
    });
    return;
  }

  if (found.expiresAt && new Date(found.expiresAt).getTime() < Date.now()) {
    found.status = "expired";
    writeDb(db);
  }

  const valid =
    found.status === "active" &&
    !!found.firstLoginAt &&
    found.hwid === hwid;

  res.json({
    success: true,
    valid,
    activated: !!found.firstLoginAt,
    paused: false,
    banned: false,
    expired: found.status === "expired",
    is_admin: false,
    license_id: found.key,
    license_key_masked: maskLicenseKey(found.key),
    plan: "discord-bot",
    expires_at: found.expiresAt || "",
    max_devices: 1,
    active_devices: found.firstLoginAt ? 1 : 0,
    message: valid ? "License valid." : "License invalid for this HWID."
  });
});

app.post("/api/license/validate", (req, res) => {
  const token = req.headers["x-menu-token"];
  if (MENU_API_TOKEN && token !== MENU_API_TOKEN) {
    res.status(401).json({ ok: false, message: "Unauthorized." });
    return;
  }

  const { key, hwid, ip } = req.body || {};
  if (!key || !hwid || !ip) {
    res.status(400).json({ ok: false, message: "Faltan campos: key, hwid, ip." });
    return;
  }

  const db = readDb();
  const result = validateAndBindKey(db, key, hwid, ip);
  if (!result.ok) {
    res.status(403).json(result);
    return;
  }

  res.json({
    ok: true,
    message: result.message,
    key: result.key.key,
    expiresAt: result.key.expiresAt,
    firstLoginAt: result.key.firstLoginAt
  });
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.once("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = (args.shift() || "").toLowerCase();

  if (command === "falcaohelp") {
    await message.reply(
      [
        "**Comandos del bot:**",
        "`!keygen <duracion_en_dias>` -> Genera 1 key con formato FALCAO-EXTERNAL-XXXXX-XXXXX.",
        "`!keylist` -> Tabla con todas las keys y datos (estado, HWID, IP, fechas).",
        "`!keycheck <key>` -> Muestra todos los datos de una key.",
        "`!keydel <key>` -> Elimina una key del sistema.",
        "`!resethwid <key>` -> Resetea HWID/IP y first login para permitir nuevo registro.",
        "",
        "El primer login se registra automaticamente desde el menu via API."
      ].join("\n")
    );
    return;
  }

  if (!isAdmin(message.author.id)) {
    await message.reply("No autorizado. Tu user ID no esta en `ADMIN_IDS`.");
    return;
  }

  const db = readDb();

  if (command === "keygen") {
    const days = Number(args[0]);
    if (!Number.isInteger(days) || days <= 0) {
      await message.reply("Uso correcto: `!keygen <duracion_en_dias>` (ej: `!keygen 30`).");
      return;
    }

    let key = generateKey();
    while (getKeyRecord(db, key)) {
      key = generateKey();
    }

    const now = new Date().toISOString();
    const record = {
      key,
      status: "active",
      createdAt: now,
      durationDays: days,
      expiresAt: calcExpiresAt(days),
      firstLoginAt: null,
      hwid: null,
      ip: null,
      note: null
    };

    db.keys.push(record);
    writeDb(db);
    await message.reply(
      [
        "**Nueva key creada**",
        `Key: \`${record.key}\``,
        `Estado: ${record.status}`,
        `Duracion: ${record.durationDays} dias`,
        `Creada: ${record.createdAt}`,
        `Expira: ${record.expiresAt}`,
        "HWID: -",
        "IP: -"
      ].join("\n")
    );
    return;
  }

  if (command === "keylist") {
    if (db.keys.length === 0) {
      await message.reply("No hay keys guardadas.");
      return;
    }
    const pageSize = 15;
    for (let start = 0; start < db.keys.length; start += pageSize) {
      const chunk = db.keys.slice(start, start + pageSize);
      const table = renderKeyTable(chunk);
      await message.reply(
        `\`\`\`txt\nKEYLIST ${start + 1}-${start + chunk.length} de ${db.keys.length}\n${table}\n\`\`\``
      );
    }
    return;
  }

  if (command === "keydel") {
    const key = args[0];
    if (!key) {
      await message.reply("Uso: `!keydel <key>`");
      return;
    }
    const before = db.keys.length;
    db.keys = db.keys.filter((k) => k.key !== key);
    if (db.keys.length === before) {
      await message.reply("No existe esa key.");
      return;
    }
    writeDb(db);
    await message.reply(`Key eliminada: \`${key}\``);
    return;
  }

  if (command === "keycheck") {
    const key = args[0];
    if (!key) {
      await message.reply("Uso: `!keycheck <key>`");
      return;
    }
    const found = getKeyRecord(db, key);
    if (!found) {
      await message.reply("No existe.");
      return;
    }
    await message.reply(
      [
        `Key: \`${found.key}\``,
        `Estado: ${found.status}`,
        `Duracion: ${found.durationDays} dias`,
        `Creada: ${found.createdAt}`,
        `Expira: ${found.expiresAt}`,
        `HWID: ${found.hwid || "-"}`,
        `IP: ${found.ip || "-"}`,
        `First login: ${found.firstLoginAt || "-"}`
      ].join("\n")
    );
    return;
  }

  if (command === "resethwid") {
    const key = args[0];
    if (!key) {
      await message.reply("Uso: `!resethwid <key>`");
      return;
    }
    const found = getKeyRecord(db, key);
    if (!found) {
      await message.reply("No existe esa key.");
      return;
    }
    found.hwid = null;
    found.ip = null;
    found.firstLoginAt = null;
    writeDb(db);
    await message.reply(`HWID/IP reseteados para \`${key}\`.`);
    return;
  }

  await message.reply("Comando invalido. Usa `!falcaohelp`.");
});

app.listen(API_PORT, () => {
  console.log(`HTTP API online on port ${API_PORT}`);
});

client.login(TOKEN);
