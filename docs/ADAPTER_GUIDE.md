# ADAPTER_GUIDE.md — how to write a planfi-import adapter

This guide is written to be followed **step by step by an AI coding agent** (it works for humans
too). Every requirement stated here is enforced by an executable test — the generic contract
harness `test/adapter-contract.test.mjs` IS this guide's checklist. If the harness passes, you
followed the guide; if you change one, change the other.

Read `AGENTS.md` first for the invariants. Short version: adapters translate ONE provider's
vocabulary into the Canonical Financial Profile (CFP); all planfi domain logic lives once in
`src/to-planfi.mjs`; never fabricate values; zero runtime dependencies.

```
provider raw ──your normalize()──► CFP ──toPlanfiPlan() (shared, DON'T touch)──► wire body
```

## 1. The canonical model (what you must emit)

Source of truth: `src/canonical.ts` (types only). Your `normalize(raw)` returns a
`CanonicalFinancialProfile`:

| Field | Type | Meaning | Who sets it |
|---|---|---|---|
| `source` | `string` | Your adapter id (must equal the `ADAPTERS` key and `adapter.source`) | adapter |
| `asOf` | ISO string | Snapshot timestamp. Use `raw.asOf \|\| defaultAsOf()` — NEVER a hardcoded epoch | adapter |
| `owner` | `OwnerContext` | Ages/goals/salary/state from onboarding. Pass through `{ ...(raw.owner ?? {}) }` untouched | caller (via adapter passthrough) |
| `accounts` | `CanonicalAccount[]` | One entry per provider account (see below) | adapter |
| `meta.warnings` | `ImportWarning[]` | Structured judgment calls — build with `warning()` from `src/util.mjs` | adapter (mapper appends its own) |
| `meta.unmapped` | `unknown[]` | Raw entities you could NOT map. Push them here; never drop silently | adapter |

`CanonicalAccount`:

| Field | Type | Meaning | Who sets it |
|---|---|---|---|
| `id` | `string` (required, non-empty) | Stable provider account id — `String()`-coerce it | adapter |
| `institution` | `string?` | Institution name/id when the provider carries one | adapter |
| `name` | `string?` | Human account name | adapter |
| `class` | `'depository' \| 'investment' \| 'loan' \| 'credit' \| 'property'` | From `classify()` | adapter (via `classify()`) |
| `subtype` | `string?` | Provider subtype, lowercased (`'401k'`, `'roth ira'`, `'mortgage'`) | adapter |
| `taxTreatment` | `'taxable' \| 'traditional' \| 'roth' \| 'hsa' \| '529' \| 'na'` | From `classify()` | adapter (via `classify()`) |
| `balance` | `number` (required, finite) | Asset value, or outstanding principal for a liability — **positive for debts**: take `Math.abs()` on loan/credit balances | adapter |
| `currency` | `string?` | ISO code, default `'USD'` | adapter |
| `holdings` | `CanonicalHolding[]?` | Investment accounts only: `{ ticker?, name?, quantity?, value?, costBasis?, assetType }`. `costBasis` missing → leave `undefined` + `NO_COST_BASIS` info warning. `assetType` via `classifyAsset()` | adapter |
| `liability` | `LiabilityDetail?` | Loan/credit only: `{ rate?, minPayment?, monthsRemaining?, originationPrincipal?, assetName?, assetValue? }`. `rate` is a **FRACTION** (use `pct()`: `6.25` → `0.0625`). `monthsRemaining` via `monthsBetween(raw.asOf, maturityDate)` | adapter |
| `ownerIndex` | `number?` (0-based int) | Which earner owns the account in a joint household; default `0` | adapter (caller-supplied field) |
| `estMonthlyContribution` | `number?` (>= 0) | Inferred monthly savings into this account, from `contributionsByAccount()` | adapter |

Everything downstream — tax buckets, the stocks total, 80%-LTV home estimates, IRS-limit clamps,
`needsInput` asks, the wire body — is `toPlanfiPlan()`'s job. **Do not** duplicate any of it.

## 2. The adapter contract

```ts
export const <source>Adapter = {
  source: '<source>',                    // adapter id, lowercase, matches file name
  normalize(raw): CanonicalFinancialProfile,
};
```

`normalize` MUST be:

- **Total** — any input (`null`, `undefined`, primitives, arrays with `null` members, truncated
  garbage) returns a valid CFP; never throws. Start with
  `raw = raw && typeof raw === 'object' ? raw : {};` and use `objs()` (from `src/util.mjs`) at
  every provider-array boundary — it drops non-object members that would otherwise crash property
  access.
