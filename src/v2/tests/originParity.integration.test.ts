import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import { buildWorkspaceV2 } from "./builders";
import { BrowserWorkspaceRepository } from "../repositories/browserWorkspaceRepository";
import { CommandService } from "../repositories/commandService";
import { deleteV2Database } from "../repositories/indexedDb";
import {
  AgentOriginAdapter,
  ImportOriginAdapter,
  SyncOriginAdapter,
  UiOriginAdapter,
  type OriginCommandInput,
  type OriginCommandServicePort,
} from "../repositories/originAdapters";
import {
  authorizeSyncBranchV2,
  createSyncManifestV2,
  createSyncOperationV2,
  decryptAndVerifySyncOperationV2,
  verifySyncHistoryV2,
} from "../repositories/syncProtocol";

const NOW = "2026-07-12T05:00:00.000Z";
const PASSPHRASE = "origin parity secret";

function capture(id: string, itemId = `inbox-${id}`): V2Command {
  return {
    type: "capture_inbox",
    id: itemId,
    text: `Captured ${id}`,
  };
}

function humanInput(
  command: V2Command,
  commandId: string,
  expectedRevision: number,
  capabilities: CommandContext["source"]["capabilities"] = ["human_decision"],
): OriginCommandInput {
  return {
    command,
    commandId,
    expectedRevision,
    actorId: "human-1",
    actorKind: "human",
    source: {
      sourceId: "human-source",
      verified: true,
      capabilities,
    },
    now: NOW,
  };
}

