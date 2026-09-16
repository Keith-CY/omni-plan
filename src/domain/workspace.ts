import type { Resource, WorkspaceSnapshot } from "./types";

export const personalResourceId = "r-me";

export function createPersonalResource(): Resource {
  return {
    id: personalResourceId,
    name: "我",
    role: "Owner",
    capacityByAttention: {
      deep: 4 * 60 * 60,
      medium: 3 * 60 * 60,
      shallow: 2 * 60 * 60
    },
    hourlyRate: 1
  };
}

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    schemaVersion: 3,
    timeZone: resolvedTimeZone(),
    todos: [],
    conversionHistory: [],
    projects: [],
    workItems: [],
    recurringOccurrences: [],
    dependencies: [],
    resources: [createPersonalResource()],
    capacities: [],
    baselines: [],
    actuals: [],
    evidence: [],
    decisions: [],
    changeSets: [],
    auditGates: [],
    auditDecisions: []
  };
}

export function workspaceHasUserContent(snapshot: WorkspaceSnapshot): boolean {
  return snapshot.projects.length > 0
    || snapshot.todos.length > 0
    || snapshot.workItems.length > 0
    || snapshot.recurringOccurrences.length > 0
    || snapshot.dependencies.length > 0
    || snapshot.resources.some((resource) => resource.id !== personalResourceId)
    || snapshot.capacities.length > 0
    || snapshot.baselines.length > 0
    || snapshot.actuals.length > 0
    || snapshot.evidence.length > 0
    || snapshot.decisions.length > 0
    || snapshot.changeSets.length > 0
    || snapshot.auditGates.length > 0
    || snapshot.auditDecisions.length > 0
    || snapshot.conversionHistory.length > 0;
}

function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
