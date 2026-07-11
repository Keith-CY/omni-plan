import type { ReviewDraft, V2Command } from "./commands";
import type { LifecycleStage, ProjectV2, WorkspaceV2 } from "./types";

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

export interface BetBoundaryProposal {
  command: Extract<V2Command, { type: "record_bet_boundary" }>;
  review: ReviewDraft;
}

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
  if (!Object.prototype.hasOwnProperty.call(transitions, project.stage)) {
    return {
      ok: false,
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      project,
    };
  }

  const row = transitions[project.stage];

  if (
    row === undefined ||
    !Object.prototype.hasOwnProperty.call(row, event)
  ) {
    return {
      ok: false,
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      project,
    };
  }

  const nextStage = row[event];

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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundaryTimestamp(
  appetiteStart: string,
  appetiteEnd: string,
  boundary: "midpoint" | "expired",
): string | undefined {
  const start = Date.parse(appetiteStart);
  const end = Date.parse(appetiteEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return undefined;
  }

  return boundary === "expired"
    ? new Date(end).toISOString()
    : new Date(start + (end - start) / 2).toISOString();
}

/**
 * Derives deterministic system commands and Review drafts from Bet time.
 * This projection never mutates the Workspace and never extends or replaces a Bet.
 */
export function evaluateBetBoundary(
  workspace: WorkspaceV2,
  now: string,
): BetBoundaryProposal[] {
  const nowMilliseconds = Date.parse(now);
  if (
    !Number.isFinite(nowMilliseconds) ||
    new Date(nowMilliseconds).toISOString() !== now
  ) {
    return [];
  }

  const betsById = new Map<string, WorkspaceV2["bets"]>();
  for (const bet of workspace.bets) {
    const matches = betsById.get(bet.id) ?? [];
    matches.push(bet);
    betsById.set(bet.id, matches);
  }
  const persistedTriggerKeys = new Set(
    workspace.reviews.map(({ triggerKey }) => triggerKey),
  );
  const proposals: BetBoundaryProposal[] = [];

  for (const project of [...workspace.projects].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    if (
      project.activeBetId === undefined ||
      !["planning", "executing", "validating"].includes(project.stage)
    ) {
      continue;
    }

    const matchingBets = betsById.get(project.activeBetId) ?? [];
    if (matchingBets.length !== 1) continue;
    const bet = matchingBets[0];
    const invalidatedAt =
      bet?.invalidatedAt === undefined
        ? undefined
        : Date.parse(bet.invalidatedAt);
    const invalidationIsEffective =
      invalidatedAt !== undefined &&
      Number.isFinite(invalidatedAt) &&
      new Date(invalidatedAt).toISOString() === bet?.invalidatedAt &&
      invalidatedAt <= nowMilliseconds;
    if (
      bet === undefined ||
      bet.projectId !== project.id ||
      invalidationIsEffective
    ) {
      continue;
    }

    const midpoint = boundaryTimestamp(
      bet.appetiteStart,
      bet.appetiteEnd,
      "midpoint",
    );
    const expired = boundaryTimestamp(
      bet.appetiteStart,
      bet.appetiteEnd,
      "expired",
    );
    if (midpoint === undefined || expired === undefined) continue;

    const reachedBoundaries: Array<"midpoint" | "expired"> = [];
    if (nowMilliseconds >= Date.parse(midpoint)) {
      reachedBoundaries.push("midpoint");
    }
    if (nowMilliseconds >= Date.parse(expired)) {
      reachedBoundaries.push("expired");
    }

    for (const boundary of reachedBoundaries) {
      const triggerKey = `${bet.id}:${boundary}`;
      if (persistedTriggerKeys.has(triggerKey)) continue;
      const dueAt = boundary === "expired" ? expired : midpoint;

      proposals.push({
        command: {
          type: "record_bet_boundary",
          projectId: project.id,
          boundary,
          triggerKey,
        },
        review: {
          id: `review:${triggerKey}`,
          kind: "event",
          triggerKey,
          triggerType:
            boundary === "expired" ? "bet_expired" : "bet_midpoint",
          affectedProjectIds: [project.id],
          affectedRecordIds: [bet.id],
          dueAt,
        },
      });
    }
  }

  return proposals;
}
