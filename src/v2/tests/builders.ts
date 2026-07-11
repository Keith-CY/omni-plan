import type { Id } from "@/domain/types";

import type {
  BetVersion,
  CapacityProfile,
  CloseDecision,
  DirectionBrief,
  ExceptionRecord,
  InboxItem,
  ProjectWorkItem,
  ProjectV2,
  WorkspaceV2,
} from "../domain/types";
import type { CommandContext } from "../domain/commands";
import { createEmptyWorkspaceV2 } from "../domain/workspace";

type BuilderInput<T, RequiredKeys extends keyof T> = Pick<T, RequiredKeys> &
  Partial<Omit<T, RequiredKeys>>;

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

export function buildWorkspaceV2(
  workspaceId: Id,
  overrides: Partial<Omit<WorkspaceV2, "schemaVersion" | "workspaceId">> = {},
): WorkspaceV2 {
  return {
    ...createEmptyWorkspaceV2(workspaceId),
    ...withoutUndefined(overrides),
    schemaVersion: 2,
    workspaceId,
  };
}

export function buildInboxItem(
  input: BuilderInput<
    InboxItem,
    "id" | "sourceId" | "actorId" | "capturedAt"
  >,
): InboxItem {
  return {
    originalText: "Captured item",
    triageStatus: "untriaged",
    ...withoutUndefined(input),
  };
}

export function buildProjectV2(
  input: BuilderInput<
    ProjectV2,
    "id" | "activeDirectionBriefId" | "createdAt" | "updatedAt"
  >,
): ProjectV2 {
  return {
    name: "Project",
    priority: 0,
    notes: "",
    stage: "direction",
    holds: [],
    ...withoutUndefined(input),
  };
}

export function buildDirectionBrief(
  input: BuilderInput<
    DirectionBrief,
    "id" | "projectId" | "createdAt" | "updatedAt"
  >,
): DirectionBrief {
  return {
    version: 1,
    audienceAndProblem: "Audience and problem",
    successEvidence: "Success evidence",
    appetiteSeconds: 0,
    validationMethod: "Validation method",
    firstScope: [],
    noGoOrKill: "No-go or kill criteria",
    advancedNotes: "",
    ...withoutUndefined(input),
  };
}

export function buildBetVersion(
  input: BuilderInput<
    BetVersion,
    | "id"
    | "projectId"
    | "briefId"
    | "briefSnapshot"
    | "appetiteStart"
    | "appetiteEnd"
    | "actorId"
    | "approvedAt"
  >,
): BetVersion {
  return {
    version: 1,
    briefHash: "brief-hash",
    committedScope: [],
    ...withoutUndefined(input),
  };
}

export function buildCapacityProfile(
  input: BuilderInput<CapacityProfile, "updatedAt" | "updatedBy">,
): CapacityProfile {
  return {
    timeZone: "UTC",
    weeklyWindows: [],
    dailyBudgets: [],
    unavailableBlocks: [],
    ...withoutUndefined(input),
  };
}

export function buildProjectWorkItem(
  input: BuilderInput<ProjectWorkItem, "id" | "projectId" | "betScopeId">,
): ProjectWorkItem {
  return {
    kind: "task",
    title: "Property Work Item",
    outline: "Exercise one bounded result.",
    durationSeconds: 1_800,
    estimate: { mostLikelySeconds: 1_800 },
    assignmentIds: [],
    percentComplete: 0,
    revision: 1,
    ...withoutUndefined(input),
  };
}

export function buildCommandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: "property-command",
    expectedRevision: 0,
    actorId: "property-human",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "property-human-session",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: "2026-07-11T00:00:00.000Z",
    ...withoutUndefined(overrides),
  };
}

export function buildCloseDecision(
  input: BuilderInput<
    CloseDecision,
    "id" | "projectId" | "actorId" | "closedAt"
  >,
): CloseDecision {
  return {
    successComparison: "Compared the result with the success evidence.",
    outcome: "achieved",
    keyLearning: "The bounded lifecycle preserved its decisions.",
    unfinishedDisposition: "historical_incomplete",
    ...withoutUndefined(input),
  };
}

export function buildExceptionRecord(
  input: BuilderInput<
    ExceptionRecord,
    | "id"
    | "projectId"
    | "requirementId"
    | "approvedBy"
    | "createdAt"
    | "reviewAt"
    | "expiresAt"
  >,
): ExceptionRecord {
  return {
    rationale: "A bounded external dependency delays exact Evidence.",
    knownConsequence: "Validation may not rely on this after expiry.",
    history: [
      {
        action: "created",
        actorId: input.approvedBy,
        at: input.createdAt,
        note: "Approved as a controlled evidence exception.",
      },
    ],
    ...withoutUndefined(input),
  };
}
