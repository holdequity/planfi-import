# planfi-import

Import a customer's real financial data from **Plaid** (and, next, MX / OFX)
into a **Planfi plan** — via a provider-neutral canonical model. Zero runtime
dependencies, Node ≥ 18.

See [`docs/IMPORT_ADAPTERS.md`](docs/ARCHITECTURE.md) for the full design.

```
Plaid payload ──plaidAdapter.normalize()──► CanonicalFinancialProfile
CFP ──toPlanfiPlan()──► generate_financial_plan wire body ──► real plan_id
```

## Quick start

```js
import { importToPlan } from 'planfi-import';

const { plan, warnings, needsInput, cfp } = importToPlan('plaid', plaidResponse);
// plan       → POST to /v1/tools/generate_financial_plan
// needsInput → fields to collect from the user (aggregators can't supply them)
// warnings   → guessed classifications, missing cost basis, etc.
// cfp        → the full canonical profile (ticker/shares/cost-basis preserved)
```

`plaidResponse` is the merged result of the Plaid product endpoints:

```js
{
  accounts,     // /accounts/get           → accounts[] (+ balances)
  holdings,     // /investments/holdings/get → holdings[]
  securities,   // /investments/holdings/get → securities[]
  liabilities,  // /liabilities/get         → { mortgage, student, credit }
  income,       // /income (optional)       → owner.annualSalary
  owner,        // onboarding-supplied context (age, retirementAge, spend, state)
  asOf,         // ISO snapshot timestamp
}
```

## What imports, and what you must ask for

**Imported from Plaid:** balances by tax treatment (taxable / traditional /
Roth / 529), cash, per-holding ticker + shares + cost basis, mortgages
(→ property + loan), student/auto/credit debts, crypto (→ speculative),
**HSA** (→ `hsa_retirement` block — a real compounding asset in net worth + FIRE),
**inferred contribution rates** (from `/investments/transactions`), and
**joint households** (two earners from `owner.earners`, retirement contributions
attributed per owner).

**`needsInput` (aggregators can't supply — collect at onboarding):** age,
retirement age, desired spend, salary (unless Plaid Income), filing state, and a
**home value** whenever a mortgage exists (per product decision: ask now, AVM
later). Nothing is fabricated — missing fields are omitted and listed.

## Design notes

- **Canonical model, N+1 not N×M.** Every adapter normalizes only its own quirks
  into the CFP (`src/canonical.ts`); all Planfi domain logic lives once in
  `src/to-planfi.mjs`.
- **Target = the `generate_financial_plan` wire schema** — validated, public,
  and `mapToNetWorthInput` unlocks full engine richness downstream.
- **Holdings depth:** the CFP fully preserves ticker + shares + **cost basis**
  (Plaid provides them, when the institution reports them). The base plan uses
  **aggregate** values; surfacing ticker-level holdings in the plan itself
  (engine `stocks.individualHoldings`) is the next hop — the wire `stocks`
  object doesn't carry them, so that step targets `NetWorthInput` directly.

## Adapters

| Source | Status |
|---|---|
| Plaid | ✅ accounts + holdings + liabilities + income |
| MX | planned |
| OFX / CSV | planned |

## Testing

```bash
node --test        # 18 cases
npm run demo       # print the plan built from the sandbox fixture
```

## License

MIT.
