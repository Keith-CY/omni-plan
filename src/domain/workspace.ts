import type { WorkspaceSnapshot } from "./types";

export function createEmptyWorkspace(): WorkspaceSnapshot {
  return {
    projects: [],
    workItems: [],
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
