import type { Id, ISODate } from "@/domain/types";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import type { V2Command } from "../domain/commands";
import { isProposableCommandType } from "../domain/agentAuthority";
import { isMaterialDirectionChange } from "../domain/direction";
import { stableHash } from "../domain/stableHash";
import {
  followUpDirectionBriefId,
  returnedInboxItemId,
} from "../domain/close";
import type {
  AuditDiff,
  BetVersion,
  CloseDecision,
  DailyCommitment,
  DirectionBrief,
  ExceptionHistoryEntry,
  ExceptionRecord,
  InboxItem,
  JsonValue,
  PlanVersion,
  ProjectHoldState,
  ProjectV2,
  ReplanProposal,
  ReviewRecord,
  SyncConflictRecord,
  WorkspaceV2,
} from "../domain/types";
import { assertProtectedEffectBundleSchema } from "./workspaceBackupSchema";

export type ProtectedCommandType = Extract<
  V2Command,
  {
    type:
      | "place_bet"
      | "update_direction"
      | "record_bet_boundary"
      | "commit_today"
      | "propose_replan"
      | "accept_replan"
      | "create_review"
      | "mark_review_overdue"
      | "complete_review"
      | "approve_evidence_exception"
      | "resolve_evidence_exception"
      | "close_project"
      | "abandon_project";
  }
>["type"];

export type ProtectedCreatedEntity =
  | {
      kind: "create";
      entity: "BetVersion";
      entityId: Id;
      value: BetVersion;
    }
  | {
      kind: "create";
      entity: "DailyCommitment";
      entityId: Id;
      value: DailyCommitment;
    }
  | {
      kind: "create";
      entity: "PlanVersion";
      entityId: Id;
      value: PlanVersion;
    }
  | {
      kind: "create";
      entity: "ReplanProposal";
      entityId: Id;
      value: ReplanProposal;
    }
  | {
      kind: "create";
      entity: "ReviewRecord";
      entityId: Id;
      value: ReviewRecord;
    }
  | {
      kind: "create";
      entity: "ExceptionRecord";
      entityId: Id;
      value: ExceptionRecord;
    }
  | {
      kind: "create";
      entity: "CloseDecision";
      entityId: Id;
      value: CloseDecision;
    }
  | {
      kind: "create";
      entity: "InboxItem";
      entityId: Id;
      value: InboxItem;
    }
  | {
      kind: "create";
      entity: "ProjectV2";
      entityId: Id;
      value: ProjectV2;
    }
  | {
      kind: "create";
      entity: "DirectionBrief";
      entityId: Id;
      value: DirectionBrief;
    };

export interface ProtectedScalarCell {
  kind: "scalar";
  entity:
    | "BetVersion"
    | "ProjectV2"
    | "ReplanProposal"
    | "ReviewRecord"
    | "ExceptionRecord";
  entityId: Id;
  /** Required for Bet scalars because a Bet ID alone is not an owner proof. */
  ownerProjectId?: Id;
  field: string;
  before: JsonValue;
  after: JsonValue;
}

export interface IndexedProjectHold {
  index: number;
  value: ProjectHoldState;
}

/** One identity cell; never a replacement for the whole Project.holds array. */
export interface ProjectHoldDelta {
  kind: "project_hold_delta";
  projectId: Id;
  holdKey: string;
  before: IndexedProjectHold | null;
  after: IndexedProjectHold | null;
}

/** One verified append; never a replacement for ExceptionRecord.history. */
export interface ExceptionHistoryAppend {
  kind: "exception_history_append";
  exceptionId: Id;
  index: number;
  entry: ExceptionHistoryEntry;
}

export type ProtectedEffectCell =
  | ProtectedCreatedEntity
  | ProtectedScalarCell
  | ProjectHoldDelta
  | ExceptionHistoryAppend;

export interface ProtectedOperationProjection {
  commandType: ProtectedCommandType;
  commandId: Id;
  /** Exact verified command whose receipt diff was normalized into `cells`. */
  command: Extract<V2Command, { type: ProtectedCommandType }>;
  /**
   * Opaque protocol-derived authority root for this replay lineage. This is
   * intentionally distinct from `sourceOperationHash`: a semantic replay may
   * have a new envelope while retaining the same human-approved authority.
   */
  authorityRootOperationHash: string;
  sourceOperationHash: string;
  receiptHash: string;
  payloadHash: string;
  createdAt: ISODate;
  cells: ProtectedEffectCell[];
}

export interface ProtectedEffectBundle {
  schemaVersion: 1;
  logicalKey: string;
  operations: ProtectedOperationProjection[];
  hash: string;
}

export interface ProtectedOperationView {
  workspace: Readonly<WorkspaceV2>;
  command: Readonly<V2Command>;
  commandId: Id;
  authorityRootOperationHash: string;
  sourceOperationHash: string;
  receiptHash: string;
  payloadHash: string;
  createdAt: ISODate;
  diff: readonly AuditDiff[];
}

export interface EffectiveAcceptedProposalView {
  outerCommand: Extract<V2Command, { type: "accept_command_proposal" }>;
  command: Extract<
    V2Command,
    { type: "update_direction" | "propose_replan" }
  >;
  diff: AuditDiff[];
}

export class SyncConflictBundleError extends Error {
  constructor(
    readonly code:
      | "INVALID_PROJECTION"
      | "UNSUPPORTED_DIFF"
      | "BUNDLE_TAMPERED"
      | "BUNDLE_MISMATCH"
      | "PROJECTION_DRIFT",
    message: string,
  ) {
    super(message);
    this.name = "SyncConflictBundleError";
  }
}

function tupleKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

