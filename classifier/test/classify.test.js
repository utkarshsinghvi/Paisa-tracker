'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classify, parseLegacy } = require('..');
const f = require('./fixtures');

const run = (text, cfg = {}, ctx = {}) => classify(text, cfg, { now: f.NOW, ...ctx });

describe('A. Incoming money is not automatically income', () => {
  it('a credit from a person is Received', () => {
    const r = run(f.iciciUpiCredit());
    assert.deepEqual([r.action, r.type, r.category, r.signedAmount], ['record', 'received', 'Received', 1000]);
  });
  it('a NEFT credit is Received, with the remitter as the party', () => {
    const r = run(f.iciciNeft());
    assert.deepEqual([r.action, r.type, r.merchant, r.amount], ['record', 'received', 'ACME PAYROLL', 139604]);
  });
  it('a dividend/interest credit is an investment return, not Received', () => {
    const r = run(f.iciciAch());
    assert.deepEqual([r.type, r.subtype, r.signedAmount], ['investment', 'dividend', -3.5]);
  });
  it('a credit from an unnamed account goes to review instead of being guessed', () => {
    const r = run(f.iciciImpsUnnamed());
    assert.equal(r.action, 'review');
    assert.match(r.review.reason, /not named/);
  });
});

describe('B. Refunds and reversals', () => {
  it('completed refund and reversal offset the expense (negative amount)', () => {
    for (const t of [f.hdfcRefund(), f.hdfcReversal(), f.iciciCardRefund()]) {
      const r = run(t);
      assert.equal(r.type, 'refund');
      assert.ok(r.signedAmount < 0);
      assert.equal(r.action, 'record');
    }
  });
  it('a refund that was only INITIATED is not money received', () => {
    const r = run(f.hdfcRefundInitiated());
    assert.deepEqual([r.action, r.type, r.subtype], ['ignore', 'info', 'refund_pending']);
  });
  it('failed / declined payments are ignored', () => {
    assert.equal(run(f.hdfcDeclined()).action, 'ignore');
  });
  it('excess card balance moved back to your own account is an internal transfer, not income', () => {
    const r = run(f.hdfcExcessBalance());
    assert.deepEqual([r.action, r.type], ['ignore', 'transfer']);
  });
});

describe('C. Internal transfers (user configuration decides whose money it is)', () => {
  const cfg = { ownNames: ['Asha Rao'], ownVpas: ['asha@okbank'], ownAccounts: ['7777'], ignorePayees: ['billpay hub'] };
  it('own name, in either direction', () => {
    assert.equal(run(f.iciciUpiDebit('ASHA RAO'), cfg).type, 'transfer');
    assert.equal(run(f.iciciUpiCredit('ASHA RAO'), cfg).type, 'transfer');
  });
  it('own VPA and own account numbers', () => {
    assert.equal(run(f.hdfcUpiSent('ASHA@OKBANK'), cfg).type, 'transfer');
    assert.equal(run(`ICICI Bank Acct XXX111 debited with INR 500.00 on 17-Oct-26. Acct XXX7777 credited.UPI:622911191668.Call 18002662`, cfg).type, 'transfer');
  });
  it('WITHOUT that configuration the same name is just a person: no guessing from the name alone', () => {
    assert.equal(run(f.iciciUpiDebit('ASHA RAO')).type, 'expense');
  });
  it('a bank-truncated own name still matches', () => {
    assert.equal(run(f.iciciUpiDebit('ASHA RA'), { ownNames: ['ASHA RAO MEHTA'] }).type, 'expense', 'too short to be safe');
    assert.equal(run(f.iciciUpiDebit('ASHA RAO ME'), { ownNames: ['ASHA RAO MEHTA'] }).type, 'transfer');
  });
});

