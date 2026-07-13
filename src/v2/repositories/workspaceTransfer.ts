import type { ISODate } from "@/domain/types";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  isKnownV2CommandType,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import { stableHash } from "../domain/stableHash";
import { validateWorkspaceInvariants } from "../domain/invariants";
import type {
  CommandReceipt,
  JsonValue,
  MigrationRecord,
  SyncConflictRecord,
  WorkspaceV2,
} from "../domain/types";
import type {
  AtomicWorkspaceRepository,
  VerifiedBackupRecord,
  WorkspaceTransferRepository,
} from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import {
  ImportOriginAdapter,
  isPortableImportCommandType,
} from "./originAdapters";
import { isExactSystemCasRetryOverlap } from "./receiptOwnership";
import {
  validateProtectedEffectBundlePair,
  validateProtectedEffectBundlePairMetadata,
} from "./syncConflictBundles";
import {
  assertWorkspaceV2Schema,
  WorkspaceBackupSchemaError,
} from "./workspaceBackupSchema";

export const V2_BACKUP_FORMAT = "omniplan-v2-backup" as const;
export const V2_PORTABLE_COMMANDS_FORMAT =
  "omniplan-v2-portable-commands" as const;

export interface WorkspaceBackupV2 {
  schemaVersion: 2;
  format: typeof V2_BACKUP_FORMAT;
  exportedAt: ISODate;
  workspace: WorkspaceV2;
  rejectedReceipts: CommandReceipt[];
  workspaceHash: string;
  receiptLedgerHash: string;
  backupChecksum: string;
}

export interface WorkspaceTransferSnapshot {
  workspace: WorkspaceV2;
  rejectedReceipts: CommandReceipt[];
}

export interface WorkspaceRestoreCheckpoint extends WorkspaceTransferSnapshot {
  migrationRuns: MigrationRecord[];
  migrationRecoveryRecord: JsonValue | null;
  outboxEntries: JsonValue[];
}

export type WorkspaceTransferErrorCode =
  | "WORKSPACE_NOT_READY"
  | "BACKUP_INVALID"
  | "PORTABLE_IMPORT_INVALID"
  | "PORTABLE_IMPORT_CONFLICT";

export class WorkspaceTransferError extends Error {
  constructor(
    readonly code: WorkspaceTransferErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkspaceTransferError";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  try {
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    return (
      required.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key),
      ) &&
      keys.every((key) => {
        if (typeof key !== "string" || !allowed.has(key)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return (
          descriptor !== undefined &&
          descriptor.enumerable &&
          "value" in descriptor
        );
      })
    );
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  try {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function canonicalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim()
  );
}

type CanonicalTransferErrorCode = Extract<
  WorkspaceTransferErrorCode,
  "BACKUP_INVALID" | "PORTABLE_IMPORT_INVALID"
>;

interface JsonRuntimeValidationOptions {
  errorCode: CanonicalTransferErrorCode;
  allowedUndefinedPaths: readonly (readonly (string | number)[])[];
  segments: readonly (string | number)[];
  ancestors: Set<object>;
}

function samePath(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function invalidRuntimeGraph(
  errorCode: CanonicalTransferErrorCode,
  path: string,
  message: string,
  cause?: unknown,
): WorkspaceTransferError {
  return new WorkspaceTransferError(errorCode, `${path} ${message}`, cause);
}

function snapshotRequestFields(
  value: unknown,
  fields: readonly string[],
  errorCode: CanonicalTransferErrorCode,
  message: string,
): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw new TypeError("Request envelope is not a plain object.");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    ) {
      throw new TypeError("Request envelope fields are not exact.");
    }
    const snapshot: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError(`Request field ${field} is not a data field.`);
      }
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    throw new WorkspaceTransferError(errorCode, message, error);
  }
}

function assertJsonSafe(
  value: unknown,
  path = "value",
  options: Partial<JsonRuntimeValidationOptions> = {},
): asserts value is JsonValue {
  const errorCode = options.errorCode ?? "BACKUP_INVALID";
  const allowedUndefinedPaths = options.allowedUndefinedPaths ?? [];
  const segments = options.segments ?? [];
  const ancestors = options.ancestors ?? new Set<object>();
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw invalidRuntimeGraph(
        errorCode,
        path,
        "contains a non-canonical number.",
      );
    }
    return;
  }
  if (value === undefined) {
    if (
      allowedUndefinedPaths.some((allowedPath) =>
        samePath(allowedPath, segments),
      )
    ) {
      return;
    }
    throw invalidRuntimeGraph(errorCode, path, "contains undefined.");
  }
  if (value === null || typeof value !== "object") {
    throw invalidRuntimeGraph(errorCode, path, "is not canonical JSON.");
  }
  if (ancestors.has(value)) {
    throw invalidRuntimeGraph(errorCode, path, "contains an ancestor cycle.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalidRuntimeGraph(errorCode, path, "must use Array.prototype.");
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0
      ) {
        throw invalidRuntimeGraph(errorCode, path, "has an invalid length.");
      }
      const length = lengthDescriptor.value as number;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || !keys.includes("length")) {
        throw invalidRuntimeGraph(errorCode, path, "must be a dense array.");
      }
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string") {
          throw invalidRuntimeGraph(
            errorCode,
            path,
            "contains a non-index own key.",
          );
        }
        const index = Number(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== key ||
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw invalidRuntimeGraph(
            errorCode,
            `${path}.${key}`,
            "is not a canonical array entry.",
          );
        }
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw invalidRuntimeGraph(errorCode, path, "must be a dense array.");
        }
        assertJsonSafe(descriptor.value, `${path}[${index}]`, {
          errorCode,
          allowedUndefinedPaths,
          segments: [...segments, index],
          ancestors,
        });
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw invalidRuntimeGraph(errorCode, path, "must be a plain object.");
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw invalidRuntimeGraph(
          errorCode,
          path,
          "contains a non-string own key.",
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw invalidRuntimeGraph(
          errorCode,
          `${path}.${key}`,
          "must be an enumerable data field.",
        );
      }
      assertJsonSafe(descriptor.value, `${path}.${key}`, {
        errorCode,
        allowedUndefinedPaths,
        segments: [...segments, key],
        ancestors,
      });
    }
  } catch (error) {
    if (error instanceof WorkspaceTransferError) throw error;
    throw invalidRuntimeGraph(
      errorCode,
      path,
      "could not be inspected safely.",
      error,
    );
  } finally {
    ancestors.delete(value);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalClone<T>(
  value: T,
  path: string,
  errorCode: CanonicalTransferErrorCode = "BACKUP_INVALID",
  allowedUndefinedPaths: readonly (readonly (string | number)[])[] = [],
): T {
  assertJsonSafe(value, path, { errorCode, allowedUndefinedPaths });
  let snapshot: T;
  try {
    snapshot = structuredClone(value);
  } catch (error) {
    throw invalidRuntimeGraph(
      errorCode,
      path,
      "could not be snapshotted safely.",
      error,
    );
  }
  assertJsonSafe(snapshot, path, { errorCode, allowedUndefinedPaths });
  try {
    return JSON.parse(canonicalJson(snapshot)) as T;
  } catch (error) {
    throw invalidRuntimeGraph(
      errorCode,
      path,
      "could not be serialized canonically.",
      error,
    );
  }
}

function assertStrictWorkspaceSchema(
  value: unknown,
): asserts value is WorkspaceV2 {
  try {
    assertWorkspaceV2Schema(value);
  } catch (error) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      error instanceof WorkspaceBackupSchemaError
        ? `Backup Workspace schema is invalid at ${error.path}.`
        : "Backup Workspace schema validation failed.",
      error,
    );
  }
}

function sortReceipts(receipts: readonly CommandReceipt[]): CommandReceipt[] {
  return [...clone(receipts)].sort(
    (left, right) =>
      compareText(left.createdAt, right.createdAt) ||
      compareText(left.id, right.id),
  );
}

