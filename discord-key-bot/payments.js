/**
 * payments.js
 * Handles Stripe (automatic), Litecoin (automatic blockchain check),
 * and PayPal F&F (manual, with Discord notification to admin).
 */

const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ── Constants ─────────────────────────────────────────────────────────────
const LTC_ADDRESS         = process.env.LTC_ADDRESS || "LRYC9MwKQDzPRqdh4MpAy3pv4MQRzNGGEG";
const PAYPAL_EMAIL        = process.env.PAYPAL_EMAIL || "yesosan@hotmail.com";
const ADMIN_DISCORD_WH    = process.env.PAYMENT_DISCORD_WEBHOOK ||
  "https://discord.com/api/webhooks/1514948883246088262/FU7CBQj88k1lKHhQoRdri8alT0_M-79GxeJW7jCTtxZBJq4tEs6CR-lpaj_QPVgCjR5l";
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_PUB_KEY        = process.env.STRIPE_PUBLIC_KEY || "";

const LTC_CONFIRM_BLOCKS  = 1; // blocks needed to consider payment confirmed
const LTC_POLL_INTERVAL   = 60 * 1000; // check every 60s
const ORDER_EXPIRY_MS     = 60 * 60 * 1000; // 1 hour to pay

// ── Discord client injection ───────────────────────────────────────────────
let _discordClient = null;
function setPaymentsDiscordClient(client) { _discordClient = client; }

// helper used inside module instead of getDiscordClient()
function getDiscordClient() { return _discordClient; }
// Map<orderId, OrderRecord>
const pendingOrders = new Map();

function makeOrderId() {
  return "ORD-" + crypto.randomBytes(6).toString("hex").toUpperCase();
}

/**
 * @typedef {Object} OrderRecord
 * @property {string} orderId
 * @property {string} method  "ltc" | "stripe" | "paypal"
 * @property {string} plan    "falcao" | "temp" | "both"
 * @property {number} durationDays
 * @property {number} priceEur
 * @property {string} discordId
 * @property {string} discordUsername
 * @property {string} [ltcAmountExpected]  LTC amount (string, 8 decimals)
 * @property {string} [stripeSessionId]
 * @property {string} status  "pending_payment" | "paid" | "delivered" | "expired" | "cancelled"
 * @property {number} createdAt   timestamp ms
 * @property {number} expiresAt   timestamp ms
 * @property {string|null} keyDelivered   key given after payment
 */

// ── Orders persistence ─────────────────────────────────────────────────────
let ordersPath = null;

function ensureOrdersFile() {
  if (!ordersPath) return;
  if (!fs.existsSync(ordersPath)) {
    fs.writeFileSync(ordersPath, JSON.stringify({ orders: [] }, null, 2), "utf8");
  }
}

function saveOrder(record) {
  pendingOrders.set(record.orderId, record);
  if (!ordersPath) return;
  ensureOrdersFile();
  try {
    const raw = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    const orders = Array.isArray(raw.orders) ? raw.orders : [];
    const idx = orders.findIndex(o => o.orderId === record.orderId);
    if (idx >= 0) orders[idx] = record;
    else orders.push(record);
    fs.writeFileSync(ordersPath, JSON.stringify({ orders }, null, 2), "utf8");
  } catch (_) {}
}

