require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");
const classifier = require("./classifier");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── User-specific knowledge for the classification engine ──────────────────
// The engine (./classifier) knows no names, accounts or payees. Everything personal arrives through this object.
// The defaults below reproduce the old hardcoded SKIP_PAYEES behaviour so nothing regresses; override them per
// deployment with the RUVIO_USER_CONFIG env var (JSON). Per-user storage can replace getUserConfig() later
// without touching the engine. Fields: ownNames, ownVpas, ownAccounts, ignorePayees, investmentPayees.
const LEGACY_USER_CONFIG = {
  ownNames: ["UTKARSH SINGHVI"],
  ignorePayees: ["CRED CLUB"],
  // Broker/platform names as banks print them (often truncated). Money to or from these is an investment, not spending or income.
  investmentPayees: ["ZERODH", "GROWW"],
};

function getUserConfig(/* groupId */) {
  if (process.env.RUVIO_USER_CONFIG) {
    try {
      return JSON.parse(process.env.RUVIO_USER_CONFIG);
    } catch (err) {
      console.error("RUVIO_USER_CONFIG is not valid JSON; using defaults:", err.message);
    }
  }
  return LEGACY_USER_CONFIG;
}

// Emoji shown next to each category in WhatsApp messages (SMS + dictated flows)
const CATEGORY_EMOJI = {
  Food: "🍔",
  Transport: "🚕",
  Shopping: "🛍️",
  Entertainment: "🎬",
  Health: "💊",
  Bills: "🧾",
  "Friends and family": "👥",
  Investments: "📈",
  Other: "💳",
};

const INCOME_EMOJI = "💰";

function emojiFor(category) {
  return CATEGORY_EMOJI[category] || "💳";
}

function formatINR(amount) {
  return `₹${Math.abs(Number(amount)).toLocaleString("en-IN")}`;
}

// How a stored row is counted (see classifier/ledger.js):
//   received   -> transaction_type "income"/"received" OR category "Received" (so it works before the optional column exists)
//   investment -> category "Investments": tracked separately, never counted as spending
//   spend      -> everything else (refunds are negative spend rows)
const isIncome = classifier.isReceived;     // kept for existing call sites
const isReceived = classifier.isReceived;
const isInvestment = classifier.isInvestment;
const isSpend = classifier.isSpend;

// Key used to remember a merchant's category in the category_rules table
function toMerchantKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\bstore\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── SMS parsing — delegated to the classification engine (./classifier) ──────
// Same return shape as the old regex parser; null when the message should not be recorded.
// The full classification (income/refund/transfer/investment, confidence, review) is used by /webhook/sms below.

function parseSMS(text) {
  return classifier.parseLegacy(text, getUserConfig());
}

// ── WhatsApp sending (never throws — a failed message must not lose a saved transaction) ──

let twilioClient = null;

function twilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM &&
    process.env.TWILIO_WHATSAPP_TO
  );
}

async function sendWhatsApp(payload) {
  if (!twilioConfigured()) {
    return { sent: false, error: "Twilio WhatsApp environment variables are not fully configured." };
  }
  try {
    if (!twilioClient) {
      twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    }
    const msg = await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
      ...payload,
    });
    return { sent: true, sid: msg && msg.sid };
  } catch (err) {
    console.error("WhatsApp send error:", err.message);
    return { sent: false, error: err.message };
  }
}

// Marks a transaction as awaiting category correction and sends the List Picker.
async function requestCategoryPicker({ groupId, txnId, amount, description }) {
  const { error: pendingError } = await supabase
    .from("groups")
    .update({ pending_category_txn_id: txnId, awaiting_custom_category: false })
    .eq("id", groupId);

  if (pendingError) {
    console.error("Could not save pending category state:", pendingError.message);
    return { sent: false, error: `Pending state not saved: ${pendingError.message}` };
  }

  if (!process.env.TWILIO_LIST_PICKER_CONTENT_SID) {
    return { sent: false, error: "TWILIO_LIST_PICKER_CONTENT_SID is not set." };
  }

  return sendWhatsApp({
    contentSid: process.env.TWILIO_LIST_PICKER_CONTENT_SID,
    contentVariables: JSON.stringify({
      "1": formatINR(amount),
      "2": description,
    }),
  });
}

// Notification for ONE recorded expense (used by bank SMS and single dictated expense).
// "Other" → List Picker to change the category; anything else → plain message with emoji.
async function notifyExpense({ groupId, txnId, amount, description, category }) {
  if (category === "Other") {
    const picker = await requestCategoryPicker({ groupId, txnId, amount, description });
    if (picker.sent) {
      return {
        reply: `Auto-logged ${formatINR(amount)} - Other. Category correction requested.`,
        whatsapp_sent: true,
        category_picker_sent: true,
      };
    }

    // Picker could not be sent — fall back to a plain message so nothing is missed.
    const fallback =
      `${emojiFor("Other")} Expense recorded\n\nAmount - ${formatINR(amount)}\nPayee - ${description}\nCategory - Other` +
      `\n\nTo change it, reply: *edit last category to Food*`;
    const wa = await sendWhatsApp({ body: fallback });
    return {
      reply: fallback,
      whatsapp_sent: wa.sent,
      category_picker_sent: false,
      whatsapp_error: [picker.error, wa.error].filter(Boolean).join(" | ") || undefined,
    };
  }

  const reply = `${emojiFor(category)} Expense recorded\n\nAmount - ${formatINR(amount)}\nPayee - ${description}\nCategory - ${category}`;
  const wa = await sendWhatsApp({ body: reply });
  return { reply, whatsapp_sent: wa.sent, whatsapp_error: wa.error };
}

// ── Classify message intent ────────────────────────────────────────────────

