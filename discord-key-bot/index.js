require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || "!";
const API_PORT = Number(process.env.PORT || process.env.API_PORT || 3000);
const MENU_API_TOKEN = process.env.MENU_API_TOKEN || "";
const REQUIRED_ROLE_ID = "1502014441623916544";
const TICKET_VIEW_ONLY_ROLE_ID = "1502033454014136400";
const LOG_CHANNEL_GENERAL_ID = "1502007488533233744";
const LOG_CHANNEL_KEYGEN_ID = "1502007948497391708";
const LOG_CHANNEL_RESETHWID_ID = "1502007476076282056";
const LOG_CHANNEL_TRANSCRIPTS_ID = "1502007473157177507";
const LOG_CHANNEL_ERRORS_ID = "1502039396978003979";
const OFFER_CHANNEL_ID = "1502029921629900890";
const SUGGESTION_CHANNEL_IDS = new Set(["1502035178309161150", "1502007614047785182"]);
const TICKET_CATEGORY_BUY = "Buy Tickets";
const TICKET_CATEGORY_SUPPORT = "Support Tickets";
const TICKET_CATEGORY_HWID_RESET = "HWID Reset Tickets";
const TICKET_CATEGORY_BUG = "Bug Tickets";
const BUY_CHANNEL_LINK = "https://discord.com/channels/1502005944945741864/1502007586613100675";

if (!TOKEN) {
  throw new Error("Missing DISCORD_TOKEN in .env");
}

const dataDir = path.join(__dirname, "data");
const dbPath = path.join(dataDir, "keys.json");
const pricesPath = path.join(dataDir, "prices.json");
const purchasesPath = path.join(dataDir, "purchases.json");
const BRAND_ORANGE = 0xff8a33;
const BUTTON_COOLDOWN_MS = 2500;
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS || 6);
const PANEL_LOGO_URL = "https://i.imgur.com/Nuy61wA.png";

const PAYMENT_METHODS = [
  { id: "paypal", label: "Paypal", emoji: "💳" },
  { id: "litecoin", label: "Litecoin", emoji: "🪙" },
  { id: "bitcoin", label: "Bitcoin", emoji: "₿" },
  { id: "solana", label: "Solana", emoji: "🌞" },
  { id: "othercrypto", label: "Other Crypto", emoji: "🧩" },
  { id: "stripe", label: "Stripe", emoji: "🏦" },
  { id: "bizum", label: "Bizum", emoji: "📱" },
  { id: "otherpay", label: "Other Payment Method", emoji: "💰" }
];

const LICENSE_TIMES = [
  { id: "1w", label: "1 Week" },
  { id: "1m", label: "1 Month" },
  { id: "life", label: "Lifetime" },
  { id: "custom", label: "Custom Time" }
];

function ensureDb() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ keys: [] }, null, 2), "utf8");
  }
}

