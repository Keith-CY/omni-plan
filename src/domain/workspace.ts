import type { WorkspaceSnapshot } from "./types";

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    timeZone: resolvedTimeZone(),
    projects: [],
    workItems: [],
    recurringOccurrences: [],
    dependencies: [],
    resources: [],
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
