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
    /** Human-readable notes: guessed classifications, dropped/partial data. */
    warnings: string[];
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
