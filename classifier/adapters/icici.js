'use strict';
// ICICI Bank SMS formats.
const { AMT, amt, firstRef, accountLabel } = require('./util');

const R = (s) => new RegExp(s.replace(/\{AMT\}/g, AMT), 'i');

const UPI_DEBIT     = R('ICICI\\s+Bank\\s+Acct\\s+\\w+\\s+debited\\s+for\\s+Rs\\s+{AMT}\\s+on\\s+[\\w-]+;\\s+(.+?)\\s+credited');
const CARD_SPEND    = R('INR\\s+{AMT}\\s+spent\\s+using\\s+ICICI\\s+Bank\\s+Card\\s+\\w+\\s+on\\s+[\\w-]+\\s+on\\s+(.+?)(?:\\.|Avl|$)');
const CARD_SPEND_2  = R('Rs\\.?\\s*{AMT}\\s+spent\\s+on\\s+ICICI\\s+Bank\\s+Card\\s+\\w+\\s+on\\s+[\\w-]+\\s+at\\s+(.+?)(?:\\.\\s|\\.?\\s*Avl|$)');
const UPI_LITE      = R('carried\\s+out\\s+\\d+\\s+transactions?\\s+worth\\s+Rs\\.?\\s*{AMT}\\s+using\\s+your\\s+UPI\\s+Lite');
const CARD_REFUND   = R('^(.+?)\\s+refund\\s+of\\s+Rs\\.?\\s*{AMT}\\s+credited\\s+to\\s+ICICI\\s+Bank\\s+Credit\\s+Card');
const UPI_CREDIT    = R('Acct\\s+(\\w+)\\s+is\\s+credited\\s+with\\s+Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\s+from\\s+(.+?)\\.?\\s+UPI[:\\s]*(\\d+)');
const NEFT_CREDIT   = R('ICICI\\s+Bank\\s+Account\\s+(\\w+)\\s+credited:\\s*Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\.?\\s+Info\\s+(NEFT|IMPS|RTGS)-([A-Z0-9]+)-([^.]+?)\\s*\\.');
const ACH_CREDIT    = R('ICICI\\s+Bank\\s+Account\\s+(\\w+)\\s+credited:\\s*Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\.?\\s+Info\\s+ACH\\*(.+?)(?:\\*\\w*)?\\s*\\.\\s*Available');
const TRFR_CREDIT  = R('ICICI\\s+Bank\\s+Account\\s+(\\w+)\\s+credited:\\s*Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\.?\\s+Info\\s+TRFR\\s+FROM:\\s*(.+?)\\s*\\.\\s*Available');
const CMS_CREDIT   = R('ICICI\\s+Bank\\s+Account\\s+(\\w+)\\s+credited:\\s*Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\.?\\s+Info\\s+CMS\\*\\s*(.+?)\\s*\\.\\s*Available');
const IMPS_CREDIT   = R('ICICI\\s+Bank\\s+Account\\s+(\\w+)\\s+is\\s+credited\\s+with\\s+Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\s+by\\s+(.+?)\\.\\s*IMPS');
const BANK_DEBIT    = R('ICICI\\s+Bank\\s+Acc\\w*\\s+(\\w+)\\s+debited\\s+Rs\\.?\\s*{AMT}\\s+on\\s+[\\w-]+\\s+Info\\s*(\\S+)');
const ACCT_TO_ACCT  = R('ICICI\\s+Bank\\s+Acct\\s+\\w+\\s+debited\\s+with\\s+INR\\s+{AMT}\\s+on\\s+[\\w-]+\\.\\s+Acct\\s+(\\w+)\\s+credited');