function randomPrice(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function defaultPriceTable() {
  return {
    "1w": randomPrice(8, 15),
    "1m": randomPrice(18, 35),
    life: randomPrice(80, 180)
  };
}

function defaultPricesPayload() {
  return {
    base: defaultPriceTable(),
    offer: {
      discountPercent: 0,
      durationText: "",
      endsAt: null
    }
  };
}

function ensurePrices() {
  ensureDb();
  if (!fs.existsSync(pricesPath)) {
    fs.writeFileSync(pricesPath, JSON.stringify(defaultPricesPayload(), null, 2), "utf8");
  }
}

function ensurePurchases() {
  ensureDb();
  if (!fs.existsSync(purchasesPath)) {
    fs.writeFileSync(purchasesPath, JSON.stringify({ users: {} }, null, 2), "utf8");
  }
}

function hashString(input) {
  const str = String(input || "");
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function runDataBackup() {
  ensureDb();
  const backupDir = path.join(dataDir, "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = [dbPath, pricesPath, purchasesPath];
  for (const source of files) {
    if (!fs.existsSync(source)) continue;
    const base = path.basename(source, ".json");
    const target = path.join(backupDir, `${base}-${stamp}.json`);
    fs.copyFileSync(source, target);
  }
}

function readPrices() {
  ensurePrices();
  const parsed = JSON.parse(fs.readFileSync(pricesPath, "utf8"));
  if (parsed && parsed.base && parsed.offer) {
    return {
      base: { ...defaultPriceTable(), ...parsed.base },
      offer: {
        discountPercent: Number(parsed.offer.discountPercent || 0),
        durationText: parsed.offer.durationText || "",
        endsAt: parsed.offer.endsAt || null,
        expiredNotified: !!parsed.offer.expiredNotified
      }
    };
  }

  // Backward compatibility for old flat format.
  return {
    base: { ...defaultPriceTable(), ...parsed },
    offer: {
      discountPercent: 0,
      durationText: "",
      endsAt: null,
      expiredNotified: false
    }
  };
}

function writePrices(prices) {
  ensurePrices();
  fs.writeFileSync(pricesPath, JSON.stringify(prices, null, 2), "utf8");
}

function readPurchases() {
  ensurePurchases();
  return JSON.parse(fs.readFileSync(purchasesPath, "utf8"));
}

function writePurchases(payload) {
  ensurePurchases();
  fs.writeFileSync(purchasesPath, JSON.stringify(payload, null, 2), "utf8");
}

function getActiveDiscount(pricesPayload) {
  const now = Date.now();
  const endsAtMs = pricesPayload.offer?.endsAt ? new Date(pricesPayload.offer.endsAt).getTime() : 0;
  const isActive = pricesPayload.offer?.discountPercent > 0 && Number.isFinite(endsAtMs) && endsAtMs > now;
  if (!isActive) return 0;
  return pricesPayload.offer.discountPercent;
}

function getEffectivePrices(pricesPayload) {
  const discount = getActiveDiscount(pricesPayload);
  const out = {};
  for (const [key, value] of Object.entries(pricesPayload.base || {})) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) continue;
    const discounted = numeric * (1 - discount / 100);
    out[key] = Number(discounted.toFixed(2));
  }
  out.custom = "X";
  return out;
}

function parseDurationToMs(rawDuration) {
  const match = /^(\d+)([smhdw])$/i.exec(String(rawDuration || "").trim());
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  const table = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  return value * table[unit];
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf8");
}

function hasRequiredRole(member) {
  return !!member?.roles?.cache?.has(REQUIRED_ROLE_ID);
}

function commandRequiresRole(command) {
  return command !== "falcaohelp";
}

async function sendLogEmbed(clientInstance, channelId, embed) {
  if (!channelId) return;
  try {
    const channel = await clientInstance.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.error("Could not send log:", error.message);
  }
}

function baseLogEmbed(title, color = BRAND_ORANGE) {
  return new EmbedBuilder().setColor(color).setTitle(title).setTimestamp(new Date());
}

async function logGeneral(clientInstance, title, fields = []) {
  const embed = baseLogEmbed(title, BRAND_ORANGE).addFields(fields);
  await sendLogEmbed(clientInstance, LOG_CHANNEL_GENERAL_ID, embed);
}

async function logError(context, error, extra = {}) {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack.slice(0, 1500) : "No stack";
  const fingerprint = hashString(`${context}|${reason}|${stack.slice(0, 400)}`);
  const errorId = `ERR-${Date.now().toString(36).toUpperCase()}-${fingerprint.slice(0, 6).toUpperCase()}`;
  const dedupeWindowMs = 30 * 1000;
  const previous = recentErrorFingerprints.get(fingerprint) || 0;
  if (Date.now() - previous < dedupeWindowMs) {
    return;
  }
  recentErrorFingerprints.set(fingerprint, Date.now());
  const fields = [
    { name: "Error ID", value: errorId, inline: true },
    { name: "Context", value: String(context).slice(0, 1024), inline: false },
    { name: "Reason", value: reason.slice(0, 1024), inline: false }
  ];
  for (const [k, v] of Object.entries(extra || {})) {
    fields.push({ name: String(k).slice(0, 256), value: String(v).slice(0, 1024), inline: true });
  }
  fields.push({ name: "Stack", value: `\`\`\`${stack}\`\`\``, inline: false });
  const embed = baseLogEmbed("Bot Error", 0xed4245).addFields(fields);
  await sendLogEmbed(client, LOG_CHANNEL_ERRORS_ID, embed);
}

async function ensureTicketCategory(guild, categoryName) {
  const found = guild.channels.cache.find(
    (channel) => channel.type === 4 && channel.name.toLowerCase() === categoryName.toLowerCase()
  );
  if (found) return found;

  return guild.channels.create({
    name: categoryName,
    type: 4
  });
}

async function fetchChannelMessagesChronological(channel) {
  const allMessages = [];
  let lastId;
  for (;;) {
    const fetched = await channel.messages.fetch({ limit: 100, before: lastId });
    if (!fetched.size) break;
    allMessages.push(...Array.from(fetched.values()));
    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }
  return allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function buildTicketTranscript(channel) {
  const messages = await fetchChannelMessagesChronological(channel);
  const lines = messages.map((message) => {
    const date = new Date(message.createdTimestamp).toISOString();
    const author = `${message.author?.tag || "Unknown"} (${message.author?.id || "?"})`;
    const content = (message.content || "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return `[${date}] ${author}: ${content || "[sin texto]"}`;
  });
  return lines.join("\n");
}

const TICKET_TYPES = {
  ticket_open_buy: {
    label: "Buy",
    emoji: "🛒",
    category: TICKET_CATEGORY_BUY,
    channelPrefix: "buy"
  },
  ticket_open_support: {
    label: "Support",
    emoji: "🛠️",
    category: TICKET_CATEGORY_SUPPORT,
    channelPrefix: "support"
  },
  ticket_open_hwid: {
    label: "HWID Reset",
    emoji: "🔁",
    category: TICKET_CATEGORY_HWID_RESET,
    channelPrefix: "hwid-reset"
  },
  ticket_open_bug: {
    label: "Bug",
    emoji: "🐞",
    category: TICKET_CATEGORY_BUG,
    channelPrefix: "bug"
  }
};
const buySelections = new Map();
const buttonCooldowns = new Map();
const suggestionVotes = new Map();
const recentErrorFingerprints = new Map();

function isOnCooldown(userId, key, cooldownMs = BUTTON_COOLDOWN_MS) {
  const now = Date.now();
  const mapKey = `${userId}:${key}`;
  const last = buttonCooldowns.get(mapKey) || 0;
  if (now - last < cooldownMs) return true;
  buttonCooldowns.set(mapKey, now);
  return false;
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

function truncateCell(value, maxLength = 32) {
  const text = String(value ?? "-");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function statusEmoji(status) {
  switch ((status || "").toLowerCase()) {
    case "active":
      return "🟢";
    case "expired":
      return "🔴";
    case "paused":
      return "🟡";
    default:
      return "⚪";
  }
}

function daysRemaining(expiresAt) {
  if (!expiresAt) return null;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return null;
  const diff = expiresMs - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

const copyPayloads = new Map();

function createCopyButton(label, value) {
  const token = randomAlphaNum(8);
  copyPayloads.set(token, { value: value || "-", expiresAt: Date.now() + 10 * 60 * 1000 });
  return new ButtonBuilder()
    .setCustomId(`copy_${token}`)
    .setLabel(label)
    .setEmoji("📋")
    .setStyle(ButtonStyle.Secondary);
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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});

client.once("ready", () => {
  console.log(`Bot online: ${client.user.tag}`);
  const slashCommands = [
    new SlashCommandBuilder().setName("falcaohelp").setDescription("Show bot commands."),
    new SlashCommandBuilder().setName("ticketpanel").setDescription("Send ticket panel."),
    new SlashCommandBuilder().setName("tablaprecios").setDescription("Show current license price table."),
    new SlashCommandBuilder()
      .setName("tablapreciosset")
      .setDescription("Set base price for a license time.")
      .addStringOption((o) =>
        o
          .setName("tiempo")
          .setDescription("1w, 1m, life")
          .setRequired(true)
          .addChoices(
            { name: "1 Week", value: "1w" },
            { name: "1 Month", value: "1m" },
            { name: "Lifetime", value: "life" }
          )
      )
      .addNumberOption((o) => o.setName("precio").setDescription("Price in EUR").setRequired(true)),
    new SlashCommandBuilder()
      .setName("oferta")
      .setDescription("Create a global offer with discount.")
      .addNumberOption((o) => o.setName("descuento").setDescription("Discount percentage").setRequired(true))
      .addStringOption((o) => o.setName("duracion").setDescription("Duration e.g. 7d, 24h").setRequired(true)),
    new SlashCommandBuilder().setName("offeroff").setDescription("Disable current active offer."),
    new SlashCommandBuilder()
      .setName("compraseveryone")
      .setDescription("Show purchase history for all users.")
      .addIntegerOption((o) => o.setName("pagina").setDescription("Page number").setRequired(false).setMinValue(1)),
    new SlashCommandBuilder()
      .setName("s")
      .setDescription("Create a suggestion in suggestion channels.")
      .addStringOption((o) => o.setName("mensaje").setDescription("Suggestion text").setRequired(true)),
    new SlashCommandBuilder()
      .setName("keygen")
      .setDescription("Generate one key.")
      .addIntegerOption((o) => o.setName("dias").setDescription("Duration in days").setRequired(true).setMinValue(1)),
    new SlashCommandBuilder().setName("keylist").setDescription("List all keys."),
    new SlashCommandBuilder()
      .setName("keycheck")
      .setDescription("Check one key.")
      .addStringOption((o) => o.setName("key").setDescription("License key").setRequired(true)),
    new SlashCommandBuilder()
      .setName("keydel")
      .setDescription("Delete one key.")
      .addStringOption((o) => o.setName("key").setDescription("License key").setRequired(true)),
    new SlashCommandBuilder()
      .setName("resethwid")
      .setDescription("Reset HWID/IP for a key.")
      .addStringOption((o) => o.setName("key").setDescription("License key").setRequired(true))
  ].map((cmd) => cmd.toJSON());

  client.application.commands.set(slashCommands).catch((error) => {
    console.error("Could not register slash commands:", error.message);
  });
});

setInterval(async () => {
  try {
    const pricesPayload = readPrices();
    const offer = pricesPayload.offer || {};
    if (!offer.endsAt || !offer.discountPercent) return;
    const endsMs = new Date(offer.endsAt).getTime();
    if (!Number.isFinite(endsMs)) return;
    if (Date.now() < endsMs) return;
    if (offer.expiredNotified) return;

    pricesPayload.offer.discountPercent = 0;
    pricesPayload.offer.durationText = "";
    pricesPayload.offer.expiredNotified = true;
    writePrices(pricesPayload);

    const embed = new EmbedBuilder()
      .setColor(BRAND_ORANGE)
      .setTitle("FALCAO EXTERNAL OFFER ENDED")
      .setThumbnail(PANEL_LOGO_URL)
      .setDescription("The active offer has expired. Standard prices are now active again.")
      .setTimestamp(new Date());
    await sendLogEmbed(client, OFFER_CHANNEL_ID, embed);
  } catch (error) {
    console.error("Offer expiry checker failed:", error.message);
    logError("offer_expiry_interval", error).catch(() => {});
  }
}, 60 * 1000);

setInterval(() => {
  try {
    runDataBackup();
  } catch (error) {
    console.error("Backup job failed:", error.message);
    logError("backup_interval", error).catch(() => {});
  }
}, Math.max(1, BACKUP_INTERVAL_HOURS) * 60 * 60 * 1000);

setInterval(async () => {
  const now = Date.now();
  for (const [messageId, suggestion] of suggestionVotes.entries()) {
    if (suggestion.closed || now < suggestion.endsAt) continue;
    suggestion.closed = true;
    const resultYes = suggestion.yes.size;
    const resultNo = suggestion.no.size;
    const winner = resultYes >= resultNo ? "YES" : "NO";
    try {
      const channel = await client.channels.fetch(suggestion.channelId);
      if (!channel || !channel.isTextBased()) continue;
      const msg = await channel.messages.fetch(messageId);
      const finalEmbed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("💡 Suggestion Result")
        .setDescription(suggestion.text)
        .addFields(
          { name: "Author", value: `<@${suggestion.authorId}>`, inline: true },
          { name: "Final votes", value: `✅ ${resultYes} | ❌ ${resultNo}`, inline: true },
          { name: "Winner", value: winner, inline: true }
        )
        .setTimestamp(new Date());
      await msg.edit({ embeds: [finalEmbed], components: [] });
    } catch (error) {
      console.error("Suggestion finalize failed:", error.message);
      logError("suggestion_finalize_interval", error, { suggestionMessageId: messageId }).catch(() => {});
    }
  }
}, 60 * 1000);

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  await message.reply("Commands are now slash-only. Please use `/` commands.");
});

app.listen(API_PORT, () => {
  console.log(`HTTP API online on port ${API_PORT}`);
});

process.on("unhandledRejection", (reason) => {
  logError("process.unhandledRejection", reason).catch(() => {});
});

process.on("uncaughtException", (error) => {
  logError("process.uncaughtException", error).catch(() => {});
});

client.login(TOKEN);

client.on("interactionCreate", async (interaction) => {
  try {
  if (interaction.isChatInputCommand()) {
    const slashCommand = interaction.commandName;
    const publicSlashCommands = new Set(["falcaohelp", "s"]);
    const requiresRole = !publicSlashCommands.has(slashCommand);
    if (requiresRole && !hasRequiredRole(interaction.member)) {
      await interaction.reply({ content: `Not authorized. You need role <@&${REQUIRED_ROLE_ID}>.` });
      return;
    }

    if (slashCommand === "falcaohelp") {
      const helpEmbed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Help")
        .setThumbnail(PANEL_LOGO_URL)
        .addFields(
          {
            name: "👤 User Commands",
            value: [
              "`/falcaohelp`",
              "`/s`",
              "Open tickets from the ticket panel buttons"
            ].join("\n"),
            inline: false
          },
          {
            name: "🛡️ Admin Commands",
            value: [
              "`/ticketpanel`",
              "`/tablaprecios`",
              "`/tablapreciosset`",
              "`/oferta`",
              "`/offeroff`",
              "`/keygen` `/keylist` `/keycheck` `/keydel` `/resethwid`",
              "`/compraseveryone`"
            ].join("\n"),
            inline: false
          }
        )
        .setFooter({ text: "Slash commands only" });
      await interaction.reply({ embeds: [helpEmbed] });
      return;
    }

    if (slashCommand === "ticketpanel") {
      const panelEmbed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Ticket Center")
        .setDescription("Choose an option to open your ticket.")
        .addFields(
          { name: "🛒 Buy", value: "Payments and license plans.", inline: true },
          { name: "🛠️ Support", value: "General technical support.", inline: true },
          { name: "🔁 HWID Reset", value: "HWID reset requests.", inline: true },
          { name: "🐞 Bug", value: "Bug reports and diagnostics.", inline: true }
        )
        .setImage(PANEL_LOGO_URL);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_open_buy").setLabel("Buy").setEmoji("🛒").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_open_support").setLabel("Support").setEmoji("🛠️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_open_hwid").setLabel("HWID Reset").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ticket_open_bug").setLabel("Bug").setEmoji("🐞").setStyle(ButtonStyle.Danger)
      );
      await interaction.channel.send({ embeds: [panelEmbed], components: [row] });
      await interaction.reply({ content: "Ticket panel sent." });
      return;
    }

    if (slashCommand === "tablaprecios") {
      const pricesPayload = readPrices();
      const effectivePrices = getEffectivePrices(pricesPayload);
      const lines = LICENSE_TIMES.map((t) => {
        const value = effectivePrices[t.id];
        return `- **${t.label}**: **${typeof value === "number" ? `${value}€` : value}**`;
      });
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Price Table")
        .setDescription([...lines, "", `Para comprar --> ${BUY_CHANNEL_LINK}`].join("\n"));
      await interaction.channel.send({ embeds: [embed] });
      await interaction.reply({ content: "Price table sent." });
      return;
    }

    if (slashCommand === "tablapreciosset") {
      const pricesPayload = readPrices();
      const timeKey = interaction.options.getString("tiempo", true);
      const amount = interaction.options.getNumber("precio", true);
      pricesPayload.base[timeKey] = Number(amount.toFixed(2));
      writePrices(pricesPayload);
      await interaction.reply({ content: `Price updated: \`${timeKey}\` -> **${pricesPayload.base[timeKey]}€**` });
      return;
    }

    if (slashCommand === "oferta") {
      const discount = interaction.options.getNumber("descuento", true);
      const durationText = interaction.options.getString("duracion", true);
      const durationMs = parseDurationToMs(durationText);
      if (!durationMs || discount <= 0 || discount >= 100) {
        await interaction.reply({ content: "Invalid values. Example: /oferta descuento:20 duracion:7d" });
        return;
      }
      const pricesPayload = readPrices();
      const endsAt = new Date(Date.now() + durationMs).toISOString();
      pricesPayload.offer = { discountPercent: Number(discount.toFixed(2)), durationText, endsAt, expiredNotified: false };
      writePrices(pricesPayload);
      const endUnix = Math.floor(new Date(endsAt).getTime() / 1000);
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("🎉🔥 **FALCAO EXTERNAL OFFER** 🔥🎉")
        .setThumbnail(PANEL_LOGO_URL)
        .setImage(PANEL_LOGO_URL)
        .setDescription([`💸 **Disccount:** **${pricesPayload.offer.discountPercent}%**`, `⏳ **Time left:** <t:${endUnix}:R>`, "🚀 Take advantage of it now!"].join("\n"));
      await sendLogEmbed(client, OFFER_CHANNEL_ID, embed);
      await interaction.reply({ content: "Offer published." });
      return;
    }

    if (slashCommand === "offeroff") {
      const pricesPayload = readPrices();
      pricesPayload.offer = { discountPercent: 0, durationText: "", endsAt: null, expiredNotified: true };
      writePrices(pricesPayload);
      await interaction.reply({ content: "Offer disabled." });
      return;
    }

    if (slashCommand === "compraseveryone") {
      const purchases = readPurchases();
      const entries = Object.entries(purchases.users || {});
      if (!entries.length) {
        await interaction.reply({ content: "No purchases recorded yet." });
        return;
      }
      const page = interaction.options.getInteger("pagina") || 1;
      const pageSize = 10;
      const totalPages = Math.max(1, Math.ceil(entries.length / pageSize));
      const safePage = Math.min(totalPages, Math.max(1, page));
      const start = (safePage - 1) * pageSize;
      const lines = entries
        .sort((a, b) => (b[1].totalSpent || 0) - (a[1].totalSpent || 0))
        .slice(start, start + pageSize)
        .map(([userId, info]) => {
          const items = info.items || [];
          const last = items[items.length - 1];
          const lastText = last ? ` | last: ${last.amountDisplay} ${last.duration} via ${last.paymentMethod}` : "";
          return `- <@${userId}> | total: **${(info.totalSpent || 0).toFixed(2)}€** | purchases: **${items.length}**${lastText}`;
        });
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Purchases Everyone")
        .setDescription(lines.join("\n").slice(0, 3900))
        .setFooter({ text: `Page ${safePage}/${totalPages}` });
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (slashCommand === "s") {
      if (!SUGGESTION_CHANNEL_IDS.has(interaction.channelId)) {
        await interaction.reply({ content: "This command only works in suggestion channels." });
        return;
      }
      const suggestionText = interaction.options.getString("mensaje", true);
      const endAt = Date.now() + 24 * 60 * 60 * 1000;
      const endUnix = Math.floor(endAt / 1000);
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("💡 New Suggestion")
        .setDescription(suggestionText)
        .addFields(
          { name: "Author", value: `<@${interaction.user.id}>`, inline: true },
          { name: "Voting ends", value: `<t:${endUnix}:R>`, inline: true }
        )
        .setTimestamp(new Date());
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("suggest_vote_yes").setLabel("Yes").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("suggest_vote_no").setLabel("No").setEmoji("❌").setStyle(ButtonStyle.Danger)
      );
      const msg = await interaction.channel.send({ embeds: [embed], components: [row] });
      suggestionVotes.set(msg.id, {
        channelId: interaction.channelId,
        messageId: msg.id,
        authorId: interaction.user.id,
        text: suggestionText,
        yes: new Set(),
        no: new Set(),
        endsAt: endAt,
        closed: false
      });
      await interaction.reply({ content: "Suggestion posted." });
      return;
    }

    if (slashCommand === "keygen") {
      const db = readDb();
      const days = interaction.options.getInteger("dias", true);
      let key = generateKey();
      while (getKeyRecord(db, key)) key = generateKey();
      const record = {
        key,
        status: "active",
        createdAt: new Date().toISOString(),
        durationDays: days,
        expiresAt: calcExpiresAt(days),
        firstLoginAt: null,
        hwid: null,
        ip: null,
        note: null
      };
      db.keys.push(record);
      writeDb(db);
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • New Key")
        .setDescription(
          [
            `Key: \`${record.key}\``,
            `Status: ${record.status}`,
            `Duration: ${record.durationDays} days`,
            `Created: ${record.createdAt}`,
            `Expires: ${record.expiresAt}`,
            "HWID: -",
            "IP: -"
          ].join("\n")
        )
        .setTimestamp(new Date());
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (slashCommand === "keylist") {
      const db = readDb();
      if (!db.keys.length) {
        await interaction.reply({ content: "No keys found." });
        return;
      }
      const sorted = [...db.keys].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const blocks = sorted.slice(0, 20).map((k) => {
        const left = daysRemaining(k.expiresAt);
        const remainLine = left === null ? "TIME LEFT: -" : `TIME LEFT: ${left} DAY${left === 1 ? "" : "S"}`;
        return [
          `${statusEmoji(k.status)} **${k.key}**`,
          `Status: ${k.status || "-"}`,
          `Duration: ${k.durationDays ?? "-"} days`,
          remainLine,
          `HWID: \`${truncateCell(k.hwid || "-", 70)}\``,
          `IP: \`${truncateCell(k.ip || "-", 45)}\``,
          `Created: ${formatDate(k.createdAt)}`,
          `Expires: ${formatDate(k.expiresAt)}`,
          `First login: ${formatDate(k.firstLoginAt)}`
        ].join("\n");
      });
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Keylist")
        .setDescription(`Showing 1-${Math.min(20, sorted.length)} of ${sorted.length} keys\n\n${blocks.join("\n------------------------------\n").slice(0, 3600)}`)
        .setFooter({ text: `Total: ${sorted.length} keys` })
        .setTimestamp(new Date());
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (slashCommand === "keycheck") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const found = getKeyRecord(db, key);
      if (!found) {
        await interaction.reply({ content: "Key not found." });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Key Check")
        .setDescription(
          [
            `Key: \`${found.key}\``,
            `Status: ${found.status}`,
            `Duration: ${found.durationDays ?? "-"} days`,
            `Created: ${found.createdAt || "-"}`,
            `Expires: ${found.expiresAt || "-"}`,
            `HWID: ${found.hwid || "-"}`,
            `IP: ${found.ip || "-"}`,
            `First login: ${found.firstLoginAt || "-"}`
          ].join("\n")
        )
        .setTimestamp(new Date());
      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (slashCommand === "keydel") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const before = db.keys.length;
      db.keys = db.keys.filter((k) => k.key !== key);
      writeDb(db);
      await interaction.reply({ content: db.keys.length === before ? "Key not found." : `Deleted key: \`${key}\`` });
      return;
    }

    if (slashCommand === "resethwid") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const found = getKeyRecord(db, key);
      if (!found) {
        await interaction.reply({ content: "Key not found." });
        return;
      }
      found.hwid = null;
      found.ip = null;
      found.firstLoginAt = null;
      writeDb(db);
      await interaction.reply({ content: `HWID/IP reset for \`${key}\`.` });
      return;
    }
    return;
  }

  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith("copy_")) {
    const token = interaction.customId.replace("copy_", "");
    const payload = copyPayloads.get(token);
    if (!payload || payload.expiresAt < Date.now()) {
      copyPayloads.delete(token);
      await interaction.reply({ content: "Este botón expiró. Usa `!keylist` otra vez.", ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `\`${payload.value}\``,
      ephemeral: true
    });
    return;
  }

  if (interaction.customId === "suggest_vote_yes" || interaction.customId === "suggest_vote_no") {
    if (isOnCooldown(interaction.user.id, "suggest_vote", 1500)) {
      await interaction.reply({ content: "Please wait a moment before voting again.", ephemeral: true });
      return;
    }
    const suggestion = suggestionVotes.get(interaction.message.id);
    if (!suggestion || suggestion.closed) {
      await interaction.reply({ content: "This suggestion vote is already closed.", ephemeral: true });
      return;
    }
    suggestion.yes.delete(interaction.user.id);
    suggestion.no.delete(interaction.user.id);
    if (interaction.customId === "suggest_vote_yes") suggestion.yes.add(interaction.user.id);
    else suggestion.no.add(interaction.user.id);

    const endUnix = Math.floor(suggestion.endsAt / 1000);
    const embed = new EmbedBuilder()
      .setColor(BRAND_ORANGE)
      .setTitle("💡 New Suggestion")
      .setDescription(suggestion.text)
      .addFields(
        { name: "Author", value: `<@${suggestion.authorId}>`, inline: true },
        { name: "Voting ends", value: `<t:${endUnix}:R>`, inline: true },
        { name: "Votes", value: `✅ ${suggestion.yes.size} | ❌ ${suggestion.no.size}`, inline: true }
      )
      .setTimestamp(new Date());
    await interaction.update({ embeds: [embed] });
    return;
  }

  if (interaction.customId in TICKET_TYPES) {
    if (isOnCooldown(interaction.user.id, "ticket_open")) {
      await interaction.reply({ content: "Slow down a bit before opening another ticket.", ephemeral: true });
      return;
    }
    const typeData = TICKET_TYPES[interaction.customId];
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "This button only works inside a server.", ephemeral: true });
      return;
    }
    const languageRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`ticket_lang_en_${interaction.customId}`).setLabel("English").setEmoji("🇬🇧").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`ticket_lang_es_${interaction.customId}`).setLabel("Español").setEmoji("🇪🇸").setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: "Choose ticket language / Elige el idioma del ticket:",
      components: [languageRow],
      ephemeral: true
    });
    return;
  }

  if (interaction.customId.startsWith("ticket_lang_")) {
    await interaction.deferReply({ ephemeral: true });
    if (isOnCooldown(interaction.user.id, "ticket_lang")) {
      await interaction.editReply({ content: "Please wait a second before trying again." });
      return;
    }
    const langMatch = /^ticket_lang_(en|es)_(ticket_open_[a-z]+)$/.exec(interaction.customId);
    if (!langMatch) return;
    const selectedLang = langMatch[1];
    const ticketCustomId = langMatch[2];
    const typeData = TICKET_TYPES[ticketCustomId];
    if (!typeData) {
      await interaction.editReply({ content: "Invalid ticket type." });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: "This button only works inside a server." });
      return;
    }

    const normalizedUser = interaction.user.username.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "user";
    const existing = guild.channels.cache.find(
      (ch) =>
        ch.type === 0 &&
        ch.name.startsWith(`${typeData.channelPrefix}-${normalizedUser}`) &&
        ch.permissionOverwrites.cache.has(interaction.user.id)
    );
    if (existing) {
      await interaction.editReply({ content: `You already have an open ticket: <#${existing.id}>` });
      return;
    }

    const category = await ensureTicketCategory(guild, typeData.category);
    const ticketName = `${typeData.channelPrefix}-${normalizedUser}`;
    const ticketChannel = await guild.channels.create({
      name: ticketName,
      type: 0,
      parent: category.id,
      topic: `Ticket ${typeData.label} | user:${interaction.user.id} | lang:${selectedLang}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
        { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles"] },
        { id: REQUIRED_ROLE_ID, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageMessages"] },
        { id: TICKET_VIEW_ONLY_ROLE_ID, allow: ["ViewChannel", "ReadMessageHistory"] },
        { id: client.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageChannels", "ManageMessages"] }
      ]
    });

    const closeButtons = [
      new ButtonBuilder().setCustomId("ticket_close").setLabel(selectedLang === "es" ? "Cerrar ticket" : "Close ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger)
    ];
    if (ticketCustomId === "ticket_open_buy") {
      closeButtons.push(
        new ButtonBuilder().setCustomId("purchase_complete").setLabel("Purchase Completed").setEmoji("✅").setStyle(ButtonStyle.Success)
      );
    }
    const closeRow = new ActionRowBuilder().addComponents(closeButtons);

    let introTextEn = "Please provide details so staff can help you quickly.";
    let introTextEs = "Explica tu solicitud con detalles para que el staff te ayude rápidamente.";
    if (ticketCustomId === "ticket_open_bug") {
      introTextEn = "Describe the bug, reproduction steps, and attach screenshots/video if possible.";
      introTextEs = "Describe el bug, pasos para reproducirlo y adjunta pruebas si puedes.";
    } else if (ticketCustomId === "ticket_open_support") {
      introTextEn = "Tell us what issue you have or what you need from support.";
      introTextEs = "Indica qué problema tienes o qué necesitas.";
    } else if (ticketCustomId === "ticket_open_hwid") {
      introTextEn = "Please send your key and explain why you need an HWID reset.";
      introTextEs = "Escribe tu key y explica por qué necesitas un HWID reset.";
    } else if (ticketCustomId === "ticket_open_buy") {
      introTextEn = "Choose a payment method first, then pick the license time.";
      introTextEs = "Selecciona método de pago y luego el tiempo de licencia.";
    }

    const ticketEmbed = new EmbedBuilder()
      .setColor(BRAND_ORANGE)
      .setTitle(`${typeData.emoji} Ticket • ${typeData.label}`)
      .setDescription(
        [
          `${interaction.user}, ${selectedLang === "es" ? "tu ticket fue creado correctamente." : "your ticket has been created successfully."}`,
          selectedLang === "es" ? introTextEs : introTextEn,
          "",
          selectedLang === "es" ? "Cuando termines, pulsa **Cerrar ticket** para generar transcript." : "When finished, click **Close ticket** to generate transcript."
        ].join("\n")
      )
      .setFooter({ text: `Ticket owner: ${interaction.user.id}` })
      .setTimestamp(new Date());

    await ticketChannel.send({ embeds: [ticketEmbed], components: [closeRow] });

    if (ticketCustomId === "ticket_open_buy") {
      const paymentButtons = PAYMENT_METHODS.map((method) =>
        new ButtonBuilder().setCustomId(`buy_pay_${method.id}`).setLabel(method.label).setEmoji(method.emoji).setStyle(ButtonStyle.Secondary)
      );
      const row1 = new ActionRowBuilder().addComponents(paymentButtons.slice(0, 4));
      const row2 = new ActionRowBuilder().addComponents(paymentButtons.slice(4, 8));
      const buyEmbed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("🛒 Buy • Payment Method")
        .setDescription(selectedLang === "es" ? "Elige cómo quieres pagar la licencia." : "Choose how you want to pay for your license.")
        .setTimestamp(new Date());
      await ticketChannel.send({ embeds: [buyEmbed], components: [row1, row2] });
    }

    await interaction.editReply({ content: `Ticket created: <#${ticketChannel.id}>` });
    await logGeneral(client, "Ticket opened", [
      { name: "Usuario", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
      { name: "Tipo", value: typeData.label, inline: true },
      { name: "Idioma", value: selectedLang, inline: true },
      { name: "Canal", value: `<#${ticketChannel.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId.startsWith("buy_pay_")) {
    if (isOnCooldown(interaction.user.id, "buy_pay")) {
      await interaction.reply({ content: "Please wait a second before clicking again.", ephemeral: true });
      return;
    }
    const methodId = interaction.customId.replace("buy_pay_", "");
    const method = PAYMENT_METHODS.find((m) => m.id === methodId);
    if (!method) {
      await interaction.reply({ content: "Invalid payment method.", ephemeral: true });
      return;
    }

    const ownerMatch = /user:(\d+)/.exec(interaction.channel?.topic || "");
    const ownerId = ownerMatch ? ownerMatch[1] : "";
    const allowed = hasRequiredRole(interaction.member) || interaction.user.id === ownerId;
    if (!allowed) {
      await interaction.reply({ content: "Only the ticket owner or staff can use this option.", ephemeral: true });
      return;
    }

    buySelections.set(interaction.channel.id, { methodId, ownerId });
    const timeButtons = LICENSE_TIMES.map((t) =>
      new ButtonBuilder()
        .setCustomId(`buy_time_${t.id}`)
        .setLabel(t.label)
        .setStyle(ButtonStyle.Primary)
    );

    const rowA = new ActionRowBuilder().addComponents(timeButtons.slice(0, 3));
    const rowB = new ActionRowBuilder().addComponents(timeButtons.slice(3, 5));
    const timeEmbed = new EmbedBuilder()
      .setColor(BRAND_ORANGE)
      .setTitle("🕒 Buy • License Duration")
      .setDescription(`${method.emoji} Selected method: **${method.label}**\nNow choose the license duration.`)
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [timeEmbed], components: [rowA, rowB] });
    return;
  }

  if (interaction.customId.startsWith("buy_time_")) {
    if (isOnCooldown(interaction.user.id, "buy_time")) {
      await interaction.reply({ content: "Please wait a second before clicking again.", ephemeral: true });
      return;
    }
    const timeId = interaction.customId.replace("buy_time_", "");
    const timeInfo = LICENSE_TIMES.find((t) => t.id === timeId);
    if (!timeInfo) {
      await interaction.reply({ content: "Invalid license duration.", ephemeral: true });
      return;
    }

    const ownerMatch = /user:(\d+)/.exec(interaction.channel?.topic || "");
    const ownerId = ownerMatch ? ownerMatch[1] : "";
    const allowed = hasRequiredRole(interaction.member) || interaction.user.id === ownerId;
    if (!allowed) {
      await interaction.reply({ content: "Only the ticket owner or staff can use this option.", ephemeral: true });
      return;
    }

    const methodInfo = buySelections.get(interaction.channel.id);
    const method = PAYMENT_METHODS.find((m) => m.id === methodInfo?.methodId) || { label: "No seleccionado", emoji: "❔" };
    const livePricesPayload = readPrices();
    const liveEffective = getEffectivePrices(livePricesPayload);
    const amount = liveEffective[timeId];

    const resultEmbed = new EmbedBuilder()
      .setColor(BRAND_ORANGE)
      .setTitle("✅ Buy • Selection Completed")
      .setDescription(
        [
          `**Payment method:** ${method.emoji} ${method.label}`,
          `**Duration:** ${timeInfo.label}`,
          `**Price:** ${typeof amount === "number" ? `${amount}€` : amount}`,
          "",
          "Staff will continue the purchase process in this ticket."
        ].join("\n")
      )
      .setTimestamp(new Date());
    await interaction.reply({ embeds: [resultEmbed] });
    buySelections.set(interaction.channel.id, {
      ...(methodInfo || {}),
      ownerId,
      timeId,
      amount: typeof amount === "number" ? amount : 0,
      amountDisplay: typeof amount === "number" ? `${amount}€` : String(amount),
      methodLabel: method.label,
      durationLabel: timeInfo.label
    });

    await logGeneral(client, "Buy selection in ticket", [
      { name: "Usuario", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
      { name: "Ticket", value: interaction.channel?.name || "unknown", inline: true },
      { name: "Pago", value: method.label, inline: true },
      { name: "Tiempo", value: timeInfo.label, inline: true },
      { name: "Precio", value: typeof amount === "number" ? `${amount}€` : String(amount), inline: true }
    ]);
    return;
  }

  if (interaction.customId === "purchase_complete") {
    if (!interaction.channel || !interaction.guild) {
      await interaction.reply({ content: "This action only works inside a ticket channel.", ephemeral: true });
      return;
    }
    if (!hasRequiredRole(interaction.member)) {
      await interaction.reply({ content: "Only staff can mark purchase as completed.", ephemeral: true });
      return;
    }

    const selection = buySelections.get(interaction.channel.id);
    if (!selection || !selection.ownerId || !selection.timeId) {
      await interaction.reply({ content: "No finalized buy selection found for this ticket yet.", ephemeral: true });
      return;
    }

    const purchases = readPurchases();
    if (!purchases.users[selection.ownerId]) {
      purchases.users[selection.ownerId] = { totalSpent: 0, items: [] };
    }
    purchases.users[selection.ownerId].totalSpent = Number(
      ((purchases.users[selection.ownerId].totalSpent || 0) + Number(selection.amount || 0)).toFixed(2)
    );
    purchases.users[selection.ownerId].items.push({
      at: new Date().toISOString(),
      amount: Number(selection.amount || 0),
      amountDisplay: selection.amountDisplay || `${selection.amount || 0}€`,
      paymentMethod: selection.methodLabel || "Unknown",
      duration: selection.durationLabel || selection.timeId,
      ticket: interaction.channel.name
    });
    writePurchases(purchases);

    const ownerUser = await client.users.fetch(selection.ownerId).catch(() => null);
    const safeName = (ownerUser?.username || selection.ownerId).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 20) || "user";
    await interaction.channel.setName(`done-${safeName}`).catch(() => null);

    await interaction.reply({ content: `Purchase saved for <@${selection.ownerId}> (${selection.amountDisplay || "0€"}).`, ephemeral: false });
    await logGeneral(client, "Purchase completed", [
      { name: "Staff", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
      { name: "Buyer", value: `<@${selection.ownerId}>`, inline: true },
      { name: "Amount", value: selection.amountDisplay || "0€", inline: true },
      { name: "Duration", value: selection.durationLabel || "-", inline: true }
    ]);
    return;
  }

  if (interaction.customId === "ticket_close") {
    if (!interaction.channel || !interaction.guild) {
      await interaction.reply({ content: "This ticket cannot be closed here.", ephemeral: true });
      return;
    }

    const canClose = hasRequiredRole(interaction.member) || interaction.channel.topic?.includes(`user:${interaction.user.id}`);
    if (!canClose) {
      await interaction.reply({ content: "You do not have permission to close this ticket.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: "Closing ticket and generating transcript...", ephemeral: true });

    const transcript = await buildTicketTranscript(interaction.channel);
    const transcriptBuffer = Buffer.from(transcript || "No messages to transcribe.", "utf8");
    const ticketName = interaction.channel.name;
    const ownerMatch = /user:(\d+)/.exec(interaction.channel.topic || "");
    const ownerId = ownerMatch ? ownerMatch[1] : "unknown";

    const transcriptEmbed = baseLogEmbed("Ticket transcript", BRAND_ORANGE).addFields([
      { name: "Ticket", value: ticketName, inline: true },
      { name: "Closed by", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
      { name: "Owner", value: ownerId, inline: true }
    ]);
    await sendLogEmbed(client, LOG_CHANNEL_TRANSCRIPTS_ID, transcriptEmbed);

    try {
      const transcriptChannel = await client.channels.fetch(LOG_CHANNEL_TRANSCRIPTS_ID);
      if (transcriptChannel && transcriptChannel.isTextBased()) {
        await transcriptChannel.send({
          files: [{ attachment: transcriptBuffer, name: `${ticketName}-transcript.txt` }]
        });
      }
    } catch (error) {
      console.error("Could not upload transcript:", error.message);
    }

    try {
      if (ownerId !== "unknown") {
        const ownerUser = await client.users.fetch(ownerId);
        const dmEmbed = new EmbedBuilder()
          .setColor(BRAND_ORANGE)
          .setTitle("📄 Your ticket transcript")
          .setDescription("Your ticket has been closed. Here is the full transcript.")
          .addFields(
            { name: "Ticket", value: ticketName, inline: true },
            { name: "Closed by", value: `${interaction.user.tag}`, inline: true }
          )
          .setTimestamp(new Date());
        await ownerUser.send({
          embeds: [dmEmbed],
          files: [{ attachment: transcriptBuffer, name: `${ticketName}-transcript.txt` }]
        });
      }
    } catch (error) {
      console.error("Could not DM transcript to ticket owner:", error.message);
    }

    await logGeneral(client, "Ticket closed", [
      { name: "Ticket", value: ticketName, inline: true },
      { name: "Closed by", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false }
    ]);

    buySelections.delete(interaction.channel.id);
    await interaction.channel.delete("Ticket closed by button action.");
  }
  } catch (error) {
    await logError("interactionCreate", error, {
      customId: interaction?.isButton?.() ? interaction.customId : "-",
      command: interaction?.isChatInputCommand?.() ? interaction.commandName : "-",
      userId: interaction?.user?.id || "-"
    });
    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content: "An error occurred while processing this action.", ephemeral: true });
        } else {
          await interaction.reply({ content: "An error occurred while processing this action.", ephemeral: true });
        }
      }
    } catch (_) {}
  }
});
