// finicity.mjs — Finicity (Mastercard Open Banking) → Canonical Financial Profile.
//
// Consumes Finicity API entities (already fetched + merged by the caller, the
// same contract style as the Plaid and MX adapters):
//   GET /aggregation/v1/customers/{customerId}/accounts
//     → accounts[]  (each account carries `type`, `balance`, and — for loans,
//       mortgages and cards — a `detail` object with interestRate / payment /
//       maturity fields when the institution reports them)
//   GET /aggregation/v1/customers/{customerId}/accounts/{accountId}
//     → account details incl. investment `position[]`; the caller flattens
//       positions from all investment accounts into one `positions[]` array,
//       each tagged with its `accountId`
//   GET /aggregation/v3/customers/{customerId}/transactions
//     → transactions[]  (optional; drives contribution inference — Finicity
//       transactions carry a `categorization.category` plus, on investment
//       accounts, an `investmentTransactionType`)
//
// Assumptions verified against the Finicity API docs (note them because sign
// conventions bite):
//   - LIABILITY BALANCES ARE POSITIVE on the account record: a mortgage's
//     `balance` is the outstanding principal, a creditCard's `balance` is the
//     amount owed. Some institutions have been observed reporting card
//     balances negative; the adapter takes |balance| for loan/credit classes
//     so a sign quirk can't zero out a debt downstream (the shared mapper
//     clamps negative *asset* balances to $0 with a warning — correct for
//     assets, wrong for debts).
//   - TRANSACTION AMOUNTS are signed from the account holder's perspective:
//     deposits into an account are POSITIVE, withdrawals negative.
//   - TRANSACTION DATES (`transactedDate`/`postedDate`) are epoch SECONDS,
//     not ISO strings — normalized here before contribution inference.
//   - Finicity has NO property/real-estate account type, so mortgages can't
//     be paired with a market value; the shared mapper estimates at 80% LTV
//     and asks for the real value via needsInput (same as Plaid).
//
// Only Finicity's vocabulary is translated here; ALL Planfi domain logic
// stays in to-planfi.mjs, shared with every other adapter.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify, classifyAsset } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';
import { arr, num, pct, groupBy, monthsBetween, defaultAsOf, warning } from '../util.mjs';

// Finicity credit categorization/labels that are savings INFLOWS (counted) vs
// investment GROWTH (excluded — already modeled by annual_return). Same split
// the MX adapter applies to its category/description labels.
const FIN_INFLOW = /transfer|deposit|contribution|payroll|direct dep/i;
const FIN_GROWTH = /dividend|interest|capital gain|reinvest/i;

// Finicity account `type` → generic [type, subtype?] that classify() consumes.
// Keys are lowercased (Finicity sends camelCase like `investmentTaxDeferred`).
const FIN_TYPE = {
  // depository
  checking: ['depository', 'checking'],
  savings: ['depository', 'savings'],
  cd: ['depository', 'cd'],
  moneymarket: ['depository', 'money market'],
  // investment — generic wrappers
  investment: ['investment', undefined],
  brokerageaccount: ['investment', 'brokerage'],
  // Pre-tax wrapper of unknown flavor → 'tax-deferred' hints traditional at
  // LOW confidence in classify() (no finer signal than "deferred").
  investmenttaxdeferred: ['investment', 'tax-deferred'],
  // investment — named retirement wrappers (classify() knows these words)
  ira: ['investment', 'ira'],
  roth: ['investment', 'roth ira'],
  '401k': ['investment', '401k'],
  '403b': ['investment', '403b'],
  simpleira: ['investment', 'simple ira'],
  sepira: ['investment', 'sep ira'],
  keogh: ['investment', 'keogh'],
  rollover: ['investment', 'rollover ira'],
  // education
  '529plan': ['investment', '529'],
  '529': ['investment', '529'],
  educationira: ['investment', 'education savings'], // Coverdell ESA → 529 treatment
  // health
  hsa: ['investment', 'hsa'],
  // loans
  mortgage: ['loan', 'mortgage'],
  homeequityloan: ['loan', 'home equity'],
  loan: ['loan', undefined],
  studentloan: ['loan', 'student'],
  studentloangroup: ['loan', 'student'],
  studentloanaccount: ['loan', 'student'],
  autoloan: ['loan', 'auto'],
  // revolving credit
  creditcard: ['credit', 'credit card'],
  lineofcredit: ['credit', 'line of credit'],
};

