# Import Adapters — Aggregator Data → Planfi Plans

**Status:** Design proposal · **Author:** eng · **Target:** the `generate_financial_plan` wire schema (`PlanInputSchema`)

## Goal

Let a customer connect any account-aggregation service — **Plaid, MX, Finicity/Mastercard, Yodlee, Teller**, or a raw **CSV/OFX** export — and have their real balances, holdings, and debts transform automatically into a Planfi plan. One connect → a populated, projectable plan.

## The core idea: canonical model, not point-to-point

Every aggregator models accounts differently (Plaid's `type/subtype`, MX's `account_type`, Yodlee's `CONTAINER`, OFX's `<ACCTTYPE>`). Mapping each provider **directly** to Planfi means writing the heavy Planfi-mapping logic — tax-treatment bucketing, earner assembly, mortgage↔property pairing, contribution inference — **once per provider** (N duplicated mappers).

Instead we insert one provider-neutral layer:

```
Plaid  ─┐
MX     ─┤   normalize()          toPlanfiPlan()            mapToNetWorthInput()
Finicity┼─► Canonical Financial ──────────────► PlanInput ───────────────► NetWorthInput
Yodlee ─┤   Profile (CFP)         (ONE mapper)   (wire)      (existing)      (engine)
CSV/OFX─┘
```

- **N source adapters** each do *only* their own quirk-normalization → CFP. Small, isolated, independently testable.
- **1 canonical mapper** (`toPlanfiPlan`) holds all the Planfi domain logic. Written and tested once; every provider benefits.
- The existing **`mapToNetWorthInput`** (`workers/ai-mcp/src/lib/mapper.ts:471`) then converts wire → engine for free.

**N + 1 instead of N × M.** This is the classic adapter + canonical-model pattern.

> The Kaggle importer already shipped (`planfi-kaggle-synth/`) is the *first working instance* of this exact shape: `transform.mjs` (source → intermediate profile) + `to-planfi.mjs` (`toPlanfiHousehold`, intermediate → wire). This design generalizes that one-off into a reusable core with a formal canonical layer.

## Target schema decision

