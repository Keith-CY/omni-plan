import type { Baseline, Evidence, Id, ISODate } from "@/domain/types";

import {
  isAuthorizedEquivalentConflictResolutionFor,
  isAuthorizedConflictOpenFor,
  type AuthorizedEquivalentConflictResolution,
  type AuthorizedConflictOpen,
} from "../repositories/syncConflictOpenAuthorization";
import {
  applyCommandHandler,
  type CommandHandlerResult,
} from "./commandHandlers";
import {
  lookupConflictTarget,
  type SyncConflictDraft,
} from "./conflicts";
import {
  exactCanonicalAppetiteBoundaryHold,
  selectExactCurrentCloseBet,
} from "./close";
import {
  createCommandRejection,
  type CommandRejection,
  type RejectionCode,
} from "./errors";
import {
  validateWorkspaceInvariants,
  type InvariantViolation,
} from "./invariants";
import { localDateAt } from "./localTime";
import {
  authorizeCommand,
  authorizeCommandIdentity,
  type AuthorizationContext,
} from "./policy";
import { stableHash } from "./stableHash";
import {
  generateTodayProposal,
  soleCommitmentLeafForLocalDate,
} from "./today";
import {
  isPortfolioReviewScope,
  reviewAffectedActiveProjectIds,
} from "./review";
import { isProposableCommandType } from "./agentAuthority";
import type {
  Action,
  ActorKind,
  ActualV2,
  AuditDiff,
  CapacityProfile,
  CloseDecision,
  CommandProposal,
  CommandOrigin,
  CommandReceipt,
  CommandSource,
  CommitmentSlot,
  DailyCommitment,
  DirectionBrief,
  ExceptionRecord,
  JsonValue,
  ProjectHoldState,
  ProjectDependency,
  ProjectWorkItem,
  ReplanProposal,
  ReviewConclusion,
  ReviewRecord,
  SourceCapability,
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
  workspaceRevision: number;
  generatedAt: ISODate;
  proposalHash: string;
  slots: CommitmentSlot[];
}
export type ExceptionDraft = Omit<
  ExceptionRecord,
  "approvedBy" | "createdAt" | "resolvedAt" | "history"
>;
export type ReviewDraft = Omit<
  ReviewRecord,
  "status" | "createdAt" | "overdueMarkedAt" | "conclusion"
>;
export interface ConflictResolution {
  conflictId: Id;
  retainedVersion: "local" | "remote";
  /** Stable selected snapshot; sync maps this identity to each device's side. */
  retainedValue: JsonValue;
  /** Stable across devices even when each device labels the sides oppositely. */
  retainedBundleHash?: string;
  reappliedCommandId?: Id;
  rationale: string;
}
export type CloseDecisionDraft = Omit<CloseDecision, "actorId" | "closedAt">;

export type CoreV2Command =
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
      eligibility: Action["eligibility"];
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
      resultStatus: "completed" | "learned" | "blocked";
      outcomeNote: string;
    }
  | {
      type: "promote_action_to_project";
      actionId: Id;
      eligibility: Action["eligibility"];
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
  | { type: "upsert_dependency"; dependency: ProjectDependency }
  | { type: "remove_dependency"; dependencyId: Id }
  | { type: "remove_work_item"; projectId: Id; workItemId: Id }
  | { type: "capture_baseline"; baseline: Baseline }
  | {
      type: "complete_work_item";
      projectId: Id;
      workItemId: Id;
      resultStatus: "completed" | "learned" | "blocked";
      outcomeNote: string;
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
  | { type: "open_sync_conflict"; conflict: SyncConflictDraft }
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

export type ProposableV2Command = Extract<
  CoreV2Command,
  {
    type:
      | "update_direction"
      | "create_work_item"
      | "update_work_item"
      | "propose_replan"
      | "upsert_dependency"
      | "remove_dependency";
  }
>;

export type V2Command =
  | CoreV2Command
  | {
      type: "submit_command_proposal";
      proposalId: Id;
      command: ProposableV2Command;
      rationale: string;
    }
  | { type: "accept_command_proposal"; proposalId: Id }
  | { type: "dismiss_command_proposal"; proposalId: Id };

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
    upsert_dependency: true,
    remove_dependency: true,
    remove_work_item: true,
    capture_baseline: true,
    complete_work_item: true,
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
    open_sync_conflict: true,
    resolve_sync_conflict: true,
    close_project: true,
    abandon_project: true,
    archive_project: true,
    submit_command_proposal: true,
    accept_command_proposal: true,
    dismiss_command_proposal: true,
  } satisfies Record<V2Command["type"], true>),
);

export function isKnownV2CommandType(
  value: unknown,
): value is V2Command["type"] {
  return (
    typeof value === "string" &&
    knownCommandTypes.has(value)
  );
}

const commandKeyShapes = {
  configure_capacity: { required: ["type", "profile"] },
  capture_inbox: { required: ["type", "id", "text"], optional: ["desiredDate"] },
  confirm_action_triage: { required: ["type", "inboxItemId", "action"] },
  confirm_project_triage: {
    required: ["type", "inboxItemId", "eligibility", "project"],
  },
  update_project_metadata: {
    required: ["type", "projectId"],
    optional: ["name", "priority", "notes"],
  },
  update_action: { required: ["type", "actionId", "patch"] },
  complete_action: {
    required: ["type", "actionId", "actualSeconds", "resultStatus", "outcomeNote"],
  },
  promote_action_to_project: {
    required: ["type", "actionId", "eligibility", "project"],
  },
  update_direction: { required: ["type", "projectId", "brief"] },
  place_bet: { required: ["type", "projectId", "betId", "start"] },
  create_work_item: { required: ["type", "projectId", "workItem"] },
  update_work_item: {
    required: ["type", "projectId", "workItemId", "patch"],
  },
  upsert_dependency: { required: ["type", "dependency"] },
  remove_dependency: { required: ["type", "dependencyId"] },
  remove_work_item: { required: ["type", "projectId", "workItemId"] },
  capture_baseline: { required: ["type", "baseline"] },
  complete_work_item: {
    required: ["type", "projectId", "workItemId", "resultStatus", "outcomeNote"],
  },
  propose_replan: { required: ["type", "proposal"] },
  commit_today: { required: ["type", "commitment"] },
  accept_replan: { required: ["type", "proposalId", "commitmentId"] },
  record_actual: { required: ["type", "actual"] },
  attach_evidence: { required: ["type", "evidence"] },
  approve_evidence_exception: { required: ["type", "exception"] },
  resolve_evidence_exception: {
    required: ["type", "exceptionId", "resolution"],
  },
  request_validation: { required: ["type", "projectId"] },
  satisfy_validation: { required: ["type", "projectId"] },
  record_bet_boundary: {
    required: ["type", "projectId", "boundary", "triggerKey"],
  },
  mark_review_overdue: { required: ["type", "reviewId", "triggerKey"] },
  create_review: { required: ["type", "review"] },
  complete_review: { required: ["type", "reviewId", "conclusion"] },
  open_sync_conflict: { required: ["type", "conflict"] },
  resolve_sync_conflict: { required: ["type", "reviewId", "resolution"] },
  close_project: { required: ["type", "projectId", "decision"] },
  abandon_project: { required: ["type", "projectId", "decision"] },
  archive_project: { required: ["type", "projectId", "archived"] },
  submit_command_proposal: {
    required: ["type", "proposalId", "command", "rationale"],
  },
  accept_command_proposal: { required: ["type", "proposalId"] },
  dismiss_command_proposal: { required: ["type", "proposalId"] },
} as const satisfies Record<
  V2Command["type"],
  { required: readonly string[]; optional?: readonly string[] }
>;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwnField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((field) => hasOwnField(value, field)) &&
    Reflect.ownKeys(value).every(
      (field) => typeof field === "string" && allowed.has(field),
    )
  );
}

function isDenseArrayValue(value: unknown): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return false;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) {
      return false;
    }
  }
  return true;
}

function hasOnlyEnumerableStringKeys(value: object): boolean {
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      Object.prototype.propertyIsEnumerable.call(value, key),
  );
}

