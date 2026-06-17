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

const SYSTEM_PROMPT = `You are the official support agent for "Falcao External", a FiveM external cheat menu.

Your job is to answer questions from users about the product. You must follow these rules strictly:

WHAT YOU CAN ANSWER:
- Features of the menu: ESP (Box, Skeleton, Radar, HealthBar, ArmorBar, WeaponName, Distance, SnapLines), Aimbot, Silent Aim, Magic Bullet, TriggerBot, Noclip, Godmode, Invisible, SuperJump, InfiniteStamina, SpeedBoost, TeleportToWaypoint, Vehicle exploits, Stream-proof (OBS bypass), Mobile panel (control via browser from phone)
- Pricing and plans: Weekly, Monthly, Lifetime. Two products: "External Cheat + Bypass" and "External Cheat + Bypass + Spoofer"
- How to purchase: via Stripe (card), Litecoin, or PayPal F&F
- How to redeem a key: go to Dashboard > Settings > Redeem License
- How to use the mobile panel: open the web on any browser after logging in
- HWID reset: users must submit a request via Dashboard > Settings > HWID Reset, an admin reviews it
- Referral program: earn 20% of every sale made through your referral link, balance used for discounts on keys
- General usage questions about the menu features
- Troubleshooting common issues (game not detected, overlay not showing, etc.)

WHAT YOU MUST NEVER DO:
- Never reveal any source code, offsets, memory addresses, or internal implementation details
- Never explain how the cheat bypasses anti-cheat systems technically
- Never confirm or deny specific detection methods
- Never give information about DMA, kernel drivers, or internal architecture
- If asked about internals, say: "I can't share technical implementation details."
- Never make up features that don't exist
- Never promise things about ban safety

TONE: Friendly, helpful, concise. If you cannot answer something, say so and suggest opening a support ticket with a human admin.

Respond in the same language the user writes in (English or Spanish).`;

// ── Conversation storage ────────────────────────────────────────────────────
let _dataDir = null;
let _convsPath = null;

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
    fs.writeFileSync(_convsPath, JSON.stringify({ conversations: convs }, null, 2), "utf8");
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
async function askGroq(history, userMessage) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not configured.");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
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
async function askGemini(history, userMessage) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured.");
  const contents = [
    { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
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
async function askAI(history, userMessage) {
  if (GROQ_API_KEY) return askGroq(history, userMessage);
  if (GEMINI_API_KEY) return askGemini(history, userMessage);
  throw new Error("No AI API key configured. Set GROQ_API_KEY or GEMINI_API_KEY.");
}

// ── Public API ─────────────────────────────────────────────────────────────
async function chat(sessionId, userMessage, meta = {}) {
  let history = conversations.get(sessionId) || [];
  const reply = await askAI(history, userMessage);
  history = [
    ...history,
    { role: "user",  parts: [{ text: userMessage }], ts: Date.now() },
    { role: "model", parts: [{ text: reply }],        ts: Date.now() }
  ];
  // Keep max 20 turns in memory
  if (history.length > 20) history = history.slice(-20);
  conversations.set(sessionId, history);
  saveConversation(sessionId, userMessage, reply, meta);
  return reply;
}

function mountAiApi(app, deps) {
  _dataDir  = deps.dataDir;
  _convsPath = path.join(_dataDir, "ai-conversations.json");

  // POST /api/ai/chat — web chat
  app.post("/api/ai/chat", async (req, res) => {
    const { message, sessionId: sid, discordId, discordUsername } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ ok: false, message: "No message provided." });
    }
    const sessionId = sid || crypto.randomBytes(12).toString("hex");
    try {
      const reply = await chat(sessionId, message.trim(), {
        source: "web", discordId, discordUsername
      });
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
