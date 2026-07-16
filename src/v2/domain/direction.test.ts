import { describe, expect, it } from "vitest";

import type { DirectionBriefDraft } from "./commands";
import {
  buildBetVersion,
  directionCompleteness,
  isDirectionComplete,
  isMaterialDirectionChange,
} from "./direction";
import { stableHash } from "./stableHash";
import type { DirectionBrief, JsonValue } from "./types";

const APPROVED_AT = "2026-07-11T09:00:00.000Z";

const COMPLETE_DRAFT: DirectionBriefDraft = {
  id: "brief-1",
  projectId: "project-1",
  audienceAndProblem: "Operators lose the next best action in planning noise.",
  successEvidence: "A user can identify and start the next action in one minute.",
  appetiteSeconds: 7_200,
  validationMethod: "Observe five users completing the workflow.",
  firstScope: [
    {
      id: "scope-1",
      title: "Guided project start",
      description: "Direction through the first committed plan.",
    },
  ],
  noGoOrKill: "Stop if the workflow needs an expert to explain it.",
  advancedNotes: "Editorial context only.",
};

function completeBrief(
  overrides: Partial<DirectionBrief> = {},
): DirectionBrief {
  return {
    ...structuredClone(COMPLETE_DRAFT),
    version: 3,
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("Direction completeness", () => {
  it("accepts exactly the six completed material decisions", () => {
    expect(directionCompleteness(COMPLETE_DRAFT)).toEqual({
      audienceAndProblem: true,
      successEvidence: true,
      appetite: true,
      validationMethod: true,
      firstScope: true,
      noGoOrKill: true,
    });
    expect(isDirectionComplete(COMPLETE_DRAFT)).toBe(true);
  });

  it.each([
    ["audience and problem", { audienceAndProblem: "   " }],
    ["success evidence", { successEvidence: "" }],
    ["positive appetite", { appetiteSeconds: 0 }],
    ["finite appetite", { appetiteSeconds: Number.POSITIVE_INFINITY }],
    ["whole-second appetite", { appetiteSeconds: 1.23456 }],
    ["validation method", { validationMethod: "\n" }],
    ["first scope", { firstScope: [] }],
    [
      "titled first scope",
      {
        firstScope: [
          { id: "scope-1", title: "   ", description: "Description" },
        ],
      },
    ],
    ["no-go or kill condition", { noGoOrKill: "" }],
  ] as const)("keeps Direction incomplete without %s", (_name, patch) => {
    const draft = { ...COMPLETE_DRAFT, ...patch } as DirectionBriefDraft;

    expect(isDirectionComplete(draft)).toBe(false);
    expect(Object.values(directionCompleteness(draft))).toContain(false);
  });
});

describe("material Direction decisions", () => {
  it.each([
    ["audienceAndProblem", "A different audience and problem"],
    ["successEvidence", "Different observable evidence"],
    ["appetiteSeconds", 10_800],
    ["validationMethod", "A different validation method"],
    [
      "firstScope",
      [{ id: "scope-2", title: "Different scope", description: "Changed" }],
    ],
    ["noGoOrKill", "A different stop condition"],
  ] as const)("treats %s as material", async (field, value) => {
    const before = completeBrief();
    const after = { ...before, [field]: value } as DirectionBrief;

    await expect(isMaterialDirectionChange(before, after)).resolves.toBe(true);
  });

  it("ignores editorial fields when deciding whether Direction changed materially", async () => {
    const before = completeBrief();
    const after = {
      ...before,
      advancedNotes: "Reformatted editorial notes.",
      updatedAt: APPROVED_AT,
    };

    await expect(isMaterialDirectionChange(before, after)).resolves.toBe(false);
  });

  it("snapshots both comparison inputs before the first hash await", async () => {
    const sameBrief = completeBrief();

    const comparison = isMaterialDirectionChange(sameBrief, sameBrief);
    sameBrief.firstScope[0].title = "Mutated while hashing";

    await expect(comparison).resolves.toBe(false);
  });
});

describe("buildBetVersion", () => {
  it("freezes the approved brief, scope, hash, actor, and exact appetite boundary", async () => {
    const brief = completeBrief({ appetiteSeconds: 7_200 });

    const bet = await buildBetVersion(brief, {
      id: "bet-1",
      version: 1,
      actorId: "human-1",
      approvedAt: APPROVED_AT,
    });

    expect(bet).toEqual({
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: "brief-1",
      briefHash: await stableHash(brief as unknown as JsonValue),
      briefSnapshot: brief,
      committedScope: brief.firstScope,
      appetiteStart: APPROVED_AT,
      appetiteEnd: "2026-07-11T11:00:00.000Z",
      actorId: "human-1",
      approvedAt: APPROVED_AT,
    });
    expect(bet.briefHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bet.briefSnapshot).not.toBe(brief);
    expect(bet.briefSnapshot.firstScope).not.toBe(brief.firstScope);
    expect(bet.committedScope).not.toBe(brief.firstScope);
    expect(bet.committedScope).not.toBe(bet.briefSnapshot.firstScope);

    brief.firstScope[0].title = "Mutated after approval";
    expect(bet.briefSnapshot.firstScope[0].title).toBe("Guided project start");
    expect(bet.committedScope[0].title).toBe("Guided project start");
  });

  it("snapshots every Bet input before the first hash await", async () => {
    const brief = completeBrief({ appetiteSeconds: 7_200 });
    const approvedBrief = structuredClone(brief);
    const approval = {
      id: "bet-async-snapshot",
      version: 2,
      actorId: "human-1",
      approvedAt: APPROVED_AT,
      supersedesId: "bet-old",
      sourceReviewId: "review:bet-old:expired",
    };
    const approvedInput = structuredClone(approval);

    const betPromise = buildBetVersion(brief, approval);
    brief.audienceAndProblem = "Mutated while hashing";
    brief.firstScope[0].title = "Mutated while hashing";
    approval.actorId = "mutated-actor";
    approval.approvedAt = "2026-07-12T09:00:00.000Z";
    approval.supersedesId = "mutated-bet";

    const bet = await betPromise;

    expect(bet.briefSnapshot).toEqual(approvedBrief);
    expect(bet.committedScope).toEqual(approvedBrief.firstScope);
    expect(bet.briefHash).toBe(
      await stableHash(approvedBrief as unknown as JsonValue),
    );
    expect(bet).toMatchObject({
      id: approvedInput.id,
      version: approvedInput.version,
      actorId: approvedInput.actorId,
      approvedAt: approvedInput.approvedAt,
      supersedesId: approvedInput.supersedesId,
      sourceReviewId: approvedInput.sourceReviewId,
      appetiteStart: approvedInput.approvedAt,
    });
  });
});
