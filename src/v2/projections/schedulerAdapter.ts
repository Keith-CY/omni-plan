import { scheduleProject } from "@/domain/scheduler";
import type {
  Dependency,
  Project,
  ScheduleResult,
  WorkItem,
} from "@/domain/types";

import type {
  BetVersion,
  DailyCommitment,
  ProjectDependency,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "../domain/types";

function isValidIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function activeBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
): BetVersion | undefined {
  if (project.activeBetId === undefined) return undefined;
  return workspace.bets.find(
    (candidate) =>
      candidate.id === project.activeBetId &&
      candidate.projectId === project.id &&
      candidate.invalidatedAt === undefined,
  );
}

export function projectToSchedulerInput(
  workspace: WorkspaceV2,
  project: ProjectV2,
): Project | undefined {
  const bet = activeBet(workspace, project);
  const brief = workspace.directionBriefs.find(
    (candidate) =>
      candidate.id === project.activeDirectionBriefId &&
      candidate.projectId === project.id,
  );
  if (
    bet === undefined ||
    brief === undefined ||
    !isValidIso(bet.appetiteStart) ||
    !isValidIso(bet.appetiteEnd) ||
    Date.parse(bet.appetiteEnd) <= Date.parse(bet.appetiteStart)
  ) {
    return undefined;
  }

  return {
    id: project.id,
    name: project.name,
    status: "active",
    mode: "build",
    priority: project.priority,
    northStar: brief.successEvidence,
    currentOutcome: brief.audienceAndProblem,
    horizon: bet.appetiteEnd,
    start: bet.appetiteStart,
    reviewCadenceDays: 7,
  };
}

export function workItemToSchedulerInput(item: ProjectWorkItem): WorkItem {
  const {
    revision: _revision,
    betScopeId,
    resultStatus: _resultStatus,
    outcomeNote: _outcomeNote,
    ...shared
  } = structuredClone(item);
  return { ...shared, shapeUpScopeId: betScopeId };
}

function dependencyToSchedulerInput(
  dependency: ProjectDependency,
): Dependency {
  const { revision: _revision, ...shared } = structuredClone(dependency);
  return shared;
}

function localDateAt(value: string, timeZone: string): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    return year === undefined || month === undefined || day === undefined
      ? undefined
      : `${year}-${month}-${day}`;
  } catch {
    return undefined;
  }
}

function currentCommitments(
  workspace: WorkspaceV2,
  now: string,
): DailyCommitment[] {
  const supersededIds = new Set(
    workspace.dailyCommitments
      .map(({ supersedesId }) => supersedesId)
      .filter((id): id is string => id !== undefined),
  );
  return workspace.dailyCommitments.filter(
    (commitment) =>
      !supersededIds.has(commitment.id) &&
      localDateAt(now, commitment.capacitySnapshot.timeZone) ===
        commitment.localDate,
  );
}

function committedWorkItemIds(
  commitments: DailyCommitment[],
  projectId: string,
): Set<string> {
  return new Set(
    commitments.flatMap(({ slots }) =>
      slots.flatMap(({ target }) =>
        target.kind === "work_item" && target.projectId === projectId
          ? [target.workItemId]
          : [],
      ),
    ),
  );
}

function projectIsExecutable(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  now: string,
): boolean {
  if (
    (project.stage !== "planning" && project.stage !== "executing") ||
    !isValidIso(now) ||
    Date.parse(now) >= Date.parse(bet.appetiteEnd)
  ) {
    return false;
  }
  if (
    project.holds.some(
      ({ type }) => type === "migration_review" || type === "rebet_required",
    )
  ) {
    return false;
  }

  return !project.holds.some(
    ({ type, affectedRecordIds }) =>
      type === "sync_conflict" &&
      [project.id, bet.id, project.activePlanVersionId]
        .filter((id): id is string => id !== undefined)
        .some((id) => affectedRecordIds.includes(id)),
  );
}

