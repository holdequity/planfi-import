# Changelog

All notable changes to `planfi-import`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## 0.6.0 — 2026-07-03

### Added

- **`batch` CLI command** — bulk-load thousands of customers through the managed
  `import_financial_data_batch` endpoint (25 items per call):
  `npx planfi-import batch <dir-or-ndjson> --source plaid --token pft_…
  [--concurrency 4] [--resume manifest.json] [--batch-size 25 | --single]`.
  Input is a directory of `<user_id>.json` payload files (filename stem = `user_id`) or an
  `.ndjson` file (`{"user_id", "payload"[, "plan_name", "source"]}` per line). The command
  chunks the load through the batch endpoint with a small worker pool, writes a **resume
  manifest / results file** (per-customer `ok`/`plan_id`/`updated`/`error` plus **full
  `needsInput` objects** — `field`/`label`/`accountId` — for collection worklists), skips
  already-ok items on re-run, never crashes on one malformed file (recorded, run continues),
  and prints a final report with the missing-data rollup (needsInput field → customers).
  Exit 0 all-ok / 1 if any item failed / 2 usage error.
- **Import upserts (server-side; documented here because the CLI relies on them)** — the
  managed import tools now key on **(partner account, `user_id`)**: the first import for a
  customer mints their plan; every re-import for the same `user_id` **updates that plan in
  place** (same `plan_id` back, `updated: true`). Batch runs are therefore idempotent — the
  resume manifest just saves quota. This deliberately differs from `generate_financial_plan`,
  which always mints; the `plan` command (which uses `generate_financial_plan`) is unchanged.
- **Consumer-tool CSV dialects** — the existing `csv` adapter's dialect table now fingerprints the
  export formats of the consumer finance tools the FIRE audience actually uses (no new adapters —
  dialect work inside `src/adapters/csv.mjs`):
  - **Monarch Money balances** (`Date/Account/Account Type/Institution/Balance`) — the file is a
    balance HISTORY, so rows are collapsed to the newest date per account (history is never
    summed). Explicit `Account Type` values classify at high confidence; the Monarch-specific
    `Real Estate`/`Vehicle`/`Valuables` types become `property`-class accounts (owned homes /
    physical assets), not fake investment balances.
  - **Monarch Money transactions** (`Date/Merchant/Category/Account/Original Statement/Notes/
    Amount/Tags`) — Mint-style signs; the Category vocabulary feeds contribution inference with
    "Dividends & Capital Gains"/"Interest" excluded as growth.
  - **YNAB register** (`Account/Flag/Date/Payee/Category Group/Category/Memo/Outflow/Inflow/
    Cleared`) — the `Outflow`/`Inflow` column PAIR nets to a signed amount; transfers into
    tracking accounts count as contributions while reconciliation balance adjustments (market
    growth) do not. YNAB structurally exports **no balances**, so the import emits the new
    `CSV_TRANSACTIONS_ONLY` warning telling the caller to pair the register with a balances file.
  - **Empower / Personal Capital holdings** (`Account/Ticker/Name/Shares/Price/…/Value`,
    community-documented column set) — rows group into accounts by the `Account` column; the
    export carries no cost basis → `NO_COST_BASIS` per holding. Empower offers no official
    all-accounts balances CSV; a hand-assembled one falls through to generic-accounts deliberately.
  - **Copilot Money transactions** (community-documented, LOW-confidence dialect fingerprinted on
    its `parent category` column) — Copilot's INVERTED sign convention (spending positive,
    money-in negative) is flipped before inference; if the convention is ever wrong, inflows read
    as outflows and are excluded (conservative — no contributions fabricated). Copilot's accounts
    export fingerprints as generic-accounts by design.
- **`CSV_TRANSACTIONS_ONLY` warning code** (append-only catalog addition, registered in
  `src/canonical.ts` + `planfi-import.d.ts` + the README/guide catalogs): the imported file's tool
  structurally cannot export balances — pair it with a balances source.
- Transactions dialects gained per-dialect vocabulary switches: `labelKeys` (compose the
  growth/inflow test label from several columns), `amountSign: -1` (inverted-sign sources), and an
  Outflow/Inflow column-pair path; `paycheck` joined the shared inflow words.
- CSV `Type`/name cells naming real estate or vehicles now classify as `property` (same
  routing-around-`classify()` pattern as the MX adapter), so they reach the plan as real estate,
  not as a taxable-investment guess.
- The `csv` sandbox fixture now carries one realistic synthetic file per consumer dialect (seven
  files total) and still round-trips the real monorepo mapper in wire-conformance.

## [0.4.0] — 2026-07-02

### Added

