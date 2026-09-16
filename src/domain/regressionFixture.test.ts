import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BrowserWorkspaceRepository,
  resolveIncomingWorkspaceChange,
  WORKSPACE_STORAGE_KEY,
  workspaceFingerprint
} from "./storage";
import { createTaskFirstRegressionFixture } from "./regressionFixture";
import { downgradeWorkspaceToSchema2, migrateWorkspaceToSchema3 } from "./workspaceMigration";

const entityIds = (workspace: ReturnType<typeof createTaskFirstRegressionFixture>) => ({
  projects: workspace.projects.map((item) => item.id).sort(),
  todos: workspace.todos.map((item) => item.id).sort(),
  workItems: workspace.workItems.map((item) => item.id).sort(),
  dependencies: workspace.dependencies.map((item) => item.id).sort(),
  resources: workspace.resources.map((item) => item.id).sort(),
  occurrences: workspace.recurringOccurrences.map((item) => item.id).sort(),
  evidence: workspace.evidence.map((item) => item.id).sort(),
  changes: workspace.changeSets.map((item) => item.id).sort()
});

describe("task-first recovery fixture", () => {
  it("exports and restores every collection without changing ids or content", () => {
    const source = createTaskFirstRegressionFixture();
    const repository = new BrowserWorkspaceRepository();
    const restored = repository.importWorkspace(repository.exportWorkspace(source));

    expect(entityIds(restored)).toEqual(entityIds(source));
    expect(workspaceFingerprint(restored)).toBe(workspaceFingerprint(source));
    expect(restored.todos[0]).toMatchObject({
      plannedStart: "2026-09-16T01:00:00.000Z",
      captureSource: "shortcut",
      captureKey: "fixture-idempotency-key"
    });
  });

  it("produces an explicit schema-2 rollback mapping and upgrades it safely", () => {
    const source = createTaskFirstRegressionFixture();
    const downgraded = downgradeWorkspaceToSchema2({ schemaVersion: 3, snapshot: source });
    const upgraded = migrateWorkspaceToSchema3(downgraded.envelope);

    expect(downgraded.report.todoRollback?.mappings).toContainEqual({
      todoId: "todo-fixture-capture",
      workItemId: "todo-fixture-capture",
      status: "open"
    });
    expect(upgraded.snapshot.workItems.some((item) => item.id === "todo-fixture-capture")).toBe(true);
    expect(upgraded.snapshot.dependencies.map((item) => item.id).sort()).toEqual(source.dependencies.map((item) => item.id).sort());
    expect(upgraded.snapshot.recurringOccurrences.map((item) => item.id)).toEqual(["occ-fixture-1"]);
  });

  it("stops a divergent multi-tab save instead of silently overwriting it", () => {
    const base = createTaskFirstRegressionFixture();
    const current = { ...base, todos: base.todos.map((todo) => ({ ...todo, title: "Edited in current tab" })) };
    const incoming = { ...base, todos: base.todos.map((todo) => ({ ...todo, note: "Edited in other tab" })) };
    const event = {
      key: WORKSPACE_STORAGE_KEY,
      oldValue: null,
      newValue: JSON.stringify({
        schemaVersion: 3,
        baseFingerprint: workspaceFingerprint(base),
        snapshot: incoming
      })
    };

    expect(resolveIncomingWorkspaceChange(current, event)).toMatchObject({ decision: "conflict", reason: "diverged" });
  });

  it("publishes a validated schema-3 copy, report, and rollback package without touching the source backup", () => {
    const directory = mkdtempSync(join(tmpdir(), "omniplan-migration-drill-"));
    const sourcePath = join(directory, "workspace-source.json");
    const migratedPath = join(directory, "workspace-schema3.json");
    const reportPath = join(directory, "migration-report.json");
    const rollbackPath = join(directory, "workspace-schema2-rollback.json");
    const repository = new BrowserWorkspaceRepository();
    const sourcePayload = repository.exportWorkspace(createTaskFirstRegressionFixture());
    writeFileSync(sourcePath, sourcePayload, "utf8");

    try {
      execFileSync("bun", [
        resolve("scripts/migrate-workspace.ts"),
        sourcePath,
        migratedPath,
        reportPath,
        rollbackPath
      ], { cwd: resolve("."), stdio: "pipe" });

      expect(readFileSync(sourcePath, "utf8")).toBe(sourcePayload);
      const migrated = repository.importWorkspace(readFileSync(migratedPath, "utf8"));
      expect(entityIds(migrated)).toEqual(entityIds(createTaskFirstRegressionFixture()));
      expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({ toSchemaVersion: 3 });
      expect(JSON.parse(readFileSync(rollbackPath, "utf8"))).toMatchObject({ schemaVersion: 2 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
