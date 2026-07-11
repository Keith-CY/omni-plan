import type { AttentionKind, Id, ISODate, Seconds } from "@/domain/types";

import { scheduleExecutablePortfolio } from "../projections/schedulerAdapter";
import {
  capacityForLocalDate,
  createCapacityLedger,
  localDateAt,
  placeCandidate,
  type CapacityCandidate,
  type CapacityPlacementReason,
  type LocalDateCapacity,
} from "./localTime";
import { buildPlanSemanticSnapshot } from "./planning";
import { stableHash } from "./stableHash";
import type {
  ActualV2,
  Action,
  BetVersion,
  CapacityProfile,
  CommitmentSlot,
  DailyCommitment,
  JsonValue,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

export interface TodayCandidate extends CapacityCandidate {
  targetId: Id;
  targetRevision: number;
  target: CommitmentSlot["target"];
  durationSeconds: Seconds;
  attention: AttentionKind;
  hasFixedTimeOrHardDeadline: boolean;
  appetiteAndCriticalUrgency: number;
  dependencyUnlockValue: number;
  projectPriority: number;
  eligibleSince: ISODate;
  betAppetiteEnd?: ISODate;
}

export type LaterReason =
  | CapacityPlacementReason
  | "DEPENDENCY_BLOCKED"
  | "BET_EXPIRED";

export interface LaterEntry {
  targetId: Id;
  reason: LaterReason;
}

export interface TodayCapacityUsage {
  deepSeconds: Seconds;
  mediumSeconds: Seconds;
  shallowSeconds: Seconds;
}

export interface TodayProposal {
  localDate: string;
  workspaceRevision: number;
  generatedAt: ISODate;
  capacity: CapacityProfile;
  localCapacity: LocalDateCapacity;
  capacityUsage: TodayCapacityUsage;
  slots: CommitmentSlot[];
  later: LaterEntry[];
  proposalHash: string;
}

export const TODAY_PROPOSAL_MAX_AGE_SECONDS = 300;

export interface ReplanProposalDraft {
  id: Id;
  localDate: string;
  reasonCodes: string[];
  createdAt: ISODate;
  createdBy: Id;
}

export function canonicalReplanReasonCodes(reasonCodes: string[]): string[] {
  return [...new Set(reasonCodes.map((reason) => reason.trim()))]
    .filter((reason) => reason.length > 0)
    .sort(compareText);
}

async function sameSemanticSnapshot(
  left: JsonValue,
  right: JsonValue,
): Promise<boolean> {
  return (await stableHash(left)) === (await stableHash(right));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareTodayCandidate(
  left: TodayCandidate,
  right: TodayCandidate,
): number {
  return (
    Number(right.hasFixedTimeOrHardDeadline) -
      Number(left.hasFixedTimeOrHardDeadline) ||
    right.appetiteAndCriticalUrgency - left.appetiteAndCriticalUrgency ||
    right.dependencyUnlockValue - left.dependencyUnlockValue ||
    right.projectPriority - left.projectPriority ||
    compareText(left.eligibleSince, right.eligibleSince) ||
    compareText(left.targetId, right.targetId)
  );
}

function parsedTimestamp(value: ISODate): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function compareCommitmentRecency(
  left: DailyCommitment,
  right: DailyCommitment,
): number {
  const leftTime = parsedTimestamp(left.committedAt);
  const rightTime = parsedTimestamp(right.committedAt);
  const timeOrder =
    leftTime === undefined
      ? rightTime === undefined
        ? 0
        : 1
      : rightTime === undefined
        ? -1
        : rightTime - leftTime;
  return (
    right.version - left.version ||
    timeOrder ||
    compareText(left.id, right.id)
  );
}

function commitmentLeavesForLocalDate(
  workspace: WorkspaceV2,
  localDate: string,
): DailyCommitment[] {
  const supersededIds = new Set(
    workspace.dailyCommitments
      .map(({ supersedesId }) => supersedesId)
      .filter((id): id is Id => id !== undefined),
  );
  return workspace.dailyCommitments
    .filter(
      (commitment) =>
        commitment.localDate === localDate &&
        !supersededIds.has(commitment.id),
    )
    .sort(compareCommitmentRecency);
}

export function effectiveCommitmentForLocalDate(
  workspace: WorkspaceV2,
  localDate: string,
): DailyCommitment | undefined {
  return commitmentLeavesForLocalDate(workspace, localDate)[0];
}

export function soleCommitmentLeafForLocalDate(
  workspace: WorkspaceV2,
  localDate: string,
): DailyCommitment | undefined {
  const history = workspace.dailyCommitments.filter(
    (commitment) => commitment.localDate === localDate,
  );
  if (history.length === 0) return undefined;
  const byId = new Map(history.map((commitment) => [commitment.id, commitment]));
  const versions = new Set<number>();
  const supersededIds = new Set<Id>();
  for (const commitment of history) {
    if (
      !Number.isInteger(commitment.version) ||
      commitment.version <= 0 ||
      versions.has(commitment.version)
    ) {
      return undefined;
    }
    versions.add(commitment.version);
    if (commitment.supersedesId === undefined) {
      if (commitment.version !== 1) return undefined;
      continue;
    }
    const parent = byId.get(commitment.supersedesId);
    if (
      parent === undefined ||
      parent.id === commitment.id ||
      commitment.version !== parent.version + 1
    ) {
      return undefined;
    }
    supersededIds.add(parent.id);
  }
  const leaves = history.filter(({ id }) => !supersededIds.has(id));
  if (leaves.length !== 1) return undefined;
  const visited = new Set<Id>();
  let cursor: DailyCommitment | undefined = leaves[0];
  while (cursor !== undefined) {
    if (visited.has(cursor.id)) return undefined;
    visited.add(cursor.id);
    cursor =
      cursor.supersedesId === undefined
        ? undefined
        : byId.get(cursor.supersedesId);
  }
  return visited.size === history.length ? leaves[0] : undefined;
}

function currentBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
): BetVersion | undefined {
  if (project.activeBetId === undefined) return undefined;
  const current = workspace.bets.filter(
    (bet) =>
      bet.projectId === project.id && bet.invalidatedAt === undefined,
  );
  return current.length === 1 && current[0].id === project.activeBetId
    ? current[0]
    : undefined;
}

function actualTargetKey(target: ActualV2["target"]): string {
  return target.kind === "action"
    ? `action:${target.actionId}`
    : `work_item:${target.workItemId}`;
}

function compareActualRecency(left: ActualV2, right: ActualV2): number {
  const leftTime = parsedTimestamp(left.recordedAt);
  const rightTime = parsedTimestamp(right.recordedAt);
  const timeOrder =
    leftTime === undefined
      ? rightTime === undefined
        ? 0
        : 1
      : rightTime === undefined
        ? -1
        : rightTime - leftTime;
  return (
    timeOrder ||
    right.revision - left.revision ||
    compareText(left.id, right.id)
  );
}

function actualsRecordedBy(
  workspace: WorkspaceV2,
  now: ISODate,
): ActualV2[] {
  const nowTimestamp = parsedTimestamp(now);
  if (nowTimestamp === undefined) {
    throw new RangeError(`Invalid Today generation timestamp: ${now}.`);
  }
  return workspace.actuals.filter((actual) => {
    const recordedAt = parsedTimestamp(actual.recordedAt);
    if (recordedAt === undefined) {
      throw new RangeError(`Actual ${actual.id} has an invalid recordedAt.`);
    }
    return recordedAt <= nowTimestamp;
  });
}

function latestActuals(actuals: ActualV2[]): Map<string, ActualV2> {
  const byTarget = new Map<string, ActualV2[]>();
  for (const actual of actuals) {
    const key = actualTargetKey(actual.target);
    const events = byTarget.get(key) ?? [];
    events.push(actual);
    byTarget.set(key, events);
  }
  return new Map(
    [...byTarget.entries()].map(([key, events]) => [
      key,
      [...events].sort(compareActualRecency)[0],
    ]),
  );
}

function actionIsComplete(
  item: Action,
  actuals: Map<string, ActualV2>,
): boolean {
  return (
    item.status !== "open" ||
    actuals.get(`action:${item.id}`)?.remainingWorkSeconds === 0
  );
}

function workItemIsComplete(
  item: ProjectWorkItem,
  actuals: Map<string, ActualV2>,
): boolean {
  return (
    item.resultStatus !== undefined ||
    item.percentComplete >= 100 ||
    actuals.get(`work_item:${item.id}`)?.remainingWorkSeconds === 0
  );
}

function targetSatisfiesDependency(
  workspace: WorkspaceV2,
  targetId: Id,
  actuals: Map<string, ActualV2>,
): boolean {
  const action = workspace.actions.find(({ id }) => id === targetId);
  if (action !== undefined) {
    return (
      action.status === "completed" ||
      actuals.get(`action:${action.id}`)?.remainingWorkSeconds === 0
    );
  }
  const item = workspace.workItems.find(({ id }) => id === targetId);
  if (item === undefined || item.resultStatus === "blocked") return false;
  return (
    item.resultStatus === "completed" ||
    item.resultStatus === "learned" ||
    item.percentComplete >= 100 ||
    actuals.get(`work_item:${item.id}`)?.remainingWorkSeconds === 0
  );
}

function targetIsUnfinished(
  workspace: WorkspaceV2,
  targetId: Id,
  actuals: Map<string, ActualV2>,
): boolean {
  const action = workspace.actions.find(({ id }) => id === targetId);
  if (action !== undefined) return !actionIsComplete(action, actuals);
  const item = workspace.workItems.find(({ id }) => id === targetId);
  return item !== undefined && !workItemIsComplete(item, actuals);
}

function dependencyUnlockValue(
  workspace: WorkspaceV2,
  targetId: Id,
  actuals: Map<string, ActualV2>,
): number {
  const dependents = new Set<string>();
  for (const action of workspace.actions) {
    if (
      action.eligibility.dependencyIds.includes(targetId) &&
      !actionIsComplete(action, actuals)
    ) {
      dependents.add(`action:${action.id}`);
    }
  }
  for (const dependency of workspace.dependencies) {
    if (
      dependency.fromId === targetId &&
      targetIsUnfinished(workspace, dependency.toId, actuals)
    ) {
      dependents.add(`target:${dependency.toId}`);
    }
  }
  return dependents.size;
}

function remainingDuration(
  targetKey: string,
  fallback: Seconds,
  actuals: Map<string, ActualV2>,
): Seconds {
  return actuals.get(targetKey)?.remainingWorkSeconds ?? fallback;
}

function attentionForWorkItem(item: ProjectWorkItem): AttentionKind {
  const priority: Record<AttentionKind, number> = {
    deep: 0,
    medium: 1,
    shallow: 2,
  };
  return [...item.assignmentIds].sort(
    (left, right) =>
      priority[left.attention] - priority[right.attention] ||
      compareText(left.resourceId, right.resourceId) ||
      right.effortSeconds - left.effortSeconds,
  )[0]?.attention ?? "deep";
}

function attentionForActualTarget(
  workspace: WorkspaceV2,
  actual: ActualV2,
): AttentionKind {
  if (actual.target.kind === "action") {
    const actionId = actual.target.actionId;
    const matches = workspace.actions.filter(
      ({ id }) => id === actionId,
    );
    if (matches.length === 1) return matches[0].attention;
  } else {
    const workItemId = actual.target.workItemId;
    const matches = workspace.workItems.filter(
      ({ id }) => id === workItemId,
    );
    if (matches.length === 1) return attentionForWorkItem(matches[0]);
  }
  throw new RangeError(
    `Actual ${actual.id} has no unique current target attention.`,
  );
}

function actualAttentionUsage(
  workspace: WorkspaceV2,
  actuals: ActualV2[],
  localDate: string,
  timeZone: string,
): Record<AttentionKind, Seconds> {
  const usage: Record<AttentionKind, Seconds> = {
    deep: 0,
    medium: 0,
    shallow: 0,
  };
  for (const actual of actuals) {
    if (localDateAt(actual.recordedAt, timeZone) !== localDate) continue;
    if (
      !Number.isFinite(actual.actualWorkSeconds) ||
      !Number.isInteger(actual.actualWorkSeconds) ||
      actual.actualWorkSeconds < 0
    ) {
      throw new RangeError(
        `Actual ${actual.id} has invalid incremental work seconds.`,
      );
    }
    const attention = attentionForActualTarget(workspace, actual);
    const next = usage[attention] + actual.actualWorkSeconds;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(
        `Actual attention usage for ${attention} exceeds safe integer range.`,
      );
    }
    usage[attention] = next;
  }
  return usage;
}

