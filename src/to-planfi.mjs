// to-planfi.mjs — the ONE shared mapper: Canonical Financial Profile →
// generate_financial_plan wire object. Every provider adapter funnels through
// here, so all Planfi domain logic lives once.
//
// Wire-contract ground truth (workers/ai-mcp/src/lib/mapper.ts, PlanRequest):
//   - `stocks.current_value` is the TOTAL investable portfolio; the optional
//     `account_balances` {taxable, traditional, roth} is its DECOMPOSITION for
//     tax-aware decumulation — the engine core never adds account_balances to
//     net worth on top of stocks (see src/lib/round-trip-harness.test.ts).
//   - `education_account` passes through as the ENGINE shape — camelCase keys
//     inside ({ enabled, initialBalance, monthlyContribution }).
//   - There is NO `hsa_retirement` wire field, and no `account_balances.hsa`
//     bucket. The only HSA wire surface is the per-earner CONTRIBUTION block
//     earners[n].retirement_accounts.hsa = { coverage, annual }. An HSA
//     BALANCE is therefore folded into the aggregate stocks total (warned).
//
// @typedef {import('./canonical').CanonicalFinancialProfile} CFP
// @typedef {import('./canonical').ImportWarning} ImportWarning
// @typedef {import('./canonical').NeedsInput} NeedsInput

import { warning } from './util.mjs';

