import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ofxAdapter, parseOfx, find, findAll, ofxDateIso } from '../src/adapters/ofx.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { ofxRaw } from '../fixtures/ofx-sandbox.mjs';

const cfp = ofxAdapter.normalize(ofxRaw);

test('parseOfx reads SGML (unclosed leaves) and XML (closed leaves) identically', () => {
  const sgml = '<OFX><BANKMSGSRSV1><STMTRS><LEDGERBAL><BALAMT>123.45\n<DTASOF>20260702\n</LEDGERBAL></STMTRS></BANKMSGSRSV1></OFX>';
  const xml = '<?xml version="1.0"?><OFX><BANKMSGSRSV1><STMTRS><LEDGERBAL><BALAMT>123.45</BALAMT><DTASOF>20260702</DTASOF></LEDGERBAL></STMTRS></BANKMSGSRSV1></OFX>';
  for (const src of [sgml, xml]) {
    const root = parseOfx(src);
    const bal = find(root, 'LEDGERBAL');
    assert.equal(find(bal, 'BALAMT').value, '123.45');
    assert.equal(find(bal, 'DTASOF').value, '20260702');
  }
});

test('parseOfx tolerates hostile input: stray closes, unclosed aggregates, truncation, garbage', () => {
  assert.doesNotThrow(() => parseOfx('</WAT><A><B>1<C></OFX'));
  assert.doesNotThrow(() => parseOfx(''));
  assert.doesNotThrow(() => parseOfx(null));
  assert.doesNotThrow(() => parseOfx('no tags at all'));
  const root = parseOfx('<A><B>hello &amp; goodbye');
  assert.equal(find(root, 'B').value, 'hello & goodbye');
  assert.equal(findAll(parseOfx('<A><X>1</A><A><X>2'), 'X').length, 2);
});

test('ofxDateIso parses OFX timestamps; junk → undefined (never fabricated)', () => {
  assert.equal(ofxDateIso('20260702'), '2026-07-02T00:00:00.000Z');
  assert.equal(ofxDateIso('20260702093000.000[-5:EST]'), '2026-07-02T09:30:00.000Z');
  assert.equal(ofxDateIso('not-a-date'), undefined);
  assert.equal(ofxDateIso('20269999'), undefined);
  assert.equal(ofxDateIso(''), undefined);
  assert.equal(ofxDateIso(null), undefined);
});

test('OFX bank statements → depository accounts with ledger balances', () => {
  const chk = cfp.accounts.find((a) => a.id === '9917341234');
  assert.equal(chk.class, 'depository');
  assert.equal(chk.subtype, 'checking');
  assert.equal(chk.balance, 11250.75);
  assert.equal(chk.name, 'Checking ••1234');
  const sav = cfp.accounts.find((a) => a.id === '9917349999');
  assert.equal(sav.subtype, 'savings');
  assert.equal(sav.balance, 27500);
});

test('OFX card balances are reported NEGATIVE → normalized to positive amount owed', () => {
  const card = cfp.accounts.find((a) => a.id === '5412000012348888');
  assert.equal(card.class, 'credit');
  assert.equal(card.balance, 2350.6, 'BALAMT -2350.60 must become +2350.60 owed');
  // And it must survive the mapper as a debt, not clamp to $0.
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  const debt = plan.debts.find((d) => /8888/.test(d.name));
  assert.equal(debt.balance, 2351);
  assert.ok(!warnings.some((w) => w.code === 'NEGATIVE_BALANCE_CLAMPED' && w.accountId === '5412000012348888'));
  // OFX card statements carry no APR → 0% modeled, structured ask emitted.
  assert.ok(warnings.some((w) => w.code === 'DEBT_RATE_MISSING' && w.accountId === '5412000012348888'));
  assert.ok(needsInput.some((n) => n.field === 'debt_rate' && n.accountId === '5412000012348888'));
});

test('a positive card BALAMT (institution quirk) still imports as amount owed', () => {
  const out = ofxAdapter.normalize({
    content: '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CCACCTFROM><ACCTID>41110000\n</CCACCTFROM><LEDGERBAL><BALAMT>980.25\n<DTASOF>20260702\n</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
  });
  assert.equal(out.accounts[0].balance, 980.25);
});

test('OFX investment positions resolve SECIDs against the SECLIST for ticker/name', () => {
  const inv = cfp.accounts.find((a) => a.class === 'investment');
  assert.equal(inv.id, 'X22334455');
  assert.equal(inv.institution, 'fidelity.com');
  assert.equal(inv.holdings.length, 2);
  const vti = inv.holdings.find((h) => h.ticker === 'VTI');
  assert.equal(vti.name, 'VANGUARD TOTAL STOCK MARKET ETF');
  assert.equal(vti.quantity, 310);
  assert.equal(vti.value, 94587.2);
  assert.equal(vti.assetType, 'equity');       // POSSTOCK/STOCKINFO
  const fxaix = inv.holdings.find((h) => h.ticker === 'FXAIX');
  assert.equal(fxaix.assetType, 'mutual_fund'); // POSMF/MFINFO
  // OFX positions carry no cost basis → never fabricated, one info note per account.
  assert.ok(inv.holdings.every((h) => h.costBasis === undefined));
  const w = cfp.meta.warnings.find((x) => x.code === 'NO_COST_BASIS' && x.accountId === 'X22334455');
  assert.equal(w.severity, 'info');
  // Balance = positions + available cash.
  assert.ok(Math.abs(inv.balance - (94587.2 + 131291.2 + 4200.55)) < 1e-9);
});

