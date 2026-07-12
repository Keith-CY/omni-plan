import type { ISODate } from "@/domain/types";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import type { CommandReceipt, WorkspaceV2 } from "../domain/types";
import type {
  PreparedSyncOperation,
  SyncOutboxEntry,
  SyncOutboxRepository,
} from "./browserWorkspaceRepository";
import {
  advanceSyncManifestV2,
  createSyncManifestV2,
  createSyncOperationV2,
  decryptAndVerifySyncOperationV2,
  parseSyncEnvelopeV2,
  parseSyncManifestV2,
  SyncProtocolError,
  syncManifestPathV2,
  syncOperationPathV2,
  type CreatedSyncOperationV2,
  type SyncManifestHeadV2,
  type SyncManifestV2,
  type VerifiedSyncHistory,
} from "./syncProtocol";
import { materializeRemoteSyncHistoryV2 } from "./syncMerge";

export interface SyncRemoteFileV2 {
  content: string;
  /** Opaque provider revision used only for manifest compare-and-swap. */
  version: string;
}

export interface SyncRemotePortV2 {
  read(path: string): Promise<SyncRemoteFileV2 | undefined>;
  list(prefix: string): Promise<readonly string[]>;
  /** Create once, or succeed only when the existing bytes are identical. */
  putImmutable(path: string, content: string): Promise<void>;
  compareAndSwap(
    path: string,
    expectedVersion: string | undefined,
    content: string,
  ): Promise<boolean>;
}

export interface SyncKeyProviderV2 {
  getPassphrase(): Promise<string | undefined>;
}

export type SyncAdapterErrorCode =
  | "SYNC_KEY_LOCKED"
  | "WORKSPACE_NOT_READY"
  | "REMOTE_READ_FAILED"
  | "REMOTE_MANIFEST_INVALID"
  | "LOCAL_RECEIPT_MISSING"
  | "LOCAL_OUTBOX_INVALID"
  | "REMOTE_ANCESTRY_REQUIRED"
  | "ENCRYPTION_FAILED"
  | "PREPARED_OPERATION_INVALID"
  | "IMMUTABLE_UPLOAD_FAILED"
  | "MANIFEST_CONFLICT"
  | "MANIFEST_WRITE_FAILED";

export class SyncAdapterError extends Error {
  readonly cause: unknown;

  constructor(
    readonly code: SyncAdapterErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SyncAdapterError";
    this.cause = cause;
  }
}

export interface SyncAdapterV2Options {
  repository: SyncOutboxRepository;
  remote: SyncRemotePortV2;
  workspaceId: string;
  deviceId: string;
  keyProvider: SyncKeyProviderV2;
  clock: () => ISODate;
  createOperation?: typeof createSyncOperationV2;
}

export interface SyncFlushResultV2 {
  sent: number;
  pending: number;
}

interface ReadManifest {
  manifest: Readonly<SyncManifestV2>;
  version: string | undefined;
}

function exactSource(left: CommandReceipt, entry: SyncOutboxEntry): boolean {
  return canonicalJson(left.source) === canonicalJson(entry.actor.source);
}

function localReceiptFor(
  workspace: WorkspaceV2,
  entry: SyncOutboxEntry,
): CommandReceipt {
  const matches = workspace.commandReceipts.filter(
    (receipt) =>
      receipt.status === "applied" &&
      receipt.id === entry.receiptId &&
      receipt.commandId === entry.commandId,
  );
  const receipt = matches.length === 1 ? matches[0] : undefined;
  if (receipt === undefined) {
    throw new SyncAdapterError(
      "LOCAL_RECEIPT_MISSING",
      `Pending outbox entry ${entry.id} has no unique applied receipt.`,
    );
  }
  if (
    receipt.commandType !== entry.command.type ||
    receipt.baseRevision !== entry.baseRevision ||
    receipt.revision !== entry.revision ||
    receipt.payloadHash !== entry.payloadHash ||
    receipt.actorId !== entry.actor.actorId ||
    receipt.actorKind !== entry.actor.actorKind ||
    receipt.origin !== entry.actor.origin ||
    receipt.createdAt !== entry.createdAt ||
    !exactSource(receipt, entry)
  ) {
    throw new SyncAdapterError(
      "LOCAL_OUTBOX_INVALID",
      `Pending outbox entry ${entry.id} does not match its applied receipt.`,
    );
  }
  return structuredClone(receipt);
}

