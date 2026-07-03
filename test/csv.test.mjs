import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvAdapter, parseCsv, moneyCell } from '../src/adapters/csv.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { csvRaw } from '../fixtures/csv-sandbox.mjs';

const cfp = csvAdapter.normalize(csvRaw);

test('parseCsv handles quoted fields, embedded commas/newlines, CRLF, doubled quotes, BOM', () => {
  const rows = parseCsv('\uFEFFa,"b,1","c""q"\r\n"multi\nline",2,3\r\nx,,z');
  assert.deepEqual(rows, [['a', 'b,1', 'c"q'], ['multi\nline', '2', '3'], ['x', '', 'z']]);
  // Unclosed quote at EOF must not throw — the field just ends.
  assert.deepEqual(parseCsv('a,"unclosed'), [['a', 'unclosed']]);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\r\n'), []);
});

test('moneyCell parses currency symbols, commas, parens negatives, percents; junk → undefined', () => {
  assert.equal(moneyCell('$1,234.56'), 1234.56);
  assert.equal(moneyCell('(1,850.00)'), -1850);
  assert.equal(moneyCell('-500'), -500);
  assert.equal(moneyCell('+12'), 12);
  assert.equal(moneyCell('5.25%'), 5.25);
  assert.equal(moneyCell('--'), undefined);
  assert.equal(moneyCell('N/A'), undefined);
  assert.equal(moneyCell(''), undefined);
  assert.equal(moneyCell('abc'), undefined);
  assert.equal(moneyCell('1.2.3'), undefined);
});

test('Fidelity positions dialect: preamble skipped, accounts grouped by number, noise rows dropped', () => {
  const by = Object.fromEntries(cfp.accounts.map((a) => [a.id, a]));
  const brk = by['Z12345678'];
  assert.equal(brk.class, 'investment');
  assert.equal(brk.institution, 'Fidelity');
  assert.equal(brk.holdings.length, 2, 'Pending Activity + disclaimer rows must not become holdings');
  const vti = brk.holdings.find((h) => h.ticker === 'VTI');
  assert.equal(vti.quantity, 420);
  assert.equal(vti.value, 128150.4);
  assert.equal(vti.costBasis, 95000);
  assert.equal(vti.assetType, 'etf');
  // Fidelity core position: symbol de-starred, "--" basis → NO_COST_BASIS, money-market → cash.
  const core = brk.holdings.find((h) => h.ticker === 'SPAXX');
  assert.equal(core.costBasis, undefined);
  assert.equal(core.assetType, 'cash');
  assert.ok(cfp.meta.warnings.some((w) => w.code === 'NO_COST_BASIS' && w.accountId === 'Z12345678'));
  // Account balance = sum of holding values.
  assert.ok(Math.abs(brk.balance - (128150.4 + 5200)) < 1e-9);
});

test('positions files carry no type column → account typed from its NAME, always CLASSIFICATION_GUESSED', () => {
  const k401 = cfp.accounts.find((a) => a.id === 'X98765432');
  assert.equal(k401.taxTreatment, 'traditional'); // "Employer 401(k)" → 401k
  assert.match(k401.subtype, /401k/);
  const brk = cfp.accounts.find((a) => a.id === 'Z12345678');
  assert.equal(brk.taxTreatment, 'taxable'); // "Individual Brokerage"
  for (const id of ['Z12345678', 'X98765432']) {
    assert.ok(cfp.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === id),
      `name-derived typing must be surfaced for ${id}`);
  }
});

test('generic accounts dialect: Type column classified, money cells cleaned, debts |abs|ed', () => {
  const byName = Object.fromEntries(cfp.accounts.map((a) => [a.name, a]));
  assert.equal(byName['Everyday Checking'].class, 'depository');
  assert.equal(byName['Everyday Checking'].balance, 8450.25);
  assert.equal(byName['Roth IRA'].taxTreatment, 'roth');
  assert.equal(byName['College Fund'].taxTreatment, '529');
  const mtg = byName['Home Mortgage'];
  assert.equal(mtg.class, 'loan');
  assert.equal(mtg.subtype, 'mortgage');
  assert.equal(mtg.balance, 310000);
  assert.ok(Math.abs(mtg.liability.rate - 0.0525) < 1e-9);
  assert.equal(mtg.liability.minPayment, 1980);
  // Accounting-style "(1,850.00)" negative → positive amount owed.
  const visa = byName['Rewards Visa'];
  assert.equal(visa.class, 'credit');
  assert.equal(visa.balance, 1850);
  assert.ok(Math.abs(visa.liability.rate - 0.2199) < 1e-9);
});

