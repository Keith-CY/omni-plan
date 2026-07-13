import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import { evaluateBetBoundary } from "../domain/lifecycle";
import { sha256Text } from "../domain/stableHash";
import type { MigrationRecord, WorkspaceV2 } from "../domain/types";
import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  BrowserWorkspaceRepository,
  type AtomicWorkspaceRepository,
  type RepositoryTransactionOperation,
} from "./browserWorkspaceRepository";
import {
  CommandService,
  CommandServiceBoundaryError,
} from "./commandService";
import { deleteV2Database } from "./indexedDb";
import {
  buildWorkspaceBackupV2,
  exportWorkspaceBackup,
} from "./workspaceTransfer";

const NOW = "2026-07-12T02:00:00.000Z";

function humanContext(
  commandId: string,
  expectedRevision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
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
    ...overrides,
  };
}

function systemContext(
  commandId: string,
  expectedRevision: number,
): CommandContext {
  return humanContext(commandId, expectedRevision, {
    actorId: "system-clock",
    actorKind: "system",
    origin: "agent",
    source: {
      sourceId: "system-clock-source",
      verified: true,
      capabilities: ["system_time"],
    },
  });
}

function capture(commandId: string): V2Command {
  return {
    type: "capture_inbox",
    id: `inbox-${commandId}`,
    text: `Captured ${commandId}`,
  };
}

function betBoundaryWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-system",
    projectId: "project-system",
    appetiteSeconds: 14_400,
    firstScope: [
      {
        id: "scope-system",
        title: "System boundary",
        description: "Exercise deterministic system retry.",
      },
    ],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: "bet-system",
    projectId: "project-system",
    briefId: brief.id,
    briefSnapshot: brief,
    briefHash: "system-brief-hash",
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-12T00:00:00.000Z",
    appetiteEnd: "2026-07-12T04:00:00.000Z",
    actorId: "human-1",
    approvedAt: "2026-07-12T00:00:00.000Z",
  });
  return buildWorkspaceV2("workspace-system", {
    projects: [
      buildProjectV2({
        id: "project-system",
        stage: "planning",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
  });
}

async function attachMigrationMarker(
  repository: Pick<AtomicWorkspaceRepository, "writeAndVerifyBackup">,
  workspace: WorkspaceV2,
  suffix: string,
): Promise<MigrationRecord> {
  const rawPayload = JSON.stringify({ schemaVersion: 1, fixture: suffix });
  const backupChecksum = await sha256Text(rawPayload);
  const record: MigrationRecord = {
    sourceSchemaVersion: 1,
    sourceChecksum: `fixture-source-${suffix}`,
    backupId: `v1-backup-${backupChecksum}`,
    backupChecksum,
    migratedAt: "2026-07-12T00:00:00.000Z",
    entityCounts: { projects: workspace.projects.length },
    deterministicIdMap: {},
  };
  await repository.writeAndVerifyBackup({
    id: record.backupId,
    rawPayload,
    checksum: record.backupChecksum,
  });
  workspace.migration = structuredClone(record);
  return record;
}

function repositoryProxy(
  delegate: AtomicWorkspaceRepository,
  overrides: Partial<AtomicWorkspaceRepository>,
): AtomicWorkspaceRepository {
  return {
    load: overrides.load ?? (() => delegate.load()),
    initialize: overrides.initialize ?? ((workspace) => delegate.initialize(workspace)),
    commit: overrides.commit ?? ((input) => delegate.commit(input)),
    commitMigration:
      overrides.commitMigration ?? ((input) => delegate.commitMigration(input)),
    writeAndVerifyBackup:
      overrides.writeAndVerifyBackup ??
      ((input) => delegate.writeAndVerifyBackup(input)),
    loadMigration:
      overrides.loadMigration ?? ((checksum) => delegate.loadMigration(checksum)),
    listPendingOutbox:
      overrides.listPendingOutbox ?? (() => delegate.listPendingOutbox()),
    markOutboxSent:
      overrides.markOutboxSent ??
      ((id, hash, sentAt) => delegate.markOutboxSent(id, hash, sentAt)),
    appendRejectedReceipt:
      overrides.appendRejectedReceipt ??
      ((receipt) => delegate.appendRejectedReceipt(receipt)),
    findReceipt:
      overrides.findReceipt ?? ((commandId) => delegate.findReceipt(commandId)),
    listReceipts: overrides.listReceipts ?? (() => delegate.listReceipts()),
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

describe("CommandService", () => {
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
    const databaseName = `omni-plan-v2-command-service-${suffix}`;
    if (!databaseNames.includes(databaseName)) databaseNames.push(databaseName);
    return new BrowserWorkspaceRepository({ databaseName, indexedDB });
  }

  it("loads, executes, and atomically persists one accepted command with a pending plaintext outbox entry", async () => {
    const repo = repository("accepted");
    const initial = buildWorkspaceV2("workspace-command-service");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);
    const command = capture("accepted");
    const commandContext = humanContext("accepted", 0);

    const result = await service.dispatch(command, commandContext);

    expect(result.ok).toBe(true);
    expect((await repo.load())?.revision).toBe(1);
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({
        id: "outbox-accepted",
        commandId: "accepted",
        baseRevision: 0,
        revision: 1,
        command,
        actor: {
          actorId: "human-1",
          actorKind: "human",
          origin: "ui",
          source: commandContext.source,
        },
        status: "pending",
      }),
    ]);
  });

  it.each([
    {
      name: "context unknown key",
      poison(context: CommandContext) {
        (context as unknown as Record<string, unknown>).unexpected = true;
      },
    },
    {
      name: "source unknown key",
      poison(context: CommandContext) {
        (context.source as unknown as Record<string, unknown>).unexpected = true;
      },
    },
    {
      name: "unknown capability",
      poison(context: CommandContext) {
        context.source.capabilities = ["unknown_capability" as never];
      },
    },
    {
      name: "duplicate capability",
      poison(context: CommandContext) {
        context.source.capabilities = ["human_decision", "human_decision"];
      },
    },
    {
      name: "sparse capability array",
      poison(context: CommandContext) {
        context.source.capabilities = new Array(1);
      },
    },
    {
      name: "custom capability array key",
      poison(context: CommandContext) {
        const capabilities: CommandContext["source"]["capabilities"] = [
          "human_decision",
        ];
        (capabilities as unknown as Record<string, unknown>).unexpected = true;
        context.source.capabilities = capabilities;
      },
    },
    {
      name: "fractional revision",
      poison(context: CommandContext) {
        context.expectedRevision = 0.5;
      },
    },
    {
      name: "noncanonical timestamp",
      poison(context: CommandContext) {
        context.now = "2026-07-12T02:00:00Z";
      },
    },
  ])("rejects $name before every repository read or write", async ({ poison }) => {
    const repo = repository(`invalid-context-${poison.name}`);
    const initial = buildWorkspaceV2("workspace-invalid-context");
    await repo.initialize(initial);
    const load = vi.fn(() => repo.load());
    const commit = vi.fn(async () => "committed" as const);
    const appendRejectedReceipt = vi.fn(async () => undefined);
    const findReceipt = vi.fn(async () => undefined);
    const service = new CommandService(
      repositoryProxy(repo, {
        load,
        commit,
        appendRejectedReceipt,
        findReceipt,
      }),
      initial.workspaceId,
    );
    const context = humanContext(`invalid-context-${poison.name}`, 0);
    poison(context);

    await expect(
      service.dispatch(capture(`invalid-context-${poison.name}`), context),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandServiceBoundaryError>>({
        name: "CommandServiceBoundaryError",
        code: "INVALID_COMMAND_CONTEXT",
      }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(appendRejectedReceipt).not.toHaveBeenCalled();
    expect(findReceipt).not.toHaveBeenCalled();
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("rejects a context accessor without invoking it", async () => {
    const repo = repository("accessor-context-snapshot");
    const initial = buildWorkspaceV2("workspace-accessor-context-snapshot");
    await repo.initialize(initial);
    const load = vi.fn(() => repo.load());
    const commit = vi.fn(async () => "committed" as const);
    const appendRejectedReceipt = vi.fn(async () => undefined);
    const findReceipt = vi.fn(async () => undefined);
    const service = new CommandService(
      repositoryProxy(repo, {
        load,
        commit,
        appendRejectedReceipt,
        findReceipt,
      }),
      initial.workspaceId,
    );
    const context = humanContext("accessor-context-snapshot", 0);
    const validSource = structuredClone(context.source);
    let sourceReads = 0;
    Object.defineProperty(context, "source", {
      enumerable: true,
      configurable: true,
      get() {
        sourceReads += 1;
        return sourceReads === 1
          ? { ...validSource, unexpected: true }
          : validSource;
      },
    });

    await expect(
      service.dispatch(capture("accessor-context-snapshot"), context),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandServiceBoundaryError>>({
        name: "CommandServiceBoundaryError",
        code: "INVALID_COMMAND_CONTEXT",
      }),
    );
    expect(sourceReads).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(appendRejectedReceipt).not.toHaveBeenCalled();
    expect(findReceipt).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "top-level command accessor",
      build(onRead: () => void): V2Command {
        const command = capture("accessor-command-input");
        Object.defineProperty(command, "text", {
          configurable: true,
          enumerable: true,
          get() {
            onRead();
            return "Accessor text";
          },
        });
        return command;
      },
    },
    {
      name: "nested proposal accessor",
      build(onRead: () => void): V2Command {
        const command: V2Command = {
          type: "submit_command_proposal",
          proposalId: "proposal-accessor-input",
          rationale: "Exercise an untrusted nested command graph.",
          command: {
            type: "remove_dependency",
            dependencyId: "dependency-accessor-input",
          },
        };
        if (command.type !== "submit_command_proposal") {
          throw new Error("Expected command proposal");
        }
        Object.defineProperty(command.command, "dependencyId", {
          configurable: true,
          enumerable: true,
          get() {
            onRead();
            return "dependency-accessor-input";
          },
        });
        return command;
      },
    },
  ])("rejects $name before cloning or repository I/O", async ({ name, build }) => {
    const repo = repository(`invalid-command-input-${name}`);
    const initial = buildWorkspaceV2(`workspace-invalid-command-input-${name}`);
    await repo.initialize(initial);
    const load = vi.fn(() => repo.load());
    const commit = vi.fn(async () => "committed" as const);
    const appendRejectedReceipt = vi.fn(async () => undefined);
    const findReceipt = vi.fn(async () => undefined);
    const service = new CommandService(
      repositoryProxy(repo, {
        load,
        commit,
        appendRejectedReceipt,
        findReceipt,
      }),
      initial.workspaceId,
    );
    let accessorReads = 0;
    const command = build(() => {
      accessorReads += 1;
    });

    await expect(
      service.dispatch(command, humanContext(`invalid-command-input-${name}`, 0)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandServiceBoundaryError>>({
        name: "CommandServiceBoundaryError",
        code: "INVALID_COMMAND_INPUT",
      }),
    );
    expect(accessorReads).toBe(0);
    expect(load).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(appendRejectedReceipt).not.toHaveBeenCalled();
    expect(findReceipt).not.toHaveBeenCalled();
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("maps an uncloneable context to the exact boundary error before repository I/O", async () => {
    const repo = repository("uncloneable-context");
    const initial = buildWorkspaceV2("workspace-uncloneable-context");
    await repo.initialize(initial);
    const load = vi.fn(() => repo.load());
    const commit = vi.fn(async () => "committed" as const);
    const appendRejectedReceipt = vi.fn(async () => undefined);
    const findReceipt = vi.fn(async () => undefined);
    const service = new CommandService(
      repositoryProxy(repo, {
        load,
        commit,
        appendRejectedReceipt,
        findReceipt,
      }),
      initial.workspaceId,
    );
    const context = new Proxy(
      humanContext("uncloneable-context", 0),
      {},
    );

    await expect(
      service.dispatch(capture("uncloneable-context"), context),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CommandServiceBoundaryError>>({
        name: "CommandServiceBoundaryError",
        code: "INVALID_COMMAND_CONTEXT",
      }),
    );
    expect(load).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(appendRejectedReceipt).not.toHaveBeenCalled();
    expect(findReceipt).not.toHaveBeenCalled();
  });

  it.each(["conflict open", "equivalent resolution"] as const)(
    "rejects malformed opaque %s context before loading the Workspace",
    async (boundary) => {
      const repo = repository(`invalid-authority-context-${boundary}`);
      const initial = buildWorkspaceV2("workspace-invalid-authority-context");
      await repo.initialize(initial);
      const load = vi.fn(() => repo.load());
      const service = new CommandService(
        repositoryProxy(repo, { load }),
        initial.workspaceId,
      );
      const context = humanContext(`invalid-authority-${boundary}`, 0) as
        CommandContext & { unexpected?: boolean };
      context.unexpected = true;
      const forged = { context } as never;

      const call = boundary === "conflict open"
        ? service.dispatchAuthorizedConflictOpen(forged)
        : service.dispatchAuthorizedEquivalentConflictResolution(forged);
      await expect(call).rejects.toMatchObject({
        name: "CommandServiceBoundaryError",
        code: "INVALID_COMMAND_CONTEXT",
      });
      expect(load).not.toHaveBeenCalled();
      expect(await repo.load()).toEqual(initial);
    },
  );

  it("returns the exact applied winner when identical commands lose the same-revision CAS race", async () => {
    const repo = repository("identical-cas-race");
    const initial = buildWorkspaceV2("workspace-identical-cas-race");
    await repo.initialize(initial);
    let waitingLoads = 0;
    let releaseLoads: (() => void) | undefined;
    const bothLoaded = new Promise<void>((resolve) => {
      releaseLoads = resolve;
    });
    const racingRepository = () =>
      repositoryProxy(repo, {
        async load() {
          const snapshot = await repo.load();
          waitingLoads += 1;
          if (waitingLoads === 2) releaseLoads?.();
          await bothLoaded;
          return snapshot;
        },
      });
    const command = capture("identical-race");
    const context = humanContext("identical-race", 0);

    const [left, right] = await Promise.all([
      new CommandService(racingRepository(), initial.workspaceId).dispatch(
        command,
        context,
      ),
      new CommandService(racingRepository(), initial.workspaceId).dispatch(
        command,
        context,
      ),
    ]);

    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) throw new Error("Expected exact CAS winner");
    expect(left.receipt).toEqual(right.receipt);
    expect((await repo.load())?.commandReceipts).toEqual([left.receipt]);
    expect(await repo.listReceipts()).toEqual([]);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
  });

  it("atomically prevents a stale human CAS rejection from colliding with a later applied owner", async () => {
    const repo = repository("atomic-receipt-owner-race");
    const initial = buildWorkspaceV2("workspace-atomic-receipt-owner-race");
    await repo.initialize(initial);
    const command = capture("shared-owner");
    let findCount = 0;
    let appliedRetry: Awaited<ReturnType<CommandService["dispatch"]>> | undefined;
    const racing = repositoryProxy(repo, {
      async commit() {
        const unrelated = await new CommandService(
          repo,
          initial.workspaceId,
        ).dispatch(capture("unrelated-winner"), humanContext("unrelated-winner", 0));
        if (!unrelated.ok) throw new Error("Expected unrelated CAS winner");
        return "revision_conflict";
      },
      async findReceipt(commandId) {
        findCount += 1;
        const observed = await repo.findReceipt(commandId);
        if (findCount === 2) {
          appliedRetry = await new CommandService(
            repo,
            initial.workspaceId,
          ).dispatch(command, humanContext("shared-owner", 1));
        }
        return observed;
      },
    });

    const stale = await new CommandService(racing, initial.workspaceId).dispatch(
      command,
      humanContext("shared-owner", 0),
    );

    expect(stale.ok).toBe(false);
    expect(appliedRetry?.ok).toBe(true);
    expect((await repo.load())?.commandReceipts).toEqual([
      expect.objectContaining({ commandId: "unrelated-winner" }),
      expect.objectContaining({ commandId: "shared-owner", status: "applied" }),
    ]);
    expect(await repo.listReceipts()).toEqual([]);
    await expect(
      exportWorkspaceBackup({ repository: repo, exportedAt: NOW }),
    ).resolves.toMatchObject({ schemaVersion: 2 });
  });

  it("snapshots command and context synchronously before the first repository await", async () => {
    const repo = repository("snapshot-before-await");
    const initial = buildWorkspaceV2("workspace-snapshot");
    await repo.initialize(initial);
    let releaseLoad: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const delayed = repositoryProxy(repo, {
      load: async () => {
        await gate;
        return repo.load();
      },
    });
    const service = new CommandService(delayed, initial.workspaceId);
    const command = capture("snapshot") as Extract<
      V2Command,
      { type: "capture_inbox" }
    >;
    const commandContext = humanContext("snapshot", 0);

    const pending = service.dispatch(command, commandContext);
    command.text = "MUTATED AFTER DISPATCH";
    commandContext.commandId = "mutated-command-id";
    commandContext.expectedRevision = 99;
    commandContext.actorId = "mutated-actor";
    commandContext.source.sourceId = "mutated-source";
    releaseLoad?.();
    const result = await pending;

    expect(result.ok).toBe(true);
    const [entry] = await repo.listPendingOutbox();
    expect(entry.command).toMatchObject({ text: "Captured snapshot" });
    expect(entry.commandId).toBe("snapshot");
    expect(entry.baseRevision).toBe(0);
    expect(entry.actor.actorId).toBe("human-1");
    expect(entry.actor.source.sourceId).toBe("human-session-1");
  });

  it("rejects an invalid command and appends only a rejection receipt", async () => {
    const repo = repository("rejected");
    const initial = buildWorkspaceV2("workspace-rejected-service");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);

    const result = await service.dispatch(
      {
        type: "capture_inbox",
        id: 42,
        text: "invalid runtime payload",
      } as unknown as V2Command,
      humanContext("invalid", 0),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected command rejection");
    expect(result.rejection.code).toBe("INVALID_COMMAND");
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.findReceipt("invalid")).toEqual(result.receipt);
  });

  it("deduplicates a sequential replay after a rejected command", async () => {
    const repo = repository("rejected-duplicate");
    const initial = buildWorkspaceV2("workspace-rejected-duplicate");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);
    const invalid = {
      type: "capture_inbox",
      id: 42,
      text: "invalid runtime payload",
    } as unknown as V2Command;
    const first = await service.dispatch(
      invalid,
      humanContext("rejected-duplicate", 0),
    );
    expect(first.ok).toBe(false);

    const duplicate = await service.dispatch(
      invalid,
      humanContext("rejected-duplicate", 0),
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("Expected rejected replay dedupe");
    expect(duplicate.rejection.code).toBe("DUPLICATE_COMMAND");
    expect(await repo.listReceipts()).toHaveLength(1);
    expect(await repo.load()).toEqual(initial);
  });

  it("returns a canonical duplicate to the loser when two tabs race different rejections under one commandId", async () => {
    const repo = repository("rejection-collision");
    const initial = buildWorkspaceV2("workspace-rejection-collision");
    await repo.initialize(initial);
    let firstLookups = 0;
    let releaseLookups: (() => void) | undefined;
    const bothLookedUp = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const synchronizedFindReceipt = async (commandId: string) => {
      if (firstLookups < 2) {
        firstLookups += 1;
        if (firstLookups === 2) releaseLookups?.();
        await bothLookedUp;
      }
      return repo.findReceipt(commandId);
    };
    const left = new CommandService(
      repositoryProxy(repo, { findReceipt: synchronizedFindReceipt }),
      initial.workspaceId,
    );
    const right = new CommandService(
      repositoryProxy(repo, { findReceipt: synchronizedFindReceipt }),
      initial.workspaceId,
    );
    const commandId = "colliding-rejection";
    const invalidPayload = {
      type: "capture_inbox",
      id: 42,
      text: "invalid runtime payload",
    } as unknown as V2Command;
    const unauthorizedContext = humanContext(commandId, 0, {
      source: {
        sourceId: "unverified-session",
        verified: false,
        capabilities: ["human_decision"],
      },
    });

    const results = await Promise.all([
      left.dispatch(invalidPayload, humanContext(commandId, 0)),
      right.dispatch(capture(commandId), unauthorizedContext),
    ]);

    expect(results.every(({ ok }) => !ok)).toBe(true);
    const rejectionCodes = results.map(({ receipt }) => receipt.rejectionCode);
    expect(rejectionCodes.filter((code) => code === "DUPLICATE_COMMAND")).toHaveLength(
      1,
    );
    expect(
      rejectionCodes.some(
        (code) => code === "INVALID_COMMAND" || code === "SOURCE_NOT_AUTHORIZED",
      ),
    ).toBe(true);
    const [stored] = await repo.listReceipts();
    expect(await repo.listReceipts()).toHaveLength(1);
    expect(stored.commandId).toBe(commandId);
    expect(stored.rejectionCode).not.toBe("DUPLICATE_COMMAND");
    const winner = results.find(
      ({ receipt }) => receipt.rejectionCode !== "DUPLICATE_COMMAND",
    );
    expect(winner?.receipt).toEqual(stored);
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });

  it("keeps a same-content deterministic rejection race idempotent", async () => {
    const repo = repository("same-rejection-race");
    const initial = buildWorkspaceV2("workspace-same-rejection-race");
    await repo.initialize(initial);
    let firstLookups = 0;
    let releaseLookups: (() => void) | undefined;
    const bothLookedUp = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    const synchronizedFindReceipt = async (commandId: string) => {
      if (firstLookups < 2) {
        firstLookups += 1;
        if (firstLookups === 2) releaseLookups?.();
        await bothLookedUp;
      }
      return repo.findReceipt(commandId);
    };
    const services = [
      new CommandService(
        repositoryProxy(repo, { findReceipt: synchronizedFindReceipt }),
        initial.workspaceId,
      ),
      new CommandService(
        repositoryProxy(repo, { findReceipt: synchronizedFindReceipt }),
        initial.workspaceId,
      ),
    ];
    const invalid = {
      type: "capture_inbox",
      id: 42,
      text: "same invalid payload",
    } as unknown as V2Command;
    const commandContext = humanContext("same-rejection", 0);

    const results = await Promise.all(
      services.map((service) => service.dispatch(invalid, commandContext)),
    );

    expect(results.map(({ receipt }) => receipt.rejectionCode)).toEqual([
      "INVALID_COMMAND",
      "INVALID_COMMAND",
    ]);
    expect(results[0].receipt).toEqual(results[1].receipt);
    expect(await repo.listReceipts()).toEqual([results[0].receipt]);
  });

  it("preserves stale-revision-before-duplicate precedence", async () => {
    const repo = repository("stale-before-duplicate");
    const initial = buildWorkspaceV2("workspace-stale-precedence");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);
    const command = capture("same-id");
    expect((await service.dispatch(command, humanContext("same-id", 0))).ok).toBe(
      true,
    );

    const staleDuplicate = await service.dispatch(
      command,
      humanContext("same-id", 0),
    );

    expect(staleDuplicate.ok).toBe(false);
    if (staleDuplicate.ok) throw new Error("Expected stale duplicate rejection");
    expect(staleDuplicate.rejection.code).toBe("REVISION_CONFLICT");
    expect((await repo.load())?.revision).toBe(1);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
  });

  it("preserves stale revision precedence over a separate rejected receipt collision", async () => {
    const repo = repository("stale-before-external-receipt");
    const initial = buildWorkspaceV2("workspace-stale-external-receipt");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);
    const commandId = "previously-rejected";
    const invalid = {
      type: "capture_inbox",
      id: 42,
      text: "invalid runtime payload",
    } as unknown as V2Command;
    const first = await service.dispatch(invalid, humanContext(commandId, 0));
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("Expected initial rejection");
    expect(first.rejection.code).toBe("INVALID_COMMAND");
    const storedBefore = await repo.findReceipt(commandId);
    expect(storedBefore).toEqual(first.receipt);
    expect(
      (
        await service.dispatch(
          capture("advance-after-rejection"),
          humanContext("advance-after-rejection", 0),
        )
      ).ok,
    ).toBe(true);

    const staleReplay = await service.dispatch(
      invalid,
      humanContext(commandId, 0),
    );

    expect(staleReplay.ok).toBe(false);
    if (staleReplay.ok) throw new Error("Expected stale replay rejection");
    expect(staleReplay.rejection.code).toBe("REVISION_CONFLICT");
    expect(await repo.findReceipt(commandId)).toEqual(storedBefore);
    expect((await repo.load())?.revision).toBe(1);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
  });

  it("deduplicates an applied command without another Workspace or outbox write", async () => {
    const repo = repository("duplicate");
    const initial = buildWorkspaceV2("workspace-duplicate-service");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);
    const command = capture("duplicate");
    expect((await service.dispatch(command, humanContext("duplicate", 0))).ok).toBe(
      true,
    );

    const duplicate = await service.dispatch(
      command,
      humanContext("duplicate", 1),
    );

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("Expected duplicate rejection");
    expect(duplicate.rejection.code).toBe("DUPLICATE_COMMAND");
    expect((await repo.load())?.revision).toBe(1);
    expect(await repo.listPendingOutbox()).toHaveLength(1);
  });

  it("turns a repository CAS loss into REVISION_CONFLICT and never retries a human commitment", async () => {
    const repo = repository("human-cas");
    const initial = buildWorkspaceV2("workspace-human-cas");
    await repo.initialize(initial);
    const commit = vi.fn(async () => "revision_conflict" as const);
    const service = new CommandService(
      repositoryProxy(repo, { commit }),
      initial.workspaceId,
    );

    const result = await service.dispatch(
      capture("human-cas"),
      humanContext("human-cas", 0),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected CAS rejection");
    expect(result.rejection.code).toBe("REVISION_CONFLICT");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect((await repo.findReceipt("human-cas"))?.rejectionCode).toBe(
      "REVISION_CONFLICT",
    );
  });

  it("never returns accepted when the atomic repository transaction aborts", async () => {
    const databaseName = "omni-plan-v2-command-service-atomic-abort";
    databaseNames.push(databaseName);
    const setup = new BrowserWorkspaceRepository({ databaseName, indexedDB });
    const initial = buildWorkspaceV2("workspace-service-abort");
    await setup.initialize(initial);
    const aborting = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
      beforeTransactionComplete: abortOnce("commit"),
    });
    const service = new CommandService(aborting, initial.workspaceId);

    await expect(
      service.dispatch(
        capture("atomic-abort"),
        humanContext("atomic-abort", 0),
      ),
    ).rejects.toThrow();
    expect(await setup.load()).toEqual(initial);
    expect(await setup.listPendingOutbox()).toEqual([]);
  });

  it("permits only an exact verified system command to retry a stored CAS conflict with the same deterministic commandId", async () => {
    const repo = repository("system-cas-retry");
    const initial = betBoundaryWorkspace();
    const migration = await attachMigrationMarker(
      repo,
      initial,
      "system-cas-retry",
    );
    await repo.commitMigration({
      sourceChecksum: migration.sourceChecksum,
      workspace: initial,
      migrationRecord: migration,
    });
    let commitAttempts = 0;
    const proxied = repositoryProxy(repo, {
      commit: async (input) => {
        commitAttempts += 1;
        if (commitAttempts === 1) return "revision_conflict";
        return repo.commit(input);
      },
    });
    const service = new CommandService(proxied, initial.workspaceId);
    const proposal = evaluateBetBoundary(initial, NOW)[0];
    if (proposal === undefined) throw new Error("Expected midpoint proposal");
    const commandId = `system:record_bet_boundary:${proposal.command.triggerKey}`;
    const commandContext = systemContext(commandId, 0);

    const conflict = await service.dispatch(proposal.command, commandContext);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("Expected first system CAS conflict");
    expect(conflict.rejection.code).toBe("REVISION_CONFLICT");
    const appliedAt = "2026-07-12T02:05:00.000Z";
    const applied = await service.dispatch(proposal.command, {
      ...commandContext,
      now: appliedAt,
    });

    expect(applied.ok).toBe(true);
    expect(commitAttempts).toBe(2);
    expect((await repo.load())?.commandReceipts).toEqual([
      expect.objectContaining({ commandId, status: "applied" }),
    ]);
    expect((await repo.findReceipt(commandId))?.status).toBe("applied");
    expect(await repo.listReceipts()).toEqual([
      expect.objectContaining({ commandId, status: "rejected" }),
    ]);
    const rejectedReceipt = (await repo.listReceipts())[0];
    if (rejectedReceipt === undefined) {
      throw new Error("Expected append-only system CAS rejection");
    }
    await expect(
      buildWorkspaceBackupV2({
        snapshot: {
          workspace: buildWorkspaceV2("workspace-system-overlap-export", {
            revision: 1,
            commandReceipts: [applied.receipt],
          }),
          rejectedReceipts: [rejectedReceipt],
        },
        exportedAt: appliedAt,
      }),
    ).resolves.toMatchObject({ schemaVersion: 2 });

    const appliedWinsDedupe = await service.dispatch(
      proposal.command,
      systemContext(commandId, 1),
    );
    expect(appliedWinsDedupe.ok).toBe(false);
    if (appliedWinsDedupe.ok) throw new Error("Expected applied dedupe");
    expect(appliedWinsDedupe.rejection.code).toBe("DUPLICATE_COMMAND");
    expect(appliedWinsDedupe.receipt.baseRevision).toBe(1);
    expect(commitAttempts).toBe(2);
  });

  it("does not retry a mismatched or non-system command merely because a CAS receipt exists", async () => {
    const repo = repository("human-same-id-no-retry");
    const initial = buildWorkspaceV2("workspace-human-same-id");
    await repo.initialize(initial);
    const commit = vi.fn(async () => "revision_conflict" as const);
    const service = new CommandService(
      repositoryProxy(repo, { commit }),
      initial.workspaceId,
    );
    const command = capture("human-no-retry");
    await service.dispatch(command, humanContext("human-no-retry", 0));

    const duplicate = await service.dispatch(
      command,
      humanContext("human-no-retry", 0),
    );

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("Expected duplicate rejection");
    expect(duplicate.rejection.code).toBe("DUPLICATE_COMMAND");
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects changed payload, unverified source, and wrong capability against a stored system CAS receipt", async () => {
    const repo = repository("system-cas-negative");
    const initial = betBoundaryWorkspace();
    const migration = await attachMigrationMarker(
      repo,
      initial,
      "system-cas-negative",
    );
    await repo.commitMigration({
      sourceChecksum: migration.sourceChecksum,
      workspace: initial,
      migrationRecord: migration,
    });
    const commit = vi.fn(async () => "revision_conflict" as const);
    const service = new CommandService(
      repositoryProxy(repo, { commit }),
      initial.workspaceId,
    );
    const proposal = evaluateBetBoundary(initial, NOW)[0];
    if (proposal === undefined) throw new Error("Expected midpoint proposal");
    const commandId = `system:record_bet_boundary:${proposal.command.triggerKey}`;
    await service.dispatch(proposal.command, systemContext(commandId, 0));

    const changedPayload = await service.dispatch(
      { ...proposal.command, triggerKey: "bet-system:changed" },
      systemContext(commandId, 0),
    );
    const unverified = await service.dispatch(proposal.command, {
      ...systemContext(commandId, 0),
      source: {
        sourceId: "system-clock-source",
        verified: false,
        capabilities: ["system_time"],
      },
    });
    const wrongCapability = await service.dispatch(proposal.command, {
      ...systemContext(commandId, 0),
      source: {
        sourceId: "system-clock-source",
        verified: true,
        capabilities: ["open_conflict"],
      },
    });

    for (const result of [changedPayload, unverified, wrongCapability]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected system retry dedupe");
      expect(result.rejection.code).toBe("DUPLICATE_COMMAND");
    }
    expect(commit).toHaveBeenCalledTimes(1);
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });

  it("persists locally without an unlocked sync key and leaves the outbox pending", async () => {
    const repo = repository("locked-sync");
    const initial = buildWorkspaceV2("workspace-locked-sync");
    await repo.initialize(initial);
    const service = new CommandService(repo, initial.workspaceId);

    const result = await service.dispatch(
      capture("locked"),
      humanContext("locked", 0),
    );

    expect(result.ok).toBe(true);
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({ commandId: "locked", status: "pending" }),
    ]);
  });

  it("requires BootstrapService to initialize the expected Workspace identity", async () => {
    const repo = repository("identity");
    const service = new CommandService(repo, "expected-workspace");
    await expect(
      service.dispatch(capture("missing"), humanContext("missing", 0)),
    ).rejects.toThrow(/initialized by BootstrapService/i);

    await repo.initialize(buildWorkspaceV2("other-workspace"));
    await expect(
      service.dispatch(capture("wrong"), humanContext("wrong", 0)),
    ).rejects.toThrow(/initialized by BootstrapService/i);
  });

  it("allows exactly one accepted result when two tabs dispatch concurrently", async () => {
    const first = repository("two-tab-dispatch");
    const second = repository("two-tab-dispatch");
    const initial = buildWorkspaceV2("workspace-two-tab");
    await first.initialize(initial);
    const firstService = new CommandService(first, initial.workspaceId);
    const secondService = new CommandService(second, initial.workspaceId);

    const results = await Promise.all([
      firstService.dispatch(capture("tab-left"), humanContext("tab-left", 0)),
      secondService.dispatch(capture("tab-right"), humanContext("tab-right", 0)),
    ]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    const rejected = results.find(({ ok }) => !ok);
    expect(rejected?.receipt.rejectionCode).toBe("REVISION_CONFLICT");
    expect((await first.load())?.revision).toBe(1);
    expect(await first.listPendingOutbox()).toHaveLength(1);
  });
});
