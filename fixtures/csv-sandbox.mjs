// CSV-shaped payload for the keyless adapter, exercising SEVEN dialects at once:
//   files[0] — a Fidelity "Positions" export (Account Number/Account Name/
//              Symbol/Description/Quantity/Last Price/Current Value/Cost Basis
//              Total), complete with the real-world noise: a preamble line
//              before the header, quoted money cells with commas, a "--" cost
//              basis, a Pending Activity row, and a trailing disclaimer line.
//              Two accounts live in one file (Fidelity groups by Account
//              Number): a taxable brokerage and an "Employer 401(k)" whose
//              type must be guessed from its NAME (positions exports carry no
//              type column → CLASSIFICATION_GUESSED, always).
//   files[1] — a generic accounts CSV (Account Name/Type/Balance + optional
//              Interest Rate/Minimum Payment), with a currency-symbol balance,
//              a parenthesized-negative card balance, a mortgage with no
//              property value (→ 80%-LTV estimate), and a stray "Notes"
//              column that must surface in CSV_UNMAPPED_COLUMNS.
//   files[2] — a Monarch Money balances download: balance HISTORY (two dated
//              rows for the Vanguard account — only the newest may survive;
//              summing history would fabricate a balance) with explicit
//              Account Type values (no classification guessing).
//   files[3] — a Monarch Money transactions export: Mint-style signs (money-in
//              positive), monthly transfers into the Vanguard brokerage, a
//              "Dividends & Capital Gains" row that must be excluded as
//              growth, and a negative (sell/withdrawal) row that never counts.
//   files[4] — a YNAB register export: Outflow/Inflow column PAIR, transfers
//              into the Roth IRA (matched to files[1] by account name), a
//              balance-adjustment row (market growth — excluded), and the
//              structural CSV_TRANSACTIONS_ONLY warning (YNAB carries no
//              balances).
//   files[5] — an Empower (Personal Capital) holdings export: Account column
//              groups rows, no Cost Basis column → NO_COST_BASIS per holding,
//              account typed from its NAME ("Rollover IRA" → traditional).
//   files[6] — a Copilot Money transactions export (community-documented,
//              low-confidence dialect): INVERTED signs (spending positive,
//              money-in negative), transfers into the Schwab account from
//              files[2], a dividend row excluded as growth.

const fidelityPositions = [
  'Positions for account(s) as of Jul-02-2026',
  'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total,Type',
  'Z12345678,Individual Brokerage,VTI,VANGUARD TOTAL STOCK MARKET ETF,420,$305.12,"$128,150.40","$95,000.00",Cash',
  'Z12345678,Individual Brokerage,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,5200,$1.00,"$5,200.00",--,Cash',
  'Z12345678,Individual Brokerage,Pending Activity,,,,"$250.00",,',
  'X98765432,Employer 401(k),FXAIX,FIDELITY 500 INDEX FUND,850,$211.76,"$179,996.00","$140,000.00",Cash',
  '',
  '"The data and information in this spreadsheet is provided to you solely for your use."',
].join('\r\n');

const genericAccounts = [
  'Account Name,Type,Balance,Interest Rate,Minimum Payment,Notes',
  'Everyday Checking,Checking,"$8,450.25",,,primary household account',
  'High-Yield Savings,Savings,"$32,000.00",,,',
  'Roth IRA,Roth IRA,"$54,000.00",,,',
  'College Fund,529,"$21,500.00",,,for Sam',
  'Home Mortgage,Mortgage,"$310,000.00",5.25%,"$1,980.00",30yr fixed',
  'Rewards Visa,Credit Card,"($1,850.00)",21.99%,$50.00,carries a balance',
].join('\n');

const monarchBalances = [
  'Date,Account,Account Type,Institution,Balance',
  '2026-06-30,Vanguard Brokerage,Brokerage,Vanguard,"$61,000.00"', // stale history row — must lose
  '2026-07-01,Vanguard Brokerage,Brokerage,Vanguard,"$62,400.00"',
  '2026-07-01,Schwab Taxable,Brokerage,Charles Schwab,"$18,000.00"',
  '2026-07-01,Ally Savings,Savings,Ally Bank,"$12,000.00"',
].join('\n');

const monarchTransactions = [
  'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags',
  ...['2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']
    .map((d) => `${d},Vanguard,Transfer,Vanguard Brokerage,VANGUARD BUY INVESTMENT,,"$1,250.00",`),
  '2026-03-12,Vanguard,Dividends & Capital Gains,Vanguard Brokerage,VANGUARD DIV PAYMENT,,$180.00,', // growth → excluded
  '2026-04-20,Vanguard,Transfer,Vanguard Brokerage,VANGUARD SELL,,"-$400.00",',                      // money out → excluded
].join('\n');

const ynabRegister = [
  '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
  ...['01/12/2026', '02/12/2026', '03/12/2026', '04/12/2026', '05/12/2026', '06/12/2026']
    .map((d) => `"Roth IRA",,"${d}","Transfer : Everyday Checking",,,,"monthly Roth transfer","$0.00","$450.00","Cleared"`),
  '"Roth IRA",,"03/28/2026","Reconciliation Balance Adjustment",,,,"market growth","$0.00","$1,200.00","Reconciled"', // adjustment ≠ contribution
  '"Everyday Checking",,"02/03/2026","Grocery Store","Everyday Expenses: Groceries","Everyday Expenses","Groceries",,"$142.19","$0.00","Cleared"',
].join('\n');

const empowerHoldings = [
  'Account,Ticker,Name,Shares,Price,Change,1 Day %,1 Day $,Value',
  'Empower Rollover IRA,VTI,Vanguard Total Stock Market ETF,100,"$305.12","$1.20","0.39%","$120.00","$30,512.00"',
  'Empower Rollover IRA,VBTLX,Vanguard Total Bond Market Index,500,"$10.50","-$0.02","-0.19%","-$10.00","$5,250.00"',
].join('\n');

const copilotTransactions = [
  'date,name,amount,status,category,parent category,excluded,tags,type,account,account mask,note,recurring',
  ...['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10']
    .map((d) => `${d},Schwab Transfer,-500.00,posted,Transfers,Transfers,false,,internal transfer,Schwab Taxable,1234,,monthly`),
  '2026-04-15,Schwab Dividend,-75.00,posted,Dividends,Investment,false,,income,Schwab Taxable,1234,,',    // growth → excluded
  '2026-03-22,Chipotle,18.40,posted,Restaurants,Food,false,,regular,Everyday Checking,5678,,',            // spending (positive) → excluded
].join('\n');

export const csvRaw = {
  asOf: '2026-07-02T00:00:00.000Z',
  owner: {
    desiredAnnualSpend: 80000,
    filingState: 'WA',
    earners: [{ name: 'Jordan', age: 39, retirementAge: 60, annualSalary: 165000 }],
  },
  files: [
    { name: 'fidelity-positions.csv', content: '\uFEFF' + fidelityPositions }, // BOM, the Excel way
    { name: 'accounts.csv', kind: 'accounts', content: genericAccounts },
    { name: 'monarch-balances.csv', content: monarchBalances },
    { name: 'monarch-transactions.csv', content: monarchTransactions },
    { name: 'ynab-register.csv', content: ynabRegister },
    { name: 'empower-holdings.csv', content: empowerHoldings },
    { name: 'copilot-transactions.csv', content: copilotTransactions },
  ],
};
