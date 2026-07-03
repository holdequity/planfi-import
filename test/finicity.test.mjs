import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finicityAdapter } from '../src/adapters/finicity.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { finicityRaw } from '../fixtures/finicity-sandbox.mjs';

const cfp = finicityAdapter.normalize(finicityRaw);

test('Finicity types normalize to canonical classes + tax treatments', () => {
  const by = Object.fromEntries(cfp.accounts.map((a) => [a.id, a]));
  assert.equal(by['5001'].class, 'depository');
  assert.equal(by['5003'].taxTreatment, 'taxable');       // brokerageAccount
  assert.equal(by['5004'].taxTreatment, 'traditional');   // 401k
  assert.equal(by['5005'].taxTreatment, 'roth');          // roth
  assert.equal(by['5006'].taxTreatment, 'hsa');
  assert.equal(by['5007'].taxTreatment, '529');           // 529plan
  assert.equal(by['5009'].class, 'loan');
  assert.equal(by['5009'].subtype, 'mortgage');
  assert.equal(by['5010'].subtype, 'student');            // studentLoan
  assert.equal(by['5011'].class, 'credit');               // creditCard
});

test('Finicity investmentTaxDeferred → traditional at LOW confidence (CLASSIFICATION_GUESSED)', () => {
  const annuity = cfp.accounts.find((a) => a.id === '5008');
  assert.equal(annuity.class, 'investment');
  assert.equal(annuity.taxTreatment, 'traditional');
  const w = cfp.meta.warnings.find((x) => x.code === 'CLASSIFICATION_GUESSED' && x.accountId === '5008');
  assert.ok(w, 'the guessed tax-deferred wrapper must carry a CLASSIFICATION_GUESSED warning');
  assert.equal(w.severity, 'warn');
  assert.match(w.message, /Old Variable Annuity/);
});

test('Finicity unknown account type → low-confidence guess + CLASSIFICATION_GUESSED', () => {
  const weird = finicityAdapter.normalize({
    accounts: [{ id: 1, name: 'Mystery', type: 'cryptocurrencyWallet', balance: 5000 }],
  });
  assert.equal(weird.accounts[0].class, 'investment');
  assert.equal(weird.accounts[0].taxTreatment, 'taxable');
  assert.ok(weird.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === '1'));
});

test('Finicity positions carry ticker + cost basis; null basis → NO_COST_BASIS', () => {
  const brk = cfp.accounts.find((a) => a.id === '5003');
  const vti = brk.holdings.find((h) => h.ticker === 'VTI');
  assert.equal(vti.quantity, 900);
  assert.equal(vti.costBasis, 150000);
  assert.equal(vti.assetType, 'etf');
  const btc = brk.holdings.find((h) => h.assetType === 'crypto');
  assert.equal(btc.costBasis, undefined); // never fabricated
  const w = cfp.meta.warnings.find((x) => x.code === 'NO_COST_BASIS');
  assert.equal(w.severity, 'info');
  assert.equal(w.accountId, '5003');
});

test('Finicity has no property records → home value estimated at 80% LTV + structured ask', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].current_value, Math.round(420000 / 0.8)); // 525000
  assert.equal(plan.real_estate[0].mortgage.balance, 420000);
  assert.ok(Math.abs(plan.real_estate[0].mortgage.rate - 0.055) < 1e-9);
  // maturity 2048-05 from 2026-07 → ~22 years, proving epoch-second dates parse.
  assert.ok(plan.real_estate[0].mortgage.years_remaining >= 21 && plan.real_estate[0].mortgage.years_remaining <= 23);
  assert.ok(warnings.some((w) => w.code === 'HOME_VALUE_ESTIMATED' && w.accountId === '5009'));
  const ask = needsInput.find((n) => n.field === 'home_value');
  assert.equal(ask.accountId, '5009');
  assert.equal(ask.accountName, 'Home Mortgage');
  assert.ok(ask.label && ask.why, 'structured ask carries a human label + why');
});

