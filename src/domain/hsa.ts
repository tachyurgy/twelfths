// HSA eligibility, contribution limits and expense substantiation.
//
// Contribution limits are indexed annually, which is why `PlanYear` is a value
// loaded from the database rather than a constant in this file. A custodian that
// hardcodes a limit ships a bug every January. The interesting logic is
// proration, the last-month rule, and the testing period that can retroactively
// disqualify a contribution made in perfectly good faith twelve months earlier.

export type Tier = "self" | "family" | null;

export interface PlanYear {
  year: number;
  selfOnly: number;
  family: number;
  catchUp: number;
  minDeductibleSelf: number;
  minDeductibleFamily: number;
  maxOopSelf: number;
  maxOopFamily: number;
}

export const CATCH_UP_AGE = 55;
export const EXCISE_RATE = 0.06;
export const TESTING_PERIOD_TAX = 0.10;

export interface Plan {
  coverage: "self" | "family";
  deductible: number;
  outOfPocketMax: number;
  coversPreDeductibleNonPreventive: boolean;
}

export interface Member {
  name: string;
  age: number;
  medicareEnrolled: boolean;
  otherHealthCoverage: boolean;
  spouseGeneralFSA: boolean;
  claimedAsDependent: boolean;
  testingPeriodFailed: boolean;
  monthlyCoverage: Tier[]; // exactly 12 entries
}

export class InvalidCoverageError extends Error {
  constructor(len: number) {
    super(`monthlyCoverage must have exactly 12 entries, got ${len}`);
    this.name = "InvalidCoverageError";
  }
}

export interface HDHPResult {
  qualifies: boolean;
  failures: string[];
  minDeductible: number;
  maxOop: number;
}

export function qualifiesAsHDHP(plan: Plan, py: PlanYear): HDHPResult {
  const isFamily = plan.coverage === "family";
  const minDeductible = isFamily ? py.minDeductibleFamily : py.minDeductibleSelf;
  const maxOop = isFamily ? py.maxOopFamily : py.maxOopSelf;

  const failures: string[] = [];
  if (plan.deductible < minDeductible) {
    failures.push(`Deductible $${plan.deductible.toLocaleString()} is below the $${minDeductible.toLocaleString()} minimum for ${plan.coverage} coverage`);
  }
  if (plan.outOfPocketMax > maxOop) {
    failures.push(`Out-of-pocket maximum $${plan.outOfPocketMax.toLocaleString()} exceeds the $${maxOop.toLocaleString()} ceiling`);
  }
  if (plan.coversPreDeductibleNonPreventive) {
    failures.push("Plan pays non-preventive benefits before the deductible is met");
  }
  return { qualifies: failures.length === 0, failures, minDeductible, maxOop };
}

export interface EligibilityIssue { code: string; message: string }

// Disqualifying coverage. Members routinely do not know that a spouse's
// general-purpose FSA counts against the whole family.
export function eligibilityIssues(m: Member): EligibilityIssue[] {
  const out: EligibilityIssue[] = [];
  if (m.medicareEnrolled) out.push({ code: "medicare", message: "Enrolled in Medicare, ineligible from the first month of enrolment" });
  if (m.otherHealthCoverage) out.push({ code: "other_coverage", message: "Covered by an additional non-HDHP health plan" });
  if (m.spouseGeneralFSA) out.push({ code: "spouse_fsa", message: "Spouse's general-purpose health FSA is disqualifying coverage for the whole family" });
  if (m.claimedAsDependent) out.push({ code: "dependent", message: "Claimed as a dependent on another return" });
  return out;
}

