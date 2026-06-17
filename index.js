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
  SlashCommandBuilder,
  AttachmentBuilder
} = require("discord.js");

const { mountPanelApi } = require("./panel");
const { mountManageApi } = require("./manage");
const { mountAccountApi } = require("./account");
const { appendKeyLog, mountKeyLogsApi } = require("./key-logs");
const { mountPaymentsApi, pendingOrders } = require("./payments");
const { mountReferralsApi } = require("./referrals");
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
const KEYS_BACKUP_CHANNEL_ID = process.env.KEYS_BACKUP_CHANNEL_ID || "1511740812621250712";
const KEYS_BACKUP_SCHEMA = "falcao-external-keys-backup-v1";
const PRICES_BACKUP_SCHEMA = "falcao-external-prices-backup-v1";
const OFFER_CHANNEL_ID = "1502029921629900890";
const SUGGESTION_CHANNEL_IDS = new Set(["1502035178309161150", "1502007614047785182"]);
const TICKET_CATEGORY_BUY = "Buy Tickets";
const TICKET_CATEGORY_SUPPORT = "Support Tickets";
const TICKET_CATEGORY_HWID_RESET = "HWID Reset Tickets";
const TICKET_CATEGORY_BUG = "Bug Tickets";
const BUY_CHANNEL_LINK = "https://discord.com/channels/1502005944945741864/1502007586613100675";

if (!TOKEN) {
  console.error("[discord] DISCORD_TOKEN no configurado — la web seguira activa pero el bot no arrancara.");
}

function resolveDataDir() {
  const fromEnv = process.env.PERSISTENT_DATA_DIR || process.env.DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) {
    return path.resolve(String(fromEnv).trim());
  }
  // Auto-detect common mounted persistent disk locations on hosts like Render.
  // Prefer a dedicated subfolder to avoid collisions.
  const candidates = [
    "/var/data/falcao-external",
    "/data/falcao-external",
    "/mnt/data/falcao-external"
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      fs.mkdirSync(p, { recursive: true });
      const probe = path.join(p, ".write-test");
      fs.writeFileSync(probe, "ok", "utf8");
      fs.unlinkSync(probe);
      return p;
    } catch (_) {
      // try next
    }
  }
  return path.join(__dirname, "data");
}

const dataDir = resolveDataDir();
const dbPath = path.join(dataDir, "keys.json");
const pricesPath = path.join(dataDir, "prices.json");
const purchasesPath = path.join(dataDir, "purchases.json");

function atomicWriteJsonFile(filePath, obj) {
  const json = JSON.stringify(obj, null, 2);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(filePath)) {
    try {
      fs.copyFileSync(filePath, `${filePath}.bak`);
    } catch (_) {
      /* ignore */
    }
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, json, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (_) {
    fs.copyFileSync(tmpPath, filePath);
    try {
      fs.unlinkSync(tmpPath);
    } catch (__) {
      /* ignore */
    }
  }
}

function restoreKeysFromLatestBackup() {
  const backupDir = path.join(dataDir, "backups");
  if (!fs.existsSync(backupDir)) {
    return null;
  }
  let files;
  try {
    files = fs.readdirSync(backupDir);
  } catch (_) {
    return null;
  }
  const candidates = files.filter((f) => f.startsWith("keys-") && f.endsWith(".json"));
  if (!candidates.length) {
    return null;
  }
  const sorted = candidates
    .map((f) => ({ f, t: fs.statSync(path.join(backupDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of sorted) {
    try {
      const p = path.join(backupDir, f);
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      if (parsed && Array.isArray(parsed.keys)) {
        return parsed;
      }
    } catch (_) {
      /* try next */
    }
  }
  return null;
}
const BRAND_ORANGE = 0xff8a33;
const BUTTON_COOLDOWN_MS = 2500;
const PANEL_LOGO_URL = "https://i.imgur.com/0nTvfnO.png";
const FAVICON_URL = "https://i.imgur.com/lst2PVm.png";

const PAYMENT_METHODS = [
  { id: "paypal", label: "Paypal", emoji: "💳" },
  { id: "litecoin", label: "Litecoin", emoji: "🪙" },
  // Note: "₿" (bitcoin sign) is not a valid Discord emoji for components.
  { id: "bitcoin", label: "Bitcoin", emoji: "🟠" },
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

async function safeReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (error) {
    // DiscordAPIError[10062]: Unknown interaction (expired token / too slow)
    // DiscordAPIError[40060]: Interaction has already been acknowledged
    const code = Number(error?.code || 0);
    if (code === 10062 || code === 40060) return null;
    throw error;
  }
}

async function safeDefer(interaction, ephemeral = false) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral });
    }
  } catch (error) {
    const code = Number(error?.code || 0);
    if (code === 10062 || code === 40060) return;
    throw error;
  }
}

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

function defaultWebPrices() {
  return {
    product1: { name: "Producto 1", week: 12, monthly: 28, lifetime: 90 },
    product2: { name: "Producto 2", week: 15, monthly: 32, lifetime: 100 }
  };
}

function defaultPricesPayload() {
  return {
    base: defaultPriceTable(),
    web: defaultWebPrices(),
    offer: {
      discountPercent: 0,
      durationText: "",
      endsAt: null
    }
  };
}

function normalizeWebPrices(web) {
  const defaults = defaultWebPrices();
  const out = {};
  for (const key of ["product1", "product2"]) {
    const src = web && web[key] ? web[key] : {};
    const def = defaults[key];
    out[key] = {
      name: String(src.name || def.name),
      week: Number.isFinite(Number(src.week)) ? Number(src.week) : def.week,
      monthly: Number.isFinite(Number(src.monthly)) ? Number(src.monthly) : def.monthly,
      lifetime: Number.isFinite(Number(src.lifetime)) ? Number(src.lifetime) : def.lifetime
    };
  }
  return out;
}