test('Finicity buckets + portfolio total + inferred contributions', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.account_balances.taxable, 268000);
  assert.equal(plan.account_balances.traditional, 350000 + 45000); // 401k + tax-deferred wrapper
  assert.equal(plan.account_balances.roth, 74000);
  assert.equal(plan.cash.current_value, 14200 + 48000);
  // stocks = TOTAL portfolio: taxable + traditional + roth + HSA balance (folded, info-warned).
  assert.equal(plan.stocks.current_value, 268000 + 395000 + 74000 + 26000);
  assert.equal(plan.hsa_retirement, undefined);
  assert.ok(warnings.some((w) => w.code === 'HSA_FOLDED_INTO_PORTFOLIO' && w.severity === 'info'));
  assert.ok(plan.stocks.monthly_contribution > 0);
  // 401(k) inference: $1,700/mo over a ~5-month window → ~$24,480/yr (under the limit).
  const k401 = plan.earners[0].retirement_accounts.k401.employee_annual;
  assert.ok(k401 > 20000 && k401 <= 24500, `401k annual ${k401}`);
  assert.ok(!warnings.some((w) => w.code === 'CONTRIBUTION_CLAMPED'), 'fixture stays under the IRS limit');
  // Roth IRA inference attributed to earner 1 (Casey) via ownerIndex.
  assert.equal(plan.earners[1].retirement_accounts.ira.type, 'roth');
  // 529 → education_account, engine camelCase inside.
  assert.equal(plan.education_account.initialBalance, 38000);
});

test('Finicity dividend deposits are excluded from contribution inference', () => {
  const moreDividends = {
    ...finicityRaw,
    transactions: [
      ...finicityRaw.transactions,
      ...[3, 4, 5].map((m) => ({ id: 8100 + m, accountId: 5003, amount: 900, transactedDate: Math.floor(Date.parse(`2026-0${m}-21`) / 1000), categorization: { category: 'Dividends & Interest Income' } })),
    ],
  };
  const a = finicityAdapter.normalize(finicityRaw).accounts.find((x) => x.id === '5003');
  const b = finicityAdapter.normalize(moreDividends).accounts.find((x) => x.id === '5003');
  assert.equal(b.estMonthlyContribution, a.estMonthlyContribution, 'dividend deposits must not inflate the inferred contribution');
});

test('Finicity unlabeled deposits are counted but flagged COARSE_INFERENCE', () => {
  const unlabeled = {
    ...finicityRaw,
    transactions: [1, 2, 3].map((m) => ({ id: 8200 + m, accountId: 5003, amount: 500, transactedDate: Math.floor(Date.parse(`2026-0${m}-20`) / 1000) })),
  };
  const norm = finicityAdapter.normalize(unlabeled);
  const w = norm.meta.warnings.find((x) => x.code === 'COARSE_INFERENCE');
  assert.ok(w && w.severity === 'warn');
  assert.ok(norm.accounts.find((x) => x.id === '5003').estMonthlyContribution > 0);
});

test('Finicity loans + cards → debts; negative-reported card balance is |abs|ed, missing APR asked', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.debts.length, 2);
  const student = plan.debts.find((d) => /student/i.test(d.name));
  assert.ok(Math.abs(student.rate - 0.048) < 1e-9);
  assert.equal(student.min_payment, 340);
  // The card was reported at -2600 (institution quirk): liability balances are
  // positive per the Finicity docs, so the adapter takes |x| — the debt must
  // survive, not clamp to $0.
  const card = plan.debts.find((d) => /cashback/i.test(d.name));
  assert.equal(card.balance, 2600);
  assert.equal(card.rate, 0);
  assert.ok(warnings.some((w) => w.code === 'DEBT_RATE_MISSING' && w.accountId === '5011'));
  const ask = needsInput.find((n) => n.field === 'debt_rate');
  assert.equal(ask.accountId, '5011');
  assert.equal(ask.accountName, 'Cashback Card');
});

test('Finicity crypto position becomes a speculative asset', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.speculative.length, 1);
  assert.equal(plan.speculative[0].current_value, 58000);
});

test('importToPlan wrapper works for finicity', () => {
  const r = importToPlan('finicity', finicityRaw);
  assert.equal(r.plan.tax_settings.state, 'CO');
  assert.equal(r.cfp.source, 'finicity');
  assert.equal(r.plan.earners.length, 2);
  assert.equal(r.plan.earners[0].name, 'Riley');
});
