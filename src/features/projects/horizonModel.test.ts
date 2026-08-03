import { describe, expect, it } from "vitest";
import type { ProjectHealth } from "@/domain/portfolio";
import type { AuditGate, Dependency, Project, ScheduleResult, ScheduledItem, WorkItem } from "@/domain/types";
import { inferProjectArea, projectHorizonSignals } from "./horizonModel";

const project: Project = {
  id: "project-1",
  name: "Quiet project",
  status: "active",
  mode: "build",
  priority: 2,
  northStar: "A calm result",
  currentOutcome: "Take the next step",
  horizon: "2026-09-01T00:00:00.000Z",
  start: "2026-08-01T00:00:00.000Z",
  reviewCadenceDays: 7
};

const workItem: WorkItem = {
  id: "task-1",
  projectId: project.id,
  kind: "task",
  title: "First step",
  outline: "1",
  durationSeconds: 3600,
  estimate: { mostLikelySeconds: 3600 },
  assignmentIds: [],
  percentComplete: 0
};

const scheduledItem: ScheduledItem = {
  workItem,
  start: "2026-08-02T00:00:00.000Z",
  finish: "2026-08-02T01:00:00.000Z",
  earlyStart: "2026-08-02T00:00:00.000Z",
  earlyFinish: "2026-08-02T01:00:00.000Z",
  lateStart: "2026-08-03T00:00:00.000Z",
  lateFinish: "2026-08-03T01:00:00.000Z",
  totalFloatSeconds: 86400,
  freeFloatSeconds: 86400,
  isCritical: false,
  warnings: []
};

const schedule: ScheduleResult = { projectId: project.id, items: [scheduledItem], diagnostics: [], unsupported: [] };
const calmHealth: ProjectHealth = {
  projectId: project.id,
  momentumScore: 40,
  riskScore: 20,
  evidenceFreshnessDays: 2,
  openHardGates: 0,
  criticalItems: 0,
  recommendedFocus: 30
};

describe("projectHorizonSignals", () => {
  it("keeps a project simple when it has no real planning signal", () => {
    expect(projectHorizonSignals({
      project,
      schedule,
      dependencies: [],
      now: "2026-08-01T00:00:00.000Z"
    }).mode).toBe("simple");
  });

  it("enables managed planning for a real deadline", () => {
    const deadlineSchedule = {
      ...schedule,
      items: [{ ...scheduledItem, workItem: { ...workItem, constraint: { noLaterThan: "2026-08-05T00:00:00.000Z" } } }]
    };
    const result = projectHorizonSignals({ project, schedule: deadlineSchedule, dependencies: [], now: "2026-08-01T00:00:00.000Z" });
    expect(result).toMatchObject({ mode: "managed", hasDeadline: true });
  });

  it("enables managed planning for dependencies or visible delay risk", () => {
    const dependencies: Dependency[] = [{ id: "dep-1", projectId: project.id, fromId: "task-1", toId: "task-2", type: "FS", lagSeconds: 0 }];
    expect(projectHorizonSignals({ project, schedule, dependencies, now: "2026-08-01T00:00:00.000Z" }).mode).toBe("managed");

    const overdueSchedule = { ...schedule, items: [{ ...scheduledItem, finish: "2026-07-31T23:00:00.000Z" }] };
    expect(projectHorizonSignals({ project, schedule: overdueSchedule, dependencies: [], now: "2026-08-01T00:00:00.000Z" })).toMatchObject({ mode: "managed", hasDelayRisk: true, delayRiskLevel: "high" });
  });

  it("does not mistake governance health for schedule delay risk", () => {
    const directionGate: AuditGate = { id: "gate-direction", projectId: project.id, targetType: "project", targetId: project.id, severity: "hard", reason: "Project does not have a complete Direction Card.", requiredAction: "Complete it", status: "open" };
    expect(directionGate.status).toBe("open");
    expect(calmHealth.riskScore).toBe(20);
    expect(projectHorizonSignals({ project, schedule: { ...schedule, items: [] }, dependencies: [], now: "2026-08-01T00:00:00.000Z" })).toMatchObject({ mode: "simple", hasDelayRisk: false, delayRiskLevel: "none" });
  });
});

describe("inferProjectArea", () => {
  it("uses lightweight project and task language without changing stored data", () => {
    expect(inferProjectArea({ ...project, name: "Apartment repair" }, [workItem])).toBe("home");
    expect(inferProjectArea({ ...project, name: "Learn Japanese" }, [workItem])).toBe("growth");
    expect(inferProjectArea({ ...project, name: "Client launch" }, [workItem])).toBe("work");
  });
});
