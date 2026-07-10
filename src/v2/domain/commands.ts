import type { Evidence, Id, ISODate } from "@/domain/types";

import { applyCommandHandler } from "./commandHandlers";
import {
  createCommandRejection,
  type CommandRejection,
  type RejectionCode,
} from "./errors";
import {
  validateWorkspaceInvariants,
  type InvariantViolation,
} from "./invariants";
import {
  authorizeCommand,
  type AuthorizationContext,
} from "./policy";
import { stableHash } from "./stableHash";
import type {
  Action,
  ActorKind,
  ActualV2,
  AuditDiff,
  CapacityProfile,
  CloseDecision,
  CommandOrigin,
  CommandReceipt,
  CommandSource,
  CommitmentSlot,
  DailyCommitment,
  DirectionBrief,
  ExceptionRecord,
  JsonValue,
  ProjectHoldState,
  ProjectWorkItem,
  ReplanProposal,
  ReviewConclusion,
  ReviewRecord,
  WorkspaceV2,
} from "./types";

export type ActionDraft = Pick<
  Action,
  "id" | "title" | "eligibility" | "attention" | "desiredDate" | "fixedStart"
>;
export type ActionPatch = Partial<
  Pick<
    Action,
    "title" | "eligibility" | "attention" | "desiredDate" | "fixedStart"
  >
>;
export interface ProjectDraft {
  id: Id;
  name: string;
  priority: number;
  notes: string;
}
export type DirectionBriefDraft = Omit<
  DirectionBrief,
  "id" | "version" | "createdAt" | "updatedAt"
> & { id: Id };
export type WorkItemPatch = Partial<
  Omit<ProjectWorkItem, "id" | "projectId" | "revision" | "betScopeId">
> & { betScopeId?: Id };
export interface DailyCommitmentDraft {
  id: Id;
  localDate: string;
  proposalHash: string;
  slots: CommitmentSlot[];
}
export type ExceptionDraft = Omit<
  ExceptionRecord,
  "approvedBy" | "createdAt" | "resolvedAt" | "history"
>;
export type ReviewDraft = Omit<
  ReviewRecord,
  "status" | "createdAt" | "conclusion"
>;
export interface ConflictResolution {
  conflictId: Id;
  retainedVersion: "local" | "remote";
  reappliedCommandId?: Id;
  rationale: string;
}
export type CloseDecisionDraft = Omit<CloseDecision, "actorId" | "closedAt">;

export type V2Command =
  | { type: "configure_capacity"; profile: CapacityProfile }
  | { type: "capture_inbox"; id: Id; text: string; desiredDate?: ISODate }
  | {
      type: "confirm_action_triage";
      inboxItemId: Id;
      action: ActionDraft;
    }
  | {
      type: "confirm_project_triage";
      inboxItemId: Id;
      project: ProjectDraft;
    }
  | {
      type: "update_project_metadata";
      projectId: Id;
      name?: string;
      priority?: number;
      notes?: string;
    }
  | { type: "update_action"; actionId: Id; patch: ActionPatch }
  | {
      type: "complete_action";
      actionId: Id;
      actualSeconds: number;
      outcomeNote: string;
    }
  | {
      type: "promote_action_to_project";
      actionId: Id;
      project: ProjectDraft;
    }
  | {
      type: "update_direction";
      projectId: Id;
      brief: DirectionBriefDraft;
    }
  | { type: "place_bet"; projectId: Id; betId: Id; start: ISODate }
  | {
      type: "create_work_item";
      projectId: Id;
      workItem: ProjectWorkItem;
    }
  | {
      type: "update_work_item";
      projectId: Id;
      workItemId: Id;
      patch: WorkItemPatch;
    }
  | { type: "propose_replan"; proposal: ReplanProposal }
  | { type: "commit_today"; commitment: DailyCommitmentDraft }
  | { type: "accept_replan"; proposalId: Id; commitmentId: Id }
  | { type: "record_actual"; actual: ActualV2 }
  | { type: "attach_evidence"; evidence: Evidence }
  | { type: "approve_evidence_exception"; exception: ExceptionDraft }
  | {
      type: "resolve_evidence_exception";
      exceptionId: Id;
      resolution: string;
    }
  | { type: "request_validation"; projectId: Id }
  | { type: "satisfy_validation"; projectId: Id }
  | {
      type: "record_bet_boundary";
      projectId: Id;
      boundary: "midpoint" | "expired";
      triggerKey: string;
    }
  | { type: "mark_review_overdue"; reviewId: Id; triggerKey: string }
  | { type: "create_review"; review: ReviewDraft }
  | {
      type: "complete_review";
      reviewId: Id;
      conclusion: ReviewConclusion;
    }
  | {
      type: "resolve_sync_conflict";
      reviewId: Id;
      resolution: ConflictResolution;
    }
  | {
      type: "close_project";
      projectId: Id;
      decision: CloseDecisionDraft;
    }
  | {
      type: "abandon_project";
      projectId: Id;
      decision: CloseDecisionDraft & { outcome: "abandoned" };
    }
  | { type: "archive_project"; projectId: Id; archived: boolean };

