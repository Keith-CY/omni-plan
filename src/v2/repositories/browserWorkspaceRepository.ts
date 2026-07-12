import type { ISODate } from "@/domain/types";

import type { CommandContext, V2Command } from "../domain/commands";
import { sha256Text, stableHash } from "../domain/stableHash";
import type {
  CommandReceipt,
  JsonValue,
  MigrationRecord,
  WorkspaceV2,
} from "../domain/types";
import type { MigrationRecoveryState } from "../migration/recovery";
import {
  openV2Database,
  requestResult,
  transactionComplete,
  V2_DATABASE_NAME,
  V2_OBJECT_STORES,
} from "./indexedDb";

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

export interface MigrationWorkspaceRepository
  extends AtomicWorkspaceRepository {
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
  | "appendRejectedReceipt";

export interface BrowserWorkspaceRepositoryOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  /** Test/diagnostic fault injection. Called only after all writes are queued. */
  beforeTransactionComplete?: (
    operation: RepositoryTransactionOperation,
    transaction: IDBTransaction,
  ) => void;
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

async function sameStableValue(left: unknown, right: unknown): Promise<boolean> {
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
    throw new Error("Invalid atomic command tuple: Workspace revision mismatch.");
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
  const finalReceipt = workspace.commandReceipts[workspace.commandReceipts.length - 1];
  if (
    matchingReceipts.length !== 1 ||
    finalReceipt?.commandId !== outboxEntry.commandId
  ) {
    throw new Error("Invalid atomic command tuple: applied receipt identity mismatch.");
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
    throw new Error("Invalid atomic command tuple: applied receipt fields mismatch.");
  }

  const payloadHash = await stableHash(outboxEntry.command as unknown as JsonValue);
  if (payloadHash !== receipt.payloadHash) {
    throw new Error("Invalid atomic command tuple: command payload hash mismatch.");
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

export class BrowserWorkspaceRepository implements AtomicWorkspaceRepository {
  readonly databaseName: string;
  private readonly indexedDB: IDBFactory | undefined;
  private readonly beforeTransactionComplete:
    | BrowserWorkspaceRepositoryOptions["beforeTransactionComplete"]
    | undefined;

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
        transaction.objectStore(V2_OBJECT_STORES.workspace).get(
          CURRENT_WORKSPACE_KEY,
        ),
      );
      await completion;
      return workspace === undefined ? undefined : structuredClone(workspace);
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
        [V2_OBJECT_STORES.workspace, V2_OBJECT_STORES.outbox],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const workspaceStore = transaction.objectStore(V2_OBJECT_STORES.workspace);
      const current = await requestResult<WorkspaceV2 | undefined>(
        workspaceStore.get(CURRENT_WORKSPACE_KEY),
      );
      if (
        current === undefined ||
        current.workspaceId !== input.workspace.workspaceId ||
        current.revision !== input.expectedRevision
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
      const workspaceStore = transaction.objectStore(V2_OBJECT_STORES.workspace);
      const migrationStore = transaction.objectStore(
        V2_OBJECT_STORES.migrationRuns,
      );
      const backupStore = transaction.objectStore(V2_OBJECT_STORES.backups);
      const [current, existingMigration, storedBackup, recoveryRecord] = await Promise.all([
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
        return await migrationAlreadyCommitted(
          current,
          existingMigration,
          input,
        )
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
          return await migrationAlreadyCommitted(
            currentAfterRace,
            storedAfterRace,
            input,
          )
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
    if (
      input.id.trim().length === 0 ||
      input.checksum.trim().length === 0 ||
      typeof input.rawPayload !== "string"
    ) {
      throw new Error("Backup identity, bytes, and checksum are required.");
    }
    if ((await sha256Text(input.rawPayload)) !== input.checksum) {
      throw new Error(`Backup ${input.id} checksum does not match its raw bytes.`);
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
          throw new Error(`Backup ${input.id} is immutable and does not match.`);
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
      (state.sourceChecksum !== null && state.sourceChecksum.trim().length === 0) ||
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
      const entry = await requestResult<SyncOutboxEntry | undefined>(store.get(id));
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
        throw new Error(`Outbox entry ${id} has a different prepared operation.`);
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
      throw new Error("Replacement sync operation envelope must be valid JSON.");
    }

    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.outbox,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.outbox);
      const entry = await requestResult<SyncOutboxEntry | undefined>(store.get(id));
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
      const entry = await requestResult<SyncOutboxEntry | undefined>(store.get(id));
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
    if ((await stableHash(receiptBase as unknown as JsonValue)) !== receiptHash) {
      throw new Error("Rejected command receipt hash is invalid.");
    }
    const database = await this.open();
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.receipts,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const store = transaction.objectStore(V2_OBJECT_STORES.receipts);
      const existing = await requestResult<CommandReceipt | undefined>(
        store.get(receipt.id),
      );
      if (existing !== undefined) {
        if (await sameStableValue(existing, receipt)) {
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
        V2_OBJECT_STORES.receipts,
        "readonly",
      );
      const completion = transactionComplete(transaction);
      const receipt = await requestResult<CommandReceipt | undefined>(
        transaction.objectStore(V2_OBJECT_STORES.receipts).get(commandId),
      );
      await completion;
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
