// Ruvio plan sync endpoints. Everything here sits behind requireKey.
// Wired in by server.js, so index.js is untouched.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const isPaise = (v) => Number.isInteger(v) && v >= 0;
const KINDS = { goals: 'app_goals', challenges: 'app_challenges', rules: 'app_rules' };

// If RUVIO_API_KEY is unset the check is skipped, so deploying this cannot lock anyone out by accident.
function requireKey(req, res, next) {
  const key = process.env.RUVIO_API_KEY;
  if (!key) return next();
  if (req.get('x-api-key') === key) return next();
  return res.status(401).json({ error: 'Unauthorised' });
}

// Express 4 does not catch rejected promises, so every handler goes through this.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: e.message || 'Server error' }));

module.exports = function planRoutes(app, supabase) {
  const guard = [requireKey];
  const uid = (req) => req.query.group_id || (req.body && req.body.group_id);
  const need = (req, res) => { const u = uid(req); if (!u) res.status(400).json({ error: 'group_id is required' }); return u; };

  // One call returns everything the app syncs.
  app.get('/api/plan', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const q = (t, order) => supabase.from(t).select('*').eq('user_id', user_id).order(order);
    const r = await Promise.all([
      q('monthly_plans', 'month'), q('commitments', 'created_at'), q('income_entries', 'created_at'),
      q('app_goals', 'updated_at'), q('app_challenges', 'updated_at'), q('app_rules', 'updated_at'),
      q('custom_categories', 'created_at'), q('reviewed_transactions', 'reviewed_at'),
    ]);
    const failed = r.find((x) => x.error);
    if (failed) return res.status(500).json({ error: failed.error.message });
    res.json({
      plans: r[0].data, commitments: r[1].data, extras: r[2].data,
      goals: r[3].data, challenges: r[4].data, rules: r[5].data,
      categories: r[6].data.map((c) => c.name), reviewed: r[7].data.map((x) => x.transaction_id),
    });
  }));

  app.put('/api/plan/month', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { month, income_paise, savings_target_paise = 0 } = req.body;
    if (!MONTH.test(month || '')) return res.status(400).json({ error: 'month must be yyyy-MM' });
    if (!isPaise(income_paise) || !isPaise(savings_target_paise)) return res.status(400).json({ error: 'amounts must be whole paise' });
    const { data, error } = await supabase.from('monthly_plans')
      .upsert({ user_id, month, income_paise, savings_target_paise, updated_at: new Date().toISOString() }, { onConflict: 'user_id,month' })
      .select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }));

  // Commitments: app-generated UUIDs, upsert, so an offline queue can safely retry.
  app.put('/api/commitments/:id', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { name, amount_paise, due_day, keyword = '', active = true } = req.body;
    if (!name || !(amount_paise > 0) || !(due_day >= 1 && due_day <= 31)) return res.status(400).json({ error: 'name, amount_paise and due_day are required' });
    const { data, error } = await supabase.from('commitments')
      .upsert({ id: req.params.id, user_id, name, amount_paise, due_day, keyword, active, updated_at: new Date().toISOString() }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }));

  app.delete('/api/commitments/:id', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { error } = await supabase.from('commitments').delete().eq('id', req.params.id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  }));

  app.put('/api/income-entries/:id', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { month, amount_paise, note = '' } = req.body;
    if (!MONTH.test(month || '') || !(amount_paise > 0)) return res.status(400).json({ error: 'month and amount_paise are required' });
    const { data, error } = await supabase.from('income_entries').upsert({ id: req.params.id, user_id, month, amount_paise, note }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }));

  app.delete('/api/income-entries/:id', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { error } = await supabase.from('income_entries').delete().eq('id', req.params.id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  }));

  // Goals, challenges, capture rules: the app's own JSON, stored as-is.
  app.put('/api/sync/:kind/:id', guard, wrap(async (req, res) => {
    const table = KINDS[req.params.kind];
    if (!table) return res.status(404).json({ error: 'unknown kind' });
    const user_id = need(req, res); if (!user_id) return;
    if (!req.body.data || typeof req.body.data !== 'object') return res.status(400).json({ error: 'data object is required' });
    const { data, error } = await supabase.from(table)
      .upsert({ id: req.params.id, user_id, data: req.body.data, updated_at: new Date().toISOString() }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  }));

  app.delete('/api/sync/:kind/:id', guard, wrap(async (req, res) => {
    const table = KINDS[req.params.kind];
    if (!table) return res.status(404).json({ error: 'unknown kind' });
    const user_id = need(req, res); if (!user_id) return;
    const { error } = await supabase.from(table).delete().eq('id', req.params.id).eq('user_id', user_id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  }));

  app.put('/api/categories', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const name = String(req.body.name || '').trim();
    if (!name || name.length > 40) return res.status(400).json({ error: 'name must be 1-40 characters' });
    const { error } = await supabase.from('custom_categories').upsert({ user_id, name });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  }));

  app.delete('/api/categories/:name', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const { error } = await supabase.from('custom_categories').delete().eq('user_id', user_id).eq('name', req.params.name);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  }));

  // Mark transactions as reviewed (bulk, idempotent).
  app.post('/api/reviewed', guard, wrap(async (req, res) => {
    const user_id = need(req, res); if (!user_id) return;
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter((x) => typeof x === 'string') : [];
    if (!ids.length) return res.json({ ok: true, count: 0 });
    const { error } = await supabase.from('reviewed_transactions').upsert(ids.map((transaction_id) => ({ user_id, transaction_id })));
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true, count: ids.length });
  }));
};

module.exports.requireKey = requireKey;
