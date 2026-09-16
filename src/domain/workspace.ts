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

function resolvedTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
