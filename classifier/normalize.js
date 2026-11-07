'use strict';
// LAYER 1 — SMS normalisation.
// Pure: text in, structured facts out. No bank-specific logic and no classification here.
const { INSTITUTION_RX } = require('./lexicon');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const toNumber = (s) => parseFloat(String(s).replace(/,/g, ''));

function extractAmounts(text) {
  const out = [];
  const rx = /(?:Rs\.?|INR\.?|₹)\s*([\d,]*\d(?:\.\d{1,2})?)/gi;
  let m;
  while ((m = rx.exec(text))) out.push({ value: toNumber(m[1]), index: m.index });
  return out;
}

// UPI RRN / UTR / bank reference numbers (the evidence used to pair debit and credit alerts).
function extractReferences(text) {
  const rx = /(?:\bUPI|\bRRN|\bUTR|\bRef(?:erence)?(?:\.?\s*(?:no|number|id)\.?)?|NEFT-)[\s:.\-]*([A-Z0-9]{9,22})/gi;
  const found = new Set();
  let m;
  while ((m = rx.exec(text))) {
    const token = m[1].toUpperCase();
    if ((token.match(/\d/g) || []).length >= 6) found.add(token);
  }
  return [...found];
}

function validDate(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const fullYear = (y) => (y < 100 ? 2000 + y : y);

// First calendar date in the message, as YYYY-MM-DD (Indian day-first order for numeric dates).
function extractDate(text) {
  const candidates = [];
  let m;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) candidates.push({ i: m.index, v: validDate(+m[1], +m[2], +m[3]) });

  const named = /\b(\d{1,2})[-/ ]([A-Za-z]{3,9})\.?[-/ ,]*(\d{2,4})\b/g;
  while ((m = named.exec(text))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) candidates.push({ i: m.index, v: validDate(fullYear(+m[3]), mo, +m[1]) });
  }

  const numeric = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/g;
  while ((m = numeric.exec(text))) candidates.push({ i: m.index, v: validDate(fullYear(+m[3]), +m[2], +m[1]) });

  const ok = candidates.filter((c) => c.v).sort((a, b) => a.i - b.i);
  return ok.length ? ok[0].v : null;
}

// "A/c XX123", "Acct *4567", "Card 8901", "Credit Card ending 8901" -> { kind, last }
function extractAccountHint(text) {
  const rx = /\b(A\/c|Acct?|Account|Card|CC)\b\s*(?:no\.?|ending(?:\s+with)?)?\s*[:*]?\s*((?:X|x|\*)*\d{3,6})\b/gi;
  let m;
  while ((m = rx.exec(text))) {
    const last = m[2].replace(/[^0-9]/g, '');
    if (last.length >= 3) return { kind: /^(card|cc)$/i.test(m[1]) ? 'card' : 'account', last };
  }
  return null;
}

function detectInstitution(text) {
  const m = INSTITUTION_RX.exec(text);
  return m ? m[1].toUpperCase().replace(/\s+/g, ' ') : null;
}

function normalize(raw) {
  const original = String(raw == null ? '' : raw);
  const text = original.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return {
    raw: original,
    text,
    amounts: extractAmounts(text),
    references: extractReferences(text),
    date: extractDate(text),
    accountHint: extractAccountHint(text),
    institution: detectInstitution(text),
  };
}

module.exports = { normalize, extractAmounts, extractReferences, extractDate, extractAccountHint, detectInstitution, toNumber };