interface VerifiedHistoricalParent {
  operationHash: string;
  revision: number;
}

function selectCausalParent(
  manifest: Readonly<SyncManifestV2>,
  entry: SyncOutboxEntry,
  deviceId: string,
  verifiedHistoricalParent?: VerifiedHistoricalParent,
): { deviceId: string; sequence: number; previousOperationHash?: string } {
  const localBranchHeads = Object.entries(manifest.heads)
    .filter(
      ([candidateDeviceId, head]) =>
        (candidateDeviceId === deviceId ||
          candidateDeviceId.startsWith(`${deviceId}~fork-`)) &&
        head.revision === entry.baseRevision,
    )
    .sort(
      ([leftDeviceId, left], [rightDeviceId, right]) =>
        (leftDeviceId === deviceId ? -1 : rightDeviceId === deviceId ? 1 : 0) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        leftDeviceId.localeCompare(rightDeviceId),
    );
  const localBranch = localBranchHeads[0];
  if (localBranch !== undefined) {
    const [writeDeviceId, head] = localBranch;
    return {
      deviceId: writeDeviceId,
      sequence: head.sequence + 1,
      previousOperationHash: head.operationHash,
    };
  }

  if (verifiedHistoricalParent !== undefined) {
    if (verifiedHistoricalParent.revision !== entry.baseRevision) {
      throw new SyncAdapterError(
        "REMOTE_ANCESTRY_REQUIRED",
        "The verified historical parent does not match the pending command base revision.",
      );
    }
    const writeDeviceId = `${deviceId}~fork-${entry.commandId}`;
    if (manifest.heads[writeDeviceId] !== undefined) {
      throw new SyncAdapterError(
        "REMOTE_ANCESTRY_REQUIRED",
        "The deterministic local historical fork is already occupied.",
      );
    }
    return {
      deviceId: writeDeviceId,
      sequence: 1,
      previousOperationHash: verifiedHistoricalParent.operationHash,
    };
  }

  const heads = Object.values(manifest.heads);
  if (entry.baseRevision === 0) {
    const writeDeviceId =
      manifest.heads[deviceId] === undefined
        ? deviceId
        : `${deviceId}~fork-${entry.commandId}`;
    if (manifest.heads[writeDeviceId] !== undefined) {
      throw new SyncAdapterError(
        "REMOTE_ANCESTRY_REQUIRED",
        "No unused local sync branch can preserve the revision-zero command.",
      );
    }
    return { deviceId: writeDeviceId, sequence: 1 };
  }
  if (heads.length === 0) {
    throw new SyncAdapterError(
      "REMOTE_ANCESTRY_REQUIRED",
      "A non-root local command cannot initialize an empty remote history.",
    );
  }

  const candidates = heads
    .filter((head) => head.revision === entry.baseRevision)
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.operationHash.localeCompare(left.operationHash),
    );
  if (candidates.length === 0) {
    throw new SyncAdapterError(
      "REMOTE_ANCESTRY_REQUIRED",
      "No current remote head matches the pending command base revision.",
    );
  }
  const writeDeviceId =
    manifest.heads[deviceId] === undefined
      ? deviceId
      : `${deviceId}~fork-${entry.commandId}`;
  if (manifest.heads[writeDeviceId] !== undefined) {
    throw new SyncAdapterError(
      "REMOTE_ANCESTRY_REQUIRED",
      "No unused local sync fork can preserve the pending command ancestry.",
    );
  }
  return {
    deviceId: writeDeviceId,
    sequence: 1,
    previousOperationHash: candidates[0].operationHash,
  };
}

function isLocalBranchDeviceId(
  candidate: string,
  configuredDeviceId: string,
): boolean {
  return (
    candidate === configuredDeviceId ||
    candidate.startsWith(`${configuredDeviceId}~fork-`)
  );
}

function isHeadForOperation(
  head: SyncManifestHeadV2 | undefined,
  operation: CreatedSyncOperationV2,
): boolean {
  return (
    head?.sequence === operation.envelope.sequence &&
    head.operationHash === operation.operationHash &&
    head.revision === operation.envelope.revision
  );
}