function isStringValue(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumberValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type CanonicalGraphLeafPredicate = (value: unknown) => boolean;

function isCanonicalGraph(
  value: unknown,
  isLeaf: CanonicalGraphLeafPredicate,
  seen = new Set<object>(),
): boolean {
  if (value === null || typeof value !== "object") return isLeaf(value);
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    if (!isDenseArrayValue(value)) {
      seen.delete(value);
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const valid = Reflect.ownKeys(descriptors).every((key) => {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (descriptor === undefined || !("value" in descriptor)) return false;
      if (key === "length") return descriptor.enumerable === false;
      return (
        typeof key === "string" &&
        descriptor.enumerable === true &&
        isCanonicalGraph(descriptor.value, isLeaf, seen)
      );
    });
    seen.delete(value);
    return valid;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Reflect.ownKeys(descriptors).every((key) => {
    const descriptor = descriptors[key as keyof typeof descriptors];
    return (
      typeof key === "string" &&
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      "value" in descriptor &&
      isCanonicalGraph(descriptor.value, isLeaf, seen)
    );
  });
  seen.delete(value);
  return valid;
}

/**
 * Rejects runtime graphs that cannot be safely snapshotted before command
 * validation. Clone-safe primitive leaves remain admissible so ordinary
 * malformed payloads still reach the domain's exact structural rejection.
 */
export function isCanonicalCommandRuntimeGraph(value: unknown): boolean {
  return isCanonicalGraph(value, (leaf) => {
    const kind = typeof leaf;
    return (
      leaf === null ||
      kind === "undefined" ||
      kind === "string" ||
      kind === "boolean" ||
      kind === "number" ||
      kind === "bigint"
    );
  });
}

function isJsonValue(value: unknown): value is JsonValue {
  return isCanonicalGraph(value, (leaf) => {
    if (
      leaf === null ||
      typeof leaf === "string" ||
      typeof leaf === "boolean"
    ) return true;
    return typeof leaf === "number" && Number.isFinite(leaf);
  });
}

function isOptionalStringValue(value: unknown): boolean {
  return value === undefined || isStringValue(value);
}

function isOptionalFiniteNumberValue(value: unknown): boolean {
  return value === undefined || isFiniteNumberValue(value);
}

function isOptionalBooleanValue(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isOneOf(value: unknown, options: readonly string[]): boolean {
  return isStringValue(value) && options.includes(value);
}

function isStringArrayValue(value: unknown): value is string[] {
  return isDenseArrayValue(value) && value.every(isStringValue);
}

function isWeekdayValue(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function isCapacityProfileValue(value: unknown): value is CapacityProfile {
  if (
    !isRecordValue(value) ||
    !hasExactKeys(value, [
      "timeZone",
      "weeklyWindows",
      "dailyBudgets",
      "unavailableBlocks",
      "updatedAt",
      "updatedBy",
    ]) ||
    !isStringValue(value.timeZone) ||
    !isStringValue(value.updatedAt) ||
    !isStringValue(value.updatedBy) ||
    !isDenseArrayValue(value.weeklyWindows) ||
    !isDenseArrayValue(value.dailyBudgets) ||
    !isDenseArrayValue(value.unavailableBlocks)
  ) {
    return false;
  }

  return (
    value.weeklyWindows.every(
      (window) =>
        isRecordValue(window) &&
        hasExactKeys(window, ["weekday", "startMinute", "finishMinute"]) &&
        isWeekdayValue(window.weekday) &&
        isFiniteNumberValue(window.startMinute) &&
        isFiniteNumberValue(window.finishMinute),
    ) &&
    value.dailyBudgets.every(
      (budget) =>
        isRecordValue(budget) &&
        hasExactKeys(budget, [
          "weekday",
          "deepSeconds",
          "mediumSeconds",
          "shallowSeconds",
        ]) &&
        isWeekdayValue(budget.weekday) &&
        isFiniteNumberValue(budget.deepSeconds) &&
        isFiniteNumberValue(budget.mediumSeconds) &&
        isFiniteNumberValue(budget.shallowSeconds),
    ) &&
    value.unavailableBlocks.every(
      (block) =>
        isRecordValue(block) &&
        hasExactKeys(block, ["id", "start", "finish"]) &&
        isStringValue(block.id) &&
        isStringValue(block.start) &&
        isStringValue(block.finish),
    )
  );
}

function isTargetValue(
  value: unknown,
  projectIdRequired: boolean,
): boolean {
  if (!isRecordValue(value)) return false;
  if (value.kind === "action") {
    return (
      hasExactKeys(value, ["kind", "actionId"]) &&
      isStringValue(value.actionId)
    );
  }
  if (value.kind === "work_item") {
    return (
      hasExactKeys(
        value,
        projectIdRequired
          ? ["kind", "workItemId", "projectId"]
          : ["kind", "workItemId"],
      ) &&
      isStringValue(value.workItemId) &&
      (projectIdRequired
        ? isStringValue(value.projectId)
        : value.projectId === undefined)
    );
  }
  return false;
}

function isCommitmentSlotValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "target",
      "targetRevision",
      "start",
      "finish",
      "attention",
    ]) &&
    isStringValue(value.id) &&
    isTargetValue(value.target, true) &&
    isFiniteNumberValue(value.targetRevision) &&
    isStringValue(value.start) &&
    isStringValue(value.finish) &&
    isOneOf(value.attention, ["deep", "medium", "shallow"])
  );
}

function areCommitmentSlotsValue(value: unknown): boolean {
  return isDenseArrayValue(value) && value.every(isCommitmentSlotValue);
}

function isProjectDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, ["id", "name", "priority", "notes"]) &&
    isStringValue(value.id) &&
    isStringValue(value.name) &&
    isFiniteNumberValue(value.priority) &&
    isStringValue(value.notes)
  );
}

function isActionEligibilityValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "singleSession",
      "estimateSeconds",
      "dependencyIds",
      "requiresMilestoneEvidence",
      "outcomeCount",
      "solutionKnown",
    ]) &&
    typeof value.singleSession === "boolean" &&
    isFiniteNumberValue(value.estimateSeconds) &&
    isStringArrayValue(value.dependencyIds) &&
    typeof value.requiresMilestoneEvidence === "boolean" &&
    isFiniteNumberValue(value.outcomeCount) &&
    typeof value.solutionKnown === "boolean"
  );
}

function isActionDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      ["id", "title", "eligibility", "attention"],
      ["desiredDate", "fixedStart"],
    ) &&
    isStringValue(value.id) &&
    isStringValue(value.title) &&
    isActionEligibilityValue(value.eligibility) &&
    isOneOf(value.attention, ["deep", "medium", "shallow"]) &&
    isOptionalStringValue(value.desiredDate) &&
    isOptionalStringValue(value.fixedStart)
  );
}

function isActionPatchValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [], [
      "title",
      "eligibility",
      "attention",
      "desiredDate",
      "fixedStart",
    ]) &&
    isOptionalStringValue(value.title) &&
    (value.eligibility === undefined ||
      isActionEligibilityValue(value.eligibility)) &&
    (value.attention === undefined ||
      isOneOf(value.attention, ["deep", "medium", "shallow"])) &&
    isOptionalStringValue(value.desiredDate) &&
    isOptionalStringValue(value.fixedStart)
  );
}

function isBetScopeValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, ["id", "title", "description"]) &&
    isStringValue(value.id) &&
    isStringValue(value.title) &&
    isStringValue(value.description)
  );
}

function isDirectionBriefDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "projectId",
      "audienceAndProblem",
      "successEvidence",
      "appetiteSeconds",
      "validationMethod",
      "firstScope",
      "noGoOrKill",
      "advancedNotes",
    ]) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isStringValue(value.audienceAndProblem) &&
    isStringValue(value.successEvidence) &&
    isFiniteNumberValue(value.appetiteSeconds) &&
    isStringValue(value.validationMethod) &&
    isDenseArrayValue(value.firstScope) &&
    value.firstScope.every(isBetScopeValue) &&
    isStringValue(value.noGoOrKill) &&
    isStringValue(value.advancedNotes)
  );
}

function isEstimateValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      ["mostLikelySeconds"],
      ["optimisticSeconds", "pessimisticSeconds"],
    ) &&
    isOptionalFiniteNumberValue(value.optimisticSeconds) &&
    isFiniteNumberValue(value.mostLikelySeconds) &&
    isOptionalFiniteNumberValue(value.pessimisticSeconds)
  );
}

function isConstraintValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [], [
      "noEarlierThan",
      "noLaterThan",
      "fixedStart",
      "fixedFinish",
    ]) &&
    isOptionalStringValue(value.noEarlierThan) &&
    isOptionalStringValue(value.noLaterThan) &&
    isOptionalStringValue(value.fixedStart) &&
    isOptionalStringValue(value.fixedFinish)
  );
}

function isAssignmentValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, ["resourceId", "attention", "effortSeconds"]) &&
    isStringValue(value.resourceId) &&
    isOneOf(value.attention, ["deep", "medium", "shallow"]) &&
    isFiniteNumberValue(value.effortSeconds)
  );
}

function isSplitSegmentValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, ["offsetSeconds", "durationSeconds"]) &&
    isFiniteNumberValue(value.offsetSeconds) &&
    isFiniteNumberValue(value.durationSeconds)
  );
}

function isRepeatRuleValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      ["count"],
      ["cadence", "everyDays", "startMode", "startAt"],
    ) &&
    (value.cadence === undefined ||
      isOneOf(value.cadence, ["every-n-days", "weekly", "monthly"])) &&
    isOptionalFiniteNumberValue(value.everyDays) &&
    isFiniteNumberValue(value.count) &&
    (value.startMode === undefined ||
      isOneOf(value.startMode, ["fixed-time", "after-previous-finish"])) &&
    isOptionalStringValue(value.startAt)
  );
}

function isProjectWorkItemBaseValue(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isRecordValue(value) &&
    isOptionalStringValue(value.parentId) &&
    isOneOf(value.kind, ["phase", "task", "milestone", "hammock"]) &&
    isStringValue(value.title) &&
    isStringValue(value.outline) &&
    isFiniteNumberValue(value.durationSeconds) &&
    isEstimateValue(value.estimate) &&
    (value.constraint === undefined || isConstraintValue(value.constraint)) &&
    isDenseArrayValue(value.assignmentIds) &&
    value.assignmentIds.every(isAssignmentValue) &&
    isFiniteNumberValue(value.percentComplete) &&
    isOptionalBooleanValue(value.isKeyTask) &&
    isOptionalBooleanValue(value.isScopeExpansion) &&
    isOptionalBooleanValue(value.isFastDelivery) &&
    (value.splitSegments === undefined ||
      (isDenseArrayValue(value.splitSegments) &&
        value.splitSegments.every(isSplitSegmentValue))) &&
    (value.repeatRule === undefined || isRepeatRuleValue(value.repeatRule)) &&
    isOptionalStringValue(value.hammockStartId) &&
    isOptionalStringValue(value.hammockFinishId) &&
    isOptionalBooleanValue(value.evidenceRequired) &&
    (value.resultStatus === undefined ||
      isOneOf(value.resultStatus, ["completed", "learned", "blocked"])) &&
    isOptionalStringValue(value.outcomeNote)
  );
}

function isProjectWorkItemValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "projectId",
        "kind",
        "title",
        "outline",
        "durationSeconds",
        "estimate",
        "assignmentIds",
        "percentComplete",
        "revision",
        "betScopeId",
      ],
      [
        "parentId",
        "constraint",
        "isKeyTask",
        "isScopeExpansion",
        "isFastDelivery",
        "splitSegments",
        "repeatRule",
        "hammockStartId",
        "hammockFinishId",
        "evidenceRequired",
        "resultStatus",
        "outcomeNote",
      ],
    ) &&
    isProjectWorkItemBaseValue(value) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isFiniteNumberValue(value.revision) &&
    isStringValue(value.betScopeId)
  );
}

function isWorkItemPatchValue(value: unknown): boolean {
  if (!isRecordValue(value)) return false;
  return (
    hasExactKeys(value, [], [
      "parentId",
      "kind",
      "title",
      "outline",
      "durationSeconds",
      "estimate",
      "constraint",
      "assignmentIds",
      "percentComplete",
      "isKeyTask",
      "isScopeExpansion",
      "isFastDelivery",
      "splitSegments",
      "repeatRule",
      "hammockStartId",
      "hammockFinishId",
      "evidenceRequired",
      "resultStatus",
      "outcomeNote",
      "betScopeId",
    ]) &&
    isOptionalStringValue(value.parentId) &&
    (!hasOwnField(value, "kind") ||
      isOneOf(value.kind, ["phase", "task", "milestone", "hammock"])) &&
    (!hasOwnField(value, "title") || isStringValue(value.title)) &&
    (!hasOwnField(value, "outline") || isStringValue(value.outline)) &&
    (!hasOwnField(value, "durationSeconds") ||
      isFiniteNumberValue(value.durationSeconds)) &&
    (!hasOwnField(value, "estimate") || isEstimateValue(value.estimate)) &&
    (value.constraint === undefined || isConstraintValue(value.constraint)) &&
    (!hasOwnField(value, "assignmentIds") ||
      (isDenseArrayValue(value.assignmentIds) &&
        value.assignmentIds.every(isAssignmentValue))) &&
    (!hasOwnField(value, "percentComplete") ||
      isFiniteNumberValue(value.percentComplete)) &&
    isOptionalBooleanValue(value.isKeyTask) &&
    isOptionalBooleanValue(value.isScopeExpansion) &&
    isOptionalBooleanValue(value.isFastDelivery) &&
    (value.splitSegments === undefined ||
      (isDenseArrayValue(value.splitSegments) &&
        value.splitSegments.every(isSplitSegmentValue))) &&
    (value.repeatRule === undefined || isRepeatRuleValue(value.repeatRule)) &&
    isOptionalStringValue(value.hammockStartId) &&
    isOptionalStringValue(value.hammockFinishId) &&
    isOptionalBooleanValue(value.evidenceRequired) &&
    (value.resultStatus === undefined ||
      isOneOf(value.resultStatus, ["completed", "learned", "blocked"])) &&
    isOptionalStringValue(value.outcomeNote) &&
    (!hasOwnField(value, "betScopeId") || isStringValue(value.betScopeId))
  );
}

function isProjectDependencyValue(value: unknown): value is ProjectDependency {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "projectId",
      "fromId",
      "toId",
      "type",
      "lagSeconds",
      "revision",
    ]) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isStringValue(value.fromId) &&
    isStringValue(value.toId) &&
    isOneOf(value.type, ["FS", "SS", "FF", "SF"]) &&
    isFiniteNumberValue(value.lagSeconds) &&
    isFiniteNumberValue(value.revision)
  );
}

function isStringRecordValue(value: unknown): value is Record<string, string> {
  return (
    isRecordValue(value) &&
    hasOnlyEnumerableStringKeys(value) &&
    Object.values(value).every(isStringValue)
  );
}

function isNumberRecordValue(value: unknown): value is Record<string, number> {
  return (
    isRecordValue(value) &&
    hasOnlyEnumerableStringKeys(value) &&
    Object.values(value).every(isFiniteNumberValue)
  );
}

function isBaselineValue(value: unknown): value is Baseline {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "projectId",
        "name",
        "capturedAt",
        "plannedStartByItem",
        "plannedFinishByItem",
        "plannedWorkSecondsByItem",
      ],
      ["approvedByDecisionId"],
    ) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isStringValue(value.name) &&
    isStringValue(value.capturedAt) &&
    isStringRecordValue(value.plannedStartByItem) &&
    isStringRecordValue(value.plannedFinishByItem) &&
    isNumberRecordValue(value.plannedWorkSecondsByItem) &&
    isOptionalStringValue(value.approvedByDecisionId)
  );
}

function isReplanProposalValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "localDate",
      "baseCommitmentId",
      "baseRevision",
      "reasonCodes",
      "proposedSlots",
      "proposalHash",
      "createdAt",
      "createdBy",
      "status",
    ]) &&
    isStringValue(value.id) &&
    isStringValue(value.localDate) &&
    isStringValue(value.baseCommitmentId) &&
    isFiniteNumberValue(value.baseRevision) &&
    isStringArrayValue(value.reasonCodes) &&
    areCommitmentSlotsValue(value.proposedSlots) &&
    isStringValue(value.proposalHash) &&
    isStringValue(value.createdAt) &&
    isStringValue(value.createdBy) &&
    isOneOf(value.status, ["open", "accepted", "dismissed"])
  );
}

function isDailyCommitmentDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "localDate",
      "workspaceRevision",
      "generatedAt",
      "proposalHash",
      "slots",
    ]) &&
    isStringValue(value.id) &&
    isStringValue(value.localDate) &&
    isFiniteNumberValue(value.workspaceRevision) &&
    Number.isInteger(value.workspaceRevision) &&
    Number(value.workspaceRevision) >= 0 &&
    isStringValue(value.generatedAt) &&
    isStringValue(value.proposalHash) &&
    areCommitmentSlotsValue(value.slots)
  );
}

function isActualValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "revision",
        "target",
        "actualWorkSeconds",
        "remainingWorkSeconds",
        "actualCost",
        "recordedAt",
      ],
      ["actualStart", "actualFinish"],
    ) &&
    isStringValue(value.id) &&
    isFiniteNumberValue(value.revision) &&
    isTargetValue(value.target, false) &&
    isOptionalStringValue(value.actualStart) &&
    isOptionalStringValue(value.actualFinish) &&
    isFiniteNumberValue(value.actualWorkSeconds) &&
    isFiniteNumberValue(value.remainingWorkSeconds) &&
    isFiniteNumberValue(value.actualCost) &&
    isStringValue(value.recordedAt)
  );
}

function isEvidenceValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "kind",
        "summary",
        "projectId",
        "createdAt",
        "confidence",
        "tags",
      ],
      ["url", "localFileRef", "workItemId"],
    ) &&
    isStringValue(value.id) &&
    isOneOf(value.kind, [
      "note",
      "commit",
      "pr",
      "ci",
      "doc",
      "screenshot",
      "release",
      "feedback",
      "metric",
      "email",
      "calendar",
      "minutes",
      "booking",
    ]) &&
    isStringValue(value.summary) &&
    isOptionalStringValue(value.url) &&
    isOptionalStringValue(value.localFileRef) &&
    isStringValue(value.projectId) &&
    isOptionalStringValue(value.workItemId) &&
    isStringValue(value.createdAt) &&
    isFiniteNumberValue(value.confidence) &&
    isStringArrayValue(value.tags)
  );
}

function isExceptionDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, [
      "id",
      "projectId",
      "requirementId",
      "rationale",
      "knownConsequence",
      "reviewAt",
      "expiresAt",
    ]) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isStringValue(value.requirementId) &&
    isStringValue(value.rationale) &&
    isStringValue(value.knownConsequence) &&
    isStringValue(value.reviewAt) &&
    isStringValue(value.expiresAt)
  );
}

function isReviewDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "kind",
        "triggerKey",
        "triggerType",
        "affectedProjectIds",
        "affectedRecordIds",
        "dueAt",
      ],
      ["cadenceTimeZone"],
    ) &&
    isStringValue(value.id) &&
    ((value.kind === "weekly" &&
      value.triggerType === "weekly" &&
      isStringValue(value.cadenceTimeZone)) ||
      (value.kind === "event" &&
        value.triggerType !== "weekly" &&
        value.cadenceTimeZone === undefined)) &&
    isStringValue(value.triggerKey) &&
    isOneOf(value.triggerType, [
      "weekly",
      "bet_midpoint",
      "bet_expired",
      "evidence_stale",
      "exception_expired",
      "capacity_variance",
      "hard_gate",
      "sync_conflict",
    ]) &&
    isStringArrayValue(value.affectedProjectIds) &&
    isStringArrayValue(value.affectedRecordIds) &&
    isStringValue(value.dueAt)
  );
}

function isReviewConclusionValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(value, ["summary", "decisionCodes", "followUpCommandIds"]) &&
    isStringValue(value.summary) &&
    isStringArrayValue(value.decisionCodes) &&
    isStringArrayValue(value.followUpCommandIds)
  );
}

function isConflictResolutionValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      ["conflictId", "retainedVersion", "retainedValue", "rationale"],
      ["retainedBundleHash", "reappliedCommandId"],
    ) &&
    isStringValue(value.conflictId) &&
    isOneOf(value.retainedVersion, ["local", "remote"]) &&
    isJsonValue(value.retainedValue) &&
    isStringValue(value.retainedBundleHash) &&
    isOptionalStringValue(value.reappliedCommandId) &&
    isStringValue(value.rationale)
  );
}

function isSyncConflictDraftValue(value: unknown): boolean {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "recordType",
        "recordId",
        "commonAncestorHash",
        "remoteValue",
      ],
      [
        "remoteRecordId",
        "logicalKey",
        "affectedProjectIds",
        "affectedRecordIds",
        "localValue",
        "localBundle",
        "remoteBundle",
      ],
    ) &&
    isStringValue(value.id) &&
    isOneOf(value.recordType, [
      "bet",
      "daily_commitment",
      "review",
      "exception",
      "close",
    ]) &&
    isStringValue(value.recordId) &&
    isStringValue(value.remoteRecordId) &&
    isStringValue(value.logicalKey) &&
    isStringArrayValue(value.affectedProjectIds) &&
    isStringArrayValue(value.affectedRecordIds) &&
    isStringValue(value.commonAncestorHash) &&
    isJsonValue(value.localValue) &&
    isJsonValue(value.remoteValue) &&
    isRecordValue(value.localBundle) &&
    isRecordValue(value.remoteBundle)
  );
}

function isDecisionValue(
  value: unknown,
): value is Record<string, unknown> & {
  id: string;
  projectId: string;
  followUpProjectId?: string;
} {
  return (
    isRecordValue(value) &&
    hasExactKeys(
      value,
      [
        "id",
        "projectId",
        "successComparison",
        "outcome",
        "keyLearning",
        "unfinishedDisposition",
      ],
      ["followUpProjectId"],
    ) &&
    isStringValue(value.id) &&
    isStringValue(value.projectId) &&
    isStringValue(value.successComparison) &&
    isOneOf(value.outcome, ["achieved", "partial", "invalidated", "abandoned"]) &&
    isStringValue(value.keyLearning) &&
    isOneOf(value.unfinishedDisposition, [
      "discard",
      "return_to_inbox",
      "follow_up_project",
      "historical_incomplete",
    ]) &&
    isOptionalStringValue(value.followUpProjectId)
  );
}

export function isStructurallyValidCommand(
  value: unknown,
): value is V2Command {
  if (
    !isCanonicalCommandRuntimeGraph(value) ||
    !isJsonValue(value) ||
    !isRecordValue(value) ||
    !isKnownV2CommandType(value.type)
  ) {
    return false;
  }
  const keyShape = commandKeyShapes[value.type];
  const optionalKeys = "optional" in keyShape ? keyShape.optional : [];
  if (!hasExactKeys(value, keyShape.required, optionalKeys)) return false;

  switch (value.type) {
    case "configure_capacity":
      return isCapacityProfileValue(value.profile);
    case "capture_inbox":
      return (
        isStringValue(value.id) &&
        isStringValue(value.text) &&
        isOptionalStringValue(value.desiredDate)
      );
    case "confirm_action_triage":
      return (
        isStringValue(value.inboxItemId) &&
        isActionDraftValue(value.action)
      );
    case "confirm_project_triage":
      return (
        isStringValue(value.inboxItemId) &&
        isActionEligibilityValue(value.eligibility) &&
        isProjectDraftValue(value.project)
      );
    case "update_project_metadata":
      return (
        isStringValue(value.projectId) &&
        isOptionalStringValue(value.name) &&
        isOptionalFiniteNumberValue(value.priority) &&
        isOptionalStringValue(value.notes)
      );
    case "update_action":
      return isStringValue(value.actionId) && isActionPatchValue(value.patch);
    case "complete_action":
      return (
        isStringValue(value.actionId) &&
        isFiniteNumberValue(value.actualSeconds) &&
        isOneOf(value.resultStatus, ["completed", "learned", "blocked"]) &&
        isStringValue(value.outcomeNote)
      );
    case "promote_action_to_project":
      return (
        isStringValue(value.actionId) &&
        isActionEligibilityValue(value.eligibility) &&
        isProjectDraftValue(value.project)
      );
    case "update_direction":
      return (
        isStringValue(value.projectId) &&
        isDirectionBriefDraftValue(value.brief)
      );
    case "place_bet":
      return (
        isStringValue(value.projectId) &&
        isStringValue(value.betId) &&
        isStringValue(value.start)
      );
    case "create_work_item":
      return (
        isStringValue(value.projectId) &&
        isProjectWorkItemValue(value.workItem)
      );
    case "update_work_item":
      return (
        isStringValue(value.projectId) &&
        isStringValue(value.workItemId) &&
        isWorkItemPatchValue(value.patch)
      );
    case "upsert_dependency":
      return isProjectDependencyValue(value.dependency);
    case "remove_dependency":
      return isStringValue(value.dependencyId);
    case "remove_work_item":
      return (
        isStringValue(value.projectId) && isStringValue(value.workItemId)
      );
    case "capture_baseline":
      return isBaselineValue(value.baseline);
    case "complete_work_item":
      return (
        isStringValue(value.projectId) &&
        isStringValue(value.workItemId) &&
        isOneOf(value.resultStatus, ["completed", "learned", "blocked"]) &&
        isStringValue(value.outcomeNote)
      );
    case "propose_replan":
      return isReplanProposalValue(value.proposal);
    case "commit_today":
      return isDailyCommitmentDraftValue(value.commitment);
    case "accept_replan":
      return (
        isStringValue(value.proposalId) &&
        isStringValue(value.commitmentId)
      );
    case "record_actual":
      return isActualValue(value.actual);
    case "attach_evidence":
      return isEvidenceValue(value.evidence);
    case "approve_evidence_exception":
      return isExceptionDraftValue(value.exception);
    case "resolve_evidence_exception":
      return (
        isStringValue(value.exceptionId) && isStringValue(value.resolution)
      );
    case "request_validation":
    case "satisfy_validation":
      return isStringValue(value.projectId);
    case "record_bet_boundary":
      return (
        isStringValue(value.projectId) &&
        (value.boundary === "midpoint" || value.boundary === "expired") &&
        isStringValue(value.triggerKey)
      );
    case "mark_review_overdue":
      return (
        isStringValue(value.reviewId) && isStringValue(value.triggerKey)
      );
    case "create_review":
      return isReviewDraftValue(value.review);
    case "complete_review":
      return (
        isStringValue(value.reviewId) &&
        isReviewConclusionValue(value.conclusion)
      );
    case "open_sync_conflict":
      return isSyncConflictDraftValue(value.conflict);
    case "resolve_sync_conflict":
      return (
        isStringValue(value.reviewId) &&
        isConflictResolutionValue(value.resolution)
      );
    case "close_project":
      return isStringValue(value.projectId) && isDecisionValue(value.decision);
    case "abandon_project":
      return (
        isStringValue(value.projectId) &&
        isDecisionValue(value.decision) &&
        value.decision.outcome === "abandoned"
      );
    case "archive_project":
      return (
        isStringValue(value.projectId) && typeof value.archived === "boolean"
      );
    case "submit_command_proposal":
      return (
        isStringValue(value.proposalId) &&
        isStringValue(value.rationale) &&
        isProposableV2Command(value.command)
      );
    case "accept_command_proposal":
    case "dismiss_command_proposal":
      return isStringValue(value.proposalId);
  }
}

