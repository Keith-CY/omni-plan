import { describe, expect, it } from "vitest";
import { evaluateAuditGates } from "./audit";
import {
  buildShapeUpBet,
  createShapeUpPitch,
  isExecutableWorkItem,
  scheduleShapeUpAwareProject,
  unlockShapeUpTasksForBet
} from "./shapeUp";
import type { Project, ShapeUpScope, WorkItem } from "./types";

const day = 24 * 60 * 60;

describe("Shape Up workflow", () => {
  it("keeps new Shape Up projects out of execution until the pitch is bet", () => {
    const project: Project = {
      id: "p-shape",
      name: "Shape candidate",
      status: "waiting",
      mode: "build",
      priority: 3,
      northStar: "Shape before execution.",
      currentOutcome: "Complete the pitch.",
      start: "2026-07-04T00:00:00.000Z",
      horizon: "2026-07-18T00:00:00.000Z",
      reviewCadenceDays: 7,
      shapeUpPitch: createShapeUpPitch({
        problem: "We do not know which project workflow is worth building.",
        appetiteKind: "small-batch",
        now: "2026-07-04T00:00:00.000Z"
      })
    };
    const task = item("w-raw", project.id, "Imagined task");
    const schedule = scheduleShapeUpAwareProject(project, [task], []);
    const gates = evaluateAuditGates(project, [task], schedule.items, [], [], "2026-07-04T12:00:00.000Z");

    expect(schedule.items).toHaveLength(0);
    expect(schedule.diagnostics[0].message).toContain("Betting Gate");
    expect(gates.some((gate) => gate.id === "gate-shapeup-pitch-p-shape")).toBe(true);
  });

  it("requires a human betting gate before a complete pitch can build", () => {
    const scope = shapeScope("scope-core", 20);
    const project: Project = {
      ...baseProject(),
      shapeUpPitch: createShapeUpPitch({
        problem: "Manual project review is too slow.",
        appetiteKind: "small-batch",
        solutionSketch: "A pitch-first flow with one hill-chart scope.",
        rabbitHoles: "Do not build a full agile backlog.",
        noGos: "No team permissions in v1.",
        successBaseline: "One project can be shaped and bet without entering Today early.",
        scopes: [scope],
        now: "2026-07-04T00:00:00.000Z"
      })
    };
    const gates = evaluateAuditGates(project, [], [], [], [], "2026-07-04T12:00:00.000Z");

    expect(gates.find((gate) => gate.id === "gate-shapeup-bet-p-shape")?.severity).toBe("hard");
  });

  it("only schedules tasks from downhill scopes after the bet is accepted", () => {
    const uphillScope = shapeScope("scope-uphill", 40);
    const downhillScope = shapeScope("scope-downhill", 70);
    const pitch = createShapeUpPitch({
      problem: "Need a reliable Shape Up execution boundary.",
      appetiteKind: "small-batch",
      solutionSketch: "Use scopes and a hill chart.",
      rabbitHoles: "Do not schedule unknown work.",
      noGos: "No automatic AI bet approval.",
      successBaseline: "Downhill work enters Gantt; uphill work does not.",
      scopes: [uphillScope, downhillScope],
      now: "2026-07-04T00:00:00.000Z"
    });
    const project: Project = {
      ...baseProject(),
      status: "active",
      shapeUpPitch: {
        ...pitch,
        bet: buildShapeUpBet({ ...baseProject(), shapeUpPitch: pitch }, "decision-bet", "2026-07-04T00:00:00.000Z")
      }
    };
    const uphillTask = item("w-uphill", project.id, "Unknown-heavy work", uphillScope.id);
    const downhillTask = item("w-downhill", project.id, "Executable slice", downhillScope.id);
    const marker = { ...item("w-marker", project.id, "Circuit breaker"), kind: "milestone" as const, isShapeUpCycleMarker: true, durationSeconds: 0, estimate: { mostLikelySeconds: 0 }, assignmentIds: [] };
    const schedule = scheduleShapeUpAwareProject(project, [uphillTask, downhillTask, marker], []);

    expect(schedule.items.map((entry) => entry.workItem.id).sort()).toEqual(["w-downhill", "w-marker"]);
  });

  it("clears the pre-Bet lock from existing tasks in confirmed scopes only", () => {
    const confirmedScope = shapeScope("scope-confirmed", 20);
    const proposedScope = { ...shapeScope("scope-proposed", 20), confirmed: false };
    const pitch = createShapeUpPitch({
      problem: "Existing Todo-derived tasks must unlock with the accepted Bet.",
      scopes: [confirmedScope, proposedScope],
      now: "2026-07-04T00:00:00.000Z"
    });
    const project: Project = {
      ...baseProject(),
      status: "active",
      shapeUpPitch: {
        ...pitch,
        bet: buildShapeUpBet({ ...baseProject(), shapeUpPitch: pitch }, "decision-bet", "2026-07-04T00:00:00.000Z")
      }
    };
    const confirmedTask = { ...item("w-confirmed", project.id, "Confirmed", confirmedScope.id), shapeUpLocked: true };
    const proposedTask = { ...item("w-proposed", project.id, "Proposed", proposedScope.id), shapeUpLocked: true };
    const otherProjectTask = { ...item("w-other", "p-other", "Other", confirmedScope.id), shapeUpLocked: true };
    const confirmedPhase = {
      ...item("w-phase", project.id, "Phase", confirmedScope.id),
      kind: "phase" as const,
      shapeUpLocked: true
    };
    const workItems = [confirmedTask, proposedTask, otherProjectTask, confirmedPhase];

    const unlocked = unlockShapeUpTasksForBet(project, workItems);

    expect(unlocked.find(({ id }) => id === confirmedTask.id)?.shapeUpLocked).toBeUndefined();
    expect(unlocked.find(({ id }) => id === proposedTask.id)?.shapeUpLocked).toBe(true);
    expect(unlocked.find(({ id }) => id === otherProjectTask.id)?.shapeUpLocked).toBe(true);
    expect(unlocked.find(({ id }) => id === confirmedPhase.id)?.shapeUpLocked).toBe(true);
    expect(confirmedTask.shapeUpLocked).toBe(true);
  });

  it("does not unlock tasks until the Bet is active", () => {
    const scope = shapeScope("scope-confirmed", 20);
    const project: Project = {
      ...baseProject(),
      shapeUpPitch: createShapeUpPitch({
        problem: "The task must stay locked before approval.",
        scopes: [scope],
        now: "2026-07-04T00:00:00.000Z"
      })
    };
    const locked = { ...item("w-locked", project.id, "Locked", scope.id), shapeUpLocked: true };

    expect(unlockShapeUpTasksForBet(project, [locked])).toEqual([locked]);
  });

  it("does not let a post-Bet scope confirmation bypass the accepted task boundary", () => {
    const acceptedScope = shapeScope("scope-accepted", 70);
    const excludedScope = { ...shapeScope("scope-excluded", 20), confirmed: false };
    const pitch = createShapeUpPitch({
      problem: "Only accepted scope may execute.",
      scopes: [acceptedScope, excludedScope],
      now: "2026-07-04T00:00:00.000Z"
    });
    const betProject: Project = {
      ...baseProject(),
      status: "active",
      shapeUpPitch: {
        ...pitch,
        bet: buildShapeUpBet({ ...baseProject(), shapeUpPitch: pitch }, "decision-bet", "2026-07-04T00:00:00.000Z")
      }
    };
    const excludedTask = {
      ...item("w-excluded", betProject.id, "Excluded", excludedScope.id),
      shapeUpLocked: true
    };
    const [stillLocked] = unlockShapeUpTasksForBet(betProject, [excludedTask]);
    const editedAfterBet: Project = {
      ...betProject,
      shapeUpPitch: {
        ...betProject.shapeUpPitch!,
        scopes: betProject.shapeUpPitch!.scopes.map((scope) =>
          scope.id === excludedScope.id ? { ...scope, confirmed: true, hillPosition: 80 } : scope
        )
      }
    };

    expect(stillLocked.shapeUpLocked).toBe(true);
    expect(isExecutableWorkItem(editedAfterBet, stillLocked)).toBe(false);
    expect(scheduleShapeUpAwareProject(editedAfterBet, [stillLocked], []).items).toEqual([]);
  });

  it("opens a circuit breaker gate after an active bet expires", () => {
    const pitch = createShapeUpPitch({
      problem: "A fixed appetite needs enforcement.",
      appetiteKind: "small-batch",
      solutionSketch: "Pause when the cycle expires.",
      rabbitHoles: "Silent extension.",
      noGos: "Do not keep extending.",
      successBaseline: "Expired active bet opens a hard gate.",
      scopes: [shapeScope("scope-core", 80)],
      now: "2026-07-04T00:00:00.000Z"
    });
    const project: Project = {
      ...baseProject(),
      status: "active",
      shapeUpPitch: {
        ...pitch,
        bet: buildShapeUpBet({ ...baseProject(), shapeUpPitch: pitch }, "decision-bet", "2026-07-04T00:00:00.000Z")
      }
    };
    const gates = evaluateAuditGates(project, [], [], [], [], "2026-07-20T00:00:00.000Z");

    expect(gates.find((gate) => gate.id === "gate-shapeup-circuit-p-shape")?.requiredAction).toContain("Ship as-is");
  });
});

