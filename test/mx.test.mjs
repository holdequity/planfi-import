import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mxAdapter } from '../src/adapters/mx.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { mxRaw } from '../fixtures/mx-sandbox.mjs';

const cfp = mxAdapter.normalize(mxRaw);

test('MX types normalize to canonical classes + tax treatments', () => {
  const by = Object.fromEntries(cfp.accounts.map((a) => [a.id, a]));
  assert.equal(by['ACT-chk'].class, 'depository');
  assert.equal(by['ACT-brk'].taxTreatment, 'taxable');
  assert.equal(by['ACT-401k'].taxTreatment, 'traditional');
  assert.equal(by['ACT-roth'].taxTreatment, 'roth');   // ROTH_IRA → roth
  assert.equal(by['ACT-hsa'].taxTreatment, 'hsa');
  assert.equal(by['ACT-529'].taxTreatment, '529');
  assert.equal(by['ACT-home'].class, 'property');
  assert.equal(by['ACT-mtg'].class, 'loan');
  assert.equal(by['ACT-cc'].class, 'credit');
});

test('MX holdings carry ticker + cost basis; null basis warned', () => {
  const brk = cfp.accounts.find((a) => a.id === 'ACT-brk');
  const voo = brk.holdings.find((h) => h.ticker === 'VOO');
  assert.equal(voo.costBasis, 180000);
  assert.equal(voo.assetType, 'etf');
  const w = cfp.meta.warnings.find((x) => x.code === 'NO_COST_BASIS');
  assert.ok(w && /no cost basis/i.test(w.message));
  assert.equal(w.accountId, 'ACT-brk');
});

test('MX PROPERTY value pairs with the mortgage (no home_value needed)', () => {
  const { plan, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].current_value, 1450000); // real market value, not a guess
  assert.equal(plan.real_estate[0].mortgage.balance, 610000);
  assert.ok(!needsInput.some((n) => n.field === 'home_value'));
});

test('MX buckets + portfolio total + inferred contributions', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.account_balances.taxable, 305000);
  assert.equal(plan.account_balances.traditional, 420000);
  assert.equal(plan.account_balances.roth, 96000);
  assert.equal(plan.cash.current_value, 21000 + 65000);
  // stocks = TOTAL portfolio: taxable + traditional + roth + HSA balance
  // (folded and warned — hsa_retirement is not a wire field).
  assert.equal(plan.stocks.current_value, 305000 + 420000 + 96000 + 30000);
  assert.equal(plan.hsa_retirement, undefined);
  assert.ok(warnings.some((w) => w.code === 'HSA_FOLDED_INTO_PORTFOLIO' && /HSA balance \$30,000 .* aggregate portfolio/.test(w.message)));
  assert.ok(plan.stocks.monthly_contribution > 0);
  assert.ok(plan.earners[0].retirement_accounts.k401.employee_annual > 0);
  // education_account is the ENGINE shape — camelCase inside.
  assert.equal(plan.education_account.initialBalance, 52000);
});

test('MX 401(k) inference over the 2026 limit clamps + warns (fixture infers $25,920/yr)', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.earners[0].retirement_accounts.k401.employee_annual, 24500);
  assert.ok(warnings.some((w) => w.code === 'CONTRIBUTION_CLAMPED' && /401\(k\) contribution .* exceeds the 2026 IRS limit/.test(w.message)));
});

test('MX growth credits (dividends/interest) are excluded from contribution inference', () => {
  const withGrowth = {
    ...mxRaw,
    transactions: [
      ...mxRaw.transactions,
      ...['2026-01-20', '2026-02-20', '2026-03-20'].map((date) => (
        { account_guid: 'ACT-brk', type: 'CREDIT', amount: 900, category: 'Dividend', date })),
    ],
  };
  const a = mxAdapter.normalize(mxRaw).accounts.find((x) => x.id === 'ACT-brk');
  const b = mxAdapter.normalize(withGrowth).accounts.find((x) => x.id === 'ACT-brk');
  assert.equal(b.estMonthlyContribution, a.estMonthlyContribution, 'dividend credits must not inflate the inferred contribution');
});

test('MX unlabeled credits are counted but flagged as coarse inference', () => {
  const unlabeled = {
    ...mxRaw,
    transactions: ['2026-01-20', '2026-02-20', '2026-03-20'].map((date) => (
      { account_guid: 'ACT-brk', type: 'CREDIT', amount: 500, date })),
  };
  const norm = mxAdapter.normalize(unlabeled);
  assert.ok(norm.meta.warnings.some((w) => w.code === 'COARSE_INFERENCE' && /MX contribution inference is coarse/.test(w.message)));
  assert.ok(norm.accounts.find((x) => x.id === 'ACT-brk').estMonthlyContribution > 0);
});

test('MX loan + credit → debts; rate as fraction', () => {
  const { plan } = toPlanfiPlan(cfp);
  const auto = plan.debts.find((d) => /auto/i.test(d.name));
  assert.ok(Math.abs(auto.rate - 0.069) < 1e-9);
  assert.equal(plan.debts.length, 2);
});

test('importToPlan wrapper works for mx', () => {
  const r = importToPlan('mx', mxRaw);
  assert.equal(r.plan.tax_settings.state, 'TX');
  assert.equal(r.plan.real_estate[0].current_value, 1450000);
});