export function isProposableV2Command(
  value: unknown,
): value is ProposableV2Command {
  return (
    isStructurallyValidCommand(value) &&
    isProposableCommandType(value.type)
  );
}

function normalizedCommandType(value: unknown): string {
  return isRecordValue(value) && isStringValue(value.type)
    ? value.type
    : "invalid_command";
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

const knownSourceCapabilities = new Set(
  Object.keys({
    human_decision: true,
    capture_inbox: true,
    record_actual: true,
    attach_evidence: true,
    submit_proposal: true,
    import_portable: true,
    replay_receipt: true,
    system_time: true,
    open_conflict: true,
  } satisfies Record<SourceCapability, true>),
);

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value
  );
}

function isCanonicalTimestamp(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

export function isStructurallyValidCommandContext(
  value: unknown,
): value is CommandContext {
  if (
    !isCanonicalCommandRuntimeGraph(value) ||
    !isRecordValue(value) ||
    !hasExactKeys(value, [
      "commandId",
      "expectedRevision",
      "actorId",
      "actorKind",
      "origin",
      "source",
      "now",
    ]) ||
    !isCanonicalIdentifier(value.commandId) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 0 ||
    !isCanonicalIdentifier(value.actorId) ||
    !isOneOf(value.actorKind, ["human", "agent", "system"]) ||
    !isOneOf(value.origin, ["ui", "agent", "import", "sync", "migration"]) ||
    !isCanonicalTimestamp(value.now) ||
    !isRecordValue(value.source) ||
    !hasExactKeys(value.source, ["sourceId", "verified", "capabilities"]) ||
    !isCanonicalIdentifier(value.source.sourceId) ||
    typeof value.source.verified !== "boolean" ||
    !isDenseArrayValue(value.source.capabilities)
  ) return false;
  const capabilities = value.source.capabilities;
  return (
    capabilities.every(
      (capability): capability is SourceCapability =>
        typeof capability === "string" &&
        knownSourceCapabilities.has(capability),
    ) &&
    new Set(capabilities).size === capabilities.length
  );
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

function projectIdsMutatedByReviewCommand(
  workspace: WorkspaceV2,
  reviewId: Id,
  operation: "mark" | "complete",
): Id[] {
  const affectedProjectIds = uniqueIds(
    recordsWithId(workspace.reviews, reviewId).flatMap((review) =>
      reviewAffectedActiveProjectIds(workspace, review),
    ),
  );
  if (operation === "mark") return affectedProjectIds;
  return affectedProjectIds.filter((projectId) =>
    recordsWithId(workspace.projects, projectId).some((project) =>
      project.holds.some(
        ({ type, sourceId }) =>
          type === "review_overdue" && sourceId === reviewId,
      ),
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

function soleEffectiveCommitmentForNow(
  workspace: WorkspaceV2,
  now: ISODate,
): DailyCommitment | undefined {
  const matching: DailyCommitment[] = [];
  const localDates = [
    ...new Set(workspace.dailyCommitments.map(({ localDate }) => localDate)),
  ].sort(compareText);

  for (const localDate of localDates) {
    const couldBeCurrent = workspace.dailyCommitments.some(
      (commitment) =>
        commitment.localDate === localDate &&
        localDateAt(now, commitment.capacitySnapshot.timeZone) === localDate,
    );
    if (!couldBeCurrent) continue;
    const commitment = soleCommitmentLeafForLocalDate(workspace, localDate);
    if (commitment === undefined) return undefined;
    if (
      localDateAt(now, commitment.capacitySnapshot.timeZone) ===
      commitment.localDate
    ) {
      matching.push(commitment);
    }
  }

  return matching.length === 1 ? matching[0] : undefined;
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
    case "submit_command_proposal":
    case "accept_command_proposal":
    case "dismiss_command_proposal":
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

    case "upsert_dependency":
      candidates = uniqueIds([
        command.dependency.projectId,
        ...recordsWithId(workspace.workItems, command.dependency.fromId).map(
          ({ projectId }) => projectId,
        ),
        ...recordsWithId(workspace.workItems, command.dependency.toId).map(
          ({ projectId }) => projectId,
        ),
      ]);
      break;

    case "remove_dependency":
      candidates = uniqueIds(
        recordsWithId(workspace.dependencies, command.dependencyId).map(
          ({ projectId }) => projectId,
        ),
      );
      break;

    case "remove_work_item":
    case "complete_work_item":
      candidates = uniqueIds([
        command.projectId,
        ...recordsWithId(workspace.workItems, command.workItemId).map(
          ({ projectId }) => projectId,
        ),
      ]);
      break;

    case "capture_baseline": {
      const itemIds = uniqueIds([
        ...Object.keys(command.baseline.plannedStartByItem),
        ...Object.keys(command.baseline.plannedFinishByItem),
        ...Object.keys(command.baseline.plannedWorkSecondsByItem),
      ]);
      candidates = uniqueIds([
        command.baseline.projectId,
        ...itemIds.flatMap((itemId) =>
          recordsWithId(workspace.workItems, itemId).map(
            ({ projectId }) => projectId,
          ),
        ),
      ]);
      break;
    }

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
      candidates = projectIdsMutatedByReviewCommand(
        workspace,
        command.reviewId,
        "mark",
      );
      break;

    case "complete_review":
      candidates = projectIdsMutatedByReviewCommand(
        workspace,
        command.reviewId,
        "complete",
      );
      break;

    case "create_review":
      candidates = [];
      break;

    case "open_sync_conflict": {
      const target = lookupConflictTarget(workspace, command.conflict);
      candidates = target.ok ? target.target.projectIds : [];
      break;
    }

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
    case "submit_command_proposal":
    case "accept_command_proposal":
    case "dismiss_command_proposal":
      return [command.proposalId];
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
    case "upsert_dependency":
      return uniqueIds([
        command.dependency.id,
        command.dependency.projectId,
        command.dependency.fromId,
        command.dependency.toId,
      ]);
    case "remove_dependency":
      return uniqueIds([
        command.dependencyId,
        ...recordsWithId(workspace.dependencies, command.dependencyId).flatMap(
          ({ projectId, fromId, toId }) => [projectId, fromId, toId],
        ),
      ]);
    case "remove_work_item":
    case "complete_work_item":
      return uniqueIds([
        command.projectId,
        command.workItemId,
        ...recordsWithId(workspace.workItems, command.workItemId).map(
          ({ betScopeId }) => betScopeId,
        ),
      ]);
    case "capture_baseline":
      return uniqueIds([
        command.baseline.id,
        command.baseline.projectId,
        command.baseline.approvedByDecisionId,
        ...Object.keys(command.baseline.plannedStartByItem),
        ...Object.keys(command.baseline.plannedFinishByItem),
        ...Object.keys(command.baseline.plannedWorkSecondsByItem),
      ]);
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
        command.commitmentId,
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
    case "open_sync_conflict":
      return uniqueIds([
        command.conflict.id,
        command.conflict.recordId,
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

function policyMutationTargetIds(
  workspace: WorkspaceV2,
  command: V2Command,
): Id[] {
  switch (command.type) {
    case "create_review":
      return [command.review.id];
    case "mark_review_overdue":
      return uniqueIds([
        command.reviewId,
        ...projectIdsMutatedByReviewCommand(
          workspace,
          command.reviewId,
          "mark",
        ),
      ]);
    case "complete_review":
      return uniqueIds([
        command.reviewId,
        ...projectIdsMutatedByReviewCommand(
          workspace,
          command.reviewId,
          "complete",
        ),
      ]);
    default:
      return affectedRecordIds(workspace, command);
  }
}

function classifyWorkItemScopeExpansion(
  workspace: WorkspaceV2,
  command: Extract<V2Command, { type: "update_work_item" }>,
): boolean | undefined {
  const workItems = recordsWithId(workspace.workItems, command.workItemId);
  const projects = recordsWithId(workspace.projects, command.projectId);
  if (workItems.length !== 1 || projects.length !== 1) return undefined;
  const workItem = workItems[0];
  const project = projects[0];
  if (
    workItem.projectId !== project.id ||
    project.activeBetId === undefined ||
    !["planning", "executing", "validating"].includes(project.stage)
  ) {
    return undefined;
  }
  const bets = recordsWithId(workspace.bets, project.activeBetId);
  if (bets.length !== 1) return undefined;
  const bet = bets[0];
  if (
    bet.projectId !== project.id ||
    bet.invalidatedAt !== undefined ||
    !bet.committedScope.some(({ id }) => id === workItem.betScopeId)
  ) {
    return undefined;
  }
  return (
    workItem.isScopeExpansion === true ||
    command.patch.isScopeExpansion === true
  );
}

function targetWasCommitted(
  workspace: WorkspaceV2,
  command: V2Command,
  now: ISODate,
): boolean | undefined {
  let targetId: Id | undefined;
  let targetKind: "action" | "work_item" | undefined;

  switch (command.type) {
    case "complete_action":
      targetKind = "action";
      targetId = command.actionId;
      break;
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
    case "complete_work_item":
      {
        const workItems = workspace.workItems.filter(
          ({ id, projectId }) =>
            id === command.workItemId && projectId === command.projectId,
        );
        const commitment = soleEffectiveCommitmentForNow(workspace, now);
        if (workItems.length !== 1 || commitment === undefined) return false;
        const workItem = workItems[0];
        return commitment.slots.some(
          ({ target, targetRevision }) =>
            target.kind === "work_item" &&
            target.projectId === command.projectId &&
            target.workItemId === workItem.id &&
            targetRevision === workItem.revision,
        );
      }
    case "configure_capacity":
    case "capture_inbox":
    case "confirm_action_triage":
    case "confirm_project_triage":
    case "update_project_metadata":
    case "update_action":
    case "promote_action_to_project":
    case "update_direction":
    case "place_bet":
    case "create_work_item":
    case "update_work_item":
    case "upsert_dependency":
    case "remove_dependency":
    case "remove_work_item":
    case "capture_baseline":
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
    case "open_sync_conflict":
    case "resolve_sync_conflict":
    case "close_project":
    case "abandon_project":
    case "archive_project":
    case "submit_command_proposal":
    case "accept_command_proposal":
    case "dismiss_command_proposal":
      return undefined;
  }

  if (targetId === undefined) {
    return false;
  }
  const commitment = soleEffectiveCommitmentForNow(workspace, now);
  if (commitment === undefined) return false;
  if (targetKind === "action") {
    const actions = recordsWithId(workspace.actions, targetId);
    return (
      actions.length === 1 &&
      commitment.slots.some(
        ({ target, targetRevision }) =>
          target.kind === "action" &&
          target.actionId === targetId &&
          targetRevision === actions[0].revision,
      )
    );
  }
  const workItems = recordsWithId(workspace.workItems, targetId);
  return (
    workItems.length === 1 &&
    commitment.slots.some(
      ({ target, targetRevision }) =>
        target.kind === "work_item" &&
        target.workItemId === targetId &&
        target.projectId === workItems[0].projectId &&
        targetRevision === workItems[0].revision,
    )
  );
}

function deterministicTriggerKey(command: V2Command): string | undefined {
  switch (command.type) {
    case "record_bet_boundary":
    case "mark_review_overdue":
      return command.triggerKey;
    case "create_review":
      return command.review.triggerKey;
    case "open_sync_conflict":
      return `sync_conflict:${command.conflict.id}`;
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
    case "upsert_dependency":
    case "remove_dependency":
    case "remove_work_item":
    case "capture_baseline":
    case "complete_work_item":
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
    case "submit_command_proposal":
    case "accept_command_proposal":
    case "dismiss_command_proposal":
      return undefined;
  }
}

function closureValidationRebetSourceIds(
  workspace: WorkspaceV2,
  projectIds: readonly Id[],
  now: ISODate,
): Id[] {
  const allowed: Id[] = [];
  for (const projectId of projectIds) {
    const projects = recordsWithId(workspace.projects, projectId);
    if (projects.length !== 1 || projects[0].stage !== "validating") continue;
    const project = projects[0];
    const currentBet = selectExactCurrentCloseBet(workspace, project);
    if (!currentBet.ok) continue;
    const hold = exactCanonicalAppetiteBoundaryHold(
      project,
      currentBet.bet,
      now,
    );
    if (hold !== undefined) allowed.push(hold.sourceId);
  }
  return uniqueIds(allowed);
}

function buildAuthorizationContext(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): AuthorizationContext {
  const projectIds = affectedExistingProjectIds(workspace, command);
  const mutationTargetIds = policyMutationTargetIds(workspace, command);
  const mutationTargetSet = new Set(mutationTargetIds);
  const projectHolds: ProjectHoldState[] = projectIds.flatMap(
    (projectId) =>
      recordsWithId(workspace.projects, projectId).flatMap(
        ({ holds }) => holds,
      ),
  );
  const matchingGlobalSyncHolds = workspace.projects.flatMap(({ holds }) =>
    holds.filter(
      (hold) =>
        hold.type === "sync_conflict" &&
        hold.affectedRecordIds.some((id) => mutationTargetSet.has(id)),
    ),
  );
  const scopedHolds = [
    ...new Set([...projectHolds, ...matchingGlobalSyncHolds]),
  ];
  const syntheticGlobalSyncHolds: ProjectHoldState[] = workspace.syncConflicts
    .filter(
      (conflict) =>
        conflict.resolvedAt === undefined &&
        mutationTargetSet.has(conflict.recordId),
    )
    .map((conflict) => ({
      type: "sync_conflict",
      sourceId: conflict.id,
      affectedRecordIds: [conflict.recordId],
      createdAt: conflict.openedAt,
    }));
  const syntheticReviewHolds: ProjectHoldState[] = workspace.reviews
    .filter((review) => {
      if (review.triggerType === "sync_conflict") return false;
      const dueAt = Date.parse(review.dueAt);
      const now = Date.parse(context.now);
      const appliesToCommand =
        isPortfolioReviewScope(workspace, review) ||
        review.affectedProjectIds.some((projectId) =>
          projectIds.includes(projectId),
        );
      return (
        appliesToCommand &&
        review.status === "open" &&
        Number.isFinite(dueAt) &&
        Number.isFinite(now) &&
        new Date(dueAt).toISOString() === review.dueAt &&
        dueAt <= now
      );
    })
    .map((review) => ({
      type: "review_overdue",
      sourceId: review.id,
      affectedRecordIds: uniqueIds([
        review.id,
        ...review.affectedRecordIds,
      ]),
      createdAt: review.dueAt,
    }));
  const expandsScope =
    command.type === "update_work_item"
      ? classifyWorkItemScopeExpansion(workspace, command)
      : undefined;

  return {
    actorKind: context.actorKind,
    origin: context.origin,
    source: context.source,
    workspaceRevision: workspace.revision,
    projectHolds: [
      ...scopedHolds,
      ...syntheticGlobalSyncHolds,
      ...syntheticReviewHolds,
    ],
    affectedRecordIds: mutationTargetIds,
    targetWasCommitted: targetWasCommitted(workspace, command, context.now),
    expandsScope,
    deterministicTriggerKey: deterministicTriggerKey(command),
    closureValidationRebetSourceIds: closureValidationRebetSourceIds(
      workspace,
      projectIds,
      context.now,
    ),
  };
}

/**
 * Evaluates the same actor, source, hold, and affected-record policy used by
 * executeCommand without applying domain mutations or creating a receipt.
 */
export function workspaceCommandAuthorizationRejection(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): CommandRejection | undefined {
  return authorizeCommand(
    command.type,
    buildAuthorizationContext(workspace, command, context),
  );
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
  commandPayload: unknown,
  commandType: string,
  context: CommandContext,
  status: CommandReceipt["status"],
  revision: number,
  diff: AuditDiff[],
  rejectionCode?: RejectionCode,
): Promise<CommandReceipt> {
  const commandId = context.commandId;
  const actorId = context.actorId;
  const actorKind = context.actorKind;
  const origin = context.origin;
  const createdAt = context.now;
  const sourceSnapshot = structuredClone(context.source);
  const diffSnapshot = structuredClone(diff);
  const payloadHash = await stableHash(toJsonValue(commandPayload));
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
  commandPayload: unknown,
  commandType: string,
  context: CommandContext,
  rejection: CommandRejection,
  baseRevision: number,
): Promise<Extract<CommandResult, { ok: false }>> {
  return {
    ok: false,
    workspace,
    receipt: await buildReceipt(
      baseRevision,
      commandPayload,
      commandType,
      context,
      "rejected",
      baseRevision,
      [],
      rejection.code,
    ),
    rejection,
  };
}

function snapshotCommandRuntimeInput(value: unknown): unknown {
  if (!isCanonicalCommandRuntimeGraph(value)) {
    throw new TypeError(
      "Command input must be a cloneable canonical data-property graph.",
    );
  }
  return structuredClone(value);
}

function snapshotCommandContextInput(value: unknown): CommandContext {
  if (!isCanonicalCommandRuntimeGraph(value)) {
    throw new TypeError(
      "Command context must be a cloneable canonical data-property graph.",
    );
  }
  return structuredClone(value) as CommandContext;
}

/**
 * Persistence adapters use this helper when a command ID was already observed
 * outside the current Workspace (for example in the append-only rejection
 * receipt store). Keeping receipt construction here preserves the domain's
 * canonical payload and receipt hashing rules.
 */
export async function duplicateCommandResult(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
  existingReceipt?: CommandReceipt,
): Promise<Extract<CommandResult, { ok: false }>> {
  const commandSnapshot = snapshotCommandRuntimeInput(command);
  const contextSnapshot = snapshotCommandContextInput(context);
  const commandType = normalizedCommandType(commandSnapshot);
  return rejectedResult(
    workspace,
    commandSnapshot,
    commandType,
    contextSnapshot,
    createCommandRejection(
      "DUPLICATE_COMMAND",
      {
        actorKind: contextSnapshot.actorKind,
        origin: contextSnapshot.origin,
        workspaceRevision: workspace.revision,
      },
      existingReceipt === undefined
        ? undefined
        : {
            reason: `Command ${contextSnapshot.commandId} already has a ${existingReceipt.status} receipt.`,
            gate: `command_id:${contextSnapshot.commandId}`,
            permittedNextCommand: "read_existing_command_receipt",
          },
    ),
    workspace.revision,
  );
}

/** Canonical CAS-loss rejection for persistence adapters. */
export async function revisionConflictResult(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<Extract<CommandResult, { ok: false }>> {
  const commandSnapshot = snapshotCommandRuntimeInput(command);
  const contextSnapshot = snapshotCommandContextInput(context);
  return rejectedResult(
    workspace,
    commandSnapshot,
    normalizedCommandType(commandSnapshot),
    contextSnapshot,
    createCommandRejection("REVISION_CONFLICT", {
      actorKind: contextSnapshot.actorKind,
      origin: contextSnapshot.origin,
      workspaceRevision: workspace.revision,
    }),
    workspace.revision,
  );
}

interface VerifiedOpenCommandProposal {
  proposal: CommandProposal;
  command: ProposableV2Command;
}

type ProposalVerification =
  | { ok: true; value: VerifiedOpenCommandProposal }
  | { ok: false; code: "REVISION_CONFLICT" | "INVALID_COMMAND"; reason: string };

async function verifyOpenCommandProposal(
  workspace: WorkspaceV2,
  proposalId: Id,
): Promise<ProposalVerification> {
  const matches = workspace.commandProposals.filter(({ id }) => id === proposalId);
  if (matches.length !== 1) {
    return {
      ok: false,
      code: matches.length === 0 ? "REVISION_CONFLICT" : "INVALID_COMMAND",
      reason:
        matches.length === 0
          ? `Command Proposal ${proposalId} is not present in the current Workspace.`
          : `Command Proposal ${proposalId} has ambiguous identity.`,
    };
  }
  const proposal = matches[0];
  if (
    proposal.status !== "open" ||
    workspace.revision !== proposal.baseRevision + 1
  ) {
    return {
      ok: false,
      code: "REVISION_CONFLICT",
      reason: `Command Proposal ${proposalId} is stale and must be regenerated or consciously reapplied.`,
    };
  }
  if (
    !isProposableV2Command(proposal.payload) ||
    proposal.payload.type !== proposal.commandType
  ) {
    return {
      ok: false,
      code: "INVALID_COMMAND",
      reason: `Command Proposal ${proposalId} does not contain one exact allowlisted V2 command.`,
    };
  }
  const nested = structuredClone(proposal.payload) as ProposableV2Command;
  const directReceipts = workspace.commandReceipts.filter(
    (receipt) =>
      receipt.status === "applied" &&
      receipt.baseRevision === proposal.baseRevision &&
      receipt.revision === proposal.baseRevision + 1,
  );
  if (directReceipts.length !== 1) {
    return {
      ok: false,
      code: "REVISION_CONFLICT",
      reason: `Command Proposal ${proposalId} lacks one exact direct submission receipt.`,
    };
  }
  const receipt = directReceipts[0];
  const creationDiffs = receipt.diff.filter(
    (diff) =>
      diff.entity === "CommandProposal" &&
      diff.entityId === proposal.id &&
      diff.field === "created" &&
      diff.before === null,
  );
  const expectedSubmitCommand = {
    type: "submit_command_proposal",
    proposalId: proposal.id,
    command: nested,
    rationale: proposal.rationale,
  } as const;
  const { receiptHash, ...receiptBase } = receipt;
  if (
    receipt.commandType !== "submit_command_proposal" ||
    receipt.actorKind !== "agent" ||
    receipt.actorId !== proposal.agentActorId ||
    receipt.createdAt !== proposal.createdAt ||
    !receipt.source.verified ||
    !receipt.source.capabilities.includes("submit_proposal") ||
    creationDiffs.length !== 1 ||
    !sameJson(creationDiffs[0].after, proposal) ||
    receipt.payloadHash !==
      (await stableHash(toJsonValue(expectedSubmitCommand))) ||
    receiptHash !== (await stableHash(receiptBase as unknown as JsonValue))
  ) {
    return {
      ok: false,
      code: "INVALID_COMMAND",
      reason: `Command Proposal ${proposalId} has invalid submission provenance.`,
    };
  }
  return { ok: true, value: { proposal, command: nested } };
}

async function commandForProposalAcceptance(
  workspace: WorkspaceV2,
  verified: VerifiedOpenCommandProposal,
  context: CommandContext,
): Promise<
  | { ok: true; command: ProposableV2Command }
  | { ok: false; code: "REVISION_CONFLICT" | "INVALID_COMMAND"; reason: string }
> {
  const nested = verified.command;
  if (nested.type !== "propose_replan") {
    return { ok: true, command: structuredClone(nested) };
  }
  if (
    (nested.proposal.baseRevision !== verified.proposal.baseRevision &&
      context.origin !== "sync") ||
    nested.proposal.createdBy !== verified.proposal.agentActorId ||
    nested.proposal.createdAt !== verified.proposal.createdAt
  ) {
    return {
      ok: false,
      code: "INVALID_COMMAND",
      reason:
        "The proposed Replan is not bound to the Agent submission revision and identity.",
    };
  }
  try {
    const current = await generateTodayProposal(
      workspace,
      nested.proposal.localDate,
      context.now,
    );
    if (!sameJson(current.slots, nested.proposal.proposedSlots)) {
      return {
        ok: false,
        code: "REVISION_CONFLICT",
        reason:
          "The proposed Replan no longer matches the current scheduling read set.",
      };
    }
    return {
      ok: true,
      command: {
        type: "propose_replan",
        proposal: {
          ...structuredClone(nested.proposal),
          baseRevision: workspace.revision,
          proposedSlots: structuredClone(current.slots),
          proposalHash: current.proposalHash,
          createdAt: context.now,
          createdBy: context.actorId,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: "REVISION_CONFLICT",
      reason:
        error instanceof Error
          ? error.message
          : "The proposed Replan could not be regenerated.",
    };
  }
}

async function applyAcceptedCommandProposal(
  workspace: WorkspaceV2,
  command: Extract<V2Command, { type: "accept_command_proposal" }>,
  context: CommandContext,
): Promise<CommandHandlerResult> {
  const verified = await verifyOpenCommandProposal(workspace, command.proposalId);
  if (!verified.ok) {
    return {
      ok: false,
      rejection: createCommandRejection(verified.code, {
        actorKind: context.actorKind,
        origin: context.origin,
        workspaceRevision: workspace.revision,
      }, {
        reason: verified.reason,
        gate: `command_proposal:${command.proposalId}:freshness`,
        permittedNextCommand: "submit_command_proposal",
      }),
    };
  }
  const effective = await commandForProposalAcceptance(
    workspace,
    verified.value,
    context,
  );
  if (!effective.ok) {
    return {
      ok: false,
      rejection: createCommandRejection(effective.code, {
        actorKind: context.actorKind,
        origin: context.origin,
        workspaceRevision: workspace.revision,
      }, {
        reason: effective.reason,
        gate: `command_proposal:${command.proposalId}:nested_command`,
        permittedNextCommand: "submit_command_proposal",
      }),
    };
  }
  const nested = effective.command;
  if (!isStructurallyValidCommand(nested)) {
    return {
      ok: false,
      rejection: createCommandRejection("INVALID_COMMAND", {
        actorKind: context.actorKind,
        origin: context.origin,
        workspaceRevision: workspace.revision,
      }, {
        reason: "The proposed nested command is structurally invalid.",
        gate: `command_proposal:${command.proposalId}:nested_command`,
        permittedNextCommand: "submit_command_proposal",
      }),
    };
  }
  const identityRejection = authorizeCommandIdentity(
    nested.type,
    buildAuthorizationContext(workspace, nested, context),
  );
  if (identityRejection !== undefined) {
    return { ok: false, rejection: identityRejection };
  }
  const authorizationRejection = authorizeCommand(
    nested.type,
    buildAuthorizationContext(workspace, nested, context),
  );
  if (authorizationRejection !== undefined) {
    return { ok: false, rejection: authorizationRejection };
  }
  const nestedResult = await applyCommandHandler(workspace, nested, context);
  if (!nestedResult.ok) return nestedResult;
  return {
    ok: true,
    workspace: {
      ...nestedResult.workspace,
      commandProposals: nestedResult.workspace.commandProposals.map((proposal) =>
        proposal.id === command.proposalId
          ? { ...proposal, status: "accepted" as const }
          : proposal,
      ),
    },
  };
}

function stalePreviouslyOpenCommandProposals(
  baseline: WorkspaceV2,
  candidate: WorkspaceV2,
): WorkspaceV2 {
  const previouslyOpen = new Set(
    baseline.commandProposals
      .filter(({ status }) => status === "open")
      .map(({ id }) => id),
  );
  return {
    ...candidate,
    commandProposals: candidate.commandProposals.map((proposal) =>
      previouslyOpen.has(proposal.id) && proposal.status === "open"
        ? { ...proposal, status: "stale" as const }
        : proposal,
    ),
  };
}

export async function executeCommand(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
  options: {
    evaluationNow?: ISODate;
    authorizedConflictOpen?: AuthorizedConflictOpen;
    authorizedEquivalentConflictResolution?: AuthorizedEquivalentConflictResolution;
  } = {},
): Promise<CommandResult> {
  const commandSnapshot = snapshotCommandRuntimeInput(command);
  const commandType = normalizedCommandType(commandSnapshot);
  const contextSnapshot = snapshotCommandContextInput(context);
  const evaluationNow = structuredClone(
    options.evaluationNow ?? contextSnapshot.now,
  );
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
      commandType,
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
      commandType,
      contextSnapshot,
      createCommandRejection("DUPLICATE_COMMAND", rejectionContext),
      baseRevision,
    );
  }

  if (!isKnownV2CommandType(commandType)) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      createCommandRejection("INVALID_COMMAND", rejectionContext, {
        reason: "The command type is not recognized.",
        gate: `command_type:${commandType}`,
        permittedNextCommand: "use_supported_command",
      }),
      baseRevision,
    );
  }

  const identityRejection = authorizeCommandIdentity(commandType, {
    actorKind: contextSnapshot.actorKind,
    origin: contextSnapshot.origin,
    source: contextSnapshot.source,
    workspaceRevision: baseRevision,
    projectHolds: [],
  });
  if (identityRejection !== undefined) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      identityRejection,
      baseRevision,
    );
  }

  if (!isStructurallyValidCommand(commandSnapshot)) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      createCommandRejection("INVALID_COMMAND", rejectionContext, {
        reason: `The ${commandType} payload is invalid.`,
        gate: `command_payload:${commandType}`,
        permittedNextCommand: commandType,
      }),
      baseRevision,
    );
  }

  const authorizationRejection = authorizeCommand(
    commandType,
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
      commandType,
      contextSnapshot,
      authorizationRejection,
      baseRevision,
    );
  }

  if (
    commandSnapshot.type === "open_sync_conflict" &&
    !isAuthorizedConflictOpenFor(
      options.authorizedConflictOpen,
      workspace,
      commandSnapshot,
      contextSnapshot,
    )
  ) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      createCommandRejection("SOURCE_NOT_AUTHORIZED", rejectionContext, {
        reason:
          "A sync conflict may open only from an opaque locally reconstructed replay projection.",
        gate: `sync_conflict:${commandSnapshot.conflict.id || "missing"}:provenance_authority`,
        permittedNextCommand: "authorize_verified_sync_conflict",
      }),
      baseRevision,
    );
  }

  if (commandType === "record_bet_boundary") {
    const payloadHash = await stableHash(toJsonValue(commandSnapshot));
    const appliedReplay = workspace.commandReceipts.find(
      (receipt) =>
        receipt.status === "applied" &&
        receipt.commandType === commandType &&
        receipt.payloadHash === payloadHash,
    );
    if (appliedReplay !== undefined) {
      return rejectedResult(
        workspace,
        commandSnapshot,
        commandType,
        contextSnapshot,
        createCommandRejection("DUPLICATE_COMMAND", rejectionContext, {
          reason: `Applied command ${appliedReplay.commandId} already recorded this Bet boundary payload.`,
          gate: `command_payload:${commandType}:${payloadHash}`,
          permittedNextCommand: "read_existing_command_receipt",
        }),
        baseRevision,
      );
    }
  }

  const baselineSnapshot = structuredClone(workspace);
  const handlerWorkspace = structuredClone(baselineSnapshot);
  const isEquivalentResolutionConfirmation =
    commandSnapshot.type === "resolve_sync_conflict" &&
    isAuthorizedEquivalentConflictResolutionFor(
      options.authorizedEquivalentConflictResolution,
      workspace,
      commandSnapshot,
      contextSnapshot,
    );
  const handlerResult = isEquivalentResolutionConfirmation
    ? { ok: true as const, workspace: handlerWorkspace }
    : commandSnapshot.type === "accept_command_proposal"
      ? await applyAcceptedCommandProposal(
          handlerWorkspace,
          commandSnapshot,
          contextSnapshot,
        )
      : await applyCommandHandler(
          handlerWorkspace,
          commandSnapshot,
          contextSnapshot,
        );
  if (!handlerResult.ok) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      handlerResult.rejection,
      baseRevision,
    );
  }
  const candidate = stalePreviouslyOpenCommandProposals(
    baselineSnapshot,
    handlerResult.workspace,
  );

  const [invariantViolation] = validateWorkspaceInvariants(
    candidate,
    contextSnapshot.now,
    baselineSnapshot,
    { evaluationNow },
  );
  if (invariantViolation !== undefined) {
    return rejectedResult(
      workspace,
      commandSnapshot,
      commandType,
      contextSnapshot,
      rejectionFromInvariant(
        invariantViolation,
        baseRevision,
        contextSnapshot,
      ),
      baseRevision,
    );
  }

  const diff = computeAuditDiff(baselineSnapshot, candidate);
  const nextRevision = baseRevision + 1;
  const receipt = await buildReceipt(
    baseRevision,
    commandSnapshot,
    commandType,
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