test('a position whose SECID has no SECLIST entry lands in meta.unmapped, not silently dropped', () => {
  const out = ofxAdapter.normalize({
    content: '<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><INVACCTFROM><ACCTID>A1\n</INVACCTFROM><INVPOSLIST><POSSTOCK><INVPOS><SECID><UNIQUEID>999000999\n</SECID><UNITS>10\n<MKTVAL>500.00\n</INVPOS></POSSTOCK></INVPOSLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>',
  });
  const h = out.accounts[0].holdings[0];
  assert.equal(h.ticker, undefined);
  assert.equal(h.value, 500);
  assert.equal(h.assetType, 'equity'); // POSSTOCK wrapper still types it
  assert.ok(out.meta.unmapped.some((u) => u.uniqueId === '999000999'));
});

test('OFX carries no tax-treatment info → investment classified taxable at LOW confidence + warned', () => {
  const inv = cfp.accounts.find((a) => a.class === 'investment');
  assert.equal(inv.taxTreatment, 'taxable');
  const w = cfp.meta.warnings.find((x) => x.code === 'CLASSIFICATION_GUESSED' && x.accountId === inv.id);
  assert.ok(w && w.severity === 'warn');
  assert.match(w.message, /tax-treatment/i);
});

test('INVBANKTRAN deposits drive contribution inference; INCOME/dividends are growth (excluded)', () => {
  const inv = cfp.accounts.find((a) => a.class === 'investment');
  // $1,500/mo over the ~5-month observed span; the $640 INCOME/DIV record
  // (and BUY records generally) must not inflate it.
  assert.ok(inv.estMonthlyContribution >= 1500 && inv.estMonthlyContribution <= 1950, `got ${inv.estMonthlyContribution}`);
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.stocks.monthly_contribution, inv.estMonthlyContribution);
  assert.ok(!cfp.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE'), 'fixture deposits are labeled');
});

test('an INVBANKTRAN labeled as a dividend is excluded; an unlabeled one is counted + COARSE_INFERENCE', () => {
  const stmt = (trn) => `<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><INVACCTFROM><ACCTID>A1\n</INVACCTFROM><INVTRANLIST>${trn}</INVTRANLIST><INVPOSLIST></INVPOSLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>`;
  const div = ofxAdapter.normalize({
    content: stmt('<INVBANKTRAN><STMTTRN><TRNTYPE>DIV\n<DTPOSTED>20260315\n<TRNAMT>800.00\n<NAME>DIVIDEND RECEIVED\n</STMTTRN></INVBANKTRAN>'),
  });
  assert.equal(div.accounts[0].estMonthlyContribution, undefined, 'dividend deposits are growth, not savings');
  const unlabeled = ofxAdapter.normalize({
    content: stmt('<INVBANKTRAN><STMTTRN><DTPOSTED>20260115\n<TRNAMT>500.00\n</STMTTRN></INVBANKTRAN><INVBANKTRAN><STMTTRN><DTPOSTED>20260315\n<TRNAMT>500.00\n</STMTTRN></INVBANKTRAN>'),
  });
  assert.ok(unlabeled.accounts[0].estMonthlyContribution > 0);
  assert.ok(unlabeled.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE' && w.severity === 'warn'));
});

test('ACCTTYPE CREDITLINE under the bank message set becomes revolving credit, not cash', () => {
  const out = ofxAdapter.normalize({
    content: '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><ACCTID>77001\n<ACCTTYPE>CREDITLINE\n</BANKACCTFROM><LEDGERBAL><BALAMT>-5200.00\n<DTASOF>20260702\n</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  });
  assert.equal(out.accounts[0].class, 'credit');
  assert.equal(out.accounts[0].balance, 5200);
  const { plan } = toPlanfiPlan(out);
  assert.equal(plan.debts.length, 1);
  assert.equal(plan.cash.current_value, 0);
});

test('asOf: caller wins, else the statement DTASOF, else NOW — never the epoch', () => {
  assert.equal(cfp.asOf, '2026-07-02T00:00:00.000Z'); // caller-supplied
  const { asOf, ...rest } = ofxRaw;
  const fromStatement = ofxAdapter.normalize(rest);
  assert.equal(fromStatement.asOf, '2026-07-02T00:00:00.000Z'); // LEDGERBAL DTASOF
  const bare = ofxAdapter.normalize({ content: '<OFX></OFX>' });
  assert.ok(new Date(bare.asOf).getFullYear() >= 2026, 'no data → NOW, not 1970');
});

test('ofx fixture → full plan: buckets + inferred contribution survive the shared mapper', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.cash.current_value, Math.round(11250.75 + 27500));
  assert.equal(plan.account_balances.taxable, Math.round(94587.2 + 131291.2 + 4200.55));
  assert.equal(plan.account_balances.traditional, 0);
  assert.equal(plan.stocks.current_value, plan.account_balances.taxable);
  assert.ok(plan.stocks.monthly_contribution > 0);
  // Salary is known (140k) and inference (~21.6k/yr) is plausible → no false alarm.
  assert.ok(!warnings.some((w) => w.code === 'CONTRIBUTION_IMPLAUSIBLE'));
});

test('importToPlan wrapper works for ofx', () => {
  const r = importToPlan('ofx', ofxRaw);
  assert.equal(r.cfp.source, 'ofx');
  assert.equal(r.plan.tax_settings.state, 'TX');
  assert.equal(r.plan.earners[0].name, 'Sam');
  assert.equal(r.plan.desired_annual_spend, 72000);
});
