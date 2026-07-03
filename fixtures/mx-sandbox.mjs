// MX-Platform-shaped payload (accounts + holdings + transactions), trimmed to
// the fields the adapter reads. Includes a PROPERTY account (MX gives the home's
// market value) and an HSA + 529 to exercise the same paths as the Plaid fixture.

export const mxRaw = {
  asOf: '2026-07-02T00:00:00.000Z',
  owner: {
    desiredAnnualSpend: 84000, filingState: 'TX',
    earners: [{ name: 'Jordan', age: 45, retirementAge: 60, annualSalary: 210000 }],
  },
  accounts: [
    { guid: 'ACT-chk', name: 'Checking', type: 'CHECKING', balance: 21000, currency_code: 'USD' },
    { guid: 'ACT-sav', name: 'High-Yield Savings', type: 'SAVINGS', balance: 65000 },
    { guid: 'ACT-brk', name: 'Individual Brokerage', type: 'INVESTMENT', subtype: 'BROKERAGE', balance: 305000 },
    { guid: 'ACT-401k', name: 'Workplace 401(k)', type: 'INVESTMENT', subtype: '401K', balance: 420000 },
    { guid: 'ACT-roth', name: 'Roth IRA', type: 'INVESTMENT', subtype: 'ROTH_IRA', balance: 96000 },
    { guid: 'ACT-hsa', name: 'HSA', type: 'INVESTMENT', subtype: 'HSA', balance: 30000 },
    { guid: 'ACT-529', name: '529 College', type: 'INVESTMENT', subtype: '529', balance: 52000 },
    { guid: 'ACT-home', name: 'Primary Home', type: 'PROPERTY', market_value: 1450000 },
    { guid: 'ACT-mtg', name: 'Primary Home Mortgage', type: 'MORTGAGE', balance: 610000, interest_rate: 5.75, minimum_payment: 3800, original_balance: 700000, maturity_date: '2049-03-01' },
    { guid: 'ACT-auto', name: 'Auto Loan', type: 'LOAN', balance: 24000, interest_rate: 6.9, minimum_payment: 455 },
    { guid: 'ACT-cc', name: 'Rewards Card', type: 'CREDIT_CARD', balance: 3100, apr: 22.9, minimum_payment: 75 },
  ],
  holdings: [
    { account_guid: 'ACT-brk', symbol: 'VOO', description: 'Vanguard S&P 500', shares: 500, market_value: 260000, cost_basis: 180000, holding_type: 'ETF' },
    { account_guid: 'ACT-brk', symbol: 'GBTC', description: 'Grayscale Bitcoin', shares: 100, market_value: 45000, cost_basis: null, holding_type: 'Cryptocurrency' },
    { account_guid: 'ACT-401k', symbol: 'FXAIX', description: 'Fidelity 500 Index', shares: 2100, market_value: 420000, cost_basis: 300000, holding_type: 'Mutual Fund' },
  ],
  transactions: [
    ...credits('ACT-brk', 2500), ...credits('ACT-401k', 1800),
  ],
};

function credits(account_guid, amount) {
  return ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10']
    .map((date) => ({ account_guid, type: 'CREDIT', amount, category: 'Transfer', date }));
}
