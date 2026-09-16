import { sampleWorkspace } from "./sampleData";
import type { WorkspaceSnapshot } from "./types";

/**
 * Deterministic, non-personal regression data spanning every persistence-sensitive
 * collection used by the task-first migration and recovery drill.
 */
export function createTaskFirstRegressionFixture(): WorkspaceSnapshot {
  const snapshot = structuredClone(sampleWorkspace);
  const recurringWorkItem = {
    id: "w-fixture-weekly-review",
    projectId: "p-omni",
    kind: "task" as const,
    title: "Review the weekly plan",
    description: "Fixture recurrence; contains no personal data.",
    outline: "9",
    durationSeconds: 1800,
    estimate: { mostLikelySeconds: 1800 },
    assignmentIds: [{ resourceId: "r-chen", attention: "medium" as const, effortSeconds: 1800 }],
    percentComplete: 0,
    captureSource: "web" as const,
    capturedAt: "2026-09-14T00:00:00.000Z",
    repeatRule: {
      id: "repeat-w-fixture-weekly-review",
      cadence: "weekly" as const,
      count: 4,
      executionMode: "automatic" as const,
      endMode: "count" as const,
      startMode: "fixed-time" as const,
      startAt: "2026-09-16T00:00:00.000Z",
      reminderLeadSeconds: 900,
      automaticDurationSeconds: 1800
    }
  };

  return {
    ...snapshot,
    todos: [{
      id: "todo-fixture-capture",
      title: "Fixture inbox capture",
      note: "Round-trip this note and checklist.",
      tags: ["fixture"],
      flagged: true,
      estimatedSeconds: 1200,
      checklist: [{ id: "check-fixture", title: "Verify recovery", completed: false }],
      plannedForDate: "2026-09-16",
      plannedStart: "2026-09-16T01:00:00.000Z",
      plannedFinish: "2026-09-16T01:20:00.000Z",
      captureSource: "shortcut",
      captureKey: "fixture-idempotency-key",
      status: "open",
      capturedAt: "2026-09-15T23:00:00.000Z",
      updatedAt: "2026-09-15T23:00:00.000Z",
      inbox: false
    }],
    conversionHistory: [{
      id: "conversion-fixture",
      type: "todo_to_task",
      itemId: "w-domain",
      projectId: "p-omni",
      occurredAt: "2026-09-15T00:00:00.000Z",
      discardedFields: []
    }],
    workItems: [...snapshot.workItems, recurringWorkItem],
    recurringOccurrences: [{
      id: "occ-fixture-1",
      ruleId: "repeat-w-fixture-weekly-review",
      workItemId: recurringWorkItem.id,
      projectId: recurringWorkItem.projectId,
      occurrenceIndex: 1,
      scheduledStart: "2026-09-16T00:00:00.000Z",
      scheduledFinish: "2026-09-16T00:30:00.000Z",
      start: "2026-09-16T00:00:00.000Z",
      finish: "2026-09-16T00:30:00.000Z",
      status: "scheduled",
      title: recurringWorkItem.title,
      description: recurringWorkItem.description,
      createdAt: "2026-09-15T00:00:00.000Z",
      updatedAt: "2026-09-15T00:00:00.000Z"
    }],
    capacities: [{
      date: "2026-09-16",
      deepSeconds: 10_800,
      mediumSeconds: 7_200,
      shallowSeconds: 3_600,
      unavailableBlocks: [{ start: "2026-09-16T03:00:00.000Z", finish: "2026-09-16T04:00:00.000Z" }]
    }],
    auditGates: [{
      id: "gate-fixture",
      projectId: "p-omni",
      targetType: "delivery",
      targetId: "w-domain",
      severity: "warning",
      reason: "Fixture recovery signal",
      requiredAction: "Verify the restored evidence and dependency links.",
      status: "open"
    }]
  };
}
