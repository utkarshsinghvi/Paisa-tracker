'use strict';
// Adapter registry. Order matters only between adapters that could match the same text.
// The generic fallback is separate: it is only consulted for messages no bank adapter and no info rule claimed.
const hdfc = require('./hdfc');
const icici = require('./icici');
const generic = require('./generic');

const BANK_ADAPTERS = [hdfc, icici];

function extractBank(n) {
  for (const a of BANK_ADAPTERS) {
    const hit = a.extract(n);
    if (hit) return hit;
  }
  return null;
}

const extractGeneric = (n) => generic.extract(n);

module.exports = { BANK_ADAPTERS, extractBank, extractGeneric };
