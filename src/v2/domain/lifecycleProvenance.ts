import type { Id, ISODate } from "@/domain/types";

import { betIntegrityIssue } from "./betIntegrity";
import { exactCanonicalAppetiteBoundaryHold } from "./close";
import {
  resolveStoredPlanProvenance,
  type ExecutionPlanProvenance,
  type PlanningContextRejection,
} from "./planning";
import { authorizeCommandIdentity } from "./policy";
import { stableHashSync } from "./stableHash";
import type {
  AuditDiff,
  BetVersion,
  CommandReceipt,
  JsonValue,
  ProjectHoldState,
  ProjectV2,
  WorkspaceV2,
} from "./types";

type ValidationPath =
  | "planning_closure"
  | "executing_validation"
  | "planning_boundary"
  | "executing_boundary";

export interface ValidationProvenance {
  ok: true;
  project: ProjectV2;
  bet: BetVersion;
  path: ValidationPath;
  entryReceipt: CommandReceipt;
  execution?: ExecutionPlanProvenance;
}

export type ValidationProvenanceResult =
  | ValidationProvenance
  | PlanningContextRejection;

export interface ClosureProvenance extends ValidationProvenance {
  satisfyReceipt: CommandReceipt;
}

export type ClosureProvenanceResult =
  | ClosureProvenance
  | PlanningContextRejection;

export interface ExpiredBoundaryProvenance {
  ok: true;
  project: ProjectV2;
  bet: BetVersion;
  hold: ProjectHoldState;
  receipt: CommandReceipt;
}

export type ExpiredBoundaryProvenanceResult =
  | ExpiredBoundaryProvenance
  | PlanningContextRejection;

interface StageReceipt {
  receipt: CommandReceipt;
  diff: AuditDiff;
}

function provenanceRejection(
  projectId: Id,
  phase: "validation" | "closure",
  reason: string,
): PlanningContextRejection {
  return {
    ok: false,
    code: "SYNC_CONFLICT",
    reason,
    gate: `project:${projectId}:${phase}_provenance`,
    permittedNextCommand: "resolve_sync_conflict",
  };
}

function canonicalTimestamp(value: string): number | undefined {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    ? milliseconds
    : undefined;
}

function boundaryRejection(
  projectId: Id,
  reason: string,
  conflict: boolean,
): PlanningContextRejection {
  return {
    ok: false,
    code: conflict ? "SYNC_CONFLICT" : "ILLEGAL_LIFECYCLE_TRANSITION",
    reason,
    gate: `project:${projectId}:appetite_boundary`,
    permittedNextCommand: conflict
      ? "resolve_sync_conflict"
      : "record_bet_boundary",
  };
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return stableHashSync(left) === stableHashSync(right);
}

function jsonArrayContains(
  value: JsonValue,
  expected: JsonValue,
): boolean {
  return Array.isArray(value) && value.some((item) => sameJson(item, expected));
}

