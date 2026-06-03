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

// ── Parse one or many expenses with Claude ────────────────────────────────
async function parseExpenses(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You parse expense messages. The message may contain ONE or MULTIPLE expenses separated in ANY way — new lines, commas, full stops, semicolons, pipes, dashes, or any other separator. Use context and amounts to identify individual expenses.
Return ONLY a JSON array, no markdown, no explanation.

Each item in the array must follow this schema:
{"amount": <number>, "description": "<2-4 word label>", "category": "<one of: Food, Transport, Shopping, Entertainment, Health, Bills, Other>", "paid_by": "<name if mentioned, else null>"}

Rules:
- amount must be a positive number in INR
- description must be short and clean
- Split smartly — "500 groceries, 299 netflix, 100 coffee" is 3 expenses
- "groceries", "sabzi", "vegetables", "fruits", "kirana", "supermarket", "BigBasket", "Zepto", "Blinkit", "Swiggy Instamart" always go to Food category
- Skip anything that is clearly not an expense
- If nothing is an expense at all, return []
- Always return an array, even for a single expense

Message:
${text}`,
      },
    ],
  });

  const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── Classify message intent ───────────────────────────────────────────────
async function classifyIntent(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: `Classify this WhatsApp message intent. Return ONLY a JSON object, no markdown.

Intents: "expense" | "edit" | "delete" | "show" | "unknown"

For "edit": include field ("amount"|"description"|"category"|"paid_by"), value (new value), target ("last" or number)
For "delete": include target ("last" or number like 2 for second-last)
For "show": include count (default 5)

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
"200 auto" -> {"intent":"expense"}
"500 groceries, 299 netflix" -> {"intent":"expense"}

Message: "${text}"`
    }]
  });
  const raw = msg.content[0].text.trim().replace(/\`\`\`json|\`\`\`/g, "").trim();
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
  return `📋 *Last ${txns.length} transactions:*

${lines.join("
")}`;
}

// ── Twilio WhatsApp webhook ────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = (req.body.Body || "").trim();
  const from = req.body.From || "whatsapp:unknown";
  const groupId = from.replace("whatsapp:", "").replace(/\D/g, "");

  try {
    // Classify intent first
    const intent = await classifyIntent(incomingMsg);

    if (intent.intent === "delete") {
      const reply = await handleDelete(intent, groupId);
      twiml.message(reply);

    } else if (intent.intent === "edit") {
      const reply = await handleEdit(intent, groupId);
      twiml.message(reply);

    } else if (intent.intent === "show") {
      const reply = await handleShow(intent, groupId);
      twiml.message(reply);

    } else if (intent.intent === "expense") {
      const expenses = await parseExpenses(incomingMsg);

      if (!expenses.length) {
        twiml.message(
          "Hmm, I couldn't find any expenses in that message.\n\nTry:\n• *200 rupees auto*\n• *500 groceries*\n• Multiple at once: 100 coffee, 299 netflix\n\nTo edit/delete: *edit last to 300* or *delete last*"
        );
      } else {
        // Upsert group
        await supabase.from("groups").upsert({ id: groupId, name: groupId }, { onConflict: "id", ignoreDuplicates: true });

        // Insert all expenses
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

        // Fetch fresh totals + limits after insert
        const { data: limits } = await supabase.from("limits").select("*").eq("group_id", groupId);
        const { data: txns } = await supabase
          .from("transactions")
          .select("amount, category")
          .eq("group_id", groupId)
          .gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

        const totalSpent = (txns || []).reduce((s, t) => s + t.amount, 0);
        const overallLimit = (limits || []).find((l) => l.category === "overall");
        const catSpent = (cat) =>
          (txns || []).filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0);

        const lines = [];
        const seenCats = new Set();

        for (const e of expenses) {
          lines.push(`✅ *₹${e.amount.toLocaleString("en-IN")}* — ${e.description} (${e.category})`);
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

        twiml.message(lines.join("\n"));
      }

    } else {
      twiml.message(
        "I didn't understand that.\n\nYou can:\n• Log expenses: *200 auto*, *500 groceries*\n• Edit last: *edit last to 300*\n• Edit field: *edit last category to Food*\n• Delete: *delete last*\n• See recent: *show last 5*"
      );
    }

  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("Something went wrong. Please try again.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── REST API for dashboard ─────────────────────────────────────────────────

// GET /api/groups
app.get("/api/groups", async (req, res) => {
  const { data, error } = await supabase.from("groups").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/transactions?group_id=&month=2026-06
app.get("/api/transactions", async (req, res) => {
  const { group_id, month } = req.query;
  let query = supabase.from("transactions").select("*").order("created_at", { ascending: false });
  if (group_id) query = query.eq("group_id", group_id);
  if (month) {
    const [y, m] = month.split("-");
    const start = new Date(y, m - 1, 1).toISOString();
    const end = new Date(y, m, 1).toISOString();
    query = query.gte("created_at", start).lt("created_at", end);
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/transactions — manual entry from website
app.post("/api/transactions", async (req, res) => {
  const { group_id, amount, description, category, paid_by } = req.body;
  if (!group_id || !amount || !description || !category) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  await supabase.from("groups").upsert({ id: group_id, name: group_id }, { onConflict: "id", ignoreDuplicates: true });
  const insertData = { group_id, amount: parseFloat(amount), description, category, paid_by: paid_by || "Me", raw_message: null };
  if (req.body.created_at) insertData.transaction_date = req.body.created_at.slice(0,10);
  const { data, error } = await supabase
    .from("transactions")
    .insert(insertData)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /api/transactions/:id — edit description, amount, category, date
app.patch("/api/transactions/:id", async (req, res) => {
  const { description, amount, category, transaction_date } = req.body;
  const updates = {};
  if (description) updates.description = description;
  if (amount) updates.amount = parseFloat(amount);
  if (category) updates.category = category;
  if (transaction_date) updates.transaction_date = transaction_date;
  const { data, error } = await supabase.from("transactions").update(updates).eq("id", req.params.id).select().single();
  if (error) { console.error("PATCH error:", error); return res.status(500).json({ error: error.message }); }
  res.json(data);
});

// DELETE /api/transactions/:id
app.delete("/api/transactions/:id", async (req, res) => {
  const { error } = await supabase.from("transactions").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/limits?group_id=
app.get("/api/limits", async (req, res) => {
  const { group_id } = req.query;
  const { data, error } = await supabase.from("limits").select("*").eq("group_id", group_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/limits
app.post("/api/limits", async (req, res) => {
  const { group_id, category, amount } = req.body;
  const { data, error } = await supabase
    .from("limits")
    .upsert({ group_id, category, amount: parseFloat(amount) }, { onConflict: "group_id,category" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/limits/:id
app.delete("/api/limits/:id", async (req, res) => {
  const { error } = await supabase.from("limits").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// GET /api/summary?group_id=&month=
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
  const byCategory = {};
  const byPerson = {};
  const byDay = {};

  for (const t of txns || []) {
    byCategory[t.category] = (byCategory[t.category] || 0) + t.amount;
    byPerson[t.paid_by] = (byPerson[t.paid_by] || 0) + t.amount;
    const day = (t.transaction_date || t.created_at).slice(0, 10);
    byDay[day] = (byDay[day] || 0) + t.amount;
  }

  res.json({ total, byCategory, byPerson, byDay, limits: limits || [], count: (txns || []).length });
});

// POST /api/insights
app.post("/api/insights", async (req, res) => {
  const { total, byCategory, limitsInfo, income, transactions, month } = req.body;

  const topCats = Object.entries(byCategory||{}).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map(([c,a]) => `${c}: ₹${Math.round(a).toLocaleString('en-IN')}`).join(', ');

  const prompt = `You are a personal finance advisor analysing someone's spending data. Be specific, helpful, and direct. Use Indian Rupee (₹) for all amounts.

Month: ${month}
Total expenses: ₹${Math.round(total||0).toLocaleString('en-IN')}
${income>0 ? `Monthly income: ₹${Math.round(income).toLocaleString('en-IN')}, Savings: ₹${Math.round(income-(total||0)).toLocaleString('en-IN')} (${Math.round(((income-(total||0))/income)*100)}%)` : 'Income not set'}
Spending by category: ${topCats}
${limitsInfo ? `Budget limits: ${limitsInfo}` : 'No budget limits set'}
Recent transactions: ${(transactions||[]).slice(0,15).map(t=>`${t.description} ₹${t.amount}`).join(', ')}

Generate exactly 4 financial insights as a JSON array. Each insight must be specific to THIS data.
Return ONLY a JSON array, no markdown:
[{"icon":"emoji","color":"hex color for background","title":"short title","body":"2-3 sentence specific insight with numbers"}]

Make insights about: spending patterns, budget alerts, savings opportunities, trend observations. Be specific with numbers.`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }]
    });
    const raw = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const insights = JSON.parse(raw);
    res.json(insights);
  } catch(err) {
    console.error("Insights error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Paisa Tracker backend running on port ${PORT}`));
