import { describe, expect, it } from "vitest";
import { captureTask, resolveTaskRef, selectDayPlan, taskRef, taskViewById, undoCapturedTask } from "./tasks";
import type { ScheduleResult, WorkItem, WorkspaceSnapshot } from "./types";
import { createEmptyWorkspace } from "./workspace";

const now = "2026-09-16T03:00:00.000Z";

describe("task-first capture", () => {
  it("captures a title immediately and leaves optional structure empty", () => {
    const result = captureTask(createEmptyWorkspace(), { title: "  买洗衣液  ", now });

    expect(result.receipt.status).toBe("captured");
    expect(result.task).toMatchObject({ title: "买洗衣液", status: "open", inbox: true, captureSource: "web" });
    expect(result.workspace.todos).toHaveLength(1);
    expect(result.task.plannedForDate).toBeUndefined();
    expect(result.task.estimatedSeconds).toBeUndefined();
  });

  it("deduplicates an external retry by idempotency key", () => {
    const first = captureTask(createEmptyWorkspace(), {
      title: "给税理士确认资料",
      source: "shortcut",
      idempotencyKey: "shortcut-42",
      now
    });
    const retry = captureTask(first.workspace, {
      title: "给税理士确认资料",
      source: "shortcut",
      idempotencyKey: "shortcut-42",
      now: "2026-09-16T03:00:10.000Z"
    });

    expect(retry.receipt.status).toBe("duplicate");
    expect(retry.receipt.taskId).toBe(first.task.id);
    expect(retry.workspace).toBe(first.workspace);
  });

  it("undoes a captured standalone task without touching project work", () => {
    const captured = captureTask(createEmptyWorkspace(), { title: "临时想法", now });
    const undone = undoCapturedTask(captured.workspace, captured.task.id);
    expect(undone.todos).toEqual([]);
  });

  it("uses the entity id as a stable reference", () => {
    const captured = captureTask(createEmptyWorkspace(), { title: "稳定链接", now });
    const ref = taskRef(captured.task);
    expect(ref).toEqual({ taskId: captured.task.id });
    expect(resolveTaskRef(captured.workspace, [], ref)?.title).toBe("稳定链接");
  });
});

