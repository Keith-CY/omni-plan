import type { Id, ISODate } from "@/domain/types";

import type {
  CloseDecision,
  ExceptionRecord,
  JsonValue,
  SyncConflictRecord,
  WorkspaceV2,
} from "./types";
import { buildCloseArtifacts, validateCloseDecisionDraft } from "./close";
import { isUsableControlledException } from "./evidence";
import { validateCapacityProfile } from "./localTime";
import { storedReviewSemanticsAreValid } from "./review";
import { stableHash } from "./stableHash";
import type { ProtectedEffectBundle } from "../repositories/syncConflictBundles";

export type SyncConflictRecordType = SyncConflictRecord["recordType"];

export interface SyncConflictDraft {
  id: Id;
  recordType: SyncConflictRecordType;
  recordId: Id;
  remoteRecordId?: Id;
  logicalKey?: string;
  affectedProjectIds?: Id[];
  affectedRecordIds?: Id[];
  commonAncestorHash: string;
  localValue?: JsonValue;
  remoteValue: JsonValue;
  localBundle?: ProtectedEffectBundle;
  remoteBundle?: ProtectedEffectBundle;
}

export interface ConflictTarget {
  record: JsonValue;
  projectIds: Id[];
  projectId?: Id;
}

export type ConflictTargetLookup =
  | { ok: true; target: ConflictTarget }
  | { ok: false; reason: "missing" | "duplicate" | "invalid_remote" };

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

