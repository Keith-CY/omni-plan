import { describe, expect, it } from "vitest";

import { stableHash } from "./stableHash";
import { createEmptyWorkspaceV2 } from "./workspace";
import { buildInboxItem } from "../tests/builders";

describe("createEmptyWorkspaceV2", () => {
  it("creates the complete schema without an implied commitment", () => {
    expect(createEmptyWorkspaceV2("workspace-1")).toEqual({
      schemaVersion: 2,
      workspaceId: "workspace-1",
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
    });
  });
});

describe("stableHash", () => {
  it("ignores object insertion order", async () => {
    expect(await stableHash({ b: 2, a: 1 })).toBe(
      await stableHash({ a: 1, b: 2 }),
    );
  });

  it("ignores nested object insertion order", async () => {
    expect(await stableHash({ outer: { b: 2, a: 1 } })).toBe(
      await stableHash({ outer: { a: 1, b: 2 } }),
    );
  });
});

describe("V2 test builders", () => {
  it("uses caller-supplied identity and time deterministically", () => {
    const input = {
      id: "inbox-1",
      sourceId: "source-1",
      actorId: "actor-1",
      capturedAt: "2026-07-10T09:00:00.000Z",
    } as const;

    const expected = {
      ...input,
      originalText: "Captured item",
      triageStatus: "untriaged",
    };

    expect(buildInboxItem(input)).toEqual(expected);
    expect(buildInboxItem(input)).toEqual(buildInboxItem(input));
  });
});
