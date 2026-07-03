// CSV-shaped payload for the keyless adapter, exercising TWO dialects at once:
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
  ],
};
