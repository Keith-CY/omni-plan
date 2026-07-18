import type { Id } from "@/domain/types";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
  workspaceCommandAuthorizationRejection,
} from "./commands";
import type { RejectionCode } from "./errors";
import {
  isConcreteEvidenceRequirement,
  requirementStatus,
} from "./evidence";
import {
  deriveReviewQueue,
  overlappingWeeklyReviewCoverage,
  reviewPolicy,
  storedReviewSemanticsAreValid,
  type ReviewQueueDraft,
} from "./review";
import type {
  DailyCommitment,
  LifecycleStage,
  ProjectHold,
  ProjectHoldState,
  ProjectV2,
  ReplanProposal,
  ReviewRecord,
  WorkspaceV2,
} from "./types";
import {
  generateTodayProposal,
  soleCommitmentLeafForLocalDate,
  type TodayProposal,
} from "./today";

export type UserLifecycleStage =
  | "direction"
  | "bet"
  | "plan"
  | "execute"
  | "evidence"
  | "close";

export interface ProjectLifecycleStep {
  stage: UserLifecycleStage;
  label: "Direction" | "Bet" | "Plan" | "Execute" | "Evidence" | "Close";
  status: "completed" | "current" | "locked";
  reason?: string;
  permittedNextCommand?: string;
  historyRecordIds?: Id[];
}

export type ProjectLifecycleSelection =
  | {
      ok: true;
      projectId: Id;
      stage: LifecycleStage;
      steps: ProjectLifecycleStep[];
    }
  | {
      ok: false;
      reason: string;
      permittedNextCommand: string;
    };

export interface LockedStage {
  stage: UserLifecycleStage;
  reason: string;
  permittedNextCommand: string;
}

export type ActiveHold = ProjectHoldState & {
  reason: string;
  permittedNextCommand: string;
};

export type ActiveHoldsSelection =
  | { ok: true; projectId: Id; holds: ActiveHold[] }
  | { ok: false; reason: string; permittedNextCommand: string };

export type CommandAvailability =
  | {
      available: true;
      reason: "Command is available.";
      permittedNextCommand: string;
    }
  | {
      available: false;
      code: RejectionCode;
      reason: string;
      permittedNextCommand: string;
      gate?: string;
      hold?: ProjectHold;
    };

export type TodayStatusSelection =
  | {
      status: "blocked";
      reason: string;
      permittedNextCommand: string;
    }
  | {
      status: "proposed";
      proposal: TodayProposal;
      reason: string;
      permittedNextCommand: "commit_today";
    }
  | {
      status: "committed";
      commitment: DailyCommitment;
      reason: string;
      permittedNextCommand: "record_actual";
    }
  | {
      status: "replan_pending";
      commitment: DailyCommitment;
      proposal: ReplanProposal;
      reason: string;
      permittedNextCommand: "accept_replan";
    };

export type ReviewSummarySelection =
  | {
      ok: true;
      pending: ReviewQueueDraft[];
      open: ReviewRecord[];
      overdue: ReviewRecord[];
      completed: ReviewRecord[];
      reason: string;
      permittedNextCommand: string;
    }
  | { ok: false; reason: string; permittedNextCommand: string };

export interface RecoveryErrorCandidate {
  id: Id;
  reason: string;
  occurredAt: string;
  permittedNextCommand: string;
}

export interface RecommendedNextActionOptions {
  now?: string;
  recoveryErrors?: readonly RecoveryErrorCandidate[];
  todayProposal?: TodayProposal;
}

export interface RecommendedNextAction {
  kind:
    | "recovery_error"
    | "migration_review"
    | "sync_conflict"
    | "rebet_required"
    | "evidence_gate"
    | "review_overdue"
    | "today_decision"
    | "aging_inbox";
  recordId: Id;
  projectId?: Id;
  triggeredAt: string;
  reason: string;
  permittedNextCommand: string;
}

const lifecycleSteps = [
  { stage: "direction", label: "Direction" },
  { stage: "bet", label: "Bet" },
  { stage: "plan", label: "Plan" },
  { stage: "execute", label: "Execute" },
  { stage: "evidence", label: "Evidence" },
  { stage: "close", label: "Close" },
] as const satisfies readonly Pick<ProjectLifecycleStep, "stage" | "label">[];

const domainStageIndex: Record<LifecycleStage, number> = {
  direction: 0,
  awaiting_bet: 1,
  planning: 2,
  executing: 3,
  validating: 4,
  closing: 5,
  closed: 6,
};

const unlockByStage: Record<
  UserLifecycleStage,
  Pick<ProjectLifecycleStep, "reason" | "permittedNextCommand">
> = {
  direction: {
    reason: "Create the Project Direction before continuing.",
    permittedNextCommand: "confirm_project_triage",
  },
  bet: {
    reason: "Complete the Direction brief before placing a Bet.",
    permittedNextCommand: "update_direction",
  },
  plan: {
    reason: "Place a human Bet before planning project work.",
    permittedNextCommand: "place_bet",
  },
  execute: {
    reason: "Commit project work to Today before execution.",
    permittedNextCommand: "commit_today",
  },
  evidence: {
    reason: "Request validation before reviewing project evidence.",
    permittedNextCommand: "request_validation",
  },
  close: {
    reason: "Satisfy every validation requirement before Close.",
    permittedNextCommand: "satisfy_validation",
  },
};

const holdPriority: Record<ProjectHold, number> = {
  migration_review: 0,
  rebet_required: 1,
  review_overdue: 2,
  sync_conflict: 3,
};

const holdGuidance: Record<
  ProjectHold,
  Pick<ActiveHold, "reason" | "permittedNextCommand">