function ensurePrices() {
  ensureDb();
  if (!fs.existsSync(pricesPath)) {
    const bak = `${pricesPath}.bak`;
    if (fs.existsSync(bak)) {
      try {
        fs.copyFileSync(bak, pricesPath);
        return;
      } catch (_) {
        /* fall through */
      }
    }
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

function readPrices() {
  ensurePrices();
  const parsed = JSON.parse(fs.readFileSync(pricesPath, "utf8"));
  if (parsed && parsed.base && parsed.offer) {
    return {
      base: { ...defaultPriceTable(), ...parsed.base },
      web: normalizeWebPrices(parsed.web),
      offer: {
        discountPercent: Number(parsed.offer.discountPercent || 0),
        durationText: parsed.offer.durationText || "",
        endsAt: parsed.offer.endsAt || null,
        expiredNotified: !!parsed.offer.expiredNotified,
        // Preserve weboffer-specific fields so they survive restarts
        isWebOffer: !!parsed.offer.isWebOffer,
        announcedChannel: parsed.offer.announcedChannel || null,
        announcedMessageId: parsed.offer.announcedMessageId || null,
        customMessage: parsed.offer.customMessage || null
      }
    };
  }

  // Backward compatibility for old flat format.
  return {
    base: { ...defaultPriceTable(), ...parsed },
    web: normalizeWebPrices(parsed.web),
    offer: {
      discountPercent: 0,
      durationText: "",
      endsAt: null,
      expiredNotified: false,
      isWebOffer: false,
      announcedChannel: null,
      announcedMessageId: null,
      customMessage: null
    }
  };
}

function getWebPricesPayload() {
  const prices = readPrices();
  const discount = getActiveDiscount(prices);
  const web = normalizeWebPrices(prices.web);
  const out = {};
  for (const [id, product] of Object.entries(web)) {
    const apply = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return "—";
      if (!discount) return Number(n.toFixed(2));
      return Number((n * (1 - discount / 100)).toFixed(2));
    };
    out[id] = {
      name: product.name,
      week: apply(product.week),
      monthly: apply(product.monthly),
      lifetime: apply(product.lifetime)
    };
  }
  return { products: out, offer: prices.offer, discountActive: discount > 0, discountPercent: discount };
}

function writePrices(prices) {
  ensurePrices();
  atomicWriteJsonFile(pricesPath, prices);
  if (discordClientRef) {
    pushPricesBackupToDiscord(discordClientRef, "prices-change").catch(() => {});
  }
}

function readPurchases() {
  ensurePurchases();
  return JSON.parse(fs.readFileSync(purchasesPath, "utf8"));
}

function writePurchases(payload) {
  ensurePurchases();
  atomicWriteJsonFile(purchasesPath, payload);
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
  const parseKeysFile = (p) => {
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.keys)) {
      throw new Error("Invalid keys database shape");
    }
    return data;
  };

  const restoreCandidates = [
  () => {
    const bak = `${dbPath}.bak`;
    if (!fs.existsSync(bak)) return null;
    return parseKeysFile(bak);
  },
  () => restoreKeysFromLatestBackup()
  ];

  try {
    return parseKeysFile(dbPath);
  } catch (e) {
    console.error(`[data] Cannot read ${dbPath}:`, e.message);
    for (const restore of restoreCandidates) {
      try {
        const restored = restore();
        if (restored && restored.keys.length > 0) {
          console.warn(`[data] Restored ${restored.keys.length} keys from backup source`);
          atomicWriteJsonFile(dbPath, restored);
          return restored;
        }
      } catch (restoreError) {
        console.error("[data] Backup restore attempt failed:", restoreError.message);
      }
    }
    console.error("[data] No local backup found; waiting for Discord restore on bot ready");
    const empty = { keys: [] };
    atomicWriteJsonFile(dbPath, empty);
    return empty;
  }
}

function logDatabaseStatus() {
  try {
    const db = readDb();
    console.log(`[data] Using database: ${dbPath}`);
    console.log(`[data] Keys loaded: ${db.keys.length}`);
    if (db.keys.length === 0) {
      console.warn("[data] WARNING: 0 keys loaded. Check Discord backup channel or generate keys.");
    }
  } catch (error) {
    console.error("[data] Startup database check failed:", error.message);
  }
}

let discordClientRef = null;
let keysBackupPushInFlight = false;
let keysBackupPushQueued = false;
let pricesBackupPushInFlight = false;
let pricesBackupPushQueued = false;

function buildKeysBackupPayload(reason = "change") {
  const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
  return {
    schema: KEYS_BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    reason,
    keys: Array.isArray(db.keys) ? db.keys : []
  };
}

async function fetchLatestDiscordKeysBackup(clientInstance) {
  if (!clientInstance?.isReady()) return null;
  const channel = await clientInstance.channels.fetch(KEYS_BACKUP_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  let lastId;
  for (let page = 0; page < 30; page += 1) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const fetched = await channel.messages.fetch(opts);
    if (!fetched.size) break;

    const messages = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const msg of messages) {
      if (msg.author?.id !== clientInstance.user.id) continue;
      const attachment = msg.attachments.find(
        (a) => a.name && a.name.startsWith("keys-backup-") && a.name.endsWith(".json")
      );
      if (!attachment?.url) continue;
      const res = await fetch(attachment.url);
      if (!res.ok) continue;
      const parsed = JSON.parse(await res.text());
      if (parsed && Array.isArray(parsed.keys)) {
        return parsed;
      }
    }

    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }
  return null;
}

async function restoreKeysFromDiscordChannel(clientInstance) {
  const backup = await fetchLatestDiscordKeysBackup(clientInstance);
  if (!backup || !Array.isArray(backup.keys)) {
    console.warn("[backup-discord] No keys backup found in Discord channel");
    return false;
  }
  atomicWriteJsonFile(dbPath, { keys: backup.keys });
  console.log(`[backup-discord] Restored ${backup.keys.length} keys from Discord`);
  return true;
}

function buildPricesBackupPayload(reason = "change") {
  const prices = readPrices();
  return {
    schema: PRICES_BACKUP_SCHEMA,
    exportedAt: new Date().toISOString(),
    reason,
    prices
  };
}

async function fetchLatestDiscordPricesBackup(clientInstance) {
  if (!clientInstance?.isReady()) return null;
  const channel = await clientInstance.channels.fetch(KEYS_BACKUP_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  let lastId;
  for (let page = 0; page < 30; page += 1) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const fetched = await channel.messages.fetch(opts);
    if (!fetched.size) break;

    const messages = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const msg of messages) {
      if (msg.author?.id !== clientInstance.user.id) continue;
      const attachment = msg.attachments.find(
        (a) => a.name && a.name.startsWith("prices-backup-") && a.name.endsWith(".json")
      );
      if (!attachment?.url) continue;
      const res = await fetch(attachment.url);
      if (!res.ok) continue;
      const parsed = JSON.parse(await res.text());
      if (parsed?.prices?.base && parsed?.prices?.web) {
        return parsed;
      }
    }

    lastId = fetched.last().id;
    if (fetched.size < 100) break;
  }
  return null;
}

async function restorePricesFromDiscordChannel(clientInstance) {
  const backup = await fetchLatestDiscordPricesBackup(clientInstance);
  if (!backup?.prices) {
    console.warn("[backup-discord] No prices backup found in Discord channel");
    return false;
  }
  atomicWriteJsonFile(pricesPath, backup.prices);
  console.log("[backup-discord] Restored prices from Discord");
  return true;
}

