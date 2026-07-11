import type { Id, ISODate } from "@/domain/types";

import { scheduleV2Project } from "../projections/schedulerAdapter";
import type { RejectionCode } from "./errors";
import { transitionLifecycle } from "./lifecycle";
import { stableHash } from "./stableHash";
import type {
  BetVersion,
  CommitmentSlot,
  JsonValue,
  PlanVersion,
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

export class PlanVersionBuildError extends Error {
  readonly gate: string;
  readonly code: RejectionCode;
  readonly permittedNextCommand?: string;
  readonly hold?: ProjectHold;

  constructor(
    reason: string,
    gate: string,
    code: RejectionCode = "INVALID_COMMAND",
    permittedNextCommand?: string,
    hold?: ProjectHold,
  ) {
    super(reason);
    this.name = "PlanVersionBuildError";
    this.gate = gate;
    this.code = code;
    this.permittedNextCommand = permittedNextCommand;
    this.hold = hold;
  }
}

export interface PlanVersionBuildResult {
  plans: PlanVersion[];
  projects: ProjectV2[];
}

export type PlanSemanticSnapshot = Pick<
  PlanVersion,
  | "betId"
  | "workItemRevisions"
  | "dependencyRevisions"
  | "scopeMapping"
  | "scheduleHash"
  | "capacityIndependentDates"
>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function solePlanLeaf(
  workspace: WorkspaceV2,
  projectId: Id,
): PlanVersion | undefined {
  const history = workspace.planVersions
    .filter((plan) => plan.projectId === projectId)
    .sort((left, right) => compareText(left.id, right.id));
  if (history.length === 0) return undefined;
  if (new Set(history.map(({ id }) => id)).size !== history.length) {
    throw new PlanVersionBuildError(
      `Project ${projectId} Plan history repeats an ID.`,
      `project:${projectId}:plan_lineage`,
      "SYNC_CONFLICT",
    );
  }

  const versions = new Set<number>();
  const byId = new Map(history.map((plan) => [plan.id, plan]));
  const supersededIds = new Set<Id>();
  for (const plan of history) {
    if (
      !Number.isInteger(plan.version) ||
      plan.version <= 0 ||
      versions.has(plan.version)
    ) {
      throw new PlanVersionBuildError(
        `Project ${projectId} Plan history has a duplicate or invalid version ${plan.version}.`,
        `project:${projectId}:plan_lineage`,
        "SYNC_CONFLICT",
      );
    }
    versions.add(plan.version);
    if (plan.supersedesId !== undefined) {
      const parent = byId.get(plan.supersedesId);
      if (
        parent === undefined ||
        parent.id === plan.id ||
        plan.version !== parent.version + 1
      ) {
        throw new PlanVersionBuildError(
          `Project ${projectId} Plan ${plan.id} has an invalid supersedes link.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
      supersededIds.add(parent.id);
    } else if (plan.version !== 1) {
      throw new PlanVersionBuildError(
        `Project ${projectId} root Plan ${plan.id} must be version 1.`,
        `project:${projectId}:plan_lineage`,
        "SYNC_CONFLICT",
      );
    }
  }
  const leaves = history.filter((plan) => !supersededIds.has(plan.id));
  if (leaves.length !== 1) {
    throw new PlanVersionBuildError(
      `Project ${projectId} must have exactly one Plan history leaf, found ${leaves.length}.`,
      `project:${projectId}:plan_lineage`,
      "SYNC_CONFLICT",
    );
  }

  const visited = new Set<Id>();
  let cursor: PlanVersion | undefined = leaves[0];
  while (cursor !== undefined) {
    if (visited.has(cursor.id)) {
      throw new PlanVersionBuildError(
        `Project ${projectId} Plan history contains a cycle.`,
        `project:${projectId}:plan_lineage`,
        "SYNC_CONFLICT",
      );
    }
    visited.add(cursor.id);
    cursor =
      cursor.supersedesId === undefined
        ? undefined
        : byId.get(cursor.supersedesId);
  }
  if (visited.size !== history.length) {
    throw new PlanVersionBuildError(
      `Project ${projectId} Plan history is forked or disconnected.`,
      `project:${projectId}:plan_lineage`,
      "SYNC_CONFLICT",
    );
  }
  return leaves[0];
}

function recordsForPlan(
  workspace: WorkspaceV2,
  projectId: Id,
  scheduledIds: Set<Id>,
) {
  const workItems = workspace.workItems
    .filter(
      (item) => item.projectId === projectId && scheduledIds.has(item.id),
    )
    .sort((left, right) => compareText(left.id, right.id));
  const dependencies = workspace.dependencies
    .filter(
      (dependency) =>
        dependency.projectId === projectId &&
        scheduledIds.has(dependency.fromId) &&
        scheduledIds.has(dependency.toId),
    )
    .sort((left, right) => compareText(left.id, right.id));
  return {
    workItemRevisions: Object.fromEntries(
      workItems.map(({ id, revision }) => [id, revision]),
    ),
    dependencyRevisions: Object.fromEntries(
      dependencies.map(({ id, revision }) => [id, revision]),
    ),
    scopeMapping: Object.fromEntries(
      workItems.map(({ id, betScopeId }) => [id, betScopeId]),
    ),
  };
}

export async function buildPlanSemanticSnapshot(
  workspace: WorkspaceV2,
  projectId: Id,
  bet: BetVersion,
  createdAt: ISODate,
): Promise<PlanSemanticSnapshot> {
  const schedule = scheduleV2Project(workspace, projectId, createdAt);
  if (
    schedule === undefined ||
    schedule.items.length === 0 ||
    schedule.diagnostics.some(({ severity }) => severity === "error") ||
    schedule.unsupported.length > 0
  ) {
    throw new PlanVersionBuildError(
      `Project ${projectId} has no executable capacity-independent schedule.`,
      `project:${projectId}:schedule`,
    );
  }
  const scheduled = [...schedule.items].sort((left, right) =>
    compareText(left.workItem.id, right.workItem.id),
  );
  const scheduledIds = new Set(scheduled.map(({ workItem }) => workItem.id));
  const records = recordsForPlan(workspace, projectId, scheduledIds);
  const capacityIndependentDates = Object.fromEntries(
    scheduled.map(({ workItem, start, finish }) => [
      workItem.id,
      { start, finish },
    ]),
  );
  const scheduleHash = await stableHash({
    projectId,
    betId: bet.id,
    workItemRevisions: records.workItemRevisions,
    dependencyRevisions: records.dependencyRevisions,
    scopeMapping: records.scopeMapping,
    capacityIndependentDates,
  } as unknown as JsonValue);
  return {
    betId: bet.id,
    workItemRevisions: records.workItemRevisions,
    dependencyRevisions: records.dependencyRevisions,
    scopeMapping: records.scopeMapping,
    scheduleHash,
    capacityIndependentDates,
  };
}

export async function buildPlanVersionsForCommitment(
  workspace: WorkspaceV2,
  slots: CommitmentSlot[],
  commitmentId: Id,
  actorId: Id,
  createdAt: ISODate,
  mode: "initial" | "replan",
  additionalProjectIds: Id[] = [],
): Promise<PlanVersionBuildResult> {
  const projectIds = [
    ...new Set(
      [
        ...additionalProjectIds,
        ...slots.flatMap(({ target }) =>
          target.kind === "work_item" ? [target.projectId] : [],
        ),
      ],
    ),
  ].sort(compareText);
  const plans: PlanVersion[] = [];
  const projects = structuredClone(workspace.projects);

  for (const projectId of projectIds) {
    const projectIndex = projects.findIndex(({ id }) => id === projectId);
    const project = projectIndex < 0 ? undefined : projects[projectIndex];
    if (project === undefined) {
      throw new PlanVersionBuildError(
        `Project ${projectId} does not exist.`,
        `entity:ProjectV2:${projectId}`,
      );
    }
    const access = resolvePlanningContext(
      workspace,
      projectId,
      createdAt,
      mode === "initial" ? "commit_today" : "accept_replan",
    );
    if (!access.ok) {
      throw new PlanVersionBuildError(
        access.reason,
        access.gate,
        access.code,
        access.permittedNextCommand,
        access.hold,
      );
    }
    const projectSlots = slots.filter(
      ({ target }) =>
        target.kind === "work_item" && target.projectId === projectId,
    );
    for (const slot of projectSlots) {
      if (slot.target.kind !== "work_item") continue;
      const target = slot.target;
      const item = workspace.workItems.find(
        ({ id, projectId: ownerId }) =>
          id === target.workItemId && ownerId === projectId,
      );
      if (item === undefined || item.revision !== slot.targetRevision) {
        throw new PlanVersionBuildError(
          `Committed Work Item ${target.workItemId} revision is stale or missing.`,
          `commitment:${commitmentId}:work_item:${target.workItemId}:revision`,
        );
      }
    }

    const leaf = solePlanLeaf(workspace, projectId);
    if (project.activePlanVersionId !== undefined) {
      if (leaf?.id !== project.activePlanVersionId) {
        throw new PlanVersionBuildError(
          `Project ${projectId} active Plan does not match its unique history leaf.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
      if (
        project.stage !== "executing" ||
        leaf.betId !== access.bet.id
      ) {
        throw new PlanVersionBuildError(
          `Project ${projectId} active Plan is not bound to its executing stage and current Bet.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
      if (mode === "initial") {
        continue;
      }
    } else if (mode === "replan") {
      if (projectSlots.length === 0) {
        const legitimateRebetRemoval =
          project.stage === "planning" &&
          leaf !== undefined &&
          leaf.betId !== access.bet.id;
        if (legitimateRebetRemoval) continue;
        throw new PlanVersionBuildError(
          `Project ${projectId} cannot remove committed work without a valid active Plan lineage.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
      const legitimateFirstPlan =
        project.stage === "planning" &&
        (leaf === undefined || leaf.betId !== access.bet.id);
      if (!legitimateFirstPlan) {
        throw new PlanVersionBuildError(
          `Project ${projectId} has no valid active Plan to supersede.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
    } else {
      const legitimateInitialPlan =
        project.stage === "planning" &&
        (leaf === undefined || leaf.betId !== access.bet.id);
      if (!legitimateInitialPlan) {
        throw new PlanVersionBuildError(
          `Project ${projectId} has no valid active Plan lineage for its current Bet.`,
          `project:${projectId}:plan_lineage`,
          "SYNC_CONFLICT",
        );
      }
    }

    const semanticSnapshot = await buildPlanSemanticSnapshot(
      workspace,
      projectId,
      access.bet,
      createdAt,
    );
    const plan: PlanVersion = {
      id: `plan:${projectId}:${commitmentId}`,
      projectId,
      version: (leaf?.version ?? 0) + 1,
      ...semanticSnapshot,
      actorId,
      createdAt,
      ...(leaf === undefined ? {} : { supersedesId: leaf.id }),
    };
    plans.push(plan);
    const transitioned =
      project.stage === "planning"
        ? transitionLifecycle(project, "first_project_work_committed")
        : { ok: true as const, project };
    if (!transitioned.ok) {
      throw new PlanVersionBuildError(
        `Project ${projectId} cannot enter execution from ${project.stage}.`,
        `project:${projectId}:stage:${project.stage}`,
      );
    }
    projects[projectIndex] = {
      ...transitioned.project,
      activePlanVersionId: plan.id,
      updatedAt: createdAt,
    };
  }

  return { plans, projects };
}

export function resolvePlanningContext(
  workspace: WorkspaceV2,
  projectId: Id,
  now: ISODate,
  commandType: string,
): PlanningContextResult {
  const projectsWithIdentity = workspace.projects.filter(
    ({ id }) => id === projectId,
  );
  if (projectsWithIdentity.length === 0) {
    return {
      ok: false,
      code: "ENTITY_NOT_FOUND",
      reason: `ProjectV2 ${projectId} does not exist.`,
      gate: `entity:ProjectV2:${projectId}`,
      permittedNextCommand: "confirm_project_triage",
    };
  }
  if (projectsWithIdentity.length !== 1) {
    return {
      ok: false,
      code: "SYNC_CONFLICT",
      reason: `ProjectV2 ${projectId} has duplicate records for one identity.`,
      gate: `entity_identity:ProjectV2:${projectId}`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const project = projectsWithIdentity[0];

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