function boundaryReceiptIssue(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  hold: ProjectHoldState,
  receipt: CommandReceipt,
  now: ISODate,
): string | undefined {
  const expectedPayload = {
    type: "record_bet_boundary",
    projectId: project.id,
    boundary: "expired",
    triggerKey: `${bet.id}:expired`,
  } as const;
  const createdAt = canonicalTimestamp(receipt.createdAt);
  const appetiteEnd = canonicalTimestamp(bet.appetiteEnd);
  const evaluatedAt = canonicalTimestamp(now);
  if (
    receipt.status !== "applied" ||
    receipt.id !== receipt.commandId ||
    receipt.commandType !== "record_bet_boundary" ||
    receipt.actorKind !== "system" ||
    receipt.actorId.trim().length === 0 ||
    receipt.baseRevision < 0 ||
    receipt.revision !== receipt.baseRevision + 1 ||
    receipt.revision > workspace.revision ||
    !receipt.source.verified ||
    !receipt.source.capabilities.includes("system_time") ||
    createdAt === undefined ||
    appetiteEnd === undefined ||
    evaluatedAt === undefined ||
    createdAt < appetiteEnd ||
    createdAt > evaluatedAt ||
    hold.createdAt !== receipt.createdAt
  ) {
    return `Expired-boundary receipt ${receipt.id} is not an exact applied system authority record.`;
  }
  const authorityIssue = authorizeCommandIdentity("record_bet_boundary", {
    actorKind: receipt.actorKind,
    origin: receipt.origin,
    source: receipt.source,
    workspaceRevision: receipt.baseRevision,
    projectHolds: [],
  });
  if (authorityIssue !== undefined) {
    return `Expired-boundary receipt ${receipt.id} has impossible command authority: ${authorityIssue.reason}`;
  }
  const { receiptHash, ...receiptBase } = receipt;
  if (
    receiptHash !== stableHashSync(receiptBase as unknown as JsonValue) ||
    receipt.payloadHash !== stableHashSync(expectedPayload as unknown as JsonValue)
  ) {
    return `Expired-boundary receipt ${receipt.id} has an invalid payload or receipt hash.`;
  }

  const targetDiffs = receipt.diff.filter(
    ({ entity, entityId }) =>
      entity === "ProjectV2" && entityId === project.id,
  );
  if (
    targetDiffs.length !== receipt.diff.length ||
    targetDiffs.some(
      ({ field }) =>
        field !== "holds" && field !== "stage" && field !== "updatedAt",
    )
  ) {
    return `Expired-boundary receipt ${receipt.id} records effects outside its exact Project boundary mutation.`;
  }
  const holdsDiffs = targetDiffs.filter(({ field }) => field === "holds");
  const holdsDiff = holdsDiffs[0];
  if (
    holdsDiffs.length !== 1 ||
    holdsDiff === undefined ||
    !Array.isArray(holdsDiff.before) ||
    !Array.isArray(holdsDiff.after)
  ) {
    return `Expired-boundary receipt ${receipt.id} does not create one exact Project hold.`;
  }
  const expectedHold = hold as unknown as JsonValue;
  const expectedAfter = [
    ...holdsDiff.before.filter(
      (candidate) =>
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        candidate.type !== "rebet_required",
    ),
    expectedHold,
  ] as JsonValue;
  if (
    !sameJson(holdsDiff.after, expectedAfter) ||
    !jsonArrayContains(holdsDiff.after, expectedHold)
  ) {
    return `Expired-boundary receipt ${receipt.id} does not record the exact canonical hold effect.`;
  }
  const stageDiffs = targetDiffs.filter(({ field }) => field === "stage");
  if (
    stageDiffs.length > 1 ||
    (stageDiffs.length === 1 &&
      ((stageDiffs[0].before !== "planning" &&
        stageDiffs[0].before !== "executing") ||
        stageDiffs[0].after !== "validating"))
  ) {
    return `Expired-boundary receipt ${receipt.id} has an invalid lifecycle effect.`;
  }
  const updatedAtDiffs = targetDiffs.filter(({ field }) => field === "updatedAt");
  if (
    updatedAtDiffs.length > 1 ||
    (updatedAtDiffs.length === 1 &&
      updatedAtDiffs[0].after !== receipt.createdAt)
  ) {
    return `Expired-boundary receipt ${receipt.id} does not bind the Project update to its authoritative time.`;
  }
  return undefined;
}

function exactCurrentBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
  now: ISODate,
  phase: "validation" | "closure",
): BetVersion | PlanningContextRejection {
  const matches = workspace.bets.filter(({ id }) => id === project.activeBetId);
  const bet = matches[0];
  const sameProjectCurrent = workspace.bets.filter(
    ({ projectId, invalidatedAt }) =>
      projectId === project.id && invalidatedAt === undefined,
  );
  if (
    matches.length !== 1 ||
    bet === undefined ||
    bet.projectId !== project.id ||
    bet.invalidatedAt !== undefined ||
    sameProjectCurrent.length !== 1 ||
    sameProjectCurrent[0] !== bet
  ) {
    return provenanceRejection(
      project.id,
      phase,
      `Project ${project.id} does not resolve to one exact current Bet for ${phase}.`,
    );
  }
  const issue = betIntegrityIssue(bet, now);
  return issue === undefined
    ? bet
    : provenanceRejection(project.id, phase, issue);
}