async function restoreLoadersFromDiscord(clientInstance) {
  if (!clientInstance?.isReady()) return false;
  const channel = await clientInstance.channels.fetch(KEYS_BACKUP_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return false;

  const loadersDir = path.join(dataDir, "loaders");
  const metaPath = path.join(loadersDir, "loaders.json");

  // Check if loaders already exist locally
  let existingMeta = {};
  try {
    if (fs.existsSync(metaPath)) {
      existingMeta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    }
  } catch (_) {}

  const loaderTypes = ["falcao", "temp"];
  const missing = loaderTypes.filter(t => {
    if (!existingMeta[t]) return true;
    return !fs.existsSync(path.join(loadersDir, existingMeta[t]));
  });

  if (missing.length === 0) {
    console.log("[backup-discord] All loaders present locally, no restore needed.");
    return true;
  }

  console.log(`[backup-discord] Restoring missing loaders: ${missing.join(", ")}`);

  let lastId;
  for (let page = 0; page < 20; page++) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const fetched = await channel.messages.fetch(opts).catch(() => null);
    if (!fetched || !fetched.size) break;

    const messages = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    for (const msg of messages) {
      if (msg.author?.id !== clientInstance.user.id) continue;
      for (const loaderType of [...missing]) {
        const attachment = msg.attachments.find(a =>
          a.name && a.name.startsWith(`loader-${loaderType}-`)
        );
        if (!attachment?.url) continue;
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) continue;
          const buf = Buffer.from(await res.arrayBuffer());
          fs.mkdirSync(loadersDir, { recursive: true });
          const fileName = attachment.name.replace(`loader-${loaderType}-`, "");
          const filePath = path.join(loadersDir, fileName);
          fs.writeFileSync(filePath, buf);
          existingMeta[loaderType] = fileName;
          fs.writeFileSync(metaPath, JSON.stringify(existingMeta, null, 2), "utf8");
          console.log(`[backup-discord] Restored loader ${loaderType}: ${fileName}`);
          missing.splice(missing.indexOf(loaderType), 1);
        } catch (_) {}
      }
      if (missing.length === 0) return true;
    }

    lastId = fetched.last()?.id;
    if (fetched.size < 100) break;
  }

  return missing.length === 0;
}

async function pushPricesBackupToDiscord(clientInstance, reason = "change") {
  if (!clientInstance?.isReady()) {
    pricesBackupPushQueued = true;
    return;
  }
  if (pricesBackupPushInFlight) {
    pricesBackupPushQueued = true;
    return;
  }
  pricesBackupPushInFlight = true;
  try {
    ensurePrices();
    const payload = buildPricesBackupPayload(reason);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `prices-backup-${stamp}.json`;
    const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
      name: fileName
    });
    const channel = await clientInstance.channels.fetch(KEYS_BACKUP_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error("Backup channel not found or not text-based");
    }
    await channel.send({
      content: `💰 Prices backup • \`${reason}\``,
      files: [attachment]
    });
    console.log(`[backup-discord] Pushed prices backup (reason: ${reason})`);
  } catch (error) {
    console.error("[backup-discord] Prices push failed:", error.message);
    logError("backup_discord_prices_push", error, { reason }).catch(() => {});
  } finally {
    pricesBackupPushInFlight = false;
    if (pricesBackupPushQueued) {
      pricesBackupPushQueued = false;
      pushPricesBackupToDiscord(clientInstance, reason).catch(() => {});
    }
  }
}

async function pushKeysBackupToDiscord(clientInstance, reason = "change") {
  if (!clientInstance?.isReady()) {
    keysBackupPushQueued = true;
    return;
  }
  if (keysBackupPushInFlight) {
    keysBackupPushQueued = true;
    return;
  }
  keysBackupPushInFlight = true;
  try {
    ensureDb();
    const payload = buildKeysBackupPayload(reason);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `keys-backup-${stamp}.json`;
    const attachment = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2), "utf8"), {
      name: fileName
    });
    const channel = await clientInstance.channels.fetch(KEYS_BACKUP_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      throw new Error("Backup channel not found or not text-based");
    }
    await channel.send({
      content: `🔐 Keys backup • **${payload.keys.length}** keys • \`${reason}\``,
      files: [attachment]
    });
    console.log(`[backup-discord] Pushed backup (${payload.keys.length} keys, reason: ${reason})`);
  } catch (error) {
    console.error("[backup-discord] Push failed:", error.message);
    logError("backup_discord_push", error, { reason }).catch(() => {});
  } finally {
    keysBackupPushInFlight = false;
    if (keysBackupPushQueued) {
      keysBackupPushQueued = false;
      pushKeysBackupToDiscord(clientInstance, reason).catch(() => {});
    }
  }
}

function writeDb(db) {
  if (fs.existsSync(dbPath)) {
    try {
      fs.copyFileSync(dbPath, `${dbPath}.bak`);
    } catch (_) {
      /* ignore backup copy errors */
    }
  }
  atomicWriteJsonFile(dbPath, db);
  if (discordClientRef) {
    pushKeysBackupToDiscord(discordClientRef, "keys-change").catch(() => {});
  }
}

function hasRequiredRole(member) {
  if (!member) return false;
  if (member.roles?.cache?.has) {
    return member.roles.cache.has(REQUIRED_ROLE_ID);
  }
  if (Array.isArray(member.roles)) {
    return member.roles.includes(REQUIRED_ROLE_ID);
  }
  return false;
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
  if (!client.isReady()) {
    console.error(`[logError] ${context}: ${reason}`);
    return;
  }
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

function normalizeKey(raw) {
  return String(raw || "").trim().toUpperCase();
}

function generateKey() {
  // Match the menu's displayed fixed format: Falcao-External-XXXXXX-XXXXXXX
  return `FALCAO-EXTERNAL-${randomAlphaNum(6)}-${randomAlphaNum(7)}`;
}

function normalizePlan(rawPlan) {
  const plan = String(rawPlan || "falcao").trim().toLowerCase();
  if (plan === "falcao" || plan === "temp" || plan === "both") return plan;
  return null;
}

function canUsePlanForProduct(plan, product) {
  const normalizedPlan = normalizePlan(plan);
  const normalizedProduct = normalizePlan(product);
  if (!normalizedProduct) return true;
  if (!normalizedPlan) return false;
  if (normalizedPlan === "both") return true;
  return normalizedPlan === normalizedProduct;
}

function calcExpiresAt(days) {
  const now = Date.now();
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

function getKeyRecord(db, key) {
  const normalized = normalizeKey(key);
  return db.keys.find((k) => normalizeKey(k.key) === normalized);
}

function validateAndBindKey(db, key, hwid, ip, product, logDataDir) {
  const found = getKeyRecord(db, key);
  if (!found) {
    return { ok: false, message: "Key no existe." };
  }
  const keyPlan = normalizePlan(found.plan) || "falcao";
  if (!canUsePlanForProduct(keyPlan, product)) {
    const productName = normalizePlan(product) || "unknown";
    return { ok: false, message: `Acceso denegado: esta key es del plan ${keyPlan} y no sirve para ${productName}.` };
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
    found.key = normalizeKey(found.key);
    writeDb(db);
    appendKeyLog(dataDir, normalizeKey(found.key), "first_login", { ip, hwid, product: product || "falcao" });
    return { ok: true, message: "Primer login registrado. Key vinculada a HWID/IP.", key: found };
  }

  if (found.hwid !== hwid || found.ip !== ip) {
    appendKeyLog(dataDir, normalizeKey(found.key), "login_rejected", { ip, hwid, reason: "hwid_ip_mismatch" });
    return { ok: false, message: "Acceso denegado: esta key ya esta vinculada a otro HWID/IP." };
  }

  appendKeyLog(dataDir, normalizeKey(found.key), "login", { ip, hwid, product: product || "falcao" });
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
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "discord-key-bot-api" });
});

