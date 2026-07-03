import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferMonthlyContribution, contributionsByAccount } from '../src/contributions.mjs';

test('sums inflows and divides by the observed window', () => {
  const txns = ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']
    .map((date) => ({ type: 'cash', subtype: 'contribution', amount: -2000, date }));
  const monthly = inferMonthlyContribution(txns);
  // ~5-month span, $12k total → ~$2.4k/mo
  assert.ok(monthly >= 2000 && monthly <= 2600, `got ${monthly}`);
});

test('ignores sells / fees (only inflows count)', () => {
  const txns = [
    { type: 'buy', subtype: 'buy', amount: 5000, date: '2026-01-01' },
    { type: 'sell', subtype: 'sell', amount: -3000, date: '2026-02-01' },
    { type: 'fee', subtype: 'management fee', amount: 20, date: '2026-03-01' },
  ];
  assert.equal(inferMonthlyContribution(txns), 0);
});

test('recognizes deposit/transfer/payroll subtypes', () => {
  const txns = [
    { subtype: 'deposit', amount: -1000, date: '2026-01-01' },
    { subtype: 'transfer', amount: -1000, date: '2026-02-01' },
  ];
  assert.ok(inferMonthlyContribution(txns) > 0);
});

test('EXCLUDES dividends/interest — growth is not a contribution (double-count regression)', () => {
  const growthOnly = [
    { type: 'cash', subtype: 'dividend', amount: -500, date: '2026-01-01' },
    { type: 'cash', subtype: 'interest', amount: -50, date: '2026-02-01' },
    { type: 'cash', subtype: 'qualified dividend', amount: -500, date: '2026-03-01' },
  ];
  assert.equal(inferMonthlyContribution(growthOnly), 0);
  // Mixed feed: only the real deposits count.
  const mixed = [
    ...growthOnly,
    { subtype: 'deposit', amount: -1000, date: '2026-01-01' },
    { subtype: 'deposit', amount: -1000, date: '2026-03-01' },
  ];
  const monthly = inferMonthlyContribution(mixed, { windowMonths: 2 });
  assert.equal(monthly, 1000);
});

test('empty / single-point → 0 (no fabrication)', () => {
  assert.equal(inferMonthlyContribution([]), 0);
  assert.equal(inferMonthlyContribution(null), 0);
});

test('contributionsByAccount groups by account_id', () => {
  const txns = [
    { account_id: 'a', subtype: 'contribution', amount: -500, date: '2026-01-01' },
    { account_id: 'a', subtype: 'contribution', amount: -500, date: '2026-02-01' },
    { account_id: 'b', subtype: 'contribution', amount: -100, date: '2026-01-01' },
    { account_id: 'b', subtype: 'contribution', amount: -100, date: '2026-02-01' },
  ];
  const m = contributionsByAccount(txns);
  assert.ok(m.a > m.b);
});
