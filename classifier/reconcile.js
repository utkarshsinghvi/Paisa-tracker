'use strict';
// LAYER 4 — reconciliation against transactions the caller already has (ctx.known).
// Pure: it only reads ctx.known and returns/mutates the result; it never touches storage.
//   * duplicate alerts      -> same reference+direction+amount, or identical text within 24h
//   * own-account transfers -> same reference seen in BOTH directions (the SMS reached this user for both accounts)
//   * refund linking        -> match a refund to the purchase it offsets (merchant + amount)
const { directionOf, isSpend } = require('./ledger');

const CANDIDATE_TYPES = new Set(['expense', 'received', 'refund', 'investment']);
const STOP = new Set(['PRIV', 'PVT', 'LTD', 'LIMITED', 'PRIVATE', 'INDIA', 'THE', 'AND', 'SERVICES', 'SERVICE', 'SOLUTIONS', 'SOLUTION', 'TECHNOLOGIES', 'TECHNOLOGY', 'PAYMENTS', 'PAYMENT', 'ONLINE', 'IND', 'COM']);

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
const sameMoney = (a, b) => Math.abs(Math.abs(Number(a)) - Math.abs(Number(b))) < 0.01;
const hasRef = (raw, ref) => !!ref && String(raw || '').toUpperCase().includes(String(ref).toUpperCase());
const rowTime = (k) => new Date(k.transaction_date || k.created_at || 0).getTime();

function merchantTokens(name) {
  const cleaned = String(name || '').toUpperCase().replace(/^[A-Z]{2,5}\*/, '').replace(/[^A-Z0-9 ]+/g, ' ');
  return new Set(cleaned.split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function relatedOf(k, relation) {
  return { id: k.id, amount: Number(k.amount), description: k.description, category: k.category, relation };
}

function linkRefund(r, known, parseRow) {
  const mine = merchantTokens(r.counterparty);
  let best = null;
  for (const k of known) {
    if (!isSpend(k) || !(Number(k.amount) > 0) || r.amount > Number(k.amount) + 0.01) continue;
    const parsed = k.raw_message ? parseRow(k.raw_message) : null;
    const theirs = merchantTokens(parsed && parsed.counterparty ? parsed.counterparty : k.description);
    const sim = jaccard(mine, theirs);
    if (sim < 0.5) continue;
    const amountScore = sameMoney(k.amount, r.amount) ? 1 : 0.6;
    const score = 0.5 * sim + 0.5 * amountScore;
    if (score < 0.6) continue;
    if (!best || score > best.score || (score === best.score && rowTime(k) > rowTime(best.row))) best = { row: k, score };
  }
  return best;
}

function reconcile(r, ctx, parseRow) {
  if (!CANDIDATE_TYPES.has(r.type)) return r;
  const known = Array.isArray(ctx && ctx.known) ? ctx.known : [];
  if (!known.length) return r;
  const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();

  const sameRef = known.filter((k) => hasRef(k.raw_message, r.reference));

  // 1) duplicate alert
  for (const k of sameRef) {
    if (directionOf(k) === r.direction && sameMoney(k.amount, r.amount)) {
      return Object.assign(r, { type: 'duplicate', subtype: 'same_reference', related: [relatedOf(k, 'already_recorded')], reasons: r.reasons.concat(`same reference and amount as transaction ${k.id}`) });
    }
  }
  const text = collapse(r.normalized.text);
  for (const k of known) {
    const age = now - new Date(k.created_at || 0).getTime();
    if (k.raw_message && collapse(k.raw_message) === text && age >= 0 && age < 24 * 3600 * 1000) {
      return Object.assign(r, { type: 'duplicate', subtype: 'identical_text', related: [relatedOf(k, 'already_recorded')], reasons: r.reasons.concat(`identical SMS already recorded as ${k.id} within 24h`) });
    }
  }

  // 2) own-account transfer: the same reference appears as money out AND money in
  for (const k of sameRef) {
    if (directionOf(k) !== r.direction && sameMoney(k.amount, r.amount)) {
      return Object.assign(r, {
        type: 'transfer', subtype: 'reference_pair', confidence: 0.9, category: null, signedAmount: null,
        related: [relatedOf(k, 'possible_own_transfer_pair')],
        reasons: r.reasons.concat(`same reference as ${k.direction === 'in' ? 'an earlier credit' : 'an earlier payment'} (${k.id}): looks like a move between your own accounts`),
      });
    }
  }

  // 3) same reference but a different amount: conflicting evidence, do not auto-record
  for (const k of sameRef) {
    if (directionOf(k) === r.direction) {
      r.confidence = Math.min(r.confidence, 0.6);
      r.reasons.push(`reference matches transaction ${k.id} but the amount differs`);
      r.conflict = true;
    }
  }

  // 4) refund -> original purchase
  if (r.type === 'refund') {
    const best = linkRefund(r, known, parseRow);
    if (best) {
      r.link = { id: best.row.id, score: Number(best.score.toFixed(2)), original_amount: Number(best.row.amount), description: best.row.description };
      r.category = best.row.category;
      r.reasons.push(`linked to earlier purchase ${best.row.id} (${best.row.description})`);
    }
  }
  return r;
}

module.exports = { reconcile, linkRefund, merchantTokens, jaccard, CANDIDATE_TYPES };
