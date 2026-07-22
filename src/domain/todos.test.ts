import { describe, expect, it } from "vitest";
import {
  completeTodo,
  convertTaskToTodo,
  convertTodoToProject,
  convertTodoToTask,
  createTodo,
  keepTodo,
  projectIdForTodo,
  reopenTodo,
  selectTodayTodos,
  shapeUpScopeIdForTodo,
  taskToTodoImpact,
  updateTodo
} from "./todos";
import {
  normalizeProjectLifecycle,
  normalizeWorkspaceSnapshot,
  withProjectPlanningMethod
} from "./projectLifecycle";
import { createEmptyWorkspace } from "./workspace";
import type { Project, Todo, WorkItem, WorkspaceSnapshot } from "./types";

const now = "2026-07-22T09:00:00.000Z";

describe("Todo capture and Inbox", () => {
  it("keeps a title/note/estimate-only capture in Inbox", () => {
    const captured = createTodo({ id: "todo-1", title: "  Capture this  " }, now);
    const edited = updateTodo(captured, {
      title: "Capture this clearly",
      note: "Still untriaged",
      estimatedSeconds: 900
    }, "2026-07-22T09:01:00.000Z");

    expect(captured).toMatchObject({ title: "Capture this", status: "open", inbox: true });
    expect(edited).toMatchObject({ inbox: true, note: "Still untriaged", estimatedSeconds: 900 });
  });

  it("leaves Inbox after setting a date, tag, flag, or repeat rule", () => {
    const patches = [
      { tags: ["home"] },
      { flagged: true },
      { dueAt: "2026-07-23T00:00:00.000Z" },
      { repeatRule: { count: 2, startAt: "2026-07-23T00:00:00.000Z" } }
    ];
    for (const patch of patches) {
      expect(updateTodo(createTodo({ id: "todo-1", title: "Captured" }, now), patch, now).inbox).toBe(false);
    }
  });

  it("leaves Inbox when explicitly kept or completed and does not re-enter when reopened", () => {
    const captured = createTodo({ id: "todo-1", title: "Captured" }, now);
    expect(keepTodo(captured, now).inbox).toBe(false);
    const completed = completeTodo(captured, now);
    expect(completed).toMatchObject({ status: "completed", completedAt: now, inbox: false });
    expect(reopenTodo(completed, now)).toMatchObject({ status: "open", inbox: false });
  });
});

