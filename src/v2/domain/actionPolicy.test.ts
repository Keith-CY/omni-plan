import { describe, expect, it } from "vitest";

import type { ActionEligibilityFacts } from "./types";
import { evaluateActionEligibility } from "./actionPolicy";

const ELIGIBLE: ActionEligibilityFacts = {
  singleSession: true,
  estimateSeconds: 7_200,
  dependencyIds: [],
  requiresMilestoneEvidence: false,
  outcomeCount: 1,
  solutionKnown: true,
};

describe("evaluateActionEligibility", () => {
  it("recommends Action only when every deterministic boundary passes", () => {
    expect(evaluateActionEligibility(ELIGIBLE)).toEqual({
      kind: "action",
      ruleCodes: [],
      explanation: "Fits the lightweight Action boundary.",
    });
  });

  it.each([
    {
      name: "one session",
      patch: { singleSession: false },
      code: "ONE_SESSION",
      reason: "Needs more than one working session.",
    },
    {
      name: "two hour limit",
      patch: { estimateSeconds: 7_201 },
      code: "TWO_HOUR_LIMIT",
      reason: "Estimate exceeds two hours.",
    },
    {
      name: "no dependency",
      patch: { dependencyIds: ["dependency-1"] },
      code: "NO_DEPENDENCY",
      reason: "Has a dependency.",
    },
    {
      name: "no milestone evidence",
      patch: { requiresMilestoneEvidence: true },
      code: "NO_MILESTONE_EVIDENCE",
      reason: "Requires milestone evidence.",
    },
    {
      name: "one outcome",
      patch: { outcomeCount: 2 },
      code: "ONE_OUTCOME",
      reason: "Contains multiple outcomes.",
    },
    {
      name: "known solution",
      patch: { solutionKnown: false },
      code: "KNOWN_SOLUTION",
      reason: "Solution path is uncertain.",
    },
  ])("recommends Project when $name fails", ({ patch, code, reason }) => {
    expect(evaluateActionEligibility({ ...ELIGIBLE, ...patch })).toEqual({
      kind: "project",
      ruleCodes: [code],
      explanation: reason,
    });
  });

  it("reports every failed rule in stable policy order", () => {
    expect(
      evaluateActionEligibility({
        singleSession: false,
        estimateSeconds: 7_201,
        dependencyIds: ["dependency-1"],
        requiresMilestoneEvidence: true,
        outcomeCount: 0,
        solutionKnown: false,
      }),
    ).toEqual({
      kind: "project",
      ruleCodes: [
        "ONE_SESSION",
        "TWO_HOUR_LIMIT",
        "NO_DEPENDENCY",
        "NO_MILESTONE_EVIDENCE",
        "ONE_OUTCOME",
        "KNOWN_SOLUTION",
      ],
      explanation:
        "Needs more than one working session. Estimate exceeds two hours. Has a dependency. Requires milestone evidence. Contains multiple outcomes. Solution path is uncertain.",
    });
  });
});