const knownCommandTypes = new Set(
  Object.keys({
    configure_capacity: true,
    capture_inbox: true,
    confirm_action_triage: true,
    confirm_project_triage: true,
    update_project_metadata: true,
    update_action: true,
    complete_action: true,
    promote_action_to_project: true,
    update_direction: true,
    place_bet: true,
    create_work_item: true,
    update_work_item: true,
    propose_replan: true,
    commit_today: true,
    accept_replan: true,
    record_actual: true,
    attach_evidence: true,
    approve_evidence_exception: true,
    resolve_evidence_exception: true,
    request_validation: true,
    satisfy_validation: true,
    record_bet_boundary: true,
    mark_review_overdue: true,
    create_review: true,
    complete_review: true,
    resolve_sync_conflict: true,
    close_project: true,
    abandon_project: true,
    archive_project: true,
  } satisfies Record<V2Command["type"], true>),
);

function isKnownCommandType(value: unknown): value is V2Command["type"] {
  return (
    typeof value === "string" &&
    knownCommandTypes.has(value)
  );
}

export interface CommandContext {
  commandId: string;
  expectedRevision: number;
  actorId: string;
  actorKind: ActorKind;
  origin: CommandOrigin;
  source: CommandSource;
  now: ISODate;
}

export type CommandResult =
  | { ok: true; workspace: WorkspaceV2; receipt: CommandReceipt }
  | {
      ok: false;
      workspace: WorkspaceV2;
      receipt: CommandReceipt;
      rejection: CommandRejection;
    };

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueIds(values: Array<Id | undefined>): Id[] {
  return [...new Set(values.filter((value): value is Id => value !== undefined))]
    .sort(compareText);
}

function recordsWithId<T extends { id: Id }>(
  values: readonly T[],
  id: Id,
): T[] {
  return values.filter((value) => value.id === id);
}

function projectIdsForTarget(
  workspace: WorkspaceV2,
  target: CommitmentSlot["target"] | ActualV2["target"],
): Id[] {
  if (target.kind === "action") {
    return uniqueIds(
      recordsWithId(workspace.actions, target.actionId).map(
        ({ promotedProjectId }) => promotedProjectId,
      ),
    );
  }

  return uniqueIds([
    "projectId" in target ? target.projectId : undefined,
    ...recordsWithId(workspace.workItems, target.workItemId).map(
      ({ projectId }) => projectId,
    ),
  ]);
}

function projectIdsForSlots(
  workspace: WorkspaceV2,
  slots: readonly CommitmentSlot[],
): Id[] {
  return uniqueIds(
    slots.flatMap(({ target }) => projectIdsForTarget(workspace, target)),
  );
}

function projectIdsForStoredCommitment(
  workspace: WorkspaceV2,
  commitmentId: Id,
): Id[] {
  return uniqueIds(
    recordsWithId(workspace.dailyCommitments, commitmentId).flatMap(
      ({ slots }) => projectIdsForSlots(workspace, slots),
    ),
  );
}

function projectIdsForStoredProposal(
  workspace: WorkspaceV2,
  proposalId: Id,
): Id[] {
  return uniqueIds(
    recordsWithId(workspace.replanProposals, proposalId).flatMap((proposal) => [
      ...projectIdsForSlots(workspace, proposal.proposedSlots),
      ...projectIdsForStoredCommitment(
        workspace,
        proposal.baseCommitmentId,
      ),
    ]),
  );
}