async function classifyIntent(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: `Classify this WhatsApp message intent. Return ONLY a JSON object, no markdown.

Intents: "expense" | "edit" | "delete" | "show" | "query" | "unknown"

For "edit": include field ("amount"|"description"|"category"|"paid_by"), value (new value), target ("last" or number)
For "delete": include target ("last" or number like 2 for second-last)
For "show": include count (default 5)
For "query": any analytical question about expenses

Examples:
"edit last to 300" -> {"intent":"edit","target":"last","field":"amount","value":"300"}
"change last amount to 500" -> {"intent":"edit","target":"last","field":"amount","value":"500"}
"delete last" -> {"intent":"delete","target":"last"}
"remove last entry" -> {"intent":"delete","target":"last"}
"delete second last" -> {"intent":"delete","target":2}
"edit last category to food" -> {"intent":"edit","target":"last","field":"category","value":"Food"}
"edit last description to Uber" -> {"intent":"edit","target":"last","field":"description","value":"Uber"}
"show last 5" -> {"intent":"show","count":5}
"show expenses" -> {"intent":"show","count":5}
"what is my biggest expense this month" -> {"intent":"query"}
"how much have I spent on food" -> {"intent":"query"}
"200 auto" -> {"intent":"expense"}
"500 groceries, 299 netflix" -> {"intent":"expense"}

Message: "${text}"`
    }]
  });

  const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Parse one or many expenses with Claude ─────────────────────────────────

async function parseExpenses(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `You parse expense messages. The message may contain ONE or MULTIPLE expenses separated in ANY way — new lines, commas, full stops, semicolons, pipes, dashes, or any other separator. Use context and amounts to identify individual expenses.
Return ONLY a JSON array, no markdown, no explanation.

Each item in the array must follow this schema:
{"amount": <number>, "description": "<2-4 word label>", "category": "<one of: Food, Transport, Shopping, Entertainment, Health, Bills, Other>", "paid_by": "<name if mentioned, else null>"}

Rules:
- amount must be a positive number in INR
- description must be short and clean
- Split smartly — "500 groceries, 299 netflix, 100 coffee" is 3 expenses
- Skip anything that is clearly not an expense
- "groceries", "sabzi", "vegetables", "fruits", "kirana", "supermarket", "BigBasket", "Zepto", "Blinkit", "Swiggy Instamart" always go to Food category
- If nothing is an expense at all, return []
- Always return an array, even for a single expense

Message:
${text}`
    }]
  });

  const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── Categorise a merchant name with Claude ─────────────────────────────────

async function categorizeMerchant(merchant, amount) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 128,
    messages: [{
      role: "user",
      content: `Given this merchant name from an Indian bank SMS, return ONLY a JSON object, no markdown.

Schema: {"description": "<2-4 word clean label>", "category": "<one of: Food, Transport, Shopping, Entertainment, Health, Bills, Other>"}

Rules:
- description should be a clean readable label (e.g. "Zepto Groceries", "Uber Ride", "Netflix", "Swiggy Food")
- Use Indian context — Zepto/Blinkit/BigBasket = Food, Ola/Uber/Rapido = Transport, Swiggy/Zomato = Food, etc.
- Bills for electricity, rent, insurance, subscriptions (non-entertainment)
- Entertainment for Netflix, Spotify, gaming, movies

Merchant: "${merchant}"
Amount: ₹${amount}`
    }]
  });

  const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Get recent transactions ────────────────────────────────────────────────

async function getRecentTxns(groupId, limit = 10) {
  const { data } = await supabase
    .from("transactions")
    .select("*")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data || [];
}

// ── Handle edit ────────────────────────────────────────────────────────────

async function handleEdit(intent, groupId) {
  const txns = await getRecentTxns(groupId, 10);
  if (!txns.length) return "No transactions found to edit.";
  const idx = intent.target === "last" ? 0 : (parseInt(intent.target) - 1) || 0;
  const txn = txns[idx];
  if (!txn) return "Couldn't find that transaction.";

  const updates = {};
  if (intent.field === "amount") updates.amount = parseFloat(intent.value);
  else if (intent.field === "description") updates.description = intent.value;
  else if (intent.field === "category") updates.category = intent.value;
  else if (intent.field === "paid_by") updates.paid_by = intent.value;
  else return "Not sure what to edit. Try: *edit last amount to 300* or *edit last category to Food*";

  await supabase.from("transactions").update(updates).eq("id", txn.id);
  const fieldLabel = intent.field === "paid_by" ? "paid by" : intent.field;
  return `✏️ Updated! *${txn.description}* — ${fieldLabel} changed to *${intent.value}*`;
}

// ── Handle delete ──────────────────────────────────────────────────────────

async function handleDelete(intent, groupId) {
  const txns = await getRecentTxns(groupId, 10);
  if (!txns.length) return "No transactions found to delete.";
  const idx = intent.target === "last" ? 0 : (parseInt(intent.target) - 1) || 0;
  const txn = txns[idx];
  if (!txn) return "Couldn't find that transaction.";

  await supabase.from("transactions").delete().eq("id", txn.id);
  return `🗑️ Deleted *${txn.description}* — ₹${txn.amount.toLocaleString("en-IN")} (${txn.category})`;
}

// ── Handle show ────────────────────────────────────────────────────────────

