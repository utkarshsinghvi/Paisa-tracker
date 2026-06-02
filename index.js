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

// ── Twilio WhatsApp webhook ────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = (req.body.Body || "").trim();
  const from = req.body.From || "whatsapp:unknown";
  const groupId = from.replace("whatsapp:", "").replace(/\D/g, "");

  try {
    const expenses = await parseExpenses(incomingMsg);

    if (!expenses.length) {
      twiml.message(
        "Hmm, I couldn't find any expenses in that message.\n\nTry:\n• *200 rupees auto*\n• *500 groceries*\n• Multiple at once:\n  100 coffee, 299 netflix, 800 groceries"
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
          paid_by: e.paid_by || "Unknown",
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

      // Helper: total spent in a category this month
      const catSpent = (cat) =>
        (txns || []).filter((t) => t.category === cat).reduce((s, t) => s + t.amount, 0);

      // Build reply — one line per expense + category balance if limit exists
      const lines = [];
      const seenCats = new Set();

      for (const e of expenses) {
        lines.push(`✅ *₹${e.amount.toLocaleString("en-IN")}* — ${e.description} (${e.category})`);

        // Show category balance once per unique category in this message
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

      // Summary line for multi-expense messages
      if (expenses.length > 1) {
        const totalThisMsg = expenses.reduce((s, e) => s + e.amount, 0);
        lines.push(`\n📦 *${expenses.length} recorded* · This batch: ₹${totalThisMsg.toLocaleString("en-IN")}`);
      }

      // Overall monthly budget
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

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Paisa Tracker backend running on port ${PORT}`));
