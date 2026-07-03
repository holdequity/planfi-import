// util.mjs — helpers shared by every adapter (and the mapper). Extracted so the
// adapters can't drift apart again: before this file existed, plaid.mjs and
// mx.mjs each carried private copies of monthsBetween whose fallback base dates
// had already diverged (2025-01-01 vs 2026-01-01). One implementation, one
// documented fallback.

/** Coerce to an array (anything else → []). */
export const arr = (x) => (Array.isArray(x) ? x : []);

/**
 * Coerce to an array of OBJECTS: non-arrays → [], and non-object members
 * (null, numbers, strings) are dropped. Use this at every provider-array
 * boundary — a null member in accounts[]/holdings[]/transactions[] must not
 * crash an adapter (the contract harness feeds exactly that).
 */
export const objs = (x) => arr(x).filter((v) => v != null && typeof v === 'object');

/** Coerce to a finite number (anything else → 0). Preserves sign. */
export const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Provider rates are percentages (6.25) → fraction (0.0625). Non-numeric → undefined. */
export const pct = (x) => (Number.isFinite(Number(x)) ? Number(x) / 100 : undefined);

/** Group a list into a Map by key(x). */
export function groupBy(list, key) {
  const m = new Map();
  for (const x of list) { const k = key(x); (m.get(k) ?? m.set(k, []).get(k)).push(x); }
  return m;
}

/**
 * Whole months between two ISO dates (>= 1), or undefined when `toIso` is
 * missing/unparseable. Fallback: when `fromIso` is missing or unparseable the
 * base is NOW (Date.now()) — the snapshot being processed is assumed current.
 * (Never a hardcoded year: a fixed base silently ages every remaining-term
 * calculation as the calendar moves on.)
 */
export function monthsBetween(fromIso, toIso) {
  if (!toIso) return undefined;
  const t = Date.parse(toIso);
  if (!Number.isFinite(t)) return undefined;
  const f = Date.parse(fromIso || '');
  const base = Number.isFinite(f) ? f : Date.now();
  return Math.max(1, Math.round((t - base) / (1000 * 60 * 60 * 24 * 30.44)));
}

/**
 * Build a structured ImportWarning (see canonical.ts). One factory shared by
 * every adapter and the mapper so the shape can't drift.
 * @param {import('./canonical').WarningCode} code - stable machine-readable id
 * @param {'info'|'warn'} severity
 * @param {string} message - human-quality explanation
 * @param {string} [accountId] - provider account id, when account-scoped
 * @returns {import('./canonical').ImportWarning}
 */
export const warning = (code, severity, message, accountId) =>
  ({ code, severity, message, ...(accountId != null ? { accountId: String(accountId) } : {}) });

/**
 * Default snapshot timestamp when the caller didn't supply one: NOW.
 * (Previously `new Date(0)` — the 1970 epoch — which made monthsBetween compute
 * mortgage terms from 1970: ~80-year `years_remaining` on every import that
 * omitted `asOf`.)
 */
export const defaultAsOf = () => new Date().toISOString();
