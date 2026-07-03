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
import { arr, num, pct, groupBy, monthsBetween, defaultAsOf, warning } from '../util.mjs';

// MX credit-transaction categories/descriptions that are savings INFLOWS
// (counted) vs investment GROWTH (excluded — already modeled by annual_return).
const MX_INFLOW = /transfer|deposit|contribution|payroll|direct dep/i;
const MX_GROWTH = /dividend|interest|capital gain|reinvest/i;

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

    // Contributions: MX CREDITs into investment accounts are candidate inflows.
    // Filter by category/description so growth (dividends/interest/reinvest)
    // isn't double-counted as savings; when a credit carries NO category or
    // description we count it but warn once that the inference is coarse.
    const invGuids = new Set(accountsIn.filter((a) => up(a.type) === 'INVESTMENT').map((a) => a.guid));
    let sawUnlabeledCredit = false;
    const normTxns = arr(raw.transactions)
      .filter((t) => {
        if (!invGuids.has(t.account_guid) || up(t.type) !== 'CREDIT') return false;
        const label = `${t.category ?? ''} ${t.description ?? ''} ${t.top_level_category ?? ''}`.trim();
        if (!label) { sawUnlabeledCredit = true; return true; } // no signal → coarse include
        if (MX_GROWTH.test(label)) return false;                // dividends/interest = growth
        return MX_INFLOW.test(label);                           // labeled but neither → exclude
      })
      .map((t) => ({ account_id: t.account_guid, subtype: 'contribution', amount: -Math.abs(num(t.amount)), date: t.date || t.transacted_at }));
    if (sawUnlabeledCredit) {
      warnings.push(warning('COARSE_INFERENCE', 'warn',
        'MX contribution inference is coarse: some investment-account credits carry no category/description, so ALL such unlabeled credits were counted as contributions (may include dividends or rollovers). Verify inferred contribution rates.'));
    }
    const contribByAccount = contributionsByAccount(normTxns);

    const accounts = accountsIn.map((a) => {
      const [genType, genSub] = MX_TYPE[up(a.type)] ?? ['investment', undefined];
      // MX investment subtype (401K, ROTH_IRA, HSA, 529…) → words classify() knows.
      const subtype = genSub ?? mxSubtype(a.subtype) ?? inferLoanSubtype(a.name);
      const { accountClass, taxTreatment, confidence } = classify(genType === 'property' ? 'investment' : genType, subtype);
      const cls = genType === 'property' ? 'property' : accountClass;
      if (confidence === 'low' && cls !== 'property') {
        warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
          `MX account "${a.name ?? a.guid}" (${a.type}/${a.subtype ?? ''}) classification guessed → ${cls}/${taxTreatment}.`, a.guid));
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
          if (h.cost_basis == null) {
            warnings.push(warning('NO_COST_BASIS', 'info',
              `Holding ${h.symbol ?? h.description ?? h.guid} has no cost basis (MX did not report it).`, a.guid));
          }
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
      // Default snapshot time is NOW (not the 1970 epoch — see util.mjs).
      asOf: raw.asOf || defaultAsOf(),
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
// (arr/num/pct/groupBy/monthsBetween live in ../util.mjs, shared with plaid.mjs.)
const up = (x) => String(x ?? '').trim().toUpperCase();
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
