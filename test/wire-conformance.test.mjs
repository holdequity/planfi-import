// wire-conformance.test.mjs — THE GUARD against silent wire drift.
//
// This package emits `generate_financial_plan` wire bodies. The consumer of
// those bodies is the REAL monorepo mapper (workers/ai-mcp/src/lib/mapper.ts →
// mapToNetWorthInput). History: three fields this package emitted were silently
// dropped or mis-shaped (hsa_retirement didn't exist on the wire; snake_case
// keys inside education_account; retirement balances left out of the stocks
// total). This test makes that class of bug unrepeatable by asserting, against
// the ACTUAL mapper, that every field we emit is consumed.
//
// How the real mapper is loaded: mapper.ts is TypeScript, so we register the
// `tsx` loader at runtime (a TEST-ONLY devDependency — the package runtime
// stays zero-dependency) and dynamically import the .ts file. The import needs
// `zod` resolvable from the monorepo tree (root node_modules); CI symlinks
// planfi-import/node_modules/zod up when the root install is absent.
//
// Degradation rules (never a false green):
//   - mapper.ts ABSENT (the standalone/public planfi-import repo, which cannot
//     see the monorepo) → SKIP loudly.
//   - mapper.ts PRESENT but tsx/zod missing → FAIL with instructions. Skipping
//     here would let a monorepo mapper change slide through unverified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { importToPlan } from '../src/index.mjs';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';
import { mxRaw } from '../fixtures/mx-sandbox.mjs';
import { finicityRaw } from '../fixtures/finicity-sandbox.mjs';
import { csvRaw } from '../fixtures/csv-sandbox.mjs';
import { ofxRaw } from '../fixtures/ofx-sandbox.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPER_PATH = path.resolve(__dirname, '../../workers/ai-mcp/src/lib/mapper.ts');
const IN_MONOREPO = existsSync(MAPPER_PATH);

if (!IN_MONOREPO) {
  console.warn(
    '\n[wire-conformance] SKIPPED: monorepo mapper not found at ' + MAPPER_PATH +
    '\n[wire-conformance] This is expected ONLY in the standalone planfi-import repo.' +
    '\n[wire-conformance] Wire conformance is enforced by the planfi-app monorepo CI' +
    ' (.github/workflows/import-conformance.yml); do not treat this skip as coverage.\n'
  );
}

const FIXTURES = [
  ['plaid', plaidRaw],
  ['mx', mxRaw],
  ['finicity', finicityRaw],
  ['csv', csvRaw],
  ['ofx', ofxRaw],
];

/**
 * Parse the PlanRequest interface out of mapper.ts SOURCE to build the
 * allowlist of legal top-level wire keys. Derived from the real file (not
 * hand-maintained) so a mapper-side rename/removal fails this test instead of
 * silently orphaning an emitted field.
 */
function planRequestKeysFromSource(src) {
  const start = src.indexOf('export interface PlanRequest {');
  assert.ok(start >= 0, 'mapper.ts no longer declares `export interface PlanRequest` — update wire-conformance.test.mjs to the new contract');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'could not find the end of interface PlanRequest');
  const body = src.slice(src.indexOf('{', start) + 1, end);
  const keys = new Set();
  let d = 0;
  for (const line of body.split('\n')) {
    if (d === 0) {
      const m = line.match(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/);
      if (m) keys.add(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '<' || ch === '[') d++;
      else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') d = Math.max(0, d - 1);
    }
  }
  return keys;
}

test('emitted plans use only PlanRequest keys (allowlist derived from the real mapper source)', { skip: !IN_MONOREPO && 'monorepo mapper.ts not present (standalone repo)' }, () => {
  const src = readFileSync(MAPPER_PATH, 'utf8');
  const allowed = planRequestKeysFromSource(src);
  // Sanity: the parser found the fields this package relies on.
  for (const k of ['earners', 'stocks', 'account_balances', 'education_account', 'tax_settings']) {
    assert.ok(allowed.has(k), `PlanRequest key parser failed to find "${k}" — parser or contract changed`);
  }
  assert.ok(!allowed.has('hsa_retirement'), 'hsa_retirement should not be a PlanRequest key (if it was ADDED, celebrate and route HSA balances there)');
  for (const [source, raw] of FIXTURES) {
    const { plan } = importToPlan(source, raw);
    for (const key of Object.keys(plan)) {
      assert.ok(allowed.has(key), `${source}: emitted top-level key "${key}" is NOT in the real PlanRequest — it would be silently dropped on the wire`);
    }
  }
});

// ── Functional conformance: run the REAL mapToNetWorthInput ─────────────────

async function loadRealMapper() {
  let register;
  try {
    const [esm, cjs] = await Promise.all([import('tsx/esm/api'), import('tsx/cjs/api')]);
    esm.register();
    cjs.register();
    register = true;
  } catch (e) {
    assert.fail(
      'mapper.ts exists but the tsx loader is unavailable (' + e.message + ').\n' +
      'Run `npm install` in planfi-import/ — skipping here would be a false green.'
    );
  }
  assert.ok(register);
  try {
    return await import(MAPPER_PATH);
  } catch (e) {
    assert.fail(
      'Failed to import the real mapper (' + e.message + ').\n' +
      'Likely `zod` is not resolvable from the monorepo tree — install the repo root ' +
      'deps or symlink planfi-import/node_modules/zod into the root node_modules (see CI workflow).'
    );
  }
}

