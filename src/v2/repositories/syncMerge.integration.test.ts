import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../../domain/canonical";
import {
  executeCommand,
  type CommandContext,
  type DailyCommitmentDraft,
  type V2Command,
} from "../domain/commands";
import {
  buildReplanProposal,
  generateTodayProposal,
} from "../domain/today";
import { deriveReviewQueue } from "../domain/review";
import { stableHash } from "../domain/stableHash";
import type { CommandReceipt, JsonValue, WorkspaceV2 } from "../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildCommandContext,
  buildDirectionBrief,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  advanceSyncManifestV2,
  authorizeSyncBranchV2,
  createSyncManifestV2,
  createSyncOperationV2,
  syncManifestPathV2,
  type CreatedSyncOperationV2,
} from "./syncProtocol";
import {
  BrowserWorkspaceRepository,
  type AtomicWorkspaceRepository,
} from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import { deleteV2Database } from "./indexedDb";
import { authorizeConflictOpenFromResolutionBranchesV2 } from "./syncConflictOpenAuthorization";
import {
  materializeRemoteSyncHistoryV2,
  SyncMergeV2,
  SyncMergeError,
  syncOperationsPrefixV2,
  type SyncRemoteHistoryPortV2,
} from "./syncMerge";
import {
  SyncAdapterV2,
  type SyncRemotePortV2,
} from "./syncAdapter";

const PASSPHRASE = "correct horse battery staple";
const NOW = "2026-07-12T05:00:00.000Z";
const WORKSPACE_ID = "workspace-sync-merge";

interface AppliedOperation {
  workspace: WorkspaceV2;
  command: V2Command;
  context: CommandContext;
  receipt: CommandReceipt;
  created: CreatedSyncOperationV2;
}

async function commandOperation(input: {
  workspace: WorkspaceV2;
  command: V2Command;
  commandId: string;
  deviceId: string;
  sequence: number;
  now?: string;
  previousOperationHash?: string;
  actorId?: string;
  actorKind?: CommandContext["actorKind"];
  origin?: CommandContext["origin"];
  source?: CommandContext["source"];
}): Promise<AppliedOperation> {
  const context = buildCommandContext({
    commandId: input.commandId,
    expectedRevision: input.workspace.revision,
    actorId: input.actorId ?? `human-${input.deviceId}`,
    actorKind: input.actorKind ?? "human",
    origin: input.origin ?? "ui",
    source:
      input.source ??
      {
        sourceId: `verified-${input.deviceId}`,
        verified: true,
        capabilities: ["human_decision"],
      },
    now: input.now ?? NOW,
  });
  const result = await executeCommand(
    input.workspace,
    input.command,
    context,
  );
  if (!result.ok) {
    throw new Error(
      `Expected ${input.commandId} to apply: ${result.rejection.code} ${result.rejection.gate ?? ""} ${result.rejection.reason}`,
    );
  }
  const created = await createSyncOperationV2({
    workspaceId: WORKSPACE_ID,
    deviceId: input.deviceId,
    sequence: input.sequence,
    operationId: `operation-${input.deviceId}-${input.sequence}-${input.commandId}`,
    command: input.command,
    receipt: result.receipt,
    ...(input.previousOperationHash === undefined
      ? {}
      : { previousOperationHash: input.previousOperationHash }),
    passphrase: PASSPHRASE,
  });
  return {
    workspace: result.workspace,
    command: input.command,
    context,
    receipt: result.receipt,
    created,
  };
}

async function captureOperation(
  input: Omit<Parameters<typeof commandOperation>[0], "command">,
): Promise<AppliedOperation> {
  return commandOperation({
    ...input,
    command: {
      type: "capture_inbox",
      id: `inbox-${input.commandId}`,
      text: `Captured by ${input.commandId}`,
    },
  });
}

class MemoryHistoryRemote
  implements SyncRemoteHistoryPortV2, SyncRemotePortV2
{
  readonly files = new Map<string, { content: string; version: string }>();
  #version = 1;

  async read(path: string) {
    return structuredClone(this.files.get(path));
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  async putImmutable(path: string, content: string): Promise<void> {
    const existing = this.files.get(path);
    if (existing !== undefined) {
      if (existing.content !== content) throw new Error("immutable collision");
      return;
    }
    this.files.set(path, {
      content,
      version: `operation-${++this.#version}`,
    });
  }

  async compareAndSwap(
    path: string,
    expectedVersion: string | undefined,
    content: string,
  ): Promise<boolean> {
    const existing = this.files.get(path);
    if (existing?.version !== expectedVersion) return false;
    if (existing === undefined && expectedVersion !== undefined) return false;
    this.files.set(path, {
      content,
      version: `manifest-${++this.#version}`,
    });
    return true;
  }

  put(path: string, value: unknown, version = "v1"): void {
    this.files.set(path, { content: canonicalJson(value), version });
  }
}

const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseNames.map((databaseName) =>
      deleteV2Database({ databaseName, indexedDB: indexedDBFactory }).catch(
        () => undefined,
      ),
    ),
  );
  databaseNames.length = 0;
});

const indexedDBFactory = new IDBFactory();

async function persistAsSent(
  repository: BrowserWorkspaceRepository,
  operation: AppliedOperation,
): Promise<void> {
  const result = await new CommandService(repository, WORKSPACE_ID).dispatch(
    operation.command,
    operation.context,
  );
  if (!result.ok) {
    throw new Error(
      `Expected local seed ${operation.context.commandId}: ${result.rejection.code}`,
    );
  }
  const outboxId = `outbox-${operation.context.commandId}`;
  await repository.prepareOutboxOperation(outboxId, {
    operationHash: operation.created.operationHash,
    path: operation.created.path,
    envelopeJson: canonicalJson(operation.created.envelope),
  });
  await repository.markOutboxSent(
    outboxId,
    operation.created.operationHash,
    operation.context.now,
  );
}

interface OpenDailyConflictFixture {
  genesis: WorkspaceV2;
  ancestor: AppliedOperation;
  localWriter: AppliedOperation;
  remoteWriter: AppliedOperation;
  openWorkspace: WorkspaceV2;
  openOperation: CreatedSyncOperationV2;
  conflict: WorkspaceV2["syncConflicts"][number] & {
    localBundle: NonNullable<WorkspaceV2["syncConflicts"][number]["localBundle"]>;
    remoteBundle: NonNullable<WorkspaceV2["syncConflicts"][number]["remoteBundle"]>;
  };
  remote: MemoryHistoryRemote;
  repository: BrowserWorkspaceRepository;
}

async function openDailyConflictFixture(
  prefix: string,
): Promise<OpenDailyConflictFixture> {
  const genesis = buildWorkspaceV2(WORKSPACE_ID);
  const profile = buildCapacityProfile({
    timeZone: "UTC",
    weeklyWindows: [{ weekday: 0, startMinute: 360, finishMinute: 480 }],
    dailyBudgets: [
      {
        weekday: 0,
        deepSeconds: 3_600,
        mediumSeconds: 3_600,
        shallowSeconds: 3_600,
      },
    ],
    unavailableBlocks: [],
    updatedAt: "2026-07-12T04:00:00.000Z",
    updatedBy: `human-${prefix}-seed`,
  });
  const ancestor = await commandOperation({
    workspace: genesis,
    command: { type: "configure_capacity", profile },
    commandId: `${prefix}-capacity-ancestor`,
    deviceId: `${prefix}-seed`,
    sequence: 1,
    now: "2026-07-12T04:00:00.000Z",
  });
  const proposal = await generateTodayProposal(
    ancestor.workspace,
    "2026-07-12",
    "2026-07-12T05:00:00.000Z",
  );
  const commitment: DailyCommitmentDraft = {
    id: `${prefix}-commitment`,
    localDate: proposal.localDate,
    workspaceRevision: proposal.workspaceRevision,
    generatedAt: proposal.generatedAt,
    proposalHash: proposal.proposalHash,
    slots: structuredClone(proposal.slots),
  };
  const localWriter = await commandOperation({
    workspace: ancestor.workspace,
    command: { type: "commit_today", commitment },
    commandId: `${prefix}-commit-local`,
    deviceId: `${prefix}-desktop`,
    sequence: 1,
    now: "2026-07-12T05:01:00.000Z",
    actorId: `${prefix}-local-human`,
    previousOperationHash: ancestor.created.operationHash,
  });
  const remoteWriter = await commandOperation({
    workspace: ancestor.workspace,
    command: { type: "commit_today", commitment },
    commandId: `${prefix}-commit-remote`,
    deviceId: `${prefix}-phone`,
    sequence: 1,
    now: "2026-07-12T05:02:00.000Z",
    actorId: `${prefix}-remote-human`,
    previousOperationHash: ancestor.created.operationHash,
  });
  const remote = new MemoryHistoryRemote();
  remote.put(
    syncManifestPathV2(WORKSPACE_ID),
    createSyncManifestV2({
      workspaceId: WORKSPACE_ID,
      heads: {
        [ancestor.created.envelope.deviceId]: {
          sequence: ancestor.created.envelope.sequence,
          operationHash: ancestor.created.operationHash,
          revision: ancestor.receipt.revision,
          updatedAt: ancestor.receipt.createdAt,
        },
        [localWriter.created.envelope.deviceId]: {
          sequence: localWriter.created.envelope.sequence,
          operationHash: localWriter.created.operationHash,
          revision: localWriter.receipt.revision,
          updatedAt: localWriter.receipt.createdAt,
        },
        [remoteWriter.created.envelope.deviceId]: {
          sequence: remoteWriter.created.envelope.sequence,
          operationHash: remoteWriter.created.operationHash,
          revision: remoteWriter.receipt.revision,
          updatedAt: remoteWriter.receipt.createdAt,
        },
      },
      updatedAt: remoteWriter.receipt.createdAt,
    }),
  );
  for (const operation of [ancestor, localWriter, remoteWriter]) {
    remote.put(operation.created.path, operation.created.envelope);
  }

  const databaseName = `omni-plan-v2-${prefix}-open-conflict`;
  databaseNames.push(databaseName);
  const repository = new BrowserWorkspaceRepository({
    databaseName,
    indexedDB: indexedDBFactory,
  });
  await repository.initialize(genesis);
  await persistAsSent(repository, ancestor);
  await persistAsSent(repository, localWriter);
  const opened = await new SyncMergeV2({
    repository,
    remote,
    workspaceId: WORKSPACE_ID,
    keyProvider: { getPassphrase: async () => PASSPHRASE },
  }).merge({
    trustedAncestorWorkspace: ancestor.workspace,
    localHeadHash: localWriter.created.operationHash,
    remoteHeadHash: remoteWriter.created.operationHash,
    now: "2026-07-12T05:03:00.000Z",
  });
  expect(opened.openedConflictIds).toHaveLength(1);
  const openWorkspace = await repository.load();
  const pending = await repository.listPendingOutbox();
  const openEntry = pending.find(
    ({ command }) => command.type === "open_sync_conflict",
  );
  if (openWorkspace === undefined || openEntry === undefined) {
    throw new Error("Expected a persisted conflict-open checkpoint");
  }
  const conflict = openWorkspace.syncConflicts.find(
    ({ id }) => id === opened.openedConflictIds[0],
  );
  const openReceipt = openWorkspace.commandReceipts.find(
    ({ commandId, status }) =>
      commandId === openEntry.commandId && status === "applied",
  );
  if (
    conflict?.localBundle === undefined ||
    conflict.remoteBundle === undefined ||
    openReceipt === undefined
  ) {
    throw new Error("Expected complete conflict bundles and open receipt");
  }
  const openOperation = await createSyncOperationV2({
    workspaceId: WORKSPACE_ID,
    deviceId: `${prefix}-open`,
    sequence: 1,
    operationId: `${prefix}-open-operation`,
    command: openEntry.command,
    receipt: openReceipt,
    previousOperationHash: localWriter.created.operationHash,
    passphrase: PASSPHRASE,
  });
  remote.put(openOperation.path, openOperation.envelope);
  const historyBeforeOpen = await materializeRemoteSyncHistoryV2({
    remote,
    workspaceId: WORKSPACE_ID,
    passphrase: PASSPHRASE,
  });
  remote.put(
    syncManifestPathV2(WORKSPACE_ID),
    await advanceSyncManifestV2(historyBeforeOpen.manifest, openOperation),
  );
  await repository.prepareOutboxOperation(openEntry.id, {
    operationHash: openOperation.operationHash,
    path: openOperation.path,
    envelopeJson: canonicalJson(openOperation.envelope),
  });
  await repository.markOutboxSent(
    openEntry.id,
    openOperation.operationHash,
    "2026-07-12T05:03:30.000Z",
  );
  return {
    genesis,
    ancestor,
    localWriter,
    remoteWriter,
    openWorkspace,
    openOperation,
    conflict: conflict as OpenDailyConflictFixture["conflict"],
    remote,
    repository,
  };
}

function resolutionCommand(input: {
  conflict: OpenDailyConflictFixture["conflict"];
  side: "local" | "remote";
  rationale: string;
}): V2Command {
  const isLocal = input.side === "local";
  return {
    type: "resolve_sync_conflict",
    reviewId: `review:sync_conflict:${input.conflict.id}`,
    resolution: {
      conflictId: input.conflict.id,
      retainedVersion: input.side,
      retainedBundleHash: isLocal
        ? input.conflict.localBundle.hash
        : input.conflict.remoteBundle.hash,
      retainedValue: structuredClone(
        isLocal ? input.conflict.localValue : input.conflict.remoteValue,
      ),
      rationale: input.rationale,
    },
  };
}

async function restoreOpenConflictRepository(
  fixture: OpenDailyConflictFixture,
  databaseName: string,
): Promise<BrowserWorkspaceRepository> {
  databaseNames.push(databaseName);
  const repository = new BrowserWorkspaceRepository({
    databaseName,
    indexedDB: indexedDBFactory,
  });
  await repository.initialize(fixture.genesis);
  await persistAsSent(repository, fixture.ancestor);
  await persistAsSent(repository, fixture.localWriter);
  await new SyncMergeV2({
    repository,
    remote: fixture.remote,
    workspaceId: WORKSPACE_ID,
    keyProvider: { getPassphrase: async () => PASSPHRASE },
  }).merge({
    trustedAncestorWorkspace: fixture.ancestor.workspace,
    localHeadHash: fixture.localWriter.created.operationHash,
    remoteHeadHash: fixture.remoteWriter.created.operationHash,
    now: "2026-07-12T05:03:00.000Z",
  });
  const openEntry = (await repository.listPendingOutbox()).find(
    ({ command }) => command.type === "open_sync_conflict",
  );
  if (openEntry === undefined) {
    throw new Error("Expected restored conflict-open outbox entry");
  }
  await repository.prepareOutboxOperation(openEntry.id, {
    operationHash: fixture.openOperation.operationHash,
    path: fixture.openOperation.path,
    envelopeJson: canonicalJson(fixture.openOperation.envelope),
  });
  await repository.markOutboxSent(
    openEntry.id,
    fixture.openOperation.operationHash,
    "2026-07-12T05:03:30.000Z",
  );
  return repository;
}

