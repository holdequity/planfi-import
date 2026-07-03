// Finicity (Mastercard Open Banking)-shaped payload, trimmed to the fields the
// adapter reads. Mirrors documented Finicity response shapes:
//   accounts     — GET /aggregation/v1/customers/{id}/accounts (type, balance,
//                  detail{} for loans/cards)
//   positions    — flattened investment position[] from the account-details
//                  calls, each tagged with its accountId
//   transactions — GET /aggregation/v3/customers/{id}/transactions
//                  (amounts positive = deposit; dates are EPOCH SECONDS)
//
// Two-earner household with one of each interesting account: HSA, 529,
// mortgage (no property record — Finicity has none, exercises the 80%-LTV
// estimate), student loan, a negative-reported credit card with no APR, a
// no-cost-basis crypto holding, and a low-confidence investmentTaxDeferred
// wrapper.

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000);

export const finicityRaw = {
  asOf: '2026-07-02T00:00:00.000Z',
  owner: {
    desiredAnnualSpend: 88000, filingState: 'CO',
    earners: [
      { name: 'Riley', age: 43, retirementAge: 62, annualSalary: 190000 },
      { name: 'Casey', age: 41, retirementAge: 62, annualSalary: 105000 },
    ],
  },
  accounts: [
    { id: 5001, name: 'Everyday Checking', type: 'checking', balance: 14200, currency: 'USD', institutionId: 101732 },
    { id: 5002, name: 'Online Savings', type: 'savings', balance: 48000 },
    { id: 5003, name: 'Taxable Brokerage', type: 'brokerageAccount', balance: 268000, ownerIndex: 0 },
    { id: 5004, name: 'Employer 401(k)', type: '401k', balance: 350000, ownerIndex: 0 },
    { id: 5005, name: 'Roth IRA', type: 'roth', balance: 74000, ownerIndex: 1 },
    { id: 5006, name: 'Health Savings', type: 'hsa', balance: 26000 },
    { id: 5007, name: 'College 529', type: '529plan', balance: 38000 },
    // Pre-tax wrapper of unknown flavor → traditional at LOW confidence (warned).
    { id: 5008, name: 'Old Variable Annuity', type: 'investmentTaxDeferred', balance: 45000, ownerIndex: 0 },
    // Finicity has no property account type → the mapper estimates home value.
    { id: 5009, name: 'Home Mortgage', type: 'mortgage', balance: 420000, detail: { interestRate: 5.5, payment: 2900, maturityDate: epoch('2048-05-01') } },
    { id: 5010, name: 'Student Loan', type: 'studentLoan', balance: 31000, detail: { interestRate: 4.8, paymentMinAmount: 340 } },
    // Negative-reported card balance (institution quirk) and NO APR on record.
    { id: 5011, name: 'Cashback Card', type: 'creditCard', balance: -2600, detail: {} },
  ],
  positions: [
    { accountId: 5003, id: 9001, symbol: 'VTI', description: 'Vanguard Total Market ETF', units: 900, marketValue: 210000, costBasis: 150000, securityType: 'ETF' },
    // No cost basis reported → NO_COST_BASIS warning; crypto → speculative.
    { accountId: 5003, id: 9002, symbol: 'BTC', description: 'Bitcoin', units: 0.55, marketValue: 58000, costBasis: null, securityType: 'Cryptocurrency' },
    { accountId: 5004, id: 9003, symbol: 'FXAIX', description: 'Fidelity 500 Index', units: 1750, marketValue: 350000, costBasis: 280000, securityType: 'Mutual Fund' },
  ],
  transactions: [
    // Monthly deposits Jan–Jun 2026 (epoch-second dates — the Finicity way).
    ...deposits(5003, 2100, { categorization: { category: 'Transfer' } }),
    ...deposits(5004, 1700, { investmentTransactionType: 'contribution' }),
    ...deposits(5005, 450, { investmentTransactionType: 'contribution' }),
    // A dividend credit that must be EXCLUDED from contribution inference.
    { id: 8000, accountId: 5003, amount: 800, transactedDate: epoch('2026-03-20'), categorization: { category: 'Dividends & Interest Income' }, description: 'VTI dividend' },
  ],
};

function deposits(accountId, amount, extra) {
  return ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']
    .map((d, i) => ({ id: accountId * 10 + i, accountId, amount, transactedDate: epoch(d), ...extra }));
}
