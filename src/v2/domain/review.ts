import type { Evidence, Id, ISODate } from "@/domain/types";

import { isUsableControlledException, isUsableEvidenceAt } from "./evidence";
import { evaluateBetBoundary } from "./lifecycle";
import {
  capacityForLocalDate,
  instantAtLocalMinute,
  localDateAt,
} from "./localTime";
import {
  actualAttentionUsageForToday,
  soleCommitmentLeafForLocalDate,
} from "./today";
import type { ReviewRecord, WorkspaceV2 } from "./types";

export const reviewPolicy = {
  weeklyDueWeekday: 0,
  weeklyDueMinute: 18 * 60,
  inboxAgingDays: 7,
  evidenceStaleDays: 14,
  capacityVarianceWindowDays: 5,
  capacityVarianceThreshold: 0.25,
  capacityVarianceBreachesRequired: 3,
} as const;

export type ReviewQueueDraft = Omit<
  ReviewRecord,
  "status" | "createdAt" | "overdueMarkedAt" | "conclusion"
>;

export function isPortfolioReviewScope(
  _workspace: WorkspaceV2,
  review: Pick<ReviewRecord, "kind" | "affectedProjectIds">,
): boolean {
  return review.kind === "weekly" || review.affectedProjectIds.length === 0;
}

export function reviewOverdueTriggerKey(
  review: Pick<ReviewRecord, "id">,
): string {
  return `${review.id}:overdue`;
}

const DAY_MS = 86_400_000;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<Id | undefined>): Id[] {
  return [
    ...new Set(
      [...values].filter((value): value is Id => value !== undefined),
    ),
  ].sort(compareText);
}

export function reviewAffectedActiveProjectIds(
  workspace: WorkspaceV2,
  review: Pick<ReviewRecord, "kind" | "affectedProjectIds">,
): Id[] {
  const requestedIds = new Set(review.affectedProjectIds);
  const portfolioScope = isPortfolioReviewScope(workspace, review);
  return uniqueSorted(
    workspace.projects
      .filter(
        ({ id, stage }) =>
          stage !== "closed" && (portfolioScope || requestedIds.has(id)),
      )
      .map(({ id }) => id),
  );
}

function parsedCanonicalTimestamp(value: ISODate): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function optionalTimestampIsEffective(
  value: ISODate | undefined,
  now: ISODate,
): boolean {
  if (value === undefined) return false;
  const timestamp = parsedCanonicalTimestamp(value);
  const evaluatedAt = parsedCanonicalTimestamp(now);
  return (
    timestamp !== undefined &&
    evaluatedAt !== undefined &&
    timestamp <= evaluatedAt
  );
}

function exceptionScheduleIsValid(
  record: WorkspaceV2["exceptions"][number],
): boolean {
  const unresolved = structuredClone(record);
  delete unresolved.resolvedAt;
  unresolved.history = unresolved.history.filter(
    ({ action }) => action !== "resolved",
  );
  return isUsableControlledException(unresolved);
}

function parseLocalDate(localDate: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) return undefined;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return date.toISOString().slice(0, 10) === localDate ? date : undefined;
}

