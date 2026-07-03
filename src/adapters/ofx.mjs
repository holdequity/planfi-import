// ofx.mjs — OFX files → Canonical Financial Profile. The other KEYLESS path:
// OFX (Open Financial Exchange) is the "Download → Quicken/Money" format that
// nearly every US bank/broker still exports, in two syntaxes:
//   - OFX 1.x: SGML — a `KEY:VALUE` header block, then tags whose LEAVES ARE
//     NEVER CLOSED (`<BALAMT>1234.56` on its own line)
//   - OFX 2.x: XML — an XML prolog, then the same tag vocabulary fully closed
//
// Input contract: { content: string (either syntax), owner, asOf }.
//
// The tolerant parser here handles both with one pass (see parseOfx): open
// tags with trailing text are leaves; close tags pop tolerantly (a close with
// no matching open is ignored, unclosed aggregates are fine). It never throws.
//
// What is extracted (per the OFX 2.2 spec sections noted):
//   - BANKMSGSRSV1 → STMTRS (11.4): BANKACCTFROM.ACCTTYPE (CHECKING/SAVINGS/
//     MONEYMRKT/CD/CREDITLINE) + LEDGERBAL.BALAMT → depository accounts
//     (CREDITLINE → credit class); STMTTRN transactions are bank cash flow,
//     NOT savings-rate signal, so they are ignored for contribution inference.
//   - CREDITCARDMSGSRSV1 → CCSTMTRS (11.4.3): card balances. OFX REPORTS CARD
//     BALANCES NEGATIVE (amount owed as a negative ledger balance) — the
//     adapter normalizes to POSITIVE amount owed (|BALAMT|), covered by a test.
//   - INVSTMTMSGSRSV1 → INVSTMTRS (13.9): INVACCTFROM, INVPOSLIST positions
//     (POSSTOCK/POSMF/POSDEBT/POSOTHER → the INVPOS inside each: SECID lookup
//     against SECLISTMSGSRSV1 for ticker/name, UNITS, MKTVAL), INVBAL.AVAILCASH,
//     and INVTRANLIST for contribution inference: INVBANKTRAN deposits are
//     candidate contributions (same growth-exclusion rules as the siblings —
//     INCOME/REINVEST records are growth, unlabeled deposits are counted
//     coarsely + COARSE_INFERENCE); BUY*/SELL* records are internal to the
//     account and never counted.
//
// Honesty rules: OFX CARRIES NO TAX-TREATMENT INFO — an investment statement
// says "brokerage at broker X", never "this is a Roth IRA". Every investment
// account is therefore classified taxable at LOW confidence with a
// CLASSIFICATION_GUESSED warning; nothing is fabricated. OFX also carries no
// account names — accounts are labeled from type + masked ACCTID.
//
// Only OFX quirk-handling lives here; ALL Planfi domain logic stays in
// to-planfi.mjs, shared with every other adapter.
//
// @typedef {import('../canonical').CanonicalFinancialProfile} CFP
// @typedef {import('../canonical').SourceAdapter} SourceAdapter

import { classify } from '../classify.mjs';
import { contributionsByAccount } from '../contributions.mjs';
import { arr, num, defaultAsOf, warning } from '../util.mjs';

// Same inflow/growth split as the CSV/MX/Finicity adapters, plus OFX TRNTYPEs.
const OFX_INFLOW = /transfer|deposit|contribution|payroll|direct dep|\bdep\b|credit|xfer/i;
const OFX_GROWTH = /dividend|interest|capital gain|reinvest|\bdiv\b|\bint\b/i;