function isExactMigrationGrandfatheredActual(
  workspace: Readonly<WorkspaceV2>,
  actualId: string,
): boolean {
  const migration = workspace.migration;
  if (migration === undefined) return false;
  const actuals = workspace.actuals.filter(({ id }) => id === actualId);
  if (actuals.length !== 1) return false;
  const actual = actuals[0];
  if (actual.target.kind !== "work_item" || actual.revision !== 1) {
    return false;
  }
  const workItemId = actual.target.workItemId;
  const workItems = workspace.workItems.filter(({ id }) => id === workItemId);
  if (workItems.length !== 1 || workItems[0].revision !== 1) return false;
  const projects = workspace.projects.filter(
    ({ id }) => id === workItems[0].projectId,
  );
  if (projects.length !== 1) return false;
  const project = projects[0];
  const exactMigrationHold = project.holds.some(
    (hold) =>
      hold.type === "migration_review" &&
      hold.sourceId === migration.backupId &&
      hold.createdAt === migration.migratedAt &&
      hold.affectedRecordIds.length === 2 &&
      hold.affectedRecordIds[0] === project.id &&
      hold.affectedRecordIds[1] === project.activeDirectionBriefId,
  );
  const exactClosedMigrationProof =
    project.stage === "closed" &&
    project.legacyClosure?.sourceChecksum === migration.sourceChecksum;
  if (!exactMigrationHold && !exactClosedMigrationProof) return false;

  let prefix: string;
  try {
    prefix =
      `migration:actual:${encodeURIComponent(workItemId)}:` +
      `${encodeURIComponent(actual.recordedAt)}:`;
  } catch {
    return false;
  }
  if (!actual.id.startsWith(prefix)) return false;
  const sourceIndexText = actual.id.slice(prefix.length);
  if (!/^(0|[1-9][0-9]*)$/.test(sourceIndexText)) return false;
  const sourceIndex = Number(sourceIndexText);
  if (
    !Number.isSafeInteger(sourceIndex) ||
    sourceIndex < 0 ||
    sourceIndex >= (migration.entityCounts.actuals ?? -1)
  ) {
    return false;
  }
  const derivationKey = `${workItemId}+${actual.recordedAt}+${sourceIndex}`;
  const mappedKeys = Object.entries(migration.deterministicIdMap)
    .filter(([, id]) => id === actual.id)
    .map(([key]) => key);
  return (
    mappedKeys.length === 1 &&
    mappedKeys[0] === derivationKey &&
    migration.deterministicIdMap[derivationKey] === actual.id
  );
}

function validatePersistedWorkspaceInvariants(
  workspace: WorkspaceV2,
  now: ISODate,
) {
  const baseline = validateWorkspaceInvariants(workspace, now);
  if (baseline.length === 0) return baseline;
  const selfContinuation = validateWorkspaceInvariants(
    workspace,
    now,
    workspace,
  );
  return baseline.filter((violation) => {
    if (!violation.gate?.endsWith(":current_bet")) return true;
    const acceptedAsSelfContinuation = !selfContinuation.some(
      (candidate) =>
        candidate.code === violation.code && candidate.gate === violation.gate,
    );
    if (acceptedAsSelfContinuation) return false;
    const migratedActual = /^actual:(.+):current_bet$/.exec(violation.gate);
    return (
      migratedActual === null ||
      !isExactMigrationGrandfatheredActual(workspace, migratedActual[1])
    );
  });
}

const sourceCapabilities = new Set([
  "human_decision",
  "capture_inbox",
  "record_actual",
  "attach_evidence",
  "submit_proposal",
  "import_portable",
  "replay_receipt",
  "system_time",
  "open_conflict",
]);

async function assertReceiptHash(
  receipt: Readonly<CommandReceipt>,
  expectedStatus: "applied" | "rejected",
): Promise<void> {
  if (
    !record(receipt) ||
    !exactKeys(
      receipt,
      [
        "id",
        "commandId",
        "commandType",
        "baseRevision",
        "revision",
        "payloadHash",
        "receiptHash",
        "actorId",
        "actorKind",
        "origin",
        "source",
        "status",
        "createdAt",
        "diff",
      ],
      ["rejectionCode"],
    ) ||
    receipt.status !== expectedStatus ||
    receipt.id !== receipt.commandId ||
    !canonicalId(receipt.commandId) ||
    !canonicalId(receipt.commandType) ||
    !Number.isSafeInteger(receipt.baseRevision) ||
    receipt.baseRevision < 0 ||
    !Number.isSafeInteger(receipt.revision) ||
    receipt.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(receipt.payloadHash) ||
    !/^[a-f0-9]{64}$/.test(receipt.receiptHash) ||
    !canonicalId(receipt.actorId) ||
    !["human", "agent", "system"].includes(receipt.actorKind) ||
    !["ui", "agent", "import", "sync", "migration"].includes(receipt.origin) ||
    !canonicalTimestamp(receipt.createdAt) ||
    !record(receipt.source) ||
    !exactKeys(receipt.source, ["sourceId", "verified", "capabilities"]) ||
    !canonicalId(receipt.source.sourceId) ||
    typeof receipt.source.verified !== "boolean" ||
    !Array.isArray(receipt.source.capabilities) ||
    !receipt.source.capabilities.every(
      (capability) =>
        canonicalId(capability) && sourceCapabilities.has(capability),
    ) ||
    new Set(receipt.source.capabilities).size !==
      receipt.source.capabilities.length ||
    !Array.isArray(receipt.diff)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `Receipt ${String(receipt.commandId)} has an invalid strict shape.`,
    );
  }
  if (
    (expectedStatus === "applied" &&
      (receipt.rejectionCode !== undefined ||
        receipt.source.verified !== true ||
        !isKnownV2CommandType(receipt.commandType) ||
        receipt.revision !== receipt.baseRevision + 1)) ||
    (expectedStatus === "rejected" &&
      (typeof receipt.rejectionCode !== "string" ||
        receipt.rejectionCode.trim().length === 0 ||
        receipt.revision !== receipt.baseRevision))
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `Receipt ${receipt.commandId} has invalid ${expectedStatus} revision semantics.`,
    );
  }
  for (const diff of receipt.diff) {
    if (
      !record(diff) ||
      !exactKeys(diff, ["entity", "entityId", "field", "before", "after"]) ||
      !canonicalId(diff.entity) ||
      !canonicalId(diff.entityId) ||
      !canonicalId(diff.field)
    ) {
      throw new WorkspaceTransferError(
        "BACKUP_INVALID",
        `Receipt ${receipt.commandId} has an invalid audit diff.`,
      );
    }
    assertJsonSafe(diff.before, `receipt:${receipt.commandId}:diff.before`);
    assertJsonSafe(diff.after, `receipt:${receipt.commandId}:diff.after`);
  }
  const { receiptHash, ...base } = receipt;
  if ((await stableHash(base as unknown as JsonValue)) !== receiptHash) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `Receipt ${receipt.commandId} hash is invalid.`,
    );
  }
}

async function loadSnapshot(
  repository: WorkspaceTransferRepository,
): Promise<WorkspaceTransferSnapshot | undefined> {
  return repository.loadTransferSnapshot();
}

