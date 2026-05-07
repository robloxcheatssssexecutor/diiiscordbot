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
  ButtonStyle
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const PREFIX = process.env.PREFIX || "!";
const API_PORT = Number(process.env.PORT || process.env.API_PORT || 3000);
const MENU_API_TOKEN = process.env.MENU_API_TOKEN || "";
const REQUIRED_ROLE_ID = "1502014441623916544";
const LOG_CHANNEL_GENERAL_ID = "1502007488533233744";
const LOG_CHANNEL_KEYGEN_ID = "1502007948497391708";
const LOG_CHANNEL_RESETHWID_ID = "1502007476076282056";
const LOG_CHANNEL_TRANSCRIPTS_ID = "1502007473157177507";
const TICKET_CATEGORY_BUY = "Buy Tickets";
const TICKET_CATEGORY_SUPPORT = "Support Tickets";
const TICKET_CATEGORY_HWID_RESET = "HWID Reset Tickets";
const TICKET_CATEGORY_BUG = "Bug Tickets";

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

function baseLogEmbed(title, color = 0x4a90e2) {
  return new EmbedBuilder().setColor(color).setTitle(title).setTimestamp(new Date());
}

async function logGeneral(clientInstance, title, fields = []) {
  const embed = baseLogEmbed(title, 0x4a90e2).addFields(fields);
  await sendLogEmbed(clientInstance, LOG_CHANNEL_GENERAL_ID, embed);
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
    label: "Soporte",
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
        "",
        "**Comandos para todos:**",
        "`!falcaohelp` -> Muestra esta ayuda.",
        "",
        "**Comandos de admin (rol requerido):**",
        "`!ticketpanel` -> Publica el panel profesional de tickets.",
        "`!keygen <duracion_en_dias>` -> Genera 1 key con formato FALCAO-EXTERNAL-XXXXX-XXXXX.",
        "`!keylist` -> Tabla con todas las keys y datos (estado, HWID, IP, fechas).",
        "`!keycheck <key>` -> Muestra todos los datos de una key.",
        "`!keydel <key>` -> Elimina una key del sistema.",
        "`!resethwid <key>` -> Resetea HWID/IP y first login para permitir nuevo registro.",
        "",
        `Rol requerido para admin: <@&${REQUIRED_ROLE_ID}>`,
        "El primer login se registra automaticamente desde el menu via API."
      ].join("\n")
    );
    await logGeneral(client, "Uso de !falcaohelp", [
      { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
      { name: "Canal", value: `<#${message.channel.id}>`, inline: true }
    ]);
    return;
  }

  if (commandRequiresRole(command) && !hasRequiredRole(message.member)) {
    await message.reply(`No autorizado. Necesitas el rol <@&${REQUIRED_ROLE_ID}>.`);
    await logGeneral(client, "Intento no autorizado de comando", [
      { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
      { name: "Comando", value: `\`${PREFIX}${command}\``, inline: true },
      { name: "Canal", value: `<#${message.channel.id}>`, inline: true }
    ]);
    return;
  }

  await logGeneral(client, "Comando ejecutado", [
    { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
    { name: "Comando", value: `\`${PREFIX}${command}\``, inline: true },
    { name: "Canal", value: `<#${message.channel.id}>`, inline: true }
  ]);

  const db = readDb();

  if (command === "ticketpanel") {
    const panelEmbed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle("Falcão External • Ticket Center")
      .setDescription(
        [
          "Selecciona una opción para abrir tu ticket.",
          "Cada tipo se organiza en su propia categoría para mantener todo ordenado."
        ].join("\n")
      )
      .addFields(
        { name: "🛒 Buy", value: "Compras, planes y métodos de pago.", inline: true },
        { name: "🛠️ Soporte", value: "Ayuda técnica general.", inline: true },
        { name: "🔁 HWID Reset", value: "Solicitudes de reset de HWID.", inline: true },
        { name: "🐞 Bug", value: "Reporte de errores del producto.", inline: true }
      )
      .setFooter({ text: "Falcão External Support System" })
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_open_buy").setLabel("Buy").setEmoji("🛒").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ticket_open_support").setLabel("Soporte").setEmoji("🛠️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_open_hwid").setLabel("HWID Reset").setEmoji("🔁").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket_open_bug").setLabel("Bug").setEmoji("🐞").setStyle(ButtonStyle.Danger)
    );

    await message.channel.send({ embeds: [panelEmbed], components: [row] });
    await message.reply("Panel de tickets enviado.");
    await logGeneral(client, "Panel de tickets publicado", [
      { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
      { name: "Canal", value: `<#${message.channel.id}>`, inline: true }
    ]);
    return;
  }

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
    await sendLogEmbed(
      client,
      LOG_CHANNEL_KEYGEN_ID,
      baseLogEmbed("Uso de !keygen", 0x57f287).addFields([
        { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
        { name: "Duración", value: `${days} días`, inline: true },
        { name: "Key", value: `\`${record.key}\``, inline: false }
      ])
    );
    return;
  }

  if (command === "keylist") {
    if (db.keys.length === 0) {
      await message.reply("No hay keys guardadas.");
      return;
    }
    const sorted = [...db.keys].sort((a, b) => {
      const ta = new Date(a.createdAt || 0).getTime();
      const tb = new Date(b.createdAt || 0).getTime();
      return tb - ta;
    });

    const blocks = sorted.map((k) => {
      const left = daysRemaining(k.expiresAt);
      const remainLine =
        left === null
          ? "TIEMPO RESTANTE: -"
          : `TIEMPO RESTANTE: ${left} DIA${left === 1 ? "" : "S"}`;

      return [
        `${statusEmoji(k.status)} **${k.key}**`,
        `Estado: ${k.status || "-"}`,
        `Duración: ${k.durationDays ?? "-"} días`,
        `${remainLine}`,
        `HWID: \`${truncateCell(k.hwid || "-", 70)}\``,
        `IP: \`${truncateCell(k.ip || "-", 45)}\``,
        `Creada: ${formatDate(k.createdAt)}`,
        `Expira: ${formatDate(k.expiresAt)}`,
        `First login: ${formatDate(k.firstLoginAt)}`
      ].join("\n");
    });

    const separator = "\n------------------------------\n";
    let description = blocks.join(separator);
    if (description.length > 3900) {
      description = `${description.slice(0, 3850)}\n\n... (lista recortada por límite de Discord)`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xff8a33)
      .setTitle("Falcão External • Keylist")
      .setDescription(`Mostrando 1-${db.keys.length} de ${db.keys.length} keys\n\n${description}`)
      .setFooter({ text: `Total: ${db.keys.length} keys` })
      .setTimestamp(new Date());

    let components = [];
    if (sorted.length > 0) {
      const first = sorted[0];
      const row = new ActionRowBuilder().addComponents(
        createCopyButton("Copy Key", first.key),
        createCopyButton("Copy HWID", first.hwid || "-"),
        createCopyButton("Copy IP", first.ip || "-")
      );
      components = [row];
    }

    await message.reply({ embeds: [embed], components });
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
    await sendLogEmbed(
      client,
      LOG_CHANNEL_RESETHWID_ID,
      baseLogEmbed("Uso de !resethwid", 0xfee75c).addFields([
        { name: "Usuario", value: `${message.author.tag} (${message.author.id})`, inline: false },
        { name: "Key", value: `\`${key}\``, inline: false },
        { name: "Canal", value: `<#${message.channel.id}>`, inline: true }
      ])
    );
    return;
  }

  await message.reply("Comando invalido. Usa `!falcaohelp`.");
});