function projectIdsForStoredReview(
  workspace: WorkspaceV2,
  reviewId: Id,
): Id[] {
  return uniqueIds(
    recordsWithId(workspace.reviews, reviewId).flatMap(
      ({ affectedProjectIds }) => affectedProjectIds,
    ),
  );
}

function compareCommitmentRecency(
  left: DailyCommitment,
  right: DailyCommitment,
): number {
  return (
    right.version - left.version ||
    compareText(right.committedAt, left.committedAt) ||
    compareText(left.id, right.id) ||
    compareText(canonicalString(left), canonicalString(right))
  );
}

function effectiveDailyCommitments(workspace: WorkspaceV2): DailyCommitment[] {
  const supersededIds = new Set(
    workspace.dailyCommitments
      .map(({ supersedesId }) => supersedesId)
      .filter((id): id is Id => id !== undefined),
  );
  const leavesByLocalDate = new Map<string, DailyCommitment[]>();

  for (const commitment of workspace.dailyCommitments) {
    if (supersededIds.has(commitment.id)) continue;
    const leaves = leavesByLocalDate.get(commitment.localDate) ?? [];
    leaves.push(commitment);
    leavesByLocalDate.set(commitment.localDate, leaves);
  }

  return [...leavesByLocalDate.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, leaves]) => [...leaves].sort(compareCommitmentRecency)[0]);
}

function effectiveCommitmentForLocalDate(
  workspace: WorkspaceV2,
  localDate: string,
): DailyCommitment | undefined {
  return effectiveDailyCommitments(workspace).find(
    (commitment) => commitment.localDate === localDate,
  );
}

function affectedExistingProjectIds(
  workspace: WorkspaceV2,
  command: V2Command,
): Id[] {
  let candidates: Id[];

  switch (command.type) {
    case "configure_capacity":
    case "capture_inbox":
    case "confirm_action_triage":
    case "confirm_project_triage":
    case "promote_action_to_project":
      candidates = [];
      break;

    case "update_project_metadata":
    case "place_bet":
    case "request_validation":
    case "satisfy_validation":
    case "record_bet_boundary":
    case "archive_project":
      candidates = [command.projectId];
      break;

    case "update_action":
    case "complete_action":
      candidates = uniqueIds(
        recordsWithId(workspace.actions, command.actionId).map(
          ({ promotedProjectId }) => promotedProjectId,
        ),
      );
      break;

    case "update_direction":
      candidates = [command.projectId, command.brief.projectId];
      break;

    case "create_work_item":
      candidates = [command.projectId, command.workItem.projectId];
      break;

    case "update_work_item":
      candidates = uniqueIds([
        command.projectId,
        ...recordsWithId(workspace.workItems, command.workItemId).map(
          ({ projectId }) => projectId,
        ),
      ]);
      break;

    case "propose_replan":
      candidates = uniqueIds([
        ...projectIdsForSlots(workspace, command.proposal.proposedSlots),
        ...projectIdsForStoredCommitment(
          workspace,
          command.proposal.baseCommitmentId,
        ),
      ]);
      break;

    case "commit_today": {
      const replacedCommitment = effectiveCommitmentForLocalDate(
        workspace,
        command.commitment.localDate,
      );
      candidates = uniqueIds([
        ...projectIdsForSlots(workspace, command.commitment.slots),
        ...projectIdsForSlots(workspace, replacedCommitment?.slots ?? []),
      ]);
      break;
    }

    case "accept_replan":
      candidates = uniqueIds([
        ...projectIdsForStoredProposal(workspace, command.proposalId),
        ...projectIdsForStoredCommitment(workspace, command.commitmentId),
      ]);
      break;

    case "record_actual":
      candidates = projectIdsForTarget(workspace, command.actual.target);
      break;

    case "attach_evidence":
      candidates = uniqueIds([
        command.evidence.projectId,
        ...(command.evidence.workItemId === undefined
          ? []
          : recordsWithId(
              workspace.workItems,
              command.evidence.workItemId,
            ).map(({ projectId }) => projectId)),
      ]);
      break;

    case "approve_evidence_exception":
      candidates = uniqueIds([
        command.exception.projectId,
        ...recordsWithId(
          workspace.workItems,
          command.exception.requirementId,
        ).map(({ projectId }) => projectId),
      ]);
      break;

    case "resolve_evidence_exception":
      candidates = uniqueIds(
        recordsWithId(workspace.exceptions, command.exceptionId).map(
          ({ projectId }) => projectId,
        ),
      );
      break;

    case "mark_review_overdue":
    case "complete_review":
      candidates = projectIdsForStoredReview(workspace, command.reviewId);
      break;

    case "create_review":
      candidates = command.review.affectedProjectIds;
      break;

    case "resolve_sync_conflict": {
      candidates = uniqueIds([
        ...projectIdsForStoredReview(workspace, command.reviewId),
        ...recordsWithId(
          workspace.syncConflicts,
          command.resolution.conflictId,
        ).map(({ projectId }) => projectId),
      ]);
      break;
    }

    case "close_project":
    case "abandon_project":
      candidates = uniqueIds([
        command.projectId,
        command.decision.projectId,
        command.decision.followUpProjectId,
      ]);
      break;
  }

  const existingIds = new Set(workspace.projects.map(({ id }) => id));
  return uniqueIds(candidates).filter((projectId) => existingIds.has(projectId));
}

