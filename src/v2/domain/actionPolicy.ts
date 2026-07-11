import type { ActionEligibilityFacts, TriageRecommendation } from "./types";

export const actionRules = [
  {
    code: "ONE_SESSION",
    valid: (facts: ActionEligibilityFacts) => facts.singleSession,
    reason: "Needs more than one working session.",
  },
  {
    code: "TWO_HOUR_LIMIT",
    valid: (facts: ActionEligibilityFacts) => facts.estimateSeconds <= 7_200,
    reason: "Estimate exceeds two hours.",
  },
  {
    code: "NO_DEPENDENCY",
    valid: (facts: ActionEligibilityFacts) => facts.dependencyIds.length === 0,
    reason: "Has a dependency.",
  },
  {
    code: "NO_MILESTONE_EVIDENCE",
    valid: (facts: ActionEligibilityFacts) =>
      !facts.requiresMilestoneEvidence,
    reason: "Requires milestone evidence.",
  },
  {
    code: "ONE_OUTCOME",
    valid: (facts: ActionEligibilityFacts) => facts.outcomeCount === 1,
    reason: "Contains multiple outcomes.",
  },
  {
    code: "KNOWN_SOLUTION",
    valid: (facts: ActionEligibilityFacts) => facts.solutionKnown,
    reason: "Solution path is uncertain.",
  },
] as const;

export function evaluateActionEligibility(
  facts: ActionEligibilityFacts,
): TriageRecommendation {
  const failed = actionRules.filter((rule) => !rule.valid(facts));
  return {
    kind: failed.length === 0 ? "action" : "project",
    ruleCodes: failed.map((rule) => rule.code),
    explanation:
      failed.length === 0
        ? "Fits the lightweight Action boundary."
        : failed.map((rule) => rule.reason).join(" "),
  };
}
