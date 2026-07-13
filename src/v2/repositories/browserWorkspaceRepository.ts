import type { ISODate } from "@/domain/types";

import { canonicalJson } from "../../domain/canonical";
import { normalizeWorkspaceSnapshot } from "../../domain/projectLifecycle";
import type { CommandContext, V2Command } from "../domain/commands";
import { sha256Text, stableHash } from "../domain/stableHash";
import type {
  CommandReceipt,
  JsonValue,
  MigrationRecord,
  WorkspaceV2,
} from "../domain/types";
import type { MigrationRecoveryState } from "../migration/recovery";
import { migrateV1Workspace } from "../migration/migrateV1";
import { migratedWorkspaceDescendsFromBaseline } from "../migration/restoreLineage";
import { parseV1Export, verifyRawV1Backup } from "../migration/backup";
import {
  openV2Database,
  requestResult,
  transactionComplete,
  V2_DATABASE_NAME,
  V2_OBJECT_STORES,
} from "./indexedDb";
import {
  consumeAuthorizedWorkspaceRestore,
  isAuthorizedWorkspaceRestore,
  type AuthorizedWorkspaceRestore,
  type WorkspaceRestoreCheckpoint,
  type WorkspaceTransferSnapshot,
} from "./workspaceTransfer";
import { parseSyncEnvelopeV2, syncOperationPathV2 } from "./syncProtocol";
import { isExactSystemCasRetryOverlap } from "./receiptOwnership";

const CURRENT_WORKSPACE_KEY = "current";

export interface PreparedSyncOperation {
  operationHash: string;
  path: string;
  /** Exact canonical ciphertext envelope uploaded to the immutable remote path. */
  envelopeJson: string;
}

export interface SyncOutboxEntry {
  id: string;
  workspaceId: string;
  commandId: string;
  baseRevision: number;
  revision: number;
  command: V2Command;
  actor: Pick<CommandContext, "actorId" | "actorKind" | "origin" | "source">;
  payloadHash: string;
  receiptId: string;
  createdAt: ISODate;
  status: "pending" | "sent";
  preparedOperation?: PreparedSyncOperation;
  sentAt?: ISODate;
  operationHash?: string;
}

export interface SyncOutboxRepository {
  load(): Promise<WorkspaceV2 | undefined>;
  listPendingOutbox(): Promise<SyncOutboxEntry[]>;
  prepareOutboxOperation(
    id: string,
    operation: PreparedSyncOperation,
  ): Promise<SyncOutboxEntry>;
  replacePreparedOutboxOperation(
    id: string,
    expectedOperationHash: string,
    operation: PreparedSyncOperation,
  ): Promise<SyncOutboxEntry>;
  markOutboxSent(
    id: string,
    operationHash: string,
    sentAt: ISODate,
  ): Promise<void>;
}

export interface AtomicWorkspaceRepository {
  load(): Promise<WorkspaceV2 | undefined>;
  initialize(workspace: WorkspaceV2): Promise<"initialized" | "already_exists">;
  commit(input: {
    expectedRevision: number;
    workspace: WorkspaceV2;
    outboxEntry: SyncOutboxEntry;
  }): Promise<"committed" | "revision_conflict">;
  commitMigration(input: {
    sourceChecksum: string;
    workspace: WorkspaceV2;
    migrationRecord: MigrationRecord;
  }): Promise<"committed" | "already_migrated" | "revision_conflict">;
  writeAndVerifyBackup(input: {
    id: string;
    rawPayload: string;
    checksum: string;
  }): Promise<void>;
  loadMigration(sourceChecksum: string): Promise<MigrationRecord | undefined>;
  listPendingOutbox(): Promise<SyncOutboxEntry[]>;
  markOutboxSent(
    id: string,
    operationHash: string,
    sentAt: ISODate,
  ): Promise<void>;
  appendRejectedReceipt(receipt: CommandReceipt): Promise<void>;
  findReceipt(commandId: string): Promise<CommandReceipt | undefined>;
  listReceipts(): Promise<CommandReceipt[]>;
}

export type AtomicWorkspaceRestoreResult =
  "restored" | "checkpoint_conflict" | "outbox_not_quiescent";

export interface WorkspaceTransferRepository {
  loadTransferSnapshot(): Promise<WorkspaceTransferSnapshot | undefined>;
  loadRestoreCheckpoint(): Promise<WorkspaceRestoreCheckpoint | undefined>;
  restoreRepositoryIdentity(): object;
  restoreVerifiedBackup(
    authorization: AuthorizedWorkspaceRestore,
  ): Promise<AtomicWorkspaceRestoreResult>;
}

export interface MigrationWorkspaceRepository extends AtomicWorkspaceRepository {
  loadVerifiedBackup(id: string): Promise<VerifiedBackupRecord | undefined>;
  saveMigrationRecovery(state: MigrationRecoveryState): Promise<void>;
  loadMigrationRecovery(): Promise<MigrationRecoveryState | undefined>;
  clearMigrationRecovery(): Promise<void>;
  clearMigrationRecoveryIfMatching(
    expected: MigrationRecoveryIdentity,
  ): Promise<"cleared" | "not_found" | "not_matching">;
}

export interface MigrationRecoveryIdentity {
  sourceChecksum: string;
  backupId: string;
  backupChecksum: string;
}

export type RepositoryTransactionOperation =
  | "initialize"
  | "commit"
  | "commitMigration"
  | "backup"
  | "saveMigrationRecovery"
  | "clearMigrationRecovery"
  | "clearMatchingMigrationRecovery"
  | "prepareOutboxOperation"
  | "replacePreparedOutboxOperation"
  | "markOutboxSent"
  | "appendRejectedReceipt"
  | "restoreVerifiedBackup";

export interface BrowserWorkspaceRepositoryOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  /** Test/diagnostic fault injection. Called only after all writes are queued. */
  beforeTransactionComplete?: (
    operation: RepositoryTransactionOperation,
    transaction: IDBTransaction,
  ) => void;
}

export class WorkspaceRestoreBoundaryError extends Error {
  constructor(
    readonly code:
      | "AUTHORIZED_RESTORE_REQUIRED"
      | "MALFORMED_OUTBOX"
      | "BACKUP_COLLISION"
      | "MIGRATION_SOURCE_BACKUP_REQUIRED"
      | "MIGRATION_LINEAGE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceRestoreBoundaryError";
  }
}

export interface VerifiedBackupRecord {
  id: string;
  rawPayload: string;
  checksum: string;
}

type BackupRecord = VerifiedBackupRecord;

const CURRENT_MIGRATION_RECOVERY_KEY = "migration-recovery:current";