/**
 * Resolves the one system receipt that created the retained appetite-expiry
 * hold. This covers both stage-changing expiry and expiry recorded after a
 * Project had already entered validation.
 */
export function resolveExpiredBoundaryProvenance(
  workspace: WorkspaceV2,
  projectId: Id,
  now: ISODate,
): ExpiredBoundaryProvenanceResult {
  const projectMatches = workspace.projects.filter(({ id }) => id === projectId);
  const project = projectMatches[0];
  if (projectMatches.length !== 1 || project === undefined) {
    return boundaryRejection(
      projectId,
      projectMatches.length === 0
        ? `Project ${projectId} does not exist for its appetite boundary.`
        : `Project ${projectId} has duplicate records for its appetite boundary.`,
      true,
    );
  }
  const betMatches = workspace.bets.filter(({ id }) => id === project.activeBetId);
  const bet = betMatches[0];
  const sameProjectCurrent = workspace.bets.filter(
    ({ projectId: ownerId, invalidatedAt }) =>
      ownerId === project.id && invalidatedAt === undefined,
  );
  if (
    betMatches.length !== 1 ||
    bet === undefined ||
    bet.projectId !== project.id ||
    bet.invalidatedAt !== undefined ||
    sameProjectCurrent.length !== 1 ||
    sameProjectCurrent[0] !== bet
  ) {
    return boundaryRejection(
      project.id,
      `Project ${project.id} does not resolve to one exact current Bet for its appetite boundary.`,
      true,
    );
  }
  const integrityIssue = betIntegrityIssue(bet, now);
  if (integrityIssue !== undefined) {
    return boundaryRejection(project.id, integrityIssue, true);
  }
  const appetiteEnd = canonicalTimestamp(bet.appetiteEnd);
  const evaluatedAt = canonicalTimestamp(now);
  if (
    appetiteEnd === undefined ||
    evaluatedAt === undefined ||
    evaluatedAt < appetiteEnd
  ) {
    return boundaryRejection(
      project.id,
      `Project ${project.id} has not reached its exact Bet appetite boundary.`,
      false,
    );
  }

  const expectedPayloadHash = stableHashSync({
    type: "record_bet_boundary",
    projectId: project.id,
    boundary: "expired",
    triggerKey: `${bet.id}:expired`,
  } as unknown as JsonValue);
  const hold = exactCanonicalAppetiteBoundaryHold(project, bet, now);
  const expectedHold = hold as unknown as JsonValue | undefined;
  const relatedReceipts = workspace.commandReceipts.filter((receipt) => {
    if (receipt.commandType !== "record_bet_boundary") return false;
    if (receipt.payloadHash === expectedPayloadHash) return true;
    return expectedHold !== undefined && receipt.diff.some(
      ({ entity, entityId, field, after }) =>
        entity === "ProjectV2" &&
        entityId === project.id &&
        field === "holds" &&
        jsonArrayContains(after, expectedHold),
    );
  });

  if (hold === undefined) {
    const boundaryShapedHold = project.holds.some(
      ({ type, sourceId }) =>
        type === "rebet_required" && sourceId === bet.id,
    );
    return boundaryRejection(
      project.id,
      relatedReceipts.length > 0 || boundaryShapedHold
        ? `Project ${project.id} has conflicting appetite-boundary receipt or hold records.`
        : `Project ${project.id} must record its exact Bet appetite boundary before continuing.`,
      relatedReceipts.length > 0 || boundaryShapedHold,
    );
  }

  const creationReceipts = relatedReceipts.filter((receipt) =>
    receipt.diff.some(
      ({ entity, entityId, field, after }) =>
        entity === "ProjectV2" &&
        entityId === project.id &&
        field === "holds" &&
        jsonArrayContains(after, hold as unknown as JsonValue),
    ),
  );
  const receipt = creationReceipts[0];
  if (creationReceipts.length !== 1 || receipt === undefined) {
    return boundaryRejection(
      project.id,
      `Project ${project.id} does not have one exact receipt that created its retained appetite-boundary hold.`,
      true,
    );
  }
  const issue = boundaryReceiptIssue(
    workspace,
    project,
    bet,
    hold,
    receipt,
    now,
  );
  if (issue !== undefined) {
    return boundaryRejection(project.id, issue, true);
  }
  return { ok: true, project, bet, hold, receipt };
}

