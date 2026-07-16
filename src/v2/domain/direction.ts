import type { Id, ISODate } from "@/domain/types";

import type { DirectionBriefDraft } from "./commands";
import { stableHash } from "./stableHash";
import type {
  BetReplacementReason,
  BetVersion,
  DirectionBrief,
  JsonValue,
} from "./types";

const materialDirectionFields = [
  "audienceAndProblem",
  "successEvidence",
  "appetiteSeconds",
  "validationMethod",
  "firstScope",
  "noGoOrKill",
] as const satisfies readonly (keyof DirectionBrief)[];

export function directionCompleteness(brief: DirectionBriefDraft) {
  return {
    audienceAndProblem: brief.audienceAndProblem.trim().length > 0,
    successEvidence: brief.successEvidence.trim().length > 0,
    appetite:
      Number.isSafeInteger(brief.appetiteSeconds) && brief.appetiteSeconds > 0,
    validationMethod: brief.validationMethod.trim().length > 0,
    firstScope:
      brief.firstScope.length > 0 &&
      brief.firstScope.every((scope) => scope.title.trim().length > 0),
    noGoOrKill: brief.noGoOrKill.trim().length > 0,
  };
}

export function isDirectionComplete(brief: DirectionBriefDraft): boolean {
  return Object.values(directionCompleteness(brief)).every(Boolean);
}

function materialDirectionValue(brief: DirectionBrief): JsonValue {
  return Object.fromEntries(
    materialDirectionFields.map((field) => [field, brief[field]]),
  ) as JsonValue;
}

export async function isMaterialDirectionChange(
  before: DirectionBrief,
  after: DirectionBrief,
): Promise<boolean> {
  const beforeSnapshot = structuredClone(before);
  const afterSnapshot = structuredClone(after);
  const beforeHash = stableHash(materialDirectionValue(beforeSnapshot));
  const afterHash = stableHash(materialDirectionValue(afterSnapshot));

  return (await beforeHash) !== (await afterHash);
}

export async function buildBetVersion(
  brief: DirectionBrief,
  input: {
    id: Id;
    version: number;
    actorId: Id;
    approvedAt: ISODate;
    supersedesId?: Id;
    replacementReason?: BetReplacementReason;
    sourceReviewId?: Id;
  },
): Promise<BetVersion> {
  const briefSnapshot = structuredClone(brief);
  const inputSnapshot = structuredClone(input);
  const committedScope = structuredClone(briefSnapshot.firstScope);
  const briefHash = stableHash(briefSnapshot as unknown as JsonValue);
  const appetiteStart = inputSnapshot.approvedAt;
  const appetiteEnd = new Date(
    new Date(appetiteStart).getTime() +
      briefSnapshot.appetiteSeconds * 1_000,
  ).toISOString();

  return {
    id: inputSnapshot.id,
    projectId: briefSnapshot.projectId,
    version: inputSnapshot.version,
    briefId: briefSnapshot.id,
    briefHash: await briefHash,
    briefSnapshot,
    committedScope,
    appetiteStart,
    appetiteEnd,
    actorId: inputSnapshot.actorId,
    approvedAt: inputSnapshot.approvedAt,
    ...(inputSnapshot.supersedesId === undefined
      ? {}
      : { supersedesId: inputSnapshot.supersedesId }),
    ...(inputSnapshot.replacementReason === undefined
      ? {}
      : { replacementReason: inputSnapshot.replacementReason }),
    ...(inputSnapshot.sourceReviewId === undefined
      ? {}
      : { sourceReviewId: inputSnapshot.sourceReviewId }),
  } satisfies BetVersion;
}
