# planfi-import

[![tests](https://github.com/holdequity/planfi-import/actions/workflows/test.yml/badge.svg)](https://github.com/holdequity/planfi-import/actions/workflows/test.yml)
![zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![node >= 18](https://img.shields.io/badge/node-%E2%89%A5%2018-blue)
![license MIT](https://img.shields.io/badge/license-MIT-lightgrey)

**Turn raw financial data — an aggregator dump (Plaid, MX, Finicity, FDX) or the CSV/OFX files a
user can download from any bank — into a [planfi](https://api.planfi.app) financial plan.
One function call, zero runtime dependencies. Ships a CLI.**

You don't need to know Plaid or planfi to use this. An *aggregator* is a service that, with a
customer's permission, fetches their real bank/brokerage/loan data as JSON. *planfi* is a financial
projection engine with a public API: you POST a plan (balances, salaries, debts…) and get back a
`plan_id` that unlocks 100+ analysis tools (FIRE date, Roth conversions, Monte Carlo backtesting…).
This package is the bridge between the two.

```
Plaid ────┐
MX ───────┤
Finicity ─┤
FDX ──────┼─ adapter.normalize() ─► Canonical Financial ─ toPlanfiPlan() ─► wire body ─ POST ─► plan_id
CSV files ┤   (vocabulary only)      Profile (CFP)          (all domain          (generate_
OFX files ┘                                                  logic, once)         financial_plan)
```

Adapters translate each provider's vocabulary into one canonical model; a single shared mapper does
all the planfi thinking. Adding a provider never means re-writing the domain logic — to write a new
adapter (human or AI), follow [docs/ADAPTER_GUIDE.md](./docs/ADAPTER_GUIDE.md) (invariants in
[AGENTS.md](./AGENTS.md)); a generic contract harness (`test/adapter-contract.test.mjs`) enforces
the guide.

## Quick start (90 seconds)

Install (not yet on npm — install from GitHub):

```bash
npm install @plan-fi/imports
```

**1. Import.** Pass the merged responses from your aggregator's endpoints (a bundled sandbox
fixture works out of the box if you don't have credentials yet):

```js
import { importToPlan } from '@plan-fi/imports';
// No Plaid account? Use the bundled fixture: fixtures/plaid-sandbox.mjs
import { plaidRaw } from '@plan-fi/imports/fixtures/plaid-sandbox.mjs';

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
node -e "import('@plan-fi/imports').then(async ({ importToPlan }) => {
  const { plaidRaw } = await import('@plan-fi/imports/fixtures/plaid-sandbox.mjs');
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
For FDX: `importToPlan('fdx', { accounts, holdings, transactions, owner, asOf })` — accounts may be
FDX-wrapped (`{ depositAccount: {…} }`) or flattened.
No aggregator at all? See [Keyless import (CSV / OFX)](#keyless-import-csv--ofx) and the [CLI](#cli).
Each adapter's file header documents exactly which provider endpoints feed each key.
`owner` is your onboarding data (ages, goals — see [needsInput](#what-imports-vs-what-you-must-collect)).

## What maps where

| Source (Plaid / MX / Finicity / FDX) | Plan field | What the engine does with it |
|---|---|---|
| depository accounts (`checking`, `SAVINGS`, `cd`, …) | `cash.current_value` | Grows at the cash rate; funds spending first |
| taxable investment (`brokerage`, `INVESTMENT`, `brokerageAccount`) | `stocks.current_value` + `account_balances.taxable` | Projected at `annual_return`; taxed as taxable in decumulation |
| pre-tax retirement (`401k`, `IRA`, `rollover`, `investmentTaxDeferred`) | `stocks.current_value` + `account_balances.traditional` | In the portfolio total; withdrawn as ordinary income |
| Roth accounts (`roth`, `ROTH_IRA`) | `stocks.current_value` + `account_balances.roth` | In the portfolio total; withdrawn tax-free |
| HSA balance | folded into `stocks.current_value` (warned) | No wire HSA-balance field exists — see [limitations](#limitations-honest) |
| 529 / education (`529`, `529plan`, `educationIRA`) | `education_account.initialBalance` | Dedicated education projection (camelCase inside — engine shape) |
| mortgage + property (MX `PROPERTY` pairs a real value; Plaid/Finicity/FDX have none → 80%-LTV estimate) | `real_estate[]` with `mortgage {balance, rate, years_remaining}` | Amortizes the loan, appreciates the home at 3.5%/yr |
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
| `CSV_UNMAPPED_COLUMNS` | warn | CSV columns matched no dialect mapping; named in the message → rename headers or accept the best-effort import |
| `CSV_TRANSACTIONS_ONLY` | warn | The file's tool (e.g. YNAB) structurally exports no account balances → pair it with a balances file or collect balances from the user |
| `IMPORT_EMPTY` | warn | Zero accounts recognized in the payload — almost always a format/shape problem. At batch scale, a systematic export error shows up as this code in the rollup instead of hiding behind ok-counts. |

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
- **Keyless formats guess account types.** CSV positions exports and OFX carry no tax-treatment
  vocabulary — types come from a CSV Type column when present, else the account NAME, else default
  to taxable; every guess is a `CLASSIFICATION_GUESSED` warning. OFX cost basis doesn't exist in
  the format; OFX 401(k)-specific records (`INV401K`) and CSV non-US number formats (`1.234,56`)
  are not parsed.

## Adapters

| Source | `importToPlan(id, …)` | Notes |
|---|---|---|
| Plaid | `'plaid'` | accounts + holdings + liabilities + income + investment transactions |
| MX | `'mx'` | accounts + holdings + transactions; `PROPERTY` gives real home values |
| Finicity (Mastercard Open Banking) | `'finicity'` | accounts + positions + transactions; epoch-second dates handled |
| FDX (Financial Data Exchange) | `'fdx'` | the US open-banking standard (CFPB §1033; Akoya speaks it natively); wrapped or flat Account entities, `debitCreditMemo`-aware contribution inference |
| CSV files | `'csv'` | keyless; dialect table for Fidelity/Schwab/Vanguard positions, Monarch Money, YNAB, Empower/Personal Capital, Copilot Money exports + generic accounts/transactions layouts |
| OFX files | `'ofx'` | keyless; OFX 1.x SGML and 2.x XML; bank + card + investment message sets |

### Keyless import (CSV / OFX)

No aggregator contract? Every US bank and brokerage still offers **Download → CSV** and most offer
**Download → Quicken (.ofx/.qfx)**. The `csv` and `ofx` adapters turn those files into the same
canonical profile — same mapper, same warnings, same `needsInput` asks:

```js
import { importToPlan } from '@plan-fi/imports';
import { readFileSync } from 'node:fs';

// CSV: any mix of files; the header fingerprint picks the dialect per file
const { plan, warnings } = importToPlan('csv', {
  files: [
    { name: 'fidelity-positions.csv', content: readFileSync('fidelity-positions.csv', 'utf8') },
    { name: 'accounts.csv', content: readFileSync('accounts.csv', 'utf8') },
  ],
  owner: { age: 39, retirementAge: 60, annualSalary: 165000 },
});

// OFX: one statement file (SGML or XML — both parse)
importToPlan('ofx', { content: readFileSync('statement.ofx', 'utf8'), owner: { age: 45 } });
```

Recognized CSV dialects — brokerages: **Fidelity positions** (Account Number/Account Name/Symbol/…/
Cost Basis Total), **Schwab positions** (Symbol/Description/Qty/Price/Mkt Val/Cost Basis),
**Vanguard downloads** (Account Number/Investment Name/Symbol/Shares/Share Price/Total Value).
Consumer finance tools: **Monarch Money** balances (Date/Account/Account Type/Institution/Balance —
a balance HISTORY, collapsed to the newest row per account, never summed) and transactions
(Date/Merchant/Category/…/Amount; the "Dividends & Capital Gains" category is excluded as growth),
**YNAB** register (Account/…/Outflow/Inflow pair — transactions ONLY: YNAB structurally exports no
balances, so the import says so with `CSV_TRANSACTIONS_ONLY` and expects a balances file alongside),
**Empower / Personal Capital** holdings (Account/Ticker/Name/Shares/Price/Value; the export carries
no cost basis → `NO_COST_BASIS` per holding), and **Copilot Money** transactions
(community-documented format; its inverted sign convention — spending positive — is flipped). Plus
**generic accounts** (Account Name/Type/Balance + optional Interest Rate/Minimum Payment) and
**generic transactions** (Account/Date/Amount/Description) layouts — Copilot's accounts export
fingerprints as generic accounts by design. Files matching no dialect import best-effort with a
`CSV_UNMAPPED_COLUMNS` warning naming what was skipped. Money cells handle `$`, thousands commas,
and accounting-style `(1,850.00)` negatives.

Keyless honesty (both formats carry less signal than an API — the gaps are surfaced, not papered
over): positions CSVs and OFX carry **no tax-treatment info**, so account types are guessed
(from a Type column when present, else the account name) and every guess is a
`CLASSIFICATION_GUESSED` warning; OFX reports **card balances negative** — normalized to positive
amount owed; OFX positions carry **no cost basis** (noted, never fabricated); contribution
inference uses the same growth-exclusion rules as every other adapter.

## CLI

The package ships a zero-dependency CLI (Node ≥ 18):

```bash
npx @plan-fi/imports demo --source csv          # run a bundled sandbox fixture, no network
npx @plan-fi/imports validate accounts.csv --source csv          # your files, structured diagnostics
npx @plan-fi/imports validate statement.ofx --source ofx --json  # machine-readable output
npx @plan-fi/imports validate payload.json --source plaid        # API-shaped sources take one .json
npx @plan-fi/imports plan accounts.csv --source csv --token pft_… [--user-id u123]  # create a REAL plan
npx @plan-fi/imports batch ./payloads --source plaid --token pft_…  # bulk-load THOUSANDS of customers
```

- `demo` prints the plan + warnings + needsInput for a bundled fixture (colors only on a TTY).
- `validate` runs `importToPlan` on your payload and exits **0 even with warnings** (they are
  diagnostics, not failures); a hard failure (unreadable file, bad JSON, unknown source) exits 1.
- `plan` POSTs the emitted body to `POST /v1/tools/generate_financial_plan` and prints the
  `plan_id`. `--base` overrides the API host. `--user-id <id>` is sent as the `X-Planfi-User-Id`
  header: the API token identifies your (partner) tenant, while `X-Planfi-User-Id` attributes the
  plan and its usage to a specific end user within that tenant — optional, partner-supplied.
- `batch` drives the managed `import_financial_data_batch` endpoint (25 items per call) over a
  directory of `<user_id>.json` payload files (**filename stem = `user_id`**) or an `.ndjson`
  file with `{"user_id", "payload"[, "plan_name", "source"]}` per line. Every item carries its
  own `user_id`, and **(your account, `user_id`) is a stable upsert identity** — re-importing a
  customer *updates* their plan (same `plan_id`) instead of duplicating it, so the whole run is
  **safe to re-run**. 5,000 customers = 200 requests; `--concurrency 4` (default) finishes in
  ~10 minutes at typical latencies.
  - Writes a **resume manifest / results file** next to the input
    (`<input>.planfi-manifest.json`, or `--resume <path>`): per-customer `ok` / `plan_id` /
    `updated` / `error`, plus **full `needsInput` objects** (`field`, `label`, `accountId`) for
    building collection worklists. A re-run skips customers already imported ok.
  - **Partial failure never stops the run** — a malformed file or a rejected payload is recorded
    and the rest continue. The final report prints ok/failed counts plus the missing-data rollup
    (needsInput field → customers). Exit 0 all-ok, 1 if any item failed.
  - `--batch-size N` (≤ 25) tunes items per call; `--single` sends one `import_financial_data`
    call per item instead of the batch endpoint.
- `--json` on every command for machine output; unknown commands/flags print help and exit 2.

## Testing

```bash
npm install   # dev deps for the conformance test only — runtime stays zero-dep
npm test      # node --test: fixtures, CLI spawns, the generic adapter-contract harness,
              # fuzz (6×3000 randomized/hostile payloads), wire conformance
npm run demo  # print the full ImportResult built from the Plaid sandbox fixture
```

`test/adapter-contract.test.mjs` is the generic floor: it discovers every adapter in `ADAPTERS`
and runs the identical battery (structural CFP validity, cataloged warning codes, hostile inputs
never throw, determinism, fixture registered for wire-conformance). It is the executable version
of the checklist in [docs/ADAPTER_GUIDE.md](./docs/ADAPTER_GUIDE.md).

Inside the planfi-app monorepo, `test/wire-conformance.test.mjs` round-trips every fixture through
the **real** engine mapper and asserts each emitted field is consumed (in this standalone repo that
test skips loudly; the monorepo CI enforces it).

## Versioning

SemVer, pre-1.0 (minor bumps may break — see [CHANGELOG.md](./CHANGELOG.md)). v0.2.0 made
`warnings`/`needsInput` structured objects and added Finicity; warning **codes** are append-only
from here. TypeScript types ship in `planfi-import.d.ts`.

## License

MIT.
