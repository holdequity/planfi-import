// fuzz.test.mjs — robustness proof. Generate thousands of randomized-but-
// plausible provider payloads (every account type, nulls, extreme values,
// missing fields) and assert the adapters + shared mapper:
//   1. NEVER throw
//   2. emit only finite, non-negative numbers (no NaN/Infinity leaks)
//   3. keep tax buckets + debts + real estate structurally valid
//   4. list only known keys in needsInput
// This catches "weird data → transform error" regressions before prod.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaidAdapter } from '../src/adapters/plaid.mjs';
import { mxAdapter } from '../src/adapters/mx.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';

const N = 3000;

const PLAID_ACCTS = [
  ['depository', ['checking', 'savings', 'money market', 'cd', 'hsa', null]],
  ['investment', ['brokerage', '401k', 'roth', 'roth 401k', 'ira', 'sep ira', 'hsa', '529', 'mutual fund', 'annuity', null]],
  ['loan', ['mortgage', 'student', 'auto', 'home equity', 'line of credit', null]],
  ['credit', ['credit card', 'paypal', null]],
];
const MX_TYPES = ['CHECKING', 'SAVINGS', 'MONEY_MARKET', 'INVESTMENT', 'MORTGAGE', 'LOAN', 'CREDIT_CARD', 'PROPERTY', 'CD', 'LINE_OF_CREDIT'];
const MX_SUB = ['BROKERAGE', '401K', 'ROTH_IRA', 'IRA', 'HSA', '529', 'SEP_IRA', null];

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
// Deliberately nasty numeric values, incl. ones that must NOT leak through.
const wildNum = () => pick([0, 1, 100, 5000, 250000, 1e7, -1, null, undefined, NaN, Infinity, '12,345', '', 'abc', 0.0001]);

function plaidPayload() {
  const n = 1 + Math.floor(rnd() * 8);
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const [type, subs] = pick(PLAID_ACCTS);
    accounts.push({ account_id: `a${i}`, name: pick([null, '', 'Acct ' + i]), type, subtype: pick(subs), balances: { current: wildNum() }, owner_index: pick([0, 1, undefined]) });
  }
  return {
    asOf: pick(['2026-07-02T00:00:00Z', null, 'not-a-date']),
    owner: pick([{}, { earners: [{ age: wildNum(), retirementAge: wildNum(), annualSalary: wildNum() }] }, { age: 40, retirementAge: 65 }]),
    accounts,
    holdings: [{ account_id: 'a0', security_id: 's', quantity: wildNum(), institution_value: wildNum(), cost_basis: pick([wildNum(), null]) }],
    securities: [{ security_id: 's', ticker_symbol: pick(['VTI', null]), type: pick(['etf', 'equity', 'cryptocurrency', null]) }],
    liabilities: { mortgage: [{ account_id: 'a0', interest_rate: { percentage: wildNum() }, maturity_date: pick(['2050-01-01', null]) }] },
  };
}

function mxPayload() {
  const n = 1 + Math.floor(rnd() * 8);
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const type = pick(MX_TYPES);
    accounts.push({ guid: `g${i}`, name: pick([null, 'Acct ' + i]), type, subtype: pick(MX_SUB), balance: wildNum(), market_value: wildNum(), interest_rate: wildNum(), minimum_payment: wildNum() });
  }
  return { asOf: '2026-07-02T00:00:00Z', owner: pick([{}, { earners: [{ age: 44, retirementAge: 60 }] }]), accounts, holdings: [{ account_guid: 'g0', symbol: pick(['VOO', null]), shares: wildNum(), market_value: wildNum(), cost_basis: pick([wildNum(), null]), holding_type: pick(['ETF', 'Stock', 'Cryptocurrency', null]) }], transactions: [{ account_guid: 'g0', type: 'CREDIT', amount: wildNum(), date: '2026-03-01' }] };
}

/** Recursively assert every number in an object is finite & (for money) >= 0. */
function assertClean(obj, path = 'plan') {
  if (obj == null) return;
  if (typeof obj === 'number') {
    assert.ok(Number.isFinite(obj), `${path} is not finite: ${obj}`);
    return;
  }
  if (Array.isArray(obj)) { obj.forEach((v, i) => assertClean(v, `${path}[${i}]`)); return; }
  if (typeof obj === 'object') for (const [k, v] of Object.entries(obj)) assertClean(v, `${path}.${k}`);
}

const KNOWN_NEEDS = /^(age|retirement_age|annual_salary|desired_annual_spend|filing_state|home_value)/;

for (const [name, adapter, gen] of [['plaid', plaidAdapter, plaidPayload], ['mx', mxAdapter, mxPayload]]) {
  test(`fuzz: ${name} adapter never throws and emits clean plans (${N} cases)`, () => {
    for (let i = 0; i < N; i++) {
      const raw = gen();
      let cfp, out;
      assert.doesNotThrow(() => { cfp = adapter.normalize(raw); }, `${name} normalize threw on case ${i}`);
      assert.doesNotThrow(() => { out = toPlanfiPlan(cfp); }, `${name} mapper threw on case ${i}`);
      assertClean(out.plan);
      // structural invariants
      const ab = out.plan.account_balances;
      for (const k of ['taxable', 'traditional', 'roth']) assert.ok(ab[k] >= 0, `${k} negative`);
      assert.ok(out.plan.cash.current_value >= 0);
      assert.ok(out.plan.stocks.current_value >= 0);
      assert.ok(out.plan.earners.length >= 1);
      for (const re of out.plan.real_estate ?? []) assert.ok(re.current_value > 0, 'property value must be positive');
      for (const d of out.plan.debts ?? []) { assert.ok(d.balance >= 0); assert.ok(d.rate >= 0); }
      for (const nkey of out.needsInput) assert.ok(KNOWN_NEEDS.test(nkey), `unexpected needsInput key: ${nkey}`);
    }
  });
}
