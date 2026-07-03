// csv.mjs — CSV exports → Canonical Financial Profile. The KEYLESS path: no
// aggregator credentials, just the files a user can download from any
// brokerage/bank today ("Download → CSV").
//
// Input contract (no provider API behind this one — the caller collects files):
//   {
//     files: [{ name?, kind?: 'accounts'|'holdings'|'transactions', content: string }],
//     owner,   // onboarding context, same as every adapter
//     asOf,    // ISO snapshot timestamp
//   }
// `kind` is optional — when omitted the file's HEADER FINGERPRINT decides
// (positions dialects → holdings, date+amount → transactions, else accounts).
//
// Column mapping is dialect-driven: DIALECTS is a table keyed by header
// fingerprints for known broker exports (Fidelity positions, Schwab positions,
// Vanguard downloads) plus generic accounts/transactions layouts. A file whose
// headers match NO dialect still imports via best-effort generic mapping
// (name-ish column + money-ish column) with a CSV_UNMAPPED_COLUMNS warning
// naming every column that couldn't be mapped — balances are never silently
// dropped, and nothing is fabricated to make the file look richer than it is.
//
// Honesty rules (CSV carries less signal than any API):
//   - A Type/Account Type column is classified via classify(), same as the
//     API adapters. NO type column → the account NAME is used as a hint, and
//     the result ALWAYS carries CLASSIFICATION_GUESSED (a name is a guess).
//     No usable signal at all → low-confidence taxable + the same warning.
//   - Money cells handle currency symbols, thousands commas, and
//     accounting-style parenthesized negatives ("(1,850.00)" → -1850).
//   - Positions dialects have no account-type column, so every account they
//     produce is name-guessed (warned). Missing cost basis ("--") → the same
//     NO_COST_BASIS info warning the API adapters emit.
//   - Transactions files feed the shared contribution inference with the same
//     growth-exclusion rules as the siblings (dividends/interest excluded,
//     unlabeled deposits counted coarsely + COARSE_INFERENCE).
//
// Only CSV quirk-handling lives here; ALL Planfi domain logic stays in
// to-planfi.mjs, shared with every other adapter.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';
import { arr, defaultAsOf, warning } from '../util.mjs';

// Same inflow/growth split as the MX + Finicity adapters.
const CSV_INFLOW = /transfer|deposit|contribution|payroll|direct dep|buy/i;
const CSV_GROWTH = /dividend|interest|capital gain|reinvest/i;

// ── dependency-free CSV parsing ──────────────────────────────────────────────

