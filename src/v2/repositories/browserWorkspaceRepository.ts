import type { ISODate } from "@/domain/types";

import type { CommandContext, V2Command } from "../domain/commands";
import { stableHash } from "../domain/stableHash";
import type {
  CommandReceipt,
  JsonValue,
  MigrationRecord,
  WorkspaceV2,
} from "../domain/types";
import {
  openV2Database,
  requestResult,
  transactionComplete,
  V2_DATABASE_NAME,
  V2_OBJECT_STORES,
} from "./indexedDb";

const CURRENT_WORKSPACE_KEY = "current";

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
  sentAt?: ISODate;
  operationHash?: string;
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

export type RepositoryTransactionOperation =
  | "initialize"
  | "commit"
  | "commitMigration"
  | "backup"
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

interface BackupRecord {
  id: string;
  rawPayload: string;
  checksum: string;
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
  if (
    outboxEntry.workspaceId !== workspace.workspaceId ||
    outboxEntry.baseRevision !== expectedRevision ||
    outboxEntry.revision !== workspace.revision ||
    outboxEntry.status !== "pending" ||
    outboxEntry.sentAt !== undefined ||
    outboxEntry.operationHash !== undefined ||
    outboxEntry.id !== `outbox-${outboxEntry.commandId}`
  ) {
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
    const database = await this.open();
    try {
      const transaction = database.transaction(
        [V2_OBJECT_STORES.workspace, V2_OBJECT_STORES.migrationRuns],
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      const workspaceStore = transaction.objectStore(V2_OBJECT_STORES.workspace);
      const migrationStore = transaction.objectStore(
        V2_OBJECT_STORES.migrationRuns,
      );
      const [current, existingMigration] = await Promise.all([
        requestResult<WorkspaceV2 | undefined>(
          workspaceStore.get(CURRENT_WORKSPACE_KEY),
        ),
        requestResult<MigrationRecord | undefined>(
          migrationStore.get(input.sourceChecksum),
        ),
      ]);

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
      this.inject("commitMigration", transaction);
      try {
        await Promise.all([
          requestResult(workspaceRequest),
          requestResult(migrationRequest),
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
            compareText(left.createdAt, right.createdAt) ||
            compareText(left.id, right.id),
        ),
      );
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