interface MigrationRecoveryRecord {
  id: typeof CURRENT_MIGRATION_RECOVERY_KEY;
  state: MigrationRecoveryState;
}

function migrationRecoveryMatches(
  state: MigrationRecoveryState,
  expected: MigrationRecoveryIdentity,
): boolean {
  return (
    state.sourceChecksum === expected.sourceChecksum &&
    state.backupId === expected.backupId &&
    state.backupChecksum === expected.backupChecksum
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalTimestamp(value: unknown): value is ISODate {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function isWellFormedSentOutboxEntry(entry: SyncOutboxEntry): boolean {
  return (
    entry.status === "sent" &&
    entry.preparedOperation !== undefined &&
    typeof entry.operationHash === "string" &&
    /^[a-f0-9]{64}$/.test(entry.operationHash) &&
    typeof entry.preparedOperation.operationHash === "string" &&
    entry.preparedOperation.operationHash === entry.operationHash &&
    typeof entry.preparedOperation.path === "string" &&
    entry.preparedOperation.path.trim().length > 0 &&
    entry.preparedOperation.path === entry.preparedOperation.path.trim() &&
    typeof entry.preparedOperation.envelopeJson === "string" &&
    entry.preparedOperation.envelopeJson.trim().length > 0 &&
    canonicalTimestamp(entry.sentAt) &&
    entry.id === `outbox-${entry.commandId}`
  );
}

async function isVerifiedSentOutboxEntry(
  entry: SyncOutboxEntry,
  workspace: Readonly<WorkspaceV2>,
): Promise<boolean> {
  if (!isWellFormedSentOutboxEntry(entry)) return false;
  const receipt = workspace.commandReceipts.find(
    ({ commandId, status }) =>
      commandId === entry.commandId && status === "applied",
  );
  if (receipt === undefined || entry.preparedOperation === undefined) {
    return false;
  }
  const commandType =
    typeof entry.command === "object" &&
    entry.command !== null &&
    "type" in entry.command
      ? entry.command.type
      : undefined;
  const { receiptHash, ...receiptBase } = receipt;
  if (
    entry.workspaceId !== workspace.workspaceId ||
    entry.receiptId !== receipt.id ||
    entry.baseRevision !== receipt.baseRevision ||
    entry.revision !== receipt.revision ||
    entry.payloadHash !== receipt.payloadHash ||
    entry.createdAt !== receipt.createdAt ||
    commandType !== receipt.commandType ||
    canonicalJson(entry.actor) !==
      canonicalJson({
        actorId: receipt.actorId,
        actorKind: receipt.actorKind,
        origin: receipt.origin,
        source: receipt.source,
      }) ||
    (await stableHash(entry.command as unknown as JsonValue)) !==
      entry.payloadHash ||
    (await stableHash(receiptBase as unknown as JsonValue)) !== receiptHash
  ) {
    return false;
  }
  let envelope;
  try {
    const parsed: unknown = JSON.parse(entry.preparedOperation.envelopeJson);
    envelope = parseSyncEnvelopeV2(parsed);
  } catch {
    return false;
  }
  const canonicalEnvelope = canonicalJson(envelope);
  const operationHash = await sha256Text(canonicalEnvelope);
  let expectedPath: string;
  try {
    expectedPath = syncOperationPathV2(
      envelope.workspaceId,
      envelope.deviceId,
      envelope.sequence,
      operationHash,
    );
  } catch {
    return false;
  }
  return (
    entry.preparedOperation.envelopeJson === canonicalEnvelope &&
    entry.preparedOperation.operationHash === operationHash &&
    entry.operationHash === operationHash &&
    entry.preparedOperation.path === expectedPath &&
    envelope.workspaceId === entry.workspaceId &&
    envelope.commandId === entry.commandId &&
    envelope.baseRevision === entry.baseRevision &&
    envelope.revision === entry.revision &&
    envelope.payloadHash === entry.payloadHash &&
    envelope.createdAt === entry.createdAt
  );
}

function errorName(error: unknown): string | undefined {
  return error instanceof DOMException || error instanceof Error
    ? error.name
    : undefined;
}

function isConstraintError(error: unknown): boolean {
  return errorName(error) === "ConstraintError";
}

const WORKSPACE_ENTITY_COLLECTIONS = [
  "inboxItems",
  "actions",
  "projects",
  "directionBriefs",
  "bets",
  "planVersions",
  "dailyCommitments",
  "replanProposals",
  "reviews",
  "exceptions",
  "closeDecisions",
  "commandProposals",
  "syncConflicts",
  "commandReceipts",
  "workItems",
  "dependencies",
  "resources",
  "capacities",
  "baselines",
  "evidence",
  "actuals",
  "legacyAuditRecords",
] as const satisfies ReadonlyArray<keyof WorkspaceV2>;

function assertInitialWorkspaceEnvelope(workspace: WorkspaceV2): void {
  if (
    workspace.schemaVersion !== 2 ||
    workspace.workspaceId.trim().length === 0 ||
    workspace.revision !== 0 ||
    workspace.commandReceipts.length !== 0
  ) {
    throw new Error(
      "A V2 Workspace must initialize at revision 0 without command receipts.",
    );
  }
}

function assertEmptyBootstrapWorkspace(workspace: WorkspaceV2): void {
  assertInitialWorkspaceEnvelope(workspace);
  const hasStoredEntities = WORKSPACE_ENTITY_COLLECTIONS.some((field) => {
    const value = workspace[field];
    return !Array.isArray(value) || value.length !== 0;
  });
  if (
    hasStoredEntities ||
    workspace.capacityProfile !== undefined ||
    workspace.migration !== undefined ||
    !Array.isArray(workspace.visibility?.archivedProjectIds) ||
    workspace.visibility.archivedProjectIds.length !== 0
  ) {
    throw new Error(
      "Bootstrap initialization requires a truly empty V2 Workspace; migrated or preloaded state must use its atomic command path.",
    );
  }
}

function assertCanonicalRevision(revision: number, field: string): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

async function sameStableValue(
  left: unknown,
  right: unknown,
): Promise<boolean> {
  return (
    (await stableHash(left as JsonValue)) ===
    (await stableHash(right as JsonValue))
  );
}

async function assertAtomicCommandTuple(input: {
  expectedRevision: number;
  workspace: WorkspaceV2;
  outboxEntry: SyncOutboxEntry;
}): Promise<void> {
  const { expectedRevision, workspace, outboxEntry } = input;
  assertCanonicalRevision(expectedRevision, "expectedRevision");
  if (
    workspace.schemaVersion !== 2 ||
    workspace.workspaceId.trim().length === 0 ||
    workspace.revision !== expectedRevision + 1
  ) {
    throw new Error(
      "Invalid atomic command tuple: Workspace revision mismatch.",
    );
  }
  const identityMatches =
    outboxEntry.workspaceId === workspace.workspaceId &&
    outboxEntry.baseRevision === expectedRevision &&
    outboxEntry.revision === workspace.revision &&
    outboxEntry.id === `outbox-${outboxEntry.commandId}`;
  const isPendingLocal =
    identityMatches &&
    outboxEntry.status === "pending" &&
    outboxEntry.preparedOperation === undefined &&
    outboxEntry.sentAt === undefined &&
    outboxEntry.operationHash === undefined;
  if (!isPendingLocal) {
    throw new Error("Invalid atomic command tuple: outbox state mismatch.");
  }

  const matchingReceipts = workspace.commandReceipts.filter(
    ({ commandId }) => commandId === outboxEntry.commandId,
  );
  const finalReceipt =
    workspace.commandReceipts[workspace.commandReceipts.length - 1];
  if (
    matchingReceipts.length !== 1 ||
    finalReceipt?.commandId !== outboxEntry.commandId
  ) {
    throw new Error(
      "Invalid atomic command tuple: applied receipt identity mismatch.",
    );
  }
  const receipt = matchingReceipts[0];
  const commandType =
    typeof outboxEntry.command === "object" &&
    outboxEntry.command !== null &&
    "type" in outboxEntry.command
      ? outboxEntry.command.type
      : undefined;
  if (
    receipt.status !== "applied" ||
    receipt.rejectionCode !== undefined ||
    receipt.id !== receipt.commandId ||
    receipt.id !== outboxEntry.receiptId ||
    receipt.commandId !== outboxEntry.commandId ||
    receipt.commandType !== commandType ||
    receipt.baseRevision !== expectedRevision ||
    receipt.revision !== workspace.revision ||
    receipt.payloadHash !== outboxEntry.payloadHash ||
    receipt.actorId !== outboxEntry.actor.actorId ||
    receipt.actorKind !== outboxEntry.actor.actorKind ||
    receipt.origin !== outboxEntry.actor.origin ||
    receipt.createdAt !== outboxEntry.createdAt ||
    !(await sameStableValue(receipt.source, outboxEntry.actor.source))
  ) {
    throw new Error(
      "Invalid atomic command tuple: applied receipt fields mismatch.",
    );
  }

  const payloadHash = await stableHash(
    outboxEntry.command as unknown as JsonValue,
  );
  if (payloadHash !== receipt.payloadHash) {
    throw new Error(
      "Invalid atomic command tuple: command payload hash mismatch.",
    );
  }
  const { receiptHash, ...receiptBase } = receipt;
  if ((await stableHash(receiptBase as unknown as JsonValue)) !== receiptHash) {
    throw new Error("Invalid atomic command tuple: receipt hash mismatch.");
  }
}

async function assertMigrationTuple(input: {
  sourceChecksum: string;
  workspace: WorkspaceV2;
  migrationRecord: MigrationRecord;
}): Promise<void> {
  const { sourceChecksum, workspace, migrationRecord } = input;
  assertInitialWorkspaceEnvelope(workspace);
  if (
    sourceChecksum.trim().length === 0 ||
    migrationRecord.sourceChecksum !== sourceChecksum ||
    workspace.migration === undefined ||
    workspace.migration.sourceChecksum !== sourceChecksum ||
    !(await sameStableValue(workspace.migration, migrationRecord))
  ) {
    throw new Error("Invalid atomic migration tuple.");
  }
}

async function migrationAlreadyCommitted(
  current: WorkspaceV2 | undefined,
  storedRecord: MigrationRecord | undefined,
  input: {
    workspace: WorkspaceV2;
    migrationRecord: MigrationRecord;
  },
): Promise<boolean> {
  return (
    current?.workspaceId === input.workspace.workspaceId &&
    current.migration !== undefined &&
    storedRecord !== undefined &&
    (await sameStableValue(storedRecord, input.migrationRecord)) &&
    (await sameStableValue(current.migration, input.migrationRecord))
  );
}

export class BrowserWorkspaceRepository
  implements AtomicWorkspaceRepository, WorkspaceTransferRepository
{
  readonly databaseName: string;
  private readonly indexedDB: IDBFactory | undefined;
  private readonly beforeTransactionComplete:
    BrowserWorkspaceRepositoryOptions["beforeTransactionComplete"] | undefined;
  private readonly restoreIdentity = Object.freeze({});

  constructor(options: BrowserWorkspaceRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? V2_DATABASE_NAME;
    this.indexedDB = options.indexedDB;
    this.beforeTransactionComplete = options.beforeTransactionComplete;
  }

  private open(): Promise<IDBDatabase> {
    return openV2Database({
      databaseName: this.databaseName,
      ...(this.indexedDB === undefined ? {} : { indexedDB: this.indexedDB }),
    });
  }

  private inject(
    operation: RepositoryTransactionOperation,
    transaction: IDBTransaction,
  ): void {
    this.beforeTransactionComplete?.(operation, transaction);
  }

  async load(): Promise<WorkspaceV2 | undefined> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.workspace,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const workspace = await requestResult<WorkspaceV2 | undefined>(
        transaction
          .objectStore(V2_OBJECT_STORES.workspace)
          .get(CURRENT_WORKSPACE_KEY),
      );
      await completion;
      return workspace === undefined ? undefined : structuredClone(workspace);
    } finally {
      database.close();
    }
  }

  restoreRepositoryIdentity(): object {
    return this.restoreIdentity;
  }

  async loadTransferSnapshot(): Promise<WorkspaceTransferSnapshot | undefined> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [V2_OBJECT_STORES.workspace, V2_OBJECT_STORES.receipts],
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const [workspace, rejectedReceipts] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          transaction
            .objectStore(V2_OBJECT_STORES.workspace)
            .get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<CommandReceipt[]>(
          transaction.objectStore(V2_OBJECT_STORES.receipts).getAll(),
        ),
      ]);
      await completion;
      if (workspace === undefined) return undefined;
      return {
        workspace: structuredClone(workspace),
        rejectedReceipts: structuredClone(
          rejectedReceipts.sort(
            (left, right) =>
              compareText(left.createdAt, right.createdAt) ||
              compareText(left.id, right.id),
          ),
        ),
      };
    } finally {
      database.close();
    }
  }

  async loadRestoreCheckpoint(): Promise<
    WorkspaceRestoreCheckpoint | undefined
  > {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [
          V2_OBJECT_STORES.workspace,
          V2_OBJECT_STORES.receipts,
          V2_OBJECT_STORES.migrationRuns,
          V2_OBJECT_STORES.backups,
          V2_OBJECT_STORES.outbox,
        ],
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const [
        workspace,
        rejectedReceipts,
        migrationRuns,
        recoveryRecord,
        outboxEntries,
      ] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          transaction
            .objectStore(V2_OBJECT_STORES.workspace)
            .get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<CommandReceipt[]>(
          transaction.objectStore(V2_OBJECT_STORES.receipts).getAll(),
        ),
        requestResult<MigrationRecord[]>(
          transaction.objectStore(V2_OBJECT_STORES.migrationRuns).getAll(),
        ),
        requestResult<MigrationRecoveryRecord | undefined>(
          transaction
            .objectStore(V2_OBJECT_STORES.backups)
            .get(CURRENT_MIGRATION_RECOVERY_KEY),
        ),
        requestResult<SyncOutboxEntry[]>(
          transaction.objectStore(V2_OBJECT_STORES.outbox).getAll(),
        ),
      ]);
      await completion;
      if (workspace === undefined) return undefined;
      return {
        workspace: structuredClone(workspace),
        rejectedReceipts: structuredClone(
          rejectedReceipts.sort(
            (left, right) =>
              compareText(left.createdAt, right.createdAt) ||
              compareText(left.id, right.id),
          ),
        ),
        migrationRuns: structuredClone(
          migrationRuns.sort((left, right) =>
            compareText(left.sourceChecksum, right.sourceChecksum),
          ),
        ),
        migrationRecoveryRecord:
          recoveryRecord === undefined
            ? null
            : (structuredClone(recoveryRecord) as unknown as JsonValue),
        outboxEntries: structuredClone(
          outboxEntries.sort((left, right) => compareText(left.id, right.id)),
        ) as unknown as JsonValue[],
      };
    } finally {
      database.close();
    }
  }

  async initialize(
    workspaceInput: WorkspaceV2,
  ): Promise<"initialized" | "already_exists"> {
    const workspace = structuredClone(workspaceInput);
    assertEmptyBootstrapWorkspace(workspace);
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.workspace,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const request = transaction
        .objectStore(V2_OBJECT_STORES.workspace)
        .add(workspace, CURRENT_WORKSPACE_KEY);
      this.inject("initialize", transaction);
      try {
        await requestResult(request);
        await completion;
        return "initialized";
      } catch (error) {
        await completion.catch(() => undefined);
        if (isConstraintError(error) || isConstraintError(transaction.error)) {
          return "already_exists";
        }
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async commit(inputValue: {
    expectedRevision: number;
    workspace: WorkspaceV2;
    outboxEntry: SyncOutboxEntry;
  }): Promise<"committed" | "revision_conflict"> {
    const input = structuredClone(inputValue);
    await assertAtomicCommandTuple(input);
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [
          V2_OBJECT_STORES.workspace,
          V2_OBJECT_STORES.outbox,
          V2_OBJECT_STORES.receipts,
        ],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const workspaceStore = transaction.objectStore(
        V2_OBJECT_STORES.workspace,
      );
      const receiptStore = transaction.objectStore(V2_OBJECT_STORES.receipts);
      const [current, existingRejectedReceipt] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          workspaceStore.get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<CommandReceipt | undefined>(
          receiptStore.get(input.outboxEntry.commandId),
        ),
      ]);
      const appliedReceipt =
        input.workspace.commandReceipts[
          input.workspace.commandReceipts.length - 1
        ];
      if (
        current === undefined ||
        current.workspaceId !== input.workspace.workspaceId ||
        current.revision !== input.expectedRevision ||
        appliedReceipt === undefined ||
        (existingRejectedReceipt !== undefined &&
          !isExactSystemCasRetryOverlap({
            applied: appliedReceipt,
            rejected: existingRejectedReceipt,
          }))
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "revision_conflict";
      }

      const workspaceRequest = workspaceStore.put(
        input.workspace,
        CURRENT_WORKSPACE_KEY,
      );
      const outboxRequest = transaction
        .objectStore(V2_OBJECT_STORES.outbox)
        .add(input.outboxEntry);
      this.inject("commit", transaction);
      try {
        await Promise.all([
          requestResult(workspaceRequest),
          requestResult(outboxRequest),
        ]);
        await completion;
        return "committed";
      } catch (error) {
        await completion.catch(() => undefined);
        if (isConstraintError(error) || isConstraintError(transaction.error)) {
          return "revision_conflict";
        }
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async restoreVerifiedBackup(
    authorization: AuthorizedWorkspaceRestore,
  ): Promise<AtomicWorkspaceRestoreResult> {
    if (!isAuthorizedWorkspaceRestore(authorization)) {
      throw new WorkspaceRestoreBoundaryError(
        "AUTHORIZED_RESTORE_REQUIRED",
        "Restore requires an opaque verified backup authorization.",
      );
    }
    const targetSnapshot = structuredClone(authorization.targetSnapshot);
    const safetyBackupRecord = structuredClone(
      authorization.safetyBackupRecord,
    );
    const targetMigration = targetSnapshot.workspace.migration;
    let verifiedMigrationSourceBackup: VerifiedBackupRecord | undefined;
    let migrationSourcePreverificationFailed = false;
    let migrationLineagePreverificationFailed = false;
    if (targetMigration !== undefined) {
      let recomputedMigrationBaseline: WorkspaceV2 | undefined;
      try {
        verifiedMigrationSourceBackup = await this.loadVerifiedBackup(
          targetMigration.backupId,
        );
        if (
          verifiedMigrationSourceBackup === undefined ||
          !(await verifyRawV1Backup(verifiedMigrationSourceBackup))
        ) {
          migrationSourcePreverificationFailed = true;
        } else {
          const parsed = parseV1Export(
            verifiedMigrationSourceBackup.rawPayload,
          );
          const normalizedSource = normalizeWorkspaceSnapshot(parsed.snapshot);
          if (
            (await stableHash(normalizedSource as unknown as JsonValue)) !==
            targetMigration.sourceChecksum
          ) {
            migrationSourcePreverificationFailed = true;
          } else {
            const recomputed = migrateV1Workspace(normalizedSource, {
              workspaceId: targetSnapshot.workspace.workspaceId,
              sourceChecksum: targetMigration.sourceChecksum,
              backupId: targetMigration.backupId,
              backupChecksum: targetMigration.backupChecksum,
              actorId: "migration-restore-verifier",
              now: targetMigration.migratedAt,
            });
            if (
              canonicalJson(recomputed.migration) !==
              canonicalJson(targetMigration)
            ) {
              migrationSourcePreverificationFailed = true;
            } else {
              recomputedMigrationBaseline = recomputed.workspace;
            }
          }
        }
      } catch {
        migrationSourcePreverificationFailed = true;
      }
      if (
        !migrationSourcePreverificationFailed &&
        recomputedMigrationBaseline !== undefined
      ) {
        try {
          if (
            !migratedWorkspaceDescendsFromBaseline(
              recomputedMigrationBaseline,
              targetSnapshot.workspace,
            )
          ) {
            migrationLineagePreverificationFailed = true;
          }
        } catch {
          migrationLineagePreverificationFailed = true;
        }
      } else if (!migrationSourcePreverificationFailed) {
        migrationSourcePreverificationFailed = true;
      }
    }
    const restoreCheckpointPreflight = await this.loadRestoreCheckpoint();
    const restoreCheckpointPreflightCanonical =
      restoreCheckpointPreflight === undefined
        ? undefined
        : canonicalJson(restoreCheckpointPreflight);
    let sentOutboxPreverificationFailed =
      restoreCheckpointPreflight === undefined;
    if (restoreCheckpointPreflight !== undefined) {
      for (const rawEntry of restoreCheckpointPreflight.outboxEntries) {
        const entry = rawEntry as unknown as SyncOutboxEntry;
        if (
          entry.status === "sent" &&
          !(await isVerifiedSentOutboxEntry(
            entry,
            restoreCheckpointPreflight.workspace,
          ))
        ) {
          sentOutboxPreverificationFailed = true;
          break;
        }
      }
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [
          V2_OBJECT_STORES.workspace,
          V2_OBJECT_STORES.receipts,
          V2_OBJECT_STORES.backups,
          V2_OBJECT_STORES.outbox,
          V2_OBJECT_STORES.migrationRuns,
        ],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const workspaceStore = transaction.objectStore(
        V2_OBJECT_STORES.workspace,
      );
      const receiptStore = transaction.objectStore(V2_OBJECT_STORES.receipts);
      const backupStore = transaction.objectStore(V2_OBJECT_STORES.backups);
      const outboxStore = transaction.objectStore(V2_OBJECT_STORES.outbox);
      const migrationStore = transaction.objectStore(
        V2_OBJECT_STORES.migrationRuns,
      );
      const [
        currentWorkspace,
        currentReceipts,
        currentBackup,
        outboxEntries,
        currentMigrationRuns,
        currentRecoveryRecord,
        targetMigrationSourceBackup,
      ] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          workspaceStore.get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<CommandReceipt[]>(receiptStore.getAll()),
        requestResult<BackupRecord | undefined>(
          backupStore.get(safetyBackupRecord.id),
        ),
        requestResult<SyncOutboxEntry[]>(outboxStore.getAll()),
        requestResult<MigrationRecord[]>(migrationStore.getAll()),
        requestResult<MigrationRecoveryRecord | undefined>(
          backupStore.get(CURRENT_MIGRATION_RECOVERY_KEY),
        ),
        targetMigration === undefined
          ? Promise.resolve(undefined)
          : requestResult<BackupRecord | undefined>(
              backupStore.get(targetMigration.backupId),
            ),
      ]);
      if (currentWorkspace === undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "checkpoint_conflict";
      }
      const current: WorkspaceRestoreCheckpoint = {
        workspace: structuredClone(currentWorkspace),
        rejectedReceipts: structuredClone(
          currentReceipts.sort(
            (left, right) =>
              compareText(left.createdAt, right.createdAt) ||
              compareText(left.id, right.id),
          ),
        ),
        migrationRuns: structuredClone(
          currentMigrationRuns.sort((left, right) =>
            compareText(left.sourceChecksum, right.sourceChecksum),
          ),
        ),
        migrationRecoveryRecord:
          currentRecoveryRecord === undefined
            ? null
            : (structuredClone(currentRecoveryRecord) as unknown as JsonValue),
        outboxEntries: structuredClone(
          outboxEntries.sort((left, right) => compareText(left.id, right.id)),
        ) as unknown as JsonValue[],
      };
      if (
        !consumeAuthorizedWorkspaceRestore({
          authorization,
          repositoryIdentity: this.restoreRepositoryIdentity(),
          current,
        })
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "checkpoint_conflict";
      }
      if (
        restoreCheckpointPreflightCanonical === undefined ||
        restoreCheckpointPreflightCanonical !== canonicalJson(current)
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "checkpoint_conflict";
      }
      if (outboxEntries.some(({ status }) => status === "pending")) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "outbox_not_quiescent";
      }
      if (
        sentOutboxPreverificationFailed ||
        !outboxEntries.every(isWellFormedSentOutboxEntry)
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new WorkspaceRestoreBoundaryError(
          "MALFORMED_OUTBOX",
          "Restore refuses malformed non-pending outbox state.",
        );
      }
      if (
        currentWorkspace.workspaceId !== targetSnapshot.workspace.workspaceId
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "checkpoint_conflict";
      }
      if (
        currentBackup !== undefined &&
        canonicalJson(currentBackup) !== canonicalJson(safetyBackupRecord)
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new WorkspaceRestoreBoundaryError(
          "BACKUP_COLLISION",
          `Safety backup ${safetyBackupRecord.id} already contains different bytes.`,
        );
      }
      if (
        targetMigration !== undefined &&
        (migrationSourcePreverificationFailed ||
          verifiedMigrationSourceBackup === undefined ||
          verifiedMigrationSourceBackup.id !== targetMigration.backupId ||
          verifiedMigrationSourceBackup.checksum !==
            targetMigration.backupChecksum ||
          targetMigrationSourceBackup === undefined ||
          targetMigrationSourceBackup.id !== targetMigration.backupId ||
          targetMigrationSourceBackup.rawPayload !==
            verifiedMigrationSourceBackup.rawPayload ||
          targetMigrationSourceBackup.checksum !==
            verifiedMigrationSourceBackup.checksum)
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new WorkspaceRestoreBoundaryError(
          "MIGRATION_SOURCE_BACKUP_REQUIRED",
          `Restore requires verified migration source backup ${targetMigration.backupId}.`,
        );
      }
      if (
        targetMigration !== undefined &&
        migrationLineagePreverificationFailed
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new WorkspaceRestoreBoundaryError(
          "MIGRATION_LINEAGE_INVALID",
          "The migrated Workspace does not descend from its exact V1 projection and applied receipt ledger.",
        );
      }

      const requests: IDBRequest[] = [
        workspaceStore.put(targetSnapshot.workspace, CURRENT_WORKSPACE_KEY),
        receiptStore.clear(),
        outboxStore.clear(),
        migrationStore.clear(),
        backupStore.delete(CURRENT_MIGRATION_RECOVERY_KEY),
      ];
      if (targetSnapshot.workspace.migration !== undefined) {
        requests.push(migrationStore.add(targetSnapshot.workspace.migration));
      }
      if (currentBackup === undefined) {
        requests.push(backupStore.add(safetyBackupRecord));
      }
      for (const receipt of targetSnapshot.rejectedReceipts) {
        requests.push(receiptStore.add(receipt));
      }
      try {
        this.inject("restoreVerifiedBackup", transaction);
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The injected fault may already have aborted the transaction.
        }
        await completion.catch(() => undefined);
        throw error;
      }
      try {
        await Promise.all(requests.map((request) => requestResult(request)));
        await completion;
        return "restored";
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async commitMigration(inputValue: {
    sourceChecksum: string;
    workspace: WorkspaceV2;
    migrationRecord: MigrationRecord;
  }): Promise<"committed" | "already_migrated" | "revision_conflict"> {
    const input = structuredClone(inputValue);
    await assertMigrationTuple(input);
    const verifiedBackup = await this.loadVerifiedBackup(
      input.migrationRecord.backupId,
    );
    if (
      verifiedBackup === undefined ||
      verifiedBackup.checksum !== input.migrationRecord.backupChecksum
    ) {
      throw new Error(
        `Migration requires verified backup ${input.migrationRecord.backupId}.`,
      );
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [
          V2_OBJECT_STORES.workspace,
          V2_OBJECT_STORES.migrationRuns,
          V2_OBJECT_STORES.backups,
        ],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const workspaceStore = transaction.objectStore(
        V2_OBJECT_STORES.workspace,
      );
      const migrationStore = transaction.objectStore(
        V2_OBJECT_STORES.migrationRuns,
      );
      const backupStore = transaction.objectStore(V2_OBJECT_STORES.backups);
      const [current, existingMigration, storedBackup, recoveryRecord] =
        await Promise.all([
          requestResult<WorkspaceV2 | undefined>(
            workspaceStore.get(CURRENT_WORKSPACE_KEY),
          ),
          requestResult<MigrationRecord | undefined>(
            migrationStore.get(input.sourceChecksum),
          ),
          requestResult<BackupRecord | undefined>(
            backupStore.get(input.migrationRecord.backupId),
          ),
          requestResult<MigrationRecoveryRecord | undefined>(
            backupStore.get(CURRENT_MIGRATION_RECOVERY_KEY),
          ),
        ]);

      if (
        storedBackup === undefined ||
        storedBackup.id !== verifiedBackup.id ||
        storedBackup.rawPayload !== verifiedBackup.rawPayload ||
        storedBackup.checksum !== verifiedBackup.checksum
      ) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(
          `Migration backup ${input.migrationRecord.backupId} changed before atomic commit.`,
        );
      }

      if (existingMigration !== undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        return (await migrationAlreadyCommitted(
          current,
          existingMigration,
          input,
        ))
          ? "already_migrated"
          : "revision_conflict";
      }
      if (current !== undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        return "revision_conflict";
      }

      const workspaceRequest = workspaceStore.add(
        input.workspace,
        CURRENT_WORKSPACE_KEY,
      );
      const migrationRequest = migrationStore.add(input.migrationRecord);
      const clearRecoveryRequest =
        recoveryRecord !== undefined &&
        migrationRecoveryMatches(recoveryRecord.state, input.migrationRecord)
          ? backupStore.delete(CURRENT_MIGRATION_RECOVERY_KEY)
          : undefined;
      this.inject("commitMigration", transaction);
      try {
        await Promise.all([
          requestResult(workspaceRequest),
          requestResult(migrationRequest),
          ...(clearRecoveryRequest === undefined
            ? []
            : [requestResult(clearRecoveryRequest)]),
        ]);
        await completion;
        return "committed";
      } catch (error) {
        await completion.catch(() => undefined);
        if (isConstraintError(error) || isConstraintError(transaction.error)) {
          const [currentAfterRace, storedAfterRace] = await Promise.all([
            this.load(),
            this.loadMigration(input.sourceChecksum),
          ]);
          return (await migrationAlreadyCommitted(
            currentAfterRace,
            storedAfterRace,
            input,
          ))
            ? "already_migrated"
            : "revision_conflict";
        }
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async writeAndVerifyBackup(inputValue: {
    id: string;
    rawPayload: string;
    checksum: string;
  }): Promise<void> {
    const input = structuredClone(inputValue);
    if (input.id === CURRENT_MIGRATION_RECOVERY_KEY) {
      throw new Error(
        `${CURRENT_MIGRATION_RECOVERY_KEY} is a reserved mutable marker.`,
      );
    }
    if (
      input.id.trim().length === 0 ||
      input.checksum.trim().length === 0 ||
      typeof input.rawPayload !== "string"
    ) {
      throw new Error("Backup identity, bytes, and checksum are required.");
    }
    if ((await sha256Text(input.rawPayload)) !== input.checksum) {
      throw new Error(
        `Backup ${input.id} checksum does not match its raw bytes.`,
      );
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.backups);
      const existing = await requestResult<BackupRecord | undefined>(
        store.get(input.id),
      );
      if (existing !== undefined) {
        if (
          existing.rawPayload !== input.rawPayload ||
          existing.checksum !== input.checksum
        ) {
          transaction.abort();
          await completion.catch(() => undefined);
          throw new Error(
            `Backup ${input.id} is immutable and does not match.`,
          );
        }
        await completion;
        return;
      }
      const record: BackupRecord = input;
      const addRequest = store.add(record);
      const verifyRequest = store.get(input.id);
      this.inject("backup", transaction);
      try {
        const [, verified] = await Promise.all([
          requestResult(addRequest),
          requestResult<BackupRecord | undefined>(verifyRequest),
        ]);
        if (
          verified?.rawPayload !== input.rawPayload ||
          verified.checksum !== input.checksum
        ) {
          transaction.abort();
          await completion.catch(() => undefined);
          throw new Error(`Backup ${input.id} failed read-back verification.`);
        }
        await completion;
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async loadVerifiedBackup(
    idValue: string,
  ): Promise<VerifiedBackupRecord | undefined> {
    const id = structuredClone(idValue);
    if (id === CURRENT_MIGRATION_RECOVERY_KEY) {
      throw new Error(
        `${CURRENT_MIGRATION_RECOVERY_KEY} is a reserved mutable marker.`,
      );
    }
    if (id.trim().length === 0) {
      throw new Error("Backup identity is required.");
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const record = await requestResult<BackupRecord | undefined>(
        transaction.objectStore(V2_OBJECT_STORES.backups).get(id),
      );
      await completion;
      if (record === undefined) return undefined;
      if (
        record.id !== id ||
        typeof record.rawPayload !== "string" ||
        typeof record.checksum !== "string" ||
        (await sha256Text(record.rawPayload)) !== record.checksum
      ) {
        throw new Error(`Backup ${id} failed read-back checksum verification.`);
      }
      return structuredClone(record);
    } finally {
      database.close();
    }
  }

  async saveMigrationRecovery(
    stateValue: MigrationRecoveryState,
  ): Promise<void> {
    const state = structuredClone(stateValue);
    const occurredAtMilliseconds = Date.parse(state.occurredAt);
    if (
      (state.sourceChecksum !== null &&
        state.sourceChecksum.trim().length === 0) ||
      state.backupId.trim().length === 0 ||
      state.backupChecksum.trim().length === 0 ||
      state.code.trim().length === 0 ||
      state.message.trim().length === 0 ||
      !Number.isFinite(occurredAtMilliseconds) ||
      new Date(occurredAtMilliseconds).toISOString() !== state.occurredAt
    ) {
      throw new Error("A canonical migration recovery state is required.");
    }
    const backup = await this.loadVerifiedBackup(state.backupId);
    if (backup === undefined || backup.checksum !== state.backupChecksum) {
      throw new Error(
        `Migration recovery requires verified backup ${state.backupId}.`,
      );
    }
    const record: MigrationRecoveryRecord = {
      id: CURRENT_MIGRATION_RECOVERY_KEY,
      state,
    };
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const request = transaction
        .objectStore(V2_OBJECT_STORES.backups)
        .put(record);
      this.inject("saveMigrationRecovery", transaction);
      await requestResult(request);
      await completion;
    } finally {
      database.close();
    }
  }

  async loadMigrationRecovery(): Promise<MigrationRecoveryState | undefined> {
    const database = await this.open();
    let state: MigrationRecoveryState | undefined;
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const record = await requestResult<MigrationRecoveryRecord | undefined>(
        transaction
          .objectStore(V2_OBJECT_STORES.backups)
          .get(CURRENT_MIGRATION_RECOVERY_KEY),
      );
      await completion;
      state = record === undefined ? undefined : structuredClone(record.state);
    } finally {
      database.close();
    }
    if (state === undefined) return undefined;
    const backup = await this.loadVerifiedBackup(state.backupId);
    if (backup === undefined || backup.checksum !== state.backupChecksum) {
      throw new Error(
        `Migration recovery backup ${state.backupId} failed verification.`,
      );
    }
    return state;
  }

  async clearMigrationRecovery(): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const request = transaction
        .objectStore(V2_OBJECT_STORES.backups)
        .delete(CURRENT_MIGRATION_RECOVERY_KEY);
      this.inject("clearMigrationRecovery", transaction);
      await requestResult(request);
      await completion;
    } finally {
      database.close();
    }
  }

  async clearMigrationRecoveryIfMatching(
    expectedValue: MigrationRecoveryIdentity,
  ): Promise<"cleared" | "not_found" | "not_matching"> {
    const expected = structuredClone(expectedValue);
    if (
      expected.sourceChecksum.trim().length === 0 ||
      expected.backupId.trim().length === 0 ||
      expected.backupChecksum.trim().length === 0
    ) {
      throw new Error("A complete migration recovery identity is required.");
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.backups,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.backups);
      const record = await requestResult<MigrationRecoveryRecord | undefined>(
        store.get(CURRENT_MIGRATION_RECOVERY_KEY),
      );
      if (record === undefined) {
        await completion;
        return "not_found";
      }
      if (!migrationRecoveryMatches(record.state, expected)) {
        await completion;
        return "not_matching";
      }
      const request = store.delete(CURRENT_MIGRATION_RECOVERY_KEY);
      this.inject("clearMatchingMigrationRecovery", transaction);
      await requestResult(request);
      await completion;
      return "cleared";
    } finally {
      database.close();
    }
  }

  async loadMigration(
    sourceChecksum: string,
  ): Promise<MigrationRecord | undefined> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.migrationRuns,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const record = await requestResult<MigrationRecord | undefined>(
        transaction
          .objectStore(V2_OBJECT_STORES.migrationRuns)
          .get(sourceChecksum),
      );
      await completion;
      return record === undefined ? undefined : structuredClone(record);
    } finally {
      database.close();
    }
  }

  async listPendingOutbox(): Promise<SyncOutboxEntry[]> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.outbox,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const entries = await requestResult<SyncOutboxEntry[]>(
        transaction
          .objectStore(V2_OBJECT_STORES.outbox)
          .index("status")
          .getAll("pending"),
      );
      await completion;
      return structuredClone(
        entries.sort(
          (left, right) =>
            left.baseRevision - right.baseRevision ||
            left.revision - right.revision ||
            compareText(left.createdAt, right.createdAt) ||
            compareText(left.id, right.id),
        ),
      );
    } finally {
      database.close();
    }
  }

  async prepareOutboxOperation(
    idValue: string,
    operationValue: PreparedSyncOperation,
  ): Promise<SyncOutboxEntry> {
    const id = structuredClone(idValue);
    const operation = structuredClone(operationValue);
    if (
      id.trim().length === 0 ||
      operation === null ||
      typeof operation !== "object" ||
      typeof operation.operationHash !== "string" ||
      operation.operationHash.trim().length === 0 ||
      typeof operation.path !== "string" ||
      operation.path.trim().length === 0 ||
      typeof operation.envelopeJson !== "string" ||
      operation.envelopeJson.trim().length === 0
    ) {
      throw new Error(
        "Outbox identity and an exact prepared sync operation are required.",
      );
    }
    try {
      JSON.parse(operation.envelopeJson);
    } catch {
      throw new Error("Prepared sync operation envelope must be valid JSON.");
    }

    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.outbox,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.outbox);
      const entry = await requestResult<SyncOutboxEntry | undefined>(
        store.get(id),
      );
      if (entry === undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(`Outbox entry ${id} was not found.`);
      }
      if (entry.status === "sent") {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(`Outbox entry ${id} is already sent.`);
      }
      if (entry.preparedOperation !== undefined) {
        if (
          entry.preparedOperation.operationHash === operation.operationHash &&
          entry.preparedOperation.path === operation.path &&
          entry.preparedOperation.envelopeJson === operation.envelopeJson
        ) {
          await completion;
          return structuredClone(entry);
        }
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(
          `Outbox entry ${id} has a different prepared operation.`,
        );
      }

      const preparedEntry = {
        ...entry,
        preparedOperation: operation,
      } satisfies SyncOutboxEntry;
      const request = store.put(preparedEntry);
      this.inject("prepareOutboxOperation", transaction);
      try {
        await requestResult(request);
        await completion;
        return structuredClone(preparedEntry);
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async replacePreparedOutboxOperation(
    idValue: string,
    expectedOperationHashValue: string,
    operationValue: PreparedSyncOperation,
  ): Promise<SyncOutboxEntry> {
    const id = structuredClone(idValue);
    const expectedOperationHash = structuredClone(expectedOperationHashValue);
    const operation = structuredClone(operationValue);
    if (
      id.trim().length === 0 ||
      expectedOperationHash.trim().length === 0 ||
      operation === null ||
      typeof operation !== "object" ||
      typeof operation.operationHash !== "string" ||
      operation.operationHash.trim().length === 0 ||
      typeof operation.path !== "string" ||
      operation.path.trim().length === 0 ||
      typeof operation.envelopeJson !== "string" ||
      operation.envelopeJson.trim().length === 0
    ) {
      throw new Error(
        "Outbox identity, expected hash, and replacement sync operation are required.",
      );
    }
    try {
      JSON.parse(operation.envelopeJson);
    } catch {
      throw new Error(
        "Replacement sync operation envelope must be valid JSON.",
      );
    }

    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.outbox,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.outbox);
      const entry = await requestResult<SyncOutboxEntry | undefined>(
        store.get(id),
      );
      if (entry === undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(`Outbox entry ${id} was not found.`);
      }
      if (entry.status === "sent") {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(`Outbox entry ${id} is already sent.`);
      }
      if (entry.preparedOperation?.operationHash !== expectedOperationHash) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(
          `Outbox entry ${id} changed before replacement could commit.`,
        );
      }
      if (
        entry.preparedOperation.operationHash === operation.operationHash &&
        entry.preparedOperation.path === operation.path &&
        entry.preparedOperation.envelopeJson === operation.envelopeJson
      ) {
        await completion;
        return structuredClone(entry);
      }
      const replacedEntry = {
        ...entry,
        preparedOperation: operation,
      } satisfies SyncOutboxEntry;
      const request = store.put(replacedEntry);
      this.inject("replacePreparedOutboxOperation", transaction);
      try {
        await requestResult(request);
        await completion;
        return structuredClone(replacedEntry);
      } catch (error) {
        await completion.catch(() => undefined);
        throw error;
      }
    } finally {
      database.close();
    }
  }

  async markOutboxSent(
    idValue: string,
    operationHashValue: string,
    sentAtValue: ISODate,
  ): Promise<void> {
    const id = structuredClone(idValue);
    const operationHash = structuredClone(operationHashValue);
    const sentAt = structuredClone(sentAtValue);
    const sentAtMilliseconds = Date.parse(sentAt);
    if (
      id.trim().length === 0 ||
      operationHash.trim().length === 0 ||
      !Number.isFinite(sentAtMilliseconds) ||
      new Date(sentAtMilliseconds).toISOString() !== sentAt
    ) {
      throw new Error(
        "Outbox sent identity, operation hash, and canonical time are required.",
      );
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.outbox,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.outbox);
      const entry = await requestResult<SyncOutboxEntry | undefined>(
        store.get(id),
      );
      if (entry === undefined) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(`Outbox entry ${id} was not found.`);
      }
      if (entry.status === "sent") {
        if (entry.operationHash !== operationHash) {
          transaction.abort();
          await completion.catch(() => undefined);
          throw new Error(`Outbox entry ${id} has a different operation hash.`);
        }
        await completion;
        return;
      }
      if (entry.preparedOperation?.operationHash !== operationHash) {
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(
          `Outbox entry ${id} does not have the matching prepared operation.`,
        );
      }
      const request = store.put({
        ...entry,
        status: "sent",
        operationHash,
        sentAt,
      } satisfies SyncOutboxEntry);
      this.inject("markOutboxSent", transaction);
      await requestResult(request);
      await completion;
    } finally {
      database.close();
    }
  }

  async appendRejectedReceipt(receiptValue: CommandReceipt): Promise<void> {
    const receipt = structuredClone(receiptValue);
    if (receipt.status !== "rejected" || receipt.commandId !== receipt.id) {
      throw new Error("Only rejected command receipts may be appended.");
    }
    const { receiptHash, ...receiptBase } = receipt;
    if (
      (await stableHash(receiptBase as unknown as JsonValue)) !== receiptHash
    ) {
      throw new Error("Rejected command receipt hash is invalid.");
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [V2_OBJECT_STORES.workspace, V2_OBJECT_STORES.receipts],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.receipts);
      const [existing, currentWorkspace] = await Promise.all([
        requestResult<CommandReceipt | undefined>(store.get(receipt.id)),
        requestResult<WorkspaceV2 | undefined>(
          transaction
            .objectStore(V2_OBJECT_STORES.workspace)
            .get(CURRENT_WORKSPACE_KEY),
        ),
      ]);
      const appliedOwner = currentWorkspace?.commandReceipts.find(
        ({ commandId, status }) =>
          commandId === receipt.commandId && status === "applied",
      );
      if (
        appliedOwner !== undefined &&
        !isExactSystemCasRetryOverlap({
          applied: appliedOwner,
          rejected: receipt,
        })
      ) {
        await completion;
        return;
      }
      if (existing !== undefined) {
        if (canonicalJson(existing) === canonicalJson(receipt)) {
          await completion;
          return;
        }
        transaction.abort();
        await completion.catch(() => undefined);
        throw new Error(
          `Rejected receipt ${receipt.commandId} already exists with different content.`,
        );
      }
      const request = store.add(receipt);
      this.inject("appendRejectedReceipt", transaction);
      await requestResult(request);
      await completion;
    } finally {
      database.close();
    }
  }

  async findReceipt(commandId: string): Promise<CommandReceipt | undefined> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [V2_OBJECT_STORES.workspace, V2_OBJECT_STORES.receipts],
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const [workspace, rejectedReceipt] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          transaction
            .objectStore(V2_OBJECT_STORES.workspace)
            .get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<CommandReceipt | undefined>(
          transaction.objectStore(V2_OBJECT_STORES.receipts).get(commandId),
        ),
      ]);
      await completion;
      const appliedReceipt = workspace?.commandReceipts.find(
        (receipt) =>
          receipt.commandId === commandId && receipt.status === "applied",
      );
      const receipt = appliedReceipt ?? rejectedReceipt;
      return receipt === undefined ? undefined : structuredClone(receipt);
    } finally {
      database.close();
    }
  }

  async listReceipts(): Promise<CommandReceipt[]> {
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.receipts,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const receipts = await requestResult<CommandReceipt[]>(
        transaction.objectStore(V2_OBJECT_STORES.receipts).getAll(),
      );
      await completion;
      return structuredClone(
        receipts.sort(
          (left, right) =>
            compareText(left.createdAt, right.createdAt) ||
            compareText(left.id, right.id),
        ),
      );
    } finally {
      database.close();
    }
  }
}