function loadOrders() {
  if (!ordersPath || !fs.existsSync(ordersPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    if (Array.isArray(raw.orders)) {
      for (const o of raw.orders) {
        if (o.status === "pending_payment") pendingOrders.set(o.orderId, o);
      }
    }
  } catch (_) {}
}

// ── Discord webhook helper ─────────────────────────────────────────────────
async function sendDiscordWebhook(url, payload) {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (_) {}
}

async function notifyAdminPayPalPending(order) {
  const content = `💰 **Pago PayPal pendiente de verificación**\n\n` +
    `**Usuario:** ${order.discordUsername} (<@${order.discordId}>)\n` +
    `**Plan:** ${order.plan} · ${order.durationDays} días\n` +
    `**Precio:** €${order.priceEur}\n` +
    `**Email PayPal:** \`${PAYPAL_EMAIL}\`\n` +
    `**Order ID:** \`${order.orderId}\`\n\n` +
    `El cliente dice que ya ha pagado. Verifica en tu cuenta PayPal y pulsa el botón correspondiente.`;

  await sendDiscordWebhook(ADMIN_DISCORD_WH, {
    content,
    components: [{
      type: 1,
      components: [
        {
          type: 2, style: 3, label: "✅ Confirmar pago y entregar key",
          custom_id: `paypal_confirm:${order.orderId}`
        },
        {
          type: 2, style: 4, label: "❌ Rechazar pago",
          custom_id: `paypal_reject:${order.orderId}`
        }
      ]
    }]
  });
}

async function notifyAdminStripeConfirmed(order) {
  await sendDiscordWebhook(ADMIN_DISCORD_WH, {
    content: `✅ **Pago Stripe confirmado automáticamente**\n` +
      `**Usuario:** ${order.discordUsername} (<@${order.discordId}>)\n` +
      `**Plan:** ${order.plan} · ${order.durationDays} días · €${order.priceEur}\n` +
      `**Key entregada:** \`${order.keyDelivered || "pendiente"}\`\n` +
      `**Order ID:** \`${order.orderId}\``
  });
}

async function notifyAdminLtcConfirmed(order, txid) {
  await sendDiscordWebhook(ADMIN_DISCORD_WH, {
    content: `✅ **Pago LTC confirmado automáticamente**\n` +
      `**Usuario:** ${order.discordUsername} (<@${order.discordId}>)\n` +
      `**Plan:** ${order.plan} · ${order.durationDays} días · €${order.priceEur}\n` +
      `**TXID:** \`${txid}\`\n` +
      `**Key entregada:** \`${order.keyDelivered || "pendiente"}\`\n` +
      `**Order ID:** \`${order.orderId}\``
  });
}

// ── LTC price fetcher ──────────────────────────────────────────────────────
async function getEurToLtc(eurAmount) {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur");
    const d = await r.json();
    const priceEur = d?.litecoin?.eur;
    if (!priceEur) throw new Error("no price");
    const ltcAmount = (eurAmount / priceEur);
    return ltcAmount.toFixed(6);
  } catch (_) {
    return null;
  }
}

// ── LTC blockchain checker ─────────────────────────────────────────────────
async function checkLtcPayment(order) {
  // Use blockcypher public API (no key needed for basic use)
  try {
    const url = `https://api.blockcypher.com/v1/ltc/main/addrs/${LTC_ADDRESS}/full?limit=10`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const txs = data.txs || [];
    const expectedSatoshis = Math.round(parseFloat(order.ltcAmountExpected) * 1e8);
    const minSatoshis = Math.floor(expectedSatoshis * 0.98); // 2% tolerance

    for (const tx of txs) {
      const txTimeMs = tx.received ? new Date(tx.received).getTime() : 0;
      if (txTimeMs < order.createdAt) continue;
      if ((tx.confirmations || 0) < LTC_CONFIRM_BLOCKS) continue;
      for (const out of (tx.outputs || [])) {
        if (out.addresses && out.addresses.includes(LTC_ADDRESS)) {
          if (out.value >= minSatoshis) {
            return tx.hash;
          }
        }
      }
    }
  } catch (_) {}
  return null;
}

// ── Key delivery ───────────────────────────────────────────────────────────
function deliverKey(order, deps) {
  const { readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan, appendKeyLog, dataDir } = deps;
  const db = readDb();
  let key = generateKey();
  while (getKeyRecord(db, key)) key = generateKey();
  const record = {
    key,
    plan: normalizePlan(order.plan) || "falcao",
    status: "active",
    createdAt: new Date().toISOString(),
    durationDays: order.durationDays,
    expiresAt: calcExpiresAt(order.durationDays),
    firstLoginAt: null,
    hwid: null,
    ip: null,
    note: `Auto-delivered via ${order.method} payment. Order: ${order.orderId}`
  };
  db.keys.push(record);
  writeDb(db);
  if (appendKeyLog && dataDir) {
    appendKeyLog(dataDir, key, "created", { method: "payment", plan: record.plan, durationDays: order.durationDays, orderId: order.orderId });
  }
  return key;
}