test('every emitted field is consumed by the real mapToNetWorthInput', { skip: !IN_MONOREPO && 'monorepo mapper.ts not present (standalone repo)' }, async () => {
  const { mapToNetWorthInput } = await loadRealMapper();

  for (const [source, raw] of FIXTURES) {
    const { plan } = importToPlan(source, raw);
    const nwi = mapToNetWorthInput(plan);

    // Per-emitted-key consumption checks. EVERY key the plan can carry must
    // have an entry here; an emitted key without one fails the test below, so
    // adding a new emitted field forces adding its consumption proof.
    const consumed = {
      name: () => assert.equal(nwi.name ?? plan.name, plan.name), // name is plan metadata (upsert-level), not an engine input
      earners: () => {
        assert.equal(nwi.earners.length, plan.earners.length, `${source}: earner count`);
        plan.earners.forEach((e, i) => {
          const m = nwi.earners[i];
          if (e.age !== undefined) assert.equal(m.age, e.age);
          if (e.annual_salary !== undefined) assert.equal(m.annualSalary, e.annual_salary);
          if (e.retirement_age !== undefined) assert.equal(m.retirementAge, e.retirement_age);
          const ra = e.retirement_accounts;
          if (ra?.k401) assert.equal(m.taxAdvantagedAccounts.employee401kContribution, ra.k401.employee_annual, `${source}: 401k contribution consumed`);
          if (ra?.ira) {
            assert.equal(m.taxAdvantagedAccounts.iraType, ra.ira.type);
            assert.equal(m.taxAdvantagedAccounts.iraContribution, ra.ira.annual);
          }
          if (ra?.hsa) {
            assert.equal(m.taxAdvantagedAccounts.hsaCoverageType, ra.hsa.coverage);
            assert.equal(m.taxAdvantagedAccounts.hsaContribution, ra.hsa.annual);
          }
        });
      },
      stocks: () => {
        // THE core regression: the mapped portfolio must be the TOTAL
        // (taxable + traditional + roth + HSA balance), not taxable alone.
        assert.equal(nwi.stocks.initialValue, plan.stocks.current_value, `${source}: stocks total consumed`);
        const ab = plan.account_balances;
        assert.ok(
          nwi.stocks.initialValue >= ab.taxable + ab.traditional + ab.roth,
          `${source}: mapped stocks (${nwi.stocks.initialValue}) must include traditional+roth (+hsa), not just taxable (${ab.taxable})`
        );
        assert.equal(nwi.stocks.monthlyContribution, plan.stocks.monthly_contribution);
      },
      cash: () => assert.equal(nwi.cash.initialValue, plan.cash.current_value),
      account_balances: () => {
        assert.equal(nwi.accountBalances.taxable, plan.account_balances.taxable);
        assert.equal(nwi.accountBalances.traditional, plan.account_balances.traditional);
        assert.equal(nwi.accountBalances.roth, plan.account_balances.roth);
      },
      real_estate: () => {
        assert.equal(nwi.realEstate.length, plan.real_estate.length);
        plan.real_estate.forEach((p, i) => {
          assert.equal(nwi.realEstate[i].initialValue, p.current_value);
          if (p.mortgage) {
            assert.equal(nwi.realEstate[i].mortgage.principal, p.mortgage.balance);
            assert.equal(nwi.realEstate[i].mortgage.annualInterestRate, p.mortgage.rate);
            assert.equal(nwi.realEstate[i].mortgage.years, p.mortgage.years_remaining);
          }
        });
      },
      debts: () => {
        assert.equal(nwi.debts.length, plan.debts.length);
        plan.debts.forEach((d, i) => {
          assert.equal(nwi.debts[i].balance, d.balance);
          assert.equal(nwi.debts[i].rate, d.rate);
          assert.equal(nwi.debts[i].minPayment, d.min_payment);
        });
      },
      speculative: () => {
        assert.equal(nwi.speculativeInvestments.length, plan.speculative.length);
        plan.speculative.forEach((s, i) => assert.equal(nwi.speculativeInvestments[i].initialValue, s.current_value));
      },
      education_account: () => {
        // Regression: snake_case keys inside this block used to be dropped,
        // leaving enabled:true with a $0 balance.
        assert.equal(nwi.educationAccount?.enabled, true, `${source}: educationAccount consumed`);
        assert.equal(nwi.educationAccount?.initialBalance, plan.education_account.initialBalance, `${source}: educationAccount.initialBalance must land in the engine input`);
        assert.ok(nwi.educationAccount.initialBalance > 0, `${source}: fixture 529 balance must be non-zero`);
      },
      tax_settings: () => assert.deepEqual(nwi.taxSettings, plan.tax_settings, `${source}: tax_settings passthrough`),
      desired_annual_spend: () => assert.equal(nwi.desiredAnnualSpend, plan.desired_annual_spend),
    };

    for (const key of Object.keys(plan)) {
      assert.ok(
        Object.hasOwn(consumed, key),
        `${source}: emitted key "${key}" has no consumption assertion — add one proving the real mapper consumes it`
      );
      consumed[key]();
    }
  }
});