/** @implements {SourceAdapter} */
export const ofxAdapter = {
  source: 'ofx',
  /**
   * @param {object} raw - { content: string (OFX 1.x SGML or 2.x XML), owner, asOf }
   * @returns {CFP}
   */
  normalize(raw = {}) {
    const warnings = [];
    const unmapped = [];
    const accounts = [];
    const root = parseOfx(raw.content);
    let statementAsOf; // best DTASOF seen, used when the caller passed no asOf

    // ── security list (SECLISTMSGSRSV1) — UNIQUEID → { ticker, name, type } ──
    const securities = new Map();
    for (const wrapTag of ['STOCKINFO', 'MFINFO', 'DEBTINFO', 'OPTINFO', 'OTHERINFO']) {
      for (const info of findAll(root, wrapTag)) {
        const uid = val(info, 'UNIQUEID');
        if (!uid) continue;
        securities.set(uid, {
          ticker: val(info, 'TICKER'),
          name: val(info, 'SECNAME'),
          assetType: { STOCKINFO: 'equity', MFINFO: 'mutual_fund', DEBTINFO: 'bond', OPTINFO: 'other', OTHERINFO: 'other' }[wrapTag],
        });
      }
    }

    // ── bank statements (STMTRS) ─────────────────────────────────────────────
    for (const stmt of findAll(root, 'STMTRS')) {
      const acctFrom = find(stmt, 'BANKACCTFROM') ?? stmt;
      const acctId = val(acctFrom, 'ACCTID') || `bank:${accounts.length}`;
      const acctType = (val(acctFrom, 'ACCTTYPE') || 'CHECKING').toUpperCase();
      const ledger = find(stmt, 'LEDGERBAL');
      statementAsOf ??= ofxDateIso(val(ledger, 'DTASOF'));
      const balance = num(val(ledger, 'BALAMT') ?? val(find(stmt, 'AVAILBAL'), 'BALAMT'));
      if (acctType === 'CREDITLINE') {
        // A credit line under the bank message set is revolving debt, not cash.
        accounts.push({
          id: acctId,
          name: `Credit line ${mask(acctId)}`,
          class: 'credit',
          subtype: 'line of credit',
          taxTreatment: 'na',
          balance: Math.abs(balance),
          currency: val(stmt, 'CURDEF') || 'USD',
          ownerIndex: 0,
          liability: { rate: undefined }, // OFX bank statements carry no APR
        });
        continue;
      }
      const { accountClass, taxTreatment } = classify('depository', acctType.toLowerCase().replace('moneymrkt', 'money market'));
      accounts.push({
        id: acctId,
        name: `${title(acctType)} ${mask(acctId)}`,
        class: accountClass,
        subtype: acctType.toLowerCase(),
        taxTreatment,
        balance,
        currency: val(stmt, 'CURDEF') || 'USD',
        ownerIndex: 0,
      });
    }

    // ── credit card statements (CCSTMTRS) ────────────────────────────────────
    for (const stmt of findAll(root, 'CCSTMTRS')) {
      const acctId = val(find(stmt, 'CCACCTFROM') ?? stmt, 'ACCTID') || `card:${accounts.length}`;
      const ledger = find(stmt, 'LEDGERBAL');
      statementAsOf ??= ofxDateIso(val(ledger, 'DTASOF'));
      // OFX reports the amount owed as a NEGATIVE ledger balance; the canonical
      // model (and the shared mapper) wants outstanding principal as a
      // positive number — normalize with |x| so a debt can't vanish.
      const owed = Math.abs(num(val(ledger, 'BALAMT')));
      accounts.push({
        id: acctId,
        name: `Credit card ${mask(acctId)}`,
        class: 'credit',
        subtype: 'credit card',
        taxTreatment: 'na',
        balance: owed,
        currency: val(stmt, 'CURDEF') || 'USD',
        ownerIndex: 0,
        liability: { rate: undefined }, // OFX card statements carry no APR → mapper asks via needsInput
      });
    }

    // ── investment statements (INVSTMTRS) ────────────────────────────────────
    let sawUnlabeledDeposit = false;
    const normTxns = [];
    for (const stmt of findAll(root, 'INVSTMTRS')) {
      const acctFrom = find(stmt, 'INVACCTFROM') ?? stmt;
      const acctId = val(acctFrom, 'ACCTID') || `inv:${accounts.length}`;
      const broker = val(acctFrom, 'BROKERID');
      statementAsOf ??= ofxDateIso(val(stmt, 'DTASOF'));

      const holdings = [];
      for (const posTag of ['POSSTOCK', 'POSMF', 'POSDEBT', 'POSOPT', 'POSOTHER']) {
        for (const pos of findAll(stmt, posTag)) {
          const uid = val(pos, 'UNIQUEID');
          const sec = (uid && securities.get(uid)) || {};
          if (uid && !securities.get(uid)) {
            unmapped.push({ ofx: posTag, uniqueId: uid, reason: 'SECID not found in SECLISTMSGSRSV1' });
          }
          holdings.push({
            ticker: sec.ticker || undefined,
            name: sec.name || undefined,
            quantity: num(val(pos, 'UNITS')),
            value: num(val(pos, 'MKTVAL')),
            costBasis: undefined, // OFX positions carry no cost basis
            assetType: sec.assetType
              ?? { POSSTOCK: 'equity', POSMF: 'mutual_fund', POSDEBT: 'bond', POSOPT: 'other', POSOTHER: 'other' }[posTag],
          });
        }
      }
      if (holdings.length) {
        // Structural to the format (not per-institution like the API adapters),
        // so ONE info note per account instead of one per holding.
        warnings.push(warning('NO_COST_BASIS', 'info',
          `${holdings.length} holding(s) in ${mask(acctId)} imported without cost basis — OFX position records don't carry one.`, acctId));
      }

      const availCash = num(val(find(stmt, 'INVBAL'), 'AVAILCASH'));
      const balance = holdings.reduce((n, h) => n + (Number.isFinite(h.value) ? h.value : 0), 0) + availCash;

      // OFX has no tax-treatment vocabulary → taxable at LOW confidence, warned.
      const { accountClass, taxTreatment } = classify('investment', undefined);
      warnings.push(warning('CLASSIFICATION_GUESSED', 'warn',
        `OFX investment account ${mask(acctId)}${broker ? ` at ${broker}` : ''}: OFX carries no tax-treatment info (no way to tell a Roth IRA from a brokerage) — classified ${accountClass}/${taxTreatment} at low confidence. Reclassify if it is a retirement account.`, acctId));

      accounts.push({
        id: acctId,
        institution: broker || undefined,
        name: `Investment ${mask(acctId)}`,
        class: accountClass,
        subtype: '',
        taxTreatment,
        balance,
        currency: val(stmt, 'CURDEF') || 'USD',
        ownerIndex: 0,
        holdings,
      });

      // Contribution inference: money moving INTO the investment account from
      // outside = INVBANKTRAN deposits. INCOME/REINVEST are growth (excluded);
      // BUY*/SELL* are internal (never counted).
      for (const bankTran of findAll(stmt, 'INVBANKTRAN')) {
        const trn = find(bankTran, 'STMTTRN') ?? bankTran;
        const amount = num(val(trn, 'TRNAMT'));
        if (!(amount > 0)) continue;
        const label = `${val(trn, 'TRNTYPE') ?? ''} ${val(trn, 'NAME') ?? ''} ${val(trn, 'MEMO') ?? ''}`.trim();
        if (!label) { sawUnlabeledDeposit = true; }
        else if (OFX_GROWTH.test(label)) continue;
        else if (!OFX_INFLOW.test(label)) continue;
        normTxns.push({
          account_id: acctId,
          subtype: 'contribution',
          amount: -Math.abs(amount),
          date: ofxDateIso(val(trn, 'DTPOSTED')),
        });
      }
    }
    if (sawUnlabeledDeposit) {
      warnings.push(warning('COARSE_INFERENCE', 'warn',
        'OFX contribution inference is coarse: some investment-account deposits carry no TRNTYPE/NAME/MEMO, so ALL such unlabeled deposits were counted as contributions (may include dividends or rollovers). Verify inferred contribution rates.'));
    }
    const contribByAccount = contributionsByAccount(normTxns);
    for (const a of accounts) {
      if (contribByAccount[a.id]) a.estMonthlyContribution = contribByAccount[a.id];
    }

    return {
      source: 'ofx',
      // Prefer the caller's asOf, then the statement's own DTASOF, then NOW.
      asOf: raw.asOf || statementAsOf || defaultAsOf(),
      owner: { ...(raw.owner ?? {}) },
      accounts,
      meta: { warnings, unmapped },
    };
  },
};

