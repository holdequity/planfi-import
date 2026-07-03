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
  // taxable = Fidelity brokerage 133,350.40 + Monarch Vanguard 62,400 + Monarch Schwab 18,000
  assert.equal(plan.account_balances.taxable, 213750);
  // traditional = Fidelity 401(k) 179,996 + Empower rollover IRA 35,762
  assert.equal(plan.account_balances.traditional, 215758);
  assert.equal(plan.account_balances.roth, 54000);
  assert.equal(plan.cash.current_value, 8450 + 32000 + 12000);
  assert.equal(plan.stocks.current_value, 213750 + 215758 + 54000);
  // Monarch (1,500/mo) + Copilot (667/mo) taxable transfers; YNAB Roth (540/mo) routes to the IRA block.
  assert.equal(plan.stocks.monthly_contribution, 1500 + 667);
  assert.deepEqual(plan.earners[0].retirement_accounts.ira, { type: 'roth', annual: 540 * 12 });
  assert.equal(plan.education_account.initialBalance, 21500);
  assert.equal(plan.real_estate[0].current_value, Math.round(310000 / 0.8));
  assert.ok(warnings.some((w) => w.code === 'HOME_VALUE_ESTIMATED'));
  const ask = needsInput.find((n) => n.field === 'home_value');
  assert.equal(ask.accountName, 'Home Mortgage');
  assert.ok(ask.label && ask.why);
  // The card carries an APR in the CSV → no debt_rate ask for it.
  assert.ok(!needsInput.some((n) => n.field === 'debt_rate'));
});

// ── consumer-tool dialects (Monarch / YNAB / Empower / Copilot) ──────────────

test('Monarch balances dialect: history collapsed to the newest row per account, types honored', () => {
  const byName = Object.fromEntries(cfp.accounts.map((a) => [a.name, a]));
  const vg = byName['Vanguard Brokerage'];
  assert.equal(vg.balance, 62400, 'the stale 2026-06-30 history row must lose to 2026-07-01 — and never be summed');
  assert.equal(vg.class, 'investment');
  assert.equal(vg.taxTreatment, 'taxable');
  assert.equal(vg.institution, 'Vanguard');
  assert.equal(byName['Ally Savings'].class, 'depository');
  assert.equal(byName['Ally Savings'].balance, 12000);
  // Explicit Account Type column → high confidence, NO guess warning.
  for (const a of [vg, byName['Ally Savings'], byName['Schwab Taxable']]) {
    assert.ok(!cfp.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === a.id),
      `${a.name} has an explicit Monarch Account Type — no guess to warn about`);
  }
});

test('Monarch balances: only one account per name survives (no duplicate from the history row)', () => {
  assert.equal(cfp.accounts.filter((a) => a.name === 'Vanguard Brokerage').length, 1);
});

test('Monarch account types "Real Estate"/"Vehicle" become property accounts, not fake investments', () => {
  const out = csvAdapter.normalize({
    files: [{
      content: [
        'Date,Account,Account Type,Institution,Balance',
        '2026-07-01,Primary Residence,Real Estate,,"$525,000.00"',
        '2026-07-01,2019 Outback,Vehicle,,"$14,500.00"',
      ].join('\n'),
    }],
  });
  const home = out.accounts.find((a) => a.name === 'Primary Residence');
  assert.equal(home.class, 'property');
  assert.equal(home.taxTreatment, 'na');
  assert.equal(home.balance, 525000);
  assert.equal(out.accounts.find((a) => a.name === '2019 Outback').class, 'property');
  // toPlanfiPlan turns a mortgage-less property into an owned home, not stocks.
  const { plan } = toPlanfiPlan(out);
  assert.ok(plan.real_estate.some((r) => r.name === 'Primary Residence' && r.current_value === 525000));
  assert.equal(plan.stocks.current_value, 0);
});

test('Monarch transactions dialect: category vocabulary drives growth exclusion', () => {
  const vg = cfp.accounts.find((a) => a.name === 'Vanguard Brokerage');
  // 6 × $1,250 transfers over ~5 months; the "Dividends & Capital Gains" $180
  // and the -$400 sell must be excluded.
  assert.equal(vg.estMonthlyContribution, 1500);
  assert.ok(!cfp.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE'),
    'every fixture deposit carries a category — nothing was counted coarsely');
});

test('YNAB register dialect: Outflow/Inflow pair nets correctly; balance adjustments are not contributions', () => {
  const roth = cfp.accounts.find((a) => a.name === 'Roth IRA');
  // 6 × $450 inflows over ~5 months = $540/mo; the $1,200 reconciliation
  // adjustment (market growth) and the checking-account outflow must not count.
  assert.equal(roth.estMonthlyContribution, 540);
});

