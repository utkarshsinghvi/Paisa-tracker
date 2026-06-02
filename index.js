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

// ── Parse expense with Claude ──────────────────────────────────────────────
async function parseExpense(text) {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: `You parse expense messages. Return ONLY a JSON object, no markdown, no explanation.

Schema: {"amount": <number>, "description": "<2-4 word label>", "category": "<one of: Food, Transport, Shopping, Entertainment, Health, Bills, Other>", "paid_by": "<name if mentioned, else null>"}

Rules:
- amount must be a positive number in INR
- If not an expense, return {"error": "not an expense"}
- description must be short and clean

Message: "${text}"`,
      },
    ],
  });

  const raw = msg.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Build WhatsApp reply ───────────────────────────────────────────────────
async function buildReply(parsed, groupId) {
  const { data: limits } = await supabase
    .from("limits")
    .select("*")
    .eq("group_id", groupId);

  const { data: txns } = await supabase
    .from("transactions")
    .select("amount, category")
    .eq("group_id", groupId)
    .gte("created_at", new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  const totalSpent = (txns || []).reduce((s, t) => s + t.amount, 0);
  const catSpent = (txns || [])
    .filter((t) => t.category === parsed.category)
    .reduce((s, t) => s + t.amount, 0);

  const overallLimit = (limits || []).find((l) => l.category === "overall");
  const catLimit = (limits || []).find((l) => l.category === parsed.category);

  let reply = `✅ *₹${parsed.amount.toLocaleString("en-IN")}* recorded for ${parsed.description} (${parsed.category})`;

  if (catLimit) {
    const rem = catLimit.amount - catSpent;
    reply +=
      rem < 0
        ? `\n\n⚠️ *${parsed.category} limit exceeded* by ₹${Math.abs(rem).toLocaleString("en-IN")}`
        : `\n\n📊 *${parsed.category}:* ₹${rem.toLocaleString("en-IN")} remaining of ₹${catLimit.amount.toLocaleString("en-IN")}`;
  }

  if (overallLimit) {
    const remOverall = overallLimit.amount - totalSpent;
    reply +=
      remOverall < 0
        ? `\n🚨 Monthly budget exceeded by ₹${Math.abs(remOverall).toLocaleString("en-IN")}`
        : `\n💰 Monthly total: ₹${totalSpent.toLocaleString("en-IN")} / ₹${overallLimit.amount.toLocaleString("en-IN")}`;
  }

  return reply;
}

// ── Twilio WhatsApp webhook ────────────────────────────────────────────────
app.post("/webhook/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const incomingMsg = (req.body.Body || "").trim();
  const from = req.body.From || "whatsapp:unknown";

  // Derive a group_id from the sender (one group per number for now)
  const groupId = from.replace("whatsapp:", "").replace(/\D/g, "");

  try {
    const parsed = await parseExpense(incomingMsg);

    if (parsed.error) {
      twiml.message(
        "Hmm, I couldn't read that as an expense.\n\nTry:\n• *200 rupees auto*\n• *paid 500 for groceries*\n• *netflix 299*"
      );
    } else {
      // Upsert group
      await supabase.from("groups").upsert({ id: groupId, name: groupId }, { onConflict: "id", ignoreDuplicates: true });

      // Insert transaction
      await supabase.from("transactions").insert({
        group_id: groupId,
        amount: parsed.amount,
        description: parsed.description,
        category: parsed.category,
        paid_by: parsed.paid_by || "Unknown",
        raw_message: incomingMsg,
      });

      const reply = await buildReply(parsed, groupId);
      twiml.message(reply);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    twiml.message("Something went wrong. Please try again.");
  }

  res.type("text/xml").send(twiml.toString());
});

// ── REST API for dashboard ─────────────────────────────────────────────────

// GET /api/groups — list all groups
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

  // Upsert group
  await supabase.from("groups").upsert({ id: group_id, name: group_id }, { onConflict: "id", ignoreDuplicates: true });

  const { data, error } = await supabase
    .from("transactions")
    .insert({ group_id, amount: parseFloat(amount), description, category, paid_by: paid_by || "Unknown", raw_message: null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
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

// POST /api/limits — set or update a limit
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
    const day = t.created_at.slice(0, 10);
    byDay[day] = (byDay[day] || 0) + t.amount;
  }

  res.json({ total, byCategory, byPerson, byDay, limits: limits || [], count: (txns || []).length });
});

app.get("/health", (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Paisa Tracker backend running on port ${PORT}`));
