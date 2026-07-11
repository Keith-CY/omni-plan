import type { ISODate } from "@/domain/types";

import type { CloseDecisionDraft } from "./commands";
import type { RejectionCode } from "./errors";
import {
  isConcreteEvidenceRequirement,
  requirementStatus,
} from "./evidence";
import type {
  CloseDecision,
  BetVersion,
  DirectionBrief,
  InboxItem,
  ProjectHoldState,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

export interface CloseValidationIssue {
  code: RejectionCode;
  reason: string;
  gate: string;
  permittedNextCommand:
    | "close_project"
    | "abandon_project"
    | "attach_evidence"
    | "place_bet"
    | "resolve_sync_conflict";
}

export interface CloseArtifacts {
  decision: CloseDecision;
  returnedInboxItems: InboxItem[];
  followUpProject?: ProjectV2;
  followUpBrief?: DirectionBrief;
}

export type ExactCurrentCloseBet =
  | { ok: true; bet: BetVersion }
  | { ok: false; issue: CloseValidationIssue };

const outcomes = new Set(["achieved", "partial", "invalidated", "abandoned"]);
const dispositions = new Set([
  "discard",
  "return_to_inbox",
  "follow_up_project",
  "historical_incomplete",
]);

function isCanonicalTimestamp(value: ISODate): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function currentBetIssue(
  project: ProjectV2,
  code: "BET_REQUIRED" | "SYNC_CONFLICT",
  reason: string,
  gate: string,
): ExactCurrentCloseBet {
  return {
    ok: false,
    issue: {
      code,
      reason,
      gate,
      permittedNextCommand:
        code === "SYNC_CONFLICT" ? "resolve_sync_conflict" : "place_bet",
    },
  };
}

export function selectExactCurrentCloseBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
): ExactCurrentCloseBet {
  if (project.activeBetId === undefined) {
    return currentBetIssue(
      project,
      "BET_REQUIRED",
      `Project ${project.id} has no current Bet for Close.`,
      `project:${project.id}:current_bet`,
    );
  }
  const activeIdentity = workspace.bets.filter(
    ({ id }) => id === project.activeBetId,
  );
  if (activeIdentity.length > 1) {
    return currentBetIssue(
      project,
      "SYNC_CONFLICT",
      `Bet ${project.activeBetId} has duplicate records for one identity.`,
      `entity_identity:BetVersion:${project.activeBetId}`,
    );
  }
  const activeBet = activeIdentity[0];
  if (
    activeBet === undefined ||
    activeBet.projectId !== project.id ||
    activeBet.invalidatedAt !== undefined
  ) {
    return currentBetIssue(
      project,
      "BET_REQUIRED",
      `Project ${project.id} has no exact uninvalidated current Bet for Close.`,
      `project:${project.id}:current_bet`,
    );
  }
  const currentSameProject = workspace.bets.filter(
    (bet) => bet.projectId === project.id && bet.invalidatedAt === undefined,
  );
  if (
    currentSameProject.length !== 1 ||
    currentSameProject[0].id !== activeBet.id
  ) {
    return currentBetIssue(
      project,
      "SYNC_CONFLICT",
      `Project ${project.id} must have exactly one uninvalidated current Bet before Close.`,
      `project:${project.id}:current_bet`,
    );
  }
  return { ok: true, bet: activeBet };
}

export function exactCanonicalAppetiteBoundaryHold(
  project: ProjectV2,
  bet: BetVersion,
  now: ISODate,
): ProjectHoldState | undefined {
  if (
    bet.projectId !== project.id ||
    bet.invalidatedAt !== undefined ||
    !isCanonicalTimestamp(now) ||
    !isCanonicalTimestamp(bet.appetiteEnd) ||
    Date.parse(bet.appetiteEnd) > Date.parse(now)
  ) {
    return undefined;
  }
  const matches = project.holds.filter(
    ({ type, sourceId }) =>
      type === "rebet_required" && sourceId === bet.id,
  );
  if (matches.length !== 1) return undefined;
  const hold = matches[0];
  if (
    !isCanonicalTimestamp(hold.createdAt) ||
    Date.parse(hold.createdAt) < Date.parse(bet.appetiteEnd) ||
    Date.parse(hold.createdAt) > Date.parse(now) ||
    hold.affectedRecordIds.length !== 2
  ) {
    return undefined;
  }
  const expected = [project.id, bet.id].sort();
  const actual = [...hold.affectedRecordIds].sort();
  return actual[0] === expected[0] && actual[1] === expected[1]
    ? hold
    : undefined;
}

