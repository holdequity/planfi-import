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
  assert.ok(cfp.meta.warnings.some((w) => /no cost basis/i.test(w)));
});

test('MX PROPERTY value pairs with the mortgage (no home_value needed)', () => {
  const { plan, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].current_value, 1450000); // real market value, not a guess
  assert.equal(plan.real_estate[0].mortgage.balance, 610000);
  assert.ok(!needsInput.some((n) => n.startsWith('home_value')));
});

test('MX buckets + HSA asset + inferred contributions', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.account_balances.taxable, 305000);
  assert.equal(plan.account_balances.traditional, 420000);
  assert.equal(plan.account_balances.roth, 96000);
  assert.equal(plan.cash.current_value, 21000 + 65000);
  assert.equal(plan.hsa_retirement.currentHsaBalance, 30000);
  assert.ok(plan.stocks.monthly_contribution > 0);
  assert.ok(plan.earners[0].retirement_accounts.k401.employee_annual > 0);
  assert.equal(plan.education_account.initial_balance, 52000);
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
