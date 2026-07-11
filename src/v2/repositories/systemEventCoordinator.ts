import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../domain/commands";
import type { ISODate } from "@/domain/types";
import { isUsableControlledException } from "../domain/evidence";
import { evaluateBetBoundary } from "../domain/lifecycle";
import { instantAtLocalMinute } from "../domain/localTime";
import {
  deriveReviewQueue,
  reviewOverdueTriggerKey,
  storedReviewSemanticsAreValid,
  type ReviewQueueDraft,
} from "../domain/review";
import type { WorkspaceV2 } from "../domain/types";

const DAY_MS = 86_400_000;
const DEFAULT_MAX_CAS_RETRIES = 4;
const DEFAULT_MAX_COMMANDS_PER_RUN = 1_000;
export const SYSTEM_EVENT_CAS_BACKOFF_MS = 1_000;

export const SYSTEM_EVENT_ACTOR_ID = "system-event-coordinator";
export const SYSTEM_EVENT_SOURCE = {
  sourceId: "system-clock",
  verified: true,
  capabilities: ["system_time"],
} as const;

export interface SystemEventWorkspaceRepository {
  load(): Promise<WorkspaceV2 | undefined>;
}

export interface SystemEventCommandDispatcher {
  dispatch(command: V2Command, context: CommandContext): Promise<CommandResult>;
}

export interface SystemEventCoordinatorOptions {
  maxCasRetries?: number;
  maxCommandsPerRun?: number;
}

export type SystemEventRunReason = "boot" | "timer" | "visibility";

export interface SystemEventRunOptions {
  reason: SystemEventRunReason;
}

interface SystemEventSuppression {
  revision: number;
  mode: "until_revision_change" | "cas_backoff";
  retryAt?: ISODate;
}

type SystemEventCommand = Extract<
  V2Command,
  | { type: "record_bet_boundary" }
  | { type: "create_review" }
  | { type: "mark_review_overdue" }
>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function commandTriggerKey(command: SystemEventCommand): string {
  switch (command.type) {
    case "record_bet_boundary":
      return command.triggerKey;
    case "create_review":
      return command.review.triggerKey;
    case "mark_review_overdue":
      return command.triggerKey;
  }
}

export function systemEventCommandId(command: SystemEventCommand): string {
  return `system-event:${command.type}:${commandTriggerKey(command)}`;
}

function systemContext(
  workspace: WorkspaceV2,
  command: SystemEventCommand,
  now: ISODate,
): CommandContext {
  return {
    commandId: systemEventCommandId(command),
    expectedRevision: workspace.revision,
    actorId: SYSTEM_EVENT_ACTOR_ID,
    actorKind: "system",
    origin: "agent",
    source: {
      sourceId: SYSTEM_EVENT_SOURCE.sourceId,
      verified: SYSTEM_EVENT_SOURCE.verified,
      capabilities: [...SYSTEM_EVENT_SOURCE.capabilities],
    },
    now,
  };
}

function commandWasApplied(
  workspace: WorkspaceV2,
  command: SystemEventCommand,
): boolean {
  const commandId = systemEventCommandId(command);
  return workspace.commandReceipts.some(
    (receipt) =>
      receipt.commandId === commandId && receipt.status === "applied",
  );
}

function dueBoundaryCommand(
  workspace: WorkspaceV2,
  now: ISODate,
  blockedCommandIds: ReadonlySet<string>,
): Extract<SystemEventCommand, { type: "record_bet_boundary" }> | undefined {
  const nowTimestamp = canonicalTimestamp(now);
  if (nowTimestamp === undefined) return undefined;
  return evaluateBetBoundary(workspace, now)
    .filter(({ review }) => {
      const dueAt = canonicalTimestamp(review.dueAt);
      return dueAt !== undefined && dueAt <= nowTimestamp;
    })
    .filter(({ command }) => !commandWasApplied(workspace, command))
    .filter(({ command }) =>
      !blockedCommandIds.has(systemEventCommandId(command)),
    )
    .sort(
      (left, right) =>
        // At restart, a midpoint command evaluated after appetiteEnd is
        // rejected until expiry has first moved every affected Project into
        // its canonical validating/held state. Reviews still sort by dueAt.
        Number(left.command.boundary !== "expired") -
          Number(right.command.boundary !== "expired") ||
        compareText(left.review.dueAt, right.review.dueAt) ||
        compareText(left.command.triggerKey, right.command.triggerKey) ||
        compareText(left.command.projectId, right.command.projectId) ||
        compareText(left.command.boundary, right.command.boundary),
    )[0]?.command;
}

