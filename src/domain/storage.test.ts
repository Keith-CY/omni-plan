import { describe, expect, it } from "vitest";
import { sampleWorkspace } from "./sampleData";
import { workspacePlaintextChecksum } from "./sync";
import {
  BrowserWorkspaceRepository,
  LEGACY_WORKSPACE_STORAGE_KEY,
  MIGRATION_BACKUP_STORAGE_KEY,
  resolveIncomingWorkspaceChange,
  WORKSPACE_STORAGE_KEY,
  workspaceFingerprint,
  workspacePayloadFingerprint,
  type WorkspaceStorageEventLike,
  type WorkspaceStorageEventSource
} from "./storage";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MemoryStorageEvents implements WorkspaceStorageEventSource {
  private readonly listeners = new Set<(event: WorkspaceStorageEventLike) => void>();

  addEventListener(type: "storage", listener: (event: WorkspaceStorageEventLike) => void): void {
    if (type === "storage") this.listeners.add(listener);
  }

  removeEventListener(type: "storage", listener: (event: WorkspaceStorageEventLike) => void): void {
    if (type === "storage") this.listeners.delete(listener);
  }

  emit(event: WorkspaceStorageEventLike): void {
    for (const listener of this.listeners) listener(event);
  }
}

function renamedWorkspace(name: string) {
  return {
    ...sampleWorkspace,
    projects: sampleWorkspace.projects.map((project, index) => index === 0 ? { ...project, name } : project)
  };
}

function legacyWorkspacePayload(schemaVersion: 1 | 2): string {
  const snapshot = JSON.parse(JSON.stringify(sampleWorkspace)) as Record<string, unknown>;
  delete snapshot.schemaVersion;
  delete snapshot.todos;
  delete snapshot.conversionHistory;
  if (schemaVersion === 1) {
    delete snapshot.timeZone;
    delete snapshot.recurringOccurrences;
  }
  return JSON.stringify({
    schemaVersion,
    exportedAt: "2026-07-22T00:00:00.000Z",
    snapshot
  });
}

function workspaceWithOpenTodo() {
  return {
    ...sampleWorkspace,
    todos: [{
      id: "todo-rollback-visible",
      title: "Visible after rollback",
      note: "This Todo must become a schema 2 task.",
      tags: ["migration"],
      flagged: true,
      estimatedSeconds: 1800,
      checklist: [{ id: "check-rollback", title: "Verify task", completed: false }],
      status: "open" as const,
      capturedAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T01:00:00.000Z",
      inbox: true
    }]
  };
}