const round = (n) => Math.round(money(n));
const round4 = (n) => Math.round(money(n) * 10000) / 10000;
/** Coerce any value to a finite, non-negative number (clamps junk/NaN/∞/neg → 0). */
function money(x) {
  const n = typeof x === 'string' ? Number(x.replace(/[$,%\s]/g, '')) : Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// IRS contribution limits — 2026 tax year, copied from the engine's
// src/lib/tax-limits.ts (TAX_ADVANTAGED_LIMITS_2026; 401(k) per IRS Notice
// 2025-67, IRA $7,500 base, HSA per Rev. Proc. 2025-19). Copied (not imported)
// so this package stays zero-dependency. NOTE: age-based catch-up contributions
// (401k +$8,000 at 50-59/64+, IRA +$1,100 at 50+, HSA +$1,000 at 55+) are NOT
// modeled — inferred contributions above the base limit are clamped and warned.
const LIMIT_401K = 24500;
const LIMIT_IRA = 7500;
const LIMIT_HSA_FAMILY = 8750;

/**
 * @param {CFP} cfp
 * @param {object} [opts]
 * @param {string} [opts.defaultState='CA']
 * @returns {{ plan: object, warnings: ImportWarning[], needsInput: NeedsInput[] }}
 */
export function toPlanfiPlan(cfp, opts = {}) {
  const { defaultState = 'CA' } = opts;
  const warnings = [...(cfp?.meta?.warnings ?? [])];
  /** @type {NeedsInput[]} */
  const needs = [];
  const need = (field, entry) => needs.push({ field, ...entry });
  const accounts = Array.isArray(cfp?.accounts) ? cfp.accounts : [];
  const owner = cfp?.owner ?? {};

  const sumBy = (pred, val = (a) => a.balance) =>
    accounts.filter(pred).reduce((n, a) => n + money(val(a)), 0);

  // Negative balances (margin debit, overdraft) are clamped to $0 by money() —
  // surface that instead of silently improving the picture.
  for (const a of accounts) {
    const raw = Number(a?.balance);
    if (Number.isFinite(raw) && raw < 0) {
      warnings.push(warning('NEGATIVE_BALANCE_CLAMPED', 'warn',
        `Account "${a.name || a.id}" has a negative balance (${raw}) — clamped to $0 (negative asset balances are not modeled).`, a.id));
    }
  }

  // ── cash + tax-treatment buckets ───────────────────────────────────────────
  const cash = round(sumBy((a) => a.class === 'depository'));
  const inv = (tt) => round(sumBy((a) => a.class === 'investment' && a.taxTreatment === tt));
  const taxable = inv('taxable');
  const traditional = inv('traditional');
  const roth = inv('roth');
  const education529 = inv('529');
  const hsaBalance = inv('hsa');

  // stocks = the TOTAL investable portfolio (taxable + traditional + roth, plus
  // the HSA balance — see the header note); account_balances is the
  // taxable/traditional/roth decomposition of it.
  const stocksTotal = taxable + traditional + roth + hsaBalance;
  if (hsaBalance > 0) {
    warnings.push(warning('HSA_FOLDED_INTO_PORTFOLIO', 'info',
      `HSA balance $${hsaBalance.toLocaleString()} is modeled inside the aggregate portfolio (stocks.current_value) — the wire schema has no dedicated HSA balance field. The engine's dedicated hsaRetirement block is NetWorthInput-only (documented next hop, alongside individualHoldings).`));
  }

  // ── inferred contributions (from transactions) ─────────────────────────────
  // Taxable brokerage inflows → stocks.monthly_contribution.
  const stocksMonthly = round(sumBy(
    (a) => a.class === 'investment' && a.taxTreatment === 'taxable',
    (a) => a.estMonthlyContribution ?? 0,
  ));

  // ── earners (multi-owner) ──────────────────────────────────────────────────
  // Demographics/goals are things NO aggregator knows (they report balances,
  // not birthdays or retirement plans) — missing ones become structured asks.
  // Non-object members in a caller-supplied earners array (null, junk) are
  // treated as empty contexts, not crashes (caught by the contract harness).
  const earnerCtx = (Array.isArray(owner.earners) && owner.earners.length ? owner.earners : [owner])
    .map((e) => (e && typeof e === 'object' ? e : {}));
  const earners = earnerCtx.map((e, i) => {
    const name = e.name || (i === 0 ? 'Primary' : `Earner ${i + 1}`);
    const who = earnerCtx.length > 1 ? ` (${name})` : '';
    const demo = (field, value, label, why) => {
      if (Number.isFinite(value)) return true;
      need(field, { earnerIndex: i, label: `${label}${who}`, why });
      return false;
    };
    const earner = { name };
    if (demo('age', e.age, 'Current age',
      'Aggregators report balances, not birthdays — the projection needs a starting age.')) earner.age = round(e.age);
    if (demo('retirement_age', e.retirementAge, 'Target retirement age',
      'Retirement age is a goal, not an account attribute — no data provider can know it.')) earner.retirement_age = round(e.retirementAge);
    if (demo('annual_salary', e.annualSalary, 'Annual salary',
      'Salary only flows through payroll-linked products (e.g. Plaid Income) — otherwise collect it.')) earner.annual_salary = round(e.annualSalary);
    return earner;
  });

  // Sanity guard on the taxable inference: inferred inflows include transfers
  // (rollovers/account moves look identical to contributions in transaction
  // feeds), so an implausibly high figure vs known salary gets flagged.
  const knownSalary = earners.reduce((n, e) => n + (Number.isFinite(e.annual_salary) ? e.annual_salary : 0), 0);
  if (knownSalary > 0 && stocksMonthly * 12 > knownSalary * 0.5) {
    warnings.push(warning('CONTRIBUTION_IMPLAUSIBLE', 'warn',
      `Inferred taxable contributions ($${(stocksMonthly * 12).toLocaleString()}/yr) exceed 50% of known household salary ($${knownSalary.toLocaleString()}) — transaction-inflow inference may be counting rollovers/transfers as savings. Verify stocks.monthly_contribution.`));
  }

  // Per-earner retirement contributions inferred from that earner's accounts.
  // Cap clips are WARNED (a silent clamp is silent wrongness). IRA traditional
  // and Roth are accumulated separately and resolved to one wire `ira` block
  // per earner below (the wire supports type 'traditional' | 'roth' | 'both').
  const iraByEarner = earners.map(() => ({ traditional: 0, roth: 0 }));
  const capWarn = (label, annual, limit) => {
    if (annual <= limit) return round(annual);
    warnings.push(warning('CONTRIBUTION_CLAMPED', 'warn',
      `Inferred ${label} contribution $${round(annual).toLocaleString()}/yr exceeds the 2026 IRS limit $${limit.toLocaleString()} — clamped to the limit (rollovers/transfers may be inflating the inference; catch-up contributions are not modeled).`));
    return limit;
  };
  for (const a of accounts.filter((x) => x.class === 'investment'
    && (x.taxTreatment === 'traditional' || x.taxTreatment === 'roth' || x.taxTreatment === 'hsa'))) {
    const monthly = money(a.estMonthlyContribution);
    if (!monthly) continue;
    const idx = Math.min(a.ownerIndex ?? 0, earners.length - 1);
    const annual = monthly * 12;
    if (a.taxTreatment === 'hsa') {
      // Inferred HSA contribution → the owning earner's retirement_accounts.hsa
      // block (the wire's only HSA surface). Coverage is unknowable from
      // aggregator data; 'family' is assumed.
      const ra = (earners[idx].retirement_accounts ??= {});
      const prior = ra.hsa?.annual ?? 0;
      ra.hsa = { coverage: 'family', annual: capWarn('HSA', prior + annual, LIMIT_HSA_FAMILY) };
      warnings.push(warning('HSA_COVERAGE_ASSUMED', 'info',
        `HSA contribution inferred at $${round(annual).toLocaleString()}/yr — coverage type assumed 'family' (aggregators don't report it).`, a.id));
    } else if (/401k|403b|457b|tsp/.test(a.subtype || '')) {
      const ra = (earners[idx].retirement_accounts ??= {});
      ra.k401 = { employee_annual: capWarn('401(k)', (ra.k401?.employee_annual ?? 0) + annual, LIMIT_401K) };
    } else {
      // Everything else pre-tax/Roth retirement (ira, roth, sep, simple) → IRA bucket.
      iraByEarner[idx][a.taxTreatment === 'roth' ? 'roth' : 'traditional'] += annual;
    }
  }
  iraByEarner.forEach((ira, idx) => {
    const total = ira.traditional + ira.roth;
    if (total <= 0) return;
    const ra = (earners[idx].retirement_accounts ??= {});
    let type;
    if (ira.traditional > 0 && ira.roth > 0) {
      // The wire carries ONE ira block per earner; type 'both' models a 50/50
      // split in the engine. Surface the real inferred split so a lopsided one
      // isn't silently reshaped.
      type = 'both';
      warnings.push(warning('IRA_SPLIT_ASSUMED', 'info',
        `Earner ${idx + 1} has both traditional ($${round(ira.traditional).toLocaleString()}/yr) and Roth ($${round(ira.roth).toLocaleString()}/yr) IRA contributions — emitted as one ira block with type 'both', which the engine models as a 50/50 split of the total.`));
    } else {
      type = ira.roth > 0 ? 'roth' : 'traditional';
    }
    ra.ira = { type, annual: capWarn('IRA', total, LIMIT_IRA) };
  });

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
    if (!value) {
      // No real value available → ESTIMATE at 80% LTV from the mortgage balance
      // (product decision: ask the user now, AVM integration later). The
      // estimate is warned and the ask is retained in needsInput — the wire
      // real_estate entry has no provenance flag, so warning + needsInput IS
      // the provenance mechanism.
      need('home_value', {
        accountId: a.id,
        ...(a.name ? { accountName: a.name } : {}),
        label: `Home value for ${a.name || a.id}`,
        why: 'The provider reported the mortgage but not the property’s market value — currently estimated at 80% LTV.',
      });
      if (balance > 0) {
        warnings.push(warning('HOME_VALUE_ESTIMATED', 'warn',
          `Home value for "${a.name || a.id}" ESTIMATED at 80% LTV from the mortgage balance ($${round(balance / 0.8).toLocaleString()}) — no market value in the source data; replace via needsInput home_value.`, a.id));
      }
    }
    const current_value = round(value || balance / 0.8);
    if (current_value <= 0) {
      warnings.push(warning('MORTGAGE_SKIPPED', 'warn', `Mortgage "${a.name || a.id}" has no balance or home value — skipped.`, a.id));
      continue;
    }
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
    if (L.rate == null || !Number.isFinite(Number(L.rate))) {
      // The wire schema requires a numeric rate, so 0 goes in the body — but a
      // 0% debt is a silently-optimistic model, so the caller is told.
      need('debt_rate', {
        accountId: a.id,
        ...(a.name ? { accountName: a.name } : {}),
        label: `Interest rate (APR) for ${a.name || a.id}`,
        why: 'The provider reported the balance but no APR — the debt is modeled at 0% (optimistic) until provided.',
      });
      warnings.push(warning('DEBT_RATE_MISSING', 'warn',
        `Debt "${a.name || a.id}" has no APR in the source data — modeled at 0% until provided (see needsInput debt_rate).`, a.id));
    }
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

  // 529 → education_account. This block passes through the wire as the ENGINE
  // shape (NetWorthInput['educationAccount']) — keys are camelCase INSIDE.
  const eduMonthly = round(sumBy(
    (a) => a.class === 'investment' && a.taxTreatment === '529',
    (a) => a.estMonthlyContribution ?? 0,
  ));

  const plan = {
    name: owner.name || `Imported plan (${cfp?.source ?? 'unknown'})`,
    earners,
    stocks: { current_value: stocksTotal, monthly_contribution: stocksMonthly, annual_return: 0.07 },
    cash: { current_value: cash, monthly_contribution: 0, annual_return: 0.04 },
    account_balances: { taxable, traditional, roth },
    ...(real_estate.length ? { real_estate } : {}),
    ...(debts.length ? { debts } : {}),
    ...(speculative.length ? { speculative } : {}),
    ...(education529 > 0 ? { education_account: { enabled: true, initialBalance: education529, monthlyContribution: eduMonthly } } : {}),
    tax_settings: { state: owner.filingState || defaultState },
  };
  if (Number.isFinite(owner.desiredAnnualSpend)) {
    plan.desired_annual_spend = round(owner.desiredAnnualSpend);
  } else {
    need('desired_annual_spend', {
      label: 'Desired annual spending in retirement',
      why: 'Target retirement spending is a goal the engine sizes the plan around — no account data implies it.',
    });
  }

  // De-dup on (field, accountId, earnerIndex), preserving first-emission order.
  // The emission order above is deterministic: earner demographics (in earner
  // order), then home_value asks (account order), then debt_rate asks (account
  // order), then plan-level goals.
  const seen = new Set();
  const needsInput = needs.filter((n) => {
    const k = `${n.field}|${n.accountId ?? ''}|${n.earnerIndex ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { plan, warnings, needsInput };
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
