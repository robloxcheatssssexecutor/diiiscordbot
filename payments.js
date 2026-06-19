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
  // Use the Discord bot to send the message with interactive buttons
  // (webhooks cannot send interactive components)
  const disc = getDiscordClient();
  if (disc && disc.isReady()) {
    try {
      // Use a dedicated env var for the admin notification channel.
      // Webhook URLs cannot be parsed for a channel ID — the second-to-last
      // segment is the webhook ID, not a channel ID.
      const channelId = process.env.PAYMENT_NOTIFY_CHANNEL_ID || "";
      if (channelId) {
        const channel = await disc.channels.fetch(channelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
          const embed = new EmbedBuilder()
            .setColor(0xf6a800)
            .setTitle("💰 Pago PayPal pendiente de verificación")
            .addFields(
              { name: "Usuario", value: `${order.discordUsername} (<@${order.discordId}>)`, inline: true },
              { name: "Plan", value: `${order.plan} · ${order.durationDays} días`, inline: true },
              { name: "Precio", value: `€${order.priceEur}`, inline: true },
              { name: "Email PayPal", value: `\`${PAYPAL_EMAIL}\``, inline: true },
              { name: "Order ID", value: `\`${order.orderId}\``, inline: true }
            )
            .setDescription("El cliente dice que ya ha pagado. Verifica en tu cuenta PayPal y pulsa el botón correspondiente.");
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`paypal_confirm:${order.orderId}`)
              .setLabel("✅ Confirmar pago y entregar key")
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`paypal_reject:${order.orderId}`)
              .setLabel("❌ Rechazar pago")
              .setStyle(ButtonStyle.Danger)
          );
          await channel.send({ embeds: [embed], components: [row] });
          return;
        }
      }
    } catch (err) {
      console.error("[payments] Could not send PayPal notification via bot:", err.message);
    }
  }

  // Fallback: plain webhook without buttons
  const content = `💰 **Pago PayPal pendiente de verificación**\n\n` +
    `**Usuario:** ${order.discordUsername} (<@${order.discordId}>)\n` +
    `**Plan:** ${order.plan} · ${order.durationDays} días\n` +
    `**Precio:** €${order.priceEur}\n` +
    `**Email PayPal:** \`${PAYPAL_EMAIL}\`\n` +
    `**Order ID:** \`${order.orderId}\`\n\n` +
    `El cliente dice que ya ha pagado. Usa \`/paypalconfirm ${order.orderId}\` para confirmar.`;
  await sendDiscordWebhook(ADMIN_DISCORD_WH, { content });
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
  // Try multiple price APIs with fallback
  const apis = [
    async () => {
      const r = await fetch("https://api.coinbase.com/v2/prices/LTC-EUR/spot", { headers: { "CB-VERSION": "2023-01-01" } });
      const d = await r.json();
      const price = parseFloat(d?.data?.amount);
      if (!price || !isFinite(price)) throw new Error("no price");
      return price;
    },
    async () => {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=eur");
      const d = await r.json();
      const price = d?.litecoin?.eur;
      if (!price) throw new Error("no price");
      return price;
    },
    async () => {
      const r = await fetch("https://min-api.cryptocompare.com/data/price?fsym=LTC&tsyms=EUR");
      const d = await r.json();
      const price = d?.EUR;
      if (!price) throw new Error("no price");
      return price;
    }
  ];
  for (const fn of apis) {
    try {
      const priceEur = await fn();
      return (eurAmount / priceEur).toFixed(6);
    } catch (_) { /* try next */ }
  }
  return null;
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

  // Auto-claim the key to the buyer's Discord account
  if (order.discordId) {
    const found2 = getKeyRecord(db, key);
    if (found2 && !found2.claimedBy) {
      found2.claimedBy = order.discordId;
      found2.claimedByUsername = order.discordUsername || order.discordId;
      found2.claimedAt = new Date().toISOString();
      writeDb(db);
    }
  }

  // Credit referrer 20% if a valid refCode was used
  if (order.referrerId && order.referrerId !== order.discordId) {
    const commission = Number((order.priceEur * 0.20).toFixed(2));
    try {
      fetch(`http://localhost:${process.env.PORT || 3000}/api/referrals/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ referrerDiscordId: order.referrerId, amount: commission })
      }).catch(() => {});
    } catch (_) {}
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

// ── Order status page HTML builder ────────────────────────────────────────
function buildOrderPageHtml(orderId) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Orden ${orderId} — Falcao External</title>
  <link rel="icon" href="https://i.imgur.com/lst2PVm.png" type="image/png"/>
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
  <style>
    :root{--bg:#08080c;--card:#121217;--card2:#1a1a22;--stroke:#2a2a35;--text:#e8e8ee;--muted:#8a8a9a;--accent:#e85822;--green:#22c55e;--red:#ef4444;--yellow:#eab308}
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{min-height:100vh;font-family:"Instrument Sans",system-ui,sans-serif;background:var(--bg);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px}
    .card{background:var(--card);border:1px solid var(--stroke);border-radius:16px;padding:28px;width:100%;max-width:480px}
    .logo{text-align:center;margin-bottom:20px}
    .logo img{width:56px;height:56px;border-radius:12px}
    h1{font-size:1.2rem;font-weight:700;text-align:center;margin-bottom:4px}
    .order-id{text-align:center;font-size:.78rem;color:var(--muted);margin-bottom:20px;font-family:monospace}
    .field{background:var(--card2);border-radius:10px;padding:12px 14px;margin-bottom:10px}
    .field-label{font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px}
    .field-value{font-size:.9rem;font-weight:600}
    .ltc-addr{font-family:monospace;font-size:.78rem;word-break:break-all;background:var(--bg);padding:8px;border-radius:7px;border:1px solid var(--stroke);margin-top:6px}
    .status-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;font-size:.82rem;font-weight:600}
    .status-pending{background:rgba(234,179,8,.15);color:var(--yellow);border:1px solid rgba(234,179,8,.3)}
    .status-delivered{background:rgba(34,197,94,.15);color:var(--green);border:1px solid rgba(34,197,94,.3)}
    .status-expired{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}
    .status-row{text-align:center;margin:16px 0}
    .spinner{width:18px;height:18px;border:2px solid var(--stroke);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:middle;margin-right:8px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:11px 20px;border-radius:10px;font-size:.88rem;font-weight:600;cursor:pointer;text-decoration:none;border:none;font-family:inherit;margin-top:12px;width:100%;transition:opacity .13s}
    .btn:hover{opacity:.88}
    .btn-accent{background:var(--accent);color:#fff}
    .btn-secondary{background:var(--card2);color:var(--text);border:1px solid var(--stroke)}
    .msg{margin-top:12px;padding:11px;border-radius:9px;font-size:.85rem;display:none;text-align:center}
    .msg.ok{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);color:var(--green);display:block}
    .msg.err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:var(--red);display:block}
    a.home{display:block;text-align:center;margin-top:16px;color:var(--muted);font-size:.82rem;text-decoration:none}
    a.home:hover{color:var(--text)}
  </style>
</head>
<body>
<div class="card">
  <div class="logo"><img src="https://i.imgur.com/lst2PVm.png" alt="logo"/></div>
  <h1>Estado de tu orden</h1>
  <div class="order-id">${orderId}</div>
  <div id="orderBody"><div style="text-align:center;color:var(--muted)"><span class="spinner"></span> Cargando...</div></div>
</div>
<a class="home" href="/">← Volver al inicio</a>
<script>
const ORDER_ID="${orderId}";
const METHOD_NAMES={stripe:"Stripe",ltc:"Litecoin",paypal:"PayPal F&F"};
const PLAN_LABEL={falcao:"Falcao",temp:"Temp",both:"Both"};
function statusBadge(s){
  const m={pending_payment:["status-pending","⏳ Pendiente de pago"],paid:["status-delivered","💰 Pagado"],delivered:["status-delivered","✅ Entregado"],expired:["status-expired","⏰ Expirada"],cancelled:["status-expired","❌ Cancelada"]};
  const[cls,label]=m[s]||["status-pending","⏳ "+s];
  return \`<span class="status-badge \${cls}">\${label}</span>\`;
}
async function loadOrder(){
  try{
    const d=await fetch("/api/payments/order/"+ORDER_ID).then(r=>r.json());
    if(!d.ok){document.getElementById("orderBody").innerHTML='<p style="color:var(--red);text-align:center">Orden no encontrada.</p>';return;}
    const o=d.order||d;
    let extra="";
    if(o.status==="pending_payment"&&o.method==="ltc"){
      extra=\`<div class="field"><div class="field-label">Enviar LTC a</div><div class="ltc-addr">\${o.ltcAddress||""}</div>
      <div class="field-label" style="margin-top:8px">Cantidad exacta</div><div class="field-value">\${o.ltcAmountExpected||"?"} LTC</div></div>
      <p style="font-size:.75rem;color:var(--muted);text-align:center;margin-top:8px">Confirmación automática tras 1 bloque</p>\`;
    }else if(o.status==="pending_payment"&&o.method==="paypal"){
      extra=\`<div class="field"><div class="field-label">Enviar pago F&F a</div><div class="field-value">\${o.paypalEmail||""}</div>
      <div class="field-label" style="margin-top:8px">Referencia (incluir en nota)</div><div class="field-value" style="font-family:monospace">\${ORDER_ID}</div></div>
      <button class="btn btn-accent" onclick="notifyPayPal()">Ya pagué — Notificar al admin</button>
      <div id="ppStatus" class="msg"></div>\`;
    }else if(o.status==="delivered"){
      extra=\`<div class="field"><div class="field-label">Key entregada</div><div class="field-value" style="font-family:monospace">\${o.keyDelivered||"—"}</div></div>
      <p style="font-size:.78rem;color:var(--muted);text-align:center;margin-top:8px">La key ha sido reclamada automáticamente en tu cuenta.</p>\`;
    }
    document.getElementById("orderBody").innerHTML=\`
      <div class="status-row">\${statusBadge(o.status)}</div>
      <div class="field"><div class="field-label">Método</div><div class="field-value">\${METHOD_NAMES[o.method]||o.method}</div></div>
      <div class="field"><div class="field-label">Plan</div><div class="field-value">\${PLAN_LABEL[o.plan]||o.plan}</div></div>
      <div class="field"><div class="field-label">Precio</div><div class="field-value">€\${o.priceEur}</div></div>
      <div class="field"><div class="field-label">Duración</div><div class="field-value">\${o.durationDays===36500?"Lifetime":o.durationDays+" días"}</div></div>
      \${extra}
      <a class="btn btn-secondary" href="/?tab=account">Ver mis keys →</a>\`;
    if(o.status==="pending_payment"&&(o.method==="ltc"||o.method==="stripe")){
      setTimeout(()=>location.reload(),15000);
    }
  }catch(_){document.getElementById("orderBody").innerHTML='<p style="color:var(--red);text-align:center">Error cargando la orden.</p>';}
}
async function notifyPayPal(){
  const st=document.getElementById("ppStatus");
  st.className="msg";st.textContent="Enviando...";st.style.display="block";
  try{
    const d=await fetch("/api/payments/paypal/notify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({orderId:ORDER_ID,discordId:null})}).then(r=>r.json());
    st.className="msg "+(d.ok?"ok":"err");st.textContent=d.ok?"✅ "+d.message:"❌ "+d.message;
  }catch(_){st.className="msg err";st.textContent="Error de red.";}
}
loadOrder();
</script>
</body>
</html>`;
}

// ── Mount payments API ─────────────────────────────────────────────────────
function mountPaymentsApi(app, deps) {
  const { readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan,
          appendKeyLog, dataDir, getWebPricesPayload } = deps;

  ordersPath = path.join(dataDir, "orders.json");
  loadOrders();
  startLtcPoller({ readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan, appendKeyLog, dataDir });

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
    const { method, plan: productId, durationKey, discordId, discordUsername } = req.body || {};
    if (!method || !productId || !durationKey || !discordId) {
      res.status(400).json({ ok: false, message: "Faltan campos: method, plan, durationKey, discordId." });
      return;
    }
    if (!["ltc", "stripe", "paypal"].includes(method)) {
      res.status(400).json({ ok: false, message: "Método inválido." });
      return;
    }
    if (!["week","monthly","lifetime"].includes(durationKey)) {
      res.status(400).json({ ok: false, message: "Duración inválida." });
      return;
    }

    const prices = getWebPricesPayload();
    const products = prices.products || {};

    // productId can be "product1", "product2", "falcao", "temp", "both"
    // Resolve to a product entry and a license plan
    let productEntry = products[productId];
    let licensePlan = normalizePlan(productId); // works if they sent "falcao"/"temp"/"both"

    if (!productEntry && !licensePlan) {
      res.status(400).json({ ok: false, message: `Plan inválido: "${productId}". Usa product1, product2, falcao, temp o both.` });
      return;
    }

    // If they sent a product key like "product1", infer the license plan from position
    if (productEntry && !licensePlan) {
      const productKeys = Object.keys(products);
      const idx = productKeys.indexOf(productId);
      // product1 → falcao, product2 → both (has spoofer), anything else → falcao
      licensePlan = idx === 1 ? "both" : "falcao";
    }

    // If they sent "falcao"/"temp"/"both" directly, find price from first matching product
    if (!productEntry && licensePlan) {
      productEntry = Object.values(products)[0]; // fallback to first product price
    }

    const priceEur = productEntry?.[durationKey];
    if (!priceEur || typeof priceEur !== "number") {
      res.status(400).json({ ok: false, message: `Precio no disponible para "${durationKey}".` });
      return;
    }

    const durationDaysMap = { week: 7, monthly: 30, lifetime: 36500 };
    const durationDays = durationDaysMap[durationKey] || 30;

    // Validate referral code if provided
    const refCode = String(req.body.refCode || "").trim().toUpperCase();
    let referrerId = null;
    if (refCode) {
      try {
        const refRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/referrals/validate?code=${encodeURIComponent(refCode)}&discordId=${encodeURIComponent(discordId)}`);
        const refData = await refRes.json();
        if (refData.ok) referrerId = refData.referrerId;
      } catch (_) {}
    }

    // Apply referral balance if requested
    const useBalance = req.body.useBalance === true;
    let finalPrice = priceEur;
    let balanceApplied = 0;
    if (useBalance && discordId) {
      try {
        const balRes = await fetch(`http://localhost:${process.env.PORT || 3000}/api/referrals/use-balance`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ discordId, priceEur })
        });
        const balData = await balRes.json();
        if (balData.ok) {
          balanceApplied = balData.appliedAmount;
          finalPrice = balData.remainingPrice;
        }
      } catch (_) {}
    }

    // If fully covered by balance, deliver key directly
    if (finalPrice <= 0 && useBalance) {
      const fakeOrder = {
        orderId: `BAL-${Date.now()}`,
        method: "balance",
        plan: licensePlan,
        durationDays,
        priceEur: 0,
        discordId: String(discordId),
        discordUsername: String(discordUsername || discordId),
        status: "pending_payment",
        createdAt: Date.now(),
        expiresAt: Date.now() + ORDER_EXPIRY_MS,
        keyDelivered: null,
        ltcAmountExpected: null,
        stripeSessionId: null,
        stripeSessionUrl: null,
        refCode: refCode || null,
        referrerId: referrerId || null
      };
      const deliverDeps2 = { readDb, writeDb, generateKey, getKeyRecord, calcExpiresAt, normalizePlan, appendKeyLog, dataDir };
      const key = deliverKey(fakeOrder, deliverDeps2);
      fakeOrder.keyDelivered = key;
      fakeOrder.status = "delivered";
      saveOrder(fakeOrder);
      // DM user
      if (getDiscordClient() && getDiscordClient().isReady()) {
        try {
          const user = await getDiscordClient().users.fetch(discordId);
          await user.send(`✅ **Key delivered using your referral balance!**\n\nKey: \`${key}\`\nPlan: **${licensePlan}** · ${durationDays === 36500 ? "Lifetime" : durationDays + "d"}\n\nYou can claim it at https://falcaobot.onrender.com/?tab=dashboard`);
        } catch (_) {}
      }
      return res.json({ ok: true, method: "balance", orderId: fakeOrder.orderId, key, balanceApplied, priceEur: 0 });
    }

    const orderId = makeOrderId();
    const order = {
      orderId,
      method,
      plan: licensePlan,
      durationDays,
      priceEur: finalPrice,
      discordId: String(discordId),
      discordUsername: String(discordUsername || discordId),
      status: "pending_payment",
      createdAt: Date.now(),
      expiresAt: Date.now() + ORDER_EXPIRY_MS,
      keyDelivered: null,
      ltcAmountExpected: null,
      stripeSessionId: null,
      stripeSessionUrl: null,
      refCode: refCode || null,
      referrerId: referrerId || null
    };

    try {
      if (method === "ltc") {
        const ltcAmount = await getEurToLtc(finalPrice);
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
    // Accept notify from anyone who has the orderId (it's already unique/secret enough)
    // discordId check is optional — removed to allow notify from /order page without account session
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
      // Verify Stripe signature using the raw body captured before express.json()
      try {
        const payload = req.rawBody || "";
        // Stripe signature format: t=<timestamp>,v1=<hmac>
        const parts = sig.split(",").reduce((acc, part) => {
          const [k, v] = part.split("=");
          acc[k] = v;
          return acc;
        }, {});
        const timestamp = parts.t;
        const v1Sig = parts.v1;
        if (!timestamp || !v1Sig) {
          console.warn("[stripe-webhook] Invalid signature format");
          res.status(400).json({ error: "Invalid signature format" });
          return;
        }
        const signedPayload = `${timestamp}.${payload}`;
        const hmac = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET);
        hmac.update(signedPayload);
        const expected = hmac.digest("hex");
        // Use timing-safe comparison to prevent timing attacks
        const expectedBuf = Buffer.from(expected, "hex");
        const receivedBuf = Buffer.from(v1Sig, "hex");
        const sigValid =
          expectedBuf.length === receivedBuf.length &&
          crypto.timingSafeEqual(expectedBuf, receivedBuf);
        if (!sigValid) {
          console.warn("[stripe-webhook] Signature mismatch — ignoring event");
          res.status(400).json({ error: "Signature verification failed" });
          return;
        }
      } catch (sigErr) {
        console.error("[stripe-webhook] Signature error:", sigErr.message);
        res.status(400).json({ error: "Signature error" });
        return;
      }
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

  // ── GET /api/payments/spending — total spent per discord user ────────────
  app.get("/api/payments/spending", (_req, res) => {
    // Read all orders from file
    const spending = {};
    if (ordersPath && fs.existsSync(ordersPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
        for (const o of (raw.orders || [])) {
          if (o.status !== "delivered") continue;
          const uid = o.discordId;
          if (!uid) continue;
          if (!spending[uid]) spending[uid] = { discordId: uid, username: o.discordUsername || uid, total: 0, orders: 0 };
          spending[uid].total += Number(o.priceEur) || 0;
          spending[uid].orders += 1;
        }
      } catch (_) {}
    }
    const list = Object.values(spending).sort((a, b) => b.total - a.total);
    res.json({ ok: true, spending: list });
  });
  app.get("/api/payments/order/:id", (req, res) => {
    const orderId = req.params.id;
    // Check in-memory first
    let order = pendingOrders.get(orderId);
    // If not in memory, check orders.json (delivered/expired orders)
    if (!order && ordersPath && fs.existsSync(ordersPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
        order = (raw.orders || []).find(o => o.orderId === orderId);
      } catch (_) {}
    }
    if (!order) { res.status(404).json({ ok: false }); return; }
    res.json({ ok: true, order: {
      orderId: order.orderId,
      method: order.method,
      plan: order.plan,
      durationDays: order.durationDays,
      priceEur: order.priceEur,
      status: order.status,
      keyDelivered: order.keyDelivered,
      ltcAmountExpected: order.ltcAmountExpected,
      ltcAddress: LTC_ADDRESS,
      paypalEmail: PAYPAL_EMAIL,
      stripeSessionUrl: order.stripeSessionUrl,
      createdAt: order.createdAt,
      expiresAt: order.expiresAt
    }});
  });

  // ── GET /order/:id — dedicated order status page ──────────────────────────
  app.get("/order/:id", (req, res) => {
    const orderId = req.params.id;
    res.type("html").send(buildOrderPageHtml(orderId));
  });

  // ── GET /api/payments/history/:discordId — purchase history for a user ──
  app.get("/api/payments/history/:discordId", (req, res) => {
    const discordId = String(req.params.discordId || "");
    if (!discordId) { res.status(400).json({ ok: false }); return; }
    const orders = [];
    if (ordersPath && fs.existsSync(ordersPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
        for (const o of (raw.orders || [])) {
          if (o.discordId === discordId) {
            orders.push({
              orderId: o.orderId,
              method: o.method,
              plan: o.plan,
              durationDays: o.durationDays,
              priceEur: o.priceEur,
              status: o.status,
              keyDelivered: o.keyDelivered,
              createdAt: o.createdAt
            });
          }
        }
      } catch (_) {}
    }
    orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ ok: true, orders });
  });

  // ── POST /api/payments/admin/confirm — admin confirms PayPal ─────────────
  // Also called from Discord bot interaction
  app.post("/api/payments/admin/confirm", (req, res) => {
    // Require a non-empty secret. If MENU_API_TOKEN is not configured,
    // block ALL requests to prevent unauthorized key delivery.
    const token = process.env.MENU_API_TOKEN || "";
    if (!token) {
      console.error("[payments] MENU_API_TOKEN not set — /api/payments/admin/confirm is disabled for security.");
      res.status(503).json({ ok: false, message: "Admin confirm endpoint is disabled: MENU_API_TOKEN not configured." });
      return;
    }
    const secret = req.headers["x-admin-secret"] || "";
    if (secret !== token) {
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
