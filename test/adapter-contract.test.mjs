// adapter-contract.test.mjs — the GENERIC floor every adapter must clear.
//
// This suite discovers every adapter registered in ADAPTERS and runs each
// through the identical battery — it is the EXECUTABLE version of the
// self-verification checklist in docs/ADAPTER_GUIDE.md (the guide and this
// harness must not drift; when you change one, change the other):
//
//   (a) normalize(fixture) → a structurally valid CFP (validateCFP) that
//       clears the fixture-content floor (≥ 3 accounts, ≥ 1 investment
//       account, ≥ 1 warning path exercised, no NaN/Infinity anywhere)
//   (b) toPlanfiPlan(cfp) succeeds; every warning carries a code from the
//       append-only catalog in src/canonical.ts and every needsInput a valid
//       field enum value
//   (c) hostile inputs NEVER throw — null/undefined/{}/[]/primitives plus
//       deterministic scrambles of the adapter's own fixture — and still
//       yield a clean plan (no NaN/Infinity, sane structure)
//   (d) determinism: two identical normalize+toPlanfiPlan runs → deep-equal
//   (e) a fixture is registered for wire-conformance (fixtures/<id>-sandbox.mjs
//       exporting <id>Raw, listed in test/helpers/fixture-registry.mjs)
//
// The catalog/enums are PARSED OUT OF src/canonical.ts (the source of truth),
// so adding a code there is automatically legal here — and an ad-hoc code an
// adapter invents fails loudly. planfi-import.d.ts is asserted to mirror the
// same unions so the shipped types can't drift either.
//
// Per-adapter tests (test/<id>.test.mjs) still assert source-specific
// behavior; this suite is only the shared floor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ADAPTERS, toPlanfiPlan } from '../src/index.mjs';
import { templateAdapter } from '../src/adapters/_template.mjs';
import { FIXTURES } from './helpers/fixture-registry.mjs';
import { validateCFP, findNonFinite } from './helpers/validate-cfp.mjs';

// ── catalog + enums, parsed from the source of truth ────────────────────────

const CANONICAL_SRC = readFileSync(new URL('../src/canonical.ts', import.meta.url), 'utf8');
const DTS_SRC = readFileSync(new URL('../planfi-import.d.ts', import.meta.url), 'utf8');