export class SyncAdapterV2 {
  readonly #repository: SyncOutboxRepository;
  readonly #remote: SyncRemotePortV2;
  readonly #workspaceId: string;
  readonly #deviceId: string;
  readonly #keyProvider: SyncKeyProviderV2;
  readonly #clock: () => ISODate;
  readonly #createOperation: typeof createSyncOperationV2;

  constructor(options: SyncAdapterV2Options) {
    this.#repository = options.repository;
    this.#remote = options.remote;
    this.#workspaceId = options.workspaceId;
    this.#deviceId = options.deviceId;
    this.#keyProvider = options.keyProvider;
    this.#clock = options.clock;
    this.#createOperation = options.createOperation ?? createSyncOperationV2;
  }

  async flushPending(): Promise<SyncFlushResultV2> {
    const pending = await this.#repository.listPendingOutbox();
    if (pending.length === 0) return { sent: 0, pending: 0 };

    const passphrase = await this.#keyProvider.getPassphrase();
    if (passphrase === undefined || passphrase.trim().length === 0) {
      throw new SyncAdapterError(
        "SYNC_KEY_LOCKED",
        "Unlock the sync key before flushing pending operations.",
      );
    }
    const workspace = await this.#repository.load();
    if (workspace === undefined || workspace.workspaceId !== this.#workspaceId) {
      throw new SyncAdapterError(
        "WORKSPACE_NOT_READY",
        "The expected V2 Workspace must be bootstrapped before sync.",
      );
    }

    let sent = 0;
    for (const entry of pending) {
      await this.#flushEntry(workspace, entry, passphrase);
      sent += 1;
    }
    return {
      sent,
      pending: (await this.#repository.listPendingOutbox()).length,
    };
  }

  async #readManifest(createdAt: ISODate): Promise<ReadManifest> {
    const path = syncManifestPathV2(this.#workspaceId);
    let remoteFile: SyncRemoteFileV2 | undefined;
    try {
      remoteFile = await this.#remote.read(path);
    } catch (error) {
      throw new SyncAdapterError(
        "REMOTE_READ_FAILED",
        "The V2 sync manifest could not be read.",
        error,
      );
    }
    if (remoteFile === undefined) {
      return {
        manifest: createSyncManifestV2({
          workspaceId: this.#workspaceId,
          updatedAt: createdAt,
        }),
        version: undefined,
      };
    }
    if (
      typeof remoteFile.content !== "string" ||
      typeof remoteFile.version !== "string" ||
      remoteFile.version.trim().length === 0
    ) {
      throw new SyncAdapterError(
        "REMOTE_MANIFEST_INVALID",
        "The remote V2 manifest file is malformed.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(remoteFile.content);
    } catch (error) {
      throw new SyncAdapterError(
        "REMOTE_MANIFEST_INVALID",
        "The remote V2 manifest is not valid JSON.",
        error,
      );
    }
    const manifest = parseSyncManifestV2(parsed);
    if (manifest.workspaceId !== this.#workspaceId) {
      throw new SyncAdapterError(
        "REMOTE_MANIFEST_INVALID",
        "The remote manifest belongs to another Workspace.",
      );
    }
    return { manifest, version: remoteFile.version };
  }

  async #flushEntry(
    workspace: WorkspaceV2,
    initialEntry: SyncOutboxEntry,
    passphrase: string,
  ): Promise<void> {
    const receipt = localReceiptFor(workspace, initialEntry);
    const current = await this.#readManifest(initialEntry.createdAt);
    let entry = initialEntry;
    let operation: CreatedSyncOperationV2;

    if (entry.preparedOperation === undefined) {
      const prepared = await this.#createPreparedOperation(
        current.manifest,
        entry,
        receipt,
        passphrase,
      );
      try {
        entry = await this.#repository.prepareOutboxOperation(entry.id, prepared);
      } catch (error) {
        // Another tab can win the random encryption race. Its persisted upload
        // unit is authoritative; never generate or upload a second ciphertext.
        const winner = (await this.#repository.listPendingOutbox()).find(
          ({ id }) => id === entry.id,
        );
        if (winner?.preparedOperation === undefined) throw error;
        entry = winner;
      }
    }
    operation = await this.#verifyPrepared(entry, receipt, passphrase);
    let operationHead = current.manifest.heads[operation.envelope.deviceId];
    let nextManifest: Readonly<SyncManifestV2> | undefined;
    if (!isHeadForOperation(operationHead, operation)) {
      try {
        nextManifest = await advanceSyncManifestV2(current.manifest, operation);
      } catch (error) {
        if (
          !(error instanceof SyncProtocolError) ||
          (error.code !== "BROKEN_HASH_CHAIN" &&
            error.code !== "MISSING_ANCESTOR")
        ) {
          throw error;
        }
        const stalePrepared = entry.preparedOperation;
        if (stalePrepared === undefined) throw error;
        const history = await this.#materializeCurrentHistory(
          current.manifest,
          passphrase,
        );
        const historicalParent = this.#verifiedHistoricalParent(
          history,
          operation,
          entry,
        );
        const replacement = await this.#createPreparedOperation(
          current.manifest,
          entry,
          receipt,
          passphrase,
          historicalParent,
        );
        try {
          entry = await this.#repository.replacePreparedOutboxOperation(
            entry.id,
            stalePrepared.operationHash,
            replacement,
          );
        } catch (replaceError) {
          const winner = (await this.#repository.listPendingOutbox()).find(
            ({ id }) => id === entry.id,
          );
          if (
            winner?.preparedOperation === undefined ||
            winner.preparedOperation.operationHash === stalePrepared.operationHash
          ) {
            throw replaceError;
          }
          entry = winner;
        }
        operation = await this.#verifyPrepared(entry, receipt, passphrase);
        operationHead = current.manifest.heads[operation.envelope.deviceId];
        nextManifest = isHeadForOperation(operationHead, operation)
          ? undefined
          : await advanceSyncManifestV2(current.manifest, operation, {
              verifiedHistory: history,
            });
      }
    }

    try {
      await this.#remote.putImmutable(
        operation.path,
        entry.preparedOperation!.envelopeJson,
      );
    } catch (error) {
      throw new SyncAdapterError(
        "IMMUTABLE_UPLOAD_FAILED",
        "The immutable V2 sync operation could not be uploaded.",
        error,
      );
    }

    if (nextManifest !== undefined) {
      let committed: boolean;
      try {
        committed = await this.#remote.compareAndSwap(
          syncManifestPathV2(this.#workspaceId),
          current.version,
          canonicalJson(nextManifest),
        );
      } catch (error) {
        throw new SyncAdapterError(
          "MANIFEST_WRITE_FAILED",
          "The V2 sync manifest could not be compare-and-swapped.",
          error,
        );
      }
      if (!committed) {
        throw new SyncAdapterError(
          "MANIFEST_CONFLICT",
          "The V2 sync manifest advanced concurrently; merge before retrying.",
        );
      }
    }

    await this.#repository.markOutboxSent(
      entry.id,
      operation.operationHash,
      this.#clock(),
    );
  }

  async #materializeCurrentHistory(
    manifest: Readonly<SyncManifestV2>,
    passphrase: string,
  ): Promise<VerifiedSyncHistory> {
    let history: VerifiedSyncHistory;
    try {
      history = await materializeRemoteSyncHistoryV2({
        remote: this.#remote,
        workspaceId: this.#workspaceId,
        passphrase,
      });
    } catch (error) {
      throw new SyncAdapterError(
        "REMOTE_ANCESTRY_REQUIRED",
        "The stale pending operation parent could not be proven from remote history.",
        error,
      );
    }
    if (canonicalJson(history.manifest) !== canonicalJson(manifest)) {
      throw new SyncAdapterError(
        "MANIFEST_CONFLICT",
        "The remote manifest changed while historical ancestry was being verified.",
      );
    }
    return history;
  }

  #verifiedHistoricalParent(
    history: VerifiedSyncHistory,
    operation: CreatedSyncOperationV2,
    entry: SyncOutboxEntry,
  ): VerifiedHistoricalParent {
    const parentHash = operation.envelope.previousOperationHash;
    const parent =
      parentHash === undefined
        ? undefined
        : history.operations.find(
            ({ operationHash }) => operationHash === parentHash,
          );
    if (parent === undefined || parent.receipt.revision !== entry.baseRevision) {
      throw new SyncAdapterError(
        "REMOTE_ANCESTRY_REQUIRED",
        "The stale pending operation does not name an exact reachable parent at its base revision.",
      );
    }
    return {
      operationHash: parent.operationHash,
      revision: parent.receipt.revision,
    };
  }

  async #createPreparedOperation(
    manifest: Readonly<SyncManifestV2>,
    entry: SyncOutboxEntry,
    receipt: CommandReceipt,
    passphrase: string,
    verifiedHistoricalParent?: VerifiedHistoricalParent,
  ): Promise<PreparedSyncOperation> {
    const causal = selectCausalParent(
      manifest,
      entry,
      this.#deviceId,
      verifiedHistoricalParent,
    );
    let created: CreatedSyncOperationV2;
    try {
      created = await this.#createOperation({
        workspaceId: this.#workspaceId,
        deviceId: causal.deviceId,
        sequence: causal.sequence,
        // A command may be replayed into another causal branch while keeping
        // its authority-bearing commandId. Immutable operation identity must
        // therefore include the branch coordinate rather than aliasing the
        // command identity.
        operationId: `operation-${causal.deviceId}-${causal.sequence}-${entry.commandId}`,
        command: structuredClone(entry.command),
        receipt,
        ...(causal.previousOperationHash === undefined
          ? {}
          : { previousOperationHash: causal.previousOperationHash }),
        passphrase,
      });
    } catch (error) {
      if (error instanceof SyncProtocolError) throw error;
      throw new SyncAdapterError(
        "ENCRYPTION_FAILED",
        "The pending command could not be encrypted.",
        error,
      );
    }
    return {
      operationHash: created.operationHash,
      path: created.path,
      envelopeJson: canonicalJson(created.envelope),
    };
  }

  async #verifyPrepared(
    entry: SyncOutboxEntry,
    localReceipt: CommandReceipt,
    passphrase: string,
  ): Promise<CreatedSyncOperationV2> {
    const prepared = entry.preparedOperation;
    if (prepared === undefined) {
      throw new SyncAdapterError(
        "PREPARED_OPERATION_INVALID",
        "The pending entry has no persisted encrypted operation.",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(prepared.envelopeJson);
    } catch (error) {
      throw new SyncAdapterError(
        "PREPARED_OPERATION_INVALID",
        "The persisted encrypted operation is not valid JSON.",
        error,
      );
    }
    const envelope = parseSyncEnvelopeV2(parsed);
    const canonicalEnvelope = canonicalJson(envelope);
    const operationHash = await sha256Hex(canonicalEnvelope);
    const expectedPath = syncOperationPathV2(
      envelope.workspaceId,
      envelope.deviceId,
      envelope.sequence,
      operationHash,
    );
    if (
      prepared.envelopeJson !== canonicalEnvelope ||
      prepared.operationHash !== operationHash ||
      prepared.path !== expectedPath ||
      envelope.workspaceId !== entry.workspaceId ||
      envelope.workspaceId !== this.#workspaceId ||
      !isLocalBranchDeviceId(envelope.deviceId, this.#deviceId) ||
      envelope.commandId !== entry.commandId ||
      envelope.baseRevision !== entry.baseRevision ||
      envelope.revision !== entry.revision ||
      envelope.payloadHash !== entry.payloadHash ||
      envelope.createdAt !== entry.createdAt
    ) {
      throw new SyncAdapterError(
        "PREPARED_OPERATION_INVALID",
        "The persisted encrypted operation does not match its pending entry.",
      );
    }
    const replay = await decryptAndVerifySyncOperationV2({
      envelope,
      path: prepared.path,
      passphrase,
      expectedWorkspaceId: this.#workspaceId,
      expectedDeviceId: envelope.deviceId,
      expectedSequence: envelope.sequence,
      expectedOperationHash: prepared.operationHash,
    });
    if (
      replay.receipt.receiptHash !== localReceipt.receiptHash ||
      canonicalJson(replay.command) !== canonicalJson(entry.command)
    ) {
      throw new SyncAdapterError(
        "PREPARED_OPERATION_INVALID",
        "The persisted operation does not contain the local applied receipt.",
      );
    }
    return Object.freeze({
      envelope,
      operationHash,
      path: prepared.path,
    });
  }
}
