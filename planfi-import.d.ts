/**
 * planfi-import.d.ts — hand-written type declarations for the package entry
 * point (src/index.mjs). Self-contained on purpose: the runtime is zero-dep
 * ESM JavaScript, and consumers should get full types without TypeScript
 * having to compile the shipped `src/canonical.ts` (which remains the
 * annotated source of truth these declarations mirror — keep them in sync).
 */

// ── Canonical Financial Profile (mirrors src/canonical.ts) ──────────────────

/** Broad account family, provider-independent. */
export type AccountClass = 'depository' | 'investment' | 'loan' | 'credit' | 'property';

/** Tax treatment of an investment/holding bucket. `na` = not applicable (debt, cash). */
export type TaxTreatment = 'taxable' | 'traditional' | 'roth' | 'hsa' | '529' | 'na';

export type AssetType = 'equity' | 'etf' | 'mutual_fund' | 'bond' | 'cash' | 'crypto' | 'other';

/** One security position inside an investment account. */
export interface CanonicalHolding {
  ticker?: string;
  name?: string;
  quantity?: number;
  /** Market value of the position at `asOf`. */
  value?: number;
  /** Total cost basis, when the institution reported it. */
  costBasis?: number;
  assetType: AssetType;
}

/** Loan/credit detail attached to a `loan` or `credit` account. */
export interface LiabilityDetail {
  /** APR as a fraction, e.g. 0.0625 for 6.25%. */
  rate?: number;
  minPayment?: number;
  monthsRemaining?: number;
  originationPrincipal?: number;
  /** The asset securing the debt (property/vehicle), when known. */
  assetName?: string;
  assetValue?: number;
}

export interface CanonicalAccount {
  /** Stable provider account id — the key for dedup/reconcile across refreshes. */
  id: string;
  institution?: string;
  name?: string;
  class: AccountClass;
  /** Provider subtype normalized to lowercase, e.g. '401k', 'roth ira', 'mortgage'. */
  subtype?: string;
  taxTreatment?: TaxTreatment;
  /** Asset value, or outstanding principal for a liability. */
  balance: number;
  currency?: string;
  holdings?: CanonicalHolding[];
  liability?: LiabilityDetail;
  /** Which earner (0-based) owns this account, for joint households. */
  ownerIndex?: number;
  /** Inferred monthly contribution into this account (from transactions). */
  estMonthlyContribution?: number;
}

/** Planning context aggregators usually CAN'T supply (age, goals, salary). */
export interface OwnerContext {
  age?: number;
  retirementAge?: number;
  annualSalary?: number;
  desiredAnnualSpend?: number;
  /** Two-letter US state for tax settings. */
  filingState?: string;
  /** Per-earner overrides for joint households. */
  earners?: Array<Partial<OwnerContext> & { name?: string }>;
}

// ── Structured results (v0.2.0) ─────────────────────────────────────────────

/**
 * Stable machine-readable warning codes. Append-only: a released code never
 * changes meaning. Message text may improve between versions; codes will not.
 */
export type WarningCode =
  | 'CLASSIFICATION_GUESSED'
  | 'NO_COST_BASIS'
  | 'COARSE_INFERENCE'
  | 'CONTRIBUTION_CLAMPED'
  | 'CONTRIBUTION_IMPLAUSIBLE'
  | 'HSA_FOLDED_INTO_PORTFOLIO'
  | 'HSA_COVERAGE_ASSUMED'
  | 'IRA_SPLIT_ASSUMED'
  | 'HOME_VALUE_ESTIMATED'
  | 'MORTGAGE_SKIPPED'
  | 'NEGATIVE_BALANCE_CLAMPED'
  | 'DEBT_RATE_MISSING'
  | 'CSV_UNMAPPED_COLUMNS'
  | 'CSV_TRANSACTIONS_ONLY';

export interface ImportWarning {
  code: WarningCode;
  /** 'info' = lossless modeling note; 'warn' = a value may be wrong — verify. */
  severity: 'info' | 'warn';
  /** Human-readable explanation, safe to show to an end user. */
  message: string;
  /** Provider account id the warning refers to, when account-scoped. */
  accountId?: string;
}

/** Fields an aggregator cannot supply — collect them from the user. */
export type NeedsInputField =
  | 'age'
  | 'retirement_age'
  | 'annual_salary'
  | 'desired_annual_spend'
  | 'home_value'
  | 'debt_rate';

/**
 * One structured ask. De-duplicated on (field, accountId, earnerIndex) and
 * emitted in deterministic order.
 */
export interface NeedsInput {
  field: NeedsInputField;
  /** Provider account id, for account-scoped asks (home_value, debt_rate). */
  accountId?: string;
  accountName?: string;
  /** 0-based earner index, for demographic asks in multi-earner households. */
  earnerIndex?: number;
  /** Short human label, ready for a form. */
  label: string;
  /** One sentence: why the import couldn't supply this. */
  why: string;
}

export interface CanonicalFinancialProfile {
  /** Adapter source id: 'plaid' | 'mx' | 'finicity' | 'fdx' | ... */
  source: string;
  /** ISO timestamp of the underlying snapshot. */
  asOf: string;
  owner: OwnerContext;
  accounts: CanonicalAccount[];
  meta: {
    /** Structured notes: guessed classifications, dropped/partial data. */
    warnings: ImportWarning[];
    /** Raw provider entities that couldn't be mapped — never silently dropped. */
    unmapped: unknown[];
  };
}

