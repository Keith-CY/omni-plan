import { describe, expect, it } from "vitest";
import {
  downgradeWorkspaceToSchema2,
  migrateWorkspaceToSchema3,
  TodoDowngradeBlockedError,
  UnsupportedWorkspaceSchemaError,
  validateWorkspaceIntegrity,
  WorkspaceIntegrityError
} from "./workspaceMigration";

function legacySchema2Snapshot() {
  return {
    timeZone: "Asia/Tokyo",
    projects: [
      {
        id: "p-main",
        name: "Main project",
        status: "active",
        mode: "build",
        priority: 1,
        northStar: "Preserve the plan",
        currentOutcome: "Migration verified",
        horizon: "2026-08-31T09:00:00.000Z",
        start: "2026-07-01T09:00:00.000Z",
        reviewCadenceDays: 7
      },
      {
        id: "p-shaped",
        name: "Shaped project",
        status: "active",
        mode: "build",
        priority: 2,
        northStar: "Ship the bet",
        currentOutcome: "Build",
        horizon: "2026-08-15T09:00:00.000Z",
        start: "2026-07-10T09:00:00.000Z",
        reviewCadenceDays: 7,
        shapeUpPitch: {
          problem: "Hard to plan",
          appetiteKind: "small-batch",
          appetiteDays: 14,
          solutionSketch: "A smaller plan",
          rabbitHoles: "None",
          noGos: "No rewrite",
          successBaseline: "Visible progress",
          scopes: [],
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T09:00:00.000Z"
        }
      }
    ],
    workItems: [
      {
        id: "w-phase",
        projectId: "p-main",
        kind: "phase",
        title: "Phase",
        description: "Parent description",
        outline: "1",
        durationSeconds: 0,
        estimate: { mostLikelySeconds: 0 },
        assignmentIds: [],
        percentComplete: 0
      },
      {
        id: "w-task",
        projectId: "p-main",
        parentId: "w-phase",
        kind: "task",
        title: "Recurring task",
        description: "Description must survive",
        outline: "1.1",
        durationSeconds: 3600,
        estimate: { mostLikelySeconds: 3600 },
        assignmentIds: [],
        percentComplete: 25,
        repeatRule: {
          cadence: "weekly",
          count: 4,
          startMode: "after-previous-finish",
          startAt: "2026-07-10T09:00:00.000Z"
        }
      }
    ],
    recurringOccurrences: [
      {
        id: "occ-1",
        ruleId: "repeat-w-task",
        workItemId: "w-task",
        projectId: "p-main",
        occurrenceIndex: 1,
        scheduledStart: "2026-07-18T09:00:00.000Z",
        scheduledFinish: "2026-07-18T10:00:00.000Z",
        start: "2026-07-18T09:00:00.000Z",
        finish: "2026-07-18T10:00:00.000Z",
        status: "occurred",
        title: "Recurring task",
        description: "Occurrence description must survive",
        createdAt: "2026-07-18T09:00:00.000Z",
        updatedAt: "2026-07-18T10:00:00.000Z"
      }
    ],
    dependencies: [
      {
        id: "d-1",
        projectId: "p-main",
        fromId: "w-phase",
        toId: "w-task",
        type: "FS",
        lagSeconds: 0
      }
    ],
    resources: [],
    capacities: [],
    baselines: [
      {
        id: "b-1",
        projectId: "p-main",
        name: "Initial",
        capturedAt: "2026-07-01T09:00:00.000Z",
        plannedStartByItem: { "w-task": "2026-07-10T09:00:00.000Z" },
        plannedFinishByItem: { "w-task": "2026-07-10T10:00:00.000Z" },
        plannedWorkSecondsByItem: { "w-task": 3600 }
      }
    ],
    actuals: [
      {
        workItemId: "w-task",
        actualWorkSeconds: 900,
        remainingWorkSeconds: 2700,
        actualCost: 0,
        recordedAt: "2026-07-18T10:00:00.000Z"
      }
    ],
    evidence: [
      {
        id: "e-1",
        kind: "note",
        summary: "Migration evidence",
        projectId: "p-main",
        workItemId: "w-task",
        createdAt: "2026-07-18T10:00:00.000Z",
        confidence: 1,
        tags: []
      }
    ],
    decisions: [],
    changeSets: [],
    auditGates: [],
    auditDecisions: []
  };
}