function baseProject(): Project {
  return {
    id: "p-shape",
    name: "Shape candidate",
    status: "waiting",
    mode: "build",
    priority: 3,
    northStar: "Shape before execution.",
    currentOutcome: "Complete the pitch.",
    start: "2026-07-04T00:00:00.000Z",
    horizon: "2026-07-18T00:00:00.000Z",
    reviewCadenceDays: 7,
    directionCard: {
      targetUser: "Personal operator",
      userProblem: "Fast execution can hide wrong direction.",
      businessGoal: "Prevent false progress.",
      coreHypothesis: "Shape Up gates reduce wrong execution.",
      successMetric: "Projects cannot enter Today before bet.",
      failureCondition: "Unbet work appears in the Gantt.",
      validationMethod: "Run scheduling tests.",
      timeboxDays: 14,
      opportunityCost: "Less raw throughput."
    }
  };
}

function shapeScope(id: string, hillPosition: number): ShapeUpScope {
  return {
    id,
    title: id.replace("scope-", ""),
    description: "A shaped scope.",
    confirmed: true,
    hillPosition
  };
}

function item(id: string, projectId: string, title: string, shapeUpScopeId?: string): WorkItem {
  return {
    id,
    projectId,
    kind: "task",
    title,
    outline: "1",
    durationSeconds: day,
    estimate: { mostLikelySeconds: day },
    assignmentIds: [{ resourceId: "r-owner", attention: "deep", effortSeconds: 4 * 60 * 60 }],
    percentComplete: 0,
    shapeUpScopeId
  };
}