// ── HWID Reset approval via Discord interaction (webhook button) ──────────
app.post("/api/hwid/action", async (req, res) => {
  const { action, discordId, keyStr } = req.body || {};
  if (!action || !discordId) return res.status(400).json({ ok: false });

  const disc = discordClientRef;
  const approved = action === 'approve';

  if (approved && keyStr) {
    try {
      const db = readDb();
      const found = getKeyRecord(db, keyStr);
      if (found) {
        found.hwid = null;
        found.ip = null;
        found.firstLoginAt = null;
        writeDb(db);
        appendKeyLog(dataDir, normalizeKey(keyStr), "hwid_reset", { by: "admin_via_request", discordId });
      }
    } catch (_) {}
  }

  // Send DM to user
  try {
    if (disc && disc.isReady()) {
      const user = await disc.users.fetch(discordId).catch(() => null);
      if (user) {
        const msg = approved
          ? `✅ **Your HWID reset request has been approved!**\nYour HWID has been cleared. You can now log in from a new device.`
          : `❌ **Your HWID reset request has been rejected.**\nIf you think this is a mistake, contact an admin on Discord.`;
        await user.send(msg).catch(() => {});
      }
    }
  } catch (_) {}

  res.json({ ok: true, approved });
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
  const product = (req.body && (req.body.product || req.body.plan)) || "";
  const ip = ipHint || getClientIp(req);
  if (!licenseKey || !hwid) {
    res.status(400).json({ success: false, message: "Missing fields: license_key, hwid." });
    return;
  }

  const db = readDb();
  const result = validateAndBindKey(db, licenseKey, hwid, ip, product, dataDir);
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
  const product = (req.body && (req.body.product || req.body.plan)) || "";
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

  const keyPlan = normalizePlan(found.plan) || "falcao";
  if (!canUsePlanForProduct(keyPlan, product)) {
    res.status(403).json({
      success: false,
      valid: false,
      activated: !!found.firstLoginAt,
      paused: false,
      banned: false,
      expired: found.status === "expired",
      is_admin: false,
      license_id: found.key,
      license_key_masked: maskLicenseKey(found.key),
      plan: keyPlan,
      expires_at: found.expiresAt || "",
      max_devices: 1,
      active_devices: found.firstLoginAt ? 1 : 0,
      message: `License plan ${keyPlan} is not valid for ${normalizePlan(product) || "this product"}.`
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
    plan: keyPlan,
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

  const { key, hwid, ip, product, plan } = req.body || {};
  if (!key || !hwid || !ip) {
    res.status(400).json({ ok: false, message: "Faltan campos: key, hwid, ip." });
    return;
  }

  const db = readDb();
  const selectedProduct = product || plan || "";
  const result = validateAndBindKey(db, key, hwid, ip, selectedProduct, dataDir);
  if (!result.ok) {
    res.status(403).json(result);
    return;
  }

  res.json({
    ok: true,
    message: result.message,
    key: result.key.key,
    plan: normalizePlan(result.key.plan) || "falcao",
    expiresAt: result.key.expiresAt,
    firstLoginAt: result.key.firstLoginAt
  });
});

app.get("/api/web/prices", (_req, res) => {
  res.json({ ok: true, ...getWebPricesPayload() });
});

mountPanelApi(app, {
  express,
  normalizeKey,
  getKeyRecord,
  readDb,
  writeDb,
  getClientIp,
  getWebPricesPayload
});

mountManageApi(app, {
  express,
  normalizeKey,
  getKeyRecord,
  readDb,
  writeDb,
  getClientIp,
  generateKey,
  calcExpiresAt,
  normalizePlan,
  dataDir
});

const loadersPath = path.join(dataDir, "loaders");

mountAccountApi(app, {
  readDb,
  writeDb,
  getKeyRecord,
  normalizeKey,
  normalizePlan,
  loadersPath
});

// Raw body needed for Stripe webhook signature verification
app.use("/api/payments/stripe/webhook", (req, _res, next) => {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", chunk => { data += chunk; });
  req.on("end", () => { req.rawBody = data; next(); });
});

mountPaymentsApi(app, {
  readDb,
  writeDb,
  generateKey,
  getKeyRecord,
  calcExpiresAt,
  normalizePlan,
  appendKeyLog,
  dataDir,
  getWebPricesPayload,
  discordClient: null // will be set after client is ready
});

mountReferralsApi(app, { dataDir });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers]
});
discordClientRef = client;

// Inject discord client into payments module after it's created
const { setPaymentsDiscordClient } = require("./payments");
setPaymentsDiscordClient(client);

app.listen(API_PORT, "0.0.0.0", () => {
  console.log(`HTTP API online on port ${API_PORT} (bind 0.0.0.0)`);
});