function schema3EnvelopeWithTodos() {
  const migrated = migrateWorkspaceToSchema3({
    schemaVersion: 2,
    exportedAt: "2026-07-22T00:00:00.000Z",
    baseFingerprint: "base-v2",
    snapshot: legacySchema2Snapshot()
  });
  return {
    ...migrated.envelope,
    snapshot: {
      ...migrated.snapshot,
      todos: [
        {
          id: "w-task",
          title: "Open colliding Todo",
          note: "Keep this open note",
          tags: ["inbox", "urgent"],
          flagged: true,
          estimatedSeconds: 1800,
          deferUntil: "2026-07-23T00:00:00.000Z",
          dueAt: "2026-07-24T00:00:00.000Z",
          repeatRule: {
            id: "repeat-w-task-todo",
            cadence: "weekly" as const,
            count: 2,
            executionMode: "manual" as const,
            endMode: "count" as const,
            startMode: "fixed-time" as const,
            automaticDurationSeconds: 0
          },
          checklist: [{ id: "check-1", title: "First step", completed: false }],
          plannedForDate: "2026-07-23",
          status: "open" as const,
          capturedAt: "2026-07-22T00:00:00.000Z",
          updatedAt: "2026-07-22T01:00:00.000Z",
          inbox: true
        },
        {
          id: "todo-complete",
          title: "Completed Todo",
          note: "Keep completed note",
          tags: [],
          flagged: false,
          checklist: [],
          status: "completed" as const,
          completedAt: "2026-07-21T02:00:00.000Z",
          capturedAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-21T02:00:00.000Z",
          inbox: false
        }
      ],
      conversionHistory: [
        {
          id: "conversion-1",
          type: "task_to_todo" as const,
          itemId: "w-old",
          occurredAt: "2026-07-20T00:00:00.000Z",
          discardedFields: ["dependency"]
        }
      ]
    }
  };
}