export async function buildWorkspaceBackupV2(input: {
  snapshot: Readonly<WorkspaceTransferSnapshot>;
  exportedAt: ISODate;
}): Promise<WorkspaceBackupV2> {
  const request = canonicalClone(input, "backupRequest", "BACKUP_INVALID", [
    ["snapshot", "workspace", "capacityProfile"],
    ["snapshot", "workspace", "migration"],
  ]);
  if (
    !record(request) ||
    !exactKeys(request, ["snapshot", "exportedAt"]) ||
    !canonicalTimestamp(request.exportedAt)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Backup export time must be a canonical ISO timestamp.",
    );
  }
  const snapshot = request.snapshot;
  if (
    !record(snapshot) ||
    !exactKeys(snapshot, ["workspace", "rejectedReceipts"]) ||
    !Array.isArray(snapshot.rejectedReceipts)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Backup export requires one exact Workspace transfer snapshot.",
    );
  }
  const workspace = snapshot.workspace;
  assertStrictWorkspaceSchema(workspace);
  for (const conflict of workspace.syncConflicts) {
    const hasLocalBundle = conflict.localBundle !== undefined;
    const hasRemoteBundle = conflict.remoteBundle !== undefined;
    const validateBundlePair =
      conflict.resolvedAt === undefined
        ? validateProtectedEffectBundlePair
        : validateProtectedEffectBundlePairMetadata;
    if (
      hasLocalBundle !== hasRemoteBundle ||
      (hasLocalBundle &&
        !(await validateBundlePair({
          workspace,
          conflictId: conflict.id,
          recordType: conflict.recordType,
          projectId: conflict.projectId,
          logicalKey: conflict.logicalKey,
          recordId: conflict.recordId,
          remoteRecordId: conflict.remoteRecordId,
          localValue: conflict.localValue,
          remoteValue: conflict.remoteValue,
          retainedVersion: conflict.retainedVersion,
          retainedBundleHash: conflict.retainedBundleHash,
          affectedRecordIds: conflict.affectedRecordIds,
          affectedProjectIds: conflict.affectedProjectIds,
          localBundle: conflict.localBundle,
          remoteBundle: conflict.remoteBundle,
        })))
    ) {
      throw new WorkspaceTransferError(
        "BACKUP_INVALID",
        `SyncConflictRecord ${conflict.id} has an invalid protected bundle pair.`,
      );
    }
  }
  const rejectedReceipts = sortReceipts(snapshot.rejectedReceipts);
  if (
    workspace.schemaVersion !== 2 ||
    !canonicalId(workspace.workspaceId) ||
    !Number.isSafeInteger(workspace.revision) ||
    workspace.revision < 0
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Only a canonical schema-2 Workspace can be exported.",
    );
  }
  for (const receipt of workspace.commandReceipts) {
    await assertReceiptHash(receipt, "applied");
  }
  for (const receipt of rejectedReceipts) {
    await assertReceiptHash(receipt, "rejected");
  }
  const appliedIds = new Set(
    workspace.commandReceipts.map(({ commandId }) => commandId),
  );
  const appliedById = new Map(
    workspace.commandReceipts.map((receipt) => [receipt.commandId, receipt]),
  );
  if (
    appliedIds.size !== workspace.commandReceipts.length ||
    new Set(rejectedReceipts.map(({ commandId }) => commandId)).size !==
      rejectedReceipts.length ||
    rejectedReceipts.some((rejected) => {
      const applied = appliedById.get(rejected.commandId);
      return (
        applied !== undefined &&
        !isExactSystemCasRetryOverlap({ applied, rejected })
      );
    })
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Receipt ledgers require unique ownership except for one exact system CAS retry pair.",
    );
  }
  let expectedBaseRevision = 0;
  for (const receipt of workspace.commandReceipts) {
    if (
      receipt.baseRevision !== expectedBaseRevision ||
      receipt.revision !== expectedBaseRevision + 1
    ) {
      throw new WorkspaceTransferError(
        "BACKUP_INVALID",
        `Applied receipt ${receipt.commandId} breaks the contiguous Workspace revision chain.`,
      );
    }
    expectedBaseRevision = receipt.revision;
  }
  if (workspace.revision !== expectedBaseRevision) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Workspace revision does not terminate at its applied receipt ledger.",
    );
  }
  const invariantViolations = validatePersistedWorkspaceInvariants(
    workspace,
    request.exportedAt,
  );
  if (invariantViolations.length > 0) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `Backup Workspace violates ${invariantViolations[0].gate}.`,
      invariantViolations,
    );
  }
  await assertHumanCommitmentProvenance(workspace);
  const workspaceHash = await sha256Hex(canonicalJson(workspace));
  const receiptLedgerHash = await sha256Hex(canonicalJson(rejectedReceipts));
  const withoutChecksum = {
    schemaVersion: 2,
    format: V2_BACKUP_FORMAT,
    exportedAt: request.exportedAt,
    workspace,
    rejectedReceipts,
    workspaceHash,
    receiptLedgerHash,
  } satisfies Omit<WorkspaceBackupV2, "backupChecksum">;
  return deepFreeze({
    ...withoutChecksum,
    backupChecksum: await sha256Hex(canonicalJson(withoutChecksum)),
  });
}

export async function exportWorkspaceBackup(input: {
  repository: WorkspaceTransferRepository;
  exportedAt: ISODate;
}): Promise<WorkspaceBackupV2> {
  const request = snapshotRequestFields(
    input,
    ["repository", "exportedAt"],
    "BACKUP_INVALID",
    "Backup export requires one exact request envelope.",
  );
  const repository = request.repository as WorkspaceTransferRepository;
  const exportedAt = request.exportedAt as ISODate;
  if (!canonicalTimestamp(exportedAt)) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Backup export time must be a canonical ISO timestamp.",
    );
  }
  const snapshot = await loadSnapshot(repository);
  if (snapshot === undefined) {
    throw new WorkspaceTransferError(
      "WORKSPACE_NOT_READY",
      "A V2 Workspace must exist before backup export.",
    );
  }
  return buildWorkspaceBackupV2({
    snapshot,
    exportedAt,
  });
}

interface PortableCommandListV2 {
  schemaVersion: 2;
  format: typeof V2_PORTABLE_COMMANDS_FORMAT;
  commands: V2Command[];
}

function parsePortableCommand(value: unknown): V2Command {
  if (!record(value) || typeof value.type !== "string") {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_INVALID",
      "Every portable entry must be one strict command object.",
    );
  }
  if (!isPortableImportCommandType(value.type)) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_INVALID",
      `Command ${value.type} is outside the portable import allowlist.`,
    );
  }
  if (value.type === "capture_inbox") {
    if (
      !exactKeys(value, ["type", "id", "text"], ["desiredDate"]) ||
      !canonicalId(value.id) ||
      typeof value.text !== "string" ||
      (value.desiredDate !== undefined &&
        !canonicalTimestamp(value.desiredDate))
    ) {
      throw new WorkspaceTransferError(
        "PORTABLE_IMPORT_INVALID",
        "Portable capture_inbox has an invalid strict shape.",
      );
    }
    return clone(value) as Extract<V2Command, { type: "capture_inbox" }>;
  }
  if (value.type === "update_project_metadata") {
    if (
      !exactKeys(value, ["type", "projectId"], ["name", "priority", "notes"]) ||
      !canonicalId(value.projectId) ||
      (value.name !== undefined && typeof value.name !== "string") ||
      (value.notes !== undefined && typeof value.notes !== "string") ||
      (value.priority !== undefined &&
        (!Number.isSafeInteger(value.priority) || Number(value.priority) < 0))
    ) {
      throw new WorkspaceTransferError(
        "PORTABLE_IMPORT_INVALID",
        "Portable update_project_metadata has an invalid strict shape.",
      );
    }
    return clone(value) as Extract<
      V2Command,
      { type: "update_project_metadata" }
    >;
  }
  if (value.type === "archive_project") {
    if (
      !exactKeys(value, ["type", "projectId", "archived"]) ||
      !canonicalId(value.projectId) ||
      typeof value.archived !== "boolean"
    ) {
      throw new WorkspaceTransferError(
        "PORTABLE_IMPORT_INVALID",
        "Portable archive_project has an invalid strict shape.",
      );
    }
    return clone(value) as Extract<V2Command, { type: "archive_project" }>;
  }
  const exhaustive: never = value.type;
  throw new WorkspaceTransferError(
    "PORTABLE_IMPORT_INVALID",
    `Command ${String(exhaustive)} is outside the portable import allowlist.`,
  );
}

function parsePortableCommandList(value: unknown): PortableCommandListV2 {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "format", "commands"]) ||
    value.schemaVersion !== 2 ||
    value.format !== V2_PORTABLE_COMMANDS_FORMAT ||
    !Array.isArray(value.commands)
  ) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_INVALID",
      "Portable import requires one exact schema-2 command-list envelope.",
    );
  }
  return {
    schemaVersion: 2,
    format: V2_PORTABLE_COMMANDS_FORMAT,
    commands: value.commands.map(parsePortableCommand),
  };
}

export type PortableImportResult =
  | {
      status: "applied";
      appliedReceipts: CommandReceipt[];
    }
  | {
      status: "rejected";
      appliedReceipts: CommandReceipt[];
      rejectionIndex: number;
      rejection: Extract<CommandResult, { ok: false }>["rejection"];
    };

function portableReceiptAttempt(
  commandId: string,
  baseCommandId: string,
): number | undefined {
  if (commandId === baseCommandId) return 0;
  const retryPrefix = `${baseCommandId}-retry-`;
  if (!commandId.startsWith(retryPrefix)) return undefined;
  const suffix = commandId.slice(retryPrefix.length);
  if (!/^[1-9][0-9]*$/.test(suffix)) return undefined;
  const attempt = Number(suffix);
  return Number.isSafeInteger(attempt) ? attempt : undefined;
}