describe("origin adapters", () => {
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
    const databaseName = `omni-plan-v2-origin-parity-${suffix}`;
    databaseNames.push(databaseName);
    return new BrowserWorkspaceRepository({ databaseName, indexedDB });
  }

  async function seededService(suffix: string, workspaceId: string) {
    const repo = repository(suffix);
    await repo.initialize(buildWorkspaceV2(workspaceId));
    const service = new CommandService(repo, workspaceId);
    const seed = await service.dispatch(capture("seed", "inbox-existing"), {
      commandId: "seed",
      expectedRevision: 0,
      actorId: "human-seed",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "seed-source",
        verified: true,
        capabilities: ["human_decision"],
      },
      now: NOW,
    });
    if (!seed.ok) throw new Error(`Expected seed: ${seed.rejection.code}`);
    return { repo, service };
  }

  it("only constructs origin envelopes and delegates to CommandService", async () => {
    const accepted = {
      ok: true,
      workspace: buildWorkspaceV2("workspace-mock"),
      receipt: { id: "receipt-mock" },
    } as unknown as CommandResult;
    const dispatch = vi.fn(
      async (_command: V2Command, _context: CommandContext) => accepted,
    );
    const dispatchVerifiedReplay = vi.fn(
      async (_replay: Parameters<OriginCommandServicePort["dispatchVerifiedReplay"]>[0]) =>
        accepted,
    );
    const service: OriginCommandServicePort = {
      dispatch,
      dispatchVerifiedReplay,
    };
    const command = capture("delegate");
    const input = humanInput(command, "delegate", 0);

    await new UiOriginAdapter(service).dispatch(input);
    await new AgentOriginAdapter(service).dispatch(input);
    await new ImportOriginAdapter(service).dispatch({
      ...input,
      source: {
        sourceId: "verified-import",
        verified: true,
        capabilities: ["import_portable"],
      },
    });

    expect(dispatch.mock.calls.map(([, context]) => context.origin)).toEqual([
      "ui",
      "agent",
      "import",
    ]);
    expect(dispatch.mock.calls.map(([sent]) => sent)).toEqual([
      command,
      command,
      command,
    ]);
    expect(dispatchVerifiedReplay).not.toHaveBeenCalled();
  });

  it("produces origin parity for the same actor, payload, base state, and expected revision", async () => {
    const workspaceId = "workspace-origin-parity";
    const command = capture("parity", "inbox-existing");
    const remoteApplied = await executeCommand(
      buildWorkspaceV2(workspaceId),
      command,
      {
        commandId: "parity",
        expectedRevision: 0,
        actorId: "human-1",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "human-source",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: NOW,
      },
    );
    if (!remoteApplied.ok) throw new Error("Expected remote parity fixture");
    const operation = await createSyncOperationV2({
      workspaceId,
      deviceId: "remote-device",
      sequence: 1,
      operationId: "operation-parity",
      command,
      receipt: remoteApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const verifiedOperation = await decryptAndVerifySyncOperationV2({
      envelope: operation.envelope,
      path: operation.path,
      passphrase: PASSPHRASE,
      expectedOperationHash: operation.operationHash,
      expectedPreviousOperationHash: null,
    });
    const replay = (
      await authorizeSyncBranchV2({
        history: verifySyncHistoryV2(
          createSyncManifestV2({
            workspaceId,
            heads: {
              [verifiedOperation.deviceId]: {
                sequence: verifiedOperation.sequence,
                operationHash: verifiedOperation.operationHash,
                revision: verifiedOperation.receipt.revision,
                updatedAt: verifiedOperation.receipt.createdAt,
              },
            },
            updatedAt: verifiedOperation.receipt.createdAt,
          }),
          [verifiedOperation],
        ),
        trustedAncestorWorkspace: buildWorkspaceV2(workspaceId),
        headOperationHash: verifiedOperation.operationHash,
      })
    ).replays[0];

    const ui = await seededService("ui", workspaceId);
    const agent = await seededService("agent", workspaceId);
    const imported = await seededService("import", workspaceId);
    const synced = await seededService("sync", workspaceId);
    const results = await Promise.all([
      new UiOriginAdapter(ui.service).dispatch(humanInput(command, "parity", 1)),
      new AgentOriginAdapter(agent.service).dispatch(
        humanInput(command, "parity", 1),
      ),
      new ImportOriginAdapter(imported.service).dispatch(
        humanInput(command, "parity", 1, ["import_portable"]),
      ),
      new SyncOriginAdapter(synced.service).dispatch(replay),
    ]);

    const projections = results.map((result) => {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected parity rejection");
      return {
        code: result.rejection.code,
        gate: result.rejection.gate,
        permittedNextCommand: result.rejection.permittedNextCommand,
        diff: result.receipt.diff,
        workspaceRevision: result.workspace.revision,
      };
    });
    expect(projections).toEqual([
      projections[0],
      projections[0],
      projections[0],
      projections[0],
    ]);
    expect(projections[0]).toEqual({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:InboxItem:inbox-existing",
      permittedNextCommand: "capture_inbox",
      diff: [],
      workspaceRevision: 1,
    });
  });

  it("keeps actor authority distinct even when the UI origin and payload are identical", async () => {
    const outcomes = [] as Array<{ actorKind: string; ok: boolean; code?: string }>;
    for (const actorKind of ["human", "agent", "system"] as const) {
      const workspaceId = `workspace-actor-${actorKind}`;
      const { service } = await seededService(`actor-${actorKind}`, workspaceId);
      const result = await new UiOriginAdapter(service).dispatch({
        command: capture(actorKind),
        commandId: `actor-${actorKind}`,
        expectedRevision: 1,
        actorId: `${actorKind}-1`,
        actorKind,
        source: {
          sourceId: `${actorKind}-source`,
          verified: true,
          capabilities:
            actorKind === "agent"
              ? ["capture_inbox"]
              : actorKind === "human"
                ? ["human_decision"]
                : ["system_time"],
        },
        now: NOW,
      });
      outcomes.push({
        actorKind,
        ok: result.ok,
        ...(result.ok ? {} : { code: result.rejection.code }),
      });
    }

    expect(outcomes).toEqual([
      { actorKind: "human", ok: true },
      { actorKind: "agent", ok: true },
      { actorKind: "system", ok: false, code: "ACTOR_NOT_AUTHORIZED" },
    ]);
  });
});