describe('D. Investments', () => {
  it('purchases are their own category and negative redemptions', () => {
    const buy = run(f.iciciUpiDebit('ACME BROKING', '5,000.00'));
    assert.deepEqual([buy.type, buy.category, buy.subtype, buy.signedAmount], ['investment', 'Investments', 'purchase', 5000]);
    const sell = run(f.iciciNeft('ACME SECURITIES LTD', '7,000.00'));
    assert.deepEqual([sell.type, sell.subtype, sell.signedAmount], ['investment', 'redemption', -7000]);
  });
  it('user-configured investment payees', () => {
    assert.equal(run(f.iciciUpiDebit('BULLION HOUSE'), { investmentPayees: ['bullion house'] }).type, 'investment');
    assert.equal(run(f.iciciUpiDebit('BULLION HOUSE')).type, 'expense');
  });
  it('a payout from a payee on the user\'s investment list is a confident redemption, not a review or income', () => {
    const t = `ICICI Bank Account XX111 credited:Rs. 14,877.26 on 06-Nov-26. Info CMS* ACME TRADE WITHDRAW REQ. Available Balance is Rs. 37,762.13.`;
    assert.equal(run(t).action, 'review', 'unknown platform without config: a human decides');
    const r = run(t, { investmentPayees: ['acme trade'] });
    assert.deepEqual([r.action, r.type, r.subtype, r.signedAmount], ['record', 'investment', 'redemption', -14877.26]);
  });
  it('a cafe called "Sip & Sip" is not an investment', () => {
    assert.equal(run(f.iciciUpiDebit('SIP AND SIP CAFE')).type, 'expense');
  });
});

describe('E. Credit cards', () => {
  it('card purchases are expenses', () => {
    assert.equal(run(f.hdfcCard()).type, 'expense');
    assert.equal(run(f.iciciCardSpend()).type, 'expense');
  });
  it('card-bill payments are not additional expenses', () => {
    assert.equal(run(f.hdfcCardPaymentReceived()).action, 'ignore');
    assert.equal(run(f.iciciCardPaymentReceived()).action, 'ignore');
    assert.equal(run(f.iciciUpiDebit('HDFC CREDIT CARD BILL')).type, 'card_payment');
    assert.equal(run(f.iciciUpiDebit('BILLPAY HUB'), { ignorePayees: ['billpay hub'] }).type, 'card_payment');
  });
  it('reward points, scheduled debits and OTPs are not transactions', () => {
    for (const t of [f.hdfcReward(), f.scheduled(), f.otp()]) assert.equal(run(t).action, 'ignore');
  });
});

describe('Layer 5: confidence and review', () => {
  it('an unfamiliar bank format is flagged for review, never recorded', () => {
    const r = run(f.otherBank());
    assert.equal(r.action, 'review');
    assert.equal(r.adapter, 'generic.fallback');
    assert.ok(r.confidence < 0.85);
  });
  it('a debit with only a bill-pay code and no payee needs review', () => {
    assert.equal(run(f.iciciBillDebit()).action, 'review');
  });
  it('implausible dates are dropped rather than trusted', () => {
    const r = classify(f.iciciUpiDebit(), {}, { now: new Date('2030-01-01') });
    assert.equal(r.date, null);
    assert.equal(r.action, 'record');
  });
  it('every result explains itself', () => {
    for (const t of [f.iciciUpiDebit(), f.hdfcRefundInitiated(), f.otherBank(), 'hello']) assert.ok(run(t).reasons.length > 0);
  });
});

describe('Backward compatibility with the old parseSMS shape', () => {
  it('keeps the legacy fields and the legacy "income" type name', () => {
    assert.deepEqual(parseLegacy(f.hdfcCard('125', 'RAZ*GAME THEORY'), {}), { amount: 125, merchant: 'RAZ*GAME THEORY', source: 'HDFC Card 2222', refund: false, type: 'expense', account: 'HDFC card 2222', reference: null });
    assert.equal(parseLegacy(f.iciciUpiCredit(), {}).type, 'income');
    assert.equal(parseLegacy(f.hdfcRefund(), {}).refund, true);
    assert.equal(parseLegacy(f.otp(), {}), null);
    assert.equal(parseLegacy(f.otherBank(), {}), null, 'review-level results are not recordable');
  });
});

describe('The engine stays generic (guard against hardcoded personal data)', () => {
  it('contains no personal names, accounts, cards or brands', () => {
    const banned = [/UTKARSH/i, /SINGHVI/i, /SKYDO/i, /ZERODHA/i, /GROWW/i, /BAJAJ/i, /CRED CLUB/i, /\b6264\b/, /\b3604\b/, /\b0639\b/, /\b639\b/];
    const root = path.join(__dirname, '..');
    const files = [];
    for (const dir of ['.', 'adapters']) for (const n of fs.readdirSync(path.join(root, dir))) if (n.endsWith('.js')) files.push(path.join(root, dir, n));
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const rx of banned) assert.ok(!rx.test(src), `${path.relative(root, file)} must not contain ${rx}`);
    }
  });
});