function assertPortableReceiptIdentity(input: {
  receipt: Readonly<CommandReceipt>;
  command: Readonly<V2Command>;
  payloadHash: string;
  actorId: string;
  sourceId: string;
}): void {
  const expectedSource = {
    sourceId: input.sourceId,
    verified: true,
    capabilities: ["import_portable"],
  };
  if (
    input.receipt.commandType !== input.command.type ||
    input.receipt.payloadHash !== input.payloadHash ||
    input.receipt.actorId !== input.actorId ||
    input.receipt.actorKind !== "human" ||
    input.receipt.origin !== "import" ||
    canonicalJson(input.receipt.source) !== canonicalJson(expectedSource)
  ) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_CONFLICT",
      `Portable command identity ${input.receipt.commandId} is already bound to different bytes or provenance.`,
    );
  }
}

interface PortableLedgerPlan {
  baseCommandId: string;
  nextCommandId: string;
  appliedReceipt?: CommandReceipt;
}

async function preflightPortableLedger(input: {
  snapshot: Readonly<WorkspaceTransferSnapshot>;
  command: Readonly<V2Command>;
  index: number;
  packageHash: string;
  actorId: string;
  sourceId: string;
}): Promise<PortableLedgerPlan> {
  const baseCommandId = `import-${input.packageHash.slice(0, 24)}-${input.index}`;
  const payloadHash = await stableHash(input.command as unknown as JsonValue);
  const namespaceReceipts = [
    ...input.snapshot.workspace.commandReceipts,
    ...input.snapshot.rejectedReceipts,
  ]
    .map((receipt) => ({
      receipt,
      attempt: portableReceiptAttempt(receipt.commandId, baseCommandId),
    }))
    .filter(
      (entry): entry is { receipt: CommandReceipt; attempt: number } =>
        entry.attempt !== undefined,
    )
    .sort((left, right) => left.attempt - right.attempt);
  for (const { receipt } of namespaceReceipts) {
    try {
      if (receipt.status !== "applied" && receipt.status !== "rejected") {
        throw new WorkspaceTransferError(
          "BACKUP_INVALID",
          `Receipt ${receipt.commandId} has an invalid status.`,
        );
      }
      await assertReceiptHash(receipt, receipt.status);
    } catch (error) {
      throw new WorkspaceTransferError(
        "PORTABLE_IMPORT_CONFLICT",
        `Portable command identity ${receipt.commandId} has an invalid receipt.`,
        error,
      );
    }
    assertPortableReceiptIdentity({
      receipt,
      command: input.command,
      payloadHash,
      actorId: input.actorId,
      sourceId: input.sourceId,
    });
  }
  if (namespaceReceipts.some(({ attempt }, position) => attempt !== position)) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_CONFLICT",
      `Portable command ${baseCommandId} has a non-contiguous retry ledger.`,
    );
  }
  const applied = namespaceReceipts.filter(
    ({ receipt }) => receipt.status === "applied",
  );
  if (applied.length > 1) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_CONFLICT",
      `Portable command ${baseCommandId} has multiple applied receipts.`,
    );
  }
  const firstAppliedPosition = namespaceReceipts.findIndex(
    ({ receipt }) => receipt.status === "applied",
  );
  if (
    firstAppliedPosition >= 0 &&
    (firstAppliedPosition !== namespaceReceipts.length - 1 ||
      namespaceReceipts
        .slice(0, firstAppliedPosition)
        .some(({ receipt }) => receipt.status !== "rejected"))
  ) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_CONFLICT",
      `Portable command ${baseCommandId} has an invalid retry status chain.`,
    );
  }
  return {
    baseCommandId,
    nextCommandId:
      namespaceReceipts.length === 0
        ? baseCommandId
        : `${baseCommandId}-retry-${namespaceReceipts.length}`,
    ...(applied[0] === undefined
      ? {}
      : { appliedReceipt: clone(applied[0].receipt) }),
  };
}

export async function importPortableCommands(input: {
  repository: AtomicWorkspaceRepository &
    Pick<WorkspaceTransferRepository, "loadTransferSnapshot">;
  workspaceId: string;
  importedAt: ISODate;
  actorId: string;
  sourceId: string;
  payload: unknown;
}): Promise<PortableImportResult> {
  const request = snapshotRequestFields(
    input,
    [
      "repository",
      "workspaceId",
      "importedAt",
      "actorId",
      "sourceId",
      "payload",
    ],
    "PORTABLE_IMPORT_INVALID",
    "Portable import requires one exact request envelope.",
  );
  const repository = request.repository as AtomicWorkspaceRepository &
    Pick<WorkspaceTransferRepository, "loadTransferSnapshot">;
  const workspaceId = request.workspaceId;
  const importedAt = request.importedAt;
  const actorId = request.actorId;
  const sourceId = request.sourceId;
  if (
    !canonicalTimestamp(importedAt) ||
    !canonicalId(workspaceId) ||
    !canonicalId(actorId) ||
    !canonicalId(sourceId)
  ) {
    throw new WorkspaceTransferError(
      "PORTABLE_IMPORT_INVALID",
      "Portable import identity and timestamp must be canonical.",
    );
  }
  const payloadSnapshot = canonicalClone(
    request.payload,
    "portableImport",
    "PORTABLE_IMPORT_INVALID",
  );
  const parsed = parsePortableCommandList(payloadSnapshot);
  const packageHash = await sha256Hex(canonicalJson(parsed));
  const preflightSnapshot = await repository.loadTransferSnapshot();
  if (
    preflightSnapshot === undefined ||
    preflightSnapshot.workspace.workspaceId !== workspaceId
  ) {
    throw new WorkspaceTransferError(
      "WORKSPACE_NOT_READY",
      "Portable import requires the initialized target Workspace.",
    );
  }
  const ledgerPlans: PortableLedgerPlan[] = [];
  let sawIncompleteCommand = false;
  for (const [index, command] of parsed.commands.entries()) {
    const plan = await preflightPortableLedger({
      snapshot: preflightSnapshot,
      command,
      index,
      packageHash,
      actorId,
      sourceId,
    });
    if (plan.appliedReceipt === undefined) {
      sawIncompleteCommand = true;
    } else if (sawIncompleteCommand) {
      throw new WorkspaceTransferError(
        "PORTABLE_IMPORT_CONFLICT",
        `Portable command ${plan.baseCommandId} is applied beyond an incomplete package prefix.`,
      );
    }
    ledgerPlans.push(plan);
  }
  const adapter = new ImportOriginAdapter(
    new CommandService(repository, workspaceId),
  );
  const appliedReceipts: CommandReceipt[] = [];
  for (const [index, command] of parsed.commands.entries()) {
    const plan = ledgerPlans[index]!;
    const snapshot = await repository.loadTransferSnapshot();
    if (
      snapshot === undefined ||
      snapshot.workspace.workspaceId !== workspaceId
    ) {
      throw new WorkspaceTransferError(
        "WORKSPACE_NOT_READY",
        "Portable import requires the initialized target Workspace.",
      );
    }
    const workspace = snapshot.workspace;
    if (plan.appliedReceipt !== undefined) {
      const currentReceipt = workspace.commandReceipts.find(
        ({ commandId }) => commandId === plan.appliedReceipt?.commandId,
      );
      if (
        currentReceipt === undefined ||
        canonicalJson(currentReceipt) !== canonicalJson(plan.appliedReceipt)
      ) {
        throw new WorkspaceTransferError(
          "PORTABLE_IMPORT_CONFLICT",
          `Portable command ${plan.baseCommandId} changed after package preflight.`,
        );
      }
      appliedReceipts.push(clone(plan.appliedReceipt));
      continue;
    }
    const context: Omit<CommandContext, "origin"> = {
      commandId: plan.nextCommandId,
      expectedRevision: workspace.revision,
      actorId,
      actorKind: "human",
      source: {
        sourceId,
        verified: true,
        capabilities: ["import_portable"],
      },
      now: importedAt,
    };
    const result = await adapter.dispatch({ command, ...context });
    if (!result.ok) {
      return {
        status: "rejected",
        appliedReceipts,
        rejectionIndex: index,
        rejection: result.rejection,
      };
    }
    appliedReceipts.push(clone(result.receipt));
  }
  return { status: "applied", appliedReceipts };
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isHumanDecisionReceipt(
  receipt: Readonly<CommandReceipt>,
  commandTypes: readonly string[],
): boolean {
  return (
    receipt.status === "applied" &&
    receipt.actorKind === "human" &&
    receipt.source.verified === true &&
    receipt.origin !== "import" &&
    receipt.origin !== "migration" &&
    commandTypes.includes(receipt.commandType) &&
    (receipt.origin === "sync"
      ? receipt.source.capabilities.includes("replay_receipt")
      : receipt.source.capabilities.includes("human_decision"))
  );
}

function exactDiff(input: {
  receipt: Readonly<CommandReceipt>;
  entity: string;
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
}): boolean {
  const matches = input.receipt.diff.filter(
    ({ entity, entityId, field }) =>
      entity === input.entity &&
      entityId === input.entityId &&
      field === input.field,
  );
  return (
    matches.length === 1 &&
    sameCanonical(matches[0]?.before, input.before) &&
    sameCanonical(matches[0]?.after, input.after)
  );
}

function hasOnlyEntityDiffFields(input: {
  receipt: Readonly<CommandReceipt>;
  entity: string;
  entityId: string;
  fields: readonly string[];
}): boolean {
  const targetDiffs = input.receipt.diff.filter(
    ({ entity, entityId }) =>
      entity === input.entity && entityId === input.entityId,
  );
  return (
    targetDiffs.length === input.fields.length &&
    new Set(targetDiffs.map(({ field }) => field)).size ===
      input.fields.length &&
    targetDiffs.every(({ field }) => input.fields.includes(field))
  );
}

function requireUniqueHumanProof(input: {
  workspace: Readonly<WorkspaceV2>;
  entity: string;
  entityId: string;
  commandTypes: readonly string[];
  proves: (receipt: Readonly<CommandReceipt>) => boolean;
}): CommandReceipt {
  const proofs = matchingHumanProofs(input);
  if (proofs.length !== 1) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `${input.entity} ${input.entityId} lacks one exact human command proof.`,
    );
  }
  return proofs[0]!;
}