- **FDX adapter** — `importToPlan('fdx', { accounts, holdings, transactions, owner, asOf })`
  for the Financial Data Exchange standard (the US open-banking vocabulary named by the CFPB
  §1033 rule; Akoya speaks it natively). Accepts FDX Account entities both WRAPPED in their
  shape keys (`{ depositAccount: {…} }`, `{ investmentAccount }`, `{ loanAccount }`,
  `{ locAccount }`, `{ lineOfCredit }`, `{ annuityAccount }`) and already flattened; the wrapper
  key doubles as the fallback class signal for unknown `accountType` values. Maps the FDX
  `accountType` enum (CHECKING/SAVINGS/CD/MONEYMARKET → depository; BROKERAGE/IRA/ROTH/ROTH401K/
  401K/403B/457/529/HSA/KEOGH/SEPIRA/SIMPLEIRA → investment with matching tax treatment;
  TDA/ANNUITY → traditional at low confidence, warned; MORTGAGE/HOMEEQUITYLOAN + LOAN/AUTOLOAN/
  STUDENTLOAN/PERSONALLOAN → loans; CREDITCARD/LINEOFCREDIT → credit), InvestmentHolding
  (holdingType/symbol/units/marketValue/costBasis — DIGITALASSET → speculative crypto; missing
  cost basis never fabricated), and transactions with `debitCreditMemo` respected (DEBITs never
  count as contributions). Liability balances are treated as positive amounts owed per FDX
  conventions with an `|x|` defense; a depositAccount `interestRate` is a savings yield and never
  becomes a debt APR. Ships with a two-earner sandbox fixture, a full test file, fuzz coverage
  (wrapped AND flat entities), wire-conformance registration, and enum-alignment notes in
  `canonical.ts`.
- **Adapter-contract harness** — `test/adapter-contract.test.mjs`: one GENERIC suite that
  discovers every adapter in `ADAPTERS` and runs the identical battery — (a) `normalize(fixture)`
  yields a structurally valid CFP (new `test/helpers/validate-cfp.mjs` validator) clearing a
  content floor, (b) `toPlanfiPlan` succeeds with every warning code from the append-only catalog
  and every needsInput field from the enum (both PARSED out of `src/canonical.ts`, with
  `planfi-import.d.ts` asserted to mirror them), (c) hostile inputs never throw
  (null/undefined/primitives/null-member arrays + 60 deterministic scrambles of each adapter's
  own fixture), (d) determinism (two identical runs → deep-equal), (e) every adapter has a
  fixture registered for wire-conformance — the fixture list moved to
  `test/helpers/fixture-registry.mjs`, shared by both suites so they cannot drift.
- **AI-agent authoring docs** — `AGENTS.md` (repo purpose, the invariants as imperatives, exact
  verify commands) and `docs/ADAPTER_GUIDE.md` (ships in the npm package): canonical-model
  reference table, the adapter contract, classification cheat sheet, warning-code catalog with
  when-to-emit rules, fixture requirements, registration checklist, and a self-verification
  checklist whose checks are the contract harness. Plus `src/adapters/_template.mjs`, a fully
  commented copy-me skeleton that emits an empty-but-valid CFP, is excluded from registration,
  and is covered by a guide-consistency test.

### Fixed

_All three found by the new contract harness's hostile-input battery (the fuzz suite generated
plausible payloads and never hit these):_

- **Every adapter threw on `normalize(null)`** — the `raw = {}` default parameter only covers
  `undefined`. All adapters now coerce non-object payloads to `{}` (a total function returns an
  empty profile instead of `TypeError`).
- **Plaid/MX/Finicity threw on `null` members inside provider arrays** (`accounts`, `holdings`,
  `positions`, `transactions`, `liabilities.*`, income streams). New `objs()` helper in
  `src/util.mjs` drops non-object members at every array boundary.
- **Finicity threw `RangeError: Invalid time value`** on absurd epoch-second dates (beyond the
  ECMAScript ±8.64e15 ms range) — `finDateIso` now returns `undefined` for out-of-range values.
- **`toPlanfiPlan` threw on non-object members in a caller-supplied `owner.earners` array** —
  they are now treated as empty earner contexts (their demographics surface as needsInput asks).

## [0.3.0] — 2026-07-02

### Added

- **CSV adapter (keyless)** — `importToPlan('csv', { files, owner, asOf })`:
  dependency-free CSV parsing (quoted fields, embedded commas/newlines, CRLF,
  BOM, unclosed quotes never throw) and a header-fingerprint DIALECTS table:
  Fidelity positions, Schwab positions, Vanguard downloads, generic accounts,
  and generic transactions layouts. Money cells handle `$`, thousands commas,
  and `(1,850.00)` accounting negatives. Files matching no dialect import
  best-effort with the new **`CSV_UNMAPPED_COLUMNS`** warning code (append-only
  catalog) naming the skipped columns. Account types classify from a Type
  column; absent one, name hints are used and ALWAYS surfaced as
  `CLASSIFICATION_GUESSED`. Transactions files feed the shared contribution
  inference with the same growth-exclusion rules as the API adapters.