export function actualAttentionUsageForToday(
  workspace: WorkspaceV2,
  localDate: string,
  generatedAt: ISODate,
  timeZone: string,
): Record<AttentionKind, Seconds> {
  return actualAttentionUsage(
    workspace,
    actualsRecordedBy(workspace, generatedAt),
    localDate,
    timeZone,
  );
}

function unelapsedCommittedUsage(
  slots: CommitmentSlot[],
  now: ISODate,
): Record<AttentionKind, Seconds> {
  const nowTimestamp = parsedTimestamp(now);
  if (nowTimestamp === undefined) {
    throw new RangeError(`Invalid Today generation timestamp: ${now}.`);
  }
  const usage: Record<AttentionKind, Seconds> = {
    deep: 0,
    medium: 0,
    shallow: 0,
  };
  for (const slot of slots) {
    const start = parsedTimestamp(slot.start);
    const finish = parsedTimestamp(slot.finish);
    if (start === undefined || finish === undefined || start >= finish) {
      throw new RangeError(`Committed slot ${slot.id} has an invalid interval.`);
    }
    const remainingSeconds =
      finish <= nowTimestamp
        ? 0
        : (finish - Math.max(start, nowTimestamp)) / 1_000;
    usage[slot.attention] += remainingSeconds;
  }
  return usage;
}