function matchingHumanProofs(input: {
  workspace: Readonly<WorkspaceV2>;
  commandTypes: readonly string[];
  proves: (receipt: Readonly<CommandReceipt>) => boolean;
}): CommandReceipt[] {
  return input.workspace.commandReceipts.filter(
    (receipt) =>
      isHumanDecisionReceipt(receipt, input.commandTypes) &&
      input.proves(receipt),
  );
}

interface ConflictTargetReauthorization {
  conflictId: string;
  recordType: SyncConflictRecord["recordType"];
  recordId: string;
  value: JsonValue;
  proof: CommandReceipt;
}

function exactConflictTargetReauthorization(input: {
  reauthorizations: readonly ConflictTargetReauthorization[];
  recordType: SyncConflictRecord["recordType"];
  recordId: string;
  value: JsonValue;
}): ConflictTargetReauthorization | undefined {
  const matches = input.reauthorizations.filter(
    (candidate) =>
      candidate.recordType === input.recordType &&
      candidate.recordId === input.recordId &&
      sameCanonical(candidate.value, input.value),
  );
  const ordered = matches.sort(
    (left, right) =>
      left.proof.revision - right.proof.revision ||
      compareText(left.conflictId, right.conflictId),
  );
  return ordered[ordered.length - 1];
}

function requireUniqueHumanProofOrConflictTarget(input: {
  workspace: Readonly<WorkspaceV2>;
  entity: string;
  entityId: string;
  commandTypes: readonly string[];
  proves: (receipt: Readonly<CommandReceipt>) => boolean;
  reauthorizations: readonly ConflictTargetReauthorization[];
  recordType: SyncConflictRecord["recordType"];
  value: JsonValue;
}): CommandReceipt | undefined {
  const proofs = matchingHumanProofs(input);
  if (proofs.length === 1) return proofs[0]!;
  const reauthorization = exactConflictTargetReauthorization({
    reauthorizations: input.reauthorizations,
    recordType: input.recordType,
    recordId: input.entityId,
    value: input.value,
  });
  if (proofs.length === 0 && reauthorization !== undefined) return undefined;
  throw new WorkspaceTransferError(
    "BACKUP_INVALID",
    `${input.entity} ${input.entityId} lacks one exact human command proof.`,
  );
}

function assertBetProvenance(
  workspace: Readonly<WorkspaceV2>,
  bet: Readonly<WorkspaceV2["bets"][number]>,
  reauthorizations: readonly ConflictTargetReauthorization[] = [],
): void {
  const {
    invalidatedAt: _invalidatedAt,
    invalidationReason: _invalidationReason,
    ...creationSnapshot
  } = clone(bet);
  if (
    (bet.invalidatedAt === undefined) !==
    (bet.invalidationReason === undefined)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `BetVersion ${bet.id} has an incomplete invalidation proof.`,
    );
  }
  const creationProofInput = {
    workspace,
    entity: "BetVersion",
    entityId: bet.id,
    commandTypes: ["place_bet"],
    proves: (receipt: Readonly<CommandReceipt>) =>
      bet.actorId === receipt.actorId &&
      bet.approvedAt === receipt.createdAt &&
      bet.appetiteStart === receipt.createdAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "BetVersion",
        entityId: bet.id,
        fields: ["created"],
      }) &&
      exactDiff({
        receipt,
        entity: "BetVersion",
        entityId: bet.id,
        field: "created",
        before: null,
        after: creationSnapshot,
      }),
    reauthorizations,
    recordType: "bet" as const,
    value: creationSnapshot as unknown as JsonValue,
  };
  const fullReauthorization = exactConflictTargetReauthorization({
    reauthorizations,
    recordType: "bet",
    recordId: bet.id,
    value: bet as unknown as JsonValue,
  });
  if (fullReauthorization !== undefined) {
    requireUniqueHumanProofOrConflictTarget({
      ...creationProofInput,
      value: bet as unknown as JsonValue,
    });
    return;
  }
  requireUniqueHumanProofOrConflictTarget(creationProofInput);
  if (bet.invalidatedAt !== undefined && bet.invalidationReason !== undefined) {
    const invalidationProof = requireUniqueHumanProof({
      workspace,
      entity: "BetVersion",
      entityId: bet.id,
      commandTypes: ["place_bet", "update_direction"],
      proves: (receipt) =>
        receipt.createdAt === bet.invalidatedAt &&
        hasOnlyEntityDiffFields({
          receipt,
          entity: "BetVersion",
          entityId: bet.id,
          fields: ["invalidatedAt", "invalidationReason"],
        }) &&
        exactDiff({
          receipt,
          entity: "BetVersion",
          entityId: bet.id,
          field: "invalidatedAt",
          before: null,
          after: bet.invalidatedAt,
        }) &&
        exactDiff({
          receipt,
          entity: "BetVersion",
          entityId: bet.id,
          field: "invalidationReason",
          before: null,
          after: bet.invalidationReason,
        }),
    });
    if (invalidationProof.commandType === "update_direction") {
      const project = workspace.projects.find(({ id }) => id === bet.projectId);
      const createdBriefDiff = invalidationProof.diff.find(
        ({ entity, field }) =>
          entity === "DirectionBrief" && field === "created",
      );
      const holdsDiff = invalidationProof.diff.find(
        ({ entity, entityId, field }) =>
          entity === "ProjectV2" &&
          entityId === bet.projectId &&
          field === "holds",
      );
      const expectedAffectedRecordIds =
        project === undefined || createdBriefDiff === undefined
          ? []
          : [project.id, bet.briefId, createdBriefDiff.entityId, bet.id];
      const holdCandidates = Array.isArray(holdsDiff?.after)
        ? holdsDiff.after.filter(
            (value): value is Record<string, JsonValue> =>
              record(value) &&
              value.type === "rebet_required" &&
              value.sourceId === bet.id,
          )
        : [];
      const hold = holdCandidates[0];
      const holdWasCreated =
        holdCandidates.length === 1 &&
        hold !== undefined &&
        hold.createdAt === invalidationProof.createdAt &&
        Array.isArray(hold.affectedRecordIds) &&
        canonicalJson(hold.affectedRecordIds) ===
          canonicalJson(expectedAffectedRecordIds) &&
        Array.isArray(holdsDiff?.before) &&
        !holdsDiff.before.some((value) => sameCanonical(value, hold));
      const holdStillPersists =
        hold !== undefined &&
        project?.holds.filter((value) => sameCanonical(value, hold)).length ===
          1;
      const continuationProofs =
        hold === undefined
          ? []
          : matchingHumanProofs({
              workspace,
              commandTypes: ["place_bet"],
              proves: (receipt) => {
                if (receipt.createdAt < invalidationProof.createdAt)
                  return false;
                const activeBetDiff = receipt.diff.find(
                  ({ entity, entityId, field, before }) =>
                    entity === "ProjectV2" &&
                    entityId === bet.projectId &&
                    field === "activeBetId" &&
                    before === bet.id,
                );
                const nextBetId = activeBetDiff?.after;
                if (typeof nextBetId !== "string") return false;
                const createdBetDiff = receipt.diff.find(
                  ({ entity, entityId, field }) =>
                    entity === "BetVersion" &&
                    entityId === nextBetId &&
                    field === "created",
                );
                const continuedHoldsDiff = receipt.diff.find(
                  ({ entity, entityId, field }) =>
                    entity === "ProjectV2" &&
                    entityId === bet.projectId &&
                    field === "holds",
                );
                return (
                  record(createdBetDiff?.after) &&
                  createdBetDiff.after.id === nextBetId &&
                  createdBetDiff.after.projectId === bet.projectId &&
                  createdBetDiff.after.supersedesId === bet.id &&
                  createdBetDiff.after.actorId === receipt.actorId &&
                  createdBetDiff.after.approvedAt === receipt.createdAt &&
                  Array.isArray(continuedHoldsDiff?.before) &&
                  continuedHoldsDiff.before.some((value) =>
                    sameCanonical(value, hold),
                  ) &&
                  Array.isArray(continuedHoldsDiff.after) &&
                  !continuedHoldsDiff.after.some((value) =>
                    sameCanonical(value, hold),
                  )
                );
              },
            });
      if (
        project === undefined ||
        createdBriefDiff === undefined ||
        !holdWasCreated ||
        (!holdStillPersists && continuationProofs.length !== 1)
      ) {
        throw new WorkspaceTransferError(
          "BACKUP_INVALID",
          `BetVersion ${bet.id} has an invalid persisted Re-bet hold.`,
        );
      }
    }
  }
}

