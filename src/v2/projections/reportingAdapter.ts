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
  return workspace.actuals.flatMap((actual) => {
    if (
      actual.target.kind !== "work_item" ||
      !workItemIds.has(actual.target.workItemId)
    ) {
      return [];
    }
    return [
      {
        workItemId: actual.target.workItemId,
        ...(actual.actualStart === undefined
          ? {}
          : { actualStart: actual.actualStart }),
        ...(actual.actualFinish === undefined
          ? {}
          : { actualFinish: actual.actualFinish }),
        actualWorkSeconds: actual.actualWorkSeconds,
        remainingWorkSeconds: actual.remainingWorkSeconds,
        actualCost: actual.actualCost,
        recordedAt: actual.recordedAt,
      },
    ];
  });
}

export function selectV2Baseline(
  workspace: WorkspaceV2,
  projectId: string,
): Baseline | undefined {
  const baseline = workspace.baselines
    .filter((candidate) => candidate.projectId === projectId)
    .sort(
      (left, right) =>
        right.capturedAt.localeCompare(left.capturedAt) ||
        left.id.localeCompare(right.id),
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