function stageReceipts(
  workspace: WorkspaceV2,
  projectId: Id,
  beforeRevision = Number.POSITIVE_INFINITY,
): StageReceipt[] {
  return workspace.commandReceipts
    .flatMap((receipt) =>
      receipt.revision >= beforeRevision
        ? []
        : receipt.diff
            .filter(
              ({ entity, entityId, field }) =>
                entity === "ProjectV2" &&
                entityId === projectId &&
                field === "stage",
            )
            .map((diff) => ({ receipt, diff })),
    )
    .sort(
      (left, right) =>
        right.receipt.revision - left.receipt.revision ||
        right.receipt.baseRevision - left.receipt.baseRevision ||
        left.receipt.id.localeCompare(right.receipt.id),
    );
}

function latestStageReceipt(
  workspace: WorkspaceV2,
  projectId: Id,
  phase: "validation" | "closure",
  beforeRevision = Number.POSITIVE_INFINITY,
): StageReceipt | PlanningContextRejection {
  const transitions = stageReceipts(workspace, projectId, beforeRevision);
  const latest = transitions[0];
  if (latest === undefined) {
    return provenanceRejection(
      projectId,
      phase,
      `Project ${projectId} has no applied lifecycle receipt for its current ${phase} stage.`,
    );
  }
  const sameRevision = transitions.filter(
    ({ receipt }) => receipt.revision === latest.receipt.revision,
  );
  const receiptStageDiffs = latest.receipt.diff.filter(
    ({ entity, entityId, field }) =>
      entity === "ProjectV2" &&
      entityId === projectId &&
      field === "stage",
  );
  if (sameRevision.length !== 1 || receiptStageDiffs.length !== 1) {
    return provenanceRejection(
      projectId,
      phase,
      `Project ${projectId} lifecycle receipts are ambiguous at revision ${latest.receipt.revision}.`,
    );
  }
  return latest;
}

function commonReceiptIssue(
  workspace: WorkspaceV2,
  receipt: CommandReceipt,
  projectId: Id,
  commandType: "request_validation" | "record_bet_boundary" | "satisfy_validation",
  expectedPayload: JsonValue,
  expectedBefore: "planning" | "executing" | "validating",
  expectedAfter: "validating" | "closing",
  actorKind: "human" | "system",
  capability: "human_decision" | "system_time",
): string | undefined {
  if (
    receipt.status !== "applied" ||
    receipt.id !== receipt.commandId ||
    receipt.commandType !== commandType ||
    receipt.actorKind !== actorKind ||
    receipt.actorId.trim().length === 0 ||
    receipt.baseRevision < 0 ||
    receipt.revision !== receipt.baseRevision + 1 ||
    receipt.revision > workspace.revision ||
    !receipt.source.verified ||
    !receipt.source.capabilities.includes(capability) ||
    canonicalTimestamp(receipt.createdAt) === undefined
  ) {
    return `Lifecycle receipt ${receipt.id} is not an exact applied ${commandType} authority record.`;
  }
  const authorityIssue = authorizeCommandIdentity(commandType, {
    actorKind: receipt.actorKind,
    origin: receipt.origin,
    source: receipt.source,
    workspaceRevision: receipt.baseRevision,
    projectHolds: [],
  });
  if (authorityIssue !== undefined) {
    return `Lifecycle receipt ${receipt.id} has impossible command authority: ${authorityIssue.reason}`;
  }
  const { receiptHash, ...receiptBase } = receipt;
  if (
    receiptHash !== stableHashSync(receiptBase as unknown as JsonValue) ||
    receipt.payloadHash !== stableHashSync(expectedPayload)
  ) {
    return `Lifecycle receipt ${receipt.id} has an invalid payload or receipt hash.`;
  }
  const stageDiffs = receipt.diff.filter(
    ({ entity, entityId, field }) =>
      entity === "ProjectV2" &&
      entityId === projectId &&
      field === "stage",
  );
  if (
    stageDiffs.length !== 1 ||
    stageDiffs[0].before !== expectedBefore ||
    stageDiffs[0].after !== expectedAfter
  ) {
    return `Lifecycle receipt ${receipt.id} does not record ${expectedBefore} to ${expectedAfter} for Project ${projectId}.`;
  }
  const updatedAtDiffs = receipt.diff.filter(
    ({ entity, entityId, field }) =>
      entity === "ProjectV2" &&
      entityId === projectId &&
      field === "updatedAt",
  );
  if (
    updatedAtDiffs.length > 1 ||
    (updatedAtDiffs.length === 1 &&
      updatedAtDiffs[0].after !== receipt.createdAt)
  ) {
    return `Lifecycle receipt ${receipt.id} does not bind the Project update to its authoritative time.`;
  }
  return undefined;
}