describe("browser workspace cross-tab storage", () => {
  it.each([1, 2] as const)("backs up and promotes a schema %s local workspace to schema 3", async (schemaVersion) => {
    const storage = new MemoryStorage();
    const legacyPayload = legacyWorkspacePayload(schemaVersion);
    storage.setItem(LEGACY_WORKSPACE_STORAGE_KEY, legacyPayload);
    const repository = new BrowserWorkspaceRepository({ storage });

    const loaded = await repository.load();
    const promoted = JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)!) as {
      schemaVersion: number;
      snapshot: { schemaVersion: number; timeZone: string; todos: unknown[]; conversionHistory: unknown[] };
    };

    expect(storage.getItem(MIGRATION_BACKUP_STORAGE_KEY)).toBe(legacyPayload);
    expect(promoted.schemaVersion).toBe(3);
    expect(promoted.snapshot.schemaVersion).toBe(3);
    expect(promoted.snapshot.todos).toEqual([]);
    expect(promoted.snapshot.conversionHistory).toEqual([]);
    expect(promoted.snapshot.timeZone).toBe(schemaVersion === 1 ? "UTC" : "Asia/Tokyo");
    expect(loaded?.schemaVersion).toBe(3);
    expect(repository.migrationReport()).toMatchObject({
      direction: "upgrade",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: 3
    });
  });

  it("writes the recovery copy before rejecting an invalid legacy migration", async () => {
    const storage = new MemoryStorage();
    const envelope = JSON.parse(legacyWorkspacePayload(2)) as {
      snapshot: { dependencies: Array<{ toId: string }> };
    };
    envelope.snapshot.dependencies[0].toId = "missing-work-item";
    const invalidPayload = JSON.stringify(envelope);
    storage.setItem(LEGACY_WORKSPACE_STORAGE_KEY, invalidPayload);
    const repository = new BrowserWorkspaceRepository({ storage });

    await expect(repository.load()).rejects.toThrow("integrity validation");
    expect(storage.getItem(MIGRATION_BACKUP_STORAGE_KEY)).toBe(invalidPayload);
    expect(storage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull();
  });

  it("exports the complete schema 3 envelope", () => {
    const repository = new BrowserWorkspaceRepository();
    const workspace = workspaceWithOpenTodo();
    const envelope = JSON.parse(repository.exportWorkspace(workspace)) as {
      schemaVersion: number;
      exportedAt: string;
      snapshot: typeof workspace;
    };

    expect(envelope.schemaVersion).toBe(3);
    expect(envelope.snapshot.schemaVersion).toBe(3);
    expect(envelope.snapshot.todos).toEqual(workspace.todos);
    expect(envelope.snapshot.conversionHistory).toEqual(sampleWorkspace.conversionHistory);
    expect(Date.parse(envelope.exportedAt)).not.toBeNaN();
  });

  it("exports a schema 2 rollback file with every open Todo visible as a task", () => {
    const repository = new BrowserWorkspaceRepository();
    const workspace = workspaceWithOpenTodo();
    const envelope = JSON.parse(repository.exportRollbackWorkspace(workspace)) as {
      schemaVersion: number;
      snapshot: Record<string, unknown> & {
        timeZone: string;
        projects: Array<{ id: string }>;
        workItems: Array<{ id: string; projectId: string; title: string; description?: string; percentComplete: number; sourceTodoId?: string }>;
      };
    };

    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.snapshot.schemaVersion).toBeUndefined();
    expect(envelope.snapshot.todos).toBeUndefined();
    expect(envelope.snapshot.conversionHistory).toBeUndefined();
    expect(envelope.snapshot.timeZone).toBe("Asia/Tokyo");
    expect(envelope.snapshot.projects).toContainEqual(expect.objectContaining({ id: "p-schema3-todo-rollback" }));
    expect(envelope.snapshot.workItems).toContainEqual(expect.objectContaining({
      id: "todo-rollback-visible",
      projectId: "p-schema3-todo-rollback",
      title: "Visible after rollback",
      description: "This Todo must become a schema 2 task.",
      percentComplete: 0,
      sourceTodoId: "todo-rollback-visible"
    }));
  });

  it("uses the same canonical SHA-256 workspace fingerprint as encrypted sync", async () => {
    expect(workspaceFingerprint(sampleWorkspace)).toBe(await workspacePlaintextChecksum(sampleWorkspace));
  });

  it("notifies an already-open tab when another tab saves a safe successor", async () => {
    const storage = new MemoryStorage();
    const events = new MemoryStorageEvents();
    const receiver = new BrowserWorkspaceRepository({ storage, eventSource: events });
    const writer = new BrowserWorkspaceRepository({ storage });
    const changes: Array<ReturnType<typeof resolveIncomingWorkspaceChange>> = [];
    const oldValue = receiver.exportWorkspace(sampleWorkspace);
    storage.setItem(WORKSPACE_STORAGE_KEY, oldValue);
    let current = (await receiver.load())!;
    await writer.load();
    receiver.subscribe(() => current, (change) => {
      changes.push(change);
      if (change.decision === "apply") current = change.snapshot;
    });

    await writer.save(renamedWorkspace("Changed in another tab"));
    events.emit({
      key: WORKSPACE_STORAGE_KEY,
      oldValue,
      newValue: storage.getItem(WORKSPACE_STORAGE_KEY)
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].decision).toBe("apply");
    expect(current.projects[0].name).toBe("Changed in another tab");

    const writerEnvelope = JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)!) as { baseFingerprint?: string };
    expect(writerEnvelope.baseFingerprint).toBe(workspaceFingerprint(sampleWorkspace));

    await receiver.save(renamedWorkspace("Sequential receiver edit"));
    const receiverEnvelope = JSON.parse(storage.getItem(WORKSPACE_STORAGE_KEY)!) as { baseFingerprint?: string };
    expect(receiverEnvelope.baseFingerprint).toBe(workspaceFingerprint(renamedWorkspace("Changed in another tab")));
  });

  it("ignores duplicate content even when exportedAt differs", () => {
    const repository = new BrowserWorkspaceRepository();
    const firstPayload = repository.exportWorkspace(sampleWorkspace);
    const secondEnvelope = JSON.parse(firstPayload) as { exportedAt: string };
    secondEnvelope.exportedAt = "2099-01-01T00:00:00.000Z";
    const secondPayload = JSON.stringify(secondEnvelope);

    expect(workspacePayloadFingerprint(firstPayload)).toBe(workspacePayloadFingerprint(secondPayload));
    expect(resolveIncomingWorkspaceChange(sampleWorkspace, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: firstPayload,
      newValue: secondPayload
    })).toMatchObject({ decision: "ignore", reason: "same-content" });
  });

  it("reports a conflict instead of trusting oldValue when a legacy envelope has no parent", () => {
    const repository = new BrowserWorkspaceRepository();
    const basePayload = repository.exportWorkspace(sampleWorkspace);
    const remotePayload = repository.exportWorkspace(renamedWorkspace("Remote edit"));
    const localWorkspace = renamedWorkspace("Unsaved local edit");

    const result = resolveIncomingWorkspaceChange(localWorkspace, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: basePayload,
      newValue: remotePayload
    });

    expect(result).toMatchObject({ decision: "conflict" });
    if (result.decision === "conflict") {
      expect(result.incomingSnapshot.projects[0].name).toBe("Remote edit");
      expect(localWorkspace.projects[0].name).toBe("Unsaved local edit");
    }
  });

  it("keeps both concurrent branches conflicted when two loaded writers save from the same parent", async () => {
    const storage = new MemoryStorage();
    const seedRepository = new BrowserWorkspaceRepository({ storage });
    storage.setItem(WORKSPACE_STORAGE_KEY, seedRepository.exportWorkspace(sampleWorkspace));
    const writerA = new BrowserWorkspaceRepository({ storage });
    const writerB = new BrowserWorkspaceRepository({ storage });
    await writerA.load();
    await writerB.load();
    const branchA = renamedWorkspace("Writer A");
    const branchB = renamedWorkspace("Writer B");

    await writerA.save(branchA);
    const payloadA = storage.getItem(WORKSPACE_STORAGE_KEY)!;
    await writerB.save(branchB);
    const payloadB = storage.getItem(WORKSPACE_STORAGE_KEY)!;

    const seenByA = resolveIncomingWorkspaceChange(branchA, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: payloadA,
      newValue: payloadB
    });
    const seenByB = resolveIncomingWorkspaceChange(branchB, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: seedRepository.exportWorkspace(sampleWorkspace),
      newValue: payloadA
    });

    expect(JSON.parse(payloadA).baseFingerprint).toBe(workspaceFingerprint(sampleWorkspace));
    expect(JSON.parse(payloadB).baseFingerprint).toBe(workspaceFingerprint(sampleWorkspace));
    expect(seenByA).toMatchObject({ decision: "conflict", reason: "diverged" });
    expect(seenByB).toMatchObject({ decision: "conflict", reason: "diverged" });
    expect(branchA.projects[0].name).toBe("Writer A");
    expect(branchB.projects[0].name).toBe("Writer B");
  });

  it("still imports legacy envelopes without a parent fingerprint", () => {
    const repository = new BrowserWorkspaceRepository();
    const legacyPayload = JSON.stringify({ schemaVersion: 1, snapshot: sampleWorkspace });

    expect(repository.importWorkspace(legacyPayload).projects).toHaveLength(sampleWorkspace.projects.length);
  });

  it("ignores unrelated, removed, and damaged storage payloads", () => {
    const unrelated = resolveIncomingWorkspaceChange(sampleWorkspace, {
      key: "some-other-key",
      oldValue: null,
      newValue: "{}"
    });
    const removed = resolveIncomingWorkspaceChange(sampleWorkspace, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: "{}",
      newValue: null
    });
    const damaged = resolveIncomingWorkspaceChange(sampleWorkspace, {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: null,
      newValue: "not json"
    });

    expect(unrelated).toMatchObject({ decision: "ignore", reason: "unrelated-key" });
    expect(removed).toMatchObject({ decision: "ignore", reason: "missing-payload" });
    expect(damaged).toMatchObject({ decision: "ignore", reason: "invalid-payload" });
  });

  it("stops delivering storage changes after unsubscribe", () => {
    const events = new MemoryStorageEvents();
    const repository = new BrowserWorkspaceRepository({ storage: new MemoryStorage(), eventSource: events });
    const payload = repository.exportWorkspace(renamedWorkspace("Remote edit"));
    let deliveries = 0;
    const unsubscribe = repository.subscribe(() => sampleWorkspace, () => {
      deliveries += 1;
    });

    unsubscribe();
    events.emit({ key: WORKSPACE_STORAGE_KEY, oldValue: null, newValue: payload });

    expect(deliveries).toBe(0);
  });
});