export interface LimitResult {
  eligibleMonths: number;
  prorated: number;
  fullYear: number;
  limit: number;
  base: number;
  catchUp: number;
  catchUpEligible: boolean;
  usedLastMonthRule: boolean;
  lastMonthAvailable: boolean;
  testingPeriodEnds: string | null;
  decemberTier: Tier;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Eligibility is determined on the first day of each month, so the annual limit
 * is the sum of twelfths at each month's own tier, not the annual figure for
 * whatever tier the member happens to hold in December.
 */
export function contributionLimit(m: Member, py: PlanYear, opts: { useLastMonthRule?: boolean } = {}): LimitResult {
  if (m.monthlyCoverage.length !== 12) throw new InvalidCoverageError(m.monthlyCoverage.length);
  const useLastMonthRule = opts.useLastMonthRule ?? true;

  const eligibleMonths = m.monthlyCoverage.filter(Boolean).length;
  const catchUpEligible = m.age >= CATCH_UP_AGE;

  const proratedBase = m.monthlyCoverage.reduce<number>((sum, tier) => {
    if (!tier) return sum;
    return sum + (tier === "family" ? py.family : py.selfOnly) / 12;
  }, 0);
  const proratedCatchUp = catchUpEligible ? (py.catchUp / 12) * eligibleMonths : 0;

  // Last-month rule: eligible on 1 December means the member may be treated as
  // eligible for the whole year at December's tier, in exchange for a testing
  // period running through the end of the following year.
  const decemberTier = m.monthlyCoverage[11] ?? null;
  const lastMonthAvailable = useLastMonthRule && decemberTier !== null && eligibleMonths < 12;
  const fullBase = decemberTier === "family" ? py.family : py.selfOnly;
  const fullCatchUp = catchUpEligible ? py.catchUp : 0;

  const useLMR = lastMonthAvailable && fullBase + fullCatchUp > proratedBase + proratedCatchUp;

  const base = useLMR ? fullBase : proratedBase;
  const catchUp = useLMR ? fullCatchUp : proratedCatchUp;

  return {
    eligibleMonths,
    prorated: round2(proratedBase + proratedCatchUp),
    fullYear: round2(fullBase + fullCatchUp),
    limit: round2(base + catchUp),
    base: round2(base),
    catchUp: round2(catchUp),
    catchUpEligible,
    usedLastMonthRule: useLMR,
    lastMonthAvailable,
    testingPeriodEnds: useLMR ? `${py.year + 1}-12-31` : null,
    decemberTier,
  };
}

export interface TestingPeriodResult {
  applicable: boolean;
  failed?: boolean;
  endsOn?: string | null;
  includedInIncome?: number;
  additionalTax?: number;
}

export function testingPeriodOutcome(m: Member, py: PlanYear, contributed: number): TestingPeriodResult {
  const l = contributionLimit(m, py);
  if (!l.usedLastMonthRule) return { applicable: false };
  if (!m.testingPeriodFailed) return { applicable: true, failed: false, endsOn: l.testingPeriodEnds };

  const excess = Math.max(0, contributed - l.prorated);
  return {
    applicable: true, failed: true, endsOn: l.testingPeriodEnds,
    includedInIncome: round2(excess),
    additionalTax: round2(excess * TESTING_PERIOD_TAX),
  };
}

export function excessContribution(contributed: number, limit: number) {
  const excess = Math.max(0, contributed - limit);
  return { excess: round2(excess), exciseTax: round2(excess * EXCISE_RATE), overLimit: excess > 0 };
}

// ---------------------------------------------------------------------------
// Substantiation under IRC 213(d).
// ---------------------------------------------------------------------------

export type Presumption = "qualified" | "mixed" | "unqualified" | "conditional";

export interface MerchantCategory { mcc: number; label: string; presumption: Presumption }

export interface Transaction {
  id: string;
  merchant: string;
  mcc: number;
  amountCents: number;
  iias: boolean;
  matchesCopay: boolean;
  matchesRecurring: boolean;
  cosmetic: boolean;
  dualPurpose: boolean;
}

export type RuleEffect = "auto_approve" | "deny" | "request_docs";

export interface Rule { id: string; label: string; effect: RuleEffect; why: string }

export const RULES: Record<string, Rule> = {
  iias: { id: "iias", label: "IIAS-certified merchant with item-level substantiation", effect: "auto_approve",
    why: "The merchant separated eligible items at the register under an inventory information approval system, so the swipe is already substantiated." },
  copay_match: { id: "copay_match", label: "Amount matches a known plan copay", effect: "auto_approve",
    why: "Copay matching is an IRS-recognised auto-substantiation method." },
  recurring: { id: "recurring", label: "Matches a previously substantiated recurring expense", effect: "auto_approve",
    why: "Same merchant, same amount, same provider as an expense already documented." },
  cosmetic: { id: "cosmetic", label: "Cosmetic procedure", effect: "deny",
    why: "Cosmetic surgery is excluded from 213(d) unless it corrects a deformity from congenital abnormality, injury or disfiguring disease." },
  general_health: { id: "general_health", label: "General health or wellness purchase", effect: "deny",
    why: "Expenses merely beneficial to general health are not medical care." },
  lmn_required: { id: "lmn_required", label: "Qualifies only with a letter of medical necessity", effect: "request_docs",
    why: "Dual-purpose expense: qualified only when prescribed for a specific diagnosed condition." },
  unmatched: { id: "unmatched", label: "No auto-substantiation path", effect: "request_docs",
    why: "Needs an itemised receipt showing provider, date of service, patient and description." },
};

export type Outcome = "AUTO-APPROVED" | "DENIED" | "DOCS REQUESTED";

export interface SubstantiationResult {
  outcome: Outcome;
  rule: Rule;
  fired: Rule[];
  category?: MerchantCategory;
}

/**
 * Rules are evaluated together and resolved by precedence rather than returning
 * on the first match. A denial has to beat an auto-approval shortcut: an
 * IIAS-certified terminal can still ring up a cosmetic procedure, and returning
 * early on `iias` would approve it.
 */
export function substantiate(txn: Transaction, categories: Record<number, MerchantCategory>): SubstantiationResult {
  const category = categories[txn.mcc];
  const fired: Rule[] = [];

  if (txn.iias) fired.push(RULES.iias!);
  if (txn.matchesCopay) fired.push(RULES.copay_match!);
  if (txn.matchesRecurring) fired.push(RULES.recurring!);
  if (txn.cosmetic) fired.push(RULES.cosmetic!);
  if (txn.dualPurpose) fired.push(RULES.lmn_required!);
  if (category?.presumption === "unqualified" && !txn.dualPurpose && !txn.iias) fired.push(RULES.general_health!);

  const denied = fired.find((r) => r.effect === "deny");
  const docs = fired.find((r) => r.effect === "request_docs");
  const approved = fired.find((r) => r.effect === "auto_approve");

  if (denied) return { outcome: "DENIED", rule: denied, fired, category };
  if (approved && !docs) return { outcome: "AUTO-APPROVED", rule: approved, fired, category };
  if (docs) return { outcome: "DOCS REQUESTED", rule: docs, fired, category };
  return { outcome: "DOCS REQUESTED", rule: RULES.unmatched!, fired, category };
}