app.listen(API_PORT, () => {
  console.log(`HTTP API online on port ${API_PORT}`);
});

client.login(TOKEN);

client.on("interactionCreate", async (interaction) => {
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

  if (interaction.customId in TICKET_TYPES) {
    const member = interaction.member;
    if (!hasRequiredRole(member)) {
      await interaction.reply({
        content: `No autorizado. Necesitas el rol <@&${REQUIRED_ROLE_ID}> para abrir tickets.`,
        ephemeral: true
      });
      await logGeneral(client, "Intento no autorizado de ticket", [
        { name: "Usuario", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
        { name: "Tipo", value: `\`${interaction.customId}\``, inline: true }
      ]);
      return;
    }

    const typeData = TICKET_TYPES[interaction.customId];
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: "Este botón solo funciona dentro de un servidor.", ephemeral: true });
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
      await interaction.reply({ content: `Ya tienes un ticket abierto: <#${existing.id}>`, ephemeral: true });
      return;
    }

    const category = await ensureTicketCategory(guild, typeData.category);
    const ticketName = `${typeData.channelPrefix}-${normalizedUser}`;
    const ticketChannel = await guild.channels.create({
      name: ticketName,
      type: 0,
      parent: category.id,
      topic: `Ticket ${typeData.label} | user:${interaction.user.id}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
        { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "AttachFiles"] },
        { id: REQUIRED_ROLE_ID, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageMessages"] },
        { id: client.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageChannels", "ManageMessages"] }
      ]
    });

    const closeRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket_close")
        .setLabel("Cerrar ticket")
        .setEmoji("🔒")
        .setStyle(ButtonStyle.Danger)
    );

    const ticketEmbed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`${typeData.emoji} Ticket • ${typeData.label}`)
      .setDescription(
        [
          `${interaction.user}, tu ticket fue creado correctamente.`,
          "Explica tu solicitud con detalles para que el staff pueda ayudarte rápidamente.",
          "",
          "Cuando termine, pulsa **Cerrar ticket** para generar transcript automático."
        ].join("\n")
      )
      .setFooter({ text: `Ticket owner: ${interaction.user.id}` })
      .setTimestamp(new Date());

    await ticketChannel.send({ embeds: [ticketEmbed], components: [closeRow] });
    await interaction.reply({ content: `Ticket creado: <#${ticketChannel.id}>`, ephemeral: true });

    await logGeneral(client, "Ticket abierto", [
      { name: "Usuario", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
      { name: "Tipo", value: typeData.label, inline: true },
      { name: "Canal", value: `<#${ticketChannel.id}>`, inline: true }
    ]);
    return;
  }

  if (interaction.customId === "ticket_close") {
    if (!interaction.channel || !interaction.guild) {
      await interaction.reply({ content: "No se puede cerrar este ticket aquí.", ephemeral: true });
      return;
    }

    const canClose = hasRequiredRole(interaction.member) || interaction.channel.topic?.includes(`user:${interaction.user.id}`);
    if (!canClose) {
      await interaction.reply({ content: "No tienes permisos para cerrar este ticket.", ephemeral: true });
      return;
    }

    await interaction.reply({ content: "Cerrando ticket y generando transcript...", ephemeral: true });

    const transcript = await buildTicketTranscript(interaction.channel);
    const transcriptBuffer = Buffer.from(transcript || "No hay mensajes para transcribir.", "utf8");
    const ticketName = interaction.channel.name;
    const ownerMatch = /user:(\d+)/.exec(interaction.channel.topic || "");
    const ownerId = ownerMatch ? ownerMatch[1] : "unknown";

    const transcriptEmbed = baseLogEmbed("Transcript de ticket", 0xed4245).addFields([
      { name: "Ticket", value: ticketName, inline: true },
      { name: "Cerrado por", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
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

    await logGeneral(client, "Ticket cerrado", [
      { name: "Ticket", value: ticketName, inline: true },
      { name: "Cerrado por", value: `${interaction.user.tag} (${interaction.user.id})`, inline: false }
    ]);

    await interaction.channel.delete("Ticket closed by button action.");
  }
});
