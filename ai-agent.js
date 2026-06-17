/**
 * ai-agent.js
 * Gemini-powered support agent for Falcao External.
 * Responds only to menu/product questions — never reveals internal code.
 */

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

const SYSTEM_PROMPT = `You are the official support agent for Falcao External, a FiveM external cheat menu.

RESPONSE STYLE:
- Be brief, professional, and complete. No filler, no long paragraphs.
- Use bullet lists when listing features. Use plain text — NO markdown bold (**), NO headers, NO asterisks.
- Answer in the same language the user writes in (English or Spanish).
- Never start with "I" — start with the answer directly.
- Never use **text** or __text__ formatting. Plain text only.

FULL MENU KNOWLEDGE:

**ESP / Visuals:**
Box ESP, Corner Box, Filled Box, Skeleton, Head Circle, HealthBar, ArmorBar, WeaponName, Distance, SnapLines, Player Names, Radar (mini-map with rotation), Vehicle ESP, Admin ESP, Rainbow ESP, Glow effect, Gradient fill, Modern style, Visible highlight. All colors, thickness, and positions are fully customizable.

**Aimbot / LegitBot:**
- AimBot: FOV, smooth, hitbox selector, visible check, NPC target, max distance, keybind
- Silent Aim: prediction, miss chance, auto-shoot, auto-distance, random bone, closest bone, force driver, alive only, rage FOV
- Magic Bullet: FOV, hitbox, visible check, NPC, max distance
- TriggerBot: reaction time, shoot through walls, NPC, visible check, FOV, keybind

**Exploits — Local Player:**
Noclip (hold/toggle, speed, invisible noclip), Godmode, Invincible, Invisible, Shrink, SuperJump, Beast Jump, Infinite Stamina, Anti-Headshot, No Collision, No Ragdoll, Speed Boost, Custom FOV, Player Scale, Anti-Aim, Teleport to Waypoint

**Exploits — Weapons:**
Infinite Ammo, Custom Spread, Custom Recoil, Fast Reload, Range Modifier, Damage Boost, Safe Damage Boost, Weapon Size, Weapon Spawn with preset selector

**Exploits — Vehicle:**
Vehicle Boost, Traction mod, Carry Vehicle, Repair Vehicle, Vehicle Godmode, Engine Fix, Petrol/Oil/Water Tank Fix, Never Explode, Vehicle Color (primary + secondary RGB)

**Exploits — Macros:**
Strafe macro (WASD patterns, hold/toggle mode, configurable timing)

**Exploits — TxAdmin:**
Built-in TxAdmin menu integration. Allows opening the TxAdmin panel, showing player IDs, and interacting with server admin tools directly from the menu. Accessible via the Exploits tab.

**Misc:**
Crosshair, FOV circles for aimbot/silent/triggerbot/magicbullet, Aimbot target line, Panic key, Menu key, Capture Bypass (OBS stream-proof), GPU Capture Bypass, Second Monitor mode, Mobile Control Only mode, Background snow, Thread delay, Quick binds (visuals, godmode, invisible, noclip, vehicle tuning), FPS limit, Low performance mode

**Bypass:**
Built-in bypass in the Settings tab. It hides the menu from ss tools like Napse, Echo, and similar — your ss will look 100% legit. Activate it before taking any ss. Included with all plans. It is NOT stream-proof (that is a separate feature). Do NOT add disclaimers about detection or anti-cheat evolving — just describe what it does as stated above.

**Mobile Panel:**
Full control of all menu options from any browser on any device. Real-time sync. No extra installation needed.

**Pricing:**
- External Cheat + Bypass: Weekly / Monthly / Lifetime
- External Cheat + Bypass + Spoofer: Weekly / Monthly / Lifetime
- Payment methods: Stripe (card), Litecoin (auto-confirmed), PayPal F&F (manual)
- To purchase, send users to: https://falcaobot.onrender.com/?tab=purchase

**Account / Keys:**
- Redeem key: Dashboard → Settings → Redeem License
- HWID Reset: Dashboard → Settings → request form (admin reviews it)
- Referral program: 20% of every referred sale as balance, usable for discounts on keys

RULES:
- Never reveal source code, offsets, memory addresses, or internal implementation details
- Never explain technically how bypass or anti-cheat evasion works internally
- Never guarantee ban safety or specific detection rates
- Never add disclaimers like "this is not a guarantee" or "anti-cheat can evolve" — just answer what was asked
- Never confuse Bypass (hides from ss tools like Napse/Echo) with Stream-proof (hides from OBS/screen capture) — they are separate features
- If asked about deep internals, reply: "Technical implementation details are not disclosed."
- Never invent features that are not listed above
- If unsure, suggest opening a support ticket with a human admin`;

