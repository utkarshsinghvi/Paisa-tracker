'use strict';
const { toNumber } = require('../normalize');

const AMT = '([\\d,]*\\d(?:\\.\\d{1,2})?)';
const amt = (s) => toNumber(s);
const firstRef = (n) => (n.references.length ? n.references[0] : null);
const accountLabel = (n, inst) => (n.accountHint ? `${inst || n.institution || ''} ${n.accountHint.kind === 'card' ? 'card' : 'A/c'} ${n.accountHint.last}`.trim() : null);
// Raw text with line breaks flattened but multi-space runs kept (some banks pad merchant/city with spaces).
const flatRaw = (n) => n.raw.replace(/[\r\n]+/g, ' ');

module.exports = { AMT, amt, firstRef, accountLabel, flatRaw };
