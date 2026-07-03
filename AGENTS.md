# AGENTS.md — planfi-import

planfi-import turns raw financial data — aggregator API dumps (Plaid, MX, Finicity, FDX) or
user-downloaded CSV/OFX files — into a planfi `generate_financial_plan` wire body via one canonical
model (the CFP). Adapters translate provider vocabulary; ONE shared mapper (`src/to-planfi.mjs`)
does all the planfi thinking.

## Invariants (non-negotiable)

- **NEVER fabricate values.** Missing cost basis stays `undefined` (+ `NO_COST_BASIS` info
  warning). A value no data source can know (age, goals, home value, missing APR) becomes a
  structured `needsInput` ask — the shared mapper emits those; adapters never invent defaults to
  paper over gaps.
- **ALL domain logic lives in `src/to-planfi.mjs`.** Adapters ONLY translate one provider's
  vocabulary into the Canonical Financial Profile (`src/canonical.ts`). If you are writing IRS
  limits, LTV estimates, tax buckets, or wire fields inside an adapter, stop — that belongs in the
  shared mapper, once.
- **Warnings use stable codes from the catalog.** Every judgment call is a
  `{ code, severity, message, accountId? }` built with `warning()` from `src/util.mjs`; `code`
  MUST be a member of the append-only `WarningCode` union in `src/canonical.ts` (mirror any
  addition in `planfi-import.d.ts` — a test compares them). Never invent ad-hoc codes; never
  repurpose an existing one.
- **Emit `needsInput` for anything a source can't know.** Fields come from the `NeedsInputField`
  enum in `src/canonical.ts`; each entry carries a form-ready `label` and a one-sentence `why`.
- **Zero runtime dependencies.** Node built-ins and sibling modules only. `tsx`/`zod` are
  test-only devDependencies; nothing under `src/` or `bin/` may import a package.
- **`normalize()` is a total, deterministic function.** Any input — `null`, junk, truncated files,
  hostile arrays with `null` members — returns a structurally valid CFP; never throw. Same input →
  same output (only exception: `defaultAsOf()` when the payload has no `asOf`).
- **Every adapter is fully registered.** `ADAPTERS` + named export in `src/index.mjs`, types in
  `planfi-import.d.ts`, source list in `bin/planfi-import.mjs` USAGE, a fixture at
  `fixtures/<id>-sandbox.mjs` exporting `<id>Raw`, registered in
  `test/helpers/fixture-registry.mjs` (which feeds wire-conformance), a `test/<id>.test.mjs`, and
  a generator in `test/fuzz.test.mjs`. `test/adapter-contract.test.mjs` enforces most of this —
  run it and read its failure messages.

## Verify (run all three; all must pass)

```bash
npm ci          # installs the test-only dev deps (runtime stays zero-dep)
node --test     # every suite: per-adapter, contract harness, fuzz, CLI, wire-conformance
npm run demo    # prints a full ImportResult from the Plaid fixture — must emit valid JSON
```

`node --test` must end `fail 0`. Inside the planfi-app monorepo, wire-conformance also round-trips
every fixture through the real engine mapper; in the standalone repo it skips loudly (that skip is
expected and not a failure).

## To add an adapter

Follow **docs/ADAPTER_GUIDE.md** step by step — it contains the canonical-model reference, the
copy-me template (`src/adapters/_template.mjs`), the classification cheat sheet, the warning-code
catalog with when-to-emit rules, fixture requirements, and a self-verification checklist whose
checks are the executable tests in `test/adapter-contract.test.mjs`.
