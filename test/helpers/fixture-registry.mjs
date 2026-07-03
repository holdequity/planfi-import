// fixture-registry.mjs — THE one list of sandbox fixtures, keyed by adapter id.
//
// Both test/wire-conformance.test.mjs (fixtures → the REAL monorepo mapper)
// and test/adapter-contract.test.mjs (the generic per-adapter battery) read
// this registry, and the contract harness asserts every adapter in ADAPTERS
// has an entry here — so a new adapter cannot ship without a fixture, and the
// two suites cannot drift apart.
//
// Convention (enforced by the contract harness): the fixture for adapter `x`
// lives at fixtures/x-sandbox.mjs and exports `xRaw` (the CLI's `demo`
// command loads it by that exact name).

import { plaidRaw } from '../../fixtures/plaid-sandbox.mjs';
import { mxRaw } from '../../fixtures/mx-sandbox.mjs';
import { finicityRaw } from '../../fixtures/finicity-sandbox.mjs';
import { fdxRaw } from '../../fixtures/fdx-sandbox.mjs';
import { csvRaw } from '../../fixtures/csv-sandbox.mjs';
import { ofxRaw } from '../../fixtures/ofx-sandbox.mjs';

/** @type {Record<string, object>} adapter id → raw sandbox payload */
export const FIXTURES = {
  plaid: plaidRaw,
  mx: mxRaw,
  finicity: finicityRaw,
  fdx: fdxRaw,
  csv: csvRaw,
  ofx: ofxRaw,
};