function dueReviewCommand(
  workspace: WorkspaceV2,
  now: ISODate,
  blockedCommandIds: ReadonlySet<string>,
): Extract<SystemEventCommand, { type: "create_review" }> | undefined {
  const nowTimestamp = canonicalTimestamp(now);
  if (nowTimestamp === undefined) return undefined;
  const dueBetBoundaryCommands = new Map(
    evaluateBetBoundary(workspace, now).map(({ command }) => [
      command.triggerKey,
      command,
    ]),
  );
  return deriveReviewQueue(workspace, now)
    .filter(({ dueAt, triggerType }) => {
      // The current weekly occurrence is persisted as an open Review as soon
      // as it is exposed. dueAt governs overdue marking, not creation.
      if (triggerType === "weekly") return true;
      const dueTimestamp = canonicalTimestamp(dueAt);
      return dueTimestamp !== undefined && dueTimestamp <= nowTimestamp;
    })
    .filter((review) => {
      if (
        review.triggerType !== "bet_midpoint" &&
        review.triggerType !== "bet_expired"
      ) {
        return true;
      }
      const boundaryCommand = dueBetBoundaryCommands.get(review.triggerKey);
      // Persisting a Review first suppresses evaluateBetBoundary. Require the
      // deterministic record receipt so a rejected boundary cannot be hidden.
      return (
        boundaryCommand !== undefined &&
        commandWasApplied(workspace, boundaryCommand)
      );
    })
    .map((review) => ({ type: "create_review", review }) as const)
    .filter((command) => !commandWasApplied(workspace, command))
    .filter((command) => !blockedCommandIds.has(systemEventCommandId(command)))
    .sort(
      (left, right) =>
        compareText(left.review.dueAt, right.review.dueAt) ||
        compareText(left.review.triggerKey, right.review.triggerKey) ||
        compareText(left.review.id, right.review.id),
    )[0];
}

function overdueCommandForReview(
  workspace: WorkspaceV2,
  now: ISODate,
  reviewId: string,
  blockedCommandIds: ReadonlySet<string>,
): Extract<SystemEventCommand, { type: "mark_review_overdue" }> | undefined {
  const nowTimestamp = canonicalTimestamp(now);
  if (nowTimestamp === undefined) return undefined;
  const matchingReviews = workspace.reviews.filter(
    (review) => review.id === reviewId,
  );
  if (matchingReviews.length !== 1) return undefined;
  const review = matchingReviews[0];
  const dueAt = canonicalTimestamp(review.dueAt);
  if (
    review.status !== "open" ||
    review.overdueMarkedAt !== undefined ||
    dueAt === undefined ||
    dueAt > nowTimestamp ||
    !storedReviewSemanticsAreValid(workspace, review, nowTimestamp)
  ) {
    return undefined;
  }
  const command = {
    type: "mark_review_overdue",
    reviewId: review.id,
    triggerKey: reviewOverdueTriggerKey(review),
  } as const;
  return commandWasApplied(workspace, command) ||
      blockedCommandIds.has(systemEventCommandId(command))
    ? undefined
    : command;
}

function dueOverdueCommand(
  workspace: WorkspaceV2,
  now: ISODate,
  blockedCommandIds: ReadonlySet<string>,
): Extract<SystemEventCommand, { type: "mark_review_overdue" }> | undefined {
  return workspace.reviews
    .map((review) =>
      overdueCommandForReview(workspace, now, review.id, blockedCommandIds),
    )
    .filter(
      (
        command,
      ): command is Extract<
        SystemEventCommand,
        { type: "mark_review_overdue" }
      > => command !== undefined,
    )
    .sort(
      (left, right) =>
        compareText(left.triggerKey, right.triggerKey) ||
        compareText(left.reviewId, right.reviewId),
    )[0];
}