function extract(n) {
  const t = n.text;
  let m;

  if ((m = UPI_DEBIT.exec(t)))    return { adapter: 'icici.upi_debit', source: 'ICICI UPI', kind: 'debit', direction: 'out', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'upi', account: accountLabel(n, 'ICICI'), reference: firstRef(n), confidence: 0.95 };
  if ((m = CARD_SPEND.exec(t)))   return { adapter: 'icici.card_spend', source: 'ICICI Card', kind: 'purchase', direction: 'out', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'card', account: accountLabel(n, 'ICICI'), reference: firstRef(n), confidence: 0.95 };
  if ((m = CARD_SPEND_2.exec(t))) return { adapter: 'icici.card_spend_alt', source: 'ICICI Card', kind: 'purchase', direction: 'out', amount: amt(m[1]), counterparty: m[2].trim(), channel: 'card', account: accountLabel(n, 'ICICI'), reference: firstRef(n), confidence: 0.95 };
  if ((m = UPI_LITE.exec(t)))     return { adapter: 'icici.upi_lite', source: 'ICICI UPI Lite', kind: 'purchase', direction: 'out', amount: amt(m[1]), counterparty: 'UPI Lite payments', channel: 'upi_lite', account: null, reference: null, confidence: 0.95 };
  if ((m = CARD_REFUND.exec(t)))  return { adapter: 'icici.card_refund', source: 'ICICI Card refund', kind: 'refund', direction: 'in', amount: amt(m[2]), counterparty: m[1].trim(), channel: 'card', account: accountLabel(n, 'ICICI'), reference: null, confidence: 0.95 };

  if (/ICICI/i.test(t) && (m = UPI_CREDIT.exec(t))) {
    return { adapter: 'icici.upi_credit', source: 'ICICI UPI credit', kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'person', channel: 'upi', account: `ICICI A/c ${m[1]}`, reference: m[4], confidence: 0.95 };
  }
  if ((m = NEFT_CREDIT.exec(t))) {
    return { adapter: 'icici.neft_credit', source: `ICICI ${m[3].toUpperCase()} credit`, kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[5].trim(), counterpartyKind: 'remitter', channel: m[3].toLowerCase(), account: `ICICI A/c ${m[1]}`, reference: m[4].toUpperCase(), confidence: 0.9 };
  }
  if ((m = ACH_CREDIT.exec(t))) {
    // ACH credits are corporate payouts (dividends, interest, refunds): the narration is the issuer, not a person.
    return { adapter: 'icici.ach_credit', source: 'ICICI ACH credit', kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'issuer', channel: 'ach', account: `ICICI A/c ${m[1]}`, reference: null, confidence: 0.9 };
  }
  if ((m = TRFR_CREDIT.exec(t))) {
    return { adapter: 'icici.trfr_credit', source: 'ICICI transfer credit', kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'person', channel: 'transfer', account: `ICICI A/c ${m[1]}`, reference: null, confidence: 0.9 };
  }
  if ((m = CMS_CREDIT.exec(t))) {
    // A payout from a cash-management/platform account (e.g. a broker or wallet withdrawal): could be a redemption, so a human decides.
    return { adapter: 'icici.cms_credit', source: 'ICICI CMS credit', kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'platform', channel: 'cms', account: `ICICI A/c ${m[1]}`, reference: null, confidence: 0.7 };
  }
  if ((m = IMPS_CREDIT.exec(t))) {
    // The remitter is an anonymous "account linked to mobile number": we cannot tell who it is.
    return { adapter: 'icici.imps_credit', source: 'ICICI IMPS credit', kind: 'credit', direction: 'in', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'unnamed', channel: 'imps', account: `ICICI A/c ${m[1]}`, reference: firstRef(n), confidence: 0.7 };
  }
  if ((m = ACCT_TO_ACCT.exec(t))) {
    return { adapter: 'icici.acct_to_acct', source: 'ICICI account transfer', kind: 'debit', direction: 'out', amount: amt(m[1]), counterparty: `Acct ${m[2]}`, counterpartyKind: 'unnamed', channel: 'upi', account: accountLabel(n, 'ICICI'), reference: firstRef(n), confidence: 0.6 };
  }
  if ((m = BANK_DEBIT.exec(t))) {
    // Debit with only a narration code (e.g. a bill-pay reference): payee unknown, so it needs a human.
    return { adapter: 'icici.bank_debit', source: 'ICICI bank debit', kind: 'debit', direction: 'out', amount: amt(m[2]), counterparty: m[3].trim(), counterpartyKind: 'narration', channel: 'bank_debit', account: `ICICI A/c ${m[1]}`, reference: null, confidence: 0.6 };
  }
  return null;
}

module.exports = { id: 'icici', institution: 'ICICI', extract };