function recordIdsForTarget(
  target: CommitmentSlot["target"] | ActualV2["target"],
): Id[] {
  return target.kind === "action"
    ? [target.actionId]
    : uniqueIds([
        target.workItemId,
        "projectId" in target ? target.projectId : undefined,
      ]);
}

function recordIdsForSlots(slots: readonly CommitmentSlot[]): Id[] {
  return uniqueIds(
    slots.flatMap((slot) => [slot.id, ...recordIdsForTarget(slot.target)]),
  );
}

function recordIdsForStoredCommitment(
  workspace: WorkspaceV2,
  commitmentId: Id,
): Id[] {
  const commitments = recordsWithId(workspace.dailyCommitments, commitmentId);
  return commitments.length === 0
    ? [commitmentId]
    : uniqueIds(
        commitments.flatMap((commitment) => [
          commitment.id,
          ...recordIdsForSlots(commitment.slots),
        ]),
      );
}

function recordIdsForStoredProposal(
  workspace: WorkspaceV2,
  proposalId: Id,
): Id[] {
  const proposals = recordsWithId(workspace.replanProposals, proposalId);
  return proposals.length === 0
    ? [proposalId]
    : uniqueIds(
        proposals.flatMap((proposal) => [
          proposal.id,
          ...recordIdsForStoredCommitment(
            workspace,
            proposal.baseCommitmentId,
          ),
          ...recordIdsForSlots(proposal.proposedSlots),
        ]),
      );
}

function recordIdsForStoredReview(
  workspace: WorkspaceV2,
  reviewId: Id,
): Id[] {
  const reviews = recordsWithId(workspace.reviews, reviewId);
  return reviews.length === 0
    ? [reviewId]
    : uniqueIds(
        reviews.flatMap((review) => [
          review.id,
          ...review.affectedProjectIds,
          ...review.affectedRecordIds,
        ]),
      );
}

function projectLifecycleRecordIds(
  workspace: WorkspaceV2,
  projectId: Id,
): Id[] {
  const projects = recordsWithId(workspace.projects, projectId);
  return projects.length === 0
    ? [projectId]
    : uniqueIds(
        projects.flatMap((project) => [
          project.id,
          project.activeDirectionBriefId,
          project.activeBetId,
          project.activePlanVersionId,
        ]),
      );
}