async function handleShow(intent, groupId) {
  const count = Math.min(intent.count || 5, 10);
  const txns = await getRecentTxns(groupId, count);
  if (!txns.length) return "No transactions found.";

  const lines = txns.map((t, i) => {
    const date = new Date(t.transaction_date || t.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    if (isIncome(t)) {
      return `${i + 1}. ${INCOME_EMOJI} *+₹${t.amount.toLocaleString("en-IN")}* — ${t.description} (Received) · ${date}`;
    }
    return `${i + 1}. *₹${t.amount.toLocaleString("en-IN")}* — ${t.description} (${t.category}) · ${date}`;
  });

  return `📋 *Last ${txns.length} transactions:*\n\n${lines.join("\n")}`;
}

// ── Handle query ───────────────────────────────────────────────────────────

async function handleQuery(question, groupId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [{ data: allTxns }, { data: limits }] = await Promise.all([
    supabase.from("transactions").select("*").eq("group_id", groupId).gte("created_at", monthStart).order("created_at", { ascending: false }),
    supabase.from("limits").select("*").eq("group_id", groupId),
  ]);

  // Spending maths excludes received money and investments; both are reported separately
  const txns = (allTxns || []).filter(isSpend);
  const incomeTxns = (allTxns || []).filter(isReceived);
  const investTxns = (allTxns || []).filter(isInvestment);
  const investNet = investTxns.reduce((s, t) => s + t.amount, 0);

  if (!txns.length && !incomeTxns.length) return "No transactions found for this month yet.";

  const total = txns.reduce((s, t) => s + t.amount, 0);
  const incomeTotal = incomeTxns.reduce((s, t) => s + t.amount, 0);

  const byCategory = {};
  for (const t of txns) byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;

  const sorted = [...txns].sort((a, b) => b.amount - a.amount);

  const catSummary = Object.entries(byCategory).sort((a, b) => b[1] - a[1])
    .map(([c, a]) => `${c}: ₹${Math.round(a).toLocaleString("en-IN")}`).join(", ");

  const limitsInfo = (limits || []).map(l => {
    const spent = l.category === "overall" ? total : (byCategory[l.category] || 0);
    const rem = l.amount - spent;
    return `${l.category}: spent ₹${Math.round(spent).toLocaleString("en-IN")} of ₹${Math.round(l.amount).toLocaleString("en-IN")} (${rem >= 0 ? "₹" + Math.round(rem).toLocaleString("en-IN") + " left" : "over by ₹" + Math.round(-rem).toLocaleString("en-IN")})`;
  }).join("; ");

  const top10 = sorted.slice(0, 10).map(t =>
    `${t.description}: ₹${t.amount.toLocaleString("en-IN")} (${t.category})`
  ).join(", ");

  const incomeInfo = incomeTxns.length
    ? `- Income received: ₹${Math.round(incomeTotal).toLocaleString("en-IN")} across ${incomeTxns.length} credits (${incomeTxns.slice(0, 10).map(t => `${t.description}: ₹${t.amount.toLocaleString("en-IN")}`).join(", ")})`
    : "- Income received: none recorded";
  const investInfo = investTxns.length
    ? `- Investments (net, NOT counted as spending): ₹${Math.round(investNet).toLocaleString("en-IN")} across ${investTxns.length} entries`
    : "";

  const prompt = `You are a personal finance assistant. Answer this question about the user's finances concisely in 2-4 lines. Use ₹ for amounts. Be specific with numbers. Income is money received and is NOT spending.

This month's data:
- Total spent: ₹${Math.round(total).toLocaleString("en-IN")} across ${txns.length} transactions
- By category: ${catSummary}
- Top transactions: ${top10}
${incomeInfo}
${investInfo}
${limitsInfo ? `- Budget limits: ${limitsInfo}` : ""}

Question: ${question}

Reply in plain text, no markdown, no bullet points. Keep it short and direct.`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }]
  });

  return `💬 ${msg.content[0].text.trim()}`;
}

// ── Build WhatsApp reply with limits ──────────────────────────────────────

async function buildExpenseReply(expenses, groupId) {
  const { data: limits } = await supabase.from("limits").select("*").eq("group_id", groupId);
  const { data: monthTxns } = await supabase
    .from("transactions")
    .select("*")
    .eq("group_id", groupId)
    .gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  // Budgets count spending only (not received money, not investments)
  const txns = (monthTxns || []).filter(isSpend);

  const totalSpent = txns.reduce((s, t) => s + t.amount, 0);
  const overallLimit = (limits || []).find((l) => l.category === "overall");
  const catSpent = (cat) => txns.filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0);

  const lines = [];
  const seenCats = new Set();

  for (const e of expenses) {
    lines.push(
      e.amount < 0
        ? `↩️ *₹${Math.abs(e.amount).toLocaleString("en-IN")} refund* — ${e.description} (${e.category})`
        : `✅ *₹${e.amount.toLocaleString("en-IN")}* — ${e.description} (${e.category})`
    );

    if (!seenCats.has(e.category)) {
      seenCats.add(e.category);
      const catLimit = (limits || []).find((l) => l.category === e.category);
      if (catLimit) {
        const spent = catSpent(e.category);
        const rem = catLimit.amount - spent;
        lines.push(
          rem < 0
            ? `   ⚠️ ${e.category} limit exceeded by ₹${Math.abs(rem).toLocaleString("en-IN")}`
            : `   📊 ${e.category}: ₹${rem.toLocaleString("en-IN")} left of ₹${catLimit.amount.toLocaleString("en-IN")}`
        );
      }
    }
  }

  if (expenses.length > 1) {
    const totalThisMsg = expenses.reduce((s, e) => s + e.amount, 0);
    lines.push(`\n📦 *${expenses.length} recorded* · This batch: ₹${totalThisMsg.toLocaleString("en-IN")}`);
  }

  if (overallLimit) {
    const rem = overallLimit.amount - totalSpent;
    lines.push(
      rem < 0
        ? `🚨 Monthly budget exceeded by ₹${Math.abs(rem).toLocaleString("en-IN")}`
        : `💰 Monthly: ₹${totalSpent.toLocaleString("en-IN")} / ₹${overallLimit.amount.toLocaleString("en-IN")} · ₹${rem.toLocaleString("en-IN")} left`
    );
  }

  return lines.join("\n");
}

// ── Saving classified transactions ─────────────────────────────────────────