Import targets the **`generate_financial_plan` wire shape** (`PlanInputSchema`, `workers/ai-mcp/src/lib/plan-schema.ts`), **not** `configure_account` (that's partner settings — unrelated) and not raw `NetWorthInput` directly.

Why the wire shape:
- Public, validated (Zod), versioned API surface.
- Accepts every engine feature via the `PLAN_FEATURE_BLOCKS` passthrough (tax lots, equity comp, education account, student loans…).
- `mapToNetWorthInput` gives us full engine richness (per-property mortgages, individual holdings, per-earner after-tax/backdoor accounts) without hand-building camelCase engine objects.

Escalate to a direct **`NetWorthInput`** JSON import (the export/import round-trip path proven in `e2e/data-export-import.spec.ts`) **only** for engine-only fields the wire schema doesn't expose (rare; per-holding cost basis is the main candidate — see Gaps).

## The Canonical Financial Profile (CFP)

Provider-neutral normalized model — the contract every adapter emits and the mapper consumes.

```ts
interface CanonicalFinancialProfile {
  source: string;                 // 'plaid' | 'mx' | 'ofx' | ...
  asOf: string;                   // ISO timestamp of the snapshot
  owner: OwnerContext;            // demographic/goal fields — often PARTIAL from aggregators
  accounts: CanonicalAccount[];
  meta: { warnings: string[]; unmapped: unknown[] };  // never silently drop
}

interface CanonicalAccount {
  id: string;                     // stable provider account id (for dedup/reconcile)
  institution?: string;
  name?: string;
  class: 'depository' | 'investment' | 'loan' | 'credit' | 'property';
  subtype?: string;               // '401k','roth ira','brokerage','mortgage','student','auto','checking'...
  taxTreatment?: 'taxable' | 'traditional' | 'roth' | 'hsa' | '529' | 'na';
  balance: number;                // asset value, or outstanding principal for a liability
  currency?: string;
  holdings?: CanonicalHolding[];  // investment accounts
  liability?: LiabilityDetail;    // loan/credit accounts
  ownerIndex?: number;            // which earner (0/1) — for joint households
}

interface CanonicalHolding {
  ticker?: string; name?: string;
  quantity?: number; value?: number; costBasis?: number;
  assetType: 'equity' | 'etf' | 'mutual_fund' | 'bond' | 'cash' | 'crypto' | 'other';
}

interface LiabilityDetail {
  rate?: number;                  // APR as a fraction (0.0625)
  minPayment?: number;
  monthsRemaining?: number;
  originationPrincipal?: number;
  assetName?: string;             // e.g. the property/vehicle securing it
  assetValue?: number;
}

interface OwnerContext {          // what aggregators usually CAN'T give — merged from onboarding
  age?: number; retirementAge?: number;
  annualSalary?: number;          // Plaid Income can supply; else onboarding
  desiredAnnualSpend?: number;
  filingState?: string;
  earners?: Array<Partial<OwnerContext>>;
}

interface SourceAdapter<Raw = unknown> {
  readonly source: string;
  normalize(raw: Raw): CanonicalFinancialProfile;
}
```

## Mapping table — CFP → `generate_financial_plan` wire

**Wire convention** (mirrors `mapToNetWorthInput` + `round-trip-harness.test.ts`):
`stocks.current_value` is the **TOTAL investable portfolio**; `account_balances`
{taxable, traditional, roth} is its **decomposition** for tax-aware decumulation.
The engine never adds `account_balances` on top of `stocks` — a balance left out
of the stocks total is simply absent from the projection.

| CFP account | → wire target | Notes |
|---|---|---|
| `depository` (checking/savings/MMA) | `cash.current_value` (summed) | contribution inferred or from onboarding |
| `investment` + `taxable`/brokerage | `stocks.current_value` (in the total) + `account_balances.taxable` | holdings → aggregate value; ticker detail → engine `stocks.individualHoldings` (next hop) |
| `investment` + `traditional` (401k/trad IRA) | `stocks.current_value` (in the total) + `account_balances.traditional` | |
| `investment` + `roth` (roth 401k/IRA) | `stocks.current_value` (in the total) + `account_balances.roth` | |
| `investment` + `hsa` (balance) | folded into `stocks.current_value` (warned) | no wire HSA-balance field; the engine `hsaRetirement` block is NetWorthInput-only (documented next hop) |
| `investment` + `hsa` (inferred contribution) | owning earner `retirement_accounts.hsa {coverage, annual}` | coverage assumed `family`, warned; IRS-capped with warning |
| `investment` + `529` | `education_account` `{ enabled, initialBalance, monthlyContribution }` | passes through as the ENGINE shape — **camelCase inside** (snake keys are silently dropped) |
| holdings `costBasis` | `tax_lots` / `equity_compensation` feature block | cost-basis is engine-only per holding → see Gaps |
| `loan` + `mortgage` | matched `real_estate[].mortgage {balance, rate, years_remaining}` | property `current_value` needs a source — see Gaps |
| `loan` + `student` | `debts[]` (or `student_loans` block) | |
| `loan` + `auto` | `debts[]` with `asset_name`/`asset_value` | |
| `credit` (card) | `debts[]` | |
| speculative/crypto holdings | `speculative[]` | |
| `owner.annualSalary` | `earners[].annual_salary` | Plaid Income or onboarding |
| `owner.age / retirementAge / desiredAnnualSpend / filingState` | `earners[].age`, `.retirement_age`, `desired_annual_spend`, `tax_settings.state` | **onboarding-supplied** |

## What aggregators give — and the honest gaps

Aggregators are strong on **balances, holdings, and debts**, weak on the **planning context**. The adapter output is therefore a **partial plan** that merges with a short onboarding form. The design makes "imported" vs "needs input" explicit (as the Kaggle tool already does with `warnings`):

1. **No demographics/goals.** Age, retirement age, desired spend, filing state — never in aggregator data. → `OwnerContext`, onboarding-merged. Emit `needsInput: [...]`.
2. **Salary** — only if the customer buys Plaid/MX **Income** (payroll/bank-income). Otherwise onboarding.
3. **Home *value*.** Plaid `/liabilities` gives the **mortgage**, not the property's market value. Options: pair with a home-value estimate (address → AVM), infer from origination + appreciation, or ask. → warning + `needsInput`.
4. **Per-holding cost basis.** Plaid `/investments/holdings` includes `cost_basis`, but the wire `stocks` object carries only ticker+shares; cost basis lives in engine feature blocks (`tax_lots`, `equity_compensation`). Full cost-basis import may target `NetWorthInput` directly.
5. **Tax-treatment ambiguity.** Subtype→treatment isn't always clean (`brokerage` vs `ira` vs `roth 401k`). → a classification table with confidence + fallback, and a warning when guessed.
6. **Contribution rates.** Not in balances; infer from `/investments/transactions` cadence, or onboarding.
7. **Idempotency.** Re-imports must reconcile by stable `account.id` so a refresh updates buckets rather than double-counting.

## Provider notes (source side)

- **Plaid** — `/accounts` + `/auth` (balances), `/investments/holdings` (+ securities: ticker/type + cost_basis), `/liabilities` (mortgage/student/credit), optional `/income`, `/investments/transactions`. `type`+`subtype` drive `class`+`taxTreatment`.
- **MX** — `/accounts` with `account_type`/`account_subtype`; holdings via `/holdings`; similar liability coverage. Same normalization contract.
- **Finicity (Mastercard Open Banking)** — `GET /aggregation/v1/customers/{id}/accounts` (account `type` + loan `detail{}`), account-details calls for investment `position[]`, `GET /aggregation/v3/customers/{id}/transactions` (epoch-second dates; `categorization` + `investmentTransactionType` drive contribution inference). Liability balances are positive on the record (the adapter |abs|es sign quirks). No property account type → home values estimated at 80% LTV. Built: `planfi-import/src/adapters/finicity.mjs`.
- **OFX / CSV** — generic adapter for institutions without an API (many brokerages export OFX/QFX). Maps `<ACCTTYPE>` / column headers → CFP. Lowest fidelity (often no holdings/cost basis) but universal.

## Where it lives

A self-contained package **`planfi-import/`** (sibling to `planfi-kaggle-synth/`), so the core is open-sourceable as an SDK:

```
planfi-import/
  src/
    canonical.ts        # CFP types + SourceAdapter interface   ← the contract
    to-planfi.ts        # toPlanfiPlan(cfp, opts) → PlanInput    ← the one shared mapper
    classify.ts         # subtype → {class, taxTreatment} table + confidence
    reconcile.ts        # dedup/merge across refreshes by account.id
    adapters/
      plaid.ts          # Plaid payloads → CFP
      mx.ts
      ofx.ts
    client.ts           # POST to /v1/tools/generate_financial_plan
  test/ …
```

Core (`canonical`, `to-planfi`, `classify`, `ofx`) has zero provider dependencies → public. `plaid.ts`/`mx.ts` are thin and depend only on the provider payload types.

## Incremental build plan

1. **Canonical core** — `canonical.ts` (CFP + `SourceAdapter`) + `to-planfi.ts` (the shared mapper) + `classify.ts`. Retrofit `planfi-kaggle-synth` to emit CFP → proves the canonical layer against an existing source. *(Ships the reusable spine.)*
2. **Plaid adapter** — accounts + holdings + liabilities → CFP. Most-requested; best-documented. Golden fixtures from Plaid Sandbox payloads.
3. **Onboarding merge + `needsInput`** — the demographic/goal overlay; the "partial plan → complete plan" UX contract.
4. **MX adapter.**
5. **OFX/CSV generic adapter** — universal fallback for API-less brokerages.
6. **Reconciliation** — `reconcile.ts` for idempotent refresh/dedup.

Each chunk is independently shippable and testable (fixtures → CFP → wire → validate against `PlanInputSchema`, no live API needed).

## Decisions (resolved)

- **First provider: Plaid.** Adapter built (`planfi-import/src/adapters/plaid.mjs`).
- **Holdings depth:** Plaid *does* return per-holding `ticker_symbol` + `cost_basis`
  (cost basis nullable — not every institution reports it). The CFP **preserves
  ticker + shares + cost basis in full**; the base plan maps **aggregate** values
  (what drives net worth + FIRE). Surfacing ticker-level holdings in the plan
  itself is the next hop and targets engine `stocks.individualHoldings`
  (`NetWorthInput`), since the wire `stocks` object doesn't carry them.
- **Home value:** omit real estate entirely when no mortgage/home is present;
  when a mortgage exists, **ask the user for a value** (emitted in `needsInput`),
  with an AVM integration likely later.

## Status

- Chunk 1 (canonical core) + Chunk 2 (Plaid adapter) + Chunk 3 (depth) + Chunk 4
  (MX adapter) + **Finicity adapter** (v0.2.0): **built** — `planfi-import/`,
  verified end-to-end (plans minted live `plan_id`s). Run `node --test` in
  `planfi-import/` for the current suite (fixtures + 3×3000-case fuzz + wire
  conformance across all three providers).
- **v0.2.0 API:** `warnings` and `needsInput` are structured objects —
  `{ code, severity, message, accountId? }` with stable SCREAMING_SNAKE codes,
  and `{ field, accountId?, accountName?, earnerIndex?, label, why }` —
  de-duplicated and deterministic. TypeScript declarations ship in
  `planfi-import/planfi-import.d.ts`. See `planfi-import/CHANGELOG.md`.
- **Chunk 3 closed the three high-priority gaps:**
  - **Contribution inference** — `contributions.mjs` reads `/investments/transactions`
    to estimate a monthly savings rate per account → `stocks.monthly_contribution`
    + per-earner `retirement_accounts` (2026-IRS-capped, clamps warned; dividends/
    interest excluded as growth; implausible totals vs salary warned). No more
    zero-contribution plans.
  - **HSA modeled honestly** — the wire schema has NO HSA balance field (and no
    `hsa_retirement` key; the engine's `hsaRetirement` block is NetWorthInput-only).
    The HSA **balance** folds into the aggregate `stocks.current_value` (warned);
    an inferred HSA **contribution** routes to the owning earner's
    `retirement_accounts.hsa`. Targeting the engine's dedicated `hsaRetirement`
    block directly is the documented next hop, alongside `individualHoldings`.
  - **Joint households** — multiple earners from `owner.earners`; retirement + HSA
    contributions attributed to the right earner by `ownerIndex`.
- **2026-07 audit hardening:** retirement balances included in the projected
  portfolio (stocks = TOTAL, decomposed by `account_balances`);
  `education_account` emitted in engine camelCase (snake keys were being
  dropped); `asOf` defaults to now (was the 1970 epoch — ~80-year mortgage
  terms); missing debt APRs surface in `needsInput`/warnings instead of silent
  0%; negative balances + cap clamps + 80%-LTV home-value estimates all warn;
  shared `util.mjs` ends adapter helper drift. Guard:
  `test/wire-conformance.test.mjs` imports the REAL `mapper.ts` and fails if any
  emitted field isn't consumed — wired into CI via
  `.github/workflows/import-conformance.yml` on changes to either side of the
  contract.
- Next: onboarding-merge UX for `needsInput`; then OFX/CSV, reconciliation;
  and the medium-priority tail (equity-comp vesting, per-lot basis, non-US accounts).
