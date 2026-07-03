// to-planfi.mjs — the ONE shared mapper: Canonical Financial Profile →
// generate_financial_plan wire object. Every provider adapter funnels through
// here, so all Planfi domain logic lives once.
//
// @typedef {import('./canonical').CanonicalFinancialProfile} CFP

const round = (n) => Math.round(money(n));
const round4 = (n) => Math.round(money(n) * 10000) / 10000;
/** Coerce any value to a finite, non-negative number (clamps junk/NaN/∞/neg → 0). */
function money(x) {
  const n = typeof x === 'string' ? Number(x.replace(/[$,%\s]/g, '')) : Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// IRS elective-deferral / IRA limits (2024/2025) used to cap inferred contributions.
const LIMIT_401K = 23000;
const LIMIT_IRA = 7000;

/**
 * @param {CFP} cfp
 * @param {object} [opts]
 * @param {string} [opts.defaultState='CA']
 * @returns {{ plan: object, warnings: string[], needsInput: string[] }}
 */
export function toPlanfiPlan(cfp, opts = {}) {
  const { defaultState = 'CA' } = opts;
  const warnings = [...(cfp?.meta?.warnings ?? [])];
  const needsInput = [];
  const accounts = Array.isArray(cfp?.accounts) ? cfp.accounts : [];
  const owner = cfp?.owner ?? {};

  const sumBy = (pred, val = (a) => a.balance) =>
    accounts.filter(pred).reduce((n, a) => n + money(val(a)), 0);

  // ── cash + tax-treatment buckets ───────────────────────────────────────────
  const cash = round(sumBy((a) => a.class === 'depository'));
  const inv = (tt) => round(sumBy((a) => a.class === 'investment' && a.taxTreatment === tt));
  const taxable = inv('taxable');
  const traditional = inv('traditional');
  const roth = inv('roth');
  const education529 = inv('529');
  const hsaBalance = inv('hsa');

  // ── inferred contributions (from transactions) ─────────────────────────────
  // Taxable brokerage inflows → stocks.monthly_contribution.
  const stocksMonthly = round(sumBy(
    (a) => a.class === 'investment' && a.taxTreatment === 'taxable',
    (a) => a.estMonthlyContribution ?? 0,
  ));

  // ── earners (multi-owner) ──────────────────────────────────────────────────
  const earnerCtx = Array.isArray(owner.earners) && owner.earners.length ? owner.earners : [owner];
  const earners = earnerCtx.map((e, i) => {
    const earner = { name: e.name || (i === 0 ? 'Primary' : `Earner ${i + 1}`) };
    if (numOrNeed(e.age, i === 0 ? 'age' : `age_earner_${i}`, needsInput) != null) earner.age = round(e.age);
    if (numOrNeed(e.retirementAge, i === 0 ? 'retirement_age' : `retirement_age_earner_${i}`, needsInput) != null) earner.retirement_age = round(e.retirementAge);
    if (numOrNeed(e.annualSalary, i === 0 ? 'annual_salary' : `annual_salary_earner_${i}`, needsInput) != null) earner.annual_salary = round(e.annualSalary);
    return earner;
  });

  // Per-earner retirement contributions inferred from that earner's accounts.
  for (const a of accounts.filter((x) => x.class === 'investment' && (x.taxTreatment === 'traditional' || x.taxTreatment === 'roth'))) {
    const monthly = money(a.estMonthlyContribution);
    if (!monthly) continue;
    const idx = Math.min(a.ownerIndex ?? 0, earners.length - 1);
    const ra = (earners[idx].retirement_accounts ??= {});
    const annual = monthly * 12;
    if (/401k|403b|457b|tsp/.test(a.subtype || '')) {
      ra.k401 = { employee_annual: Math.min(round((ra.k401?.employee_annual ?? 0) + annual), LIMIT_401K) };
    } else {
      // Everything else pre-tax/Roth retirement (ira, roth, sep, simple) → IRA bucket.
      ra.ira = { type: a.taxTreatment === 'roth' ? 'roth' : 'traditional', annual: Math.min(round((ra.ira?.annual ?? 0) + annual), LIMIT_IRA) };
    }
  }

  // ── real estate ────────────────────────────────────────────────────────────
  // `property`-class accounts (e.g. MX PROPERTY) carry the home's MARKET VALUE;
  // pair them to mortgages so we use a real value instead of asking the user.
  const propertyPool = accounts
    .filter((a) => a.class === 'property')
    .map((a) => ({ name: a.name || '', value: money(a.balance) }));
  const takeProperty = (mortgageName) => {
    if (!propertyPool.length) return null;
    let i = propertyPool.findIndex((p) => sharesToken(p.name, mortgageName));
    if (i < 0) i = 0;
    return propertyPool.splice(i, 1)[0];
  };

  const real_estate = [];
  for (const a of accounts.filter((x) => x.class === 'loan' && /mortgage|home equity/.test(x.subtype || ''))) {
    const L = a.liability ?? {};
    const balance = money(a.balance);
    let value = money(L.assetValue);
    if (!value) { const p = takeProperty(a.name); if (p && p.value > 0) value = p.value; }
    if (!value) needsInput.push(`home_value:${a.name || a.id}`);
    const current_value = round(value || balance / 0.8);
    if (current_value <= 0) { warnings.push(`Mortgage "${a.name || a.id}" has no balance or home value — skipped.`); continue; }
    const months = money(L.monthsRemaining);
    real_estate.push({
      name: a.name || 'Primary residence',
      current_value,
      annual_appreciation: 0.035,
      mortgage: {
        balance,
        rate: round4(L.rate),
        years_remaining: months ? Math.max(1, Math.round(months / 12)) : 30,
      },
    });
  }
  // Leftover property accounts with no mortgage → owned (paid-off) homes.
  for (const p of propertyPool) {
    const cv = round(p.value);
    if (cv > 0) real_estate.push({ name: p.name || 'Property', current_value: cv, annual_appreciation: 0.035 });
  }

  // ── non-mortgage debts ─────────────────────────────────────────────────────
  const debts = [];
  for (const a of accounts.filter((x) => (x.class === 'loan' && !/mortgage|home equity/.test(x.subtype || '')) || x.class === 'credit')) {
    const L = a.liability ?? {};
    debts.push({
      name: a.name || labelFor(a),
      balance: round(a.balance),
      rate: round4(L.rate ?? 0),
      min_payment: round(L.minPayment ?? 0),
      ...(L.assetName ? { asset_name: L.assetName, asset_value: round(L.assetValue ?? 0) } : {}),
    });
  }

  // ── speculative (crypto) ───────────────────────────────────────────────────
  const cryptoValue = accounts
    .filter((a) => a.class === 'investment')
    .flatMap((a) => a.holdings ?? [])
    .filter((h) => h.assetType === 'crypto')
    .reduce((n, h) => n + money(h.value), 0);
  const speculative = cryptoValue > 0
    ? [{ name: 'Crypto holdings', current_value: round(cryptoValue), annual_growth_rate: 0.10 }]
    : [];

  const plan = {
    name: owner.name || `Imported plan (${cfp?.source ?? 'unknown'})`,
    earners,
    stocks: { current_value: taxable, monthly_contribution: stocksMonthly, annual_return: 0.07 },
    cash: { current_value: cash, monthly_contribution: 0, annual_return: 0.04 },
    account_balances: { taxable, traditional, roth },
    ...(real_estate.length ? { real_estate } : {}),
    ...(debts.length ? { debts } : {}),
    ...(speculative.length ? { speculative } : {}),
    ...(education529 > 0 ? { education_account: { enabled: true, initial_balance: education529, monthly_contribution: 0 } } : {}),
    tax_settings: { state: owner.filingState || defaultState },
  };
  if (numOrNeed(owner.desiredAnnualSpend, 'desired_annual_spend', needsInput) != null) {
    plan.desired_annual_spend = round(owner.desiredAnnualSpend);
  }

  // ── HSA as a real asset via the hsa_retirement feature block ───────────────
  // Its projected invested balance folds into net worth + FIRE + backtesting.
  // Requires currentAge < retirementAge; falls back to a warning if unknown.
  if (hsaBalance > 0) {
    const p0 = earnerCtx[0] ?? {};
    if (Number.isFinite(p0.age) && Number.isFinite(p0.retirementAge) && p0.retirementAge > p0.age) {
      plan.hsa_retirement = {
        currentAge: round(p0.age),
        retirementAge: round(p0.retirementAge),
        currentHsaBalance: round(hsaBalance),
        coverageType: 'family',
      };
    } else {
      warnings.push(`HSA balance $${hsaBalance.toLocaleString()} not placed — hsa_retirement needs age + retirement age (see needsInput).`);
    }
  }

  return { plan, warnings, needsInput: [...new Set(needsInput)] };
}

function numOrNeed(v, key, needsInput) {
  if (Number.isFinite(v)) return v;
  needsInput.push(key);
  return null;
}

function labelFor(a) {
  const s = a.subtype || '';
  if (/student/.test(s)) return 'Student loan';
  if (/auto/.test(s)) return 'Auto loan';
  if (a.class === 'credit') return 'Credit card';
  return 'Loan';
}

/** Loose name match: do two names share a meaningful token (>3 chars)? */
function sharesToken(a, b) {
  const toks = (s) => new Set(String(s).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const ta = toks(a); const tb = toks(b);
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}
