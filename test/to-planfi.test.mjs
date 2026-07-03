import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaidAdapter } from '../src/adapters/plaid.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';

const cfp = plaidAdapter.normalize(plaidRaw);

test('stocks = TOTAL portfolio; account_balances = its decomposition', () => {
  const { plan } = toPlanfiPlan(cfp);
  // brokerage 240k + the low-confidence 'annuity' account 15k (guessed taxable, warned)
  assert.equal(plan.account_balances.taxable, 255000);
  assert.equal(plan.account_balances.traditional, 315000);  // 401k
  assert.equal(plan.account_balances.roth, 88000);          // roth ira
  assert.equal(plan.cash.current_value, 18400 + 52000);     // checking + savings
  // Wire convention (mapper.ts PlanRequest): stocks.current_value is the TOTAL
  // investable portfolio (the engine core never adds account_balances on top).
  // taxable 255k + traditional 315k + roth 88k + HSA balance 22k (folded — no
  // dedicated wire HSA balance field).
  assert.equal(plan.stocks.current_value, 255000 + 315000 + 88000 + 22000);
});

test('retirement balances are IN the projected portfolio (regression: they used to be silently dropped)', () => {
  const { plan } = toPlanfiPlan(cfp);
  const decomposition = plan.account_balances.taxable + plan.account_balances.traditional + plan.account_balances.roth;
  assert.ok(plan.stocks.current_value >= decomposition, 'stocks total must cover the full decomposition');
});

test('529 becomes an education account (engine camelCase INSIDE the block)', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.education_account.enabled, true);
  // education_account passes through the wire as NetWorthInput['educationAccount'] —
  // snake_case keys here would be silently dropped by the engine.
  assert.equal(plan.education_account.initialBalance, 41000);
  assert.equal(plan.education_account.monthlyContribution, 0);
  assert.equal(plan.education_account.initial_balance, undefined);
});

test('mortgage becomes a property; rate carried as fraction', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].mortgage.balance, 512000);
  assert.ok(Math.abs(plan.real_estate[0].mortgage.rate - 0.0625) < 1e-9);
});

test('estimated home value (80% LTV) is warned + kept in needsInput (structured)', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate[0].current_value, Math.round(512000 / 0.8));
  const w = warnings.find((x) => x.code === 'HOME_VALUE_ESTIMATED');
  assert.ok(w && /ESTIMATED at 80% LTV/.test(w.message));
  assert.equal(w.severity, 'warn');
  assert.equal(w.accountId, 'mtg1');
  const ask = needsInput.find((n) => n.field === 'home_value');
  assert.equal(ask.accountId, 'mtg1');
  assert.equal(ask.accountName, 'Home mortgage');
  assert.match(ask.label, /Home value/);
  assert.ok(ask.why.length > 20, 'why must explain the gap');
});

test('student loan + credit card become debts', () => {
  const { plan } = toPlanfiPlan(cfp);
  const names = plan.debts.map((d) => d.name);
  assert.ok(plan.debts.length === 2);
  assert.ok(names.some((n) => /student/i.test(n)));
  assert.ok(names.some((n) => /sapphire|credit/i.test(n)));
});