> = {
  migration_review: {
    reason: "Complete the guided migration review before changing project operations.",
    permittedNextCommand: "place_bet",
  },
  rebet_required: {
    reason:
      "A new human Bet is required before planning or execution can continue.",
    permittedNextCommand: "place_bet",
  },
  review_overdue: {
    reason: "Complete the overdue Review before creating a new commitment.",
    permittedNextCommand: "complete_review",
  },
  sync_conflict: {
    reason: "Resolve the sync conflict before changing affected records.",
    permittedNextCommand: "resolve_sync_conflict",
  },
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function selectProjectLifecycle(
  workspace: WorkspaceV2,
  projectId: Id,
): ProjectLifecycleSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return {
      ok: false,
      reason:
        projects.length === 0
          ? `Project ${projectId} does not exist.`
          : `Project ${projectId} has duplicate records for one identity.`,
      permittedNextCommand:
        projects.length === 0
          ? "confirm_project_triage"
          : "resolve_sync_conflict",
    };
  }

  const project = projects[0];
  const referenceIssue = lifecycleReferenceIssue(workspace, project);
  if (referenceIssue !== undefined) {
    return { ok: false, ...referenceIssue };
  }
  const currentIndex = domainStageIndex[project.stage];
  const historyRecordIds = (stage: UserLifecycleStage): Id[] => {
    switch (stage) {
      case "direction":
        return workspace.directionBriefs
          .filter(({ projectId: ownerId }) => ownerId === project.id)
          .map(({ id }) => id)
          .sort(compareText);
      case "bet":
        return workspace.bets
          .filter(({ projectId: ownerId }) => ownerId === project.id)
          .map(({ id }) => id)
          .sort(compareText);
      case "plan":
        return workspace.planVersions
          .filter(({ projectId: ownerId }) => ownerId === project.id)
          .map(({ id }) => id)
          .sort(compareText);
      case "execute":
        return workspace.dailyCommitments
          .filter(({ slots }) => slots.some(({ target }) =>
            target.kind === "work_item" && target.projectId === project.id))
          .map(({ id }) => id)
          .sort(compareText);
      case "evidence":
        return [
          ...workspace.evidence
            .filter(({ projectId: ownerId }) => ownerId === project.id)
            .map(({ id }) => id),
          ...workspace.exceptions
            .filter(({ projectId: ownerId }) => ownerId === project.id)
            .map(({ id }) => id),
        ].sort(compareText);
      case "close":
        return [
          ...workspace.closeDecisions
            .filter(({ projectId: ownerId }) => ownerId === project.id)
            .map(({ id }) => id),
          ...(project.legacyClosure === undefined
            ? []
            : [project.legacyClosure.legacyRecordId]),
        ].sort(compareText);
    }
  };
  return {
    ok: true,
    projectId,
    stage: project.stage,
    steps: lifecycleSteps.map((step, index): ProjectLifecycleStep => {
      if (index < currentIndex || project.stage === "closed") {
        return {
          ...step,
          status: "completed",
          historyRecordIds: historyRecordIds(step.stage),
        };
      }
      if (index === currentIndex) {
        return { ...step, status: "current" };
      }
      return { ...step, status: "locked", ...unlockByStage[step.stage] };
    }),
  };
}

export function selectLockedStages(
  workspace: WorkspaceV2,
  projectId: Id,
): LockedStage[] {
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) {
    return lifecycleSteps.map(({ stage }) => ({
      stage,
      reason: lifecycle.reason,
      permittedNextCommand: lifecycle.permittedNextCommand,
    }));
  }

  const exactProject = workspace.projects.filter(({ id }) => id === projectId)[0];
  const holdIssue = firstHoldIssue(workspace, exactProject);
  if (holdIssue !== undefined) {
    return lifecycleSteps.map(({ stage }) => ({ stage, ...holdIssue }));
  }

  const locked = lifecycle.steps.flatMap((step) =>
    step.status === "locked" &&
    step.reason !== undefined &&
    step.permittedNextCommand !== undefined
      ? [{
          stage: step.stage,
          reason: step.reason,
          permittedNextCommand: step.permittedNextCommand,
        }]
      : [],
  );
  const project = workspace.projects.find(({ id }) => id === projectId);
  const blockingHold = project?.holds
    .filter(({ type }) =>
      type === "migration_review" || type === "rebet_required")
    .sort(
      (left, right) =>
        holdPriority[left.type] - holdPriority[right.type] ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.sourceId, right.sourceId),
    )[0];
  const currentOperationalStage = project?.stage === "planning"
    ? "plan"
    : project?.stage === "executing"
      ? "execute"
      : undefined;
  if (
    blockingHold !== undefined &&
    currentOperationalStage !== undefined &&
    !locked.some(({ stage }) => stage === currentOperationalStage)
  ) {
    locked.push({
      stage: currentOperationalStage,
      ...holdGuidance[blockingHold.type],
    });
  }
  return locked.sort(
    (left, right) =>
      lifecycleSteps.findIndex(({ stage }) => stage === left.stage) -
      lifecycleSteps.findIndex(({ stage }) => stage === right.stage),
  );
}

export function selectActiveHolds(
  workspace: WorkspaceV2,
  projectId: Id,
  now?: string,
): ActiveHoldsSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return {
      ok: false,
      reason:
        projects.length === 0
          ? `Project ${projectId} does not exist.`
          : `Project ${projectId} has duplicate records for one identity.`,
      permittedNextCommand:
        projects.length === 0
          ? "confirm_project_triage"
          : "resolve_sync_conflict",
    };
  }

  const evaluatedAt = now === undefined ? undefined : canonicalTimestamp(now);
  if (now !== undefined && evaluatedAt === undefined) {
    return {
      ok: false,
      reason: "Project holds require a canonical evaluation time.",
      permittedNextCommand: "retry_with_valid_time",
    };
  }
  const holdIssue = firstHoldIssue(workspace, projects[0], evaluatedAt);
  if (holdIssue !== undefined) {
    return { ok: false, ...holdIssue };
  }

  const holds = projects[0].holds
    .map((hold): ActiveHold => ({
      type: hold.type,
      sourceId: hold.sourceId,
      affectedRecordIds: [...hold.affectedRecordIds].sort(compareText),
      createdAt: hold.createdAt,
      ...holdGuidance[hold.type],
    }))
    .sort(
      (left, right) =>
        holdPriority[left.type] - holdPriority[right.type] ||
        compareText(left.sourceId, right.sourceId) ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(
          JSON.stringify(left.affectedRecordIds),
          JSON.stringify(right.affectedRecordIds),
        ),
    );
  return { ok: true, projectId, holds };
}

