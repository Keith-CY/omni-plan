import { calculateEvm } from "@/domain/evm";
import { runMonteCarlo } from "@/domain/monteCarlo";
import { scheduleProject } from "@/domain/scheduler";
import type {
  Actual,
  Baseline,
  EvmResult,
  MonteCarloResult,
} from "@/domain/types";

import type { WorkspaceV2 } from "../domain/types";
import {
  projectToSchedulerInput,
  workItemToSchedulerInput,
  workItemsInActiveBet,
} from "./schedulerAdapter";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parsedTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function compareActualRecency(
  left: WorkspaceV2["actuals"][number],
  right: WorkspaceV2["actuals"][number],
): number {
  const leftTimestamp = parsedTimestamp(left.recordedAt);
  const rightTimestamp = parsedTimestamp(right.recordedAt);
  if (leftTimestamp !== rightTimestamp) {
    if (leftTimestamp === undefined) return 1;
    if (rightTimestamp === undefined) return -1;
    return rightTimestamp - leftTimestamp;
  }
  return right.revision - left.revision || compareText(left.id, right.id);
}

function boundaryTimestamp(
  values: Array<string | undefined>,
  direction: "earliest" | "latest",
): string | undefined {
  return values
    .flatMap((value) => {
      if (value === undefined) return [];
      const timestamp = parsedTimestamp(value);
      return timestamp === undefined ? [] : [{ timestamp, value }];
    })
    .sort((left, right) => {
      const timestampOrder =
        direction === "earliest"
          ? left.timestamp - right.timestamp
          : right.timestamp - left.timestamp;
      return timestampOrder || compareText(left.value, right.value);
    })[0]?.value;
}

function reportingInputs(workspace: WorkspaceV2, projectId: string) {
  const project = workspace.projects.find(({ id }) => id === projectId);
  if (project === undefined) return undefined;
  const projectedProject = projectToSchedulerInput(workspace, project);
  if (projectedProject === undefined) return undefined;
  const scopedWorkItems = workItemsInActiveBet(workspace, projectId);
  const scopedWorkItemIds = new Set(scopedWorkItems.map(({ id }) => id));
  const items = scopedWorkItems.map(workItemToSchedulerInput);
  const dependencies = workspace.dependencies
    .filter(
      (dependency) =>
        dependency.projectId === projectId &&
        scopedWorkItemIds.has(dependency.fromId) &&
        scopedWorkItemIds.has(dependency.toId),
    )
    .map(({ revision: _revision, ...dependency }) =>
      structuredClone(dependency),
    );
  return { project: projectedProject, items, dependencies };
}

export function actualsForProjectReporting(
  workspace: WorkspaceV2,
  projectId: string,
): Actual[] {
  const workItemIds = new Set(
    workspace.workItems
      .filter((item) => item.projectId === projectId)
      .map(({ id }) => id),
  );
  const eventsByWorkItem = new Map<
    string,
    Array<WorkspaceV2["actuals"][number]>
  >();
  for (const actual of workspace.actuals) {
    if (
      actual.target.kind !== "work_item" ||
      !workItemIds.has(actual.target.workItemId)
    ) {
      continue;
    }
    const events = eventsByWorkItem.get(actual.target.workItemId) ?? [];
    events.push(actual);
    eventsByWorkItem.set(actual.target.workItemId, events);
  }

  return [...eventsByWorkItem.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([workItemId, events]) => {
      const latest = [...events].sort(compareActualRecency)[0];
      const actualStart = boundaryTimestamp(
        events.map(({ actualStart }) => actualStart),
        "earliest",
      );
      const actualFinish = boundaryTimestamp(
        events.map(({ actualFinish }) => actualFinish),
        "latest",
      );
      return {
        workItemId,
        ...(actualStart === undefined ? {} : { actualStart }),
        ...(actualFinish === undefined ? {} : { actualFinish }),
        actualWorkSeconds: events.reduce(
          (total, actual) => total + actual.actualWorkSeconds,
          0,
        ),
        remainingWorkSeconds: latest.remainingWorkSeconds,
        actualCost: events.reduce(
          (total, actual) =>
            total +
            (actual.actualCost || actual.actualWorkSeconds / 3_600),
          0,
        ),
        recordedAt: latest.recordedAt,
      };
    });
}

function sameSortedKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left).sort(compareText);
  const rightKeys = Object.keys(right).sort(compareText);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index])
  );
}

function isValidReportingBaseline(baseline: Baseline): boolean {
  if (parsedTimestamp(baseline.capturedAt) === undefined) return false;
  if (
    !sameSortedKeys(
      baseline.plannedStartByItem,
      baseline.plannedFinishByItem,
    ) ||
    !sameSortedKeys(
      baseline.plannedStartByItem,
      baseline.plannedWorkSecondsByItem,
    )
  ) {
    return false;
  }

  return Object.keys(baseline.plannedStartByItem).every((workItemId) => {
    const start = parsedTimestamp(baseline.plannedStartByItem[workItemId]);
    const finish = parsedTimestamp(baseline.plannedFinishByItem[workItemId]);
    const workSeconds = baseline.plannedWorkSecondsByItem[workItemId];
    return (
      start !== undefined &&
      finish !== undefined &&
      finish >= start &&
      Number.isFinite(workSeconds) &&
      workSeconds >= 0
    );
  });
}

export function selectV2Baseline(
  workspace: WorkspaceV2,
  projectId: string,
): Baseline | undefined {
  const baseline = workspace.baselines
    .filter(
      (candidate) =>
        candidate.projectId === projectId &&
        isValidReportingBaseline(candidate),
    )
    .sort(
      (left, right) => {
        const capturedAtOrder =
          Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
        return capturedAtOrder || compareText(left.id, right.id);
      },
    )[0];
  return baseline === undefined ? undefined : structuredClone(baseline);
}

export function calculateV2Evm(
  workspace: WorkspaceV2,
  projectId: string,
  asOf: string,
): EvmResult | undefined {
  const inputs = reportingInputs(workspace, projectId);
  const baseline = selectV2Baseline(workspace, projectId);
  if (inputs === undefined || baseline === undefined) return undefined;
  const schedule = scheduleProject(
    inputs.project,
    inputs.items,
    inputs.dependencies,
  );
  return calculateEvm(
    inputs.project,
    schedule.items,
    baseline,
    actualsForProjectReporting(workspace, projectId),
    workspace.resources,
    asOf,
  );
}

export function runV2MonteCarlo(
  workspace: WorkspaceV2,
  projectId: string,
  simulations = 500,
  seed = 42,
): MonteCarloResult | undefined {
  const inputs = reportingInputs(workspace, projectId);
  return inputs === undefined
    ? undefined
    : runMonteCarlo(
        inputs.project,
        inputs.items,
        inputs.dependencies,
        simulations,
        seed,
      );
}