client.once("ready", async () => {
  try {
    await restoreKeysFromDiscordChannel(client);
  } catch (error) {
    console.error("[backup-discord] Restore on startup failed:", error.message);
    logError("backup_discord_restore", error).catch(() => {});
  }
  try {
    await restorePricesFromDiscordChannel(client);
  } catch (error) {
    console.error("[backup-discord] Prices restore on startup failed:", error.message);
    logError("backup_discord_prices_restore", error).catch(() => {});
  }
  // Restore loaders from Discord backup channel
  try {
    await restoreLoadersFromDiscord(client);
  } catch (error) {
    console.error("[backup-discord] Loaders restore failed:", error.message);
  }
  logDatabaseStatus();
  if (!process.env.DISCORD_CLIENT_ID && client.application?.id) {
    process.env.DISCORD_CLIENT_ID = client.application.id;
    console.log(`[manage] DISCORD_CLIENT_ID auto: ${client.application.id}`);
  }
  console.log(`Bot online: ${client.user.tag}`);
  console.log(`[data] Data directory: ${dataDir}`);
  console.log(`[data] Keys file: ${dbPath}`);
  console.log(`[backup-discord] Backup channel: ${KEYS_BACKUP_CHANNEL_ID}`);
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
    new SlashCommandBuilder().setName("webofferoff").setDescription("Desactiva la oferta web activa y elimina el mensaje de anuncio."),
    new SlashCommandBuilder()
      .setName("weboffer")
      .setDescription("Activa oferta web con precio tachado y banner.")
      .addStringOption(o => o.setName("porcentaje").setDescription("Ej: -30 (descuento) o +10 (aumento)").setRequired(true))
      .addStringOption(o => o.setName("duracion").setDescription("Duración: 1h, 5d, 2w...").setRequired(true))
      .addStringOption(o => o.setName("anunciar").setDescription("Anunciar en canal de ofertas?").setRequired(true)
        .addChoices({ name: "Si", value: "si" }, { name: "No", value: "no" }))
      .addStringOption(o => o.setName("everyone").setDescription("Mencionar @everyone?").setRequired(true)
        .addChoices({ name: "Si", value: "si" }, { name: "No", value: "no" }))
      .addStringOption(o => o.setName("mensaje").setDescription("Mensaje personalizado (opcional)").setRequired(false)),
    new SlashCommandBuilder()
      .setName("paypalconfirm")
      .setDescription("Confirmar o rechazar un pago PayPal pendiente.")
      .addStringOption(o => o.setName("orderid").setDescription("Order ID del pago PayPal").setRequired(true))
      .addStringOption(o => o.setName("accion").setDescription("Confirmar o rechazar").setRequired(true)
        .addChoices({ name: "✅ Confirmar y entregar key", value: "confirm" }, { name: "❌ Rechazar", value: "reject" })),
    new SlashCommandBuilder()
      .setName("webprices")
      .setDescription("Set web landing page product prices.")
      .addStringOption((o) =>
        o
          .setName("producto")
          .setDescription("product1 or product2")
          .setRequired(true)
          .addChoices(
            { name: "Producto 1", value: "product1" },
            { name: "Producto 2", value: "product2" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("plan")
          .setDescription("week, monthly or lifetime")
          .setRequired(true)
          .addChoices(
            { name: "Week", value: "week" },
            { name: "Monthly", value: "monthly" },
            { name: "Lifetime", value: "lifetime" }
          )
      )
      .addNumberOption((o) => o.setName("precio").setDescription("Price in EUR").setRequired(true))
      .addStringOption((o) => o.setName("nombre").setDescription("Optional display name for the product")),
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
      .addIntegerOption((o) => o.setName("dias").setDescription("Duration in days").setRequired(true).setMinValue(1))
      .addStringOption((o) =>
        o
          .setName("plan")
          .setDescription("License plan: falcao, temp, both")
          .setRequired(true)
          .addChoices(
            { name: "Falcao", value: "falcao" },
            { name: "Temp", value: "temp" },
            { name: "Both", value: "both" }
          )
      ),
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
    ,
    new SlashCommandBuilder()
      .setName("datadir")
      .setDescription("Show the current persistent data directory.")
    ,
    new SlashCommandBuilder()
      .setName("keybackups")
      .setDescription("Export all keys as a JSON file (downloadable).")
    ,
    new SlashCommandBuilder()
      .setName("keyimports")
      .setDescription("Import keys from a JSON backup file.")
      .addAttachmentOption((o) =>
        o.setName("archivo").setDescription("JSON file from /keybackups").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("falcaoloader")
      .setDescription("Update the Falcao plan loader file (replaces previous).")
      .addAttachmentOption((o) =>
        o.setName("archivo").setDescription("Loader executable file").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("temploader")
      .setDescription("Update the Temp plan loader file (replaces previous).")
      .addAttachmentOption((o) =>
        o.setName("archivo").setDescription("Loader executable file").setRequired(true)
      )
  ].map((cmd) => cmd.toJSON());

  // Clear global commands to avoid duplicates (guild commands are instant and preferred)
  client.application.commands.set([]).catch((error) => {
    console.error("Could not clear global slash commands:", error.message);
  });

  // Register only as guild commands for instant availability (no duplicates)
  const GUILD_ID = "1502005944945741864";
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(slashCommands);
    console.log(`[commands] Registered ${slashCommands.length} slash commands to guild ${GUILD_ID}`);
  } catch (guildErr) {
    console.error("[commands] Could not register guild slash commands:", guildErr.message);
    // Try registering one by one to find the problematic command
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      await guild.commands.set([]); // clear first
      let registered = 0;
      for (const cmd of slashCommands) {
        try {
          await guild.commands.create(cmd);
          registered++;
        } catch (singleErr) {
          console.error(`[commands] Failed to register command "${cmd.name}":`, singleErr.message);
        }
      }
      console.log(`[commands] Registered ${registered}/${slashCommands.length} commands individually`);
    } catch (_) {}
  }
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

    // If this was a weboffer with an announced channel, send end notice there
    if (offer.isWebOffer && offer.announcedChannel) {
      try {
        const ch = await client.channels.fetch(offer.announcedChannel).catch(() => null);
        if (ch && ch.isTextBased()) {
          const embed = new EmbedBuilder()
            .setColor(0x8a8a9a)
            .setTitle("⏰ Oferta finalizada")
            .setDescription("La oferta ha expirado. Los precios han vuelto a la normalidad.")
            .setTimestamp(new Date());
          await ch.send({ embeds: [embed] }); // no @everyone on expiry
        }
      } catch (_) {}
    } else {
      // Legacy: send to old OFFER_CHANNEL_ID
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL OFFER ENDED")
        .setThumbnail(PANEL_LOGO_URL)
        .setDescription("The active offer has expired. Standard prices are now active again.")
        .setTimestamp(new Date());
      await sendLogEmbed(client, OFFER_CHANNEL_ID, embed);
    }
  } catch (error) {
    console.error("Offer expiry checker failed:", error.message);
    logError("offer_expiry_interval", error).catch(() => {});
  }
}, 60 * 1000);

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

process.on("unhandledRejection", (reason) => {
  logError("process.unhandledRejection", reason).catch(() => {});
});

process.on("uncaughtException", (error) => {
  logError("process.uncaughtException", error).catch(() => {});
});

if (TOKEN) {
  client.login(TOKEN).catch((error) => {
    console.error("[discord] Login fallido:", error.message);
  });
}

