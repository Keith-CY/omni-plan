import type { Id } from "@/domain/types";

import type {
  BetVersion,
  CapacityProfile,
  DirectionBrief,
  InboxItem,
  ProjectV2,
  WorkspaceV2,
} from "../domain/types";
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