function affectedRecordIds(
  workspace: WorkspaceV2,
  command: V2Command,
): Id[] {
  switch (command.type) {
    case "configure_capacity":
      return [];
    case "capture_inbox":
      return [command.id];
    case "confirm_action_triage":
      return uniqueIds([command.inboxItemId, command.action.id]);
    case "confirm_project_triage":
      return uniqueIds([command.inboxItemId, command.project.id]);
    case "update_project_metadata":
    case "archive_project":
      return [command.projectId];
    case "request_validation":
    case "satisfy_validation":
      return projectLifecycleRecordIds(workspace, command.projectId);
    case "update_action":
    case "complete_action":
      return [command.actionId];
    case "promote_action_to_project":
      return uniqueIds([command.actionId, command.project.id]);
    case "update_direction":
      return uniqueIds([
        ...projectLifecycleRecordIds(workspace, command.projectId),
        command.brief.id,
      ]);
    case "place_bet":
      return uniqueIds([
        ...projectLifecycleRecordIds(workspace, command.projectId),
        command.betId,
      ]);
    case "create_work_item":
      return uniqueIds([
        command.projectId,
        command.workItem.id,
        command.workItem.betScopeId,
      ]);
    case "update_work_item": {
      return uniqueIds([
        command.projectId,
        command.workItemId,
        ...recordsWithId(workspace.workItems, command.workItemId).map(
          ({ betScopeId }) => betScopeId,
        ),
        command.patch.betScopeId,
      ]);
    }
    case "propose_replan":
      return uniqueIds([
        command.proposal.id,
        ...recordIdsForStoredCommitment(
          workspace,
          command.proposal.baseCommitmentId,
        ),
        ...recordIdsForSlots(command.proposal.proposedSlots),
      ]);
    case "commit_today": {
      const replacedCommitment = effectiveCommitmentForLocalDate(
        workspace,
        command.commitment.localDate,
      );
      return uniqueIds([
        command.commitment.id,
        ...recordIdsForSlots(command.commitment.slots),
        ...(replacedCommitment === undefined
          ? []
          : recordIdsForStoredCommitment(workspace, replacedCommitment.id)),
      ]);
    }
    case "accept_replan":
      return uniqueIds([
        ...recordIdsForStoredProposal(workspace, command.proposalId),
        ...recordIdsForStoredCommitment(workspace, command.commitmentId),
      ]);
    case "record_actual":
      return uniqueIds([command.actual.id, ...recordIdsForTarget(command.actual.target)]);
    case "attach_evidence":
      return uniqueIds([
        command.evidence.id,
        command.evidence.projectId,
        command.evidence.workItemId,
      ]);
    case "approve_evidence_exception":
      return uniqueIds([
        command.exception.id,
        command.exception.projectId,
        command.exception.requirementId,
      ]);
    case "resolve_evidence_exception":
      return uniqueIds([
        command.exceptionId,
        ...recordsWithId(workspace.exceptions, command.exceptionId).flatMap(
          ({ projectId, requirementId }) => [projectId, requirementId],
        ),
      ]);
    case "record_bet_boundary":
      return projectLifecycleRecordIds(workspace, command.projectId);
    case "mark_review_overdue":
    case "complete_review":
      return recordIdsForStoredReview(workspace, command.reviewId);
    case "create_review":
      return uniqueIds([
        command.review.id,
        ...command.review.affectedProjectIds,
        ...command.review.affectedRecordIds,
      ]);
    case "resolve_sync_conflict":
      return uniqueIds([
        ...recordIdsForStoredReview(workspace, command.reviewId),
        command.resolution.conflictId,
        ...recordsWithId(
          workspace.syncConflicts,
          command.resolution.conflictId,
        ).map(({ recordId }) => recordId),
        command.resolution.reappliedCommandId,
      ]);
    case "close_project":
    case "abandon_project": {
      const boundProjectIds = uniqueIds([
        command.projectId,
        command.decision.projectId,
        command.decision.followUpProjectId,
      ]);
      return uniqueIds([
        command.decision.id,
        ...boundProjectIds.flatMap((projectId) =>
          projectLifecycleRecordIds(workspace, projectId),
        ),
      ]);
    }
  }
}