test('YNAB register carries NO balances → stable CSV_TRANSACTIONS_ONLY warning, no accounts fabricated', () => {
  const w = cfp.meta.warnings.find((x) => x.code === 'CSV_TRANSACTIONS_ONLY');
  assert.ok(w, 'a YNAB file in the import must announce that it carries no balances');
  assert.equal(w.severity, 'warn');
  assert.match(w.message, /ynab-register\.csv/);
  assert.match(w.message, /no.*balances|balances or holdings/i);
  // A YNAB file ALONE yields transactions but zero accounts — never invented ones.
  const alone = csvAdapter.normalize({
    files: [{
      name: 'My Budget as of 2026-07-01 - Register.csv',
      content: [
        '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
        '"Brokerage",,"01/12/2026","Transfer : Checking",,,,"","$0.00","$450.00","Cleared"',
      ].join('\n'),
    }],
  });
  assert.equal(alone.accounts.length, 0, 'no balances in a YNAB register → no accounts');
  assert.ok(alone.meta.warnings.some((x) => x.code === 'CSV_TRANSACTIONS_ONLY'));
});

test('Empower holdings dialect: Account column groups rows; no Cost Basis column → NO_COST_BASIS per holding', () => {
  const ira = cfp.accounts.find((a) => a.name === 'Empower Rollover IRA');
  assert.equal(ira.institution, 'Empower');
  assert.equal(ira.class, 'investment');
  assert.equal(ira.taxTreatment, 'traditional'); // "Rollover IRA" name hint — a guess, warned
  assert.ok(cfp.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === ira.id));
  assert.equal(ira.holdings.length, 2);
  assert.ok(Math.abs(ira.balance - (30512 + 5250)) < 1e-9);
  assert.equal(ira.holdings.find((h) => h.ticker === 'VTI').quantity, 100);
  assert.equal(ira.holdings.find((h) => h.ticker === 'VBTLX').assetType, 'bond');
  const basisWarnings = cfp.meta.warnings.filter((w) => w.code === 'NO_COST_BASIS' && w.accountId === ira.id);
  assert.equal(basisWarnings.length, 2, 'Empower stock exports carry no cost basis — one info warning per holding');
});

test('Copilot transactions dialect: inverted sign convention flipped, dividends excluded', () => {
  const schwab = cfp.accounts.find((a) => a.name === 'Schwab Taxable');
  // 4 × $500 transfers (written NEGATIVE by Copilot) over ~3 months → 667/mo;
  // the -$75 dividend (growth) and +$18.40 spending row must be excluded.
  assert.equal(schwab.estMonthlyContribution, 667);
});

test('Copilot spending rows (positive amounts) never read as deposits after the sign flip', () => {
  const out = csvAdapter.normalize({
    files: [
      { content: 'Account Name,Type,Balance\nBrokerage,Brokerage,"$10,000"' },
      {
        content: [
          'date,name,amount,status,category,parent category,excluded,tags,type,account,account mask,note,recurring',
          '2026-01-10,Big Purchase,2500.00,posted,Shopping,Shopping,false,,regular,Brokerage,1234,,',
          '2026-02-10,ACH In,-300.00,posted,Transfers,Transfers,false,,internal transfer,Brokerage,1234,,',
          '2026-04-10,ACH In,-300.00,posted,Transfers,Transfers,false,,internal transfer,Brokerage,1234,,',
        ].join('\n'),
      },
    ],
  });
  const brk = out.accounts.find((a) => a.name === 'Brokerage');
  // Only the two flipped -$300 → +$300 transfers count: $600 over the ~2-month
  // Feb→Apr span. If the $2,500 purchase had been read as a deposit the figure
  // would be far higher.
  assert.equal(brk.estMonthlyContribution, 300);
});

test('Copilot accounts exports fingerprint as generic-accounts (deliberately no dedicated dialect)', () => {
  const out = csvAdapter.normalize({
    files: [{
      name: 'copilot-accounts.csv',
      content: 'name,type,balance\nChase Checking,Checking,"$4,200.00"\nWealthfront,Brokerage,"$52,000.00"',
    }],
  });
  assert.equal(out.accounts.length, 2);
  assert.equal(out.accounts.find((a) => a.name === 'Chase Checking').class, 'depository');
  assert.equal(out.accounts.find((a) => a.name === 'Wealthfront').taxTreatment, 'taxable');
});

test('importToPlan wrapper works for csv', () => {
  const r = importToPlan('csv', csvRaw);
  assert.equal(r.cfp.source, 'csv');
  assert.equal(r.plan.tax_settings.state, 'WA');
  assert.equal(r.plan.earners[0].name, 'Jordan');
  assert.equal(r.plan.desired_annual_spend, 80000);
});