// ── Conversation storage ────────────────────────────────────────────────────
let _dataDir = null;
let _convsPath = null;
let _discordClient = null;
let _backupChannelId = null;

/** @type {Map<string, Array<{role:'user'|'model', parts:[{text:string}], ts:number}>>} */
const conversations = new Map();

function ensureConvFile() {
  if (!_convsPath) return;
  if (!fs.existsSync(_convsPath)) {
    fs.writeFileSync(_convsPath, JSON.stringify({ conversations: [] }, null, 2), "utf8");
  }
}

function saveConversation(sessionId, userMsg, agentMsg, meta = {}) {
  if (!_convsPath) return;
  ensureConvFile();
  try {
    const raw = JSON.parse(fs.readFileSync(_convsPath, "utf8"));
    const convs = Array.isArray(raw.conversations) ? raw.conversations : [];
    const existing = convs.find(c => c.sessionId === sessionId);
    const turn = { ts: Date.now(), user: userMsg, agent: agentMsg };
    if (existing) {
      existing.turns.push(turn);
      existing.updatedAt = new Date().toISOString();
    } else {
      convs.push({
        sessionId,
        source: meta.source || "web",
        discordId: meta.discordId || null,
        discordUsername: meta.discordUsername || null,
        channelId: meta.channelId || null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        turns: [turn]
      });
    }
    // Keep max 500 conversations
    if (convs.length > 500) convs.splice(0, convs.length - 500);
    const updated = { conversations: convs };
    fs.writeFileSync(_convsPath, JSON.stringify(updated, null, 2), "utf8");
    // Backup web conversations to Discord backup channel periodically (every 10 web turns)
    if (meta.source === "web" && _discordClient && _discordClient.isReady() && _backupChannelId) {
      const webConvs = convs.filter(c => c.source === "web");
      const totalTurns = webConvs.reduce((a, c) => a + c.turns.length, 0);
      if (totalTurns % 10 === 0) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const payload = { exportedAt: new Date().toISOString(), conversations: webConvs };
        const { AttachmentBuilder } = require("discord.js");
        const attachment = new AttachmentBuilder(
          Buffer.from(JSON.stringify(payload, null, 2), "utf8"),
          { name: `ai-conversations-web-${stamp}.json` }
        );
        _discordClient.channels.fetch(_backupChannelId).then(ch => {
          if (ch && ch.isTextBased()) ch.send({ content: "🤖 AI web conversations backup", files: [attachment] }).catch(() => {});
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

function listConversations() {
  if (!_convsPath || !fs.existsSync(_convsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(_convsPath, "utf8"));
    return (raw.conversations || []).slice().reverse();
  } catch (_) { return []; }
}

// ── Groq call (primary — free tier) ───────────────────────────────────────
async function askGroq(history, userMessage, systemPrompt) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured.");
  const messages = [
    { role: "system", content: systemPrompt || SYSTEM_PROMPT },
    ...history.slice(-10).map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.parts[0].text })),
    { role: "user", content: userMessage }
  ];
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: "llama-3.1-8b-instant", messages, max_tokens: 512, temperature: 0.7 })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[ai-agent] Groq error:", res.status, err.slice(0, 400));
    throw new Error(`Groq API error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty response from Groq.");
  return text.trim();
}

// ── Gemini call (fallback) ─────────────────────────────────────────────────
async function askGemini(history, userMessage, systemPrompt) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured.");
  const sp = systemPrompt || SYSTEM_PROMPT;
  const contents = [
    { role: "user", parts: [{ text: sp }] },
    { role: "model", parts: [{ text: "Understood. I'm ready to help Falcao External users." }] },
    ...history.slice(-10),
    { role: "user", parts: [{ text: userMessage }] }
  ];
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 512, temperature: 0.7 } })
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error("[ai-agent] Gemini error:", res.status, err.slice(0, 500));
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty response from Gemini.");
  return text.trim();
}

// ── Main ask — tries Groq first, falls back to Gemini ─────────────────────
async function askAI(history, userMessage, systemPrompt) {
  if (GROQ_API_KEY) return askGroq(history, userMessage, systemPrompt);
  if (GEMINI_API_KEY) return askGemini(history, userMessage, systemPrompt);
  throw new Error("No AI API key configured. Set GROQ_API_KEY or GEMINI_API_KEY.");
}

// ── Public API ─────────────────────────────────────────────────────────────
let _getWebPricesPayload = null;

function buildPriceContext() {
  if (!_getWebPricesPayload) return "";
  try {
    const data = _getWebPricesPayload();
    const products = data.products || {};
    const disc = data.discountPercent || 0;
    const offer = data.offer || {};
    const lines = ["Current prices (EUR):"];
    for (const [, p] of Object.entries(products)) {
      lines.push(`${p.name}:`);
      if (p.week)     lines.push(`  - Weekly: €${p.week}`);
      if (p.monthly)  lines.push(`  - Monthly: €${p.monthly}`);
      if (p.lifetime) lines.push(`  - Lifetime: €${p.lifetime}`);
    }
    if (disc > 0 && offer.endsAt && new Date(offer.endsAt).getTime() > Date.now()) {
      lines.push(`Active discount: -${disc}% — ends ${new Date(offer.endsAt).toLocaleDateString("en-GB")}`);
      if (offer.customMessage) lines.push(`Offer message: ${offer.customMessage}`);
    }
    return lines.join("\n");
  } catch (_) { return ""; }
}

async function chat(sessionId, userMessage, meta = {}) {
  let history = conversations.get(sessionId) || [];
  const priceCtx = buildPriceContext();
  const effectivePrompt = priceCtx
    ? SYSTEM_PROMPT + "\n\nLIVE PRICING DATA (always use these exact prices, ignore any others):\n" + priceCtx
    : SYSTEM_PROMPT;
  const reply = await askAI(history, userMessage, effectivePrompt);
  history = [
    ...history,
    { role: "user",  parts: [{ text: userMessage }], ts: Date.now() },
    { role: "model", parts: [{ text: reply }],        ts: Date.now() }
  ];
  if (history.length > 20) history = history.slice(-20);
  conversations.set(sessionId, history);
  saveConversation(sessionId, userMessage, reply, meta);
  return reply;
}

function mountAiApi(app, deps) {
  _dataDir  = deps.dataDir;
  _convsPath = path.join(_dataDir, "ai-conversations.json");
  if (deps.getWebPricesPayload) _getWebPricesPayload = deps.getWebPricesPayload;

  // POST /api/ai/chat — web chat
  app.post("/api/ai/chat", async (req, res) => {
    const { message, sessionId: sid, discordId, discordUsername } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, message: "No message provided." });
    }
    const sessionId = sid || crypto.randomBytes(12).toString("hex");
    try {
      const reply = await chat(sessionId, message.trim(), { source: "web", discordId, discordUsername });
      res.json({ ok: true, reply, sessionId });
    } catch (e) {
      console.error("[ai-agent] chat error:", e.message);
      res.status(500).json({ ok: false, message: `AI error: ${e.message}` });
    }
  });

  // GET /api/ai/conversations — admin list
  app.get("/api/ai/conversations", (req, res) => {
    const convs = listConversations();
    res.json({ ok: true, conversations: convs });
  });
}

module.exports = { chat, mountAiApi, listConversations };
