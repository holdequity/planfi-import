// FDX (Financial Data Exchange)-shaped payload, trimmed to the fields the
// adapter reads. Mirrors the FDX API conventions:
//   accounts     — GET /accounts: each account WRAPPED in its shape key
//                  ({ depositAccount }, { investmentAccount }, { loanAccount },
//                  { locAccount }), accountType UPPERCASE, currentValue /
//                  currentBalance / principalBalance per shape, ISO dates
//   holdings     — flattened InvestmentHolding[] from the account-details
//                  calls, each tagged with its accountId (holdingType,
//                  symbol, units, marketValue, costBasis)
//   transactions — wrapped { investmentTransaction } records with
//                  debitCreditMemo + ISO postedTimestamp
//
// Two-earner household with one of each interesting account: HSA, 529,
// mortgage (FDX has no property entity → exercises the 80%-LTV estimate),
// student loan, a credit card with NO APR on record, a no-cost-basis
// DIGITALASSET holding, and an unknown-accountType account.

export const fdxRaw = {
  asOf: '2026-07-02T00:00:00.000Z',
  owner: {
    desiredAnnualSpend: 92000, filingState: 'NY',
    earners: [
      { name: 'Avery', age: 44, retirementAge: 63, annualSalary: 200000 },
      { name: 'Morgan', age: 42, retirementAge: 63, annualSalary: 118000 },
    ],
  },
  accounts: [
    { depositAccount: { accountId: 'fdx-chk', accountType: 'CHECKING', nickname: 'Everyday Checking', currentBalance: 16800, currency: { currencyCode: 'USD' } } },
    // interestRate on a depositAccount is a savings YIELD — must NOT become a debt APR.
    { depositAccount: { accountId: 'fdx-sav', accountType: 'SAVINGS', nickname: 'Emergency Savings', currentBalance: 54000, interestRate: 4.2 } },
    { investmentAccount: { accountId: 'fdx-brk', accountType: 'BROKERAGE', nickname: 'Joint Brokerage', currentValue: 295000, ownerIndex: 0 } },
    { investmentAccount: { accountId: 'fdx-401k', accountType: '401K', nickname: 'Acme 401(k)', currentValue: 380000, ownerIndex: 0 } },
    { investmentAccount: { accountId: 'fdx-roth', accountType: 'ROTH', nickname: 'Roth IRA', currentValue: 81000, ownerIndex: 1 } },
    { investmentAccount: { accountId: 'fdx-hsa', accountType: 'HSA', nickname: 'Health Savings', currentValue: 24000 } },
    { investmentAccount: { accountId: 'fdx-529', accountType: '529', nickname: 'College 529', currentValue: 36000 } },
    // Unknown accountType → the investmentAccount container is the fallback
    // class signal; taxable at LOW confidence + CLASSIFICATION_GUESSED.
    { investmentAccount: { accountId: 'fdx-mystery', accountType: 'DIGITALWALLET', nickname: 'Mystery Wallet', currentValue: 9000 } },
    // FDX has no property entity → the mapper estimates the home value (80% LTV).
    { loanAccount: { accountId: 'fdx-mtg', accountType: 'MORTGAGE', nickname: 'Home Mortgage', principalBalance: 405000, interestRate: 5.25, nextPaymentAmount: 2750, originalPrincipal: 480000, maturityDate: '2049-04-01' } },
    { loanAccount: { accountId: 'fdx-stu', accountType: 'STUDENTLOAN', nickname: 'Grad Student Loan', principalBalance: 27000, interestRate: 4.6, nextPaymentAmount: 320 } },
    // Card with NO APR on record → DEBT_RATE_MISSING + a debt_rate ask.
    { locAccount: { accountId: 'fdx-card', accountType: 'CREDITCARD', nickname: 'Travel Card', currentBalance: 3400, minimumPaymentAmount: 85 } },
  ],
  holdings: [
    { accountId: 'fdx-brk', holdingId: 'h1', symbol: 'VTI', securityName: 'Vanguard Total Stock Market ETF', holdingType: 'ETF', units: 780, marketValue: 238000, costBasis: 170000 },
    // No cost basis reported → NO_COST_BASIS warning; DIGITALASSET → speculative.
    { accountId: 'fdx-brk', holdingId: 'h2', symbol: 'ETH', securityName: 'Ether', holdingType: 'DIGITALASSET', units: 12, marketValue: 57000, costBasis: null },
    { accountId: 'fdx-401k', holdingId: 'h3', symbol: 'FXAIX', securityName: 'Fidelity 500 Index Fund', holdingType: 'MUTUALFUND', units: 1795, marketValue: 380000, costBasis: 290000 },
  ],
  transactions: [
    // Monthly credits Jan–Jun 2026 (ISO timestamps — the FDX way).
    ...credits('fdx-brk', 2200, { description: 'ACH TRANSFER IN' }),
    ...credits('fdx-401k', 1650, { transactionType: 'CONTRIBUTION' }),
    ...credits('fdx-roth', 500, { transactionType: 'CONTRIBUTION' }),
    // A dividend credit that must be EXCLUDED from contribution inference.
    { investmentTransaction: { transactionId: 'fdx-div-1', accountId: 'fdx-brk', transactionType: 'DIVIDEND', totalAmount: 700, debitCreditMemo: 'CREDIT', postedTimestamp: '2026-03-20T00:00:00.000Z', description: 'VTI dividend' } },
  ],
};

function credits(accountId, amount, extra) {
  return ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']
    .map((d, i) => ({ investmentTransaction: {
      transactionId: `${accountId}-t${i + 1}`, accountId, totalAmount: amount,
      debitCreditMemo: 'CREDIT', postedTimestamp: `${d}T00:00:00.000Z`, ...extra,
    } }));
}