function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function stringValue(value: unknown): value is string {
  return typeof value === "string";
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function canonicalId(value: unknown): value is Id {
  return stringValue(value) && value.trim().length > 0 && value === value.trim();
}

function canonicalTimestamp(value: unknown): value is ISODate {
  if (!stringValue(value)) return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalLocalDate(value: unknown): value is string {
  if (!stringValue(value) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function validTimeZone(value: unknown): value is string {
  if (!stringValue(value) || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function uniqueIds(values: readonly string[]): boolean {
  return values.every(canonicalId) && new Set(values).size === values.length;
}

function uniqueRecordIds(values: readonly unknown[]): boolean {
  const ids = values.map((value) =>
    recordValue(value) && stringValue(value.id) ? value.id : "",
  );
  return uniqueIds(ids);
}

function optionalString(value: unknown): boolean {
  return value === undefined || stringValue(value);
}

function optionalId(value: unknown): boolean {
  return value === undefined || canonicalId(value);
}

function optionalTimestamp(value: unknown): boolean {
  return value === undefined || canonicalTimestamp(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(stringValue);
}

function scopeValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(value, ["id", "title", "description"]) &&
    canonicalId(value.id) &&
    stringValue(value.title) &&
    stringValue(value.description)
  );
}

function directionBriefValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(value, [
      "id",
      "projectId",
      "version",
      "audienceAndProblem",
      "successEvidence",
      "appetiteSeconds",
      "validationMethod",
      "firstScope",
      "noGoOrKill",
      "advancedNotes",
      "createdAt",
      "updatedAt",
    ]) &&
    canonicalId(value.id) &&
    canonicalId(value.projectId) &&
    positiveSafeInteger(value.version) &&
    stringValue(value.audienceAndProblem) &&
    stringValue(value.successEvidence) &&
    positiveSafeInteger(value.appetiteSeconds) &&
    stringValue(value.validationMethod) &&
    Array.isArray(value.firstScope) &&
    value.firstScope.every(scopeValue) &&
    uniqueRecordIds(value.firstScope) &&
    stringValue(value.noGoOrKill) &&
    stringValue(value.advancedNotes) &&
    canonicalTimestamp(value.createdAt) &&
    canonicalTimestamp(value.updatedAt) &&
    Date.parse(value.updatedAt) >= Date.parse(value.createdAt)
  );
}

function betValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(
      value,
      [
        "id",
        "projectId",
        "version",
        "briefId",
        "briefHash",
        "briefSnapshot",
        "committedScope",
        "appetiteStart",
        "appetiteEnd",
        "actorId",
        "approvedAt",
      ],
      [
        "supersedesId",
        "replacementReason",
        "sourceReviewId",
        "invalidatedAt",
        "invalidationReason",
      ],
    ) &&
    canonicalId(value.id) &&
    canonicalId(value.projectId) &&
    positiveSafeInteger(value.version) &&
    canonicalId(value.briefId) &&
    stringValue(value.briefHash) &&
    value.briefHash.trim().length > 0 &&
    directionBriefValue(value.briefSnapshot) &&
    recordValue(value.briefSnapshot) &&
    value.briefSnapshot.projectId === value.projectId &&
    value.briefSnapshot.id === value.briefId &&
    Array.isArray(value.committedScope) &&
    value.committedScope.every(scopeValue) &&
    uniqueRecordIds(value.committedScope) &&
    canonicalTimestamp(value.appetiteStart) &&
    canonicalTimestamp(value.appetiteEnd) &&
    Date.parse(value.appetiteEnd) > Date.parse(value.appetiteStart) &&
    canonicalId(value.actorId) &&
    canonicalTimestamp(value.approvedAt) &&
    Date.parse(value.approvedAt) <= Date.parse(value.appetiteEnd) &&
    optionalId(value.supersedesId) &&
    (value.replacementReason === undefined ||
      value.replacementReason === "material_direction_change" ||
      value.replacementReason === "appetite_expiry") &&
    optionalId(value.sourceReviewId) &&
    optionalTimestamp(value.invalidatedAt) &&
    optionalString(value.invalidationReason) &&
    ((value.invalidatedAt === undefined &&
      value.invalidationReason === undefined) ||
      (canonicalTimestamp(value.invalidatedAt) &&
        stringValue(value.invalidationReason) &&
        value.invalidationReason.trim().length > 0 &&
        Date.parse(value.invalidatedAt) >= Date.parse(value.approvedAt)))
  );
}

function capacityProfileValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(value, [
      "timeZone",
      "weeklyWindows",
      "dailyBudgets",
      "unavailableBlocks",
      "updatedAt",
      "updatedBy",
    ]) &&
    validTimeZone(value.timeZone) &&
    Array.isArray(value.weeklyWindows) &&
    value.weeklyWindows.every(
      (window) =>
        recordValue(window) &&
        exactKeys(window, ["weekday", "startMinute", "finishMinute"]) &&
        nonNegativeSafeInteger(window.weekday) &&
        window.weekday <= 6 &&
        nonNegativeSafeInteger(window.startMinute) &&
        nonNegativeSafeInteger(window.finishMinute) &&
        window.startMinute < window.finishMinute &&
        window.finishMinute <= 1_440,
    ) &&
    Array.isArray(value.dailyBudgets) &&
    value.dailyBudgets.every(
      (budget) =>
        recordValue(budget) &&
        exactKeys(budget, [
          "weekday",
          "deepSeconds",
          "mediumSeconds",
          "shallowSeconds",
        ]) &&
        nonNegativeSafeInteger(budget.weekday) &&
        budget.weekday <= 6 &&
        nonNegativeSafeInteger(budget.deepSeconds) &&
        nonNegativeSafeInteger(budget.mediumSeconds) &&
        nonNegativeSafeInteger(budget.shallowSeconds),
    ) &&
    Array.isArray(value.unavailableBlocks) &&
    value.unavailableBlocks.every(
      (block) =>
        recordValue(block) &&
        exactKeys(block, ["id", "start", "finish"]) &&
        canonicalId(block.id) &&
        canonicalTimestamp(block.start) &&
        canonicalTimestamp(block.finish) &&
        Date.parse(block.start) < Date.parse(block.finish),
    ) &&
    uniqueRecordIds(value.unavailableBlocks) &&
    canonicalTimestamp(value.updatedAt) &&
    canonicalId(value.updatedBy)
  );
}

function commitmentTargetValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    ((value.kind === "action" &&
      exactKeys(value, ["kind", "actionId"]) &&
      canonicalId(value.actionId)) ||
      (value.kind === "work_item" &&
        exactKeys(value, ["kind", "workItemId", "projectId"]) &&
        canonicalId(value.workItemId) &&
        canonicalId(value.projectId)))
  );
}

function commitmentSlotValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(value, [
      "id",
      "target",
      "targetRevision",
      "start",
      "finish",
      "attention",
    ]) &&
    canonicalId(value.id) &&
    commitmentTargetValue(value.target) &&
    nonNegativeSafeInteger(value.targetRevision) &&
    canonicalTimestamp(value.start) &&
    canonicalTimestamp(value.finish) &&
    Date.parse(value.start) < Date.parse(value.finish) &&
    ["deep", "medium", "shallow"].includes(String(value.attention))
  );
}

function dailyCommitmentValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(
      value,
      [
        "id",
        "localDate",
        "version",
        "proposalHash",
        "capacitySnapshot",
        "slots",
        "actorId",
        "committedAt",
      ],
      ["supersedesId"],
    ) &&
    canonicalId(value.id) &&
    canonicalLocalDate(value.localDate) &&
    positiveSafeInteger(value.version) &&
    stringValue(value.proposalHash) &&
    value.proposalHash.trim().length > 0 &&
    capacityProfileValue(value.capacitySnapshot) &&
    Array.isArray(value.slots) &&
    value.slots.every(commitmentSlotValue) &&
    uniqueRecordIds(value.slots) &&
    canonicalId(value.actorId) &&
    canonicalTimestamp(value.committedAt) &&
    optionalId(value.supersedesId)
  );
}

function reviewValue(value: unknown): boolean {
  if (!recordValue(value)) return false;
  const validBase =
    exactKeys(
      value,
      [
        "id",
        "kind",
        "triggerKey",
        "triggerType",
        "status",
        "affectedProjectIds",
        "affectedRecordIds",
        "dueAt",
        "createdAt",
      ],
      [
        "cadenceTimeZone",
        "overdueMarkedAt",
        "conclusion",
      ],
    ) &&
    canonicalId(value.id) &&
    ["weekly", "event"].includes(String(value.kind)) &&
    stringValue(value.triggerKey) &&
    value.triggerKey.trim().length > 0 &&
    [
      "weekly",
      "bet_midpoint",
      "bet_expired",
      "evidence_stale",
      "exception_expired",
      "capacity_variance",
      "hard_gate",
      "sync_conflict",
    ].includes(String(value.triggerType)) &&
    ["open", "completed"].includes(String(value.status)) &&
    stringArray(value.affectedProjectIds) &&
    uniqueIds(value.affectedProjectIds) &&
    stringArray(value.affectedRecordIds) &&
    uniqueIds(value.affectedRecordIds) &&
    canonicalTimestamp(value.dueAt) &&
    (value.cadenceTimeZone === undefined ||
      validTimeZone(value.cadenceTimeZone)) &&
    canonicalTimestamp(value.createdAt) &&
    (value.overdueMarkedAt === undefined ||
      (canonicalTimestamp(value.overdueMarkedAt) &&
        Date.parse(value.overdueMarkedAt) >= Date.parse(value.dueAt)));
  if (!validBase) return false;
  if (value.conclusion === undefined) return value.status === "open";
  return (
    value.status === "completed" &&
    recordValue(value.conclusion) &&
    exactKeys(value.conclusion, [
      "summary",
      "decisionCodes",
      "followUpCommandIds",
      "actorId",
      "completedAt",
    ]) &&
    stringValue(value.conclusion.summary) &&
    stringArray(value.conclusion.decisionCodes) &&
    stringArray(value.conclusion.followUpCommandIds) &&
    uniqueIds(value.conclusion.followUpCommandIds) &&
    canonicalId(value.conclusion.actorId) &&
    canonicalTimestamp(value.conclusion.completedAt) &&
    canonicalTimestamp(value.createdAt) &&
    Date.parse(value.conclusion.completedAt) >= Date.parse(value.createdAt)
  );
}