function targetWasCommitted(
  workspace: WorkspaceV2,
  command: V2Command,
): boolean | undefined {
  let targetId: Id | undefined;
  let targetKind: "action" | "work_item" | undefined;

  switch (command.type) {
    case "record_actual":
      targetKind = command.actual.target.kind;
      targetId =
        command.actual.target.kind === "action"
          ? command.actual.target.actionId
          : command.actual.target.workItemId;
      break;
    case "attach_evidence":
      targetKind = "work_item";
      targetId = command.evidence.workItemId;
      break;
    case "configure_capacity":
    case "capture_inbox":
    case "confirm_action_triage":
    case "confirm_project_triage":
    case "update_project_metadata":
    case "update_action":
    case "complete_action":
    case "promote_action_to_project":
    case "update_direction":
    case "place_bet":
    case "create_work_item":
    case "update_work_item":
    case "propose_replan":
    case "commit_today":
    case "accept_replan":
    case "approve_evidence_exception":
    case "resolve_evidence_exception":
    case "request_validation":
    case "satisfy_validation":
    case "record_bet_boundary":
    case "mark_review_overdue":
    case "create_review":
    case "complete_review":
    case "resolve_sync_conflict":
    case "close_project":
    case "abandon_project":
    case "archive_project":
      return undefined;
  }

  if (targetId === undefined) {
    return false;
  }

  return effectiveDailyCommitments(workspace).some((commitment) =>
    commitment.slots.some(({ target }) =>
      targetKind === "action"
        ? target.kind === "action" && target.actionId === targetId
        : target.kind === "work_item" && target.workItemId === targetId,
    ),
  );
}

function deterministicTriggerKey(command: V2Command): string | undefined {
  switch (command.type) {
    case "record_bet_boundary":
    case "mark_review_overdue":
      return command.triggerKey;
    case "create_review":
      return command.review.triggerKey;
    case "configure_capacity":
    case "capture_inbox":
    case "confirm_action_triage":
    case "confirm_project_triage":
    case "update_project_metadata":
    case "update_action":
    case "complete_action":
    case "promote_action_to_project":
    case "update_direction":
    case "place_bet":
    case "create_work_item":
    case "update_work_item":
    case "propose_replan":
    case "commit_today":
    case "accept_replan":
    case "record_actual":
    case "attach_evidence":
    case "approve_evidence_exception":
    case "resolve_evidence_exception":
    case "request_validation":
    case "satisfy_validation":
    case "complete_review":
    case "resolve_sync_conflict":
    case "close_project":
    case "abandon_project":
    case "archive_project":
      return undefined;
  }
}

function buildAuthorizationContext(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): AuthorizationContext {
  const projectIds = affectedExistingProjectIds(workspace, command);
  const projectHolds: ProjectHoldState[] = projectIds.flatMap(
    (projectId) =>
      recordsWithId(workspace.projects, projectId).flatMap(
        ({ holds }) => holds,
      ),
  );

  return {
    actorKind: context.actorKind,
    origin: context.origin,
    source: context.source,
    workspaceRevision: workspace.revision,
    projectHolds,
    affectedRecordIds: affectedRecordIds(workspace, command),
    targetWasCommitted: targetWasCommitted(workspace, command),
    deterministicTriggerKey: deterministicTriggerKey(command),
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : toJsonValue(item),
    );
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  return null;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return canonicalString(left) === canonicalString(right);
}

const entityNames: Record<string, string> = {
  inboxItems: "InboxItem",
  actions: "Action",
  projects: "ProjectV2",
  directionBriefs: "DirectionBrief",
  bets: "BetVersion",
  planVersions: "PlanVersion",
  dailyCommitments: "DailyCommitment",
  replanProposals: "ReplanProposal",
  reviews: "ReviewRecord",
  exceptions: "ExceptionRecord",
  closeDecisions: "CloseDecision",
  commandProposals: "CommandProposal",
  syncConflicts: "SyncConflictRecord",
  workItems: "ProjectWorkItem",
  dependencies: "ProjectDependency",
  resources: "Resource",
  baselines: "Baseline",
  evidence: "Evidence",
  actuals: "ActualV2",
  legacyAuditRecords: "LegacyAuditRecord",
};

function isEntity(value: unknown): value is { id: Id } & Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function entityIndex(values: readonly unknown[]): Map<Id, Record<string, unknown>> {
  const sorted = values
    .filter(isEntity)
    .sort(
      (left, right) =>
        compareText(left.id, right.id) ||
        compareText(canonicalString(left), canonicalString(right)),
    );
  const result = new Map<Id, Record<string, unknown>>();
  for (const value of sorted) {
    if (!result.has(value.id)) result.set(value.id, value);
  }
  return result;
}