/**
 * Parse CSV text → array of rows (arrays of string cells). Handles quoted
 * fields, commas/newlines inside quotes, doubled-quote escapes, CRLF and lone
 * CR line endings, and a leading BOM. Tolerant by construction: an unclosed
 * quote at EOF just ends the field — this function never throws.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') { if (s[i + 1] === '\n') i++; endRow(); }
    else field += c;
  }
  if (field !== '' || row.length) endRow();
  // Drop rows that are entirely empty (blank lines, trailing newline).
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

// ── dialect table ────────────────────────────────────────────────────────────
// Each dialect: header fingerprint (`requires` keys that must all resolve via
// `columns` aliases) + the column map. First match wins, so brand dialects sit
// above the generic ones. Headers are normalized (lowercased, trimmed,
// parenthetical suffixes stripped: "Qty (Quantity)" → "qty").

const DIALECTS = [
  {
    id: 'fidelity-positions', kind: 'holdings', institution: 'Fidelity',
    columns: {
      accountId: ['account number'],
      accountName: ['account name'],
      symbol: ['symbol'],
      name: ['description'],
      quantity: ['quantity'],
      lastPrice: ['last price'],
      value: ['current value'],
      costBasis: ['cost basis total', 'cost basis'],
    },
    requires: ['accountId', 'accountName', 'symbol', 'name', 'quantity', 'lastPrice', 'value'],
  },
  {
    id: 'vanguard-download', kind: 'holdings', institution: 'Vanguard',
    columns: {
      accountId: ['account number'],
      name: ['investment name'],
      symbol: ['symbol'],
      quantity: ['shares'],
      lastPrice: ['share price'],
      value: ['total value'],
      costBasis: ['cost basis', 'total cost'],
    },
    requires: ['accountId', 'name', 'symbol', 'quantity', 'lastPrice', 'value'],
  },
  {
    id: 'schwab-positions', kind: 'holdings', institution: 'Charles Schwab',
    columns: {
      symbol: ['symbol'],
      name: ['description'],
      quantity: ['qty', 'quantity'],
      lastPrice: ['price'],
      value: ['mkt val', 'market value'],
      costBasis: ['cost basis', 'cost basis total'],
    },
    requires: ['symbol', 'name', 'quantity', 'lastPrice', 'value'],
  },
  {
    id: 'generic-transactions', kind: 'transactions',
    columns: {
      account: ['account', 'account name', 'account number', 'account id'],
      date: ['date', 'posted date', 'transaction date', 'run date', 'trade date'],
      amount: ['amount', 'amount ($)', 'total amount'],
      label: ['description', 'action', 'type', 'category', 'memo', 'transaction type'],
    },
    requires: ['date', 'amount'],
  },
  {
    id: 'generic-accounts', kind: 'accounts',
    columns: {
      accountId: ['account number', 'account #', 'account id', 'number'],
      name: ['account name', 'name', 'account'],
      type: ['type', 'account type', 'category'],
      balance: ['balance', 'current balance', 'value', 'current value', 'amount', 'total'],
      rate: ['interest rate', 'apr', 'rate'],
      minPayment: ['minimum payment', 'min payment', 'monthly payment'],
      institution: ['institution', 'bank', 'custodian'],
      owner: ['owner', 'owner index'],
    },
    requires: ['name', 'balance'],
  },
];

/** @implements {SourceAdapter} */
export const csvAdapter = {
  source: 'csv',
  /**
   * @param {object} raw - { files: [{name?, kind?, content}], owner, asOf }
   * @returns {CFP}
   */
  normalize(raw) {
    // Total function: null/primitive payloads normalize to an empty profile
    // (a default parameter only covers `undefined` — the contract harness
    // caught the null case throwing).
    raw = raw && typeof raw === 'object' ? raw : {};
    const warnings = [];
    const unmapped = [];
    const accounts = [];
    const txnRows = []; // { ref, amount, date, label } collected across files
    const usedIds = new Set();
    const uniqueId = (want) => {
      let id = want;
      for (let n = 2; usedIds.has(id); n++) id = `${want}:${n}`;
      usedIds.add(id);
      return id;
    };

    arr(raw.files).forEach((f, fileIdx) => {
      const fname = str(f?.name) || `file ${fileIdx + 1}`;
      const rows = parseCsv(f?.content);
      if (!rows.length) {
        warnings.push(warning('CSV_UNMAPPED_COLUMNS', 'warn',
          `CSV file "${fname}" is empty or unparseable — nothing imported from it.`));
        unmapped.push({ file: fname, reason: 'empty or unparseable' });
        return;
      }
      const wantKind = ['accounts', 'holdings', 'transactions'].includes(f?.kind) ? f.kind : undefined;
      const hit = detectDialect(rows, wantKind);

      if (!hit) {
        // No dialect fingerprint matched → best-effort generic mapping: the
        // left-most texty column is the name, the money-densest column is the
        // balance. Balances still import; the guess is warned, never hidden.
        bestEffortAccounts(rows, fname, fileIdx, { accounts, warnings, unmapped, uniqueId });
        return;
      }

      const { dialect, map, headerIdx, headers } = hit;
      const data = rows.slice(headerIdx + 1);
      if (dialect.kind === 'holdings') {
        mapHoldingsFile(data, map, dialect, fname, fileIdx, { accounts, warnings, uniqueId });
      } else if (dialect.kind === 'transactions') {
        for (const r of data) {
          const cell = (k) => (map[k] != null ? r[map[k]] : undefined);
          txnRows.push({
            ref: str(cell('account')),
            amount: moneyCell(cell('amount')),
            date: str(cell('date')),
            label: str(cell('label')),
          });
        }
        warnUnmappedColumns(dialect, map, headers, fname, { warnings, unmapped });
      } else {
        mapAccountsFile(data, map, fname, fileIdx, { accounts, warnings, uniqueId });
        warnUnmappedColumns(dialect, map, headers, fname, { warnings, unmapped });
      }
    });

    // ── contribution inference from transactions files ──────────────────────
    // Same rules as the API adapters: only deposits INTO investment accounts,
    // growth (dividends/interest/reinvest) excluded, unlabeled deposits
    // counted but flagged once as coarse.
    const invAccounts = accounts.filter((a) => a.class === 'investment');
    const byRef = new Map();
    for (const a of invAccounts) {
      byRef.set(low(a.id), a.id);
      if (a.name) byRef.set(low(a.name), a.id);
    }
    let sawUnlabeledDeposit = false;
    const normTxns = [];
    for (const t of txnRows) {
      const id = byRef.get(low(t.ref));
      if (!id) { if (t.ref) unmapped.push({ transactionAccount: t.ref, reason: 'no matching investment account' }); continue; }
      if (!(Number(t.amount) > 0)) continue; // outflows/junk are not contributions
      if (!t.label) { sawUnlabeledDeposit = true; }
      else if (CSV_GROWTH.test(t.label)) continue; // dividends/interest = growth
      else if (!CSV_INFLOW.test(t.label)) continue; // labeled but neither → exclude
      normTxns.push({ account_id: id, subtype: 'contribution', amount: -Math.abs(t.amount), date: t.date });
    }
    if (sawUnlabeledDeposit) {
      warnings.push(warning('COARSE_INFERENCE', 'warn',
        'CSV contribution inference is coarse: some investment-account deposits carry no description, so ALL such unlabeled deposits were counted as contributions (may include dividends or rollovers). Verify inferred contribution rates.'));
    }
    const contribByAccount = contributionsByAccount(normTxns);
    for (const a of accounts) {
      if (contribByAccount[a.id]) a.estMonthlyContribution = contribByAccount[a.id];
    }

    return {
      source: 'csv',
      // Default snapshot time is NOW (not the 1970 epoch — see util.mjs).
      asOf: raw.asOf || defaultAsOf(),
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── dialect detection ────────────────────────────────────────────────────────

/** Normalize a header cell: lowercase, trim, strip "(…)" suffixes + BOM. */
const normHeader = (h) => String(h ?? '')
  .replace(/^\uFEFF/, '')
  .trim()
  .toLowerCase()
  .replace(/\s*\([^)]*\)\s*$/, '')
  .replace(/\s+/g, ' ');

/** Resolve a dialect's column aliases against normalized headers → {key: index}. */
function resolveColumns(headers, columns) {
  const map = {};
  for (const [key, aliases] of Object.entries(columns)) {
    for (const alias of aliases) {
      const idx = headers.indexOf(alias);
      if (idx >= 0) { map[key] = idx; break; }
    }
  }
  return map;
}

/**
 * Find the header row + dialect. Broker exports carry preamble lines
 * (timestamps, blank rows) before the real header, so the first several rows
 * are each tried as a candidate header; the first row matching any dialect's
 * fingerprint wins. `wantKind` (explicit file.kind) restricts the candidates.
 */
function detectDialect(rows, wantKind) {
  const candidates = wantKind ? DIALECTS.filter((d) => d.kind === wantKind) : DIALECTS;
  const scanTo = Math.min(rows.length, 10);
  for (let i = 0; i < scanTo; i++) {
    const headers = rows[i].map(normHeader);
    for (const dialect of candidates) {
      const map = resolveColumns(headers, dialect.columns);
      if (dialect.requires.every((k) => map[k] != null)) return { dialect, map, headerIdx: i, headers };
    }
  }
  return null;
}

/** Warn (stable code CSV_UNMAPPED_COLUMNS) when generic mapping left columns behind. */
function warnUnmappedColumns(dialect, map, headers, fname, ctx) {
  const used = new Set(Object.values(map));
  const missed = headers.filter((h, i) => h && !used.has(i));
  if (!missed.length) return;
  ctx.warnings.push(warning('CSV_UNMAPPED_COLUMNS', 'warn',
    `CSV file "${fname}": column(s) ${missed.map((c) => `"${c}"`).join(', ')} did not match the ${dialect.id} mapping and were ignored — rename them to a recognized header if they carry balances.`));
  ctx.unmapped.push({ file: fname, unmappedColumns: missed });
}

// ── file mappers ─────────────────────────────────────────────────────────────

/** Positions export → one investment account per account-number/name group. */
function mapHoldingsFile(data, map, dialect, fname, fileIdx, ctx) {
  const groups = new Map(); // key → { id, name, holdings }
  for (const r of data) {
    const cell = (k) => (map[k] != null ? r[map[k]] : undefined);
    const symbol = str(cell('symbol'));
    const name = str(cell('name'));
    if (!symbol && !name) continue; // blank/short disclaimer rows
    // Broker exports append synthetic rows — never model them as holdings.
    if (/pending activity|account total|^total$|grand total|^cash & cash investments$/i.test(symbol || name)) continue;
    const value = moneyCell(cell('value'));
    const quantity = moneyCell(cell('quantity'));
    if (value == null && quantity == null) continue; // footer/disclaimer text rows
    const acctId = str(cell('accountId'));
    const acctName = str(cell('accountName'))
      || (acctId ? `${dialect.institution} ${acctId}` : fname.replace(/\.csv$/i, ''));
    const key = acctId || acctName;
    if (!groups.has(key)) groups.set(key, { id: acctId || `csv:${fileIdx}:${slug(acctName)}`, name: acctName, holdings: [] });
    const g = groups.get(key);
    const costBasis = moneyCell(cell('costBasis'));
    if (costBasis == null) {
      ctx.warnings.push(warning('NO_COST_BASIS', 'info',
        `Holding ${symbol || name} has no cost basis in "${fname}" (cell empty or "--").`, g.id));
    }
    g.holdings.push({
      ticker: symbol ? symbol.replace(/\*+$/, '') : undefined, // Fidelity core positions end in **
      name: name || undefined,
      quantity: quantity ?? undefined,
      value: value ?? undefined,
      costBasis: costBasis ?? undefined,
      assetType: csvAssetType(symbol, name),
    });
  }
  for (const g of groups.values()) {
    const id = ctx.uniqueId(g.id);
    // Positions exports carry NO type column — the account name is the only
    // typing signal, so the classification is ALWAYS surfaced as a guess.
    const hint = csvKind(g.name);
    const { accountClass, taxTreatment } = hint
      ? classify(hint[0], hint[1])
      : { accountClass: 'investment', taxTreatment: 'taxable' };
    ctx.warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
      `CSV positions file "${fname}" has no account-type column — "${g.name}" typed from its name → ${accountClass}/${taxTreatment}. Reclassify if wrong.`, id));
    ctx.accounts.push({
      id,
      institution: dialect.institution,
      name: g.name,
      class: 'investment', // positions exports are investment accounts by construction
      subtype: hint ? String(hint[1] ?? '').toLowerCase() : '',
      taxTreatment: accountClass === 'investment' ? taxTreatment : 'taxable',
      balance: g.holdings.reduce((n, h) => n + (Number.isFinite(h.value) ? h.value : 0), 0),
      currency: 'USD',
      ownerIndex: 0,
      holdings: g.holdings,
    });
  }
}