describe("Today Todo selector", () => {
  it("selects date-driven open Todos and orders overdue due, today due, then manual/start", () => {
    const todos = [
      todo("flag-only", { flagged: true }),
      todo("planned-past", { plannedForDate: "2026-07-21" }),
      todo("repeat-today", { repeatRule: { count: 2, startAt: "2026-07-22T09:00:00.000Z" } }),
      todo("deferred", { deferUntil: "2026-07-21T23:00:00.000Z", dueAt: "2026-07-30T00:00:00.000Z" }),
      todo("planned", { plannedForDate: "2026-07-22" }),
      todo("due-today", { dueAt: "2026-07-22T12:00:00.000Z" }),
      todo("overdue", { dueAt: "2026-07-20T12:00:00.000Z" }),
      todo("completed", { dueAt: "2026-07-20T12:00:00.000Z", status: "completed" })
    ];

    expect(selectTodayTodos(todos, "2026-07-22", "UTC").map(({ id }) => id)).toEqual([
      "overdue",
      "due-today",
      "deferred",
      "planned",
      "repeat-today"
    ]);
  });

  it("uses the workspace time zone when converting instants to a Today date", () => {
    const tokyoDue = todo("tokyo", { dueAt: "2026-07-21T15:30:00.000Z" });
    expect(selectTodayTodos([tokyoDue], "2026-07-22", "Asia/Tokyo")).toHaveLength(1);
  });

  it("keeps the next uncompleted repeat occurrence visible after it becomes overdue", () => {
    const recurring = [
      todo("weekly", {
        repeatRule: { cadence: "weekly", count: 3, endMode: "count", startAt: "2026-07-08T09:00:00.000Z" }
      }),
      todo("monthly", {
        repeatRule: { cadence: "monthly", count: 3, endMode: "count", startAt: "2026-05-22T09:00:00.000Z" }
      }),
      todo("month-end", {
        repeatRule: { cadence: "monthly", count: 3, endMode: "count", startAt: "2026-05-31T09:00:00.000Z" }
      }),
      todo("ended", {
        repeatRule: { cadence: "weekly", count: 2, endMode: "count", startAt: "2026-07-01T09:00:00.000Z" }
      }),
      todo("stopped", {
        repeatRule: {
          cadence: "weekly",
          count: 10,
          endMode: "never",
          startAt: "2026-07-01T09:00:00.000Z",
          stoppedAt: "2026-07-20T00:00:00.000Z"
        }
      })
    ];

    expect(selectTodayTodos(recurring, "2026-07-22", "UTC").map(({ id }) => id)).toEqual([
      "monthly",
      "month-end",
      "ended",
      "stopped",
      "weekly"
    ]);
    expect(selectTodayTodos(recurring, "2026-06-30", "UTC").map(({ id }) => id)).toEqual(["monthly", "month-end"]);
  });

  it("advances one master Todo to the latest fixed occurrence without duplicating Today", () => {
    const weekly = todo("weekly", {
      dueAt: "2026-07-01T12:00:00.000Z",
      deferUntil: "2026-07-01T08:00:00.000Z",
      plannedForDate: "2026-07-01",
      repeatRule: {
        cadence: "weekly",
        count: 6,
        endMode: "count",
        startAt: "2026-07-01T09:00:00.000Z"
      }
    });

    expect(selectTodayTodos([weekly], "2026-07-01", "UTC").map(({ id }) => id)).toEqual(["weekly"]);
    const advanced = completeTodo(weekly, "2026-07-22T12:00:00.000Z", "UTC");

    expect(advanced).toMatchObject({ status: "open", repeatCompletedCount: 4 });
    expect(advanced.completedAt).toBeUndefined();
    expect(selectTodayTodos([advanced], "2026-07-22", "UTC")).toEqual([]);
    expect(selectTodayTodos([advanced], "2026-07-29", "UTC").map(({ id }) => id)).toEqual(["weekly"]);
  });

  it("finishes count, until, and stopped series only after their final available occurrence", () => {
    const countRule = todo("count", {
      repeatRule: { cadence: "weekly", count: 2, endMode: "count", startAt: "2026-07-01T09:00:00.000Z" }
    });
    const untilRule = todo("until", {
      repeatRule: {
        cadence: "weekly",
        count: 99,
        endMode: "until",
        until: "2026-07-10T23:59:00.000Z",
        startAt: "2026-07-01T09:00:00.000Z"
      }
    });
    const stoppedRule = todo("stopped", {
      repeatRule: {
        cadence: "weekly",
        count: 99,
        endMode: "never",
        stoppedAt: "2026-07-20T00:00:00.000Z",
        startAt: "2026-07-01T09:00:00.000Z"
      }
    });

    const completedCount = completeTodo(countRule, "2026-07-08T12:00:00.000Z", "UTC");
    const completedUntil = completeTodo(untilRule, "2026-07-08T12:00:00.000Z", "UTC");
    const completedStopped = completeTodo(stoppedRule, "2026-07-18T12:00:00.000Z", "UTC");

    expect(completedCount).toMatchObject({ status: "completed", repeatCompletedCount: 2 });
    expect(completedUntil).toMatchObject({ status: "completed", repeatCompletedCount: 2 });
    expect(completedStopped).toMatchObject({ status: "completed", repeatCompletedCount: 3 });
    expect(reopenTodo(completedCount, "2026-07-22T00:00:00.000Z")).toMatchObject({
      status: "open",
      repeatCompletedCount: 1
    });
  });

  it("preserves the original month-end anchor across timezone-aware completions", () => {
    const monthly = todo("monthly", {
      repeatRule: {
        cadence: "monthly",
        count: 3,
        endMode: "count",
        startAt: "2026-01-30T15:30:00.000Z"
      }
    });

    const afterJanuary = completeTodo(monthly, "2026-01-31T03:00:00.000Z", "Asia/Tokyo");
    expect(selectTodayTodos([afterJanuary], "2026-02-28", "Asia/Tokyo")).toHaveLength(1);
    const afterFebruary = completeTodo(afterJanuary, "2026-02-28T03:00:00.000Z", "Asia/Tokyo");
    expect(selectTodayTodos([afterFebruary], "2026-03-30", "Asia/Tokyo")).toHaveLength(0);
    expect(selectTodayTodos([afterFebruary], "2026-03-31", "Asia/Tokyo")).toHaveLength(1);
  });
});

