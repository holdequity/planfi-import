import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fdxAdapter } from '../src/adapters/fdx.mjs';
import { toPlanfiPlan } from '../src/to-planfi.mjs';
import { importToPlan } from '../src/index.mjs';
import { fdxRaw } from '../fixtures/fdx-sandbox.mjs';

const cfp = fdxAdapter.normalize(fdxRaw);

test('FDX accountType enum normalizes to canonical classes + tax treatments', () => {
  const by = Object.fromEntries(cfp.accounts.map((a) => [a.id, a]));
  assert.equal(by['fdx-chk'].class, 'depository');
  assert.equal(by['fdx-sav'].class, 'depository');
  assert.equal(by['fdx-brk'].taxTreatment, 'taxable');       // BROKERAGE
  assert.equal(by['fdx-401k'].taxTreatment, 'traditional');  // 401K
  assert.equal(by['fdx-roth'].taxTreatment, 'roth');         // ROTH
  assert.equal(by['fdx-hsa'].taxTreatment, 'hsa');           // HSA
  assert.equal(by['fdx-529'].taxTreatment, '529');           // 529
  assert.equal(by['fdx-mtg'].class, 'loan');
  assert.equal(by['fdx-mtg'].subtype, 'mortgage');
  assert.equal(by['fdx-stu'].subtype, 'student');            // STUDENTLOAN
  assert.equal(by['fdx-card'].class, 'credit');              // CREDITCARD in a locAccount
});

test('FDX wrapped and flat account entities both normalize', () => {
  const flat = fdxAdapter.normalize({
    accounts: [{ accountId: 'flat1', accountType: 'SAVINGS', nickname: 'Flat Savings', currentBalance: 1200 }],
  });
  assert.equal(flat.accounts[0].id, 'flat1');
  assert.equal(flat.accounts[0].class, 'depository');
  assert.equal(flat.accounts[0].balance, 1200);
});

test('FDX unknown accountType → container is the fallback class signal + CLASSIFICATION_GUESSED', () => {
  const mystery = cfp.accounts.find((a) => a.id === 'fdx-mystery');
  assert.equal(mystery.class, 'investment'); // investmentAccount container
  assert.equal(mystery.taxTreatment, 'taxable');
  const w = cfp.meta.warnings.find((x) => x.code === 'CLASSIFICATION_GUESSED' && x.accountId === 'fdx-mystery');
  assert.ok(w, 'the unknown accountType must carry a CLASSIFICATION_GUESSED warning');
  assert.equal(w.severity, 'warn');
  assert.match(w.message, /DIGITALWALLET/);
  // Unknown type in a loanAccount container falls back to loan, not investment.
  const loanish = fdxAdapter.normalize({
    accounts: [{ loanAccount: { accountId: 'l1', accountType: 'SOMETHINGNEW', principalBalance: 5000 } }],
  });
  assert.equal(loanish.accounts[0].class, 'loan');
  assert.ok(loanish.meta.warnings.some((w2) => w2.code === 'CLASSIFICATION_GUESSED' && w2.accountId === 'l1'));
});

test('FDX TDA/ANNUITY → traditional at LOW confidence (CLASSIFICATION_GUESSED)', () => {
  const norm = fdxAdapter.normalize({
    accounts: [{ investmentAccount: { accountId: 'tda1', accountType: 'TDA', nickname: 'Old TDA', currentValue: 40000 } }],
  });
  assert.equal(norm.accounts[0].taxTreatment, 'traditional');
  assert.ok(norm.meta.warnings.some((w) => w.code === 'CLASSIFICATION_GUESSED' && w.accountId === 'tda1'));
});

test('FDX holdings carry ticker + cost basis; null basis → NO_COST_BASIS; DIGITALASSET → crypto', () => {
  const brk = cfp.accounts.find((a) => a.id === 'fdx-brk');
  const vti = brk.holdings.find((h) => h.ticker === 'VTI');
  assert.equal(vti.quantity, 780);
  assert.equal(vti.costBasis, 170000);
  assert.equal(vti.assetType, 'etf');
  const eth = brk.holdings.find((h) => h.ticker === 'ETH');
  assert.equal(eth.assetType, 'crypto'); // DIGITALASSET
  assert.equal(eth.costBasis, undefined); // never fabricated
  const w = cfp.meta.warnings.find((x) => x.code === 'NO_COST_BASIS');
  assert.equal(w.severity, 'info');
  assert.equal(w.accountId, 'fdx-brk');
  const k = cfp.accounts.find((a) => a.id === 'fdx-401k');
  assert.equal(k.holdings[0].assetType, 'mutual_fund'); // MUTUALFUND
});

test('FDX has no property entity → home value estimated at 80% LTV + structured ask', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.real_estate.length, 1);
  assert.equal(plan.real_estate[0].current_value, Math.round(405000 / 0.8)); // 506250
  assert.equal(plan.real_estate[0].mortgage.balance, 405000);
  assert.ok(Math.abs(plan.real_estate[0].mortgage.rate - 0.0525) < 1e-9);
  // maturity 2049-04 from 2026-07 → ~23 years, proving ISO dates parse.
  assert.ok(plan.real_estate[0].mortgage.years_remaining >= 22 && plan.real_estate[0].mortgage.years_remaining <= 24);
  assert.ok(warnings.some((w) => w.code === 'HOME_VALUE_ESTIMATED' && w.accountId === 'fdx-mtg'));
  const ask = needsInput.find((n) => n.field === 'home_value');
  assert.equal(ask.accountId, 'fdx-mtg');
  assert.equal(ask.accountName, 'Home Mortgage');
});