function unsupportedCrossProjectDependencies(
  workspace: WorkspaceV2,
  projectId: string,
): string[] {
  const itemProject = new Map(
    workspace.workItems.map((item) => [item.id, item.projectId]),
  );
  return workspace.dependencies
    .filter((dependency) => {
      const fromProject = itemProject.get(dependency.fromId);
      const toProject = itemProject.get(dependency.toId);
      return (
        dependency.projectId === projectId &&
        fromProject !== undefined &&
        toProject !== undefined &&
        (fromProject !== projectId || toProject !== projectId)
      );
    })
    .map(
      ({ id }) => `Cross-project dependency ${id} is unsupported in V2.`,
    )
    .sort();
}

function workItemsForBet(
  workspace: WorkspaceV2,
  projectId: string,
  bet: BetVersion,
): ProjectWorkItem[] {
  const scopeIds = new Set(bet.committedScope.map(({ id }) => id));
  return workspace.workItems.filter(
    (item) => item.projectId === projectId && scopeIds.has(item.betScopeId),
  );
}

export function workItemsInActiveBet(
  workspace: WorkspaceV2,
  projectId: string,
): ProjectWorkItem[] {
  const project = workspace.projects.find(({ id }) => id === projectId);
  if (project === undefined) return [];
  const bet = activeBet(workspace, project);
  return bet === undefined ? [] : workItemsForBet(workspace, projectId, bet);
}

function scheduledWorkItems(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  now: string,
): ProjectWorkItem[] {
  let items = workItemsForBet(workspace, project.id, bet);

  const commitments = currentCommitments(workspace, now);
  if (project.holds.some(({ type }) => type === "review_overdue")) {
    const committedIds = committedWorkItemIds(commitments, project.id);
    items = items.filter(({ id }) => committedIds.has(id));
  }

  const conflictingCommitmentIds = new Set(
    project.holds.flatMap(({ type, affectedRecordIds }) =>
      type === "sync_conflict"
        ? affectedRecordIds.filter((recordId) =>
            workspace.dailyCommitments.some(({ id }) => id === recordId),
          )
        : [],
    ),
  );
  if (conflictingCommitmentIds.size > 0) {
    const conflictedWorkItemIds = committedWorkItemIds(
      workspace.dailyCommitments.filter(({ id }) =>
        conflictingCommitmentIds.has(id),
      ),
      project.id,
    );
    items = items.filter(({ id }) => !conflictedWorkItemIds.has(id));
  }

  return items;
}

function scheduleEligibleProject(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now: string,
): ScheduleResult | undefined {
  const bet = activeBet(workspace, project);
  const projectedProject = projectToSchedulerInput(workspace, project);
  if (
    bet === undefined ||
    projectedProject === undefined ||
    !projectIsExecutable(workspace, project, bet, now)
  ) {
    return undefined;
  }

  const items = scheduledWorkItems(workspace, project, bet, now);
  const itemIds = new Set(items.map(({ id }) => id));
  const dependencies = workspace.dependencies.filter(
    (dependency) =>
      dependency.projectId === project.id &&
      itemIds.has(dependency.fromId) &&
      itemIds.has(dependency.toId),
  );
  const result = scheduleProject(
    projectedProject,
    items.map(workItemToSchedulerInput),
    dependencies.map(dependencyToSchedulerInput),
  );
  return {
    ...result,
    unsupported: [
      ...result.unsupported,
      ...unsupportedCrossProjectDependencies(workspace, project.id),
    ],
  };
}

export function scheduleV2Project(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): ScheduleResult | undefined {
  const project = workspace.projects.find(({ id }) => id === projectId);
  return project === undefined
    ? undefined
    : scheduleEligibleProject(workspace, project, now);
}

export function scheduleExecutablePortfolio(
  workspace: WorkspaceV2,
  now: string,
): ScheduleResult[] {
  return [...workspace.projects]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((project) => {
      const result = scheduleEligibleProject(workspace, project, now);
      return result === undefined ? [] : [result];
    });
}
