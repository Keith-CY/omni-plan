import { describe, expect, it } from "vitest";

import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  betIntegrityIssue,
  betReplacementProvenanceIssue,
  directionSnapshotIntegrityIssue,
} from "./betIntegrity";
import { stableHashSync } from "./stableHash";
import type { JsonValue } from "./types";

const APPROVED_AT = "2026-07-16T03:00:00.000Z";

function validBet() {
  const brief = buildDirectionBrief({
    id: "direction:integrity",
    projectId: "project:integrity",
    appetiteSeconds: 3_600,
    firstScope: [{ id: "scope:one", title: "One", description: "Bounded." }],
    createdAt: "2026-07-15T01:00:00.000Z",
    updatedAt: "2026-07-15T02:00:00.000Z",
  });
  return buildBetVersion({
    id: "bet:integrity",
    projectId: brief.projectId,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: APPROVED_AT,
    appetiteEnd: "2026-07-16T04:00:00.000Z",
    actorId: "human",
    approvedAt: APPROVED_AT,
  });
}

describe("Bet integrity", () => {
  it("does not activate a Bet before its authoritative human approval", () => {
    expect(
      betIntegrityIssue(validBet(), "2026-07-16T02:59:59.999Z"),
    ).toMatch(/future/i);
  });

  it("requires snapshot creation, update, and approval chronology", () => {
    const bet = validBet();
    bet.briefSnapshot.updatedAt = "2026-07-16T03:00:00.001Z";
    bet.briefHash = stableHashSync(
      bet.briefSnapshot as unknown as JsonValue,
    );

    expect(betIntegrityIssue(bet, APPROVED_AT)).toMatch(/chronology/i);
  });

  it("rejects oversized Direction snapshots before synchronous hashing", () => {
    const brief = validBet().briefSnapshot;
    brief.advancedNotes = "x".repeat(262_145);

    expect(directionSnapshotIntegrityIssue(brief, APPROVED_AT)).toMatch(
      /verification limit/i,
    );
  });

  it("keeps persisted expiry Re-bet provenance bound to its predecessor", () => {
    const predecessor = validBet();
    predecessor.invalidatedAt = "2026-07-16T05:00:00.000Z";
    predecessor.invalidationReason = "Superseded by Re-bet bet:replacement.";
    const replacementBrief = structuredClone(predecessor.briefSnapshot);
    replacementBrief.id = "direction:replacement";
    replacementBrief.updatedAt = "2026-07-16T04:30:00.000Z";
    const replacement = buildBetVersion({
      id: "bet:replacement",
      projectId: predecessor.projectId,
      version: 2,
      briefId: replacementBrief.id,
      briefSnapshot: replacementBrief,
      committedScope: structuredClone(replacementBrief.firstScope),
      appetiteStart: "2026-07-16T05:00:00.000Z",
      appetiteEnd: "2026-07-16T06:00:00.000Z",
      actorId: "human",
      approvedAt: "2026-07-16T05:00:00.000Z",
      supersedesId: predecessor.id,
      replacementReason: "appetite_expiry",
      sourceReviewId: `review:${predecessor.id}:expired`,
    });
    const project = buildProjectV2({
      id: predecessor.projectId,
      stage: "planning",
      activeDirectionBriefId: replacementBrief.id,
      activeBetId: replacement.id,
      createdAt: predecessor.briefSnapshot.createdAt,
      updatedAt: replacement.approvedAt,
    });
    const workspace = buildWorkspaceV2("workspace:integrity", {
      projects: [project],
      directionBriefs: [predecessor.briefSnapshot, replacementBrief],
      bets: [predecessor, replacement],
      reviews: [{
        id: `review:${predecessor.id}:expired`,
        kind: "event",
        triggerKey: `${predecessor.id}:expired`,
        triggerType: "bet_expired",
        status: "completed",
        affectedProjectIds: [project.id],
        affectedRecordIds: [predecessor.id],
        dueAt: predecessor.appetiteEnd,
        createdAt: predecessor.appetiteEnd,
        conclusion: {
          summary: "Commit a fresh bounded Bet.",
          decisionCodes: ["rebet"],
          followUpCommandIds: [],
          actorId: "human",
          completedAt: "2026-07-16T04:30:00.000Z",
        },
      }],
    });

    expect(betReplacementProvenanceIssue(workspace, replacement)).toBeUndefined();
    const untypedReplacement = structuredClone(replacement);
    delete untypedReplacement.replacementReason;
    expect(
      betReplacementProvenanceIssue(workspace, untypedReplacement),
    ).toMatch(/explicit replacement reason/i);

    delete replacement.sourceReviewId;
    predecessor.invalidatedAt = predecessor.briefSnapshot.updatedAt;
    predecessor.invalidationReason =
      "Material Direction change requires Re-bet.";
    expect(betReplacementProvenanceIssue(workspace, replacement)).toMatch(
      /appetite expiry|source Review|replacement reason/i,
    );

    replacement.replacementReason = "material_direction_change";
    predecessor.invalidatedAt = predecessor.appetiteEnd;
    replacement.briefSnapshot.createdAt = predecessor.appetiteEnd;
    replacement.briefSnapshot.updatedAt = predecessor.appetiteEnd;
    replacement.briefHash = stableHashSync(
      replacement.briefSnapshot as unknown as JsonValue,
    );
    expect(betReplacementProvenanceIssue(workspace, replacement)).toMatch(
      /pre-expiry material Direction replacement boundary/i,
    );
  });
});
