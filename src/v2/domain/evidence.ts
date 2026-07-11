import type { Id, ISODate } from "@/domain/types";

import type {
  ActualV2,
  ExceptionRecord,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

function timestamp(value: ISODate): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isCanonicalTimestamp(value: ISODate): boolean {
  const parsed = timestamp(value);
  return parsed !== undefined && new Date(parsed).toISOString() === value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasUsableEvidenceFields(
  evidence: WorkspaceV2["evidence"][number],
  evaluatedAt: number,
): boolean {
  return (
    typeof evidence.id === "string" &&
    evidence.id.trim().length > 0 &&
    typeof evidence.summary === "string" &&
    evidence.summary.trim().length > 0 &&
    typeof evidence.projectId === "string" &&
    evidence.projectId.trim().length > 0 &&
    (evidence.workItemId === undefined ||
      (typeof evidence.workItemId === "string" &&
        evidence.workItemId.trim().length > 0)) &&
    isCanonicalTimestamp(evidence.createdAt) &&
    Date.parse(evidence.createdAt) <= evaluatedAt &&
    Number.isFinite(evidence.confidence) &&
    evidence.confidence >= 0 &&
    evidence.confidence <= 1 &&
    Array.isArray(evidence.tags) &&
    evidence.tags.every(
      (tag) =>
        typeof tag === "string" &&
        tag.length > 0 &&
        tag === tag.trim(),
    ) &&
    new Set(evidence.tags).size === evidence.tags.length
  );
}

export function isUsableControlledException(
  record: ExceptionRecord,
): boolean {
  if (
    !isNonBlank(record.id) ||
    !isNonBlank(record.projectId) ||
    !isNonBlank(record.requirementId) ||
    !isNonBlank(record.rationale) ||
    !isNonBlank(record.knownConsequence) ||
    !isNonBlank(record.approvedBy) ||
    !isCanonicalTimestamp(record.createdAt) ||
    !isCanonicalTimestamp(record.reviewAt) ||
    !isCanonicalTimestamp(record.expiresAt)
  ) {
    return false;
  }

  const createdAt = Date.parse(record.createdAt);
  const reviewAt = Date.parse(record.reviewAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (!(createdAt <= reviewAt && reviewAt < expiresAt)) return false;
  if (!Array.isArray(record.history) || record.history.length === 0) {
    return false;
  }
  const historyIsValid = record.history.every(
    (entry) =>
      (entry.action === "created" ||
        entry.action === "resolved" ||
        entry.action === "expired") &&
      isNonBlank(entry.actorId) &&
      isNonBlank(entry.note) &&
      isCanonicalTimestamp(entry.at) &&
      Date.parse(entry.at) >= createdAt,
  );
  if (!historyIsValid) return false;

  const createdEntries = record.history.filter(
    ({ action }) => action === "created",
  );
  if (
    createdEntries.length !== 1 ||
    record.history[0] !== createdEntries[0] ||
    createdEntries[0].actorId !== record.approvedBy ||
    createdEntries[0].at !== record.createdAt
  ) {
    return false;
  }

  const resolvedEntries = record.history.filter(
    ({ action }) => action === "resolved",
  );
  if (record.resolvedAt === undefined) return resolvedEntries.length === 0;
  return (
    isCanonicalTimestamp(record.resolvedAt) &&
    Date.parse(record.resolvedAt) >= createdAt &&
    resolvedEntries.length === 1 &&
    resolvedEntries[0].at === record.resolvedAt
  );
}

export function isConcreteEvidenceRequirement(
  workItem: ProjectWorkItem,
): boolean {
  return workItem.kind === "milestone" && workItem.evidenceRequired === true;
}

export function isExceptionActive(
  record: ExceptionRecord,
  now: ISODate,
): boolean {
  if (!isUsableControlledException(record) || record.resolvedAt !== undefined) {
    return false;
  }
  const createdAt = timestamp(record.createdAt);
  const expiresAt = timestamp(record.expiresAt);
  const evaluatedAt = timestamp(now);
  return (
    createdAt !== undefined &&
    expiresAt !== undefined &&
    evaluatedAt !== undefined &&
    createdAt <= evaluatedAt &&
    evaluatedAt < expiresAt
  );
}

export function requirementStatus(
  workspace: WorkspaceV2,
  projectId: Id,
  requirementId: Id,
  now: ISODate,
):
  | { satisfied: true; via: "evidence" }
  | { satisfied: true; via: "exception"; exceptionId: Id }
  | { satisfied: false; code: "EVIDENCE_REQUIRED" }
  | { satisfied: false; code: "EXCEPTION_EXPIRED"; exceptionId: Id } {
  const requirements = workspace.workItems.filter(
    (item) =>
      item.id === requirementId &&
      item.projectId === projectId &&
      isConcreteEvidenceRequirement(item),
  );
  if (requirements.length !== 1) {
    return { satisfied: false, code: "EVIDENCE_REQUIRED" };
  }

  const evaluatedAt = timestamp(now);
  if (evaluatedAt === undefined) {
    return { satisfied: false, code: "EVIDENCE_REQUIRED" };
  }
  const hasEvidence = workspace.evidence
    .filter(
      (item) =>
        item.projectId === projectId &&
        item.workItemId === requirementId &&
        hasUsableEvidenceFields(item, evaluatedAt),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    ).length > 0;
  if (hasEvidence) return { satisfied: true, via: "evidence" };

  const matchingExceptions = workspace.exceptions
    .filter(
      (item) =>
        item.projectId === projectId &&
        item.requirementId === requirementId &&
        isUsableControlledException(item),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.expiresAt.localeCompare(right.expiresAt) ||
        left.id.localeCompare(right.id),
    );
  const activeException = matchingExceptions.find((item) =>
    isExceptionActive(item, now),
  );
  if (activeException !== undefined) {
    return {
      satisfied: true,
      via: "exception",
      exceptionId: activeException.id,
    };
  }

  const expiredException = matchingExceptions.find((item) => {
    if (item.resolvedAt !== undefined) return false;
    const createdAt = timestamp(item.createdAt);
    const expiresAt = timestamp(item.expiresAt);
    return (
      createdAt !== undefined &&
      expiresAt !== undefined &&
      createdAt <= evaluatedAt &&
      expiresAt <= evaluatedAt
    );
  });
  return expiredException === undefined
    ? { satisfied: false, code: "EVIDENCE_REQUIRED" }
    : {
        satisfied: false,
        code: "EXCEPTION_EXPIRED",
        exceptionId: expiredException.id,
      };
}

export function hasActualEffort(
  workspace: WorkspaceV2,
  target: ActualV2["target"],
  now: ISODate,
): boolean {
  const evaluatedAt = timestamp(now);
  if (evaluatedAt === undefined) return false;
  return workspace.actuals.some(
    (actual) =>
      Number.isSafeInteger(actual.actualWorkSeconds) &&
      actual.actualWorkSeconds > 0 &&
      (timestamp(actual.recordedAt) ?? Number.POSITIVE_INFINITY) <= evaluatedAt &&
      (target.kind === "action"
        ? actual.target.kind === "action" &&
          actual.target.actionId === target.actionId
        : actual.target.kind === "work_item" &&
          actual.target.workItemId === target.workItemId),
  );
}
