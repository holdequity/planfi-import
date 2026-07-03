import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plaidAdapter } from '../src/adapters/plaid.mjs';
import { classify, classifyAsset } from '../src/classify.mjs';
import { plaidRaw } from '../fixtures/plaid-sandbox.mjs';

test('classify: tax treatment by subtype', () => {
  assert.equal(classify('investment', 'roth').taxTreatment, 'roth');
  assert.equal(classify('investment', '401k').taxTreatment, 'traditional');
  assert.equal(classify('investment', 'roth 401k').taxTreatment, 'roth');
  assert.equal(classify('investment', 'hsa').taxTreatment, 'hsa');
  assert.equal(classify('investment', '529').taxTreatment, '529');
  assert.equal(classify('investment', 'brokerage').taxTreatment, 'taxable');
  assert.equal(classify('depository', 'checking').accountClass, 'depository');
  assert.equal(classify('loan', 'mortgage').accountClass, 'loan');
  assert.equal(classify('credit', 'credit card').accountClass, 'credit');
});

test('classify: unknown investment subtype is taxable but low confidence', () => {
  const c = classify('investment', 'annuity');
  assert.equal(c.taxTreatment, 'taxable');
  assert.equal(c.confidence, 'low');
});

test('classifyAsset maps security types', () => {
  assert.equal(classifyAsset('etf'), 'etf');
  assert.equal(classifyAsset('equity'), 'equity');
  assert.equal(classifyAsset('cryptocurrency'), 'crypto');
  assert.equal(classifyAsset('fixed income'), 'bond');
});

test('plaid adapter normalizes to a CFP with all accounts', () => {
  const cfp = plaidAdapter.normalize(plaidRaw);
  assert.equal(cfp.source, 'plaid');
  assert.equal(cfp.accounts.length, 11);
  const byId = Object.fromEntries(cfp.accounts.map((a) => [a.id, a]));
  assert.equal(byId.brk1.class, 'investment');
  assert.equal(byId.brk1.taxTreatment, 'taxable');
  assert.equal(byId.k401.taxTreatment, 'traditional');
  assert.equal(byId.roth1.taxTreatment, 'roth');
  assert.equal(byId.mtg1.class, 'loan');
});

test('plaid adapter preserves ticker + cost basis on holdings', () => {
  const cfp = plaidAdapter.normalize(plaidRaw);
  const brk = cfp.accounts.find((a) => a.id === 'brk1');
  const vti = brk.holdings.find((h) => h.ticker === 'VTI');
  assert.equal(vti.quantity, 800);
  assert.equal(vti.value, 200000);
  assert.equal(vti.costBasis, 150000); // ← cost basis imported
  assert.equal(vti.assetType, 'etf');
  const btc = brk.holdings.find((h) => h.assetType === 'crypto');
  assert.equal(btc.costBasis, undefined); // null cost basis → undefined, not fabricated
});

test('plaid adapter warns on missing cost basis and guessed classification', () => {
  const cfp = plaidAdapter.normalize(plaidRaw);
  assert.ok(cfp.meta.warnings.some((w) => /no cost basis/i.test(w)));
  assert.ok(cfp.meta.warnings.some((w) => /classification guessed/i.test(w)));
});

test('plaid adapter maps liability detail (rate as fraction, min payment)', () => {
  const cfp = plaidAdapter.normalize(plaidRaw);
  const mtg = cfp.accounts.find((a) => a.id === 'mtg1');
  assert.ok(Math.abs(mtg.liability.rate - 0.0625) < 1e-9); // 6.25% → 0.0625
  assert.equal(mtg.liability.minPayment, 3150);
  const std = cfp.accounts.find((a) => a.id === 'std1');
  assert.ok(Math.abs(std.liability.rate - 0.055) < 1e-9);
});

test('plaid Income supplies annualSalary when present', () => {
  const withIncome = { ...plaidRaw, owner: {}, income: { income_streams: [{ monthly_income: 12000 }] } };
  const cfp = plaidAdapter.normalize(withIncome);
  assert.equal(cfp.owner.annualSalary, 144000);
});
