'use strict';
// Synthetic, anonymised SMS fixtures in the formats the adapters understand. Dates are fixed; tests pass ctx.now.
module.exports = {
  NOW: new Date('2026-11-08T10:00:00Z'),
  iciciUpiDebit:  (name = 'KABIR NAIR', amt = '250.00', ref = '630111111111') => `ICICI Bank Acct XX111 debited for Rs ${amt} on 03-Nov-26; ${name} credited. UPI:${ref}. Call 18002662 for dispute. SMS BLOCK 111 to 9215676766.`,
  iciciUpiCredit: (name = 'RIYA MEHTA', amt = '1,000.00', ref = '630222222222') => `Dear Customer, Acct XX111 is credited with Rs ${amt} on 04-Nov-26 from ${name}. UPI:${ref}-ICICI Bank.`,
  iciciNeft:      (who = 'ACME PAYROLL', amt = '1,39,604.00') => `ICICI Bank Account XX111 credited:Rs. ${amt} on 30-Oct-26. Info NEFT-IDFB6273M4338458-${who} . Available Balance is Rs. 1,58,7`,
  iciciAch:       (narr = 'ACME FIN DIV 25 26', amt = '3.50') => `ICICI Bank Account XX111 credited:Rs. ${amt} on 05-Nov-26. Info ACH*${narr}*00000. Available Balance is Rs. 39,752.37.`,
  iciciImpsUnnamed: (amt = '125,000.00') => `ICICI Bank Account XX111 is credited with Rs ${amt} on 26-Oct-26 by Account linked to mobile number XXXXX01234. IMPS Ref. no. 623816044594.`,
  iciciBillDebit: () => `ICICI Bank Acc XX111 debited Rs. 2,51,900.00 on 26-Oct-26 InfoBIL*INFT*ABCD.Avl Bal Rs. 1,02,964.71.To dispute call 18002662 or SMS BLOCK 111 to 9215676766`,
  iciciCardSpend: (amt = '103.00', m = 'SHOPCO ONLINE') => `INR ${amt} spent using ICICI Bank Card XX0000 on 02-Nov-26 on ${m}. Avl Limit: INR 2,64,858.95. If not you, call 1800 2662/SMS BLOCK 0000 to 9215676766.`,
  iciciCardRefund: (m = 'SHOPCO ONLINE', amt = '2,099.00') => `${m} refund of Rs ${amt} credited to ICICI Bank Credit Card XX0000 on 28-OCT-26. Revised total due Rs 0, minimum due Rs .00`,
  iciciCardPaymentReceived: () => `Payment of Rs 7,398.20 has been received on your ICICI Bank Credit Card XX0000 through Bharat Bill Payment System on 13-OCT-26.`,
  hdfcCard:       (amt = '125', m = 'RAZ*GAME THEORY') => `Spent Rs.${amt} On HDFC Bank Card 2222 At ${m} On 2026-11-03:21:56:42.Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 2222 to 7308080808`,
  hdfcUpiSent:    (to = 'KABIR NAIR', amt = '1.00', ref = '132379940945') => `Sent Rs.${amt}\nFrom HDFC Bank A/C *3333\nTo ${to}\nOn 05/11/26\nRef ${ref}\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808`,
  hdfcRefund:     (m = 'PYU*SHOPCO DESIGNS PRI', amt = '2063') => `Alert! Rs. ${amt} refunded by ${m}   Bangalore    IND on 20/OCT/2026 & adjusted against HDFC Bank Credit Card 2222 View updated balance here: https://1.hdfc.bank.in/HDFCBK/s/abc`,
  hdfcReversal:   (m = 'RIDECO INDIA SYSTEMS', amt = '209.34') => `Transaction Reversed!On HDFC Bank CREDIT Card xx2222 Amt: Rs.${amt} By ${m} On 2026-10-11:08:58:21`,
  hdfcCredit:     (ref = '665976224812', amt = '1.00') => `Credit Alert! Rs.${amt} credited to HDFC Bank A/c XX3333 on 20-10-26 from VPA *ab@okicici (UPI ${ref})`,
  hdfcRefundInitiated: () => `Refund initiated: Amt: Rs.2062.82 on HDFC Bank Credit Card 2222.To receive your Refund,please update your Bank details:https://1.hdfc.bank.in/HDFCBK/a/xyz TnC.`,
  hdfcExcessBalance: () => `Excess Balance Refunded: Rs.10811.38 has been credited from your HDFC Bank Credit Card ending 2222 to your Bank A/c ending 3333 on 17-08-26.`,
  hdfcCardPaymentReceived: () => `DEAR HDFCBANK CARDMEMBER, PAYMENT OF Rs. 36752.00 RECEIVED TOWARDS YOUR CREDIT CARD ENDING WITH 2222 ON 14-10-2026.YOUR AVAILABLE`,
  hdfcReward:     () => `Reward Points Credited: 188 To HDFC Bank Credit Card 2222 On 03/NOV/2026 Towards 1% CashBack on all_other_SpendsCheck Here: https://1.hdfc.bank.in/HDFCBK/s/x`,
  hdfcDeclined:   () => `Transaction of Rs.5108.00 Declined on HDFC Bank Credit Card 2222 Reason: Domestic Contactless usage limit lower than amount`,
  otp:            () => `OTP is 427751 for txn of INR 1729.00 at SHOP on HDFC Bank card ending 2222. Valid till 10:48.`,
  scheduled:      () => `Alert: INR.119.00 will be debited on 25/10/2026 from HDFC Bank Card 2222 for Streamly India Pvt Ltd`,
  // A bank the engine has no adapter for: must be flagged, never guessed
  otherBank:      () => `Rs.500.00 debited from A/c XX7777 on 05-11-26 to GROCERY HUB. Ref 987654321012. Avl Bal Rs.9,000.00 - Example Bank`,
};
