/**
 * canonical.ts — the Canonical Financial Profile (CFP): the provider-neutral
 * contract every import adapter emits and the single Planfi mapper consumes.
 *
 * See docs/IMPORT_ADAPTERS.md for the architecture. This file is the contract
 * (types only, zero dependencies) so it can anchor the open-source SDK.
 *
 *   Plaid/MX/OFX raw  ──SourceAdapter.normalize()──►  CanonicalFinancialProfile
 *   CanonicalFinancialProfile  ──toPlanfiPlan()──►  generate_financial_plan wire
 */

/** Broad account family, provider-independent. */
export type AccountClass = 'depository' | 'investment' | 'loan' | 'credit' | 'property';

/**
 * Stable machine-readable warning codes (v0.2.0). Codes are append-only: a
 * released code never changes meaning, so callers can switch on them safely.
 * Human `message` text may improve between versions; `code` will not.
 */
export type WarningCode =
  | 'CLASSIFICATION_GUESSED'      // account type/subtype ambiguous → treatment guessed
  | 'NO_COST_BASIS'               // institution reported a holding without cost basis
  | 'COARSE_INFERENCE'            // contribution inference ran on unlabeled transactions
  | 'CONTRIBUTION_CLAMPED'        // inferred contribution exceeded the IRS limit → clamped
  | 'CONTRIBUTION_IMPLAUSIBLE'    // inferred savings rate implausibly high vs known salary
  | 'HSA_FOLDED_INTO_PORTFOLIO'   // HSA balance folded into stocks total (no wire HSA balance field)
  | 'HSA_COVERAGE_ASSUMED'        // HSA coverage type unknowable → assumed 'family'
  | 'IRA_SPLIT_ASSUMED'           // trad+Roth IRA contributions → one 'both' block (engine models 50/50)
  | 'HOME_VALUE_ESTIMATED'        // no property value in source → estimated at 80% LTV
  | 'MORTGAGE_SKIPPED'            // mortgage had no balance or home value → dropped
  | 'NEGATIVE_BALANCE_CLAMPED'    // negative asset balance clamped to $0
  | 'DEBT_RATE_MISSING';          // debt has no APR in source → modeled at 0%

/** One structured warning. Emitted by adapters (via CFP meta) and the mapper. */
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
 * emitted in deterministic order (earner demographics, then per-account asks
 * in account order, then plan-level goals).
 */
export interface NeedsInput {
  field: NeedsInputField;
  /** Provider account id, for account-scoped asks (home_value, debt_rate). */
  accountId?: string;
  accountName?: string;
  /** 0-based earner index, for demographic asks in multi-earner households. */
  earnerIndex?: number;
  /** Short human label, ready for a form ("Home value for Home mortgage"). */
  label: string;
  /** One sentence: why the import couldn't supply this. */
  why: string;
}

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
  /** Total cost basis (engine-only on import — see docs Gaps). */
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

/**
 * Planning context aggregators usually CAN'T supply (age, goals, salary).
 * Populated from onboarding and merged over the imported accounts. Fields left
 * undefined surface in the mapper's `needsInput` list.
 */
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

export interface CanonicalFinancialProfile {
  /** Adapter source id: 'plaid' | 'mx' | 'ofx' | 'kaggle' | ... */
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

/**
 * The contract implemented once per provider. `normalize` does ONLY that
 * provider's quirk-mapping into the CFP; all Planfi domain logic lives
 * downstream in `toPlanfiPlan`, written once and shared across every adapter.
 */
export interface SourceAdapter<Raw = unknown> {
  readonly source: string;
  normalize(raw: Raw): CanonicalFinancialProfile;
}