function addAttentionUsage(
  left: Record<AttentionKind, Seconds>,
  right: Record<AttentionKind, Seconds>,
): Record<AttentionKind, Seconds> {
  return {
    deep: left.deep + right.deep,
    medium: left.medium + right.medium,
    shallow: left.shallow + right.shallow,
  };
}

function inverseSecondsUntil(value: ISODate, now: ISODate): number {
  const timestamp = parsedTimestamp(value);
  const nowTimestamp = parsedTimestamp(now);
  if (timestamp === undefined || nowTimestamp === undefined) return 0;
  const seconds = Math.max(0, Math.floor((timestamp - nowTimestamp) / 1_000));
  return 1_000_000_000 - Math.min(1_000_000_000, seconds);
}

function appetiteAndCriticalUrgency(
  bet: BetVersion,
  schedule: { isCritical: boolean; lateStart: ISODate } | undefined,
  now: ISODate,
): number {
  return (
    (schedule?.isCritical ? 4_000_000_000 : 0) +
    inverseSecondsUntil(bet.appetiteEnd, now) * 2 +
    (schedule === undefined ? 0 : inverseSecondsUntil(schedule.lateStart, now))
  );
}

function dateIsOnOrBefore(
  value: ISODate | undefined,
  localDate: string,
  timeZone: string,
): boolean {
  if (value === undefined) return false;
  const date = localDateAt(value, timeZone);
  return date !== undefined && compareText(date, localDate) <= 0;
}