// ── tolerant OFX parser ──────────────────────────────────────────────────────

/**
 * Parse OFX text (1.x SGML or 2.x XML) into a tag tree. One pass, one rule
 * set for both syntaxes:
 *   - `<TAG>text` → a LEAF (SGML leaves are never closed; XML's later
 *     `</TAG>` finds nothing open and is ignored)
 *   - `<TAG>` with no trailing text → an AGGREGATE (pushed on the stack)
 *   - `</TAG>` → pops back to the matching open aggregate; ignored when
 *     nothing matches (hostile/truncated input never throws)
 * The `OFXHEADER:...` SGML header block / XML prolog before `<OFX>` is
 * skipped; when no `<OFX>` tag exists the whole text is scanned anyway.
 * @param {string} text
 * @returns {{tag: string, value?: string, children: object[]}}
 */
export function parseOfx(text) {
  let s = String(text ?? '');
  const ofxStart = s.search(/<OFX>/i);
  if (ofxStart >= 0) s = s.slice(ofxStart);
  const root = { tag: 'ROOT', children: [] };
  const stack = [root];
  const re = /<(\/?)([A-Za-z0-9_.]+)[^>]*>([^<]*)/g;
  let m;
  while ((m = re.exec(s))) {
    const closing = m[1] === '/';
    const tag = m[2].toUpperCase();
    const trailing = decodeEntities(m[3]).trim();
    if (closing) {
      // Pop back to the matching open aggregate; tolerate mismatches.
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) { stack.length = i; break; }
      }
    } else if (trailing) {
      stack[stack.length - 1].children.push({ tag, value: trailing, children: [] });
    } else {
      const node = { tag, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
  }
  return root;
}

const decodeEntities = (s) => String(s)
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ');

/** Depth-first search: first descendant with `tag`, or undefined. */
export function find(node, tag) {
  if (!node) return undefined;
  for (const c of node.children ?? []) {
    if (c.tag === tag) return c;
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return undefined;
}

/** Depth-first search: ALL descendants with `tag` (document order). */
export function findAll(node, tag) {
  const out = [];
  const walk = (n) => {
    for (const c of n.children ?? []) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  if (node) walk(node);
  return out;
}

/** Leaf value of the first descendant `tag` under `node`, or undefined. */
const val = (node, tag) => (node ? find(node, tag)?.value : undefined);

/**
 * OFX dates are `YYYYMMDD[HHMMSS[.XXX]][ [gmt offset:TZ] ]` — take the digits
 * and build a UTC ISO string. Unparseable → undefined (never a fabricated date).
 */
export function ofxDateIso(v) {
  const m = String(v ?? '').match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?/);
  if (!m) return undefined;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isFinite(t) && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31
    ? new Date(t).toISOString()
    : undefined;
}

/** "1234567890" → "••7890" — OFX has no account names, only ids. */
const mask = (id) => `••${String(id ?? '').slice(-4)}`;
const title = (s) => String(s ?? '').charAt(0) + String(s ?? '').slice(1).toLowerCase();
