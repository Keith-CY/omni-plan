import { describe, expect, it, vi } from "vitest";

import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  betIntegrityIssue,
  directionSnapshotIntegrityIssue,
} from "./betIntegrity";
import { validateWorkspaceInvariants } from "./invariants";
import * as stableHashModule from "./stableHash";

const APPROVED_AT = "2026-07-16T03:00:00.000Z";

function validBet() {
  const brief = buildDirectionBrief({
    id: "direction:security",
    projectId: "project:security",
    appetiteSeconds: 3_600,
    firstScope: [{
      id: "scope:one",
      title: "One",
      description: "Bounded.",
    }],
    createdAt: "2026-07-15T01:00:00.000Z",
    updatedAt: "2026-07-15T02:00:00.000Z",
  });
  return buildBetVersion({
    id: "bet:security",
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

describe("bounded Bet integrity verification", () => {
  it("rejects unknown snapshot and scope fields before synchronous hashing", () => {
    const bet = validBet();
    Object.assign(bet.briefSnapshot, { unbounded: "x".repeat(1_000_000) });
    Object.assign(bet.briefSnapshot.firstScope[0], {
      unbounded: "x".repeat(1_000_000),
    });
    const hash = vi.spyOn(stableHashModule, "stableHashSync");

    expect(betIntegrityIssue(bet, APPROVED_AT)).toMatch(/unknown own field/i);
    expect(hash).not.toHaveBeenCalled();
  });

  it("fails closed on symbols and accessors without invoking them", () => {
    const symbolBet = validBet();
    Object.defineProperty(symbolBet.briefSnapshot, Symbol("extra"), {
      enumerable: true,
      value: "unexpected",
    });
    expect(betIntegrityIssue(symbolBet, APPROVED_AT)).toMatch(
      /unknown own field/i,
    );

    const accessorBet = validBet();
    Object.defineProperty(accessorBet.briefSnapshot, "advancedNotes", {
      enumerable: true,
      get() {
        throw new Error("must not invoke persisted accessors");
      },
    });
    expect(() => betIntegrityIssue(accessorBet, APPROVED_AT)).not.toThrow();
    expect(betIntegrityIssue(accessorBet, APPROVED_AT)).toMatch(
      /own data properties/i,
    );
  });

  it("rejects non-exact scope arrays before hashing or invoking accessors", () => {
    const extraFieldBet = validBet();
    Object.assign(extraFieldBet.briefSnapshot.firstScope, {
      extra: "x".repeat(1_000_000),
    });
    const hash = vi.spyOn(stableHashModule, "stableHashSync");
    const beforeExtraFieldCheck = hash.mock.calls.length;

    expect(betIntegrityIssue(extraFieldBet, APPROVED_AT)).toMatch(
      /unknown own field/i,
    );
    expect(hash).toHaveBeenCalledTimes(beforeExtraFieldCheck);

    const symbolFieldBet = validBet();
    Object.defineProperty(symbolFieldBet.committedScope, Symbol("extra"), {
      enumerable: true,
      value: "unexpected",
    });
    const beforeSymbolFieldCheck = hash.mock.calls.length;
    expect(betIntegrityIssue(symbolFieldBet, APPROVED_AT)).toMatch(
      /unknown own field/i,
    );
    expect(hash).toHaveBeenCalledTimes(beforeSymbolFieldCheck);

    const accessorBet = validBet();
    const getter = vi.fn(() => {
      throw new Error("must not invoke persisted array accessors");
    });
    Object.defineProperty(accessorBet.briefSnapshot.firstScope, "0", {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    expect(() => betIntegrityIssue(accessorBet, APPROVED_AT)).not.toThrow();
    expect(betIntegrityIssue(accessorBet, APPROVED_AT)).toMatch(
      /enumerable own data properties/i,
    );
    expect(getter).not.toHaveBeenCalled();

    const sparseBet = validBet();
    delete sparseBet.committedScope[0];
    expect(betIntegrityIssue(sparseBet, APPROVED_AT)).toMatch(
      /unknown own field|dense data array/i,
    );

    const subclassBet = validBet();
    Object.setPrototypeOf(
      subclassBet.committedScope,
      Object.create(Array.prototype),
    );
    expect(betIntegrityIssue(subclassBet, APPROVED_AT)).toMatch(
      /plain dense data array/i,
    );
  });

  it("applies one aggregate budget to snapshot and committed scope", () => {
    const description = "x".repeat(140_000);
    const brief = buildDirectionBrief({
      id: "direction:aggregate",
      projectId: "project:aggregate",
      appetiteSeconds: 3_600,
      firstScope: [{ id: "scope:one", title: "One", description }],
      createdAt: "2026-07-15T01:00:00.000Z",
      updatedAt: "2026-07-15T02:00:00.000Z",
    });
    const bet = buildBetVersion({
      id: "bet:aggregate",
      projectId: brief.projectId,
      briefId: brief.id,
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: APPROVED_AT,
      appetiteEnd: "2026-07-16T04:00:00.000Z",
      actorId: "human",
      approvedAt: APPROVED_AT,
    });
    expect(directionSnapshotIntegrityIssue(brief, APPROVED_AT)).toBeUndefined();
    const hash = vi.spyOn(stableHashModule, "stableHashSync");

    expect(betIntegrityIssue(bet, APPROVED_AT)).toMatch(/verification limit/i);
    expect(hash).not.toHaveBeenCalled();
  });

  it("counts escaped multi-byte JSON at the exact accepted boundary", () => {
    const brief = validBet().briefSnapshot;
    let low = 0;
    let high = 70_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      brief.advancedNotes = "😀".repeat(middle);
      if (directionSnapshotIntegrityIssue(brief, APPROVED_AT) === undefined) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }

    brief.advancedNotes = "😀".repeat(low);
    expect(directionSnapshotIntegrityIssue(brief, APPROVED_AT)).toBeUndefined();
    brief.advancedNotes += "😀";
    expect(directionSnapshotIntegrityIssue(brief, APPROVED_AT)).toMatch(
      /verification limit/i,
    );
  });

  it("revalidates a mutated object instead of reusing identity state", () => {
    const bet = validBet();
    expect(betIntegrityIssue(bet, APPROVED_AT)).toBeUndefined();

    bet.briefSnapshot.firstScope[0].description = "Mutated after validation.";
    bet.committedScope[0].description = "Mutated after validation.";
    expect(betIntegrityIssue(bet, APPROVED_AT)).toMatch(/hash/i);

    Object.assign(bet.briefSnapshot, { extra: "unexpected" });
    expect(betIntegrityIssue(bet, APPROVED_AT)).toMatch(/unknown own field/i);
  });

  it("hashes each Bet once per synchronous invariant validation", () => {
    const bet = validBet();
    const project = buildProjectV2({
      id: bet.projectId,
      stage: "planning",
      activeDirectionBriefId: bet.briefId,
      activeBetId: bet.id,
      createdAt: bet.briefSnapshot.createdAt,
      updatedAt: bet.approvedAt,
    });
    const workspace = buildWorkspaceV2("workspace:security", {
      projects: [project],
      directionBriefs: [bet.briefSnapshot],
      bets: [bet],
    });
    const hash = vi.spyOn(stableHashModule, "stableHashSync");

    expect(validateWorkspaceInvariants(workspace, APPROVED_AT)).toEqual([]);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(validateWorkspaceInvariants(workspace, APPROVED_AT)).toEqual([]);
    expect(hash).toHaveBeenCalledTimes(2);
  });
});