- **OFX adapter (keyless)** — `importToPlan('ofx', { content, owner, asOf })`:
  one tolerant dependency-free parser for both OFX 1.x SGML (unclosed leaves)
  and 2.x XML. Reads BANKMSGSRSV1 (checking/savings/CD/money-market balances;
  ACCTTYPE CREDITLINE → revolving credit), CREDITCARDMSGSRSV1 (card balances —
  OFX reports them NEGATIVE; normalized to positive amount owed, tested),
  INVSTMTMSGSRSV1 (POSSTOCK/POSMF/POSDEBT/POSOTHER positions with SECID →
  SECLISTMSGSRSV1 ticker/name lookup, UNITS/MKTVAL, INVBAL cash) and
  INVBANKTRAN deposits for contribution inference (INCOME/dividends excluded
  as growth). OFX carries no tax-treatment info → investment accounts are
  taxable at LOW confidence with `CLASSIFICATION_GUESSED`; no cost basis
  exists in the format (info-noted, never fabricated).
- **CLI** — `npx planfi-import` (zero-dep, Node ≥ 18, `bin` wired):
  `demo [--source id]` runs a bundled fixture offline; `validate <payload…>
  --source <id>` prints structured warnings/needsInput and exits 0 unless the
  import hard-fails (warnings are diagnostics); `plan <payload…> --source <id>
  [--token pft_…] [--user-id <id>] [--base <url>]` creates a real plan via
  `POST /v1/tools/generate_financial_plan` and prints the `plan_id`
  (`--user-id` is sent as the `X-Planfi-User-Id` end-user attribution header).
  CSV/OFX payloads are file paths passed directly; `--json` everywhere;
  colors only on a TTY; unknown args → help + exit 2. Tested via
  child-process spawns with the `plan` command hitting a node:http mock
  server, never the real API.
- Both new adapters are registered in `ADAPTERS`, exported from the package
  root, typed in `planfi-import.d.ts`, covered by sandbox fixtures + full test
  files, added to the wire-conformance suite (fixtures round-trip the real
  monorepo mapper) and to the fuzz suite (hostile/truncated CSV and OFX never
  throw).

## [0.2.0] — 2026-07-02

### Breaking

- **`needsInput` entries are structured objects**, not strings. Each is
  `{ field, accountId?, accountName?, earnerIndex?, label, why }` with `field`
  one of `age | retirement_age | annual_salary | desired_annual_spend |
  home_value | debt_rate`. Entries are de-duplicated on
  `(field, accountId, earnerIndex)` and emitted in deterministic order
  (earner demographics → per-account asks in account order → plan-level goals).
  Migration: `needsInput.includes('age')` → `needsInput.some(n => n.field === 'age')`;
  `'home_value:<name>'` prefixes → `n.field === 'home_value'` + `n.accountId`.
- **`warnings` entries are structured objects**, not strings. Each is
  `{ code, severity: 'info' | 'warn', message, accountId? }` where `code` is a
  stable SCREAMING_SNAKE id (see the README warnings catalog). Codes are
  append-only. Migration: `/regex/.test(w)` → match on `w.code` (or `w.message`).
- `cfp.meta.warnings` (adapter-level warnings on the canonical profile) carry
  the same structured shape.

### Added

- **Finicity (Mastercard Open Banking) adapter** — `importToPlan('finicity', …)`
  with the full Finicity account-type vocabulary (`investmentTaxDeferred`,
  `529plan`, `homeEquityLoan`, `studentLoan`, …), positions → holdings,
  transaction-based contribution inference (epoch-second dates handled,
  dividends/interest excluded), and loan `detail` fields → liability shape.
  Ships with a synthetic sandbox fixture, a full test file, fuzz coverage, and
  wire-conformance round-tripping through the real monorepo mapper.
- **TypeScript declarations** — hand-written `planfi-import.d.ts` covering
  `importToPlan`, `toPlanfiPlan`, adapters, the CFP, and the new structured
  result types; wired via the `types` field/export condition. Runtime stays
  zero-dependency ESM.
- `classify()` understands `tax-deferred` subtypes (traditional treatment at
  low confidence) for Finicity's `investmentTaxDeferred`.

### Notes on 0.1.x

- `0.1.0` was the initial release (Plaid + MX). Three wire-mapping bugs in it
  were fixed on `main` after release, before this version: retirement balances
  were omitted from the `stocks` total (silently shrinking projections), the
  package emitted an `hsa_retirement` field that does not exist on the wire,
  and `education_account` used snake_case keys the engine dropped. `0.2.0` is
  the first tagged version carrying those fixes — if you are on `0.1.0`,
  upgrade; do not pin it.

## [0.1.0] — 2026-07-01

- Initial release: canonical model (CFP), Plaid + MX adapters, shared
  `toPlanfiPlan` mapper, contribution inference, fuzz + fixture tests.