function validateEntryReceipt(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  entry: StageReceipt,
  now: ISODate,
  phase: "validation" | "closure",
): ValidationProvenanceResult {
  const before = entry.diff.before;
  if (before !== "planning" && before !== "executing") {
    return provenanceRejection(
      project.id,
      phase,
      `Project ${project.id} entered validation from an unsupported lifecycle stage.`,
    );
  }
  const isBoundary = entry.receipt.commandType === "record_bet_boundary";
  const expectedPayload = isBoundary
    ? {
        type: "record_bet_boundary",
        projectId: project.id,
        boundary: "expired",
        triggerKey: `${bet.id}:expired`,
      }
    : { type: "request_validation", projectId: project.id };
  const issue = commonReceiptIssue(
    workspace,
    entry.receipt,
    project.id,
    isBoundary ? "record_bet_boundary" : "request_validation",
    expectedPayload as JsonValue,
    before,
    "validating",
    isBoundary ? "system" : "human",
    isBoundary ? "system_time" : "human_decision",
  );
  if (issue !== undefined) {
    return provenanceRejection(project.id, phase, issue);
  }
  const transitionTime = canonicalTimestamp(entry.receipt.createdAt);
  const appetiteEnd = canonicalTimestamp(bet.appetiteEnd);
  const evaluationTime = canonicalTimestamp(now);
  if (
    transitionTime === undefined ||
    appetiteEnd === undefined ||
    evaluationTime === undefined ||
    transitionTime > evaluationTime ||
    (isBoundary ? transitionTime < appetiteEnd : transitionTime >= appetiteEnd)
  ) {
    return provenanceRejection(
      project.id,
      phase,
      `Lifecycle receipt ${entry.receipt.id} is outside the authoritative Bet time boundary.`,
    );
  }
  if (isBoundary) {
    const holds = project.holds.filter(
      ({ type, sourceId }) =>
        type === "rebet_required" && sourceId === bet.id,
    );
    const affected = holds[0]?.affectedRecordIds ?? [];
    if (
      holds.length !== 1 ||
      holds[0].createdAt !== entry.receipt.createdAt ||
      affected.length !== 2 ||
      new Set(affected).size !== 2 ||
      !affected.includes(project.id) ||
      !affected.includes(bet.id)
    ) {
      return provenanceRejection(
        project.id,
        phase,
        `Project ${project.id} does not retain the exact hold created by its appetite-expiry receipt.`,
      );
    }
  }
  if (before === "planning") {
    const currentBetPlans = workspace.planVersions.filter(
      ({ projectId, betId }) => projectId === project.id && betId === bet.id,
    );
    if (
      project.activePlanVersionId !== undefined ||
      currentBetPlans.length !== 0
    ) {
      return provenanceRejection(
        project.id,
        phase,
        `Project ${project.id} claims a planning-origin validation path while retaining a current-Bet Plan.`,
      );
    }
    return {
      ok: true,
      project,
      bet,
      path: isBoundary ? "planning_boundary" : "planning_closure",
      entryReceipt: entry.receipt,
    };
  }
  const execution = resolveStoredPlanProvenance(workspace, project.id, now);
  if (!execution.ok) return execution;
  return {
    ok: true,
    project,
    bet,
    path: isBoundary ? "executing_boundary" : "executing_validation",
    entryReceipt: entry.receipt,
    execution,
  };
}

