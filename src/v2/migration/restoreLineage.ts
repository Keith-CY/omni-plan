import { canonicalJson } from "../../domain/canonical";
import type {
  AuditDiff,
  CommandReceipt,
  JsonValue,
  WorkspaceV2,
} from "../domain/types";
import { assertWorkspaceV2Schema } from "../repositories/workspaceBackupSchema";

const collectionByEntity = {
  InboxItem: "inboxItems",
  Action: "actions",
  ProjectV2: "projects",
  DirectionBrief: "directionBriefs",
  BetVersion: "bets",
  PlanVersion: "planVersions",
  DailyCommitment: "dailyCommitments",
  ReplanProposal: "replanProposals",
  ReviewRecord: "reviews",
  ExceptionRecord: "exceptions",
  CloseDecision: "closeDecisions",
  CommandProposal: "commandProposals",
  SyncConflictRecord: "syncConflicts",
  ProjectWorkItem: "workItems",
  ProjectDependency: "dependencies",
  Resource: "resources",
  Baseline: "baselines",
  Evidence: "evidence",
  ActualV2: "actuals",
  LegacyAuditRecord: "legacyAuditRecords",
} as const;

type EntityName = keyof typeof collectionByEntity;
type IdentityCollection = (typeof collectionByEntity)[EntityName];