test('missing debt APR surfaces in needsInput + warning (not silently 0%)', () => {
  const noRate = {
    ...cfp,
    accounts: [{ id: 'cc9', name: 'Mystery card', class: 'credit', subtype: 'credit card', balance: 5000, liability: {} }],
  };
  const { plan, warnings, needsInput } = toPlanfiPlan(noRate);
  assert.equal(plan.debts[0].rate, 0); // schema requires a number — 0 stays in the body
  const ask = needsInput.find((n) => n.field === 'debt_rate');
  assert.equal(ask.accountId, 'cc9');
  assert.equal(ask.accountName, 'Mystery card');
  assert.ok(ask.label && ask.why);
  assert.ok(warnings.some((w) => w.code === 'DEBT_RATE_MISSING' && w.accountId === 'cc9' && /no APR .* modeled at 0%/.test(w.message)));
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

test('missing demographics surface in needsInput as structured asks (not fabricated)', () => {
  const bare = plaidAdapter.normalize({ ...plaidRaw, owner: {} });
  const { plan, needsInput } = toPlanfiPlan(bare);
  const age = needsInput.find((n) => n.field === 'age');
  assert.ok(age, 'age ask expected');
  assert.equal(age.earnerIndex, 0);
  assert.match(age.label, /age/i);
  assert.ok(age.why.length > 20, 'why must explain WHY the aggregator cannot supply it');
  assert.ok(needsInput.some((n) => n.field === 'annual_salary'));
  assert.ok(needsInput.some((n) => n.field === 'retirement_age'));
  assert.ok(needsInput.some((n) => n.field === 'desired_annual_spend'));
  assert.equal(plan.earners[0].age, undefined); // omitted, not zero
});

test('needsInput is deterministic + de-duplicated on (field, accountId, earnerIndex)', () => {
  const bare = plaidAdapter.normalize({ ...plaidRaw, owner: {} });
  const a = toPlanfiPlan(bare).needsInput;
  const b = toPlanfiPlan(bare).needsInput;
  assert.deepEqual(a, b, 'same input → identical needsInput order');
  const keys = a.map((n) => `${n.field}|${n.accountId ?? ''}|${n.earnerIndex ?? ''}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate (field, accountId, earnerIndex) entries');
  // Demographics first (earner order), account-scoped asks after, goals last.
  assert.equal(a[0].field, 'age');
  assert.equal(a.at(-1).field, 'desired_annual_spend');
});

test('two earners missing the same field produce two distinct asks (earnerIndex dedup key)', () => {
  const noAges = plaidAdapter.normalize({
    ...plaidRaw,
    owner: { earners: [{ name: 'Alex' }, { name: 'Sam' }] },
  });
  const { needsInput } = toPlanfiPlan(noAges);
  const ages = needsInput.filter((n) => n.field === 'age');
  assert.equal(ages.length, 2);
  assert.deepEqual(ages.map((n) => n.earnerIndex), [0, 1]);
  assert.match(ages[0].label, /Alex/);
  assert.match(ages[1].label, /Sam/);
});

test('every warning is structured: stable code, severity, human message', () => {
  const { warnings } = toPlanfiPlan(cfp);
  assert.ok(warnings.length > 0);
  for (const w of warnings) {
    assert.match(w.code, /^[A-Z][A-Z0-9_]+$/, `code must be SCREAMING_SNAKE: ${w.code}`);
    assert.ok(['info', 'warn'].includes(w.severity), `severity: ${w.severity}`);
    assert.ok(typeof w.message === 'string' && w.message.length > 20, 'human-quality message');
  }
});

test('HSA balance folds into the stocks total with a warning (no hsa_retirement — not a wire field)', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.hsa_retirement, undefined, 'hsa_retirement does not exist on the wire and must not be emitted');
  assert.ok(plan.stocks.current_value >= 22000, 'HSA balance must be inside the portfolio total');
  assert.ok(warnings.some((w) => w.code === 'HSA_FOLDED_INTO_PORTFOLIO' && w.severity === 'info' && /HSA balance \$22,000 .* aggregate portfolio/.test(w.message)));
});

test('HSA balance needs no ages (balance folding is unconditional)', () => {
  const noAge = plaidAdapter.normalize({ ...plaidRaw, owner: {} });
  const { plan } = toPlanfiPlan(noAge);
  assert.equal(plan.stocks.current_value, 255000 + 315000 + 88000 + 22000);
});

test('inferred HSA contribution routes to the OWNING earner retirement_accounts.hsa', () => {
  const withHsaContrib = {
    ...cfp,
    accounts: cfp.accounts.map((a) => a.id === 'hsa1'
      ? { ...a, ownerIndex: 1, estMonthlyContribution: 300 }
      : a),
  };
  const { plan, warnings } = toPlanfiPlan(withHsaContrib);
  assert.equal(plan.earners[0].retirement_accounts?.hsa, undefined);
  assert.deepEqual(plan.earners[1].retirement_accounts.hsa, { coverage: 'family', annual: 3600 });
  assert.ok(warnings.some((w) => w.code === 'HSA_COVERAGE_ASSUMED' && /coverage type assumed 'family'/.test(w.message)));
});

test('inferred HSA contribution above the IRS limit is clamped WITH a warning', () => {
  const bigHsa = {
    ...cfp,
    accounts: cfp.accounts.map((a) => a.id === 'hsa1'
      ? { ...a, estMonthlyContribution: 1000 } // $12k/yr > $8,750 family limit
      : a),
  };
  const { plan, warnings } = toPlanfiPlan(bigHsa);
  assert.equal(plan.earners[0].retirement_accounts.hsa.annual, 8750);
  assert.ok(warnings.some((w) => w.code === 'CONTRIBUTION_CLAMPED' && /HSA contribution \$12,000\/yr exceeds the 2026 IRS limit \$8,750/.test(w.message)));
});

test('401(k) inference above the 2026 limit is clamped WITH a warning', () => {
  const big401k = {
    ...cfp,
    accounts: cfp.accounts.map((a) => a.id === 'k401'
      ? { ...a, estMonthlyContribution: 3000 } // $36k/yr > $24,500
      : a),
  };
  const { plan, warnings } = toPlanfiPlan(big401k);
  assert.equal(plan.earners[0].retirement_accounts.k401.employee_annual, 24500);
  assert.ok(warnings.some((w) => w.code === 'CONTRIBUTION_CLAMPED' && /401\(k\) contribution \$36,000\/yr exceeds the 2026 IRS limit \$24,500/.test(w.message)));
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

test('implausible taxable inference (vs known salary) is warned', () => {
  const huge = {
    ...cfp,
    accounts: cfp.accounts.map((a) => a.id === 'brk1'
      ? { ...a, estMonthlyContribution: 20000 } // $240k/yr vs $305k salary
      : a),
  };
  const { warnings } = toPlanfiPlan(huge);
  assert.ok(warnings.some((w) => w.code === 'CONTRIBUTION_IMPLAUSIBLE' && /exceed 50% of known household salary/.test(w.message)));
});

test('inferred contributions attach to the right earner by ownerIndex', () => {
  const { plan } = toPlanfiPlan(cfp);
  // k401 (owner 0 = Alex) → 401k; roth1 (owner 1 = Sam) → Roth IRA
  assert.ok(plan.earners[0].retirement_accounts?.k401?.employee_annual > 0);
  assert.equal(plan.earners[1].retirement_accounts?.ira?.type, 'roth');
  assert.ok(plan.earners[1].retirement_accounts?.ira?.annual > 0);
  // 401k contribution within the 2026 IRS limit
  assert.ok(plan.earners[0].retirement_accounts.k401.employee_annual <= 24500);
});

test('an earner with BOTH traditional and Roth IRA contributions gets ira.type "both" + a split warning', () => {
  const both = {
    ...cfp,
    accounts: [
      // Roth IRA $300/mo + traditional IRA $200/mo for the same earner.
      ...cfp.accounts.map((a) => a.id === 'roth1' ? { ...a, estMonthlyContribution: 300 } : a),
      { id: 'trad9', name: 'Trad IRA', class: 'investment', subtype: 'ira', taxTreatment: 'traditional', balance: 10000, ownerIndex: 1, estMonthlyContribution: 200 },
    ],
  };
  const { plan, warnings } = toPlanfiPlan(both);
  const ira = plan.earners[1].retirement_accounts.ira;
  assert.equal(ira.type, 'both');
  assert.equal(ira.annual, 300 * 12 + 200 * 12); // 6000 — under the $7,500 limit, no clamp
  assert.ok(warnings.some((w) => w.code === 'IRA_SPLIT_ASSUMED' && /both traditional .* and Roth .* 50\/50 split/.test(w.message)));
});

test('negative balances are clamped to $0 WITH a warning naming the account', () => {
  const margin = {
    ...cfp,
    accounts: [
      ...cfp.accounts,
      { id: 'mgn1', name: 'Margin cash', class: 'depository', subtype: 'checking', taxTreatment: 'na', balance: -1200 },
    ],
  };
  const { plan, warnings } = toPlanfiPlan(margin);
  assert.equal(plan.cash.current_value, 18400 + 52000); // -1200 contributed $0
  assert.ok(warnings.some((w) => w.code === 'NEGATIVE_BALANCE_CLAMPED' && w.accountId === 'mgn1' && /"Margin cash" has a negative balance \(-1200\)/.test(w.message)));
});

test('importToPlan one-call wrapper returns plan + cfp + warnings', () => {
  const r = importToPlan('plaid', plaidRaw);
  assert.ok(r.plan && r.cfp && Array.isArray(r.warnings) && Array.isArray(r.needsInput));
  assert.equal(r.plan.account_balances.traditional, 315000);
});

test('unknown source throws', () => {
  assert.throws(() => importToPlan('nope', {}), /No import adapter/);
});

test('IMPORT_EMPTY: zero recognized accounts warns loudly (batch-scale format-error visibility)', () => {
  const { warnings } = toPlanfiPlan({ source: 'plaid', accounts: [], owner: {}, meta: { warnings: [] } });
  const w = warnings.find((x) => x.code === 'IMPORT_EMPTY');
  assert.ok(w, 'IMPORT_EMPTY emitted');
  assert.equal(w.severity, 'warn');
  const ok = toPlanfiPlan({ source: 'plaid', accounts: [{ id: 'a', class: 'depository', subtype: 'checking', taxTreatment: 'na', balance: 100 }], owner: {}, meta: { warnings: [] } });
  assert.ok(!ok.warnings.find((x) => x.code === 'IMPORT_EMPTY'), 'not emitted when accounts exist');
});