export async function conflictRemoteSemanticsAreValid(
  workspace: WorkspaceV2,
  draft: SyncConflictDraft,
): Promise<boolean> {
  if (
    !typedRemoteValue(draft.recordType, draft.remoteValue) ||
    !recordValue(draft.remoteValue)
  ) {
    return false;
  }
  switch (draft.recordType) {
    case "bet": {
      const remote = draft.remoteValue;
      const expectedEndMilliseconds =
        Date.parse(String(remote.appetiteStart)) +
        Number(
          (remote.briefSnapshot as Record<string, unknown>).appetiteSeconds,
        ) *
          1_000;
      if (
        !Number.isFinite(expectedEndMilliseconds) ||
        Math.abs(expectedEndMilliseconds) > 8.64e15
      ) {
        return false;
      }
      const expectedEnd = new Date(expectedEndMilliseconds).toISOString();
      return (
        remote.approvedAt === remote.appetiteStart &&
        remote.appetiteEnd === expectedEnd &&
        (await stableHash(remote.briefSnapshot as JsonValue)) ===
          remote.briefHash &&
        (await stableHash(remote.committedScope as JsonValue)) ===
          (await stableHash(
            (remote.briefSnapshot as Record<string, JsonValue>).firstScope,
          ))
      );
    }
    case "daily_commitment":
      return validateCapacityProfile(
        draft.remoteValue.capacitySnapshot as never,
      ).ok;
    case "review": {
      const reviews = workspace.reviews.map((review) =>
        review.id === draft.recordId ? (draft.remoteValue as never) : review,
      );
      return storedReviewSemanticsAreValid(
        { ...workspace, reviews },
        draft.remoteValue as never,
      );
    }
    case "exception":
      return isUsableControlledException(
        draft.remoteValue as unknown as ExceptionRecord,
      );
    case "close": {
      const remote = draft.remoteValue as unknown as CloseDecision;
      const projects = workspace.projects.filter(
        ({ id }) => id === remote.projectId,
      );
      if (projects.length !== 1) return false;
      const { actorId, closedAt, ...decision } = structuredClone(remote);
      if (
        validateCloseDecisionDraft(
          workspace,
          projects[0],
          decision,
          actorId,
          closedAt,
          remote.outcome === "abandoned" ? "abandon_project" : "close_project",
        ) !== undefined
      ) {
        return false;
      }
      const normalized = buildCloseArtifacts(
        workspace,
        projects[0],
        decision,
        actorId,
        closedAt,
      ).decision;
      return (await stableHash(normalized as unknown as JsonValue)) ===
        (await stableHash(remote as unknown as JsonValue));
    }
  }
}

export async function conflictRemoteResolutionIsSafe(
  draft: SyncConflictDraft,
  localValue: JsonValue,
): Promise<boolean> {
  if (!recordValue(draft.remoteValue) || !recordValue(localValue)) return false;
  if (draft.recordType === "review") {
    const immutableFields = [
      "id",
      "kind",
      "triggerKey",
      "triggerType",
      "affectedProjectIds",
      "affectedRecordIds",
      "dueAt",
      "cadenceTimeZone",
      "createdAt",
      "overdueMarkedAt",
    ] as const;
    const immutable = (value: Record<string, unknown>): JsonValue =>
      Object.fromEntries(
        immutableFields.map((field) => [field, value[field] ?? null]),
      ) as JsonValue;
    return (
      (await stableHash(immutable(localValue))) ===
      (await stableHash(immutable(draft.remoteValue)))
    );
  }
  if (draft.recordType === "close") {
    const sideEffectful = new Set(["return_to_inbox", "follow_up_project"]);
    if (
      !sideEffectful.has(String(localValue.unfinishedDisposition)) &&
      !sideEffectful.has(String(draft.remoteValue.unfinishedDisposition))
    ) {
      return true;
    }
    return (
      localValue.unfinishedDisposition ===
        draft.remoteValue.unfinishedDisposition &&
      localValue.followUpProjectId === draft.remoteValue.followUpProjectId &&
      localValue.actorId === draft.remoteValue.actorId &&
      localValue.closedAt === draft.remoteValue.closedAt
    );
  }
  return true;
}

function exceptionValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(
      value,
      [
        "id",
        "projectId",
        "requirementId",
        "rationale",
        "knownConsequence",
        "reviewAt",
        "expiresAt",
        "approvedBy",
        "createdAt",
        "history",
      ],
      ["resolvedAt"],
    ) &&
    canonicalId(value.id) &&
    canonicalId(value.projectId) &&
    canonicalId(value.requirementId) &&
    stringValue(value.rationale) &&
    stringValue(value.knownConsequence) &&
    canonicalTimestamp(value.reviewAt) &&
    canonicalTimestamp(value.expiresAt) &&
    canonicalId(value.approvedBy) &&
    canonicalTimestamp(value.createdAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.reviewAt) &&
    Date.parse(value.reviewAt) < Date.parse(value.expiresAt) &&
    (value.resolvedAt === undefined ||
      (canonicalTimestamp(value.resolvedAt) &&
        Date.parse(value.resolvedAt) >= Date.parse(value.createdAt))) &&
    Array.isArray(value.history) &&
    value.history.length > 0 &&
    value.history.every(
      (entry) =>
        recordValue(entry) &&
        exactKeys(entry, ["action", "actorId", "at", "note"]) &&
        ["created", "resolved", "expired"].includes(String(entry.action)) &&
        canonicalId(entry.actorId) &&
        canonicalTimestamp(entry.at) &&
        stringValue(entry.note),
    )
  );
}

function closeValue(value: unknown): boolean {
  return (
    recordValue(value) &&
    exactKeys(
      value,
      [
        "id",
        "projectId",
        "successComparison",
        "outcome",
        "keyLearning",
        "unfinishedDisposition",
        "actorId",
        "closedAt",
      ],
      ["followUpProjectId"],
    ) &&
    canonicalId(value.id) &&
    canonicalId(value.projectId) &&
    stringValue(value.successComparison) &&
    ["achieved", "partial", "invalidated", "abandoned"].includes(
      String(value.outcome),
    ) &&
    stringValue(value.keyLearning) &&
    [
      "discard",
      "return_to_inbox",
      "follow_up_project",
      "historical_incomplete",
    ].includes(String(value.unfinishedDisposition)) &&
    optionalId(value.followUpProjectId) &&
    (value.unfinishedDisposition === "follow_up_project"
      ? canonicalId(value.followUpProjectId)
      : value.followUpProjectId === undefined) &&
    canonicalId(value.actorId) &&
    canonicalTimestamp(value.closedAt)
  );
}

function typedRemoteValue(
  type: SyncConflictRecordType,
  value: JsonValue,
): boolean {
  switch (type) {
    case "bet":
      return betValue(value);
    case "daily_commitment":
      return dailyCommitmentValue(value);
    case "review":
      return reviewValue(value);
    case "exception":
      return exceptionValue(value);
    case "close":
      return closeValue(value);
  }
}

function remoteIdentityMatches(
  recordType: SyncConflictRecordType,
  value: JsonValue,
  recordId: Id,
  projectIds: readonly Id[],
): boolean {
  if (
    !typedRemoteValue(recordType, value) ||
    !recordValue(value) ||
    value.id !== recordId
  ) return false;
  if ("projectId" in value) {
    return (
      typeof value.projectId === "string" &&
      projectIds.includes(value.projectId)
    );
  }
  return true;
}