describe("V2 remote-history materialization", () => {
  it("reads the isolated manifest and every immutable operation into a verified history", async () => {
    const applied = await captureOperation({
      workspace: buildWorkspaceV2(WORKSPACE_ID),
      commandId: "materialize-root",
      deviceId: "desktop",
      sequence: 1,
    });
    const manifest = createSyncManifestV2({
      workspaceId: WORKSPACE_ID,
      heads: {
        desktop: {
          sequence: 1,
          operationHash: applied.created.operationHash,
          revision: applied.receipt.revision,
          updatedAt: applied.receipt.createdAt,
        },
      },
      updatedAt: applied.receipt.createdAt,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(syncManifestPathV2(WORKSPACE_ID), manifest, "manifest-1");
    remote.put(applied.created.path, applied.created.envelope, "operation-1");

    const history = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });

    expect(syncOperationsPrefixV2(WORKSPACE_ID)).toBe(
      `v2/workspaces/${WORKSPACE_ID}/operations/`,
    );
    expect(history.manifest).toEqual(manifest);
    expect(history.operations).toHaveLength(1);
    expect(history.operations[0]).toMatchObject({
      operationHash: applied.created.operationHash,
      path: applied.created.path,
      command: applied.command,
      receipt: applied.receipt,
    });
  });

  it("fails with a typed error when the V2 manifest is unavailable", async () => {
    await expect(
      materializeRemoteSyncHistoryV2({
        remote: new MemoryHistoryRemote(),
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<SyncMergeError>>({
        name: "SyncMergeError",
        code: "REMOTE_MANIFEST_MISSING",
      }),
    );
  });

  it("maps remote history I/O failures to a typed merge boundary error", async () => {
    const remote: SyncRemoteHistoryPortV2 = {
      read: async () => {
        throw new Error("provider offline");
      },
      list: async () => [],
    };

    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({
      name: "SyncMergeError",
      code: "REMOTE_READ_FAILED",
      cause: expect.objectContaining({ message: "provider offline" }),
    });
  });

  it("rejects a V1 snapshot placed at the V2 manifest path", async () => {
    const remote = new MemoryHistoryRemote();
    remote.put(syncManifestPathV2(WORKSPACE_ID), {
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      latestRevision: "legacy-snapshot",
    });

    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "V2_SCHEMA_REQUIRED" });
  });

  it("rejects a manifest head whose immutable ancestor is unavailable", async () => {
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          phone: {
            sequence: 1,
            operationHash: "a".repeat(64),
            revision: 1,
            updatedAt: NOW,
          },
        },
        updatedAt: NOW,
      }),
    );

    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "MISSING_ANCESTOR" });
  });

  it("rejects a decrypted child whose receipt revision breaks the hash chain", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const root = await captureOperation({
      workspace: genesis,
      commandId: "broken-root",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T05:10:00.000Z",
    });
    const unlinkedAdvance = await captureOperation({
      workspace: root.workspace,
      commandId: "broken-unlinked-advance",
      deviceId: "unpublished",
      sequence: 1,
      now: "2026-07-12T05:10:30.000Z",
      previousOperationHash: root.created.operationHash,
    });
    const invalidChild = await captureOperation({
      workspace: unlinkedAdvance.workspace,
      commandId: "broken-child",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T05:11:00.000Z",
      previousOperationHash: root.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          desktop: {
            sequence: 1,
            operationHash: root.created.operationHash,
            revision: root.receipt.revision,
            updatedAt: root.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: invalidChild.created.operationHash,
            revision: invalidChild.receipt.revision,
            updatedAt: invalidChild.receipt.createdAt,
          },
        },
        updatedAt: invalidChild.receipt.createdAt,
      }),
    );
    remote.put(root.created.path, root.created.envelope);
    remote.put(invalidChild.created.path, invalidChild.created.envelope);

    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "BROKEN_HASH_CHAIN" });
  });
});