function dueSystemCommand(
  workspace: WorkspaceV2,
  now: ISODate,
  blockedCommandIds: ReadonlySet<string>,
): SystemEventCommand | undefined {
  return (
    dueBoundaryCommand(workspace, now, blockedCommandIds) ??
    dueReviewCommand(workspace, now, blockedCommandIds) ??
    dueOverdueCommand(workspace, now, blockedCommandIds)
  );
}

function activeProjectIds(workspace: WorkspaceV2): Set<string> {
  return new Set(
    workspace.projects
      .filter(({ stage }) => stage !== "closed")
      .map(({ id }) => id),
  );
}

function betBoundaryCandidates(workspace: WorkspaceV2): ISODate[] {
  const persistedTriggers = new Set(
    workspace.reviews.map(({ triggerKey }) => triggerKey),
  );
  const candidates: ISODate[] = [];
  for (const project of [...workspace.projects].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (
      project.activeBetId === undefined ||
      !["planning", "executing", "validating"].includes(project.stage)
    ) {
      continue;
    }
    const matches = workspace.bets.filter(
      (bet) => bet.id === project.activeBetId && bet.projectId === project.id,
    );
    if (matches.length !== 1) continue;
    const bet = matches[0];
    // invalidatedAt is an immediate tombstone, never a scheduled transition.
    if (bet.invalidatedAt !== undefined) continue;
    const start = canonicalTimestamp(bet.appetiteStart);
    const end = canonicalTimestamp(bet.appetiteEnd);
    if (start === undefined || end === undefined || end <= start) continue;
    const boundaries = [
      {
        triggerKey: `${bet.id}:midpoint`,
        dueAt: new Date(start + (end - start) / 2).toISOString(),
      },
      { triggerKey: `${bet.id}:expired`, dueAt: bet.appetiteEnd },
    ];
    for (const boundary of boundaries) {
      if (!persistedTriggers.has(boundary.triggerKey)) {
        candidates.push(boundary.dueAt);
      }
    }
  }
  return candidates;
}

function exceptionCandidates(
  workspace: WorkspaceV2,
  nowTimestamp: number,
): ISODate[] {
  const activeProjects = activeProjectIds(workspace);
  const persistedTriggers = new Set(
    workspace.reviews.map(({ triggerKey }) => triggerKey),
  );
  return workspace.exceptions.flatMap((record) => {
    if (
      (record.resolvedAt !== undefined &&
        canonicalTimestamp(record.resolvedAt) !== undefined &&
        Date.parse(record.resolvedAt) <= nowTimestamp) ||
      !activeProjects.has(record.projectId) ||
      !isUsableControlledException(record)
    ) {
      return [];
    }
    const candidates: ISODate[] = [];
    const expiresAt = canonicalTimestamp(record.expiresAt);
    if (
      expiresAt !== undefined &&
      nowTimestamp < expiresAt &&
      !persistedTriggers.has(
        `exception:${record.id}:review:${record.reviewAt}`,
      )
    ) {
      candidates.push(record.reviewAt);
    }
    if (!persistedTriggers.has(`exception:${record.id}:expired`)) {
      candidates.push(record.expiresAt);
    }
    return candidates;
  });
}

function openReviewCandidates(
  workspace: WorkspaceV2,
  nowTimestamp: number,
): ISODate[] {
  return workspace.reviews.flatMap((review) => {
    if (
      review.status !== "open" ||
      review.overdueMarkedAt !== undefined ||
      !storedReviewSemanticsAreValid(workspace, review, nowTimestamp)
    ) {
      return [];
    }
    return [review.dueAt];
  });
}

function weeklyOpeningAt(draft: ReviewQueueDraft): ISODate | undefined {
  if (
    draft.triggerType !== "weekly" ||
    draft.cadenceTimeZone === undefined
  ) {
    return undefined;
  }
  const single = /^weekly:(\d{4}-\d{2}-\d{2})$/.exec(draft.triggerKey);
  const catchup =
    /^weekly_catchup:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(
      draft.triggerKey,
    );
  const weekStart = single?.[1] ?? catchup?.[1];
  return weekStart === undefined
    ? undefined
    : instantAtLocalMinute(weekStart, 0, draft.cadenceTimeZone);
}

