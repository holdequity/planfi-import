// planfi-import — aggregator data → Planfi plans, via a canonical model.
// See docs/IMPORT_ADAPTERS.md.

export { classify, classifyAsset } from './classify.mjs';
export { inferMonthlyContribution, contributionsByAccount } from './contributions.mjs';
export { toPlanfiPlan } from './to-planfi.mjs';
export { plaidAdapter } from './adapters/plaid.mjs';
export { mxAdapter } from './adapters/mx.mjs';

import { plaidAdapter } from './adapters/plaid.mjs';
import { mxAdapter } from './adapters/mx.mjs';
import { toPlanfiPlan } from './to-planfi.mjs';

/** Registry of source adapters by id. Add ofx here as it lands. */
export const ADAPTERS = { plaid: plaidAdapter, mx: mxAdapter };

/**
 * One-call import: raw provider payload → { plan, warnings, needsInput, cfp }.
 * @param {string} source - adapter id ('plaid')
 * @param {object} raw - provider-native payload
 * @param {object} [opts] - forwarded to toPlanfiPlan (e.g. defaultState)
 */
export function importToPlan(source, raw, opts) {
  const adapter = ADAPTERS[source];
  if (!adapter) throw new Error(`No import adapter for source "${source}". Known: ${Object.keys(ADAPTERS).join(', ')}`);
  const cfp = adapter.normalize(raw);
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp, opts);
  return { plan, warnings, needsInput, cfp };
}
