// fdx.mjs — FDX (Financial Data Exchange) → Canonical Financial Profile.
//
// FDX is the US open-banking standard (the CFPB §1033 personal-financial-data
// rule names it; Akoya speaks it natively; most large US institutions publish
// FDX-conformant APIs). Consumes FDX API entities (already fetched by the
// caller, same contract style as the Plaid/MX/Finicity adapters):
//   GET /accounts        → accounts[]  — FDX Account entities. The FDX wire
//       wraps each account in its shape key ({ depositAccount: {…} },
//       { investmentAccount: {…} }, { loanAccount: {…} }, { locAccount: {…} },
//       { lineOfCredit: {…} }, { annuityAccount: {…} }); this adapter accepts
//       both the wrapped form and already-flattened entities. The wrapper key
//       itself is a class signal, used as the fallback when `accountType` is
//       a value we don't recognize.
//   GET /accounts/{id}   → investment `holdings[]`; the caller flattens
//       holdings from all investment accounts into one `holdings[]` array,
//       each tagged with its `accountId` (inline `investmentAccount.holdings`
//       are read too).
//   GET /accounts/{id}/transactions → transactions[]  (optional; drives
//       contribution inference — wrapped { investmentTransaction: {…} } or
//       flat, each tagged with `accountId`).
//
// FDX ↔ CFP field correspondence (the vocabulary this adapter translates):
//   accountId                        → CanonicalAccount.id
//   nickname / productName           → CanonicalAccount.name
//   accountType (enum)               → class + subtype via FDX_TYPE below
//   currency.currencyCode            → CanonicalAccount.currency
//   depositAccount.currentBalance    → balance (asset)
//   investmentAccount.currentValue   → balance (asset)
//   loanAccount.principalBalance     → balance (outstanding principal)
//   locAccount.currentBalance        → balance (amount owed)
//   loan/loc interestRate            → liability.rate (percentage → fraction)
//   nextPaymentAmount /
//     minimumPaymentAmount           → liability.minPayment
//   originalPrincipal                → liability.originationPrincipal
//   maturityDate                     → liability.monthsRemaining (vs asOf)
//   InvestmentHolding.symbol         → holding.ticker
//   InvestmentHolding.securityName   → holding.name
//   InvestmentHolding.units          → holding.quantity
//   InvestmentHolding.marketValue    → holding.value
//   InvestmentHolding.costBasis      → holding.costBasis (never fabricated)
//   InvestmentHolding.holdingType    → holding.assetType via FDX_HOLDING_TYPE
//
// Assumptions verified against the FDX data-structure conventions (noted
// because sign conventions bite):
//   - LIABILITY BALANCES ARE POSITIVE amounts owed: `principalBalance` on a
//     LoanAccount is the outstanding principal, `currentBalance` on a
//     LocAccount/credit card is the amount owed. The adapter takes |balance|
//     for loan/credit classes so an institution sign quirk can't zero out a
//     debt downstream (the shared mapper clamps negative *asset* balances to
//     $0 — correct for assets, wrong for debts).
//   - DATES/TIMESTAMPS ARE ISO 8601 strings (FDX Timestamp/DateString) — no
//     epoch conversion needed (contrast: Finicity sends epoch seconds).
//   - TRANSACTION AMOUNTS: FDX carries `debitCreditMemo` ('DEBIT'|'CREDIT')
//     next to `amount`. A CREDIT (or, absent the memo, a positive amount) into
//     an investment account is a candidate contribution; DEBITs never are.
//   - A depositAccount's `interestRate` is a savings YIELD, not a debt APR —
//     it is deliberately NOT mapped to liability.rate.
//   - FDX has NO property/real-estate account entity, so mortgages can't be
//     paired with a market value; the shared mapper estimates at 80% LTV and
//     asks for the real value via needsInput (same as Plaid/Finicity).
//
// Only FDX's vocabulary is translated here; ALL Planfi domain logic stays in
// to-planfi.mjs, shared with every other adapter.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify, classifyAsset } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';
import { arr, objs, num, pct, groupBy, monthsBetween, defaultAsOf, warning } from '../util.mjs';

// FDX credit labels that are savings INFLOWS (counted) vs investment GROWTH
// (excluded — already modeled by annual_return). Same split as the siblings.
const FDX_INFLOW = /transfer|deposit|contribution|payroll|direct dep|\bdep\b|xfer/i;
const FDX_GROWTH = /dividend|interest|capital gain|reinvest|\bdiv\b|\bint\b/i;

