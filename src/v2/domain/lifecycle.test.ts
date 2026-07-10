import { describe, expect, it } from "vitest";

import { buildProjectV2 } from "../tests/builders";
import { transitionLifecycle, type LifecycleEvent } from "./lifecycle";
import type { LifecycleStage, ProjectV2 } from "./types";

const legalTransitions = [
  ["direction", "brief_completed", "awaiting_bet"],
  ["awaiting_bet", "brief_became_incomplete", "direction"],
  ["awaiting_bet", "bet_placed", "planning"],
  ["planning", "bet_replaced", "planning"],
  ["executing", "bet_replaced", "planning"],
  ["validating", "bet_replaced", "planning"],
  ["planning", "first_project_work_committed", "executing"],
  ["planning", "closure_requested", "validating"],
  ["planning", "appetite_expired", "validating"],
  ["executing", "validation_requested", "validating"],
  ["executing", "appetite_expired", "validating"],
  ["validating", "validation_satisfied", "closing"],
  ["validating", "abandon_confirmed", "closing"],
  ["closing", "project_closed", "closed"],
] as const;

const lifecycleEvents = [
  "brief_completed",
  "brief_became_incomplete",
  "bet_placed",
  "bet_replaced",
  "first_project_work_committed",
  "closure_requested",
  "validation_requested",
  "appetite_expired",
  "validation_satisfied",
  "abandon_confirmed",
  "project_closed",
] as const satisfies readonly LifecycleEvent[];

function buildLifecycleProject(
  stage: LifecycleStage,
  activeBetId: ProjectV2["activeBetId"],
): ProjectV2 {
  return buildProjectV2({
    id: "project-1",
    name: "Lifecycle project",
    priority: 7,
    notes: "Preserve every unrelated field",
    stage,
    holds: [
      {
        type: "review_overdue",
        sourceId: "review-1",
        affectedRecordIds: ["work-item-1"],
        createdAt: "2026-07-10T09:01:00.000Z",
      },
    ],
    activeDirectionBriefId: "brief-1",
    ...(activeBetId === undefined ? {} : { activeBetId }),
    activePlanVersionId: "plan-1",
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-10T09:02:00.000Z",
  });
}

function expectIllegalTransition(
  project: ProjectV2,
  event: LifecycleEvent,
): void {
  const originalProject = structuredClone(project);

  const result = transitionLifecycle(project, event);

  expect(result).toEqual({
    ok: false,
    code: "ILLEGAL_LIFECYCLE_TRANSITION",
    project,
  });
  expect(result.project).toBe(project);
  expect(project).toEqual(originalProject);
}

describe("transitionLifecycle", () => {
  describe("legal transition table", () => {
    it.each(legalTransitions)(
      "%s + %s transitions to %s without mutating unrelated project state",
      (from, event, to) => {
        const project = buildLifecycleProject(from, "bet-1");
        const originalProject = structuredClone(project);

        const result = transitionLifecycle(project, event);

        expect(result).toEqual({
          ok: true,
          project: { ...project, stage: to },
        });
        if (!result.ok) {
          throw new Error("Expected a legal lifecycle transition");
        }
        expect(result.project).not.toBe(project);
        expect(result.project.holds).toEqual(project.holds);
        expect(project).toEqual(originalProject);
      },
    );
  });

  it("rejects a direct skip from direction to executing", () => {
    expectIllegalTransition(
      buildLifecycleProject("direction", "bet-1"),
      "first_project_work_committed",
    );
  });

  it("does not let awaiting_bet reach planning without bet_placed", () => {
    expectIllegalTransition(
      buildLifecycleProject("awaiting_bet", "bet-1"),
      "first_project_work_committed",
    );
  });

  it.each(lifecycleEvents)(
    "rejects %s for a closed project and leaves it unchanged",
    (event) => {
      expectIllegalTransition(buildLifecycleProject("closed", "bet-1"), event);
    },
  );

  it("rejects an untyped set_stage-style runtime event", () => {
    const event = "set_stage" as LifecycleEvent;

    expectIllegalTransition(buildLifecycleProject("direction", "bet-1"), event);
  });

  it.each([
    ["preserves an existing Bet reference", "bet-1"],
    ["does not invent a Bet reference", undefined],
  ] as const)("on appetite expiry, %s", (_description, activeBetId) => {
    const project = buildLifecycleProject("executing", activeBetId);
    const hadActiveBetReference = "activeBetId" in project;

    const result = transitionLifecycle(project, "appetite_expired");

    expect(result).toEqual({
      ok: true,
      project: { ...project, stage: "validating" },
    });
    if (!result.ok) {
      throw new Error("Expected appetite expiry to start validation");
    }
    expect(result.project.activeBetId).toBe(activeBetId);
    expect("activeBetId" in result.project).toBe(hadActiveBetReference);
  });
});
