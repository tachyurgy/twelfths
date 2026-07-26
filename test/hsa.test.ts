import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  contributionLimit, qualifiesAsHDHP, eligibilityIssues, excessContribution,
  testingPeriodOutcome, substantiate, InvalidCoverageError,
  type PlanYear, type Member, type Plan, type Tier, type MerchantCategory,
} from "../src/domain/hsa.js";

const PY: PlanYear = {
  year: 2026, selfOnly: 4400, family: 8750, catchUp: 1000,
  minDeductibleSelf: 1700, minDeductibleFamily: 3400, maxOopSelf: 8500, maxOopFamily: 17000,
};

const twelve = (t: Tier): Tier[] => Array(12).fill(t);

const member = (over: Partial<Member> = {}): Member => ({
  name: "Test", age: 40,
  medicareEnrolled: false, otherHealthCoverage: false, spouseGeneralFSA: false,
  claimedAsDependent: false, testingPeriodFailed: false,
  monthlyCoverage: twelve("family"),
  ...over,
});

describe("contribution limits", () => {
  test("full-year family with catch-up equals the statutory sum", () => {
    const l = contributionLimit(member({ age: 57 }), PY);
    assert.equal(l.limit, PY.family + PY.catchUp);
    assert.equal(l.eligibleMonths, 12);
    assert.equal(l.usedLastMonthRule, false, "a full year needs no last-month rule");
  });

  test("full-year self-only under 55 gets no catch-up", () => {
    const l = contributionLimit(member({ age: 40, monthlyCoverage: twelve("self") }), PY);
    assert.equal(l.limit, PY.selfOnly);
    assert.equal(l.catchUp, 0);
    assert.equal(l.catchUpEligible, false);
  });

  test("catch-up begins at exactly 55", () => {
    assert.equal(contributionLimit(member({ age: 54 }), PY).catchUpEligible, false);
    assert.equal(contributionLimit(member({ age: 55 }), PY).catchUpEligible, true);
  });

  test("proration sums twelfths at each month's own tier", () => {
    // Six eligible months: three self-only, three family, aged 57 so catch-up prorates too.
    const coverage: Tier[] = [null, null, null, null, null, null, "self", "self", "self", "family", "family", "family"];
    const l = contributionLimit(member({ age: 57, monthlyCoverage: coverage }), PY, { useLastMonthRule: false });

    const expected = (3 * PY.selfOnly) / 12 + (3 * PY.family) / 12 + (6 * PY.catchUp) / 12;
    assert.equal(l.limit, Math.round(expected * 100) / 100);
    assert.equal(l.eligibleMonths, 6);
  });

  test("the annual figure is NOT simply December's tier when months differ", () => {
    const coverage: Tier[] = [null, null, null, null, null, null, "self", "self", "self", "family", "family", "family"];
    const l = contributionLimit(member({ age: 40, monthlyCoverage: coverage }), PY, { useLastMonthRule: false });
    assert.notEqual(l.limit, PY.family, "using December's tier for the whole year would be wrong");
    assert.ok(l.limit < PY.family);
  });

  test("last-month rule lifts a partial year to the full annual figure and opens a testing period", () => {
    const coverage: Tier[] = [null, null, null, null, null, null, "self", "self", "self", "family", "family", "family"];
    const m = member({ age: 57, monthlyCoverage: coverage });

    const withRule = contributionLimit(m, PY);
    const without = contributionLimit(m, PY, { useLastMonthRule: false });

    assert.equal(withRule.usedLastMonthRule, true);
    assert.equal(withRule.limit, PY.family + PY.catchUp);
    assert.ok(withRule.limit > without.limit);
    assert.equal(withRule.testingPeriodEnds, "2027-12-31");
  });

  test("last-month rule is unavailable when December is not covered", () => {
    const coverage: Tier[] = ["family", "family", "family", "family", "family", "family", null, null, null, null, null, null];
    const l = contributionLimit(member({ monthlyCoverage: coverage }), PY);
    assert.equal(l.lastMonthAvailable, false);
    assert.equal(l.usedLastMonthRule, false);
    assert.equal(l.testingPeriodEnds, null);
  });

  test("last-month rule is not applied when it would not help", () => {
    // Eleven family months already exceed a full self-only year, so switching to
    // December's self-only tier would LOWER the limit. The rule is optional.
    const coverage: Tier[] = [...Array(11).fill("family"), "self"] as Tier[];
    const l = contributionLimit(member({ age: 40, monthlyCoverage: coverage }), PY);
    assert.equal(l.usedLastMonthRule, false);
    assert.ok(l.limit > PY.selfOnly);
  });

  test("no eligible months means no contribution room", () => {
    const l = contributionLimit(member({ monthlyCoverage: twelve(null) }), PY);
    assert.equal(l.limit, 0);
    assert.equal(l.eligibleMonths, 0);
  });

  test("a malformed coverage array raises rather than silently mis-prorating", () => {
    const bad = member({ monthlyCoverage: [null, "family"] as Tier[] });
    assert.throws(() => contributionLimit(bad, PY), InvalidCoverageError);
  });
});