- **Deterministic** — same input, same output. The only allowed nondeterminism is
  `defaultAsOf()` (= now) when the payload carries no `asOf`.
- **Honest** — a guessed classification always emits `CLASSIFICATION_GUESSED`; unmappable raw
  entities go to `meta.unmapped`; nothing is invented.

## 3. Start from the template

Copy `src/adapters/_template.mjs` → `src/adapters/<source>.mjs`. It is a fully commented skeleton
that returns an empty-but-structurally-valid CFP; the TODO comments walk you through transactions
→ contribution inference → account mapping. As shipped it would fail the harness's fixture-content
floor (≥ 3 accounts) — that failure is your to-do list. The template itself is **not registered**
in `ADAPTERS` and must stay that way (a harness test asserts it).

Model implementations, most useful first: `src/adapters/fdx.mjs` (wrapped entities, container
fallbacks), `finicity.mjs` (flat entities, epoch dates), `mx.mjs` (property accounts),
`csv.mjs`/`ofx.mjs` (keyless file parsing).

## 4. Classification cheat sheet

Call `classify(type, subtype)` with a generic `type` of `'depository' | 'investment' | 'loan' |
'credit'` (also accepts `'brokerage'` as investment) and a lowercase `subtype`. Build a lookup
table from YOUR provider's vocabulary to these words (see `FDX_TYPE` in `fdx.mjs`). Words
`classify()` understands inside `subtype`:

| You want | Subtype words that get there | Confidence |
|---|---|---|
| depository (cash) | any subtype under type `depository` (`checking`, `savings`, `cd`, `money market`) | high |
| investment / hsa | `hsa` (under `depository` OR `investment`) | high |
| investment / 529 | `529`, `education savings` | high |
| investment / roth | anything containing `roth` (`roth ira`, `roth 401k`) | high |
| investment / traditional | `401k`, `403b`, `457b`, `401a`, `ira` (word), `sep`, `simple`, `keogh`, `thrift`, `tsp`, `retirement` | high |
| investment / traditional (guess) | `tax-deferred`, `pension` | **low → warn** |
| investment / taxable | `brokerage`, `mutual fund`, `cash management`, `stock plan`, `crypto`, `ugma`, `utma`, `other` | high |
| investment / taxable (guess) | `non-taxable brokerage`, any unknown subtype, any unknown top-level type | **low → warn** |
| loan / credit | type `loan` / `credit` (any subtype; use `mortgage`, `home equity`, `student`, `auto` — the mapper routes `mortgage\|home equity` to real estate, everything else to debts) | high |

Whenever `classify()` returns `confidence: 'low'` — or your provider's type wasn't in your lookup
table at all — emit `CLASSIFICATION_GUESSED` (severity `warn`) naming the account and the guess.

For holdings, `classifyAsset(securityType)` understands: `etf`, `mutual fund`, `equity`/`stock`/
`common stock`, `fixed income`/`bond`, `cash`/`cash equivalent`, `crypto*`, `derivative` →
otherwise `'other'`. Translate your provider's holding-type enum into those words first (see
`FDX_HOLDING_TYPE`).

## 5. Warning-code catalog (when to emit each)

Codes live in the append-only `WarningCode` union in `src/canonical.ts` (mirrored in
`planfi-import.d.ts` — a harness test compares the two). Codes an **adapter** emits:

| Code | Severity | Emit when |
|---|---|---|
| `CLASSIFICATION_GUESSED` | warn | `classify()` returned low confidence, or the provider type wasn't in your lookup table, or you typed an account from its NAME |
| `NO_COST_BASIS` | info | A holding has no cost basis in the source. One per holding (API adapters) or one per account (structural to the format, e.g. OFX) |
| `COARSE_INFERENCE` | warn | Contribution inference counted deposits that carried NO category/description/type label. Emit ONCE per import, not per transaction |
| `CSV_UNMAPPED_COLUMNS` | warn | (csv adapter) columns matched no dialect mapping; name them in the message |

Codes the **shared mapper** emits (never emit these from an adapter — they fire automatically
when your CFP is right): `CONTRIBUTION_CLAMPED`, `CONTRIBUTION_IMPLAUSIBLE`,
`HSA_FOLDED_INTO_PORTFOLIO`, `HSA_COVERAGE_ASSUMED`, `IRA_SPLIT_ASSUMED`, `HOME_VALUE_ESTIMATED`,
`MORTGAGE_SKIPPED`, `NEGATIVE_BALANCE_CLAMPED`, `DEBT_RATE_MISSING`.

Need a genuinely new code? Append it to BOTH `src/canonical.ts` and `planfi-import.d.ts`, document
it in the README catalog, and never change the meaning of an existing code.

