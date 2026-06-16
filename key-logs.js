/**
 * key-logs.js
 * Per-key event log: claim, login, validate, hwid-reset, status-change, etc.
 * Stored as data/key_logs/<KEY_NORM>.json — one file per key, max 500 entries.
 */

const fs   = require("fs");
const path = require("path");

const MAX_ENTRIES = 500;

function getLogsDir(dataDir) {
  return path.join(dataDir, "key_logs");
}

function ensureLogsDir(dataDir) {
  const d = getLogsDir(dataDir);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function logFilePath(dataDir, keyNorm) {
  return path.join(ensureLogsDir(dataDir), `${keyNorm.replace(/[^A-Z0-9\-]/g, "_")}.json`);
}

/**
 * Append a log entry for a key.
 * @param {string} dataDir
 * @param {string} keyNorm  — normalised (uppercase) key string
 * @param {string} event    — e.g. "claimed", "first_login", "login", "hwid_reset", "status_change", "deleted"
 * @param {object} [meta]   — optional extra fields (ip, hwid, discordId, note, …)
 */
function appendKeyLog(dataDir, keyNorm, event, meta = {}) {
  const p = logFilePath(dataDir, keyNorm);
  let entries = [];
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed;
    }
  } catch (_) { /* start fresh */ }

  entries.push({
    ts:    new Date().toISOString(),
    event,
    ...meta
  });

  // Keep only the most recent MAX_ENTRIES
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);

  try {
    fs.writeFileSync(p, JSON.stringify(entries, null, 2), "utf8");
  } catch (_) { /* non-fatal */ }
}

/**
 * Read log entries for a key (newest first).
 * @param {string} dataDir
 * @param {string} keyNorm
 * @returns {Array}
 */
function readKeyLogs(dataDir, keyNorm) {
  const p = logFilePath(dataDir, keyNorm);
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return [...parsed].reverse(); // newest first
    return [];
  } catch (_) {
    return [];
  }
}

/**
 * Mount the logs API routes onto the Express app.
 * Called from mountManageApi with { requireManageAuth, dataDir, normalizeKey }.
 */
function mountKeyLogsApi(app, deps) {
  const { requireManageAuth, dataDir, normalizeKey } = deps;

  // GET /api/manage/keys/:key/logs
  app.get("/api/manage/keys/:key/logs", (req, res) => {
    if (!requireManageAuth(req, res)) return;
    const keyNorm = normalizeKey(req.params.key);
    const logs = readKeyLogs(dataDir, keyNorm);
    res.json({ ok: true, key: keyNorm, logs });
  });
}

module.exports = { appendKeyLog, readKeyLogs, mountKeyLogsApi };
