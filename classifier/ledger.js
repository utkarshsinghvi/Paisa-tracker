'use strict';
// Pure helpers that decide how a STORED transaction row is counted.
// Used by the API / WhatsApp aggregators so every total partitions rows the same way.
//
//   received   -> money in that is not a refund (category "Received", or legacy transaction_type "income")
//   investment -> category "Investments" (purchases positive, redemptions negative); never counted as spending
//   spend      -> everything else (refunds are negative spend rows)

function lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

function isReceived(t) {
  if (!t) return false;
  const type = lc(t.transaction_type);
  if (type === 'income' || type === 'received') return true;
  const cat = lc(t.category);
  return cat === 'received' || cat === 'income';
}

function isInvestment(t) {
  if (!t) return false;
  return lc(t.transaction_type) === 'investment' || lc(t.category) === 'investments';
}

function isSpend(t) { return !!t && !isReceived(t) && !isInvestment(t); }

// 'in' = money came in (received, refund, redemption); 'out' = money went out.
function directionOf(t) {
  if (!t) return null;
  if (isReceived(t)) return 'in';
  return Number(t.amount) < 0 ? 'in' : 'out';
}

module.exports = { isReceived, isInvestment, isSpend, directionOf };
