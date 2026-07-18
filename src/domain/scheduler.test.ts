import { describe, expect, it } from "vitest";
import { dependencies, projects, resources, workItems } from "./sampleData";
import {
  detectCrossProjectOverload,
  generateLevelingProposals,
  schedulePortfolio,
  scheduleProject
} from "./scheduler";

describe("scheduler", () => {
  it("returns an empty schedule for projects without work items", () => {
    const project = {
      ...projects[0],
      id: "p-empty",
      name: "Empty Project"
    };
    const result = scheduleProject(project, workItems, dependencies);

    expect(result.projectId).toBe("p-empty");
    expect(result.items).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.unsupported).toHaveLength(0);
  });

  it("schedules legacy projects that are missing a start date", () => {
    const project = {
      ...projects[0],
      id: "p-legacy-no-start",
      name: "Legacy No Start",
      start: undefined as unknown as string,
      horizon: "2026-08-01T00:00:00.000Z"
    };
    const task = {
      ...workItems.find((item) => item.id === "w-domain")!,
      id: "w-legacy-no-start",
      projectId: project.id,
      parentId: undefined,
      constraint: { noEarlierThan: undefined as unknown as string }
    };
    const result = scheduleProject(project, [task], []);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].start).toBe("2026-08-01T00:00:00.000Z");
  });

  it("schedules dependency order and hammock windows", () => {
    const project = projects.find((item) => item.id === "p-omni")!;
    const result = scheduleProject(project, workItems, dependencies);
    const core = result.items.find((item) => item.workItem.id === "w-core")!;
    const domain = result.items.find((item) => item.workItem.id === "w-domain")!;
    const scheduler = result.items.find((item) => item.workItem.id === "w-scheduler")!;
    const hammock = result.items.find((item) => item.workItem.id === "w-hammock")!;
    const milestone = result.items.find((item) => item.workItem.id === "w-milestone")!;

    expect(result.diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
    expect(scheduler.start >= domain.finish).toBe(true);
    expect(core.start).toBe(domain.start);
    expect(core.finish).toBe(milestone.finish);
    expect(hammock.start).toBe(domain.start);
    expect(hammock.finish).toBe(milestone.finish);
    expect(result.items.some((item) => item.isCritical)).toBe(true);
  });

  it("refuses circular dependencies", () => {
    const project = projects.find((item) => item.id === "p-launch")!;
    const result = scheduleProject(project, workItems, [
      ...dependencies,
      { id: "cycle", projectId: "p-launch", fromId: "w-launch-report", toId: "w-launch-brief", type: "FS", lagSeconds: 0 }
    ]);

    expect(result.items).toHaveLength(0);
    expect(result.diagnostics.some((item) => item.message.includes("Circular"))).toBe(true);
  });

  it("warns when fixed start violates dependency bounds", () => {
    const project = projects.find((item) => item.id === "p-launch")!;
    const constrainedItems = workItems.map((item) =>
      item.id === "w-launch-report"
        ? { ...item, constraint: { fixedStart: "2026-07-05T00:00:00.000Z" } }
        : item
    );
    const result = scheduleProject(project, constrainedItems, dependencies);

    expect(result.diagnostics.some((item) => item.itemId === "w-launch-report" && item.message.includes("fixed start"))).toBe(true);
    expect(result.items.find((item) => item.workItem.id === "w-launch-report")?.warnings.some((warning) => warning.includes("Fixed start"))).toBe(true);
  });

  it("detects cross-project attention overload and proposes a local optimizer move", () => {
    const schedules = schedulePortfolio(projects, workItems, dependencies);
    const overloads = detectCrossProjectOverload(schedules, resources);
    const proposals = generateLevelingProposals(schedules, resources);

    expect(overloads.length).toBeGreaterThan(0);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some((proposal) => proposal.workItemId === "w-launch-brief")).toBe(false);
    expect(proposals.every((proposal) => proposal.beforeStart.slice(0, 10) === proposal.id.split("-").slice(-3).join("-"))).toBe(true);
    expect(proposals[0].reason).toContain("over capacity");
  });

  it("keeps automatic recurring items and their assignments out of planning", () => {
    const project = projects[0];
    const automatic = {
      ...workItems.find((item) => item.id === "w-domain")!,
      id: "w-automatic-transfer",
      projectId: project.id,
      parentId: undefined,
      title: "Automatic transfer",
      assignmentIds: [{ resourceId: resources[0].id, attention: "deep" as const, effortSeconds: 100 * 3600 }],
      repeatRule: {
        id: "repeat-auto-transfer",
        cadence: "monthly" as const,
        count: 12,
        startMode: "fixed-time" as const,
        startAt: "2026-07-01T09:00:00.000Z",
        executionMode: "automatic" as const,
        endMode: "never" as const,
        automaticDurationSeconds: 0
      }
    };
    const manual = {
      ...automatic,
      id: "w-manual-repeat",
      title: "Manual recurring review",
      assignmentIds: [],
      repeatRule: { ...automatic.repeatRule, id: "repeat-manual", executionMode: "manual" as const }
    };
    const autoDependency = {
      id: "d-auto-domain",
      projectId: project.id,
      fromId: automatic.id,
      toId: "w-domain",
      type: "FS" as const,
      lagSeconds: 0
    };

    const result = scheduleProject(project, [...workItems, automatic, manual], [...dependencies, autoDependency]);
    const overloads = detectCrossProjectOverload([result], resources);

    expect(result.items.some((item) => item.workItem.id === automatic.id)).toBe(false);
    expect(result.items.some((item) => item.workItem.id === manual.id)).toBe(true);
    expect(overloads.some((row) => row.plannedSeconds >= 100 * 3600)).toBe(false);
  });
});