describe("workspace schema migration", () => {
  it("upgrades schema 1 with deterministic defaults while preserving live references", () => {
    const source = legacySchema2Snapshot();
    delete (source as { timeZone?: string }).timeZone;
    delete (source as { recurringOccurrences?: unknown[] }).recurringOccurrences;
    source.projects[0].status = "archived";
    const untouched = JSON.parse(JSON.stringify(source));

    const result = migrateWorkspaceToSchema3({
      schemaVersion: 1,
      exportedAt: "2026-07-22T00:00:00.000Z",
      snapshot: source
    });

    expect(result.envelope.schemaVersion).toBe(3);
    expect(result.snapshot.schemaVersion).toBe(3);
    expect(result.snapshot.timeZone).toBe("UTC");
    expect(result.snapshot.todos).toEqual([]);
    expect(result.snapshot.conversionHistory).toEqual([]);
    expect(result.snapshot.recurringOccurrences).toEqual([]);
    expect(result.snapshot.projects[0]).toMatchObject({
      id: "p-main",
      status: "done",
      archived: true,
      planningMethod: "omniplan",
      stage: "close"
    });
    expect(result.snapshot.projects[1]).toMatchObject({ planningMethod: "shape-up", stage: "shape" });
    expect(result.snapshot.workItems[1]).toMatchObject({
      id: "w-task",
      projectId: "p-main",
      parentId: "w-phase",
      description: "Description must survive",
      repeatRule: {
        id: "repeat-w-task",
        executionMode: "manual",
        endMode: "count",
        startMode: "after-previous-finish",
        count: 4
      }
    });
    expect(result.snapshot.dependencies[0]).toMatchObject({ fromId: "w-phase", toId: "w-task" });
    expect(result.report).toMatchObject({
      direction: "upgrade",
      fromSchemaVersion: 1,
      toSchemaVersion: 3,
      applied: true
    });
    expect(source).toEqual(untouched);
  });

  it("upgrades schema 2 without losing timezone, occurrence history, descriptions, or envelope metadata", () => {
    const result = migrateWorkspaceToSchema3(JSON.stringify({
      schemaVersion: 2,
      exportedAt: "2026-07-22T00:00:00.000Z",
      baseFingerprint: "base-v2",
      snapshot: legacySchema2Snapshot()
    }));

    expect(result.envelope.exportedAt).toBe("2026-07-22T00:00:00.000Z");
    expect(result.envelope.baseFingerprint).toBe("base-v2");
    expect(result.snapshot.timeZone).toBe("Asia/Tokyo");
    expect(result.snapshot.workItems[1].description).toBe("Description must survive");
    expect(result.snapshot.recurringOccurrences).toEqual([
      expect.objectContaining({
        id: "occ-1",
        ruleId: "repeat-w-task",
        workItemId: "w-task",
        projectId: "p-main",
        description: "Occurrence description must survive"
      })
    ]);
    expect(result.report.before).toMatchObject({ projects: 2, workItems: 2, recurringOccurrences: 1 });
    expect(result.report.after).toMatchObject({ projects: 2, workItems: 2, recurringOccurrences: 1 });
  });

  it("is idempotent once a workspace is normalized to schema 3", () => {
    const first = migrateWorkspaceToSchema3(schema3EnvelopeWithTodos());
    const second = migrateWorkspaceToSchema3(first.envelope);

    expect(second.envelope).toEqual(first.envelope);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(second.report.direction).toBe("noop");
    expect(second.report.applied).toBe(false);
  });

  it("rejects future schemas before inspecting their snapshots", () => {
    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 4, snapshot: null }))
      .toThrow(UnsupportedWorkspaceSchemaError);
  });

  it("rejects broken live scheduling references and reports historical links as warnings", () => {
    const broken = legacySchema2Snapshot();
    broken.dependencies[0].toId = "w-missing";

    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: broken }))
      .toThrow(WorkspaceIntegrityError);

    const historical = legacySchema2Snapshot();
    (historical.baselines[0].plannedStartByItem as Record<string, string>)["w-deleted"] = "2026-07-01T00:00:00.000Z";
    const issues = validateWorkspaceIntegrity(historical);
    expect(issues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "historical-baseline-item",
      entityId: "b-1"
    }));
    expect(issues.some((issue) => issue.severity === "error")).toBe(false);

    const historicalOccurrence = legacySchema2Snapshot();
    historicalOccurrence.recurringOccurrences[0].workItemId = "w-deleted";
    const occurrenceIssues = validateWorkspaceIntegrity(historicalOccurrence);
    expect(occurrenceIssues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "historical-occurrence-work-item",
      entityId: "occ-1"
    }));
    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: historicalOccurrence })).not.toThrow();

    historicalOccurrence.recurringOccurrences[0].status = "scheduled";
    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: historicalOccurrence }))
      .toThrow(WorkspaceIntegrityError);
  });

  it("keeps approved deleted-project ChangeSets as history but rejects live orphaned changes", () => {
    const historyChangeSet = {
      id: "cs-history",
      projectId: "p-deleted",
      title: "Deleted project",
      reason: "Keep the audit event",
      status: "approved" as "approved" | "draft",
      diffs: [],
      createdAt: "2026-07-22T00:00:00.000Z"
    };
    const source = { ...legacySchema2Snapshot(), changeSets: [historyChangeSet] };

    const historical = migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: source });
    expect(historical.report.integrityIssues).toContainEqual(expect.objectContaining({
      severity: "warning",
      code: "historical-change-set-project",
      entityId: "cs-history"
    }));

    historyChangeSet.status = "draft";
    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: source }))
      .toThrow(WorkspaceIntegrityError);
  });

  it("accepts baseline audit gates that target their approval ChangeSet", () => {
    const source = legacySchema2Snapshot();
    const withBaselineApprovalGate = {
      ...source,
      changeSets: [{
        id: "cs-baseline-approval",
        projectId: "p-main",
        title: "Approve baseline",
        reason: "Operator review",
        status: "queued-audit",
        diffs: [],
        createdAt: "2026-07-22T00:00:00.000Z"
      }],
      auditGates: [{
        id: "gate-baseline-approval",
        projectId: "p-main",
        targetType: "baseline",
        targetId: "cs-baseline-approval",
        severity: "hard",
        reason: "Approve baseline ChangeSet",
        requiredAction: "Review",
        status: "queued"
      }]
    };

    const issues = validateWorkspaceIntegrity(withBaselineApprovalGate);
    expect(issues.some((issue) => issue.severity === "error")).toBe(false);
    expect(() => migrateWorkspaceToSchema3({ schemaVersion: 2, snapshot: withBaselineApprovalGate }))
      .not.toThrow();
  });

  it("down-migrates every Todo to deterministic rollback tasks without changing existing IDs or references", () => {
    const source = schema3EnvelopeWithTodos();
    const first = downgradeWorkspaceToSchema2(source);
    const second = downgradeWorkspaceToSchema2(source);

    expect(first.envelope).toEqual(second.envelope);
    expect(first.envelope.schemaVersion).toBe(2);
    expect("schemaVersion" in first.snapshot).toBe(false);
    expect("todos" in first.snapshot).toBe(false);
    expect("conversionHistory" in first.snapshot).toBe(false);
    expect(first.snapshot.timeZone).toBe("Asia/Tokyo");
    expect(first.snapshot.dependencies[0]).toMatchObject({
      id: "d-1",
      fromId: "w-phase",
      toId: "w-task"
    });
    expect(first.snapshot.recurringOccurrences[0]).toMatchObject({
      id: "occ-1",
      workItemId: "w-task",
      projectId: "p-main"
    });

    const rollback = first.report.todoRollback;
    expect(rollback).toMatchObject({
      projectId: "p-schema3-todo-rollback",
      openTodoIds: ["w-task"]
    });
    expect(rollback?.mappings).toEqual([
      { todoId: "w-task", workItemId: "w-todo-rollback-w-task", status: "open" },
      { todoId: "todo-complete", workItemId: "todo-complete", status: "completed" }
    ]);
    const openTask = first.snapshot.workItems.find((item) => item.id === "w-todo-rollback-w-task");
    const completedTask = first.snapshot.workItems.find((item) => item.id === "todo-complete");
    expect(openTask).toMatchObject({
      projectId: "p-schema3-todo-rollback",
      title: "Open colliding Todo",
      description: "Keep this open note",
      percentComplete: 0,
      durationSeconds: 1800,
      sourceTodoId: "w-task",
      tags: ["inbox", "urgent"],
      checklist: [{ id: "check-1", title: "First step", completed: false }]
    });
    expect(completedTask).toMatchObject({ percentComplete: 100, description: "Keep completed note" });
    expect(first.snapshot.projects.find((project) => project.id === rollback?.projectId)).toMatchObject({
      name: "Recovered Todos (schema 3 rollback)",
      status: "active"
    });
    expect(first.snapshot.projects.every((project) => !("planningMethod" in project) && !("stage" in project))).toBe(true);
    expect(first.report.omitted).toEqual({ conversionHistoryEntries: 1, projectPlanningFields: 4 });
    expect(first.report.warnings.join(" ")).toContain("conversion-history");
  });

  it("can reject a schema 2 projection instead of mapping Todos", () => {
    const source = schema3EnvelopeWithTodos();
    expect(() => downgradeWorkspaceToSchema2(source, { todoPolicy: "reject" }))
      .toThrow(TodoDowngradeBlockedError);
    try {
      downgradeWorkspaceToSchema2(source, { todoPolicy: "reject" });
    } catch (error) {
      expect((error as TodoDowngradeBlockedError).todoIds).toEqual(["w-task", "todo-complete"]);
    }
  });
});
