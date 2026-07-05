import { describe, expect, it } from "vitest";
import { evaluateAuditGates, recommendAuditDecision } from "./audit";
import { calculateEvm } from "./evm";
import { runMonteCarlo } from "./monteCarlo";
import { actuals, baselines, changeSets, dependencies, evidence, projects, resources, workItems } from "./sampleData";
import { scheduleProject } from "./scheduler";

const now = "2026-07-08T12:00:00.000Z";

describe("risk, EVM, and audit", () => {
  it("calculates EVM from baseline, actuals, and attention cost", () => {
    const project = projects.find((item) => item.id === "p-omni")!;
    const schedule = scheduleProject(project, workItems, dependencies);
    const evm = calculateEvm(project, schedule.items, baselines[0], actuals, resources, now);

    expect(evm.plannedValue).toBeGreaterThan(0);
    expect(evm.earnedValue).toBeGreaterThan(0);
    expect(evm.actualCost).toBeGreaterThan(0);
    expect(Number.isFinite(evm.schedulePerformanceIndex)).toBe(true);
  });

  it("runs deterministic Monte Carlo finish probabilities", () => {
    const project = projects.find((item) => item.id === "p-omni")!;
    const first = runMonteCarlo(project, workItems.filter((item) => item.projectId === project.id), dependencies, 80, 11);
    const second = runMonteCarlo(project, workItems.filter((item) => item.projectId === project.id), dependencies, 80, 11);

    expect(first.p50Finish).toBe(second.p50Finish);
    expect(first.p90Finish >= first.p50Finish).toBe(true);
  });

  it("runs Monte Carlo for legacy empty projects without a start date", () => {
    const project = {
      ...projects[0],
      id: "p-legacy-empty-risk",
      start: undefined as unknown as string,
      horizon: "2026-08-01T00:00:00.000Z"
    };
    const result = runMonteCarlo(project, [], [], 10, 11);

    expect(result.p50Finish).toBe("2026-08-01T00:00:00.000Z");
    expect(result.finishDistribution[0]).toEqual({ finish: "2026-08-01T00:00:00.000Z", count: 10 });
  });

  it("samples split-task duration instead of pinning the original split window", () => {
    const project = { ...projects[0], id: "p-split-risk", start: "2026-07-01T00:00:00.000Z" };
    const day = 8 * 3600;
    const result = runMonteCarlo(
      project,
      [
        {
          ...workItems[1],
          id: "w-split-risk",
          projectId: project.id,
          durationSeconds: day,
          estimate: { optimisticSeconds: day, mostLikelySeconds: day, pessimisticSeconds: 10 * day },
          splitSegments: [{ offsetSeconds: 0, durationSeconds: day }]
        }
      ],
      [],
      100,
      13
    );

    expect(Date.parse(result.p90Finish)).toBeGreaterThan(Date.parse("2026-07-01T08:00:00.000Z"));
  });

  it("opens hard gates for missing evidence without blocking on optional baseline changes", () => {
    const project = projects.find((item) => item.id === "p-omni")!;
    const schedule = scheduleProject(project, workItems, dependencies);
    const gates = evaluateAuditGates(project, workItems, schedule.items, evidence, changeSets, now);
    const decision = recommendAuditDecision(project, gates, evidence, now);

    expect(gates.some((gate) => gate.targetType === "milestone" && gate.severity === "hard")).toBe(true);
    expect(gates.some((gate) => gate.targetType === "baseline")).toBe(false);
    expect(gates.find((gate) => gate.id === decision.sourceGateIds[0])?.severity).toBe("hard");
    expect(["Accelerate", "Continue", "Narrow", "Pivot", "Stop"]).toContain(decision.action);
  });
});