// Optional columns added by migrations/001_additive_columns.sql. Until that migration is run, saves fall back to
// the original columns so nothing breaks (received/investment rows are still recognised by their category).
const OPTIONAL_TXN_COLUMNS = ["transaction_type", "reference_id"];
const OPTIONAL_COLUMN_RETRY_MS = 10 * 60 * 1000;
let optionalColumns = { missing: false, checkedAt: 0 };

function isMissingColumnError(err) {
  if (!err) return false;
  return (
    err.code === "PGRST204" ||
    err.code === "42703" ||
    /could not find the .* column|column .* does not exist|schema cache/i.test(err.message || "")
  );
}

async function insertTransaction(row) {
  const legacyRow = { ...row };
  OPTIONAL_TXN_COLUMNS.forEach((c) => delete legacyRow[c]);

  const skipFull = optionalColumns.missing && Date.now() - optionalColumns.checkedAt < OPTIONAL_COLUMN_RETRY_MS;
  if (!skipFull) {
    const full = await supabase.from("transactions").insert(row).select("id").single();
    if (!full.error) {
      optionalColumns = { missing: false, checkedAt: Date.now() };
      return full;
    }
    if (!isMissingColumnError(full.error)) return full;
    optionalColumns = { missing: true, checkedAt: Date.now() };
    console.warn("transactions is missing optional columns (run migrations/001_additive_columns.sql). Saving without them:", full.error.message);
  }
  return supabase.from("transactions").insert(legacyRow).select("id").single();
}

// Existing rows the engine needs for reconciliation: same reference number, the identical SMS in the last 24h,
// and (for refunds only) recent purchases to link against. Read-only; failures degrade to "no extra context".
async function fetchKnownTransactions(groupId, normalized, needRefundCandidates) {
  const rows = new Map();
  const queries = [];

  for (const ref of normalized.references.slice(0, 3)) {
    queries.push(supabase.from("transactions").select("*").eq("group_id", groupId).ilike("raw_message", `%${ref}%`).limit(10));
  }
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  queries.push(supabase.from("transactions").select("*").eq("group_id", groupId).eq("raw_message", normalized.raw.trim()).gte("created_at", since).limit(5));
  if (needRefundCandidates) {
    const from = new Date(Date.now() - 180 * 24 * 3600 * 1000).toISOString();
    queries.push(supabase.from("transactions").select("*").eq("group_id", groupId).gt("amount", 0).gte("created_at", from).order("created_at", { ascending: false }).limit(300));
  }

  // Run the lookups in parallel: one round-trip of added latency, not one per query.
  for (const res of await Promise.all(queries)) {
    if (res && res.error) console.error("Reconciliation lookup failed:", res.error.message);
    ((res && res.data) || []).forEach((r) => rows.set(r.id, r));
  }
  return [...rows.values()];
}

const summariseClassification = (r) => ({
  type: r.type, subtype: r.subtype, direction: r.direction, confidence: r.confidence,
  adapter: r.adapter, reasons: r.reasons, reference: r.reference, date: r.date,
  ...(r.link ? { link: r.link } : {}),
  ...(r.related && r.related.length ? { related: r.related } : {}),
});

const ignoreReason = (r) => {
  if (r.type === "unknown" || r.type === "info") return "Not a recognised transaction SMS, an OTP, or an own-account transfer";
  if (r.type === "duplicate") return "Duplicate: this SMS is already recorded";
  if (r.type === "transfer") return "Transfer between your own accounts: not counted as spending or income";
  if (r.type === "card_payment") return "Credit card bill payment: card purchases are recorded individually";
  return "Not recorded";
};

async function notifyReview(r, text) {
  const arrow = r.direction === "in" ? "received" : "paid";
  const body =
    `⚠️ Needs your review\n\nAmount - ${formatINR(r.amount)} (${arrow})\n` +
    (r.counterparty ? `Party - ${r.counterparty}\n` : "") +
    `Why - ${r.review ? r.review.reason : "Low confidence"}\n\n` +
    `Not recorded. If it's yours, add it manually, e.g. *${Math.round(r.amount)} <what it was for>*.\n\n` +
    `SMS: ${text.replace(/\s+/g, " ").slice(0, 140)}`;
  return sendWhatsApp({ body });
}

async function notifyTransferPair(r) {
  const k = r.related && r.related[0];
  if (!k) return { sent: false };
  const body =
    `↔️ Looks like a transfer between your own accounts\n\nAmount - ${formatINR(r.amount)}\n` +
    `Same reference as an earlier entry: ${k.description} (${formatINR(k.amount)}).\n\n` +
    `This SMS was not counted. The earlier entry is still recorded: delete it if it isn't a real expense or income.`;
  return sendWhatsApp({ body });
}

// ══════════════════════════════════════════════════════════════════════════
// ── SMS WEBHOOK — called by iPhone Shortcut ────────────────────────────────
// POST /webhook/sms
// Body: { "text": "<raw SMS text>", "group_id": "<your group id>", "secret": "<SMS_SECRET>" }
// Flow: classify (./classifier) -> reconcile with existing rows -> record | ignore | flag for review.
// ══════════════════════════════════════════════════════════════════════════

