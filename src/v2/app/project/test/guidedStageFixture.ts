import { vi } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../../../domain/commands";
import { generateTodayProposal } from "../../../domain/today";
import type {
  ProjectWorkItem,
  WorkspaceV2,
} from "../../../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../../../tests/builders";
import type { V2WorkspaceRuntime } from "../../state/V2WorkspaceProvider";

export const GUIDED_NOW = "2026-07-16T03:00:00.000Z";
export const GUIDED_PROJECT_ID = "project:guided-operations";
export const GUIDED_REQUIREMENT_ID = "work:validation-milestone";
export const GUIDED_UNFINISHED_ID = "work:unfinished-follow-up";

const BRIEF_ID = "direction:guided-operations";
const BET_ID = "bet:guided-operations";
const COMMITMENT_ID = "commitment:guided-operations";
const SCOPE_ID = "scope:guided-operations";

export function planningWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: BRIEF_ID,
    projectId: GUIDED_PROJECT_ID,
    audienceAndProblem: "Independent teams lose the decision trail during delivery.",
    successEvidence: "Five teams complete the guided lifecycle without raw status edits.",
    appetiteSeconds: 345_600,
    validationMethod: "Observe five end-to-end guided runs.",
    firstScope: [{
      id: SCOPE_ID,
      title: "Guided delivery boundary",
      description: "Execute, evidence, and close one bounded result.",
    }],
    noGoOrKill: "Stop if a protected transition can be bypassed.",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: BET_ID,
    projectId: GUIDED_PROJECT_ID,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-15T00:00:00.000Z",
    appetiteEnd: "2026-07-19T00:00:00.000Z",
    actorId: "human-ui",
    approvedAt: "2026-07-15T00:00:00.000Z",
  });
  const requirement = buildProjectWorkItem({
    id: GUIDED_REQUIREMENT_ID,
    projectId: GUIDED_PROJECT_ID,
    betScopeId: SCOPE_ID,
    kind: "milestone",
    title: "Validate the guided lifecycle",
    outline: "Prove the intended outcome with concrete evidence.",
    evidenceRequired: true,
    percentComplete: 80,
  });
  const unfinished = buildProjectWorkItem({
    id: GUIDED_UNFINISHED_ID,
    projectId: GUIDED_PROJECT_ID,
    betScopeId: SCOPE_ID,
    title: "Document the optional follow-up",
    outline: "Keep unfinished work visible for an explicit Close disposition.",
    percentComplete: 40,
  });
  const workItems: ProjectWorkItem[] = [requirement, unfinished];
  return buildWorkspaceV2("personal", {
    revision: 7,
    capacityProfile: buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [{ weekday: 4, startMinute: 180, finishMinute: 480 }],
      dailyBudgets: [{
        weekday: 4,
        deepSeconds: 7_200,
        mediumSeconds: 7_200,
        shallowSeconds: 7_200,
      }],
      unavailableBlocks: [],
      updatedAt: GUIDED_NOW,
      updatedBy: "human-ui",
    }),
    projects: [buildProjectV2({
      id: GUIDED_PROJECT_ID,
      name: "Guide delivery without status editing",
      stage: "planning",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: brief.createdAt,
      updatedAt: brief.updatedAt,
    })],
    directionBriefs: [brief],
    bets: [bet],
    workItems,
  });
}

export async function executingWorkspace(): Promise<WorkspaceV2> {
  const planning = planningWorkspace();
  const proposal = await generateTodayProposal(
    planning,
    "2026-07-16",
    GUIDED_NOW,
  );
  return applyFixtureCommand(
    planning,
    {
      type: "commit_today",
      commitment: {
        id: COMMITMENT_ID,
        localDate: proposal.localDate,
        workspaceRevision: proposal.workspaceRevision,
        generatedAt: proposal.generatedAt,
        proposalHash: proposal.proposalHash,
        slots: structuredClone(proposal.slots),
      },
    },
    "fixture:commit-today",
  );
}

export async function applyFixtureCommand(
  source: WorkspaceV2,
  command: V2Command,
  commandId: string,
  now = GUIDED_NOW,
): Promise<WorkspaceV2> {
  const context: CommandContext = {
    commandId,
    expectedRevision: source.revision,
    actorId: "human-ui",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "guided-stage-fixture",
      verified: true,
      capabilities: ["human_decision"],
    },
    now,
  };
  const result = await executeCommand(structuredClone(source), command, context);
  if (!result.ok) throw new Error(result.rejection.reason);
  return result.workspace;
}

export async function validatingWorkspace(
  withEvidence = false,
): Promise<WorkspaceV2> {
  const validating = await applyFixtureCommand(
    await executingWorkspace(),
    { type: "request_validation", projectId: GUIDED_PROJECT_ID },
    "fixture:request-validation",
  );
  if (!withEvidence) return validating;
  return applyFixtureCommand(
    validating,
    {
      type: "attach_evidence",
      evidence: {
        id: "evidence:guided-validation",
        kind: "metric",
        summary: "Five teams completed the guided lifecycle without help.",
        projectId: GUIDED_PROJECT_ID,
        workItemId: GUIDED_REQUIREMENT_ID,
        createdAt: GUIDED_NOW,
        confidence: 0.9,
        tags: [],
      },
    },
    "fixture:attach-evidence",
  );
}