const identityCollections = Object.values(
  collectionByEntity,
) as IdentityCollection[];
const allowedWorkspaceFields = new Set(["capacityProfile", "visibility"]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function plainRecord(value: unknown): value is Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedField(
  value: Record<string, unknown>,
  field: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(value, field)
    ? value[field]
    : null;
}

function diffComparator(left: AuditDiff, right: AuditDiff): number {
  return (
    compareText(left.entity, right.entity) ||
    compareText(left.entityId, right.entityId) ||
    compareText(left.field, right.field) ||
    compareText(canonicalJson(left.before), canonicalJson(right.before)) ||
    compareText(canonicalJson(left.after), canonicalJson(right.after))
  );
}

function hasCanonicalDiffOrder(diffs: readonly AuditDiff[]): boolean {
  const sorted = [...diffs].sort(diffComparator);
  return canonicalJson(sorted) === canonicalJson(diffs);
}

function uniqueEntity(
  workspace: WorkspaceV2,
  collection: IdentityCollection,
  entityId: string,
): { entity: Record<string, unknown>; index: number } | undefined {
  const values = workspace[collection] as unknown as Array<
    Record<string, unknown>
  >;
  const matches = values.flatMap((entity, index) =>
    entity?.id === entityId ? [{ entity, index }] : [],
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function preflightDiff(workspace: WorkspaceV2, diff: AuditDiff): boolean {
  if (diff.entity === "WorkspaceV2") {
    if (
      diff.entityId !== workspace.workspaceId ||
      !allowedWorkspaceFields.has(diff.field)
    ) {
      return false;
    }
    return sameValue(
      normalizedField(
        workspace as unknown as Record<string, unknown>,
        diff.field,
      ),
      diff.before,
    );
  }

  const collection = collectionByEntity[diff.entity as EntityName];
  if (collection === undefined) return false;
  const values = workspace[collection] as unknown as Array<
    Record<string, unknown>
  >;
  const matchingCount = values.filter(({ id }) => id === diff.entityId).length;
  const selected = uniqueEntity(workspace, collection, diff.entityId);
  if (diff.field === "created") {
    return (
      diff.before === null &&
      matchingCount === 0 &&
      plainRecord(diff.after) &&
      diff.after.id === diff.entityId
    );
  }
  if (diff.field === "deleted") {
    return (
      diff.after === null &&
      selected !== undefined &&
      sameValue(selected.entity, diff.before)
    );
  }
  return (
    diff.field !== "id" &&
    selected !== undefined &&
    sameValue(normalizedField(selected.entity, diff.field), diff.before)
  );
}

function applyDiff(workspace: WorkspaceV2, diff: AuditDiff): void {
  if (diff.entity === "WorkspaceV2") {
    const target = workspace as unknown as Record<string, unknown>;
    if (diff.after === null) delete target[diff.field];
    else target[diff.field] = structuredClone(diff.after);
    return;
  }

  const collection = collectionByEntity[diff.entity as EntityName]!;
  const values = workspace[collection] as unknown as Array<
    Record<string, unknown>
  >;
  if (diff.field === "created") {
    values.push(structuredClone(diff.after) as Record<string, unknown>);
    return;
  }
  const selected = uniqueEntity(workspace, collection, diff.entityId)!;
  if (diff.field === "deleted") {
    values.splice(selected.index, 1);
    return;
  }
  if (diff.after === null) delete selected.entity[diff.field];
  else selected.entity[diff.field] = structuredClone(diff.after);
}

function receiptDiffIsAtomic(receipt: Readonly<CommandReceipt>): boolean {
  const identities = new Set<string>();
  const modes = new Map<string, "whole" | "fields">();
  for (const diff of receipt.diff) {
    const identity = JSON.stringify([diff.entity, diff.entityId, diff.field]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    const entityIdentity = JSON.stringify([diff.entity, diff.entityId]);
    const mode =
      diff.field === "created" || diff.field === "deleted" ? "whole" : "fields";
    const previous = modes.get(entityIdentity);
    if (previous !== undefined && previous !== mode) return false;
    modes.set(entityIdentity, mode);
  }
  return true;
}

function replayReceipt(
  workspace: WorkspaceV2,
  receipt: Readonly<CommandReceipt>,
): WorkspaceV2 | undefined {
  if (
    receipt.status !== "applied" ||
    receipt.baseRevision !== workspace.revision ||
    receipt.revision !== workspace.revision + 1 ||
    !hasCanonicalDiffOrder(receipt.diff) ||
    !receiptDiffIsAtomic(receipt) ||
    !receipt.diff.every((diff) => preflightDiff(workspace, diff))
  ) {
    return undefined;
  }
  try {
    const next = structuredClone(workspace);
    for (const diff of receipt.diff) applyDiff(next, diff);
    next.revision = receipt.revision;
    next.commandReceipts.push(structuredClone(receipt));

    const canonicalNext: unknown = JSON.parse(canonicalJson(next));
    assertWorkspaceV2Schema(canonicalNext);
    return canonicalNext;
  } catch {
    return undefined;
  }
}

function lineageProjection(workspace: Readonly<WorkspaceV2>): WorkspaceV2 {
  const projected = structuredClone(workspace);
  for (const collection of identityCollections) {
    const values = projected[collection] as unknown as Array<{
      id: string;
      [key: string]: unknown;
    }>;
    values.sort(
      (left, right) =>
        compareText(left.id, right.id) ||
        compareText(canonicalJson(left), canonicalJson(right)),
    );
  }
  return projected;
}

function recordCreatedIds(
  receipt: Readonly<CommandReceipt>,
  createdIdsByCollection: Map<IdentityCollection, Set<string>>,
): void {
  for (const diff of receipt.diff) {
    if (diff.field !== "created" || diff.entity === "WorkspaceV2") continue;
    const collection = collectionByEntity[diff.entity as EntityName];
    if (collection === undefined) continue;
    const createdIds =
      createdIdsByCollection.get(collection) ?? new Set<string>();
    createdIds.add(diff.entityId);
    createdIdsByCollection.set(collection, createdIds);
  }
}

function collectionOrderIsConsistent(
  replayed: Readonly<WorkspaceV2>,
  target: Readonly<WorkspaceV2>,
  createdIdsByCollection: ReadonlyMap<IdentityCollection, ReadonlySet<string>>,
): boolean {
  for (const collection of identityCollections) {
    const replayedValues = replayed[collection] as unknown as ReadonlyArray<{
      id: string;
    }>;
    const targetValues = target[collection] as unknown as ReadonlyArray<{
      id: string;
    }>;
    const createdIds = createdIdsByCollection.get(collection);
    if (createdIds === undefined || createdIds.size === 0) {
      if (canonicalJson(replayedValues) !== canonicalJson(targetValues)) {
        return false;
      }
      continue;
    }

    const replayedSurvivorIds = replayedValues
      .filter(({ id }) => !createdIds.has(id))
      .map(({ id }) => id);
    const targetSurvivorIds = targetValues
      .filter(({ id }) => !createdIds.has(id))
      .map(({ id }) => id);
    if (
      canonicalJson(replayedSurvivorIds) !== canonicalJson(targetSurvivorIds)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Proves that a migrated restore is the exact deterministic migration output,
 * optionally followed by a complete, contiguous applied-receipt diff chain.
 * AuditDiff does not encode a created entity's array insertion index. Created
 * entities may therefore move among existing survivors, but every collection
 * without a create keeps exact order and all pre-existing survivors keep their
 * relative order in collections that do contain creates.
 */
export function migratedWorkspaceDescendsFromBaseline(
  baseline: Readonly<WorkspaceV2>,
  target: Readonly<WorkspaceV2>,
): boolean {
  if (
    baseline.revision !== 0 ||
    baseline.commandReceipts.length !== 0 ||
    baseline.workspaceId !== target.workspaceId ||
    target.revision !== target.commandReceipts.length
  ) {
    return false;
  }
  if (target.revision === 0) {
    return canonicalJson(baseline) === canonicalJson(target);
  }

  let replayed = structuredClone(baseline);
  const createdIdsByCollection = new Map<IdentityCollection, Set<string>>();
  for (const receipt of target.commandReceipts) {
    const next = replayReceipt(replayed, receipt);
    if (next === undefined) return false;
    replayed = next;
    recordCreatedIds(receipt, createdIdsByCollection);
  }
  return (
    canonicalJson(lineageProjection(replayed)) ===
      canonicalJson(lineageProjection(target)) &&
    collectionOrderIsConsistent(replayed, target, createdIdsByCollection)
  );
}