function latestInstant(
  ...values: Array<ISODate | undefined>
): ISODate | undefined {
  let selected: ISODate | undefined;
  let selectedTimestamp: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const timestamp = parsedTimestamp(value);
    if (timestamp === undefined) return value;
    if (selectedTimestamp === undefined || timestamp > selectedTimestamp) {
      selected = value;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}

function earliestInstant(
  ...values: Array<ISODate | undefined>
): ISODate | undefined {
  let selected: ISODate | undefined;
  let selectedTimestamp: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const timestamp = parsedTimestamp(value);
    if (timestamp === undefined) return value;
    if (selectedTimestamp === undefined || timestamp < selectedTimestamp) {
      selected = value;
      selectedTimestamp = timestamp;
    }
  }
  return selected;
}

function fixedFinishStart(
  value: ISODate | undefined,
  durationSeconds: Seconds,
): ISODate | undefined {
  if (value === undefined || parsedTimestamp(value) === undefined) return undefined;
  return new Date(Date.parse(value) - durationSeconds * 1_000).toISOString();
}

function betEligibleSince(bet: BetVersion): ISODate {
  const eligibleSince = latestInstant(bet.approvedAt, bet.appetiteStart);
  if (eligibleSince === undefined || parsedTimestamp(eligibleSince) === undefined) {
    throw new RangeError(`Bet ${bet.id} has an invalid eligibility boundary.`);
  }
  return eligibleSince;
}

function syncAffectedRecordIds(project: ProjectV2): Set<Id> {
  return new Set(
    project.holds.flatMap(({ type, affectedRecordIds }) =>
      type === "sync_conflict" ? affectedRecordIds : [],
    ),
  );
}

function allSyncAffectedRecordIds(workspace: WorkspaceV2): Set<Id> {
  return new Set(
    workspace.projects.flatMap((project) => [
      ...syncAffectedRecordIds(project),
    ]),
  );
}

