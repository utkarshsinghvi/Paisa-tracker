#!/usr/bin/env node
'use strict';
// Validate the engine against a real SMS export (the corpus stays on your machine; nothing here is bank- or user-specific).
//
//   node classifier/scripts/validate-corpus.js <export.tsv> [--config user-config.json] [--legacy old-index.js]
//
//   export.tsv   2 columns (sender<TAB>text) or 3 columns (sender<TAB>YYYY-MM-DD HH:MM:SS<TAB>text, from export_sms.py)
//   --config     JSON with ownNames / ownVpas / ownAccounts / ignorePayees / investmentPayees
//   --legacy     the previous index.js, to diff the old parseSMS() against the engine (exit code 1 on any regression)
//
// Messages are replayed OLDEST FIRST into an in-memory ledger so reconciliation (duplicates, own-account pairs,
// refund linking) sees exactly what production would have seen.
const fs = require('node:fs');
const path = require('node:path');
const { classify, parseLegacy, isSpend, isReceived, isInvestment } = require('..');

const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: validate-corpus.js <export.tsv> [--config cfg.json] [--legacy old-index.js]'); process.exit(2); }
const cfg = arg('--config') ? JSON.parse(fs.readFileSync(arg('--config'), 'utf8')) : {};

// ── load corpus ──
const DATE_COL = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
let rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.includes('\t')).map((l) => {
  const parts = l.split('\t');
  const hasDate = parts.length >= 3 && DATE_COL.test(parts[1]);
  return { sender: parts[0], at: hasDate ? new Date(parts[1].replace(' ', 'T') + 'Z') : null, text: parts.slice(hasDate ? 2 : 1).join('\t').replace(/ \| /g, '\n') };
});
const timed = rows.every((r) => r.at);
rows = timed ? rows.sort((a, b) => a.at - b.at) : rows.reverse();    // untimed exports are newest-first
const base = timed ? null : new Date(Date.now() - rows.length * 3600e3);
rows.forEach((r, i) => { if (!r.at) r.at = new Date(base.getTime() + i * 3600e3); });

// ── optional: legacy parser from the previous index.js ──
let legacy = null;
if (arg('--legacy')) {
  const src = fs.readFileSync(arg('--legacy'), 'utf8');
  const a = src.indexOf('const SKIP_PAYEES'); const b = src.indexOf('// ── WhatsApp sending');
  if (a < 0 || b < 0) { console.error('--legacy: could not find the old parseSMS block'); process.exit(2); }
  legacy = new Function(`${src.slice(a, b).replace('const SKIP_PAYEES', 'var SKIP_PAYEES')}; return parseSMS;`)();
}

// ── replay ──
const ledger = [];
let seq = 0;
const tally = {}; const reviews = []; const pairs = []; const dups = []; const regress = []; const changed = [];
const before = { expense: 0, refund: 0, income: 0 };
for (const m of rows) {
  const old = legacy ? legacy(m.text) : null;
  if (old) { if (old.type === 'income') before.income += old.amount; else if (old.refund) before.refund -= old.amount; else before.expense += old.amount; }

  const known = ledger.filter((k) => true);
  const r = classify(m.text, cfg, { now: m.at, known });
  const key = `${r.action}/${r.type}${r.subtype ? ':' + r.subtype : ''}`;
  tally[key] = (tally[key] || 0) + 1;

  if (r.action === 'record') {
    ledger.push({ id: `sim-${++seq}`, amount: r.signedAmount, description: r.merchant, category: r.category || 'Other', raw_message: m.text, created_at: m.at.toISOString(), transaction_type: r.type === 'received' ? 'received' : undefined });
  } else if (r.action === 'review') reviews.push({ r, text: m.text });
  if (r.type === 'transfer' && r.subtype === 'reference_pair') pairs.push(r);
  if (r.type === 'duplicate') dups.push(r);

  if (legacy) {
    const nw = parseLegacy(m.text, cfg);
    if (old && !nw && r.type !== 'transfer' && r.type !== 'duplicate') regress.push({ text: m.text.replace(/\s+/g, ' ').slice(0, 120), old: `${old.type} ${old.amount} ${old.merchant}`, now: key });
    if (old && nw && (old.amount !== nw.amount || old.merchant !== nw.merchant || old.source !== nw.source || old.refund !== nw.refund)) changed.push({ old, nw });
  }
}

// ── report ──
const sum = (f) => ledger.filter(f).reduce((s, t) => s + t.amount, 0);
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const line = (s = '') => console.log(s);
line(`Corpus: ${rows.length} messages from ${path.basename(file)}${timed ? ' (with timestamps)' : ' (no timestamps: replayed in reverse file order)'}`);
line('\n== Outcome per message ==');
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => line(`  ${String(v).padStart(4)}  ${k}`));

line('\n== Ledger totals ==');
if (legacy) line(`  BEFORE (old parser):  spend ${inr(before.expense)}  refunds ${inr(before.refund)}  income ${inr(before.income)}   [investments/transfers not distinguished]`);
line(`  AFTER  (engine):      spend ${inr(sum(isSpend))} (incl. refunds)  received ${inr(sum(isReceived))}  investments(net) ${inr(sum(isInvestment))}`);
line(`  rows recorded: ${ledger.length}  | flagged for review: ${reviews.length}  | own-account pairs by reference: ${pairs.length}  | duplicates caught: ${dups.length}`);
const refunds = ledger.filter((t) => t.amount < 0 && isSpend(t));
line(`  refunds recorded: ${refunds.length} (negative spend rows)`);

if (pairs.length) { line('\n== Own-account pairs detected (shared reference) =='); pairs.slice(0, 5).forEach((r) => line(`  ${inr(r.amount)} ${r.reasons.at(-1)}`)); if (pairs.length > 5) line(`  … ${pairs.length - 5} more`); }
if (reviews.length) { line('\n== Flagged for review (not recorded) =='); reviews.forEach(({ r, text }) => line(`  ${inr(r.amount).padStart(10)} ${r.direction === 'in' ? 'IN ' : 'OUT'}  ${r.review.reason}\n             ${text.replace(/\s+/g, ' ').slice(0, 110)}`)); }

if (legacy) {
  line('\n== Compared with the old parser ==');
  line(`  recorded by old parser: ${rows.filter((m) => legacy(m.text)).length}`);
  line(`  field differences on messages both record: ${changed.length}`);
  line(`  REGRESSIONS (old parser recorded, engine does not): ${regress.length}`);
  regress.forEach((x) => line(`    ✗ ${x.old} -> ${x.now} | ${x.text}`));
  process.exit(regress.length || changed.length ? 1 : 0);
}