function addLocalDays(localDate: string, days: number): string | undefined {
  const date = parseLocalDate(localDate);
  if (date === undefined) return undefined;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStartForLocalDate(localDate: string): string | undefined {
  const date = parseLocalDate(localDate);
  if (date === undefined) return undefined;
  return addLocalDays(localDate, -((date.getUTCDay() + 6) % 7));
}

function capacityCadenceAnchorAt(
  workspace: WorkspaceV2,
  now: ISODate,
): ISODate | undefined {
  const evaluatedAt = parsedCanonicalTimestamp(now);
  if (evaluatedAt === undefined) return undefined;
  const candidates: Array<{ value: ISODate; timestamp: number }> = [];
  for (const receipt of workspace.commandReceipts) {
    if (
      receipt.status !== "applied" ||
      receipt.commandType !== "configure_capacity"
    ) {
      continue;
    }
    const receiptAt = parsedCanonicalTimestamp(receipt.createdAt);
    if (receiptAt !== undefined && receiptAt <= evaluatedAt) {
      candidates.push({ value: receipt.createdAt, timestamp: receiptAt });
    }
    for (const diff of receipt.diff) {
      if (
        diff.entity !== "WorkspaceV2" ||
        diff.field !== "capacityProfile" ||
        diff.before === null ||
        Array.isArray(diff.before) ||
        typeof diff.before !== "object"
      ) {
        continue;
      }
      const updatedAt = diff.before.updatedAt;
      if (typeof updatedAt !== "string") continue;
      const timestamp = parsedCanonicalTimestamp(updatedAt);
      if (timestamp !== undefined && timestamp <= evaluatedAt) {
        candidates.push({ value: updatedAt, timestamp });
      }
    }
  }
  const profileUpdatedAt = workspace.capacityProfile?.updatedAt;
  if (profileUpdatedAt !== undefined) {
    const timestamp = parsedCanonicalTimestamp(profileUpdatedAt);
    if (timestamp !== undefined && timestamp <= evaluatedAt) {
      candidates.push({ value: profileUpdatedAt, timestamp });
    }
  }
  return candidates.sort(
    (left, right) =>
      left.timestamp - right.timestamp || compareText(left.value, right.value),
  )[0]?.value;
}

function weeklyOccurrenceForStart(
  weekStart: string,
  timeZone: string,
): {
  weekStart: string;
  triggerKey: string;
  dueAt: ISODate;
  timeZone: string;
} | undefined {
  const dueLocalDate = addLocalDays(weekStart, 6);
  const dueAt =
    dueLocalDate === undefined
      ? undefined
      : instantAtLocalMinute(
          dueLocalDate,
          reviewPolicy.weeklyDueMinute,
          timeZone,
        );
  return dueAt === undefined
    ? undefined
    : { weekStart, triggerKey: `weekly:${weekStart}`, dueAt, timeZone };
}

export interface WeeklyReviewCoverageRange {
  start: string;
  end: string;
  reviewId: Id;
}

function weeklyTriggerRange(
  review: Pick<ReviewRecord, "id" | "triggerKey">,
): WeeklyReviewCoverageRange | undefined {
  const single = /^weekly:(\d{4}-\d{2}-\d{2})$/.exec(review.triggerKey);
  if (single !== null) {
    const weekStart = single[1];
    return weekStartForLocalDate(weekStart) === weekStart
      ? { start: weekStart, end: weekStart, reviewId: review.id }
      : undefined;
  }
  const catchUp =
    /^weekly_catchup:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(
      review.triggerKey,
    );
  if (catchUp === null) return undefined;
  const start = catchUp[1];
  const end = catchUp[2];
  return weekStartForLocalDate(start) === start &&
    weekStartForLocalDate(end) === end &&
    start < end
    ? { start, end, reviewId: review.id }
    : undefined;
}

function legacyCadenceTimeZonesAt(
  workspace: WorkspaceV2,
  createdAt: ISODate,
): string[] {
  const created = parsedCanonicalTimestamp(createdAt);
  if (created === undefined) return [];
  const timeZones = new Set<string>();
  const profile = workspace.capacityProfile;
  if (
    profile !== undefined &&
    typeof profile.timeZone === "string" &&
    parsedCanonicalTimestamp(profile.updatedAt) !== undefined &&
    Date.parse(profile.updatedAt) <= created
  ) {
    timeZones.add(profile.timeZone);
  }
  for (const receipt of workspace.commandReceipts) {
    const configuredAt = parsedCanonicalTimestamp(receipt.createdAt);
    if (
      receipt.status !== "applied" ||
      receipt.commandType !== "configure_capacity" ||
      configuredAt === undefined ||
      configuredAt > created
    ) {
      continue;
    }
    for (const diff of receipt.diff) {
      if (
        diff.entity === "WorkspaceV2" &&
        diff.field === "capacityProfile" &&
        diff.after !== null &&
        !Array.isArray(diff.after) &&
        typeof diff.after === "object" &&
        typeof diff.after.timeZone === "string"
      ) {
        timeZones.add(diff.after.timeZone);
      }
    }
  }
  return [...timeZones].sort(compareText);
}

export function weeklyReviewCoverageRange(
  workspace: WorkspaceV2,
  review: Pick<
    ReviewRecord,
    | "id"
    | "kind"
    | "triggerType"
    | "triggerKey"
    | "dueAt"
    | "cadenceTimeZone"
    | "createdAt"
  >,
): WeeklyReviewCoverageRange | undefined {
  if (review.kind !== "weekly" || review.triggerType !== "weekly") {
    return undefined;
  }
  const range = weeklyTriggerRange(review);
  if (range === undefined) return undefined;
  const runtimeTimeZone = (
    review as { cadenceTimeZone?: unknown }
  ).cadenceTimeZone;
  if (
    runtimeTimeZone !== undefined &&
    typeof runtimeTimeZone !== "string"
  ) {
    return undefined;
  }
  const timeZones =
    runtimeTimeZone === undefined
      ? legacyCadenceTimeZonesAt(workspace, review.createdAt)
      : [runtimeTimeZone];
  const createdAt = parsedCanonicalTimestamp(review.createdAt);
  if (createdAt === undefined) return undefined;
  return timeZones.some((timeZone) => {
    if (
      timeZone.length === 0 ||
      timeZone !== timeZone.trim() ||
      localDateAt(review.createdAt, timeZone) === undefined
    ) {
      return false;
    }
    const coverageStartsAt = instantAtLocalMinute(range.start, 0, timeZone);
    const expectedDueAt = weeklyOccurrenceForStart(range.end, timeZone)?.dueAt;
    return (
      coverageStartsAt !== undefined &&
      createdAt >= Date.parse(coverageStartsAt) &&
      expectedDueAt !== undefined &&
      review.dueAt === expectedDueAt &&
      (range.start === range.end || Date.parse(review.dueAt) <= createdAt)
    );
  })
    ? range
    : undefined;
}

export function overlappingWeeklyReviewCoverage(
  workspace: WorkspaceV2,
): Array<{ overlapStart: string; leftReviewId: Id; rightReviewId: Id }> {
  const ranges = workspace.reviews
    .map((review) => weeklyReviewCoverageRange(workspace, review))
    .filter((range): range is WeeklyReviewCoverageRange => range !== undefined)
    .sort(
      (left, right) =>
        compareText(left.start, right.start) ||
        compareText(left.end, right.end) ||
        compareText(left.reviewId, right.reviewId),
    );
  const conflicts: Array<{
    overlapStart: string;
    leftReviewId: Id;
    rightReviewId: Id;
  }> = [];
  let covering: WeeklyReviewCoverageRange | undefined;
  for (const range of ranges) {
    if (covering !== undefined && range.start <= covering.end) {
      conflicts.push({
        overlapStart: range.start,
        leftReviewId: covering.reviewId,
        rightReviewId: range.reviewId,
      });
    }
    if (
      covering === undefined ||
      compareText(range.end, covering.end) > 0 ||
      (range.end === covering.end &&
        compareText(range.reviewId, covering.reviewId) < 0)
    ) {
      covering = range;
    }
  }
  return conflicts;
}

function persistedWeeklyCoverage(
  workspace: WorkspaceV2,
  now: ISODate,
): Array<{ start: string; end: string }> {
  const evaluatedAt = parsedCanonicalTimestamp(now);
  if (evaluatedAt === undefined) return [];
  const reviews = workspace.reviews.filter((review) => {
    const createdAt = parsedCanonicalTimestamp(review.createdAt);
    return createdAt !== undefined && createdAt <= evaluatedAt;
  });
  const effectiveWorkspace = { ...workspace, reviews };
  if (overlappingWeeklyReviewCoverage(effectiveWorkspace).length > 0) {
    return [];
  }
  return reviews
    .map((review) => weeklyReviewCoverageRange(workspace, review))
    .filter((range): range is WeeklyReviewCoverageRange => range !== undefined)
    .map(({ start, end }) => ({ start, end }))
    .sort(
      (left, right) =>
        compareText(left.start, right.start) || compareText(left.end, right.end),
    );
}

function weeklyOccurrences(
  workspace: WorkspaceV2,
  now: ISODate,
): Array<{
  weekStart: string;
  triggerKey: string;
  dueAt: ISODate;
  timeZone: string;
}> {
  const profile = workspace.capacityProfile;
  if (
    profile === undefined ||
    parsedCanonicalTimestamp(now) === undefined
  ) {
    return [];
  }
  const currentLocalDate = localDateAt(now, profile.timeZone);
  const cadenceAnchor = capacityCadenceAnchorAt(workspace, now);
  const anchorLocalDate =
    cadenceAnchor === undefined
      ? undefined
      : localDateAt(cadenceAnchor, profile.timeZone);
  const currentWeekStart =
    currentLocalDate === undefined
      ? undefined
      : weekStartForLocalDate(currentLocalDate);
  const anchorWeekStart =
    anchorLocalDate === undefined
      ? undefined
      : weekStartForLocalDate(anchorLocalDate);
  if (currentWeekStart === undefined) return [];
  let firstWeek = currentWeekStart;
  if (cadenceAnchor !== undefined && anchorWeekStart !== undefined) {
    const anchorWeekBoundary = instantAtLocalMinute(
      anchorWeekStart,
      0,
      profile.timeZone,
    );
    if (anchorWeekBoundary !== undefined) {
      const firstFullWeek =
        Date.parse(cadenceAnchor) <= Date.parse(anchorWeekBoundary)
          ? anchorWeekStart
          : addLocalDays(anchorWeekStart, 7);
      if (firstFullWeek !== undefined && firstFullWeek <= currentWeekStart) {
        firstWeek = firstFullWeek;
      }
    }
  }
  const occurrences: Array<{
    weekStart: string;
    triggerKey: string;
    dueAt: ISODate;
    timeZone: string;
  }> = [];
  const previousWeekStart = addLocalDays(currentWeekStart, -7);
  if (previousWeekStart !== undefined && firstWeek <= previousWeekStart) {
    const coverage = persistedWeeklyCoverage(workspace, now);
    let firstMissing = firstWeek;
    let lastMissing = previousWeekStart;
    for (const range of coverage) {
      if (range.end < firstMissing) continue;
      if (range.start > previousWeekStart) break;
      if (range.start > firstMissing) {
        lastMissing = addLocalDays(range.start, -7) ?? firstMissing;
        break;
      }
      const afterRange = addLocalDays(range.end, 7);
      if (afterRange === undefined) return [];
      firstMissing = afterRange;
      if (firstMissing > previousWeekStart) break;
    }
    if (firstMissing <= previousWeekStart) {
      const dueOccurrence = weeklyOccurrenceForStart(
        lastMissing,
        profile.timeZone,
      );
      if (dueOccurrence === undefined) return [];
      occurrences.push(
        firstMissing === lastMissing
          ? dueOccurrence
          : {
              weekStart: firstMissing,
              triggerKey: `weekly_catchup:${firstMissing}:${lastMissing}`,
              dueAt: dueOccurrence.dueAt,
              timeZone: profile.timeZone,
            },
      );
    }
  }
  const currentOccurrence = weeklyOccurrenceForStart(
    currentWeekStart,
    profile.timeZone,
  );
  if (currentOccurrence === undefined) return [];
  occurrences.push(currentOccurrence);
  return occurrences;
}

function latestEvidenceByRequirement(
  workspace: WorkspaceV2,
  now: ISODate,
): Evidence[] {
  const concreteRequirementIds = new Set(
    workspace.workItems
      .filter(
        ({ kind, evidenceRequired }) =>
          kind === "milestone" && evidenceRequired === true,
      )
      .map(({ id, projectId }) => `${projectId}\u0000${id}`),
  );
  const latest = new Map<string, Evidence>();
  for (const evidence of workspace.evidence) {
    if (
      evidence.workItemId === undefined ||
      !isUsableEvidenceAt(evidence, now)
    ) {
      continue;
    }
    const key = `${evidence.projectId}\u0000${evidence.workItemId}`;
    if (!concreteRequirementIds.has(key)) continue;
    const previous = latest.get(key);
    if (
      previous === undefined ||
      compareText(previous.createdAt, evidence.createdAt) < 0 ||
      (previous.createdAt === evidence.createdAt &&
        compareText(previous.id, evidence.id) < 0)
    ) {
      latest.set(key, evidence);
    }
  }
  return [...latest.values()].sort((left, right) => compareText(left.id, right.id));
}

function staleEvidence(workspace: WorkspaceV2, now: ISODate): Evidence[] {
  const nowMilliseconds = parsedCanonicalTimestamp(now);
  if (nowMilliseconds === undefined) return [];
  const threshold = reviewPolicy.evidenceStaleDays * DAY_MS;
  return latestEvidenceByRequirement(workspace, now).filter((evidence) => {
    const createdAt = parsedCanonicalTimestamp(evidence.createdAt);
    return createdAt !== undefined && nowMilliseconds - createdAt >= threshold;
  });
}

function workspaceRecordIds(workspace: WorkspaceV2): Set<Id> {
  return new Set([
    ...workspace.inboxItems,
    ...workspace.actions,
    ...workspace.projects,
    ...workspace.directionBriefs,
    ...workspace.bets,
    ...workspace.planVersions,
    ...workspace.dailyCommitments,
    ...workspace.replanProposals,
    ...workspace.reviews,
    ...workspace.exceptions,
    ...workspace.closeDecisions,
    ...workspace.commandProposals,
    ...workspace.syncConflicts,
    ...workspace.commandReceipts,
    ...workspace.workItems,
    ...workspace.dependencies,
    ...workspace.resources,
    ...workspace.baselines,
    ...workspace.evidence,
    ...workspace.actuals,
    ...workspace.legacyAuditRecords,
    ...workspace.directionBriefs.flatMap(({ firstScope }) => firstScope),
    ...workspace.bets.flatMap((bet) => [
      ...bet.committedScope,
      ...bet.briefSnapshot.firstScope,
    ]),
    ...workspace.dailyCommitments.flatMap(({ slots, capacitySnapshot }) => [
      ...slots,
      ...capacitySnapshot.unavailableBlocks,
    ]),
    ...workspace.replanProposals.flatMap(({ proposedSlots }) => proposedSlots),
    ...(workspace.capacityProfile?.unavailableBlocks ?? []),
    ...(workspace.migration === undefined
      ? []
      : [{ id: workspace.migration.backupId }]),
  ].map(({ id }) => id));
}

function weeklyReviewDraft(
  workspace: WorkspaceV2,
  now: ISODate,
  capacityAssessment: CapacityWindowAssessment | undefined,
  occurrence: { triggerKey: string; dueAt: ISODate; timeZone: string },
): ReviewQueueDraft {
  const evaluatedAt = parsedCanonicalTimestamp(now);
  const activeProjects = workspace.projects.filter(
    ({ stage }) => stage !== "closed",
  );
  const activeProjectIds = new Set(activeProjects.map(({ id }) => id));
  const activeBets = workspace.bets.filter(
    (bet) =>
      !optionalTimestampIsEffective(bet.invalidatedAt, now) &&
      activeProjects.some(
        (project) =>
          project.id === bet.projectId && project.activeBetId === bet.id,
      ),
  );
  const agingInbox = workspace.inboxItems.filter((item) => {
    const capturedAt = parsedCanonicalTimestamp(item.capturedAt);
    const current = parsedCanonicalTimestamp(now);
    return (
      item.triageStatus === "untriaged" &&
      capturedAt !== undefined &&
      current !== undefined &&
      current - capturedAt >= reviewPolicy.inboxAgingDays * DAY_MS
    );
  });
  const stale = staleEvidence(workspace, now).filter(({ projectId }) =>
    activeProjectIds.has(projectId),
  );
  const exceptions = workspace.exceptions.filter(
    ({ projectId, resolvedAt }) =>
      activeProjectIds.has(projectId) &&
      !optionalTimestampIsEffective(resolvedAt, now),
  );
  const conflicts = workspace.syncConflicts.filter(
    ({ projectId, resolvedAt, openedAt }) => {
      const opened = parsedCanonicalTimestamp(openedAt);
      return (
        evaluatedAt !== undefined &&
        opened !== undefined &&
        opened <= evaluatedAt &&
        !optionalTimestampIsEffective(resolvedAt, now) &&
        (projectId === undefined || activeProjectIds.has(projectId))
      );
    },
  );
  const knownRecordIds = workspaceRecordIds(workspace);
  const holdRecordIds = activeProjects.flatMap((project) =>
    project.holds.flatMap((hold) => {
      const createdAt = parsedCanonicalTimestamp(hold.createdAt);
      return evaluatedAt === undefined ||
        createdAt === undefined ||
        createdAt > evaluatedAt
        ? []
        : [
            project.id,
            ...(knownRecordIds.has(hold.sourceId) ? [hold.sourceId] : []),
            ...hold.affectedRecordIds.filter((id) => knownRecordIds.has(id)),
          ];
    }),
  );
  const affectedRecordIds = uniqueSorted([
    ...activeProjects.map(({ id }) => id),
    ...agingInbox.map(({ id }) => id),
    ...activeBets.map(({ id }) => id),
    ...stale.flatMap(({ id, workItemId }) => [id, workItemId]),
    ...exceptions.flatMap(({ id, requirementId }) => [id, requirementId]),
    ...conflicts.flatMap(({ id, recordId }) => [id, recordId]),
    ...holdRecordIds,
    ...(capacityAssessment?.affectedRecordIds ?? []),
  ]);
  const triggerKey = occurrence.triggerKey;
  return {
    id: `review:${triggerKey}`,
    kind: "weekly",
    triggerKey,
    triggerType: "weekly",
    affectedProjectIds: uniqueSorted(activeProjectIds),
    affectedRecordIds,
    dueAt: occurrence.dueAt,
    cadenceTimeZone: occurrence.timeZone,
  };
}

function eventReviewDraft(
  triggerKey: string,
  triggerType: Exclude<ReviewRecord["triggerType"], "weekly">,
  dueAt: ISODate,
  affectedProjectIds: Iterable<Id | undefined>,
  affectedRecordIds: Iterable<Id | undefined>,
): ReviewQueueDraft {
  return {
    id: `review:${triggerKey}`,
    kind: "event",
    triggerKey,
    triggerType,
    affectedProjectIds: uniqueSorted(affectedProjectIds),
    affectedRecordIds: uniqueSorted(affectedRecordIds),
    dueAt,
  };
}

function betBoundaryReviewDrafts(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  if (parsedCanonicalTimestamp(now) === undefined) return [];
  return evaluateBetBoundary(workspace, now).map(({ review }) =>
    structuredClone(review),
  );
}

function evidenceReviewDrafts(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  const activeProjectIds = new Set(
    workspace.projects
      .filter(({ stage }) => stage !== "closed")
      .map(({ id }) => id),
  );
  return staleEvidence(workspace, now)
    .filter(({ projectId }) => activeProjectIds.has(projectId))
    .map((evidence) => {
      const createdAt = parsedCanonicalTimestamp(evidence.createdAt);
      const dueAt = new Date(
        (createdAt ?? 0) + reviewPolicy.evidenceStaleDays * DAY_MS,
      ).toISOString();
      return eventReviewDraft(
        `evidence:${evidence.id}:stale`,
        "evidence_stale",
        dueAt,
        [evidence.projectId],
        [evidence.id, evidence.projectId, evidence.workItemId],
      );
    });
}

function exceptionReviewDrafts(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  const nowMilliseconds = parsedCanonicalTimestamp(now);
  if (nowMilliseconds === undefined) return [];
  const activeProjectIds = new Set(
    workspace.projects
      .filter(({ stage }) => stage !== "closed")
      .map(({ id }) => id),
  );
  return workspace.exceptions.flatMap((record) => {
    const expiresAt = parsedCanonicalTimestamp(record.expiresAt);
    const reviewAt = parsedCanonicalTimestamp(record.reviewAt);
    if (
      optionalTimestampIsEffective(record.resolvedAt, now) ||
      !activeProjectIds.has(record.projectId) ||
      !exceptionScheduleIsValid(record) ||
      expiresAt === undefined ||
      reviewAt === undefined
    ) {
      return [];
    }
    const affectedRecords = [record.id, record.projectId, record.requirementId];
    if (nowMilliseconds >= expiresAt) {
      return [
        eventReviewDraft(
          `exception:${record.id}:expired`,
          "exception_expired",
          record.expiresAt,
          [record.projectId],
          affectedRecords,
        ),
      ];
    }
    return nowMilliseconds >= reviewAt
      ? [
          eventReviewDraft(
            `exception:${record.id}:review:${record.reviewAt}`,
            "hard_gate",
            record.reviewAt,
            [record.projectId],
            affectedRecords,
          ),
        ]
      : [];
  });
}

function hardGateReviewDrafts(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  const evaluatedAt = parsedCanonicalTimestamp(now);
  if (evaluatedAt === undefined) return [];
  return workspace.projects
    .filter(({ stage }) => stage !== "closed")
    .flatMap((project) =>
      project.holds.flatMap((hold) => {
        if (hold.type === "review_overdue" || hold.type === "sync_conflict") {
          return [];
        }
        const createdAt = parsedCanonicalTimestamp(hold.createdAt);
        if (createdAt === undefined || createdAt > evaluatedAt) return [];
        return [
          eventReviewDraft(
            `hard_gate:${JSON.stringify([
              project.id,
              hold.type,
              hold.sourceId,
              hold.createdAt,
            ])}`,
            "hard_gate",
            hold.createdAt,
            [project.id],
            [project.id, hold.sourceId, ...hold.affectedRecordIds],
          ),
        ];
      }),
    );
}

function conflictProjectOwnership(
  workspace: WorkspaceV2,
  conflict: WorkspaceV2["syncConflicts"][number],
): {
  affectedProjectIds: Id[];
  hasResolvedOwner: boolean;
  portfolioScope: boolean;
} {
  const projectIds: Array<Id | undefined> = [conflict.projectId];
  let portfolioScope = false;
  switch (conflict.recordType) {
    case "bet":
      projectIds.push(
        ...workspace.bets
          .filter(({ id }) => id === conflict.recordId)
          .map(({ projectId }) => projectId),
      );
      break;
    case "daily_commitment":
      projectIds.push(
        ...workspace.dailyCommitments
          .filter(({ id }) => id === conflict.recordId)
          .flatMap(({ slots }) =>
            slots.flatMap(({ target }) =>
              target.kind === "work_item" ? [target.projectId] : [],
            ),
          ),
      );
      break;
    case "review":
      {
        const reviews = workspace.reviews.filter(
          ({ id }) => id === conflict.recordId,
        );
        portfolioScope =
          conflict.projectId === undefined &&
          reviews.some((review) => isPortfolioReviewScope(workspace, review));
        if (!portfolioScope) {
          projectIds.push(
            ...reviews.flatMap(({ affectedProjectIds }) => affectedProjectIds),
          );
        }
      }
      break;
    case "exception":
      projectIds.push(
        ...workspace.exceptions
          .filter(({ id }) => id === conflict.recordId)
          .map(({ projectId }) => projectId),
      );
      break;
    case "close":
      projectIds.push(
        ...workspace.closeDecisions
          .filter(({ id }) => id === conflict.recordId)
          .map(({ projectId }) => projectId),
      );
      break;
  }
  const activeProjectIds = new Set(
    workspace.projects
      .filter(({ stage }) => stage !== "closed")
      .map(({ id }) => id),
  );
  const resolvedProjectIds = uniqueSorted(projectIds);
  return {
    affectedProjectIds: resolvedProjectIds.filter((id) =>
      activeProjectIds.has(id),
    ),
    hasResolvedOwner: portfolioScope || resolvedProjectIds.length > 0,
    portfolioScope,
  };
}

function syncConflictReviewDrafts(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  return workspace.syncConflicts.flatMap((conflict) => {
    const ownership = conflictProjectOwnership(workspace, conflict);
    const openedAt = parsedCanonicalTimestamp(conflict.openedAt);
    const evaluatedAt = parsedCanonicalTimestamp(now);
    if (
      optionalTimestampIsEffective(conflict.resolvedAt, now) ||
      openedAt === undefined ||
      evaluatedAt === undefined ||
      openedAt > evaluatedAt ||
      (!ownership.portfolioScope &&
        ownership.hasResolvedOwner &&
        ownership.affectedProjectIds.length === 0)
    ) {
      return [];
    }
    return [
      eventReviewDraft(
        `sync_conflict:${conflict.id}`,
        "sync_conflict",
        conflict.openedAt,
        ownership.affectedProjectIds,
        [conflict.id, conflict.projectId, conflict.recordId],
      ),
    ];
  });
}

function varianceAtLeast(actual: number, configured: number): boolean {
  if (configured === 0) return actual !== 0;
  return (
    Math.abs(actual - configured) / configured >=
    reviewPolicy.capacityVarianceThreshold
  );
}

interface CapacityWindowDayAssessment {
  commitmentId: Id;
  actualIds: Id[];
  configuredTotalSeconds: number;
  actualTotalSeconds: number;
  configuredAttention: {
    deep: number;
    medium: number;
    shallow: number;
  };
  actualAttention: {
    deep: number;
    medium: number;
    shallow: number;
  };
  breached: boolean;
}

interface CapacityWindowAssessment {
  status: "valid" | "invalid";
  days: CapacityWindowDayAssessment[];
  breaches: number;
  affectedProjectIds: Id[];
  affectedRecordIds: Id[];
  dueAt: ISODate;
  triggerKey: string;
}

function assessCapacityWindow(
  workspace: WorkspaceV2,
  now: ISODate,
): CapacityWindowAssessment | undefined {
  const evaluatedAt = parsedCanonicalTimestamp(now);
  if (evaluatedAt === undefined) return undefined;
  const localDates = [
    ...new Set(
      workspace.dailyCommitments.map(({ localDate }) => localDate),
    ),
  ].sort((left, right) => compareText(right, left));
  const utcDateAtEvaluation = now.slice(0, 10);
  const potentiallyCompletedDates = localDates.filter((localDate) => {
    const observedDates = workspace.dailyCommitments
      .filter((commitment) => commitment.localDate === localDate)
      .map((commitment) =>
        localDateAt(now, commitment.capacitySnapshot.timeZone),
      );
    return (
      observedDates.some(
        (observedDate) =>
          observedDate !== undefined && observedDate > localDate,
      ) ||
      (observedDates.some((observedDate) => observedDate === undefined) &&
        utcDateAtEvaluation > localDate)
    );
  });
  const windowDates = potentiallyCompletedDates.slice(
    0,
    reviewPolicy.capacityVarianceWindowDays,
  );
  if (windowDates.length === 0) {
    return undefined;
  }
  const histories = windowDates.flatMap((localDate) =>
    workspace.dailyCommitments.filter(
      (commitment) => commitment.localDate === localDate,
    ),
  );
  const completed = windowDates.map((localDate) =>
    soleCommitmentLeafForLocalDate(workspace, localDate),
  );
  const lineageIsInvalid = completed.some(
    (commitment) => commitment === undefined,
  );
  const leaves = completed.filter(
    (commitment): commitment is WorkspaceV2["dailyCommitments"][number] =>
      commitment !== undefined,
  );

  const hasUnlocatableSnapshot = histories.some(
    (commitment) =>
      localDateAt(now, commitment.capacitySnapshot.timeZone) === undefined,
  );
  const traceActuals = workspace.actuals.filter((actual) => {
    const recordedAt = parsedCanonicalTimestamp(actual.recordedAt);
    if (recordedAt === undefined) return true;
    if (recordedAt > evaluatedAt) return false;
    if (hasUnlocatableSnapshot) return true;
    return histories.some(
      (commitment) =>
        localDateAt(
          actual.recordedAt,
          commitment.capacitySnapshot.timeZone,
        ) === commitment.localDate,
    );
  });

  const days: CapacityWindowDayAssessment[] = [];
  const actualsByCommitment = new Map<
    Id,
    WorkspaceV2["actuals"]
  >();
  const affectedProjectIds: Id[] = histories.flatMap(({ slots }) =>
    slots.flatMap(({ target }) =>
      target.kind === "work_item" ? [target.projectId] : [],
    ),
  );
  for (const commitment of leaves) {
    const actuals = traceActuals.filter(
      (actual) =>
        parsedCanonicalTimestamp(actual.recordedAt) !== undefined &&
        Date.parse(actual.recordedAt) <= evaluatedAt &&
        localDateAt(
          actual.recordedAt,
          commitment.capacitySnapshot.timeZone,
        ) === commitment.localDate,
    );
    actualsByCommitment.set(commitment.id, actuals);
    for (const actual of actuals) {
      if (actual.target.kind === "work_item") {
        const workItemId = actual.target.workItemId;
        affectedProjectIds.push(
          ...workspace.workItems
            .filter(({ id }) => id === workItemId)
            .map(({ projectId }) => projectId),
        );
      }
    }
  }
  for (const actual of traceActuals) {
    if (actual.target.kind !== "work_item") continue;
    const workItemId = actual.target.workItemId;
    affectedProjectIds.push(
      ...workspace.workItems
        .filter(({ id }) => id === workItemId)
        .map(({ projectId }) => projectId),
    );
  }
  const commitmentIds = (lineageIsInvalid ? histories : leaves)
    .map(({ id }) => id)
    .sort(compareText);
  const actualIds = uniqueSorted(traceActuals.map(({ id }) => id));
  const latestCommitment = [...(leaves.length > 0 ? leaves : histories)].sort(
    (left, right) =>
      compareText(right.localDate, left.localDate) ||
      compareText(left.id, right.id),
  )[0];
  if (latestCommitment === undefined) return undefined;
  const dayAfterLatest = addLocalDays(latestCommitment.localDate, 1);
  const snapshotTimeZone = latestCommitment.capacitySnapshot.timeZone;
  const dueTimeZone =
    localDateAt(now, snapshotTimeZone) === undefined
      ? workspace.capacityProfile?.timeZone
      : snapshotTimeZone;
  const scheduledDueAt =
    dayAfterLatest === undefined || dueTimeZone === undefined
      ? undefined
      : instantAtLocalMinute(
          dayAfterLatest,
          0,
          dueTimeZone,
        );
  const dueAt =
    scheduledDueAt ??
    (parsedCanonicalTimestamp(latestCommitment.committedAt) === undefined
      ? now
      : latestCommitment.committedAt);
  const common = {
    affectedProjectIds: uniqueSorted(affectedProjectIds),
    affectedRecordIds: uniqueSorted([...commitmentIds, ...actualIds]),
    dueAt,
  };
  const invalidAssessment = (): CapacityWindowAssessment => ({
    status: "invalid",
    days: [],
    breaches: 0,
    ...common,
    triggerKey: `capacity_assessment_invalid:${JSON.stringify(commitmentIds)}`,
  });
  if (
    lineageIsInvalid ||
    leaves.length !== windowDates.length ||
    leaves.some((commitment) => {
      const observedDate = localDateAt(
        now,
        commitment.capacitySnapshot.timeZone,
      );
      return observedDate === undefined || observedDate <= commitment.localDate;
    }) ||
    traceActuals.some(
      ({ recordedAt }) => parsedCanonicalTimestamp(recordedAt) === undefined,
    ) ||
    scheduledDueAt === undefined
  ) {
    return invalidAssessment();
  }
  try {
    for (const commitment of leaves) {
      const actuals = actualsByCommitment.get(commitment.id) ?? [];
      const capacity = capacityForLocalDate(
        commitment.capacitySnapshot,
        commitment.localDate,
      );
      const configured = {
        deep: capacity.budgets.deepSeconds,
        medium: capacity.budgets.mediumSeconds,
        shallow: capacity.budgets.shallowSeconds,
      };
      const configuredTotal = capacity.availableIntervals.reduce(
        (total, interval) =>
          total + (Date.parse(interval.finish) - Date.parse(interval.start)) / 1_000,
        0,
      );
      const usage = actualAttentionUsageForToday(
        workspace,
        commitment.localDate,
        now,
        commitment.capacitySnapshot.timeZone,
      );
      const actualTotal = usage.deep + usage.medium + usage.shallow;
      const breached =
        varianceAtLeast(actualTotal, configuredTotal) ||
        varianceAtLeast(usage.deep, configured.deep) ||
        varianceAtLeast(usage.medium, configured.medium) ||
        varianceAtLeast(usage.shallow, configured.shallow);
      days.push({
        commitmentId: commitment.id,
        actualIds: uniqueSorted(actuals.map(({ id }) => id)),
        configuredTotalSeconds: configuredTotal,
        actualTotalSeconds: actualTotal,
        configuredAttention: configured,
        actualAttention: usage,
        breached,
      });
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return invalidAssessment();
  }
  return {
    status: "valid",
    days,
    breaches: days.filter(({ breached }) => breached).length,
    ...common,
    triggerKey: `capacity_variance:${JSON.stringify(commitmentIds)}`,
  };
}

function capacityAssessmentReviewDraft(
  assessment: CapacityWindowAssessment | undefined,
): ReviewQueueDraft | undefined {
  if (assessment?.status === "invalid") {
    return eventReviewDraft(
      assessment.triggerKey,
      "hard_gate",
      assessment.dueAt,
      assessment.affectedProjectIds,
      assessment.affectedRecordIds,
    );
  }
  if (
    assessment === undefined ||
    assessment.days.length !== reviewPolicy.capacityVarianceWindowDays ||
    assessment.breaches < reviewPolicy.capacityVarianceBreachesRequired
  ) {
    return undefined;
  }
  return eventReviewDraft(
    assessment.triggerKey,
    "capacity_variance",
    assessment.dueAt,
    assessment.affectedProjectIds,
    assessment.affectedRecordIds,
  );
}

export function deriveReviewQueue(
  workspace: WorkspaceV2,
  now: ISODate,
): ReviewQueueDraft[] {
  if (parsedCanonicalTimestamp(now) === undefined) return [];
  const capacityAssessment = assessCapacityWindow(workspace, now);
  const capacityReview = capacityAssessmentReviewDraft(capacityAssessment);
  const weekly = weeklyOccurrences(workspace, now).map((occurrence) =>
    weeklyReviewDraft(workspace, now, capacityAssessment, occurrence),
  );
  const drafts = [
    ...weekly,
    ...betBoundaryReviewDrafts(workspace, now),
    ...evidenceReviewDrafts(workspace, now),
    ...exceptionReviewDrafts(workspace, now),
    ...hardGateReviewDrafts(workspace, now),
    ...syncConflictReviewDrafts(workspace, now),
    ...(capacityReview === undefined ? [] : [capacityReview]),
  ];
  const persistedTriggerKeys = new Set(
    workspace.reviews
      .filter(
        (review) => {
          const createdAt = parsedCanonicalTimestamp(review.createdAt);
          return (
            createdAt !== undefined &&
            createdAt <= Date.parse(now) &&
            (review.kind !== "weekly" ||
              weeklyReviewCoverageRange(workspace, review) !== undefined)
          );
        },
      )
      .map(({ triggerKey }) => triggerKey),
  );
  const draftsByTrigger = new Map<
    string,
    { draft: ReviewQueueDraft; canonical: string }
  >();
  const ambiguousTriggers = new Set<string>();
  for (const draft of drafts) {
    const canonical = JSON.stringify(draft);
    const existing = draftsByTrigger.get(draft.triggerKey);
    if (existing === undefined) {
      draftsByTrigger.set(draft.triggerKey, { draft, canonical });
    } else if (existing.canonical !== canonical) {
      ambiguousTriggers.add(draft.triggerKey);
    }
  }
  return [...draftsByTrigger.values()]
    .map(({ draft }) => draft)
    .filter(({ triggerKey }) => !ambiguousTriggers.has(triggerKey))
    .filter(({ triggerKey }) => !persistedTriggerKeys.has(triggerKey))
    .sort(
      (left, right) =>
        compareText(left.dueAt, right.dueAt) ||
        compareText(left.triggerKey, right.triggerKey),
    );
}
