import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCommand, type CommandContext, type V2Command } from "../domain/commands";
import type { CommandReceipt, MigrationRecord, WorkspaceV2 } from "../domain/types";
import { buildWorkspaceV2 } from "../tests/builders";
import {
  BrowserWorkspaceRepository,
  type RepositoryTransactionOperation,
  type SyncOutboxEntry,
} from "./browserWorkspaceRepository";
import {
  deleteV2Database,
  openV2Database,
  V2_DATABASE_NAME,
  V2_OBJECT_STORES,
} from "./indexedDb";

const V1_STORAGE_KEY = "omni-plan-personal.workspace.v1";
const NOW = "2026-07-12T00:00:00.000Z";

function context(commandId: string, revision: number): CommandContext {
  return {
    commandId,
    expectedRevision: revision,
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
    text: `Captured by ${commandId}`,
  };
}

async function acceptedTuple(
  workspace: WorkspaceV2,
  commandId: string,
): Promise<{
  workspace: WorkspaceV2;
  outboxEntry: SyncOutboxEntry;
  receipt: CommandReceipt;
}> {
  const command = capture(commandId);
  const commandContext = context(commandId, workspace.revision);
  const result = await executeCommand(workspace, command, commandContext);
  if (!result.ok) throw new Error(`Expected accepted fixture: ${result.rejection.code}`);
  return {
    workspace: result.workspace,
    receipt: result.receipt,
    outboxEntry: {
      id: `outbox-${commandId}`,
      workspaceId: workspace.workspaceId,
      commandId,
      baseRevision: workspace.revision,
      revision: result.workspace.revision,
      command,
      actor: {
        actorId: commandContext.actorId,
        actorKind: commandContext.actorKind,
        origin: commandContext.origin,
        source: structuredClone(commandContext.source),
      },
      payloadHash: result.receipt.payloadHash,
      receiptId: result.receipt.id,
      createdAt: commandContext.now,
      status: "pending",
    },
  };
}

function migrationRecord(checksum: string): MigrationRecord {
  return {
    sourceSchemaVersion: 1,
    sourceChecksum: checksum,
    backupId: `backup-${checksum}`,
    backupChecksum: `backup-hash-${checksum}`,
    migratedAt: NOW,
    entityCounts: { projects: 0 },
    deterministicIdMap: {},
  };
}

function abortOnce(operation: RepositoryTransactionOperation) {
  let shouldAbort = true;
  return (current: RepositoryTransactionOperation, transaction: IDBTransaction) => {
    if (shouldAbort && current === operation) {
      shouldAbort = false;
      transaction.abort();
    }
  };
}