function derivedReviewCandidates(
  workspace: WorkspaceV2,
  now: ISODate,
  nowTimestamp: number,
): ISODate[] {
  const candidates: ISODate[] = [];
  for (let day = 0; day <= 15; day += 1) {
    const evaluatedAt =
      day === 0
        ? now
        : new Date(nowTimestamp + day * DAY_MS).toISOString();
    for (const draft of deriveReviewQueue(workspace, evaluatedAt)) {
      if (
        draft.triggerType === "bet_midpoint" ||
        draft.triggerType === "bet_expired"
      ) {
        continue;
      }
      const candidateAt =
        draft.triggerType === "weekly"
          ? weeklyOpeningAt(draft)
          : draft.dueAt;
      if (
        candidateAt !== undefined &&
        canonicalTimestamp(candidateAt) !== undefined
      ) {
        candidates.push(candidateAt);
      }
    }
  }
  return candidates;
}

function sortedWakeCandidates(
  workspace: WorkspaceV2,
  now: ISODate,
  nowTimestamp: number,
): Array<{ value: ISODate; timestamp: number }> {
  return [
    ...betBoundaryCandidates(workspace),
    ...exceptionCandidates(workspace, nowTimestamp),
    ...openReviewCandidates(workspace, nowTimestamp),
    ...derivedReviewCandidates(workspace, now, nowTimestamp),
  ]
    .map((value) => ({ value, timestamp: canonicalTimestamp(value) }))
    .filter(
      (candidate): candidate is { value: ISODate; timestamp: number } =>
        candidate.timestamp !== undefined,
    )
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || compareText(left.value, right.value),
    );
}

/** Returns the nearest unresolved system-event boundary, clamped to `now`. */
export function nextWakeAt(
  workspace: WorkspaceV2,
  now: ISODate,
): ISODate | undefined {
  const nowTimestamp = canonicalTimestamp(now);
  if (nowTimestamp === undefined) return undefined;
  const candidates = sortedWakeCandidates(workspace, now, nowTimestamp);
  const nearest = candidates[0];
  if (nearest === undefined) return undefined;
  return nearest.timestamp <= nowTimestamp ? now : nearest.value;
}

export class SystemEventCoordinator {
  private readonly maxCasRetries: number;
  private readonly maxCommandsPerRun: number;
  private readonly suppressions = new Map<string, SystemEventSuppression>();

  constructor(
    private readonly repository: SystemEventWorkspaceRepository,
    private readonly dispatcher: SystemEventCommandDispatcher,
    options: SystemEventCoordinatorOptions = {},
  ) {
    this.maxCasRetries = Math.max(
      0,
      Math.trunc(options.maxCasRetries ?? DEFAULT_MAX_CAS_RETRIES),
    );
    this.maxCommandsPerRun = Math.max(
      1,
      Math.trunc(options.maxCommandsPerRun ?? DEFAULT_MAX_COMMANDS_PER_RUN),
    );
  }

  private suppressedCommandIds(
    workspace: WorkspaceV2,
    nowTimestamp: number,
    reason: SystemEventRunReason,
  ): Set<string> {
    const blocked = new Set<string>();
    for (const [commandId, suppression] of this.suppressions) {
      if (suppression.revision !== workspace.revision) {
        this.suppressions.delete(commandId);
        continue;
      }
      if (suppression.mode === "cas_backoff") {
        const retryAt =
          suppression.retryAt === undefined
            ? undefined
            : canonicalTimestamp(suppression.retryAt);
        if (retryAt === undefined || retryAt <= nowTimestamp) {
          this.suppressions.delete(commandId);
          continue;
        }
      }
      // Boot and foreground visibility are explicit recovery opportunities.
      // Only timer-driven runs honor cross-run suppression.
      if (reason === "timer") blocked.add(commandId);
    }
    return blocked;
  }

