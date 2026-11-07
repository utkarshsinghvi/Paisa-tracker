'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isReceived, isInvestment, isSpend, directionOf } = require('../ledger');

describe('ledger partition of stored rows', () => {
  const rows = {
    spend: { amount: 100, category: 'Food' },
    refund: { amount: -100, category: 'Food' },
    receivedByType: { amount: 50, category: 'Whatever', transaction_type: 'received' },
    legacyIncome: { amount: 50, category: 'Income', transaction_type: 'income' },
    receivedByCategory: { amount: 50, category: 'Received' },
    invest: { amount: 900, category: 'Investments' },
    redemption: { amount: -400, category: 'Investments' },
  };
  it('every row lands in exactly one bucket', () => {
    for (const [name, r] of Object.entries(rows)) {
      assert.equal([isSpend(r), isReceived(r), isInvestment(r)].filter(Boolean).length, 1, name);
    }
  });
  it('refunds stay in spend (as negative spend)', () => assert.equal(isSpend(rows.refund), true));
  it('received works with or without the optional column', () => {
    assert.ok(isReceived(rows.receivedByType) && isReceived(rows.receivedByCategory) && isReceived(rows.legacyIncome));
  });
  it('rows without the new fields behave exactly as before', () => assert.equal(isSpend({ amount: 5, category: 'Anything' }), true));
  it('direction', () => {
    assert.deepEqual([rows.spend, rows.refund, rows.receivedByType, rows.redemption].map(directionOf), ['out', 'in', 'in', 'in']);
  });
});
