# Architecture

`planfi-import` turns customer financial data from account aggregators
(**Plaid**, **MX**, and — planned — OFX/CSV) into a **Planfi plan**, using a
provider-neutral canonical model.

## Canonical model — N + 1, not N × M

Every aggregator models accounts differently. Mapping each provider *directly*
to a plan means writing the heavy domain logic once per provider. Instead a
single provider-neutral layer sits in the middle:

```
Plaid ┐
MX    ┤  normalize()        toPlanfiPlan()          generate_financial_plan
OFX   ┼─► Canonical ────────────────────► Plan wire ────────────────────► plan
CSV   ┘   Profile (CFP)      (one mapper)   object       (Planfi engine)
```

- **N source adapters** each normalize *only* their own quirks into the CFP.
  Small, isolated, independently testable.
- **One shared mapper** (`toPlanfiPlan`) holds all Planfi domain logic:
  tax-treatment bucketing, mortgage↔property pairing, debt assembly, HSA
  routing, contribution inference, missing-context detection.

Adding a provider is a thin adapter, not a new end-to-end mapping.

## The Canonical Financial Profile (CFP)

The contract every adapter emits and the mapper consumes — see
[`src/canonical.ts`](../src/canonical.ts). Accounts are normalized to a small
set of classes (`depository`, `investment`, `loan`, `credit`, `property`) and
tax treatments (`taxable`, `traditional`, `roth`, `hsa`, `529`), with holdings
(ticker + shares + cost basis) and liability detail preserved verbatim. Nothing
is fabricated: values the aggregator can't supply become `warnings` or
`needsInput` entries.

## What imports vs. what you must ask for

Aggregators are strong on **balances, holdings, and debts** and weak on
**planning context**. So an import is a *partial plan* + a `needsInput` list:

- **Imported:** balances by tax treatment, cash, holdings (ticker/shares/cost
  basis), mortgages → property + loan, student/auto/credit debts, crypto,
  **HSA** (as a real compounding asset), and **inferred contribution rates**
  from investment transactions. Joint households → multiple earners.
- **`needsInput` (collect at onboarding):** age, retirement age, desired spend,
  salary (unless the provider supplies income), filing state, and a home value
  when a mortgage exists but the provider gives no property value. (MX PROPERTY
  accounts supply the home value directly, so MX imports often need nothing.)

## Robustness — proven, not asserted

`test/fuzz.test.mjs` runs **6,000 randomized payloads** (3,000 per adapter) with
nulls, negatives, `NaN`/`Infinity`, junk strings, and missing fields, and
asserts the adapters **never throw** and every emitted plan carries only finite,
non-negative numbers with valid structure. Strict `money()` coercion clamps any
junk to safe values. This is what keeps "weird provider data" from becoming a
downstream transform error.

## Adding an adapter

1. Implement `SourceAdapter` (`src/canonical.ts`): a `normalize(raw)` that maps
   your provider's payload into a `CanonicalFinancialProfile`.
2. Reuse `classify()` / `classifyAsset()` by translating your provider's
   type/subtype vocabulary into the generic strings they expect.
3. Register it in `src/index.mjs`'s `ADAPTERS`.
4. Add a fixture + tests. The shared mapper and the fuzz harness cover the rest.
