import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import { normalizeWorkspaceSnapshot } from "../../domain/projectLifecycle";
import type { WorkspaceSnapshot } from "../../domain/types";
import type {
  CommandReceipt,
  JsonValue,
  MigrationRecord,
} from "../domain/types";
import { migrateV1Workspace } from "../migration/migrateV1";
import {
  buildCommandContext,
  buildDirectionBrief,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../tests/builders";
import currentSampleFixture from "../tests/fixtures/v1/current-sample.json";
import {
  BrowserWorkspaceRepository,
  type SyncOutboxEntry,
  type VerifiedBackupRecord,
} from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import {
  deleteV2Database,
  openV2Database,
  requestResult,
  transactionComplete,
  V2_OBJECT_STORES,
} from "./indexedDb";
import { createSyncOperationV2 } from "./syncProtocol";
import {
  authorizeVerifiedBackupRestore,
  buildWorkspaceBackupV2,
  exportWorkspaceBackup,
  importPortableCommands,
  restoreVerifiedBackup,
  type WorkspaceBackupV2,
} from "./workspaceTransfer";

const WORKSPACE_ID = "workspace-transfer";
const EXPORTED_AT = "2026-07-12T08:00:00.000Z";
const indexedDBFactory = new IDBFactory();
const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseNames.map((databaseName) =>
      deleteV2Database({
        databaseName,
        indexedDB: indexedDBFactory,
      }).catch(() => undefined),
    ),
  );
  databaseNames.length = 0;
});

function repository(
  suffix: string,
  options: ConstructorParameters<typeof BrowserWorkspaceRepository>[0] = {},
): BrowserWorkspaceRepository {
  const databaseName = `omni-plan-v2-workspace-transfer-${suffix}`;
  databaseNames.push(databaseName);
  return new BrowserWorkspaceRepository({
    databaseName,
    indexedDB: indexedDBFactory,
    ...options,
  });
}

async function initializedRepository(
  suffix: string,
): Promise<BrowserWorkspaceRepository> {
  const result = repository(suffix);
  await result.initialize(buildWorkspaceV2(WORKSPACE_ID));
  return result;
}

