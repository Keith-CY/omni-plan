import { describe, expect, it } from "vitest";
import { canDeleteEmptyProject, removeEmptyProjectFromWorkspace } from "./projectLifecycle";
import { sampleWorkspace } from "./sampleData";
import type { WorkspaceSnapshot } from "./types";

function cloneWorkspace(): WorkspaceSnapshot {
  return JSON.parse(JSON.stringify(sampleWorkspace)) as WorkspaceSnapshot;
}

describe("project lifecycle cleanup", () => {
  it("does not delete projects that still have work items", () => {
    const workspace = cloneWorkspace();

    expect(canDeleteEmptyProject(workspace, "p-omni")).toBe(false);
    expect(removeEmptyProjectFromWorkspace(workspace, "p-omni")).toBeUndefined();
  });

  it("removes an empty project and its project-level records", () => {
    const workspace = cloneWorkspace();
    workspace.projects.push({
      id: "p-empty",
      name: "Empty Project",
      status: "waiting",
      mode: "explore",
      priority: 1,
      northStar: "Remove empty shell projects.",
      currentOutcome: "No work has started.",
      horizon: "2026-08-01T00:00:00.000Z",
      start: "2026-07-06T00:00:00.000Z",
      reviewCadenceDays: 7
    });
    workspace.baselines.push({
      id: "b-empty",
      projectId: "p-empty",
      name: "Empty baseline",
      capturedAt: "2026-07-06T00:00:00.000Z",
      plannedStartByItem: {},
      plannedFinishByItem: {},
      plannedWorkSecondsByItem: {}
    });
    workspace.evidence.push({
      id: "e-empty",
      projectId: "p-empty",
      kind: "note",
      summary: "No execution evidence.",
      createdAt: "2026-07-06T00:00:00.000Z",
      confidence: 0.5,
      tags: []
    });
    workspace.decisions.push({
      id: "decision-empty",
      projectId: "p-empty",
      statement: "Delete this shell.",
      context: "No work exists.",
      options: ["delete"],
      rationale: "Keep portfolio clean.",
      consequences: "Project disappears from planning.",
      linkedEvidenceIds: [],
      createdAt: "2026-07-06T00:00:00.000Z"
    });
    workspace.auditGates.push({
      id: "gate-empty",
      projectId: "p-empty",
      targetType: "project",
      targetId: "p-empty",
      severity: "warning",
      reason: "Shell project.",
      requiredAction: "Delete or define work.",
      status: "open"
    });
    workspace.auditDecisions.push({
      id: "audit-empty",
      projectId: "p-empty",
      action: "Stop",
      strongestContinueEvidence: "",
      strongestStopReason: "No work exists.",
      rationale: "Remove shell project.",
      createdAt: "2026-07-06T00:00:00.000Z",
      sourceGateIds: ["gate-empty"]
    });

    const next = removeEmptyProjectFromWorkspace(workspace, "p-empty");

    expect(next).toBeDefined();
    expect(next?.projects.some((project) => project.id === "p-empty")).toBe(false);
    expect(next?.baselines.some((baseline) => baseline.projectId === "p-empty")).toBe(false);
    expect(next?.evidence.some((item) => item.projectId === "p-empty")).toBe(false);
    expect(next?.decisions.some((decision) => decision.projectId === "p-empty")).toBe(false);
    expect(next?.auditGates.some((gate) => gate.projectId === "p-empty")).toBe(false);
    expect(next?.auditDecisions.some((decision) => decision.projectId === "p-empty")).toBe(false);
  });
});
