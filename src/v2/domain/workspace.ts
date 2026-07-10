import type { Id } from "@/domain/types";

import type { WorkspaceV2 } from "./types";

export function createEmptyWorkspaceV2(workspaceId: Id): WorkspaceV2 {
  return {
    schemaVersion: 2,
    workspaceId,
    revision: 0,
    capacityProfile: undefined,
    inboxItems: [],
    actions: [],
    projects: [],
    directionBriefs: [],
    bets: [],
    planVersions: [],
    dailyCommitments: [],
    reviews: [],
    exceptions: [],
    closeDecisions: [],
    replanProposals: [],
    commandProposals: [],
    syncConflicts: [],
    commandReceipts: [],
    workItems: [],
    dependencies: [],
    resources: [],
    capacities: [],
    baselines: [],
    evidence: [],
    actuals: [],
    legacyAuditRecords: [],
    visibility: { archivedProjectIds: [] },
    migration: undefined,
  };
}