/** Generic accounts file → one canonical account per row. */
function mapAccountsFile(data, map, fname, fileIdx, ctx) {
  data.forEach((r, rowIdx) => {
    const cell = (k) => (map[k] != null ? r[map[k]] : undefined);
    const name = str(cell('name'));
    const balanceRaw = moneyCell(cell('balance'));
    if (!name && balanceRaw == null) return; // fully blank / footer row
    const id = ctx.uniqueId(str(cell('accountId')) || `csv:${fileIdx}:${rowIdx}`);

    const typeStr = str(cell('type'));
    const fromType = csvKind(typeStr);
    const hint = fromType ?? csvKind(name);
    let cls;
    if (hint) {
      cls = classify(hint[0], hint[1]);
      if (!fromType) {
        ctx.warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
          `CSV account "${name || id}" in "${fname}" has no Type value — typed from its name → ${cls.accountClass}/${cls.taxTreatment}. Add a Type column to remove the guess.`, id));
      } else if (cls.confidence === 'low') {
        ctx.warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
          `CSV account "${name || id}" (type "${typeStr}") classification guessed → ${cls.accountClass}/${cls.taxTreatment}.`, id));
      }
    } else {
      // No recognizable type signal at all: import the balance honestly as a
      // low-confidence taxable investment — never fabricate a richer story.
      cls = { accountClass: 'investment', taxTreatment: 'taxable', confidence: 'low' };
      ctx.warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
        `CSV account "${name || id}" in "${fname}" has no recognizable type — imported as a taxable investment at low confidence. Set a Type column (e.g. "401k", "Checking", "Mortgage") to classify it.`, id));
    }

    const isDebt = cls.accountClass === 'loan' || cls.accountClass === 'credit';
    // Accounting-style negatives ("(1,850.00)") are how spreadsheets mark owed
    // balances; a debt's outstanding principal is |x| either way.
    const balance = isDebt ? Math.abs(balanceRaw ?? 0) : (balanceRaw ?? 0);

    const acct = {
      id,
      institution: str(cell('institution')) || undefined,
      name: name || undefined,
      class: cls.accountClass,
      subtype: hint ? String(hint[1] ?? '').toLowerCase() : '',
      taxTreatment: cls.taxTreatment,
      balance,
      currency: 'USD',
      ownerIndex: intOr0(cell('owner')),
    };
    if (isDebt) {
      const rate = rateCell(cell('rate'));
      const minPayment = moneyCell(cell('minPayment'));
      acct.liability = {
        rate,
        minPayment: minPayment != null ? Math.abs(minPayment) : undefined,
        ...(acct.subtype === 'mortgage' || acct.subtype === 'home equity' ? { assetName: name || 'Home' } : {}),
      };
    }
    ctx.accounts.push(acct);
  });
}

