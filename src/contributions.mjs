// contributions.mjs — infer a monthly contribution rate per account from Plaid
// investment transactions. Aggregators report balances, not savings rates, so
// projections need this signal or they understate growth.
//
// Heuristic: sum the money flowing INTO the account (deposits / contributions /
// transfers-in / payroll) over the observed window, then divide by the window
// length in months. Sign-agnostic (uses magnitude) to survive Plaid's debit/
// credit convention differences across products. Conservative: unknown → 0.

const IN_SUBTYPE = /contribution|deposit|transfer|payroll|dividend|interest/i;

/**
 * @param {Array<{account_id?:string, type?:string, subtype?:string, amount?:number, date?:string}>} txns
 * @param {object} [opts]
 * @param {number} [opts.windowMonths] - override the inferred window
 * @returns {number} estimated monthly contribution (>= 0)
 */
export function inferMonthlyContribution(txns, opts = {}) {
  const list = (Array.isArray(txns) ? txns : []).filter(isInflow);
  if (!list.length) return 0;
  const total = list.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0);
  const months = opts.windowMonths || spanMonths(txns) || 12;
  const monthly = total / months;
  return Number.isFinite(monthly) && monthly > 0 ? Math.round(monthly) : 0;
}

/** Group investment transactions by account_id → inferred monthly contribution. */
export function contributionsByAccount(txns, opts = {}) {
  const byAcct = new Map();
  for (const t of Array.isArray(txns) ? txns : []) {
    const k = t.account_id;
    if (!k) continue;
    (byAcct.get(k) ?? byAcct.set(k, []).get(k)).push(t);
  }
  const out = {};
  for (const [acct, list] of byAcct) out[acct] = inferMonthlyContribution(list, opts);
  return out;
}

/** A transaction that represents money entering the account. */
function isInflow(t) {
  const sub = String(t?.subtype ?? '');
  if (IN_SUBTYPE.test(sub)) return true;
  // Plaid credits cash into the account as a negative `amount` on a 'cash' type.
  return String(t?.type ?? '') === 'cash' && Number(t?.amount) < 0;
}

/** Months spanned by the transaction dates (min→max), min 1. */
function spanMonths(txns) {
  const times = (Array.isArray(txns) ? txns : [])
    .map((t) => Date.parse(t?.date ?? ''))
    .filter(Number.isFinite);
  if (times.length < 2) return 0;
  const span = (Math.max(...times) - Math.min(...times)) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.max(1, Math.round(span));
}
