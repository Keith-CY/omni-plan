import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import { buildWorkspaceV2 } from "../tests/builders";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import { deleteV2Database } from "./indexedDb";
import {
  authorizeSyncBranchV2,
  createSyncOperationV2,
  createSyncManifestV2,
  decryptAndVerifySyncOperationV2,
  type AuthorizedSyncReplay,
  type VerifiedSyncReplay,
  verifySyncHistoryV2,
} from "./syncProtocol";

const NOW = "2026-07-12T04:00:00.000Z";
const PASSPHRASE = "sync replay secret";

function humanContext(
  commandId: string,
  expectedRevision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId,
    expectedRevision,
    actorId: "human-remote",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "remote-human-session",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: NOW,
    ...overrides,
  };
}

function capture(id: string): V2Command {
  return {
    type: "capture_inbox",
    id: `inbox-${id}`,
    text: `Captured ${id}`,
  };
}

async function verifiedOperation(
  workspaceId: string,
  commandId: string,
): Promise<VerifiedSyncReplay> {
  const command = capture(commandId);
  const result = await executeCommand(
    buildWorkspaceV2(workspaceId),
    command,
    humanContext(commandId, 0),
  );
  if (!result.ok) throw new Error(`Expected remote fixture: ${result.rejection.code}`);
  const operation = await createSyncOperationV2({
    workspaceId,
    deviceId: "device-remote",
    sequence: 1,
    operationId: `operation-${commandId}`,
    command,
    receipt: result.receipt,
    passphrase: PASSPHRASE,
  });
  return decryptAndVerifySyncOperationV2({
    envelope: operation.envelope,
    path: operation.path,
    passphrase: PASSPHRASE,
    expectedWorkspaceId: workspaceId,
    expectedOperationHash: operation.operationHash,
    expectedPreviousOperationHash: null,
  });
}

async function authorizedReplay(
  workspaceId: string,
  commandId: string,
): Promise<AuthorizedSyncReplay> {
  const operation = await verifiedOperation(workspaceId, commandId);
  const history = verifySyncHistoryV2(
    createSyncManifestV2({
      workspaceId,
      heads: {
        [operation.deviceId]: {
          sequence: operation.sequence,
          operationHash: operation.operationHash,
          revision: operation.receipt.revision,
          updatedAt: operation.receipt.createdAt,
        },
      },
      updatedAt: operation.receipt.createdAt,
    }),
    [operation],
  );
  const branch = await authorizeSyncBranchV2({
    history,
    trustedAncestorWorkspace: buildWorkspaceV2(workspaceId),
    headOperationHash: operation.operationHash,
  });
  return branch.replays[0];
}

describe("CommandService verified sync replay boundary", () => {
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

  function repository(suffix: string): BrowserWorkspaceRepository {
    const databaseName = `omni-plan-v2-sync-replay-${suffix}`;
    databaseNames.push(databaseName);
    return new BrowserWorkspaceRepository({ databaseName, indexedDB });
  }

  it("rejects raw sync-origin authority before repository or domain mutation", async () => {
    const workspaceId = "workspace-raw-sync";
    const repo = repository("raw");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatch(capture("raw"), {
        ...humanContext("raw", 0),
        origin: "sync",
        source: {
          sourceId: "forged-sync-source",
          verified: true,
          capabilities: ["replay_receipt"],
        },
      }),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("rejects raw conflict-open commands before persistence", async () => {
    const workspaceId = "workspace-raw-conflict-open";
    const repo = repository("raw-conflict-open");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatch(
        {
          type: "open_sync_conflict",
          conflict: {
            id: "conflict-raw",
            recordType: "review",
            recordId: "review-local",
            commonAncestorHash: "ancestor-raw",
            remoteValue: { id: "review-remote" },
          },
        },
        {
          commandId: "open-conflict-raw",
          expectedRevision: initial.revision,
          actorId: "sync-conflict-detector",
          actorKind: "system",
          origin: "agent",
          source: {
            sourceId: "sync-merge:ancestor-raw",
            verified: true,
            capabilities: ["open_conflict"],
          },
          now: NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZED_CONFLICT_OPEN_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("rejects structural lookalikes that were not created by protocol verification", async () => {
    const workspaceId = "workspace-fake-replay";
    const repo = repository("fake");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatchVerifiedReplay({
        operationHash: "a".repeat(64),
        path: "v2/workspaces/workspace-fake-replay/operations/device/1-fake.json.enc",
        workspaceId,
        deviceId: "device",
        sequence: 1,
        command: capture("fake"),
        receipt: {},
      } as unknown as AuthorizedSyncReplay),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
  });

  it("re-authorizes a history-proven receipt at the local revision and logs the merge causally", async () => {
    const workspaceId = "workspace-verified-replay";
    const repo = repository("verified");
    await repo.initialize(buildWorkspaceV2(workspaceId));
    const service = new CommandService(repo, workspaceId);
    const local = await service.dispatch(
      capture("local"),
      humanContext("local", 0, {
        actorId: "human-local",
        source: {
          sourceId: "local-human-session",
          verified: true,
          capabilities: ["human_decision"],
        },
      }),
    );
    if (!local.ok) throw new Error(`Expected local fixture: ${local.rejection.code}`);
    const replay = await authorizedReplay(workspaceId, "remote");

    const result = await service.dispatchVerifiedReplay(replay);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected replay: ${result.rejection.code}`);
    expect(result.workspace.revision).toBe(2);
    expect(result.receipt).toMatchObject({
      commandId: "remote",
      baseRevision: 1,
      revision: 2,
      actorId: "human-remote",
      actorKind: "human",
      origin: "sync",
      status: "applied",
      source: {
        verified: true,
        capabilities: expect.arrayContaining(["human_decision", "replay_receipt"]),
      },
    });
    expect(result.receipt.source.sourceId).toContain(replay.operationHash);
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({ commandId: "local", status: "pending" }),
      expect.objectContaining({
        commandId: "remote",
        baseRevision: 1,
        revision: 2,
        status: "pending",
      }),
    ]);
    expect((await repo.load())?.inboxItems.map(({ id }) => id).sort()).toEqual([
      "inbox-local",
      "inbox-remote",
    ]);
  });

  it("rejects a verified operation for another Workspace without persisting anything", async () => {
    const repo = repository("workspace-mismatch");
    const initial = buildWorkspaceV2("workspace-local-only");
    await repo.initialize(initial);
    const replay = await authorizedReplay(
      "workspace-remote-only",
      "remote-other",
    );

    await expect(
      new CommandService(repo, initial.workspaceId).dispatchVerifiedReplay(replay),
    ).rejects.toMatchObject({ code: "SYNC_WORKSPACE_MISMATCH" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });

  it("does not grant authority to a decrypted operation before verified-history domain replay", async () => {
    const workspaceId = "workspace-unproven-operation";
    const repo = repository("unproven");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const operation = await verifiedOperation(workspaceId, "unproven");

    await expect(
      new CommandService(repo, workspaceId).dispatchVerifiedReplay(
        operation as unknown as AuthorizedSyncReplay,
      ),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });
});
