import { describe, expect, it } from "vitest";
import { moveWorkItemToProject } from "./workItems";
import { createEmptyWorkspace } from "./workspace";
import type { Project, WorkItem, WorkspaceSnapshot } from "./types";

const start = "2026-07-09T00:00:00.000Z";

function project(id: string, name: string): Project {
  return {
    id,
    name,
    status: "active",
    mode: "maintain",
    priority: 1,
    northStar: `${name} outcome`,
    currentOutcome: `${name} current`,
    horizon: start,
    start,
    reviewCadenceDays: 7
  };
}

function item(id: string, projectId: string, outline: string, title: string, parentId?: string): WorkItem {
  return {
    id,
    projectId,
    parentId,
    kind: id.includes("phase") ? "phase" : "task",
    title,
    outline,
    durationSeconds: 3600,
    estimate: { mostLikelySeconds: 3600 },
    assignmentIds: [],
    percentComplete: 0
  };
}

function workspace(): WorkspaceSnapshot {
  return {
    ...createEmptyWorkspace(),
    projects: [project("p-source", "Source"), project("p-target", "Target")],
    workItems: [
      item("w-phase", "p-source", "1", "Source phase"),
      {
        ...item("w-child", "p-source", "1.1", "Child task", "w-phase"),
        repeatRule: { cadence: "every-n-days", everyDays: 7, count: 6, startMode: "fixed-time", startAt: "2026-07-10T00:00:00.000Z" }
      },
      item("w-other", "p-source", "2", "Other source task"),
      item("w-target-phase", "p-target", "1", "Target phase")
    ],
    dependencies: [
      { id: "d-internal", projectId: "p-source", fromId: "w-phase", toId: "w-child", type: "FS", lagSeconds: 0 },
      { id: "d-cross", projectId: "p-source", fromId: "w-child", toId: "w-other", type: "FS", lagSeconds: 0 }
    ],
    evidence: [
      { id: "e-child", projectId: "p-source", workItemId: "w-child", kind: "note", summary: "Child done.", createdAt: start, confidence: 1, tags: [] },
      { id: "e-project", projectId: "p-source", kind: "note", summary: "Project note.", createdAt: start, confidence: 1, tags: [] }
    ],
    baselines: [{
      id: "b-source",
      projectId: "p-source",
      name: "Source baseline",
      capturedAt: start,
      plannedStartByItem: { "w-child": start, "w-other": start },
      plannedFinishByItem: { "w-child": start, "w-other": start },
      plannedWorkSecondsByItem: { "w-child": 3600, "w-other": 3600 }
    }],
    auditGates: [{
      id: "g-child",
      projectId: "p-source",
      targetType: "delivery",
      targetId: "w-child",
      severity: "warning",
      reason: "Needs review.",
      requiredAction: "Review moved task.",
      status: "open"
    }]
  };
}

describe("work item moves", () => {
  it("moves a work item subtree to another project without leaving broken local links", () => {
    const result = moveWorkItemToProject(workspace(), {
      workItemId: "w-phase",
      targetProjectId: "p-target",
      parentId: "w-target-phase"
    });

    expect(result).toBeDefined();
    expect(result?.movedIds).toEqual(["w-phase", "w-child"]);
    expect(result?.movedDependencyIds).toEqual(["d-internal"]);
    expect(result?.removedDependencyIds).toEqual(["d-cross"]);

    const movedPhase = result?.workspace.workItems.find((entry) => entry.id === "w-phase");
    const movedChild = result?.workspace.workItems.find((entry) => entry.id === "w-child");
    expect(movedPhase).toMatchObject({ projectId: "p-target", parentId: "w-target-phase", outline: "1.1" });
    expect(movedChild).toMatchObject({ projectId: "p-target", parentId: "w-phase", outline: "1.1.1" });
    expect(movedChild?.repeatRule?.everyDays).toBe(7);

    expect(result?.workspace.dependencies).toEqual([
      { id: "d-internal", projectId: "p-target", fromId: "w-phase", toId: "w-child", type: "FS", lagSeconds: 0 }
    ]);
    expect(result?.workspace.evidence.find((entry) => entry.id === "e-child")?.projectId).toBe("p-target");
    expect(result?.workspace.evidence.find((entry) => entry.id === "e-project")?.projectId).toBe("p-source");
    expect(result?.workspace.auditGates.find((entry) => entry.id === "g-child")?.projectId).toBe("p-target");
    expect(result?.workspace.baselines[0].plannedStartByItem).toEqual({ "w-other": start });
  });
});