function committedSlotHasSyncConflict(
  workspace: WorkspaceV2,
  commitment: DailyCommitment,
  slot: CommitmentSlot,
  affectedRecordIds: Set<Id>,
): boolean {
  const targetIds: Id[] =
    slot.target.kind === "action"
      ? [slot.target.actionId]
      : [slot.target.workItemId, slot.target.projectId];
  const projectId =
    slot.target.kind === "work_item" ? slot.target.projectId : undefined;
  const project =
    projectId !== undefined
      ? workspace.projects.find(({ id }) => id === projectId)
      : undefined;
  return [
    commitment.id,
    slot.id,
    ...targetIds,
    project?.activeBetId,
    project?.activePlanVersionId,
  ]
    .filter((id): id is Id => id !== undefined)
    .some((id) => affectedRecordIds.has(id));
}

interface RejectedCandidate {
  candidate: TodayCandidate;
  reason: LaterReason;
}

function actionCandidate(
  workspace: WorkspaceV2,
  action: Action,
  localDate: string,
  capacity: LocalDateCapacity,
  actuals: Map<string, ActualV2>,
): TodayCandidate | undefined {
  if (actionIsComplete(action, actuals)) return undefined;
  const durationSeconds = remainingDuration(
    `action:${action.id}`,
    action.eligibility.estimateSeconds,
    actuals,
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }

  const fixedStart = action.fixedStart;
  return {
    targetId: action.id,
    targetRevision: action.revision,
    target: { kind: "action", actionId: action.id },
    durationSeconds,
    attention: action.attention,
    ...(fixedStart === undefined ? {} : { fixedStart }),
    hasFixedTimeOrHardDeadline:
      fixedStart !== undefined ||
      dateIsOnOrBefore(
        action.fixedStart,
        localDate,
        capacity.timeZone,
      ) ||
      dateIsOnOrBefore(
        action.desiredDate,
        localDate,
        capacity.timeZone,
      ),
    appetiteAndCriticalUrgency: 0,
    dependencyUnlockValue: dependencyUnlockValue(
      workspace,
      action.id,
      actuals,
    ),
    projectPriority: 0,
    eligibleSince: action.createdAt,
  };
}

function workItemCandidate(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  item: ProjectWorkItem,
  localDate: string,
  capacity: LocalDateCapacity,
  now: ISODate,
  actuals: Map<string, ActualV2>,
  schedule:
    | { isCritical: boolean; lateStart: ISODate; start: ISODate }
    | undefined,
): TodayCandidate | undefined {
  if (workItemIsComplete(item, actuals)) return undefined;
  const durationSeconds = remainingDuration(
    `work_item:${item.id}`,
    item.durationSeconds,
    actuals,
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return undefined;
  }

  const fixedStart =
    item.constraint?.fixedStart ??
    fixedFinishStart(
      item.constraint?.fixedFinish,
      durationSeconds,
    );
  const earliestStart = latestInstant(
    item.constraint?.noEarlierThan,
    schedule?.start,
  );
  const latestFinish = earliestInstant(
    item.constraint?.noLaterThan,
    item.constraint?.fixedFinish,
  );

  return {
    targetId: item.id,
    targetRevision: item.revision,
    target: {
      kind: "work_item",
      workItemId: item.id,
      projectId: project.id,
    },
    durationSeconds,
    attention: attentionForWorkItem(item),
    ...(fixedStart === undefined ? {} : { fixedStart }),
    ...(earliestStart === undefined ? {} : { earliestStart }),
    ...(latestFinish === undefined ? {} : { latestFinish }),
    hasFixedTimeOrHardDeadline:
      fixedStart !== undefined ||
      dateIsOnOrBefore(
        item.constraint?.fixedStart,
        localDate,
        capacity.timeZone,
      ) ||
      dateIsOnOrBefore(
        item.constraint?.fixedFinish,
        localDate,
        capacity.timeZone,
      ) ||
      dateIsOnOrBefore(
        item.constraint?.noLaterThan,
        localDate,
        capacity.timeZone,
      ),
    appetiteAndCriticalUrgency: appetiteAndCriticalUrgency(
      bet,
      schedule,
      now,
    ),
    dependencyUnlockValue: dependencyUnlockValue(
      workspace,
      item.id,
      actuals,
    ),
    projectPriority: project.priority,
    eligibleSince: betEligibleSince(bet),
    betAppetiteEnd: bet.appetiteEnd,
  };
}