export async function planlessValidatingWorkspace(
  withEvidence = false,
): Promise<WorkspaceV2> {
  const validating = await applyFixtureCommand(
    planningWorkspace(),
    { type: "request_validation", projectId: GUIDED_PROJECT_ID },
    "fixture:request-planless-validation",
  );
  if (!withEvidence) return validating;
  return applyFixtureCommand(
    validating,
    {
      type: "attach_evidence",
      evidence: {
        id: "evidence:guided-planless-validation",
        kind: "metric",
        summary: "Planning stopped with a concrete validation result.",
        projectId: GUIDED_PROJECT_ID,
        workItemId: GUIDED_REQUIREMENT_ID,
        createdAt: GUIDED_NOW,
        confidence: 0.9,
        tags: [],
      },
    },
    "fixture:attach-planless-evidence",
  );
}

export async function planlessClosingWorkspace(): Promise<WorkspaceV2> {
  const validating = await planlessValidatingWorkspace(true);
  return applyFixtureCommand(
    validating,
    { type: "satisfy_validation", projectId: GUIDED_PROJECT_ID },
    "fixture:satisfy-planless-validation",
  );
}

export function addUnrelatedSyncHold(
  workspace: WorkspaceV2,
): WorkspaceV2 {
  const reviewId = "review:unrelated-sync-record";
  const conflictId = "conflict:unrelated-sync-record";
  workspace.reviews.push({
    id: reviewId,
    kind: "event",
    triggerKey: "unrelated-sync-record",
    triggerType: "sync_conflict",
    status: "completed",
    affectedProjectIds: [],
    affectedRecordIds: [],
    dueAt: GUIDED_NOW,
    createdAt: GUIDED_NOW,
    conclusion: {
      summary: "An unrelated record was already reviewed.",
      decisionCodes: ["retain_local"],
      followUpCommandIds: [],
      actorId: "human-ui",
      completedAt: GUIDED_NOW,
    },
  });
  workspace.syncConflicts.push({
    id: conflictId,
    recordType: "review",
    recordId: reviewId,
    commonAncestorHash: "unrelated-ancestor",
    localValue: { side: "local" },
    remoteValue: { side: "remote" },
    openedAt: GUIDED_NOW,
  });
  workspace.projects[0].holds.push({
    type: "sync_conflict",
    sourceId: conflictId,
    affectedRecordIds: [reviewId],
    createdAt: GUIDED_NOW,
  });
  return workspace;
}

export async function closingWorkspace(): Promise<WorkspaceV2> {
  const validating = await validatingWorkspace(true);
  return applyFixtureCommand(
    validating,
    { type: "satisfy_validation", projectId: GUIDED_PROJECT_ID },
    "fixture:satisfy-validation",
  );
}

export async function expiredValidatingWorkspace(): Promise<WorkspaceV2> {
  const validating = await validatingWorkspace(true);
  const appetiteEnd = validating.bets.find(
    ({ id }) => id === validating.projects[0].activeBetId,
  )?.appetiteEnd;
  if (appetiteEnd === undefined) throw new Error("Expected active Bet appetite");
  const result = await executeCommand(
    validating,
    {
      type: "record_bet_boundary",
      projectId: GUIDED_PROJECT_ID,
      boundary: "expired",
      triggerKey: `${validating.projects[0].activeBetId}:expired`,
    },
    {
      commandId: "fixture:record-expired-boundary",
      expectedRevision: validating.revision,
      actorId: "system-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "guided-system-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      now: appetiteEnd,
    },
  );
  if (!result.ok) throw new Error(result.rejection.reason);
  return result.workspace;
}

export interface ProjectRuntimeHarness {
  runtime: V2WorkspaceRuntime;
  commands: V2Command[];
  contexts: CommandContext[];
  current(): WorkspaceV2;
}

export function projectRuntime(
  initial: WorkspaceV2,
  options: {
    beforeExecute?(): Promise<void>;
    now?(): string;
  } = {},
): ProjectRuntimeHarness {
  let current = structuredClone(initial);
  let commandSequence = 0;
  const commands: V2Command[] = [];
  const contexts: CommandContext[] = [];
  const runtime: V2WorkspaceRuntime = {
    bootstrap: {
      resolve: vi.fn(async () => ({
        status: "ready" as const,
        workspace: current,
      })),
    },
    commands: {
      dispatch: vi.fn(async (command, context) => {
        commands.push(structuredClone(command));
        contexts.push(structuredClone(context));
        await options.beforeExecute?.();
        const result = await executeCommand(current, command, context);
        if (result.ok) current = result.workspace;
        return result;
      }),
    },
    systemEvents: {
      run: vi.fn(async () => current),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: options.now ?? (() => GUIDED_NOW),
    createCommandId: () => `guided-stage:${++commandSequence}`,
  };
  return { runtime, commands, contexts, current: () => current };
}