describe("day plan", () => {
  it("merges standalone and project tasks, calculates capacity, and exposes only direct dependencies", () => {
    const workspace: WorkspaceSnapshot = {
      ...createEmptyWorkspace(),
      timeZone: "Asia/Tokyo",
      todos: [{
        id: "todo-tax",
        title: "给税理士确认资料",
        tags: [],
        flagged: false,
        checklist: [],
        estimatedSeconds: 1200,
        plannedForDate: "2026-09-16",
        plannedStart: "2026-09-16T07:00:00.000Z",
        plannedFinish: "2026-09-16T07:20:00.000Z",
        status: "open",
        capturedAt: now,
        updatedAt: now,
        inbox: false
      }],
      projects: [{
        id: "project-v3",
        name: "OmniPlan V3",
        status: "active",
        mode: "build",
        priority: 1,
        northStar: "轻松规划",
        currentOutcome: "技术方案",
        horizon: "2026-09-30T00:00:00.000Z",
        start: "2026-09-01T00:00:00.000Z",
        reviewCadenceDays: 7
      }],
      workItems: [
        workItem("architecture", "梳理核心架构", 100),
        workItem("writing", "撰写 V3 技术方案", 0),
        workItem("visual", "确认视觉原型", 0)
      ],
      dependencies: [
        { id: "dep-before", projectId: "project-v3", fromId: "architecture", toId: "writing", type: "FS", lagSeconds: 0 },
        { id: "dep-after", projectId: "project-v3", fromId: "writing", toId: "visual", type: "FS", lagSeconds: 0 }
      ],
      capacities: [{ date: "2026-09-16", deepSeconds: 7200, mediumSeconds: 7200, shallowSeconds: 7200, unavailableBlocks: [] }]
    };
    const schedules: ScheduleResult[] = [{
      projectId: "project-v3",
      items: [
        scheduled(workspace.workItems[0], "2026-09-16T03:00:00.000Z", "2026-09-16T03:45:00.000Z"),
        scheduled(workspace.workItems[1], "2026-09-16T04:00:00.000Z", "2026-09-16T05:30:00.000Z"),
        scheduled(workspace.workItems[2], "2026-09-16T06:00:00.000Z", "2026-09-16T07:00:00.000Z")
      ],
      diagnostics: [],
      unsupported: []
    }];

    const plan = selectDayPlan(workspace, schedules, "2026-09-16");
    const writing = taskViewById(workspace, schedules, "writing")!;

    expect(plan.tasks.map((task) => task.title)).toEqual([
      "梳理核心架构",
      "撰写 V3 技术方案",
      "确认视觉原型",
      "给税理士确认资料"
    ]);
    expect(plan.capacitySeconds).toBe(21600);
    expect(plan.plannedEffortSeconds).toBe(10200);
    expect(writing.predecessors.map((task) => task.title)).toEqual(["梳理核心架构"]);
    expect(writing.successors.map((task) => task.title)).toEqual(["确认视觉原型"]);
    expect(writing.blocked).toBe(false);
  });

  it("uses half-open time ranges so midnight finishes do not leak into the next day", () => {
    const exactTodo = {
      id: "todo-exact-midnight",
      title: "午夜前结束",
      tags: [],
      flagged: false,
      checklist: [],
      plannedStart: "2026-09-16T14:30:00.000Z",
      plannedFinish: "2026-09-16T15:00:00.000Z",
      status: "open" as const,
      capturedAt: now,
      updatedAt: now,
      inbox: false
    };
    const crossingTodo = {
      ...exactTodo,
      id: "todo-crossing-midnight",
      title: "跨过午夜",
      plannedFinish: "2026-09-16T15:30:00.000Z"
    };
    const exactWorkItem = workItem("work-exact-midnight", "项目任务午夜前结束", 0);
    const crossingWorkItem = workItem("work-crossing-midnight", "项目任务跨过午夜", 0);
    const workspace: WorkspaceSnapshot = {
      ...createEmptyWorkspace(),
      timeZone: "Asia/Tokyo",
      todos: [exactTodo, crossingTodo],
      projects: [{
        id: "project-v3",
        name: "跨日项目",
        status: "active",
        mode: "build",
        priority: 1,
        northStar: "边界正确",
        currentOutcome: "跨日计划",
        horizon: "2026-09-30T00:00:00.000Z",
        start: "2026-09-01T00:00:00.000Z",
        reviewCadenceDays: 7
      }],
      workItems: [exactWorkItem, crossingWorkItem]
    };
    const schedules: ScheduleResult[] = [{
      projectId: "project-v3",
      items: [
        scheduled(exactWorkItem, "2026-09-16T14:30:00.000Z", "2026-09-16T15:00:00.000Z"),
        scheduled(crossingWorkItem, "2026-09-16T14:30:00.000Z", "2026-09-16T15:30:00.000Z")
      ],
      diagnostics: [],
      unsupported: []
    }];

    expect(selectDayPlan(workspace, schedules, "2026-09-16").tasks.map((task) => task.id).sort()).toEqual([
      "todo-crossing-midnight",
      "todo-exact-midnight",
      "work-crossing-midnight",
      "work-exact-midnight"
    ]);
    expect(selectDayPlan(workspace, schedules, "2026-09-17").tasks.map((task) => task.id).sort()).toEqual([
      "todo-crossing-midnight",
      "work-crossing-midnight"
    ]);
  });

  it("surfaces relevant scheduler warnings and broken direct dependencies without flooding the day", () => {
    const visible = workItem("visible", "需要留意的任务", 0);
    const hidden = workItem("hidden", "另一天的任务", 0);
    const workspace: WorkspaceSnapshot = {
      ...createEmptyWorkspace(),
      timeZone: "Asia/Tokyo",
      projects: [{
        id: "project-v3",
        name: "有诊断的项目",
        status: "active",
        mode: "build",
        priority: 1,
        northStar: "安全排程",
        currentOutcome: "处理提醒",
        horizon: "2026-09-30T00:00:00.000Z",
        start: "2026-09-01T00:00:00.000Z",
        reviewCadenceDays: 7
      }],
      workItems: [visible, hidden],
      dependencies: [{ id: "dangling", projectId: "project-v3", fromId: "deleted", toId: "visible", type: "FS", lagSeconds: 0 }]
    };
    const schedules: ScheduleResult[] = [{
      projectId: "project-v3",
      items: [
        { ...scheduled(visible, "2026-09-16T03:00:00.000Z", "2026-09-16T04:00:00.000Z"), warnings: ["Resource unavailable"] },
        scheduled(hidden, "2026-09-17T03:00:00.000Z", "2026-09-17T04:00:00.000Z")
      ],
      diagnostics: [
        { severity: "error", message: "Unsafe fixed start", itemId: "visible" },
        { severity: "warning", message: "Do not show this today", itemId: "hidden" }
      ],
      unsupported: []
    }];

    const issues = selectDayPlan(workspace, schedules, "2026-09-16").issues;
    expect(issues.map((issue) => issue.message)).toEqual([
      "Unsafe fixed start",
      "Resource unavailable",
      "任务依赖指向了已删除的事项，请在项目计划中修复。"
    ]);
    expect(issues.every((issue) => issue.taskId === "visible")).toBe(true);
  });
});

function workItem(id: string, title: string, percentComplete: number) {
  return {
    id,
    projectId: "project-v3",
    kind: "task" as const,
    title,
    outline: id,
    durationSeconds: id === "writing" ? 5400 : id === "visual" ? 3600 : 2700,
    estimate: { mostLikelySeconds: id === "writing" ? 5400 : id === "visual" ? 3600 : 2700 },
    assignmentIds: [],
    percentComplete
  };
}

function scheduled(item: WorkItem, start: string, finish: string) {
  return {
    workItem: item,
    start,
    finish,
    earlyStart: start,
    earlyFinish: finish,
    lateStart: start,
    lateFinish: finish,
    totalFloatSeconds: 0,
    freeFloatSeconds: 0,
    isCritical: false,
    warnings: []
  };
}