function unresolvedDependency(
  workspace: WorkspaceV2,
  item: ProjectWorkItem,
  actuals: Map<string, ActualV2>,
): boolean {
  return workspace.dependencies.some(
    ({ toId, fromId, type }) =>
      toId === item.id &&
      type === "FS" &&
      !targetSatisfiesDependency(workspace, fromId, actuals),
  );
}

function projectedDependencyDateIsLater(
  workspace: WorkspaceV2,
  item: ProjectWorkItem,
  projectedStart: ISODate | undefined,
  localDate: string,
  timeZone: string,
): boolean {
  if (
    projectedStart === undefined ||
    !workspace.dependencies.some(({ toId }) => toId === item.id)
  ) {
    return false;
  }
  const projectedLocalDate = localDateAt(projectedStart, timeZone);
  return (
    projectedLocalDate !== undefined &&
    compareText(projectedLocalDate, localDate) > 0
  );
}

function candidateExactBoundsCrossBet(candidate: TodayCandidate): boolean {
  if (candidate.betAppetiteEnd === undefined) return false;
  const betEnd = parsedTimestamp(candidate.betAppetiteEnd);
  if (betEnd === undefined) return false;
  const durationMilliseconds = candidate.durationSeconds * 1_000;
  return [candidate.fixedStart, candidate.earliestStart].some((value) => {
    if (value === undefined) return false;
    const start = parsedTimestamp(value);
    return start !== undefined && start + durationMilliseconds > betEnd;
  });
}

