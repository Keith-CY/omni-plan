import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { executeCommand, type CommandContext, type V2Command } from "../domain/commands";
import type { CommandReceipt, MigrationRecord, WorkspaceV2 } from "../domain/types";
import { buildWorkspaceV2 } from "../tests/builders";
import {
  BrowserWorkspaceRepository,
  type PreparedSyncOperation,
  type RepositoryTransactionOperation,
  type SyncOutboxEntry,
} from "./browserWorkspaceRepository";
import {
  deleteV2Database,
  openV2Database,
  requestResult,
  transactionComplete,
  V2_DATABASE_NAME,
  V2_OBJECT_STORES,
} from "./indexedDb";

const V1_STORAGE_KEY = "omni-plan-personal.workspace.v1";
const NOW = "2026-07-12T00:00:00.000Z";

function preparedOperation(
  suffix = "1",
): PreparedSyncOperation {
  return {
    operationHash: `operation-hash-${suffix}`,
    path: `v2/workspaces/workspace-mark-sent/operations/device-1/1-operation-hash-${suffix}.json.enc`,
    envelopeJson: JSON.stringify({
      schemaVersion: 2,
      protocol: "omniplan-v2-command-log",
      nonce: suffix,
    }),
  };
}

async function checksumText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function context(
  commandId: string,
  revision: number,
  now: string = NOW,
): CommandContext {
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
    now,
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
  now: string = NOW,
): Promise<{
  workspace: WorkspaceV2;
  outboxEntry: SyncOutboxEntry;
  receipt: CommandReceipt;
}> {
  const command = capture(commandId);
  const commandContext = context(commandId, workspace.revision, now);
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

async function persistMigrationBackup(
  repository: BrowserWorkspaceRepository,
  record: MigrationRecord,
): Promise<void> {
  const rawPayload = JSON.stringify({
    schemaVersion: 1,
    sourceChecksum: record.sourceChecksum,
  });
  record.backupId = `backup-${record.sourceChecksum}`;
  record.backupChecksum = await checksumText(rawPayload);
  await repository.writeAndVerifyBackup({
    id: record.backupId,
    rawPayload,
    checksum: record.backupChecksum,
  });
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
    await persistMigrationBackup(first, record);
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
    await persistMigrationBackup(first, other);
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

  it("refuses to commit migration without its matching verified backup", async () => {
    const repo = repository("migration-missing-backup");
    const record = migrationRecord("missing-backup-source");

    await expect(
      repo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: buildWorkspaceV2("workspace-missing-backup", {
          migration: record,
        }),
        migrationRecord: record,
      }),
    ).rejects.toThrow(/verified backup|backup.*missing/i);
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(record.sourceChecksum)).toBeUndefined();
  });

  it("recognizes the same canonical migration after normal Workspace revisions advance", async () => {
    const repo = repository("migration-after-evolution");
    const record = migrationRecord("evolved-migration-checksum");
    await persistMigrationBackup(repo, record);
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
    await persistMigrationBackup(migrationRepo, record);
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
    await Promise.all([
      persistMigrationBackup(first, left),
      persistMigrationBackup(second, right),
    ]);

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
    await persistMigrationBackup(repo, record);
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
    const rawPayload = "{\"schemaVersion\":1}";
    const checksum = await checksumText(rawPayload);
    await repo.writeAndVerifyBackup({
      id: "backup-1",
      rawPayload,
      checksum,
    });
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload,
        checksum,
      }),
    ).resolves.toBeUndefined();
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload: "different",
        checksum: await checksumText("different"),
      }),
    ).rejects.toThrow(/immutable|mismatch/i);
    await expect(
      repo.writeAndVerifyBackup({
        id: "backup-1",
        rawPayload,
        checksum: "different-checksum",
      }),
    ).rejects.toThrow(/checksum|mismatch/i);
  });

  it("loads a verified backup as an isolated exact-byte recovery copy", async () => {
    const repo = repository("backup-readback");
    const rawPayload = '{\n  "schemaVersion": 1,\n  "snapshot": {}\n}\n';
    const checksum = await checksumText(rawPayload);
    const backup = {
      id: `v1-backup-${checksum}`,
      rawPayload,
      checksum,
    };

    await repo.writeAndVerifyBackup(backup);
    const loaded = await repo.loadVerifiedBackup(backup.id);

    expect(loaded).toEqual(backup);
    if (loaded === undefined) throw new Error("Expected verified backup");
    loaded.rawPayload = "caller mutation";
    expect(await repo.loadVerifiedBackup(backup.id)).toEqual(backup);
  });

  it("persists one clone-isolated migration recovery marker and clears it explicitly", async () => {
    const repo = repository("migration-recovery-marker");
    const rawPayload = '{"schemaVersion":1,"snapshot":{}}';
    const backupChecksum = await checksumText(rawPayload);
    const backupId = `v1-backup-${backupChecksum}`;
    await repo.writeAndVerifyBackup({
      id: backupId,
      rawPayload,
      checksum: backupChecksum,
    });
    const recovery = {
      sourceChecksum: "normalized-source-checksum",
      backupId,
      backupChecksum,
      code: "MIGRATION_VALIDATION_FAILED" as const,
      message: "A required project reference is malformed.",
      occurredAt: NOW,
      violations: [
        {
          code: "MALFORMED_REFERENCE",
          message: "Missing project",
        },
      ],
    };

    await repo.saveMigrationRecovery(recovery);
    const loaded = await repo.loadMigrationRecovery();
    expect(loaded).toEqual(recovery);
    if (loaded === undefined) throw new Error("Expected recovery marker");
    loaded.message = "caller mutation";
    expect(await repo.loadMigrationRecovery()).toEqual(recovery);

    await repo.clearMigrationRecovery();
    expect(await repo.loadMigrationRecovery()).toBeUndefined();
  });

  it("clears recovery by exact migration tuple CAS and preserves an unrelated marker", async () => {
    const repo = repository("migration-recovery-cas");
    const rawPayload = '{"schemaVersion":1,"snapshot":{"projects":[]}}';
    const backupChecksum = await checksumText(rawPayload);
    const backupId = `v1-backup-${backupChecksum}`;
    await repo.writeAndVerifyBackup({ id: backupId, rawPayload, checksum: backupChecksum });
    const recovery = {
      sourceChecksum: "source-b",
      backupId,
      backupChecksum,
      code: "MIGRATION_CONFLICT" as const,
      message: "Source B still needs recovery.",
      occurredAt: NOW,
    };
    await repo.saveMigrationRecovery(recovery);

    await expect(
      repo.clearMigrationRecoveryIfMatching({
        sourceChecksum: "source-a",
        backupId,
        backupChecksum,
      }),
    ).resolves.toBe("not_matching");
    expect(await repo.loadMigrationRecovery()).toEqual(recovery);

    await expect(
      repo.clearMigrationRecoveryIfMatching({
        sourceChecksum: recovery.sourceChecksum,
        backupId,
        backupChecksum,
      }),
    ).resolves.toBe("cleared");
    expect(await repo.loadMigrationRecovery()).toBeUndefined();
  });

  it("rejects a recovery marker that is not backed by matching verified raw bytes", async () => {
    const repo = repository("orphan-recovery-marker");

    await expect(
      repo.saveMigrationRecovery({
        sourceChecksum: "source-checksum",
        backupId: "missing-backup",
        backupChecksum: "missing-checksum",
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: "Migration failed after backup.",
        occurredAt: NOW,
      }),
    ).rejects.toThrow(/verified backup|not found/i);
    expect(await repo.loadMigrationRecovery()).toBeUndefined();
  });

  it("fails closed when a recovery marker's verified backup is later corrupted", async () => {
    const repo = repository("corrupt-recovery-backup");
    const rawPayload = '{"schemaVersion":1,"snapshot":{}}';
    const backupChecksum = await checksumText(rawPayload);
    const backupId = `v1-backup-${backupChecksum}`;
    await repo.writeAndVerifyBackup({
      id: backupId,
      rawPayload,
      checksum: backupChecksum,
    });
    await repo.saveMigrationRecovery({
      sourceChecksum: "source-checksum",
      backupId,
      backupChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: "Migration failed after backup.",
      occurredAt: NOW,
    });
    const databaseName = databaseNames[databaseNames.length - 1] ?? "";
    const database = await openV2Database({ databaseName, indexedDB });
    const transaction = database.transaction(
      V2_OBJECT_STORES.backups,
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    await requestResult(
      transaction.objectStore(V2_OBJECT_STORES.backups).put({
        id: backupId,
        rawPayload: "tampered",
        checksum: backupChecksum,
      }),
    );
    await completion;
    database.close();

    await expect(repo.loadMigrationRecovery()).rejects.toThrow(
      /backup|checksum|verification/i,
    );
  });

  it("clears a matching recovery marker in the same transaction that commits migration", async () => {
    const repo = repository("migration-clears-recovery");
    const rawPayload = '{"schemaVersion":1,"snapshot":{}}';
    const backupChecksum = await checksumText(rawPayload);
    const backupId = `v1-backup-${backupChecksum}`;
    await repo.writeAndVerifyBackup({
      id: backupId,
      rawPayload,
      checksum: backupChecksum,
    });
    const record = {
      ...migrationRecord("recovered-source-checksum"),
      backupId,
      backupChecksum,
    };
    await repo.saveMigrationRecovery({
      sourceChecksum: record.sourceChecksum,
      backupId: record.backupId,
      backupChecksum: record.backupChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: "The previous migration transaction aborted.",
      occurredAt: NOW,
    });
    const workspace = buildWorkspaceV2("workspace-recovered", {
      migration: record,
    });

    await expect(
      repo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace,
        migrationRecord: record,
      }),
    ).resolves.toBe("committed");

    expect(await repo.load()).toEqual(workspace);
    expect(await repo.loadMigration(record.sourceChecksum)).toEqual(record);
    expect(await repo.loadMigrationRecovery()).toBeUndefined();
  });

  it("preserves an unrelated recovery marker when another source commits", async () => {
    const repo = repository("migration-preserves-unrelated-recovery");
    const record = migrationRecord("source-a");
    await persistMigrationBackup(repo, record);
    const rawPayloadB = '{"schemaVersion":1,"snapshot":{"source":"b"}}';
    const backupChecksumB = await checksumText(rawPayloadB);
    const backupIdB = `v1-backup-${backupChecksumB}`;
    await repo.writeAndVerifyBackup({
      id: backupIdB,
      rawPayload: rawPayloadB,
      checksum: backupChecksumB,
    });
    const recoveryB = {
      sourceChecksum: "source-b",
      backupId: backupIdB,
      backupChecksum: backupChecksumB,
      code: "MIGRATION_CONFLICT" as const,
      message: "Source B still needs recovery.",
      occurredAt: NOW,
    };
    await repo.saveMigrationRecovery(recoveryB);

    await expect(
      repo.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: buildWorkspaceV2("workspace-source-a", { migration: record }),
        migrationRecord: record,
      }),
    ).resolves.toBe("committed");

    expect(await repo.loadMigrationRecovery()).toEqual(recoveryB);
  });

  it("retains the verified recovery marker when migration commit aborts", async () => {
    const databaseName = "omni-plan-v2-repository-recovery-commit-abort";
    databaseNames.push(databaseName);
    const setup = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawPayload = '{"schemaVersion":1,"snapshot":{}}';
    const backupChecksum = await checksumText(rawPayload);
    const backupId = `v1-backup-${backupChecksum}`;
    await setup.writeAndVerifyBackup({
      id: backupId,
      rawPayload,
      checksum: backupChecksum,
    });
    const record = {
      ...migrationRecord("recovery-aborted-source"),
      backupId,
      backupChecksum,
    };
    const recovery = {
      sourceChecksum: record.sourceChecksum,
      backupId,
      backupChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED" as const,
      message: "Previous attempt aborted.",
      occurredAt: NOW,
    };
    await setup.saveMigrationRecovery(recovery);
    const failing = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: abortOnce("commitMigration"),
    });

    await expect(
      failing.commitMigration({
        sourceChecksum: record.sourceChecksum,
        workspace: buildWorkspaceV2("workspace-recovery-aborted", {
          migration: record,
        }),
        migrationRecord: record,
      }),
    ).rejects.toThrow();

    expect(await setup.load()).toBeUndefined();
    expect(await setup.loadMigration(record.sourceChecksum)).toBeUndefined();
    expect(await setup.loadMigrationRecovery()).toEqual(recovery);
    expect(await setup.loadVerifiedBackup(backupId)).toEqual({
      id: backupId,
      rawPayload,
      checksum: backupChecksum,
    });
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

    await expect(
      repo.markOutboxSent("outbox-send-1", "operation-hash-1", NOW),
    ).rejects.toThrow(/matching prepared operation/i);
    await repo.prepareOutboxOperation(
      "outbox-send-1",
      preparedOperation(),
    );
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

  it("persists one exact prepared encrypted upload unit and reuses it idempotently", async () => {
    const repo = repository("prepare-operation");
    const initial = buildWorkspaceV2("workspace-mark-sent");
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "prepare-1");
    await repo.commit({
      expectedRevision: 0,
      workspace: tuple.workspace,
      outboxEntry: tuple.outboxEntry,
    });
    const prepared = preparedOperation();

    await expect(
      repo.prepareOutboxOperation(tuple.outboxEntry.id, prepared),
    ).resolves.toEqual(
      expect.objectContaining({
        id: tuple.outboxEntry.id,
        status: "pending",
        preparedOperation: prepared,
      }),
    );
    await expect(
      repo.prepareOutboxOperation(tuple.outboxEntry.id, structuredClone(prepared)),
    ).resolves.toEqual(
      expect.objectContaining({ preparedOperation: prepared }),
    );
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({ preparedOperation: prepared }),
    ]);
    await expect(
      repo.prepareOutboxOperation(tuple.outboxEntry.id, preparedOperation("other")),
    ).rejects.toThrow(/different prepared operation/i);
  });

  it("replaces a stale prepared upload only when its exact old hash still owns the pending entry", async () => {
    const repo = repository("replace-prepared-operation");
    const initial = buildWorkspaceV2("workspace-mark-sent");
    await repo.initialize(initial);
    const tuple = await acceptedTuple(initial, "replace-prepared-1");
    await repo.commit({
      expectedRevision: 0,
      workspace: tuple.workspace,
      outboxEntry: tuple.outboxEntry,
    });
    const stale = preparedOperation("stale");
    const rebased = preparedOperation("rebased");
    await repo.prepareOutboxOperation(tuple.outboxEntry.id, stale);

    await expect(
      repo.replacePreparedOutboxOperation(
        tuple.outboxEntry.id,
        stale.operationHash,
        rebased,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ preparedOperation: rebased, status: "pending" }),
    );
    await expect(
      repo.replacePreparedOutboxOperation(
        tuple.outboxEntry.id,
        stale.operationHash,
        preparedOperation("loser"),
      ),
    ).rejects.toThrow(/changed before replacement/i);
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({ preparedOperation: rebased }),
    ]);
  });

  it("lists pending operations by causal revision even when clocks move backward", async () => {
    const repo = repository("causal-outbox-order");
    const initial = buildWorkspaceV2("workspace-causal-order");
    await repo.initialize(initial);
    const first = await acceptedTuple(
      initial,
      "revision-1-late-clock",
      "2026-07-12T10:00:00.000Z",
    );
    await repo.commit({
      expectedRevision: 0,
      workspace: first.workspace,
      outboxEntry: first.outboxEntry,
    });
    const second = await acceptedTuple(
      first.workspace,
      "revision-2-early-clock",
      "2026-07-12T01:00:00.000Z",
    );
    await repo.commit({
      expectedRevision: 1,
      workspace: second.workspace,
      outboxEntry: second.outboxEntry,
    });

    expect(
      (await repo.listPendingOutbox()).map(({ commandId }) => commandId),
    ).toEqual(["revision-1-late-clock", "revision-2-early-clock"]);
  });

  it("never prepares a missing or sent entry and leaves an aborted prepare pending without ciphertext", async () => {
    const aborted = repository("prepare-abort", {
      beforeTransactionComplete: abortOnce("prepareOutboxOperation"),
    });
    const initial = buildWorkspaceV2("workspace-mark-sent");
    await aborted.initialize(initial);
    const tuple = await acceptedTuple(initial, "prepare-abort");
    await aborted.commit({
      expectedRevision: 0,
      workspace: tuple.workspace,
      outboxEntry: tuple.outboxEntry,
    });

    await expect(
      aborted.prepareOutboxOperation(tuple.outboxEntry.id, preparedOperation()),
    ).rejects.toThrow();
    expect(await aborted.listPendingOutbox()).toEqual([
      expect.not.objectContaining({ preparedOperation: expect.anything() }),
    ]);
    await expect(
      aborted.prepareOutboxOperation("outbox-missing", preparedOperation()),
    ).rejects.toThrow(/not found/i);

    const normal = repository("prepare-sent");
    await normal.initialize(initial);
    const sentTuple = await acceptedTuple(initial, "prepare-sent");
    await normal.commit({
      expectedRevision: 0,
      workspace: sentTuple.workspace,
      outboxEntry: sentTuple.outboxEntry,
    });
    const prepared = preparedOperation("sent");
    await normal.prepareOutboxOperation(sentTuple.outboxEntry.id, prepared);
    await normal.markOutboxSent(
      sentTuple.outboxEntry.id,
      prepared.operationHash,
      NOW,
    );
    await expect(
      normal.prepareOutboxOperation(sentTuple.outboxEntry.id, prepared),
    ).rejects.toThrow(/already sent/i);
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