test('stray columns surface in CSV_UNMAPPED_COLUMNS (stable code), never silently dropped', () => {
  const w = cfp.meta.warnings.find((x) => x.code === 'CSV_UNMAPPED_COLUMNS');
  assert.ok(w, 'the generic accounts file has a Notes column that maps to nothing');
  assert.equal(w.severity, 'warn');
  assert.match(w.message, /"notes"/);
  assert.match(w.message, /accounts\.csv/);
  assert.ok(cfp.meta.unmapped.some((u) => Array.isArray(u.unmappedColumns) && u.unmappedColumns.includes('notes')));
});

test('Schwab positions dialect: single account per file, named from the file', () => {
  const out = csvAdapter.normalize({
    files: [{
      name: 'roth-positions.csv',
      content: [
        'Symbol,Description,Qty (Quantity),Price,Mkt Val (Market Value),Cost Basis',
        'SWTSX,SCHWAB TOTAL STOCK MARKET INDEX,1000,"$85.50","$85,500.00","$60,000.00"',
        'SCHD,SCHWAB US DIVIDEND EQUITY ETF,200,"$28.10","$5,620.00","$4,100.00"',
      ].join('\n'),
    }],
  });
  assert.equal(out.accounts.length, 1);
  const a = out.accounts[0];
  assert.equal(a.institution, 'Charles Schwab');
  assert.equal(a.name, 'roth-positions'); // file name, .csv stripped
  assert.equal(a.taxTreatment, 'roth');   // name hint — still a guess
  assert.ok(out.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === a.id));
  assert.ok(Math.abs(a.balance - 91120) < 1e-9);
  assert.equal(a.holdings.find((h) => h.ticker === 'SCHD').assetType, 'etf');
});

test('Vanguard download dialect: accounts grouped by number', () => {
  const out = csvAdapter.normalize({
    files: [{
      content: [
        'Account Number,Investment Name,Symbol,Shares,Share Price,Total Value',
        '87654321,Vanguard Total Stock Market Index Fund Admiral Shares,VTSAX,900.5,"$125.00","$112,562.50"',
        '87654321,Vanguard Federal Money Market Fund,VMFXX,3000,"$1.00","$3,000.00"',
        '11112222,Vanguard Total Bond Market Index Fund,VBTLX,400,"$10.50","$4,200.00"',
      ].join('\n'),
    }],
  });
  assert.equal(out.accounts.length, 2);
  const a = out.accounts.find((x) => x.id === '87654321');
  assert.equal(a.institution, 'Vanguard');
  assert.equal(a.holdings.length, 2);
  assert.ok(Math.abs(a.balance - 115562.5) < 1e-9);
  assert.equal(a.holdings.find((h) => h.ticker === 'VTSAX').assetType, 'mutual_fund');
  assert.equal(a.holdings.find((h) => h.ticker === 'VMFXX').assetType, 'cash');
  assert.equal(out.accounts.find((x) => x.id === '11112222').holdings[0].assetType, 'bond');
});

test('no Type column + no recognizable name → taxable at low confidence, warned — never fabricated', () => {
  const out = csvAdapter.normalize({
    files: [{ name: 'mystery.csv', content: 'Account Name,Balance\nHoliday Fund,"$5,000.00"' }],
  });
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].class, 'investment');
  assert.equal(out.accounts[0].taxTreatment, 'taxable');
  assert.equal(out.accounts[0].balance, 5000);
  const w = out.meta.warnings.find((x) => x.code === 'CLASSIFICATION_GUESSED');
  assert.ok(w && w.severity === 'warn');
  assert.match(w.message, /no recognizable type/i);
});

test('unrecognized headers → best-effort generic mapping + CSV_UNMAPPED_COLUMNS naming the columns', () => {
  const out = csvAdapter.normalize({
    files: [{
      name: 'weird.csv',
      content: [
        'Nickname,Institution Ref,Widget Score,Money',
        'Old 401k Rollover IRA,XX-1,7,"$44,000.00"',
        'Beach Fund,XX-2,3,"$9,500.00"',
      ].join('\n'),
    }],
  });
  assert.equal(out.accounts.length, 2, 'balances still import through the best-effort path');
  const ira = out.accounts.find((a) => a.name === 'Old 401k Rollover IRA');
  assert.equal(ira.balance, 44000);
  assert.equal(ira.taxTreatment, 'traditional'); // name hint, guessed
  const w = out.meta.warnings.find((x) => x.code === 'CSV_UNMAPPED_COLUMNS');
  assert.ok(w, 'best-effort mapping must announce itself');
  assert.match(w.message, /"widget score"/);
  assert.ok(out.meta.warnings.filter((x) => x.code === 'CLASSIFICATION_GUESSED').length >= 2);
});