describe("V2 common-ancestor merge", () => {
  it("rejects an unproved pending local branch before replaying remote commands", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const local = await captureOperation({
      workspace: genesis,
      commandId: "stale-local-head",
      deviceId: "desktop",
      sequence: 1,
    });
    const remoteBranch = await captureOperation({
      workspace: genesis,
      commandId: "stale-remote-head",
      deviceId: "phone",
      sequence: 1,
    });
    const unflushedLocal = await captureOperation({
      workspace: local.workspace,
      commandId: "not-in-remote-history",
      deviceId: "desktop",
      sequence: 2,
      previousOperationHash: local.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: remoteBranch.created.operationHash,
            revision: remoteBranch.receipt.revision,
            updatedAt: remoteBranch.receipt.createdAt,
          },
        },
        updatedAt: remoteBranch.receipt.createdAt,
      }),
    );
    remote.put(local.created.path, local.created.envelope);
    remote.put(remoteBranch.created.path, remoteBranch.created.envelope);
    const repository = {
      load: async () => structuredClone(unflushedLocal.workspace),
    } as unknown as AtomicWorkspaceRepository;

    await expect(
      new SyncMergeV2({
        repository,
        remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: genesis,
        localHeadHash: local.created.operationHash,
        remoteHeadHash: remoteBranch.created.operationHash,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_STALE" });
  });

  it("does not treat an unuploaded same-identity different-payload command as the verified remote authority", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const local = await captureOperation({
      workspace: genesis,
      commandId: "collision-local-head",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T05:00:00.000Z",
    });
    const remoteBranch = await commandOperation({
      workspace: genesis,
      command: {
        type: "capture_inbox",
        id: "inbox-verified-remote-payload",
        text: "Verified remote payload",
      },
      commandId: "authority-collision",
      deviceId: "phone",
      sequence: 1,
      actorId: "human-phone",
      now: "2026-07-12T05:01:00.000Z",
    });
    const unuploadedCollision = await commandOperation({
      workspace: local.workspace,
      command: {
        type: "capture_inbox",
        id: "inbox-different-local-payload",
        text: "Different unuploaded payload",
      },
      commandId: "authority-collision",
      deviceId: "desktop",
      sequence: 2,
      actorId: "human-phone",
      now: remoteBranch.receipt.createdAt,
      previousOperationHash: local.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: remoteBranch.created.operationHash,
            revision: remoteBranch.receipt.revision,
            updatedAt: remoteBranch.receipt.createdAt,
          },
        },
        updatedAt: remoteBranch.receipt.createdAt,
      }),
    );
    remote.put(local.created.path, local.created.envelope);
    remote.put(remoteBranch.created.path, remoteBranch.created.envelope);
    const repository = {
      load: async () => structuredClone(unuploadedCollision.workspace),
    } as unknown as AtomicWorkspaceRepository;

    await expect(
      new SyncMergeV2({
        repository,
        remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: genesis,
        localHeadHash: local.created.operationHash,
        remoteHeadHash: remoteBranch.created.operationHash,
        now: "2026-07-12T05:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_STALE" });
  });

  it("merges concurrent genesis roots through CommandService and leaves a causal pending outbox entry", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const local = await captureOperation({
      workspace: genesis,
      commandId: "genesis-local",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T05:01:00.000Z",
    });
    const remoteBranch = await captureOperation({
      workspace: genesis,
      commandId: "genesis-remote",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T05:02:00.000Z",
    });
    const manifest = createSyncManifestV2({
      workspaceId: WORKSPACE_ID,
      heads: {
        desktop: {
          sequence: 1,
          operationHash: local.created.operationHash,
          revision: local.receipt.revision,
          updatedAt: local.receipt.createdAt,
        },
        phone: {
          sequence: 1,
          operationHash: remoteBranch.created.operationHash,
          revision: remoteBranch.receipt.revision,
          updatedAt: remoteBranch.receipt.createdAt,
        },
      },
      updatedAt: remoteBranch.receipt.createdAt,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(syncManifestPathV2(WORKSPACE_ID), manifest);
    remote.put(local.created.path, local.created.envelope);
    remote.put(remoteBranch.created.path, remoteBranch.created.envelope);
    const databaseName = "omni-plan-v2-sync-merge-genesis";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await repository.commit({
      expectedRevision: 0,
      workspace: local.workspace,
      outboxEntry: {
        id: "outbox-genesis-local",
        workspaceId: WORKSPACE_ID,
        commandId: "genesis-local",
        baseRevision: 0,
        revision: 1,
        command: local.command,
        actor: {
          actorId: "human-desktop",
          actorKind: "human",
          origin: "ui",
          source: {
            sourceId: "verified-desktop",
            verified: true,
            capabilities: ["human_decision"],
          },
        },
        payloadHash: local.receipt.payloadHash,
        receiptId: local.receipt.id,
        createdAt: local.receipt.createdAt,
        status: "pending",
      },
    });
    await repository.prepareOutboxOperation("outbox-genesis-local", {
      operationHash: local.created.operationHash,
      path: local.created.path,
      envelopeJson: canonicalJson(local.created.envelope),
    });
    await repository.markOutboxSent(
      "outbox-genesis-local",
      local.created.operationHash,
      "2026-07-12T05:01:30.000Z",
    );

    const merger = new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const mergeInput = {
      trustedAncestorWorkspace: genesis,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: remoteBranch.created.operationHash,
      now: "2026-07-12T05:03:00.000Z",
    } as const;
    const result = await merger.merge(mergeInput);

    expect(result).toMatchObject({
      status: "merged",
      commonAncestorHash: `genesis:${WORKSPACE_ID}`,
      replayedOperationHashes: [remoteBranch.created.operationHash],
      openedConflictIds: [],
      revision: 2,
    });
    expect((await repository.load())?.inboxItems.map(({ id }) => id).sort()).toEqual(
      ["inbox-genesis-local", "inbox-genesis-remote"],
    );
    expect(await repository.listPendingOutbox()).toEqual([
      expect.objectContaining({
        commandId: "genesis-remote",
        baseRevision: 1,
        revision: 2,
        status: "pending",
      }),
    ]);

    const workspaceAfterFirstMerge = await repository.load();
    const outboxAfterFirstMerge = await repository.listPendingOutbox();
    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "already_merged",
      commonAncestorHash: `genesis:${WORKSPACE_ID}`,
      replayedOperationHashes: [],
      openedConflictIds: [],
      revision: 2,
    });
    expect(await repository.load()).toEqual(workspaceAfterFirstMerge);
    expect(await repository.listPendingOutbox()).toEqual(outboxAfterFirstMerge);

    await expect(
      new SyncAdapterV2({
        repository,
        remote,
        workspaceId: WORKSPACE_ID,
        deviceId: "desktop",
        keyProvider: { getPassphrase: async () => PASSPHRASE },
        clock: () => "2026-07-12T05:04:00.000Z",
      }).flushPending(),
    ).resolves.toEqual({ sent: 1, pending: 0 });
    const advancedManifest = JSON.parse(
      remote.files.get(syncManifestPathV2(WORKSPACE_ID))!.content,
    );
    expect(advancedManifest.heads).toMatchObject({
      desktop: { sequence: 2, revision: 2 },
      phone: { sequence: 1, revision: 1 },
    });
    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).resolves.toMatchObject({
      operations: expect.arrayContaining([
        expect.objectContaining({
          command: remoteBranch.command,
          receipt: expect.objectContaining({
            commandId: remoteBranch.receipt.commandId,
            origin: "sync",
          }),
        }),
      ]),
    });

    await expect(
      merger.merge({
        ...mergeInput,
        localHeadHash: advancedManifest.heads.desktop.operationHash,
        now: "2026-07-12T05:05:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "already_merged",
      replayedOperationHashes: [],
      openedConflictIds: [],
      revision: 2,
    });
    expect(await repository.listPendingOutbox()).toEqual([]);

    const roundtripBDatabase = "omni-plan-v2-sync-merge-roundtrip-b";
    databaseNames.push(roundtripBDatabase);
    const roundtripBRepository = new BrowserWorkspaceRepository({
      databaseName: roundtripBDatabase,
      indexedDB: indexedDBFactory,
    });
    await roundtripBRepository.initialize(genesis);
    await persistAsSent(roundtripBRepository, remoteBranch);
    await new SyncMergeV2({
      repository: roundtripBRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: genesis,
      localHeadHash: remoteBranch.created.operationHash,
      remoteHeadHash: local.created.operationHash,
      now: "2026-07-12T05:06:00.000Z",
    });
    await new SyncAdapterV2({
      repository: roundtripBRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "phone",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:07:00.000Z",
    }).flushPending();
    const roundtripHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const roundtripBHead = roundtripHistory.manifest.heads.phone.operationHash;

    const roundtripADatabase = "omni-plan-v2-sync-merge-roundtrip-a";
    databaseNames.push(roundtripADatabase);
    const roundtripARepository = new BrowserWorkspaceRepository({
      databaseName: roundtripADatabase,
      indexedDB: indexedDBFactory,
    });
    await roundtripARepository.initialize(genesis);
    await persistAsSent(roundtripARepository, local);
    const roundtrip = await new SyncMergeV2({
      repository: roundtripARepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: genesis,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: roundtripBHead,
      now: "2026-07-12T05:08:00.000Z",
    });
    expect(roundtrip.replayedOperationHashes).toEqual([
      remoteBranch.created.operationHash,
    ]);
    expect(
      (await roundtripARepository.load())?.inboxItems.map(({ id }) => id).sort(),
    ).toEqual(["inbox-genesis-local", "inbox-genesis-remote"]);
  });

  it("semantically rebases unchanged Today through A→B→C and roundtrips the authority root", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const profile = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [{ weekday: 0, startMinute: 360, finishMinute: 480 }],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 3_600,
          mediumSeconds: 3_600,
          shallowSeconds: 3_600,
        },
      ],
      unavailableBlocks: [],
      updatedAt: "2026-07-12T04:00:00.000Z",
      updatedBy: "human-seed",
    });
    const ancestor = await commandOperation({
      workspace: genesis,
      command: { type: "configure_capacity", profile },
      commandId: "semantic-capacity",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-12T04:00:00.000Z",
    });
    const local = await captureOperation({
      workspace: ancestor.workspace,
      commandId: "semantic-local-inbox",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T05:00:30.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const proposal = await generateTodayProposal(
      ancestor.workspace,
      "2026-07-12",
      "2026-07-12T05:00:00.000Z",
    );
    const originalCommitment: DailyCommitmentDraft = {
      id: "semantic-remote-commitment",
      localDate: proposal.localDate,
      workspaceRevision: proposal.workspaceRevision,
      generatedAt: proposal.generatedAt,
      proposalHash: proposal.proposalHash,
      slots: structuredClone(proposal.slots),
    };
    const remoteBranch = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "commit_today", commitment: originalCommitment },
      commandId: "semantic-remote-commit",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T05:01:00.000Z",
      actorId: "human-remote",
      previousOperationHash: ancestor.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: 1,
            operationHash: ancestor.created.operationHash,
            revision: ancestor.receipt.revision,
            updatedAt: ancestor.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: remoteBranch.created.operationHash,
            revision: remoteBranch.receipt.revision,
            updatedAt: remoteBranch.receipt.createdAt,
          },
        },
        updatedAt: remoteBranch.receipt.createdAt,
      }),
    );
    for (const operation of [ancestor, local, remoteBranch]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-semantic-today";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await persistAsSent(repository, ancestor);
    await persistAsSent(repository, local);

    const merger = new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const semanticMergeInput = {
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: remoteBranch.created.operationHash,
      now: "2026-07-12T05:02:00.000Z",
    } as const;
    const result = await merger.merge(semanticMergeInput);

    expect(result.replayedOperationHashes).toEqual([
      remoteBranch.created.operationHash,
    ]);
    const merged = await repository.load();
    expect(merged?.dailyCommitments).toEqual(
      remoteBranch.workspace.dailyCommitments,
    );
    expect(merged?.syncConflicts).toEqual([]);
    expect(await repository.listPendingOutbox()).toContainEqual(
      expect.objectContaining({
        commandId: "semantic-remote-commit",
        command: expect.objectContaining({
          type: "commit_today",
          commitment: expect.objectContaining({
            workspaceRevision: 2,
            slots: originalCommitment.slots,
          }),
        }),
        actor: expect.objectContaining({
          origin: "sync",
          source: expect.objectContaining({
            sourceId: expect.stringContaining("sync-semantic:"),
          }),
        }),
      }),
    );
    await expect(merger.merge(semanticMergeInput)).resolves.toMatchObject({
      status: "already_merged",
      replayedOperationHashes: [],
      revision: 3,
    });

    await new SyncAdapterV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "desktop",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:03:00.000Z",
    }).flushPending();
    const semanticHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const semanticHead = semanticHistory.manifest.heads.desktop.operationHash;
    expect(
      semanticHistory.operations.some(({ receipt }) =>
        receipt.source.sourceId.startsWith("sync-semantic:"),
      ),
    ).toBe(true);

    const thirdLocalFirst = await captureOperation({
      workspace: ancestor.workspace,
      commandId: "semantic-third-local-first",
      deviceId: "tablet",
      sequence: 1,
      now: "2026-07-12T05:00:10.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const thirdLocalSecond = await captureOperation({
      workspace: thirdLocalFirst.workspace,
      commandId: "semantic-third-local-second",
      deviceId: "tablet",
      sequence: 2,
      now: "2026-07-12T05:00:20.000Z",
      previousOperationHash: thirdLocalFirst.created.operationHash,
    });
    remote.put(
      thirdLocalFirst.created.path,
      thirdLocalFirst.created.envelope,
    );
    remote.put(
      thirdLocalSecond.created.path,
      thirdLocalSecond.created.envelope,
    );
    const thirdLocalManifest = await advanceSyncManifestV2(
      await advanceSyncManifestV2(
        semanticHistory.manifest,
        thirdLocalFirst.created,
      ),
      thirdLocalSecond.created,
    );
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      thirdLocalManifest,
      "semantic-third-local-manifest",
    );
    const thirdDatabaseName =
      "omni-plan-v2-sync-merge-semantic-today-third-device";
    databaseNames.push(thirdDatabaseName);
    const thirdRepository = new BrowserWorkspaceRepository({
      databaseName: thirdDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await thirdRepository.initialize(genesis);
    await persistAsSent(thirdRepository, ancestor);
    await persistAsSent(thirdRepository, thirdLocalFirst);
    await persistAsSent(thirdRepository, thirdLocalSecond);
    const thirdMerge = await new SyncMergeV2({
      repository: thirdRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: thirdLocalSecond.created.operationHash,
      remoteHeadHash: semanticHead,
      now: "2026-07-12T05:04:30.000Z",
    });
    expect(thirdMerge).toMatchObject({
      status: "merged",
      replayedOperationHashes: [
        local.created.operationHash,
        semanticHead,
      ],
      openedConflictIds: [],
      revision: 5,
    });
    expect((await thirdRepository.load())?.dailyCommitments).toEqual(
      remoteBranch.workspace.dailyCommitments,
    );
    expect(await thirdRepository.listPendingOutbox()).toContainEqual(
      expect.objectContaining({
        commandId: remoteBranch.receipt.commandId,
        command: expect.objectContaining({
          type: "commit_today",
          commitment: expect.objectContaining({
            workspaceRevision: 4,
            proposalHash: originalCommitment.proposalHash,
          }),
        }),
        actor: expect.objectContaining({
          source: expect.objectContaining({
            sourceId: expect.stringContaining(`sync-semantic:${semanticHead}:`),
          }),
        }),
      }),
    );
    await new SyncAdapterV2({
      repository: thirdRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "tablet",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:05:00.000Z",
    }).flushPending();
    const thirdHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const thirdHead = thirdHistory.manifest.heads.tablet.operationHash;
    const authorizedThirdBranch = await authorizeSyncBranchV2({
      history: thirdHistory,
      trustedAncestorWorkspace: ancestor.workspace,
      ancestorOperationHash: ancestor.created.operationHash,
      headOperationHash: thirdHead,
    });
    expect(authorizedThirdBranch.workspace.dailyCommitments).toEqual(
      remoteBranch.workspace.dailyCommitments,
    );
    expect(
      authorizedThirdBranch.workspace.commandReceipts.find(
        ({ commandId }) => commandId === remoteBranch.receipt.commandId,
      )?.source.sourceId,
    ).toContain(`sync-semantic:${semanticHead}:`);

    const roundtripDatabaseName =
      "omni-plan-v2-sync-merge-semantic-today-roundtrip";
    databaseNames.push(roundtripDatabaseName);
    const roundtripRepository = new BrowserWorkspaceRepository({
      databaseName: roundtripDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await roundtripRepository.initialize(genesis);
    await persistAsSent(roundtripRepository, ancestor);
    await persistAsSent(roundtripRepository, remoteBranch);
    const roundtrip = await new SyncMergeV2({
      repository: roundtripRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: remoteBranch.created.operationHash,
      remoteHeadHash: semanticHead,
      now: "2026-07-12T05:04:00.000Z",
    });
    expect(roundtrip.replayedOperationHashes).toEqual([
      local.created.operationHash,
    ]);
    const roundtripWorkspace = await roundtripRepository.load();
    expect(roundtripWorkspace?.dailyCommitments).toEqual(
      remoteBranch.workspace.dailyCommitments,
    );
    expect(roundtripWorkspace?.syncConflicts).toEqual([]);
    expect(roundtripWorkspace?.inboxItems).toContainEqual(
      expect.objectContaining({ id: "inbox-semantic-local-inbox" }),
    );
  }, 15_000);

  it("semantically rebases a remote Replan proposal and then replays its human acceptance", async () => {
    const localDate = "2026-07-11";
    const committedAt = "2026-07-11T01:00:00.000Z";
    const projectId = "semantic-replan-project";
    const scopeId = "semantic-replan-scope";
    const workItem = buildProjectWorkItem({
      id: "semantic-replan-work",
      projectId,
      betScopeId: scopeId,
      durationSeconds: 1_800,
      estimate: { mostLikelySeconds: 1_800 },
    });
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const seedOperations: AppliedOperation[] = [];
    let seedWorkspace = genesis;
    let seedParentHash: string | undefined;
    const applySeed = async (
      command: V2Command,
      commandId: string,
      now: string,
    ): Promise<AppliedOperation> => {
      const operation = await commandOperation({
        workspace: seedWorkspace,
        command,
        commandId,
        deviceId: "seed",
        sequence: seedOperations.length + 1,
        actorId: "human-seed",
        now,
        ...(seedParentHash === undefined
          ? {}
          : { previousOperationHash: seedParentHash }),
      });
      seedOperations.push(operation);
      seedWorkspace = operation.workspace;
      seedParentHash = operation.created.operationHash;
      return operation;
    };
    await applySeed(
      {
        type: "configure_capacity",
        profile: buildCapacityProfile({
          timeZone: "UTC",
          weeklyWindows: [
            { weekday: 6, startMinute: 0, finishMinute: 1_440 },
          ],
          dailyBudgets: [
            {
              weekday: 6,
              deepSeconds: 3_600,
              mediumSeconds: 3_600,
              shallowSeconds: 3_600,
            },
          ],
          unavailableBlocks: [],
          updatedAt: "2026-07-10T00:00:00.000Z",
          updatedBy: "human-seed",
        }),
      },
      "semantic-replan-capacity",
      "2026-07-10T00:00:00.000Z",
    );
    await applySeed(
      {
        type: "capture_inbox",
        id: "semantic-replan-inbox",
        text: "Shape a bounded project",
      },
      "semantic-replan-capture",
      "2026-07-10T00:01:00.000Z",
    );
    await applySeed(
      {
        type: "confirm_project_triage",
        inboxItemId: "semantic-replan-inbox",
        eligibility: {
          singleSession: false,
          estimateSeconds: 7_200,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 2,
          solutionKnown: false,
        },
        project: {
          id: projectId,
          name: "Semantic Replan",
          priority: 4,
          notes: "Exercise the full approved chain.",
        },
      },
      "semantic-replan-triage",
      "2026-07-10T00:02:00.000Z",
    );
    await applySeed(
      {
        type: "update_direction",
        projectId,
        brief: {
          id: `${projectId}:direction-brief:1`,
          projectId,
          audienceAndProblem: "A concrete user has a concrete planning problem.",
          successEvidence: "The bounded workflow completes with evidence.",
          appetiteSeconds: 864_000,
          validationMethod: "Run the acceptance scenario.",
          firstScope: [
            {
              id: scopeId,
              title: "Bounded",
              description: "Exact scope",
            },
          ],
          noGoOrKill: "Stop if authority cannot be proven.",
          advancedNotes: "",
        },
      },
      "semantic-replan-direction",
      "2026-07-10T00:03:00.000Z",
    );
    await applySeed(
      {
        type: "place_bet",
        projectId,
        betId: "semantic-replan-bet",
        start: "2026-07-10T00:04:00.000Z",
      },
      "semantic-replan-bet-command",
      "2026-07-10T00:04:00.000Z",
    );
    await applySeed(
      { type: "create_work_item", projectId, workItem },
      "semantic-replan-work-command",
      "2026-07-10T00:05:00.000Z",
    );
    const today = await generateTodayProposal(
      seedWorkspace,
      localDate,
      committedAt,
    );
    const committed = await applySeed(
      {
        type: "commit_today",
        commitment: {
          id: "semantic-replan-base-commitment",
          localDate: today.localDate,
          workspaceRevision: today.workspaceRevision,
          generatedAt: today.generatedAt,
          proposalHash: today.proposalHash,
          slots: structuredClone(today.slots),
        },
      },
      "semantic-replan-base-command",
      committedAt,
    );
    const actualAt = "2026-07-11T01:01:00.000Z";
    const actual = await applySeed(
      {
        type: "record_actual",
        actual: {
          id: "semantic-replan-actual",
          revision: 1,
          target: { kind: "work_item", workItemId: workItem.id },
          actualWorkSeconds: 60,
          remainingWorkSeconds: 900,
          actualCost: 0,
          recordedAt: actualAt,
        },
      },
      "semantic-replan-actual-command",
      actualAt,
    );
    const local = await captureOperation({
      workspace: actual.workspace,
      commandId: "semantic-replan-local-inbox",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-11T01:01:30.000Z",
      previousOperationHash: actual.created.operationHash,
    });
    const proposedAt = "2026-07-11T01:02:00.000Z";
    const proposal = await buildReplanProposal(actual.workspace, {
      id: "semantic-replan-proposal",
      localDate,
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: proposedAt,
      createdBy: "human-phone",
    });
    const proposed = await commandOperation({
      workspace: actual.workspace,
      command: { type: "propose_replan", proposal },
      commandId: "semantic-replan-propose-command",
      deviceId: "phone",
      sequence: 1,
      actorId: "human-phone",
      now: proposedAt,
      previousOperationHash: actual.created.operationHash,
    });
    const accepted = await commandOperation({
      workspace: proposed.workspace,
      command: {
        type: "accept_replan",
        proposalId: proposal.id,
        commitmentId: "semantic-replan-accepted-commitment",
      },
      commandId: "semantic-replan-accept-command",
      deviceId: "phone",
      sequence: 2,
      actorId: "human-phone",
      now: "2026-07-11T01:03:00.000Z",
      previousOperationHash: proposed.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: seedOperations.length,
            operationHash: actual.created.operationHash,
            revision: actual.receipt.revision,
            updatedAt: actual.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 2,
            operationHash: accepted.created.operationHash,
            revision: accepted.receipt.revision,
            updatedAt: accepted.receipt.createdAt,
          },
        },
        updatedAt: accepted.receipt.createdAt,
      }),
    );
    for (const operation of [...seedOperations, local, proposed, accepted]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-semantic-replan";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    for (const operation of seedOperations) {
      await persistAsSent(repository, operation);
    }
    await persistAsSent(repository, local);
    const merger = new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const mergeInput = {
      trustedAncestorWorkspace: actual.workspace,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: accepted.created.operationHash,
      now: "2026-07-11T01:04:00.000Z",
    } as const;

    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "merged",
      replayedOperationHashes: [
        proposed.created.operationHash,
        accepted.created.operationHash,
      ],
      openedConflictIds: [],
      revision: accepted.workspace.revision + 1,
    });
    const merged = await repository.load();
    expect(merged?.dailyCommitments).toEqual(
      accepted.workspace.dailyCommitments,
    );
    expect(merged?.planVersions).toEqual(accepted.workspace.planVersions);
    expect(merged?.projects).toEqual(accepted.workspace.projects);
    expect(merged?.replanProposals).toEqual([
      expect.objectContaining({
        id: proposal.id,
        baseRevision: proposal.baseRevision,
        proposalHash: proposal.proposalHash,
        status: "accepted",
      }),
    ]);
    expect(merged?.syncConflicts).toEqual([]);
    expect(await repository.listPendingOutbox()).toEqual([
      expect.objectContaining({
        commandId: proposed.receipt.commandId,
        actor: expect.objectContaining({
          source: expect.objectContaining({
            sourceId: expect.stringContaining("sync-semantic:"),
          }),
        }),
      }),
      expect.objectContaining({
        commandId: accepted.receipt.commandId,
        actor: expect.objectContaining({
          source: expect.objectContaining({
            sourceId: expect.stringContaining("sync-replay:"),
          }),
        }),
      }),
    ]);
    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "already_merged",
      replayedOperationHashes: [],
      openedConflictIds: [],
      revision: accepted.workspace.revision + 1,
    });

    await new SyncAdapterV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "desktop",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-11T01:05:00.000Z",
    }).flushPending();
    const roundtripHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const desktopHead =
      roundtripHistory.manifest.heads.desktop.operationHash;
    const roundtripDatabaseName =
      "omni-plan-v2-sync-merge-semantic-replan-roundtrip";
    databaseNames.push(roundtripDatabaseName);
    const roundtripRepository = new BrowserWorkspaceRepository({
      databaseName: roundtripDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await roundtripRepository.initialize(genesis);
    for (const operation of seedOperations) {
      await persistAsSent(roundtripRepository, operation);
    }
    await persistAsSent(roundtripRepository, proposed);
    await persistAsSent(roundtripRepository, accepted);
    const roundtrip = await new SyncMergeV2({
      repository: roundtripRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: actual.workspace,
      localHeadHash: accepted.created.operationHash,
      remoteHeadHash: desktopHead,
      now: "2026-07-11T01:06:00.000Z",
    });
    expect(roundtrip).toMatchObject({
      status: "merged",
      replayedOperationHashes: [local.created.operationHash],
      openedConflictIds: [],
      revision: accepted.workspace.revision + 1,
    });
    const roundtripWorkspace = await roundtripRepository.load();
    expect(roundtripWorkspace?.dailyCommitments).toEqual(
      accepted.workspace.dailyCommitments,
    );
    expect(roundtripWorkspace?.replanProposals).toEqual(
      accepted.workspace.replanProposals,
    );
    expect(roundtripWorkspace?.planVersions).toEqual(
      accepted.workspace.planVersions,
    );
    expect(roundtripWorkspace?.projects).toEqual(accepted.workspace.projects);
    expect(roundtripWorkspace?.syncConflicts).toEqual([]);
    expect(roundtripWorkspace?.inboxItems).toContainEqual(
      expect.objectContaining({ id: "inbox-semantic-replan-local-inbox" }),
    );
  }, 15_000);

  it("reauthorizes an earlier remote receipt after a later local Review with a monotonic evaluation clock", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const ancestor = await commandOperation({
      workspace: genesis,
      command: {
        type: "configure_capacity",
        profile: buildCapacityProfile({
          timeZone: "UTC",
          weeklyWindows: [
            { weekday: 1, startMinute: 540, finishMinute: 1_020 },
          ],
          dailyBudgets: [
            {
              weekday: 1,
              deepSeconds: 3_600,
              mediumSeconds: 1_800,
              shallowSeconds: 900,
            },
          ],
          unavailableBlocks: [],
          updatedAt: "2026-07-01T00:00:00.000Z",
          updatedBy: "human-seed",
        }),
      },
      commandId: "temporal-capacity",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-01T00:00:00.000Z",
    });
    const remoteReceiptAt = "2026-07-12T04:00:00.000Z";
    const localReviewAt = "2026-07-12T05:00:00.000Z";
    const reviewDraft = deriveReviewQueue(
      ancestor.workspace,
      localReviewAt,
    ).find(({ triggerType }) => triggerType === "weekly");
    if (reviewDraft === undefined) {
      throw new Error("Expected a weekly Review occurrence");
    }
    const localReview = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "create_review", review: reviewDraft },
      commandId: "temporal-later-local-review",
      deviceId: "desktop",
      sequence: 1,
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "temporal-review-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      now: localReviewAt,
      previousOperationHash: ancestor.created.operationHash,
    });
    const remoteBranch = await captureOperation({
      workspace: ancestor.workspace,
      commandId: "temporal-earlier-remote-capture",
      deviceId: "phone",
      sequence: 1,
      now: remoteReceiptAt,
      previousOperationHash: ancestor.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: 1,
            operationHash: ancestor.created.operationHash,
            revision: ancestor.receipt.revision,
            updatedAt: ancestor.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: localReview.created.operationHash,
            revision: localReview.receipt.revision,
            updatedAt: localReview.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: remoteBranch.created.operationHash,
            revision: remoteBranch.receipt.revision,
            updatedAt: remoteBranch.receipt.createdAt,
          },
        },
        updatedAt: localReview.receipt.createdAt,
      }),
    );
    for (const operation of [ancestor, localReview, remoteBranch]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-temporal-review";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await persistAsSent(repository, ancestor);
    await persistAsSent(repository, localReview);
    const merged = await new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: localReview.created.operationHash,
      remoteHeadHash: remoteBranch.created.operationHash,
      now: "2026-07-12T06:00:00.000Z",
    });
    expect(merged).toMatchObject({
      status: "merged",
      replayedOperationHashes: [remoteBranch.created.operationHash],
      openedConflictIds: [],
      revision: 3,
    });
    const mergedWorkspace = await repository.load();
    expect(mergedWorkspace?.reviews).toContainEqual(
      expect.objectContaining({
        id: reviewDraft.id,
        createdAt: localReviewAt,
      }),
    );
    expect(
      mergedWorkspace?.commandReceipts.find(
        ({ commandId }) => commandId === remoteBranch.receipt.commandId,
      ),
    ).toMatchObject({
      createdAt: remoteReceiptAt,
      origin: "sync",
    });

    await new SyncAdapterV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "desktop",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T06:01:00.000Z",
    }).flushPending();
    const history = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const authorized = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: ancestor.workspace,
      ancestorOperationHash: ancestor.created.operationHash,
      headOperationHash: history.manifest.heads.desktop.operationHash,
    });
    expect(authorized.workspace.reviews).toEqual(mergedWorkspace?.reviews);
    expect(authorized.workspace.inboxItems).toEqual(mergedWorkspace?.inboxItems);
    expect(
      authorized.workspace.commandReceipts.find(
        ({ commandId }) => commandId === remoteBranch.receipt.commandId,
      )?.createdAt,
    ).toBe(remoteReceiptAt);
  });

  it("rejects Today semantic replay when unused capacity metadata changes even if the approved slots stay empty", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const profile = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [{ weekday: 0, startMinute: 360, finishMinute: 480 }],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 3_600,
          mediumSeconds: 3_600,
          shallowSeconds: 3_600,
        },
      ],
      unavailableBlocks: [],
      updatedAt: "2026-07-12T04:00:00.000Z",
      updatedBy: "human-seed",
    });
    const ancestor = await commandOperation({
      workspace: genesis,
      command: { type: "configure_capacity", profile },
      commandId: "readset-capacity-ancestor",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-12T04:00:00.000Z",
    });
    const changedProfile = structuredClone(profile);
    changedProfile.dailyBudgets[0].deepSeconds = 7_200;
    changedProfile.updatedAt = "2026-07-12T05:00:30.000Z";
    changedProfile.updatedBy = "human-local";
    const local = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "configure_capacity", profile: changedProfile },
      commandId: "readset-local-unused-capacity",
      deviceId: "desktop",
      sequence: 1,
      now: changedProfile.updatedAt,
      previousOperationHash: ancestor.created.operationHash,
    });
    const proposal = await generateTodayProposal(
      ancestor.workspace,
      "2026-07-12",
      "2026-07-12T05:00:00.000Z",
    );
    expect(proposal.slots).toEqual([]);
    const remoteBranch = await commandOperation({
      workspace: ancestor.workspace,
      command: {
        type: "commit_today",
        commitment: {
          id: "readset-remote-commitment",
          localDate: proposal.localDate,
          workspaceRevision: proposal.workspaceRevision,
          generatedAt: proposal.generatedAt,
          proposalHash: proposal.proposalHash,
          slots: structuredClone(proposal.slots),
        },
      },
      commandId: "readset-remote-commit",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T05:01:00.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const localProposal = await generateTodayProposal(
      local.workspace,
      proposal.localDate,
      proposal.generatedAt,
    );
    expect(localProposal.slots).toEqual(proposal.slots);
    expect(localProposal.proposalHash).not.toBe(proposal.proposalHash);

    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: 1,
            operationHash: ancestor.created.operationHash,
            revision: ancestor.receipt.revision,
            updatedAt: ancestor.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: remoteBranch.created.operationHash,
            revision: remoteBranch.receipt.revision,
            updatedAt: remoteBranch.receipt.createdAt,
          },
        },
        updatedAt: remoteBranch.receipt.createdAt,
      }),
    );
    for (const operation of [ancestor, local, remoteBranch]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-semantic-readset";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await persistAsSent(repository, ancestor);
    await persistAsSent(repository, local);

    await expect(
      new SyncMergeV2({
        repository,
        remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: ancestor.workspace,
        localHeadHash: local.created.operationHash,
        remoteHeadHash: remoteBranch.created.operationHash,
        now: "2026-07-12T05:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MERGE_REPLAY_REJECTED" });
    expect(await repository.load()).toEqual(local.workspace);
    expect(await repository.listPendingOutbox()).toEqual([]);
  });

  it("opens a Review conflict after replaying its remote-created Project owner", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const capacity = await commandOperation({
      workspace: genesis,
      command: {
        type: "configure_capacity",
        profile: buildCapacityProfile({
          timeZone: "UTC",
          weeklyWindows: [
            { weekday: 1, startMinute: 540, finishMinute: 1_020 },
          ],
          dailyBudgets: [
            {
              weekday: 1,
              deepSeconds: 3_600,
              mediumSeconds: 1_800,
              shallowSeconds: 900,
            },
          ],
          unavailableBlocks: [],
          updatedAt: "2026-07-01T00:01:00.000Z",
          updatedBy: "human-seed",
        }),
      },
      commandId: "dynamic-owner-capacity",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-01T00:01:00.000Z",
    });
    const projectOneCapture = await commandOperation({
      workspace: capacity.workspace,
      command: {
        type: "capture_inbox",
        id: "dynamic-owner-inbox-1",
        text: "Create the existing Review owner",
      },
      commandId: "dynamic-owner-capture-1",
      deviceId: "seed",
      sequence: 2,
      now: "2026-07-01T00:02:00.000Z",
      previousOperationHash: capacity.created.operationHash,
    });
    const ancestor = await commandOperation({
      workspace: projectOneCapture.workspace,
      command: {
        type: "confirm_project_triage",
        inboxItemId: "dynamic-owner-inbox-1",
        eligibility: {
          singleSession: false,
          estimateSeconds: 7_200,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 2,
          solutionKnown: false,
        },
        project: {
          id: "dynamic-owner-project-1",
          name: "Existing owner",
          priority: 1,
          notes: "Exists on both branches.",
        },
      },
      commandId: "dynamic-owner-triage-1",
      deviceId: "seed",
      sequence: 3,
      now: "2026-07-01T00:03:00.000Z",
      previousOperationHash: projectOneCapture.created.operationHash,
    });
    const reviewAt = "2026-07-12T05:00:00.000Z";
    const localReviewDraft = deriveReviewQueue(
      ancestor.workspace,
      reviewAt,
    ).find(({ triggerType }) => triggerType === "weekly");
    if (localReviewDraft === undefined) {
      throw new Error("Expected local weekly Review draft");
    }
    const localReview = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "create_review", review: localReviewDraft },
      commandId: "dynamic-owner-local-review",
      deviceId: "desktop",
      sequence: 1,
      now: reviewAt,
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "dynamic-owner-local-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      previousOperationHash: ancestor.created.operationHash,
    });
    const remoteCapture = await commandOperation({
      workspace: ancestor.workspace,
      command: {
        type: "capture_inbox",
        id: "dynamic-owner-inbox",
        text: "Create the remote-only Review owner",
      },
      commandId: "dynamic-owner-capture",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T04:58:00.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const remoteProject = await commandOperation({
      workspace: remoteCapture.workspace,
      command: {
        type: "confirm_project_triage",
        inboxItemId: "dynamic-owner-inbox",
        eligibility: {
          singleSession: false,
          estimateSeconds: 7_200,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 2,
          solutionKnown: false,
        },
        project: {
          id: "dynamic-owner-project-2",
          name: "Remote owner",
          priority: 2,
          notes: "Must exist before conflict-open validation.",
        },
      },
      commandId: "dynamic-owner-triage",
      deviceId: "phone",
      sequence: 2,
      now: "2026-07-12T04:59:00.000Z",
      previousOperationHash: remoteCapture.created.operationHash,
    });
    const remoteReviewDraft = deriveReviewQueue(
      remoteProject.workspace,
      reviewAt,
    ).find(({ triggerKey }) => triggerKey === localReviewDraft.triggerKey);
    if (remoteReviewDraft === undefined) {
      throw new Error("Expected remote weekly Review draft");
    }
    expect(remoteReviewDraft.affectedProjectIds).toEqual([
      "dynamic-owner-project-1",
      "dynamic-owner-project-2",
    ]);
    const remoteReview = await commandOperation({
      workspace: remoteProject.workspace,
      command: { type: "create_review", review: remoteReviewDraft },
      commandId: "dynamic-owner-remote-review",
      deviceId: "phone",
      sequence: 3,
      now: reviewAt,
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "dynamic-owner-remote-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      previousOperationHash: remoteProject.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: 3,
            operationHash: ancestor.created.operationHash,
            revision: ancestor.receipt.revision,
            updatedAt: ancestor.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: localReview.created.operationHash,
            revision: localReview.receipt.revision,
            updatedAt: localReview.receipt.createdAt,
          },
          phone: {
            sequence: 3,
            operationHash: remoteReview.created.operationHash,
            revision: remoteReview.receipt.revision,
            updatedAt: remoteReview.receipt.createdAt,
          },
        },
        updatedAt: reviewAt,
      }),
    );
    for (const operation of [
      capacity,
      projectOneCapture,
      ancestor,
      localReview,
      remoteCapture,
      remoteProject,
      remoteReview,
    ]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-dynamic-owner";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await persistAsSent(repository, capacity);
    await persistAsSent(repository, projectOneCapture);
    await persistAsSent(repository, ancestor);
    await persistAsSent(repository, localReview);

    const merged = await new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: localReview.created.operationHash,
      remoteHeadHash: remoteReview.created.operationHash,
      now: "2026-07-12T05:01:00.000Z",
    });

    expect(merged.openedConflictIds).toHaveLength(1);
    const workspace = await repository.load();
    expect(workspace?.syncConflicts[0]?.affectedProjectIds).toEqual([
      "dynamic-owner-project-1",
      "dynamic-owner-project-2",
    ]);
    for (const projectId of [
      "dynamic-owner-project-1",
      "dynamic-owner-project-2",
    ]) {
      expect(
        workspace?.projects.find(({ id }) => id === projectId)?.holds,
      ).toContainEqual(
        expect.objectContaining({
          type: "sync_conflict",
          sourceId: merged.openedConflictIds[0],
        }),
      );
    }
  });

  it("normally replays boundary, validation, and editorial lifecycle writers", async () => {
    const projectId = "ordinary-replay-project";
    const briefId = `${projectId}:direction-brief:1`;
    const betId = "ordinary-replay-bet";
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const seedCapture = await commandOperation({
      workspace: genesis,
      command: {
        type: "capture_inbox",
        id: "ordinary-replay-inbox",
        text: "Shape the ordinary replay project",
      },
      commandId: "ordinary-replay-seed-capture",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-11T23:55:00.000Z",
    });
    const eligibility = {
      singleSession: false,
      estimateSeconds: 7_200,
      dependencyIds: [],
      requiresMilestoneEvidence: false,
      outcomeCount: 2,
      solutionKnown: false,
    };
    const seedProject = await commandOperation({
      workspace: seedCapture.workspace,
      command: {
        type: "confirm_project_triage",
        inboxItemId: "ordinary-replay-inbox",
        eligibility,
        project: {
          id: projectId,
          name: "Ordinary replay",
          priority: 1,
          notes: "",
        },
      },
      commandId: "ordinary-replay-seed-project",
      deviceId: "seed",
      sequence: 2,
      now: "2026-07-11T23:56:00.000Z",
      previousOperationHash: seedCapture.created.operationHash,
    });
    const directionDraft = {
      id: briefId,
      projectId,
      audienceAndProblem: "Operators need an exact bounded workflow.",
      successEvidence: "One complete bounded run succeeds.",
      appetiteSeconds: 7_200,
      validationMethod: "Run the complete acceptance path.",
      firstScope: [{
        id: "ordinary-replay-scope",
        title: "Bounded path",
        description: "Only the verified path.",
      }],
      noGoOrKill: "Stop if the path cannot be verified.",
      advancedNotes: "",
    };
    const seedDirection = await commandOperation({
      workspace: seedProject.workspace,
      command: {
        type: "update_direction",
        projectId,
        brief: directionDraft,
      },
      commandId: "ordinary-replay-seed-direction",
      deviceId: "seed",
      sequence: 3,
      now: "2026-07-11T23:57:00.000Z",
      previousOperationHash: seedProject.created.operationHash,
    });
    const ancestor = await commandOperation({
      workspace: seedDirection.workspace,
      command: {
        type: "place_bet",
        projectId,
        betId,
        start: "2026-07-12T00:00:00.000Z",
      },
      commandId: "ordinary-replay-seed-bet",
      deviceId: "seed",
      sequence: 4,
      now: "2026-07-12T00:00:00.000Z",
      previousOperationHash: seedDirection.created.operationHash,
    });
    const local = await captureOperation({
      workspace: ancestor.workspace,
      commandId: "ordinary-replay-local-capture",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T00:30:00.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const midpoint = await commandOperation({
      workspace: ancestor.workspace,
      command: {
        type: "record_bet_boundary",
        projectId,
        boundary: "midpoint",
        triggerKey: `${betId}:midpoint`,
      },
      commandId: "ordinary-replay-midpoint",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T01:00:00.000Z",
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "ordinary-replay-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      previousOperationHash: ancestor.created.operationHash,
    });
    const editorial = await commandOperation({
      workspace: midpoint.workspace,
      command: {
        type: "update_direction",
        projectId,
        brief: {
          ...directionDraft,
          advancedNotes: "Editorial clarification only.",
        },
      },
      commandId: "ordinary-replay-editorial",
      deviceId: "phone",
      sequence: 2,
      now: "2026-07-12T01:01:00.000Z",
      previousOperationHash: midpoint.created.operationHash,
    });
    const requested = await commandOperation({
      workspace: editorial.workspace,
      command: { type: "request_validation", projectId },
      commandId: "ordinary-replay-request-validation",
      deviceId: "phone",
      sequence: 3,
      now: "2026-07-12T01:02:00.000Z",
      previousOperationHash: editorial.created.operationHash,
    });
    const satisfied = await commandOperation({
      workspace: requested.workspace,
      command: { type: "satisfy_validation", projectId },
      commandId: "ordinary-replay-satisfy-validation",
      deviceId: "phone",
      sequence: 4,
      now: "2026-07-12T01:03:00.000Z",
      previousOperationHash: requested.created.operationHash,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          seed: {
            sequence: 4,
            operationHash: ancestor.created.operationHash,
            revision: ancestor.receipt.revision,
            updatedAt: ancestor.receipt.createdAt,
          },
          desktop: {
            sequence: 1,
            operationHash: local.created.operationHash,
            revision: local.receipt.revision,
            updatedAt: local.receipt.createdAt,
          },
          phone: {
            sequence: 4,
            operationHash: satisfied.created.operationHash,
            revision: satisfied.receipt.revision,
            updatedAt: satisfied.receipt.createdAt,
          },
        },
        updatedAt: satisfied.receipt.createdAt,
      }),
    );
    const operations = [
      seedCapture,
      seedProject,
      seedDirection,
      ancestor,
      local,
      midpoint,
      editorial,
      requested,
      satisfied,
    ];
    for (const operation of operations) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-ordinary-lifecycle";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    for (const operation of [
      seedCapture,
      seedProject,
      seedDirection,
      ancestor,
      local,
    ]) {
      await persistAsSent(repository, operation);
    }
    const merged = await new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: satisfied.created.operationHash,
      now: "2026-07-12T01:04:00.000Z",
    });
    expect(merged.replayedOperationHashes).toEqual([
      midpoint.created.operationHash,
      editorial.created.operationHash,
      requested.created.operationHash,
      satisfied.created.operationHash,
    ]);
    expect(merged.openedConflictIds).toEqual([]);
    expect((await repository.load())?.projects).toEqual(
      satisfied.workspace.projects,
    );
  });

  it("opens one Bet conflict when a material Direction edit races a human Re-bet", async () => {
    const approvedAt = "2026-07-12T09:00:00.000Z";
    const appetiteEnd = "2026-07-12T11:00:00.000Z";
    const brief = buildDirectionBrief({
      id: "material-race-brief-1",
      projectId: "material-race-project",
      version: 1,
      audienceAndProblem: "Operators lose the bounded next action.",
      successEvidence: "Five operators complete it without coaching.",
      appetiteSeconds: 7_200,
      validationMethod: "Observe five bounded runs.",
      firstScope: [{
        id: "material-race-scope",
        title: "Bounded start",
        description: "Only the approved start.",
      }],
      noGoOrKill: "Stop if coaching is required.",
      advancedNotes: "",
      createdAt: approvedAt,
      updatedAt: approvedAt,
    });
    const bet = buildBetVersion({
      id: "material-race-bet-old",
      projectId: "material-race-project",
      version: 1,
      briefId: brief.id,
      briefHash: await stableHash(brief as unknown as JsonValue),
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: approvedAt,
      appetiteEnd,
      actorId: "human-seed",
      approvedAt,
    });
    const workItem = buildProjectWorkItem({
      id: "material-race-work",
      projectId: "material-race-project",
      betScopeId: "material-race-scope",
      durationSeconds: 1_800,
      estimate: { mostLikelySeconds: 1_800 },
    });
    const genesis = buildWorkspaceV2(WORKSPACE_ID, {
      projects: [buildProjectV2({
        id: "material-race-project",
        name: "Material race",
        priority: 1,
        notes: "",
        stage: "executing",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        activePlanVersionId: "material-race-plan",
        createdAt: approvedAt,
        updatedAt: approvedAt,
      })],
      directionBriefs: [structuredClone(brief)],
      bets: [structuredClone(bet)],
      workItems: [structuredClone(workItem)],
      planVersions: [{
        id: "material-race-plan",
        projectId: "material-race-project",
        version: 1,
        betId: bet.id,
        workItemRevisions: { [workItem.id]: workItem.revision },
        dependencyRevisions: {},
        scopeMapping: { [workItem.id]: workItem.betScopeId },
        scheduleHash: "material-race-plan-hash",
        capacityIndependentDates: {
          [workItem.id]: {
            start: approvedAt,
            finish: "2026-07-12T10:00:00.000Z",
          },
        },
        actorId: "human-seed",
        createdAt: approvedAt,
      }],
    });
    const ancestor = await captureOperation({
      workspace: genesis,
      commandId: "material-race-ancestor",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-12T09:05:00.000Z",
    });
    const boundary = await commandOperation({
      workspace: ancestor.workspace,
      command: {
        type: "record_bet_boundary",
        projectId: "material-race-project",
        boundary: "expired",
        triggerKey: `${bet.id}:expired`,
      },
      commandId: "material-race-boundary",
      deviceId: "desktop",
      sequence: 1,
      now: appetiteEnd,
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "verified-system-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      previousOperationHash: ancestor.created.operationHash,
    });
    const localRebet = await commandOperation({
      workspace: boundary.workspace,
      command: {
        type: "place_bet",
        projectId: "material-race-project",
        betId: "material-race-bet-new",
        start: "2026-07-12T11:01:00.000Z",
      },
      commandId: "material-race-rebet",
      deviceId: "desktop",
      sequence: 2,
      now: "2026-07-12T11:01:00.000Z",
      previousOperationHash: boundary.created.operationHash,
    });
    const remoteDirection = await commandOperation({
      workspace: ancestor.workspace,
      command: {
        type: "update_direction",
        projectId: "material-race-project",
        brief: {
          id: brief.id,
          projectId: brief.projectId,
          audienceAndProblem: brief.audienceAndProblem,
          successEvidence: "Seven operators complete it without coaching.",
          appetiteSeconds: brief.appetiteSeconds,
          validationMethod: brief.validationMethod,
          firstScope: structuredClone(brief.firstScope),
          noGoOrKill: brief.noGoOrKill,
          advancedNotes: brief.advancedNotes,
        },
      },
      commandId: "material-race-direction",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T10:00:00.000Z",
      previousOperationHash: ancestor.created.operationHash,
    });
    const manifest = createSyncManifestV2({
      workspaceId: WORKSPACE_ID,
      heads: {
        seed: {
          sequence: 1,
          operationHash: ancestor.created.operationHash,
          revision: ancestor.receipt.revision,
          updatedAt: ancestor.receipt.createdAt,
        },
        desktop: {
          sequence: 2,
          operationHash: localRebet.created.operationHash,
          revision: localRebet.receipt.revision,
          updatedAt: localRebet.receipt.createdAt,
        },
        phone: {
          sequence: 1,
          operationHash: remoteDirection.created.operationHash,
          revision: remoteDirection.receipt.revision,
          updatedAt: remoteDirection.receipt.createdAt,
        },
      },
      updatedAt: localRebet.receipt.createdAt,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(syncManifestPathV2(WORKSPACE_ID), manifest);
    for (const operation of [ancestor, boundary, localRebet, remoteDirection]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-material-direction-rebet";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(buildWorkspaceV2(WORKSPACE_ID));
    await expect(repository.commit({
      expectedRevision: 0,
      workspace: ancestor.workspace,
      outboxEntry: {
        id: `outbox-${ancestor.context.commandId}`,
        workspaceId: WORKSPACE_ID,
        commandId: ancestor.context.commandId,
        baseRevision: ancestor.receipt.baseRevision,
        revision: ancestor.receipt.revision,
        command: structuredClone(ancestor.command),
        actor: {
          actorId: ancestor.context.actorId,
          actorKind: ancestor.context.actorKind,
          origin: ancestor.context.origin,
          source: structuredClone(ancestor.context.source),
        },
        payloadHash: ancestor.receipt.payloadHash,
        receiptId: ancestor.receipt.id,
        createdAt: ancestor.context.now,
        status: "pending",
      },
    })).resolves.toBe("committed");
    await repository.prepareOutboxOperation(
      `outbox-${ancestor.context.commandId}`,
      {
        operationHash: ancestor.created.operationHash,
        path: ancestor.created.path,
        envelopeJson: canonicalJson(ancestor.created.envelope),
      },
    );
    await repository.markOutboxSent(
      `outbox-${ancestor.context.commandId}`,
      ancestor.created.operationHash,
      ancestor.context.now,
    );
    await persistAsSent(repository, boundary);
    await persistAsSent(repository, localRebet);

    const result = await new SyncMergeV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: localRebet.created.operationHash,
      remoteHeadHash: remoteDirection.created.operationHash,
      now: "2026-07-12T11:02:00.000Z",
    });

    expect(result).toMatchObject({
      status: "merged",
      replayedOperationHashes: [],
      revision: localRebet.workspace.revision + 1,
    });
    expect(result.openedConflictIds).toHaveLength(1);
    const conflict = (await repository.load())?.syncConflicts[0];
    expect(conflict).toMatchObject({
      id: result.openedConflictIds[0],
      recordType: "bet",
      recordId: "material-race-bet-new",
      remoteRecordId: "material-race-bet-old",
      logicalKey: '["bet","material-race-project"]',
    });
    expect(conflict?.localBundle?.operations.map(({ commandType }) => commandType)).toEqual([
      "record_bet_boundary",
      "place_bet",
    ]);
    const remoteBundle = conflict?.remoteBundle;
    if (remoteBundle === undefined) throw new Error("Missing remote Bet bundle");
    expect(remoteBundle.operations.map(({ commandType }) => commandType)).toEqual([
      "update_direction",
    ]);
    expect(remoteBundle.operations[0]?.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "scalar",
          entity: "BetVersion",
          entityId: bet.id,
          ownerProjectId: "material-race-project",
        }),
        expect.objectContaining({
          kind: "create",
          entity: "DirectionBrief",
          entityId: "material-race-project:direction-brief:2",
        }),
      ]),
    );
  });

  it("opens a deterministic conflict instead of replaying a divergent protected record writer", async () => {
    const genesis = buildWorkspaceV2(WORKSPACE_ID);
    const profile = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [{ weekday: 0, startMinute: 360, finishMinute: 480 }],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 3_600,
          mediumSeconds: 3_600,
          shallowSeconds: 3_600,
        },
      ],
      unavailableBlocks: [],
      updatedAt: "2026-07-12T04:00:00.000Z",
      updatedBy: "human-seed",
    });
    const ancestor = await commandOperation({
      workspace: genesis,
      command: { type: "configure_capacity", profile },
      commandId: "capacity-ancestor",
      deviceId: "seed",
      sequence: 1,
      now: "2026-07-12T04:00:00.000Z",
    });
    const proposal = await generateTodayProposal(
      ancestor.workspace,
      "2026-07-12",
      "2026-07-12T05:00:00.000Z",
    );
    const commitment: DailyCommitmentDraft = {
      id: "commitment-shared",
      localDate: proposal.localDate,
      workspaceRevision: proposal.workspaceRevision,
      generatedAt: proposal.generatedAt,
      proposalHash: proposal.proposalHash,
      slots: structuredClone(proposal.slots),
    };
    const local = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "commit_today", commitment },
      commandId: "commit-local",
      deviceId: "desktop",
      sequence: 1,
      now: "2026-07-12T05:01:00.000Z",
      actorId: "human-local",
      previousOperationHash: ancestor.created.operationHash,
    });
    const remoteBranch = await commandOperation({
      workspace: ancestor.workspace,
      command: { type: "commit_today", commitment },
      commandId: "commit-remote",
      deviceId: "phone",
      sequence: 1,
      now: "2026-07-12T05:02:00.000Z",
      actorId: "human-remote",
      previousOperationHash: ancestor.created.operationHash,
    });
    const remoteUnrelated = await captureOperation({
      workspace: remoteBranch.workspace,
      commandId: "capture-through-protected-conflict",
      deviceId: "phone",
      sequence: 2,
      now: "2026-07-12T05:02:30.000Z",
      previousOperationHash: remoteBranch.created.operationHash,
    });
    const manifest = createSyncManifestV2({
      workspaceId: WORKSPACE_ID,
      heads: {
        seed: {
          sequence: 1,
          operationHash: ancestor.created.operationHash,
          revision: ancestor.receipt.revision,
          updatedAt: ancestor.receipt.createdAt,
        },
        desktop: {
          sequence: 1,
          operationHash: local.created.operationHash,
          revision: local.receipt.revision,
          updatedAt: local.receipt.createdAt,
        },
        phone: {
          sequence: 2,
          operationHash: remoteUnrelated.created.operationHash,
          revision: remoteUnrelated.receipt.revision,
          updatedAt: remoteUnrelated.receipt.createdAt,
        },
      },
      updatedAt: remoteUnrelated.receipt.createdAt,
    });
    const remote = new MemoryHistoryRemote();
    remote.put(syncManifestPathV2(WORKSPACE_ID), manifest);
    for (const operation of [ancestor, local, remoteBranch, remoteUnrelated]) {
      remote.put(operation.created.path, operation.created.envelope);
    }
    const databaseName = "omni-plan-v2-sync-merge-protected";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB: indexedDBFactory,
    });
    await repository.initialize(genesis);
    await persistAsSent(repository, ancestor);
    await persistAsSent(repository, local);

    let failConflictCommit = true;
    const transientFailureRepository = new Proxy(repository, {
      get(target, property) {
        if (property === "commit") {
          return async (
            input: Parameters<AtomicWorkspaceRepository["commit"]>[0],
          ) => {
            if (
              failConflictCommit &&
              input.outboxEntry.command.type === "open_sync_conflict"
            ) {
              failConflictCommit = false;
              throw new Error("temporary conflict write failure");
            }
            return target.commit(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AtomicWorkspaceRepository;
    const merger = new SyncMergeV2({
      repository: transientFailureRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const mergeInput = {
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: local.created.operationHash,
      remoteHeadHash: remoteUnrelated.created.operationHash,
      now: "2026-07-12T05:03:00.000Z",
    } as const;
    await expect(merger.merge(mergeInput)).rejects.toThrow(
      "temporary conflict write failure",
    );
    expect((await repository.load())?.inboxItems).toContainEqual(
      expect.objectContaining({
        id: "inbox-capture-through-protected-conflict",
      }),
    );
    expect((await repository.load())?.syncConflicts).toEqual([]);

    const result = await merger.merge(mergeInput);

    expect(result.replayedOperationHashes).toEqual([
      remoteUnrelated.created.operationHash,
    ]);
    expect(result.openedConflictIds).toHaveLength(1);
    const workspace = await repository.load();
    const conflict = workspace?.syncConflicts[0];
    expect(conflict).toMatchObject({
      id: result.openedConflictIds[0],
      recordType: "daily_commitment",
      recordId: "commitment-shared",
      commonAncestorHash: ancestor.created.operationHash,
      localValue: local.workspace.dailyCommitments[0],
      remoteValue: remoteBranch.workspace.dailyCommitments[0],
      openedAt: "2026-07-12T05:02:00.000Z",
    });
    expect(workspace?.dailyCommitments).toEqual(local.workspace.dailyCommitments);
    expect(workspace?.inboxItems).toContainEqual(
      expect.objectContaining({
        id: "inbox-capture-through-protected-conflict",
      }),
    );
    expect(workspace?.reviews).toContainEqual(
      expect.objectContaining({
        id: `review:sync_conflict:${result.openedConflictIds[0]}`,
        triggerKey: `sync_conflict:${result.openedConflictIds[0]}`,
        status: "open",
      }),
    );
    expect(await repository.listPendingOutbox()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          commandId: "capture-through-protected-conflict",
          command: expect.objectContaining({ type: "capture_inbox" }),
        }),
        expect.objectContaining({
          command: expect.objectContaining({ type: "open_sync_conflict" }),
          actor: expect.objectContaining({
            actorKind: "system",
            origin: "agent",
          }),
        }),
      ]),
    );

    const reverseDatabaseName = "omni-plan-v2-sync-merge-protected-reverse";
    databaseNames.push(reverseDatabaseName);
    const reverseRepository = new BrowserWorkspaceRepository({
      databaseName: reverseDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await reverseRepository.initialize(genesis);
    await persistAsSent(reverseRepository, ancestor);
    await persistAsSent(reverseRepository, remoteBranch);
    await persistAsSent(reverseRepository, remoteUnrelated);
    const reverse = await new SyncMergeV2({
      repository: reverseRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: remoteUnrelated.created.operationHash,
      remoteHeadHash: local.created.operationHash,
      now: "2026-07-12T05:03:00.000Z",
    });
    expect(reverse.openedConflictIds).toEqual(result.openedConflictIds);
    expect((await reverseRepository.load())?.syncConflicts[0]).toMatchObject({
      id: result.openedConflictIds[0],
      localValue: remoteBranch.workspace.dailyCommitments[0],
      remoteValue: local.workspace.dailyCommitments[0],
    });
    await new SyncAdapterV2({
      repository: reverseRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "phone",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:03:30.000Z",
    }).flushPending();
    await expect(
      materializeRemoteSyncHistoryV2({
        remote,
        workspaceId: WORKSPACE_ID,
        passphrase: PASSPHRASE,
      }),
    ).resolves.toMatchObject({ workspaceId: WORKSPACE_ID });

    const beforeRepeat = await repository.load();
    const pendingBeforeRepeat = await repository.listPendingOutbox();
    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "already_merged",
      commonAncestorHash: ancestor.created.operationHash,
      replayedOperationHashes: [],
      openedConflictIds: [],
      revision: beforeRepeat?.revision,
    });
    expect(await repository.load()).toEqual(beforeRepeat);
    expect(await repository.listPendingOutbox()).toEqual(pendingBeforeRepeat);

    await expect(
      new SyncAdapterV2({
        repository,
        remote,
        workspaceId: WORKSPACE_ID,
        deviceId: "desktop",
        keyProvider: { getPassphrase: async () => PASSPHRASE },
        clock: () => "2026-07-12T05:04:00.000Z",
      }).flushPending(),
    ).resolves.toEqual({ sent: 2, pending: 0 });
    const propagatedHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const openConflictHead = propagatedHistory.manifest.heads.desktop.operationHash;

    const thirdDatabaseName =
      "omni-plan-v2-sync-merge-persisted-open-third-device";
    databaseNames.push(thirdDatabaseName);
    const thirdRepository = new BrowserWorkspaceRepository({
      databaseName: thirdDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await thirdRepository.initialize(genesis);
    await persistAsSent(thirdRepository, ancestor);
    const thirdMerge = await new SyncMergeV2({
      repository: thirdRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: ancestor.created.operationHash,
      remoteHeadHash: openConflictHead,
      now: "2026-07-12T05:04:30.000Z",
    });
    expect(thirdMerge.openedConflictIds).toEqual(result.openedConflictIds);
    expect((await thirdRepository.load())?.syncConflicts).toEqual([
      expect.objectContaining({
        id: result.openedConflictIds[0],
        localValue: local.workspace.dailyCommitments[0],
        remoteValue: remoteBranch.workspace.dailyCommitments[0],
      }),
    ]);
    expect((await thirdRepository.load())?.reviews).toEqual([
      expect.objectContaining({
        id: `review:sync_conflict:${result.openedConflictIds[0]}`,
        status: "open",
      }),
    ]);
    await expect(
      new SyncAdapterV2({
        repository: thirdRepository,
        remote,
        workspaceId: WORKSPACE_ID,
        deviceId: "third-device",
        keyProvider: { getPassphrase: async () => PASSPHRASE },
        clock: () => "2026-07-12T05:04:40.000Z",
      }).flushPending(),
    ).resolves.toEqual({ sent: 3, pending: 0 });
    const thirdPropagatedHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    expect(
      thirdPropagatedHistory.operations.filter(
        ({ command }) => command.type === "open_sync_conflict",
      ),
    ).toHaveLength(3);
    const thirdDeviceOperations = thirdPropagatedHistory.operations
      .filter(({ deviceId }) => deviceId === "third-device")
      .sort((left, right) => left.sequence - right.sequence);
    expect(thirdDeviceOperations).toHaveLength(3);
    const propagatedOpenParent = thirdDeviceOperations[1];
    const propagatedOpenChild = thirdDeviceOperations[2];
    if (
      propagatedOpenParent === undefined ||
      propagatedOpenChild === undefined ||
      propagatedOpenChild.command.type !== "open_sync_conflict"
    ) {
      throw new Error("Expected the third-device propagated open chain");
    }
    const propagatedParentBranch = await authorizeSyncBranchV2({
      history: thirdPropagatedHistory,
      trustedAncestorWorkspace: ancestor.workspace,
      ancestorOperationHash: ancestor.created.operationHash,
      headOperationHash: propagatedOpenParent.operationHash,
    });
    await expect(
      authorizeSyncBranchV2({
        history: thirdPropagatedHistory,
        trustedAncestorWorkspace: propagatedParentBranch.workspace,
        ancestorOperationHash: propagatedOpenParent.operationHash,
        headOperationHash: propagatedOpenChild.operationHash,
      }),
    ).resolves.toMatchObject({
      headOperationHash: propagatedOpenChild.operationHash,
      workspace: {
        syncConflicts: [
          expect.objectContaining({ id: result.openedConflictIds[0] }),
        ],
      },
    });

    const propagationDatabaseName =
      "omni-plan-v2-sync-merge-protected-propagation";
    databaseNames.push(propagationDatabaseName);
    const propagationRepository = new BrowserWorkspaceRepository({
      databaseName: propagationDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await propagationRepository.initialize(genesis);
    await persistAsSent(propagationRepository, ancestor);
    await persistAsSent(propagationRepository, remoteBranch);
    await persistAsSent(propagationRepository, remoteUnrelated);
    const propagated = await new SyncMergeV2({
      repository: propagationRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: remoteUnrelated.created.operationHash,
      remoteHeadHash: openConflictHead,
      now: "2026-07-12T05:05:00.000Z",
    });

    expect(propagated.replayedOperationHashes).toEqual([]);
    expect(propagated.openedConflictIds).toEqual(result.openedConflictIds);
    expect((await propagationRepository.load())?.syncConflicts).toEqual([
      expect.objectContaining({
        id: result.openedConflictIds[0],
        localValue: remoteBranch.workspace.dailyCommitments[0],
        remoteValue: local.workspace.dailyCommitments[0],
      }),
    ]);
    expect((await propagationRepository.load())?.reviews).toEqual([
      expect.objectContaining({
        id: `review:sync_conflict:${result.openedConflictIds[0]}`,
        status: "open",
      }),
    ]);
    const propagationOpenHead =
      propagatedHistory.manifest.heads.phone.operationHash;
    const propagationOpenReplay = propagatedHistory.operations.find(
      ({ operationHash }) => operationHash === propagationOpenHead,
    );
    const propagationPending =
      await propagationRepository.listPendingOutbox();
    const propagationOpenFile = propagationOpenReplay === undefined
      ? undefined
      : await remote.read(propagationOpenReplay.path);
    if (
      propagationOpenReplay === undefined ||
      propagationOpenFile === undefined ||
      propagationPending.length !== 1 ||
      propagationPending[0].command.type !== "open_sync_conflict" ||
      propagationPending[0].commandId !==
        propagationOpenReplay.receipt.commandId ||
      canonicalJson(propagationPending[0].command) !==
        canonicalJson(propagationOpenReplay.command)
    ) {
      throw new Error("Expected the existing branch-local open marker");
    }
    await propagationRepository.prepareOutboxOperation(
      propagationPending[0].id,
      {
        operationHash: propagationOpenHead,
        path: propagationOpenReplay.path,
        envelopeJson: propagationOpenFile.content,
      },
    );
    await propagationRepository.markOutboxSent(
      propagationPending[0].id,
      propagationOpenHead,
      "2026-07-12T05:05:05.000Z",
    );

    const oneSidedDatabaseName =
      "omni-plan-v2-sync-merge-one-sided-resolution";
    databaseNames.push(oneSidedDatabaseName);
    const oneSidedRepository = new BrowserWorkspaceRepository({
      databaseName: oneSidedDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await oneSidedRepository.initialize(genesis);
    await persistAsSent(oneSidedRepository, ancestor);
    await persistAsSent(oneSidedRepository, remoteBranch);
    await persistAsSent(oneSidedRepository, remoteUnrelated);
    await new SyncMergeV2({
      repository: oneSidedRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: remoteUnrelated.created.operationHash,
      remoteHeadHash: openConflictHead,
      now: "2026-07-12T05:05:10.000Z",
    });
    const oneSidedOpenWorkspace = await oneSidedRepository.load();
    if (oneSidedOpenWorkspace === undefined) {
      throw new Error("Expected one-sided unresolved conflict Workspace");
    }
    const oneSidedPending = await oneSidedRepository.listPendingOutbox();
    if (
      oneSidedPending.length !== 1 ||
      oneSidedPending[0].command.type !== "open_sync_conflict"
    ) {
      throw new Error("Expected one pending one-sided conflict open");
    }
    const oneSidedOpenReceipt = oneSidedOpenWorkspace.commandReceipts.find(
      ({ commandId, status }) =>
        status === "applied" && commandId === oneSidedPending[0].commandId,
    );
    if (oneSidedOpenReceipt === undefined) {
      throw new Error("Expected one-sided conflict-open receipt");
    }
    const oneSidedOpenOperation = await createSyncOperationV2({
      workspaceId: WORKSPACE_ID,
      deviceId: "one-sided-local",
      sequence: 1,
      operationId: "operation-one-sided-local-open",
      command: oneSidedPending[0].command,
      receipt: oneSidedOpenReceipt,
      previousOperationHash: remoteUnrelated.created.operationHash,
      passphrase: PASSPHRASE,
    });
    remote.put(
      oneSidedOpenOperation.path,
      oneSidedOpenOperation.envelope,
    );
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          ...propagatedHistory.manifest.heads,
          phone: {
            sequence: 2,
            operationHash: remoteUnrelated.created.operationHash,
            revision: remoteUnrelated.receipt.revision,
            updatedAt: remoteUnrelated.receipt.createdAt,
          },
          "one-sided-local": {
            sequence: 1,
            operationHash: oneSidedOpenOperation.operationHash,
            revision: oneSidedOpenReceipt.revision,
            updatedAt: oneSidedOpenReceipt.createdAt,
          },
        },
        updatedAt: "2026-07-12T05:05:20.000Z",
      }),
    );
    await oneSidedRepository.prepareOutboxOperation(
      oneSidedPending[0].id,
      {
        operationHash: oneSidedOpenOperation.operationHash,
        path: oneSidedOpenOperation.path,
        envelopeJson: canonicalJson(oneSidedOpenOperation.envelope),
      },
    );
    await oneSidedRepository.markOutboxSent(
      oneSidedPending[0].id,
      oneSidedOpenOperation.operationHash,
      "2026-07-12T05:05:20.000Z",
    );
    const oneSidedOpenHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const oneSidedOpenHead = oneSidedOpenOperation.operationHash;
    const oneSidedConflict = oneSidedOpenWorkspace.syncConflicts[0];
    if (oneSidedConflict?.localBundle === undefined) {
      throw new Error("Expected one-sided local conflict bundle");
    }
    const oneSidedResolution = await commandOperation({
      workspace: oneSidedOpenWorkspace,
      command: {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${oneSidedConflict.id}`,
        resolution: {
          conflictId: oneSidedConflict.id,
          retainedVersion: "local",
          retainedBundleHash: oneSidedConflict.localBundle.hash,
          retainedValue: structuredClone(oneSidedConflict.localValue),
          rationale: "Retain the currently applied verified side.",
        },
      },
      commandId: "one-sided-remote-resolution",
      deviceId: "one-sided-remote",
      sequence: 1,
      now: "2026-07-12T05:05:30.000Z",
      previousOperationHash: oneSidedOpenHead,
    });
    const postResolutionCapacity = await commandOperation({
      workspace: oneSidedResolution.workspace,
      command: {
        type: "configure_capacity",
        profile: {
          ...structuredClone(profile),
          dailyBudgets: profile.dailyBudgets.map((budget) => ({
            ...budget,
            shallowSeconds: budget.shallowSeconds + 600,
          })),
          updatedAt: "2026-07-12T05:05:32.000Z",
          updatedBy: "human-one-sided-remote",
        },
      },
      commandId: "capacity-after-one-sided-resolution",
      deviceId: "one-sided-remote",
      sequence: 2,
      now: "2026-07-12T05:05:32.000Z",
      previousOperationHash: oneSidedResolution.created.operationHash,
    });
    const postResolutionProposal = await buildReplanProposal(
      postResolutionCapacity.workspace,
      {
        id: "proposal-after-one-sided-resolution",
        localDate: "2026-07-12",
        reasonCodes: ["ACTUAL_CHANGED"],
        createdAt: "2026-07-12T05:05:35.000Z",
        createdBy: "human-one-sided-remote",
      },
    );
    const postResolutionWriter = await commandOperation({
      workspace: postResolutionCapacity.workspace,
      command: { type: "propose_replan", proposal: postResolutionProposal },
      commandId: "writer-after-one-sided-resolution",
      deviceId: "one-sided-remote",
      sequence: 3,
      now: "2026-07-12T05:05:35.000Z",
      previousOperationHash: postResolutionCapacity.created.operationHash,
    });
    remote.put(
      oneSidedResolution.created.path,
      oneSidedResolution.created.envelope,
    );
    remote.put(
      postResolutionCapacity.created.path,
      postResolutionCapacity.created.envelope,
    );
    remote.put(
      postResolutionWriter.created.path,
      postResolutionWriter.created.envelope,
    );
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          ...oneSidedOpenHistory.manifest.heads,
          "one-sided-remote": {
            sequence: 3,
            operationHash: postResolutionWriter.created.operationHash,
            revision: postResolutionWriter.receipt.revision,
            updatedAt: postResolutionWriter.receipt.createdAt,
          },
        },
        updatedAt: postResolutionWriter.receipt.createdAt,
      }),
    );

    let failOneSidedResolution = true;
    let failPostResolutionWriter = true;
    const oneSidedTransientRepository = new Proxy(oneSidedRepository, {
      get(target, property) {
        if (property === "commit") {
          return async (
            input: Parameters<AtomicWorkspaceRepository["commit"]>[0],
          ) => {
            if (
              failOneSidedResolution &&
              input.outboxEntry.commandId ===
                "one-sided-remote-resolution"
            ) {
              failOneSidedResolution = false;
              throw new Error("temporary one-sided resolution failure");
            }
            if (
              failPostResolutionWriter &&
              input.outboxEntry.commandId ===
                "writer-after-one-sided-resolution"
            ) {
              failPostResolutionWriter = false;
              throw new Error("temporary post-resolution writer failure");
            }
            return target.commit(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AtomicWorkspaceRepository;
    const oneSidedMerger = new SyncMergeV2({
      repository: oneSidedTransientRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const oneSidedMergeInput = {
      trustedAncestorWorkspace: oneSidedOpenWorkspace,
      localHeadHash: oneSidedOpenHead,
      remoteHeadHash: postResolutionWriter.created.operationHash,
      now: "2026-07-12T05:05:40.000Z",
    } as const;
    const beforeResolutionFailure = await oneSidedRepository.load();
    const outboxBeforeResolutionFailure =
      await oneSidedRepository.listPendingOutbox();
    await expect(oneSidedMerger.merge(oneSidedMergeInput)).rejects.toThrow(
      "temporary one-sided resolution failure",
    );
    const afterResolutionFailure = await oneSidedRepository.load();
    expect(afterResolutionFailure).toEqual(beforeResolutionFailure);
    expect(await oneSidedRepository.listPendingOutbox()).toEqual(
      outboxBeforeResolutionFailure,
    );
    expect(afterResolutionFailure?.syncConflicts).toEqual([
      expect.objectContaining({ id: oneSidedConflict.id }),
    ]);
    expect(afterResolutionFailure?.syncConflicts[0]?.resolvedAt).toBeUndefined();
    await expect(oneSidedMerger.merge(oneSidedMergeInput)).rejects.toThrow(
      "temporary post-resolution writer failure",
    );
    expect((await oneSidedRepository.load())?.syncConflicts).toEqual([
      expect.objectContaining({
        id: oneSidedConflict.id,
        retainedVersion: "local",
      }),
    ]);
    expect((await oneSidedRepository.load())?.replanProposals).toEqual([]);
    const oneSidedMerged = await oneSidedMerger.merge(oneSidedMergeInput);
    expect(oneSidedMerged).toMatchObject({
      replayedOperationHashes: [
        oneSidedResolution.created.operationHash,
        postResolutionCapacity.created.operationHash,
        postResolutionWriter.created.operationHash,
      ],
      openedConflictIds: [],
    });
    expect((await oneSidedRepository.load())?.replanProposals).toEqual(
      postResolutionWriter.workspace.replanProposals,
    );
    expect((await oneSidedRepository.load())?.syncConflicts).toEqual([
      expect.objectContaining({
        id: oneSidedConflict.id,
        retainedVersion: "local",
        resolvedAt: oneSidedResolution.receipt.createdAt,
      }),
    ]);
    expect((await oneSidedRepository.load())?.reviews).toEqual([
      expect.objectContaining({
        id: `review:sync_conflict:${oneSidedConflict.id}`,
        status: "completed",
      }),
    ]);
    const beforeExtraLocalMutation = await oneSidedRepository.load();
    if (beforeExtraLocalMutation === undefined) {
      throw new Error("Expected converged one-sided Workspace");
    }
    const extraLocalMutation = await new CommandService(
      oneSidedRepository,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "capture_inbox",
        id: "extra-local-after-one-sided-retry",
        text: "Must invalidate the proven merge prefix",
      },
      buildCommandContext({
        commandId: "extra-local-after-one-sided-retry",
        expectedRevision: beforeExtraLocalMutation.revision,
        actorId: "local-human-after-retry",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-local-human-after-retry",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T05:05:42.000Z",
      }),
    );
    if (!extraLocalMutation.ok) {
      throw new Error("Expected extra local mutation after retry");
    }
    await expect(
      oneSidedMerger.merge(oneSidedMergeInput),
    ).rejects.toMatchObject({ code: "LOCAL_CHECKPOINT_STALE" });
    await new SyncAdapterV2({
      repository: oneSidedRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "one-sided-local",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:05:45.000Z",
    }).flushPending();
    const beforeResolution = await repository.load();
    if (beforeResolution === undefined) throw new Error("Expected A conflict");
    const conflictBeforeResolution = beforeResolution.syncConflicts.find(
      ({ id }) => id === result.openedConflictIds[0],
    );
    if (conflictBeforeResolution?.localBundle === undefined) {
      throw new Error("Expected A local conflict bundle");
    }
    const resolvedOnA = await new CommandService(
      repository,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${result.openedConflictIds[0]}`,
        resolution: {
          conflictId: result.openedConflictIds[0],
          retainedVersion: "local",
          retainedBundleHash: conflictBeforeResolution.localBundle.hash,
          retainedValue: structuredClone(
            local.workspace.dailyCommitments[0],
          ) as unknown as JsonValue,
          rationale: "Keep A's human-selected commitment.",
        },
      },
      buildCommandContext({
        commandId: "resolve-conflict-on-a",
        expectedRevision: beforeResolution.revision,
        actorId: "human-desktop",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-desktop",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T05:06:00.000Z",
      }),
    );
    if (!resolvedOnA.ok) {
      throw new Error(`Expected A resolution: ${resolvedOnA.rejection.code}`);
    }
    await new SyncAdapterV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: "desktop",
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:07:00.000Z",
    }).flushPending();
    const beforeOpenMarkerMerge = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const markerHeads = Object.fromEntries(
      Object.entries(beforeOpenMarkerMerge.manifest.heads).filter(
        ([deviceId]) =>
          ![
            "one-sided-local",
            "one-sided-remote",
            "concurrent-resolution",
          ].includes(deviceId),
      ),
    );
    remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      createSyncManifestV2({
        workspaceId: WORKSPACE_ID,
        heads: {
          ...markerHeads,
          phone: {
            sequence: propagationOpenReplay.sequence,
            operationHash: propagationOpenReplay.operationHash,
            revision: propagationOpenReplay.receipt.revision,
            updatedAt: propagationOpenReplay.receipt.createdAt,
          },
        },
        updatedAt: "2026-07-12T05:07:00.000Z",
      }),
    );
    const resolvedHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const resolvedAHead = resolvedHistory.manifest.heads.desktop.operationHash;
    const converged = await new SyncMergeV2({
      repository: propagationRepository,
      remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: ancestor.workspace,
      localHeadHash: propagationOpenHead,
      remoteHeadHash: resolvedAHead,
      now: "2026-07-12T05:08:00.000Z",
    });
    expect(converged.openedConflictIds).toEqual([]);
    const convergedWorkspace = await propagationRepository.load();
    expect(convergedWorkspace?.dailyCommitments).toEqual(
      local.workspace.dailyCommitments,
    );
    expect(convergedWorkspace?.syncConflicts).toEqual([
      expect.objectContaining({
        id: result.openedConflictIds[0],
        retainedVersion: "remote",
        resolvedAt: "2026-07-12T05:06:00.000Z",
      }),
    ]);
    expect(convergedWorkspace?.reviews).toEqual([
      expect.objectContaining({
        id: `review:sync_conflict:${result.openedConflictIds[0]}`,
        status: "completed",
      }),
    ]);
  }, 10_000);

  it("records independent equivalent conflict resolutions as auditable no-op confirmations", async () => {
    const fixture = await openDailyConflictFixture("equivalent-resolution");
    const left = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "local",
        rationale: "Left human retains the verified local commitment.",
      }),
      commandId: "equivalent-resolution-left",
      deviceId: "equivalent-resolution-left",
      sequence: 1,
      actorId: "equivalent-left-human",
      now: "2026-07-12T05:04:00.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    const right = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "local",
        rationale: "Right human independently retains the same commitment.",
      }),
      commandId: "equivalent-resolution-right",
      deviceId: "equivalent-resolution-right",
      sequence: 1,
      actorId: "equivalent-right-human",
      now: "2026-07-12T05:04:30.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    await persistAsSent(fixture.repository, left);
    fixture.remote.put(left.created.path, left.created.envelope);
    fixture.remote.put(right.created.path, right.created.envelope);
    const openHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const resolutionManifest = await advanceSyncManifestV2(
      await advanceSyncManifestV2(openHistory.manifest, left.created),
      right.created,
    );
    fixture.remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      resolutionManifest,
    );
    const beforeRawBypass = await fixture.repository.load();
    const outboxBeforeRawBypass = await fixture.repository.listPendingOutbox();
    if (beforeRawBypass === undefined) {
      throw new Error("Expected the locally resolved Workspace");
    }
    const rawBypass = await new CommandService(
      fixture.repository,
      WORKSPACE_ID,
    ).dispatch(
      right.command,
      buildCommandContext({
        commandId: "raw-equivalent-resolution-bypass",
        expectedRevision: beforeRawBypass.revision,
        actorId: "raw-bypass-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "raw-bypass-source",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T05:04:45.000Z",
      }),
    );
    expect(rawBypass).toMatchObject({
      ok: false,
      rejection: { code: "REVISION_CONFLICT" },
    });
    const forgedEquivalentAuthority = {
      command: right.command,
      context: right.context,
    } as unknown as Parameters<
      CommandService["dispatchAuthorizedEquivalentConflictResolution"]
    >[0];
    await expect(
      new CommandService(
        fixture.repository,
        WORKSPACE_ID,
      ).dispatchAuthorizedEquivalentConflictResolution(
        forgedEquivalentAuthority,
      ),
    ).rejects.toMatchObject({
      code: "AUTHORIZED_EQUIVALENT_RESOLUTION_REQUIRED",
    });
    expect(await fixture.repository.load()).toEqual(beforeRawBypass);
    expect(await fixture.repository.listPendingOutbox()).toEqual(
      outboxBeforeRawBypass,
    );

    let failEquivalentCommit = true;
    const transientRepository = new Proxy(fixture.repository, {
      get(target, property) {
        if (property === "commit") {
          return async (
            input: Parameters<AtomicWorkspaceRepository["commit"]>[0],
          ) => {
            if (
              failEquivalentCommit &&
              input.outboxEntry.commandId === right.receipt.commandId
            ) {
              failEquivalentCommit = false;
              throw new Error("temporary equivalent confirmation failure");
            }
            return target.commit(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as AtomicWorkspaceRepository;
    const merger = new SyncMergeV2({
      repository: transientRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    });
    const mergeInput = {
      trustedAncestorWorkspace: fixture.openWorkspace,
      localHeadHash: left.created.operationHash,
      remoteHeadHash: right.created.operationHash,
      now: "2026-07-12T05:05:00.000Z",
    } as const;
    const selectedBefore = structuredClone(left.workspace.dailyCommitments);

    await expect(merger.merge(mergeInput)).rejects.toThrow(
      "temporary equivalent confirmation failure",
    );
    expect(await fixture.repository.load()).toEqual(beforeRawBypass);
    expect(await fixture.repository.listPendingOutbox()).toEqual(
      outboxBeforeRawBypass,
    );
    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "merged",
      replayedOperationHashes: [right.created.operationHash],
      openedConflictIds: [],
      revision: left.workspace.revision + 1,
    });
    const merged = await fixture.repository.load();
    expect(merged?.dailyCommitments).toEqual(selectedBefore);
    expect(merged?.syncConflicts).toEqual([
      expect.objectContaining({
        id: fixture.conflict.id,
        retainedBundleHash: fixture.conflict.localBundle.hash,
      }),
    ]);
    expect(
      merged?.commandReceipts.find(
        ({ commandId }) => commandId === right.receipt.commandId,
      ),
    ).toMatchObject({
      status: "applied",
      origin: "sync",
      diff: [],
    });
    expect(await fixture.repository.listPendingOutbox()).toEqual([
      expect.objectContaining({
        commandId: right.receipt.commandId,
        command: right.command,
        status: "pending",
      }),
    ]);

    const beforeRetry = await fixture.repository.load();
    const outboxBeforeRetry = await fixture.repository.listPendingOutbox();
    await expect(merger.merge(mergeInput)).resolves.toMatchObject({
      status: "already_merged",
      replayedOperationHashes: [],
      openedConflictIds: [],
      revision: beforeRetry?.revision,
    });
    expect(await fixture.repository.load()).toEqual(beforeRetry);
    expect(await fixture.repository.listPendingOutbox()).toEqual(
      outboxBeforeRetry,
    );

    await new SyncAdapterV2({
      repository: fixture.repository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      deviceId: left.created.envelope.deviceId,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:05:30.000Z",
    }).flushPending();
    const propagatedHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const propagatedHead =
      propagatedHistory.manifest.heads[left.created.envelope.deviceId]
        .operationHash;
    await expect(
      authorizeSyncBranchV2({
        history: propagatedHistory,
        trustedAncestorWorkspace: fixture.openWorkspace,
        ancestorOperationHash: fixture.openOperation.operationHash,
        headOperationHash: propagatedHead,
      }),
    ).resolves.toMatchObject({
      workspace: {
        revision: left.workspace.revision + 1,
        dailyCommitments: selectedBefore,
      },
    });

    const roundtripDatabaseName =
      "omni-plan-v2-equivalent-resolution-roundtrip";
    databaseNames.push(roundtripDatabaseName);
    const roundtripRepository = new BrowserWorkspaceRepository({
      databaseName: roundtripDatabaseName,
      indexedDB: indexedDBFactory,
    });
    await roundtripRepository.initialize(fixture.genesis);
    await persistAsSent(roundtripRepository, fixture.ancestor);
    await persistAsSent(roundtripRepository, fixture.localWriter);
    await new SyncMergeV2({
      repository: roundtripRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: fixture.ancestor.workspace,
      localHeadHash: fixture.localWriter.created.operationHash,
      remoteHeadHash: fixture.remoteWriter.created.operationHash,
      now: "2026-07-12T05:03:00.000Z",
    });
    const roundtripOpenEntry = (
      await roundtripRepository.listPendingOutbox()
    ).find(({ command }) => command.type === "open_sync_conflict");
    if (roundtripOpenEntry === undefined) {
      throw new Error("Expected roundtrip conflict-open outbox entry");
    }
    await roundtripRepository.prepareOutboxOperation(roundtripOpenEntry.id, {
      operationHash: fixture.openOperation.operationHash,
      path: fixture.openOperation.path,
      envelopeJson: canonicalJson(fixture.openOperation.envelope),
    });
    await roundtripRepository.markOutboxSent(
      roundtripOpenEntry.id,
      fixture.openOperation.operationHash,
      "2026-07-12T05:03:30.000Z",
    );
    await persistAsSent(roundtripRepository, right);
    await expect(
      new SyncMergeV2({
        repository: roundtripRepository,
        remote: fixture.remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: fixture.openWorkspace,
        localHeadHash: right.created.operationHash,
        remoteHeadHash: propagatedHead,
        now: "2026-07-12T05:06:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "merged",
      replayedOperationHashes: [left.created.operationHash],
      openedConflictIds: [],
    });
    expect((await roundtripRepository.load())?.dailyCommitments).toEqual(
      selectedBefore,
    );
    expect(
      (await roundtripRepository.load())?.commandReceipts.filter(
        ({ commandType, status }) =>
          commandType === "resolve_sync_conflict" && status === "applied",
      ),
    ).toHaveLength(2);
    await new SyncAdapterV2({
      repository: roundtripRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      deviceId: right.created.envelope.deviceId,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:06:30.000Z",
    }).flushPending();
    const bothRootsHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const roundtripHead =
      bothRootsHistory.manifest.heads[right.created.envelope.deviceId]
        .operationHash;
    const beforeSameRootDedupe = await fixture.repository.load();
    const outboxBeforeSameRootDedupe =
      await fixture.repository.listPendingOutbox();
    await expect(
      merger.merge({
        trustedAncestorWorkspace: fixture.openWorkspace,
        localHeadHash: propagatedHead,
        remoteHeadHash: roundtripHead,
        now: "2026-07-12T05:07:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "already_merged",
      replayedOperationHashes: [],
      openedConflictIds: [],
    });
    expect(await fixture.repository.load()).toEqual(beforeSameRootDedupe);
    expect(await fixture.repository.listPendingOutbox()).toEqual(
      outboxBeforeSameRootDedupe,
    );
  }, 15_000);

  it("replays unrelated remote work before opening a resolution successor conflict", async () => {
    const fixture = await openDailyConflictFixture(
      "opposite-resolution-unrelated",
    );
    const left = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "local",
        rationale: "Retain the local outcome.",
      }),
      commandId: "opposite-unrelated-left",
      deviceId: "opposite-unrelated-left",
      sequence: 1,
      now: "2026-07-12T05:04:00.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    const right = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "remote",
        rationale: "Retain the remote outcome.",
      }),
      commandId: "opposite-unrelated-right",
      deviceId: "opposite-unrelated-right",
      sequence: 1,
      now: "2026-07-12T05:04:30.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    const unrelated = await captureOperation({
      workspace: right.workspace,
      commandId: "capture-before-resolution-successor",
      deviceId: right.created.envelope.deviceId,
      sequence: 2,
      now: "2026-07-12T05:04:40.000Z",
      previousOperationHash: right.created.operationHash,
    });
    await persistAsSent(fixture.repository, left);
    for (const operation of [left, right, unrelated]) {
      fixture.remote.put(operation.created.path, operation.created.envelope);
    }
    const openHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    fixture.remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      await advanceSyncManifestV2(
        await advanceSyncManifestV2(
          await advanceSyncManifestV2(openHistory.manifest, left.created),
          right.created,
        ),
        unrelated.created,
      ),
    );

    await expect(
      new SyncMergeV2({
        repository: fixture.repository,
        remote: fixture.remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: fixture.openWorkspace,
        localHeadHash: left.created.operationHash,
        remoteHeadHash: unrelated.created.operationHash,
        now: "2026-07-12T05:05:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "merged",
      replayedOperationHashes: [unrelated.created.operationHash],
      openedConflictIds: [expect.stringMatching(/^sync-conflict-/)],
    });
    const merged = await fixture.repository.load();
    expect(merged?.inboxItems).toContainEqual(
      expect.objectContaining({
        id: "inbox-capture-before-resolution-successor",
      }),
    );
    expect(merged?.dailyCommitments).toEqual(left.workspace.dailyCommitments);
    expect(merged?.syncConflicts).toHaveLength(2);
  }, 10_000);

  it("opens a fresh normal conflict when a resolved conflict is the trusted ancestor", async () => {
    const fixture = await openDailyConflictFixture("resolved-ancestor");
    const resolved = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "local",
        rationale: "Resolve the first conflict before the next divergence.",
      }),
      commandId: "resolved-ancestor-resolution",
      deviceId: "resolved-ancestor-resolution",
      sequence: 1,
      actorId: "resolved-ancestor-human",
      now: "2026-07-12T05:04:00.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    await persistAsSent(fixture.repository, resolved);
    fixture.remote.put(resolved.created.path, resolved.created.envelope);

    const secondProposal = await generateTodayProposal(
      resolved.workspace,
      "2026-07-19",
      "2026-07-19T05:00:00.000Z",
    );
    const secondCommitment: DailyCommitmentDraft = {
      id: "resolved-ancestor-second-commitment",
      localDate: secondProposal.localDate,
      workspaceRevision: secondProposal.workspaceRevision,
      generatedAt: secondProposal.generatedAt,
      proposalHash: secondProposal.proposalHash,
      slots: structuredClone(secondProposal.slots),
    };
    const w1 = await commandOperation({
      workspace: resolved.workspace,
      command: { type: "commit_today", commitment: secondCommitment },
      commandId: "resolved-ancestor-w1",
      deviceId: "resolved-ancestor-w1",
      sequence: 1,
      actorId: "resolved-ancestor-w1-human",
      now: "2026-07-19T05:01:00.000Z",
      previousOperationHash: resolved.created.operationHash,
    });
    const w2 = await commandOperation({
      workspace: resolved.workspace,
      command: { type: "commit_today", commitment: secondCommitment },
      commandId: "resolved-ancestor-w2",
      deviceId: "resolved-ancestor-w2",
      sequence: 1,
      actorId: "resolved-ancestor-w2-human",
      now: "2026-07-19T05:02:00.000Z",
      previousOperationHash: resolved.created.operationHash,
    });
    await persistAsSent(fixture.repository, w1);
    fixture.remote.put(w1.created.path, w1.created.envelope);
    fixture.remote.put(w2.created.path, w2.created.envelope);
    const openHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    fixture.remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      await advanceSyncManifestV2(
        await advanceSyncManifestV2(
          await advanceSyncManifestV2(openHistory.manifest, resolved.created),
          w1.created,
        ),
        w2.created,
      ),
    );

    const result = await new SyncMergeV2({
      repository: fixture.repository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: resolved.workspace,
      localHeadHash: w1.created.operationHash,
      remoteHeadHash: w2.created.operationHash,
      now: "2026-07-19T05:03:00.000Z",
    });
    expect(result.replayedOperationHashes).toEqual([]);
    expect(result.openedConflictIds).toHaveLength(1);
    expect(result.openedConflictIds[0]).not.toBe(fixture.conflict.id);
    const merged = await fixture.repository.load();
    expect(merged?.syncConflicts).toEqual([
      expect.objectContaining({
        id: fixture.conflict.id,
        resolvedAt: resolved.receipt.createdAt,
        retainedBundleHash: fixture.conflict.localBundle.hash,
      }),
      expect.objectContaining({
        id: result.openedConflictIds[0],
        logicalKey: canonicalJson(["daily_commitment", "2026-07-19"]),
        commonAncestorHash: resolved.created.operationHash,
      }),
    ]);
    expect(merged?.syncConflicts[1]?.resolvedAt).toBeUndefined();
    expect(merged?.reviews).toContainEqual(
      expect.objectContaining({
        id: `review:sync_conflict:${result.openedConflictIds[0]}`,
        status: "open",
      }),
    );
  }, 10_000);

  it("opens one symmetric successor conflict for opposite human resolution outcomes", async () => {
    const fixture = await openDailyConflictFixture("opposite-resolution");
    const left = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "local",
        rationale: "Left human retains the local commitment.",
      }),
      commandId: "opposite-resolution-left",
      deviceId: "opposite-resolution-left",
      sequence: 1,
      actorId: "opposite-left-human",
      now: "2026-07-12T05:04:00.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    const right = await commandOperation({
      workspace: fixture.openWorkspace,
      command: resolutionCommand({
        conflict: fixture.conflict,
        side: "remote",
        rationale: "Right human retains the remote commitment.",
      }),
      commandId: "opposite-resolution-right",
      deviceId: "opposite-resolution-right",
      sequence: 1,
      actorId: "opposite-right-human",
      now: "2026-07-12T05:04:30.000Z",
      previousOperationHash: fixture.openOperation.operationHash,
    });
    await persistAsSent(fixture.repository, left);
    fixture.remote.put(left.created.path, left.created.envelope);
    fixture.remote.put(right.created.path, right.created.envelope);
    const openHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    fixture.remote.put(
      syncManifestPathV2(WORKSPACE_ID),
      await advanceSyncManifestV2(
        await advanceSyncManifestV2(openHistory.manifest, left.created),
        right.created,
      ),
    );
    const mergeA = await new SyncMergeV2({
      repository: fixture.repository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: fixture.openWorkspace,
      localHeadHash: left.created.operationHash,
      remoteHeadHash: right.created.operationHash,
      now: "2026-07-12T05:05:00.000Z",
    });
    expect(mergeA.replayedOperationHashes).toEqual([]);
    expect(mergeA.openedConflictIds).toHaveLength(1);
    const successorId = mergeA.openedConflictIds[0];
    const workspaceA = await fixture.repository.load();
    expect(workspaceA?.dailyCommitments).toEqual(left.workspace.dailyCommitments);
    expect(workspaceA?.syncConflicts).toEqual([
      expect.objectContaining({
        id: fixture.conflict.id,
        resolvedAt: left.receipt.createdAt,
        retainedBundleHash: fixture.conflict.localBundle.hash,
      }),
      expect.objectContaining({
        id: successorId,
        localBundle: expect.objectContaining({
          hash: fixture.conflict.localBundle.hash,
        }),
        remoteBundle: expect.objectContaining({
          hash: fixture.conflict.remoteBundle.hash,
        }),
        localValue: fixture.conflict.localValue,
        remoteValue: fixture.conflict.remoteValue,
      }),
    ]);
    expect(workspaceA?.syncConflicts[1]?.resolvedAt).toBeUndefined();
    expect(workspaceA?.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `review:sync_conflict:${fixture.conflict.id}`,
          status: "completed",
        }),
        expect.objectContaining({
          id: `review:sync_conflict:${successorId}`,
          status: "open",
        }),
      ]),
    );
    const successorOutbox = await fixture.repository.listPendingOutbox();
    expect(successorOutbox).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "open_sync_conflict",
          conflict: expect.objectContaining({ id: successorId }),
        }),
      }),
    ]);
    const successorEntry = successorOutbox[0];
    if (successorEntry.command.type !== "open_sync_conflict") {
      throw new Error("Expected the authorized successor-open command");
    }
    const resolutionHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const [authorizedLeftBranch, authorizedRightBranch] = await Promise.all([
      authorizeSyncBranchV2({
        history: resolutionHistory,
        trustedAncestorWorkspace: fixture.openWorkspace,
        ancestorOperationHash: fixture.openOperation.operationHash,
        headOperationHash: left.created.operationHash,
      }),
      authorizeSyncBranchV2({
        history: resolutionHistory,
        trustedAncestorWorkspace: fixture.openWorkspace,
        ancestorOperationHash: fixture.openOperation.operationHash,
        headOperationHash: right.created.operationHash,
      }),
    ]);
    const successorContext: CommandContext = {
      commandId: successorEntry.commandId,
      expectedRevision: left.workspace.revision,
      actorId: successorEntry.actor.actorId,
      actorKind: successorEntry.actor.actorKind,
      origin: successorEntry.actor.origin,
      source: structuredClone(successorEntry.actor.source),
      now: successorEntry.createdAt,
    };
    await expect(
      authorizeConflictOpenFromResolutionBranchesV2({
        localBranch: authorizedLeftBranch,
        remoteBranch: authorizedRightBranch,
        predecessorConflictId: fixture.conflict.id,
        currentWorkspace: left.workspace,
        command: successorEntry.command,
        context: successorContext,
      }),
    ).resolves.toMatchObject({
      command: successorEntry.command,
      context: successorContext,
    });
    await expect(
      authorizeConflictOpenFromResolutionBranchesV2({
        localBranch: authorizedLeftBranch,
        remoteBranch: authorizedRightBranch,
        predecessorConflictId: fixture.conflict.id,
        currentWorkspace: left.workspace,
        command: {
          ...structuredClone(successorEntry.command),
          conflict: {
            ...structuredClone(successorEntry.command.conflict),
            id: `${successorId}-forged`,
          },
        },
        context: successorContext,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT_PROJECTION_MISMATCH" });
    await expect(
      authorizeConflictOpenFromResolutionBranchesV2({
        localBranch: authorizedLeftBranch,
        remoteBranch: authorizedRightBranch,
        predecessorConflictId: fixture.conflict.id,
        currentWorkspace: left.workspace,
        command: successorEntry.command,
        context: {
          ...successorContext,
          now: "2026-07-12T05:05:31.000Z",
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT_PROJECTION_MISMATCH" });

    const reverseRepository = await restoreOpenConflictRepository(
      fixture,
      "omni-plan-v2-opposite-resolution-reverse",
    );
    await persistAsSent(reverseRepository, right);
    const mergeB = await new SyncMergeV2({
      repository: reverseRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: fixture.openWorkspace,
      localHeadHash: right.created.operationHash,
      remoteHeadHash: left.created.operationHash,
      now: "2026-07-12T05:05:00.000Z",
    });
    expect(mergeB.openedConflictIds).toEqual([successorId]);
    const workspaceB = await reverseRepository.load();
    expect(workspaceB?.dailyCommitments).toEqual(right.workspace.dailyCommitments);
    expect(workspaceB?.syncConflicts[1]).toMatchObject({
      id: successorId,
      localBundle: { hash: fixture.conflict.remoteBundle.hash },
      remoteBundle: { hash: fixture.conflict.localBundle.hash },
      localValue: fixture.conflict.remoteValue,
      remoteValue: fixture.conflict.localValue,
    });

    const beforeForgery = await fixture.repository.load();
    const outboxBeforeForgery = await fixture.repository.listPendingOutbox();
    const forgedAuthority = {
      command: successorEntry.command,
      context: buildCommandContext({
        commandId: "forged-successor-open",
        expectedRevision: beforeForgery?.revision ?? -1,
        actorId: "forged-system",
        actorKind: "system",
        origin: "agent",
        source: {
          sourceId: "forged-resolution-branches",
          verified: true,
          capabilities: ["open_conflict"],
        },
        now: "2026-07-12T05:05:30.000Z",
      }),
    } as unknown as Parameters<
      CommandService["dispatchAuthorizedConflictOpen"]
    >[0];
    await expect(
      new CommandService(
        fixture.repository,
        WORKSPACE_ID,
      ).dispatchAuthorizedConflictOpen(forgedAuthority),
    ).rejects.toMatchObject({ code: "AUTHORIZED_CONFLICT_OPEN_REQUIRED" });
    expect(await fixture.repository.load()).toEqual(beforeForgery);
    expect(await fixture.repository.listPendingOutbox()).toEqual(
      outboxBeforeForgery,
    );

    const openSuccessorWorkspace = await fixture.repository.load();
    const successor = openSuccessorWorkspace?.syncConflicts.find(
      ({ id }) => id === successorId,
    );
    if (
      openSuccessorWorkspace === undefined ||
      successor?.localBundle === undefined
    ) {
      throw new Error("Expected the open successor conflict on branch A");
    }
    const resolvedSuccessor = await new CommandService(
      fixture.repository,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${successorId}`,
        resolution: {
          conflictId: successorId,
          retainedVersion: "local",
          retainedBundleHash: successor.localBundle.hash,
          retainedValue: structuredClone(successor.localValue),
          rationale: "Resolve the successor by retaining branch A's outcome.",
        },
      },
      buildCommandContext({
        commandId: "resolve-opposite-successor-on-a",
        expectedRevision: openSuccessorWorkspace.revision,
        actorId: "successor-resolution-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-successor-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T05:06:00.000Z",
      }),
    );
    if (!resolvedSuccessor.ok) {
      throw new Error(
        `Expected successor resolution: ${resolvedSuccessor.rejection.code}`,
      );
    }
    await new SyncAdapterV2({
      repository: fixture.repository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      deviceId: left.created.envelope.deviceId,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:06:30.000Z",
    }).flushPending();
    await new SyncAdapterV2({
      repository: reverseRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      deviceId: right.created.envelope.deviceId,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => "2026-07-12T05:06:40.000Z",
    }).flushPending();
    const propagatedHistory = await materializeRemoteSyncHistoryV2({
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    const branchAHead =
      propagatedHistory.manifest.heads[left.created.envelope.deviceId]
        .operationHash;
    const branchBHead =
      propagatedHistory.manifest.heads[right.created.envelope.deviceId]
        .operationHash;
    const successorResolutionOperation = propagatedHistory.operations.find(
      ({ receipt }) =>
        receipt.commandId === "resolve-opposite-successor-on-a",
    );
    if (successorResolutionOperation === undefined) {
      throw new Error("Expected the flushed successor resolution operation");
    }
    const branchBOpenOperation = propagatedHistory.operations.find(
      ({ operationHash }) => operationHash === branchBHead,
    );
    const branchBOpenFile =
      branchBOpenOperation === undefined
        ? undefined
        : await fixture.remote.read(branchBOpenOperation.path);
    if (
      branchBOpenOperation === undefined ||
      branchBOpenOperation.command.type !== "open_sync_conflict" ||
      branchBOpenFile === undefined
    ) {
      throw new Error("Expected branch B's flushed successor-open operation");
    }
    const thirdRepository = await restoreOpenConflictRepository(
      fixture,
      "omni-plan-v2-opposite-resolution-third-device",
    );
    await persistAsSent(thirdRepository, right);
    await new SyncMergeV2({
      repository: thirdRepository,
      remote: fixture.remote,
      workspaceId: WORKSPACE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
    }).merge({
      trustedAncestorWorkspace: fixture.openWorkspace,
      localHeadHash: right.created.operationHash,
      remoteHeadHash: left.created.operationHash,
      now: "2026-07-12T05:05:00.000Z",
    });
    const thirdOpenEntry = (await thirdRepository.listPendingOutbox()).find(
      ({ command }) =>
        command.type === "open_sync_conflict" &&
        command.conflict.id === successorId,
    );
    if (thirdOpenEntry === undefined) {
      throw new Error("Expected successor open on the third device");
    }
    await thirdRepository.prepareOutboxOperation(thirdOpenEntry.id, {
      operationHash: branchBOpenOperation.operationHash,
      path: branchBOpenOperation.path,
      envelopeJson: branchBOpenFile.content,
    });
    await thirdRepository.markOutboxSent(
      thirdOpenEntry.id,
      branchBOpenOperation.operationHash,
      "2026-07-12T05:06:40.000Z",
    );
    await expect(
      new SyncMergeV2({
        repository: thirdRepository,
        remote: fixture.remote,
        workspaceId: WORKSPACE_ID,
        keyProvider: { getPassphrase: async () => PASSPHRASE },
      }).merge({
        trustedAncestorWorkspace: fixture.openWorkspace,
        localHeadHash: branchBHead,
        remoteHeadHash: branchAHead,
        now: "2026-07-12T05:07:00.000Z",
      }),
    ).resolves.toMatchObject({
      status: "merged",
      replayedOperationHashes: [successorResolutionOperation.operationHash],
      openedConflictIds: [],
    });
    const propagatedWorkspace = await thirdRepository.load();
    expect(propagatedWorkspace?.dailyCommitments).toEqual(
      left.workspace.dailyCommitments,
    );
    expect(propagatedWorkspace?.syncConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: fixture.conflict.id,
          resolvedAt: right.receipt.createdAt,
        }),
        expect.objectContaining({
          id: successorId,
          resolvedAt: "2026-07-12T05:06:00.000Z",
          retainedBundleHash: fixture.conflict.localBundle.hash,
        }),
      ]),
    );
    expect(propagatedWorkspace?.reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `review:sync_conflict:${successorId}`,
          status: "completed",
        }),
      ]),
    );
  }, 15_000);
});