app.post("/webhook/sms", async (req, res) => {
  // Simple secret to prevent abuse
  const secret = req.body.secret || req.headers["x-sms-secret"];
  if (process.env.SMS_SECRET && secret !== process.env.SMS_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const text = (req.body.text || "").trim();
  const groupId = req.body.group_id || process.env.DEFAULT_GROUP_ID;

  if (!text || !groupId) {
    return res.status(400).json({ error: "Missing text or group_id" });
  }

  try {
    const userConfig = getUserConfig(groupId);

    // Pass 1: no database. Anything clearly not a money movement returns immediately.
    let result = classifier.classify(text, userConfig, { now: new Date() });
    const NEEDS_CONTEXT = ["expense", "received", "refund", "investment"];
    if (NEEDS_CONTEXT.includes(result.type)) {
      // Pass 2: reconcile against existing rows (duplicates, own-account pairs, refund -> purchase link).
      const known = await fetchKnownTransactions(groupId, result.normalized, result.type === "refund");
      result = classifier.classify(text, userConfig, { now: new Date(), known });
    }
    const classification = summariseClassification(result);

    // ── Not recorded: informational, own transfer, card bill, duplicate ──
    if (result.action === "ignore") {
      let whatsapp;
      if (result.type === "transfer" && result.subtype === "reference_pair") whatsapp = await notifyTransferPair(result);
      return res.json({
        recorded: false,
        type: result.type,
        reason: ignoreReason(result),
        classification,
        ...(result.type === "duplicate" ? { duplicate: true } : {}),
        ...(whatsapp ? { whatsapp_sent: whatsapp.sent } : {}),
      });
    }

    // ── Ambiguous: never force a guess. Flag it and let the user decide ──
    if (result.action === "review") {
      const wa = await notifyReview(result, text);
      return res.json({
        recorded: false,
        needs_review: true,
        reason: result.review.reason,
        classification,
        whatsapp_sent: wa.sent,
        ...(wa.error ? { whatsapp_error: wa.error } : {}),
      });
    }

    // ── Record ──
    await supabase.from("groups").upsert({ id: groupId, name: groupId }, { onConflict: "id", ignoreDuplicates: true });

    const baseRow = {
      group_id: groupId,
      paid_by: "Me",
      raw_message: text,
      ...(result.reference ? { reference_id: result.reference } : {}),
      ...(result.date ? { transaction_date: result.date } : {}),
    };
    const saved = (row) => insertTransaction({ ...baseRow, ...row });
    const duplicateResponse = () =>
      res.json({ recorded: false, duplicate: true, type: "duplicate", reason: ignoreReason({ type: "duplicate" }), classification });

    // Received money (credits from people, NEFT/IMPS/ACH credits)
    if (result.type === "received") {
      const { data: txn, error } = await saved({ amount: result.signedAmount, description: result.merchant, category: "Received", transaction_type: "received" });
      if (error && error.code === "23505") return duplicateResponse();
      if (error) throw error;

      const reply =
        `${INCOME_EMOJI} Money received\n\nAmount - ${formatINR(result.amount)}\nFrom - ${result.merchant}` +
        (result.account ? `\nAccount - ${result.account}` : "");
      const wa = await sendWhatsApp({ body: reply });
      return res.json({
        recorded: true, type: "received", id: txn.id, amount: result.signedAmount, description: result.merchant,
        category: "Received", source: result.source, reply, classification,
        whatsapp_sent: wa.sent, ...(wa.error ? { whatsapp_error: wa.error } : {}),
      });
    }

    // Investments: own category, kept out of spending
    if (result.type === "investment") {
      const { data: txn, error } = await saved({ amount: result.signedAmount, description: result.merchant, category: "Investments", transaction_type: "investment" });
      if (error && error.code === "23505") return duplicateResponse();
      if (error) throw error;

      const label = result.subtype === "purchase" ? "Investment" : result.subtype === "dividend" ? "Dividend / interest" : "Investment redemption";
      const reply =
        `${emojiFor("Investments")} ${label} recorded\n\nAmount - ${formatINR(result.amount)}\n${result.subtype === "purchase" ? "To" : "From"} - ${result.merchant}\n` +
        `Category - Investments (not counted as spending or income)`;
      const wa = await sendWhatsApp({ body: reply });
      return res.json({
        recorded: true, type: "investment", subtype: result.subtype, id: txn.id, amount: result.signedAmount, description: result.merchant,
        category: "Investments", source: result.source, reply, classification,
        whatsapp_sent: wa.sent, ...(wa.error ? { whatsapp_error: wa.error } : {}),
      });
    }

    // Expenses and refunds
    const isRefund = result.type === "refund";
    let category;
    let description;
    if (isRefund && result.link) {
      // Linked refund: offsets the original purchase, in the original's category
      category = result.category;
      description = `Refund: ${result.link.description}`;
    } else {
      // Check whether this merchant/person has a previously saved category, else ask Claude
      const merchantKey = toMerchantKey(result.merchant);
      const { data: savedRule, error: savedRuleError } = await supabase
        .from("category_rules")
        .select("category")
        .eq("group_id", groupId)
        .eq("merchant_key", merchantKey)
        .maybeSingle();
      if (savedRuleError) throw savedRuleError;

      const categorized = savedRule
        ? { description: result.merchant, category: savedRule.category }
        : await categorizeMerchant(result.merchant, result.amount);
      category = categorized.category;
      description = isRefund ? `Refund: ${categorized.description}` : categorized.description;
    }

    const { data: transaction, error: insertError } = await saved({ amount: result.signedAmount, description, category });
    if (insertError && insertError.code === "23505") return duplicateResponse();
    if (insertError) throw insertError;

    let notification;
    if (isRefund) {
      const reply =
        `↩️ Refund recorded\n\nAmount - ${formatINR(result.amount)}\nFrom - ${description.replace(/^Refund: /, "")}\nCategory - ${category}` +
        (result.link ? `\nOffsets an earlier purchase of ${formatINR(result.link.original_amount)}` : "");
      const wa = await sendWhatsApp({ body: reply });
      notification = { reply, whatsapp_sent: wa.sent, whatsapp_error: wa.error };
    } else {
      // Concise WhatsApp notification (List Picker if category is "Other")
      notification = await notifyExpense({ groupId, txnId: transaction.id, amount: result.signedAmount, description, category });
    }

    res.json({
      recorded: true,
      type: isRefund ? "refund" : "expense",
      id: transaction.id,
      amount: result.signedAmount,
      description,
      category,
      source: result.source,
      reply: notification.reply,
      classification,
      ...(result.link ? { linked_txn_id: result.link.id } : {}),
      whatsapp_sent: notification.whatsapp_sent,
      ...(notification.whatsapp_error ? { whatsapp_error: notification.whatsapp_error } : {}),
    });
  } catch (err) {
    console.error("SMS webhook error:", err.message || err);
    res.status(500).json({ error: err.message });
  }
});

// ── Category correction helpers (used by the WhatsApp webhook) ─────────────

// Map List Picker option IDs to categories (case-insensitive)
const PICKER_OPTIONS = {
  food: "Food",
  transport: "Transport",
  entertainment: "Entertainment",
  others: "Others",
  other: "Others",
};

async function clearPendingCategory(groupId) {
  const { error } = await supabase
    .from("groups")
    .update({ pending_category_txn_id: null, awaiting_custom_category: false })
    .eq("id", groupId);
  if (error) throw error;
}

// The category rule must use the SAME key that the SMS webhook looks up,
// i.e. the merchant name parsed from the original bank SMS (not the AI label).
// Dictated / manual entries have no bank SMS, so no rule is saved for them.
function ruleKeyForTxn(txn) {
  const parsed = txn.raw_message ? parseSMS(txn.raw_message) : null;
  if (!parsed || parsed.type === "income" || parsed.type === "investment") return null;
  return toMerchantKey(parsed.merchant) || null;
}

// Updates the EXISTING pending transaction's category. Never inserts a row.
async function applyPendingCategory(groupId, txnId, category) {
  const { data: txn, error: txnError } = await supabase
    .from("transactions")
    .select("id, description, raw_message")
    .eq("id", txnId)
    .eq("group_id", groupId)
    .maybeSingle();

  if (txnError) throw txnError;

  if (!txn) {
    await clearPendingCategory(groupId);
    return "That transaction no longer exists (it may have been deleted), so nothing was changed.";
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ category })
    .eq("id", txnId)
    .eq("group_id", groupId);

  if (updateError) throw updateError;

  const merchantKey = ruleKeyForTxn(txn);
  if (merchantKey) {
    const { error: ruleError } = await supabase
      .from("category_rules")
      .upsert(
        { group_id: groupId, merchant_key: merchantKey, category, updated_at: new Date().toISOString() },
        { onConflict: "group_id,merchant_key" }
      );
    // The category itself is already updated, so a rule failure is logged, not fatal
    if (ruleError) console.error("Category rule save error:", ruleError.message);
  }

  await clearPendingCategory(groupId);
  return `${emojiFor(category)} Transaction category updated to ${category}.`;
}

