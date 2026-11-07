'use strict';
// LAYERS 2, 3 and 5.
//   Layer 2  extract   : is this a money movement? (info gate + bank adapters + generic fallback)
//   Layer 3  classify  : what kind of money movement is it?
//   Layer 4  reconcile : see reconcile.js
//   Layer 5  decide    : record / ignore / review, by confidence. Uncertain => review, never a forced guess.
const { normalize } = require('./normalize');
const { OTP_PATTERN, INFO_PATTERNS, INVESTMENT_RX, DIVIDEND_RX, CARD_BILL_RX } = require('./lexicon');
const { extractBank, extractGeneric } = require('./adapters');
const { reconcile } = require('./reconcile');

const AUTO_RECORD_AT = 0.85;
const DATE_WINDOW = { pastDays: 400, futureDays: 3 };

const normName = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9@ ]+/g, ' ').replace(/\s+/g, ' ').trim();

// User-specific knowledge arrives ONLY through this object. The engine itself knows no names, accounts or payees.
function prepareConfig(cfg) {
  const list = (a) => (Array.isArray(a) ? a : []).map(normName).filter(Boolean);
  return {
    ownNames: list(cfg && cfg.ownNames),
    ownVpas: list(cfg && cfg.ownVpas),
    ownAccounts: (Array.isArray(cfg && cfg.ownAccounts) ? cfg.ownAccounts : []).map((a) => String(a).replace(/\D/g, '')).filter(Boolean),
    ignorePayees: list(cfg && cfg.ignorePayees),
    investmentPayees: list(cfg && cfg.investmentPayees),
  };
}

function matchesAny(counterparty, names) {
  const cp = normName(counterparty);
  if (!cp) return false;
  return names.some((n) => cp.includes(n) || (cp.length >= 10 && n.startsWith(cp)));   // bank-truncated names are prefixes
}
function matchesOwnAccount(counterparty, accounts) {
  const digits = String(counterparty || '').replace(/\D/g, '');
  return !!digits && accounts.some((a) => digits.endsWith(a));
}

// Merchant label used for display and category rules (same clean-up the SMS parser has always applied).
function cleanCounterparty(name) {
  let s = String(name == null ? '' : name)
    .replace(/\s+(PRIV|PVT|LTD|INDIA|PRIVATE|SERVICES?|SOLUTIONS?|SERV)\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 40) s = s.substring(0, 40).trim();
  return s;
}

function blank(n) {
  return {
    action: null, type: 'unknown', subtype: null, direction: null,
    amount: null, signedAmount: null, counterparty: null, merchant: null, category: null,
    account: null, reference: null, date: null, source: null, adapter: null, channel: null,
    confidence: 0, reasons: [], link: null, related: [], review: null, normalized: n,
  };
}

function saneDate(iso, now) {
  if (!iso) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  const ref = now ? new Date(now).getTime() : Date.now();
  if (t > ref + DATE_WINDOW.futureDays * 86400000 || t < ref - DATE_WINDOW.pastDays * 86400000) return null;
  return iso;
}