/** @implements {SourceAdapter} */
export const finicityAdapter = {
  source: 'finicity',
  /**
   * @param {object} raw - { accounts, positions, transactions, owner, asOf }
   * @returns {CFP}
   */
  normalize(raw = {}) {
    const warnings = [];
    const unmapped = [];
    const accountsIn = arr(raw.accounts);
    const positionsByAccount = groupBy(arr(raw.positions), (p) => p.accountId);

    // Contributions: deposits (positive amounts) into investment accounts are
    // candidate inflows. Finicity carries categorization on most transactions;
    // filter growth (dividends/interest/reinvest) out the same way MX does.
    // A deposit with NO usable label is counted but flagged once as coarse.
    const invIds = new Set(accountsIn
      .filter((a) => (finType(a.type) ?? ['investment'])[0] === 'investment')
      .map((a) => String(a.id)));
    let sawUnlabeledDeposit = false;
    const normTxns = arr(raw.transactions)
      .filter((t) => {
        if (!invIds.has(String(t.accountId)) || !(num(t.amount) > 0)) return false;
        const label = `${t.investmentTransactionType ?? ''} ${t.categorization?.category ?? ''} ${t.description ?? ''} ${t.memo ?? ''}`.trim();
        if (!label) { sawUnlabeledDeposit = true; return true; } // no signal → coarse include
        if (FIN_GROWTH.test(label)) return false;                // dividends/interest = growth
        return FIN_INFLOW.test(label);                           // labeled but neither → exclude
      })
      .map((t) => ({
        account_id: String(t.accountId),
        subtype: 'contribution',
        amount: -Math.abs(num(t.amount)),
        date: finDate(t.transactedDate ?? t.postedDate ?? t.date),
      }));
    if (sawUnlabeledDeposit) {
      warnings.push(warning('COARSE_INFERENCE', 'warn',
        'Finicity contribution inference is coarse: some investment-account deposits carry no categorization/description, so ALL such unlabeled deposits were counted as contributions (may include dividends or rollovers). Verify inferred contribution rates.'));
    }
    const contribByAccount = contributionsByAccount(normTxns);

    const accounts = accountsIn.map((a) => {
      const id = String(a.id);
      const mapped = finType(a.type);
      const [genType, genSub] = mapped ?? ['investment', undefined];
      const subtype = genSub ?? inferLoanSubtype(a.name);
      const { accountClass, taxTreatment, confidence } = classify(genType, subtype);
      if (confidence === 'low' || !mapped) {
        warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
          `Finicity account "${a.name ?? id}" (type "${a.type ?? '?'}") classification guessed → ${accountClass}/${taxTreatment}.`, id));
      }

      // Liability balances are positive per the Finicity docs; |x| defends
      // against institutions that report cards negative (see header).
      const isDebt = accountClass === 'loan' || accountClass === 'credit';
      const rawBalance = num(a.balance) || num(a.detail?.availableBalanceAmount) || 0;
      const balance = isDebt ? Math.abs(rawBalance) : rawBalance;

      const acct = {
        id,
        institution: a.institutionId != null ? String(a.institutionId) : undefined,
        name: a.name,
        class: accountClass,
        subtype: String(subtype ?? '').toLowerCase(),
        taxTreatment,
        balance,
        currency: a.currency ?? 'USD',
        // Which earner owns it (0/1). Finicity doesn't attribute accounts to
        // household members; the caller sets ownerIndex (e.g. from customer
        // records). Defaults to the primary earner.
        ownerIndex: Number.isInteger(a.ownerIndex) ? a.ownerIndex : 0,
        ...(contribByAccount[id] ? { estMonthlyContribution: contribByAccount[id] } : {}),
      };

      if (accountClass === 'investment') {
        const ps = positionsByAccount.get(a.id) ?? positionsByAccount.get(id) ?? [];
        acct.holdings = ps.map((p) => {
          if (p.costBasis == null) {
            warnings.push(warning('NO_COST_BASIS', 'info',
              `Holding ${p.symbol ?? p.description ?? p.id} has no cost basis (Finicity did not report it).`, id));
          }
          return {
            ticker: p.symbol ?? undefined,
            name: p.description ?? p.fundName ?? undefined,
            quantity: num(p.units ?? p.quantity),
            value: num(p.marketValue),
            costBasis: p.costBasis == null ? undefined : num(p.costBasis),
            assetType: classifyAsset(p.securityType),
          };
        });
      }
      if (isDebt) {
        // Loan/card detail lives on account.detail (populated by the account-
        // details call). Field names vary by product; try the documented ones.
        const d = a.detail ?? {};
        acct.liability = {
          rate: pct(d.interestRate ?? d.interestRatePercent ?? a.interestRate),
          minPayment: num(d.payment ?? d.nextPayment ?? d.paymentMinAmount ?? d.minimumPaymentAmount) || undefined,
          originationPrincipal: num(d.originalLoanAmount ?? d.creditLimit) || undefined,
          monthsRemaining: monthsBetween(raw.asOf, finDateIso(d.maturityDate ?? d.payoffDate ?? d.endDate)),
          ...(subtype === 'mortgage' ? { assetName: a.name || 'Home' } : {}),
        };
      }
      return acct;
    });

    return {
      source: 'finicity',
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
// the plaid + mx adapters.)
const low = (x) => String(x ?? '').trim().toLowerCase();
/** Own-property FIN_TYPE lookup (a hostile `type` like "constructor" must miss). */
const finType = (t) => (Object.hasOwn(FIN_TYPE, low(t)) ? FIN_TYPE[low(t)] : undefined);

/** Finicity dates are epoch SECONDS; also accept ISO strings. → ISO or undefined. */
function finDateIso(v) {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toISOString();
  return Number.isFinite(Date.parse(v)) ? String(v) : undefined;
}
/** Same, but for transaction dates fed into contribution inference. */
const finDate = finDateIso;

function inferLoanSubtype(name) {
  const n = String(name ?? '').toLowerCase();
  if (/student/.test(n)) return 'student';
  if (/auto|car|vehicle/.test(n)) return 'auto';
  if (/mortgage|home/.test(n)) return 'mortgage';
  return undefined;
}