describe("excess and testing period", () => {
  test("excess accrues a 6% excise", () => {
    const e = excessContribution(12_000, 9_750);
    assert.equal(e.excess, 2250);
    assert.equal(e.exciseTax, 135);
    assert.equal(e.overLimit, true);
  });

  test("contributing at the limit produces no excess", () => {
    const e = excessContribution(9_750, 9_750);
    assert.equal(e.excess, 0);
    assert.equal(e.overLimit, false);
  });

  test("failing the testing period claws back the difference plus 10%", () => {
    const coverage: Tier[] = [null, null, null, null, null, null, "self", "self", "self", "family", "family", "family"];
    const m = member({ age: 57, monthlyCoverage: coverage, testingPeriodFailed: true });
    const l = contributionLimit(m, PY);

    const t = testingPeriodOutcome(m, PY, l.limit);
    assert.equal(t.applicable, true);
    assert.equal(t.failed, true);
    assert.equal(t.includedInIncome, Math.round((l.limit - l.prorated) * 100) / 100);
    assert.equal(t.additionalTax, Math.round(t.includedInIncome! * 0.1 * 100) / 100);
  });

  test("the testing period does not apply when the rule was never used", () => {
    const m = member({ age: 57 }); // full year, no last-month rule
    assert.equal(testingPeriodOutcome(m, PY, 9_750).applicable, false);
  });
});

describe("HDHP qualification", () => {
  test("a compliant family plan qualifies", () => {
    const plan: Plan = { coverage: "family", deductible: 3600, outOfPocketMax: 9200, coversPreDeductibleNonPreventive: false };
    assert.equal(qualifiesAsHDHP(plan, PY).qualifies, true);
  });

  test("a deductible below the minimum disqualifies", () => {
    const plan: Plan = { coverage: "family", deductible: 1000, outOfPocketMax: 9200, coversPreDeductibleNonPreventive: false };
    const r = qualifiesAsHDHP(plan, PY);
    assert.equal(r.qualifies, false);
    assert.match(r.failures.join(" "), /below the/);
  });

  test("an out-of-pocket maximum above the ceiling disqualifies", () => {
    const plan: Plan = { coverage: "self", deductible: 2000, outOfPocketMax: 20_000, coversPreDeductibleNonPreventive: false };
    assert.equal(qualifiesAsHDHP(plan, PY).qualifies, false);
  });

  test("a spouse's general-purpose FSA disqualifies the member", () => {
    const issues = eligibilityIssues(member({ spouseGeneralFSA: true }));
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.code, "spouse_fsa");
  });
});

describe("card substantiation", () => {
  const cats: Record<number, MerchantCategory> = {
    8011: { mcc: 8011, label: "Doctors and physicians", presumption: "qualified" },
    5912: { mcc: 5912, label: "Drug stores and pharmacies", presumption: "mixed" },
    5411: { mcc: 5411, label: "Grocery stores", presumption: "unqualified" },
    7997: { mcc: 7997, label: "Health clubs and gyms", presumption: "conditional" },
  };
  const txn = (over: Partial<Parameters<typeof substantiate>[0]> = {}) => ({
    id: "TX", merchant: "M", mcc: 8011, amountCents: 10_000,
    iias: false, matchesCopay: false, matchesRecurring: false, cosmetic: false, dualPurpose: false,
    ...over,
  });

  test("an IIAS merchant auto-approves", () => {
    assert.equal(substantiate(txn({ mcc: 5912, iias: true }), cats).outcome, "AUTO-APPROVED");
  });

  test("a copay match auto-approves", () => {
    assert.equal(substantiate(txn({ matchesCopay: true }), cats).outcome, "AUTO-APPROVED");
  });

  test("a denial beats an auto-approval shortcut", () => {
    // An IIAS-certified terminal can still ring up a cosmetic procedure. Returning
    // early on the IIAS rule would approve it.
    const r = substantiate(txn({ iias: true, cosmetic: true }), cats);
    assert.equal(r.outcome, "DENIED");
    assert.equal(r.rule.id, "cosmetic");
  });

  test("a dual-purpose expense requests documentation even alongside an approval path", () => {
    const r = substantiate(txn({ mcc: 7997, dualPurpose: true, matchesRecurring: true }), cats);
    assert.equal(r.outcome, "DOCS REQUESTED");
    assert.equal(r.rule.id, "lmn_required");
  });

  test("an unqualified category is denied", () => {
    assert.equal(substantiate(txn({ mcc: 5411 }), cats).outcome, "DENIED");
  });

  test("an ordinary provider charge with no shortcut needs a receipt", () => {
    const r = substantiate(txn({ mcc: 8011 }), cats);
    assert.equal(r.outcome, "DOCS REQUESTED");
    assert.equal(r.rule.id, "unmatched");
  });
});