function diffEntityArray(
  field: string,
  before: readonly unknown[],
  after: readonly unknown[],
): AuditDiff[] | undefined {
  const combined = [...before, ...after];
  if (combined.length === 0 || !combined.every(isEntity)) return undefined;
  const beforeIds = before.map((value) => (value as { id: Id }).id);
  const afterIds = after.map((value) => (value as { id: Id }).id);
  if (
    new Set(beforeIds).size !== beforeIds.length ||
    new Set(afterIds).size !== afterIds.length
  ) {
    return undefined;
  }

  const entity = entityNames[field] ?? field;
  const beforeById = entityIndex(before);
  const afterById = entityIndex(after);
  const diffs: AuditDiff[] = [];

  for (const entityId of uniqueIds([
    ...beforeById.keys(),
    ...afterById.keys(),
  ])) {
    const beforeEntity = beforeById.get(entityId);
    const afterEntity = afterById.get(entityId);
    if (beforeEntity === undefined && afterEntity !== undefined) {
      diffs.push({
        entity,
        entityId,
        field: "created",
        before: null,
        after: toJsonValue(afterEntity),
      });
      continue;
    }
    if (beforeEntity !== undefined && afterEntity === undefined) {
      diffs.push({
        entity,
        entityId,
        field: "deleted",
        before: toJsonValue(beforeEntity),
        after: null,
      });
      continue;
    }
    if (beforeEntity === undefined || afterEntity === undefined) continue;

    const fields = [...new Set([
      ...Object.keys(beforeEntity),
      ...Object.keys(afterEntity),
    ])]
      .filter((entityField) => entityField !== "id")
      .sort(compareText);
    for (const entityField of fields) {
      const beforeValue = beforeEntity[entityField];
      const afterValue = afterEntity[entityField];
      if (!sameJson(beforeValue, afterValue)) {
        diffs.push({
          entity,
          entityId,
          field: entityField,
          before:
            beforeValue === undefined ? null : toJsonValue(beforeValue),
          after: afterValue === undefined ? null : toJsonValue(afterValue),
        });
      }
    }
  }

  return diffs;
}

function computeAuditDiff(
  beforeWorkspace: WorkspaceV2,
  afterWorkspace: WorkspaceV2,
): AuditDiff[] {
  const before = beforeWorkspace as unknown as Record<string, unknown>;
  const after = afterWorkspace as unknown as Record<string, unknown>;
  const diffs: AuditDiff[] = [];

  for (const field of [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => key !== "revision" && key !== "commandReceipts")
    .sort(compareText)) {
    const beforeValue = before[field];
    const afterValue = after[field];
    if (sameJson(beforeValue, afterValue)) continue;

    if (Array.isArray(beforeValue) && Array.isArray(afterValue)) {
      const entityDiff = diffEntityArray(field, beforeValue, afterValue);
      if (entityDiff !== undefined) {
        diffs.push(...entityDiff);
        continue;
      }
    }

    diffs.push({
      entity: "WorkspaceV2",
      entityId: beforeWorkspace.workspaceId,
      field,
      before: beforeValue === undefined ? null : toJsonValue(beforeValue),
      after: afterValue === undefined ? null : toJsonValue(afterValue),
    });
  }

  return diffs.sort(
    (left, right) =>
      compareText(left.entity, right.entity) ||
      compareText(left.entityId, right.entityId) ||
      compareText(left.field, right.field) ||
      compareText(canonicalString(left.before), canonicalString(right.before)) ||
      compareText(canonicalString(left.after), canonicalString(right.after)),
  );
}

type ReceiptBase = Omit<CommandReceipt, "receiptHash">;

async function buildReceipt(
  baseRevision: number,
  command: V2Command,
  context: CommandContext,
  status: CommandReceipt["status"],
  revision: number,
  diff: AuditDiff[],
  rejectionCode?: RejectionCode,
): Promise<CommandReceipt> {
  const commandId = context.commandId;
  const commandType = command.type;
  const actorId = context.actorId;
  const actorKind = context.actorKind;
  const origin = context.origin;
  const createdAt = context.now;
  const sourceSnapshot = structuredClone(context.source);
  const diffSnapshot = structuredClone(diff);
  const payloadHash = await stableHash(command as unknown as JsonValue);
  const base: ReceiptBase = {
    id: commandId,
    commandId,
    commandType,
    baseRevision,
    revision,
    payloadHash,
    actorId,
    actorKind,
    origin,
    source: sourceSnapshot,
    status,
    createdAt,
    diff: diffSnapshot,
    ...(rejectionCode === undefined ? {} : { rejectionCode }),
  };

  return {
    ...base,
    receiptHash: await stableHash(base as unknown as JsonValue),
  };
}