test('transactions files drive contribution inference with the shared growth-exclusion rules', () => {
  const files = [
    { name: 'accounts.csv', content: 'Account Name,Type,Balance\nMy Brokerage,Brokerage,"$100,000.00"\nMy Checking,Checking,"$5,000.00"' },
    {
      name: 'transactions.csv',
      content: [
        'Account,Date,Amount,Description',
        ...['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']
          .map((d) => `My Brokerage,${d},"$1,000.00",ACH deposit`),
        'My Brokerage,2026-03-20,$800.00,Dividend received',   // growth → excluded
        'My Brokerage,2026-04-02,"($500.00)",ACH withdrawal',  // outflow → excluded
        'My Checking,2026-04-10,"$2,000.00",Payroll deposit',  // not an investment account → ignored
      ].join('\n'),
    },
  ];
  const out = csvAdapter.normalize({ files });
  const brk = out.accounts.find((a) => a.name === 'My Brokerage');
  // $1,000/mo over the ~5-month observed span — dividends/outflows excluded.
  assert.ok(brk.estMonthlyContribution >= 1000 && brk.estMonthlyContribution <= 1300, `got ${brk.estMonthlyContribution}`);
  assert.equal(out.accounts.find((a) => a.name === 'My Checking').estMonthlyContribution, undefined);
  assert.ok(!out.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE'), 'all deposits were labeled');
  const { plan } = toPlanfiPlan(out);
  assert.equal(plan.stocks.monthly_contribution, brk.estMonthlyContribution);
});

test('unlabeled CSV deposits are counted but flagged COARSE_INFERENCE', () => {
  const out = csvAdapter.normalize({
    files: [
      { content: 'Account Name,Type,Balance\nBrokerage,Brokerage,"$10,000"' },
      { kind: 'transactions', content: 'Account,Date,Amount\nBrokerage,2026-01-15,$500\nBrokerage,2026-03-15,$500' },
    ],
  });
  assert.ok(out.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE' && w.severity === 'warn'));
  assert.ok(out.accounts[0].estMonthlyContribution > 0);
});

test('explicit file.kind overrides the header fingerprint', () => {
  // These headers fingerprint as generic-accounts; kind forces transactions
  // (which then fails to resolve, so the file maps best-effort under that kind).
  const out = csvAdapter.normalize({
    files: [{ name: 'x.csv', kind: 'transactions', content: 'Account Name,Balance\nA,"$10"' }],
  });
  assert.equal(out.accounts.length, 1, 'no transactions dialect matched → best-effort still imports the balance');
  assert.ok(out.meta.warnings.some((w) => w.code === 'CSV_UNMAPPED_COLUMNS'));
});

test('empty / unparseable / money-free files warn honestly and import nothing', () => {
  const out = csvAdapter.normalize({
    files: [
      { name: 'empty.csv', content: '' },
      { name: 'prose.csv', content: 'hello there\njust,words,here\nno,money,anywhere' },
    ],
  });
  assert.equal(out.accounts.length, 0);
  const codes = out.meta.warnings.filter((w) => w.code === 'CSV_UNMAPPED_COLUMNS');
  assert.equal(codes.length, 2);
  assert.equal(out.meta.unmapped.length, 2);
});

test('duplicate account ids across files stay unique', () => {
  const content = 'Account Number,Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total\nZ1,Brokerage,VTI,VANGUARD ETF,1,$100,"$100","$90"';
  const out = csvAdapter.normalize({ files: [{ content }, { content }] });
  const ids = out.accounts.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, `ids must be unique: ${ids}`);
});

test('csv fixture → full plan: buckets, 80%-LTV estimate, structured asks', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.account_balances.taxable, 133350);
  assert.equal(plan.account_balances.traditional, 179996);
  assert.equal(plan.account_balances.roth, 54000);
  assert.equal(plan.cash.current_value, 8450 + 32000);
  assert.equal(plan.stocks.current_value, 133350 + 179996 + 54000);
  assert.equal(plan.education_account.initialBalance, 21500);
  assert.equal(plan.real_estate[0].current_value, Math.round(310000 / 0.8));
  assert.ok(warnings.some((w) => w.code === 'HOME_VALUE_ESTIMATED'));
  const ask = needsInput.find((n) => n.field === 'home_value');
  assert.equal(ask.accountName, 'Home Mortgage');
  assert.ok(ask.label && ask.why);
  // The card carries an APR in the CSV → no debt_rate ask for it.
  assert.ok(!needsInput.some((n) => n.field === 'debt_rate'));
});

test('importToPlan wrapper works for csv', () => {
  const r = importToPlan('csv', csvRaw);
  assert.equal(r.cfp.source, 'csv');
  assert.equal(r.plan.tax_settings.state, 'WA');
  assert.equal(r.plan.earners[0].name, 'Jordan');
  assert.equal(r.plan.desired_annual_spend, 80000);
});
