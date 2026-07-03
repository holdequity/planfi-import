// validate-cfp.mjs — structural validator for a Canonical Financial Profile.
//
// This is the EXECUTABLE version of the "adapter contract" section in
// docs/ADAPTER_GUIDE.md: what every adapter's normalize() must emit. The
// contract harness (test/adapter-contract.test.mjs) runs it over every
// registered adapter's output — for the sandbox fixture AND for hostile
// inputs — so the guide and the tests cannot drift.
//
// Returns an array of human-readable error strings; [] means structurally
// valid. Deliberately checks STRUCTURE only (types, enums, finite numbers) —
// content floors (e.g. "the fixture must produce accounts") live in the
// harness so an intentionally-empty CFP (the _template adapter) still
// validates.

const ACCOUNT_CLASSES = new Set(['depository', 'investment', 'loan', 'credit', 'property']);
const TAX_TREATMENTS = new Set(['taxable', 'traditional', 'roth', 'hsa', '529', 'na']);
const ASSET_TYPES = new Set(['equity', 'etf', 'mutual_fund', 'bond', 'cash', 'crypto', 'other']);
const SEVERITIES = new Set(['info', 'warn']);

const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const isFiniteNum = (x) => typeof x === 'number' && Number.isFinite(x);
const optFinite = (x) => x === undefined || isFiniteNum(x);
const optStr = (x) => x === undefined || typeof x === 'string';

/**
 * @param {unknown} cfp - candidate CanonicalFinancialProfile
 * @returns {string[]} errors ([] = structurally valid)
 */