/** The contract implemented once per provider. */
export interface SourceAdapter<Raw = unknown> {
  readonly source: string;
  normalize(raw: Raw): CanonicalFinancialProfile;
}

// ── Emitted plan (generate_financial_plan wire body) ────────────────────────
// The body is validated server-side by the engine's Zod schema; typing it
// loosely here keeps this package decoupled from engine releases.
export interface PlanfiPlan {
  name: string;
  earners: Array<{
    name: string;
    age?: number;
    retirement_age?: number;
    annual_salary?: number;
    retirement_accounts?: {
      k401?: { employee_annual: number };
      ira?: { type: 'traditional' | 'roth' | 'both'; annual: number };
      hsa?: { coverage: 'self' | 'family'; annual: number };
    };
  }>;
  stocks: { current_value: number; monthly_contribution: number; annual_return: number };
  cash: { current_value: number; monthly_contribution: number; annual_return: number };
  account_balances: { taxable: number; traditional: number; roth: number };
  real_estate?: Array<{
    name: string;
    current_value: number;
    annual_appreciation: number;
    mortgage?: { balance: number; rate: number; years_remaining: number };
  }>;
  debts?: Array<{ name: string; balance: number; rate: number; min_payment: number; asset_name?: string; asset_value?: number }>;
  speculative?: Array<{ name: string; current_value: number; annual_growth_rate: number }>;
  education_account?: { enabled: boolean; initialBalance: number; monthlyContribution: number };
  tax_settings: { state: string };
  desired_annual_spend?: number;
  [key: string]: unknown;
}

export interface ImportResult {
  /** POST this to /v1/tools/generate_financial_plan. */
  plan: PlanfiPlan;
  warnings: ImportWarning[];
  needsInput: NeedsInput[];
  /** The full canonical profile (ticker/shares/cost-basis preserved). */
  cfp: CanonicalFinancialProfile;
}

export interface ToPlanfiOptions {
  /** Two-letter US state used when the owner context has none. Default 'CA'. */
  defaultState?: string;
}

// ── Functions + adapters (mirrors src/index.mjs exports) ────────────────────

/**
 * One-call import: raw provider payload → { plan, warnings, needsInput, cfp }.
 * @throws if `source` is not a registered adapter id.
 */
export function importToPlan(
  source: 'plaid' | 'mx' | 'finicity' | 'fdx' | 'csv' | 'ofx' | (string & {}),
  raw: object,
  opts?: ToPlanfiOptions,
): ImportResult;

/** The shared mapper: Canonical Financial Profile → wire body + diagnostics. */
export function toPlanfiPlan(
  cfp: CanonicalFinancialProfile,
  opts?: ToPlanfiOptions,
): { plan: PlanfiPlan; warnings: ImportWarning[]; needsInput: NeedsInput[] };

/** Map a provider (type, subtype) to the canonical class + tax treatment. */
export function classify(
  type: string,
  subtype?: string,
): { accountClass: AccountClass; taxTreatment: TaxTreatment; confidence: 'high' | 'medium' | 'low' };

/** Map a provider security type ('etf', 'Mutual Fund', …) → canonical AssetType. */
export function classifyAsset(securityType?: string): AssetType;

/** Infer a monthly contribution rate from investment transactions. */
export function inferMonthlyContribution(
  txns: Array<{ account_id?: string; type?: string; subtype?: string; amount?: number; date?: string }>,
  opts?: { windowMonths?: number },
): number;

/** Group transactions by account_id → inferred monthly contribution each. */
export function contributionsByAccount(
  txns: Array<{ account_id?: string; type?: string; subtype?: string; amount?: number; date?: string }>,
  opts?: { windowMonths?: number },
): Record<string, number>;

export declare const plaidAdapter: SourceAdapter<object>;
export declare const mxAdapter: SourceAdapter<object>;
export declare const finicityAdapter: SourceAdapter<object>;

/**
 * FDX (Financial Data Exchange — the US open-banking standard; Akoya speaks
 * it natively) → CFP. Raw shape: { accounts, holdings?, transactions?, owner?,
 * asOf? } where accounts are FDX Account entities, wrapped
 * ({ depositAccount: {…} } / { investmentAccount: {…} } / { loanAccount: {…} }
 * / { locAccount: {…} }) or already flattened.
 */
export declare const fdxAdapter: SourceAdapter<object>;

/** One CSV file handed to the csv adapter (the keyless path). */
export interface CsvFile {
  /** Used in warnings and as the fallback account name (Schwab positions). */
  name?: string;
  /** Force the mapping; omitted → the header fingerprint decides. */
  kind?: 'accounts' | 'holdings' | 'transactions';
  content: string;
}

/** CSV exports → CFP. Raw shape: { files: CsvFile[], owner?, asOf? }. */
export declare const csvAdapter: SourceAdapter<{ files: CsvFile[]; owner?: OwnerContext; asOf?: string }>;

/** OFX 1.x (SGML) / 2.x (XML) → CFP. Raw shape: { content: string, owner?, asOf? }. */
export declare const ofxAdapter: SourceAdapter<{ content: string; owner?: OwnerContext; asOf?: string }>;

/** Registry of source adapters by id. */
export declare const ADAPTERS: Record<string, SourceAdapter<object>>;