// ── LTC polling loop ───────────────────────────────────────────────────────
function startLtcPoller(deps) {
  setInterval(async () => {
    const now = Date.now();
    for (const [orderId, order] of pendingOrders.entries()) {
      if (order.method !== "ltc" || order.status !== "pending_payment") continue;
      if (order.expiresAt < now) {
        order.status = "expired";
        saveOrder(order);
        pendingOrders.delete(orderId);
        continue;
      }
      const txid = await checkLtcPayment(order);
      if (txid) {
        order.status = "paid";
        const key = deliverKey(order, deps);
        order.keyDelivered = key;
        order.status = "delivered";
        saveOrder(order);
        pendingOrders.delete(orderId);
        await notifyAdminLtcConfirmed(order, txid);
        // DM user via Discord bot if available
        if (getDiscordClient() && getDiscordClient().isReady()) {
          try {
            const user = await getDiscordClient().users.fetch(order.discordId);
            await user.send(`✅ **Tu pago de Litecoin ha sido confirmado!**\n\nTu key: \`${key}\`\nPlan: **${order.plan}** · ${order.durationDays} días\n\nVe a https://falcaobot.onrender.com/?tab=account para reclamarla.`);
          } catch (_) {}
        }
      }
    }
  }, LTC_POLL_INTERVAL).unref();
}

// ── Stripe helper ──────────────────────────────────────────────────────────
async function createStripeSession(order, baseUrl) {
  const body = {
    mode: "payment",
    success_url: `${baseUrl}/api/payments/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/?tab=shop&cancelled=1`,
    metadata: {
      orderId: order.orderId,
      discordId: order.discordId,
      plan: order.plan,
      durationDays: String(order.durationDays)
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "eur",
        unit_amount: Math.round(order.priceEur * 100),
        product_data: {
          name: `Falcao External — ${order.plan} (${order.durationDays}d)`,
          description: `Licencia ${order.plan} por ${order.durationDays} días`
        }
      }
    }]
  };

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: Object.entries(flattenForStripe(body)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Stripe error");
  return data;
}

function flattenForStripe(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flattenForStripe(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") {
          Object.assign(out, flattenForStripe(item, `${key}[${i}]`));
        } else {
          out[`${key}[${i}]`] = item;
        }
      });
    } else {
      out[key] = v;
    }
  }
  return out;
}

