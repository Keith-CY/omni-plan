import type { Id, ISODate } from "@/domain/types";

import type { RejectionCode } from "./errors";
import type {
  BetVersion,
  ProjectHold,
  ProjectV2,
  WorkspaceV2,
} from "./types";

export interface PlanningContext {
  ok: true;
  project: ProjectV2;
  bet: BetVersion;
}

export interface PlanningContextRejection {
  ok: false;
  code: RejectionCode;
  reason: string;
  gate: string;
  hold?: ProjectHold;
  permittedNextCommand: string;
}

export type PlanningContextResult =
  | PlanningContext
  | PlanningContextRejection;

export function resolvePlanningContext(
  workspace: WorkspaceV2,
  projectId: Id,
  now: ISODate,
  commandType: string,
): PlanningContextResult {
  const project = workspace.projects.find(({ id }) => id === projectId);
  if (project === undefined) {
    return {
      ok: false,
      code: "ENTITY_NOT_FOUND",
      reason: `ProjectV2 ${projectId} does not exist.`,
      gate: `entity:ProjectV2:${projectId}`,
      permittedNextCommand: "confirm_project_triage",
    };
  }

  if (project.stage === "closed") {
    return {
      ok: false,
      code: "PROJECT_CLOSED",
      reason: `Closed Project ${project.id} cannot change its Plan.`,
      gate: `project:${project.id}:closed`,
      permittedNextCommand: "create_follow_up_project",
    };
  }

  const blockingHold =
    project.holds.find(({ type }) => type === "migration_review") ??
    project.holds.find(({ type }) => type === "rebet_required");
  if (blockingHold !== undefined) {
    return {
      ok: false,
      code: "HOLD_BLOCKS_COMMAND",
      reason: `Project hold ${blockingHold.type} blocks command ${commandType}.`,
      gate: `project_hold:${blockingHold.type}`,
      hold: blockingHold.type,
      permittedNextCommand: "place_bet",
    };
  }

  if (project.stage === "direction" || project.stage === "awaiting_bet") {
    return {
      ok: false,
      code: "BET_REQUIRED",
      reason: `Project ${project.id} requires a current Bet before Plan changes.`,
      gate: `project:${project.id}:current_bet`,
      permittedNextCommand: "place_bet",
    };
  }

  if (project.stage !== "planning" && project.stage !== "executing") {
    return {
      ok: false,
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      reason: `Project ${project.id} cannot change its Plan from ${project.stage}.`,
      gate: `project:${project.id}:stage:${project.stage}`,
      permittedNextCommand: "use_legal_lifecycle_command",
    };
  }

  const currentBets = workspace.bets.filter(
    (bet) =>
      bet.projectId === project.id && bet.invalidatedAt === undefined,
  );
  const bet = currentBets.find(({ id }) => id === project.activeBetId);
  if (currentBets.length !== 1 || bet === undefined) {
    return {
      ok: false,
      code: "BET_REQUIRED",
      reason: `Project ${project.id} has no single valid current Bet.`,
      gate: `project:${project.id}:current_bet`,
      permittedNextCommand: "place_bet",
    };
  }

  const nowMilliseconds = Date.parse(now);
  const appetiteEndMilliseconds = Date.parse(bet.appetiteEnd);
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Number.isFinite(appetiteEndMilliseconds)
  ) {
    return {
      ok: false,
      code: "INVALID_COMMAND",
      reason: "Planning requires valid authoritative Bet timestamps.",
      gate: `bet:${bet.id}:appetite_end`,
      permittedNextCommand: commandType,
    };
  }
  if (nowMilliseconds >= appetiteEndMilliseconds) {
    return {
      ok: false,
      code: "BET_EXPIRED",
      reason: `Current Bet ${bet.id} expired at ${bet.appetiteEnd}.`,
      gate: `bet:${bet.id}:appetite_end`,
      permittedNextCommand: "record_bet_boundary",
    };
  }

  return { ok: true, project, bet };
}
