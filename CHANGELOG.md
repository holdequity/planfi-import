# Changelog

All notable changes to `planfi-import`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (pre-1.0: minor bumps may break).

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