test('FDX buckets + portfolio total + inferred contributions', () => {
  const { plan, warnings } = toPlanfiPlan(cfp);
  assert.equal(plan.account_balances.taxable, 295000 + 9000); // brokerage + guessed mystery wallet
  assert.equal(plan.account_balances.traditional, 380000);
  assert.equal(plan.account_balances.roth, 81000);
  assert.equal(plan.cash.current_value, 16800 + 54000);
  // stocks = TOTAL portfolio: taxable + traditional + roth + HSA balance (folded, info-warned).
  assert.equal(plan.stocks.current_value, 304000 + 380000 + 81000 + 24000);
  assert.equal(plan.hsa_retirement, undefined);
  assert.ok(warnings.some((w) => w.code === 'HSA_FOLDED_INTO_PORTFOLIO' && w.severity === 'info'));
  assert.ok(plan.stocks.monthly_contribution > 0);
  // 401(k) inference: $1,650/mo credits over a ~5-month window → under the limit.
  const k401 = plan.earners[0].retirement_accounts.k401.employee_annual;
  assert.ok(k401 > 19000 && k401 <= 24500, `401k annual ${k401}`);
  assert.ok(!warnings.some((w) => w.code === 'CONTRIBUTION_CLAMPED'), 'fixture stays under the IRS limits');
  // Roth IRA inference attributed to earner 1 (Morgan) via ownerIndex.
  assert.equal(plan.earners[1].retirement_accounts.ira.type, 'roth');
  // 529 → education_account, engine camelCase inside.
  assert.equal(plan.education_account.initialBalance, 36000);
});

test('FDX dividend credits are excluded; DEBITs never count as contributions', () => {
  const withNoise = {
    ...fdxRaw,
    transactions: [
      ...fdxRaw.transactions,
      // more dividends + an outgoing DEBIT with an inflow-looking description
      ...[3, 4, 5].map((m) => ({ investmentTransaction: { transactionId: `div${m}`, accountId: 'fdx-brk', transactionType: 'DIVIDEND', totalAmount: 900, debitCreditMemo: 'CREDIT', postedTimestamp: `2026-0${m}-21T00:00:00.000Z` } })),
      { investmentTransaction: { transactionId: 'out1', accountId: 'fdx-brk', description: 'TRANSFER OUT', totalAmount: 5000, debitCreditMemo: 'DEBIT', postedTimestamp: '2026-04-02T00:00:00.000Z' } },
    ],
  };
  const a = fdxAdapter.normalize(fdxRaw).accounts.find((x) => x.id === 'fdx-brk');
  const b = fdxAdapter.normalize(withNoise).accounts.find((x) => x.id === 'fdx-brk');
  assert.equal(b.estMonthlyContribution, a.estMonthlyContribution, 'dividends and DEBITs must not move the inferred contribution');
});

test('FDX unlabeled credits are counted but flagged COARSE_INFERENCE', () => {
  const unlabeled = {
    ...fdxRaw,
    transactions: [1, 2, 3].map((m) => ({ investmentTransaction: { transactionId: `u${m}`, accountId: 'fdx-brk', totalAmount: 400, debitCreditMemo: 'CREDIT', postedTimestamp: `2026-0${m}-20T00:00:00.000Z` } })),
  };
  const norm = fdxAdapter.normalize(unlabeled);
  const w = norm.meta.warnings.find((x) => x.code === 'COARSE_INFERENCE');
  assert.ok(w && w.severity === 'warn');
  assert.ok(norm.accounts.find((x) => x.id === 'fdx-brk').estMonthlyContribution > 0);
});

test('FDX loans + cards → debts; negative-reported balances are |abs|ed; missing APR asked', () => {
  const { plan, warnings, needsInput } = toPlanfiPlan(cfp);
  assert.equal(plan.debts.length, 2);
  const student = plan.debts.find((d) => /student/i.test(d.name));
  assert.ok(Math.abs(student.rate - 0.046) < 1e-9);
  assert.equal(student.min_payment, 320);
  const card = plan.debts.find((d) => /travel/i.test(d.name));
  assert.equal(card.balance, 3400);
  assert.equal(card.rate, 0); // no APR on record → modeled at 0%, warned + asked
  assert.ok(warnings.some((w) => w.code === 'DEBT_RATE_MISSING' && w.accountId === 'fdx-card'));
  const ask = needsInput.find((n) => n.field === 'debt_rate');
  assert.equal(ask.accountId, 'fdx-card');
  // Liability balances are positive owed per FDX; a negative-reporting
  // institution quirk must not clamp the debt to $0 downstream.
  const quirk = fdxAdapter.normalize({
    accounts: [{ locAccount: { accountId: 'neg1', accountType: 'CREDITCARD', nickname: 'Quirk Card', currentBalance: -1800 } }],
  });
  assert.equal(quirk.accounts[0].balance, 1800);
});

test('FDX deposit-account interestRate is a yield, never a debt APR', () => {
  const sav = cfp.accounts.find((a) => a.id === 'fdx-sav');
  assert.equal(sav.liability, undefined, 'depository accounts must not grow a liability block');
});

test('FDX crypto holding becomes a speculative asset', () => {
  const { plan } = toPlanfiPlan(cfp);
  assert.equal(plan.speculative.length, 1);
  assert.equal(plan.speculative[0].current_value, 57000);
});

test('importToPlan wrapper works for fdx', () => {
  const r = importToPlan('fdx', fdxRaw);
  assert.equal(r.plan.tax_settings.state, 'NY');
  assert.equal(r.cfp.source, 'fdx');
  assert.equal(r.plan.earners.length, 2);
  assert.equal(r.plan.earners[0].name, 'Avery');
});