// Order: OTP gate -> bank adapters -> informational rules -> generic fallback.
// Layers 1-3 for ONE message (no knowledge of other transactions).
function analyse(raw, cfg, now) {
  const n = normalize(raw);
  const r = blank(n);

  if (OTP_PATTERN.test(n.text)) {
    r.type = 'info'; r.subtype = 'otp'; r.reasons.push('informational message (otp): not a money movement');
    return r;
  }

  let ext = extractBank(n);
  if (!ext) {
    for (const [id, rx] of INFO_PATTERNS) {
      if (rx.test(n.text)) {
        r.type = 'info'; r.subtype = id; r.reasons.push(`informational message (${id}): not a money movement`);
        return r;
      }
    }
    ext = extractGeneric(n);
  }
  if (!ext || !(ext.amount > 0)) { r.reasons.push('no recognised transaction format'); return r; }

  Object.assign(r, {
    direction: ext.direction, amount: ext.amount, counterparty: ext.counterparty,
    merchant: cleanCounterparty(ext.counterparty), account: ext.account, reference: ext.reference,
    date: saneDate(n.date, now), source: ext.source, adapter: ext.adapter, channel: ext.channel,
    confidence: ext.confidence,
  });
  r.reasons.push(`matched format ${ext.adapter}`);
  if (n.date && !r.date) r.reasons.push('message date outside the plausible window; ignored');
  const cp = ext.counterparty;

  // Own accounts and configured payees (user config only).
  if (ext.kind === 'internal' || matchesAny(cp, cfg.ownNames) || matchesAny(cp, cfg.ownVpas) || matchesOwnAccount(cp, cfg.ownAccounts)) {
    r.type = 'transfer'; r.subtype = ext.kind === 'internal' ? 'own_accounts_named' : 'configured_own_account'; r.confidence = 0.95;
    r.reasons.push('counterparty is one of your own accounts');
    return r;
  }
  if (matchesAny(cp, cfg.ignorePayees)) {
    r.type = 'card_payment'; r.subtype = 'configured_payee'; r.reasons.push('payee is on your ignore list (e.g. a card-bill payment service)');
    return r;
  }
  if (ext.direction === 'out' && CARD_BILL_RX.test(cp || '')) {
    r.type = 'card_payment'; r.subtype = 'card_bill_keyword'; r.reasons.push('looks like a credit card bill payment; card purchases are recorded individually');
    return r;
  }

  const isDividend = ext.direction === 'in' && ext.channel === 'ach' && DIVIDEND_RX.test(cp || '');
  const isInvestment = isDividend || INVESTMENT_RX.test(cp || '') || matchesAny(cp, cfg.investmentPayees);
  if (isInvestment) {
    r.type = 'investment'; r.category = 'Investments';
    r.subtype = isDividend ? 'dividend' : ext.direction === 'in' ? 'redemption' : 'purchase';
    r.signedAmount = ext.direction === 'in' ? -ext.amount : ext.amount;
    r.reasons.push(`investment ${r.subtype}: kept out of spending`);
    if (matchesAny(cp, cfg.investmentPayees)) {
      // The user told us this payee is an investment platform: that is stronger evidence than an anonymous narration.
      r.confidence = Math.max(r.confidence, 0.9);
      r.reasons.push('payee is on your investment list');
    }
    return r;
  }

  if (ext.kind === 'refund' || ext.kind === 'reversal') {
    r.type = 'refund'; r.subtype = ext.kind; r.signedAmount = -ext.amount;
    r.reasons.push('refund/reversal: offsets the original expense');
  } else if (ext.direction === 'in') {
    r.type = 'received'; r.category = 'Received'; r.signedAmount = ext.amount;
    r.reasons.push('money received');
  } else {
    r.type = 'expense'; r.signedAmount = ext.amount;
    r.reasons.push('money paid out');
  }

  if (ext.counterpartyKind) r.counterpartyKind = ext.counterpartyKind;
  return r;
}

const NEVER_RECORDED = new Set(['info', 'card_payment', 'transfer', 'duplicate', 'unknown']);

function reviewReason(r) {
  if (r.conflict) return 'The reference number matches an existing transaction but the amount differs.';
  if (r.adapter === 'generic.fallback') return 'Unrecognised SMS format: could not classify it safely.';
  if (r.counterpartyKind === 'unnamed') return 'The other party is not named, so this cannot be classified safely.';
  if (r.counterpartyKind === 'narration') return 'A debit with no payee name (bill-pay or reference code only).';
  return 'Low confidence in this classification.';
}

function decide(r) {
  if (NEVER_RECORDED.has(r.type)) { r.action = 'ignore'; return r; }
  if (r.confidence >= AUTO_RECORD_AT) { r.action = 'record'; return r; }
  r.action = 'review';
  r.review = { reason: reviewReason(r) };
  return r;
}

function classify(raw, userConfig, ctx) {
  const cfg = prepareConfig(userConfig);
  const c = ctx || {};
  const result = analyse(raw, cfg, c.now);
  reconcile(result, c, (row) => analyse(row, cfg, c.now));
  return decide(result);
}

module.exports = { classify, analyse, decide, prepareConfig, cleanCounterparty, AUTO_RECORD_AT };