/**
 * No dialect matched at all → best-effort generic mapping. Row 0 is the
 * header; the left-most non-numeric column is the name, the column whose data
 * cells most often parse as money is the balance. Everything unmapped is
 * named in a CSV_UNMAPPED_COLUMNS warning. No money-ish column → nothing to
 * import; say so instead of inventing zeros.
 */
function bestEffortAccounts(rows, fname, fileIdx, ctx) {
  const headers = rows[0].map(normHeader);
  const data = rows.slice(1);
  const width = Math.max(headers.length, ...data.map((r) => r.length), 0);
  let balanceIdx = -1;
  let bestScore = 0;
  for (let c = width - 1; c >= 0; c--) {
    const score = data.reduce((n, r) => n + (moneyCell(r[c]) != null ? 1 : 0), 0);
    if (score > bestScore || (score === bestScore && score > 0 && balanceIdx < 0)) { bestScore = score; balanceIdx = c; }
  }
  let nameIdx = -1;
  for (let c = 0; c < width; c++) {
    if (c === balanceIdx) continue;
    const texty = data.reduce((n, r) => n + (str(r[c]) && moneyCell(r[c]) == null ? 1 : 0), 0);
    if (texty > 0) { nameIdx = c; break; }
  }
  if (balanceIdx < 0 || !data.length) {
    ctx.warnings.push(warning('CSV_UNMAPPED_COLUMNS', 'warn',
      `CSV file "${fname}" matched no known dialect and no column parses as money — nothing imported. Columns seen: ${headers.filter(Boolean).map((c) => `"${c}"`).join(', ') || '(none)'}.`));
    ctx.unmapped.push({ file: fname, unmappedColumns: headers, reason: 'no dialect, no money column' });
    return;
  }
  const missed = headers.filter((h, i) => h && i !== balanceIdx && i !== nameIdx);
  ctx.warnings.push(warning('CSV_UNMAPPED_COLUMNS', 'warn',
    `CSV file "${fname}" matched no known dialect — best-effort import used "${headers[nameIdx] ?? `column ${nameIdx + 1}`}" as the name and "${headers[balanceIdx] ?? `column ${balanceIdx + 1}`}" as the balance.${missed.length ? ` Unmapped column(s): ${missed.map((c) => `"${c}"`).join(', ')}.` : ''}`));
  if (missed.length) ctx.unmapped.push({ file: fname, unmappedColumns: missed });
  data.forEach((r, rowIdx) => {
    const balance = moneyCell(r[balanceIdx]);
    if (balance == null) return;
    const name = nameIdx >= 0 ? str(r[nameIdx]) : '';
    const id = ctx.uniqueId(`csv:${fileIdx}:${rowIdx}`);
    const hint = csvKind(name);
    const cls = hint ? classify(hint[0], hint[1]) : { accountClass: 'investment', taxTreatment: 'taxable' };
    ctx.warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
      `CSV account "${name || id}" in "${fname}" ${hint ? 'typed from its name' : 'has no recognizable type — imported as a taxable investment'} → ${cls.accountClass}/${cls.taxTreatment} (best-effort file mapping).`, id));
    const isDebt = cls.accountClass === 'loan' || cls.accountClass === 'credit';
    ctx.accounts.push({
      id,
      name: name || undefined,
      class: cls.accountClass,
      subtype: hint ? String(hint[1] ?? '').toLowerCase() : '',
      taxTreatment: cls.taxTreatment,
      balance: isDebt ? Math.abs(balance) : balance,
      currency: 'USD',
      ownerIndex: 0,
      ...(isDebt ? { liability: { rate: undefined } } : {}),
    });
  });
}

