import {
  generateRecurringOccurrences,
  type RecurringOccurrence,
} from "@/domain/recurring";

import type { ProjectWorkItem, WorkspaceV2 } from "../domain/types";
import {
  projectToSchedulerInput,
  workItemToSchedulerInput,
  workItemsInActiveBet,
} from "./schedulerAdapter";

export function recurringOccurrencesForV2(
  item: ProjectWorkItem,
  fallbackStart: string,
  limit = 8,
): RecurringOccurrence[] {
  return generateRecurringOccurrences(
    workItemToSchedulerInput(item),
    fallbackStart,
    limit,
  );
}

export function projectRecurringOccurrences(
  workspace: WorkspaceV2,
  projectId: string,
  limit = 8,
): Array<{ workItemId: string; occurrences: RecurringOccurrence[] }> {
  const project = workspace.projects.find(({ id }) => id === projectId);
  if (project === undefined) return [];
  const projected = projectToSchedulerInput(workspace, project);
  if (projected === undefined) return [];

  return workItemsInActiveBet(workspace, projectId)
    .filter((item) => item.repeatRule !== undefined)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      workItemId: item.id,
      occurrences: recurringOccurrencesForV2(item, projected.start, limit),
    }));
}