/** Extract the string literals of `export type <name> = 'a' | 'b' | …;` (comments stripped). */
function literalUnion(src, typeName) {
  const m = src.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
  assert.ok(m, `could not find \`export type ${typeName}\` — update adapter-contract.test.mjs to the new contract`);
  const body = m[1].replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const WARNING_CODES = new Set(literalUnion(CANONICAL_SRC, 'WarningCode'));
const NEEDS_FIELDS = new Set(literalUnion(CANONICAL_SRC, 'NeedsInputField'));

test('warning-code catalog + needsInput enum parse from canonical.ts (sanity)', () => {
  for (const known of ['CLASSIFICATION_GUESSED', 'NO_COST_BASIS', 'DEBT_RATE_MISSING']) {
    assert.ok(WARNING_CODES.has(known), `catalog parser lost "${known}"`);
  }
  for (const known of ['age', 'home_value', 'debt_rate']) {
    assert.ok(NEEDS_FIELDS.has(known), `needsInput enum parser lost "${known}"`);
  }
});

test('planfi-import.d.ts mirrors the canonical.ts WarningCode + NeedsInputField unions', () => {
  assert.deepEqual(new Set(literalUnion(DTS_SRC, 'WarningCode')), WARNING_CODES,
    'planfi-import.d.ts WarningCode drifted from src/canonical.ts — keep them in sync');
  assert.deepEqual(new Set(literalUnion(DTS_SRC, 'NeedsInputField')), NEEDS_FIELDS,
    'planfi-import.d.ts NeedsInputField drifted from src/canonical.ts — keep them in sync');
});

// ── shared assertions ────────────────────────────────────────────────────────

function assertDiagnostics(source, warnings, needsInput, context) {
  for (const w of warnings) {
    assert.ok(WARNING_CODES.has(w.code),
      `${source} (${context}): warning code "${w.code}" is not in the src/canonical.ts WarningCode catalog — add it there (append-only) or use an existing code`);
    assert.ok(w.severity === 'info' || w.severity === 'warn', `${source} (${context}): bad severity ${w.severity}`);
    assert.ok(typeof w.message === 'string' && w.message.length > 0, `${source} (${context}): warning message required`);
  }
  const seen = new Set();
  for (const n of needsInput) {
    assert.ok(NEEDS_FIELDS.has(n.field),
      `${source} (${context}): needsInput field "${n.field}" is not in the src/canonical.ts NeedsInputField enum`);
    assert.ok(typeof n.label === 'string' && n.label.length > 0, `${source} (${context}): needsInput.label required`);
    assert.ok(typeof n.why === 'string' && n.why.length > 0, `${source} (${context}): needsInput.why required`);
    const k = `${n.field}|${n.accountId ?? ''}|${n.earnerIndex ?? ''}`;
    assert.ok(!seen.has(k), `${source} (${context}): duplicate needsInput entry ${k}`);
    seen.add(k);
  }
}

function assertPlanFloor(source, plan, context) {
  const bad = findNonFinite(plan, 'plan');
  assert.equal(bad.length, 0, `${source} (${context}): NaN/Infinity leaked into the plan: ${bad.join('; ')}`);
  assert.ok(Array.isArray(plan.earners) && plan.earners.length >= 1, `${source} (${context}): plan.earners required`);
  const ab = plan.account_balances;
  for (const k of ['taxable', 'traditional', 'roth']) assert.ok(ab[k] >= 0, `${source} (${context}): account_balances.${k} negative`);
  assert.ok(plan.cash.current_value >= 0, `${source} (${context}): negative cash`);
  assert.ok(plan.stocks.current_value >= ab.taxable + ab.traditional + ab.roth,
    `${source} (${context}): stocks total must cover the account_balances decomposition`);
  assert.equal(plan.hsa_retirement, undefined, `${source} (${context}): hsa_retirement is not a wire field`);
  for (const re of plan.real_estate ?? []) assert.ok(re.current_value > 0, `${source} (${context}): non-positive property value`);
  for (const d of plan.debts ?? []) { assert.ok(d.balance >= 0 && d.rate >= 0, `${source} (${context}): bad debt ${JSON.stringify(d)}`); }
}

/** Deterministic scramble of a fixture: hostile numbers/strings, shuffled/holey shapes. */
function scramble(value, seedStart) {
  let seed = seedStart;
  const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const walk = (v) => {
    if (typeof v === 'number') return pick([v, NaN, Infinity, -Infinity, -v, null, '12,345', '', 1e15, 0]);
    if (typeof v === 'string') return pick([v, v, '', null, 'constructor', '   ', v.slice(0, Math.floor(rnd() * v.length))]);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      if (rnd() < 0.3) out.reverse();
      if (rnd() < 0.2) out.push(pick([null, {}, 42, 'junk']));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (rnd() < 0.15) continue; // drop keys
        out[k] = rnd() < 0.05 ? pick([null, undefined, 'nope']) : walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

const SIMPLE_HOSTILE = [
  ['null', null],
  ['undefined', undefined],
  ['empty object', {}],
  ['array', []],
  ['number', 0],
  ['string', 'garbage'],
  ['wrong-typed keys', { accounts: 'nope', holdings: 7, transactions: {}, files: 42, content: {}, owner: 'x', asOf: 12 }],
  ['null-member arrays', { accounts: [null, 42, 'x', {}], holdings: [null], transactions: [null, {}], files: [null, {}], content: '' }],
];

const N_SCRAMBLES = 60;

// ── the battery, per registered adapter ──────────────────────────────────────

for (const [source, adapter] of Object.entries(ADAPTERS)) {
  const fixture = FIXTURES[source];

  test(`[contract:${source}] adapter identity + registration shape`, () => {
    assert.equal(adapter.source, source, `ADAPTERS key "${source}" must equal adapter.source`);
    assert.equal(typeof adapter.normalize, 'function');
  });

  test(`[contract:${source}] (e) a sandbox fixture is registered for wire-conformance`, async () => {
    assert.ok(fixture,
      `Adapter "${source}" has NO fixture in test/helpers/fixture-registry.mjs.\n` +
      `Fix: create fixtures/${source}-sandbox.mjs exporting \`${source}Raw\` and add it to the registry — ` +
      'wire-conformance, the CLI demo, and this harness all read that file/registry.');
    // Naming convention: the CLI `demo` command imports fixtures/<id>-sandbox.mjs
    // and reads the `<id>Raw` export — enforce it here so demo can't break.
    const mod = await import(`../fixtures/${source}-sandbox.mjs`);
    assert.equal(mod[`${source}Raw`], fixture,
      `fixtures/${source}-sandbox.mjs must export \`${source}Raw\` and the registry must reference exactly that object`);
    // Fixture floor (documented in docs/ADAPTER_GUIDE.md → Fixture requirements):
    assert.ok(Number.isFinite(Date.parse(fixture.asOf)),
      `${source} fixture must carry an explicit ISO asOf (determinism: without it normalize() stamps "now")`);
    assert.ok(Array.isArray(fixture.owner?.earners) && fixture.owner.earners.length >= 1,
      `${source} fixture must carry owner.earners (≥ 1 named earner) so the demo prints a full plan`);
  });

  test(`[contract:${source}] (a) normalize(fixture) → structurally valid CFP + content floor`, () => {
    const cfp = adapter.normalize(fixture);
    const errors = validateCFP(cfp);
    assert.equal(errors.length, 0, `${source}: CFP structurally invalid:\n  - ${errors.join('\n  - ')}`);
    assert.equal(cfp.source, source, `${source}: cfp.source must be the adapter id`);
    assert.ok(cfp.accounts.length >= 3,
      `${source}: fixture must produce ≥ 3 accounts (got ${cfp.accounts.length}) — a thin fixture proves nothing`);
    assert.ok(cfp.accounts.some((a) => a.class === 'investment'),
      `${source}: fixture must include at least one investment account`);
    const bad = findNonFinite(cfp, 'cfp');
    assert.equal(bad.length, 0, `${source}: NaN/Infinity in the CFP: ${bad.join('; ')}`);
  });

  test(`[contract:${source}] (b) toPlanfiPlan(fixture CFP) succeeds; diagnostics use the catalog`, () => {
    const cfp = adapter.normalize(fixture);
    const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
    assertDiagnostics(source, warnings, needsInput, 'fixture');
    assertPlanFloor(source, plan, 'fixture');
    assert.ok(warnings.length >= 1,
      `${source}: the fixture must exercise at least one warning path (judgment calls are the product) — got zero warnings`);
  });

  test(`[contract:${source}] (c) hostile inputs never throw and still yield clean plans`, () => {
    const cases = [
      ...SIMPLE_HOSTILE,
      ...Array.from({ length: N_SCRAMBLES }, (_, i) => [`scrambled fixture #${i}`, scramble(fixture, 1000 + i * 7919)]),
    ];
    for (const [label, raw] of cases) {
      let cfp, out;
      assert.doesNotThrow(() => { cfp = adapter.normalize(raw); },
        `${source}: normalize() threw on hostile input (${label}) — normalize must be a total function`);
      assert.doesNotThrow(() => { out = toPlanfiPlan(cfp); },
        `${source}: toPlanfiPlan threw downstream of hostile input (${label})`);
      assertDiagnostics(source, out.warnings, out.needsInput, label);
      assertPlanFloor(source, out.plan, label);
    }
  });

  test(`[contract:${source}] (d) determinism: identical runs → deep-equal output`, () => {
    const a = adapter.normalize(fixture);
    const b = adapter.normalize(fixture);
    assert.deepEqual(a, b, `${source}: normalize() is not deterministic for the fixture`);
    assert.deepEqual(toPlanfiPlan(a), toPlanfiPlan(b), `${source}: toPlanfiPlan is not deterministic`);
  });
}

// ── guide consistency: the copy-me template ──────────────────────────────────
// docs/ADAPTER_GUIDE.md documents src/adapters/_template.mjs as an
// UNREGISTERED skeleton that emits an empty-but-structurally-valid CFP and
// would fail the fixture-content floor until filled in. Prove all of that.

test('[template] _template.mjs is NOT registered in ADAPTERS', () => {
  assert.ok(!Object.values(ADAPTERS).includes(templateAdapter), 'the template must never be registered');
  assert.ok(!Object.hasOwn(ADAPTERS, '_template'), 'no "_template" key in ADAPTERS');
});

test('[template] emits an empty-but-structurally-valid CFP, as the guide documents', () => {
  const cfp = templateAdapter.normalize({});
  const errors = validateCFP(cfp);
  assert.equal(errors.length, 0, `template CFP must be structurally valid:\n  - ${errors.join('\n  - ')}`);
  assert.equal(cfp.source, '_template');
  assert.equal(cfp.accounts.length, 0,
    'the template starts EMPTY — it must fail the harness content floor (≥ 3 accounts) until filled in');
  // …and it degrades gracefully through the shared mapper + hostile inputs.
  for (const raw of [null, undefined, 'junk', { asOf: '2026-07-02T00:00:00.000Z' }]) {
    let out;
    assert.doesNotThrow(() => { out = toPlanfiPlan(templateAdapter.normalize(raw)); });
    assertPlanFloor('_template', out.plan, 'template hostile');
  }
});