function assertDailyCommitmentProvenance(
  workspace: Readonly<WorkspaceV2>,
  commitment: Readonly<WorkspaceV2["dailyCommitments"][number]>,
  reauthorizations: readonly ConflictTargetReauthorization[] = [],
): void {
  requireUniqueHumanProofOrConflictTarget({
    workspace,
    entity: "DailyCommitment",
    entityId: commitment.id,
    commandTypes: ["commit_today", "accept_replan"],
    proves: (receipt: Readonly<CommandReceipt>) =>
      commitment.actorId === receipt.actorId &&
      commitment.committedAt === receipt.createdAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "DailyCommitment",
        entityId: commitment.id,
        fields: ["created"],
      }) &&
      exactDiff({
        receipt,
        entity: "DailyCommitment",
        entityId: commitment.id,
        field: "created",
        before: null,
        after: commitment,
      }),
    reauthorizations,
    recordType: "daily_commitment",
    value: commitment as unknown as JsonValue,
  });
}

function assertExceptionProvenance(
  workspace: Readonly<WorkspaceV2>,
  exception: Readonly<WorkspaceV2["exceptions"][number]>,
  reauthorizations: readonly ConflictTargetReauthorization[] = [],
): void {
  const [creationHistory, ...laterHistory] = exception.history;
  if (
    creationHistory === undefined ||
    creationHistory.action !== "created" ||
    creationHistory.actorId !== exception.approvedBy ||
    creationHistory.at !== exception.createdAt ||
    creationHistory.note !== exception.rationale ||
    laterHistory.length > 1
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `ExceptionRecord ${exception.id} has invalid immutable approval fields.`,
    );
  }
  const { resolvedAt: _resolvedAt, ...unresolvedSnapshot } = clone(exception);
  const creationSnapshot = {
    ...unresolvedSnapshot,
    history: [clone(creationHistory)],
  };
  const resolutionHistory = laterHistory[0];
  if (
    exception.resolvedAt === undefined
      ? laterHistory.length !== 0
      : resolutionHistory === undefined ||
        resolutionHistory.action !== "resolved" ||
        resolutionHistory.at !== exception.resolvedAt
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `ExceptionRecord ${exception.id} has invalid resolution history.`,
    );
  }
  const creationProofInput = {
    workspace,
    entity: "ExceptionRecord",
    entityId: exception.id,
    commandTypes: ["approve_evidence_exception"],
    proves: (receipt: Readonly<CommandReceipt>) =>
      exception.approvedBy === receipt.actorId &&
      exception.createdAt === receipt.createdAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "ExceptionRecord",
        entityId: exception.id,
        fields: ["created"],
      }) &&
      exactDiff({
        receipt,
        entity: "ExceptionRecord",
        entityId: exception.id,
        field: "created",
        before: null,
        after: creationSnapshot,
      }),
    reauthorizations,
    recordType: "exception" as const,
    value: creationSnapshot as unknown as JsonValue,
  };
  const fullReauthorization = exactConflictTargetReauthorization({
    reauthorizations,
    recordType: "exception",
    recordId: exception.id,
    value: exception as unknown as JsonValue,
  });
  if (fullReauthorization !== undefined) {
    requireUniqueHumanProofOrConflictTarget({
      ...creationProofInput,
      value: exception as unknown as JsonValue,
    });
    return;
  }
  requireUniqueHumanProofOrConflictTarget(creationProofInput);
  if (exception.resolvedAt === undefined || resolutionHistory === undefined)
    return;
  requireUniqueHumanProof({
    workspace,
    entity: "ExceptionRecord",
    entityId: exception.id,
    commandTypes: ["resolve_evidence_exception"],
    proves: (receipt) =>
      receipt.actorId === resolutionHistory.actorId &&
      receipt.createdAt === exception.resolvedAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "ExceptionRecord",
        entityId: exception.id,
        fields: ["resolvedAt", "history"],
      }) &&
      exactDiff({
        receipt,
        entity: "ExceptionRecord",
        entityId: exception.id,
        field: "resolvedAt",
        before: null,
        after: exception.resolvedAt,
      }) &&
      exactDiff({
        receipt,
        entity: "ExceptionRecord",
        entityId: exception.id,
        field: "history",
        before: [creationHistory],
        after: exception.history,
      }),
  });
}

function assertCloseDecisionProvenance(
  workspace: Readonly<WorkspaceV2>,
  decision: Readonly<WorkspaceV2["closeDecisions"][number]>,
  reauthorizations: readonly ConflictTargetReauthorization[] = [],
): void {
  requireUniqueHumanProofOrConflictTarget({
    workspace,
    entity: "CloseDecision",
    entityId: decision.id,
    commandTypes: ["close_project", "abandon_project"],
    proves: (receipt) =>
      decision.actorId === receipt.actorId &&
      decision.closedAt === receipt.createdAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "CloseDecision",
        entityId: decision.id,
        fields: ["created"],
      }) &&
      exactDiff({
        receipt,
        entity: "CloseDecision",
        entityId: decision.id,
        field: "created",
        before: null,
        after: decision,
      }),
    reauthorizations,
    recordType: "close",
    value: decision as unknown as JsonValue,
  });
}

function assertCompletedReviewProvenance(
  workspace: Readonly<WorkspaceV2>,
  review: Readonly<WorkspaceV2["reviews"][number]>,
  reauthorizations: readonly ConflictTargetReauthorization[] = [],
): CommandReceipt {
  const conclusion = review.conclusion;
  if (review.status !== "completed" || conclusion === undefined) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `ReviewRecord ${review.id} has no immutable conclusion.`,
    );
  }
  const proofInput = {
    workspace,
    commandTypes:
      review.triggerType === "sync_conflict"
        ? ["resolve_sync_conflict"]
        : ["complete_review"],
    proves: (receipt: Readonly<CommandReceipt>) =>
      conclusion.actorId === receipt.actorId &&
      conclusion.completedAt === receipt.createdAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "ReviewRecord",
        entityId: review.id,
        fields: ["status", "conclusion"],
      }) &&
      exactDiff({
        receipt,
        entity: "ReviewRecord",
        entityId: review.id,
        field: "status",
        before: "open",
        after: "completed",
      }) &&
      exactDiff({
        receipt,
        entity: "ReviewRecord",
        entityId: review.id,
        field: "conclusion",
        before: null,
        after: conclusion,
      }),
  };
  const proofs = matchingHumanProofs(proofInput);
  if (proofs.length === 1) return proofs[0]!;
  const reauthorization =
    review.triggerType === "sync_conflict"
      ? undefined
      : exactConflictTargetReauthorization({
          reauthorizations,
          recordType: "review",
          recordId: review.id,
          value: review as unknown as JsonValue,
        });
  if (proofs.length === 0 && reauthorization !== undefined) {
    return reauthorization.proof;
  }
  throw new WorkspaceTransferError(
    "BACKUP_INVALID",
    `ReviewRecord ${review.id} lacks one exact human command proof.`,
  );
}

