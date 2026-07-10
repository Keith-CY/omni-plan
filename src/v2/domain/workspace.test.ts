import { describe, expect, it } from "vitest";

import type { JsonValue } from "./types";
import { stableHash } from "./stableHash";
import { createEmptyWorkspaceV2 } from "./workspace";
import { buildInboxItem, buildWorkspaceV2 } from "../tests/builders";

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

  it("orders distinct canonically equivalent Unicode keys deterministically", async () => {
    const composed = "é";
    const decomposed = "e\u0301";
    const composedFirst = { [composed]: 1, [decomposed]: 2 };
    const decomposedFirst = { [decomposed]: 2, [composed]: 1 };

    expect(await stableHash(composedFirst)).toBe(
      await stableHash(decomposedFirst),
    );
  });

  it("canonicalizes non-finite numbers as null", async () => {
    const runtimeNaN = Number.NaN as JsonValue;

    expect(await stableHash(runtimeNaN)).toBe(await stableHash(null));
  });

  it("canonicalizes sparse array holes as null", async () => {
    const sparseArray = Array(1) as JsonValue;

    expect(await stableHash(sparseArray)).toBe(await stableHash([null]));
  });

  it("does not collapse sparse arrays to empty arrays", async () => {
    const sparseArray = Array(1) as JsonValue;

    expect(await stableHash(sparseArray)).not.toBe(await stableHash([]));
  });

  it("canonicalizes runtime undefined array elements as null", async () => {
    const runtimeUndefinedArray = [undefined] as unknown as JsonValue;

    expect(await stableHash(runtimeUndefinedArray)).toBe(
      await stableHash([null]),
    );
  });

  it("preserves array order", async () => {
    expect(await stableHash([1, 2])).not.toBe(await stableHash([2, 1]));
  });

  it("matches the known SHA-256 vector for canonical JSON", async () => {
    expect(await stableHash({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
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

  it("retains defaults when an override is explicitly undefined", () => {
    expect(
      buildInboxItem({
        id: "inbox-1",
        sourceId: "source-1",
        actorId: "actor-1",
        capturedAt: "2026-07-10T09:00:00.000Z",
        originalText: undefined,
      }).originalText,
    ).toBe("Captured item");
  });

  it("protects workspace identity and schema from wide overrides", () => {
    const wideOverrides = {
      schemaVersion: 1,
      workspaceId: "workspace-override",
      revision: undefined,
    };

    expect(buildWorkspaceV2("workspace-1", wideOverrides)).toMatchObject({
      schemaVersion: 2,
      workspaceId: "workspace-1",
      revision: 0,
    });
  });
});
