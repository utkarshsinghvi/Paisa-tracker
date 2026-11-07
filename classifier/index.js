'use strict';
// Ruvio classification engine — public surface.
//
//   classify(text, userConfig, ctx)  -> full classification (see README)
//   parseLegacy(text, userConfig)    -> the shape the old parseSMS() returned (backward compatibility)
//   references(text)                 -> reference numbers in a message (so a caller can look up related transactions)
//
// This module is pure: no network, no database, no framework. Persistence lives in the caller.
const { classify, AUTO_RECORD_AT } = require('./classify');
const { normalize } = require('./normalize');
const ledger = require('./ledger');

function parseLegacy(text, userConfig) {
  const r = classify(text, userConfig);
  if (r.action !== 'record') return null;
  return {
    amount: r.amount,
    merchant: r.merchant,
    source: r.source,
    refund: r.type === 'refund',
    type: r.type === 'received' ? 'income' : r.type === 'investment' ? 'investment' : 'expense',
    account: r.account,
    reference: r.reference,
  };
}

const references = (text) => normalize(text).references;

module.exports = Object.assign({ classify, parseLegacy, references, normalize, AUTO_RECORD_AT }, ledger);