async function assertBundledSyncConflictOpenProvenance(
  workspace: Readonly<WorkspaceV2>,
  conflict: Readonly<WorkspaceV2["syncConflicts"][number]>,
): Promise<void> {
  if (
    conflict.localBundle === undefined &&
    conflict.remoteBundle === undefined
  ) {
    return;
  }
  if (
    conflict.localBundle === undefined ||
    conflict.remoteBundle === undefined
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} has incomplete open provenance.`,
    );
  }
  const {
    resolvedAt: _resolvedAt,
    retainedVersion: _retainedVersion,
    retainedBundleHash: _retainedBundleHash,
    ...openedConflict
  } = clone(conflict);
  const {
    projectId: _projectId,
    openedAt: _openedAt,
    ...draft
  } = clone(openedConflict);
  const expectedPayloadHash = await stableHash({
    type: "open_sync_conflict",
    conflict: draft,
  } as unknown as JsonValue);
  const proofs = workspace.commandReceipts.filter(
    (receipt) =>
      receipt.status === "applied" &&
      receipt.commandType === "open_sync_conflict" &&
      receipt.actorKind === "system" &&
      receipt.source.verified === true &&
      receipt.source.capabilities.includes("open_conflict") &&
      receipt.createdAt === conflict.openedAt &&
      receipt.payloadHash === expectedPayloadHash &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        fields: ["created"],
      }) &&
      exactDiff({
        receipt,
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        field: "created",
        before: null,
        after: openedConflict,
      }),
  );
  if (proofs.length !== 1) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} lacks one exact authorized open proof.`,
    );
  }
}

function assertResolvedSyncConflictProvenance(
  workspace: Readonly<WorkspaceV2>,
  conflict: Readonly<WorkspaceV2["syncConflicts"][number]>,
): ConflictTargetReauthorization | undefined {
  if (
    conflict.resolvedAt === undefined ||
    conflict.retainedVersion === undefined
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} has an incomplete resolution.`,
    );
  }
  const isBundled =
    conflict.localBundle !== undefined || conflict.remoteBundle !== undefined;
  if (
    isBundled &&
    (conflict.localBundle === undefined ||
      conflict.remoteBundle === undefined ||
      conflict.remoteRecordId === undefined ||
      conflict.retainedBundleHash === undefined)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} has incomplete retained bundle provenance.`,
    );
  }
  const review = workspace.reviews.find(
    ({ id }) => id === `review:sync_conflict:${conflict.id}`,
  );
  if (review === undefined || review.conclusion === undefined) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} lacks its completed resolution Review.`,
    );
  }
  const proof = requireUniqueHumanProof({
    workspace,
    entity: "SyncConflictRecord",
    entityId: conflict.id,
    commandTypes: ["resolve_sync_conflict"],
    proves: (receipt) =>
      receipt.createdAt === conflict.resolvedAt &&
      hasOnlyEntityDiffFields({
        receipt,
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        fields:
          conflict.retainedBundleHash === undefined
            ? ["resolvedAt", "retainedVersion"]
            : ["resolvedAt", "retainedVersion", "retainedBundleHash"],
      }) &&
      exactDiff({
        receipt,
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        field: "resolvedAt",
        before: null,
        after: conflict.resolvedAt,
      }) &&
      exactDiff({
        receipt,
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        field: "retainedVersion",
        before: null,
        after: conflict.retainedVersion,
      }) &&
      (conflict.retainedBundleHash === undefined
        ? !receipt.diff.some(
            ({ entity, entityId, field }) =>
              entity === "SyncConflictRecord" &&
              entityId === conflict.id &&
              field === "retainedBundleHash",
          )
        : exactDiff({
            receipt,
            entity: "SyncConflictRecord",
            entityId: conflict.id,
            field: "retainedBundleHash",
            before: null,
            after: conflict.retainedBundleHash,
          })),
  });
  const reviewProof = assertCompletedReviewProvenance(workspace, review);
  const expectedDecisionCode = `sync_conflict_retained_${conflict.retainedVersion}`;
  if (
    reviewProof.commandId !== proof.commandId ||
    review.conclusion.decisionCodes.length !== 1 ||
    review.conclusion.decisionCodes[0] !== expectedDecisionCode
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} resolution and Review proof diverge.`,
    );
  }
  if (!isBundled) return undefined;
  const selectsRemote = conflict.retainedVersion === "remote";
  const selectedBundle = selectsRemote
    ? conflict.remoteBundle!
    : conflict.localBundle!;
  const selectedRecordId = selectsRemote
    ? conflict.remoteRecordId!
    : conflict.recordId;
  const selectedValue = selectsRemote
    ? conflict.remoteValue
    : conflict.localValue;
  if (conflict.retainedBundleHash !== selectedBundle.hash) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `SyncConflictRecord ${conflict.id} retained bundle hash diverges from its decision.`,
    );
  }
  return {
    conflictId: conflict.id,
    recordType: conflict.recordType,
    recordId: selectedRecordId,
    value: clone(selectedValue),
    proof,
  };
}

async function assertHumanCommitmentProvenance(
  workspace: Readonly<WorkspaceV2>,
): Promise<void> {
  await Promise.all(
    workspace.syncConflicts.map((conflict) =>
      assertBundledSyncConflictOpenProvenance(workspace, conflict),
    ),
  );
  const reauthorizations = workspace.syncConflicts
    .filter(({ resolvedAt }) => resolvedAt !== undefined)
    .flatMap((conflict) => {
      const reauthorization = assertResolvedSyncConflictProvenance(
        workspace,
        conflict,
      );
      return reauthorization === undefined ? [] : [reauthorization];
    });
  workspace.bets.forEach((bet) =>
    assertBetProvenance(workspace, bet, reauthorizations),
  );
  workspace.dailyCommitments.forEach((commitment) =>
    assertDailyCommitmentProvenance(workspace, commitment, reauthorizations),
  );
  workspace.exceptions.forEach((exception) =>
    assertExceptionProvenance(workspace, exception, reauthorizations),
  );
  workspace.closeDecisions.forEach((decision) =>
    assertCloseDecisionProvenance(workspace, decision, reauthorizations),
  );
  workspace.reviews
    .filter(({ status }) => status === "completed")
    .forEach((review) =>
      assertCompletedReviewProvenance(workspace, review, reauthorizations),
    );
}

async function parseVerifiedBackup(
  value: unknown,
  validationNow: ISODate,
): Promise<WorkspaceBackupV2> {
  if (!canonicalTimestamp(validationNow)) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Restore validation time must be canonical.",
    );
  }
  const candidateValue = canonicalClone(value, "backup", "BACKUP_INVALID", [
    ["workspace", "capacityProfile"],
    ["workspace", "migration"],
  ]);
  if (
    !record(candidateValue) ||
    !exactKeys(candidateValue, [
      "schemaVersion",
      "format",
      "exportedAt",
      "workspace",
      "rejectedReceipts",
      "workspaceHash",
      "receiptLedgerHash",
      "backupChecksum",
    ]) ||
    candidateValue.schemaVersion !== 2 ||
    candidateValue.format !== V2_BACKUP_FORMAT ||
    !canonicalTimestamp(candidateValue.exportedAt) ||
    !Array.isArray(candidateValue.rejectedReceipts) ||
    typeof candidateValue.workspaceHash !== "string" ||
    typeof candidateValue.receiptLedgerHash !== "string" ||
    typeof candidateValue.backupChecksum !== "string"
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Restore requires one exact schema-2 OmniPlan backup envelope.",
    );
  }
  const candidate = candidateValue as unknown as WorkspaceBackupV2;
  assertStrictWorkspaceSchema(candidate.workspace);
  const rebuilt = await buildWorkspaceBackupV2({
    snapshot: {
      workspace: candidate.workspace,
      rejectedReceipts: candidate.rejectedReceipts,
    },
    exportedAt: candidate.exportedAt,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(candidate)) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Backup hashes, ledger order, or checksum do not match the canonical envelope.",
    );
  }
  const invariantViolations = validatePersistedWorkspaceInvariants(
    candidate.workspace,
    validationNow,
  );
  if (invariantViolations.length > 0) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      `Backup Workspace violates ${invariantViolations[0].gate}.`,
      invariantViolations,
    );
  }
  await assertHumanCommitmentProvenance(candidate.workspace);
  return deepFreeze(candidate);
}

