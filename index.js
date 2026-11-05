require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Payees ignored by the SMS parser (uppercase substrings)
const INTERNAL_TRANSFER_PAYEES = ["UTKARSH SINGHVI"];

// ── SMS Parser — HDFC/ICICI cards, UPI, UPI Lite, refunds & reversals ─────────────────────
function parseSMS(text) {
  // Skip OTP messages entirely
  if (/\bOTP\b/i.test(text) || /one.?time.?pass/i.test(text)) {
    return null;
  }

  let amount = null;
  let merchant = null;
  let source = null;
  let refund = false;

  // ── HDFC Credit Card ──────────────────────────────────────────────────────
  // "Spent Rs.1729 On HDFC Bank Card 3604 At ZEPTO MARKETPLACE PRIV On 2026-10-19"
  const hdfcCC = text.match(/Spent\s+Rs\.?([\d,]+(?:\.\d+)?)\s+On\s+HDFC\s+Bank\s+Card\s+(\d+)\s+At\s+(.+?)\s+On\s+\d{4}/i);
  if (hdfcCC) {
    amount = parseFloat(hdfcCC[1].replace(/,/g, ""));
    merchant = hdfcCC[3].trim();
    source = `HDFC Card ${hdfcCC[2]}`;
  }

  // ── ICICI UPI ─────────────────────────────────────────────────────────────
  // "ICICI Bank Acct XX639 debited for Rs 129.00 on 17-Oct-26; NAGAMMA NAGAMMA credited."
  if (!amount) {
    const iciciBankUPI = text.match(/ICICI\s+Bank\s+Acct\s+\w+\s+debited\s+for\s+Rs\s+([\d,]+(?:\.\d+)?)\s+on\s+[\w-]+;\s+(.+?)\s+credited/i);
    if (iciciBankUPI) {
      amount = parseFloat(iciciBankUPI[1].replace(/,/g, ""));
      merchant = iciciBankUPI[2].trim();
      source = "ICICI UPI";
    }
  }

  // ── ICICI Credit Card ─────────────────────────────────────────────────────
  // "INR 125.00 spent using ICICI Bank Card XX0000 on 13-Oct-26 on AMAZON PAY IN G."
  if (!amount) {
    const iciciCC = text.match(/INR\s+([\d,]+(?:\.\d+)?)\s+spent\s+using\s+ICICI\s+Bank\s+Card\s+\w+\s+on\s+[\w-]+\s+on\s+(.+?)(?:\.|Avl|$)/i);
    if (iciciCC) {
      amount = parseFloat(iciciCC[1].replace(/,/g, ""));
      merchant = iciciCC[2].trim();
      source = "ICICI Card";
    }
  }

  // ── HDFC UPI ─────────────────────────────────────────────────────────────
  // "Sent Rs.1.00 From HDFC Bank A/C *6264 To UTKARSH SINGHVI On 05/11/26 Ref ..."
  if (!amount) {
    const hdfcUPI = text.match(/Sent\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s+From\s+HDFC\s+Bank\s+A\/C\s+\*?\w+\s+To\s+([\s\S]+?)\s+On\s+\d{1,2}\/\d{1,2}\/\d{2,4}/i);
    if (hdfcUPI) {
      amount = parseFloat(hdfcUPI[1].replace(/,/g, ""));
      merchant = hdfcUPI[2].trim();
      source = "HDFC UPI";
    }
  }

  // ── ICICI Credit Card (alternate wording) ────────────────────────────────
  // "Rs 36,287.00 spent on ICICI Bank Card XX0000 on 30-Oct-26 at AMAZON PAY IN E. Avl Lmt..."
  if (!amount) {
    const m = text.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)\s+spent\s+on\s+ICICI\s+Bank\s+Card\s+\w+\s+on\s+[\w-]+\s+at\s+(.+?)(?:\.\s|\.?\s*Avl|$)/i);
    if (m) { amount = parseFloat(m[1].replace(/,/g, "")); merchant = m[2].trim(); source = "ICICI Card"; }
  }

  // ── HDFC Credit Card (no-OTP / autopay wording) ──────────────────────────
  // "Amount Spent: Rs.119 with HDFC Bank Credit Card 3604 at SPOTIFYINDIA on 2026-09-26..."
  if (!amount) {
    const m = text.match(/Amount\s+Spent:\s*Rs\.?\s*([\d,]+(?:\.\d+)?)\s+with\s+HDFC\s+Bank\s+Credit\s+Card\s+\d+\s+at\s+(.+?)\s+on\s+\d{4}/i);
    if (m) { amount = parseFloat(m[1].replace(/,/g, "")); merchant = m[2].trim(); source = "HDFC Card"; }
  }

  // ── ICICI UPI Lite (daily summary) ────────────────────────────────────────
  // "You have carried out 1 transactions worth Rs 80 using your UPI Lite Wallet/s on 30-SEP-26"
  if (!amount) {
    const m = text.match(/carried\s+out\s+\d+\s+transactions?\s+worth\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s+using\s+your\s+UPI\s+Lite/i);
    if (m) { amount = parseFloat(m[1].replace(/,/g, "")); merchant = "UPI Lite payments"; source = "ICICI UPI Lite"; }
  }

  // ── Refunds / reversals (logged as negative amounts) ─────────────────────
  if (!amount) {
    // HDFC: "Alert! Rs. 2063 refunded by PYU*MYNTRA DESIGNS PRI Bangalore     IND on 20/OCT/2026"
    let m = text.match(/Rs\.?\s*([\d,]+(?:\.\d+)?)\s+refunded\s+by\s+(.+?)\s+on\s+\d{1,2}\//i);
    if (m) { amount = parseFloat(m[1].replace(/,/g, "")); merchant = m[2].slice(0, 23).trim(); source = "HDFC Card refund"; refund = true; }
    // HDFC: "Transaction Reversed!On HDFC Bank CREDIT Card xx3604 Amt: Rs.209.34 By UBER INDIA SYSTEMS On 2026-..."
    if (!m) {
      m = text.match(/Transaction\s+Reversed!.*?Amt:\s*Rs\.?\s*([\d,]+(?:\.\d+)?)\s+By\s+(.+?)\s+On\s+\d{4}/i);
      if (m) { amount = parseFloat(m[1].replace(/,/g, "")); merchant = m[2].trim(); source = "HDFC Card reversal"; refund = true; }
    }
    // ICICI: "AMAZON PAY IN E COMMERC refund of Rs 2,099.00 credited to ICICI Bank Credit Card XX0000"
    if (!m) {
      m = text.match(/^(.+?)\s+refund\s+of\s+Rs\.?\s*([\d,]+(?:\.\d+)?)\s+credited\s+to\s+ICICI\s+Bank\s+Credit\s+Card/i);
      if (m) { amount = parseFloat(m[2].replace(/,/g, "")); merchant = m[1].trim(); source = "ICICI Card refund"; refund = true; }
    }
  }

  if (!amount || !merchant) return null;

  // Skip payees that aren't real spending (edit this list as needed):
  // own-account transfers, and credit card bill payments (card spends are already logged individually)
  const isInternalTransfer = INTERNAL_TRANSFER_PAYEES.some(
  (p) => merchant.toUpperCase().includes(p)
);

  // Clean up merchant name — remove trailing noise words
  merchant = merchant
    .replace(/\s+(PRIV|PVT|LTD|INDIA|PRIVATE|SERVICES?|SOLUTIONS?|SERV)\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  // Truncate if too long
  if (merchant.length > 40) merchant = merchant.substring(0, 40).trim();

  return { amount, merchant, source, refund, isInternalTransfer };
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
    return `${i + 1}. *₹${t.amount.toLocaleString("en-IN")}* — ${t.description} (${t.category}) · ${date}`;
  });
  return `📋 *Last ${txns.length} transactions:*\n\n${lines.join("\n")}`;
}