export function validateCFP(cfp) {
  const errors = [];
  const err = (msg) => errors.push(msg);

  if (!isObj(cfp)) return [`cfp must be a plain object, got ${cfp === null ? 'null' : typeof cfp}`];

  if (typeof cfp.source !== 'string' || !cfp.source) err('cfp.source must be a non-empty string');
  if (typeof cfp.asOf !== 'string' || !Number.isFinite(Date.parse(cfp.asOf))) {
    err(`cfp.asOf must be a parseable ISO timestamp, got ${JSON.stringify(cfp.asOf)}`);
  }
  if (!isObj(cfp.owner)) err('cfp.owner must be an object (may be empty)');
  if (!isObj(cfp.meta)) err('cfp.meta must be an object');
  else {
    if (!Array.isArray(cfp.meta.warnings)) err('cfp.meta.warnings must be an array');
    else {
      cfp.meta.warnings.forEach((w, i) => {
        if (!isObj(w)) return err(`meta.warnings[${i}] must be an object`);
        if (typeof w.code !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(w.code)) err(`meta.warnings[${i}].code must be SCREAMING_SNAKE, got ${JSON.stringify(w.code)}`);
        if (!SEVERITIES.has(w.severity)) err(`meta.warnings[${i}].severity must be 'info'|'warn', got ${JSON.stringify(w.severity)}`);
        if (typeof w.message !== 'string' || !w.message) err(`meta.warnings[${i}].message must be a non-empty string`);
        if (!optStr(w.accountId)) err(`meta.warnings[${i}].accountId must be a string when present`);
      });
    }
    if (!Array.isArray(cfp.meta.unmapped)) err('cfp.meta.unmapped must be an array');
  }

  if (!Array.isArray(cfp.accounts)) {
    err('cfp.accounts must be an array');
    return errors;
  }
  cfp.accounts.forEach((a, i) => {
    const at = `accounts[${i}]`;
    if (!isObj(a)) return err(`${at} must be an object`);
    if (typeof a.id !== 'string' || !a.id) err(`${at}.id must be a non-empty string (stable provider id)`);
    if (!ACCOUNT_CLASSES.has(a.class)) err(`${at}.class must be one of ${[...ACCOUNT_CLASSES].join('|')}, got ${JSON.stringify(a.class)}`);
    if (!isFiniteNum(a.balance)) err(`${at}.balance must be a finite number (no NaN/Infinity), got ${String(a.balance)}`);
    if (!optStr(a.subtype)) err(`${at}.subtype must be a string when present`);
    if (a.taxTreatment !== undefined && !TAX_TREATMENTS.has(a.taxTreatment)) {
      err(`${at}.taxTreatment must be one of ${[...TAX_TREATMENTS].join('|')}, got ${JSON.stringify(a.taxTreatment)}`);
    }
    if (!optStr(a.institution)) err(`${at}.institution must be a string when present`);
    if (!optStr(a.name)) err(`${at}.name must be a string when present`);
    if (!optStr(a.currency)) err(`${at}.currency must be a string when present`);
    if (a.ownerIndex !== undefined && (!Number.isInteger(a.ownerIndex) || a.ownerIndex < 0)) {
      err(`${at}.ownerIndex must be a non-negative integer when present, got ${String(a.ownerIndex)}`);
    }
    if (a.estMonthlyContribution !== undefined && (!isFiniteNum(a.estMonthlyContribution) || a.estMonthlyContribution < 0)) {
      err(`${at}.estMonthlyContribution must be a finite number >= 0 when present, got ${String(a.estMonthlyContribution)}`);
    }
    if (a.holdings !== undefined) {
      if (!Array.isArray(a.holdings)) err(`${at}.holdings must be an array when present`);
      else a.holdings.forEach((h, j) => {
        const ht = `${at}.holdings[${j}]`;
        if (!isObj(h)) return err(`${ht} must be an object`);
        if (!ASSET_TYPES.has(h.assetType)) err(`${ht}.assetType must be one of ${[...ASSET_TYPES].join('|')}, got ${JSON.stringify(h.assetType)}`);
        if (!optFinite(h.quantity)) err(`${ht}.quantity must be finite when present, got ${String(h.quantity)}`);
        if (!optFinite(h.value)) err(`${ht}.value must be finite when present, got ${String(h.value)}`);
        if (!optFinite(h.costBasis)) err(`${ht}.costBasis must be finite when present (NEVER fabricated), got ${String(h.costBasis)}`);
        if (!optStr(h.ticker)) err(`${ht}.ticker must be a string when present`);
        if (!optStr(h.name)) err(`${ht}.name must be a string when present`);
      });
    }
    if (a.liability !== undefined) {
      const L = a.liability;
      const lt = `${at}.liability`;
      if (!isObj(L)) err(`${lt} must be an object when present`);
      else {
        if (!optFinite(L.rate)) err(`${lt}.rate must be a finite FRACTION (0.0625, not 6.25) when present, got ${String(L.rate)}`);
        if (!optFinite(L.minPayment)) err(`${lt}.minPayment must be finite when present, got ${String(L.minPayment)}`);
        if (!optFinite(L.monthsRemaining)) err(`${lt}.monthsRemaining must be finite when present, got ${String(L.monthsRemaining)}`);
        if (!optFinite(L.originationPrincipal)) err(`${lt}.originationPrincipal must be finite when present, got ${String(L.originationPrincipal)}`);
        if (!optStr(L.assetName)) err(`${lt}.assetName must be a string when present`);
        if (!optFinite(L.assetValue)) err(`${lt}.assetValue must be finite when present, got ${String(L.assetValue)}`);
      }
    }
  });

  // Duplicate ids break dedup/reconcile downstream.
  const ids = cfp.accounts.filter(isObj).map((a) => a.id).filter((x) => typeof x === 'string');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) err(`duplicate account ids: ${[...new Set(dupes)].join(', ')}`);

  return errors;
}

/** Recursively find NaN/Infinity anywhere in a value tree → paths (or []). */
export function findNonFinite(obj, path = '$') {
  const bad = [];
  const walk = (v, p) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(`${p} = ${v}`); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  walk(obj, path);
  return bad;
}
