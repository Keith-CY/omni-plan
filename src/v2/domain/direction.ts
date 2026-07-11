import type { Id, ISODate } from "@/domain/types";

import type { DirectionBriefDraft } from "./commands";
import { stableHash } from "./stableHash";
import type { BetVersion, DirectionBrief, JsonValue } from "./types";

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
      Number.isFinite(brief.appetiteSeconds) && brief.appetiteSeconds > 0,
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
  return (
    (await stableHash(materialDirectionValue(before))) !==
    (await stableHash(materialDirectionValue(after)))
  );
}

export async function buildBetVersion(
  brief: DirectionBrief,
  input: {
    id: Id;
    version: number;
    actorId: Id;
    approvedAt: ISODate;
    supersedesId?: Id;
  },
): Promise<BetVersion> {
  const briefSnapshot = structuredClone(brief);
  const appetiteStart = input.approvedAt;
  const appetiteEnd = new Date(
    new Date(appetiteStart).getTime() + brief.appetiteSeconds * 1_000,
  ).toISOString();

  return {
    id: input.id,
    projectId: brief.projectId,
    version: input.version,
    briefId: brief.id,
    briefHash: await stableHash(brief as unknown as JsonValue),
    briefSnapshot,
    committedScope: structuredClone(brief.firstScope),
    appetiteStart,
    appetiteEnd,
    actorId: input.actorId,
    approvedAt: input.approvedAt,
    ...(input.supersedesId === undefined
      ? {}
      : { supersedesId: input.supersedesId }),
  } satisfies BetVersion;
}