client.on("interactionCreate", async (interaction) => {
  try {
  if (interaction.isChatInputCommand()) {
    await safeDefer(interaction, false);

    const slashCommand = interaction.commandName;
    const publicSlashCommands = new Set(["falcaohelp", "s"]);
    const requiresRole = !publicSlashCommands.has(slashCommand);
    if (requiresRole && !hasRequiredRole(interaction.member)) {
      await safeReply(interaction, { content: `Not authorized. You need role <@&${REQUIRED_ROLE_ID}>.` });
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
              "`/weboffer`",
              "`/webofferoff`",
              "`/webprices`",
              "`/keygen` `/keylist` `/keycheck` `/keydel` `/resethwid`",
              "`/compraseveryone`"
            ].join("\n"),
            inline: false
          }
        )
        .setFooter({ text: "Slash commands only" });
      await safeReply(interaction, { embeds: [helpEmbed] });
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
      await safeReply(interaction, { content: "Ticket panel sent." });
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
      await safeReply(interaction, { content: "Price table sent." });
      return;
    }

    if (slashCommand === "tablapreciosset") {
      const pricesPayload = readPrices();
      const timeKey = interaction.options.getString("tiempo", true);
      const amount = interaction.options.getNumber("precio", true);
      pricesPayload.base[timeKey] = Number(amount.toFixed(2));
      writePrices(pricesPayload);
      await safeReply(interaction, { content: `Price updated: \`${timeKey}\` -> **${pricesPayload.base[timeKey]}€**` });
      return;
    }

    if (slashCommand === "oferta") {
      const discount = interaction.options.getNumber("descuento", true);
      const durationText = interaction.options.getString("duracion", true);
      const durationMs = parseDurationToMs(durationText);
      if (!durationMs || discount <= 0 || discount >= 100) {
        await safeReply(interaction, { content: "Invalid values. Example: /oferta descuento:20 duracion:7d" });
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
      await safeReply(interaction, { content: "Offer published." });
      return;
    }

    if (slashCommand === "offeroff") {
      const pricesPayload = readPrices();
      pricesPayload.offer = { discountPercent: 0, durationText: "", endsAt: null, expiredNotified: true };
      writePrices(pricesPayload);
      await safeReply(interaction, { content: "Offer disabled." });
      return;
    }

    if (slashCommand === "paypalconfirm") {
      const orderId = interaction.options.getString("orderid", true).trim();
      const accion = interaction.options.getString("accion", true);
      try {
        const res = await fetch(`http://localhost:${API_PORT}/api/payments/admin/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-admin-secret": process.env.MENU_API_TOKEN || "" },
          body: JSON.stringify({ orderId, action: accion })
        });
        const data = await res.json();
        if (accion === "confirm" && data.ok) {
          await safeReply(interaction, { content: `✅ Pago confirmado. Key entregada: \`${data.key}\`\nOrder: \`${orderId}\`` });
        } else if (accion === "reject" && data.ok) {
          await safeReply(interaction, { content: `❌ Pago rechazado. Order: \`${orderId}\`` });
        } else {
          await safeReply(interaction, { content: `Error: ${data.message || "Orden no encontrada."}` });
        }
      } catch (err) {
        await safeReply(interaction, { content: `Error interno: ${err.message}` });
      }
      return;
    }

    if (slashCommand === "weboffer") {
      const rawPct = interaction.options.getString("porcentaje", true).replace("%", "").trim();
      const durRaw = interaction.options.getString("duracion", true).trim();
      const customMsg = interaction.options.getString("mensaje") || null;
      const anunciar = interaction.options.getString("anunciar", true) === "si";
      const everyone = interaction.options.getString("everyone", true) === "si";

      const pct = Number(rawPct);
      if (!Number.isFinite(pct) || pct === 0) {
        await safeReply(interaction, { content: "Porcentaje inválido. Usa ej: -30 o +10" });
        return;
      }
      const durationMs = parseDurationToMs(durRaw);
      if (!durationMs) {
        await safeReply(interaction, { content: "Duración inválida. Usa ej: 1h, 5d, 2w" });
        return;
      }

      const endsAt = new Date(Date.now() + durationMs).toISOString();
      const endUnix = Math.floor((Date.now() + durationMs) / 1000);
      const isDiscount = pct < 0;
      const absPct = Math.abs(pct);

      const pricesPayload = readPrices();
      pricesPayload.offer = {
        discountPercent: isDiscount ? absPct : -absPct, // negative = increase, positive = discount
        durationText: durRaw,
        endsAt,
        expiredNotified: false,
        customMessage: customMsg,
        announcedChannel: anunciar ? "1502048947001102546" : null,
        isWebOffer: true
      };
      writePrices(pricesPayload);

      const offerLabel = isDiscount ? `🔥 -${absPct}% DESCUENTO` : `📈 +${absPct}% AUMENTO DE PRECIO`;
      const msgBody = customMsg
        ? customMsg
        : isDiscount
          ? `⚡ Oferta limitada activa: **${absPct}% de descuento** en todos los planes. Aprovéchala antes de que acabe!`
          : `📊 Precios actualizados: +${absPct}% en todos los planes.`;

      if (anunciar) {
        const OFFER_WEB_CHANNEL = "1502048947001102546";
        try {
          const ch = await client.channels.fetch(OFFER_WEB_CHANNEL);
          if (ch && ch.isTextBased()) {
            const embed = new EmbedBuilder()
              .setColor(isDiscount ? 0x22c55e : 0xe85822)
              .setTitle(offerLabel)
              .setDescription(`${msgBody}\n\n⏳ **Termina:** <t:${endUnix}:R> (<t:${endUnix}:F>)`)
              .setFooter({ text: "Falcao External • Oferta limitada" })
              .setTimestamp();
            const content = everyone ? "@everyone" : "";
            const sentMsg = await ch.send({ content, embeds: [embed] });
            // Save the message ID so /webofferoff can delete it
            const pricesAfter = readPrices();
            pricesAfter.offer.announcedMessageId = sentMsg.id;
            writePrices(pricesAfter);
          }
        } catch (e) {
          console.error("[weboffer] announce error:", e.message);
        }
      }

      await safeReply(interaction, {
        content: `✅ Oferta web activada: **${pct > 0 ? "+" : ""}${pct}%** durante **${durRaw}**${anunciar ? " · Anunciado en el canal" : ""}.\nLos precios en la web ahora muestran el precio original tachado con el nuevo precio.`
      });
      return;
    }

    if (slashCommand === "webofferoff") {
      const pricesPayload = readPrices();
      const offer = pricesPayload.offer || {};

      // Check if there is actually an active web offer
      const hasActiveOffer = offer.discountPercent && offer.discountPercent !== 0 && offer.endsAt && !offer.expiredNotified;
      if (!hasActiveOffer) {
        await safeReply(interaction, { content: "ℹ️ No hay ninguna oferta activa en este momento." });
        return;
      }

      // Try to delete the announcement message from the offer channel
      const announcedChannel = offer.announcedChannel;
      const announcedMessageId = offer.announcedMessageId;
      let deletedMsg = false;

      if (announcedChannel && announcedMessageId) {
        try {
          const ch = await client.channels.fetch(announcedChannel).catch(() => null);
          if (ch && ch.isTextBased()) {
            const msg = await ch.messages.fetch(announcedMessageId).catch(() => null);
            if (msg) {
              await msg.delete();
              deletedMsg = true;
            }
          }
        } catch (e) {
          console.error("[webofferoff] Could not delete offer message:", e.message);
        }
      }

      // Send an "offer ended" notice to the announcement channel if it was announced
      if (announcedChannel) {
        try {
          const ch = await client.channels.fetch(announcedChannel).catch(() => null);
          if (ch && ch.isTextBased()) {
            const embed = new EmbedBuilder()
              .setColor(0x8a8a9a)
              .setTitle("⏰ Oferta finalizada")
              .setDescription("La oferta ha sido desactivada manualmente. Los precios han vuelto a la normalidad.")
              .setTimestamp(new Date());
            await ch.send({ embeds: [embed] });
          }
        } catch (e) {
          console.error("[webofferoff] Could not send end notice:", e.message);
        }
      }

      // Clear the offer from prices
      pricesPayload.offer = {
        discountPercent: 0,
        durationText: "",
        endsAt: null,
        expiredNotified: true,
        isWebOffer: false,
        announcedChannel: null,
        announcedMessageId: null,
        customMessage: null
      };
      writePrices(pricesPayload);

      const details = deletedMsg
        ? " El mensaje de anuncio ha sido eliminado del canal."
        : announcedChannel
          ? " No se pudo eliminar el mensaje de anuncio (puede que ya no exista)."
          : "";

      await safeReply(interaction, {
        content: `✅ Oferta web desactivada. Los precios en la web ya no muestran descuento.${details}`
      });
      return;
    }

    if (slashCommand === "webprices") {
      const pricesPayload = readPrices();
      const productId = interaction.options.getString("producto", true);
      const plan = interaction.options.getString("plan", true);
      const amount = interaction.options.getNumber("precio", true);
      const name = interaction.options.getString("nombre");
      if (!Number.isFinite(amount) || amount < 0) {
        await safeReply(interaction, { content: "Precio invalido." });
        return;
      }
      pricesPayload.web = normalizeWebPrices(pricesPayload.web);
      pricesPayload.web[productId][plan] = Number(amount.toFixed(2));
      if (name && name.trim()) pricesPayload.web[productId].name = name.trim();
      writePrices(pricesPayload);
      const p = pricesPayload.web[productId];
      await safeReply(interaction, {
        content: `Web actualizada: **${p.name}** · ${plan} = **${p[plan]}€**`
      });
      return;
    }

    if (slashCommand === "compraseveryone") {
      const purchases = readPurchases();
      const entries = Object.entries(purchases.users || {});
      if (!entries.length) {
        await safeReply(interaction, { content: "No purchases recorded yet." });
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
      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    if (slashCommand === "s") {
      if (!SUGGESTION_CHANNEL_IDS.has(interaction.channelId)) {
        await safeReply(interaction, { content: "This command only works in suggestion channels." });
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
      await safeReply(interaction, { content: "Suggestion posted." });
      return;
    }

    if (slashCommand === "keygen") {
      const db = readDb();
      const days = interaction.options.getInteger("dias", true);
      const plan = normalizePlan(interaction.options.getString("plan", true));
      if (!plan) {
        await safeReply(interaction, { content: "Plan invalido. Usa: falcao, temp o both." });
        return;
      }
      let key = generateKey();
      while (getKeyRecord(db, key)) key = generateKey();
      const record = {
        key,
        plan,
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
            `Plan: ${record.plan}`,
            `Status: ${record.status}`,
            `Duration: ${record.durationDays} days`,
            `Created: ${record.createdAt}`,
            `Expires: ${record.expiresAt}`,
            "HWID: -",
            "IP: -"
          ].join("\n")
        )
        .setTimestamp(new Date());
      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    if (slashCommand === "keylist") {
      const db = readDb();
      if (!db.keys.length) {
        await safeReply(interaction, { content: "No keys found." });
        return;
      }
      const sorted = [...db.keys].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const blocks = sorted.slice(0, 20).map((k) => {
        const left = daysRemaining(k.expiresAt);
        const remainLine = left === null ? "TIME LEFT: -" : `TIME LEFT: ${left} DAY${left === 1 ? "" : "S"}`;
        const keyPlan = normalizePlan(k.plan) || "falcao";
        return [
          `${statusEmoji(k.status)} **${k.key}**`,
          `Plan: ${keyPlan}`,
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
      const rowsWithCopyButtons = sorted.slice(0, 5).map((k, idx) =>
        new ActionRowBuilder().addComponents(
          createCopyButton(`#${idx + 1} KEY`, k.key || "-"),
          createCopyButton(`#${idx + 1} HWID`, k.hwid || "-"),
          createCopyButton(`#${idx + 1} IP`, k.ip || "-")
        )
      );
      await safeReply(interaction, { embeds: [embed], components: rowsWithCopyButtons });
      return;
    }

    if (slashCommand === "keycheck") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const found = getKeyRecord(db, key);
      if (!found) {
        await safeReply(interaction, { content: "Key not found." });
        return;
      }
      const embed = new EmbedBuilder()
        .setColor(BRAND_ORANGE)
        .setTitle("FALCAO EXTERNAL • Key Check")
        .setDescription(
          [
            `Key: \`${found.key}\``,
            `Plan: ${normalizePlan(found.plan) || "falcao"}`,
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
      await safeReply(interaction, { embeds: [embed] });
      return;
    }

    if (slashCommand === "datadir") {
      const usingEnv = !!(process.env.PERSISTENT_DATA_DIR || process.env.DATA_DIR);
      await safeReply(interaction, {
        content: [
          `Persistent data dir: \`${dataDir}\``,
          `Keys DB: \`${dbPath}\``,
          `Using env override: **${usingEnv ? "YES" : "NO"}**`
        ].join("\n")
      });
      return;
    }

    if (slashCommand === "keybackups") {
      const db = readDb();
      const payload = {
        schema: "falcao-external-keys-backup-v1",
        exportedAt: new Date().toISOString(),
        keys: Array.isArray(db.keys) ? db.keys : []
      };
      const jsonText = JSON.stringify(payload, null, 2);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const fileName = `keys-backup-${stamp}.json`;
      const attachment = new AttachmentBuilder(Buffer.from(jsonText, "utf8"), { name: fileName });
      await safeReply(interaction, {
        content: `Backup generated. Keys: **${payload.keys.length}**`,
        files: [attachment]
      });
      return;
    }

    if (slashCommand === "keyimports") {
      const file = interaction.options.getAttachment("archivo", true);
      if (!file?.url) {
        await safeReply(interaction, { content: "Missing file URL." });
        return;
      }

      const res = await fetch(file.url);
      if (!res.ok) {
        await safeReply(interaction, { content: `Could not download file (HTTP ${res.status}).` });
        return;
      }
      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        await safeReply(interaction, { content: "Invalid JSON file." });
        return;
      }

      const incomingKeys = Array.isArray(parsed?.keys) ? parsed.keys : Array.isArray(parsed?.data?.keys) ? parsed.data.keys : null;
      if (!incomingKeys) {
        await safeReply(interaction, { content: "Backup file shape not recognized (expected { keys: [...] })." });
        return;
      }

      const db = readDb();
      const existing = new Map((db.keys || []).map((k) => [normalizeKey(k.key), k]));
      let imported = 0;
      let skipped = 0;

      for (const rec of incomingKeys) {
        const k = normalizeKey(rec?.key);
        if (!k) {
          skipped += 1;
          continue;
        }
        if (existing.has(k)) {
          skipped += 1;
          continue;
        }
        // Preserve exact fields from backup without altering timestamps.
        db.keys.push({ ...rec, key: k });
        existing.set(k, rec);
        imported += 1;
      }

      writeDb(db);
      await safeReply(interaction, { content: `Import done. Imported: **${imported}** | Skipped: **${skipped}** | Total now: **${db.keys.length}**` });
      return;
    }

    if (slashCommand === "falcaoloader" || slashCommand === "temploader") {
      const loaderType = slashCommand === "falcaoloader" ? "falcao" : "temp";
      const file = interaction.options.getAttachment("archivo", true);
      if (!file?.url) {
        await safeReply(interaction, { content: "Falta el archivo." });
        return;
      }

      try {
        // Download the attachment
        const res = await fetch(file.url);
        if (!res.ok) {
          await safeReply(interaction, { content: `No se pudo descargar el archivo (HTTP ${res.status}).` });
          return;
        }
        const buf = Buffer.from(await res.arrayBuffer());

        // Ensure loaders directory exists
        const loadersDir = path.join(dataDir, "loaders");
        fs.mkdirSync(loadersDir, { recursive: true });

        // Load current meta, delete previous file if any
        const metaPath = path.join(loadersDir, "loaders.json");
        let meta = {};
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch (_) {}
        }
        if (meta[loaderType]) {
          const oldPath = path.join(loadersDir, meta[loaderType]);
          if (fs.existsSync(oldPath)) {
            try { fs.unlinkSync(oldPath); } catch (_) {}
          }
        }

        // Save new file with original name
        const safeFileName = file.name.replace(/[^a-zA-Z0-9._\-]/g, "_");
        const newFilePath = path.join(loadersDir, safeFileName);
        fs.writeFileSync(newFilePath, buf);

        // Update meta
        meta[loaderType] = safeFileName;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

        // Backup loader file to Discord backup channel so it survives restarts
        try {
          const backupChannel = await client.channels.fetch(KEYS_BACKUP_CHANNEL_ID);
          if (backupChannel && backupChannel.isTextBased()) {
            const attachment = new AttachmentBuilder(buf, { name: `loader-${loaderType}-${safeFileName}` });
            await backupChannel.send({
              content: `🔧 Loader backup • plan: **${loaderType}** • \`${safeFileName}\``,
              files: [attachment]
            });
          }
        } catch (_) { /* non-fatal */ }

        const planLabel = loaderType === "falcao" ? "Falcao" : "Temp";
        await safeReply(interaction, {
          content: `✅ Loader **${planLabel}** actualizado: \`${safeFileName}\` (${(buf.length / 1024).toFixed(1)} KB)\nLos usuarios con plan **${planLabel}** y **Both** pueden descargarlo desde /account.`
        });
        await logGeneral(client, `Loader ${planLabel} actualizado`, [
          { name: "Archivo", value: safeFileName, inline: true },
          { name: "Tamaño", value: `${(buf.length / 1024).toFixed(1)} KB`, inline: true },
          { name: "Por", value: `<@${interaction.user.id}>`, inline: true }
        ]);
      } catch (err) {
        console.error(`[loader] Error updating ${loaderType} loader:`, err.message);
        await safeReply(interaction, { content: `Error al actualizar el loader: ${err.message}` });
      }
      return;
    }

    if (slashCommand === "keydel") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const before = db.keys.length;
      db.keys = db.keys.filter((k) => k.key !== key);
      writeDb(db);
      await safeReply(interaction, { content: db.keys.length === before ? "Key not found." : `Deleted key: \`${key}\`` });
      return;
    }

    if (slashCommand === "resethwid") {
      const db = readDb();
      const key = interaction.options.getString("key", true);
      const found = getKeyRecord(db, key);
      if (!found) {
        await safeReply(interaction, { content: "Key not found." });
        return;
      }
      found.hwid = null;
      found.ip = null;
      found.firstLoginAt = null;
      writeDb(db);
      await safeReply(interaction, { content: `HWID/IP reset for \`${key}\`.` });
      return;
    }
    return;
  }

  if (!interaction.isButton()) return;

  // ── HWID Reset approve/reject ──────────────────────────────────────────
  if (interaction.customId.startsWith("hwid_approve_") || interaction.customId.startsWith("hwid_reject_")) {
    if (!hasRequiredRole(interaction.member)) {
      await safeReply(interaction, { content: "You don't have permission to do this.", ephemeral: true });
      return;
    }
    await safeDefer(interaction, true);
    const isApprove = interaction.customId.startsWith("hwid_approve_");
    // custom_id format: hwid_approve_DISCORDID_KEYSTR or hwid_reject_DISCORDID
    const parts = interaction.customId.split("_");
    const discordId = isApprove ? parts[2] : parts[2];
    const keyStr = isApprove ? parts.slice(3).join("_") : null;
    try {
      await fetch(`http://localhost:${API_PORT}/api/hwid/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: isApprove ? "approve" : "reject", discordId, keyStr })
      });
      await interaction.editReply({
        content: isApprove
          ? `✅ HWID reset **approved** for <@${discordId}>. They have been notified via DM.`
          : `❌ HWID reset **rejected** for <@${discordId}>. They have been notified via DM.`
      });
      // Disable buttons on original message
      try {
        await interaction.message.edit({ components: [] });
      } catch (_) {}
    } catch (e) {
      await interaction.editReply({ content: `Error: ${e.message}` });
    }
    return;
  }

  // ── PayPal admin confirm/reject buttons ────────────────────────────────
  if (interaction.customId.startsWith("paypal_confirm:") || interaction.customId.startsWith("paypal_reject:")) {
    if (!hasRequiredRole(interaction.member)) {
      await interaction.reply({ content: "No tienes permisos para esto.", ephemeral: true });
      return;
    }
    const [action, orderId] = interaction.customId.split(":");
    const isConfirm = action === "paypal_confirm";
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/payments/admin/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-secret": process.env.MENU_API_TOKEN || "" },
        body: JSON.stringify({ orderId, action: isConfirm ? "confirm" : "reject" })
      });
      const data = await res.json();
      if (isConfirm && data.ok) {
        await interaction.update({
          content: `✅ **Pago PayPal confirmado.** Key entregada: \`${data.key}\`\nOrder: \`${orderId}\``,
          components: []
        });
      } else if (!isConfirm && data.ok) {
        await interaction.update({
          content: `❌ **Pago PayPal rechazado.** Order: \`${orderId}\``,
          components: []
        });
      } else {
        await interaction.reply({ content: `Error: ${data.message || "Orden no encontrada."}`, ephemeral: true });
      }
    } catch (err) {
      await interaction.reply({ content: `Error interno: ${err.message}`, ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith("copy_")) {
    const token = interaction.customId.replace("copy_", "");
    const payload = copyPayloads.get(token);
    if (!payload || payload.expiresAt < Date.now()) {
      copyPayloads.delete(token);
      await interaction.reply({ content: "This button expired. Run `/keylist` again.", ephemeral: true });
      return;
    }

    await interaction.reply({
      content: `Press the copy icon in this block:\n\`\`\`\n${payload.value}\n\`\`\``,
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
      // Component emojis are strict and can error with some unicode symbols.
      // Keep the UX by embedding the symbol into the label instead.
      const paymentButtons = PAYMENT_METHODS.map((method) => {
        const safeLabel = method.emoji ? `${method.emoji} ${method.label}` : method.label;
        return new ButtonBuilder()
          .setCustomId(`buy_pay_${method.id}`)
          .setLabel(safeLabel.slice(0, 80))
          .setStyle(ButtonStyle.Secondary);
      });
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