describe("Todo and Task conversion", () => {
  it("turns a Todo into a same-id OmniPlan task while preserving common fields", () => {
    const snapshot = workspaceWithProject(omniPlanProject());
    snapshot.workItems.push(task("existing", snapshot.projects[0].id, { outline: "2" }));
    snapshot.todos.push(todo("todo-task", {
      title: "Plan release",
      note: "Preserve this note",
      tags: ["launch"],
      flagged: true,
      estimatedSeconds: 1800,
      deferUntil: "2026-07-23T00:00:00.000Z",
      dueAt: "2026-07-24T00:00:00.000Z",
      plannedForDate: "2026-07-23",
      checklist: [{ id: "check-1", title: "Draft", completed: false }]
    }));

    const result = convertTodoToTask(snapshot, {
      todoId: "todo-task",
      projectId: snapshot.projects[0].id,
      now
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.task).toMatchObject({
      id: "todo-task",
      projectId: snapshot.projects[0].id,
      kind: "task",
      description: "Preserve this note",
      tags: ["launch"],
      flagged: true,
      outline: "3",
      durationSeconds: 1800,
      constraint: {
        noEarlierThan: "2026-07-23T00:00:00.000Z",
        noLaterThan: "2026-07-24T00:00:00.000Z"
      }
    });
    expect(result.workspace.todos).toEqual([]);
    expect(result.workspace.conversionHistory[0]).toMatchObject({
      type: "todo_to_task",
      itemId: "todo-task"
    });
  });

  it("accepts proposed or confirmed scopes before a Bet, but locks the task", () => {
    const project = shapeUpProject(false);
    const snapshot = workspaceWithProject(project);
    snapshot.todos.push(todo("todo-shape"));

    const result = convertTodoToTask(snapshot, {
      todoId: "todo-shape",
      projectId: project.id,
      shapeUpScopeId: "scope-proposed",
      now
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task).toMatchObject({
        shapeUpScopeId: "scope-proposed",
        shapeUpLocked: true
      });
    }
  });

  it("requires a confirmed scope after the Bet", () => {
    const project = shapeUpProject(true);
    const proposed = workspaceWithProject(project);
    proposed.todos.push(todo("todo-proposed"));
    const rejected = convertTodoToTask(proposed, {
      todoId: "todo-proposed",
      projectId: project.id,
      shapeUpScopeId: "scope-proposed",
      now
    });
    expect(rejected).toMatchObject({ ok: false, code: "shape_up_scope_unconfirmed" });

    const confirmed = workspaceWithProject(project);
    confirmed.todos.push(todo("todo-confirmed"));
    const accepted = convertTodoToTask(confirmed, {
      todoId: "todo-confirmed",
      projectId: project.id,
      shapeUpScopeId: "scope-confirmed",
      now
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.task.shapeUpLocked).toBe(false);
  });

  it("rejects a repeating Todo before direct Shape Up conversion", () => {
    const project = shapeUpProject(false);
    const snapshot = workspaceWithProject(project);
    snapshot.todos.push(todo("todo-repeat", { repeatRule: { count: 2 } }));

    expect(convertTodoToTask(snapshot, {
      todoId: "todo-repeat",
      projectId: project.id,
      shapeUpScopeId: "scope-confirmed",
      now
    })).toMatchObject({ ok: false, code: "shape_up_repeat_not_supported" });
  });

  it("turns a simple task into a same-id Todo without confirmation", () => {
    const snapshot = workspaceWithProject(omniPlanProject());
    snapshot.workItems.push(task("task-simple", snapshot.projects[0].id, {
      title: "Write notes",
      description: "Keep the public details",
      tags: ["writing"],
      flagged: true,
      estimate: { mostLikelySeconds: 1200 },
      durationSeconds: 1200,
      checklist: [{ id: "check-1", title: "Proofread", completed: true }]
    }));

    const result = convertTaskToTodo(snapshot, { taskId: "task-simple", now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.todo).toMatchObject({
      id: "task-simple",
      title: "Write notes",
      note: "Keep the public details",
      tags: ["writing"],
      flagged: true,
      estimatedSeconds: 1200,
      inbox: false
    });
    expect(result.workspace.workItems).toEqual([]);
    expect(result.workspace.conversionHistory[0].type).toBe("task_to_todo");
  });

  it("requires confirmation before discarding partial progress or an estimate range", () => {
    const snapshot = workspaceWithProject(omniPlanProject());
    snapshot.workItems.push(task("task-estimated", snapshot.projects[0].id, {
      durationSeconds: 7200,
      estimate: {
        optimisticSeconds: 3600,
        mostLikelySeconds: 7200,
        pessimisticSeconds: 14_400
      },
      percentComplete: 60
    }));

    const impact = taskToTodoImpact(snapshot, "task-estimated");
    expect(impact).toEqual({
      requiresConfirmation: true,
      discardedFields: ["estimate_range", "progress"]
    });
    expect(convertTaskToTodo(snapshot, { taskId: "task-estimated", now })).toMatchObject({
      ok: false,
      code: "impact_confirmation_required",
      impact
    });
  });

  it("clears inbound hammock anchors when their task becomes a Todo", () => {
    const snapshot = workspaceWithProject(omniPlanProject());
    snapshot.workItems.push(
      task("anchor", snapshot.projects[0].id),
      task("finish", snapshot.projects[0].id),
      {
        ...task("hammock", snapshot.projects[0].id),
        kind: "hammock",
        hammockStartId: "anchor",
        hammockFinishId: "finish"
      }
    );

    expect(taskToTodoImpact(snapshot, "anchor")).toEqual({
      requiresConfirmation: true,
      discardedFields: ["schedule"]
    });
    const result = convertTaskToTodo(snapshot, { taskId: "anchor", confirmedImpact: true, now });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.workItems.find(({ id }) => id === "hammock")).toMatchObject({
      id: "hammock",
      hammockFinishId: "finish"
    });
    expect(result.workspace.workItems.find(({ id }) => id === "hammock")?.hammockStartId).toBeUndefined();
  });

  it("requires impact confirmation and then permanently clears project-only relationships", () => {
    const snapshot = impactedTaskWorkspace();
    const impact = taskToTodoImpact(snapshot, "task-impact");
    expect(impact.requiresConfirmation).toBe(true);
    expect(impact.discardedFields).toEqual(expect.arrayContaining([
      "parent",
      "children",
      "dependencies",
      "assignments",
      "baselines",
      "evidence",
      "actuals",
      "shape_up_scope",
      "recurring_occurrences"
    ]));

    expect(convertTaskToTodo(snapshot, { taskId: "task-impact", now })).toMatchObject({
      ok: false,
      code: "impact_confirmation_required",
      impact
    });
    const result = convertTaskToTodo(snapshot, {
      taskId: "task-impact",
      confirmedImpact: true,
      now
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.workspace.workItems.map(({ id }) => id)).toEqual(["child"]);
    expect(result.workspace.workItems[0].parentId).toBeUndefined();
    expect(result.workspace.dependencies).toEqual([]);
    expect(result.workspace.evidence).toEqual([]);
    expect(result.workspace.actuals).toEqual([]);
    expect(result.workspace.baselines[0].plannedStartByItem).toEqual({});
    expect(result.workspace.recurringOccurrences.map(({ id }) => id)).toEqual(["occ-history"]);
    expect(result.workspace.conversionHistory[0].discardedFields).toEqual(impact.discardedFields);
  });
});

describe("Todo to Project conversion", () => {
  it("creates a stable separate OmniPlan project and a same-id first task", () => {
    const snapshot = createEmptyWorkspace();
    snapshot.todos.push(todo("todo-project", { note: "Project problem" }));
    const result = convertTodoToProject(snapshot, {
      todoId: "todo-project",
      planningMethod: "omniplan",
      now
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project).toMatchObject({
      id: projectIdForTodo("todo-project"),
      planningMethod: "omniplan",
      stage: "plan"
    });
    expect(result.project.id).not.toBe(result.task.id);
    expect(result.task).toMatchObject({ id: "todo-project", projectId: result.project.id, outline: "1" });
  });

  it("prefills a Shape Up problem and first scope and locks the first task", () => {
    const snapshot = createEmptyWorkspace();
    snapshot.todos.push(todo("todo-project", { title: "Shape this", note: "Unclear workflow" }));
    const result = convertTodoToProject(snapshot, {
      todoId: "todo-project",
      planningMethod: "shape-up",
      now
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.project).toMatchObject({
      planningMethod: "shape-up",
      stage: "shape",
      shapeUpPitch: {
        problem: "Unclear workflow",
        scopes: [{ id: shapeUpScopeIdForTodo("todo-project"), title: "Shape this", confirmed: false }]
      }
    });
    expect(result.task).toMatchObject({
      id: "todo-project",
      shapeUpScopeId: shapeUpScopeIdForTodo("todo-project"),
      shapeUpLocked: true
    });
  });

  it("rejects direct conversion of a repeating Todo to a Shape Up project", () => {
    const snapshot = createEmptyWorkspace();
    snapshot.todos.push(todo("todo-repeat", { repeatRule: { count: 2 } }));
    expect(convertTodoToProject(snapshot, {
      todoId: "todo-repeat",
      planningMethod: "shape-up",
      now
    })).toMatchObject({ ok: false, code: "shape_up_repeat_not_supported" });
  });
});

describe("schema-3 project normalization", () => {
  it("migrates existing Shape Up projects and defaults other projects to OmniPlan", () => {
    expect(normalizeProjectLifecycle(shapeUpProject(false))).toMatchObject({
      planningMethod: "shape-up",
      stage: "shape"
    });
    expect(normalizeProjectLifecycle({ ...omniPlanProject(), planningMethod: undefined, stage: undefined })).toMatchObject({
      planningMethod: "omniplan",
      stage: "plan"
    });
  });

  it("does not allow an established planning method to switch", () => {
    const project = normalizeProjectLifecycle(omniPlanProject());
    expect(withProjectPlanningMethod(project, "omniplan")).toMatchObject({ planningMethod: "omniplan" });
    expect(withProjectPlanningMethod(project, "shape-up")).toBeUndefined();
  });

  it("normalizes legacy workspace collections into schema 3", () => {
    const legacy = {
      ...createEmptyWorkspace(),
      schemaVersion: undefined,
      todos: undefined,
      conversionHistory: undefined
    } as unknown as WorkspaceSnapshot;
    expect(normalizeWorkspaceSnapshot(legacy)).toMatchObject({
      schemaVersion: 3,
      todos: [],
      conversionHistory: []
    });
  });
});

function todo(id: string, patch: Partial<Todo> = {}): Todo {
  return createTodo({ id, title: id, ...patch }, patch.capturedAt ?? now);
}

function omniPlanProject(): Project {
  return {
    id: "project-omni",
    name: "OmniPlan project",
    status: "active",
    mode: "build",
    priority: 3,
    northStar: "Plan reliably",
    currentOutcome: "Finish the plan",
    horizon: "2026-08-01T00:00:00.000Z",
    start: "2026-07-20T00:00:00.000Z",
    planningMethod: "omniplan",
    stage: "plan",
    reviewCadenceDays: 7
  };
}

function shapeUpProject(withBet: boolean): Project {
  return {
    ...omniPlanProject(),
    id: "project-shape",
    planningMethod: "shape-up",
    stage: withBet ? "build" : "shape",
    shapeUpPitch: {
      problem: "Shape work before building",
      appetiteKind: "small-batch",
      appetiteDays: 14,
      solutionSketch: "",
      rabbitHoles: "",
      noGos: "",
      successBaseline: "",
      scopes: [
        { id: "scope-proposed", title: "Proposed", description: "", confirmed: false, hillPosition: 0 },
        { id: "scope-confirmed", title: "Confirmed", description: "", confirmed: true, hillPosition: 0 }
      ],
      ...(withBet ? {
        bet: {
          approvedAt: now,
          auditDecisionId: "decision-bet",
          cycleStart: now,
          cycleEnd: "2026-08-05T09:00:00.000Z",
          circuitBreakerAt: "2026-08-05T09:00:00.000Z",
          summary: "Bet"
        }
      } : {}),
      createdAt: now,
      updatedAt: now
    }
  };
}

function workspaceWithProject(project: Project): WorkspaceSnapshot {
  return { ...createEmptyWorkspace(), projects: [project] };
}

function task(id: string, projectId: string, patch: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    projectId,
    kind: "task",
    title: id,
    outline: "1",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    assignmentIds: [],
    percentComplete: 0,
    ...patch
  };
}

function impactedTaskWorkspace(): WorkspaceSnapshot {
  const project = shapeUpProject(false);
  const snapshot = workspaceWithProject(project);
  snapshot.workItems = [
    task("task-impact", project.id, {
      parentId: "missing-parent",
      shapeUpScopeId: "scope-confirmed",
      shapeUpLocked: true,
      assignmentIds: [{ resourceId: "owner", attention: "deep", effortSeconds: 600 }],
      repeatRule: { count: 2 }
    }),
    task("child", project.id, { parentId: "task-impact", outline: "1.1" })
  ];
  snapshot.dependencies = [{
    id: "dependency",
    projectId: project.id,
    fromId: "task-impact",
    toId: "child",
    type: "FS",
    lagSeconds: 0
  }];
  snapshot.baselines = [{
    id: "baseline",
    projectId: project.id,
    name: "Baseline",
    capturedAt: now,
    plannedStartByItem: { "task-impact": now },
    plannedFinishByItem: { "task-impact": now },
    plannedWorkSecondsByItem: { "task-impact": 600 }
  }];
  snapshot.evidence = [{
    id: "evidence",
    kind: "note",
    summary: "Project evidence",
    projectId: project.id,
    workItemId: "task-impact",
    createdAt: now,
    confidence: 1,
    tags: []
  }];
  snapshot.actuals = [{
    workItemId: "task-impact",
    actualWorkSeconds: 300,
    remainingWorkSeconds: 300,
    actualCost: 0,
    recordedAt: now
  }];
  snapshot.recurringOccurrences = [
    occurrence("occ-future", "scheduled"),
    occurrence("occ-history", "occurred")
  ];
  return snapshot;
}

function occurrence(
  id: string,
  status: WorkspaceSnapshot["recurringOccurrences"][number]["status"]
): WorkspaceSnapshot["recurringOccurrences"][number] {
  return {
    id,
    ruleId: "repeat-task-impact",
    workItemId: "task-impact",
    projectId: "project-shape",
    occurrenceIndex: id === "occ-future" ? 2 : 1,
    scheduledStart: now,
    scheduledFinish: now,
    start: now,
    finish: now,
    status,
    title: "Recurring",
    description: "",
    createdAt: now,
    updatedAt: now,
    ...(status === "occurred" ? { settledAt: now, settlementSource: "on-time" as const } : {})
  };
}
