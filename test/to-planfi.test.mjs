import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaidAdapter } from '../src/adapters/plaid.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';

const cfp = plaidAdapter.normalize(plaidRaw);

test('buckets balances by tax treatment', () => {
  const { plan } = toPlanfiPlan(cfp);
  // brokerage 240k + the low-confidence 'annuity' account 15k (guessed taxable, warned)
  assert.equal(plan.account_balances.taxable, 255000);
  assert.equal(plan.account_balances.traditional, 315000);  // 401k
  assert.equal(plan.account_balances.roth, 88000);          // roth ira
  assert.equal(plan.cash.current_value, 18400 + 52000);     // checking + savings
  assert.equal(plan.stocks.current_value, 255000);          // mirrors taxable
});

test('529 becomes an education account', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.education_account.enabled, true);
  assert.equal(plan.education_account.initial_balance, 41000);
});

test('mortgage becomes a property; rate carried as fraction', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].mortgage.balance, 512000);
  assert.ok(Math.abs(plan.real_estate[0].mortgage.rate - 0.0625) < 1e-9);
});

test('student loan + credit card become debts', () => {
  const { plan } = toPlanfiPlan(cfp);
  const names = plan.debts.map((d) => d.name);
  assert.ok(plan.debts.length === 2);
  assert.ok(names.some((n) => /student/i.test(n)));
  assert.ok(names.some((n) => /sapphire|credit/i.test(n)));
});

test('crypto holding becomes a speculative asset', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.speculative.length, 1);
  assert.equal(plan.speculative[0].current_value, 40000);
});

test('owner context flows to earner + spend + state', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.earners[0].age, 41);
  assert.equal(plan.earners[0].retirement_age, 62);
  assert.equal(plan.desired_annual_spend, 90000);
  assert.equal(plan.tax_settings.state, 'CA');
});

test('missing demographics surface in needsInput (not fabricated)', () => {
  const bare = plaidAdapter.normalize({ ...plaidRaw, owner: {} });
  const { plan, needsInput } = toPlanfiPlan(bare);
  assert.ok(needsInput.includes('age'));
  assert.ok(needsInput.includes('annual_salary'));
  assert.equal(plan.earners[0].age, undefined); // omitted, not zero
});

test('HSA balance becomes an hsa_retirement asset (folds into net worth)', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.ok(plan.hsa_retirement, 'expected an hsa_retirement block');
  assert.equal(plan.hsa_retirement.currentHsaBalance, 22000);
  assert.equal(plan.hsa_retirement.currentAge, 41);
  assert.equal(plan.hsa_retirement.retirementAge, 62);
});

test('HSA falls back to a warning when age/retirement age unknown', () => {
  const noAge = plaidAdapter.normalize({ ...plaidRaw, owner: {} });
  const { plan, warnings } = toPlanfiPlan(noAge);
  assert.equal(plan.hsa_retirement, undefined);
  assert.ok(warnings.some((w) => /HSA balance .* not placed/.test(w)));
});

test('multi-owner: two earners built from owner.earners', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.earners.length, 2);
  assert.equal(plan.earners[0].name, 'Alex');
  assert.equal(plan.earners[1].name, 'Sam');
  assert.equal(plan.earners[1].annual_salary, 120000);
});

test('inferred contributions: taxable → stocks.monthly_contribution', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.ok(plan.stocks.monthly_contribution > 0, 'brokerage deposits should infer a contribution');
});

test('inferred contributions attach to the right earner by ownerIndex', () => {
  const { plan } = toPlanfiPlan(cfp);
  // k401 (owner 0 = Alex) → 401k; roth1 (owner 1 = Sam) → Roth IRA
  assert.ok(plan.earners[0].retirement_accounts?.k401?.employee_annual > 0);
  assert.equal(plan.earners[1].retirement_accounts?.ira?.type, 'roth');
  assert.ok(plan.earners[1].retirement_accounts?.ira?.annual > 0);
  // 401k contribution capped at the IRS limit
  assert.ok(plan.earners[0].retirement_accounts.k401.employee_annual <= 23000);
});

test('importToPlan one-call wrapper returns plan + cfp + warnings', () => {
  const r = importToPlan('plaid', plaidRaw);
  assert.ok(r.plan && r.cfp && Array.isArray(r.warnings) && Array.isArray(r.needsInput));
  assert.equal(r.plan.account_balances.traditional, 315000);
});

test('unknown source throws', () => {
  assert.throws(() => importToPlan('nope', {}), /No import adapter/);
});
