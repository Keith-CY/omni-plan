import type { LifecycleStage, ProjectV2 } from "./types";

export type LifecycleEvent =
  | "brief_completed"
  | "brief_became_incomplete"
  | "bet_placed"
  | "bet_replaced"
  | "first_project_work_committed"
  | "closure_requested"
  | "validation_requested"
  | "appetite_expired"
  | "validation_satisfied"
  | "abandon_confirmed"
  | "project_closed";

export type LifecycleTransitionResult =
  | { ok: true; project: ProjectV2 }
  | {
      ok: false;
      code: "ILLEGAL_LIFECYCLE_TRANSITION";
      project: ProjectV2;
    };

const transitions: Record<
  LifecycleStage,
  Partial<Record<LifecycleEvent, LifecycleStage>>
> = {
  direction: { brief_completed: "awaiting_bet" },
  awaiting_bet: {
    brief_became_incomplete: "direction",
    bet_placed: "planning",
  },
  planning: {
    bet_replaced: "planning",
    first_project_work_committed: "executing",
    closure_requested: "validating",
    appetite_expired: "validating",
  },
  executing: {
    bet_replaced: "planning",
    validation_requested: "validating",
    appetite_expired: "validating",
  },
  validating: {
    bet_replaced: "planning",
    validation_satisfied: "closing",
    abandon_confirmed: "closing",
  },
  closing: { project_closed: "closed" },
  closed: {},
};

export function transitionLifecycle(
  project: ProjectV2,
  event: LifecycleEvent,
): LifecycleTransitionResult {
  const nextStage = transitions[project.stage][event];

  if (nextStage === undefined) {
    return {
      ok: false,
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      project,
    };
  }

  return {
    ok: true,
    project: { ...project, stage: nextStage },
  };
}
