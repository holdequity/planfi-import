// planfi-import — aggregator data → Planfi plans, via a canonical model.
// See docs/IMPORT_ADAPTERS.md. To ADD an adapter, follow docs/ADAPTER_GUIDE.md
// (and AGENTS.md for the invariants) — every adapter must be registered here
// in ADAPTERS + the named exports, typed in planfi-import.d.ts, and covered by
// a fixture in test/helpers/fixture-registry.mjs; test/adapter-contract.test.mjs
// enforces all of that.

export { classify, classifyAsset } from './classify.mjs';
export { inferMonthlyContribution, contributionsByAccount } from './contributions.mjs';
export { toPlanfiPlan } from './to-planfi.mjs';
export { plaidAdapter } from './adapters/plaid.mjs';
export { mxAdapter } from './adapters/mx.mjs';
export { finicityAdapter } from './adapters/finicity.mjs';
export { fdxAdapter } from './adapters/fdx.mjs';
export { csvAdapter } from './adapters/csv.mjs';
export { ofxAdapter } from './adapters/ofx.mjs';

import { plaidAdapter } from './adapters/plaid.mjs';
import { mxAdapter } from './adapters/mx.mjs';
import { finicityAdapter } from './adapters/finicity.mjs';
import { fdxAdapter } from './adapters/fdx.mjs';
import { csvAdapter } from './adapters/csv.mjs';
import { ofxAdapter } from './adapters/ofx.mjs';
import { toPlanfiPlan } from './to-planfi.mjs';

/** Registry of source adapters by id. */
export const ADAPTERS = { plaid: plaidAdapter, mx: mxAdapter, finicity: finicityAdapter, fdx: fdxAdapter, csv: csvAdapter, ofx: ofxAdapter };

/**
 * One-call import: raw provider payload → { plan, warnings, needsInput, cfp }.
 * @param {string} source - adapter id ('plaid' | 'mx' | 'finicity' | 'fdx' | 'csv' | 'ofx')
 * @param {object} raw - provider-native payload
 * @param {object} [opts] - forwarded to toPlanfiPlan (e.g. defaultState)
 * @returns {{ plan: object, warnings: import('./canonical').ImportWarning[], needsInput: import('./canonical').NeedsInput[], cfp: import('./canonical').CanonicalFinancialProfile }}
 */
export function importToPlan(source, raw, opts) {
  const adapter = ADAPTERS[source];
  if (!adapter) throw new Error(`No import adapter for source "${source}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const cfp = adapter.normalize(raw);
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp, opts);
  return { plan, warnings, needsInput, cfp };
}
