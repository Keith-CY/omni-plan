import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canonicalJson } from "../../domain/canonical";
import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import { buildWorkspaceV2 } from "../tests/builders";
import {
  BrowserWorkspaceRepository,
  type SyncOutboxRepository,
} from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import { deleteV2Database } from "./indexedDb";
import {
  advanceSyncManifestV2,
  createSyncOperationV2,
  parseSyncManifestV2,
  syncManifestPathV2,
} from "./syncProtocol";
import { materializeRemoteSyncHistoryV2 } from "./syncMerge";
import {
  SyncAdapterV2,
  type SyncRemoteFileV2,
  type SyncRemotePortV2,
} from "./syncAdapter";

const NOW = "2026-07-12T03:00:00.000Z";
const WORKSPACE_ID = "workspace-sync-adapter";
const DEVICE_ID = "device-local";
const PASSPHRASE = "correct horse battery staple";

function context(commandId: string, expectedRevision: number): CommandContext {
  return {
    commandId,
    expectedRevision,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "human-session-1",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: NOW,
  };
}

function capture(commandId: string): V2Command {
  return {
    type: "capture_inbox",
    id: `inbox-${commandId}`,
    text: `private text ${commandId}`,
  };
}

class MemorySyncRemote implements SyncRemotePortV2 {
  readonly files = new Map<string, SyncRemoteFileV2>();
  readonly immutableWrites: Array<{ path: string; content: string }> = [];
  readonly manifestWrites: Array<{
    path: string;
    content: string;
    expectedVersion: string | undefined;
  }> = [];
  failImmutable = false;
  conflictOnce = false;
  conflictReplacement?: string;
  #version = 0;

  async read(path: string): Promise<SyncRemoteFileV2 | undefined> {
    return structuredClone(this.files.get(path));
  }

  async list(prefix: string): Promise<readonly string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith(prefix));
  }

  async putImmutable(path: string, content: string): Promise<void> {
    this.immutableWrites.push({ path, content });
    if (this.failImmutable) throw new Error("immutable upload failed");
    const existing = this.files.get(path);
    if (existing !== undefined) {
      if (existing.content !== content) throw new Error("immutable collision");
      return;
    }
    this.files.set(path, {
      content,
      version: `immutable-${++this.#version}`,
    });
  }

  async compareAndSwap(
    path: string,
    expectedVersion: string | undefined,
    content: string,
  ): Promise<boolean> {
    this.manifestWrites.push({ path, content, expectedVersion });
    if (this.conflictOnce) {
      this.conflictOnce = false;
      if (this.conflictReplacement !== undefined) {
        this.files.set(path, {
          content: this.conflictReplacement,
          version: `manifest-${++this.#version}`,
        });
      }
      return false;
    }
    const existing = this.files.get(path);
    if (existing?.version !== expectedVersion) return false;
    if (existing === undefined && expectedVersion !== undefined) return false;
    this.files.set(path, {
      content,
      version: `manifest-${++this.#version}`,
    });
    return true;
  }
}