// FDX `accountType` enum → generic [type, subtype?] that classify() consumes.
// Keys are UPPERCASE (the FDX convention: CHECKING, 401K, MORTGAGE, …).
const FDX_TYPE = {
  // depository
  CHECKING: ['depository', 'checking'],
  SAVINGS: ['depository', 'savings'],
  CD: ['depository', 'cd'],
  MONEYMARKET: ['depository', 'money market'],
  // investment — taxable wrappers
  BROKERAGE: ['investment', 'brokerage'],
  // investment — named retirement wrappers (classify() knows these words)
  IRA: ['investment', 'ira'],
  ROTH: ['investment', 'roth ira'],
  ROTH401K: ['investment', 'roth 401k'],
  '401K': ['investment', '401k'],
  '403B': ['investment', '403b'],
  457: ['investment', '457b'],
  KEOGH: ['investment', 'keogh'],
  SEPIRA: ['investment', 'sep ira'],
  SIMPLEIRA: ['investment', 'simple ira'],
  // Tax-Deferred Annuity: pre-tax wrapper of unknown flavor → 'tax-deferred'
  // hints traditional at LOW confidence in classify() (surfaces as a guess).
  TDA: ['investment', 'tax-deferred'],
  ANNUITY: ['investment', 'tax-deferred'],
  // education + health
  529: ['investment', '529'],
  HSA: ['investment', 'hsa'],
  // loans
  MORTGAGE: ['loan', 'mortgage'],
  HOMEEQUITYLOAN: ['loan', 'home equity'],
  LOAN: ['loan', undefined],
  AUTOLOAN: ['loan', 'auto'],
  STUDENTLOAN: ['loan', 'student'],
  PERSONALLOAN: ['loan', 'personal'],
  // revolving credit
  CREDITCARD: ['credit', 'credit card'],
  LINEOFCREDIT: ['credit', 'line of credit'],
};

// FDX account-shape wrapper key → fallback [type, subtype?] when accountType
// is missing/unrecognized (the shape itself still tells the account family).
const FDX_CONTAINER = {
  depositAccount: ['depository', undefined],
  investmentAccount: ['investment', undefined],
  annuityAccount: ['investment', 'tax-deferred'],
  loanAccount: ['loan', undefined],
  locAccount: ['credit', 'line of credit'],
  lineOfCredit: ['credit', 'line of credit'],
};

// FDX InvestmentHolding.holdingType → words classifyAsset() understands.
const FDX_HOLDING_TYPE = {
  STOCK: 'stock',
  ETF: 'etf',
  MUTUALFUND: 'mutual fund',
  BOND: 'bond',
  CD: 'cash equivalent',
  CASH: 'cash',
  MONEYMARKET: 'cash equivalent',
  DIGITALASSET: 'cryptocurrency',
  OPTION: 'derivative',
  ANNUITY: 'other',
  OTHER: 'other',
};

