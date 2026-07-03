# planfi-import

[![tests](https://github.com/holdequity/planfi-import/actions/workflows/test.yml/badge.svg)](https://github.com/holdequity/planfi-import/actions/workflows/test.yml)
![zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node >= 18](https://img.shields.io/badge/node-%E2%89%A5%2018-blue)
![license MIT](https://img.shields.io/badge/license-MIT-lightgrey)

**Turn a raw data dump from a bank-account aggregator (Plaid, MX, or Finicity) into a
[planfi](https://api.planfi.app) financial plan — one function call, zero runtime dependencies.**

You don't need to know Plaid or planfi to use this. An *aggregator* is a service that, with a
customer's permission, fetches their real bank/brokerage/loan data as JSON. *planfi* is a financial
projection engine with a public API: you POST a plan (balances, salaries, debts…) and get back a
`plan_id` that unlocks 100+ analysis tools (FIRE date, Roth conversions, Monte Carlo backtesting…).
This package is the bridge between the two.

```
Plaid ───┐
MX ──────┼─ adapter.normalize() ─► Canonical Financial ─ toPlanfiPlan() ─► wire body ─ POST ─► plan_id
Finicity ┘   (vocabulary only)      Profile (CFP)          (all domain          (generate_
                                                            logic, once)         financial_plan)
```

Adapters translate each provider's vocabulary into one canonical model; a single shared mapper does
all the planfi thinking. Adding a provider never means re-writing the domain logic.

## Quick start (90 seconds)

Install (not yet on npm — install from GitHub):

```bash
npm install github:holdequity/planfi-import
```

**1. Import.** Pass the merged responses from your aggregator's endpoints (a bundled sandbox
fixture works out of the box if you don't have credentials yet):

```js
import { importToPlan } from 'planfi-import';
// No Plaid account? Use the bundled fixture: fixtures/plaid-sandbox.mjs
import { plaidRaw } from 'planfi-import/fixtures/plaid-sandbox.mjs';

const { plan, warnings, needsInput } = importToPlan('plaid', plaidRaw);
```

The emitted `plan` is a complete `generate_financial_plan` request body (real fixture output,
trimmed):

```jsonc
{
  "name": "Imported plan (plaid)",
  "earners": [{ "name": "Alex", "age": 41, "annual_salary": 185000,
                "retirement_accounts": { "k401": { "employee_annual": 21600 } } }, /* … */],
  "stocks": { "current_value": 680000, "monthly_contribution": 2400, "annual_return": 0.07 },
  "account_balances": { "taxable": 255000, "traditional": 315000, "roth": 88000 },
  "real_estate": [{ "current_value": 640000, "mortgage": { "balance": 512000, "rate": 0.0625 } }],
  "debts": [{ "name": "Student loan", "balance": 28000, "rate": 0.055, "min_payment": 310 }],
  "education_account": { "enabled": true, "initialBalance": 41000 },
  "desired_annual_spend": 90000, "tax_settings": { "state": "CA" }
}
```

**2. Mint the plan.** POST it to the public planfi API:

```bash
node -e "import('planfi-import').then(async ({ importToPlan }) => {
  const { plaidRaw } = await import('planfi-import/fixtures/plaid-sandbox.mjs');
  process.stdout.write(JSON.stringify(importToPlan('plaid', plaidRaw).plan));
})" > plan.json

curl -X POST https://api.planfi.app/v1/tools/generate_financial_plan \
  -H 'Content-Type: application/json' \
  --data @plan.json
```

```jsonc
{ "plan_id": "plan_af83…", "fire_age": 58, /* …full projection… */ }
```

(Anonymous calls get a small free monthly quota; add `-H "Authorization: Bearer $PLANFI_API_TOKEN"`
with a free API key for more.)

**3. Use it.** You now have a `plan_id` — every planfi tool accepts it
(`analyze_roth_conversion`, `run_backtesting`, `analyze_fire_number`, …). The connected accounts
became a living financial plan.

For MX: `importToPlan('mx', { accounts, holdings, transactions, owner, asOf })`.
For Finicity: `importToPlan('finicity', { accounts, positions, transactions, owner, asOf })`.
Each adapter's file header documents exactly which provider endpoints feed each key.
`owner` is your onboarding data (ages, goals — see [needsInput](#what-imports-vs-what-you-must-collect)).

## What maps where

| Source (Plaid / MX / Finicity) | Plan field | What the engine does with it |
|---|---|---|
| depository accounts (`checking`, `SAVINGS`, `cd`, …) | `cash.current_value` | Grows at the cash rate; funds spending first |
| taxable investment (`brokerage`, `INVESTMENT`, `brokerageAccount`) | `stocks.current_value` + `account_balances.taxable` | Projected at `annual_return`; taxed as taxable in decumulation |
| pre-tax retirement (`401k`, `IRA`, `rollover`, `investmentTaxDeferred`) | `stocks.current_value` + `account_balances.traditional` | In the portfolio total; withdrawn as ordinary income |
| Roth accounts (`roth`, `ROTH_IRA`) | `stocks.current_value` + `account_balances.roth` | In the portfolio total; withdrawn tax-free |
| HSA balance | folded into `stocks.current_value` (warned) | No wire HSA-balance field exists — see [limitations](#limitations-honest) |
| 529 / education (`529`, `529plan`, `educationIRA`) | `education_account.initialBalance` | Dedicated education projection (camelCase inside — engine shape) |
| mortgage + property (MX `PROPERTY` pairs a real value; Plaid/Finicity have none → 80%-LTV estimate) | `real_estate[]` with `mortgage {balance, rate, years_remaining}` | Amortizes the loan, appreciates the home at 3.5%/yr |
| student/auto loans, credit cards | `debts[]` (`balance`, `rate`, `min_payment`) | Paid down in cash flow; APR compounds |
| crypto holdings (security type) | `speculative[]` at 10% assumed growth | Kept out of the core stock projection |
| investment transactions (deposits in) | `stocks.monthly_contribution` / `earners[].retirement_accounts.{k401,ira,hsa}` | Inferred savings rates (dividends/interest excluded; IRS-limit clamped) |
| `owner` context you pass (ages, salary, goals) | `earners[]`, `desired_annual_spend`, `tax_settings.state` | Drives retirement timing and tax math |

Everything else the provider sent lands untouched in `cfp.meta.unmapped` — nothing is silently
dropped. The full canonical profile (`cfp`) preserves per-holding ticker/shares/cost-basis.

## What imports vs what you must collect

Aggregators know *balances*, not *people*. Anything they can't know arrives in `needsInput` as a
structured, form-ready ask — with the why:

```jsonc
// needsInput — real fixture output
[{
  "field": "home_value",
  "accountId": "mtg1",
  "accountName": "Home mortgage",
  "label": "Home value for Home mortgage",
  "why": "The provider reported the mortgage but not the property's market value — currently estimated at 80% LTV."
}]
```

| `field` | Why the import can't supply it |
|---|---|
| `age`, `retirement_age` | Aggregators report balances, not birthdays or goals (`earnerIndex` says whose) |
| `annual_salary` | Only payroll-linked products (e.g. Plaid Income) carry it; otherwise ask |
| `desired_annual_spend` | A retirement-spending goal — no account data implies it |
| `home_value` | Providers report the *mortgage*, not the home's market value (MX `PROPERTY` is the exception) |
| `debt_rate` | Some institutions omit the APR; the debt is modeled at 0% (optimistic) until supplied |

Entries are de-duplicated on `(field, accountId, earnerIndex)` and deterministic in order. Collect
them at onboarding, merge into `owner` (or patch the plan), re-run.

## Warnings catalog

Every judgment call is surfaced as `{ code, severity, message, accountId? }`. Codes are **stable and
append-only** — switch on them; the human `message` may improve between versions.

| Code | Sev | Meaning → suggested handling |
|---|---|---|
| `CLASSIFICATION_GUESSED` | warn | Ambiguous account type; tax treatment guessed → show the account, let the user reclassify |
| `NO_COST_BASIS` | info | Institution omitted a holding's cost basis → fine for projections; collect before tax-lot analysis |
| `COARSE_INFERENCE` | warn | Unlabeled deposits counted as contributions → have the user verify savings rates |
| `CONTRIBUTION_CLAMPED` | warn | Inferred contribution exceeded the IRS limit; clamped → likely a rollover; verify |
| `CONTRIBUTION_IMPLAUSIBLE` | warn | Inferred savings > 50% of known salary → likely transfers counted; verify |
| `HSA_FOLDED_INTO_PORTFOLIO` | info | HSA balance modeled inside the aggregate portfolio → no action; see limitations |
| `HSA_COVERAGE_ASSUMED` | info | HSA coverage type assumed `family` → ask self/family if precision matters |
| `IRA_SPLIT_ASSUMED` | info | Trad + Roth IRA contributions merged as type `both` (engine models 50/50) → note if lopsided |
| `HOME_VALUE_ESTIMATED` | warn | Home value estimated at 80% LTV → replace via the `home_value` ask |
| `MORTGAGE_SKIPPED` | warn | Mortgage had no balance or value; dropped → check the source record |
| `NEGATIVE_BALANCE_CLAMPED` | warn | Negative *asset* balance clamped to $0 → check for margin/overdraft |
| `DEBT_RATE_MISSING` | warn | Debt modeled at 0% APR → supply the rate via the `debt_rate` ask |

## Limitations (honest)

- **No catch-up contributions.** Inferred contributions clamp to the base 2026 IRS limits
  (401k $24,500 / IRA $7,500 / HSA family $8,750); age-50+ catch-ups are not modeled.
- **Home values estimated at 80% LTV** when the provider has no property record (Plaid, Finicity) —
  always warned, always asked for.
- **HSA balances ride inside the portfolio total.** The wire schema has no HSA-balance field; the
  engine's dedicated `hsaRetirement` block is `NetWorthInput`-only (targeting it is the next hop,
  alongside per-ticker `individualHoldings`).
- **IRA `both` = 50/50.** An earner with both traditional and Roth IRA contributions gets one wire
  block the engine splits evenly, whatever the real split (warned with the real numbers).
- **Contribution inference is a heuristic.** Transfers and rollovers look like savings in a
  transaction feed; MX/Finicity credits without labels are counted coarsely (`COARSE_INFERENCE`).
  Sanity checks (salary %, IRS limits) warn, not fix.
- **A defined-benefit pension "balance"** is bucketed as a traditional account, low confidence — a
  coarse stand-in for an income stream.

## Adapters

| Source | `importToPlan(id, …)` | Notes |
|---|---|---|
| Plaid | `'plaid'` | accounts + holdings + liabilities + income + investment transactions |
| MX | `'mx'` | accounts + holdings + transactions; `PROPERTY` gives real home values |
| Finicity (Mastercard Open Banking) | `'finicity'` | accounts + positions + transactions; epoch-second dates handled |
| OFX / CSV | — | planned |

## Testing

```bash
npm install   # dev deps for the conformance test only — runtime stays zero-dep
npm test      # node --test: fixtures, fuzz (3×3000 randomized payloads), wire conformance
npm run demo  # print the full ImportResult built from the Plaid sandbox fixture
```

Inside the planfi-app monorepo, `test/wire-conformance.test.mjs` round-trips every fixture through
the **real** engine mapper and asserts each emitted field is consumed (in this standalone repo that
test skips loudly; the monorepo CI enforces it).

## Versioning

SemVer, pre-1.0 (minor bumps may break — see [CHANGELOG.md](./CHANGELOG.md)). v0.2.0 made
`warnings`/`needsInput` structured objects and added Finicity; warning **codes** are append-only
from here. TypeScript types ship in `planfi-import.d.ts`.

## License

MIT.