async function rawInitializedRepository(
  suffix: string,
  workspace: ReturnType<typeof buildWorkspaceV2>,
): Promise<BrowserWorkspaceRepository> {
  const result = repository(suffix);
  const database = await openV2Database({
    databaseName: result.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      V2_OBJECT_STORES.workspace,
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    await requestResult(
      transaction
        .objectStore(V2_OBJECT_STORES.workspace)
        .add(structuredClone(workspace), "current"),
    );
    await completion;
  } finally {
    database.close();
  }
  return result;
}

async function overwriteRawWorkspace(
  repo: BrowserWorkspaceRepository,
  workspace: ReturnType<typeof buildWorkspaceV2>,
): Promise<void> {
  const database = await openV2Database({
    databaseName: repo.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      V2_OBJECT_STORES.workspace,
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    await requestResult(
      transaction
        .objectStore(V2_OBJECT_STORES.workspace)
        .put(structuredClone(workspace), "current"),
    );
    await completion;
  } finally {
    database.close();
  }
}

async function dispatchCapture(input: {
  repository: BrowserWorkspaceRepository;
  commandId: string;
  inboxId: string;
  text?: string;
  now?: string;
}) {
  const workspace = await input.repository.load();
  if (workspace === undefined)
    throw new Error("Expected initialized Workspace");
  return new CommandService(input.repository, WORKSPACE_ID).dispatch(
    {
      type: "capture_inbox",
      id: input.inboxId,
      text: input.text ?? `Captured ${input.inboxId}`,
    },
    buildCommandContext({
      commandId: input.commandId,
      expectedRevision: workspace.revision,
      actorId: "transfer-human",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "verified-transfer-human",
        verified: true,
        capabilities: ["human_decision"],
      },
      now: input.now ?? "2026-07-12T07:00:00.000Z",
    }),
  );
}

async function markPendingSent(
  repo: BrowserWorkspaceRepository,
  sentAt = "2026-07-12T07:30:00.000Z",
): Promise<void> {
  const workspace = await repo.load();
  if (workspace === undefined) throw new Error("Expected sent Workspace");
  let previousOperationHash: string | undefined;
  const entries = (await repo.listPendingOutbox()).sort(
    (left, right) => left.revision - right.revision,
  );
  for (const [index, entry] of entries.entries()) {
    const receipt = workspace.commandReceipts.find(
      ({ commandId }) => commandId === entry.commandId,
    );
    if (receipt === undefined) throw new Error("Expected sent receipt");
    const operation = await createSyncOperationV2({
      workspaceId: entry.workspaceId,
      deviceId: "workspace-transfer-device",
      sequence: index + 1,
      operationId: `workspace-transfer-operation-${index + 1}`,
      command: entry.command,
      receipt,
      ...(previousOperationHash === undefined ? {} : { previousOperationHash }),
      passphrase: "workspace-transfer-passphrase",
    });
    await repo.prepareOutboxOperation(entry.id, {
      operationHash: operation.operationHash,
      path: operation.path,
      envelopeJson: canonicalJson(operation.envelope),
    });
    await repo.markOutboxSent(entry.id, operation.operationHash, sentAt);
    previousOperationHash = operation.operationHash;
  }
}

async function seedRejectedReceipt(
  repo: BrowserWorkspaceRepository,
  commandId: string,
  existingInboxId: string,
  now: string,
) {
  const result = await dispatchCapture({
    repository: repo,
    commandId,
    inboxId: existingInboxId,
    text: "Duplicate identity",
    now,
  });
  if (result.ok) throw new Error("Expected rejected receipt seed");
  return result.receipt;
}

interface RawRepositoryState {
  workspace: unknown;
  receipts: CommandReceipt[];
  outbox: SyncOutboxEntry[];
  backups: unknown[];
  migrationRuns: MigrationRecord[];
}

async function rawRepositoryState(
  repo: BrowserWorkspaceRepository,
): Promise<RawRepositoryState> {
  const database = await openV2Database({
    databaseName: repo.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      [
        V2_OBJECT_STORES.workspace,
        V2_OBJECT_STORES.receipts,
        V2_OBJECT_STORES.outbox,
        V2_OBJECT_STORES.backups,
        V2_OBJECT_STORES.migrationRuns,
      ],
      "readonly",
    );
    const completion = transactionComplete(transaction);
    const [workspace, receipts, outbox, backups, migrationRuns] =
      await Promise.all([
        requestResult(
          transaction.objectStore(V2_OBJECT_STORES.workspace).get("current"),
        ),
        requestResult<CommandReceipt[]>(
          transaction.objectStore(V2_OBJECT_STORES.receipts).getAll(),
        ),
        requestResult<SyncOutboxEntry[]>(
          transaction.objectStore(V2_OBJECT_STORES.outbox).getAll(),
        ),
        requestResult<unknown[]>(
          transaction.objectStore(V2_OBJECT_STORES.backups).getAll(),
        ),
        requestResult<MigrationRecord[]>(
          transaction.objectStore(V2_OBJECT_STORES.migrationRuns).getAll(),
        ),
      ]);
    await completion;
    return structuredClone({
      workspace,
      receipts,
      outbox,
      backups,
      migrationRuns,
    });
  } finally {
    database.close();
  }
}

async function mutateRawOutbox(
  repo: BrowserWorkspaceRepository,
  mutate: (entry: SyncOutboxEntry) => void,
): Promise<void> {
  const database = await openV2Database({
    databaseName: repo.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      V2_OBJECT_STORES.outbox,
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    const store = transaction.objectStore(V2_OBJECT_STORES.outbox);
    const entries = await requestResult<SyncOutboxEntry[]>(store.getAll());
    const entry = entries[0];
    if (entry === undefined) throw new Error("Expected raw outbox entry");
    mutate(entry);
    await requestResult(store.put(entry));
    await completion;
  } finally {
    database.close();
  }
}

async function writeSentinelBackup(
  repo: BrowserWorkspaceRepository,
  id: string,
): Promise<VerifiedBackupRecord> {
  const rawPayload = canonicalJson({ id, sentinel: true });
  const record = {
    id,
    rawPayload,
    checksum: await sha256Hex(rawPayload),
  };
  await repo.writeAndVerifyBackup(record);
  return record;
}

async function seedMigrationArtifacts(input: {
  repository: BrowserWorkspaceRepository;
  migration: MigrationRecord;
  sourceBackup: VerifiedBackupRecord;
  recovery?: boolean;
}): Promise<VerifiedBackupRecord> {
  const sourceBackup = structuredClone(input.sourceBackup);
  if (sourceBackup.checksum !== input.migration.backupChecksum) {
    throw new Error("Migration fixture backup checksum mismatch");
  }
  await input.repository.writeAndVerifyBackup(sourceBackup);
  const database = await openV2Database({
    databaseName: input.repository.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      [V2_OBJECT_STORES.migrationRuns, V2_OBJECT_STORES.backups],
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    const requests: IDBRequest[] = [
      transaction
        .objectStore(V2_OBJECT_STORES.migrationRuns)
        .add(structuredClone(input.migration)),
    ];
    if (input.recovery) {
      requests.push(
        transaction.objectStore(V2_OBJECT_STORES.backups).put({
          id: "migration-recovery:current",
          state: {
            sourceChecksum: input.migration.sourceChecksum,
            backupId: input.migration.backupId,
            backupChecksum: input.migration.backupChecksum,
            code: "MIGRATION_CONFLICT",
            message: "Synthetic pending recovery",
            occurredAt: input.migration.migratedAt,
          },
        }),
      );
    }
    await Promise.all(requests.map((request) => requestResult(request)));
    await completion;
  } finally {
    database.close();
  }
  return sourceBackup;
}

async function migrationFixture(suffix: string): Promise<{
  migration: MigrationRecord;
  sourceBackup: VerifiedBackupRecord;
}> {
  const snapshot = {
    projects: [],
    workItems: [],
    dependencies: [],
    resources: [],
    capacities: [],
    baselines: [],
    actuals: [],
    evidence: [],
    decisions: [],
    changeSets: [],
    auditGates: [],
    auditDecisions: [],
  };
  const sourceChecksum = await sha256Hex(canonicalJson(snapshot));
  const rawPayload = canonicalJson({
    schemaVersion: 1,
    exportedAt: "2026-07-12T06:00:00.000Z",
    snapshot,
  });
  const backupChecksum = await sha256Hex(rawPayload);
  const sourceBackup = {
    id: `v1-backup-${backupChecksum}`,
    rawPayload,
    checksum: backupChecksum,
  };
  return {
    sourceBackup,
    migration: {
      sourceSchemaVersion: 1,
      sourceChecksum,
      backupId: sourceBackup.id,
      backupChecksum: sourceBackup.checksum,
      migratedAt: "2026-07-12T06:00:00.000Z",
      entityCounts: {
        projects: 0,
        workItems: 0,
        dependencies: 0,
        resources: 0,
        capacities: 0,
        baselines: 0,
        actuals: 0,
        evidence: 0,
        decisions: 0,
        changeSets: 0,
        auditGates: 0,
        auditDecisions: 0,
      },
      deterministicIdMap: {},
    },
  };
}

async function nonemptyMigrationFixture(
  options: {
    stripActuals?: boolean;
  } = {},
): Promise<{
  migration: MigrationRecord;
  sourceBackup: VerifiedBackupRecord;
  workspace: ReturnType<typeof buildWorkspaceV2>;
}> {
  const rawSnapshot = structuredClone(
    (currentSampleFixture as { snapshot: WorkspaceSnapshot }).snapshot,
  );
  if (options.stripActuals) rawSnapshot.actuals = [];
  const snapshot = normalizeWorkspaceSnapshot(rawSnapshot);
  const sourceChecksum = await sha256Hex(canonicalJson(snapshot));
  const rawPayload = canonicalJson({
    schemaVersion: 1,
    exportedAt: "2026-07-12T06:00:00.000Z",
    snapshot,
  });
  const backupChecksum = await sha256Hex(rawPayload);
  const sourceBackup = {
    id: `v1-backup-${backupChecksum}`,
    rawPayload,
    checksum: backupChecksum,
  };
  const migrated = migrateV1Workspace(snapshot, {
    workspaceId: WORKSPACE_ID,
    sourceChecksum,
    backupId: sourceBackup.id,
    backupChecksum,
    actorId: "migration-restore-verifier",
    now: "2026-07-12T06:00:00.000Z",
  });
  return {
    migration: migrated.migration,
    sourceBackup,
    workspace: migrated.workspace,
  };
}

async function resignBackup(
  backup: WorkspaceBackupV2,
  mutate: (draft: WorkspaceBackupV2) => void,
): Promise<WorkspaceBackupV2> {
  const draft = structuredClone(backup);
  mutate(draft);
  draft.workspaceHash = await sha256Hex(canonicalJson(draft.workspace));
  draft.receiptLedgerHash = await sha256Hex(
    canonicalJson(draft.rejectedReceipts),
  );
  const { backupChecksum: _checksum, ...withoutChecksum } = draft;
  draft.backupChecksum = await sha256Hex(canonicalJson(withoutChecksum));
  return draft;
}

async function rehashReceipt(receipt: CommandReceipt): Promise<void> {
  const { receiptHash: _receiptHash, ...withoutReceiptHash } = receipt;
  receipt.receiptHash = await sha256Hex(canonicalJson(withoutReceiptHash));
}

function workspaceWithProposalPayload(payload: unknown) {
  const workspace = buildWorkspaceV2(WORKSPACE_ID);
  workspace.commandProposals.push({
    id: "runtime-graph-proposal",
    commandType: "update_direction",
    payload: payload as never,
    baseRevision: 0,
    rationale: "Inspect the runtime graph before canonicalization.",
    agentActorId: "runtime-graph-agent",
    createdAt: EXPORTED_AT,
    status: "open",
  });
  return workspace;
}

describe("V2 Workspace transfer boundaries", () => {
  it("exports an exact deterministic backup envelope including the external rejected ledger", async () => {
    const repo = await initializedRepository("export");
    const applied = await dispatchCapture({
      repository: repo,
      commandId: "export-applied",
      inboxId: "export-inbox",
    });
    if (!applied.ok) throw new Error("Expected export seed command to apply");
    const rejected = await dispatchCapture({
      repository: repo,
      commandId: "export-rejected",
      inboxId: "export-inbox",
      text: "Duplicate identity",
      now: "2026-07-12T07:01:00.000Z",
    });
    if (rejected.ok) throw new Error("Expected rejected receipt seed");

    const backup = await exportWorkspaceBackup({
      repository: repo,
      exportedAt: EXPORTED_AT,
    });

    expect(Object.keys(backup).sort()).toEqual([
      "backupChecksum",
      "exportedAt",
      "format",
      "receiptLedgerHash",
      "rejectedReceipts",
      "schemaVersion",
      "workspace",
      "workspaceHash",
    ]);
    expect(backup).toMatchObject({
      schemaVersion: 2,
      format: "omniplan-v2-backup",
      exportedAt: EXPORTED_AT,
      workspace: JSON.parse(canonicalJson(applied.workspace)),
      rejectedReceipts: [rejected.receipt],
    });
    expect(backup.workspaceHash).toBe(
      await sha256Hex(canonicalJson(applied.workspace)),
    );
    expect(backup.receiptLedgerHash).toBe(
      await sha256Hex(canonicalJson([rejected.receipt])),
    );
    const { backupChecksum: _checksum, ...withoutChecksum } = backup;
    expect(backup.backupChecksum).toBe(
      await sha256Hex(canonicalJson(withoutChecksum)),
    );
    expect(Object.isFrozen(backup)).toBe(true);
    expect(Object.isFrozen(backup.workspace)).toBe(true);
    expect(Object.isFrozen(backup.rejectedReceipts)).toBe(true);
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: EXPORTED_AT }),
    ).resolves.toEqual(backup);
  });

  it("exports and restores finite legacy-shaped values accepted by real commands", async () => {
    const source = await initializedRepository(
      "runtime-schema-contract-source",
    );
    const captured = await dispatchCapture({
      repository: source,
      commandId: "runtime-schema-capture",
      inboxId: "runtime-schema-inbox",
      text: "Shape a fractional project",
      now: "2026-07-12T08:05:00.000Z",
    });
    if (!captured.ok) throw new Error("Expected capture to apply");

    const capturedWorkspace = await source.load();
    if (capturedWorkspace === undefined) {
      throw new Error("Expected captured Workspace");
    }
    const dated = await new CommandService(source, WORKSPACE_ID).dispatch(
      {
        type: "capture_inbox",
        id: "runtime-schema-dated-inbox",
        text: "Date-only desired date",
        desiredDate: "2026-07-20",
      },
      buildCommandContext({
        commandId: "runtime-schema-date-only",
        expectedRevision: capturedWorkspace.revision,
        actorId: "transfer-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-transfer-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:06:00.000Z",
      }),
    );
    if (!dated.ok) throw new Error("Expected date-only capture to apply");

    const triaged = await new CommandService(source, WORKSPACE_ID).dispatch(
      {
        type: "confirm_project_triage",
        inboxItemId: "runtime-schema-inbox",
        eligibility: {
          singleSession: false,
          estimateSeconds: 1_800.5,
          dependencyIds: ["external-dependency"],
          requiresMilestoneEvidence: false,
          outcomeCount: 1.5,
          solutionKnown: true,
        },
        project: {
          id: "runtime-schema-project",
          name: "Fractional project",
          priority: 1.5,
          notes: "Accepted by the command boundary",
        },
      },
      buildCommandContext({
        commandId: "runtime-schema-project-triage",
        expectedRevision: dated.workspace.revision,
        actorId: "transfer-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-transfer-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:07:00.000Z",
      }),
    );
    if (!triaged.ok) throw new Error("Expected Project triage to apply");

    const actionCapture = await new CommandService(
      source,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "capture_inbox",
        id: "runtime-schema-action-inbox",
        text: "Fractional estimate action",
      },
      buildCommandContext({
        commandId: "runtime-schema-action-capture",
        expectedRevision: triaged.workspace.revision,
        actorId: "transfer-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-transfer-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:07:30.000Z",
      }),
    );
    if (!actionCapture.ok) throw new Error("Expected Action capture to apply");
    const actionTriaged = await new CommandService(
      source,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "confirm_action_triage",
        inboxItemId: "runtime-schema-action-inbox",
        action: {
          id: "runtime-schema-action",
          title: "Fractional estimate action",
          eligibility: {
            singleSession: true,
            estimateSeconds: 1_200.5,
            dependencyIds: [],
            requiresMilestoneEvidence: false,
            outcomeCount: 1,
            solutionKnown: true,
          },
          attention: "medium",
        },
      },
      buildCommandContext({
        commandId: "runtime-schema-action-triage",
        expectedRevision: actionCapture.workspace.revision,
        actorId: "transfer-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-transfer-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:07:45.000Z",
      }),
    );
    if (!actionTriaged.ok) throw new Error("Expected Action triage to apply");

    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: "2026-07-12T08:08:00.000Z",
    });
    expect(backup.workspace.inboxItems[1]?.desiredDate).toBe("2026-07-20");
    expect(backup.workspace.projects[0]?.priority).toBe(1.5);
    expect(backup.workspace.actions[0]?.eligibility.estimateSeconds).toBe(
      1_200.5,
    );

    const target = await initializedRepository(
      "runtime-schema-contract-target",
    );
    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:08:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });
    expect(await target.load()).toEqual(backup.workspace);
  });

  it("exports only exactly identified migration-grandfathered Actuals without a Bet", async () => {
    const backupChecksum = "a".repeat(64);
    const backupId = `v1-backup-${backupChecksum}`;
    const recordedAt = "2026-07-01T03:00:00.000Z";
    const workItemId = "migration-work-item";
    const sourceIndex = 0;
    const actualId =
      `migration:actual:${encodeURIComponent(workItemId)}:` +
      `${encodeURIComponent(recordedAt)}:${sourceIndex}`;
    const derivationKey = `${workItemId}+${recordedAt}+${sourceIndex}`;
    const brief = buildDirectionBrief({
      id: "migration-project:direction-brief:1",
      projectId: "migration-project",
      createdAt: "2026-07-12T07:00:00.000Z",
      updatedAt: "2026-07-12T07:00:00.000Z",
    });
    const migration: MigrationRecord = {
      sourceSchemaVersion: 1,
      sourceChecksum: "migration-source-checksum",
      backupId,
      backupChecksum,
      migratedAt: "2026-07-12T07:00:00.000Z",
      entityCounts: {
        projects: 1,
        workItems: 1,
        dependencies: 0,
        resources: 0,
        capacities: 0,
        baselines: 0,
        actuals: 1,
        evidence: 0,
        decisions: 0,
        changeSets: 0,
        auditGates: 0,
        auditDecisions: 0,
      },
      deterministicIdMap: { [derivationKey]: actualId },
    };
    const workspace = buildWorkspaceV2(WORKSPACE_ID, {
      projects: [
        buildProjectV2({
          id: "migration-project",
          activeDirectionBriefId: brief.id,
          holds: [
            {
              type: "migration_review",
              sourceId: backupId,
              affectedRecordIds: ["migration-project", brief.id],
              createdAt: migration.migratedAt,
            },
          ],
          createdAt: migration.migratedAt,
          updatedAt: migration.migratedAt,
        }),
      ],
      directionBriefs: [brief],
      workItems: [
        buildProjectWorkItem({
          id: workItemId,
          projectId: "migration-project",
          betScopeId: "migration:unscoped:migration-project",
        }),
      ],
      actuals: [
        {
          id: actualId,
          revision: 1,
          target: { kind: "work_item", workItemId },
          actualWorkSeconds: 600,
          remainingWorkSeconds: 1_200,
          actualCost: 0,
          recordedAt,
        },
      ],
      migration,
    });

    await expect(
      buildWorkspaceBackupV2({
        snapshot: { workspace, rejectedReceipts: [] },
        exportedAt: EXPORTED_AT,
      }),
    ).resolves.toMatchObject({ workspace: { actuals: [{ id: actualId }] } });

    for (const [name, mutate] of [
      [
        "missing migration hold",
        (candidate: typeof workspace) => {
          candidate.projects[0]!.holds = [];
        },
      ],
      [
        "non-derived Actual identity",
        (candidate: typeof workspace) => {
          candidate.actuals[0]!.id = "post-migration-actual";
        },
      ],
      [
        "mismatched deterministic map",
        (candidate: typeof workspace) => {
          candidate.migration!.deterministicIdMap[derivationKey] =
            "different-actual";
        },
      ],
    ] as const) {
      const candidate = structuredClone(workspace);
      mutate(candidate);
      await expect(
        buildWorkspaceBackupV2({
          snapshot: { workspace: candidate, rejectedReceipts: [] },
          exportedAt: EXPORTED_AT,
        }),
        name,
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    }
  });

  it("rejects non-canonical runtime graphs before they can alias to canonical backup bytes", async () => {
    class RuntimePayload {
      readonly value = "class-instance";
    }
    const cyclicPayload: Record<string, unknown> = { value: "cycle" };
    cyclicPayload.self = cyclicPayload;
    const symbolPayload = { value: "symbol" } as Record<PropertyKey, unknown>;
    symbolPayload[Symbol("hidden-authority")] = true;
    const nonEnumerablePayload = { value: "non-enumerable" };
    Object.defineProperty(nonEnumerablePayload, "hidden", {
      value: true,
      enumerable: false,
    });

    const cases = [
      [
        "Date payload",
        () => workspaceWithProposalPayload(new Date(EXPORTED_AT)),
      ],
      ["Map payload", () => workspaceWithProposalPayload(new Map([["a", 1]]))],
      [
        "class payload",
        () => workspaceWithProposalPayload(new RuntimePayload()),
      ],
      ["symbol payload", () => workspaceWithProposalPayload(symbolPayload)],
      [
        "non-enumerable payload",
        () => workspaceWithProposalPayload(nonEnumerablePayload),
      ],
      ["cyclic payload", () => workspaceWithProposalPayload(cyclicPayload)],
      [
        "plain-looking Proxy payload",
        () => workspaceWithProposalPayload(new Proxy({ value: "proxy" }, {})),
      ],
      [
        "sparse Workspace collection",
        () => {
          const workspace = buildWorkspaceV2(WORKSPACE_ID);
          workspace.inboxItems = new Array(1);
          return workspace;
        },
      ],
      [
        "custom-key Workspace collection",
        () => {
          const workspace = buildWorkspaceV2(WORKSPACE_ID);
          (workspace.inboxItems as any).extra = "not-json";
          return workspace;
        },
      ],
    ] as const;

    for (const [name, createWorkspace] of cases) {
      await expect(
        buildWorkspaceBackupV2({
          snapshot: { workspace: createWorkspace(), rejectedReceipts: [] },
          exportedAt: EXPORTED_AT,
        }),
        name,
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    }
  });

  it("rejects an accessor runtime graph without invoking the getter", async () => {
    let getterCalls = 0;
    const payload = {};
    Object.defineProperty(payload, "authority", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });

    await expect(
      buildWorkspaceBackupV2({
        snapshot: {
          workspace: workspaceWithProposalPayload(payload),
          rejectedReceipts: [],
        },
        exportedAt: EXPORTED_AT,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    expect(getterCalls).toBe(0);
  });

  it("does not let dotted keys impersonate the two Workspace undefined optionals", async () => {
    const snapshot = {
      workspace: buildWorkspaceV2(WORKSPACE_ID),
      rejectedReceipts: [],
      "workspace.capacityProfile": undefined,
    };

    await expect(
      buildWorkspaceBackupV2({ snapshot, exportedAt: EXPORTED_AT }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
  });

  it("rejects an accessor transfer request without observing a changing export time", async () => {
    let getterCalls = 0;
    const request: Record<string, unknown> = {
      snapshot: {
        workspace: buildWorkspaceV2(WORKSPACE_ID),
        rejectedReceipts: [],
      },
    };
    Object.defineProperty(request, "exportedAt", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return getterCalls === 1 ? EXPORTED_AT : "not-a-time";
      },
    });

    await expect(
      buildWorkspaceBackupV2(
        request as unknown as Parameters<typeof buildWorkspaceBackupV2>[0],
      ),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    expect(getterCalls).toBe(0);
  });

  it.each([
    {
      name: "sparse commands",
      commands: () => new Array(1),
    },
    {
      name: "huge sparse commands",
      commands: () => new Array(1_000_000_000),
    },
    {
      name: "custom-key commands",
      commands: () => {
        const commands: unknown[] = [];
        (commands as any).extra = "not-json";
        return commands;
      },
    },
  ])("rejects $name before any repository I/O", async ({ commands }) => {
    let repositoryIo = 0;
    const inaccessibleRepository = {
      async loadTransferSnapshot() {
        repositoryIo += 1;
        throw new Error("Portable validation performed repository I/O.");
      },
    } as unknown as Parameters<typeof importPortableCommands>[0]["repository"];

    await expect(
      importPortableCommands({
        repository: inaccessibleRepository,
        workspaceId: WORKSPACE_ID,
        importedAt: EXPORTED_AT,
        actorId: "portable-import-human",
        sourceId: "portable-file:runtime-graph",
        payload: {
          schemaVersion: 2,
          format: "omniplan-v2-portable-commands",
          commands: commands(),
        },
      }),
    ).rejects.toMatchObject({ code: "PORTABLE_IMPORT_INVALID" });
    expect(repositoryIo).toBe(0);
  });

  it("snapshots portable request fields without invoking identity accessors", async () => {
    let repositoryIo = 0;
    let actorGetterCalls = 0;
    const request: Record<string, unknown> = {
      repository: {
        async loadTransferSnapshot() {
          repositoryIo += 1;
          throw new Error("Portable validation performed repository I/O.");
        },
      },
      workspaceId: WORKSPACE_ID,
      importedAt: EXPORTED_AT,
      sourceId: "portable-file:request-snapshot",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [],
      },
    };
    Object.defineProperty(request, "actorId", {
      enumerable: true,
      get() {
        actorGetterCalls += 1;
        return `portable-human-${actorGetterCalls}`;
      },
    });

    await expect(
      importPortableCommands(
        request as unknown as Parameters<typeof importPortableCommands>[0],
      ),
    ).rejects.toMatchObject({ code: "PORTABLE_IMPORT_INVALID" });
    expect(actorGetterCalls).toBe(0);
    expect(repositoryIo).toBe(0);
  });

  it("maps an uninspectable restore payload to the strict backup error", async () => {
    let repositoryIo = 0;
    const inaccessibleRepository = {
      async loadRestoreCheckpoint() {
        repositoryIo += 1;
        throw new Error("Restore validation performed repository I/O.");
      },
    } as unknown as Parameters<typeof restoreVerifiedBackup>[0]["repository"];
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    await expect(
      restoreVerifiedBackup({
        repository: inaccessibleRepository,
        backup: revoked.proxy,
        validationNow: EXPORTED_AT,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    expect(repositoryIo).toBe(0);
  });

  it("imports only a strictly parsed command allowlist through ImportOriginAdapter", async () => {
    const repo = await initializedRepository("portable-import");

    const result = await importPortableCommands({
      repository: repo,
      workspaceId: WORKSPACE_ID,
      importedAt: "2026-07-12T09:00:00.000Z",
      actorId: "portable-import-human",
      sourceId: "portable-file:inbox",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          { type: "capture_inbox", id: "portable-1", text: "First" },
          {
            type: "capture_inbox",
            id: "portable-2",
            text: "Second",
            desiredDate: "2026-07-20T00:00:00.000Z",
          },
        ],
      },
    });

    expect(
      new Set(result.appliedReceipts.map(({ commandId }) => commandId)).size,
    ).toBe(2);
    expect(result.appliedReceipts[0]?.source).toEqual({
      sourceId: "portable-file:inbox",
      verified: true,
      capabilities: ["import_portable"],
    });
    expect((await repo.load())?.inboxItems.map(({ id }) => id)).toEqual([
      "portable-1",
      "portable-2",
    ]);
    expect(result).toMatchObject({
      status: "applied",
      appliedReceipts: [
        expect.objectContaining({ origin: "import", status: "applied" }),
        expect.objectContaining({ origin: "import", status: "applied" }),
      ],
    });
  });

  it.each([
    {
      name: "raw Workspace snapshot",
      suffix: "snapshot",
      payload: buildWorkspaceV2(WORKSPACE_ID),
    },
    {
      name: "protected commitment after an otherwise valid command",
      suffix: "protected",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          {
            type: "capture_inbox",
            id: "must-not-apply",
            text: "No partial import",
          },
          {
            type: "commit_today",
            commitment: {
              id: "forbidden-commitment",
              localDate: "2026-07-12",
              workspaceRevision: 0,
              generatedAt: EXPORTED_AT,
              proposalHash: "forged",
              slots: [],
            },
          },
        ],
      },
    },
    {
      name: "extra command field",
      suffix: "extra-field",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          {
            type: "capture_inbox",
            id: "extra-field",
            text: "Strict shape",
            privileged: true,
          },
        ],
      },
    },
  ])("rejects $name before any write", async ({ payload, suffix }) => {
    const repo = await initializedRepository(`portable-denial-${suffix}`);
    const before = await repo.load();

    await expect(
      importPortableCommands({
        repository: repo,
        workspaceId: WORKSPACE_ID,
        importedAt: EXPORTED_AT,
        actorId: "portable-import-human",
        sourceId: "portable-file:denied",
        payload,
      }),
    ).rejects.toMatchObject({ code: "PORTABLE_IMPORT_INVALID" });
    expect(await repo.load()).toEqual(before);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("stops on a domain rejection and reports the already-applied atomic prefix", async () => {
    const repo = await initializedRepository("portable-domain-rejection");

    const result = await importPortableCommands({
      repository: repo,
      workspaceId: WORKSPACE_ID,
      importedAt: EXPORTED_AT,
      actorId: "portable-import-human",
      sourceId: "portable-file:domain-rejection",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          { type: "capture_inbox", id: "portable-duplicate", text: "First" },
          { type: "capture_inbox", id: "portable-duplicate", text: "Second" },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "rejected",
      rejectionIndex: 1,
      appliedReceipts: [expect.objectContaining({ status: "applied" })],
      rejection: { code: "ENTITY_ALREADY_EXISTS" },
    });
    expect((await repo.load())?.inboxItems).toEqual([
      expect.objectContaining({ id: "portable-duplicate" }),
    ]);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
    expect(await repo.listReceipts()).toEqual([
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  it("resumes an exact applied prefix after the rejected suffix becomes valid", async () => {
    const repo = await initializedRepository("portable-prefix-resume");
    const portableInput = {
      repository: repo,
      workspaceId: WORKSPACE_ID,
      importedAt: EXPORTED_AT,
      actorId: "portable-import-human",
      sourceId: "portable-file:prefix-resume",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          { type: "capture_inbox", id: "portable-prefix", text: "Prefix" },
          {
            type: "update_project_metadata",
            projectId: "portable-later-project",
            name: "Updated by resumed import",
          },
        ],
      },
    } as const;

    const first = await importPortableCommands(portableInput);
    expect(first).toMatchObject({
      status: "rejected",
      rejectionIndex: 1,
      appliedReceipts: [expect.objectContaining({ status: "applied" })],
    });
    if (first.status !== "rejected") throw new Error("Expected rejection");
    const firstPrefixReceipt = first.appliedReceipts[0];
    const firstRejectedReceipt = (await repo.listReceipts())[0];

    const repairCapture = await dispatchCapture({
      repository: repo,
      commandId: "repair-project-inbox",
      inboxId: "repair-project-inbox",
      now: "2026-07-12T08:01:00.000Z",
    });
    if (!repairCapture.ok) throw new Error("Expected repair capture");
    const repaired = await new CommandService(repo, WORKSPACE_ID).dispatch(
      {
        type: "confirm_project_triage",
        inboxItemId: "repair-project-inbox",
        eligibility: {
          singleSession: false,
          estimateSeconds: 7_200,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 2,
          solutionKnown: true,
        },
        project: {
          id: "portable-later-project",
          name: "Repair project",
          priority: 1,
          notes: "",
        },
      },
      buildCommandContext({
        commandId: "repair-project-create",
        expectedRevision: repairCapture.workspace.revision,
        actorId: "transfer-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-transfer-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:02:00.000Z",
      }),
    );
    if (!repaired.ok) throw new Error("Expected repair project creation");

    const resumedAt = "2026-07-12T08:03:00.000Z";
    const resumed = await importPortableCommands({
      ...portableInput,
      importedAt: resumedAt,
    });

    expect(resumed).toMatchObject({
      status: "applied",
      appliedReceipts: [
        firstPrefixReceipt,
        expect.objectContaining({
          status: "applied",
          commandType: "update_project_metadata",
        }),
      ],
    });
    expect(resumed.appliedReceipts[0]?.commandId).toBe(
      firstPrefixReceipt?.commandId,
    );
    expect(resumed.appliedReceipts[1]?.commandId).not.toBe(
      firstRejectedReceipt?.commandId,
    );
    expect(resumed.appliedReceipts[1]?.createdAt).toBe(resumedAt);
    expect(
      (await repo.load())?.inboxItems.filter(
        ({ id }) => id === "portable-prefix",
      ),
    ).toHaveLength(1);
    expect(
      (await repo.load())?.projects.find(
        ({ id }) => id === "portable-later-project",
      )?.name,
    ).toBe("Updated by resumed import");
  });

  it("fails closed when a deterministic import identity already has different applied bytes", async () => {
    const repo = await initializedRepository("portable-prefix-collision");
    const payload = {
      schemaVersion: 2,
      format: "omniplan-v2-portable-commands",
      commands: [
        { type: "capture_inbox", id: "expected-portable", text: "Expected" },
      ],
    } as const;
    const packageHash = await sha256Hex(canonicalJson(payload));
    const collidingCommandId = `import-${packageHash.slice(0, 24)}-0`;
    const collision = await dispatchCapture({
      repository: repo,
      commandId: collidingCommandId,
      inboxId: "different-command-payload",
    });
    if (!collision.ok) throw new Error("Expected collision seed to apply");
    const before = await repo.loadTransferSnapshot();

    await expect(
      importPortableCommands({
        repository: repo,
        workspaceId: WORKSPACE_ID,
        importedAt: EXPORTED_AT,
        actorId: "portable-import-human",
        sourceId: "portable-file:collision",
        payload,
      }),
    ).rejects.toMatchObject({ code: "PORTABLE_IMPORT_CONFLICT" });
    expect(await repo.loadTransferSnapshot()).toEqual(before);
  });

  it("refuses to skip a matching portable prefix whose stored receipt hash is corrupt", async () => {
    const repo = await initializedRepository("portable-prefix-corrupt-receipt");
    const input = {
      repository: repo,
      workspaceId: WORKSPACE_ID,
      importedAt: EXPORTED_AT,
      actorId: "portable-import-human",
      sourceId: "portable-file:corrupt-prefix",
      payload: {
        schemaVersion: 2,
        format: "omniplan-v2-portable-commands",
        commands: [
          { type: "capture_inbox", id: "corrupt-prefix", text: "Prefix" },
        ],
      },
    } as const;
    await expect(importPortableCommands(input)).resolves.toMatchObject({
      status: "applied",
    });
    const corrupted = await repo.load();
    if (corrupted === undefined) throw new Error("Expected imported Workspace");
    corrupted.commandReceipts[0]!.receiptHash = "0".repeat(64);
    await overwriteRawWorkspace(repo, corrupted);
    const before = await rawRepositoryState(repo);

    await expect(importPortableCommands(input)).rejects.toMatchObject({
      code: "PORTABLE_IMPORT_CONFLICT",
    });
    expect(await rawRepositoryState(repo)).toEqual(before);
  });

  it("preflights a later namespace conflict before an earlier portable command can write", async () => {
    const repo = await initializedRepository("portable-late-conflict");
    const payload = {
      schemaVersion: 2,
      format: "omniplan-v2-portable-commands",
      commands: [
        { type: "capture_inbox", id: "must-not-write", text: "First" },
        { type: "capture_inbox", id: "expected-second", text: "Second" },
      ],
    } as const;
    const packageHash = await sha256Hex(canonicalJson(payload));
    const collision = await dispatchCapture({
      repository: repo,
      commandId: `import-${packageHash.slice(0, 24)}-1`,
      inboxId: "different-second-command",
    });
    if (!collision.ok) throw new Error("Expected later collision seed");
    const before = await rawRepositoryState(repo);

    await expect(
      importPortableCommands({
        repository: repo,
        workspaceId: WORKSPACE_ID,
        importedAt: EXPORTED_AT,
        actorId: "portable-import-human",
        sourceId: "portable-file:late-conflict",
        payload,
      }),
    ).rejects.toMatchObject({ code: "PORTABLE_IMPORT_CONFLICT" });
    expect(await rawRepositoryState(repo)).toEqual(before);
    expect(
      (await repo.load())?.inboxItems.some(({ id }) => id === "must-not-write"),
    ).toBe(false);
  });

  it("converges identical concurrent portable imports without an applied/rejected receipt collision", async () => {
    const primary = await initializedRepository("portable-concurrent");
    const peer = new BrowserWorkspaceRepository({
      databaseName: primary.databaseName,
      indexedDB: indexedDBFactory,
    });
    const payload = {
      schemaVersion: 2,
      format: "omniplan-v2-portable-commands",
      commands: [
        { type: "capture_inbox", id: "portable-concurrent", text: "Once" },
      ],
    } as const;
    const importInput = {
      workspaceId: WORKSPACE_ID,
      importedAt: EXPORTED_AT,
      actorId: "portable-import-human",
      sourceId: "portable-file:concurrent",
      payload,
    } as const;

    const [left, right] = await Promise.all([
      importPortableCommands({ repository: primary, ...importInput }),
      importPortableCommands({ repository: peer, ...importInput }),
    ]);

    expect(left.status).toBe("applied");
    expect(right.status).toBe("applied");
    expect(left.appliedReceipts).toEqual(right.appliedReceipts);
    expect((await primary.load())?.commandReceipts).toEqual(
      left.appliedReceipts,
    );
    expect(await primary.listReceipts()).toEqual([]);
    expect(await primary.listPendingOutbox()).toHaveLength(1);
  });

  it("roundtrips a verified backup while atomically preserving a full safety backup", async () => {
    const source = await initializedRepository("restore-source");
    const sourceApplied = await dispatchCapture({
      repository: source,
      commandId: "restore-source-applied",
      inboxId: "restore-source-inbox",
    });
    if (!sourceApplied.ok) throw new Error("Expected source command");
    const sourceRejected = await seedRejectedReceipt(
      source,
      "restore-source-rejected",
      "restore-source-inbox",
      "2026-07-12T07:02:00.000Z",
    );
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });

    const target = await initializedRepository("restore-target");
    const targetApplied = await dispatchCapture({
      repository: target,
      commandId: "restore-target-applied",
      inboxId: "restore-target-inbox",
      now: "2026-07-12T07:10:00.000Z",
    });
    if (!targetApplied.ok) throw new Error("Expected target command");
    const targetRejected = await seedRejectedReceipt(
      target,
      "restore-target-rejected",
      "restore-target-inbox",
      "2026-07-12T07:11:00.000Z",
    );
    await markPendingSent(target);
    const sentinelBackup = await writeSentinelBackup(
      target,
      "preexisting-backup",
    );

    const result = await restoreVerifiedBackup({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:30:00.000Z",
    });
    if (result.status !== "restored") throw new Error("Expected restore");
    const safetyBackupId = result.safetyBackupId;

    expect(result).toMatchObject({
      status: "restored",
      revision: backup.workspace.revision,
      safetyBackupId: expect.stringMatching(/^v2-restore-point:/),
    });
    expect(await target.load()).toEqual(backup.workspace);
    expect(await target.listReceipts()).toEqual([sourceRejected]);
    expect(await target.listPendingOutbox()).toEqual([]);
    expect((await rawRepositoryState(target)).outbox).toEqual([]);
    expect(await target.loadVerifiedBackup(sentinelBackup.id)).toEqual(
      sentinelBackup,
    );
    const safetyRecord = await target.loadVerifiedBackup(safetyBackupId);
    if (safetyRecord === undefined) throw new Error("Expected safety backup");
    const safetyBackup = JSON.parse(
      safetyRecord.rawPayload,
    ) as WorkspaceBackupV2;
    expect(safetyBackup.workspace).toEqual(
      JSON.parse(canonicalJson(targetApplied.workspace)),
    );
    expect(safetyBackup.rejectedReceipts).toEqual([targetRejected]);
    const { backupChecksum: _safetyChecksum, ...safetyWithoutChecksum } =
      safetyBackup;
    expect(safetyBackup.backupChecksum).toBe(
      await sha256Hex(canonicalJson(safetyWithoutChecksum)),
    );
  });

  it("reconstructs the migrationRuns derived index when restoring a migrated Workspace", async () => {
    const fixture = await migrationFixture("restore-migrated");
    const source = await rawInitializedRepository(
      "restore-migrated-source",
      buildWorkspaceV2(WORKSPACE_ID, { migration: fixture.migration }),
    );
    await seedMigrationArtifacts({
      repository: source,
      migration: fixture.migration,
      sourceBackup: fixture.sourceBackup,
    });
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("restore-migrated-target");
    await target.writeAndVerifyBackup(fixture.sourceBackup);

    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });
    expect(
      await target.loadMigration(fixture.migration.sourceChecksum),
    ).toEqual(fixture.migration);
    expect((await rawRepositoryState(target)).migrationRuns).toEqual([
      fixture.migration,
    ]);
  });

  it("rejects a migrated Workspace entity that is not derived from its exact V1 source", async () => {
    const fixture = await nonemptyMigrationFixture();
    const tamperedWorkspace = structuredClone(fixture.workspace);
    tamperedWorkspace.workItems[0]!.title =
      "Tampered without any post-migration receipt";
    const source = await rawInitializedRepository(
      "restore-migration-lineage-source",
      tamperedWorkspace,
    );
    await seedMigrationArtifacts({
      repository: source,
      migration: fixture.migration,
      sourceBackup: fixture.sourceBackup,
    });
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository(
      "restore-migration-lineage-target",
    );
    await target.writeAndVerifyBackup(fixture.sourceBackup);
    const before = await rawRepositoryState(target);

    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_LINEAGE_INVALID" });
    expect(await rawRepositoryState(target)).toEqual(before);
  });

  it("restores a migrated Workspace with a real post-migration receipt chain and rejects unexplained later drift", async () => {
    const fixture = await nonemptyMigrationFixture({ stripActuals: true });
    const source = await rawInitializedRepository(
      "restore-migration-receipt-chain-source",
      fixture.workspace,
    );
    await seedMigrationArtifacts({
      repository: source,
      migration: fixture.migration,
      sourceBackup: fixture.sourceBackup,
    });
    const applied = await dispatchCapture({
      repository: source,
      commandId: "post-migration-capture",
      inboxId: "post-migration-inbox",
      now: "2026-07-12T07:00:00.000Z",
    });
    if (!applied.ok) {
      throw new Error(
        `Expected post-migration command: ${JSON.stringify(applied.rejection)}`,
      );
    }
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });

    const validTarget = await initializedRepository(
      "restore-migration-receipt-chain-valid",
    );
    await validTarget.writeAndVerifyBackup(fixture.sourceBackup);
    await expect(
      restoreVerifiedBackup({
        repository: validTarget,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored", revision: 1 });
    expect(await validTarget.load()).toEqual(backup.workspace);

    const tamperedBackup = await resignBackup(backup, (draft) => {
      draft.workspace.workItems[0]!.title =
        "Later drift without a matching receipt diff";
    });
    const invalidTarget = await initializedRepository(
      "restore-migration-receipt-chain-invalid",
    );
    await invalidTarget.writeAndVerifyBackup(fixture.sourceBackup);
    const before = await rawRepositoryState(invalidTarget);
    await expect(
      restoreVerifiedBackup({
        repository: invalidTarget,
        backup: tamperedBackup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MIGRATION_LINEAGE_INVALID" });
    expect(await rawRepositoryState(invalidTarget)).toEqual(before);
  });

  it.each(["missing", "mismatched"] as const)(
    "rejects a migrated restore with a %s migration source backup without any write",
    async (scenario) => {
      const fixture = await migrationFixture(`migration-source-${scenario}`);
      const source = await rawInitializedRepository(
        `migration-source-${scenario}`,
        buildWorkspaceV2(WORKSPACE_ID, { migration: fixture.migration }),
      );
      await seedMigrationArtifacts({
        repository: source,
        migration: fixture.migration,
        sourceBackup: fixture.sourceBackup,
      });
      const backup = await exportWorkspaceBackup({
        repository: source,
        exportedAt: EXPORTED_AT,
      });
      const target = await initializedRepository(
        `migration-source-target-${scenario}`,
      );
      if (scenario === "mismatched") {
        await writeSentinelBackup(target, fixture.migration.backupId);
      }
      const before = await rawRepositoryState(target);

      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "MIGRATION_SOURCE_BACKUP_REQUIRED",
      });
      expect(await rawRepositoryState(target)).toEqual(before);
    },
  );

  it.each([
    "noncanonical_backup_id",
    "non_v1_payload",
    "normalized_source_mismatch",
    "entity_counts_mismatch",
    "deterministic_map_mismatch",
  ] as const)(
    "rejects migrated restore provenance case %s with zero writes",
    async (scenario) => {
      const fixture = await migrationFixture(
        `migration-adversarial-${scenario}`,
      );
      if (scenario === "noncanonical_backup_id") {
        fixture.sourceBackup.id = "not-a-checksum-derived-v1-backup";
        fixture.migration.backupId = fixture.sourceBackup.id;
      } else if (scenario === "non_v1_payload") {
        fixture.sourceBackup.rawPayload = canonicalJson({
          schemaVersion: 2,
          snapshot: { projects: [] },
        });
        fixture.sourceBackup.checksum = await sha256Hex(
          fixture.sourceBackup.rawPayload,
        );
        fixture.sourceBackup.id = `v1-backup-${fixture.sourceBackup.checksum}`;
        fixture.migration.backupId = fixture.sourceBackup.id;
        fixture.migration.backupChecksum = fixture.sourceBackup.checksum;
      } else if (scenario === "normalized_source_mismatch") {
        fixture.migration.sourceChecksum = "0".repeat(64);
      } else if (scenario === "entity_counts_mismatch") {
        fixture.migration.entityCounts.projects = 1;
      } else {
        fixture.migration.deterministicIdMap["forged:source"] = "forged-target";
      }
      const source = await rawInitializedRepository(
        `migration-adversarial-source-${scenario}`,
        buildWorkspaceV2(WORKSPACE_ID, { migration: fixture.migration }),
      );
      await seedMigrationArtifacts({
        repository: source,
        migration: fixture.migration,
        sourceBackup: fixture.sourceBackup,
      });
      const backup = await exportWorkspaceBackup({
        repository: source,
        exportedAt: EXPORTED_AT,
      });
      const target = await initializedRepository(
        `migration-adversarial-target-${scenario}`,
      );
      await target.writeAndVerifyBackup(fixture.sourceBackup);
      const before = await rawRepositoryState(target);

      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "MIGRATION_SOURCE_BACKUP_REQUIRED",
      });
      expect(await rawRepositoryState(target)).toEqual(before);
    },
  );

  it("clears stale migrationRuns and only the mutable recovery marker when restoring a fresh Workspace", async () => {
    const source = await initializedRepository("restore-fresh-source");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const fixture = await migrationFixture("restore-fresh-target");
    const target = await rawInitializedRepository(
      "restore-fresh-target",
      buildWorkspaceV2(WORKSPACE_ID, { migration: fixture.migration }),
    );
    const migrationSourceBackup = await seedMigrationArtifacts({
      repository: target,
      migration: fixture.migration,
      sourceBackup: fixture.sourceBackup,
      recovery: true,
    });
    const sentinel = await writeSentinelBackup(
      target,
      "fresh-restore-sentinel",
    );

    const result = await restoreVerifiedBackup({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:30:00.000Z",
    });

    expect(result).toMatchObject({ status: "restored" });
    expect((await target.load())?.migration).toBeUndefined();
    expect(
      await target.loadMigration(fixture.migration.sourceChecksum),
    ).toBeUndefined();
    const after = await rawRepositoryState(target);
    expect(after.migrationRuns).toEqual([]);
    expect(after.backups).not.toContainEqual(
      expect.objectContaining({ id: "migration-recovery:current" }),
    );
    expect(after.backups).toContainEqual(migrationSourceBackup);
    expect(after.backups).toContainEqual(sentinel);
  });

  it("rolls back migrationRuns and the recovery marker with an aborted restore", async () => {
    const source = await initializedRepository("migration-rollback-source");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const fixture = await migrationFixture("migration-rollback-target");
    const target = await rawInitializedRepository(
      "migration-rollback-target",
      buildWorkspaceV2(WORKSPACE_ID, { migration: fixture.migration }),
    );
    await seedMigrationArtifacts({
      repository: target,
      migration: fixture.migration,
      sourceBackup: fixture.sourceBackup,
      recovery: true,
    });
    const before = await rawRepositoryState(target);
    const faulted = new BrowserWorkspaceRepository({
      databaseName: target.databaseName,
      indexedDB: indexedDBFactory,
      beforeTransactionComplete(operation, transaction) {
        if (operation === "restoreVerifiedBackup") transaction.abort();
      },
    });

    await expect(
      restoreVerifiedBackup({
        repository: faulted,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).rejects.toBeInstanceOf(DOMException);
    expect(await rawRepositoryState(target)).toEqual(before);
  });

  it("rejects checksum, ledger, receipt, shape, and impossible applied-ledger tampering before any write", async () => {
    const source = await initializedRepository("tamper-source");
    const applied = await dispatchCapture({
      repository: source,
      commandId: "tamper-applied",
      inboxId: "tamper-inbox",
    });
    if (!applied.ok) throw new Error("Expected tamper source command");
    await seedRejectedReceipt(
      source,
      "tamper-rejected",
      "tamper-inbox",
      "2026-07-12T07:03:00.000Z",
    );
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });

    const badChecksum = structuredClone(backup);
    badChecksum.backupChecksum = "0".repeat(64);
    const badWorkspaceHash = structuredClone(backup);
    badWorkspaceHash.workspaceHash = "1".repeat(64);
    const badLedgerHash = structuredClone(backup);
    badLedgerHash.receiptLedgerHash = "2".repeat(64);
    const badReceiptHash = await resignBackup(backup, (draft) => {
      draft.workspace.commandReceipts[0]!.actorId = "tampered-actor";
    });
    const badPayloadHash = await resignBackup(backup, (draft) => {
      draft.workspace.commandReceipts[0]!.payloadHash = "3".repeat(64);
    });
    const badDiff = await resignBackup(backup, (draft) => {
      draft.workspace.commandReceipts[0]!.diff[0]!.field = "tampered";
    });
    const badRejectedReceipt = await resignBackup(backup, (draft) => {
      draft.rejectedReceipts[0]!.receiptHash = "4".repeat(64);
    });
    let appliedRejectedCollision = structuredClone(backup);
    const collidingRejectedReceipt =
      appliedRejectedCollision.rejectedReceipts[0]!;
    collidingRejectedReceipt.id =
      appliedRejectedCollision.workspace.commandReceipts[0]!.commandId;
    collidingRejectedReceipt.commandId = collidingRejectedReceipt.id;
    await rehashReceipt(collidingRejectedReceipt);
    appliedRejectedCollision = await resignBackup(
      appliedRejectedCollision,
      () => undefined,
    );
    let brokenRevisionChain = structuredClone(backup);
    const brokenRevisionReceipt =
      brokenRevisionChain.workspace.commandReceipts[0]!;
    brokenRevisionReceipt.baseRevision = 7;
    brokenRevisionReceipt.revision = 8;
    await rehashReceipt(brokenRevisionReceipt);
    brokenRevisionChain = await resignBackup(
      brokenRevisionChain,
      () => undefined,
    );
    const unverifiedAppliedReceipt = await resignBackup(backup, (draft) => {
      draft.workspace.commandReceipts[0]!.source.verified = false;
    });
    await rehashReceipt(unverifiedAppliedReceipt.workspace.commandReceipts[0]!);
    const resignedUnverified = await resignBackup(
      unverifiedAppliedReceipt,
      () => undefined,
    );
    const unknownAppliedCommand = await resignBackup(backup, (draft) => {
      draft.workspace.commandReceipts[0]!.commandType =
        "unknown_future_command";
    });
    await rehashReceipt(unknownAppliedCommand.workspace.commandReceipts[0]!);
    const resignedUnknown = await resignBackup(
      unknownAppliedCommand,
      () => undefined,
    );
    const extraEnvelopeField = structuredClone(backup) as WorkspaceBackupV2 & {
      privileged?: boolean;
    };
    extraEnvelopeField.privileged = true;

    const tampered = [
      ["backup checksum", badChecksum],
      ["workspace hash", badWorkspaceHash],
      ["receipt ledger hash", badLedgerHash],
      ["receipt hash", badReceiptHash],
      ["payload hash", badPayloadHash],
      ["audit diff", badDiff],
      ["rejected receipt", badRejectedReceipt],
      ["applied and rejected receipt collision", appliedRejectedCollision],
      ["revision chain", brokenRevisionChain],
      ["unverified applied receipt", resignedUnverified],
      ["unknown applied command", resignedUnknown],
      ["extra envelope field", extraEnvelopeField],
    ] as const;

    for (const [name, candidate] of tampered) {
      const target = await initializedRepository(`tamper-target-${name}`);
      const before = await rawRepositoryState(target);
      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup: candidate,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
        name,
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      expect(await rawRepositoryState(target), name).toEqual(before);
    }
  });

  it("binds a protected Bet creation snapshot to the exact human receipt actor and time", async () => {
    const direction = buildDirectionBrief({
      id: "transfer-brief",
      projectId: "transfer-project",
      version: 1,
      audienceAndProblem: "Operators need one trustworthy next action.",
      successEvidence: "Five operators complete the guided flow.",
      appetiteSeconds: 7_200,
      validationMethod: "Observe the guided flow.",
      firstScope: [
        {
          id: "transfer-scope",
          title: "Guided start",
          description: "Direction through a committed first scope.",
        },
      ],
      noGoOrKill: "Stop if the flow needs expert intervention.",
      advancedNotes: "",
      createdAt: "2026-07-12T06:00:00.000Z",
      updatedAt: "2026-07-12T07:00:00.000Z",
    });
    const source = await rawInitializedRepository(
      "protected-provenance-source",
      buildWorkspaceV2(WORKSPACE_ID, {
        projects: [
          buildProjectV2({
            id: "transfer-project",
            name: "Transfer project",
            stage: "awaiting_bet",
            activeDirectionBriefId: direction.id,
            createdAt: "2026-07-12T06:00:00.000Z",
            updatedAt: "2026-07-12T07:00:00.000Z",
          }),
        ],
        directionBriefs: [direction],
      }),
    );
    const placed = await new CommandService(source, WORKSPACE_ID).dispatch(
      {
        type: "place_bet",
        projectId: "transfer-project",
        betId: "transfer-bet",
        start: EXPORTED_AT,
      },
      buildCommandContext({
        commandId: "protected-place-bet",
        expectedRevision: 0,
        actorId: "protected-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-protected-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: EXPORTED_AT,
      }),
    );
    if (!placed.ok) throw new Error("Expected protected Bet to apply");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });

    const validTarget = await initializedRepository(
      "protected-provenance-valid",
    );
    await expect(
      restoreVerifiedBackup({
        repository: validTarget,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });

    let actorMismatch = structuredClone(backup);
    actorMismatch.workspace.commandReceipts[0]!.actorId = "forged-human";
    await rehashReceipt(actorMismatch.workspace.commandReceipts[0]!);
    actorMismatch = await resignBackup(actorMismatch, () => undefined);

    let receiptTimeMismatch = structuredClone(backup);
    receiptTimeMismatch.workspace.commandReceipts[0]!.createdAt =
      "2026-07-12T08:01:00.000Z";
    await rehashReceipt(receiptTimeMismatch.workspace.commandReceipts[0]!);
    receiptTimeMismatch = await resignBackup(
      receiptTimeMismatch,
      () => undefined,
    );

    let diffRecordMismatch = structuredClone(backup);
    const creationDiff =
      diffRecordMismatch.workspace.commandReceipts[0]!.diff.find(
        ({ entity, entityId, field }) =>
          entity === "BetVersion" &&
          entityId === "transfer-bet" &&
          field === "created",
      );
    if (
      creationDiff === undefined ||
      creationDiff.after === null ||
      typeof creationDiff.after !== "object" ||
      Array.isArray(creationDiff.after)
    ) {
      throw new Error("Expected Bet creation diff");
    }
    creationDiff.after.actorId = "forged-human";
    await rehashReceipt(diffRecordMismatch.workspace.commandReceipts[0]!);
    diffRecordMismatch = await resignBackup(
      diffRecordMismatch,
      () => undefined,
    );

    let recordActorMismatch = structuredClone(backup);
    recordActorMismatch.workspace.bets[0]!.actorId = "forged-human";
    recordActorMismatch = await resignBackup(
      recordActorMismatch,
      () => undefined,
    );

    for (const [name, candidate] of [
      ["receipt actor", actorMismatch],
      ["receipt time", receiptTimeMismatch],
      ["creation diff", diffRecordMismatch],
      ["protected record actor", recordActorMismatch],
    ] as const) {
      const target = await initializedRepository(`protected-tamper-${name}`);
      const before = await rawRepositoryState(target);
      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup: candidate,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
      expect(await rawRepositoryState(target)).toEqual(before);
    }

    const activeBrief = placed.workspace.directionBriefs.find(
      ({ id }) => id === placed.workspace.projects[0]?.activeDirectionBriefId,
    );
    if (activeBrief === undefined) throw new Error("Expected active Direction");
    const {
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...directionDraft
    } = activeBrief;
    const proposalSource = await rawInitializedRepository(
      "protected-accepted-direction-source",
      placed.workspace,
    );
    const submittedDirection = await new CommandService(
      proposalSource,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "submit_command_proposal",
        proposalId: "protected-direction-proposal",
        command: {
          type: "update_direction",
          projectId: "transfer-project",
          brief: {
            ...directionDraft,
            audienceAndProblem:
              "Operators now need a materially different accepted flow.",
          },
        },
        rationale: "Observed behavior requires a materially different flow.",
      },
      buildCommandContext({
        commandId: "protected-submit-direction-proposal",
        expectedRevision: placed.workspace.revision,
        actorId: "protected-agent",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "verified-protected-agent",
          verified: true,
          capabilities: ["submit_proposal"],
        },
        now: "2026-07-12T08:05:00.000Z",
      }),
    );
    if (!submittedDirection.ok) {
      throw new Error("Expected material Direction proposal submission");
    }
    const proposalWorkspaceWithSibling = structuredClone(
      submittedDirection.workspace,
    );
    const submittedProposal =
      proposalWorkspaceWithSibling.commandProposals.find(
        ({ id }) => id === "protected-direction-proposal",
      );
    if (submittedProposal === undefined) {
      throw new Error("Expected submitted Direction proposal");
    }
    proposalWorkspaceWithSibling.commandProposals.push({
      ...structuredClone(submittedProposal),
      id: "protected-unrelated-proposal",
      rationale: "A separate open proposal must become stale on acceptance.",
    });
    await overwriteRawWorkspace(
      proposalSource,
      proposalWorkspaceWithSibling,
    );
    const acceptedDirection = await new CommandService(
      proposalSource,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "accept_command_proposal",
        proposalId: "protected-direction-proposal",
      },
      buildCommandContext({
        commandId: "protected-accept-direction-proposal",
        expectedRevision: submittedDirection.workspace.revision,
        actorId: "protected-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-protected-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:10:00.000Z",
      }),
    );
    if (!acceptedDirection.ok) {
      throw new Error("Expected material Direction proposal acceptance");
    }
    const laterProposalHistory = await dispatchCapture({
      repository: proposalSource,
      commandId: "protected-post-acceptance-capture",
      inboxId: "protected-post-acceptance-inbox",
      now: "2026-07-12T08:10:00.000Z",
    });
    if (!laterProposalHistory.ok) {
      throw new Error("Expected valid post-acceptance history");
    }
    const acceptedDirectionBackup = await exportWorkspaceBackup({
      repository: proposalSource,
      exportedAt: "2026-07-12T08:10:00.000Z",
    });
    const acceptedDirectionTarget = await initializedRepository(
      "protected-accepted-direction-valid",
    );
    await expect(
      restoreVerifiedBackup({
        repository: acceptedDirectionTarget,
        backup: acceptedDirectionBackup,
        validationNow: "2026-07-12T08:10:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });

    let impossibleUnrelatedProposalTransition = structuredClone(
      acceptedDirectionBackup,
    );
    const unrelatedProposal =
      impossibleUnrelatedProposalTransition.workspace.commandProposals.find(
        ({ id }) => id === "protected-unrelated-proposal",
      );
    const acceptedDirectionReceipt =
      impossibleUnrelatedProposalTransition.workspace.commandReceipts.find(
        ({ commandId }) =>
          commandId === "protected-accept-direction-proposal",
      );
    const unrelatedStatusDiff = acceptedDirectionReceipt?.diff.find(
      ({ entity, entityId, field }) =>
        entity === "CommandProposal" &&
        entityId === "protected-unrelated-proposal" &&
        field === "status",
    );
    if (
      unrelatedProposal === undefined ||
      acceptedDirectionReceipt === undefined ||
      unrelatedStatusDiff === undefined
    ) {
      throw new Error("Expected unrelated proposal staleness lineage");
    }
    unrelatedProposal.status = "open";
    unrelatedStatusDiff.before = "dismissed";
    unrelatedStatusDiff.after = "open";
    await rehashReceipt(acceptedDirectionReceipt);
    impossibleUnrelatedProposalTransition = await resignBackup(
      impossibleUnrelatedProposalTransition,
      () => undefined,
    );
    const impossibleUnrelatedProposalTarget = await initializedRepository(
      "protected-accepted-direction-impossible-unrelated-transition",
    );
    await expect(
      restoreVerifiedBackup({
        repository: impossibleUnrelatedProposalTarget,
        backup: impossibleUnrelatedProposalTransition,
        validationNow: "2026-07-12T08:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });

    let mismatchedAcceptedDirection = structuredClone(
      acceptedDirectionBackup,
    );
    const storedProposal =
      mismatchedAcceptedDirection.workspace.commandProposals.find(
        ({ id }) => id === "protected-direction-proposal",
      );
    const storedSubmitReceipt =
      mismatchedAcceptedDirection.workspace.commandReceipts.find(
        ({ commandId }) =>
          commandId === "protected-submit-direction-proposal",
      );
    const storedProposalCreation = storedSubmitReceipt?.diff.find(
      ({ entity, entityId, field }) =>
        entity === "CommandProposal" &&
        entityId === "protected-direction-proposal" &&
        field === "created",
    );
    if (
      storedProposal === undefined ||
      storedSubmitReceipt === undefined ||
      storedProposalCreation === undefined
    ) {
      throw new Error("Expected accepted Direction proposal lineage");
    }
    const benignDirectionCommand = {
      type: "update_direction" as const,
      projectId: "transfer-project",
      brief: structuredClone(directionDraft),
    };
    storedProposal.payload = benignDirectionCommand as unknown as JsonValue;
    storedProposalCreation.after = {
      ...structuredClone(storedProposal),
      status: "open",
    };
    storedSubmitReceipt.payloadHash = await sha256Hex(
      canonicalJson({
        type: "submit_command_proposal",
        proposalId: storedProposal.id,
        command: benignDirectionCommand,
        rationale: storedProposal.rationale,
      }),
    );
    await rehashReceipt(storedSubmitReceipt);
    mismatchedAcceptedDirection = await resignBackup(
      mismatchedAcceptedDirection,
      () => undefined,
    );
    const mismatchedAcceptedDirectionTarget = await initializedRepository(
      "protected-accepted-direction-mismatched-effect",
    );
    await expect(
      restoreVerifiedBackup({
        repository: mismatchedAcceptedDirectionTarget,
        backup: mismatchedAcceptedDirection,
        validationNow: "2026-07-12T08:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });

    const materialDirection = await new CommandService(
      source,
      WORKSPACE_ID,
    ).dispatch(
      {
        type: "update_direction",
        projectId: "transfer-project",
        brief: {
          ...directionDraft,
          audienceAndProblem: "Operators now need a materially different flow.",
        },
      },
      buildCommandContext({
        commandId: "protected-material-direction",
        expectedRevision: placed.workspace.revision,
        actorId: "protected-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-protected-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T08:10:00.000Z",
      }),
    );
    if (!materialDirection.ok) {
      throw new Error("Expected material Direction invalidation");
    }
    const rebetBackup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: "2026-07-12T08:10:00.000Z",
    });
    const rebetTarget = await initializedRepository("protected-rebet-valid");
    await expect(
      restoreVerifiedBackup({
        repository: rebetTarget,
        backup: rebetBackup,
        validationNow: "2026-07-12T08:10:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });
    let forgedRebetHold = structuredClone(rebetBackup);
    const rebetProject = forgedRebetHold.workspace.projects.find(
      ({ id }) => id === "transfer-project",
    );
    const rebetHold = rebetProject?.holds.find(
      ({ type }) => type === "rebet_required",
    );
    if (rebetHold === undefined) throw new Error("Expected Re-bet hold");
    rebetHold.affectedRecordIds = ["transfer-project", "transfer-bet"];
    forgedRebetHold = await resignBackup(forgedRebetHold, () => undefined);
    const forgedHoldTarget = await initializedRepository(
      "protected-rebet-forged-hold",
    );
    await expect(
      restoreVerifiedBackup({
        repository: forgedHoldTarget,
        backup: forgedRebetHold,
        validationNow: "2026-07-12T08:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });

    const rebetAt = "2026-07-12T08:20:00.000Z";
    const continued = await new CommandService(source, WORKSPACE_ID).dispatch(
      {
        type: "place_bet",
        projectId: "transfer-project",
        betId: "transfer-bet-2",
        start: rebetAt,
      },
      buildCommandContext({
        commandId: "protected-place-rebet",
        expectedRevision: materialDirection.workspace.revision,
        actorId: "protected-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-protected-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: rebetAt,
      }),
    );
    if (!continued.ok) throw new Error("Expected Re-bet continuation");
    expect(
      continued.workspace.bets.find(({ id }) => id === "transfer-bet-2"),
    ).toMatchObject({
      supersedesId: "transfer-bet",
      replacementReason: "material_direction_change",
    });
    expect(
      continued.workspace.projects[0]?.holds.some(
        ({ type, sourceId }) =>
          type === "rebet_required" && sourceId === "transfer-bet",
      ),
    ).toBe(false);
    const continuedBackup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: rebetAt,
    });
    const continuedTarget = await initializedRepository(
      "protected-rebet-continued",
    );
    await expect(
      restoreVerifiedBackup({
        repository: continuedTarget,
        backup: continuedBackup,
        validationNow: rebetAt,
      }),
    ).resolves.toMatchObject({ status: "restored" });

    const replacementCreation = continuedBackup.workspace.commandReceipts
      .find(({ commandId }) => commandId === "protected-place-rebet")
      ?.diff.find(
        ({ entity, entityId, field }) =>
          entity === "BetVersion" &&
          entityId === "transfer-bet-2" &&
          field === "created",
      );
    expect(replacementCreation?.after).toMatchObject({
      supersedesId: "transfer-bet",
      replacementReason: "material_direction_change",
    });

    const forgedReplacementReason = await resignBackup(
      continuedBackup,
      (draft) => {
        const replacement = draft.workspace.bets.find(
          ({ id }) => id === "transfer-bet-2",
        );
        if (replacement === undefined) throw new Error("Expected replacement Bet");
        replacement.replacementReason = "appetite_expiry";
      },
    );
    const forgedSourceReview = await resignBackup(
      continuedBackup,
      (draft) => {
        const replacement = draft.workspace.bets.find(
          ({ id }) => id === "transfer-bet-2",
        );
        if (replacement === undefined) throw new Error("Expected replacement Bet");
        replacement.sourceReviewId = "forged-expiry-review";
      },
    );
    const forgedPredecessorTombstone = await resignBackup(
      continuedBackup,
      (draft) => {
        const predecessor = draft.workspace.bets.find(
          ({ id }) => id === "transfer-bet",
        );
        if (predecessor === undefined) throw new Error("Expected predecessor Bet");
        predecessor.invalidatedAt = "2026-07-12T08:11:00.000Z";
        predecessor.invalidationReason =
          "Superseded by Re-bet transfer-bet-2.";
      },
    );
    for (const [name, candidate] of [
      ["replacement reason", forgedReplacementReason],
      ["source Review", forgedSourceReview],
      ["predecessor tombstone", forgedPredecessorTombstone],
    ] as const) {
      const target = await initializedRepository(
        `protected-rebet-lineage-${name}`,
      );
      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup: candidate,
          validationNow: rebetAt,
        }),
      ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    }

    const corruptedLiveWorkspace = structuredClone(placed.workspace);
    corruptedLiveWorkspace.bets[0]!.actorId = "forged-live-actor";
    await overwriteRawWorkspace(source, corruptedLiveWorkspace);
    const corruptedBefore = await rawRepositoryState(source);
    await expect(
      exportWorkspaceBackup({ repository: source, exportedAt: EXPORTED_AT }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
    expect(await rawRepositoryState(source)).toEqual(corruptedBefore);
  });

  it("refuses both unprepared and prepared pending outbox state without writing a safety backup", async () => {
    const source = await initializedRepository("pending-source");
    const sourceApplied = await dispatchCapture({
      repository: source,
      commandId: "pending-source-applied",
      inboxId: "pending-source-inbox",
    });
    if (!sourceApplied.ok) throw new Error("Expected pending source command");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("pending-target");
    const targetApplied = await dispatchCapture({
      repository: target,
      commandId: "pending-target-applied",
      inboxId: "pending-target-inbox",
    });
    if (!targetApplied.ok) throw new Error("Expected pending target command");

    const beforeUnprepared = await rawRepositoryState(target);
    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).resolves.toEqual({ status: "outbox_not_quiescent" });
    expect(await rawRepositoryState(target)).toEqual(beforeUnprepared);

    const [entry] = await target.listPendingOutbox();
    if (entry === undefined) throw new Error("Expected pending outbox entry");
    await target.prepareOutboxOperation(entry.id, {
      operationHash: "prepared-pending-operation",
      path: `v2/test/${entry.commandId}`,
      envelopeJson: canonicalJson({ commandId: entry.commandId }),
    });
    const beforePrepared = await rawRepositoryState(target);
    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:31:00.000Z",
      }),
    ).resolves.toEqual({ status: "outbox_not_quiescent" });
    expect(await rawRepositoryState(target)).toEqual(beforePrepared);
    expect((await rawRepositoryState(target)).backups).toEqual([]);
  });

  it("fails closed on malformed sent outbox identity without changing any store", async () => {
    const source = await initializedRepository("malformed-outbox-source");
    const sourceApplied = await dispatchCapture({
      repository: source,
      commandId: "malformed-outbox-source",
      inboxId: "malformed-outbox-source",
    });
    if (!sourceApplied.ok) throw new Error("Expected malformed source command");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("malformed-outbox-target");
    const targetApplied = await dispatchCapture({
      repository: target,
      commandId: "malformed-outbox-target",
      inboxId: "malformed-outbox-target",
    });
    if (!targetApplied.ok) throw new Error("Expected malformed target command");
    const [entry] = await target.listPendingOutbox();
    if (entry === undefined) throw new Error("Expected malformed outbox entry");
    await target.prepareOutboxOperation(entry.id, {
      operationHash: "not-a-sha256-identity",
      path: "v2/test/malformed",
      envelopeJson: canonicalJson({ malformed: true }),
    });
    await target.markOutboxSent(
      entry.id,
      "not-a-sha256-identity",
      "2026-07-12T08:00:00.000Z",
    );
    const before = await rawRepositoryState(target);

    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup,
        validationNow: "2026-07-12T08:30:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_OUTBOX" });
    expect(await rawRepositoryState(target)).toEqual(before);
  });

  it.each([
    {
      name: "hex hash not matching the canonical envelope",
      mutate(entry: SyncOutboxEntry) {
        if (entry.preparedOperation === undefined) {
          throw new Error("Expected prepared operation");
        }
        const forgedHash = "0".repeat(64);
        entry.operationHash = forgedHash;
        entry.preparedOperation.operationHash = forgedHash;
      },
    },
    {
      name: "valid envelope at the wrong immutable path",
      mutate(entry: SyncOutboxEntry) {
        if (entry.preparedOperation === undefined) {
          throw new Error("Expected prepared operation");
        }
        entry.preparedOperation.path = "v2/workspaces/forged/operations/wrong";
      },
    },
    {
      name: "valid envelope with a mismatched outbox tuple",
      mutate(entry: SyncOutboxEntry) {
        entry.payloadHash = "f".repeat(64);
      },
    },
    {
      name: "noncanonical envelope JSON",
      mutate(entry: SyncOutboxEntry) {
        if (entry.preparedOperation === undefined) {
          throw new Error("Expected prepared operation");
        }
        entry.preparedOperation.envelopeJson = JSON.stringify(
          JSON.parse(entry.preparedOperation.envelopeJson),
          null,
          2,
        );
      },
    },
  ])(
    "rejects $name as non-quiescent sent state with zero writes",
    async ({ mutate }) => {
      const source = await initializedRepository(
        `strong-outbox-source-${mutate.name}`,
      );
      const backup = await exportWorkspaceBackup({
        repository: source,
        exportedAt: EXPORTED_AT,
      });
      const target = await initializedRepository(
        `strong-outbox-target-${mutate.name}`,
      );
      const applied = await dispatchCapture({
        repository: target,
        commandId: `strong-outbox-${mutate.name}`,
        inboxId: `strong-outbox-${mutate.name}`,
      });
      if (!applied.ok) throw new Error("Expected strong outbox command");
      await markPendingSent(target);
      await mutateRawOutbox(target, mutate);
      const before = await rawRepositoryState(target);

      await expect(
        restoreVerifiedBackup({
          repository: target,
          backup,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_OUTBOX" });
      expect(await rawRepositoryState(target)).toEqual(before);
    },
  );

  it.each([
    {
      name: "abort",
      inject: (transaction: IDBTransaction) => transaction.abort(),
    },
    {
      name: "simulated quota failure",
      inject: (transaction: IDBTransaction) => {
        transaction.abort();
        throw new DOMException(
          "Simulated quota exhaustion",
          "QuotaExceededError",
        );
      },
    },
  ])(
    "rolls back workspace, ledgers, backups, and sent outbox on $name",
    async ({ inject }) => {
      const source = await initializedRepository(
        `rollback-source-${inject.name}`,
      );
      const sourceApplied = await dispatchCapture({
        repository: source,
        commandId: `rollback-source-${inject.name}`,
        inboxId: `rollback-source-${inject.name}`,
      });
      if (!sourceApplied.ok)
        throw new Error("Expected rollback source command");
      const backup = await exportWorkspaceBackup({
        repository: source,
        exportedAt: EXPORTED_AT,
      });
      const target = await initializedRepository(
        `rollback-target-${inject.name}`,
      );
      const targetApplied = await dispatchCapture({
        repository: target,
        commandId: `rollback-target-${inject.name}`,
        inboxId: `rollback-target-${inject.name}`,
      });
      if (!targetApplied.ok)
        throw new Error("Expected rollback target command");
      await seedRejectedReceipt(
        target,
        `rollback-rejected-${inject.name}`,
        `rollback-target-${inject.name}`,
        "2026-07-12T07:20:00.000Z",
      );
      await markPendingSent(target);
      await writeSentinelBackup(target, `rollback-sentinel-${inject.name}`);
      const before = await rawRepositoryState(target);
      const faulted = new BrowserWorkspaceRepository({
        databaseName: target.databaseName,
        indexedDB: indexedDBFactory,
        beforeTransactionComplete(operation, transaction) {
          if (operation === "restoreVerifiedBackup") inject(transaction);
        },
      });

      await expect(
        restoreVerifiedBackup({
          repository: faulted,
          backup,
          validationNow: "2026-07-12T08:30:00.000Z",
        }),
      ).rejects.toBeInstanceOf(DOMException);
      expect(await rawRepositoryState(target)).toEqual(before);
    },
  );

  it("rejects forged, stale, cross-checkpoint, and reused opaque restore authorizations", async () => {
    const source = await initializedRepository("token-source");
    const sourceApplied = await dispatchCapture({
      repository: source,
      commandId: "token-source-applied",
      inboxId: "token-source-inbox",
    });
    if (!sourceApplied.ok) throw new Error("Expected token source command");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("token-target");

    await expect(
      target.restoreVerifiedBackup({} as never),
    ).rejects.toMatchObject({ code: "AUTHORIZED_RESTORE_REQUIRED" });

    const samePersistenceAlias = new BrowserWorkspaceRepository({
      databaseName: target.databaseName,
      indexedDB: indexedDBFactory,
    });
    const instanceBound = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:28:00.000Z",
    });
    await expect(
      samePersistenceAlias.restoreVerifiedBackup(instanceBound),
    ).resolves.toBe("checkpoint_conflict");
    await expect(
      target.restoreVerifiedBackup(instanceBound),
    ).rejects.toMatchObject({ code: "AUTHORIZED_RESTORE_REQUIRED" });

    const crossRepository = await initializedRepository("token-cross-target");
    const crossIdentity = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:29:00.000Z",
    });
    await expect(
      crossRepository.restoreVerifiedBackup(crossIdentity),
    ).resolves.toBe("checkpoint_conflict");
    await expect(
      target.restoreVerifiedBackup(crossIdentity),
    ).rejects.toMatchObject({ code: "AUTHORIZED_RESTORE_REQUIRED" });

    const stale = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:30:00.000Z",
    });
    const changed = await dispatchCapture({
      repository: target,
      commandId: "token-target-changed",
      inboxId: "token-target-changed",
    });
    if (!changed.ok) throw new Error("Expected token target change");
    await markPendingSent(target);
    await expect(target.restoreVerifiedBackup(stale)).resolves.toBe(
      "checkpoint_conflict",
    );
    await expect(target.restoreVerifiedBackup(stale)).rejects.toMatchObject({
      code: "AUTHORIZED_RESTORE_REQUIRED",
    });

    const ledgerRace = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:31:00.000Z",
    });
    await seedRejectedReceipt(
      target,
      "token-ledger-race",
      "token-target-changed",
      "2026-07-12T08:32:00.000Z",
    );
    await expect(target.restoreVerifiedBackup(ledgerRace)).resolves.toBe(
      "checkpoint_conflict",
    );

    const valid = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:33:00.000Z",
    });
    await expect(target.restoreVerifiedBackup(valid)).resolves.toBe("restored");
    await expect(target.restoreVerifiedBackup(valid)).rejects.toMatchObject({
      code: "AUTHORIZED_RESTORE_REQUIRED",
    });
  });

  it("does not erase a migration recovery marker created after restore authorization", async () => {
    const source = await initializedRepository("recovery-race-source");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("recovery-race-target");
    const authorization = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:30:00.000Z",
    });
    const recoveryBackup = await writeSentinelBackup(
      target,
      "recovery-race-backup",
    );
    await target.saveMigrationRecovery({
      sourceChecksum: "recovery-race-source-checksum",
      backupId: recoveryBackup.id,
      backupChecksum: recoveryBackup.checksum,
      code: "MIGRATION_CONFLICT",
      message: "A newer recovery checkpoint must survive.",
      occurredAt: "2026-07-12T08:31:00.000Z",
    });
    const before = await rawRepositoryState(target);

    await expect(target.restoreVerifiedBackup(authorization)).resolves.toBe(
      "checkpoint_conflict",
    );
    expect(await rawRepositoryState(target)).toEqual(before);
    await expect(
      target.restoreVerifiedBackup(authorization),
    ).rejects.toMatchObject({ code: "AUTHORIZED_RESTORE_REQUIRED" });
  });

  it("fails atomically on an immutable safety-backup collision", async () => {
    const source = await initializedRepository("collision-source");
    const sourceApplied = await dispatchCapture({
      repository: source,
      commandId: "collision-source-applied",
      inboxId: "collision-source-inbox",
    });
    if (!sourceApplied.ok) throw new Error("Expected collision source command");
    const backup = await exportWorkspaceBackup({
      repository: source,
      exportedAt: EXPORTED_AT,
    });
    const target = await initializedRepository("collision-target");
    const authorization = await authorizeVerifiedBackupRestore({
      repository: target,
      backup,
      validationNow: "2026-07-12T08:30:00.000Z",
    });
    const collisionRaw = canonicalJson({ collision: true });
    await target.writeAndVerifyBackup({
      id: authorization.safetyBackupRecord.id,
      rawPayload: collisionRaw,
      checksum: await sha256Hex(collisionRaw),
    });
    const before = await rawRepositoryState(target);

    await expect(
      target.restoreVerifiedBackup(authorization),
    ).rejects.toMatchObject({
      code: "BACKUP_COLLISION",
    });
    expect(await rawRepositoryState(target)).toEqual(before);
  });

  it("routes schema-1 restore input to migration without touching V2 state", async () => {
    const target = await initializedRepository("restore-schema1");
    await writeSentinelBackup(target, "schema1-sentinel");
    const pending = await dispatchCapture({
      repository: target,
      commandId: "schema1-pending",
      inboxId: "schema1-pending",
    });
    if (!pending.ok) throw new Error("Expected schema-1 pending seed");
    const before = await rawRepositoryState(target);

    await expect(
      restoreVerifiedBackup({
        repository: target,
        backup: { schemaVersion: 1, workspaceId: WORKSPACE_ID },
        validationNow: EXPORTED_AT,
      }),
    ).resolves.toEqual({ status: "migration_required" });
    expect(await rawRepositoryState(target)).toEqual(before);
  });
});