function tupleId(parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export function returnedInboxItemId(
  decisionId: string,
  workItemId: string,
): string {
  return tupleId(["close_return_to_inbox", decisionId, workItemId]);
}

export function followUpDirectionBriefId(
  decisionId: string,
  projectId: string,
): string {
  return tupleId(["close_follow_up_direction", decisionId, projectId]);
}

export function unfinishedProjectWorkItems(
  workspace: WorkspaceV2,
  projectId: string,
): ProjectWorkItem[] {
  return workspace.workItems
    .filter(
      (item) =>
        item.projectId === projectId &&
        item.resultStatus === undefined,
    )
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

export function validateCloseDecisionDraft(
  workspace: WorkspaceV2,
  project: ProjectV2,
  draft: CloseDecisionDraft,
  actorId: string,
  now: ISODate,
  commandType: "close_project" | "abandon_project",
): CloseValidationIssue | undefined {
  const gate = `project:${project.id}:${
    commandType === "close_project" ? "close_decision" : "abandon_decision"
  }`;
  const briefMatches = workspace.directionBriefs.filter(
    (brief) =>
      brief.id === project.activeDirectionBriefId &&
      brief.projectId === project.id,
  );
  const followUpId = draft.followUpProjectId?.trim();
  const hasValidFollowUpSemantics =
    draft.unfinishedDisposition === "follow_up_project"
      ? followUpId !== undefined &&
        followUpId.length > 0 &&
        draft.followUpProjectId === followUpId
      : draft.followUpProjectId === undefined;

  if (
    draft.id.trim().length === 0 ||
    draft.id !== draft.id.trim() ||
    draft.projectId !== project.id ||
    draft.successComparison.trim().length === 0 ||
    !outcomes.has(draft.outcome) ||
    draft.keyLearning.trim().length === 0 ||
    !dispositions.has(draft.unfinishedDisposition) ||
    !hasValidFollowUpSemantics ||
    actorId.trim().length === 0 ||
    !isCanonicalTimestamp(now) ||
    !isCanonicalTimestamp(project.createdAt) ||
    Date.parse(now) < Date.parse(project.createdAt) ||
    briefMatches.length !== 1 ||
    briefMatches[0].successEvidence.trim().length === 0 ||
    !isCanonicalTimestamp(briefMatches[0].createdAt) ||
    Date.parse(now) < Date.parse(briefMatches[0].createdAt)
  ) {
    return {
      code: "INVALID_COMMAND",
      reason:
        "Close requires one success-evidence comparison, outcome, key learning, unfinished-work disposition, human actor, and canonical timestamp.",
      gate,
      permittedNextCommand: commandType,
    };
  }

  const requirements = workspace.workItems
    .filter(
      (item) =>
        item.projectId === project.id && isConcreteEvidenceRequirement(item),
    )
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
  for (const requirement of requirements) {
    const status = requirementStatus(
      workspace,
      project.id,
      requirement.id,
      now,
    );
    if (!status.satisfied) {
      return {
        code: status.code,
        reason:
          status.code === "EXCEPTION_EXPIRED"
            ? `Evidence exception ${status.exceptionId} expired before Project ${project.id} could Close.`
            : `Project ${project.id} still requires evidence for ${requirement.id} before Close.`,
        gate: `project:${project.id}:evidence:${requirement.id}`,
        permittedNextCommand: "attach_evidence",
      };
    }
  }

  return undefined;
}

export function buildCloseArtifacts(
  workspace: WorkspaceV2,
  project: ProjectV2,
  draft: CloseDecisionDraft,
  actorId: string,
  now: ISODate,
): CloseArtifacts {
  const unfinished = unfinishedProjectWorkItems(workspace, project.id);
  const decision: CloseDecision = {
    ...structuredClone(draft),
    successComparison: draft.successComparison.trim(),
    keyLearning: draft.keyLearning.trim(),
    ...(draft.followUpProjectId === undefined
      ? {}
      : { followUpProjectId: draft.followUpProjectId.trim() }),
    actorId,
    closedAt: now,
  };
  const returnedInboxItems =
    draft.unfinishedDisposition === "return_to_inbox"
      ? unfinished.map<InboxItem>((item) => ({
          id: returnedInboxItemId(draft.id, item.id),
          originalText: item.title,
          sourceId: item.id,
          actorId,
          capturedAt: now,
          triageStatus: "untriaged",
        }))
      : [];

  if (
    draft.unfinishedDisposition !== "follow_up_project" ||
    decision.followUpProjectId === undefined
  ) {
    return { decision, returnedInboxItems };
  }

  const followUpBriefId = followUpDirectionBriefId(
    draft.id,
    decision.followUpProjectId,
  );
  const unfinishedIds = unfinished.map(({ id }) => id);
  const provenance = `Follow-up from Project ${project.id}; unfinished Work Items ${JSON.stringify(
    unfinishedIds,
  )}.`;
  return {
    decision,
    returnedInboxItems,
    followUpProject: {
      id: decision.followUpProjectId,
      name: `${project.name} follow-up`,
      priority: project.priority,
      notes: provenance,
      stage: "direction",
      holds: [],
      activeDirectionBriefId: followUpBriefId,
      createdAt: now,
      updatedAt: now,
    },
    followUpBrief: {
      id: followUpBriefId,
      projectId: decision.followUpProjectId,
      version: 1,
      audienceAndProblem: "",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [],
      noGoOrKill: "",
      advancedNotes: provenance,
      createdAt: now,
      updatedAt: now,
    },
  };
}