// ── cell helpers ─────────────────────────────────────────────────────────────
const low = (x) => String(x ?? '').trim().toLowerCase();
const str = (x) => String(x ?? '').trim();
const slug = (x) => low(x).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'acct';
const intOr0 = (x) => (Number.isInteger(Number(str(x))) && str(x) !== '' ? Number(str(x)) : 0);

/**
 * Parse a money-ish cell → number, or undefined when it isn't one. Handles
 * "$1,234.56", " 1234 ", "(1,850.00)" (accounting negative), "-500", "5.5%",
 * and treats "--" / "n/a" / "" as absent. Never returns NaN/Infinity.
 */
export function moneyCell(v) {
  if (v == null) return undefined;
  let s = String(v).trim();
  if (!s || s === '--' || /^n\/?a$/i.test(s)) return undefined;
  let neg = false;
  const paren = s.match(/^\((.*)\)$/);
  if (paren) { neg = true; s = paren[1]; }
  s = s.replace(/[$\s,]/g, '').replace(/%$/, '');
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d*\.?\d+$/.test(s)) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return neg ? -n : n;
}

/** Rate cells are percentages ("5.25%" or "5.25") → fraction, like pct(). */
function rateCell(v) {
  const n = moneyCell(v);
  return n == null ? undefined : n / 100;
}