export async function generateTodayProposal(
  workspace: WorkspaceV2,
  localDate: string,
  now: ISODate,
): Promise<TodayProposal> {
  if (workspace.capacityProfile === undefined) {
    throw new Error("Today generation requires a Capacity Profile.");
  }
  if (parsedTimestamp(now) === undefined) {
    throw new RangeError(`Invalid Today generation timestamp: ${now}.`);
  }
  const capacityProfile = structuredClone(workspace.capacityProfile);
  const localCapacity = capacityForLocalDate(capacityProfile, localDate);
  const currentLocalDate = localDateAt(now, localCapacity.timeZone);
  if (currentLocalDate === undefined) {
    throw new RangeError(`Invalid Today generation timestamp: ${now}.`);
  }
  const dateOrder = compareText(localDate, currentLocalDate);
  if (dateOrder < 0) {
    throw new RangeError(
      `Cannot generate Today for past local date ${localDate}.`,
    );
  }
  const cutoff = dateOrder === 0 ? now : undefined;
  const visibleActuals = actualsRecordedBy(workspace, now);
  const actuals = latestActuals(visibleActuals);
  const initialUsedSeconds = actualAttentionUsage(
    workspace,
    visibleActuals,
    localDate,
    localCapacity.timeZone,
  );
  const ledger = createCapacityLedger(
    localCapacity,
    cutoff,
    initialUsedSeconds,
  );
  const effectiveCommitment = effectiveCommitmentForLocalDate(
    workspace,
    localDate,
  );
  const scheduleByWorkItem = new Map(
    scheduleExecutablePortfolio(workspace, now).flatMap((result) =>
      result.items.map((scheduled) => [scheduled.workItem.id, scheduled] as const),
    ),
  );
  const candidates: TodayCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const preservedSlots: CommitmentSlot[] = [];
  const hasReviewOverdue = workspace.projects.some((project) =>
    project.holds.some(({ type }) => type === "review_overdue"),
  );
  const syncAffectedIds = allSyncAffectedRecordIds(workspace);

  if (hasReviewOverdue && effectiveCommitment !== undefined) {
    for (const slot of effectiveCommitment.slots) {
      if (
        !committedSlotHasSyncConflict(
          workspace,
          effectiveCommitment,
          slot,
          syncAffectedIds,
        )
      ) {
        preservedSlots.push(structuredClone(slot));
      }
    }
  }

  for (const action of [...workspace.actions].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (hasReviewOverdue || syncAffectedIds.has(action.id)) continue;
    const candidate = actionCandidate(
      workspace,
      action,
      localDate,
      localCapacity,
      actuals,
    );
    if (candidate === undefined) continue;
    if (
      action.eligibility.dependencyIds.some(
        (dependencyId) =>
          !targetSatisfiesDependency(workspace, dependencyId, actuals),
      )
    ) {
      rejected.push({ candidate, reason: "DEPENDENCY_BLOCKED" });
    } else {
      candidates.push(candidate);
    }
  }

  for (const project of [...workspace.projects].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (hasReviewOverdue) continue;
    if (
      (project.stage !== "planning" && project.stage !== "executing") ||
      project.holds.some(
        ({ type }) =>
          type === "migration_review" || type === "rebet_required",
      )
    ) {
      continue;
    }
    const bet = currentBet(workspace, project);
    if (bet === undefined) continue;
    const betEnd = parsedTimestamp(bet.appetiteEnd);
    if (betEnd === undefined) continue;
    const finalBetInstant = new Date(betEnd - 1).toISOString();
    const finalBetLocalDate = localDateAt(
      finalBetInstant,
      localCapacity.timeZone,
    );
    if (finalBetLocalDate === undefined) continue;

    if (
      [project.id, bet.id, project.activePlanVersionId]
        .filter((id): id is Id => id !== undefined)
        .some((id) => syncAffectedIds.has(id))
    ) {
      continue;
    }
    const scopeIds = new Set(bet.committedScope.map(({ id }) => id));
    const items = workspace.workItems
      .filter(
        (item) =>
          item.projectId === project.id && scopeIds.has(item.betScopeId),
      )
      .sort((left, right) => compareText(left.id, right.id));

    if (
      Date.parse(now) >= betEnd ||
      compareText(finalBetLocalDate, localDate) < 0
    ) {
      for (const item of items) {
        if (
          syncAffectedIds.has(item.id) ||
          workItemIsComplete(item, actuals)
        ) {
          continue;
        }
        const candidate = workItemCandidate(
          workspace,
          project,
          bet,
          item,
          localDate,
          localCapacity,
          now,
          actuals,
          undefined,
        );
        if (candidate !== undefined) {
          rejected.push({ candidate, reason: "BET_EXPIRED" });
        }
      }
      continue;
    }

    for (const item of items) {
      if (syncAffectedIds.has(item.id)) {
        continue;
      }
      const scheduled = scheduleByWorkItem.get(item.id);
      if (scheduled === undefined) continue;
      const candidate = workItemCandidate(
        workspace,
        project,
        bet,
        item,
        localDate,
        localCapacity,
        now,
        actuals,
        scheduled,
      );
      if (candidate === undefined) continue;
      if (
        unresolvedDependency(workspace, item, actuals) ||
        projectedDependencyDateIsLater(
          workspace,
          item,
          scheduled.start,
          localDate,
          localCapacity.timeZone,
        )
      ) {
        rejected.push({ candidate, reason: "DEPENDENCY_BLOCKED" });
      } else {
        candidates.push(candidate);
      }
    }
  }

  const slots = preservedSlots.map((slot) => structuredClone(slot));
  for (const candidate of candidates.sort(compareTodayCandidate)) {
    if (candidateExactBoundsCrossBet(candidate)) {
      rejected.push({ candidate, reason: "BET_EXPIRED" });
      continue;
    }
    const placement = placeCandidate(candidate, ledger);
    if (!placement.ok) {
      rejected.push({ candidate, reason: placement.reason });
      continue;
    }
    if (
      candidate.betAppetiteEnd !== undefined &&
      Date.parse(placement.slot.finish) > Date.parse(candidate.betAppetiteEnd)
    ) {
      rejected.push({ candidate, reason: "BET_EXPIRED" });
      continue;
    }
    slots.push(placement.slot);
    ledger.consume(placement.slot);
  }

  const later = rejected
    .sort(
      (left, right) =>
        compareTodayCandidate(left.candidate, right.candidate) ||
        compareText(left.reason, right.reason),
    )
    .map(({ candidate, reason }) => ({
      targetId: candidate.targetId,
      reason,
    }));
  const used = hasReviewOverdue
    ? addAttentionUsage(
        initialUsedSeconds,
        unelapsedCommittedUsage(slots, now),
      )
    : ledger.usedSeconds;
  const proposalBase = {
    localDate,
    workspaceRevision: workspace.revision,
    generatedAt: now,
    capacity: structuredClone(capacityProfile),
    localCapacity: structuredClone(localCapacity),
    capacityUsage: {
      deepSeconds: used.deep,
      mediumSeconds: used.medium,
      shallowSeconds: used.shallow,
    },
    slots,
    later,
  };
  return {
    ...proposalBase,
    proposalHash: await stableHash(proposalBase as unknown as JsonValue),
  };
}

