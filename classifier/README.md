# Ruvio classification engine

Turns a bank SMS into a decision: **record**, **ignore** or **review**. Pure JavaScript, no dependencies, no
network, no database, no framework. The caller (today `index.js`) handles storage and notifications.

> The engine understands money. The user's configuration understands whose money it is.

## Layers
| Layer | File | Job |
|---|---|---|
| 1 Normalise | `normalize.js` | amount, date, reference numbers, account hint, institution |
| 2 Extract | `adapters/*.js`, `lexicon.js` | is it a money movement? bank formats (modular), informational rules, generic fallback |
| 3 Classify | `classify.js` | expense, received, refund, investment, transfer, card payment |
| 4 Reconcile | `reconcile.js` | duplicates, own-account pairs (shared reference), refund → purchase link |
| 5 Decide | `classify.js` | confidence ≥ 0.85 → record; below → review; never a forced guess |

Order inside Layer 2: OTP gate → bank adapters → informational rules → generic fallback. Informational rules only
apply to messages no bank adapter recognised, so a real alert in a known format can never be swallowed by them.

## Use
```js
const { classify } = require('./classifier');
const r = classify(smsText, userConfig, { now: new Date(), known: existingRows });
// r.action: 'record' | 'ignore' | 'review'     r.type: expense | received | refund | investment | transfer | card_payment | duplicate | info | unknown
// r.signedAmount (what to store: refunds and redemptions are negative), r.merchant, r.category ('Received'/'Investments'/null),
// r.date, r.reference, r.confidence, r.reasons[], r.link, r.related[], r.review
```
`known` is optional: rows the caller already has (`id, amount, description, category, raw_message, created_at`).
`references(text)` tells the caller which reference numbers to look up. `known` rows are never modified.

## User configuration (all optional; the engine knows none of it)
`ownNames`, `ownVpas`, `ownAccounts` (last digits), `ignorePayees` (e.g. a card-bill service), `investmentPayees`.

## Add a bank
Create `adapters/yourbank.js` exporting `{ id, institution, extract(normalized) }` that returns `{ adapter, source, kind,
direction, amount, counterparty, channel, account, reference, confidence }` or `null`, then add it to `BANK_ADAPTERS` in
`adapters/index.js`. Unknown formats are never recorded automatically: they go to review until an adapter exists.

## Test
`npm test` (Node's built-in runner). `npm run validate -- export.tsv --config cfg.json --legacy old-index.js` replays a
real export oldest-first and reports totals, reviews, pairs, duplicates and regressions against the old parser.