/**
 * Map a free-text type/name → generic [type, subtype] that classify()
 * consumes (the CSV analogue of FIN_TYPE/MX_TYPE, regex-based because CSV
 * cells are human-typed). Returns undefined when nothing is recognizable.
 */
function csvKind(s) {
  const t = low(s).replace(/[()]/g, ''); // "401(k)" → "401k"
  if (!t) return undefined;
  if (/home equity|heloc/.test(t)) return ['loan', 'home equity'];
  if (/mortgage/.test(t)) return ['loan', 'mortgage'];
  if (/student/.test(t)) return ['loan', 'student'];
  if (/(auto|car|vehicle).*(loan|note)|loan.*(auto|car)/.test(t)) return ['loan', 'auto'];
  if (/credit card|creditcard|visa|mastercard|amex|discover card/.test(t)) return ['credit', 'credit card'];
  if (/line of credit/.test(t)) return ['credit', 'line of credit'];
  if (/\bloan\b/.test(t)) return ['loan', undefined];
  if (/checking|savings|money market|certificate|\bcd\b|cash management/.test(t)) return ['depository', t];
  if (/hsa|health savings/.test(t)) return ['investment', 'hsa'];
  if (/529|coverdell|education/.test(t)) return ['investment', '529'];
  if (/annuity/.test(t)) return ['investment', 'tax-deferred']; // pre-tax wrapper, flavor unknown → low confidence in classify()
  if (/roth/.test(t)) return ['investment', t]; // roth ira / roth 401k — classify() reads the word
  if (/401|403b|457b|\bira\b|sep|simple|keogh|tsp|pension|retirement|rollover/.test(t)) return ['investment', t];
  if (/brokerage|invest|taxable|mutual fund|stock|etf|crypto/.test(t)) return ['investment', t];
  return undefined;
}

/**
 * CSV positions carry no security-type field — infer the canonical assetType
 * from ticker/description keywords. Defaults to 'equity' (a positions row is
 * a security by construction).
 */
function csvAssetType(symbol, name) {
  const s = `${low(symbol)} ${low(name)}`;
  if (/bitcoin|ethereum|crypto|\bbtc\b|\beth\b/.test(s)) return 'crypto';
  if (/money market|spaxx|fdrxx|swvxx|vmfxx|\bcash\b/.test(s)) return 'cash';
  if (/\betf\b|ishares|spdr/.test(s)) return 'etf';
  if (/bond|treasury|fixed income/.test(s)) return 'bond';
  if (/fund|index|admiral|instl/.test(s)) return 'mutual_fund';
  return 'equity';
}