function exactlyOneById<T extends { id: string }>(
  values: readonly T[],
  id: string,
): T | undefined {
  const matches = values.filter((value) => value.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

export function protectedCommandLogicalKey(
  workspace: Readonly<WorkspaceV2>,
  command: Readonly<V2Command>,
): string | undefined {
  switch (command.type) {
    case "place_bet":
    case "update_direction":
    case "record_bet_boundary":
      return tupleKey("bet", command.projectId);
    case "commit_today":
      return tupleKey("daily_commitment", command.commitment.localDate);
    case "propose_replan":
      return tupleKey("daily_commitment", command.proposal.localDate);
    case "accept_replan": {
      const proposal = exactlyOneById(
        workspace.replanProposals,
        command.proposalId,
      );
      return proposal === undefined
        ? undefined
        : tupleKey("daily_commitment", proposal.localDate);
    }
    case "create_review":
      return tupleKey("review", command.review.triggerKey);
    case "mark_review_overdue":
    case "complete_review": {
      const review = exactlyOneById(workspace.reviews, command.reviewId);
      return review === undefined
        ? undefined
        : tupleKey("review", review.triggerKey);
    }
    case "approve_evidence_exception":
      return tupleKey("exception", command.exception.id);
    case "resolve_evidence_exception":
      return tupleKey("exception", command.exceptionId);
    case "close_project":
    case "abandon_project":
      return tupleKey("close", command.projectId);
    default:
      return undefined;
  }
}

const protectedCommandTypes = new Set<ProtectedCommandType>([
  "place_bet",
  "update_direction",
  "record_bet_boundary",
  "commit_today",
  "propose_replan",
  "accept_replan",
  "create_review",
  "mark_review_overdue",
  "complete_review",
  "approve_evidence_exception",
  "resolve_evidence_exception",
  "close_project",
  "abandon_project",
]);

function isProtectedCommandType(value: string): value is ProtectedCommandType {
  return protectedCommandTypes.has(value as ProtectedCommandType);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Proves that one outer human proposal acceptance is backed by the exact
 * direct Agent submission and returns only its effective protected mutation.
 */
export async function resolveEffectiveAcceptedProposalView(
  view: ProtectedOperationView,
): Promise<EffectiveAcceptedProposalView | undefined> {
  const outerCommand = view.command;
  if (outerCommand.type !== "accept_command_proposal") return undefined;
  const proposalMatches = view.workspace.commandProposals.filter(
    ({ id }) => id === outerCommand.proposalId,
  );
  const proposal = proposalMatches[0];
  const invalid = (message: string): never => {
    throw new SyncConflictBundleError(
      "INVALID_PROJECTION",
      `Accepted command proposal provenance is invalid: ${message}`,
    );
  };
  if (proposalMatches.length !== 1 || proposal === undefined) {
    return invalid("the proposal identity is missing or ambiguous");
  }
  if (
    proposal.status !== "open" ||
    view.workspace.revision !== proposal.baseRevision + 1
  ) {
    return invalid("the proposal is not the fresh open submission");
  }
  if (
    !record(proposal.payload) ||
    !isProposableCommandType(proposal.payload.type) ||
    proposal.payload.type !== proposal.commandType
  ) {
    return invalid("the stored commandType and payload disagree");
  }
  if (
    proposal.commandType !== "update_direction" &&
    proposal.commandType !== "propose_replan"
  ) {
    return undefined;
  }
  const directReceipts = view.workspace.commandReceipts.filter(
    (receipt) =>
      receipt.status === "applied" &&
      receipt.baseRevision === proposal.baseRevision &&
      receipt.revision === proposal.baseRevision + 1,
  );
  const receipt = directReceipts[0];
  if (directReceipts.length !== 1 || receipt === undefined) {
    return invalid("the exact direct submit receipt is missing");
  }
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
    command: proposal.payload,
    rationale: proposal.rationale,
  };
  const { receiptHash, ...receiptBase } = receipt;
  if (
    receipt.commandType !== "submit_command_proposal" ||
    receipt.actorKind !== "agent" ||
    receipt.actorId !== proposal.agentActorId ||
    receipt.createdAt !== proposal.createdAt ||
    !receipt.source.verified ||
    !receipt.source.capabilities.includes("submit_proposal") ||
    creationDiffs.length !== 1 ||
    !sameValue(creationDiffs[0].after, proposal) ||
    receipt.payloadHash !==
      (await stableHash(expectedSubmitCommand as unknown as JsonValue)) ||
    receiptHash !== (await stableHash(receiptBase as unknown as JsonValue))
  ) {
    return invalid("the submit receipt, payload, or creation snapshot is forged");
  }
  const proposalDiffs = view.diff.filter(
    ({ entity }) => entity === "CommandProposal",
  );
  const acceptedDiffs = proposalDiffs.filter(
    (diff) =>
      diff.entityId === proposal.id &&
      diff.field === "status" &&
      diff.before === "open" &&
      diff.after === "accepted",
  );
  if (
    acceptedDiffs.length !== 1 ||
    proposalDiffs.some(
      (diff) =>
        diff !== acceptedDiffs[0] &&
        !(
          diff.field === "status" &&
          diff.before === "open" &&
          diff.after === "stale"
        ),
    )
  ) {
    return invalid("the acceptance status diff is not exact");
  }
  const effectiveDiff = view.diff
    .filter(({ entity }) => entity !== "CommandProposal")
    .map((diff) => structuredClone(diff));
  if (proposal.commandType === "update_direction") {
    return {
      outerCommand: structuredClone(outerCommand),
      command: structuredClone(proposal.payload) as unknown as Extract<
        V2Command,
        { type: "update_direction" }
      >,
      diff: effectiveDiff,
    };
  }
  const storedReplan = record(proposal.payload.proposal)
    ? proposal.payload.proposal
    : undefined;
  if (storedReplan === undefined || typeof storedReplan.id !== "string") {
    return invalid("the stored Replan payload is malformed");
  }
  const creations = effectiveDiff.filter(
    (diff) =>
      diff.entity === "ReplanProposal" &&
      diff.field === "created" &&
      diff.before === null &&
      record(diff.after) &&
      diff.after.id === storedReplan.id,
  );
  if (creations.length !== 1 || !record(creations[0].after)) {
    return invalid("the accepted Replan creation diff is not exact");
  }
  const acceptedReplan = creations[0].after;
  for (const field of [
    "id",
    "localDate",
    "baseCommitmentId",
    "reasonCodes",
    "proposedSlots",
    "status",
  ] as const) {
    if (!sameValue(storedReplan[field], acceptedReplan[field])) {
      return invalid(`the accepted Replan changed proposed field ${field}`);
    }
  }
  if (
    acceptedReplan.baseRevision !== view.workspace.revision ||
    acceptedReplan.createdAt !== view.createdAt
  ) {
    return invalid("the accepted Replan was not rebased at human acceptance");
  }
  const effectiveCommand = {
    type: "propose_replan",
    proposal: structuredClone(acceptedReplan) as unknown as ReplanProposal,
  } as const;
  return {
    outerCommand: structuredClone(outerCommand),
    command: effectiveCommand,
    diff: effectiveDiff,
  };
}

function holdIdentity(hold: ProjectHoldState): string {
  return JSON.stringify([hold.type, hold.sourceId]);
}

function indexedHolds(value: JsonValue): Map<string, IndexedProjectHold> {
  if (!Array.isArray(value)) {
    throw new SyncConflictBundleError(
      "INVALID_PROJECTION",
      "Project holds audit values must be arrays.",
    );
  }
  const result = new Map<string, IndexedProjectHold>();
  value.forEach((candidate, index) => {
    if (
      !record(candidate) ||
      typeof candidate.type !== "string" ||
      !["migration_review", "rebet_required", "review_overdue", "sync_conflict"].includes(
        candidate.type,
      ) ||
      typeof candidate.sourceId !== "string" ||
      !Array.isArray(candidate.affectedRecordIds) ||
      !candidate.affectedRecordIds.every((id) => typeof id === "string") ||
      typeof candidate.createdAt !== "string"
    ) {
      throw new SyncConflictBundleError(
        "INVALID_PROJECTION",
        "Project hold audit values are malformed.",
      );
    }
    const value = structuredClone(candidate) as unknown as ProjectHoldState;
    const key = holdIdentity(value);
    if (result.has(key)) {
      throw new SyncConflictBundleError(
        "INVALID_PROJECTION",
        `Project hold identity ${key} is duplicated.`,
      );
    }
    result.set(key, { index, value });
  });
  return result;
}

function allowedHoldDelta(
  command: Readonly<V2Command>,
  before: IndexedProjectHold | undefined,
  after: IndexedProjectHold | undefined,
): boolean {
  const changed = after ?? before;
  if (changed === undefined) return false;
  const hold = changed.value;
  switch (command.type) {
    case "place_bet":
    case "close_project":
    case "abandon_project":
      return before !== undefined && after === undefined && hold.type === "rebet_required";
    case "update_direction":
      return (
        before === undefined &&
        after !== undefined &&
        hold.type === "rebet_required"
      );
    case "record_bet_boundary":
      return (
        command.boundary === "expired" &&
        before === undefined &&
        after !== undefined &&
        hold.type === "rebet_required" &&
        command.triggerKey === `${hold.sourceId}:expired`
      );
    case "mark_review_overdue":
      return (
        before === undefined &&
        after !== undefined &&
        hold.type === "review_overdue" &&
        hold.sourceId === command.reviewId
      );
    case "complete_review":
      return (
        before !== undefined &&
        after === undefined &&
        hold.type === "review_overdue" &&
        hold.sourceId === command.reviewId
      );
    default:
      return false;
  }
}

function projectHoldCells(
  command: Readonly<V2Command>,
  diff: AuditDiff,
): ProjectHoldDelta[] {
  const before = indexedHolds(diff.before);
  const after = indexedHolds(diff.after);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.flatMap((key) => {
    const beforeValue = before.get(key);
    const afterValue = after.get(key);
    if (sameValue(beforeValue?.value, afterValue?.value)) return [];
    if (!allowedHoldDelta(command, beforeValue, afterValue)) {
      throw new SyncConflictBundleError(
        "UNSUPPORTED_DIFF",
        `Command ${command.type} cannot replace Project hold ${key}.`,
      );
    }
    return [{
      kind: "project_hold_delta" as const,
      projectId: diff.entityId,
      holdKey: key,
      before: beforeValue ?? null,
      after: afterValue ?? null,
    }];
  });
}

function historyAppendCell(
  command: Readonly<V2Command>,
  diff: AuditDiff,
): ExceptionHistoryAppend {
  const before = diff.before;
  const after = diff.after;
  if (
    command.type !== "resolve_evidence_exception" ||
    !Array.isArray(before) ||
    !Array.isArray(after) ||
    after.length !== before.length + 1 ||
    !before.every((entry, index) => sameValue(entry, after[index]))
  ) {
    throw new SyncConflictBundleError(
      "UNSUPPORTED_DIFF",
      "Exception history may only append one exact resolution entry.",
    );
  }
  const entry = after[before.length];
  if (
    !record(entry) ||
    entry.action !== "resolved" ||
    typeof entry.actorId !== "string" ||
    typeof entry.at !== "string" ||
    typeof entry.note !== "string"
  ) {
    throw new SyncConflictBundleError(
      "INVALID_PROJECTION",
      "Exception resolution history entry is malformed.",
    );
  }
  return {
    kind: "exception_history_append",
    exceptionId: diff.entityId,
    index: before.length,
    entry: structuredClone(entry) as unknown as ExceptionHistoryEntry,
  };
}

function allowedScalar(
  commandType: ProtectedCommandType,
  entity: string,
  field: string,
): ProtectedScalarCell["entity"] | undefined {
  const key = `${entity}.${field}`;
  const allowed: Partial<Record<ProtectedCommandType, readonly string[]>> = {
    place_bet: [
      "BetVersion.invalidatedAt",
      "BetVersion.invalidationReason",
      "ProjectV2.stage",
      "ProjectV2.activeBetId",
      "ProjectV2.activePlanVersionId",
    ],
    update_direction: [
      "BetVersion.invalidatedAt",
      "BetVersion.invalidationReason",
      "ProjectV2.activeDirectionBriefId",
    ],
    record_bet_boundary: ["ProjectV2.stage"],
    commit_today: ["ProjectV2.stage", "ProjectV2.activePlanVersionId"],
    accept_replan: [
      "ProjectV2.stage",
      "ProjectV2.activePlanVersionId",
      "ReplanProposal.status",
    ],
    mark_review_overdue: ["ReviewRecord.overdueMarkedAt"],
    complete_review: ["ReviewRecord.status", "ReviewRecord.conclusion"],
    resolve_evidence_exception: ["ExceptionRecord.resolvedAt"],
    close_project: ["ProjectV2.stage"],
    abandon_project: ["ProjectV2.stage"],
  };
  if (!(allowed[commandType] ?? []).includes(key)) return undefined;
  return entity as ProtectedScalarCell["entity"];
}

function closeDecision(
  command: Readonly<V2Command>,
): Extract<V2Command, { type: "close_project" | "abandon_project" }>["decision"] | undefined {
  return command.type === "close_project" || command.type === "abandon_project"
    ? command.decision
    : undefined;
}

function allowedCreate(
  command: Readonly<V2Command>,
  entity: ProtectedCreatedEntity["entity"],
  entityId: Id,
  value: Record<string, unknown>,
): boolean {
  if (value.id !== entityId) return false;
  switch (entity) {
    case "BetVersion":
      return (
        command.type === "place_bet" &&
        command.betId === entityId &&
        value.projectId === command.projectId &&
        value.appetiteStart === command.start &&
        value.approvedAt === command.start
      );
    case "DailyCommitment":
      return (
        (command.type === "commit_today" &&
          command.commitment.id === entityId &&
          value.localDate === command.commitment.localDate) ||
        (command.type === "accept_replan" && command.commitmentId === entityId)
      );
    case "PlanVersion":
      {
        const commitmentId =
          command.type === "commit_today"
            ? command.commitment.id
            : command.type === "accept_replan"
              ? command.commitmentId
              : undefined;
      return (
        commitmentId !== undefined &&
        typeof value.projectId === "string" &&
        entityId === `plan:${value.projectId}:${commitmentId}`
      );
      }
    case "ReplanProposal":
      return (
        command.type === "propose_replan" &&
        command.proposal.id === entityId &&
        sameValue(value, command.proposal)
      );
    case "ReviewRecord":
      return command.type === "create_review" && command.review.id === entityId;
    case "ExceptionRecord":
      return (
        command.type === "approve_evidence_exception" &&
        command.exception.id === entityId
      );
    case "CloseDecision": {
      const decision = closeDecision(command);
      return (
        decision !== undefined &&
        decision.id === entityId &&
        (command.type === "close_project" || command.type === "abandon_project") &&
        value.projectId === command.projectId
      );
    }
    case "InboxItem": {
      const decision = closeDecision(command);
      return (
        decision !== undefined &&
        typeof value.sourceId === "string" &&
        entityId === returnedInboxItemId(decision.id, value.sourceId)
      );
    }
    case "ProjectV2": {
      const decision = closeDecision(command);
      return decision?.followUpProjectId === entityId;
    }
    case "DirectionBrief": {
      if (command.type === "update_direction") {
        return (
          value.projectId === command.projectId &&
          typeof value.version === "number" &&
          Number.isSafeInteger(value.version) &&
          value.version > 0 &&
          entityId ===
            `${command.projectId}:direction-brief:${String(value.version)}`
        );
      }
      const decision = closeDecision(command);
      return (
        decision?.followUpProjectId !== undefined &&
        entityId ===
          followUpDirectionBriefId(decision.id, decision.followUpProjectId)
      );
    }
  }
}

function createdCell(
  command: Readonly<V2Command>,
  diff: AuditDiff,
): ProtectedCreatedEntity {
  const entities = new Set<ProtectedCreatedEntity["entity"]>([
    "BetVersion",
    "DailyCommitment",
    "PlanVersion",
    "ReplanProposal",
    "ReviewRecord",
    "ExceptionRecord",
    "CloseDecision",
    "InboxItem",
    "ProjectV2",
    "DirectionBrief",
  ]);
  if (
    diff.field !== "created" ||
    diff.before !== null ||
    !entities.has(diff.entity as ProtectedCreatedEntity["entity"]) ||
    !record(diff.after) ||
    !allowedCreate(
      command,
      diff.entity as ProtectedCreatedEntity["entity"],
      diff.entityId,
      diff.after,
    )
  ) {
    throw new SyncConflictBundleError(
      "UNSUPPORTED_DIFF",
      `Command ${command.type} cannot create ${diff.entity} ${diff.entityId}.`,
    );
  }
  return {
    kind: "create",
    entity: diff.entity,
    entityId: diff.entityId,
    value: structuredClone(diff.after),
  } as unknown as ProtectedCreatedEntity;
}

function normalizeDiff(
  workspace: Readonly<WorkspaceV2> | undefined,
  command: Readonly<V2Command>,
  commandType: ProtectedCommandType,
  createdAt: ISODate,
  diff: AuditDiff,
  betOwnerProjectId?: Id,
): ProtectedEffectCell[] {
  if (diff.field === "created") return [createdCell(command, diff)];
  if (diff.field === "deleted") {
    throw new SyncConflictBundleError(
      "UNSUPPORTED_DIFF",
      "Protected commands cannot delete whole entities.",
    );
  }
  if (diff.entity === "ProjectV2" && diff.field === "updatedAt") {
    if (diff.after !== createdAt) {
      throw new SyncConflictBundleError(
        "INVALID_PROJECTION",
        "Project updatedAt must equal the authoritative command time.",
      );
    }
    return [];
  }
  if (diff.entity === "ProjectV2" && diff.field === "holds") {
    return projectHoldCells(command, diff);
  }
  if (diff.entity === "ExceptionRecord" && diff.field === "history") {
    return [historyAppendCell(command, diff)];
  }
  const entity = allowedScalar(commandType, diff.entity, diff.field);
  if (entity === undefined) {
    throw new SyncConflictBundleError(
      "UNSUPPORTED_DIFF",
      `Command ${commandType} cannot patch ${diff.entity}.${diff.field}.`,
    );
  }
  return [{
    kind: "scalar",
    entity,
    entityId: diff.entityId,
    ...(entity === "BetVersion"
      ? (() => {
          const ownerProjectId = workspace === undefined
            ? betOwnerProjectId
            : exactlyOneById(workspace.bets, diff.entityId)?.projectId;
          if (ownerProjectId === undefined) {
            throw new SyncConflictBundleError(
              "INVALID_PROJECTION",
              `Bet ${diff.entityId} has no unique Project owner.`,
            );
          }
          return { ownerProjectId };
        })()
      : {}),
    field: diff.field,
    before: structuredClone(diff.before),
    after: structuredClone(diff.after),
  }];
}

function exactlyOneDiff(
  view: ProtectedOperationView,
  entity: string,
  entityId: Id,
  field: string,
): AuditDiff | undefined {
  const matches = view.diff.filter(
    (diff) =>
      diff.entity === entity &&
      diff.entityId === entityId &&
      diff.field === field,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Only the active-Bet material transition is protected. Editorial Direction
 * versions and pre-Bet lifecycle edits remain ordinary replayable commands.
 */
async function isMaterialActiveDirectionProjection(
  view: ProtectedOperationView,
): Promise<boolean> {
  const command = view.command;
  if (command.type !== "update_direction") return false;
  const project = exactlyOneById(view.workspace.projects, command.projectId);
  if (
    project === undefined ||
    !["planning", "executing", "validating"].includes(project.stage) ||
    project.activeDirectionBriefId !== command.brief.id ||
    project.activeBetId === undefined
  ) return false;
  const activeBrief = exactlyOneById(
    view.workspace.directionBriefs,
    project.activeDirectionBriefId,
  );
  const activeBet = exactlyOneById(view.workspace.bets, project.activeBetId);
  if (
    activeBrief === undefined ||
    activeBrief.projectId !== project.id ||
    activeBet === undefined ||
    activeBet.projectId !== project.id ||
    activeBet.invalidatedAt !== undefined ||
    project.holds.some(({ type }) => type === "rebet_required")
  ) return false;
  const briefCreates = view.diff.filter(
    (diff) =>
      diff.entity === "DirectionBrief" &&
      diff.field === "created" &&
      diff.before === null &&
      record(diff.after) &&
      diff.after.projectId === project.id,
  );
  if (briefCreates.length !== 1) return false;
  const briefCreate = briefCreates[0];
  const nextBrief = briefCreate.after as unknown as DirectionBrief;
  if (
    nextBrief.id !== briefCreate.entityId ||
    nextBrief.createdAt !== view.createdAt ||
    nextBrief.updatedAt !== view.createdAt ||
    !(await isMaterialDirectionChange(activeBrief, nextBrief))
  ) return false;
  const invalidatedAt = exactlyOneDiff(
    view,
    "BetVersion",
    activeBet.id,
    "invalidatedAt",
  );
  const invalidationReason = exactlyOneDiff(
    view,
    "BetVersion",
    activeBet.id,
    "invalidationReason",
  );
  const activeBriefPointer = exactlyOneDiff(
    view,
    "ProjectV2",
    project.id,
    "activeDirectionBriefId",
  );
  const holdsDiff = exactlyOneDiff(
    view,
    "ProjectV2",
    project.id,
    "holds",
  );
  if (
    invalidatedAt?.before !== null ||
    invalidatedAt.after !== view.createdAt ||
    invalidationReason?.before !== null ||
    invalidationReason.after !==
      "Material Direction change requires Re-bet." ||
    activeBriefPointer?.before !== activeBrief.id ||
    activeBriefPointer.after !== nextBrief.id ||
    holdsDiff === undefined
  ) return false;
  let beforeHolds: Map<string, IndexedProjectHold>;
  let afterHolds: Map<string, IndexedProjectHold>;
  try {
    beforeHolds = indexedHolds(holdsDiff.before);
    afterHolds = indexedHolds(holdsDiff.after);
  } catch {
    return false;
  }
  const addedHolds = [...afterHolds.entries()].filter(
    ([key]) => !beforeHolds.has(key),
  );
  if (
    beforeHolds.size !== project.holds.length ||
    afterHolds.size !== beforeHolds.size + 1 ||
    addedHolds.length !== 1
  ) return false;
  const added = addedHolds[0][1].value;
  return (
    added.type === "rebet_required" &&
    added.sourceId === activeBet.id &&
    added.createdAt === view.createdAt &&
    canonicalJson([...new Set(added.affectedRecordIds)].sort()) ===
      canonicalJson([
        activeBet.id,
        activeBrief.id,
        nextBrief.id,
        project.id,
      ].sort())
  );
}

/**
 * Exact normal-replay contracts for lifecycle commands that happen to touch a
 * Project field also used by protected bundles. This keeps unknown primary
 * writers fail-closed without misclassifying ordinary lifecycle transitions.
 */
export function isKnownUnprotectedLifecycleWriter(
  view: Pick<ProtectedOperationView, "command" | "createdAt" | "diff">,
): boolean {
  const projectDiffsFor = (
    projectId: Id,
    allowedFields: readonly string[],
  ): AuditDiff[] | undefined => {
    if (
      view.diff.some(
        ({ entity, entityId, field }) =>
          entity !== "ProjectV2" ||
          entityId !== projectId ||
          !allowedFields.includes(field),
      )
    ) return undefined;
    return [...view.diff];
  };
  const oneField = (diffs: readonly AuditDiff[], field: string) =>
    diffs.filter((diff) => diff.field === field);

  switch (view.command.type) {
    case "request_validation": {
      const diffs = projectDiffsFor(view.command.projectId, ["stage", "updatedAt"]);
      if (diffs === undefined) return false;
      const stage = oneField(diffs, "stage");
      const updatedAt = oneField(diffs, "updatedAt");
      return (
        diffs.length === 2 &&
        stage.length === 1 &&
        ["planning", "executing"].includes(String(stage[0].before)) &&
        stage[0].after === "validating" &&
        updatedAt.length === 1 &&
        updatedAt[0].after === view.createdAt
      );
    }
    case "satisfy_validation": {
      const diffs = projectDiffsFor(view.command.projectId, ["stage", "updatedAt"]);
      if (diffs === undefined) return false;
      const stage = oneField(diffs, "stage");
      const updatedAt = oneField(diffs, "updatedAt");
      return (
        diffs.length === 2 &&
        stage.length === 1 &&
        stage[0].before === "validating" &&
        stage[0].after === "closing" &&
        updatedAt.length === 1 &&
        updatedAt[0].after === view.createdAt
      );
    }
    case "record_bet_boundary": {
      if (view.command.boundary !== "expired") return view.diff.length === 0;
      const diffs = projectDiffsFor(view.command.projectId, [
        "stage",
        "holds",
        "updatedAt",
      ]);
      if (diffs === undefined) return false;
      const holds = oneField(diffs, "holds");
      const stages = oneField(diffs, "stage");
      const updatedAt = oneField(diffs, "updatedAt");
      const betId = view.command.triggerKey.endsWith(":expired")
        ? view.command.triggerKey.slice(0, -":expired".length)
        : "";
      if (
        betId.length === 0 ||
        holds.length !== 1 ||
        stages.length > 1 ||
        updatedAt.length !== 1 ||
        updatedAt[0].after !== view.createdAt
      ) return false;
      let before: Map<string, IndexedProjectHold>;
      let after: Map<string, IndexedProjectHold>;
      try {
        before = indexedHolds(holds[0].before);
        after = indexedHolds(holds[0].after);
      } catch {
        return false;
      }
      const added = [...after.entries()].filter(([key]) => !before.has(key));
      if (
        added.length !== 1 ||
        after.size !== before.size + 1 ||
        added[0][1].value.type !== "rebet_required" ||
        added[0][1].value.sourceId !== betId ||
        added[0][1].value.createdAt !== view.createdAt ||
        canonicalJson([...new Set(added[0][1].value.affectedRecordIds)].sort()) !==
          canonicalJson([betId, view.command.projectId].sort())
      ) return false;
      return (
        (stages.length === 0 ||
          (["planning", "executing"].includes(String(stages[0].before)) &&
            stages[0].after === "validating")) &&
        diffs.length === 2 + stages.length
      );
    }
    case "update_direction": {
      const command = view.command;
      if (
        view.diff.length === 0 ||
        view.diff.some(({ entity, entityId, field, after }) => {
          if (entity === "ProjectV2") {
            return (
              entityId !== command.projectId ||
              !["stage", "activeDirectionBriefId", "updatedAt"].includes(field)
            );
          }
          if (entity !== "DirectionBrief") return true;
          if (field === "created") {
            return !record(after) || after.projectId !== command.projectId;
          }
          return (
            entityId !== command.brief.id ||
            ![
              "audienceAndProblem",
              "successEvidence",
              "appetiteSeconds",
              "validationMethod",
              "firstScope",
              "noGoOrKill",
              "advancedNotes",
              "version",
              "updatedAt",
            ].includes(field)
          );
        })
      ) return false;
      return view.diff.some(({ entity }) => entity === "DirectionBrief");
    }
    default:
      return false;
  }
}

export async function isKnownUnprotectedLifecycleWriterForView(
  view: ProtectedOperationView,
): Promise<boolean> {
  const accepted = await resolveEffectiveAcceptedProposalView(view);
  return isKnownUnprotectedLifecycleWriter(
    accepted === undefined
      ? view
      : {
          command: accepted.command,
          createdAt: view.createdAt,
          diff: accepted.diff,
        },
  );
}

async function withBundleHash(
  value: Omit<ProtectedEffectBundle, "hash">,
): Promise<ProtectedEffectBundle> {
  return {
    ...value,
    hash: await sha256Hex(canonicalJson(value)),
  };
}

export async function projectProtectedEffectBundleAtLogicalKey(
  view: ProtectedOperationView,
  logicalKey: string,
): Promise<ProtectedEffectBundle | undefined> {
  const commandType = view.command.type;
  if (!isProtectedCommandType(commandType)) return undefined;
  if (
    commandType === "update_direction" &&
    !(await isMaterialActiveDirectionProjection(view))
  ) return undefined;
  if (
    commandType === "record_bet_boundary" &&
    (view.command.boundary !== "expired" ||
      !view.diff.some(({ entity, field }) =>
        entity === "ProjectV2" && (field === "stage" || field === "holds")
      ))
  ) return undefined;
  const cells = view.diff.flatMap((diff) =>
    normalizeDiff(view.workspace, view.command, commandType, view.createdAt, diff),
  );
  return withBundleHash({
    schemaVersion: 1,
    logicalKey,
    operations: [{
      commandType,
      commandId: view.commandId,
      command: structuredClone(view.command) as Extract<
        V2Command,
        { type: ProtectedCommandType }
      >,
      authorityRootOperationHash: view.authorityRootOperationHash,
      sourceOperationHash: view.sourceOperationHash,
      receiptHash: view.receiptHash,
      payloadHash: view.payloadHash,
      createdAt: view.createdAt,
      cells,
    }],
  });
}

export async function projectProtectedEffectBundle(
  view: ProtectedOperationView,
): Promise<ProtectedEffectBundle | undefined> {
  const accepted = await resolveEffectiveAcceptedProposalView(view);
  const effectiveView: ProtectedOperationView =
    accepted === undefined
      ? view
      : {
          ...view,
          command: accepted.command,
          diff: accepted.diff,
        };
  const commandType = effectiveView.command.type;
  if (!isProtectedCommandType(commandType)) return undefined;
  const logicalKey = protectedCommandLogicalKey(
    effectiveView.workspace,
    effectiveView.command,
  );
  if (logicalKey === undefined) {
    throw new SyncConflictBundleError(
      "INVALID_PROJECTION",
      `Command ${effectiveView.command.type} has no unique logical target.`,
    );
  }
  return projectProtectedEffectBundleAtLogicalKey(effectiveView, logicalKey);
}

export interface VerifyProtectedOperationProjectionInput {
  logicalKey: string;
  projection: Readonly<ProtectedOperationProjection>;
  command: Readonly<V2Command>;
  commandId: Id;
  authorityRootOperationHash: string;
  sourceOperationHash: string;
  receiptHash: string;
  payloadHash: string;
  createdAt: ISODate;
  diff: readonly AuditDiff[];
}

/**
 * Rebuild one protected operation directly from its verified receipt. Unlike
 * normal branch projection this verifier intentionally needs no Workspace
 * snapshot: the logical key and typed command establish the Project owner,
 * while the command-complete cell validator proves the exact transition.
 */
export function verifyProtectedOperationProjectionFromReceiptDiff(
  input: VerifyProtectedOperationProjectionInput,
): boolean {
  const logical = parseLogicalKey(input.logicalKey);
  const commandType = input.command.type;
  if (
    logical === undefined ||
    !isProtectedCommandType(commandType) ||
    !commandMatchesLogicalKind(commandType, logical[0])
  ) return false;

  let cells: ProtectedEffectCell[];
  try {
    cells = input.diff.flatMap((diff) =>
      normalizeDiff(
        undefined,
        input.command,
        commandType,
        input.createdAt,
        diff,
        logical[0] === "bet" ? logical[1] : undefined,
      ),
    );
  } catch {
    return false;
  }
  const rebuilt: ProtectedOperationProjection = {
    commandType,
    commandId: input.commandId,
    command: structuredClone(input.command) as Extract<
      V2Command,
      { type: ProtectedCommandType }
    >,
    authorityRootOperationHash: input.authorityRootOperationHash,
    sourceOperationHash: input.sourceOperationHash,
    receiptHash: input.receiptHash,
    payloadHash: input.payloadHash,
    createdAt: input.createdAt,
    cells,
  };
  return (
    validProjectedOperation(rebuilt) &&
    operationOwnerAndTransitionAreValid(rebuilt, logical) &&
    canonicalJson(rebuilt) === canonicalJson(input.projection)
  );
}

export async function combineProtectedEffectBundles(
  bundles: readonly ProtectedEffectBundle[],
): Promise<ProtectedEffectBundle> {
  const first = bundles[0];
  if (
    first === undefined ||
    bundles.some(
      (bundle) =>
        bundle.schemaVersion !== 1 ||
        bundle.logicalKey !== first.logicalKey,
    )
  ) {
    throw new SyncConflictBundleError(
      "BUNDLE_MISMATCH",
      "Only non-empty projections for one protected logical record may combine.",
    );
  }
  return withBundleHash({
    schemaVersion: 1,
    logicalKey: first.logicalKey,
    operations: bundles.flatMap((bundle) =>
      structuredClone(bundle.operations),
    ),
  });
}

async function expectedBundleHash(
  bundle: Pick<ProtectedEffectBundle, "schemaVersion" | "logicalKey" | "operations">,
): Promise<string> {
  return sha256Hex(canonicalJson({
    schemaVersion: bundle.schemaVersion,
    logicalKey: bundle.logicalKey,
    operations: bundle.operations,
  }));
}

function jsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return record(value) && Object.values(value).every(jsonValue);
}

function canonicalTimestamp(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

type LogicalKeyParts = readonly [
  "bet" | "daily_commitment" | "review" | "exception" | "close",
  string,
];

function parseLogicalKey(value: string): LogicalKeyParts | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      ["bet", "daily_commitment", "review", "exception", "close"].includes(
        String(parsed[0]),
      ) &&
      typeof parsed[1] === "string" &&
      parsed[1].length > 0
    ) {
      return parsed as unknown as LogicalKeyParts;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function commandMayCreate(
  commandType: ProtectedCommandType,
  entity: string,
): entity is ProtectedCreatedEntity["entity"] {
  const allowed: Partial<
    Record<ProtectedCommandType, readonly ProtectedCreatedEntity["entity"][]>
  > = {
    place_bet: ["BetVersion"],
    update_direction: ["DirectionBrief"],
    commit_today: ["DailyCommitment", "PlanVersion"],
    propose_replan: ["ReplanProposal"],
    accept_replan: ["DailyCommitment", "PlanVersion"],
    create_review: ["ReviewRecord"],
    approve_evidence_exception: ["ExceptionRecord"],
    close_project: [
      "CloseDecision",
      "InboxItem",
      "ProjectV2",
      "DirectionBrief",
    ],
    abandon_project: [
      "CloseDecision",
      "InboxItem",
      "ProjectV2",
      "DirectionBrief",
    ],
  };
  return (allowed[commandType] ?? []).includes(
    entity as ProtectedCreatedEntity["entity"],
  );
}

function indexedHoldValue(value: unknown): value is IndexedProjectHold {
  return (
    record(value) &&
    Number.isSafeInteger(value.index) &&
    Number(value.index) >= 0 &&
    record(value.value) &&
    typeof value.value.type === "string" &&
    ["migration_review", "rebet_required", "review_overdue", "sync_conflict"].includes(
      value.value.type,
    ) &&
    typeof value.value.sourceId === "string" &&
    Array.isArray(value.value.affectedRecordIds) &&
    value.value.affectedRecordIds.every((id) => typeof id === "string") &&
    canonicalTimestamp(value.value.createdAt)
  );
}

function validProjectedCell(
  commandType: ProtectedCommandType,
  value: unknown,
): value is ProtectedEffectCell {
  if (!record(value) || typeof value.kind !== "string") return false;
  if (value.kind === "create") {
    return (
      typeof value.entity === "string" &&
      commandMayCreate(commandType, value.entity) &&
      typeof value.entityId === "string" &&
      record(value.value) &&
      value.value.id === value.entityId &&
      jsonValue(value.value)
    );
  }
  if (value.kind === "scalar") {
    return (
      typeof value.entity === "string" &&
      typeof value.entityId === "string" &&
      (value.entity === "BetVersion"
        ? typeof value.ownerProjectId === "string"
        : value.ownerProjectId === undefined) &&
      typeof value.field === "string" &&
      allowedScalar(commandType, value.entity, value.field) !== undefined &&
      jsonValue(value.before) &&
      jsonValue(value.after)
    );
  }
  if (value.kind === "project_hold_delta") {
    const before = value.before;
    const after = value.after;
    const selected = after ?? before;
    if (
      typeof value.projectId !== "string" ||
      typeof value.holdKey !== "string" ||
      !(before === null || indexedHoldValue(before)) ||
      !(after === null || indexedHoldValue(after)) ||
      selected === null ||
      selected === undefined
    ) return false;
    if (
      !indexedHoldValue(selected) ||
      value.holdKey !== holdIdentity(selected.value)
    ) return false;
    if (
      commandType === "place_bet" ||
      commandType === "close_project" ||
      commandType === "abandon_project"
    ) {
      return before !== null && after === null && before.value.type === "rebet_required";
    }
    if (commandType === "update_direction") {
      return before === null && after !== null && after.value.type === "rebet_required";
    }
    if (commandType === "record_bet_boundary") {
      return before === null && after !== null && after.value.type === "rebet_required";
    }
    if (commandType === "mark_review_overdue") {
      return before === null && after !== null && after.value.type === "review_overdue";
    }
    if (commandType === "complete_review") {
      return before !== null && after === null && before.value.type === "review_overdue";
    }
    return false;
  }
  if (value.kind === "exception_history_append") {
    return (
      commandType === "resolve_evidence_exception" &&
      typeof value.exceptionId === "string" &&
      Number.isSafeInteger(value.index) &&
      Number(value.index) >= 1 &&
      record(value.entry) &&
      value.entry.action === "resolved" &&
      typeof value.entry.actorId === "string" &&
      canonicalTimestamp(value.entry.at) &&
      typeof value.entry.note === "string"
    );
  }
  return false;
}

function validProjectedOperation(value: unknown): value is ProtectedOperationProjection {
  const hash = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
  if (
    !record(value) ||
    typeof value.commandType !== "string" ||
    !isProtectedCommandType(value.commandType) ||
    typeof value.commandId !== "string" ||
    value.commandId.length === 0 ||
    !record(value.command) ||
    value.command.type !== value.commandType ||
    !jsonValue(value.command) ||
    !hash(value.authorityRootOperationHash) ||
    !hash(value.sourceOperationHash) ||
    !hash(value.receiptHash) ||
    !hash(value.payloadHash) ||
    !canonicalTimestamp(value.createdAt) ||
    !Array.isArray(value.cells)
  ) return false;
  return value.cells.every((cell) =>
    validProjectedCell(value.commandType as ProtectedCommandType, cell),
  );
}

function commandMatchesLogicalKind(
  commandType: ProtectedCommandType,
  kind: LogicalKeyParts[0],
): boolean {
  const allowed: Record<LogicalKeyParts[0], readonly ProtectedCommandType[]> = {
    bet: ["place_bet", "update_direction", "record_bet_boundary"],
    daily_commitment: ["commit_today", "propose_replan", "accept_replan"],
    review: ["create_review", "mark_review_overdue", "complete_review"],
    exception: ["approve_evidence_exception", "resolve_evidence_exception"],
    close: ["close_project", "abandon_project"],
  };
  return allowed[kind].includes(commandType);
}

function createsOf<E extends ProtectedCreatedEntity["entity"]>(
  creates: readonly ProtectedCreatedEntity[],
  entity: E,
): Array<Extract<ProtectedCreatedEntity, { entity: E }>> {
  return creates.filter(
    (cell): cell is Extract<ProtectedCreatedEntity, { entity: E }> =>
      cell.entity === entity,
  );
}

function operationCellsOfKind<K extends ProtectedEffectCell["kind"]>(
  operation: ProtectedOperationProjection,
  kind: K,
): Array<Extract<ProtectedEffectCell, { kind: K }>> {
  return operation.cells.filter(
    (cell): cell is Extract<ProtectedEffectCell, { kind: K }> =>
      cell.kind === kind,
  );
}

function slotProjectIds(
  slots: readonly { target: { kind: string; projectId?: string } }[],
): Set<Id> {
  return new Set(
    slots.flatMap(({ target }) =>
      target.kind === "work_item" && typeof target.projectId === "string"
        ? [target.projectId]
        : [],
    ),
  );
}

/**
 * A bundle hash is only an integrity checksum. Keep the normalized projection
 * command-complete as well, so an attacker cannot add a whitelisted cell from
 * another command/owner and merely recompute that checksum.
 */
function operationOwnerAndTransitionAreValid(
  operation: ProtectedOperationProjection,
  logical: LogicalKeyParts,
): boolean {
  const [kind, owner] = logical;
  const command = operation.command;
  if (command.type !== operation.commandType) return false;
  const creates = operationCellsOfKind(operation, "create");
  const scalars = operationCellsOfKind(operation, "scalar");
  const holds = operationCellsOfKind(operation, "project_hold_delta");
  const histories = operationCellsOfKind(
    operation,
    "exception_history_append",
  );

  switch (command.type) {
    case "place_bet": {
      if (kind !== "bet" || command.projectId !== owner) return false;
      const bets = createsOf(creates, "BetVersion");
      if (
        bets.length !== 1 ||
        bets[0].entityId !== command.betId ||
        bets[0].value.projectId !== owner ||
        bets[0].value.appetiteStart !== command.start ||
        bets[0].value.approvedAt !== command.start
      ) return false;
      const ownedBetIds = new Set<Id>([command.betId]);
      if (bets[0].value.supersedesId !== undefined) {
        ownedBetIds.add(bets[0].value.supersedesId);
      }
      return (
        creates.length === 1 &&
        scalars.every((cell) =>
          cell.entity === "BetVersion"
            ? ownedBetIds.has(cell.entityId) && cell.ownerProjectId === owner
            : cell.entity === "ProjectV2" && cell.entityId === owner,
        ) &&
        holds.every(({ projectId }) => projectId === owner) &&
        histories.length === 0
      );
    }

    case "record_bet_boundary": {
      if (
        kind !== "bet" ||
        command.projectId !== owner ||
        command.boundary !== "expired" ||
        creates.length !== 0 ||
        histories.length !== 0 ||
        holds.length !== 1 ||
        scalars.length > 1
      ) return false;
      const betId = command.triggerKey.endsWith(":expired")
        ? command.triggerKey.slice(0, -":expired".length)
        : "";
      const selectedHold = holds[0].after;
      return (
        betId.length > 0 &&
        holds[0].projectId === owner &&
        holds[0].before === null &&
        selectedHold !== null &&
        selectedHold.value.type === "rebet_required" &&
        selectedHold.value.sourceId === betId &&
        selectedHold.value.createdAt === operation.createdAt &&
        canonicalJson(
          [...new Set(selectedHold.value.affectedRecordIds)].sort(),
        ) === canonicalJson([betId, owner].sort()) &&
        scalars.every(
          ({ entity, entityId, field, before, after }) =>
            entity === "ProjectV2" &&
            entityId === owner &&
            field === "stage" &&
            ["planning", "executing"].includes(String(before)) &&
            after === "validating",
        )
      );
    }

    case "update_direction": {
      if (kind !== "bet" || command.projectId !== owner) return false;
      const briefs = createsOf(creates, "DirectionBrief");
      if (briefs.length !== 1 || creates.length !== 1) return false;
      const brief = briefs[0];
      const value = brief.value;
      const expectedBrief = {
        ...structuredClone(command.brief),
        id: value.id,
        version: value.version,
        createdAt: operation.createdAt,
        updatedAt: operation.createdAt,
      };
      if (
        value.projectId !== owner ||
        value.id !== `${owner}:direction-brief:${String(value.version)}` ||
        !sameValue(value, expectedBrief)
      ) return false;
      const betScalars = scalars.filter(
        (cell) => cell.entity === "BetVersion",
      );
      const projectScalars = scalars.filter(
        (cell) => cell.entity === "ProjectV2",
      );
      if (
        scalars.length !== 3 ||
        betScalars.length !== 2 ||
        projectScalars.length !== 1 ||
        new Set(betScalars.map(({ entityId }) => entityId)).size !== 1
      ) return false;
      const betId = betScalars[0].entityId;
      const invalidatedAt = betScalars.find(
        ({ field }) => field === "invalidatedAt",
      );
      const invalidationReason = betScalars.find(
        ({ field }) => field === "invalidationReason",
      );
      const pointer = projectScalars[0];
      if (
        betScalars.some(({ ownerProjectId }) => ownerProjectId !== owner) ||
        invalidatedAt?.before !== null ||
        invalidatedAt.after !== operation.createdAt ||
        invalidationReason?.before !== null ||
        invalidationReason.after !==
          "Material Direction change requires Re-bet." ||
        pointer.entityId !== owner ||
        pointer.field !== "activeDirectionBriefId" ||
        pointer.before !== command.brief.id ||
        pointer.after !== value.id ||
        holds.length !== 1
      ) return false;
      const selectedHold = holds[0].after;
      return (
        holds[0].projectId === owner &&
        holds[0].before === null &&
        selectedHold !== null &&
        selectedHold.value.type === "rebet_required" &&
        selectedHold.value.sourceId === betId &&
        selectedHold.value.createdAt === operation.createdAt &&
        canonicalJson(
          [...new Set(selectedHold.value.affectedRecordIds)].sort(),
        ) === canonicalJson([
          betId,
          command.brief.id,
          owner,
          value.id,
        ].sort()) &&
        histories.length === 0
      );
    }

    case "commit_today": {
      if (
        kind !== "daily_commitment" ||
        command.commitment.localDate !== owner
      ) return false;
      const commitments = createsOf(creates, "DailyCommitment");
      const plans = createsOf(creates, "PlanVersion");
      if (
        commitments.length !== 1 ||
        commitments[0].entityId !== command.commitment.id ||
        commitments[0].value.localDate !== owner
      ) return false;
      const affectedProjects = slotProjectIds(commitments[0].value.slots);
      return (
        creates.length === 1 + plans.length &&
        plans.every(({ value }) => affectedProjects.has(value.projectId)) &&
        scalars.every(
          ({ entity, entityId }) =>
            entity === "ProjectV2" && affectedProjects.has(entityId),
        ) &&
        holds.length === 0 &&
        histories.length === 0
      );
    }

    case "propose_replan": {
      if (
        kind !== "daily_commitment" ||
        command.proposal.localDate !== owner
      ) return false;
      const proposals = createsOf(creates, "ReplanProposal");
      return (
        proposals.length === 1 &&
        creates.length === 1 &&
        proposals[0].entityId === command.proposal.id &&
        sameValue(proposals[0].value, command.proposal) &&
        scalars.length === 0 &&
        holds.length === 0 &&
        histories.length === 0
      );
    }

    case "accept_replan": {
      if (kind !== "daily_commitment") return false;
      const commitments = createsOf(creates, "DailyCommitment");
      const plans = createsOf(creates, "PlanVersion");
      if (
        commitments.length !== 1 ||
        commitments[0].entityId !== command.commitmentId ||
        commitments[0].value.localDate !== owner
      ) return false;
      const affectedProjects = slotProjectIds(commitments[0].value.slots);
      const proposalTransitions = scalars.filter(
        ({ entity }) => entity === "ReplanProposal",
      );
      return (
        creates.length === 1 + plans.length &&
        plans.every(({ value }) => affectedProjects.has(value.projectId)) &&
        proposalTransitions.length === 1 &&
        proposalTransitions[0].entityId === command.proposalId &&
        proposalTransitions[0].field === "status" &&
        proposalTransitions[0].before === "open" &&
        proposalTransitions[0].after === "accepted" &&
        scalars.every((cell) =>
          cell.entity === "ReplanProposal"
            ? cell === proposalTransitions[0]
            : cell.entity === "ProjectV2" && affectedProjects.has(cell.entityId),
        ) &&
        holds.length === 0 &&
        histories.length === 0
      );
    }

    case "create_review": {
      if (
        kind !== "review" ||
        command.review.triggerKey !== owner
      ) return false;
      const reviews = createsOf(creates, "ReviewRecord");
      return (
        reviews.length === 1 &&
        creates.length === 1 &&
        reviews[0].entityId === command.review.id &&
        reviews[0].value.triggerKey === owner &&
        scalars.length === 0 &&
        holds.length === 0 &&
        histories.length === 0
      );
    }

    case "mark_review_overdue": {
      if (kind !== "review") return false;
      return (
        creates.length === 0 &&
        scalars.length === 1 &&
        scalars[0].entity === "ReviewRecord" &&
        scalars[0].entityId === command.reviewId &&
        scalars[0].field === "overdueMarkedAt" &&
        holds.every((cell) => {
          const selected = cell.after ?? cell.before;
          return selected?.value.sourceId === command.reviewId;
        }) &&
        histories.length === 0
      );
    }

    case "complete_review": {
      if (kind !== "review") return false;
      const reviewScalars = scalars.filter(
        ({ entity, entityId }) =>
          entity === "ReviewRecord" && entityId === command.reviewId,
      );
      return (
        creates.length === 0 &&
        scalars.length === 2 &&
        reviewScalars.length === 2 &&
        reviewScalars.some(
          ({ field, before, after }) =>
            field === "status" && before === "open" && after === "completed",
        ) &&
        reviewScalars.some(({ field }) => field === "conclusion") &&
        holds.every((cell) => {
          const selected = cell.after ?? cell.before;
          return selected?.value.sourceId === command.reviewId;
        }) &&
        histories.length === 0
      );
    }

    case "approve_evidence_exception": {
      if (
        kind !== "exception" ||
        command.exception.id !== owner
      ) return false;
      const exceptions = createsOf(creates, "ExceptionRecord");
      return (
        exceptions.length === 1 &&
        creates.length === 1 &&
        exceptions[0].entityId === owner &&
        scalars.length === 0 &&
        holds.length === 0 &&
        histories.length === 0
      );
    }

    case "resolve_evidence_exception": {
      if (kind !== "exception" || command.exceptionId !== owner) return false;
      return (
        creates.length === 0 &&
        scalars.length === 1 &&
        scalars[0].entity === "ExceptionRecord" &&
        scalars[0].entityId === owner &&
        scalars[0].field === "resolvedAt" &&
        histories.length === 1 &&
        histories[0].exceptionId === owner &&
        holds.length === 0
      );
    }

    case "close_project":
    case "abandon_project": {
      if (kind !== "close" || command.projectId !== owner) return false;
      const decisions = createsOf(creates, "CloseDecision");
      if (
        decisions.length !== 1 ||
        decisions[0].entityId !== command.decision.id ||
        decisions[0].value.projectId !== owner ||
        command.decision.projectId !== owner ||
        decisions[0].value.successComparison !==
          command.decision.successComparison ||
        decisions[0].value.outcome !== command.decision.outcome ||
        decisions[0].value.keyLearning !== command.decision.keyLearning ||
        decisions[0].value.unfinishedDisposition !==
          command.decision.unfinishedDisposition ||
        decisions[0].value.followUpProjectId !==
          command.decision.followUpProjectId
      ) return false;
      return (
        scalars.every(
          ({ entity, entityId }) =>
            entity === "ProjectV2" && entityId === owner,
        ) &&
        holds.every(({ projectId }) => projectId === owner) &&
        histories.length === 0
      );
    }

    default:
      return false;
  }
}

function bundleOwnerSemanticsAreValid(
  bundle: ProtectedEffectBundle,
): boolean {
  const logical = parseLogicalKey(bundle.logicalKey);
  if (logical === undefined) return false;
  const [kind, owner] = logical;
  if (
    bundle.operations.some(
      (operation) =>
        !commandMatchesLogicalKind(operation.commandType, kind) ||
        operation.cells.length === 0 ||
        !operationOwnerAndTransitionAreValid(operation, logical),
    )
  ) return false;
  const cells = bundle.operations.flatMap(({ cells }) => cells);
  const creates = cells.filter(
    (cell): cell is ProtectedCreatedEntity => cell.kind === "create",
  );
  const scalars = cells.filter(
    (cell): cell is ProtectedScalarCell => cell.kind === "scalar",
  );
  const holds = cells.filter(
    (cell): cell is ProjectHoldDelta => cell.kind === "project_hold_delta",
  );
  const histories = cells.filter(
    (cell): cell is ExceptionHistoryAppend =>
      cell.kind === "exception_history_append",
  );

  if (kind === "bet") {
    const bets = createsOf(creates, "BetVersion");
    const briefs = createsOf(creates, "DirectionBrief");
    const boundaryOperations = bundle.operations.filter(
      ({ commandType }) => commandType === "record_bet_boundary",
    );
    const createdBetIds = new Set(bets.map(({ entityId }) => entityId));
    const createdBriefIds = new Set(briefs.map(({ entityId }) => entityId));
    return (
      (bets.length > 0 || briefs.length > 0 || boundaryOperations.length > 0) &&
      creates.length === bets.length + briefs.length &&
      bets.every(({ value }) => value.projectId === owner) &&
      briefs.every(({ value }) => value.projectId === owner) &&
      scalars.every((cell) =>
        (cell.entity === "BetVersion" && cell.ownerProjectId === owner) ||
        (cell.entity === "ProjectV2" &&
          cell.entityId === owner &&
          (cell.field === "activeBetId"
            ? typeof cell.after === "string" && createdBetIds.has(cell.after)
            : cell.field === "activeDirectionBriefId"
              ? typeof cell.after === "string" &&
                createdBriefIds.has(cell.after)
              : true))
      ) &&
      holds.every(({ projectId }) => projectId === owner) &&
      histories.length === 0
    );
  }

  if (kind === "daily_commitment") {
    const commitments = createsOf(creates, "DailyCommitment");
    const proposals = createsOf(creates, "ReplanProposal");
    const plans = createsOf(creates, "PlanVersion");
    const planIds = new Set(plans.map(({ entityId }) => entityId));
    const commitmentIds = new Set(
      commitments.map(({ entityId }) => entityId),
    );
    return (
      commitments.length + proposals.length > 0 &&
      commitments.every(({ value }) => value.localDate === owner) &&
      proposals.every(({ value }) => value.localDate === owner) &&
      plans.every(({ value, entityId }) =>
        [...commitmentIds].some(
          (commitmentId) =>
            entityId === `plan:${value.projectId}:${commitmentId}`,
        ),
      ) &&
      scalars.every((cell) => {
        if (cell.entity === "ProjectV2") {
          return (
            cell.field !== "activePlanVersionId" ||
            (typeof cell.after === "string" && planIds.has(cell.after))
          );
        }
        return (
          cell.entity === "ReplanProposal" &&
          cell.field === "status" &&
          cell.before === "open" &&
          cell.after === "accepted"
        );
      }) &&
      holds.length === 0 &&
      histories.length === 0
    );
  }

  if (kind === "review") {
    const reviews = createsOf(creates, "ReviewRecord");
    const reviewIds = new Set([
      ...reviews.map(({ entityId }) => entityId),
      ...scalars
        .filter(({ entity }) => entity === "ReviewRecord")
        .map(({ entityId }) => entityId),
    ]);
    return (
      reviews.every(({ value }) => value.triggerKey === owner) &&
      scalars.every(({ entity }) => entity === "ReviewRecord") &&
      holds.every((cell) => {
        const selected = cell.after ?? cell.before;
        return selected !== null && reviewIds.has(selected.value.sourceId);
      }) &&
      histories.length === 0 &&
      reviewIds.size === 1 &&
      (reviews.length > 0 || scalars.length > 0)
    );
  }

  if (kind === "exception") {
    const exceptions = createsOf(creates, "ExceptionRecord");
    return (
      exceptions.every(({ entityId, value }) =>
        entityId === owner && value.id === owner,
      ) &&
      creates.every(({ entity }) => entity === "ExceptionRecord") &&
      scalars.every(
        ({ entity, entityId }) =>
          entity === "ExceptionRecord" && entityId === owner,
      ) &&
      histories.every(({ exceptionId }) => exceptionId === owner) &&
      holds.length === 0 &&
      (creates.length > 0 || scalars.length > 0 || histories.length > 0)
    );
  }

  const decisions = createsOf(creates, "CloseDecision");
  const decisionIds = new Set(decisions.map(({ entityId }) => entityId));
  const followUpProjectIds = new Set(
    decisions.flatMap(({ value }) =>
      value.followUpProjectId === undefined ? [] : [value.followUpProjectId],
    ),
  );
  const inboxItems = createsOf(creates, "InboxItem");
  const projects = createsOf(creates, "ProjectV2");
  const briefs = createsOf(creates, "DirectionBrief");
  return (
    decisions.length > 0 &&
    decisions.every(({ value }) => value.projectId === owner) &&
    inboxItems.every(({ entityId, value }) =>
      [...decisionIds].some(
        (decisionId) =>
          entityId === returnedInboxItemId(decisionId, value.sourceId),
      ),
    ) &&
    projects.every(
      ({ entityId, value }) =>
        followUpProjectIds.has(entityId) &&
        briefs.some(
          ({ entityId: briefId, value: brief }) =>
            brief.projectId === entityId &&
            value.activeDirectionBriefId === briefId &&
            [...decisionIds].some(
              (decisionId) =>
                briefId === followUpDirectionBriefId(decisionId, entityId),
            ),
        ),
    ) &&
    briefs.every(({ value }) => followUpProjectIds.has(value.projectId)) &&
    scalars.every(
      ({ entity, entityId }) => entity === "ProjectV2" && entityId === owner,
    ) &&
    holds.every(({ projectId }) => projectId === owner) &&
    histories.length === 0
  );
}

export async function validateProtectedEffectBundle(
  bundle: unknown,
): Promise<boolean> {
  try {
    assertProtectedEffectBundleSchema(bundle);
  } catch {
    return false;
  }
  if (
    !record(bundle) ||
    bundle.schemaVersion !== 1 ||
    typeof bundle.logicalKey !== "string" ||
    parseLogicalKey(bundle.logicalKey) === undefined ||
    !Array.isArray(bundle.operations) ||
    bundle.operations.length === 0 ||
    !bundle.operations.every(validProjectedOperation) ||
    typeof bundle.hash !== "string"
  ) {
    return false;
  }
  const typed = bundle as unknown as ProtectedEffectBundle;
  return (
    bundleOwnerSemanticsAreValid(typed) &&
    bundle.hash === (await expectedBundleHash(typed))
  );
}

export function protectedEffectBundleTouchedEntityIds(
  bundle: Readonly<ProtectedEffectBundle>,
): Id[] {
  const ids = bundle.operations.flatMap(({ cells }) =>
    cells.flatMap((cell) => {
      switch (cell.kind) {
        case "create":
        case "scalar":
          return [cell.entityId];
        case "project_hold_delta":
          return [cell.projectId];
        case "exception_history_append":
          return [cell.exceptionId];
      }
    }),
  );
  return [...new Set(ids)].sort();
}

export function protectedEffectBundleAffectedProjectIds(
  bundle: Readonly<ProtectedEffectBundle>,
): Id[] {
  const ids: Id[] = [];
  for (const operation of bundle.operations) {
    for (const cell of operation.cells) {
      if (cell.kind === "project_hold_delta") {
        ids.push(cell.projectId);
        continue;
      }
      if (cell.kind === "scalar" && cell.entity === "ProjectV2") {
        ids.push(cell.entityId);
        continue;
      }
      if (
        cell.kind === "scalar" &&
        cell.entity === "BetVersion" &&
        cell.ownerProjectId !== undefined
      ) {
        ids.push(cell.ownerProjectId);
        continue;
      }
      if (cell.kind !== "create") continue;
      switch (cell.entity) {
        case "ProjectV2":
          ids.push(cell.value.id);
          break;
        case "BetVersion":
        case "PlanVersion":
        case "ExceptionRecord":
        case "CloseDecision":
        case "DirectionBrief":
          ids.push(cell.value.projectId);
          break;
        case "DailyCommitment":
          ids.push(
            ...cell.value.slots.flatMap(({ target }) =>
              target.kind === "work_item" ? [target.projectId] : [],
            ),
          );
          break;
        case "ReviewRecord":
          ids.push(...cell.value.affectedProjectIds);
          break;
        case "ReplanProposal":
          ids.push(
            ...cell.value.proposedSlots.flatMap(({ target }) =>
              target.kind === "work_item" ? [target.projectId] : [],
            ),
          );
          break;
        case "InboxItem":
          break;
      }
    }
  }
  return [...new Set(ids)].sort();
}

interface ProtectedRecordProjectionAtLogicalKey {
  recordType: SyncConflictRecord["recordType"];
  recordId: Id;
  value: JsonValue;
}

function protectedRecordProjectionAtLogicalKey(
  workspace: Readonly<WorkspaceV2>,
  logicalKey: string,
): ProtectedRecordProjectionAtLogicalKey | undefined {
  const logical = parseLogicalKey(logicalKey);
  if (logical === undefined) return undefined;
  const [recordType, owner] = logical;
  const matches = (() => {
    switch (recordType) {
      case "bet": {
        const projects = workspace.projects.filter(({ id }) => id === owner);
        if (projects.length !== 1 || projects[0].activeBetId === undefined) {
          return [];
        }
        return workspace.bets.filter(
          ({ id, projectId }) =>
            id === projects[0].activeBetId && projectId === owner,
        );
      }
      case "daily_commitment":
        return workspace.dailyCommitments.filter(
          (commitment) =>
            commitment.localDate === owner &&
            !workspace.dailyCommitments.some(
              ({ supersedesId }) => supersedesId === commitment.id,
            ),
        );
      case "review":
        return workspace.reviews.filter(({ triggerKey }) => triggerKey === owner);
      case "exception":
        return workspace.exceptions.filter(({ id }) => id === owner);
      case "close":
        return workspace.closeDecisions.filter(
          ({ projectId }) => projectId === owner,
        );
    }
  })();
  if (matches.length !== 1) return undefined;
  return {
    recordType,
    recordId: matches[0].id,
    value: structuredClone(matches[0]) as unknown as JsonValue,
  };
}

function protectedValueProjectIds(
  recordType: SyncConflictRecord["recordType"],
  value: JsonValue,
): Id[] {
  if (!record(value)) return [];
  const ids: Id[] = [];
  if (
    recordType === "bet" ||
    recordType === "exception" ||
    recordType === "close"
  ) {
    if (typeof value.projectId === "string") ids.push(value.projectId);
  } else if (recordType === "review") {
    if (Array.isArray(value.affectedProjectIds)) {
      ids.push(
        ...value.affectedProjectIds.filter(
          (id): id is string => typeof id === "string",
        ),
      );
    }
  } else if (Array.isArray(value.slots)) {
    for (const slot of value.slots) {
      if (!record(slot) || !record(slot.target)) continue;
      if (
        slot.target.kind === "work_item" &&
        typeof slot.target.projectId === "string"
      ) {
        ids.push(slot.target.projectId);
      }
    }
  }
  return [...new Set(ids)].sort();
}

/**
 * The effect cells are not always sufficient to discover Project ownership:
 * scalar-only Review and Exception branches keep that information in their
 * immutable primary snapshots. Keep merge planning and persisted metadata on
 * one canonical union so those conflicts cannot silently lose their holds.
 */
export function protectedEffectBundlePairAffectedProjectIds(input: {
  recordType: SyncConflictRecord["recordType"];
  localValue: JsonValue;
  remoteValue: JsonValue;
  localBundle: Readonly<ProtectedEffectBundle>;
  remoteBundle: Readonly<ProtectedEffectBundle>;
}): Id[] {
  return [...new Set([
    ...protectedEffectBundleAffectedProjectIds(input.localBundle),
    ...protectedEffectBundleAffectedProjectIds(input.remoteBundle),
    ...protectedValueProjectIds(input.recordType, input.localValue),
    ...protectedValueProjectIds(input.recordType, input.remoteValue),
  ])].sort();
}

interface ProtectedEffectBundlePairInput {
  workspace: Readonly<WorkspaceV2>;
  conflictId: Id;
  recordType: SyncConflictRecord["recordType"];
  projectId: Id | undefined;
  logicalKey: string | undefined;
  recordId: Id;
  remoteRecordId: Id | undefined;
  localValue: JsonValue;
  remoteValue: JsonValue;
  retainedVersion?: "local" | "remote";
  retainedBundleHash?: string;
  affectedRecordIds: readonly Id[] | undefined;
  affectedProjectIds: readonly Id[] | undefined;
  localBundle: Readonly<ProtectedEffectBundle> | undefined;
  remoteBundle: Readonly<ProtectedEffectBundle> | undefined;
}

function protectedValueIdentityMatchesLogicalKey(input: {
  recordType: SyncConflictRecord["recordType"];
  recordId: Id;
  owner: string;
  value: JsonValue;
}): boolean {
  if (!record(input.value) || input.value.id !== input.recordId) return false;
  switch (input.recordType) {
    case "bet":
    case "close":
      return input.value.projectId === input.owner;
    case "daily_commitment":
      return input.value.localDate === input.owner;
    case "review":
      return input.value.triggerKey === input.owner;
    case "exception":
      return input.value.id === input.owner;
  }
}

const primaryProtectedEntityByRecordType = {
  bet: "BetVersion",
  daily_commitment: "DailyCommitment",
  review: "ReviewRecord",
  exception: "ExceptionRecord",
  close: "CloseDecision",
} as const satisfies Record<
  SyncConflictRecord["recordType"],
  ProtectedCreatedEntity["entity"]
>;

interface HistoricalPrimaryProjection {
  valid: boolean;
  created: boolean;
  ancestor?: JsonValue;
  /** The first predecessor not created inside this bundle. */
  externalPredecessor?: Id | null;
}

type PrimaryProtectedEntity =
  (typeof primaryProtectedEntityByRecordType)[keyof typeof primaryProtectedEntityByRecordType];

function primaryCellId(
  cell: ProtectedEffectCell,
  primaryEntity: PrimaryProtectedEntity,
): Id | undefined {
  if (
    (cell.kind === "create" || cell.kind === "scalar") &&
    cell.entity === primaryEntity
  ) return cell.entityId;
  if (
    cell.kind === "exception_history_append" &&
    primaryEntity === "ExceptionRecord"
  ) return cell.exceptionId;
  return undefined;
}

function invalidHistoricalPrimaryProjection(): HistoricalPrimaryProjection {
  return { valid: false, created: false };
}

function reverseStoredPrimaryValue(
  value: JsonValue,
  cells: readonly ProtectedEffectCell[],
): HistoricalPrimaryProjection {
  let current: JsonValue | undefined = structuredClone(value);
  let created = false;

  for (const cell of [...cells].reverse()) {
    if (cell.kind === "create") {
      if (created || current === undefined || !sameValue(current, cell.value)) {
        return invalidHistoricalPrimaryProjection();
      }
      created = true;
      current = undefined;
      continue;
    }
    if (current === undefined || !record(current)) {
      return invalidHistoricalPrimaryProjection();
    }
    if (cell.kind === "scalar") {
      const currentField = Object.prototype.hasOwnProperty.call(
        current,
        cell.field,
      )
        ? current[cell.field]
        : null;
      if (!sameValue(currentField, cell.after)) {
        return invalidHistoricalPrimaryProjection();
      }
      if (cell.before === null) {
        delete current[cell.field];
      } else {
        current[cell.field] = structuredClone(cell.before);
      }
      continue;
    }

    if (cell.kind !== "exception_history_append") {
      return invalidHistoricalPrimaryProjection();
    }
    const history = current.history;
    if (
      !Array.isArray(history) ||
      cell.index !== history.length - 1 ||
      !sameValue(history[cell.index], cell.entry)
    ) {
      return invalidHistoricalPrimaryProjection();
    }
    history.pop();
  }

  return created
    ? { valid: current === undefined, created: true }
    : { valid: current !== undefined, created: false, ancestor: current };
}

function createdPrimaryPredecessor(
  cell: ProtectedCreatedEntity,
): Id | null {
  if (cell.entity === "BetVersion" || cell.entity === "DailyCommitment") {
    return cell.value.supersedesId ?? null;
  }
  return null;
}

/**
 * Reverse the bundle's cells for one stored primary value. A create cell binds
 * every byte of the snapshot to the hashed bundle. Scalar-only branches bind
 * every changed field and recover the pre-branch value so two branches can
 * prove that they descend from the same historical snapshot.
 */
function reverseHistoricalPrimaryProjection(input: {
  recordType: SyncConflictRecord["recordType"];
  recordId: Id;
  value: JsonValue;
  bundle: Readonly<ProtectedEffectBundle>;
}): HistoricalPrimaryProjection {
  const primaryEntity = primaryProtectedEntityByRecordType[input.recordType];
  const primaryCells = input.bundle.operations.flatMap(({ cells }) => cells)
    .filter(
      (cell) => primaryCellId(cell, primaryEntity) !== undefined,
    );
  const primaryCreates = primaryCells.filter(
    (cell): cell is ProtectedCreatedEntity => cell.kind === "create",
  );

  if (input.recordType === "bet" || input.recordType === "daily_commitment") {
    if (primaryCreates.length === 0) {
      if (
        primaryCells.some(
          (cell) => primaryCellId(cell, primaryEntity) !== input.recordId,
        ) ||
        (primaryCells.length === 0 &&
          !input.bundle.operations.every(({ commandType }) =>
            input.recordType === "bet"
              ? commandType === "record_bet_boundary"
              : commandType === "propose_replan"
          ))
      ) return invalidHistoricalPrimaryProjection();
      return reverseStoredPrimaryValue(input.value, primaryCells);
    }

    const createsById = new Map<Id, ProtectedCreatedEntity>();
    for (const create of primaryCreates) {
      if (createsById.has(create.entityId)) {
        return invalidHistoricalPrimaryProjection();
      }
      createsById.set(create.entityId, create);
    }
    const internallySupersededIds = new Set<Id>();
    for (const create of primaryCreates) {
      const predecessor = createdPrimaryPredecessor(create);
      if (predecessor !== null && createsById.has(predecessor)) {
        internallySupersededIds.add(predecessor);
      }
    }
    const leaves = [...createsById.keys()].filter(
      (id) => !internallySupersededIds.has(id),
    );
    if (leaves.length !== 1 || leaves[0] !== input.recordId) {
      return invalidHistoricalPrimaryProjection();
    }

    const visited = new Set<Id>();
    let cursor = leaves[0];
    let externalPredecessor: Id | null = null;
    while (true) {
      if (visited.has(cursor)) return invalidHistoricalPrimaryProjection();
      visited.add(cursor);
      const create = createsById.get(cursor);
      if (create === undefined) return invalidHistoricalPrimaryProjection();
      const predecessor = createdPrimaryPredecessor(create);
      if (predecessor === null) break;
      if (!createsById.has(predecessor)) {
        externalPredecessor = predecessor;
        break;
      }
      cursor = predecessor;
    }
    if (visited.size !== createsById.size) {
      return invalidHistoricalPrimaryProjection();
    }

    const allowedPrimaryIds = new Set<Id>(createsById.keys());
    if (externalPredecessor !== null) {
      allowedPrimaryIds.add(externalPredecessor);
    }
    if (
      primaryCells.some((cell) => {
        const id = primaryCellId(cell, primaryEntity);
        return id === undefined || !allowedPrimaryIds.has(id);
      })
    ) return invalidHistoricalPrimaryProjection();

    const selectedCells = primaryCells.filter(
      (cell) => primaryCellId(cell, primaryEntity) === input.recordId,
    );
    const reversed = reverseStoredPrimaryValue(input.value, selectedCells);
    return reversed.valid && reversed.created
      ? { ...reversed, externalPredecessor }
      : invalidHistoricalPrimaryProjection();
  }

  const primaryIds = new Set(
    primaryCells.flatMap((cell) => {
      const id = primaryCellId(cell, primaryEntity);
      return id === undefined ? [] : [id];
    }),
  );
  if (
    primaryIds.size !== 1 ||
    !primaryIds.has(input.recordId) ||
    primaryCreates.length > 1 ||
    (input.recordType === "close" && primaryCreates.length !== 1)
  ) return invalidHistoricalPrimaryProjection();
  return reverseStoredPrimaryValue(input.value, primaryCells);
}

/**
 * Validates the immutable conflict snapshot independently from whichever
 * protected record is live now. Resolved conflicts use this historical layer;
 * open/resolve command boundaries additionally require the reversible live
 * projection below.
 */
export async function validateProtectedEffectBundlePairMetadata(
  input: ProtectedEffectBundlePairInput,
): Promise<boolean> {
  const logical = input.logicalKey === undefined
    ? undefined
    : parseLogicalKey(input.logicalKey);
  if (
    logical === undefined ||
    logical[0] !== input.recordType ||
    input.remoteRecordId === undefined ||
    input.localBundle === undefined ||
    input.remoteBundle === undefined ||
    input.affectedRecordIds === undefined ||
    input.affectedProjectIds === undefined ||
    !(await validateProtectedEffectBundle(input.localBundle)) ||
    !(await validateProtectedEffectBundle(input.remoteBundle)) ||
    input.localBundle.logicalKey !== input.logicalKey ||
    input.remoteBundle.logicalKey !== input.logicalKey ||
    input.localBundle.hash === input.remoteBundle.hash ||
    (input.retainedVersion === undefined
      ? input.retainedBundleHash !== undefined
      : input.retainedBundleHash !==
        (input.retainedVersion === "local"
          ? input.localBundle.hash
          : input.remoteBundle.hash))
  ) {
    return false;
  }
  if (
    !protectedValueIdentityMatchesLogicalKey({
      recordType: input.recordType,
      recordId: input.recordId,
      owner: logical[1],
      value: input.localValue,
    }) ||
    !protectedValueIdentityMatchesLogicalKey({
      recordType: input.recordType,
      recordId: input.remoteRecordId,
      owner: logical[1],
      value: input.remoteValue,
    })
  ) return false;
  const localHistorical = reverseHistoricalPrimaryProjection({
    recordType: input.recordType,
    recordId: input.recordId,
    value: input.localValue,
    bundle: input.localBundle,
  });
  const remoteHistorical = reverseHistoricalPrimaryProjection({
    recordType: input.recordType,
    recordId: input.remoteRecordId,
    value: input.remoteValue,
    bundle: input.remoteBundle,
  });
  if (!localHistorical.valid || !remoteHistorical.valid) return false;
  if (localHistorical.created && remoteHistorical.created) {
    if (
      (input.recordType === "bet" ||
        input.recordType === "daily_commitment") &&
      localHistorical.externalPredecessor !==
        remoteHistorical.externalPredecessor
    ) return false;
  } else if (localHistorical.created !== remoteHistorical.created) {
    if (
      input.recordType !== "bet" &&
      input.recordType !== "daily_commitment"
    ) return false;
    const created = localHistorical.created
      ? localHistorical
      : remoteHistorical;
    const existingRecordId = localHistorical.created
      ? input.remoteRecordId
      : input.recordId;
    if (created.externalPredecessor !== existingRecordId) return false;
  } else if (
    input.recordId !== input.remoteRecordId ||
    !sameValue(localHistorical.ancestor, remoteHistorical.ancestor)
  ) return false;
  const sortedUnique = (values: readonly (Id | undefined)[]) =>
    [...new Set(values.filter((value): value is Id => value !== undefined))]
      .sort();
  const expectedAffectedRecordIds = sortedUnique([
    input.recordId,
    input.remoteRecordId,
    ...protectedEffectBundleTouchedEntityIds(input.localBundle),
    ...protectedEffectBundleTouchedEntityIds(input.remoteBundle),
  ]);
  const currentProjectIds = new Set(
    input.workspace.projects.map(({ id }) => id),
  );
  const expectedAffectedProjectIds = protectedEffectBundlePairAffectedProjectIds({
    recordType: input.recordType,
    localValue: input.localValue,
    remoteValue: input.remoteValue,
    localBundle: input.localBundle,
    remoteBundle: input.remoteBundle,
  }).filter((id) => currentProjectIds.has(id));
  if (
    input.affectedRecordIds.length !== expectedAffectedRecordIds.length ||
    input.affectedProjectIds.length !== expectedAffectedProjectIds.length ||
    canonicalJson(sortedUnique(input.affectedRecordIds)) !==
      canonicalJson(expectedAffectedRecordIds) ||
    canonicalJson(sortedUnique(input.affectedProjectIds)) !==
      canonicalJson(expectedAffectedProjectIds)
  ) return false;

  const localProjectIds = protectedValueProjectIds(
    input.recordType,
    input.localValue,
  );
  const expectedProjectId = localProjectIds.length === 1
    ? localProjectIds[0]
    : undefined;
  if (input.projectId !== expectedProjectId) return false;
  if (
    ["bet", "exception", "close"].includes(input.recordType) &&
    canonicalJson(
      protectedValueProjectIds(
        input.recordType,
        input.remoteValue,
      ),
    ) !== canonicalJson(localProjectIds)
  ) return false;

  return true;
}

export async function validateProtectedEffectBundlePair(
  input: ProtectedEffectBundlePairInput,
): Promise<boolean> {
  if (!(await validateProtectedEffectBundlePairMetadata(input))) return false;
  const logicalKey = input.logicalKey;
  const localBundle = input.localBundle;
  const remoteBundle = input.remoteBundle;
  if (
    logicalKey === undefined ||
    localBundle === undefined ||
    remoteBundle === undefined
  ) return false;

  const currentIsRemote = input.retainedVersion === "remote";
  const currentProjection = protectedRecordProjectionAtLogicalKey(
    input.workspace,
    logicalKey,
  );
  const currentRecordId = currentIsRemote
    ? input.remoteRecordId
    : input.recordId;
  const currentValue = currentIsRemote
    ? input.remoteValue
    : input.localValue;
  if (
    currentRecordId === undefined ||
    currentProjection === undefined ||
    currentProjection.recordType !== input.recordType ||
    currentProjection.recordId !== currentRecordId ||
    !sameValue(currentProjection.value, currentValue)
  ) return false;

  let otherWorkspace: WorkspaceV2;
  try {
    otherWorkspace = await applyRemoteProtectedEffectBundle({
      workspace: input.workspace,
      localBundle: currentIsRemote ? remoteBundle : localBundle,
      remoteBundle: currentIsRemote ? localBundle : remoteBundle,
      conflictId: input.conflictId,
      now: "1970-01-01T00:00:00.000Z",
    });
  } catch {
    return false;
  }
  const otherProjection = protectedRecordProjectionAtLogicalKey(
    otherWorkspace,
    logicalKey,
  );
  const otherRecordId = currentIsRemote
    ? input.recordId
    : input.remoteRecordId;
  const otherValue = currentIsRemote
    ? input.localValue
    : input.remoteValue;
  return (
    otherRecordId !== undefined &&
    otherProjection !== undefined &&
    otherProjection.recordType === input.recordType &&
    otherProjection.recordId === otherRecordId &&
    sameValue(otherProjection.value, otherValue)
  );
}

const collectionByEntity = {
  BetVersion: "bets",
  DailyCommitment: "dailyCommitments",
  PlanVersion: "planVersions",
  ReplanProposal: "replanProposals",
  ReviewRecord: "reviews",
  ExceptionRecord: "exceptions",
  CloseDecision: "closeDecisions",
  InboxItem: "inboxItems",
  ProjectV2: "projects",
  DirectionBrief: "directionBriefs",
} as const satisfies Record<
  ProtectedCreatedEntity["entity"],
  keyof WorkspaceV2
>;

type MutableRecord = { id: Id } & Record<string, unknown>;

function mutableEntityCollection(
  workspace: WorkspaceV2,
  entity: ProtectedCreatedEntity["entity"],
): MutableRecord[] {
  return workspace[collectionByEntity[entity]] as unknown as MutableRecord[];
}

function oneMutableEntity(
  workspace: WorkspaceV2,
  entity: ProtectedCreatedEntity["entity"],
  entityId: Id,
): MutableRecord {
  const matches = mutableEntityCollection(workspace, entity).filter(
    ({ id }) => id === entityId,
  );
  if (matches.length !== 1) {
    throw new SyncConflictBundleError(
      "PROJECTION_DRIFT",
      `${entity} ${entityId} no longer has one exact projection target.`,
    );
  }
  return matches[0];
}

function scalarEntityName(
  entity: ProtectedScalarCell["entity"],
): ProtectedCreatedEntity["entity"] {
  return entity;
}

function transitionScalar(
  workspace: WorkspaceV2,
  cell: ProtectedScalarCell,
  before: JsonValue,
  after: JsonValue,
  touchedProjects: Set<Id>,
): void {
  const target = oneMutableEntity(
    workspace,
    scalarEntityName(cell.entity),
    cell.entityId,
  );
  const current = Object.prototype.hasOwnProperty.call(target, cell.field)
    ? target[cell.field]
    : null;
  if (!sameValue(current, before)) {
    throw new SyncConflictBundleError(
      "PROJECTION_DRIFT",
      `${cell.entity} ${cell.entityId}.${cell.field} drifted from its selected bundle.`,
    );
  }
  if (after === null) {
    delete target[cell.field];
  } else {
    target[cell.field] = structuredClone(after);
  }
  if (cell.entity === "ProjectV2") touchedProjects.add(cell.entityId);
}

function transitionCreate(
  workspace: WorkspaceV2,
  cell: ProtectedCreatedEntity,
  direction: "apply" | "unapply",
  touchedProjects: Set<Id>,
  preferredCreateIndexes?: Map<ProtectedCreatedEntity["entity"], number[]>,
): void {
  const collection = mutableEntityCollection(workspace, cell.entity);
  const indexes = collection
    .map(({ id }, index) => (id === cell.entityId ? index : -1))
    .filter((index) => index >= 0);
  if (direction === "unapply") {
    if (
      indexes.length !== 1 ||
      !sameValue(collection[indexes[0]], cell.value)
    ) {
      throw new SyncConflictBundleError(
        "PROJECTION_DRIFT",
        `${cell.entity} ${cell.entityId} cannot be removed because its owned value drifted.`,
      );
    }
    collection.splice(indexes[0], 1);
  } else {
    if (indexes.length !== 0) {
      throw new SyncConflictBundleError(
        "PROJECTION_DRIFT",
        `${cell.entity} ${cell.entityId} collides with an existing record.`,
      );
    }
    const preferredIndex = preferredCreateIndexes
      ?.get(cell.entity)
      ?.shift();
    collection.splice(
      preferredIndex === undefined
        ? collection.length
        : Math.min(preferredIndex, collection.length),
      0,
      structuredClone(cell.value) as unknown as MutableRecord,
    );
  }
  if (cell.entity === "ProjectV2") touchedProjects.add(cell.entityId);
}

function mutableProject(
  workspace: WorkspaceV2,
  projectId: Id,
): ProjectV2 {
  return oneMutableEntity(
    workspace,
    "ProjectV2",
    projectId,
  ) as unknown as ProjectV2;
}

function transitionHold(
  workspace: WorkspaceV2,
  cell: ProjectHoldDelta,
  before: IndexedProjectHold | null,
  after: IndexedProjectHold | null,
  touchedProjects: Set<Id>,
): void {
  const project = mutableProject(workspace, cell.projectId);
  const matches = project.holds
    .map((hold, index) => ({ hold, index }))
    .filter(({ hold }) => holdIdentity(hold) === cell.holdKey);
  if (
    (before === null && matches.length !== 0) ||
    (before !== null &&
      (matches.length !== 1 ||
        !sameValue(matches[0].hold, before.value)))
  ) {
    throw new SyncConflictBundleError(
      "PROJECTION_DRIFT",
      `Project ${cell.projectId} hold ${cell.holdKey} drifted from its selected bundle.`,
    );
  }
  if (before !== null) project.holds.splice(matches[0].index, 1);
  if (after !== null) {
    if (project.holds.some((hold) => holdIdentity(hold) === cell.holdKey)) {
      throw new SyncConflictBundleError(
        "PROJECTION_DRIFT",
        `Project ${cell.projectId} hold ${cell.holdKey} cannot be duplicated.`,
      );
    }
    project.holds.splice(
      Math.min(after.index, project.holds.length),
      0,
      structuredClone(after.value),
    );
  }
  touchedProjects.add(cell.projectId);
}

function transitionHistoryAppend(
  workspace: WorkspaceV2,
  cell: ExceptionHistoryAppend,
  direction: "apply" | "unapply",
): void {
  const record = oneMutableEntity(
    workspace,
    "ExceptionRecord",
    cell.exceptionId,
  ) as unknown as ExceptionRecord;
  if (direction === "unapply") {
    if (
      record.history.length !== cell.index + 1 ||
      !sameValue(record.history[cell.index], cell.entry)
    ) {
      throw new SyncConflictBundleError(
        "PROJECTION_DRIFT",
        `Exception ${cell.exceptionId} history drifted from its selected append.`,
      );
    }
    record.history.pop();
    return;
  }
  if (record.history.length !== cell.index) {
    throw new SyncConflictBundleError(
      "PROJECTION_DRIFT",
      `Exception ${cell.exceptionId} cannot append at history index ${cell.index}.`,
    );
  }
  record.history.push(structuredClone(cell.entry));
}

function transitionCell(
  workspace: WorkspaceV2,
  cell: ProtectedEffectCell,
  direction: "apply" | "unapply",
  touchedProjects: Set<Id>,
  preferredCreateIndexes?: Map<ProtectedCreatedEntity["entity"], number[]>,
): void {
  switch (cell.kind) {
    case "create":
      transitionCreate(
        workspace,
        cell,
        direction,
        touchedProjects,
        preferredCreateIndexes,
      );
      return;
    case "scalar":
      transitionScalar(
        workspace,
        cell,
        direction === "apply" ? cell.before : cell.after,
        direction === "apply" ? cell.after : cell.before,
        touchedProjects,
      );
      return;
    case "project_hold_delta":
      transitionHold(
        workspace,
        cell,
        direction === "apply" ? cell.before : cell.after,
        direction === "apply" ? cell.after : cell.before,
        touchedProjects,
      );
      return;
    case "exception_history_append":
      transitionHistoryAppend(workspace, cell, direction);
  }
}

export interface ApplyRemoteProtectedEffectBundleInput {
  workspace: Readonly<WorkspaceV2>;
  localBundle: Readonly<ProtectedEffectBundle>;
  remoteBundle: Readonly<ProtectedEffectBundle>;
  conflictId: Id;
  now: ISODate;
}

/**
 * Pure, atomic projection swap. The caller still owns conflict/Review status
 * updates and invariant validation inside the central command transaction.
 */
export async function applyRemoteProtectedEffectBundle(
  input: ApplyRemoteProtectedEffectBundleInput,
): Promise<WorkspaceV2> {
  if (
    !(await validateProtectedEffectBundle(input.localBundle)) ||
    !(await validateProtectedEffectBundle(input.remoteBundle))
  ) {
    throw new SyncConflictBundleError(
      "BUNDLE_TAMPERED",
      "A protected effect bundle failed its canonical hash.",
    );
  }
  if (input.localBundle.logicalKey !== input.remoteBundle.logicalKey) {
    throw new SyncConflictBundleError(
      "BUNDLE_MISMATCH",
      "Local and remote bundles do not address the same logical record.",
    );
  }
  const timestamp = Date.parse(input.now);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== input.now
  ) {
    throw new SyncConflictBundleError(
      "INVALID_PROJECTION",
      "Bundle resolution requires a canonical timestamp.",
    );
  }

  const workspace = structuredClone(input.workspace) as WorkspaceV2;
  const preferredCreateIndexes = new Map<
    ProtectedCreatedEntity["entity"],
    number[]
  >();
  for (const operation of input.localBundle.operations) {
    for (const cell of operation.cells) {
      if (cell.kind !== "create") continue;
      const index = mutableEntityCollection(workspace, cell.entity).findIndex(
        ({ id }) => id === cell.entityId,
      );
      if (index < 0) continue;
      const indexes = preferredCreateIndexes.get(cell.entity) ?? [];
      indexes.push(index);
      preferredCreateIndexes.set(cell.entity, indexes);
    }
  }
  const touchedProjects = new Set<Id>();
  for (const project of workspace.projects) {
    const matching = project.holds.filter(
      ({ type, sourceId }) =>
        type === "sync_conflict" && sourceId === input.conflictId,
    );
    if (matching.length > 1) {
      throw new SyncConflictBundleError(
        "PROJECTION_DRIFT",
        `Project ${project.id} repeats conflict hold ${input.conflictId}.`,
      );
    }
    if (matching.length === 1) {
      project.holds = project.holds.filter(
        ({ type, sourceId }) =>
          !(type === "sync_conflict" && sourceId === input.conflictId),
      );
      touchedProjects.add(project.id);
    }
  }

  for (
    let operationIndex = input.localBundle.operations.length - 1;
    operationIndex >= 0;
    operationIndex -= 1
  ) {
    const cells = input.localBundle.operations[operationIndex].cells;
    for (let cellIndex = cells.length - 1; cellIndex >= 0; cellIndex -= 1) {
      transitionCell(workspace, cells[cellIndex], "unapply", touchedProjects);
    }
  }
  for (const operation of input.remoteBundle.operations) {
    for (const cell of operation.cells) {
      transitionCell(
        workspace,
        cell,
        "apply",
        touchedProjects,
        preferredCreateIndexes,
      );
    }
  }

  if (input.remoteBundle.hash === input.localBundle.hash) {
    const retained = structuredClone(input.workspace) as WorkspaceV2;
    for (const project of retained.projects) {
      const holds = project.holds.filter(
        ({ type, sourceId }) =>
          !(type === "sync_conflict" && sourceId === input.conflictId),
      );
      if (holds.length !== project.holds.length) {
        project.holds = holds;
        project.updatedAt = input.now;
      }
    }
    return retained;
  }

  for (const projectId of touchedProjects) {
    const matches = workspace.projects.filter(({ id }) => id === projectId);
    if (matches.length === 1) matches[0].updatedAt = input.now;
  }
  return workspace;
}
