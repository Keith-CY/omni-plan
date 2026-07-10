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
] as const satisfies readonly (readonly [
  LifecycleStage,
  LifecycleEvent,
  LifecycleStage,
])[];

const lifecycleEventFlags = {
  brief_completed: true,
  brief_became_incomplete: true,
  bet_placed: true,
  bet_replaced: true,
  first_project_work_committed: true,
  closure_requested: true,
  validation_requested: true,
  appetite_expired: true,
  validation_satisfied: true,
  abandon_confirmed: true,
  project_closed: true,
} satisfies Record<LifecycleEvent, true>;

const lifecycleStageFlags = {
  direction: true,
  awaiting_bet: true,
  planning: true,
  executing: true,
  validating: true,
  closing: true,
  closed: true,
} satisfies Record<LifecycleStage, true>;

const lifecycleEvents = Object.keys(lifecycleEventFlags) as LifecycleEvent[];
const lifecycleStages = Object.keys(lifecycleStageFlags) as LifecycleStage[];

function transitionKey(stage: LifecycleStage, event: LifecycleEvent): string {
  return `${stage}:${event}`;
}

const legalTransitionKeys = new Set(
  legalTransitions.map(([stage, event]) => transitionKey(stage, event)),
);
const illegalTransitions = lifecycleStages.flatMap((stage) =>
  lifecycleEvents
    .filter((event) => !legalTransitionKeys.has(transitionKey(stage, event)))
    .map((event) => [stage, event] as const),
);

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
  let result: ReturnType<typeof transitionLifecycle> | undefined;

  expect(() => {
    result = transitionLifecycle(project, event);
  }).not.toThrow();

  expect(result).toEqual({
    ok: false,
    code: "ILLEGAL_LIFECYCLE_TRANSITION",
    project,
  });
  expect(result?.project).toBe(project);
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

  describe("complete illegal transition matrix", () => {
    it.each(illegalTransitions)(
      "%s + %s rejects without mutating the project",
      (stage, event) => {
        expectIllegalTransition(
          buildLifecycleProject(stage, "bet-1"),
          event,
        );
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

  it("rejects an untyped set_stage-style runtime event", () => {
    const event = "set_stage" as LifecycleEvent;

    expectIllegalTransition(buildLifecycleProject("direction", "bet-1"), event);
  });

  it.each(["__proto__", "constructor", "toString"] as const)(
    "rejects the prototype-chain runtime event %s",
    (event) => {
      expectIllegalTransition(
        buildLifecycleProject("direction", "bet-1"),
        event as LifecycleEvent,
      );
    },
  );

  it("rejects a malformed runtime stage without throwing", () => {
    const project = {
      ...buildLifecycleProject("direction", "bet-1"),
      stage: "malformed_stage",
    } as unknown as ProjectV2;

    expectIllegalTransition(project, "brief_completed");
  });

  it.each([
    ["__proto__", "constructor"],
    ["constructor", "prototype"],
    ["toString", "length"],
  ] as const)(
    "rejects the inherited runtime stage %s combined with event %s",
    (stage, event) => {
      const project = {
        ...buildLifecycleProject("direction", "bet-1"),
        stage,
      } as unknown as ProjectV2;

      expectIllegalTransition(project, event as LifecycleEvent);
    },
  );

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