export async function selectCommandAvailability(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandAvailability> {
  const result = await executeCommand(
    structuredClone(workspace),
    structuredClone(command),
    structuredClone(context),
  );
  if (result.ok) {
    return {
      available: true,
      reason: "Command is available.",
      permittedNextCommand: command.type,
    };
  }

  return {
    available: false,
    code: result.rejection.code,
    reason: result.rejection.reason,
    permittedNextCommand: result.rejection.permittedNextCommand,
    ...(result.rejection.gate === undefined
      ? {}
      : { gate: result.rejection.gate }),
    ...(result.rejection.hold === undefined
      ? {}
      : { hold: result.rejection.hold }),
  };
}

export function selectCommandPolicyAvailability(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): CommandAvailability {
  const rejection = workspaceCommandAuthorizationRejection(
    workspace,
    command,
    context,
  );
  if (rejection === undefined) {
    return {
      available: true,
      reason: "Command is available.",
      permittedNextCommand: command.type,
    };
  }
  return {
    available: false,
    code: rejection.code,
    reason: rejection.reason,
    permittedNextCommand: rejection.permittedNextCommand,
    ...(rejection.gate === undefined ? {} : { gate: rejection.gate }),
    ...(rejection.hold === undefined ? {} : { hold: rejection.hold }),
  };
}

export async function selectTodayStatus(
  workspace: WorkspaceV2,
  localDate: string,
  now: string,
): Promise<TodayStatusSelection> {
  if (workspace.capacityProfile === undefined) {
    return {
      status: "blocked",
      reason: "Configure capacity before generating Today.",
      permittedNextCommand: "configure_capacity",
    };
  }
  const localDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const validLocalDate = localDateMatch !== null && (() => {
    const date = new Date(`${localDate}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === localDate;
  })();
  const evaluatedAt = canonicalTimestamp(now);
  if (evaluatedAt === undefined || !validLocalDate) {
    return {
      status: "blocked",
      reason: "Today status requires a canonical evaluation time and local date.",
      permittedNextCommand: "retry_with_valid_time",
    };
  }

  const commitmentHistory = workspace.dailyCommitments.filter(
    (commitment) => commitment.localDate === localDate,
  );
  const duplicateCommitmentId = duplicateValue(
    workspace.dailyCommitments.map(({ id }) => id),
  );
  if (duplicateCommitmentId !== undefined) {
    return {
      status: "blocked",
      reason: `Daily Commitment identity ${duplicateCommitmentId} has duplicate stored records.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const duplicateReplanId = duplicateValue(
    workspace.replanProposals.map(({ id }) => id),
  );
  if (duplicateReplanId !== undefined) {
    return {
      status: "blocked",
      reason: `Replan identity ${duplicateReplanId} has duplicate stored records.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const commitment = soleCommitmentLeafForLocalDate(workspace, localDate);
  if (commitmentHistory.length > 0 && commitment === undefined) {
    return {
      status: "blocked",
      reason: `Today commitment history for ${localDate} has multiple current leaves.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  if (
    commitment !== undefined &&
    (canonicalTimestamp(commitment.committedAt) === undefined ||
      Date.parse(commitment.committedAt) > evaluatedAt)
  ) {
    return {
      status: "blocked",
      reason: `Today commitment ${commitment.id} has an invalid effective time.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const relevantOpenReplans = workspace.replanProposals.filter(
    ({ localDate: proposalDate, status }) =>
      proposalDate === localDate && status === "open",
  );
  for (const proposal of relevantOpenReplans) {
    const createdAt = canonicalTimestamp(proposal.createdAt);
    const baseIssue = replanBaseIssue(workspace, proposal);
    const base = workspace.dailyCommitments.find(
      ({ id }) => id === proposal.baseCommitmentId,
    );
    if (
      createdAt === undefined ||
      createdAt > evaluatedAt ||
      baseIssue !== undefined ||
      base === undefined ||
      Date.parse(proposal.createdAt) < Date.parse(base.committedAt)
    ) {
      return {
        status: "blocked",
        reason:
          baseIssue?.reason ??
          `Replan ${proposal.id} has an invalid effective time.`,
        permittedNextCommand: "resolve_sync_conflict",
      };
    }
  }
  if (commitment !== undefined) {
    const openReplans = relevantOpenReplans
      .filter((proposal) => proposal.baseCommitmentId === commitment.id)
      .sort(
        (left, right) =>
          compareText(left.createdAt, right.createdAt) ||
          compareText(left.id, right.id),
      );
    if (openReplans.length > 1) {
      return {
        status: "blocked",
        reason: `Today has multiple open Replans for current commitment ${commitment.id}.`,
        permittedNextCommand: "resolve_sync_conflict",
      };
    }
    const replan = openReplans[0];
    if (replan !== undefined) {
      return {
        status: "replan_pending",
        commitment: structuredClone(commitment),
        proposal: structuredClone(replan),
        reason:
          "Keep the committed agenda until a human accepts the pending Replan.",
        permittedNextCommand: "accept_replan",
      };
    }
    return {
      status: "committed",
      commitment: structuredClone(commitment),
      reason: "Today is committed; record progress against the preserved agenda.",
      permittedNextCommand: "record_actual",
    };
  }

  let proposal: TodayProposal;
  try {
    proposal = await generateTodayProposal(
      structuredClone(workspace),
      localDate,
      now,
    );
  } catch {
    return {
      status: "blocked",
      reason: "Today proposal inputs are invalid or ambiguous.",
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  return {
    status: "proposed",
    proposal,
    reason: "Review the proposed agenda before committing Today.",
    permittedNextCommand: "commit_today",
  };
}

function canonicalTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function duplicateValue(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort(compareText)[0];
}

interface SelectorIssue {
  reason: string;
  permittedNextCommand: string;
}

const stagesRequiringBet = new Set<LifecycleStage>([
  "planning",
  "executing",
  "validating",
  "closing",
]);

function exactRecordCount(workspace: WorkspaceV2, id: Id): number {
  const collections: readonly (readonly { id: Id }[])[] = [
    workspace.inboxItems,
    workspace.actions,
    workspace.projects,
    workspace.directionBriefs,
    workspace.bets,
    workspace.planVersions,
    workspace.dailyCommitments,
    workspace.replanProposals,
    workspace.reviews,
    workspace.exceptions,
    workspace.closeDecisions,
    workspace.commandProposals,
    workspace.syncConflicts,
    workspace.commandReceipts,
    workspace.workItems,
    workspace.dependencies,
    workspace.resources,
    workspace.baselines,
    workspace.evidence,
    workspace.actuals,
    workspace.legacyAuditRecords,
  ];
  return collections.reduce(
    (count, records) => count + records.filter((record) => record.id === id).length,
    (workspace.workspaceId === id ? 1 : 0) +
      (workspace.migration?.backupId === id ? 1 : 0),
  );
}

function recordIdentityResolves(workspace: WorkspaceV2, id: Id): boolean {
  const directCount = exactRecordCount(workspace, id);
  const nestedCount = [
    ...workspace.directionBriefs.flatMap(({ firstScope }) => firstScope),
    ...workspace.bets.flatMap(({ briefSnapshot, committedScope }) => [
      ...briefSnapshot.firstScope,
      ...committedScope,
    ]),
    ...workspace.dailyCommitments.flatMap(({ slots, capacitySnapshot }) => [
      ...slots,
      ...capacitySnapshot.unavailableBlocks,
    ]),
    ...workspace.replanProposals.flatMap(({ proposedSlots }) => proposedSlots),
    ...(workspace.capacityProfile?.unavailableBlocks ?? []),
  ].filter((record) => record.id === id).length;
  return directCount + nestedCount === 1;
}

function affectedIdsIssue(
  workspace: WorkspaceV2,
  hold: ProjectHoldState,
): SelectorIssue | undefined {
  if (
    hold.affectedRecordIds.length === 0 ||
    new Set(hold.affectedRecordIds).size !== hold.affectedRecordIds.length ||
    hold.affectedRecordIds.some((id) => !recordIdentityResolves(workspace, id))
  ) {
    return {
      reason: `Project hold ${hold.sourceId} has ambiguous affected record identities.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  return undefined;
}

function holdSourceIssue(
  workspace: WorkspaceV2,
  project: ProjectV2,
  hold: ProjectHoldState,
  now?: number,
): SelectorIssue | undefined {
  const createdAt = canonicalTimestamp(hold.createdAt);
  if (createdAt === undefined || (now !== undefined && createdAt > now)) {
    return {
      reason: `Project hold ${hold.sourceId} has an invalid creation time.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const affectedIssue = affectedIdsIssue(workspace, hold);
  if (affectedIssue !== undefined) return affectedIssue;

  switch (hold.type) {
    case "migration_review": {
      const legacySources = workspace.legacyAuditRecords.filter(
        ({ id, projectId }) => id === hold.sourceId && projectId === project.id,
      );
      const backupMatches = workspace.migration?.backupId === hold.sourceId ? 1 : 0;
      if (legacySources.length + backupMatches !== 1) {
        return {
          reason: `Migration hold ${hold.sourceId} has no unique migration source.`,
          permittedNextCommand: "resolve_sync_conflict",
        };
      }
      return undefined;
    }
    case "rebet_required": {
      const betSources = workspace.bets.filter(
        ({ id, projectId }) => id === hold.sourceId && projectId === project.id,
      );
      const reviewSources = workspace.reviews.filter(
        (review) =>
          review.id === hold.sourceId &&
          (review.affectedProjectIds.length === 0 ||
            review.affectedProjectIds.includes(project.id)),
      );
      if (betSources.length + reviewSources.length !== 1) {
        return {
          reason: `Re-bet hold ${hold.sourceId} has no unique same-project source.`,
          permittedNextCommand: "resolve_sync_conflict",
        };
      }
      return undefined;
    }
    case "review_overdue": {
      const reviews = workspace.reviews.filter(({ id }) => id === hold.sourceId);
      const review = reviews[0];
      const dueAt = review === undefined ? undefined : canonicalTimestamp(review.dueAt);
      if (
        reviews.length !== 1 ||
        review.status !== "open" ||
        (review.affectedProjectIds.length > 0 &&
          !review.affectedProjectIds.includes(project.id)) ||
        dueAt === undefined ||
        dueAt > createdAt
      ) {
        return {
          reason: `Review hold ${hold.sourceId} has no unique open overdue Review source.`,
          permittedNextCommand: "resolve_sync_conflict",
        };
      }
      return undefined;
    }
    case "sync_conflict": {
      const conflicts = workspace.syncConflicts.filter(({ id }) => id === hold.sourceId);
      const conflict = conflicts[0];
      const openedAt = conflict === undefined
        ? undefined
        : canonicalTimestamp(conflict.openedAt);
      if (
        conflicts.length !== 1 ||
        conflict.resolvedAt !== undefined ||
        conflict.retainedVersion !== undefined ||
        (conflict.projectId !== undefined && conflict.projectId !== project.id) ||
        openedAt === undefined ||
        openedAt > createdAt ||
        !hold.affectedRecordIds.includes(conflict.recordId)
      ) {
        return {
          reason: `Sync hold ${hold.sourceId} has no unique unresolved conflict source.`,
          permittedNextCommand: "resolve_sync_conflict",
        };
      }
      return undefined;
    }
  }
}

function firstHoldIssue(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now?: number,
): SelectorIssue | undefined {
  return [...project.holds]
    .sort(
      (left, right) =>
        holdPriority[left.type] - holdPriority[right.type] ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.sourceId, right.sourceId),
    )
    .map((hold) => holdSourceIssue(workspace, project, hold, now))
    .find((issue): issue is SelectorIssue => issue !== undefined);
}

function hasValidRebetHold(
  workspace: WorkspaceV2,
  project: ProjectV2,
  betId: Id,
  now?: number,
): boolean {
  return project.holds.some(
    (hold) =>
      hold.type === "rebet_required" &&
      hold.sourceId === betId &&
      holdSourceIssue(workspace, project, hold, now) === undefined,
  );
}

function activeBetIssue(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now?: number,
): SelectorIssue | undefined {
  if (!stagesRequiringBet.has(project.stage) && project.activeBetId === undefined) {
    return undefined;
  }
  if (project.activeBetId === undefined) {
    return {
      reason: `Project ${project.id} has no active Bet for ${project.stage}.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const matches = workspace.bets.filter(({ id }) => id === project.activeBetId);
  if (matches.length !== 1 || matches[0].projectId !== project.id) {
    return {
      reason: `Project ${project.id} does not resolve to exactly one same-project active Bet ${project.activeBetId}.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const bet = matches[0];
  if (bet.invalidatedAt !== undefined) {
    if (project.stage === "closing") {
      return {
        reason: `Project ${project.id} cannot Close with invalidated Bet ${bet.id}.`,
        permittedNextCommand: "resolve_sync_conflict",
      };
    }
    const invalidatedAt = canonicalTimestamp(bet.invalidatedAt);
    if (
      invalidatedAt === undefined ||
      (now !== undefined && invalidatedAt > now) ||
      !hasValidRebetHold(workspace, project, bet.id, now)
    ) {
      return {
        reason: `Project ${project.id} references invalidated Bet ${bet.id} without an effective Re-bet hold.`,
        permittedNextCommand: "resolve_sync_conflict",
      };
    }
    return undefined;
  }
  const current = workspace.bets.filter(
    ({ projectId, invalidatedAt }) =>
      projectId === project.id && invalidatedAt === undefined,
  );
  if (current.length !== 1 || current[0].id !== bet.id) {
    return {
      reason: `Project ${project.id} has ambiguous current Bet records.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  return undefined;
}

function lifecycleReferenceIssue(
  workspace: WorkspaceV2,
  project: ProjectV2,
): SelectorIssue | undefined {
  const duplicateBetId = duplicateValue(workspace.bets.map(({ id }) => id));
  if (duplicateBetId !== undefined) {
    return {
      reason: `Bet identity ${duplicateBetId} has duplicate stored records.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const briefs = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (briefs.length !== 1 || briefs[0].projectId !== project.id) {
    return {
      reason: `Project ${project.id} does not resolve to exactly one same-project active Direction brief.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const betIssue = activeBetIssue(workspace, project);
  if (betIssue !== undefined) return betIssue;
  if (project.activePlanVersionId !== undefined) {
    const plans = workspace.planVersions.filter(
      ({ id }) => id === project.activePlanVersionId,
    );
    if (
      plans.length !== 1 ||
      plans[0].projectId !== project.id ||
      (project.activeBetId !== undefined && plans[0].betId !== project.activeBetId)
    ) {
      return {
        reason: `Project ${project.id} does not resolve to exactly one active Plan for its Bet.`,
        permittedNextCommand: "resolve_sync_conflict",
      };
    }
  }
  if (project.stage !== "closed") return undefined;
  if (project.legacyClosure !== undefined) {
    const legacy = workspace.legacyAuditRecords.filter(
      ({ id, projectId, recordType, sourceChecksum }) =>
        id === project.legacyClosure?.legacyRecordId &&
        projectId === project.id &&
        recordType === "legacy_closure" &&
        sourceChecksum === project.legacyClosure?.sourceChecksum,
    );
    if (legacy.length === 1) return undefined;
  } else {
    const decisions = workspace.closeDecisions.filter(
      ({ projectId }) => projectId === project.id,
    );
    if (decisions.length === 1) return undefined;
  }
  return {
    reason: `Closed Project ${project.id} has ambiguous closure provenance.`,
    permittedNextCommand: "resolve_sync_conflict",
  };
}

function reviewSemanticsIssue(
  workspace: WorkspaceV2,
  review: ReviewRecord,
  now: number,
): SelectorIssue | undefined {
  if (!storedReviewSemanticsAreValid(workspace, review, now)) {
    return {
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const projectIdsAreValid =
    new Set(review.affectedProjectIds).size === review.affectedProjectIds.length &&
    review.affectedProjectIds.every(
      (projectId) => workspace.projects.filter(({ id }) => id === projectId).length === 1,
    );
  const recordIdsAreValid =
    new Set(review.affectedRecordIds).size === review.affectedRecordIds.length &&
    review.affectedRecordIds.every((recordId) =>
      recordIdentityResolves(workspace, recordId));
  if (!projectIdsAreValid || !recordIdsAreValid) {
    return {
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  return undefined;
}

function weeklyReviewOverlapIssue(
  workspace: WorkspaceV2,
): (SelectorIssue & { recordId: Id }) | undefined {
  const overlap = overlappingWeeklyReviewCoverage(workspace)[0];
  if (overlap === undefined) return undefined;
  return {
    recordId: overlap.leftReviewId,
    reason:
      `Weekly Reviews ${overlap.leftReviewId} and ${overlap.rightReviewId} ` +
      `have overlapping coverage at ${overlap.overlapStart}.`,
    permittedNextCommand: "resolve_sync_conflict",
  };
}

function replanBaseIssue(
  workspace: WorkspaceV2,
  proposal: ReplanProposal,
): SelectorIssue | undefined {
  const bases = workspace.dailyCommitments.filter(
    ({ id }) => id === proposal.baseCommitmentId,
  );
  const leaf = soleCommitmentLeafForLocalDate(workspace, proposal.localDate);
  if (
    bases.length !== 1 ||
    bases[0].localDate !== proposal.localDate ||
    leaf === undefined ||
    leaf.id !== bases[0].id
  ) {
    return {
      reason: `Replan ${proposal.id} does not resolve to one current same-date base commitment.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  return undefined;
}

export function selectReviewSummary(
  workspace: WorkspaceV2,
  now: string,
): ReviewSummarySelection {
  const duplicateId = duplicateValue(workspace.reviews.map(({ id }) => id));
  if (duplicateId !== undefined) {
    return {
      ok: false,
      reason: `Review identity ${duplicateId} has duplicate stored records.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const duplicateTrigger = duplicateValue(
    workspace.reviews.map(({ triggerKey }) => triggerKey),
  );
  if (duplicateTrigger !== undefined) {
    return {
      ok: false,
      reason: `Review trigger ${duplicateTrigger} has duplicate stored occurrences.`,
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const evaluatedAt = canonicalTimestamp(now);
  if (evaluatedAt === undefined) {
    return {
      ok: false,
      reason: "Review summary requires a canonical evaluation time.",
      permittedNextCommand: "retry_with_valid_time",
    };
  }
  const malformed = [...workspace.reviews]
    .sort((left, right) => compareText(left.id, right.id))
    .map((review) => ({
      review,
      issue: reviewSemanticsIssue(workspace, review, evaluatedAt),
    }))
    .find(({ issue }) => issue !== undefined);
  if (malformed !== undefined) {
    return {
      ok: false,
      reason: malformed.issue!.reason,
      permittedNextCommand: malformed.issue!.permittedNextCommand,
    };
  }
  const overlapIssue = weeklyReviewOverlapIssue(workspace);
  if (overlapIssue !== undefined) {
    return {
      ok: false,
      reason: overlapIssue.reason,
      permittedNextCommand: overlapIssue.permittedNextCommand,
    };
  }

  let pending: ReviewQueueDraft[];
  try {
    pending = deriveReviewQueue(workspace, now)
      .map((review) => structuredClone(review))
      .sort(
        (left, right) =>
          compareText(left.dueAt, right.dueAt) || compareText(left.id, right.id),
      );
  } catch {
    return {
      ok: false,
      reason: "Review derivation inputs are invalid or ambiguous.",
      permittedNextCommand: "resolve_sync_conflict",
    };
  }
  const open = workspace.reviews
    .filter(({ status }) => status === "open")
    .map((review) => structuredClone(review))
    .sort(
      (left, right) =>
        compareText(left.dueAt, right.dueAt) ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.id, right.id),
    );
  const overdue = open.filter(
    ({ dueAt }) => (canonicalTimestamp(dueAt) ?? Number.POSITIVE_INFINITY) <= evaluatedAt,
  );
  const completed = workspace.reviews
    .filter(({ status }) => status === "completed")
    .map((review) => structuredClone(review))
    .sort((left, right) => compareText(left.id, right.id));

  if (overdue.length > 0) {
    return {
      ok: true,
      pending,
      open,
      overdue,
      completed,
      reason: "Complete the oldest overdue Review.",
      permittedNextCommand: "complete_review",
    };
  }
  if (open.length > 0) {
    return {
      ok: true,
      pending,
      open,
      overdue,
      completed,
      reason: "Complete the oldest open Review.",
      permittedNextCommand: "complete_review",
    };
  }
  if (pending.length > 0) {
    return {
      ok: true,
      pending,
      open,
      overdue,
      completed,
      reason: "Create the oldest due Review occurrence.",
      permittedNextCommand: "create_review",
    };
  }
  return {
    ok: true,
    pending,
    open,
    overdue,
    completed,
    reason: "No Review action is required.",
    permittedNextCommand: "read_review_history",
  };
}

export function selectRecommendedNextAction(
  workspace: WorkspaceV2,
  projectId?: Id,
  options: RecommendedNextActionOptions = {},
): RecommendedNextAction | undefined {
  type RankedAction = RecommendedNextAction & { priority: number };
  const actions: RankedAction[] = [];
  const now = options.now === undefined
    ? undefined
    : canonicalTimestamp(options.now);
  const fallbackTime = now === undefined
    ? "1970-01-01T00:00:00.000Z"
    : options.now!;
  const inScope = (candidateProjectId: Id | undefined): boolean =>
    projectId === undefined || candidateProjectId === projectId;
  const effectiveBy = (value: string): boolean => {
    const timestamp = canonicalTimestamp(value);
    return timestamp !== undefined && (now === undefined || timestamp <= now);
  };
  const add = (priority: number, action: RecommendedNextAction): void => {
    actions.push({ ...action, priority });
  };
  const addRecovery = (
    recordId: Id,
    reason: string,
    triggeredAt = fallbackTime,
    permittedNextCommand = "restore_backup",
  ): void => add(0, {
    kind: "recovery_error",
    recordId,
    triggeredAt,
    reason,
    permittedNextCommand,
  });

  if (options.now !== undefined && now === undefined) {
    addRecovery(
      "selector:now",
      "Recommended-action selection requires a canonical evaluation time.",
      fallbackTime,
      "retry_with_valid_time",
    );
  }
  for (const error of options.recoveryErrors ?? []) {
    const occurredAt = canonicalTimestamp(error.occurredAt);
    if (occurredAt === undefined) {
      addRecovery(
        error.id,
        `Recovery error ${error.id} has an invalid occurrence time.`,
        fallbackTime,
        error.permittedNextCommand,
      );
      continue;
    }
    if (now !== undefined && occurredAt > now) continue;
    add(0, {
      kind: "recovery_error",
      recordId: error.id,
      triggeredAt: error.occurredAt,
      reason: error.reason,
      permittedNextCommand: error.permittedNextCommand,
    });
  }

  const duplicateProjectId = duplicateValue(workspace.projects.map(({ id }) => id));
  if (duplicateProjectId !== undefined) {
    addRecovery(
      duplicateProjectId,
      `Project ${duplicateProjectId} has duplicate records for one identity.`,
      fallbackTime,
      "resolve_sync_conflict",
    );
  }
  const duplicateIsOwnedByOpenConflict = (
    entity: string,
    duplicateId: Id,
  ): boolean => workspace.syncConflicts.some(
    ({ recordType, recordId, resolvedAt }) =>
      resolvedAt === undefined &&
      recordId === duplicateId &&
      ((entity === "Bet" && recordType === "bet") ||
        (entity === "Daily Commitment" && recordType === "daily_commitment")),
  );
  for (const [entity, values] of [
    ["Bet", workspace.bets.map(({ id }) => id)],
    ["Daily Commitment", workspace.dailyCommitments.map(({ id }) => id)],
    ["Sync conflict", workspace.syncConflicts.map(({ id }) => id)],
    ["Replan", workspace.replanProposals.map(({ id }) => id)],
    ["Inbox item", workspace.inboxItems.map(({ id }) => id)],
  ] as const) {
    const duplicateId = duplicateValue(values);
    if (duplicateId !== undefined) {
      if (duplicateIsOwnedByOpenConflict(entity, duplicateId)) continue;
      addRecovery(
        duplicateId,
        `${entity} ${duplicateId} has duplicate records for one identity.`,
        fallbackTime,
        "resolve_sync_conflict",
      );
    }
  }
  const duplicateReviewId = duplicateValue(workspace.reviews.map(({ id }) => id));
  const duplicateReviewTrigger = duplicateValue(
    workspace.reviews.map(({ triggerKey }) => triggerKey),
  );
  if (duplicateReviewId !== undefined) {
    addRecovery(
      duplicateReviewId,
      `Review identity ${duplicateReviewId} has duplicate stored records.`,
      fallbackTime,
      "resolve_sync_conflict",
    );
  }
  if (duplicateReviewTrigger !== undefined) {
    addRecovery(
      duplicateReviewTrigger,
      `Review trigger ${duplicateReviewTrigger} has duplicate stored occurrences.`,
      fallbackTime,
      "resolve_sync_conflict",
    );
  }
  const overlapIssue = weeklyReviewOverlapIssue(workspace);
  if (overlapIssue !== undefined) {
    addRecovery(
      overlapIssue.recordId,
      overlapIssue.reason,
      fallbackTime,
      overlapIssue.permittedNextCommand,
    );
  }
  if (
    projectId !== undefined &&
    workspace.projects.filter(({ id }) => id === projectId).length === 0
  ) {
    addRecovery(
      projectId,
      `Project ${projectId} does not exist.`,
      fallbackTime,
      "confirm_project_triage",
    );
  }

  const scopedProjects = workspace.projects
    .filter((project) => inScope(project.id) && project.stage !== "closed")
    .sort((left, right) => compareText(left.id, right.id));
  const structurallyValidBetProjectIds = new Set<Id>();
  for (const project of scopedProjects) {
    const betIssue = activeBetIssue(workspace, project, now);
    if (betIssue === undefined) {
      structurallyValidBetProjectIds.add(project.id);
      continue;
    }
    add(0, {
      kind: "recovery_error",
      recordId: project.activeBetId ?? project.id,
      projectId: project.id,
      triggeredAt: fallbackTime,
      reason: betIssue.reason,
      permittedNextCommand: betIssue.permittedNextCommand,
    });
  }
  for (const project of scopedProjects) {
    for (const hold of [...project.holds].sort(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.sourceId, right.sourceId),
    )) {
      if (!effectiveBy(hold.createdAt)) {
        if (canonicalTimestamp(hold.createdAt) === undefined) {
          addRecovery(
            hold.sourceId,
            `Project hold ${hold.sourceId} has an invalid creation time.`,
            fallbackTime,
            "resolve_sync_conflict",
          );
        }
        continue;
      }
      const sourceIssue = holdSourceIssue(workspace, project, hold, now);
      if (sourceIssue !== undefined) {
        addRecovery(
          hold.sourceId,
          sourceIssue.reason,
          hold.createdAt,
          sourceIssue.permittedNextCommand,
        );
        continue;
      }
      if (hold.type === "migration_review") {
        add(1, {
          kind: "migration_review",
          recordId: hold.sourceId,
          projectId: project.id,
          triggeredAt: hold.createdAt,
          reason: `Complete migration review for Project ${project.id}.`,
          permittedNextCommand: "place_bet",
        });
      } else if (hold.type === "rebet_required") {
        add(3, {
          kind: "rebet_required",
          recordId: hold.sourceId,
          projectId: project.id,
          triggeredAt: hold.createdAt,
          reason: `Place a new human Bet for Project ${project.id}.`,
          permittedNextCommand: "place_bet",
        });
      }
    }
  }

  const conflictOwner = (
    record: WorkspaceV2["syncConflicts"][number],
  ): { count: number; projectIds: Id[] } => {
    let count = 0;
    let projectIds: Id[] = [];
    switch (record.recordType) {
      case "bet": {
        const matches = workspace.bets.filter(({ id }) => id === record.recordId);
        count = matches.length;
        projectIds = matches.map(({ projectId: ownerId }) => ownerId);
        break;
      }
      case "daily_commitment": {
        const matches = workspace.dailyCommitments.filter(
          ({ id }) => id === record.recordId,
        );
        count = matches.length;
        projectIds = matches.flatMap(({ slots }) => slots.flatMap(({ target }) =>
          target.kind === "work_item" ? [target.projectId] : []));
        break;
      }
      case "review": {
        const matches = workspace.reviews.filter(({ id }) => id === record.recordId);
        count = matches.length;
        projectIds = matches.flatMap(({ affectedProjectIds }) => affectedProjectIds);
        break;
      }
      case "exception": {
        const matches = workspace.exceptions.filter(({ id }) => id === record.recordId);
        count = matches.length;
        projectIds = matches.map(({ projectId: ownerId }) => ownerId);
        break;
      }
      case "close": {
        const matches = workspace.closeDecisions.filter(
          ({ id }) => id === record.recordId,
        );
        count = matches.length;
        projectIds = matches.map(({ projectId: ownerId }) => ownerId);
        break;
      }
    }
    return { count, projectIds: [...new Set(projectIds)].sort(compareText) };
  };
  for (const conflict of [...workspace.syncConflicts].sort((left, right) =>
    compareText(left.id, right.id))) {
    if (conflict.resolvedAt !== undefined) {
      const resolvedAt = canonicalTimestamp(conflict.resolvedAt);
      if (
        resolvedAt === undefined ||
        conflict.retainedVersion === undefined ||
        (now !== undefined && resolvedAt > now)
      ) {
        addRecovery(
          conflict.id,
          `Sync conflict ${conflict.id} has invalid resolution semantics.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
      }
      continue;
    }
    if (conflict.retainedVersion !== undefined) {
      addRecovery(
        conflict.id,
        `Sync conflict ${conflict.id} has invalid resolution semantics.`,
        fallbackTime,
        "resolve_sync_conflict",
      );
      continue;
    }
    const owner = conflictOwner(conflict);
    const declaredProjects = conflict.projectId === undefined
      ? []
      : workspace.projects.filter(({ id }) => id === conflict.projectId);
    const invalidDeclaredProject =
      conflict.projectId !== undefined &&
      (declaredProjects.length !== 1 ||
        (owner.projectIds.length > 0 &&
          !owner.projectIds.includes(conflict.projectId)));
    if (owner.count !== 1 || invalidDeclaredProject) {
      addRecovery(
        conflict.id,
        `Sync conflict ${conflict.id} does not resolve to exactly one affected record owner.`,
        fallbackTime,
        "resolve_sync_conflict",
      );
      continue;
    }
    const ownerIds = conflict.projectId === undefined
      ? owner.projectIds
      : [conflict.projectId];
    if (projectId !== undefined && !ownerIds.includes(projectId)) continue;
    if (!effectiveBy(conflict.openedAt)) {
      if (canonicalTimestamp(conflict.openedAt) === undefined) {
        addRecovery(
          conflict.id,
          `Sync conflict ${conflict.id} has an invalid opening time.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
      }
      continue;
    }
    add(2, {
      kind: "sync_conflict",
      recordId: conflict.id,
      ...(ownerIds.length === 1 ? { projectId: ownerIds[0] } : {}),
      triggeredAt: conflict.openedAt,
      reason: `Resolve sync conflict ${conflict.id} before changing ${conflict.recordType} ${conflict.recordId}.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
  }

  if (now !== undefined) {
    for (const project of scopedProjects) {
      if (!structurallyValidBetProjectIds.has(project.id)) continue;
      if (project.activeBetId === undefined) continue;
      const bets = workspace.bets.filter(({ id }) => id === project.activeBetId);
      const bet = bets[0];
      if (bet.invalidatedAt !== undefined) continue;
      const end = canonicalTimestamp(bet.appetiteEnd);
      if (end === undefined) {
        addRecovery(
          bet.id,
          `Bet ${bet.id} has an invalid appetite boundary.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
        continue;
      }
      const alreadyHeld = hasValidRebetHold(workspace, project, bet.id, now);
      if (end <= now && !alreadyHeld) {
        add(3, {
          kind: "rebet_required",
          recordId: bet.id,
          projectId: project.id,
          triggeredAt: bet.appetiteEnd,
          reason: `Resolve expired Bet ${bet.id} for Project ${project.id}.`,
          permittedNextCommand: "record_bet_boundary",
        });
      }
    }

    const duplicateWorkItemId = duplicateValue(workspace.workItems.map(({ id }) => id));
    if (duplicateWorkItemId !== undefined) {
      addRecovery(
        duplicateWorkItemId,
        `Work Item ${duplicateWorkItemId} has duplicate records for one identity.`,
        fallbackTime,
        "resolve_sync_conflict",
      );
    } else {
      for (const project of scopedProjects) {
        if (project.stage !== "validating" && project.stage !== "closing") continue;
        const projectUpdatedAt = canonicalTimestamp(project.updatedAt);
        if (projectUpdatedAt === undefined || projectUpdatedAt > now) {
          addRecovery(
            project.id,
            `Project ${project.id} has an invalid update time for its evidence gate.`,
            fallbackTime,
            "resolve_sync_conflict",
          );
          continue;
        }
        for (const requirement of workspace.workItems
          .filter((item) =>
            item.projectId === project.id && isConcreteEvidenceRequirement(item))
          .sort((left, right) => compareText(left.id, right.id))) {
          const status = requirementStatus(
            workspace,
            project.id,
            requirement.id,
            options.now!,
          );
          if (status.satisfied) continue;
          add(4, {
            kind: "evidence_gate",
            recordId: requirement.id,
            projectId: project.id,
            triggeredAt: project.updatedAt,
            reason: `Attach evidence for milestone ${requirement.id} before validation can complete.`,
            permittedNextCommand:
              status.code === "EXCEPTION_EXPIRED"
                ? "approve_evidence_exception"
                : "attach_evidence",
          });
        }
      }
    }

    for (const review of workspace.reviews
      .filter(({ status }) => status === "open")
      .sort((left, right) => compareText(left.id, right.id))) {
      const semanticsIssue = reviewSemanticsIssue(workspace, review, now);
      if (semanticsIssue !== undefined) {
        addRecovery(
          review.id,
          semanticsIssue.reason,
          fallbackTime,
          semanticsIssue.permittedNextCommand,
        );
        continue;
      }
      const dueAt = canonicalTimestamp(review.dueAt);
      const portfolio = review.affectedProjectIds.length === 0;
      if (dueAt === undefined) {
        addRecovery(
          review.id,
          `Review ${review.id} has an invalid due time.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
        continue;
      }
      if (
        dueAt > now ||
        (projectId !== undefined &&
          !portfolio &&
          !review.affectedProjectIds.includes(projectId))
      ) continue;
      add(5, {
        kind: "review_overdue",
        recordId: review.id,
        ...(review.affectedProjectIds.length === 1
          ? { projectId: review.affectedProjectIds[0] }
          : {}),
        triggeredAt: review.dueAt,
        reason: `Complete overdue Review ${review.id}.`,
        permittedNextCommand: "complete_review",
      });
    }
  }

  if (now === undefined) {
    for (const review of workspace.reviews
      .filter(({ status, overdueMarkedAt }) =>
        status === "open" && overdueMarkedAt !== undefined)
      .sort((left, right) => compareText(left.id, right.id))) {
      const markedAt = canonicalTimestamp(review.overdueMarkedAt!);
      if (markedAt === undefined) {
        addRecovery(
          review.id,
          `Review ${review.id} has invalid stored semantics.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
        continue;
      }
      const semanticsIssue = reviewSemanticsIssue(workspace, review, markedAt);
      if (semanticsIssue !== undefined) {
        addRecovery(
          review.id,
          semanticsIssue.reason,
          review.overdueMarkedAt!,
          semanticsIssue.permittedNextCommand,
        );
        continue;
      }
      const portfolio = review.affectedProjectIds.length === 0;
      if (
        projectId !== undefined &&
        !portfolio &&
        !review.affectedProjectIds.includes(projectId)
      ) {
        continue;
      }
      add(5, {
        kind: "review_overdue",
        recordId: review.id,
        ...(review.affectedProjectIds.length === 1
          ? { projectId: review.affectedProjectIds[0] }
          : {}),
        triggeredAt: review.dueAt,
        reason: `Complete overdue Review ${review.id}.`,
        permittedNextCommand: "complete_review",
      });
    }
  }

  const proposalProjectIds = (
    proposal: ReplanProposal,
    commitment: DailyCommitment,
  ): Id[] => {
    const slots = [...commitment.slots, ...proposal.proposedSlots];
    return [...new Set(slots.flatMap(({ target }) =>
      target.kind === "work_item" ? [target.projectId] : []))].sort(compareText);
  };
  for (const proposal of workspace.replanProposals
      .filter(({ status }) => status === "open")
      .sort((left, right) => compareText(left.id, right.id))) {
    const createdAt = canonicalTimestamp(proposal.createdAt);
    if (createdAt === undefined) {
      addRecovery(
        proposal.id,
        `Replan ${proposal.id} has an invalid creation time.`,
        fallbackTime,
        "resolve_sync_conflict",
      );
      continue;
    }
    if (now !== undefined && createdAt > now) continue;
    const baseIssue = replanBaseIssue(workspace, proposal);
    if (baseIssue !== undefined) {
      addRecovery(
        proposal.id,
        baseIssue.reason,
        proposal.createdAt,
        baseIssue.permittedNextCommand,
      );
      continue;
    }
    const commitment = workspace.dailyCommitments.filter(
      ({ id }) => id === proposal.baseCommitmentId,
    )[0];
    if (Date.parse(proposal.createdAt) < Date.parse(commitment.committedAt)) {
      addRecovery(
        proposal.id,
        `Replan ${proposal.id} predates its base commitment.`,
        proposal.createdAt,
        "resolve_sync_conflict",
      );
      continue;
    }
    const ownerIds = proposalProjectIds(proposal, commitment);
    if (projectId !== undefined && !ownerIds.includes(projectId)) continue;
    add(6, {
      kind: "today_decision",
      recordId: proposal.id,
      ...(ownerIds.length === 1 ? { projectId: ownerIds[0] } : {}),
      triggeredAt: proposal.createdAt,
      reason: `Accept or dismiss Replan ${proposal.id} before changing Today.`,
      permittedNextCommand: "accept_replan",
    });
  }
  if (options.todayProposal !== undefined) {
    const generatedAt = canonicalTimestamp(options.todayProposal.generatedAt);
    const proposalOwnerIds = [...new Set(options.todayProposal.slots.flatMap(
      ({ target }) => target.kind === "work_item" ? [target.projectId] : [],
    ))].sort(compareText);
    if (generatedAt === undefined) {
      addRecovery(
        options.todayProposal.proposalHash,
        "Today proposal has an invalid generation time.",
        fallbackTime,
        "retry_with_valid_time",
      );
    } else if (
      (now === undefined || generatedAt <= now) &&
      (projectId === undefined || proposalOwnerIds.includes(projectId))
    ) {
      add(6, {
        kind: "today_decision",
        recordId: options.todayProposal.proposalHash,
        ...(proposalOwnerIds.length === 1 ? { projectId: proposalOwnerIds[0] } : {}),
        triggeredAt: options.todayProposal.generatedAt,
        reason: "Review the uncommitted Today proposal.",
        permittedNextCommand: "commit_today",
      });
    }
  }

  if (now !== undefined && projectId === undefined) {
    const agingBoundary = now - reviewPolicy.inboxAgingDays * 86_400_000;
    for (const inbox of workspace.inboxItems
      .filter(({ triageStatus }) => triageStatus === "untriaged")
      .sort((left, right) => compareText(left.id, right.id))) {
      const capturedAt = canonicalTimestamp(inbox.capturedAt);
      if (capturedAt === undefined) {
        addRecovery(
          inbox.id,
          `Inbox item ${inbox.id} has an invalid capture time.`,
          fallbackTime,
          "resolve_sync_conflict",
        );
        continue;
      }
      if (capturedAt > agingBoundary) continue;
      add(7, {
        kind: "aging_inbox",
        recordId: inbox.id,
        triggeredAt: inbox.capturedAt,
        reason: `Triage aging Inbox item ${inbox.id}.`,
        permittedNextCommand: "confirm_action_triage",
      });
    }
  }

  const selected = actions.sort(
    (left, right) =>
      left.priority - right.priority ||
      compareText(left.triggeredAt, right.triggeredAt) ||
      compareText(left.recordId, right.recordId) ||
      compareText(left.projectId ?? "", right.projectId ?? ""),
  )[0];
  if (selected === undefined) return undefined;
  const { priority: _priority, ...result } = selected;
  return result;
}
