import { schedulePortfolio, scheduleProject } from "@/domain/scheduler";
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
import { localDateAt } from "../domain/localTime";

function isValidIso(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function activeBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
): BetVersion | undefined {
  if (project.activeBetId === undefined) return undefined;
  const currentBets = workspace.bets.filter(
    (candidate) =>
      candidate.projectId === project.id && candidate.invalidatedAt === undefined,
  );
  return currentBets.length === 1 && currentBets[0].id === project.activeBetId
    ? currentBets[0]
    : undefined;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function compareCommitmentRecency(
  left: DailyCommitment,
  right: DailyCommitment,
): number {
  const leftCommittedAt = Date.parse(left.committedAt);
  const rightCommittedAt = Date.parse(right.committedAt);
  const leftHasValidTime = Number.isFinite(leftCommittedAt);
  const rightHasValidTime = Number.isFinite(rightCommittedAt);
  const timeOrder =
    leftHasValidTime && rightHasValidTime
      ? rightCommittedAt - leftCommittedAt
      : leftHasValidTime
        ? -1
        : rightHasValidTime
          ? 1
          : 0;
  return (
    right.version - left.version ||
    timeOrder ||
    compareText(left.id, right.id) ||
    compareText(
      JSON.stringify(canonicalValue(left)),
      JSON.stringify(canonicalValue(right)),
    )
  );
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
  const winnersByLocalDate = new Map<string, DailyCommitment>();
  for (const commitment of workspace.dailyCommitments) {
    if (supersededIds.has(commitment.id)) continue;
    const currentWinner = winnersByLocalDate.get(commitment.localDate);
    if (
      currentWinner === undefined ||
      compareCommitmentRecency(commitment, currentWinner) < 0
    ) {
      winnersByLocalDate.set(commitment.localDate, commitment);
    }
  }
  const candidates = [...winnersByLocalDate.values()].filter(
    (commitment) =>
      localDateAt(now, commitment.capacitySnapshot.timeZone) ===
      commitment.localDate,
  );
  const current = [...candidates].sort(compareCommitmentRecency)[0];
  return current === undefined ? [] : [current];
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

function committedWorkItemRevisions(
  commitments: DailyCommitment[],
  projectId: string,
): Map<string, Set<number>> {
  const revisions = new Map<string, Set<number>>();
  for (const commitment of commitments) {
    for (const slot of commitment.slots) {
      if (
        slot.target.kind !== "work_item" ||
        slot.target.projectId !== projectId
      ) {
        continue;
      }
      const itemRevisions = revisions.get(slot.target.workItemId) ?? new Set();
      itemRevisions.add(slot.targetRevision);
      revisions.set(slot.target.workItemId, itemRevisions);
    }
  }
  return revisions;
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
    const committedRevisions = committedWorkItemRevisions(
      commitments,
      project.id,
    );
    items = items.filter(({ id, revision }) =>
      committedRevisions.get(id)?.has(revision),
    );
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

interface ExecutableSchedulerProjection {
  project: Project;
  workItems: WorkItem[];
  dependencies: Dependency[];
  unsupported: string[];
}

function executableSchedulerProjection(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now: string,
): ExecutableSchedulerProjection | undefined {
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
  return {
    project: projectedProject,
    workItems: items.map(workItemToSchedulerInput),
    dependencies: dependencies.map(dependencyToSchedulerInput),
    unsupported: unsupportedCrossProjectDependencies(workspace, project.id),
  };
}

function scheduleEligibleProject(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now: string,
): ScheduleResult | undefined {
  const projection = executableSchedulerProjection(workspace, project, now);
  if (projection === undefined) return undefined;
  const result = scheduleProject(
    projection.project,
    projection.workItems,
    projection.dependencies,
  );
  return {
    ...result,
    unsupported: [...result.unsupported, ...projection.unsupported],
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
  const projections = [...workspace.projects]
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((project) => {
      const projection = executableSchedulerProjection(
        workspace,
        project,
        now,
      );
      return projection === undefined ? [] : [projection];
    });
  const unsupportedByProject = new Map(
    projections.map(({ project, unsupported }) => [project.id, unsupported]),
  );
  return schedulePortfolio(
    projections.map(({ project }) => project),
    projections.flatMap(({ workItems }) => workItems),
    projections.flatMap(({ dependencies }) => dependencies),
  ).map((result) => ({
    ...result,
    unsupported: [
      ...result.unsupported,
      ...(unsupportedByProject.get(result.projectId) ?? []),
    ],
  }));
}