/** @implements {SourceAdapter} */
export const fdxAdapter = {
  source: 'fdx',
  /**
   * @param {object} raw - { accounts, holdings, transactions, owner, asOf }
   * @returns {CFP}
   */
  normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const warnings = [];
    const unmapped = [];

    // First pass: unwrap the FDX shape containers so classification and the
    // contribution pass see one flat entity per account.
    const entities = arr(raw.accounts).map((e, i) => unwrapAccount(e, i));
    const holdingsByAccount = groupBy(objs(raw.holdings), (h) => String(h.accountId));

    // Contributions: CREDITs into investment accounts are candidate inflows.
    // Filter by transactionType/category/description so growth (dividends/
    // interest/reinvest) isn't double-counted as savings; a credit with NO
    // usable label is counted but flagged once as coarse.
    const invIds = new Set(entities
      .filter(({ acct, container }) => (fdxType(acct.accountType) ?? FDX_CONTAINER[container] ?? ['investment'])[0] === 'investment')
      .map(({ id }) => id));
    let sawUnlabeledCredit = false;
    const normTxns = arr(raw.transactions)
      .map(unwrapTransaction)
      .filter((t) => {
        if (!invIds.has(String(t.accountId))) return false;
        const memo = up(t.debitCreditMemo);
        if (memo === 'DEBIT') return false; // money out is never a contribution
        const amount = num(t.totalAmount) || num(t.amount);
        if (!(Math.abs(amount) > 0) || (memo !== 'CREDIT' && !(amount > 0))) return false;
        const label = `${t.transactionType ?? ''} ${t.category ?? ''} ${t.description ?? ''} ${t.memo ?? ''}`.trim();
        if (!label) { sawUnlabeledCredit = true; return true; } // no signal → coarse include
        if (FDX_GROWTH.test(label)) return false;               // dividends/interest = growth
        return FDX_INFLOW.test(label);                          // labeled but neither → exclude
      })
      .map((t) => ({
        account_id: String(t.accountId),
        subtype: 'contribution',
        amount: -Math.abs(num(t.totalAmount) || num(t.amount)),
        date: t.postedTimestamp ?? t.transactionTimestamp ?? t.date, // ISO 8601 per FDX
      }));
    if (sawUnlabeledCredit) {
      warnings.push(warning('COARSE_INFERENCE', 'warn',
        'FDX contribution inference is coarse: some investment-account credits carry no transactionType/description, so ALL such unlabeled credits were counted as contributions (may include dividends or rollovers). Verify inferred contribution rates.'));
    }
    const contribByAccount = contributionsByAccount(normTxns);

    const accounts = entities.map(({ acct: a, container, id }) => {
      const mapped = fdxType(a.accountType);
      const [genType, genSub] = mapped ?? FDX_CONTAINER[container] ?? ['investment', undefined];
      const subtype = genSub ?? inferLoanSubtype(a.nickname ?? a.productName);
      const { accountClass, taxTreatment, confidence } = classify(genType, subtype);
      if (confidence === 'low' || !mapped) {
        warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
          `FDX account "${a.nickname ?? a.productName ?? id}" (accountType "${a.accountType ?? '?'}") classification guessed → ${accountClass}/${taxTreatment}.`, id));
      }

      // Liability balances are positive amounts owed per FDX conventions;
      // |x| defends against institutions that report them negative (see header).
      const isDebt = accountClass === 'loan' || accountClass === 'credit';
      const rawBalance = num(a.principalBalance) || num(a.currentValue)
        || num(a.currentBalance) || num(a.balance) || num(a.availableBalance) || 0;
      const balance = isDebt ? Math.abs(rawBalance) : rawBalance;

      const out = {
        id,
        institution: a.fiName ?? (a.institutionId != null ? String(a.institutionId) : undefined),
        name: a.nickname ?? a.productName ?? undefined,
        class: accountClass,
        subtype: String(subtype ?? '').toLowerCase(),
        taxTreatment,
        balance,
        currency: (typeof a.currency === 'string' ? a.currency : a.currency?.currencyCode) ?? 'USD',
        // Which earner owns it (0/1). FDX doesn't attribute accounts to
        // household members; the caller sets ownerIndex (e.g. from the
        // customer records behind the consent grant). Defaults to primary.
        ownerIndex: Number.isInteger(a.ownerIndex) ? a.ownerIndex : 0,
        ...(contribByAccount[id] ? { estMonthlyContribution: contribByAccount[id] } : {}),
      };

      if (accountClass === 'investment') {
        const hs = [...(holdingsByAccount.get(id) ?? []), ...objs(a.holdings)];
        out.holdings = hs.map((h) => {
          if (h.costBasis == null) {
            warnings.push(warning('NO_COST_BASIS', 'info',
              `Holding ${h.symbol ?? h.securityName ?? h.holdingId ?? '?'} has no cost basis (the FDX source did not report it).`, id));
          }
          return {
            ticker: h.symbol ?? undefined,
            name: h.securityName ?? h.holdingName ?? h.description ?? undefined,
            quantity: num(h.units),
            value: num(h.marketValue),
            costBasis: h.costBasis == null ? undefined : num(h.costBasis),
            assetType: classifyAsset(FDX_HOLDING_TYPE[up(h.holdingType)] ?? h.holdingType),
          };
        });
      }
      if (isDebt) {
        out.liability = {
          // interestRate is only read on debt shapes — a depositAccount's
          // interestRate is a savings yield, not an APR (see header).
          rate: pct(a.interestRate ?? a.interestRatePercentage ?? a.apr),
          minPayment: num(a.minimumPaymentAmount ?? a.nextPaymentAmount ?? a.payment) || undefined,
          originationPrincipal: num(a.originalPrincipal ?? a.originalLoanAmount ?? a.creditLine) || undefined,
          monthsRemaining: monthsBetween(raw.asOf, a.maturityDate ?? a.payoffDate),
          ...(subtype === 'mortgage' ? { assetName: a.nickname || a.productName || 'Home' } : {}),
        };
      }
      return out;
    });

    return {
      source: 'fdx',
      // Default snapshot time is NOW (not the 1970 epoch — see util.mjs).
      asOf: raw.asOf || defaultAsOf(),
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────
// (arr/num/pct/groupBy/monthsBetween/warning live in ../util.mjs, shared with
// every other adapter.)
const up = (x) => String(x ?? '').trim().toUpperCase();
/** Own-property FDX_TYPE lookup (a hostile accountType like "constructor" must miss). */
const fdxType = (t) => (Object.hasOwn(FDX_TYPE, up(t)) ? FDX_TYPE[up(t)] : undefined);

/**
 * Unwrap one FDX account entity: { depositAccount: {…} } → its inner object +
 * which container it came in (a class signal). Flat entities pass through.
 */
function unwrapAccount(entity, index) {
  let acct = entity && typeof entity === 'object' ? entity : {};
  let container;
  for (const key of Object.keys(FDX_CONTAINER)) {
    if (acct[key] && typeof acct[key] === 'object') { container = key; acct = acct[key]; break; }
  }
  const id = String(acct.accountId ?? acct.id ?? `fdx:${index}`);
  return { acct, container, id };
}

/** Unwrap one FDX transaction ({ investmentTransaction: {…} } or flat). */
function unwrapTransaction(t) {
  if (!t || typeof t !== 'object') return {};
  for (const key of ['investmentTransaction', 'depositTransaction', 'loanTransaction', 'locTransaction']) {
    if (t[key] && typeof t[key] === 'object') return t[key];
  }
  return t;
}

function inferLoanSubtype(name) {
  const n = String(name ?? '').toLowerCase();
  if (/student/.test(n)) return 'student';
  if (/auto|car|vehicle/.test(n)) return 'auto';
  if (/mortgage|home/.test(n)) return 'mortgage';
  return undefined;
}
