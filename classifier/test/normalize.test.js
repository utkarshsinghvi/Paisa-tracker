'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, extractDate, extractReferences, extractAmounts } = require('../normalize');
const f = require('./fixtures');

describe('Layer 1: normalisation', () => {
  it('reads amounts in every notation banks use', () => {
    const v = (t) => extractAmounts(t).map((a) => a.value);
    assert.deepEqual(v('Rs.1.00 and Rs 1,39,604.00 and INR 103.00 and INR.119.00 and Rs. 2063'), [1, 139604, 103, 119, 2063]);
    assert.deepEqual(v('minimum due Rs .00'), []);
  });

  it('reads dates in day-first Indian order across formats, and rejects impossible dates', () => {
    assert.equal(extractDate('on 2026-11-03:21:56:42.Not You'), '2026-11-03');
    assert.equal(extractDate('on 17-Oct-26;'), '2026-10-17');
    assert.equal(extractDate('on 25/OCT/2026 &'), '2026-10-25');
    assert.equal(extractDate('On 05/11/26 Ref'), '2026-11-05');
    assert.equal(extractDate('on 20-10-26 from VPA'), '2026-10-20');
    assert.equal(extractDate('on 31-02-26'), null);
    assert.equal(extractDate('no date here'), null);
  });

  it('extracts reference numbers (UPI RRN, NEFT, Ref) and ignores look-alikes', () => {
    assert.deepEqual(extractReferences('UPI:630111111111-ICICI Bank.'), ['630111111111']);
    assert.deepEqual(extractReferences('(UPI 665976224812)'), ['665976224812']);
    assert.deepEqual(extractReferences('Ref 132379940945 Not You'), ['132379940945']);
    assert.deepEqual(extractReferences('Info NEFT-IDFB6273M4338458-ACME .'), ['IDFB6273M4338458']);
    assert.deepEqual(extractReferences('using your UPI Lite Wallet/s on 30-SEP-26'), []);
  });

  it('finds the account or card hint and the institution', () => {
    assert.deepEqual(normalize(f.iciciUpiDebit()).accountHint, { kind: 'account', last: '111' });
    assert.deepEqual(normalize(f.hdfcCard()).accountHint, { kind: 'card', last: '2222' });
    assert.equal(normalize(f.hdfcCard()).institution, 'HDFC');
  });

  it('copes with line breaks, odd spacing and empty input', () => {
    assert.equal(normalize(f.hdfcUpiSent()).text.includes('\n'), false);
    assert.equal(normalize(null).text, '');
    assert.deepEqual(normalize('').amounts, []);
  });
});
