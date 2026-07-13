import { normalizeWorkspaceSnapshot } from "@/domain/projectLifecycle";
import type { WorkspaceSnapshot } from "@/domain/types";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stableHash } from "../domain/stableHash";
import type { JsonValue } from "../domain/types";
import {
  buildBetVersion,
  buildCloseDecision,
  buildDirectionBrief,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  BrowserWorkspaceRepository,
} from "../repositories/browserWorkspaceRepository";
import { deleteV2Database } from "../repositories/indexedDb";
import { exportWorkspaceBackup } from "../repositories/workspaceTransfer";
import currentSampleFixture from "../tests/fixtures/v1/current-sample.json";
import { createRawV1Backup, sha256Text } from "./backup";
import { migrateV1Workspace } from "./migrateV1";
import {
  loadRecoveryBackupDownload,
  migrateBrowserWorkspace,
} from "./recovery";
import { migrateBrowserWorkspaceWithTestMapper } from "./recoveryTestHarness";

const NOW = "2026-07-12T00:00:00.000Z";

function emptySnapshot(): WorkspaceSnapshot {
  return {
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
}

describe("atomic V1 migration coordinator", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => item()));
  });

  function repository(suffix: string): BrowserWorkspaceRepository {
    const indexedDB = new IDBFactory();
    const databaseName = `omni-plan-v2-atomic-migration-${suffix}`;
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    return new BrowserWorkspaceRepository({ databaseName, indexedDB });
  }

  it("verifies raw bytes, hashes only normalized source, then atomically commits V2 and the migration record", async () => {
    const repo = repository("commit");
    const snapshot = emptySnapshot();
    const rawV1Payload = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: "2026-07-12T00:00:00.000Z",
        snapshot,
      },
      null,
      2,
    );

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-migrated",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    const backupChecksum = await sha256Text(rawV1Payload);
    const sourceChecksum = await stableHash(
      normalizeWorkspaceSnapshot(snapshot) as unknown as JsonValue,
    );
    expect(backupChecksum).not.toBe(sourceChecksum);
    expect(result).toMatchObject({
      status: "committed",
      backupId: `v1-backup-${backupChecksum}`,
      backupChecksum,
      sourceChecksum,
    });
    const stored = await repo.load();
    expect(stored?.migration?.sourceChecksum).toBe(sourceChecksum);
    expect(await repo.loadMigration(sourceChecksum)).toEqual(stored?.migration);
    expect(
      await repo.loadVerifiedBackup(`v1-backup-${backupChecksum}`),
    ).toEqual({
      id: `v1-backup-${backupChecksum}`,
      rawPayload: rawV1Payload,
      checksum: backupChecksum,
    });
  });

  it("projects legacy Resource extensions before a committed migration is exported", async () => {
    const repo = repository("resource-known-field-projection");
    const snapshot = structuredClone(
      currentSampleFixture.snapshot,
    ) as unknown as WorkspaceSnapshot;
    snapshot.actuals = [];
    const resource = snapshot.resources[0] as unknown as Record<string, unknown>;
    resource.legacyExtra = { shouldNotLeak: true };
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-resource-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    expect((await repo.load())?.resources[0]).not.toHaveProperty("legacyExtra");
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("projects legacy AttentionCapacity extensions recursively before export", async () => {
    const repo = repository("capacity-known-field-projection");
    const snapshot = emptySnapshot();
    snapshot.capacities.push({
      date: "2026-07-12",
      deepSeconds: 3_600,
      mediumSeconds: 1_800,
      shallowSeconds: 900,
      unavailableBlocks: [
        {
          start: "2026-07-12T02:00:00.000Z",
          finish: "2026-07-12T03:00:00.000Z",
          legacyNestedExtra: true,
        },
      ],
      legacyExtra: { shouldNotLeak: true },
    } as unknown as WorkspaceSnapshot["capacities"][number]);
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-capacity-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    const [capacity] = (await repo.load())?.capacities ?? [];
    expect(capacity).not.toHaveProperty("legacyExtra");
    expect(capacity?.unavailableBlocks[0]).not.toHaveProperty(
      "legacyNestedExtra",
    );
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("projects legacy WorkItem extensions recursively before export", async () => {
    const repo = repository("work-item-known-field-projection");
    const snapshot = structuredClone(
      currentSampleFixture.snapshot,
    ) as unknown as WorkspaceSnapshot;
    snapshot.actuals = [];
    const workItem = snapshot.workItems.find(({ id }) => id === "w-scheduler")!;
    const rawWorkItem = workItem as unknown as Record<string, unknown>;
    rawWorkItem.legacyExtra = true;
    (workItem.estimate as unknown as Record<string, unknown>).legacyExtra = true;
    workItem.constraint = {
      noEarlierThan: "legacy-no-earlier-than",
      fixedFinish: "legacy-fixed-finish",
      legacyExtra: true,
    } as WorkspaceSnapshot["workItems"][number]["constraint"];
    (workItem.assignmentIds[0] as unknown as Record<string, unknown>).legacyExtra =
      true;
    (workItem.splitSegments![0] as unknown as Record<string, unknown>).legacyExtra =
      true;
    workItem.repeatRule = {
      cadence: "every-n-days",
      everyDays: 2,
      count: 3,
      startMode: "fixed-time",
      startAt: "legacy-repeat-start",
      legacyExtra: true,
    } as WorkspaceSnapshot["workItems"][number]["repeatRule"];
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-work-item-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    const stored = (await repo.load())?.workItems.find(
      ({ id }) => id === workItem.id,
    );
    expect(stored).not.toHaveProperty("legacyExtra");
    expect(stored?.estimate).not.toHaveProperty("legacyExtra");
    expect(stored?.constraint).not.toHaveProperty("legacyExtra");
    expect(stored?.assignmentIds[0]).not.toHaveProperty("legacyExtra");
    expect(stored?.splitSegments?.[0]).not.toHaveProperty("legacyExtra");
    expect(stored?.repeatRule).not.toHaveProperty("legacyExtra");
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("projects legacy Baseline extensions before export", async () => {
    const repo = repository("baseline-known-field-projection");
    const snapshot = structuredClone(
      currentSampleFixture.snapshot,
    ) as unknown as WorkspaceSnapshot;
    snapshot.actuals = [];
    const baseline = snapshot.baselines[0] as unknown as Record<string, unknown>;
    baseline.legacyExtra = { shouldNotLeak: true };
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-baseline-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    expect((await repo.load())?.baselines[0]).not.toHaveProperty("legacyExtra");
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("projects legacy Evidence extensions before export", async () => {
    const repo = repository("evidence-known-field-projection");
    const snapshot = structuredClone(
      currentSampleFixture.snapshot,
    ) as unknown as WorkspaceSnapshot;
    snapshot.actuals = [];
    const evidence = snapshot.evidence[0] as unknown as Record<string, unknown>;
    evidence.legacyExtra = { shouldNotLeak: true };
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-evidence-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    expect((await repo.load())?.evidence[0]).not.toHaveProperty("legacyExtra");
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("projects legacy Dependency extensions before export", async () => {
    const repo = repository("dependency-known-field-projection");
    const snapshot = structuredClone(
      currentSampleFixture.snapshot,
    ) as unknown as WorkspaceSnapshot;
    snapshot.actuals = [];
    const dependency = snapshot.dependencies[0] as unknown as Record<
      string,
      unknown
    >;
    dependency.legacyExtra = { shouldNotLeak: true };
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-dependency-known-field-projection",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    expect((await repo.load())?.dependencies[0]).not.toHaveProperty(
      "legacyExtra",
    );
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("rejects a migrated known field whose runtime value cannot be exported", async () => {
    const repo = repository("invalid-known-field");
    const snapshot = emptySnapshot();
    snapshot.resources.push({
      id: "resource-invalid-role",
      name: "Invalid role",
      role: 42,
      capacityByAttention: { deep: 1, medium: 1, shallow: 1 },
      hourlyRate: 1,
    } as unknown as WorkspaceSnapshot["resources"][number]);
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot,
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-invalid-known-field",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejection");
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        code: "WORKSPACE_SCHEMA_INVALID",
        path: "workspace.resources[0].role",
      }),
    );
    expect(await repo.load()).toBeUndefined();
  });

  it("uses the production migration and validation engine when no test engine is supplied", async () => {
    const repo = repository("production-engine");
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-production-engine",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("committed");
    if (result.status !== "committed") {
      throw new Error("Expected production migration to commit");
    }
    expect((await repo.load())?.migration).toEqual(result.migration);
  });

  it("rejects a mapper that fabricates a V2 Bet before atomic commit", async () => {
    const repo = repository("forged-bet");
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-forged-bet",
        actorId: "human-migrator",
        now: NOW,
        repository: repo,
      },
      (source, options) => {
        const candidate = migrateV1Workspace(source, options);
        const brief = buildDirectionBrief({
          id: "forged-brief",
          projectId: "forged-project",
          createdAt: NOW,
          updatedAt: NOW,
        });
        candidate.workspace.bets.push(
          buildBetVersion({
            id: "forged-bet",
            projectId: "forged-project",
            briefId: brief.id,
            briefSnapshot: brief,
            appetiteStart: NOW,
            appetiteEnd: "2026-07-13T00:00:00.000Z",
            actorId: "forged-human",
            approvedAt: NOW,
          }),
        );
        return candidate;
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejection");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNAUTHORIZED_V2_AUTHORITY",
          path: "workspace.bets",
        }),
      ]),
    );
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(result.sourceChecksum)).toBeUndefined();
  });

  it.each([
    {
      label: "Workspace identity",
      code: "MIGRATION_RECORD_MISMATCH",
      path: "workspace.workspaceId",
      mutate: (candidate: ReturnType<typeof migrateV1Workspace>) => {
        candidate.workspace.workspaceId = "workspace-forged";
      },
    },
    {
      label: "source checksum",
      code: "SOURCE_CHECKSUM_MISMATCH",
      path: "migration.sourceChecksum",
      mutate: (candidate: ReturnType<typeof migrateV1Workspace>) => {
        const forged = {
          ...candidate.migration,
          sourceChecksum: "forged-source-checksum",
        };
        candidate.migration = forged;
        candidate.workspace.migration = structuredClone(forged);
      },
    },
    {
      label: "backup tuple",
      code: "MIGRATION_RECORD_MISMATCH",
      path: "migration.backupId",
      mutate: (candidate: ReturnType<typeof migrateV1Workspace>) => {
        const forged = {
          ...candidate.migration,
          backupId: "v1-backup-forged",
          backupChecksum: "forged",
        };
        candidate.migration = forged;
        candidate.workspace.migration = structuredClone(forged);
      },
    },
    {
      label: "migration timestamp",
      code: "MIGRATION_RECORD_MISMATCH",
      path: "migration.migratedAt",
      mutate: (candidate: ReturnType<typeof migrateV1Workspace>) => {
        const forged = {
          ...candidate.migration,
          migratedAt: "2030-01-01T00:00:00.000Z",
        };
        candidate.migration = forged;
        candidate.workspace.migration = structuredClone(forged);
      },
    },
  ])("rejects a mapper with a forged $label binding", async ({ label, code, path, mutate }) => {
    const repo = repository(`forged-binding-${label.split(" ").join("-")}`);
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-trusted",
        actorId: "human-migrator",
        now: NOW,
        repository: repo,
      },
      (source, options) => {
        const candidate = migrateV1Workspace(source, options);
        mutate(candidate);
        return candidate;
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejection");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code,
          path,
        }),
      ]),
    );
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(result.sourceChecksum)).toBeUndefined();
  });

  it("keeps the trusted normalized source immutable when a mapper deletes an entity", async () => {
    const repo = repository("mapper-mutates-source");
    const rawV1Payload = JSON.stringify(currentSampleFixture);

    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-mapper-mutates-source",
        actorId: "human-migrator",
        now: NOW,
        repository: repo,
      },
      (source, options) => {
        source.baselines.splice(0, 1);
        return migrateV1Workspace(source, options);
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected rejection");
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "ENTITY_PRESERVATION_FAILED",
          path: "workspace.baselines",
        }),
      ]),
    );
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(result.sourceChecksum)).toBeUndefined();
  });

  it("keeps a verified downloadable backup and no V2 state when a mapper fabricates a CloseDecision", async () => {
    const repo = repository("validation-rejected");
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-rejected",
        actorId: "human-migrator",
        now: NOW,
        repository: repo,
      },
      (source, options) => {
        const candidate = migrateV1Workspace(source, options);
        candidate.workspace.closeDecisions.push(
          buildCloseDecision({
            id: "forged-close",
            projectId: "forged-project",
            actorId: "forged-human",
            closedAt: NOW,
          }),
        );
        return candidate;
      },
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") {
      throw new Error("Expected rejected migration");
    }
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNAUTHORIZED_V2_AUTHORITY",
          path: "workspace.closeDecisions",
        }),
      ]),
    );
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigration(result.sourceChecksum)).toBeUndefined();
    expect(await repo.loadMigrationRecovery()).toEqual(result.recovery);
    const download = await loadRecoveryBackupDownload(repo, result.recovery);
    expect(new TextDecoder().decode(download.bytes)).toBe(rawV1Payload);
    expect(download.checksum).toBe(result.backupChecksum);
  });

  it("recovers from an aborted migration transaction without publishing either V2 half", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-abort";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    let shouldAbort = true;
    const failing = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: (operation, transaction) => {
        if (operation === "commitMigration" && shouldAbort) {
          shouldAbort = false;
          transaction.abort();
        }
      },
    });
    const inspect = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-aborted",
      actorId: "human-migrator",
      now: NOW,
      repository: failing,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed migration");
    expect(result.recovery.code).toBe("MIGRATION_PERSISTENCE_FAILED");
    expect(await inspect.load()).toBeUndefined();
    if (result.sourceChecksum === null) {
      throw new Error("Persistence failure must retain source checksum");
    }
    expect(await inspect.loadMigration(result.sourceChecksum)).toBeUndefined();
    expect(await inspect.loadMigrationRecovery()).toEqual(result.recovery);
    const download = await loadRecoveryBackupDownload(inspect, result.recovery);
    expect(new TextDecoder().decode(download.bytes)).toBe(rawV1Payload);
  });

  it("uses normalized sourceChecksum for idempotency while retaining each distinct raw backup", async () => {
    const repo = repository("normalized-idempotency");
    const snapshot = emptySnapshot();
    const firstRaw = JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2026-07-12T00:00:00.000Z",
      snapshot,
    });
    const secondRaw = JSON.stringify(
      {
        snapshot,
        exportedAt: "2026-07-13T00:00:00.000Z",
        schemaVersion: 1,
      },
      null,
      2,
    );
    const first = await migrateBrowserWorkspace({
      rawV1Payload: firstRaw,
      workspaceId: "workspace-idempotent",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });
    const storedAfterFirst = await repo.load();
    const second = await migrateBrowserWorkspace({
      rawV1Payload: secondRaw,
      workspaceId: "workspace-idempotent",
      actorId: "human-migrator",
      now: "2026-07-13T00:00:00.000Z",
      repository: repo,
    });

    expect(first.status).toBe("committed");
    expect(second.status).toBe("already_migrated");
    expect(second.sourceChecksum).toBe(first.sourceChecksum);
    expect(second.backupChecksum).not.toBe(first.backupChecksum);
    expect(await repo.load()).toEqual(storedAfterFirst);
    expect(await repo.loadVerifiedBackup(first.backupId)).toBeDefined();
    expect(await repo.loadVerifiedBackup(second.backupId)).toBeDefined();
  });

  it("does not clear a newer recovery marker when an older migration is already stored", async () => {
    const repo = repository("already-preserves-newer-recovery");
    const snapshot = emptySnapshot();
    const firstRaw = JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2026-07-12T00:00:00.000Z",
      snapshot,
    });
    const secondRaw = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: "2026-07-13T00:00:00.000Z",
        snapshot,
      },
      null,
      2,
    );
    const first = await migrateBrowserWorkspace({
      rawV1Payload: firstRaw,
      workspaceId: "workspace-recovery-a-b",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") throw new Error("Expected commit");
    const newerBackup = await createRawV1Backup(secondRaw);
    await repo.writeAndVerifyBackup(newerBackup);
    const newerRecovery = {
      sourceChecksum: first.sourceChecksum,
      backupId: newerBackup.id,
      backupChecksum: newerBackup.checksum,
      code: "MIGRATION_PERSISTENCE_FAILED" as const,
      message: "A newer raw export failed after the older migration.",
      occurredAt: "2026-07-13T00:00:00.000Z",
    };
    await repo.saveMigrationRecovery(newerRecovery);

    const repeated = await migrateBrowserWorkspace({
      rawV1Payload: secondRaw,
      workspaceId: "workspace-recovery-a-b",
      actorId: "human-migrator",
      now: "2026-07-13T00:00:00.000Z",
      repository: repo,
    });

    expect(repeated.status).toBe("already_migrated");
    expect(await repo.loadMigrationRecovery()).toEqual(newerRecovery);
  });

  it("does not clear a newer recovery marker when the older migration wins a concurrent race", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-race-recovery-a-b";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const setup = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const snapshot = emptySnapshot();
    const firstRaw = JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2026-07-12T00:00:00.000Z",
      snapshot,
    });
    const secondRaw = JSON.stringify(
      {
        schemaVersion: 1,
        exportedAt: "2026-07-13T00:00:00.000Z",
        snapshot,
      },
      null,
      2,
    );
    const first = await migrateBrowserWorkspace({
      rawV1Payload: firstRaw,
      workspaceId: "workspace-race-recovery-a-b",
      actorId: "human-migrator",
      now: NOW,
      repository: setup,
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") throw new Error("Expected commit");
    const newerBackup = await createRawV1Backup(secondRaw);
    await setup.writeAndVerifyBackup(newerBackup);
    const newerRecovery = {
      sourceChecksum: first.sourceChecksum,
      backupId: newerBackup.id,
      backupChecksum: newerBackup.checksum,
      code: "MIGRATION_PERSISTENCE_FAILED" as const,
      message: "A newer raw export failed while another tab committed.",
      occurredAt: "2026-07-13T00:00:00.000Z",
    };
    await setup.saveMigrationRecovery(newerRecovery);
    class RacingRepository extends BrowserWorkspaceRepository {
      private firstMigrationRead = true;

      override async loadMigration(sourceChecksum: string) {
        if (this.firstMigrationRead) {
          this.firstMigrationRead = false;
          return undefined;
        }
        return super.loadMigration(sourceChecksum);
      }
    }
    const racing = new RacingRepository({ databaseName, indexedDB });

    const repeated = await migrateBrowserWorkspace({
      rawV1Payload: secondRaw,
      workspaceId: "workspace-race-recovery-a-b",
      actorId: "human-migrator",
      now: "2026-07-13T00:00:00.000Z",
      repository: racing,
    });

    expect(repeated.status).toBe("already_migrated");
    expect(await setup.loadMigrationRecovery()).toEqual(newerRecovery);
  });

  it("snapshots migration identity, time, and raw input before the first await", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-input-snapshot";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let backupWritten!: () => void;
    const backupReady = new Promise<void>((resolve) => {
      backupWritten = resolve;
    });
    class PausingRepository extends BrowserWorkspaceRepository {
      override async writeAndVerifyBackup(input: {
        id: string;
        rawPayload: string;
        checksum: string;
      }): Promise<void> {
        await super.writeAndVerifyBackup(input);
        backupWritten();
        await writeGate;
      }
    }
    const repo = new PausingRepository({ databaseName, indexedDB });
    const originalRaw = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const input = {
      rawV1Payload: originalRaw,
      workspaceId: "workspace-original",
      actorId: "human-original",
      now: NOW,
      repository: repo,
    };

    const pending = migrateBrowserWorkspace(input);
    await backupReady;
    input.rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: "2030-01-01T00:00:00.000Z",
      snapshot: emptySnapshot(),
    });
    input.workspaceId = "workspace-mutated";
    input.actorId = "human-mutated";
    input.now = "2030-01-01T00:00:00.000Z";
    releaseWrite();
    const result = await pending;

    expect(result.status).toBe("committed");
    expect((await repo.load())?.workspaceId).toBe("workspace-original");
    expect((await repo.load())?.migration?.migratedAt).toBe(NOW);
    expect(await repo.loadVerifiedBackup(result.backupId)).toEqual({
      id: result.backupId,
      rawPayload: originalRaw,
      checksum: await sha256Text(originalRaw),
    });
  });

  it("fails closed when a checksum record belongs to a different Workspace identity", async () => {
    const repo = repository("existing-wrong-workspace");
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const first = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-owner",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });
    expect(first.status).toBe("committed");
    const stored = await repo.load();

    const conflict = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-impostor",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(conflict.status).toBe("revision_conflict");
    if (conflict.status !== "revision_conflict") {
      throw new Error("Expected migration conflict");
    }
    expect(conflict.recovery.code).toBe("MIGRATION_CONFLICT");
    expect(await repo.load()).toEqual(stored);
    expect(await repo.loadMigrationRecovery()).toEqual(conflict.recovery);
  });

  it("returns a recoverable conflict when empty initialization wins before migration commit", async () => {
    const repo = repository("initialize-wins");
    const initialized = buildWorkspaceV2("workspace-initialize-wins");
    await repo.initialize(initialized);
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: initialized.workspaceId,
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("revision_conflict");
    if (result.status !== "revision_conflict") {
      throw new Error("Expected migration conflict");
    }
    expect(result.recovery.code).toBe("MIGRATION_CONFLICT");
    expect(await repo.load()).toEqual(initialized);
    expect(await repo.loadMigration(result.sourceChecksum)).toBeUndefined();
    expect(await repo.loadMigrationRecovery()).toEqual(result.recovery);
    expect(
      new TextDecoder().decode(
        (await loadRecoveryBackupDownload(repo, result.recovery)).bytes,
      ),
    ).toBe(rawV1Payload);
  });

  it("preserves malformed raw V1 bytes for recovery without creating V2 state", async () => {
    const repo = repository("malformed-v1");
    const rawV1Payload = '{"schemaVersion":1,"snapshot":';

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-malformed",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed migration");
    expect(result.sourceChecksum).toBeNull();
    expect(result.recovery.code).toBe("V1_PARSE_FAILED");
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigrationRecovery()).toEqual(result.recovery);
    expect(
      new TextDecoder().decode(
        (await loadRecoveryBackupDownload(repo, result.recovery)).bytes,
      ),
    ).toBe(rawV1Payload);
  });

  it("turns migration mapping errors into a recoverable validation failure", async () => {
    const repo = repository("mapping-error");
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-mapping-error",
        actorId: "human-migrator",
        now: NOW,
        repository: repo,
      },
      () => {
        throw new Error("Work Item orphan references missing Project.");
      },
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed migration");
    expect(result.recovery.code).toBe("MIGRATION_VALIDATION_FAILED");
    expect(result.recovery.message).toContain("missing Project");
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigrationRecovery()).toEqual(result.recovery);
    expect(
      new TextDecoder().decode(
        (await loadRecoveryBackupDownload(repo, result.recovery)).bytes,
      ),
    ).toBe(rawV1Payload);
  });

  it("returns a persistence failure when the migration record read fails after backup", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-load-failure";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    class ReadFailureRepository extends BrowserWorkspaceRepository {
      override async loadMigration(): Promise<undefined> {
        throw new DOMException(
          "Migration record read failed.",
          "UnknownError",
        );
      }
    }
    const failing = new ReadFailureRepository({ databaseName, indexedDB });
    const inspect = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-load-failure",
      actorId: "human-migrator",
      now: NOW,
      repository: failing,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failure");
    expect(result.recovery.code).toBe("MIGRATION_PERSISTENCE_FAILED");
    expect(result.recovery.message).toContain("read failed");
    expect(result.recoveryPersisted).toBe(true);
    expect(result.backup).toMatchObject({
      id: result.backupId,
      checksum: result.backupChecksum,
      rawPayload: rawV1Payload,
    });
    expect(await inspect.load()).toBeUndefined();
    expect(await inspect.loadMigrationRecovery()).toEqual(result.recovery);
  });

  it("returns an unpersisted failure with validation diagnostics when the recovery marker exceeds quota", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-marker-quota";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    class MarkerQuotaRepository extends BrowserWorkspaceRepository {
      override async saveMigrationRecovery(): Promise<void> {
        throw new DOMException(
          "Recovery marker quota exceeded.",
          "QuotaExceededError",
        );
      }
    }
    const failing = new MarkerQuotaRepository({ databaseName, indexedDB });
    const inspect = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });

    const result = await migrateBrowserWorkspaceWithTestMapper(
      {
        rawV1Payload,
        workspaceId: "workspace-marker-quota",
        actorId: "human-migrator",
        now: NOW,
        repository: failing,
      },
      (source, options) => {
        const candidate = migrateV1Workspace(source, options);
        candidate.workspace.closeDecisions.push(
          buildCloseDecision({
            id: "forged-close-marker-quota",
            projectId: "forged-project",
            actorId: "forged-human",
            closedAt: NOW,
          }),
        );
        return candidate;
      },
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failure");
    expect(result.recovery.code).toBe("MIGRATION_PERSISTENCE_FAILED");
    expect(result.recovery.message).toContain("quota exceeded");
    expect(result.recoveryPersisted).toBe(false);
    expect(result.recovery.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNAUTHORIZED_V2_AUTHORITY",
          path: "workspace.closeDecisions",
        }),
      ]),
    );
    expect(result.backup).toMatchObject({
      id: result.backupId,
      checksum: result.backupChecksum,
      rawPayload: rawV1Payload,
    });
    expect(await inspect.load()).toBeUndefined();
    expect(await inspect.loadMigrationRecovery()).toBeUndefined();
  });

  it("returns an unpersisted failure and preserves the marker when matching recovery clear fails", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-clear-failure";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const setup = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const committed = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-clear-failure",
      actorId: "human-migrator",
      now: NOW,
      repository: setup,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("Expected commit");
    const originalRecovery = {
      sourceChecksum: committed.migration.sourceChecksum,
      backupId: committed.migration.backupId,
      backupChecksum: committed.migration.backupChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED" as const,
      message: "A prior matching attempt needs cleanup.",
      occurredAt: NOW,
    };
    await setup.saveMigrationRecovery(originalRecovery);
    class ClearFailureRepository extends BrowserWorkspaceRepository {
      override async clearMigrationRecoveryIfMatching(): Promise<"cleared"> {
        throw new DOMException(
          "Matching recovery clear failed.",
          "UnknownError",
        );
      }
    }
    const failing = new ClearFailureRepository({ databaseName, indexedDB });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-clear-failure",
      actorId: "human-migrator",
      now: NOW,
      repository: failing,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failure");
    expect(result.recovery.code).toBe("MIGRATION_PERSISTENCE_FAILED");
    expect(result.recovery.message).toContain("clear failed");
    expect(result.recoveryPersisted).toBe(false);
    expect(result.backup).toMatchObject({
      id: result.backupId,
      checksum: result.backupChecksum,
      rawPayload: rawV1Payload,
    });
    expect(await setup.loadMigrationRecovery()).toEqual(originalRecovery);
  });

  it("stops before parsing when backup persistence aborts and leaves the V1 source untouched", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-backup-abort";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    let shouldAbort = true;
    const repo = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: (operation, transaction) => {
        if (operation === "backup" && shouldAbort) {
          shouldAbort = false;
          transaction.abort();
        }
      },
    });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const values = new Map([
      ["omni-plan-personal.workspace.v1", rawV1Payload],
    ]);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    const removeItem = vi.fn((key: string) => values.delete(key));
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
        removeItem,
      },
    });
    cleanup.push(async () => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-backup-abort",
      actorId: "human-migrator",
      now: NOW,
      repository: repo,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed migration");
    expect(result.sourceChecksum).toBeNull();
    expect(result.recovery.code).toBe("BACKUP_VERIFICATION_FAILED");
    expect(result.recoveryPersisted).toBe(false);
    expect(result.backup).toMatchObject({
      rawPayload: rawV1Payload,
      checksum: await sha256Text(rawV1Payload),
    });
    expect(await repo.load()).toBeUndefined();
    expect(await repo.loadMigrationRecovery()).toBeUndefined();
    expect(values.get("omni-plan-personal.workspace.v1")).toBe(rawV1Payload);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("keeps the verified backup recoverable when migration commit exceeds quota", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-atomic-migration-quota";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    class QuotaRepository extends BrowserWorkspaceRepository {
      override async commitMigration(): Promise<
        "committed" | "already_migrated" | "revision_conflict"
      > {
        throw new DOMException("Storage quota exceeded.", "QuotaExceededError");
      }
    }
    const failing = new QuotaRepository({ databaseName, indexedDB });
    const inspect = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const rawV1Payload = JSON.stringify({
      schemaVersion: 1,
      exportedAt: NOW,
      snapshot: emptySnapshot(),
    });
    const values = new Map([
      ["omni-plan-personal.workspace.v1", rawV1Payload],
    ]);
    const setItem = vi.fn((key: string, value: string) => values.set(key, value));
    const removeItem = vi.fn((key: string) => values.delete(key));
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem,
        removeItem,
      },
    });
    cleanup.push(async () => {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    });

    const result = await migrateBrowserWorkspace({
      rawV1Payload,
      workspaceId: "workspace-quota",
      actorId: "human-migrator",
      now: NOW,
      repository: failing,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed migration");
    expect(result.recovery.code).toBe("MIGRATION_PERSISTENCE_FAILED");
    expect(result.recovery.message).toContain("quota");
    expect(result.recoveryPersisted).toBe(true);
    expect(await inspect.load()).toBeUndefined();
    if (result.sourceChecksum === null) {
      throw new Error("Quota failure must retain source checksum");
    }
    expect(await inspect.loadMigration(result.sourceChecksum)).toBeUndefined();
    expect(await inspect.loadMigrationRecovery()).toEqual(result.recovery);
    expect(
      new TextDecoder().decode(
        (await loadRecoveryBackupDownload(inspect, result.recovery)).bytes,
      ),
    ).toBe(rawV1Payload);
    expect(values.get("omni-plan-personal.workspace.v1")).toBe(rawV1Payload);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