describe("BrowserWorkspaceRepository", () => {
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

  function repository(
    suffix: string,
    options: {
      beforeTransactionComplete?: (
        operation: RepositoryTransactionOperation,
        transaction: IDBTransaction,
      ) => void;
    } = {},
  ): BrowserWorkspaceRepository {
    const databaseName = `omni-plan-v2-repository-${suffix}`;
    if (!databaseNames.includes(databaseName)) databaseNames.push(databaseName);
    return new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      ...options,
    });
  }

  it("loads read-only without implicitly initializing a Workspace", async () => {
    const repo = repository("read-only-load");

    expect(await repo.load()).toBeUndefined();
    expect(await repo.load()).toBeUndefined();
  });

  it("opens the exact default database schema with only the five versioned stores", async () => {
    databaseNames.push(V2_DATABASE_NAME);
    const database = await openV2Database({ indexedDB });

    expect(database.name).toBe("omni-plan-personal-v2");
    expect([...database.objectStoreNames].sort()).toEqual([
      "backups",
      "migrationRuns",
      "outbox",
      "receipts",
      "workspace",
    ]);
    expect(database.version).toBe(1);
    database.close();
  });

  it("snapshots initialized input and returns isolated load clones", async () => {
    const repo = repository("clone-isolation");
    const input = buildWorkspaceV2("workspace-clone-isolation");
    const pending = repo.initialize(input);
    input.workspaceId = "mutated-after-initialize";
    input.inboxItems.push({
      id: "caller-only",
      originalText: "caller mutation",
      sourceId: "caller",
      actorId: "caller",
      capturedAt: NOW,
      triageStatus: "untriaged",
    });
    await pending;

    const first = await repo.load();
    expect(first?.workspaceId).toBe("workspace-clone-isolation");
    expect(first?.inboxItems).toEqual([]);
    if (first === undefined) throw new Error("Expected stored Workspace");
    first.workspaceId = "mutated-loaded-copy";
    first.inboxItems.push({
      id: "loaded-only",
      originalText: "loaded mutation",
      sourceId: "loaded",
      actorId: "loaded",
      capturedAt: NOW,
      triageStatus: "untriaged",
    });
    expect(await repo.load()).toEqual(
      buildWorkspaceV2("workspace-clone-isolation"),
    );
  });

  it("rejects non-V2, nonzero-revision, or pre-receipted initialization", async () => {
    const invalid = [
      { ...buildWorkspaceV2("wrong-schema"), schemaVersion: 1 },
      buildWorkspaceV2("wrong-revision", { revision: 1 }),
      buildWorkspaceV2("pre-receipted", {
        commandReceipts: [
          {
            id: "forged",
            commandId: "forged",
            commandType: "capture_inbox",
            baseRevision: 0,
            revision: 1,
            payloadHash: "forged",
            receiptHash: "forged",
            actorId: "forged",
            actorKind: "human" as const,
            origin: "ui" as const,
            source: {
              sourceId: "forged",
              verified: true,
              capabilities: ["human_decision"],
            },
            status: "applied" as const,
            createdAt: NOW,
            diff: [],
          },
        ],
      }),
    ];
    for (const [index, workspace] of invalid.entries()) {
      const repo = repository(`invalid-initialize-${index}`);
      await expect(
        repo.initialize(workspace as unknown as WorkspaceV2),
      ).rejects.toThrow(/revision 0|V2 Workspace/i);
      expect(await repo.load()).toBeUndefined();
    }
  });

  it("rejects every non-empty bootstrap surface so migration cannot bypass the atomic migration path", async () => {
    const record = migrationRecord("bootstrap-migration-bypass");
    const cases: Array<[string, Partial<WorkspaceV2>]> = [
      [
        "capacity",
        {
          capacityProfile: {
            timeZone: "UTC",
            weeklyWindows: [],
            dailyBudgets: [],
            unavailableBlocks: [],
            updatedAt: NOW,
            updatedBy: "human-1",
          },
        },
      ],
      [
        "entity collection",
        {
          inboxItems: [
            {
              id: "preloaded-inbox",
              originalText: "must use a command",
              sourceId: "source",
              actorId: "human-1",
              capturedAt: NOW,
              triageStatus: "untriaged",
            },
          ],
        },
      ],
      ["visibility", { visibility: { archivedProjectIds: ["preloaded"] } }],
      ["migration marker", { migration: record }],
    ];

    for (const [label, overrides] of cases) {
      const repo = repository(
        `non-empty-bootstrap-${label.split(" ").join("-")}`,
      );
      const workspace = buildWorkspaceV2(
        `workspace-non-empty-${label}`,
        overrides,
      );
      await expect(repo.initialize(workspace), label).rejects.toThrow(/empty/i);
      expect(await repo.load()).toBeUndefined();
      expect(await repo.loadMigration(record.sourceChecksum)).toBeUndefined();
    }

    const collectionFields = [
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
    for (const field of collectionFields) {
      const repo = repository(`non-empty-collection-${field}`);
      const workspace = buildWorkspaceV2(`workspace-non-empty-${field}`);
      (workspace[field] as unknown[]) = [{}];
      await expect(repo.initialize(workspace), field).rejects.toThrow(
        /empty|without command receipts/i,
      );
      expect(await repo.load()).toBeUndefined();
    }
  });

  it("initializes the singleton exactly once across two tabs, even for different workspace IDs", async () => {
    const first = repository("initialize-race");
    const second = repository("initialize-race");
    const left = buildWorkspaceV2("workspace-left");
    const right = buildWorkspaceV2("workspace-right");

    const outcomes = await Promise.all([
      first.initialize(left),
      second.initialize(right),
    ]);

    expect(outcomes.sort()).toEqual(["already_exists", "initialized"]);
    const stored = await first.load();
    expect([left.workspaceId, right.workspaceId]).toContain(stored?.workspaceId);
    expect(stored?.revision).toBe(0);
  });

  it("does not publish initialization before transaction completion and can retry after an injected abort", async () => {
    const databaseName = "omni-plan-v2-repository-initialize-abort";
    databaseNames.push(databaseName);
    const aborted = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: abortOnce("initialize"),
    });
    const retry = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const workspace = buildWorkspaceV2("workspace-init-abort");

    await expect(aborted.initialize(workspace)).rejects.toThrow();
    expect(await retry.load()).toBeUndefined();
    await expect(retry.initialize(workspace)).resolves.toBe("initialized");
    expect(await retry.load()).toEqual(workspace);
  });

  it("atomically commits the Workspace and pending outbox tuple, then reloads both", async () => {
    const repo = repository("accepted-commit");
    const initial = buildWorkspaceV2("workspace-commit");
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "accepted-1");

    await expect(
      repo.commit({
        expectedRevision: initial.revision,
        workspace: tuple.workspace,
        outboxEntry: tuple.outboxEntry,
      }),
    ).resolves.toBe("committed");

    expect(await repo.load()).toEqual(tuple.workspace);
    expect(await repo.listPendingOutbox()).toEqual([tuple.outboxEntry]);
  });

  it("returns a CAS conflict without writing either half of the transaction", async () => {
    const repo = repository("cas-conflict");
    const initial = buildWorkspaceV2("workspace-cas");
    await repo.initialize(initial);
    const winning = await acceptedTuple(initial, "winner");
    const losing = await acceptedTuple(initial, "loser");
    const outcomes = await Promise.all([
      repo.commit({
        expectedRevision: 0,
        workspace: winning.workspace,
        outboxEntry: winning.outboxEntry,
      }),
      repository("cas-conflict").commit({
        expectedRevision: 0,
        workspace: losing.workspace,
        outboxEntry: losing.outboxEntry,
      }),
    ]);

    expect(outcomes.sort()).toEqual(["committed", "revision_conflict"]);
    const stored = await repo.load();
    expect([winning.workspace, losing.workspace]).toContainEqual(stored);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
  });

  it("aborts an accepted commit atomically when the transaction fails", async () => {
    const databaseName = "omni-plan-v2-repository-commit-abort";
    databaseNames.push(databaseName);
    const setup = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const initial = buildWorkspaceV2("workspace-commit-abort");
    await setup.initialize(initial);
    const tuple = await acceptedTuple(initial, "aborted-commit");
    const aborted = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: abortOnce("commit"),
    });

    await expect(
      aborted.commit({
        expectedRevision: 0,
        workspace: tuple.workspace,
        outboxEntry: tuple.outboxEntry,
      }),
    ).rejects.toThrow();
    expect(await setup.load()).toEqual(initial);
    expect(await setup.listPendingOutbox()).toEqual([]);
  });

  it("rejects an internally inconsistent Workspace/outbox/receipt tuple before persistence", async () => {
    const repo = repository("tuple-validation");
    const initial = buildWorkspaceV2("workspace-tuple");
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "tuple-1");
    const corrupt = structuredClone(tuple.outboxEntry);
    corrupt.payloadHash = "corrupt-payload-hash";

    await expect(
      repo.commit({
        expectedRevision: 0,
        workspace: tuple.workspace,
        outboxEntry: corrupt,
      }),
    ).rejects.toThrow(/tuple/i);
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });

  it("rejects every corrupted applied receipt tuple dimension", async () => {
    const mutations: Array<{
      label: string;
      mutate: (tuple: Awaited<ReturnType<typeof acceptedTuple>>) => void;
    }> = [
      {
        label: "forged receipt identity",
        mutate: ({ workspace, outboxEntry }) => {
          workspace.commandReceipts[0].id = "forged-receipt";
          outboxEntry.receiptId = "forged-receipt";
        },
      },
      {
        label: "changed command bytes",
        mutate: ({ outboxEntry }) => {
          (outboxEntry.command as Extract<V2Command, { type: "capture_inbox" }>).text =
            "changed after receipt";
        },
      },
      {
        label: "changed actor source",
        mutate: ({ outboxEntry }) => {
          outboxEntry.actor.source.sourceId = "different-source";
        },
      },
      {
        label: "forged receipt hash",
        mutate: ({ workspace }) => {
          workspace.commandReceipts[0].receiptHash = "forged-receipt-hash";
        },
      },
      {
        label: "receipt not final",
        mutate: ({ workspace }) => {
          workspace.commandReceipts.push({
            ...workspace.commandReceipts[0],
            id: "later-receipt",
            commandId: "later-receipt",
          });
        },
      },
    ];

    for (const [index, mutation] of mutations.entries()) {
      const repo = repository(`tuple-corruption-${index}`);
      const initial = buildWorkspaceV2(`workspace-tuple-corruption-${index}`);
      await repo.initialize(initial);
      const tuple = await acceptedTuple(initial, `tuple-corruption-${index}`);
      mutation.mutate(tuple);
      await expect(
        repo.commit({
          expectedRevision: 0,
          workspace: tuple.workspace,
          outboxEntry: tuple.outboxEntry,
        }),
        mutation.label,
      ).rejects.toThrow(/tuple/i);
      expect(await repo.load()).toEqual(initial);
      expect(await repo.listPendingOutbox()).toEqual([]);
    }
  });

  it("creates a unique commandId index for outbox replay identity", async () => {
    const repo = repository("outbox-index");
    await repo.load();
    const databaseName = databaseNames[databaseNames.length - 1] ?? "";
    const database = await openV2Database({ databaseName, indexedDB });
    const transaction = database.transaction(V2_OBJECT_STORES.outbox, "readonly");
    const index = transaction.objectStore(V2_OBJECT_STORES.outbox).index("commandId");

    expect(index.unique).toBe(true);
    database.close();
  });

  it("commits migration Workspace and checksum record atomically and is idempotent across tabs", async () => {
    const first = repository("migration-race");
    const second = repository("migration-race");
    const record = migrationRecord("source-checksum-1");
    const migrated = buildWorkspaceV2("workspace-migrated", {
      migration: record,
    });

    const outcomes = await Promise.all([
      first.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: migrated,
        migrationRecord: record,
      }),
      second.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: migrated,
        migrationRecord: record,
      }),
    ]);

    expect(outcomes.sort()).toEqual(["already_migrated", "committed"]);
    expect(await first.load()).toEqual(migrated);
    expect(await first.loadMigration(record.sourceChecksum)).toEqual(record);

    const other = migrationRecord("different-checksum");
    expect(
      await first.commitMigration({
        sourceChecksum: other.sourceChecksum,
        workspace: buildWorkspaceV2("other-workspace", { migration: other }),
        migrationRecord: other,
      }),
    ).toBe("revision_conflict");

    const divergent = {
      ...record,
      entityCounts: { projects: 99 },
    };
    expect(
      await first.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: buildWorkspaceV2(migrated.workspaceId, {
          migration: divergent,
        }),
        migrationRecord: divergent,
      }),
    ).toBe("revision_conflict");
  });

  it("recognizes the same canonical migration after normal Workspace revisions advance", async () => {
    const repo = repository("migration-after-evolution");
    const record = migrationRecord("evolved-migration-checksum");
    const migrated = buildWorkspaceV2("workspace-evolved-migration", {
      migration: record,
    });
    expect(
      await repo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: migrated,
        migrationRecord: record,
      }),
    ).toBe("committed");
    const tuple = await acceptedTuple(migrated, "post-migration-command");
    expect(
      await repo.commit({
        expectedRevision: migrated.revision,
        workspace: tuple.workspace,
        outboxEntry: tuple.outboxEntry,
      }),
    ).toBe("committed");

    const canonicalEquivalentRecord: MigrationRecord = {
      deterministicIdMap: {},
      entityCounts: { projects: 0 },
      migratedAt: record.migratedAt,
      backupChecksum: record.backupChecksum,
      backupId: record.backupId,
      sourceChecksum: record.sourceChecksum,
      sourceSchemaVersion: 1,
    };
    const canonicalEquivalentWorkspace = buildWorkspaceV2(
      migrated.workspaceId,
      { migration: canonicalEquivalentRecord },
    );
    expect(
      await repo.commitMigration({
        sourceChecksum: canonicalEquivalentRecord.sourceChecksum,
        workspace: canonicalEquivalentWorkspace,
        migrationRecord: canonicalEquivalentRecord,
      }),
    ).toBe("already_migrated");
    expect((await repo.load())?.revision).toBe(1);
    expect((await repo.load())?.inboxItems).toHaveLength(1);
  });

  it("arbitrates initialize versus migration in the same singleton transaction boundary", async () => {
    const initializeRepo = repository("initialize-migration-race");
    const migrationRepo = repository("initialize-migration-race");
    const record = migrationRecord("initialize-migration-checksum");
    const migrated = buildWorkspaceV2("workspace-race-migrated", {
      migration: record,
    });

    const [initializeOutcome, migrationOutcome] = await Promise.all([
      initializeRepo.initialize(buildWorkspaceV2("workspace-race-empty")),
      migrationRepo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: migrated,
        migrationRecord: record,
      }),
    ]);

    expect([
      ["initialized", "revision_conflict"],
      ["already_exists", "committed"],
    ]).toContainEqual([initializeOutcome, migrationOutcome]);
    expect(await initializeRepo.load()).toBeDefined();
  });

  it("allows only one of two different-checksum concurrent migrations", async () => {
    const first = repository("different-migration-race");
    const second = repository("different-migration-race");
    const left = migrationRecord("checksum-left");
    const right = migrationRecord("checksum-right");

    const outcomes = await Promise.all([
      first.commitMigration({
        sourceChecksum: left.sourceChecksum,
        workspace: buildWorkspaceV2("workspace-left-migration", {
          migration: left,
        }),
        migrationRecord: left,
      }),
      second.commitMigration({
        sourceChecksum: right.sourceChecksum,
        workspace: buildWorkspaceV2("workspace-right-migration", {
          migration: right,
        }),
        migrationRecord: right,
      }),
    ]);

    expect(outcomes.sort()).toEqual(["committed", "revision_conflict"]);
    expect(await first.load()).toBeDefined();
    const migrationCount = Number(
      (await first.loadMigration(left.sourceChecksum)) !== undefined,
    ) + Number((await first.loadMigration(right.sourceChecksum)) !== undefined);
    expect(migrationCount).toBe(1);
  });

  it("leaves neither migration half after an injected abort", async () => {
    const databaseName = "omni-plan-v2-repository-migration-abort";
    databaseNames.push(databaseName);
    const repo = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: abortOnce("commitMigration"),
    });
    const record = migrationRecord("aborted-migration");
    const workspace = buildWorkspaceV2("workspace-aborted-migration", {
      migration: record,
    });

    await expect(
      repo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace,
        migrationRecord: record,
      }),
    ).rejects.toThrow();
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(record.sourceChecksum)).toBeUndefined();
  });

  it("writes immutable verified backups and rejects mismatched bytes", async () => {
    const repo = repository("backup");
    await repo.writeAndVerifyBackup({
      id: "backup-1",
      rawPayload: "{\"schemaVersion\":1}",
      checksum: "checksum-1",
    });
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload: "{\"schemaVersion\":1}",
        checksum: "checksum-1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload: "different",
        checksum: "checksum-1",
      }),
    ).rejects.toThrow(/immutable|mismatch/i);
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload: "{\"schemaVersion\":1}",
        checksum: "different-checksum",
      }),
    ).rejects.toThrow(/immutable|mismatch/i);
  });

  it("stores rejected receipts append-only without changing Workspace or outbox", async () => {
    const repo = repository("rejected-receipt");
    const initial = buildWorkspaceV2("workspace-rejected");
    await repo.initialize(initial);
    const rejected = await executeCommand(
      initial,
      {
        type: "capture_inbox",
        id: 42,
        text: "invalid runtime payload",
      } as unknown as V2Command,
      context("rejected-1", 0),
    );
    if (rejected.ok) throw new Error("Expected invalid capture fixture");

    await repo.appendRejectedReceipt(rejected.receipt);

    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.findReceipt("rejected-1")).toEqual(rejected.receipt);
    expect(await repo.listReceipts()).toEqual([rejected.receipt]);
    await expect(
      repo.appendRejectedReceipt(rejected.receipt),
    ).resolves.toBeUndefined();
  });

  it("marks an existing outbox entry sent idempotently by operation hash and never upserts", async () => {
    const repo = repository("mark-sent");
    const initial = buildWorkspaceV2("workspace-mark-sent");
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "send-1");
    await repo.commit({
      expectedRevision: 0,
      workspace: tuple.workspace,
      outboxEntry: tuple.outboxEntry,
    });

    await repo.markOutboxSent("outbox-send-1", "operation-hash-1", NOW);
    await expect(
      repo.markOutboxSent(
        "outbox-send-1",
        "operation-hash-1",
        "2026-07-12T01:00:00.000Z",
      ),
    ).resolves.toBeUndefined();
    expect(await repo.listPendingOutbox()).toEqual([]);
    await expect(
      repo.markOutboxSent("outbox-send-1", "other-operation", NOW),
    ).rejects.toThrow(/operation hash/i);
    await expect(
      repo.markOutboxSent("outbox-missing", "operation-hash-2", NOW),
    ).rejects.toThrow(/not found/i);
    await expect(repo.markOutboxSent("", "hash", NOW)).rejects.toThrow(
      /required/i,
    );
    await expect(
      repo.markOutboxSent("outbox-send-1", "", NOW),
    ).rejects.toThrow(/required/i);
    await expect(
      repo.markOutboxSent("outbox-send-1", "hash", "not-a-time"),
    ).rejects.toThrow(/canonical time/i);
  });

  it("never writes or removes the V1 localStorage sentinel", async () => {
    const values = new Map([[V1_STORAGE_KEY, "legacy-sentinel"]]);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    const removeItem = vi.fn((key: string) => values.delete(key));
    const clear = vi.fn(() => values.clear());
    const localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem,
      removeItem,
      clear,
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: localStorage,
    });
    const repo = repository("v1-sentinel");
    const initial = buildWorkspaceV2("workspace-sentinel");
    await repo.load();
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "sentinel-1");
    await repo.commit({
      expectedRevision: 0,
      workspace: tuple.workspace,
      outboxEntry: tuple.outboxEntry,
    });
    await repo.appendRejectedReceipt(
      (
        await executeCommand(
          tuple.workspace,
          {
            type: "capture_inbox",
            id: 42,
            text: "invalid runtime payload",
          } as unknown as V2Command,
          context("sentinel-rejected", tuple.workspace.revision),
        )
      ).receipt,
    );

    expect(localStorage.getItem(V1_STORAGE_KEY)).toBe("legacy-sentinel");
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
