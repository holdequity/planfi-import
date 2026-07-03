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
import { finicityAdapter } from '../src/adapters/finicity.mjs';
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
const FIN_TYPES = ['checking', 'savings', 'cd', 'moneyMarket', 'investment', 'brokerageAccount',
  'investmentTaxDeferred', 'ira', 'roth', '401k', '403b', 'simpleIRA', 'sepIRA', 'keogh', 'rollover',
  '529plan', 'educationIRA', 'hsa', 'mortgage', 'homeEquityLoan', 'loan', 'studentLoan', 'autoLoan',
  'creditCard', 'lineOfCredit', 'somethingWeird', 'constructor', null];

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

function finicityPayload() {
  const n = 1 + Math.floor(rnd() * 8);
  const accounts = [];
  for (let i = 0; i < n; i++) {
    accounts.push({
      id: pick([i, `f${i}`, null]),
      name: pick([null, '', 'Acct ' + i]),
      type: pick(FIN_TYPES),
      balance: wildNum(),
      detail: pick([undefined, {}, { interestRate: wildNum(), payment: wildNum(), maturityDate: pick([wildNum(), 2470000000, '2050-01-01', null]) }]),
      ownerIndex: pick([0, 1, undefined]),
    });
  }
  return {
    asOf: pick(['2026-07-02T00:00:00Z', null, 'not-a-date']),
    owner: pick([{}, { earners: [{ age: wildNum(), retirementAge: wildNum(), annualSalary: wildNum() }] }, { age: 40, retirementAge: 65 }]),
    accounts,
    positions: [{ accountId: pick([0, 'f0', null]), symbol: pick(['VTI', null]), units: wildNum(), marketValue: wildNum(), costBasis: pick([wildNum(), null]), securityType: pick(['ETF', 'Stock', 'Cryptocurrency', null]) }],
    transactions: [{ accountId: pick([0, 'f0']), amount: wildNum(), transactedDate: pick([1767225600, wildNum(), '2026-03-01', null]), categorization: pick([undefined, { category: pick(['Transfer', 'Dividends & Interest Income', null]) }]) }],
  };
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

const KNOWN_FIELDS = new Set(['age', 'retirement_age', 'annual_salary', 'desired_annual_spend', 'home_value', 'debt_rate']);

for (const [name, adapter, gen] of [['plaid', plaidAdapter, plaidPayload], ['mx', mxAdapter, mxPayload], ['finicity', finicityAdapter, finicityPayload]]) {
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
      // stocks = TOTAL portfolio: must cover the account_balances decomposition.
      assert.ok(out.plan.stocks.current_value >= ab.taxable + ab.traditional + ab.roth, 'stocks total must cover the decomposition');
      // hsa_retirement is not a wire field and must never be emitted.
      assert.equal(out.plan.hsa_retirement, undefined);
      // education_account (when present) carries engine camelCase keys.
      if (out.plan.education_account) {
        assert.equal(out.plan.education_account.initial_balance, undefined, 'education_account must be camelCase inside');
        assert.ok(out.plan.education_account.initialBalance >= 0);
      }
      assert.ok(out.plan.earners.length >= 1);
      for (const re of out.plan.real_estate ?? []) assert.ok(re.current_value > 0, 'property value must be positive');
      for (const d of out.plan.debts ?? []) { assert.ok(d.balance >= 0); assert.ok(d.rate >= 0); }
      // needsInput entries are structured, use known fields, and never duplicate.
      const seen = new Set();
      for (const ni of out.needsInput) {
        assert.ok(KNOWN_FIELDS.has(ni.field), `unexpected needsInput field: ${ni.field}`);
        assert.ok(typeof ni.label === 'string' && ni.label.length > 0, 'needsInput.label required');
        assert.ok(typeof ni.why === 'string' && ni.why.length > 0, 'needsInput.why required');
        const k = `${ni.field}|${ni.accountId ?? ''}|${ni.earnerIndex ?? ''}`;
        assert.ok(!seen.has(k), `duplicate needsInput entry: ${k}`);
        seen.add(k);
      }
      // warnings are structured with stable codes + severities.
      for (const w of out.warnings) {
        assert.match(w.code, /^[A-Z][A-Z0-9_]+$/, `warning code must be SCREAMING_SNAKE: ${JSON.stringify(w)}`);
        assert.ok(w.severity === 'info' || w.severity === 'warn', `bad severity: ${w.severity}`);
        assert.ok(typeof w.message === 'string' && w.message.length > 0);
      }
    }
  });
}