`needsInput` is emitted by the mapper only, from the `NeedsInputField` enum:
`age | retirement_age | annual_salary | desired_annual_spend | home_value | debt_rate`. Your job
is merely to NOT fill gaps that trigger them (e.g. leave `liability.rate` undefined when the
provider has no APR — the mapper then models 0% AND asks).

## 6. Contribution inference (if your provider has transactions)

Normalize provider transactions to `{ account_id, subtype: 'contribution', amount: -|x|, date }`
and run `contributionsByAccount()` — copy the pattern from `fdx.mjs`. Rules (identical in every
adapter):

1. Only money flowing INTO **investment** accounts counts.
2. Dividends/interest/capital gains/reinvestments are GROWTH → exclude (already modeled by
   `annual_return`).
3. A labeled deposit that is neither growth nor a recognized inflow word → exclude.
4. An UNLABELED deposit → include, and emit `COARSE_INFERENCE` once.
5. Money out (debits/withdrawals) never counts.

## 7. Fixture requirements (enforced by the harness)

Create `fixtures/<source>-sandbox.mjs` exporting **`<source>Raw`** (exact name — the CLI `demo`
command imports it by convention). The fixture MUST:

- carry an explicit ISO `asOf` (determinism: without it, `normalize()` stamps "now"),
- carry `owner` with at least one named earner (age, retirementAge, annualSalary) — the demo must
  print a full plan,
- produce **≥ 3 accounts**, at least one of class `investment`,
- exercise **at least one warning path** end-to-end (a no-cost-basis holding, an unknown-type
  account, a mortgage without a property value, a debt without an APR — pick several; the shipped
  fixtures each exercise most of them),
- be synthetic (no real customer data), shaped like the provider's REAL response fields.

## 8. Registration checklist

Wire the adapter everywhere (the harness fails with a pointed message for most omissions):

1. `src/adapters/<source>.mjs` — the adapter.
2. `src/index.mjs` — named export + entry in `ADAPTERS` (key === `adapter.source`).
3. `planfi-import.d.ts` — `export declare const <source>Adapter: SourceAdapter<object>;` and add
   the id to the `importToPlan` source union.
4. `bin/planfi-import.mjs` — add the id to the USAGE source lists.
5. `fixtures/<source>-sandbox.mjs` — the fixture (section 7).
6. `test/helpers/fixture-registry.mjs` — register the fixture (this feeds BOTH wire-conformance
   and the contract harness).
7. `test/<source>.test.mjs` — source-specific tests: vocabulary mapping, sign conventions, date
   handling, contribution inference, and one `importToPlan('<source>', fixture)` smoke test.
8. `test/fuzz.test.mjs` — a `<source>Payload()` generator + a row in the adapter loop.
9. `README.md` — a row in the Adapters table.
10. `CHANGELOG.md` — an entry under the next version.

## 9. SELF-VERIFICATION CHECKLIST (run these; expected outputs given)

Run from the `planfi-import/` directory.

```bash
# 1. Install test-only dev deps (runtime stays zero-dependency)
npm ci
# expected: exits 0

# 2. The generic contract harness — YOUR adapter appears in its output
node --test test/adapter-contract.test.mjs
# expected: "# fail 0", and for your <source> these subtests all "ok":
#   [contract:<source>] adapter identity + registration shape
#   [contract:<source>] (e) a sandbox fixture is registered for wire-conformance
#   [contract:<source>] (a) normalize(fixture) → structurally valid CFP + content floor
#   [contract:<source>] (b) toPlanfiPlan(fixture CFP) succeeds; diagnostics use the catalog
#   [contract:<source>] (c) hostile inputs never throw and still yield clean plans
#   [contract:<source>] (d) determinism: identical runs → deep-equal output

# 3. The whole suite (per-adapter tests, fuzz, CLI spawns, wire-conformance)
node --test
# expected: "# fail 0" (150+ tests). In the standalone repo, wire-conformance
# prints a loud SKIP about the monorepo mapper — that is expected, not a failure.

# 4. The CLI demo runs your fixture offline and emits valid JSON
node bin/planfi-import.mjs demo --source <source> --json | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
   if(r.cfp.source!=='<source>'||!r.plan.earners.length) process.exit(1);
   console.log('demo OK:', r.plan.stocks.current_value)})"
# expected: "demo OK: <a positive number>", exit 0

# 5. The default demo still works (regression guard for the package script)
npm run demo > /dev/null
# expected: exits 0
```

If any step fails, the failure message names the file to fix — the harness messages are written
to be actionable. Do not weaken a harness assertion to get green; fix the adapter.