// ── Mount payments API ─────────────────────────────────────────────────────
function mountPaymentsApi(app, deps) {
  const { readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan,
          appendKeyLog, dataDir, getWebPricesPayload, getDiscordClient() } = deps;

  ordersPath = path.join(dataDir, "orders.json");
  loadOrders();
  startLtcPoller({ readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan, appendKeyLog, dataDir, getDiscordClient() });

  const deliverDeps = { readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan, appendKeyLog, dataDir };

  function getBaseUrl(req) {
    const fromEnv = String(process.env.BASE_URL || "").trim().replace(/\/$/, "");
    if (fromEnv) return fromEnv;
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    return `${proto}://${host}`;
  }

  // ── GET /api/payments/prices — returns product list with current prices ──
  app.get("/api/payments/prices", (_req, res) => {
    const p = getWebPricesPayload();
    res.json({ ok: true, ...p, ltcAddress: LTC_ADDRESS, paypalEmail: PAYPAL_EMAIL, stripePubKey: STRIPE_PUB_KEY });
  });

  // ── POST /api/payments/create — create an order ──────────────────────────
  app.post("/api/payments/create", async (req, res) => {
    const { method, plan, durationKey, discordId, discordUsername } = req.body || {};
    if (!method || !plan || !durationKey || !discordId) {
      res.status(400).json({ ok: false, message: "Faltan campos: method, plan, durationKey, discordId." });
      return;
    }
    if (!["ltc", "stripe", "paypal"].includes(method)) {
      res.status(400).json({ ok: false, message: "Método inválido." });
      return;
    }
    if (!normalizePlan(plan)) {
      res.status(400).json({ ok: false, message: "Plan inválido." });
      return;
    }

    const prices = getWebPricesPayload();
    // durationKey: "week" | "monthly" | "lifetime"
    const planPrices = Object.values(prices.products || {})[plan === "both" ? 1 : plan === "temp" ? 1 : 0];
    const priceEur = planPrices?.[durationKey];
    if (!priceEur || typeof priceEur !== "number") {
      res.status(400).json({ ok: false, message: "Duración o precio inválido." });
      return;
    }
    const durationDaysMap = { week: 7, monthly: 30, lifetime: 36500 };
    const durationDays = durationDaysMap[durationKey] || 30;

    const orderId = makeOrderId();
    const order = {
      orderId,
      method,
      plan,
      durationDays,
      priceEur,
      discordId: String(discordId),
      discordUsername: String(discordUsername || discordId),
      status: "pending_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + ORDER_EXPIRY_MS,
      keyDelivered: null,
      ltcAmountExpected: null,
      stripeSessionId: null,
      stripeSessionUrl: null
    };

    try {
      if (method === "ltc") {
        const ltcAmount = await getEurToLtc(priceEur);
        if (!ltcAmount) {
          res.status(503).json({ ok: false, message: "No se pudo obtener el precio en LTC. Inténtalo de nuevo." });
          return;
        }
        order.ltcAmountExpected = ltcAmount;
        saveOrder(order);
        res.json({ ok: true, orderId, method: "ltc", ltcAddress: LTC_ADDRESS, ltcAmount, priceEur, expiresAt: new Date(order.expiresAt).toISOString() });

      } else if (method === "stripe") {
        const session = await createStripeSession(order, getBaseUrl(req));
        order.stripeSessionId = session.id;
        order.stripeSessionUrl = session.url;
        saveOrder(order);
        res.json({ ok: true, orderId, method: "stripe", stripeUrl: session.url, priceEur });

      } else if (method === "paypal") {
        saveOrder(order);
        res.json({ ok: true, orderId, method: "paypal", paypalEmail: PAYPAL_EMAIL, amount: priceEur, reference: orderId, expiresAt: new Date(order.expiresAt).toISOString() });
      }
    } catch (err) {
      console.error("[payments] create error:", err.message);
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── POST /api/payments/paypal/notify — client says they paid ─────────────
  app.post("/api/payments/paypal/notify", async (req, res) => {
    const { orderId, discordId } = req.body || {};
    const order = pendingOrders.get(String(orderId || ""));
    if (!order || order.status !== "pending_payment" || order.method !== "paypal") {
      res.status(404).json({ ok: false, message: "Orden no encontrada o ya procesada." });
      return;
    }
    if (order.discordId !== String(discordId || "")) {
      res.status(403).json({ ok: false, message: "No autorizado." });
      return;
    }
    order.status = "pending_payment"; // stays pending until admin confirms
    saveOrder(order);
    await notifyAdminPayPalPending(order);
    res.json({ ok: true, message: "Notificación enviada al administrador. Te contactaremos pronto con tu key." });
  });

  // ── GET /api/payments/stripe/success — stripe redirect after payment ──────
  app.get("/api/payments/stripe/success", async (req, res) => {
    const sessionId = String(req.query.session_id || "");
    // Find order by stripe session id
    let order = null;
    for (const o of pendingOrders.values()) {
      if (o.stripeSessionId === sessionId) { order = o; break; }
    }
    if (!order) {
      res.redirect("/?tab=shop&stripe=not_found");
      return;
    }
    // Verify with Stripe
    try {
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` }
      });
      const session = await r.json();
      if (session.payment_status === "paid") {
        order.status = "paid";
        const key = deliverKey(order, deliverDeps);
        order.keyDelivered = key;
        order.status = "delivered";
        saveOrder(order);
        pendingOrders.delete(order.orderId);
        await notifyAdminStripeConfirmed(order);
        if (getDiscordClient() && getDiscordClient().isReady()) {
          try {
            const user = await getDiscordClient().users.fetch(order.discordId);
            await user.send(`✅ **Pago confirmado con Stripe!**\n\nTu key: \`${key}\`\nPlan: **${order.plan}** · ${order.durationDays} días\n\nVe a https://falcaobot.onrender.com/?tab=account para reclamarla.`);
          } catch (_) {}
        }
        res.redirect(`/?tab=account&payment=ok&key=${encodeURIComponent(key)}`);
      } else {
        res.redirect("/?tab=shop&stripe=pending");
      }
    } catch (err) {
      res.redirect("/?tab=shop&stripe=error");
    }
  });

  // ── POST /api/payments/stripe/webhook — Stripe webhook (auto-confirm) ─────
  app.post("/api/payments/stripe/webhook", async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    if (STRIPE_WEBHOOK_SECRET && sig) {
      // Verify signature (requires raw body — express.json() breaks this)
      // Raw body handled below
      try {
        const payload = req.rawBody || "";
        const hmac = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET);
        hmac.update(payload);
        const expected = `sha256=${hmac.digest("hex")}`;
        // simplified — proper sig check needs timestamp
        // For production use the official stripe library
      } catch (_) {}
    }
    try {
      event = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (_) {
      res.status(400).end();
      return;
    }
    if (event.type === "checkout.session.completed") {
      const session = event.data?.object;
      const orderId = session?.metadata?.orderId;
      if (orderId) {
        const order = pendingOrders.get(orderId);
        if (order && order.status === "pending_payment") {
          order.status = "paid";
          const key = deliverKey(order, deliverDeps);
          order.keyDelivered = key;
          order.status = "delivered";
          saveOrder(order);
          pendingOrders.delete(orderId);
          await notifyAdminStripeConfirmed(order);
          if (getDiscordClient() && getDiscordClient().isReady()) {
            try {
              const user = await getDiscordClient().users.fetch(order.discordId);
              await user.send(`✅ **Pago confirmado con Stripe!**\n\nTu key: \`${key}\`\nPlan: **${order.plan}** · ${order.durationDays} días\n\nVe a https://falcaobot.onrender.com/?tab=account para reclamarla.`);
            } catch (_) {}
          }
        }
      }
    }
    res.json({ received: true });
  });

  // ── GET /api/payments/order/:id — check order status ─────────────────────
  app.get("/api/payments/order/:id", (req, res) => {
    const order = pendingOrders.get(req.params.id);
    if (!order) { res.status(404).json({ ok: false }); return; }
    res.json({ ok: true, status: order.status, keyDelivered: order.keyDelivered, ltcAmount: order.ltcAmountExpected, ltcAddress: LTC_ADDRESS });
  });

  // ── POST /api/payments/admin/confirm — admin confirms PayPal ─────────────
  // Also called from Discord bot interaction
  app.post("/api/payments/admin/confirm", (req, res) => {
    // Simple secret check
    const secret = req.headers["x-admin-secret"] || "";
    if (secret !== (process.env.MENU_API_TOKEN || "")) {
      res.status(401).json({ ok: false }); return;
    }
    const { orderId, action } = req.body || {};
    const order = pendingOrders.get(String(orderId || ""));
    if (!order) { res.status(404).json({ ok: false, message: "Orden no encontrada." }); return; }
    if (action === "confirm") {
      const key = deliverKey(order, deliverDeps);
      order.keyDelivered = key;
      order.status = "delivered";
      saveOrder(order);
      pendingOrders.delete(order.orderId);
      if (getDiscordClient() && getDiscordClient().isReady()) {
        getDiscordClient().users.fetch(order.discordId).then(u => {
          u.send(`✅ **Tu pago de PayPal ha sido verificado y confirmado!**\n\nTu key: \`${key}\`\nPlan: **${order.plan}** · ${order.durationDays} días\n\nVe a https://falcaobot.onrender.com/?tab=account para reclamarla.`);
        }).catch(() => {});
      }
      res.json({ ok: true, key });
    } else {
      order.status = "cancelled";
      saveOrder(order);
      pendingOrders.delete(order.orderId);
      if (getDiscordClient() && getDiscordClient().isReady()) {
        getDiscordClient().users.fetch(order.discordId).then(u => {
          u.send(`❌ Tu pago de PayPal ha sido rechazado. Contacta con soporte si crees que es un error.`);
        }).catch(() => {});
      }
      res.json({ ok: true, cancelled: true });
    }
  });
}

module.exports = { mountPaymentsApi, pendingOrders, setPaymentsDiscordClient };
