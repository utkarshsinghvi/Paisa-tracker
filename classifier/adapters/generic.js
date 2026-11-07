'use strict';
// Bank-agnostic FALLBACK for formats no adapter knows. It never auto-records:
// its confidence is capped below the auto-record threshold, so results are routed to review.
const { amt, firstRef, accountLabel } = require('./util');

const OUT_RX = /\b(?:debited|spent|paid|purchase[d]?|withdrawn|deducted|sent)\b/i;
const IN_RX  = /\b(?:credited|received|deposited|refund(?:ed)?)\b/i;

function extract(n) {
  const t = n.text;
  if (!n.amounts.length) return null;
  const out = OUT_RX.test(t);
  const inn = IN_RX.test(t);
  if (out === inn) return null;                       // no direction, or contradictory wording
  if (!n.accountHint && !n.references.length && !n.institution) return null;  // not recognisably a bank alert

  const cp = /\b(?:at|to|from|by|towards|info)[:\s]+([A-Za-z0-9*@&.' -]{3,40}?)(?:\s+(?:on|using|via|ref|avl|bal|upi)\b|[.;,]|$)/i.exec(t);
  let confidence = 0.5;
  if (cp) confidence += 0.1;
  if (n.accountHint) confidence += 0.1;
  if (n.date) confidence += 0.05;
  if (n.references.length) confidence += 0.05;

  return {
    adapter: 'generic.fallback', source: 'Unrecognised format', kind: out ? 'debit' : 'credit',
    direction: out ? 'out' : 'in', amount: n.amounts[0].value,
    counterparty: cp ? cp[1].trim() : null, counterpartyKind: cp ? 'unverified' : 'unnamed',
    channel: null, account: accountLabel(n), reference: firstRef(n),
    confidence: Math.min(confidence, 0.8),
  };
}

module.exports = { id: 'generic', institution: null, extract };