export async function replanHasMaterialChange(
  workspace: WorkspaceV2,
  baseCommitment: DailyCommitment,
  today: TodayProposal,
): Promise<boolean> {
  let committedLocalCapacity: LocalDateCapacity;
  try {
    committedLocalCapacity = capacityForLocalDate(
      baseCommitment.capacitySnapshot,
      baseCommitment.localDate,
    );
  } catch {
    return true;
  }
  if (
    !(await sameSemanticSnapshot(
      {
        localCapacity: committedLocalCapacity,
        slots: baseCommitment.slots,
      } as unknown as JsonValue,
      {
        localCapacity: today.localCapacity,
        slots: today.slots,
      } as unknown as JsonValue,
    ))
  ) {
    return true;
  }

  const projectIds = [
    ...new Set(
      [...baseCommitment.slots, ...today.slots].flatMap(({ target }) =>
        target.kind === "work_item" ? [target.projectId] : [],
      ),
    ),
  ].sort(compareText);
  for (const projectId of projectIds) {
    const projects = workspace.projects.filter(({ id }) => id === projectId);
    if (projects.length !== 1) return true;
    const project = projects[0];
    if (project.activePlanVersionId === undefined) return true;
    const plans = workspace.planVersions.filter(
      ({ id }) => id === project.activePlanVersionId,
    );
    if (plans.length !== 1) return true;
    const plan = plans[0];
    const bets = workspace.bets.filter(
      ({ id, projectId: ownerId, invalidatedAt }) =>
        id === project.activeBetId &&
        ownerId === projectId &&
        invalidatedAt === undefined,
    );
    if (bets.length !== 1 || plan.betId !== bets[0].id) return true;
    let currentInputs;
    try {
      currentInputs = await buildPlanSemanticSnapshot(
        workspace,
        projectId,
        bets[0],
        today.generatedAt,
      );
    } catch {
      return true;
    }
    const committedInputs = {
      betId: plan.betId,
      workItemRevisions: plan.workItemRevisions,
      dependencyRevisions: plan.dependencyRevisions,
      scopeMapping: plan.scopeMapping,
      scheduleHash: plan.scheduleHash,
      capacityIndependentDates: plan.capacityIndependentDates,
    };
    if (
      !(await sameSemanticSnapshot(
        committedInputs as unknown as JsonValue,
        currentInputs as unknown as JsonValue,
      ))
    ) {
      return true;
    }
  }
  return false;
}

export async function buildReplanProposal(
  workspace: WorkspaceV2,
  draft: ReplanProposalDraft,
): Promise<WorkspaceV2["replanProposals"][number]> {
  const baseCommitment = soleCommitmentLeafForLocalDate(
    workspace,
    draft.localDate,
  );
  if (baseCommitment === undefined) {
    throw new RangeError(
      `Replan requires exactly one current Daily Commitment for ${draft.localDate}.`,
    );
  }
  if (Date.parse(draft.createdAt) < Date.parse(baseCommitment.committedAt)) {
    throw new RangeError(
      `Replan creation time cannot predate Daily Commitment ${baseCommitment.id}.`,
    );
  }
  const reasonCodes = canonicalReplanReasonCodes(draft.reasonCodes);
  if (reasonCodes.length === 0) {
    throw new RangeError("Replan requires at least one reason code.");
  }
  const today = await generateTodayProposal(
    workspace,
    draft.localDate,
    draft.createdAt,
  );
  const reviewOverdue = workspace.projects.some((project) =>
    project.holds.some(({ type }) => type === "review_overdue"),
  );
  if (
    !reviewOverdue &&
    !(await replanHasMaterialChange(workspace, baseCommitment, today))
  ) {
    throw new RangeError(
      `Replan for ${draft.localDate} requires a material change from Daily Commitment ${baseCommitment.id}.`,
    );
  }
  return {
    id: draft.id,
    localDate: draft.localDate,
    baseCommitmentId: baseCommitment.id,
    baseRevision: workspace.revision,
    reasonCodes,
    proposedSlots: structuredClone(today.slots),
    proposalHash: today.proposalHash,
    createdAt: draft.createdAt,
    createdBy: draft.createdBy,
    status: "open",
  };
}
