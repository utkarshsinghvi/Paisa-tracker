'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classify } = require('..');
const f = require('./fixtures');

const NOW = f.NOW;
const run = (text, known, cfg = {}) => classify(text, cfg, { now: NOW, known });
const row = (over) => ({ id: 'row-1', amount: 250, description: 'Kabir Transfer', category: 'Other', created_at: '2026-11-03T08:00:00Z', ...over });

describe('Layer 4: reconciliation', () => {
  it('flags a duplicate by reference, direction and amount', () => {
    const known = [row({ raw_message: f.iciciUpiDebit('KABIR NAIR', '250.00', '630111111111') })];
    const r = run(f.iciciUpiDebit('KABIR NAIR', '250.00', '630111111111'), known);
    assert.deepEqual([r.type, r.action, r.subtype], ['duplicate', 'ignore', 'same_reference']);
  });

  it('flags the identical SMS arriving twice within 24h even when there is no reference', () => {
    const text = f.hdfcCard('125', 'RAZ*GAME THEORY');
    const known = [row({ amount: 125, raw_message: text, created_at: '2026-11-08T08:00:00Z' })];
    assert.equal(run(text, known).type, 'duplicate');
    const old = [row({ amount: 125, raw_message: text, created_at: '2026-11-03T08:00:00Z' })];
    assert.equal(run(text, old).type, 'expense', 'an identical SMS days later is a new purchase');
  });

  it('pairs a debit and a credit that share a reference as an own-account transfer', () => {
    const debitRow = row({ id: 'debit-1', amount: 3000, raw_message: f.iciciUpiDebit('SOME ONE', '3,000.00', '665976224812') });
    const r = run(f.hdfcCredit('665976224812', '3000.00'), [debitRow]);
    assert.deepEqual([r.type, r.action], ['transfer', 'ignore']);
    assert.equal(r.related[0].id, 'debit-1');
    assert.equal(debitRow.amount, 3000, 'known rows are never modified');
  });

  it('pairs them in the other order too', () => {
    const creditRow = row({ id: 'credit-1', amount: 3000, category: 'Received', transaction_type: 'received', raw_message: f.hdfcCredit('665976224812', '3000.00') });
    assert.equal(run(f.iciciUpiDebit('SOME ONE', '3,000.00', '665976224812'), [creditRow]).type, 'transfer');
  });

  it('does NOT pair on amount alone: a matching amount with no shared reference is not evidence', () => {
    const debitRow = row({ amount: 3000, raw_message: f.iciciUpiDebit('SOME ONE', '3,000.00', '665976224812') });
    assert.equal(run(f.hdfcCredit('111111111111', '3000.00'), [debitRow]).type, 'received');
  });

  it('a shared reference with a DIFFERENT amount is a conflict: review, not record', () => {
    const known = [row({ amount: 100, raw_message: f.iciciUpiDebit('KABIR NAIR', '100.00', '630111111111') })];
    const r = run(f.iciciUpiDebit('KABIR NAIR', '250.00', '630111111111'), known);
    assert.equal(r.action, 'review');
    assert.match(r.review.reason, /amount differs/);
  });
});

describe('Layer 4: refund linking', () => {
  const purchase = (over) => row({ id: 'buy-1', amount: 2063, description: 'Shopco Purchase', category: 'Shopping', raw_message: f.hdfcCard('2063', 'PYU*SHOPCO DESIGNS PRI'), ...over });

  it('links a full refund to its purchase and inherits the category', () => {
    const r = run(f.hdfcRefund('PYU*SHOPCO DESIGNS PRI', '2063'), [purchase()]);
    assert.equal(r.link.id, 'buy-1');
    assert.equal(r.category, 'Shopping');
    assert.equal(r.signedAmount, -2063);
  });
  it('links a partial refund', () => {
    assert.equal(run(f.hdfcRefund('PYU*SHOPCO DESIGNS PRI', '500'), [purchase()]).link.id, 'buy-1');
  });
  it('never links a refund larger than the purchase', () => {
    assert.equal(run(f.hdfcRefund('PYU*SHOPCO DESIGNS PRI', '9000'), [purchase()]).link, null);
  });
  it('never links across different merchants, even with the same amount', () => {
    assert.equal(run(f.hdfcRefund('PYU*OTHERSHOP LTD', '2063'), [purchase()]).link, null);
  });
  it('picks the right purchase among several, preferring the exact amount', () => {
    const near = purchase({ id: 'buy-2', amount: 4000, raw_message: f.hdfcCard('4000', 'PYU*SHOPCO DESIGNS PRI') });
    assert.equal(run(f.hdfcRefund('PYU*SHOPCO DESIGNS PRI', '2063'), [near, purchase()]).link.id, 'buy-1');
  });
  it('an unlinked refund is still a refund (it just keeps the legacy behaviour)', () => {
    const r = run(f.hdfcRefund('PYU*SHOPCO DESIGNS PRI', '2063'), []);
    assert.deepEqual([r.type, r.action, r.link], ['refund', 'record', null]);
  });
});
