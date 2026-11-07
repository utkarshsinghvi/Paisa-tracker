'use strict';
// HDFC Bank SMS formats. Add a new bank by adding a file like this one and registering it in adapters/index.js.
const { AMT, amt, firstRef, accountLabel, flatRaw } = require('./util');

const R = (s) => new RegExp(s.replace(/\{AMT\}/g, AMT), 'i');

const CARD_SPEND   = R('Spent\\s+Rs\\.?\\s*{AMT}\\s+On\\s+HDFC\\s+Bank\\s+Card\\s+(\\d+)\\s+At\\s+(.+?)\\s+On\\s+\\d{4}');
const UPI_SENT     = R('Sent\\s+Rs\\.?\\s*{AMT}\\s+From\\s+HDFC\\s+Bank\\s+A\\/C\\s+\\*?\\w+\\s+To\\s+([\\s\\S]+?)\\s+On\\s+\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}');
const CARD_AUTOPAY = R('Amount\\s+Spent:\\s*Rs\\.?\\s*{AMT}\\s+with\\s+HDFC\\s+Bank\\s+Credit\\s+Card\\s+\\d+\\s+at\\s+(.+?)\\s+on\\s+\\d{4}');
const REFUND       = R('Rs\\.?\\s*{AMT}\\s+refunded\\s+by\\s+(.+?)\\s+on\\s+\\d{1,2}\\/');
const REVERSAL     = R('Transaction\\s+Reversed!.*?Amt:\\s*Rs\\.?\\s*{AMT}\\s+By\\s+(.+?)\\s+On\\s+\\d{4}');
const UPI_CREDIT   = R('Credit\\s+Alert!?\\s*Rs\\.?\\s*{AMT}\\s+credited\\s+to\\s+HDFC\\s+Bank\\s+A\\/c\\s+\\S+\\s+on\\s+\\S+\\s+from\\s+(.+?)(?:\\s*\\(UPI\\s*\\d+\\))?\\s*$');
const CARD_TO_BANK = R('Excess\\s+Balance\\s+Refunded:\\s*Rs\\.?\\s*{AMT}\\s+has\\s+been\\s+credited\\s+from\\s+your\\s+HDFC\\s+Bank\\s+Credit\\s+Card\\s+ending\\s+(\\d+)\\s+to\\s+your\\s+Bank\\s+A\\/c\\s+ending\\s+(\\d+)');

function extract(n) {
  const t = n.text;
  let m;

  if ((m = CARD_SPEND.exec(t))) {
    return { adapter: 'hdfc.card_spend', source: `HDFC Card ${m[2]}`, kind: 'purchase', direction: 'out', amount: amt(m[1]), counterparty: m[3].trim(), channel: 'card', account: accountLabel(n, 'HDFC'), reference: firstRef(n), confidence: 0.95 };
  }
  if ((m = UPI_SENT.exec(t))) {
    return { adapter: 'hdfc.upi_sent', source: 'HDFC UPI', kind: 'debit', direction: 'out', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'upi', account: accountLabel(n, 'HDFC'), reference: firstRef(n), confidence: 0.95 };
  }
  if ((m = CARD_AUTOPAY.exec(t))) {
    return { adapter: 'hdfc.card_autopay', source: 'HDFC Card', kind: 'purchase', direction: 'out', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'card', account: accountLabel(n, 'HDFC'), reference: firstRef(n), confidence: 0.95 };
  }
  if ((m = REFUND.exec(flatRaw(n)))) {
    return { adapter: 'hdfc.card_refund', source: 'HDFC Card refund', kind: 'refund', direction: 'in', amount: amt(m[1]), counterparty: m[2].split(/\s{2,}/)[0].slice(0, 23).trim(), channel: 'card', account: accountLabel(n, 'HDFC'), reference: null, confidence: 0.95 };
  }
  if ((m = REVERSAL.exec(t))) {
    return { adapter: 'hdfc.card_reversal', source: 'HDFC Card reversal', kind: 'reversal', direction: 'in', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'card', account: accountLabel(n, 'HDFC'), reference: null, confidence: 0.95 };
  }
  if ((m = CARD_TO_BANK.exec(t))) {
    // Money moving from the user's own card back to the user's own account: both ends are named in the SMS.
    return { adapter: 'hdfc.card_to_bank', source: 'HDFC card excess refund', kind: 'internal', direction: 'in', amount: amt(m[1]), counterparty: `own account ${m[3]}`, channel: 'internal', account: `HDFC A/c ${m[3]}`, reference: null, confidence: 0.95 };
  }
  if ((m = UPI_CREDIT.exec(t))) {
    const who = m[2].trim();
    return { adapter: 'hdfc.upi_credit', source: 'HDFC UPI credit', kind: 'credit', direction: 'in', amount: amt(m[1]), counterparty: who.replace(/^VPA\s+/i, ''), counterpartyKind: /^VPA\b/i.test(who) ? 'vpa' : 'person', channel: 'upi', account: accountLabel(n, 'HDFC'), reference: firstRef(n), confidence: 0.9 };
  }
  return null;
}

module.exports = { id: 'hdfc', institution: 'HDFC', extract };