function rejectionFromInvariant(
  violation: InvariantViolation,
  workspaceRevision: number,
  context: CommandContext,
): CommandRejection {
  return createCommandRejection(
    violation.code,
    {
      actorKind: context.actorKind,
      origin: context.origin,
      workspaceRevision,
    },
    {
      reason: violation.reason,
      permittedNextCommand: violation.permittedNextCommand,
      ...(violation.gate === undefined ? {} : { gate: violation.gate }),
      ...(violation.hold === undefined ? {} : { hold: violation.hold }),
    },
  );
}

async function rejectedResult(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
  rejection: CommandRejection,
  baseRevision: number,
): Promise<Extract<CommandResult, { ok: false }>> {
  return {
    ok: false,
    workspace,
    receipt: await buildReceipt(
      baseRevision,
      command,
      context,
      "rejected",
      baseRevision,
      [],
      rejection.code,
    ),
    rejection,
  };
}

export async function executeCommand(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandResult> {
  const commandSnapshot = structuredClone(command);
  const contextSnapshot = structuredClone(context);
  const baseRevision = workspace.revision;
  const rejectionContext = {
    actorKind: contextSnapshot.actorKind,
    origin: contextSnapshot.origin,
    workspaceRevision: baseRevision,
  };

  if (contextSnapshot.expectedRevision !== baseRevision) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      createCommandRejection("REVISION_CONFLICT", rejectionContext),
      baseRevision,
    );
  }

  if (
    workspace.commandReceipts.some(
      (receipt) => receipt.commandId === contextSnapshot.commandId,
    )
  ) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      createCommandRejection("DUPLICATE_COMMAND", rejectionContext),
      baseRevision,
    );
  }

  const runtimeCommandType = (commandSnapshot as { type?: unknown }).type;
  if (!isKnownCommandType(runtimeCommandType)) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      createCommandRejection("INVALID_COMMAND", rejectionContext, {
        reason: "The command type is not recognized.",
        gate: `command_type:${String(runtimeCommandType)}`,
        permittedNextCommand: "use_supported_command",
      }),
      baseRevision,
    );
  }

  const authorizationRejection = authorizeCommand(
    runtimeCommandType,
    buildAuthorizationContext(
      workspace,
      commandSnapshot,
      contextSnapshot,
    ),
  );
  if (authorizationRejection !== undefined) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      authorizationRejection,
      baseRevision,
    );
  }

  const workspaceSnapshot = structuredClone(workspace);
  const handlerResult = await applyCommandHandler(
    workspaceSnapshot,
    commandSnapshot,
    contextSnapshot,
  );
  if (!handlerResult.ok) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      handlerResult.rejection,
      baseRevision,
    );
  }
  const candidate = handlerResult.workspace;

  const [invariantViolation] = validateWorkspaceInvariants(
    candidate,
    contextSnapshot.now,
    workspaceSnapshot,
  );
  if (invariantViolation !== undefined) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      contextSnapshot,
      rejectionFromInvariant(
        invariantViolation,
        baseRevision,
        contextSnapshot,
      ),
      baseRevision,
    );
  }

  const diff = computeAuditDiff(workspaceSnapshot, candidate);
  const nextRevision = baseRevision + 1;
  const receipt = await buildReceipt(
    baseRevision,
    commandSnapshot,
    contextSnapshot,
    "applied",
    nextRevision,
    diff,
  );
  const nextWorkspace: WorkspaceV2 = {
    ...candidate,
    revision: nextRevision,
    commandReceipts: [
      ...candidate.commandReceipts,
      structuredClone(receipt),
    ],
  };

  return {
    ok: true,
    workspace: nextWorkspace,
    receipt: structuredClone(receipt),
  };
}
