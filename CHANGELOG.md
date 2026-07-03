# Changelog

All notable changes to `planfi-import`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

## 0.3.0 — 2026-07-02 — targeting 0.3.0

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
