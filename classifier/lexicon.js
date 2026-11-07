'use strict';
// Generic, bank-agnostic vocabulary. DATA ONLY: extend these lists (or pass user config)
// instead of editing engine logic. Nothing here refers to a specific user, account or person.

// One-time passwords are never transactions. Checked before everything else.
const OTP_PATTERN = /\bOTP\b|one.?time.?pass(?:word)?|verification code|\bpasscode\b/i;

// Messages that are NOT money movements. Applied only to messages that NO bank adapter recognised, so a real
// alert in a known format can never be swallowed here (a regression guard), and as a gate before the generic fallback.
const INFO_PATTERNS = [
  ['scheduled',            /\b(?:will be|to be|shall be)\s+debited\b/i],
  ['failed',               /\b(?:declined|could not be processed|unsuccessful|transaction failed|payment failed)\b/i],
  ['refund_pending',       /\brefund\s+initiated\b|\bto receive your refund\b/i],
  ['reward',               /\breward\s+points?\b|\bpoints?\s+credited\b/i],
  ['balance',              /\b(?:available|avl)\.?\s*bal(?:ance)?\b[^.]*\bas on\b|gone below minimum|\bminimum balance\b/i],
  ['statement',            /\bstatement\b.*\b(?:generated|ready|available|has been)\b|\bstatement generated\b/i],
  ['mandate',              /\b(?:autopay|e-?mandate|upi[\s-]?mandate|one[\s-]?time mandate|standing instruction)\b/i],
  ['collect_request',      /\bhas requested money\b|\bon approval\b|\bcollect request\b/i],
  ['card_payment_received',/\bpayment of (?:rs\.?|inr)\s*[\d,]+(?:\.\d+)?\s+(?:has been\s+)?received\b[^.]*\bcredit card\b|\bpayment of (?:rs\.?|inr)\s*[\d,]+(?:\.\d+)?.*\bcredited to your card\b/i],
  ['confirmation',         /\bsuccessfully processed payment of\b/i],
  ['bill_presented',       /\bbill for (?:rs\.?|inr)\s*[\d,]+(?:\.\d+)?\s+due on\b|\bhas been presented\b/i],
  ['loan_info',            /\bloan\s+(?:update|contract|facility|disbursed)\b|\bpre-?approved\b|\bpersonal loan\b/i],
  ['investment_info',      /\bsip purchase\b|\bfolio\b|\blien\b|\be-?voting\b/i],
  ['promo',                /\b(?:zero processing fee|apply now|click here|t&c|tnc|eligible for|limited time)\b/i],
];

// Counterparty / narration that indicates an investment institution (institution TYPES, not brands).
// Brands or anything user-specific belong in userConfig.investmentPayees.
const INVESTMENT_RX = /\b(?:broking|brokerage|securities|demat|mutual\s+fund|asset\s+management|clearing\s+corp(?:oration)?|invest(?:ment|ments|ing)?|national\s+pension|nps\s+trust)\b/i;

// Narration on an incoming corporate (ACH) credit that marks it as a return on an investment.
const DIVIDEND_RX = /\b(?:div|dividend|interest|int)\b/i;

// Counterparty / narration that indicates a credit-card bill payment (money moving to settle a card).
const CARD_BILL_RX = /\b(?:credit\s*card|card\s+(?:bill|payment|dues|outstanding)|cc\s+(?:bill|payment)|cardmember)\b/i;

// Institutions that appear in SMS text (used only to label the source; unknown => null).
const INSTITUTION_RX = /\b(HDFC|ICICI|SBI|AXIS|KOTAK|YES\s*BANK|IDFC|INDUSIND|PNB|CANARA|BANK OF BARODA|BOB|FEDERAL|IDBI|UNION BANK|RBL|AU SMALL|PAYTM|AIRTEL PAYMENTS)\b/i;

module.exports = { OTP_PATTERN, INFO_PATTERNS, INVESTMENT_RX, DIVIDEND_RX, CARD_BILL_RX, INSTITUTION_RX };
