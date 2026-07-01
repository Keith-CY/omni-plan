import type { Actual, Baseline, EvmResult, Project, Resource, ScheduledItem, WorkItem } from "./types";
import { secondsBetween } from "./time";

function assignmentCost(item: WorkItem, resources: Resource[]): number {
  return item.assignmentIds.reduce((sum, assignment) => {
    const resource = resources.find((candidate) => candidate.id === assignment.resourceId);
    const hourlyRate = resource?.hourlyRate ?? 1;
    return sum + (assignment.effortSeconds / 3600) * hourlyRate;
  }, 0);
}

export function calculateEvm(
  project: Project,
  schedule: ScheduledItem[],
  baseline: Baseline,
  actuals: Actual[],
  resources: Resource[],
  asOf: string
): EvmResult {
  let plannedValue = 0;
  let earnedValue = 0;
  let actualCost = 0;

  for (const scheduled of schedule) {
    const item = scheduled.workItem;
    const budget = assignmentCost(item, resources);
    const baselineStart = baseline.plannedStartByItem[item.id] ?? scheduled.start;
    const baselineFinish = baseline.plannedFinishByItem[item.id] ?? scheduled.finish;
    const total = Math.max(1, secondsBetween(baselineStart, baselineFinish));
    const elapsed = Math.max(0, Math.min(total, secondsBetween(baselineStart, asOf)));
    const plannedPercent = item.kind === "milestone" ? (asOf >= baselineFinish ? 1 : 0) : elapsed / total;
    plannedValue += budget * plannedPercent;
    earnedValue += budget * Math.max(0, Math.min(1, item.percentComplete / 100));

    const actual = actuals.find((candidate) => candidate.workItemId === item.id);
    if (actual) actualCost += actual.actualCost || actual.actualWorkSeconds / 3600;
  }

  return {
    projectId: project.id,
    asOf,
    plannedValue,
    earnedValue,
    actualCost,
    schedulePerformanceIndex: plannedValue === 0 ? 1 : earnedValue / plannedValue,
    costPerformanceIndex: actualCost === 0 ? 1 : earnedValue / actualCost,
    estimateAtCompletion: earnedValue === 0 ? actualCost : actualCost / (earnedValue / Math.max(plannedValue, earnedValue))
  };
}
