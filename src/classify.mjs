// classify.mjs — map a provider account (type + subtype) to the canonical
// { class, taxTreatment }. Provider-neutral: adapters pass already-lowercased
// type/subtype strings. Returns a confidence so ambiguous guesses can warn.
//
// @typedef {import('./canonical').AccountClass} AccountClass
// @typedef {import('./canonical').TaxTreatment} TaxTreatment

/** Roth-flavored investment subtypes. */
const ROTH = /roth/;
/** Pre-tax retirement subtypes (traditional treatment). */
const PRETAX = /401k|403b|457b|401a|\bira\b|sep|simple|keogh|pension|thrift|tsp|retirement/;
/** Education / 529. */
const EDU_529 = /529|education\s?savings/;
/** Explicitly taxable investment subtypes. */
const TAXABLE_INV = /brokerage|mutual fund|cash management|stock plan|crypto|ugma|utma|non-taxable brokerage|other/;

/**
 * @param {string} type - provider account family (e.g. Plaid 'investment'|'depository'|'loan'|'credit')
 * @param {string} [subtype]
 * @returns {{ accountClass: AccountClass, taxTreatment: TaxTreatment, confidence: 'high'|'medium'|'low' }}
 */
export function classify(type, subtype = '') {
  const t = String(type || '').trim().toLowerCase();
  const s = String(subtype || '').trim().toLowerCase();

  if (t === 'loan') return { accountClass: 'loan', taxTreatment: 'na', confidence: 'high' };
  if (t === 'credit') return { accountClass: 'credit', taxTreatment: 'na', confidence: 'high' };

  if (t === 'depository') {
    if (s === 'hsa') return { accountClass: 'investment', taxTreatment: 'hsa', confidence: 'high' };
    return { accountClass: 'depository', taxTreatment: 'na', confidence: 'high' };
  }

  if (t === 'investment' || t === 'brokerage') {
    if (s === 'hsa') return { accountClass: 'investment', taxTreatment: 'hsa', confidence: 'high' };
    if (EDU_529.test(s)) return { accountClass: 'investment', taxTreatment: '529', confidence: 'high' };
    if (ROTH.test(s)) return { accountClass: 'investment', taxTreatment: 'roth', confidence: 'high' };
    if (PRETAX.test(s)) return { accountClass: 'investment', taxTreatment: 'traditional', confidence: 'high' };
    if (TAXABLE_INV.test(s)) return { accountClass: 'investment', taxTreatment: 'taxable', confidence: 'high' };
    // Unknown investment subtype → assume taxable but flag it.
    return { accountClass: 'investment', taxTreatment: 'taxable', confidence: 'low' };
  }

  // Unknown top-level type — treat as taxable investment, low confidence.
  return { accountClass: 'investment', taxTreatment: 'taxable', confidence: 'low' };
}

/** Map a provider security type → canonical assetType. Handles Plaid + MX vocab. */
export function classifyAsset(securityType = '') {
  const s = String(securityType || '').trim().toLowerCase();
  if (s === 'etf') return 'etf';
  if (s === 'mutual fund') return 'mutual_fund';
  if (s === 'equity' || s === 'stock' || s === 'common stock') return 'equity';
  if (s === 'fixed income' || s === 'bond') return 'bond';
  if (s === 'cash' || s === 'cash equivalent') return 'cash';
  if (s.startsWith('crypto')) return 'crypto';
  if (s === 'derivative') return 'other';
  return 'other';
}
