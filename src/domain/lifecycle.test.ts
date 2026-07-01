import { describe, expect, it } from "vitest";
import { evaluateAuditGates, recommendAuditDecision } from "./audit";
import { calculateEvm } from "./evm";
import { exportProjectMarkdown } from "./exports";
import { runMonteCarlo } from "./monteCarlo";
import { scheduleProject } from "./scheduler";
import type { Actual, Baseline, ChangeSet, Dependency, Evidence, Project, Resource, WorkItem } from "./types";

const hour = 60 * 60;
const day = 24 * hour;

describe("project lifecycle tracking", () => {
  it("represents a completed software project from charter through dependencies, evidence, actuals, audit, and baseline", () => {
    const project: Project = {
      id: "p-agentic-dev",
      name: "Agentic Dev Project Simulation",
      status: "done",
      mode: "build",
      priority: 1,
      northStar: "Ship a trustworthy agentic project workflow.",
      currentOutcome: "Lifecycle tracking is complete and evidence-backed.",
      start: "2026-07-02T00:00:00.000Z",
      horizon: "2026-08-01T00:00:00.000Z",
      reviewCadenceDays: 7,
      directionCard: {
        targetUser: "Personal project operator",
        userProblem: "Fast execution can hide wrong direction.",
        businessGoal: "Replace ad hoc project tracking with audit-gated planning.",
        coreHypothesis: "Evidence and dependency-aware planning prevent false progress.",
        successMetric: "All critical items complete with linked evidence and no hard gates.",
        failureCondition: "Milestone completion happens without evidence.",
        validationMethod: "Review schedule, actuals, gates, and evidence exports.",
        timeboxDays: 21,
        opportunityCost: "Less time spent on manual project status reconciliation."
      }
    };
    const workItems: WorkItem[] = [
      item("w-prd", "1", "Define PRD", 1, 100, true),
      item("w-arch", "2", "Design architecture", 1, 100, true),
      item("w-frontend", "3", "Frontend shell", 2, 100, true),
      item("w-scheduler", "4", "Scheduler API", 2, 100, true),
      item("w-storage", "5", "Local storage", 2, 100, true),
      item("w-evidence", "6", "Evidence and audit UI", 1, 100, true),
      item("w-validation", "7", "Validation milestone", 0, 100, true, "milestone")
    ];
    const dependencies: Dependency[] = [
      dependency("d-prd-arch", "w-prd", "w-arch"),
      dependency("d-arch-frontend", "w-arch", "w-frontend"),
      dependency("d-arch-scheduler", "w-arch", "w-scheduler"),
      dependency("d-arch-storage", "w-arch", "w-storage"),
      dependency("d-storage-evidence", "w-storage", "w-evidence"),
      dependency("d-scheduler-validation", "w-scheduler", "w-validation", "FF"),
      dependency("d-evidence-validation", "w-evidence", "w-validation", "FF")
    ];
    const schedule = scheduleProject(project, workItems, dependencies);
    const baseline: Baseline = {
      id: "b-agentic-dev",
      projectId: project.id,
      name: "Agentic Dev Project Simulation approved baseline",
      capturedAt: "2026-07-02T08:00:00.000Z",
      plannedStartByItem: Object.fromEntries(schedule.items.map((entry) => [entry.workItem.id, entry.start])),
      plannedFinishByItem: Object.fromEntries(schedule.items.map((entry) => [entry.workItem.id, entry.finish])),
      plannedWorkSecondsByItem: Object.fromEntries(schedule.items.map((entry) => [
        entry.workItem.id,
        entry.workItem.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0)
      ])),
      approvedByDecisionId: "decision-approve-baseline"
    };
    const changeSets: ChangeSet[] = [
      {
        id: "cs-baseline",
        projectId: project.id,
        title: "Capture baseline",
        status: "approved",
        createdAt: "2026-07-02T08:00:00.000Z",
        reason: "Approved after project charter review.",
        diffs: [{ entity: "Baseline", entityId: baseline.id, field: "created", before: null, after: baseline }],
        rollbackToken: "rollback-cs-baseline",
        auditGateIds: []
      }
    ];
    const evidence: Evidence[] = workItems.map((entry, index) => ({
      id: `e-${entry.id}`,
      projectId: project.id,
      workItemId: entry.id,
      kind: index % 3 === 0 ? "doc" : index % 3 === 1 ? "pr" : "screenshot",
      summary: `${entry.title} completion evidence`,
      url: `https://example.test/${entry.id}`,
      createdAt: "2026-07-10T10:00:00.000Z",
      confidence: 0.9,
      tags: ["lifecycle"]
    }));
    const actuals: Actual[] = workItems.map((entry) => ({
      workItemId: entry.id,
      actualStart: "2026-07-02T09:00:00.000Z",
      actualFinish: "2026-07-10T18:00:00.000Z",
      actualWorkSeconds: entry.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0),
      remainingWorkSeconds: 0,
      actualCost: 1,
      recordedAt: "2026-07-10T18:00:00.000Z"
    }));
    const resource: Resource = {
      id: "r-owner",
      name: "Owner",
      role: "operator",
      capacityByAttention: { deep: 6 * hour, medium: 4 * hour, shallow: 2 * hour },
      hourlyRate: 1
    };

    const gates = evaluateAuditGates(project, workItems, schedule.items, evidence, changeSets, "2026-07-10T18:00:00.000Z");
    const evm = calculateEvm(project, schedule.items, baseline, actuals, [resource], "2026-07-10T18:00:00.000Z");
    const auditDecision = recommendAuditDecision(project, gates, evidence, "2026-07-10T18:00:00.000Z");
    const markdown = exportProjectMarkdown(project, schedule, evidence, auditDecision, evm, runMonteCarlo(project, workItems, dependencies, 60, 7), gates, baseline);

    expect(schedule.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toHaveLength(0);
    expect(gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared")).toHaveLength(0);
    expect(evm.schedulePerformanceIndex).toBeGreaterThan(0);
    expect(markdown).toContain("Open Hard Gates: 0");
    expect(markdown).toContain("[pr] Design architecture completion evidence");
    expect(markdown).toContain("Scheduler Diagnostics");
  });

  it("exports explicit scheduler diagnostics instead of hiding unsafe fixed-start plans", () => {
    const project: Project = {
      id: "p-diagnostic",
      name: "Diagnostic project",
      status: "active",
      mode: "build",
      priority: 1,
      northStar: "Expose unsafe schedules.",
      currentOutcome: "Fixed-start conflict is visible.",
      start: "2026-07-02T00:00:00.000Z",
      horizon: "2026-07-20T00:00:00.000Z",
      reviewCadenceDays: 7
    };
    const predecessor = { ...item("w-a", "1", "Predecessor", 3, 0, false), projectId: project.id };
    const successor = {
      ...item("w-b", "2", "Fixed successor", 1, 0, false),
      projectId: project.id,
      constraint: { fixedStart: "2026-07-02T00:00:00.000Z" }
    };
    const schedule = scheduleProject(project, [predecessor, successor], [{ ...dependency("d-a-b", predecessor.id, successor.id), projectId: project.id }]);
    const decision = {
      id: "audit-diagnostic",
      projectId: project.id,
      action: "Narrow" as const,
      strongestContinueEvidence: "None",
      strongestStopReason: "Fixed start conflict",
      rationale: "Review schedule diagnostics before continuing.",
      createdAt: "2026-07-02T00:00:00.000Z",
      sourceGateIds: []
    };
    const markdown = exportProjectMarkdown(project, schedule, [], decision, undefined, runMonteCarlo(project, [predecessor, successor], [], 10, 1), []);

    expect(schedule.diagnostics.some((diagnostic) => diagnostic.message.includes("fixed start"))).toBe(true);
    expect(markdown).toContain("## Scheduler Diagnostics");
    expect(markdown).toContain("fixed start");
  });
});

function item(id: string, outline: string, title: string, durationDays: number, percentComplete: number, evidenceRequired: boolean, kind: WorkItem["kind"] = "task"): WorkItem {
  return {
    id,
    projectId: "p-agentic-dev",
    kind,
    title,
    outline,
    durationSeconds: durationDays * day,
    estimate: { mostLikelySeconds: durationDays * day },
    assignmentIds: kind === "milestone" ? [] : [{ resourceId: "r-owner", attention: "deep", effortSeconds: Math.max(1, durationDays) * 4 * hour }],
    percentComplete,
    evidenceRequired,
    isKeyTask: evidenceRequired
  };
}

function dependency(id: string, fromId: string, toId: string, type: Dependency["type"] = "FS"): Dependency {
  return {
    id,
    projectId: "p-agentic-dev",
    fromId,
    toId,
    type,
    lagSeconds: 0
  };
}
