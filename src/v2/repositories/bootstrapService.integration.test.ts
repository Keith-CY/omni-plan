import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCapacityProfile, buildWorkspaceV2 } from "../tests/builders";
import type { MigrationRecoveryState } from "../migration/recovery";
import { createRawV1Backup } from "../migration/backup";
import {
  BootstrapService,
  bootstrapAllowsCommandService,
  canDispatchBootstrapCommand,
  type BootstrapWorkspaceRepository,
} from "./bootstrapService";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import { deleteV2Database } from "./indexedDb";

const NOW = "2026-07-12T00:00:00.000Z";

function recoveryState(): MigrationRecoveryState {
  return {
    sourceChecksum: "source-checksum",
    backupId: "v1-backup-raw-checksum",
    backupChecksum: "raw-checksum",
    code: "MIGRATION_VALIDATION_FAILED",
    message: "Migration validation failed.",
    occurredAt: NOW,
  };
}

describe("BootstrapService", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => item()));
  });

  it("loads recovery first, then existing V2, and blocks command service on an unresolved recovery", async () => {
    const calls: string[] = [];
    const recovery = recoveryState();
    const repository = {
      loadMigrationRecovery: vi.fn(async () => {
        calls.push("recovery");
        return recovery;
      }),
      clearMigrationRecoveryIfMatching: vi.fn(async () => {
        calls.push("clear-recovery");
        return "not_found" as const;
      }),
      load: vi.fn(async () => {
        calls.push("workspace");
        return undefined;
      }),
      initialize: vi.fn(async () => {
        calls.push("initialize");
        return "initialized" as const;
      }),
    } satisfies BootstrapWorkspaceRepository;
    const storage = {
      getItem: vi.fn(() => {
        calls.push("v1-storage");
        return null;
      }),
    };
    const service = new BootstrapService({
      repository,
      workspaceId: "workspace-bootstrap",
      v1Storage: storage,
    });

    const state = await service.resolve();

    expect(state).toEqual({ status: "recovery_error", recovery });
    expect(calls).toEqual(["recovery", "workspace"]);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(repository.initialize).not.toHaveBeenCalled();
    expect(bootstrapAllowsCommandService(state)).toBe(false);
    expect(canDispatchBootstrapCommand(state, "configure_capacity")).toBe(false);
    expect(canDispatchBootstrapCommand(state, "capture_inbox")).toBe(false);
  });

  it("clears a stale recovery marker when the matching migration is already committed", async () => {
    const calls: string[] = [];
    const recovery = recoveryState();
    const migration = {
      sourceSchemaVersion: 1 as const,
      sourceChecksum: recovery.sourceChecksum ?? "",
      backupId: recovery.backupId,
      backupChecksum: recovery.backupChecksum,
      migratedAt: NOW,
      entityCounts: {},
      deterministicIdMap: {},
    };
    const workspace = buildWorkspaceV2("workspace-recovered", {
      migration,
      capacityProfile: buildCapacityProfile({
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });
    const repository = {
      loadMigrationRecovery: vi.fn(async () => {
        calls.push("recovery");
        return recovery;
      }),
      clearMigrationRecoveryIfMatching: vi.fn(async () => {
        calls.push("clear-recovery");
        return "cleared" as const;
      }),
      load: vi.fn(async () => {
        calls.push("workspace");
        return workspace;
      }),
      initialize: vi.fn(async () => "already_exists" as const),
    } satisfies BootstrapWorkspaceRepository;
    const storage = { getItem: vi.fn(() => null) };

    const state = await new BootstrapService({
      repository,
      workspaceId: workspace.workspaceId,
      v1Storage: storage,
    }).resolve();

    expect(state).toEqual({ status: "ready", workspace });
    expect(calls).toEqual(["recovery", "workspace", "clear-recovery"]);
    expect(repository.clearMigrationRecoveryIfMatching).toHaveBeenCalledWith({
      sourceChecksum: recovery.sourceChecksum,
      backupId: recovery.backupId,
      backupChecksum: recovery.backupChecksum,
    });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(bootstrapAllowsCommandService(state)).toBe(true);
  });

  it("does not enter operational state when another tab replaces the recovery marker before cleanup", async () => {
    const staleRecovery = recoveryState();
    const newerRecovery: MigrationRecoveryState = {
      ...staleRecovery,
      sourceChecksum: "newer-source-checksum",
      backupId: "v1-backup-newer-checksum",
      backupChecksum: "newer-checksum",
      message: "A newer migration still needs recovery.",
    };
    const workspace = buildWorkspaceV2("workspace-bootstrap-race", {
      migration: {
        sourceSchemaVersion: 1,
        sourceChecksum: staleRecovery.sourceChecksum ?? "",
        backupId: staleRecovery.backupId,
        backupChecksum: staleRecovery.backupChecksum,
        migratedAt: NOW,
        entityCounts: {},
        deterministicIdMap: {},
      },
    });
    let marker: MigrationRecoveryState | undefined = staleRecovery;
    const repository = {
      loadMigrationRecovery: vi.fn(async () => marker),
      clearMigrationRecoveryIfMatching: vi.fn(async () => {
        // A second tab wins immediately before the tuple-CAS.
        marker = newerRecovery;
        return "not_matching" as const;
      }),
      load: vi.fn(async () => workspace),
      initialize: vi.fn(async () => "already_exists" as const),
    } satisfies BootstrapWorkspaceRepository;

    const state = await new BootstrapService({
      repository,
      workspaceId: workspace.workspaceId,
      v1Storage: { getItem: () => null },
    }).resolve();

    expect(marker).toEqual(newerRecovery);
    expect(state).toEqual({ status: "recovery_error", recovery: newerRecovery });
  });

  it("preserves a second tab's newer real IndexedDB recovery marker during stale cleanup", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-bootstrap-recovery-race";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const first = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const second = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const backupA = await createRawV1Backup(
      '{"schemaVersion":1,"snapshot":{"source":"a"}}',
    );
    const backupB = await createRawV1Backup(
      '{"schemaVersion":1,"snapshot":{"source":"b"}}',
    );
    await first.writeAndVerifyBackup(backupA);
    await second.writeAndVerifyBackup(backupB);
    const migrationA = {
      sourceSchemaVersion: 1 as const,
      sourceChecksum: "source-a",
      backupId: backupA.id,
      backupChecksum: backupA.checksum,
      migratedAt: NOW,
      entityCounts: {},
      deterministicIdMap: {},
    };
    const workspace = buildWorkspaceV2("workspace-bootstrap-idb-race", {
      migration: migrationA,
    });
    await first.commitMigration({
      sourceChecksum: migrationA.sourceChecksum,
      workspace,
      migrationRecord: migrationA,
    });
    const staleRecovery: MigrationRecoveryState = {
      sourceChecksum: migrationA.sourceChecksum,
      backupId: migrationA.backupId,
      backupChecksum: migrationA.backupChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: "The committed migration left a stale marker.",
      occurredAt: NOW,
    };
    const newerRecovery: MigrationRecoveryState = {
      sourceChecksum: "source-b",
      backupId: backupB.id,
      backupChecksum: backupB.checksum,
      code: "MIGRATION_VALIDATION_FAILED",
      message: "Source B still needs recovery.",
      occurredAt: NOW,
    };
    await first.saveMigrationRecovery(staleRecovery);
    let raced = false;
    const racingRepository: BootstrapWorkspaceRepository = {
      loadMigrationRecovery: () => first.loadMigrationRecovery(),
      load: () => first.load(),
      initialize: (candidate) => first.initialize(candidate),
      clearMigrationRecoveryIfMatching: async (expected) => {
        if (!raced) {
          raced = true;
          await second.saveMigrationRecovery(newerRecovery);
        }
        return first.clearMigrationRecoveryIfMatching(expected);
      },
    };

    const state = await new BootstrapService({
      repository: racingRepository,
      workspaceId: workspace.workspaceId,
      v1Storage: { getItem: () => null },
    }).resolve();

    expect(state).toEqual({ status: "recovery_error", recovery: newerRecovery });
    expect(await first.loadMigrationRecovery()).toEqual(newerRecovery);
  });

  it("fails closed on a mismatched existing Workspace identity without clearing recovery or inspecting V1", async () => {
    const recovery = recoveryState();
    const workspace = buildWorkspaceV2("workspace-other", {
      migration: {
        sourceSchemaVersion: 1,
        sourceChecksum: recovery.sourceChecksum ?? "",
        backupId: recovery.backupId,
        backupChecksum: recovery.backupChecksum,
        migratedAt: NOW,
        entityCounts: {},
        deterministicIdMap: {},
      },
    });
    const repository = {
      loadMigrationRecovery: vi.fn(async () => recovery),
      clearMigrationRecoveryIfMatching: vi.fn(async () => "not_found" as const),
      load: vi.fn(async () => workspace),
      initialize: vi.fn(async () => "already_exists" as const),
    } satisfies BootstrapWorkspaceRepository;
    const storage = { getItem: vi.fn(() => null) };

    await expect(
      new BootstrapService({
        repository,
        workspaceId: "workspace-expected",
        v1Storage: storage,
      }).resolve(),
    ).rejects.toThrow(/workspace.*identity|workspaceId/i);
    expect(repository.clearMigrationRecoveryIfMatching).not.toHaveBeenCalled();
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(repository.initialize).not.toHaveBeenCalled();
  });

  it("returns setup_required for an existing V2 without inspecting V1 storage", async () => {
    const workspace = buildWorkspaceV2("workspace-needs-setup");
    const repository = {
      loadMigrationRecovery: vi.fn(async () => undefined),
      clearMigrationRecoveryIfMatching: vi.fn(async () => "not_found" as const),
      load: vi.fn(async () => workspace),
      initialize: vi.fn(async () => "already_exists" as const),
    } satisfies BootstrapWorkspaceRepository;
    const storage = { getItem: vi.fn(() => "must-not-be-read") };

    const state = await new BootstrapService({
      repository,
      workspaceId: workspace.workspaceId,
      v1Storage: storage,
    }).resolve();

    expect(state).toEqual({ status: "setup_required", workspace });
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(repository.initialize).not.toHaveBeenCalled();
    expect(bootstrapAllowsCommandService(state)).toBe(true);
    expect(canDispatchBootstrapCommand(state, "configure_capacity")).toBe(true);
    expect(canDispatchBootstrapCommand(state, "capture_inbox")).toBe(false);
  });

  it("returns migration_required from the exact raw V1 key without initializing V2", async () => {
    const rawV1Payload = '{\n  "schemaVersion": 1,\n  "snapshot": {}\n}\n';
    const repository = {
      loadMigrationRecovery: vi.fn(async () => undefined),
      clearMigrationRecoveryIfMatching: vi.fn(async () => "not_found" as const),
      load: vi.fn(async () => undefined),
      initialize: vi.fn(async () => "initialized" as const),
    } satisfies BootstrapWorkspaceRepository;
    const storage = {
      getItem: vi.fn((key: string) =>
        key === "omni-plan-personal.workspace.v1" ? rawV1Payload : null,
      ),
    };

    const state = await new BootstrapService({
      repository,
      workspaceId: "workspace-migration-required",
      v1Storage: storage,
    }).resolve();

    expect(state).toEqual({ status: "migration_required", rawV1Payload });
    expect(storage.getItem).toHaveBeenCalledWith(
      "omni-plan-personal.workspace.v1",
    );
    expect(repository.initialize).not.toHaveBeenCalled();
    expect(bootstrapAllowsCommandService(state)).toBe(false);
    expect(canDispatchBootstrapCommand(state, "configure_capacity")).toBe(false);
  });

  it("uses repository CAS to initialize one empty V2 across two tabs", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-bootstrap-two-tabs";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const firstRepository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const secondRepository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const options = {
      workspaceId: "workspace-two-tabs",
      v1Storage: { getItem: () => null },
    };

    const [first, second] = await Promise.all([
      new BootstrapService({
        ...options,
        repository: firstRepository,
      }).resolve(),
      new BootstrapService({
        ...options,
        repository: secondRepository,
      }).resolve(),
    ]);

    expect(first.status).toBe("setup_required");
    expect(second.status).toBe("setup_required");
    if (first.status !== "setup_required" || second.status !== "setup_required") {
      throw new Error("Expected both tabs to resolve setup");
    }
    expect(first.workspace).toEqual(second.workspace);
    expect(first.workspace.workspaceId).toBe(options.workspaceId);
    expect(first.workspace.revision).toBe(0);
    expect(await firstRepository.load()).toEqual(first.workspace);
  });

  it("transitions a real persisted Workspace from setup_required to ready after configure_capacity", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-bootstrap-setup-ready";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const v1Storage = { getItem: vi.fn(() => null) };
    const workspaceId = "workspace-setup-ready";
    const bootstrap = new BootstrapService({
      repository,
      workspaceId,
      v1Storage,
    });

    const setup = await bootstrap.resolve();
    expect(setup.status).toBe("setup_required");
    expect(bootstrapAllowsCommandService(setup)).toBe(true);
    expect(canDispatchBootstrapCommand(setup, "configure_capacity")).toBe(true);
    expect(canDispatchBootstrapCommand(setup, "capture_inbox")).toBe(false);
    const profile = buildCapacityProfile({
      timeZone: "Asia/Tokyo",
      weeklyWindows: [
        { weekday: 0, startMinute: 540, finishMinute: 1_020 },
      ],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 7_200,
          mediumSeconds: 3_600,
          shallowSeconds: 1_800,
        },
      ],
      updatedAt: NOW,
      updatedBy: "human-1",
    });
    const configured = await new CommandService(repository, workspaceId).dispatch(
      { type: "configure_capacity", profile },
      {
        commandId: "configure-capacity-bootstrap",
        expectedRevision: 0,
        actorId: "human-1",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "setup-session",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: NOW,
      },
    );
    expect(configured.ok).toBe(true);

    const ready = await bootstrap.resolve();
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("Expected ready Workspace");
    expect(ready.workspace.capacityProfile).toEqual(profile);
    expect(bootstrapAllowsCommandService(ready)).toBe(true);
    expect(canDispatchBootstrapCommand(ready, "capture_inbox")).toBe(true);
    expect(v1Storage.getItem).toHaveBeenCalledTimes(1);
  });
});