export function resolveValidationProvenance(
  workspace: WorkspaceV2,
  projectId: Id,
  now: ISODate,
): ValidationProvenanceResult {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  const project = projects[0];
  if (projects.length !== 1 || project === undefined) {
    return provenanceRejection(
      projectId,
      "validation",
      projects.length === 0
        ? `Project ${projectId} does not exist.`
        : `Project ${projectId} has duplicate records for one identity.`,
    );
  }
  if (project.stage !== "validating") {
    return provenanceRejection(
      project.id,
      "validation",
      `Project ${project.id} is not currently validating.`,
    );
  }
  const bet = exactCurrentBet(workspace, project, now, "validation");
  if (!("id" in bet)) return bet;
  const entry = latestStageReceipt(
    workspace,
    project.id,
    "validation",
  );
  if (!("receipt" in entry)) return entry;
  if (entry.diff.after !== "validating") {
    return provenanceRejection(
      project.id,
      "validation",
      `Project ${project.id} current stage is not backed by its latest lifecycle receipt.`,
    );
  }
  return validateEntryReceipt(
    workspace,
    project,
    bet,
    entry,
    now,
    "validation",
  );
}

export function resolveClosureProvenance(
  workspace: WorkspaceV2,
  projectId: Id,
  now: ISODate,
): ClosureProvenanceResult {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  const project = projects[0];
  if (projects.length !== 1 || project === undefined) {
    return provenanceRejection(
      projectId,
      "closure",
      projects.length === 0
        ? `Project ${projectId} does not exist.`
        : `Project ${projectId} has duplicate records for one identity.`,
    );
  }
  if (project.stage !== "closing") {
    return provenanceRejection(
      project.id,
      "closure",
      `Project ${project.id} is not currently closing.`,
    );
  }
  const bet = exactCurrentBet(workspace, project, now, "closure");
  if (!("id" in bet)) return bet;
  const closing = latestStageReceipt(workspace, project.id, "closure");
  if (!("receipt" in closing)) return closing;
  if (closing.diff.before !== "validating" || closing.diff.after !== "closing") {
    return provenanceRejection(
      project.id,
      "closure",
      `Project ${project.id} current Close stage is not backed by validation satisfaction.`,
    );
  }
  const satisfyIssue = commonReceiptIssue(
    workspace,
    closing.receipt,
    project.id,
    "satisfy_validation",
    { type: "satisfy_validation", projectId: project.id },
    "validating",
    "closing",
    "human",
    "human_decision",
  );
  if (satisfyIssue !== undefined) {
    return provenanceRejection(project.id, "closure", satisfyIssue);
  }
  const entry = latestStageReceipt(
    workspace,
    project.id,
    "closure",
    closing.receipt.revision,
  );
  if (!("receipt" in entry)) return entry;
  if (
    entry.diff.after !== "validating" ||
    entry.receipt.revision > closing.receipt.baseRevision ||
    Date.parse(entry.receipt.createdAt) > Date.parse(closing.receipt.createdAt)
  ) {
    return provenanceRejection(
      project.id,
      "closure",
      `Project ${project.id} validation receipt does not precede its satisfaction receipt.`,
    );
  }
  const validation = validateEntryReceipt(
    workspace,
    project,
    bet,
    entry,
    now,
    "closure",
  );
  if (!validation.ok) return validation;
  const hasCurrentBetRebetHold = project.holds.some(
    ({ type, sourceId }) =>
      type === "rebet_required" && sourceId === bet.id,
  );
  if (
    hasCurrentBetRebetHold ||
    Date.parse(closing.receipt.createdAt) >= Date.parse(bet.appetiteEnd)
  ) {
    const boundary = resolveExpiredBoundaryProvenance(
      workspace,
      project.id,
      now,
    );
    if (!boundary.ok) return boundary;
  }
  return {
    ...validation,
    satisfyReceipt: closing.receipt,
  };
}
