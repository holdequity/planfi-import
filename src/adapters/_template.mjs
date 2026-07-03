// _template.mjs — COPY-ME adapter skeleton. NOT REGISTERED in ADAPTERS on
// purpose (the leading underscore is the convention for "not a real source").
//
// How to use (the full step-by-step recipe lives in docs/ADAPTER_GUIDE.md):
//   1. Copy this file to src/adapters/<source>.mjs and rename `templateAdapter`
//      → `<source>Adapter`, `source: '_template'` → your adapter id.
//   2. Fill in the TODOs below — translate ONLY your provider's vocabulary
//      into the Canonical Financial Profile. NO Planfi domain logic here;
//      that all lives in to-planfi.mjs, shared by every adapter.
//   3. Register it (index.mjs exports + ADAPTERS, planfi-import.d.ts, the CLI
//      source list in bin/planfi-import.mjs), add fixtures/<source>-sandbox.mjs
//      exporting `<source>Raw`, register that in
//      test/helpers/fixture-registry.mjs, and add a fuzz generator.
//   4. Run `node --test` — test/adapter-contract.test.mjs runs every
//      registered adapter through the identical battery.
//
// AS SHIPPED this skeleton returns an empty-but-STRUCTURALLY-VALID CFP: it
// passes the structural validator (validateCFP) but would FAIL the contract
// harness's fixture-content floor (a registered adapter's fixture must
// produce accounts and exercise at least one warning path) — that failure is
// the to-do list. A guide-consistency test in adapter-contract.test.mjs
// asserts exactly this behavior, so the template can't silently rot.
//
// Invariants (AGENTS.md is the authoritative list):
//   - NEVER fabricate values. Missing cost basis stays undefined + a
//     NO_COST_BASIS info warning; a guessed classification is a
//     CLASSIFICATION_GUESSED warning; a value only the user can know becomes
//     a needsInput ask (emitted by the shared mapper, not by you).
//   - Warning codes come from the append-only catalog in src/canonical.ts
//     (WarningCode). Build them with warning() from util.mjs — never ad-hoc.
//   - Zero runtime dependencies. Only node built-ins and sibling modules.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify, classifyAsset } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';
import { arr, num, pct, groupBy, monthsBetween, defaultAsOf, warning } from '../util.mjs';

// TODO: map YOUR provider's account-type vocabulary → the generic
// [type, subtype?] pair that classify() consumes. See the classification
// cheat sheet in docs/ADAPTER_GUIDE.md for the words classify() understands.
// Example:
//   const MY_TYPE = {
//     CHECKING: ['depository', 'checking'],
//     '401K':   ['investment', '401k'],
//     MORTGAGE: ['loan', 'mortgage'],
//     CREDITCARD: ['credit', 'credit card'],
//   };

/** @implements {SourceAdapter} */
export const templateAdapter = {
  source: '_template', // TODO: your adapter id (lowercase, matches the file name)

  /**
   * Translate one raw provider payload → a Canonical Financial Profile.
   * MUST be a total function: any input (null, junk, truncated data) returns
   * a valid CFP — never throw. MUST be deterministic: same input, same output
   * (the only allowed nondeterminism is defaultAsOf() when raw.asOf is absent).
   *
   * @param {object} raw - { accounts, holdings?, transactions?, owner, asOf }
   *                       (document YOUR provider's exact shape here: which
   *                       API endpoints the caller merges into each key)
   * @returns {CFP}
   */
  normalize(raw) {
    // Hostile-input floor: null/undefined/primitive payloads normalize to an
    // empty profile instead of throwing (property access on null throws!).
    raw = raw && typeof raw === 'object' ? raw : {};

    const warnings = []; // structured ImportWarning[] — use warning(code, sev, msg, accountId?)
    const unmapped = []; // raw entities you could NOT map — push them here, never drop silently

    // TODO 1: normalize transactions FIRST if your provider has them, and run
    // contributionsByAccount() to infer per-account monthly savings:
    //   - only money flowing INTO investment accounts counts
    //   - dividends/interest/reinvest are GROWTH → exclude
    //   - an unlabeled credit is counted but flagged once: COARSE_INFERENCE
    // (Copy the pattern from src/adapters/fdx.mjs or finicity.mjs.)
    const contribByAccount = contributionsByAccount([]);

    // TODO 2: map every provider account → a CanonicalAccount:
    //   const accounts = arr(raw.accounts).map((a) => { ... });
    //   - id: String(provider id)      — stable, required
    //   - class/taxTreatment: classify(genType, subtype); confidence 'low'
    //     (or an unrecognized provider type) → push CLASSIFICATION_GUESSED
    //   - balance: finite number; for loan/credit take Math.abs(x) — liability
    //     balances are positive outstanding principal in the CFP
    //   - holdings (investment only): ticker/name/quantity/value/costBasis
    //     (costBasis missing → undefined + NO_COST_BASIS info warning) and
    //     assetType via classifyAsset()
    //   - liability (loan/credit only): rate as a FRACTION via pct(),
    //     minPayment, originationPrincipal, monthsRemaining via
    //     monthsBetween(raw.asOf, maturityDate), assetName for mortgages
    //   - ownerIndex: which earner owns it (0-based; default 0)
    //   - estMonthlyContribution: from contribByAccount[id] when present
    const accounts = [];
    void classify; void classifyAsset; void num; void pct; void groupBy;
    void monthsBetween; void warning; void contribByAccount; // (drop these once the TODOs are filled in)

    return {
      source: '_template', // keep in sync with this.source
      // Prefer the caller's snapshot time; default is NOW (never the 1970 epoch).
      asOf: raw.asOf || defaultAsOf(),
      // Owner context (ages, goals, salary) passes through untouched — the
      // shared mapper turns what's missing into structured needsInput asks.
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};