// ── Twilio WhatsApp webhook ────────────────────────────────────────────────

app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = (req.body.Body || "").trim();
  const groupId = process.env.DEFAULT_GROUP_ID || "utkarsh";

  // Log only non-sensitive fields (no phone numbers or message text)
  console.log("WhatsApp webhook received:", {
    messageType: req.body.MessageType || null,
    listId: req.body.ListId || null,
  });

  try {
    const listId = (req.body.ListId || "").trim();

    // ── List Picker selection ──
    if (listId) {
      const choice = PICKER_OPTIONS[listId.toLowerCase()];

      if (!choice) {
        twiml.message("Sorry, I didn't recognise that option. Please pick a category from the list again.");
        return res.type("text/xml").send(twiml.toString());
      }

      const { data: group, error: groupError } = await supabase
        .from("groups")
        .select("pending_category_txn_id")
        .eq("id", groupId)
        .maybeSingle();

      if (groupError) throw groupError;

      if (!group?.pending_category_txn_id) {
        twiml.message("No pending transaction found to update.");
        return res.type("text/xml").send(twiml.toString());
      }

      if (choice === "Others") {
        const { error } = await supabase
          .from("groups")
          .update({ awaiting_custom_category: true })
          .eq("id", groupId);

        if (error) throw error;

        twiml.message("Please type your custom category (e.g. Shopping, Bills, Health).\n\nReply *cancel* to keep it as Other.");
        return res.type("text/xml").send(twiml.toString());
      }

      twiml.message(await applyPendingCategory(groupId, group.pending_category_txn_id, choice));
      return res.type("text/xml").send(twiml.toString());
    }

    // ── Custom category typed after choosing "Others" ──
    const { data: pendingGroup, error: pendingGroupError } = await supabase
      .from("groups")
      .select("pending_category_txn_id, awaiting_custom_category")
      .eq("id", groupId)
      .maybeSingle();

    if (pendingGroupError) throw pendingGroupError;

    if (pendingGroup?.awaiting_custom_category && pendingGroup?.pending_category_txn_id) {
      const customCategory = incomingMsg.trim();

      if (/^cancel$/i.test(customCategory)) {
        await clearPendingCategory(groupId);
        twiml.message("Cancelled. The category stays as Other.");
        return res.type("text/xml").send(twiml.toString());
      }

      if (!customCategory || customCategory.length > 40) {
        twiml.message("Please enter a valid category (maximum 40 characters), or reply *cancel*.");
        return res.type("text/xml").send(twiml.toString());
      }

      twiml.message(await applyPendingCategory(groupId, pendingGroup.pending_category_txn_id, customCategory));
      return res.type("text/xml").send(twiml.toString());
    }

    // ── Normal WhatsApp commands ──
    const intent = await classifyIntent(incomingMsg);

    if (intent.intent === "delete") {
      twiml.message(await handleDelete(intent, groupId));
    } else if (intent.intent === "edit") {
      twiml.message(await handleEdit(intent, groupId));
    } else if (intent.intent === "show") {
      twiml.message(await handleShow(intent, groupId));
    } else if (intent.intent === "query") {
      twiml.message(await handleQuery(incomingMsg, groupId));
    } else if (intent.intent === "expense") {
      const expenses = await parseExpenses(incomingMsg);

      if (!expenses.length) {
        twiml.message(
          "Hmm, I couldn't find any expenses in that message.\n\nTry:\n• *200 auto*, *500 groceries*\n• Multiple: 100 coffee, 299 netflix\n• Edit: *edit last to 300*\n• Delete: *delete last*\n• Ask: *biggest expense this month?*"
        );
      } else {
        await supabase.from("groups").upsert({ id: groupId, name: groupId }, { onConflict: "id", ignoreDuplicates: true });
        await supabase.from("transactions").insert(
          expenses.map((e) => ({
            group_id: groupId,
            amount: e.amount,
            description: e.description,
            category: e.category,
            paid_by: e.paid_by || "Me",
            raw_message: incomingMsg,
          }))
        );
        const reply = await buildExpenseReply(expenses, groupId);
        twiml.message(reply);
      }
    } else {
      twiml.message(
        "I didn't understand that.\n\nYou can:\n• Log: *200 auto*, *500 groceries, 299 netflix*\n• Edit: *edit last to 300*\n• Edit field: *edit last category to Food*\n• Delete: *delete last*\n• List: *show last 5*\n• Ask: *biggest expense this month?*, *how much on food?*"
      );
    }
  } catch (err) {
    console.error("Webhook error:", err.message || err);
    twiml.message("Something went wrong. Please try again.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── VOICE EXPENSE API — called by iPhone Dictation Shortcut ─────────────────
// POST /api/voice-expense
// Body: { "text": "<spoken words>", "group_id": "utkarsh", "secret": "<VOICE_SECRET>" }

app.post("/api/voice-expense", async (req, res) => {
  const secret = req.body.secret || req.headers["x-voice-secret"];

  if (!process.env.VOICE_SECRET) {
    return res.status(503).json({ error: "Voice logging is not configured." });
  }

  if (secret !== process.env.VOICE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const text = (req.body.text || "").trim();
  const groupId = req.body.group_id || process.env.DEFAULT_GROUP_ID;

  if (!text || !groupId) {
    return res.status(400).json({ error: "Missing spoken text or group_id" });
  }

  try {
    // Reuse the existing Claude expense parser to support one or multiple expenses.
    const parsedExpenses = await parseExpenses(text);
    const allowedCategories = ["Food", "Transport", "Shopping", "Entertainment", "Health", "Bills", "Other"];

    const expenses = parsedExpenses
      .filter((e) =>
        Number.isFinite(Number(e.amount)) &&
        Number(e.amount) > 0 &&
        typeof e.description === "string" &&
        e.description.trim()
      )
      .map((e) => ({
        group_id: groupId,
        amount: Number(e.amount),
        description: e.description.trim().slice(0, 80),
        category: allowedCategories.includes(e.category) ? e.category : "Other",
        paid_by: e.paid_by || "Me",
        raw_message: `Voice: ${text}`,
      }));

    if (!expenses.length) {
      return res.status(422).json({
        recorded: false,
        error: "I couldn't identify an expense. Try saying the amount and what it was for.",
      });
    }

    const { error: groupError } = await supabase
      .from("groups")
      .upsert(
        { id: groupId, name: groupId },
        { onConflict: "id", ignoreDuplicates: true }
      );
    if (groupError) throw groupError;

    const { data, error: insertError } = await supabase
      .from("transactions")
      .insert(expenses)
      .select("id, amount, description, category, paid_by, created_at");

    if (insertError) throw insertError;

    const total = data.reduce((sum, item) => sum + Number(item.amount), 0);

    // WhatsApp confirmation. A WhatsApp failure does not undo an expense already saved in Supabase.
    let whatsappSent = false;
    let whatsappError = null;
    let categoryPickerSent = false;
    let confirmationMessage;

    if (data.length === 1) {
      // Single expense: same format as bank SMS — category emoji, and List Picker if "Other"
      const item = data[0];
      const notification = await notifyExpense({
        groupId,
        txnId: item.id,
        amount: item.amount,
        description: item.description,
        category: item.category,
      });
      confirmationMessage = notification.reply;
      whatsappSent = notification.whatsapp_sent;
      whatsappError = notification.whatsapp_error || null;
      categoryPickerSent = Boolean(notification.category_picker_sent);
    } else {
      // Several expenses: one summary with each item's category emoji
      const others = data.filter((item) => item.category === "Other");

      confirmationMessage =
        `✅ ${data.length} expenses recorded\n\n` +
        data.map((item) => `${emojiFor(item.category)} ₹${Number(item.amount).toLocaleString("en-IN")} - ${item.description} (${item.category})`).join("\n") +
        `\n\nTotal - ₹${total.toLocaleString("en-IN")}`;

      if (others.length > 1) {
        confirmationMessage += `\n\n${others.length} items are in Other. You'll get a category picker for *${others[0].description}*; change the rest from the dashboard.`;
      }

      const wa = await sendWhatsApp({ body: confirmationMessage });
      whatsappSent = wa.sent;
      whatsappError = wa.error || null;

      // Only one transaction can await a category choice at a time — use the first "Other" one
      if (others.length) {
        const picker = await requestCategoryPicker({
          groupId,
          txnId: others[0].id,
          amount: others[0].amount,
          description: others[0].description,
        });
        categoryPickerSent = picker.sent;
        if (!picker.sent) {
          whatsappError = [whatsappError, `Category picker not sent: ${picker.error}`].filter(Boolean).join(" | ");
        }
      }
    }

    return res.json({
      recorded: true,
      count: data.length,
      total,
      transactions: data,
      whatsapp_sent: whatsappSent,
      category_picker_sent: categoryPickerSent,
      ...(whatsappError ? { whatsapp_error: whatsappError } : {}),
      message: data.length === 1
        ? `Saved ₹${total.toLocaleString("en-IN")} for ${data[0].description}.`
        : `Saved ${data.length} expenses totalling ₹${total.toLocaleString("en-IN")}.`,
    });

  } catch (err) {
    console.error("Voice expense error:", err.message || err);
    return res.status(500).json({ error: "Could not save the voice expense." });
  }
});

// ── REST API ───────────────────────────────────────────────────────────────

app.get("/api/groups", async (req, res) => {
  const { data, error } = await supabase.from("groups").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ?type=expense (default — same as before, income excluded) | income | all
app.get("/api/transactions", async (req, res) => {
  const { group_id, month, type } = req.query;
  let query = supabase.from("transactions").select("*").order("created_at", { ascending: false });
  if (group_id) query = query.eq("group_id", group_id);
  if (month) {
    const [y, m] = month.split("-");
    query = query.gte("created_at", new Date(y, m - 1, 1).toISOString()).lt("created_at", new Date(y, m, 1).toISOString());
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const rows = data || [];
  if (type === "all") return res.json(rows);
  if (type === "income" || type === "received") return res.json(rows.filter(isReceived));
  if (type === "investment" || type === "investments") return res.json(rows.filter(isInvestment));
  res.json(rows.filter(isSpend));
});

app.post("/api/transactions", async (req, res) => {
  const { group_id, amount, description, category, paid_by } = req.body;
  if (!group_id || !amount || !description || !category) return res.status(400).json({ error: "Missing required fields" });
  const insertData = { group_id, amount: parseFloat(amount), description, category, paid_by: paid_by || "Me", raw_message: null };
  if (req.body.created_at) insertData.transaction_date = req.body.created_at.slice(0, 10);
  await supabase.from("groups").upsert({ id: group_id, name: group_id }, { onConflict: "id", ignoreDuplicates: true });
  const { data, error } = await supabase.from("transactions").insert(insertData).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch("/api/transactions/:id", async (req, res) => {
  const { description, amount, category, transaction_date } = req.body;
  const updates = {};
  if (description) updates.description = description;
  if (amount) updates.amount = parseFloat(amount);
  if (category) updates.category = category;
  if (transaction_date) updates.transaction_date = transaction_date;
  const { data, error } = await supabase.from("transactions").update(updates).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/transactions/:id", async (req, res) => {
  const { error } = await supabase.from("transactions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/api/limits", async (req, res) => {
  const { group_id } = req.query;
  const { data, error } = await supabase.from("limits").select("*").eq("group_id", group_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post("/api/limits", async (req, res) => {
  const { group_id, category, amount } = req.body;
  const { data, error } = await supabase
    .from("limits")
    .upsert({ group_id, category, amount: parseFloat(amount) }, { onConflict: "group_id,category" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete("/api/limits/:id", async (req, res) => {
  const { error } = await supabase.from("limits").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

app.get("/api/summary", async (req, res) => {
  const { group_id, month } = req.query;
  const [y, m] = (month || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`).split("-");
  const start = new Date(y, m - 1, 1).toISOString();
  const end = new Date(y, m, 1).toISOString();
  const [{ data: allTxns }, { data: limits }] = await Promise.all([
    supabase.from("transactions").select("*").eq("group_id", group_id).gte("created_at", start).lt("created_at", end),
    supabase.from("limits").select("*").eq("group_id", group_id),
  ]);

  // Spending figures exclude received money and investments; both are returned separately (additive fields)
  const txns = (allTxns || []).filter(isSpend);
  const incomeTxns = (allTxns || []).filter(isReceived);
  const investTxns = (allTxns || []).filter(isInvestment);

  const total = txns.reduce((s, t) => s + t.amount, 0);
  const byCategory = {}, byPerson = {}, byDay = {};
  for (const t of txns) {
    byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    byPerson[t.paid_by] = (byPerson[t.paid_by] || 0) + t.amount;
    const day = (t.transaction_date || t.created_at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + t.amount;
  }
  const incomeTotal = incomeTxns.reduce((s, t) => s + t.amount, 0);

  res.json({
    total,
    byCategory,
    byPerson,
    byDay,
    limits: limits || [],
    count: txns.length,
    incomeTotal,
    incomeCount: incomeTxns.length,
    receivedTotal: incomeTotal,
    receivedCount: incomeTxns.length,
    investmentTotal: investTxns.reduce((s, t) => s + t.amount, 0),   // net: purchases minus redemptions/dividends
    investmentCount: investTxns.length,
  });
});

app.post("/api/insights", async (req, res) => {
  const { total, byCategory, limitsInfo, income, transactions, month } = req.body;
  const topCats = Object.entries(byCategory || {}).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([c, a]) => `${c}: ₹${Math.round(a).toLocaleString("en-IN")}`).join(", ");

  const prompt = `You are a personal finance advisor analysing someone's spending data. Be specific, helpful, and direct. Use Indian Rupee (₹) for all amounts.

Month: ${month}
Total expenses: ₹${Math.round(total || 0).toLocaleString("en-IN")}
${income > 0 ? `Monthly income: ₹${Math.round(income).toLocaleString("en-IN")}, Savings: ₹${Math.round(income - (total || 0)).toLocaleString("en-IN")} (${Math.round(((income - (total || 0)) / income) * 100)}%)` : "Income not set"}
Spending by category: ${topCats}
${limitsInfo ? `Budget limits: ${limitsInfo}` : "No budget limits set"}
Recent transactions: ${(transactions || []).slice(0, 15).map(t => `${t.description} ₹${t.amount}`).join(", ")}

Generate exactly 4 financial insights as a JSON array. Each insight must be specific to THIS data.
Return ONLY a JSON array, no markdown:
[{"icon":"emoji","type":"good|warn|tip","title":"short title","body":"2-3 sentence specific insight with numbers"}]`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });
    const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error("Insights error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Paisa Tracker backend running on port ${PORT}`));