describe("SyncAdapterV2", () => {
  let indexedDB: IDBFactory;
  let databaseNames: string[];

  beforeEach(() => {
    indexedDB = new IDBFactory();
    databaseNames = [];
  });

  afterEach(async () => {
    await Promise.all(
      databaseNames.map((databaseName) =>
        deleteV2Database({ databaseName, indexedDB }).catch(() => undefined),
      ),
    );
  });

  async function pendingCommand(suffix: string): Promise<BrowserWorkspaceRepository> {
    const databaseName = `omni-plan-v2-sync-adapter-${suffix}`;
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    await repository.initialize(buildWorkspaceV2(WORKSPACE_ID));
    const result = await new CommandService(repository, WORKSPACE_ID).dispatch(
      capture(suffix),
      context(suffix, 0),
    );
    if (!result.ok) throw new Error(`Expected command fixture: ${result.rejection.code}`);
    return repository;
  }

  function adapter(
    repository: SyncOutboxRepository,
    remote: SyncRemotePortV2,
    overrides: Partial<ConstructorParameters<typeof SyncAdapterV2>[0]> = {},
  ): SyncAdapterV2 {
    return new SyncAdapterV2({
      repository,
      remote,
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      keyProvider: { getPassphrase: async () => PASSPHRASE },
      clock: () => NOW,
      ...overrides,
    });
  }

  it("uploads one immutable encrypted operation, CASes only the V2 manifest, then marks sent", async () => {
    const repository = await pendingCommand("success");
    const remote = new MemorySyncRemote();

    await expect(adapter(repository, remote).flushPending()).resolves.toEqual({
      sent: 1,
      pending: 0,
    });

    expect(await repository.listPendingOutbox()).toEqual([]);
    expect(remote.immutableWrites).toHaveLength(1);
    expect(remote.immutableWrites[0].path).toMatch(
      /^v2\/workspaces\/workspace-sync-adapter\/operations\/device-local\/1-[a-f0-9]{64}\.json\.enc$/,
    );
    expect(remote.immutableWrites[0].content).not.toContain("private text success");
    expect(remote.manifestWrites).toHaveLength(1);
    expect(remote.manifestWrites[0]).toMatchObject({
      path: syncManifestPathV2(WORKSPACE_ID),
      expectedVersion: undefined,
    });
    expect(
      parseSyncManifestV2(JSON.parse(remote.manifestWrites[0].content)).heads[
        DEVICE_ID
      ],
    ).toMatchObject({ sequence: 1, revision: 1 });
  });

  it("does no remote work while locked and does not prepare random ciphertext", async () => {
    const repository = await pendingCommand("locked");
    const remote = new MemorySyncRemote();

    await expect(
      adapter(repository, remote, {
        keyProvider: { getPassphrase: async () => undefined },
      }).flushPending(),
    ).rejects.toMatchObject({ code: "SYNC_KEY_LOCKED" });

    expect(remote.immutableWrites).toEqual([]);
    expect(remote.manifestWrites).toEqual([]);
    expect(await repository.listPendingOutbox()).toEqual([
      expect.not.objectContaining({ preparedOperation: expect.anything() }),
    ]);
  });

  it("persists and reuses exact ciphertext across upload and manifest-CAS retries", async () => {
    const repository = await pendingCommand("retry");
    const remote = new MemorySyncRemote();
    const service = adapter(repository, remote);

    remote.failImmutable = true;
    await expect(service.flushPending()).rejects.toMatchObject({
      code: "IMMUTABLE_UPLOAD_FAILED",
    });
    const afterUploadFailure = (await repository.listPendingOutbox())[0]
      .preparedOperation;
    expect(afterUploadFailure).toBeDefined();

    remote.failImmutable = false;
    remote.conflictOnce = true;
    await expect(service.flushPending()).rejects.toMatchObject({
      code: "MANIFEST_CONFLICT",
    });
    expect((await repository.listPendingOutbox())[0].preparedOperation).toEqual(
      afterUploadFailure,
    );
    expect(remote.files.has(syncManifestPathV2(WORKSPACE_ID))).toBe(false);

    await expect(service.flushPending()).resolves.toEqual({ sent: 1, pending: 0 });
    expect(remote.immutableWrites.map(({ content }) => content)).toEqual([
      afterUploadFailure?.envelopeJson,
      afterUploadFailure?.envelopeJson,
      afterUploadFailure?.envelopeJson,
    ]);
  });

  it("recovers when manifest CAS committed but the local sent marker failed", async () => {
    const repository = await pendingCommand("mark-retry");
    const remote = new MemorySyncRemote();
    let failMark = true;
    const repositoryWithOneFailedMark: SyncOutboxRepository = {
      load: () => repository.load(),
      listPendingOutbox: () => repository.listPendingOutbox(),
      prepareOutboxOperation: (id, operation) =>
        repository.prepareOutboxOperation(id, operation),
      replacePreparedOutboxOperation: (id, expectedOperationHash, operation) =>
        repository.replacePreparedOutboxOperation(
          id,
          expectedOperationHash,
          operation,
        ),
      markOutboxSent: async (id, operationHash, sentAt) => {
        if (failMark) {
          failMark = false;
          throw new Error("local transaction aborted");
        }
        await repository.markOutboxSent(id, operationHash, sentAt);
      },
    };
    const service = adapter(repositoryWithOneFailedMark, remote);

    await expect(service.flushPending()).rejects.toThrow(/local transaction aborted/i);
    expect(remote.files.has(syncManifestPathV2(WORKSPACE_ID))).toBe(true);
    const prepared = (await repository.listPendingOutbox())[0].preparedOperation;

    await expect(service.flushPending()).resolves.toEqual({ sent: 1, pending: 0 });
    expect(remote.immutableWrites.map(({ content }) => content)).toEqual([
      prepared?.envelopeJson,
      prepared?.envelopeJson,
    ]);
    expect(remote.manifestWrites).toHaveLength(1);
  });

  it("rejects schema-1 content at the V2 manifest path before any upload", async () => {
    const repository = await pendingCommand("v1-reject");
    const remote = new MemorySyncRemote();
    remote.files.set(syncManifestPathV2(WORKSPACE_ID), {
      version: "legacy-v1",
      content: canonicalJson({
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        latestRevision: "legacy-snapshot",
      }),
    });

    await expect(adapter(repository, remote).flushPending()).rejects.toMatchObject({
      code: "V2_SCHEMA_REQUIRED",
    });
    expect(remote.immutableWrites).toEqual([]);
    expect(remote.manifestWrites).toEqual([]);
    expect(await repository.listPendingOutbox()).toHaveLength(1);
  });

  it("leaves plaintext pending and performs no upload when encryption fails", async () => {
    const repository = await pendingCommand("encrypt-failure");
    const remote = new MemorySyncRemote();
    const createOperation = vi.fn(async () => {
      throw new Error("crypto unavailable");
    });

    await expect(
      adapter(repository, remote, { createOperation }).flushPending(),
    ).rejects.toMatchObject({
      code: "ENCRYPTION_FAILED",
    });
    expect(createOperation).toHaveBeenCalledTimes(1);
    expect(remote.immutableWrites).toEqual([]);
    expect(remote.manifestWrites).toEqual([]);
    expect((await repository.listPendingOutbox())[0].preparedOperation).toBeUndefined();
  });

  it("preserves both device heads when two revision-zero commands race from the shared genesis", async () => {
    const firstRepository = await pendingCommand("genesis-first");
    const secondRepository = await pendingCommand("genesis-second");
    const remote = new MemorySyncRemote();

    await expect(
      adapter(firstRepository, remote, { deviceId: "device-first" }).flushPending(),
    ).resolves.toEqual({ sent: 1, pending: 0 });
    await expect(
      adapter(secondRepository, remote, {
        deviceId: "device-second",
      }).flushPending(),
    ).resolves.toEqual({ sent: 1, pending: 0 });

    const remoteManifest = remote.files.get(syncManifestPathV2(WORKSPACE_ID));
    expect(remoteManifest).toBeDefined();
    const manifest = parseSyncManifestV2(JSON.parse(remoteManifest!.content));
    expect(Object.keys(manifest.heads).sort()).toEqual([
      "device-first",
      "device-second",
    ]);
    expect(manifest.heads["device-first"]).toMatchObject({
      sequence: 1,
      revision: 1,
    });
    expect(manifest.heads["device-second"]).toMatchObject({
      sequence: 1,
      revision: 1,
    });
  });

  it("ignores an upload-before-CAS orphan and forks from R1 when a cross-device child R2 wins", async () => {
    const databaseName = "omni-plan-v2-sync-adapter-real-cas-race";
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    await repository.initialize(buildWorkspaceV2(WORKSPACE_ID));
    const service = new CommandService(repository, WORKSPACE_ID);
    const remote = new MemorySyncRemote();

    const ancestorResult = await service.dispatch(
      capture("race-ancestor"),
      context("race-ancestor", 0),
    );
    if (!ancestorResult.ok) throw new Error("Expected race ancestor");
    await adapter(repository, remote, { deviceId: "seed" }).flushPending();
    const ancestorWorkspace = await repository.load();
    if (ancestorWorkspace === undefined) throw new Error("Expected ancestor Workspace");
    const initialManifestFile = remote.files.get(syncManifestPathV2(WORKSPACE_ID));
    if (initialManifestFile === undefined) throw new Error("Expected initial manifest");
    const initialManifest = parseSyncManifestV2(
      JSON.parse(initialManifestFile.content),
    );
    const ancestorHash = initialManifest.heads.seed.operationHash;

    const localResult = await service.dispatch(
      capture("race-local"),
      context("race-local", 1),
    );
    if (!localResult.ok) throw new Error("Expected local pending command");
    const competitorCommand = capture("race-competitor");
    const competitorResult = await executeCommand(
      ancestorWorkspace,
      competitorCommand,
      context("race-competitor", 1),
    );
    if (!competitorResult.ok) throw new Error("Expected competitor command");
    const competitor = await createSyncOperationV2({
      workspaceId: WORKSPACE_ID,
      deviceId: DEVICE_ID,
      sequence: 1,
      operationId: "operation-device-local-1-race-competitor",
      command: competitorCommand,
      receipt: competitorResult.receipt,
      previousOperationHash: ancestorHash,
      passphrase: PASSPHRASE,
    });
    remote.files.set(competitor.path, {
      content: canonicalJson(competitor.envelope),
      version: "competitor-operation",
    });
    remote.conflictReplacement = canonicalJson(
      await advanceSyncManifestV2(initialManifest, competitor),
    );
    remote.conflictOnce = true;

    const localAdapter = adapter(repository, remote);
    await expect(localAdapter.flushPending()).rejects.toMatchObject({
      code: "MANIFEST_CONFLICT",
    });
    const orphan = (await repository.listPendingOutbox())[0].preparedOperation;
    expect(orphan).toBeDefined();

    const afterRaceHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    expect(
      afterRaceHistory.operations.map(({ operationHash }) => operationHash),
    ).toEqual([ancestorHash, competitor.operationHash]);
    expect(
      afterRaceHistory.operations.map(({ operationHash }) => operationHash),
    ).not.toContain(orphan?.operationHash);

    await expect(localAdapter.flushPending()).resolves.toEqual({
      sent: 1,
      pending: 0,
    });
    const finalHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    expect(finalHistory.operations).toHaveLength(3);
    expect(finalHistory.operations.map(({ command }) => command)).toContainEqual(
      capture("race-local"),
    );
    expect(
      finalHistory.operations.map(({ operationHash }) => operationHash),
    ).toContain(competitor.operationHash);
    expect(
      finalHistory.operations.map(({ operationHash }) => operationHash),
    ).not.toContain(orphan?.operationHash);
    const finalManifest = parseSyncManifestV2(
      JSON.parse(remote.files.get(syncManifestPathV2(WORKSPACE_ID))!.content),
    );
    expect(Object.keys(finalManifest.heads)).toEqual(
      expect.arrayContaining(["seed", DEVICE_ID]),
    );
    expect(Object.keys(finalManifest.heads)).toContainEqual(
      expect.stringMatching(/^device-local~fork-/),
    );
  });

  it.each([
    {
      name: "recovers a same-device pending orphan from verified non-head R1 after its sole head advances to R2",
      remoteDevice: DEVICE_ID,
      suffix: "same-device",
    },
    {
      name: "recovers a cross-device pending orphan from verified non-head R1 after another device's sole head advances to R2",
      remoteDevice: "remote-chain",
      suffix: "cross-device",
    },
  ])("$name", async ({ remoteDevice, suffix }) => {
    const databaseName =
      `omni-plan-v2-sync-adapter-historical-parent-${suffix}`;
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    await repository.initialize(buildWorkspaceV2(WORKSPACE_ID));
    const service = new CommandService(repository, WORKSPACE_ID);
    const remote = new MemorySyncRemote();

    const ancestorResult = await service.dispatch(
      capture("historical-r1"),
      context("historical-r1", 0),
    );
    if (!ancestorResult.ok) throw new Error("Expected historical R1");
    await adapter(repository, remote, {
      deviceId: remoteDevice,
    }).flushPending();
    const ancestorWorkspace = await repository.load();
    if (ancestorWorkspace === undefined) throw new Error("Expected R1 Workspace");
    const initialManifestFile = remote.files.get(syncManifestPathV2(WORKSPACE_ID));
    if (initialManifestFile === undefined) throw new Error("Expected R1 manifest");
    const initialManifest = parseSyncManifestV2(
      JSON.parse(initialManifestFile.content),
    );
    const ancestorHash = initialManifest.heads[remoteDevice].operationHash;

    const localResult = await service.dispatch(
      capture("historical-local"),
      context("historical-local", 1),
    );
    if (!localResult.ok) throw new Error("Expected pending local command");
    const remoteR2Command = capture("historical-r2");
    const remoteR2Result = await executeCommand(
      ancestorWorkspace,
      remoteR2Command,
      context("historical-r2", 1),
    );
    if (!remoteR2Result.ok) throw new Error("Expected remote R2 command");
    const remoteR2 = await createSyncOperationV2({
      workspaceId: WORKSPACE_ID,
      deviceId: remoteDevice,
      sequence: 2,
      operationId: `operation-${remoteDevice}-2-historical-r2`,
      command: remoteR2Command,
      receipt: remoteR2Result.receipt,
      previousOperationHash: ancestorHash,
      passphrase: PASSPHRASE,
    });
    remote.files.set(remoteR2.path, {
      content: canonicalJson(remoteR2.envelope),
      version: "historical-r2-operation",
    });
    remote.conflictReplacement = canonicalJson(
      await advanceSyncManifestV2(initialManifest, remoteR2),
    );
    remote.conflictOnce = true;

    const localAdapter = adapter(repository, remote);
    await expect(localAdapter.flushPending()).rejects.toMatchObject({
      code: "MANIFEST_CONFLICT",
    });
    const orphan = (await repository.listPendingOutbox())[0].preparedOperation;
    expect(orphan).toBeDefined();
    const racedHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    expect(Object.keys(racedHistory.manifest.heads)).toEqual([remoteDevice]);
    expect(racedHistory.manifest.heads[remoteDevice]).toMatchObject({
      sequence: 2,
      operationHash: remoteR2.operationHash,
      revision: 2,
    });
    expect(
      racedHistory.operations.map(({ operationHash }) => operationHash),
    ).toEqual([ancestorHash, remoteR2.operationHash]);

    const ancestorOperation = racedHistory.operations.find(
      ({ operationHash }) => operationHash === ancestorHash,
    );
    if (ancestorOperation === undefined) throw new Error("Expected verified R1");
    const storedAncestor = remote.files.get(ancestorOperation.path);
    if (storedAncestor === undefined) throw new Error("Expected stored R1");
    remote.files.delete(ancestorOperation.path);
    await expect(localAdapter.flushPending()).rejects.toMatchObject({
      code: "REMOTE_ANCESTRY_REQUIRED",
    });
    remote.files.set(ancestorOperation.path, {
      ...storedAncestor,
      content: "{corrupt historical ancestor",
    });
    await expect(localAdapter.flushPending()).rejects.toMatchObject({
      code: "REMOTE_ANCESTRY_REQUIRED",
    });
    remote.files.set(ancestorOperation.path, storedAncestor);
    expect((await repository.listPendingOutbox())[0].preparedOperation).toEqual(
      orphan,
    );

    await expect(localAdapter.flushPending()).resolves.toEqual({
      sent: 1,
      pending: 0,
    });
    const finalHistory = await materializeRemoteSyncHistoryV2({
      remote,
      workspaceId: WORKSPACE_ID,
      passphrase: PASSPHRASE,
    });
    expect(finalHistory.operations).toHaveLength(3);
    expect(finalHistory.operations.map(({ command }) => command)).toContainEqual(
      capture("historical-local"),
    );
    expect(
      finalHistory.operations.map(({ operationHash }) => operationHash),
    ).not.toContain(orphan?.operationHash);
    const forkHeadId = Object.keys(finalHistory.manifest.heads).find((deviceId) =>
      deviceId.startsWith(`${DEVICE_ID}~fork-historical-local`),
    );
    expect(forkHeadId).toBeDefined();
    expect(finalHistory.manifest.heads[forkHeadId!]).toMatchObject({
      sequence: 1,
      revision: 2,
    });
    if (remoteDevice !== DEVICE_ID) {
      expect(finalHistory.manifest.heads[DEVICE_ID]).toBeUndefined();
    }
    expect(finalHistory.manifest.heads[remoteDevice]).toMatchObject({
      operationHash: remoteR2.operationHash,
      sequence: 2,
    });
  });
});