  /**
   * Suppression-aware timer projection. Task 20's provider must schedule from
   * this instance method, not the pure `nextWakeAt` projection, or a permanent
   * rejection could be clamped to `now` forever.
   */
  nextScheduledWakeAt(
    workspace: WorkspaceV2,
    now: ISODate,
  ): ISODate | undefined {
    const nowTimestamp = canonicalTimestamp(now);
    if (nowTimestamp === undefined) return undefined;
    const blocked = this.suppressedCommandIds(
      workspace,
      nowTimestamp,
      "timer",
    );
    if (dueSystemCommand(workspace, now, blocked) !== undefined) return now;

    const future = sortedWakeCandidates(workspace, now, nowTimestamp).filter(
      ({ timestamp }) => timestamp > nowTimestamp,
    );
    const backoffs = [...this.suppressions.values()]
      .filter(
        (suppression) =>
          suppression.revision === workspace.revision &&
          suppression.mode === "cas_backoff" &&
          suppression.retryAt !== undefined,
      )
      .map((suppression) => ({
        value: suppression.retryAt!,
        timestamp: canonicalTimestamp(suppression.retryAt!),
      }))
      .filter(
        (candidate): candidate is { value: ISODate; timestamp: number } =>
          candidate.timestamp !== undefined &&
          candidate.timestamp > nowTimestamp,
      );
    return [...future, ...backoffs].sort(
      (left, right) =>
        left.timestamp - right.timestamp || compareText(left.value, right.value),
    )[0]?.value;
  }

  /**
   * `timer` respects suppression; `boot` and `visibility` explicitly bypass it
   * once. Every path still reloads and rederives before each dispatch.
   */
  async run(
    now: ISODate,
    options: SystemEventRunOptions = { reason: "boot" },
  ): Promise<WorkspaceV2 | undefined> {
    const nowTimestamp = canonicalTimestamp(now);
    if (nowTimestamp === undefined) return this.repository.load();
    const blockedForRun = new Set<string>();
    let preferredOverdueReviewId: string | undefined;
    let casCommandId: string | undefined;
    let casConflicts = 0;
    let dispatchedCommands = 0;

    while (dispatchedCommands < this.maxCommandsPerRun) {
      const workspace = await this.repository.load();
      if (workspace === undefined) return undefined;
      const blockedCommandIds = new Set([
        ...blockedForRun,
        ...this.suppressedCommandIds(workspace, nowTimestamp, options.reason),
      ]);

      let command: SystemEventCommand | undefined;
      if (preferredOverdueReviewId !== undefined) {
        command = overdueCommandForReview(
          workspace,
          now,
          preferredOverdueReviewId,
          blockedCommandIds,
        );
        if (command === undefined) preferredOverdueReviewId = undefined;
      }
      command ??= dueSystemCommand(workspace, now, blockedCommandIds);
      if (command === undefined) return workspace;

      const result = await this.dispatcher.dispatch(
        command,
        systemContext(workspace, command, now),
      );
      dispatchedCommands += 1;
      if (result.ok) {
        this.suppressions.delete(systemEventCommandId(command));
        casCommandId = undefined;
        casConflicts = 0;
        preferredOverdueReviewId =
          command.type === "create_review" ? command.review.id : undefined;
        continue;
      }
      if (result.rejection.code === "REVISION_CONFLICT") {
        const commandId = systemEventCommandId(command);
        casConflicts = casCommandId === commandId ? casConflicts + 1 : 1;
        casCommandId = commandId;
        if (casConflicts > this.maxCasRetries) {
          const latest = await this.repository.load();
          if (latest === undefined) return undefined;
          this.suppressions.set(commandId, {
            revision: latest.revision,
            mode: "cas_backoff",
            retryAt: new Date(
              nowTimestamp + SYSTEM_EVENT_CAS_BACKOFF_MS,
            ).toISOString(),
          });
          blockedForRun.add(commandId);
          casCommandId = undefined;
          casConflicts = 0;
        }
        continue;
      }
      casCommandId = undefined;
      casConflicts = 0;
      const commandId = systemEventCommandId(command);
      this.suppressions.set(commandId, {
        revision: workspace.revision,
        mode: "until_revision_change",
      });
      blockedForRun.add(commandId);
      preferredOverdueReviewId = undefined;
    }

    return this.repository.load();
  }
}
