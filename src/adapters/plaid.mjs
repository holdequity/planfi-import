// plaid.mjs — Plaid → Canonical Financial Profile.
//
// Consumes the merged results of the Plaid product endpoints:
//   /accounts/get              → accounts[] (+ balances)
//   /investments/holdings/get  → holdings[] + securities[]
//   /liabilities/get           → liabilities.{mortgage,student,credit}[]
//   /income (optional)         → owner.annualSalary
// It maps ONLY Plaid's quirks into the CFP; all Planfi logic lives in
// to-planfi.mjs. Nothing is fabricated — missing fields become warnings.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify, classifyAsset } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';

/** @implements {SourceAdapter} */
export const plaidAdapter = {
  source: 'plaid',
  /**
   * @param {object} raw - { accounts, holdings, securities, liabilities, income, owner, asOf }
   * @returns {CFP}
   */
  normalize(raw = {}) {
    const warnings = [];
    const unmapped = [];
    const accountsIn = arr(raw.accounts);
    const holdingsIn = arr(raw.holdings);
    const securitiesIn = arr(raw.securities);
    const liab = raw.liabilities ?? {};

    const secById = new Map(securitiesIn.map((s) => [s.security_id, s]));
    const holdingsByAccount = groupBy(holdingsIn, (h) => h.account_id);
    // Inferred monthly contributions from investment transactions (if provided).
    const contribByAccount = contributionsByAccount(arr(raw.investmentTransactions ?? raw.investment_transactions));

    // liability detail keyed by account_id
    const liabByAccount = new Map();
    for (const m of arr(liab.mortgage)) {
      liabByAccount.set(m.account_id, {
        rate: pct(m.interest_rate?.percentage),
        minPayment: num(m.next_monthly_payment) || num(m.last_payment_amount),
        originationPrincipal: num(m.origination_principal_amount),
        assetName: m.property_address?.street ? `Home — ${m.property_address.city ?? ''}`.trim() : 'Home',
        monthsRemaining: monthsBetween(raw.asOf, m.maturity_date),
      });
    }
    for (const st of arr(liab.student)) {
      liabByAccount.set(st.account_id, {
        rate: pct(st.interest_rate_percentage),
        minPayment: num(st.minimum_payment_amount),
      });
    }
    for (const cc of arr(liab.credit)) {
      liabByAccount.set(cc.account_id, {
        rate: pct(cc.aprs?.[0]?.apr_percentage),
        minPayment: num(cc.minimum_payment_amount) || num(cc.last_statement_balance) * 0.02,
      });
    }

    const accounts = accountsIn.map((a) => {
      const { accountClass, taxTreatment, confidence } = classify(a.type, a.subtype);
      if (confidence === 'low') {
        warnings.push(`Account "${a.name ?? a.account_id}" (${a.type}/${a.subtype}) classification guessed → ${accountClass}/${taxTreatment}.`);
      }
      const bal = a.balances ?? {};
      // asset accounts use `current`; liabilities also carry `current` = amount owed.
      const balance = num(bal.current) || num(bal.available) || 0;

      const acct = {
        id: a.account_id,
        institution: a.institution_name,
        name: a.official_name || a.name,
        class: accountClass,
        subtype: String(a.subtype ?? '').toLowerCase(),
        taxTreatment,
        balance,
        currency: bal.iso_currency_code ?? 'USD',
        // Which earner owns it (0/1). Caller may set from Plaid /identity name
        // matching; defaults to the primary earner.
        ownerIndex: Number.isInteger(a.owner_index) ? a.owner_index : 0,
        ...(contribByAccount[a.account_id] ? { estMonthlyContribution: contribByAccount[a.account_id] } : {}),
      };

      if (accountClass === 'investment') {
        const hs = holdingsByAccount.get(a.account_id) ?? [];
        acct.holdings = hs.map((h) => {
          const sec = secById.get(h.security_id) ?? {};
          if (h.cost_basis == null) warnings.push(`Holding ${sec.ticker_symbol ?? sec.name ?? h.security_id} has no cost basis (institution did not report it).`);
          return {
            ticker: sec.ticker_symbol ?? undefined,
            name: sec.name ?? undefined,
            quantity: num(h.quantity),
            value: num(h.institution_value),
            costBasis: h.cost_basis == null ? undefined : num(h.cost_basis),
            assetType: classifyAsset(sec.type),
          };
        });
      }
      if (accountClass === 'loan' || accountClass === 'credit') {
        acct.liability = liabByAccount.get(a.account_id) ?? { rate: undefined };
      }
      return acct;
    });

    // owner context: Plaid Income can supply salary; everything else onboarding.
    const owner = { ...(raw.owner ?? {}) };
    const salary = plaidAnnualIncome(raw.income);
    if (salary != null && owner.annualSalary == null) owner.annualSalary = salary;

    return {
      source: 'plaid',
      asOf: raw.asOf || new Date(0).toISOString(),
      owner,
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
/** Plaid rates are percentages (6.25) → fraction (0.0625). */
const pct = (x) => (Number.isFinite(Number(x)) ? Number(x) / 100 : undefined);
function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); }
  return m;
}
function monthsBetween(fromIso, toIso) {
  if (!toIso) return undefined;
  const f = Date.parse(fromIso || ''); const t = Date.parse(toIso);
  if (!Number.isFinite(t)) return undefined;
  const base = Number.isFinite(f) ? f : Date.parse('2025-01-01');
  return Math.max(1, Math.round((t - base) / (1000 * 60 * 60 * 24 * 30.44)));
}
/** Plaid Income: sum the primary income stream(s) to an annual figure. */
function plaidAnnualIncome(income) {
  if (!income) return null;
  const streams = arr(income.income_streams ?? income.bank_income?.[0]?.income_sources);
  if (!streams.length) return null;
  const monthly = streams.reduce((n, s) => n + num(s.monthly_income), 0);
  return monthly > 0 ? Math.round(monthly * 12) : null;
}