const authorizedWorkspaceRestoreBrand: unique symbol = Symbol(
  "AuthorizedWorkspaceRestore",
);
const authorizedWorkspaceRestores = new WeakSet<object>();

export interface AuthorizedWorkspaceRestore {
  readonly [authorizedWorkspaceRestoreBrand]: true;
  readonly targetBackup: Readonly<WorkspaceBackupV2>;
  readonly targetSnapshot: Readonly<WorkspaceTransferSnapshot>;
  readonly safetyBackupRecord: Readonly<VerifiedBackupRecord>;
}

class AuthorizedWorkspaceRestoreValue implements AuthorizedWorkspaceRestore {
  readonly [authorizedWorkspaceRestoreBrand] = true as const;
  readonly #repositoryIdentity: object;
  readonly #expectedCurrentCanonical: string;
  readonly #targetBackupCanonical: string;
  readonly #targetSnapshotCanonical: string;
  readonly #safetyBackupRecordCanonical: string;

  constructor(input: {
    repositoryIdentity: object;
    expectedCurrent: Readonly<WorkspaceRestoreCheckpoint>;
    targetBackup: Readonly<WorkspaceBackupV2>;
    safetyBackupRecord: Readonly<VerifiedBackupRecord>;
  }) {
    this.#repositoryIdentity = input.repositoryIdentity;
    this.#expectedCurrentCanonical = canonicalJson(input.expectedCurrent);
    this.#targetBackupCanonical = canonicalJson(input.targetBackup);
    this.#targetSnapshotCanonical = canonicalJson({
      workspace: input.targetBackup.workspace,
      rejectedReceipts: input.targetBackup.rejectedReceipts,
    });
    this.#safetyBackupRecordCanonical = canonicalJson(input.safetyBackupRecord);
    Object.freeze(this);
    authorizedWorkspaceRestores.add(this);
  }

  get targetBackup(): Readonly<WorkspaceBackupV2> {
    return JSON.parse(this.#targetBackupCanonical) as WorkspaceBackupV2;
  }

  get targetSnapshot(): Readonly<WorkspaceTransferSnapshot> {
    return JSON.parse(
      this.#targetSnapshotCanonical,
    ) as WorkspaceTransferSnapshot;
  }

  get safetyBackupRecord(): Readonly<VerifiedBackupRecord> {
    return JSON.parse(
      this.#safetyBackupRecordCanonical,
    ) as VerifiedBackupRecord;
  }

  consume(
    repositoryIdentity: object,
    current: Readonly<WorkspaceRestoreCheckpoint>,
  ): boolean {
    const wasAuthorized = authorizedWorkspaceRestores.delete(this);
    if (
      !wasAuthorized ||
      this.#repositoryIdentity !== repositoryIdentity ||
      this.#expectedCurrentCanonical !== canonicalJson(current)
    )
      return false;
    return true;
  }
}

export function isAuthorizedWorkspaceRestore(
  value: unknown,
): value is AuthorizedWorkspaceRestore {
  return (
    typeof value === "object" &&
    value !== null &&
    value instanceof AuthorizedWorkspaceRestoreValue &&
    authorizedWorkspaceRestores.has(value)
  );
}

export function consumeAuthorizedWorkspaceRestore(input: {
  authorization: AuthorizedWorkspaceRestore;
  repositoryIdentity: object;
  current: Readonly<WorkspaceRestoreCheckpoint>;
}): boolean {
  return (
    isAuthorizedWorkspaceRestore(input.authorization) &&
    input.authorization instanceof AuthorizedWorkspaceRestoreValue &&
    input.authorization.consume(input.repositoryIdentity, input.current)
  );
}

export async function authorizeVerifiedBackupRestore(input: {
  repository: WorkspaceTransferRepository;
  backup: unknown;
  validationNow: ISODate;
}): Promise<AuthorizedWorkspaceRestore> {
  const request = snapshotRequestFields(
    input,
    ["repository", "backup", "validationNow"],
    "BACKUP_INVALID",
    "Verified restore requires one exact authorization request.",
  );
  const repository = request.repository as WorkspaceTransferRepository;
  const validationNow = request.validationNow as ISODate;
  const targetBackup = await parseVerifiedBackup(request.backup, validationNow);
  const loadedCurrent = await repository.loadRestoreCheckpoint();
  if (loadedCurrent === undefined) {
    throw new WorkspaceTransferError(
      "WORKSPACE_NOT_READY",
      "Restore requires an initialized current Workspace.",
    );
  }
  const current = canonicalClone(loadedCurrent, "current", "BACKUP_INVALID", [
    ["workspace", "capacityProfile"],
    ["workspace", "migration"],
  ]);
  if (
    !record(current) ||
    !exactKeys(current, [
      "workspace",
      "rejectedReceipts",
      "migrationRuns",
      "migrationRecoveryRecord",
      "outboxEntries",
    ]) ||
    !Array.isArray(current.rejectedReceipts) ||
    !Array.isArray(current.migrationRuns) ||
    !Array.isArray(current.outboxEntries)
  ) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "Current restore checkpoint has an invalid strict shape.",
    );
  }
  if (current.workspace.workspaceId !== targetBackup.workspace.workspaceId) {
    throw new WorkspaceTransferError(
      "BACKUP_INVALID",
      "A backup cannot replace a different Workspace identity.",
    );
  }
  const safetyBackup = await buildWorkspaceBackupV2({
    snapshot: {
      workspace: current.workspace,
      rejectedReceipts: current.rejectedReceipts,
    },
    exportedAt: validationNow,
  });
  const safetyRawPayload = canonicalJson(safetyBackup);
  const safetyBackupRecord: VerifiedBackupRecord = {
    id: `v2-restore-point:${safetyBackup.backupChecksum}`,
    rawPayload: safetyRawPayload,
    checksum: await sha256Hex(safetyRawPayload),
  };
  return new AuthorizedWorkspaceRestoreValue({
    repositoryIdentity: repository.restoreRepositoryIdentity(),
    expectedCurrent: {
      workspace: current.workspace,
      rejectedReceipts: sortReceipts(current.rejectedReceipts),
      migrationRuns: [...current.migrationRuns].sort((left, right) =>
        compareText(left.sourceChecksum, right.sourceChecksum),
      ),
      migrationRecoveryRecord: current.migrationRecoveryRecord,
      outboxEntries: current.outboxEntries,
    },
    targetBackup,
    safetyBackupRecord,
  });
}

export type RestoreVerifiedBackupResult =
  | { status: "migration_required" }
  | {
      status: "restored";
      revision: number;
      safetyBackupId: string;
    }
  | { status: "checkpoint_conflict" }
  | { status: "outbox_not_quiescent" };

export async function restoreVerifiedBackup(input: {
  repository: WorkspaceTransferRepository;
  backup: unknown;
  validationNow: ISODate;
}): Promise<RestoreVerifiedBackupResult> {
  const request = snapshotRequestFields(
    input,
    ["repository", "backup", "validationNow"],
    "BACKUP_INVALID",
    "Verified restore requires one exact request envelope.",
  );
  const repository = request.repository as WorkspaceTransferRepository;
  const backup = request.backup;
  const validationNow = request.validationNow as ISODate;
  let schemaVersionDescriptor: PropertyDescriptor | undefined;
  if (record(backup)) {
    try {
      schemaVersionDescriptor = Object.getOwnPropertyDescriptor(
        backup,
        "schemaVersion",
      );
    } catch {
      schemaVersionDescriptor = undefined;
    }
  }
  if (
    schemaVersionDescriptor !== undefined &&
    "value" in schemaVersionDescriptor &&
    schemaVersionDescriptor.value === 1
  ) {
    return { status: "migration_required" };
  }
  const authorization = await authorizeVerifiedBackupRestore({
    repository,
    backup,
    validationNow,
  });
  const result = await repository.restoreVerifiedBackup(authorization);
  if (result !== "restored") return { status: result };
  return {
    status: "restored",
    revision: authorization.targetSnapshot.workspace.revision,
    safetyBackupId: authorization.safetyBackupRecord.id,
  };
}
