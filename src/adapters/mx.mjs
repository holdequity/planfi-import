// mx.mjs — MX Platform → Canonical Financial Profile.
//
// Consumes MX API entities (already fetched by the caller):
//   /users/{u}/accounts      → accounts[]
//   /users/{u}/holdings      → holdings[]
//   /users/{u}/transactions  → transactions[]  (optional; drives contributions)
// MX encodes the account family in `type` (CHECKING, INVESTMENT, MORTGAGE,
// PROPERTY, …) and refines investment tax treatment in `subtype`. We translate
// MX's vocabulary into the generic (type, subtype) that classify() understands,
// then reuse the same classifier + the same shared to-planfi mapper.
//
// MX advantage over Plaid: a PROPERTY account carries the home's MARKET VALUE,
// so mortgages can be paired to a real value instead of asking the user.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify, classifyAsset } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';

// MX top-level `type` → generic { type, subtype? } that classify() consumes.
const MX_TYPE = {
  CHECKING: ['depository', 'checking'],
  SAVINGS: ['depository', 'savings'],
  MONEY_MARKET: ['depository', 'money market'],
  CD: ['depository', 'cd'],
  CASH: ['depository', 'cash'],
  PREPAID: ['depository', 'cash'],
  INVESTMENT: ['investment', undefined],
  LOAN: ['loan', undefined],
  MORTGAGE: ['loan', 'mortgage'],
  CREDIT_CARD: ['credit', 'credit card'],
  LINE_OF_CREDIT: ['credit', 'line of credit'],
  PROPERTY: ['property', undefined],
};

/** @implements {SourceAdapter} */
export const mxAdapter = {
  source: 'mx',
  /**
   * @param {object} raw - { accounts, holdings, transactions, owner, asOf }
   * @returns {CFP}
   */
  normalize(raw = {}) {
    const warnings = [];
    const unmapped = [];
    const accountsIn = arr(raw.accounts);
    const holdingsByAccount = groupBy(arr(raw.holdings), (h) => h.account_guid);

    // Contributions: MX CREDITs into investment accounts are inflows. Normalize
    // to the shape contributions.mjs expects and reuse the same inference.
    const invGuids = new Set(accountsIn.filter((a) => up(a.type) === 'INVESTMENT').map((a) => a.guid));
    const normTxns = arr(raw.transactions)
      .filter((t) => invGuids.has(t.account_guid) && up(t.type) === 'CREDIT')
      .map((t) => ({ account_id: t.account_guid, subtype: 'contribution', amount: -Math.abs(num(t.amount)), date: t.date || t.transacted_at }));
    const contribByAccount = contributionsByAccount(normTxns);

    const accounts = accountsIn.map((a) => {
      const [genType, genSub] = MX_TYPE[up(a.type)] ?? ['investment', undefined];
      // MX investment subtype (401K, ROTH_IRA, HSA, 529…) → words classify() knows.
      const subtype = genSub ?? mxSubtype(a.subtype) ?? inferLoanSubtype(a.name);
      const { accountClass, taxTreatment, confidence } = classify(genType === 'property' ? 'investment' : genType, subtype);
      const cls = genType === 'property' ? 'property' : accountClass;
      if (confidence === 'low' && cls !== 'property') {
        warnings.push(`MX account "${a.name ?? a.guid}" (${a.type}/${a.subtype ?? ''}) classification guessed → ${cls}/${taxTreatment}.`);
      }

      const acct = {
        id: a.guid,
        institution: a.institution_code,
        name: a.name,
        class: cls,
        subtype: String(subtype ?? '').toLowerCase(),
        taxTreatment: cls === 'property' ? 'na' : taxTreatment,
        balance: num(a.balance) || num(a.market_value) || num(a.available_balance) || 0,
        currency: a.currency_code ?? 'USD',
        ownerIndex: Number.isInteger(a.owner_index) ? a.owner_index : 0,
        ...(contribByAccount[a.guid] ? { estMonthlyContribution: contribByAccount[a.guid] } : {}),
      };

      if (cls === 'investment') {
        const hs = holdingsByAccount.get(a.guid) ?? [];
        acct.holdings = hs.map((h) => {
          if (h.cost_basis == null) warnings.push(`Holding ${h.symbol ?? h.description ?? h.guid} has no cost basis (MX did not report it).`);
          return {
            ticker: h.symbol ?? undefined,
            name: h.description ?? undefined,
            quantity: num(h.shares),
            value: num(h.market_value),
            costBasis: h.cost_basis == null ? undefined : num(h.cost_basis),
            assetType: classifyAsset(h.holding_type),
          };
        });
      }
      if (cls === 'loan' || cls === 'credit') {
        acct.liability = {
          rate: pct(a.interest_rate ?? a.apr),
          minPayment: num(a.minimum_payment) || undefined,
          originationPrincipal: num(a.original_balance) || undefined,
          monthsRemaining: monthsBetween(raw.asOf, a.maturity_date),
          ...(subtype === 'mortgage' ? { assetName: a.name || 'Home' } : {}),
        };
      }
      return acct;
    });

    return {
      source: 'mx',
      asOf: raw.asOf || new Date(0).toISOString(),
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const up = (x) => String(x ?? '').trim().toUpperCase();
const pct = (x) => (Number.isFinite(Number(x)) ? Number(x) / 100 : undefined);
/** MX investment subtype enum → classify()-friendly words. */
function mxSubtype(sub) {
  if (!sub) return undefined;
  return String(sub).toLowerCase().replace(/_/g, ' ');
}
function inferLoanSubtype(name) {
  const n = String(name ?? '').toLowerCase();
  if (/student/.test(n)) return 'student';
  if (/auto|car|vehicle/.test(n)) return 'auto';
  if (/mortgage|home/.test(n)) return 'mortgage';
  return undefined;
}
function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); }
  return m;
}
function monthsBetween(fromIso, toIso) {
  if (!toIso) return undefined;
  const t = Date.parse(toIso); if (!Number.isFinite(t)) return undefined;
  const f = Date.parse(fromIso || ''); const base = Number.isFinite(f) ? f : Date.parse('2026-01-01');
  return Math.max(1, Math.round((t - base) / (1000 * 60 * 60 * 24 * 30.44)));
}
