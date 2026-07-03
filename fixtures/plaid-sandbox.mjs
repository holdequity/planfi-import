// Plaid-sandbox-shaped payload (merged /accounts + /investments/holdings +
// /liabilities), trimmed to the fields the adapter reads. Mirrors real Plaid
// response shapes. Intentionally includes a holding with NO cost basis and a
// low-confidence subtype to exercise the warning paths.

export const plaidRaw = {
  asOf: '2026-07-02T00:00:00.000Z',
  // Two earners → joint household. Accounts carry owner_index (0/1).
  owner: {
    desiredAnnualSpend: 90000, filingState: 'CA',
    earners: [
      { name: 'Alex', age: 41, retirementAge: 62, annualSalary: 185000 },
      { name: 'Sam', age: 39, retirementAge: 62, annualSalary: 120000 },
    ],
  },
  accounts: [
    { account_id: 'chk1', name: 'Checking', type: 'depository', subtype: 'checking', balances: { current: 18400, iso_currency_code: 'USD' } },
    { account_id: 'sav1', name: 'Savings', type: 'depository', subtype: 'savings', balances: { current: 52000 } },
    { account_id: 'brk1', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balances: { current: 240000 }, owner_index: 0 },
    { account_id: 'k401', name: 'Fidelity 401(k)', type: 'investment', subtype: '401k', balances: { current: 315000 }, owner_index: 0 },
    { account_id: 'roth1', name: 'Roth IRA', type: 'investment', subtype: 'roth', balances: { current: 88000 }, owner_index: 1 },
    { account_id: 'hsa1', name: 'HSA', type: 'investment', subtype: 'hsa', balances: { current: 22000 } },
    { account_id: 'edu1', name: "Kid's 529", type: 'investment', subtype: '529', balances: { current: 41000 } },
    { account_id: 'mtg1', name: 'Home mortgage', type: 'loan', subtype: 'mortgage', balances: { current: 512000 } },
    { account_id: 'std1', name: 'Student loan', type: 'loan', subtype: 'student', balances: { current: 28000 } },
    { account_id: 'cc1', name: 'Sapphire card', type: 'credit', subtype: 'credit card', balances: { current: 4200 } },
    { account_id: 'weird1', name: 'Mystery acct', type: 'investment', subtype: 'annuity', balances: { current: 15000 } },
  ],
  securities: [
    { security_id: 's_vti', ticker_symbol: 'VTI', name: 'Vanguard Total Market ETF', type: 'etf' },
    { security_id: 's_aapl', ticker_symbol: 'AAPL', name: 'Apple Inc', type: 'equity' },
    { security_id: 's_btc', ticker_symbol: 'BTC', name: 'Bitcoin', type: 'cryptocurrency' },
    { security_id: 's_tgt', ticker_symbol: null, name: 'Target Retirement 2045', type: 'mutual fund' },
  ],
  holdings: [
    { account_id: 'brk1', security_id: 's_vti', quantity: 800, institution_value: 200000, cost_basis: 150000 },
    { account_id: 'brk1', security_id: 's_btc', quantity: 0.5, institution_value: 40000, cost_basis: null },
    { account_id: 'k401', security_id: 's_tgt', quantity: 3200, institution_value: 315000, cost_basis: 260000 },
    { account_id: 'roth1', security_id: 's_aapl', quantity: 400, institution_value: 88000, cost_basis: 41000 },
  ],
  liabilities: {
    mortgage: [{ account_id: 'mtg1', interest_rate: { percentage: 6.25 }, next_monthly_payment: 3150, origination_principal_amount: 560000, maturity_date: '2052-06-01', property_address: { city: 'Palo Alto', street: '1 Main St' } }],
    student: [{ account_id: 'std1', interest_rate_percentage: 5.5, minimum_payment_amount: 310 }],
    credit: [{ account_id: 'cc1', aprs: [{ apr_percentage: 21.9 }], minimum_payment_amount: 95 }],
  },
  // /investments/transactions — monthly contributions Jan–Jun 2026 (drives the
  // inferred savings rate). brk1 $2k/mo, k401 $1.5k/mo (Alex), roth1 $500/mo (Sam).
  investmentTransactions: [
    ...monthly('brk1', 2000), ...monthly('k401', 1500), ...monthly('roth1', 500),
  ],
};

function monthly(account_id, amount) {
  return ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']
    .map((date) => ({ account_id, type: 'cash', subtype: 'contribution', amount: -amount, date }));
}