// ── Handle query ───────────────────────────────────────────────────────────
async function handleQuery(question, groupId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const [{ data: txns }, { data: limits }] = await Promise.all([
    supabase.from("transactions").select("*").eq("group_id", groupId).gte("created_at", monthStart).order("created_at", { ascending: false }),
    supabase.from("limits").select("*").eq("group_id", groupId),
  ]);
  if (!txns || !txns.length) return "No transactions found for this month yet.";
  const total = txns.reduce((s, t) => s + t.amount, 0);
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
  const prompt = `You are a personal finance assistant. Answer this question about the user's expenses concisely in 2-4 lines. Use ₹ for amounts. Be specific with numbers.

This month's data:
- Total spent: ₹${Math.round(total).toLocaleString("en-IN")} across ${txns.length} transactions
- By category: ${catSummary}
- Top transactions: ${top10}
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
  const { data: txns } = await supabase
    .from("transactions")
    .select("amount, category")
    .eq("group_id", groupId)
    .gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  const totalSpent = (txns || []).reduce((s, t) => s + t.amount, 0);
  const overallLimit = (limits || []).find((l) => l.category === "overall");
  const catSpent = (cat) => (txns || []).filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0);

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

// ══════════════════════════════════════════════════════════════════════════
// ── SMS WEBHOOK — called by iPhone Shortcut ────────────────────────────────
// POST /webhook/sms
// Body: { "text": "<raw SMS text>", "group_id": "<your group id>", "secret": "<SMS_SECRET>" }
// ══════════════════════════════════════════════════════════════════════════
app.post("/webhook/sms", async (req, res) => {
  console.log("SMS WEBHOOK BODY:", JSON.stringify(req.body));
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

  // Parse the SMS with regex first (fast, no API cost)
  const parsed = parseSMS(text);

  if (!parsed) {
    return res.json({ recorded: false, reason: "Not a debit transaction or OTP" });
  }

  try {
    // Use Claude to get a clean description and category
    // Check whether this merchant/person has a previously saved category
const merchantKey = parsed.merchant
  .toLowerCase()
  .replace(/\bstore\b/g, "")
  .replace(/\s+/g, " ")
  .trim();

const { data: savedRule, error: savedRuleError } = await supabase
  .from("category_rules")
  .select("category")
  .eq("group_id", groupId)
  .eq("merchant_key", merchantKey)
  .maybeSingle();

if (savedRuleError) throw savedRuleError;

let categorized;

if (savedRule) {
  categorized = {
    description: parsed.merchant,
    category: savedRule.category,
  };
} else {
  categorized = await categorizeMerchant(parsed.merchant, parsed.amount);
}

    // Upsert group
    await supabase.from("groups").upsert(
      { id: groupId, name: groupId },
      { onConflict: "id", ignoreDuplicates: true }
    );

    // Insert transaction
    const signedAmount = parsed.refund ? -parsed.amount : parsed.amount;
    const description = parsed.refund ? `Refund: ${categorized.description}` : categorized.description;

    const { data: transaction, error: insertError } = await supabase
  .from("transactions")
  .insert({
    group_id: groupId,
    amount: signedAmount,
    description,
    category: categorized.category,
    paid_by: "Me",
    raw_message: text,
  })
  .select("id")
  .single();

if (insertError) throw insertError;

    // Send concise WhatsApp notification via Twilio
let reply;

if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_WHATSAPP_FROM &&
  process.env.TWILIO_WHATSAPP_TO
) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
const categoryEmoji = {
  Food: "🍔",
  Transport: "🚕",
  Shopping: "🛍️",
  Entertainment: "🎬",
  Health: "💊",
  Bills: "🧾",
  "Friends and family": "👥",
  Other: "💳",
};

const emoji = categoryEmoji[categorized.category] || "💳";
  if (categorized.category === "Other") {
    const { error: pendingError } = await supabase
      .from("groups")
      .update({
        pending_category_txn_id: transaction.id,
        awaiting_custom_category: false,
      })
      .eq("id", groupId);

    if (pendingError) throw pendingError;

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
      contentSid: process.env.TWILIO_LIST_PICKER_CONTENT_SID,
      contentVariables: JSON.stringify({
  "1": `₹${Math.abs(signedAmount).toLocaleString("en-IN")}`,
  "2": description,
}),
    });

    reply = `Auto-logged ₹${Math.abs(signedAmount).toLocaleString("en-IN")} - Other. Category correction requested.`;
  } else {
    reply = `${emoji} Expense recorded\n\nAmount - ₹${Math.abs(signedAmount).toLocaleString("en-IN")}\nPayee - ${description}\nCategory - ${categorized.category}`;
    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: process.env.TWILIO_WHATSAPP_TO,
      body: reply,
    });
  }
} else {
  reply = `₹${Math.abs(signedAmount).toLocaleString("en-IN")} - ${categorized.category}`;
}

    res.json({
      recorded: true,
      amount: signedAmount,
      description,
      category: categorized.category,
      source: parsed.source,
      reply,
    });

  } catch (err) {
    console.error("SMS webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Twilio WhatsApp webhook ────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = (req.body.Body || "").trim();
  console.log("WHATSAPP WEBHOOK PAYLOAD:", JSON.stringify(req.body));
  const from = req.body.From || "whatsapp:unknown";
  const groupId = process.env.DEFAULT_GROUP_ID || "utkarsh";

  try {
  const listId = (req.body.ListId || "").trim();

  if (listId) {
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

    if (listId === "Others") {
      const { error } = await supabase
        .from("groups")
        .update({ awaiting_custom_category: true })
        .eq("id", groupId);

      if (error) throw error;

      twiml.message("Please type your custom category (e.g. Shopping, Bills, Health).");
      return res.type("text/xml").send(twiml.toString());
    }

    const allowedCategories = ["Food", "Transport", "Entertainment"];

    if (allowedCategories.includes(listId)) {
      const { error: updateError } = await supabase
        .from("transactions")
        .update({ category: listId })
        .eq("id", group.pending_category_txn_id)
        .eq("group_id", groupId);

      if (updateError) throw updateError;
      const { data: pendingTxn, error: pendingTxnError } = await supabase
  .from("transactions")
  .select("description")
  .eq("id", group.pending_category_txn_id)
  .eq("group_id", groupId)
  .maybeSingle();

if (pendingTxnError) throw pendingTxnError;

if (pendingTxn?.description) {
  const merchantKey = pendingTxn.description
  .toLowerCase()
  .replace(/\bstore\b/g, "")
  .replace(/\s+/g, " ")
  .trim();

  const { error: ruleError } = await supabase
    .from("category_rules")
    .upsert(
      {
        group_id: groupId,
        merchant_key: merchantKey,
        category: listId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "group_id,merchant_key" }
    );

  if (ruleError) throw ruleError;
}

      const { error: clearError } = await supabase
        .from("groups")
        .update({
          pending_category_txn_id: null,
          awaiting_custom_category: false,
        })
        .eq("id", groupId);

      if (clearError) throw clearError;

      twiml.message(`Transaction category updated to ${listId}.`);
      return res.type("text/xml").send(twiml.toString());
    }
  }
  const { data: pendingGroup, error: pendingGroupError } = await supabase
    .from("groups")
    .select("pending_category_txn_id, awaiting_custom_category")
    .eq("id", groupId)
    .maybeSingle();

  if (pendingGroupError) throw pendingGroupError;

  if (pendingGroup?.awaiting_custom_category && pendingGroup?.pending_category_txn_id) {
    const customCategory = incomingMsg.trim();

    if (!customCategory || customCategory.length > 40) {
      twiml.message("Please enter a valid category (maximum 40 characters).");
      return res.type("text/xml").send(twiml.toString());
    }

    const { error: updateError } = await supabase
      .from("transactions")
      .update({ category: customCategory })
      .eq("id", pendingGroup.pending_category_txn_id)
      .eq("group_id", groupId);

    if (updateError) throw updateError;
    const { data: pendingTxn, error: pendingTxnError } = await supabase
  .from("transactions")
  .select("description")
  .eq("id", pendingGroup.pending_category_txn_id)
  .eq("group_id", groupId)
  .maybeSingle();

if (pendingTxnError) throw pendingTxnError;

if (pendingTxn?.description) {
  const merchantKey = pendingTxn.description
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  const { error: ruleError } = await supabase
    .from("category_rules")
    .upsert(
      {
        group_id: groupId,
        merchant_key: merchantKey,
        category: customCategory,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "group_id,merchant_key" }
    );

  if (ruleError) throw ruleError;
}

    const { error: clearError } = await supabase
      .from("groups")
      .update({
        pending_category_txn_id: null,
        awaiting_custom_category: false,
      })
      .eq("id", groupId);

    if (clearError) throw clearError;

    twiml.message(`Transaction category updated to ${customCategory}.`);
    return res.type("text/xml").send(twiml.toString());
  }
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
    console.error("Webhook error:", err);
    twiml.message("Something went wrong. Please try again.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── REST API ───────────────────────────────────────────────────────────────
app.get("/api/groups", async (req, res) => {
  const { data, error } = await supabase.from("groups").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/api/transactions", async (req, res) => {
  const { group_id, month } = req.query;
  let query = supabase.from("transactions").select("*").order("created_at", { ascending: false });
  if (group_id) query = query.eq("group_id", group_id);
  if (month) {
    const [y, m] = month.split("-");
    query = query.gte("created_at", new Date(y, m - 1, 1).toISOString()).lt("created_at", new Date(y, m, 1).toISOString());
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
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
  const [{ data: txns }, { data: limits }] = await Promise.all([
    supabase.from("transactions").select("*").eq("group_id", group_id).gte("created_at", start).lt("created_at", end),
    supabase.from("limits").select("*").eq("group_id", group_id),
  ]);
  const total = (txns || []).reduce((s, t) => s + t.amount, 0);
  const byCategory = {}, byPerson = {}, byDay = {};
  for (const t of txns || []) {
    byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    byPerson[t.paid_by] = (byPerson[t.paid_by] || 0) + t.amount;
    const day = (t.transaction_date || t.created_at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + t.amount;
  }
  res.json({ total, byCategory, byPerson, byDay, limits: limits || [], count: (txns || []).length });
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