export function lookupConflictTarget(
  workspace: WorkspaceV2,
  draft: SyncConflictDraft,
): ConflictTargetLookup {
  let matches: unknown[];
  let projectIds: Id[];

  switch (draft.recordType) {
    case "bet": {
      const bets = workspace.bets.filter(({ id }) => id === draft.recordId);
      matches = bets;
      projectIds = uniqueSorted(bets.map(({ projectId }) => projectId));
      break;
    }
    case "daily_commitment": {
      const commitments = workspace.dailyCommitments.filter(
        ({ id }) => id === draft.recordId,
      );
      matches = commitments;
      projectIds = uniqueSorted(
        commitments.flatMap(({ slots }) =>
          slots.flatMap(({ target }) =>
            target.kind === "work_item" ? [target.projectId] : [],
          ),
        ),
      );
      break;
    }
    case "review": {
      const reviews = workspace.reviews.filter(
        ({ id }) => id === draft.recordId,
      );
      matches = reviews;
      projectIds = uniqueSorted(
        reviews.flatMap(({ affectedProjectIds }) => affectedProjectIds),
      );
      break;
    }
    case "exception": {
      const exceptions = workspace.exceptions.filter(
        ({ id }) => id === draft.recordId,
      );
      matches = exceptions;
      projectIds = uniqueSorted(
        exceptions.map(({ projectId }) => projectId),
      );
      break;
    }
    case "close": {
      const decisions = workspace.closeDecisions.filter(
        ({ id }) => id === draft.recordId,
      );
      matches = decisions;
      projectIds = uniqueSorted(
        decisions.map(({ projectId }) => projectId),
      );
      break;
    }
  }

  if (matches.length === 0) return { ok: false, reason: "missing" };
  if (matches.length !== 1) return { ok: false, reason: "duplicate" };
  if (!remoteIdentityMatches(
    draft.recordType,
    draft.remoteValue,
    draft.remoteRecordId ?? draft.recordId,
    projectIds,
  )) {
    return { ok: false, reason: "invalid_remote" };
  }

  return {
    ok: true,
    target: {
      record: structuredClone(matches[0]) as JsonValue,
      projectIds,
      ...(projectIds.length === 1 ? { projectId: projectIds[0] } : {}),
    },
  };
}

export function buildSyncConflictRecord(
  draft: SyncConflictDraft,
  target: ConflictTarget,
  openedAt: ISODate,
): SyncConflictRecord {
  return {
    id: draft.id,
    recordType: draft.recordType,
    recordId: draft.recordId,
    ...(draft.remoteRecordId === undefined
      ? {}
      : { remoteRecordId: draft.remoteRecordId }),
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
    ...(draft.logicalKey === undefined ? {} : { logicalKey: draft.logicalKey }),
    ...(draft.affectedProjectIds === undefined
      ? {}
      : { affectedProjectIds: structuredClone(draft.affectedProjectIds) }),
    ...(draft.affectedRecordIds === undefined
      ? {}
      : { affectedRecordIds: structuredClone(draft.affectedRecordIds) }),
    commonAncestorHash: draft.commonAncestorHash,
    localValue: structuredClone(target.record),
    remoteValue: structuredClone(draft.remoteValue),
    ...(draft.localBundle === undefined
      ? {}
      : { localBundle: structuredClone(draft.localBundle) }),
    ...(draft.remoteBundle === undefined
      ? {}
      : { remoteBundle: structuredClone(draft.remoteBundle) }),
    openedAt,
  };
}

export function replaceConflictTargetWithRemote(
  workspace: WorkspaceV2,
  conflict: SyncConflictRecord,
): WorkspaceV2 | undefined {
  const replacement = structuredClone(conflict.remoteValue) as never;
  switch (conflict.recordType) {
    case "bet": {
      const indexes = workspace.bets
        .map(({ id }, index) => (id === conflict.recordId ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) return undefined;
      const bets = [...workspace.bets];
      bets[indexes[0]] = replacement;
      return { ...workspace, bets };
    }
    case "daily_commitment": {
      const indexes = workspace.dailyCommitments
        .map(({ id }, index) => (id === conflict.recordId ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) return undefined;
      const dailyCommitments = [...workspace.dailyCommitments];
      dailyCommitments[indexes[0]] = replacement;
      return { ...workspace, dailyCommitments };
    }
    case "review": {
      const indexes = workspace.reviews
        .map(({ id }, index) => (id === conflict.recordId ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) return undefined;
      const reviews = [...workspace.reviews];
      reviews[indexes[0]] = replacement;
      return { ...workspace, reviews };
    }
    case "exception": {
      const indexes = workspace.exceptions
        .map(({ id }, index) => (id === conflict.recordId ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) return undefined;
      const exceptions = [...workspace.exceptions];
      exceptions[indexes[0]] = replacement;
      return { ...workspace, exceptions };
    }
    case "close": {
      const indexes = workspace.closeDecisions
        .map(({ id }, index) => (id === conflict.recordId ? index : -1))
        .filter((index) => index >= 0);
      if (indexes.length !== 1) return undefined;
      const closeDecisions = [...workspace.closeDecisions];
      closeDecisions[indexes[0]] = replacement;
      return { ...workspace, closeDecisions };
    }
  }
}
