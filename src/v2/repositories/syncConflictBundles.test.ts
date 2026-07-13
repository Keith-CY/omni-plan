import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import { deriveReviewQueue } from "../domain/review";
import { stableHash } from "../domain/stableHash";
import { createEmptyWorkspaceV2 } from "../domain/workspace";
import type {
  CommandReceipt,
  JsonValue,
  ReviewRecord,
  WorkspaceV2,
} from "../domain/types";
import { buildSyncConflictRecord } from "../domain/conflicts";
import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  applyRemoteProtectedEffectBundle,
  combineProtectedEffectBundles,
  isKnownUnprotectedLifecycleWriter,
  projectProtectedEffectBundle,
  protectedCommandLogicalKey,
  protectedEffectBundleAffectedProjectIds,
  protectedEffectBundleTouchedEntityIds,
  type ProtectedEffectBundle,
  validateProtectedEffectBundle,
  validateProtectedEffectBundlePair,
  validateProtectedEffectBundlePairMetadata,
} from "./syncConflictBundles";
import {
  authorizeConflictOpenFromBranchesV2,
  authorizePersistedConflictOpenFromVerifiedReplayV2,
} from "./syncConflictOpenAuthorization";
import {
  authorizeSyncBranchV2,
  createSyncManifestV2,
  createSyncOperationV2,
  decryptAndVerifySyncOperationV2,
  verifySyncHistoryV2,
  type VerifiedSyncReplay,
} from "./syncProtocol";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import {
  buildWorkspaceBackupV2,
  restoreVerifiedBackup,
} from "./workspaceTransfer";

const PASSPHRASE = "sync-conflict-bundle-test-passphrase";

function operationProvenance(seed: number) {
  const hash = (offset: number) =>
    (seed + offset).toString(16).padStart(64, "0");
  return {
    authorityRootOperationHash: hash(0),
    sourceOperationHash: hash(0),
    receiptHash: hash(1_000),
    payloadHash: hash(2_000),
  };
}

async function rehashBundle(
  bundle: ProtectedEffectBundle,
): Promise<ProtectedEffectBundle> {
  return {
    ...bundle,
    hash: await sha256Hex(
      canonicalJson({
        schemaVersion: bundle.schemaVersion,
        logicalKey: bundle.logicalKey,
        operations: bundle.operations,
      }),
    ),
  };
}

async function actionOnlyDailyProjection(input: {
  workspace: Readonly<WorkspaceV2>;
  id: string;
  localDate: string;
  version: number;
  createdAt: string;
  seed: number;
  supersedesId?: string;
}) {
  const value: WorkspaceV2["dailyCommitments"][number] = {
    id: input.id,
    localDate: input.localDate,
    version: input.version,
    proposalHash: `proposal:${input.id}`,
    capacitySnapshot: {
      timeZone: "UTC",
      weeklyWindows: [],
      dailyBudgets: [],
      unavailableBlocks: [],
      updatedAt: input.createdAt,
      updatedBy: `human:${input.id}`,
    },
    slots: [],
    actorId: `human:${input.id}`,
    committedAt: input.createdAt,
    ...(input.supersedesId === undefined
      ? {}
      : { supersedesId: input.supersedesId }),
  };
  const bundle = await projectProtectedEffectBundle({
    ...operationProvenance(input.seed),
    workspace: input.workspace,
    command: {
      type: "commit_today",
      commitment: {
        id: value.id,
        localDate: value.localDate,
        workspaceRevision: input.workspace.revision,
        generatedAt: input.createdAt,
        proposalHash: value.proposalHash,
        slots: [],
      },
    },
    commandId: `command:${input.id}`,
    createdAt: input.createdAt,
    diff: [
      {
        entity: "DailyCommitment",
        entityId: value.id,
        field: "created",
        before: null,
        after: value as unknown as JsonValue,
      },
    ],
  });
  if (bundle === undefined) throw new Error("Expected Daily Commitment bundle");
  return { bundle, value };
}

async function betConflictPairFixture() {
  const base = createEmptyWorkspaceV2("workspace-bundle-pair");
  const brief = buildDirectionBrief({
    id: "project-1:direction-brief:1",
    projectId: "project-1",
    appetiteSeconds: 3_600,
    firstScope: [
      {
        id: "scope-1",
        title: "Bounded scope",
        description: "Produce one inspectable result.",
      },
    ],
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  });
  base.directionBriefs.push(brief);
  base.projects.push(
    buildProjectV2({
      id: "project-1",
      stage: "awaiting_bet",
      activeDirectionBriefId: brief.id,
      createdAt: brief.createdAt,
      updatedAt: brief.updatedAt,
    }),
  );

  const place = async (side: "local" | "remote", minute: string) => {
    const command = {
      type: "place_bet" as const,
      projectId: "project-1",
      betId: `bet-${side}`,
      start: `2026-07-12T00:${minute}:00.000Z`,
    };
    const result = await executeCommand(base, command, {
      commandId: `command-${side}`,
      expectedRevision: base.revision,
      actorId: `human-${side}`,
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: `verified-human-${side}`,
        verified: true,
        capabilities: ["human_decision"],
      },
      now: command.start,
    });
    if (!result.ok) {
      throw new Error(
        `Expected ${side} Bet: ${JSON.stringify(result.rejection)}`,
      );
    }
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(side === "local" ? 701 : 702),
      workspace: base,
      command,
      commandId: result.receipt.commandId,
      createdAt: result.receipt.createdAt,
      diff: result.receipt.diff,
    });
    if (bundle === undefined) throw new Error(`Expected ${side} bundle`);
    const value = result.workspace.bets.find(({ id }) => id === command.betId);
    if (value === undefined) throw new Error(`Expected ${side} Bet value`);
    return { bundle, value, workspace: result.workspace };
  };

  const local = await place("local", "01");
  const remote = await place("remote", "02");
  const affectedRecordIds = [
    ...new Set([
      local.value.id,
      remote.value.id,
      ...protectedEffectBundleTouchedEntityIds(local.bundle),
      ...protectedEffectBundleTouchedEntityIds(remote.bundle),
    ]),
  ].sort();
  const affectedProjectIds = [
    ...new Set([
      ...protectedEffectBundleAffectedProjectIds(local.bundle),
      ...protectedEffectBundleAffectedProjectIds(remote.bundle),
    ]),
  ].sort();
  return { base, local, remote, affectedProjectIds, affectedRecordIds };
}

type BetPairFixture = Awaited<ReturnType<typeof betConflictPairFixture>>;

function validBetPairInput(fixture: BetPairFixture) {
  return {
    workspace: fixture.local.workspace,
    conflictId: "conflict-valid-bet",
    recordType: "bet" as const,
    projectId: "project-1",
    logicalKey: fixture.local.bundle.logicalKey,
    recordId: fixture.local.value.id,
    remoteRecordId: fixture.remote.value.id,
    localValue: fixture.local.value as unknown as JsonValue,
    remoteValue: fixture.remote.value as unknown as JsonValue,
    affectedRecordIds: fixture.affectedRecordIds,
    affectedProjectIds: fixture.affectedProjectIds,
    localBundle: fixture.local.bundle,
    remoteBundle: fixture.remote.bundle,
  };
}

describe("sync conflict effect bundles", () => {
  it("accepts a Bet conflict whose wrapper is bound to both bundle projections", async () => {
    const fixture = await betConflictPairFixture();

    await expect(
      validateProtectedEffectBundlePair(validBetPairInput(fixture)),
    ).resolves.toBe(true);
  });

  it("rejects incomplete, equal, mismatched-key, wrong-owner, and wrong-projection Bet pairs", async () => {
    const fixture = await betConflictPairFixture();
    const valid = validBetPairInput(fixture);
    const cases = [
      { ...valid, remoteBundle: undefined },
      {
        ...valid,
        remoteRecordId: valid.recordId,
        remoteValue: valid.localValue,
        remoteBundle: valid.localBundle,
        affectedRecordIds: protectedEffectBundleTouchedEntityIds(
          valid.localBundle,
        ),
      },
      { ...valid, logicalKey: '["bet","project-other"]' },
      { ...valid, projectId: "project-other" },
      {
        ...valid,
        remoteValue: {
          ...(valid.remoteValue as Record<string, JsonValue>),
          actorId: "forged-remote-actor",
        },
      },
    ];

    for (const candidate of cases) {
      await expect(validateProtectedEffectBundlePair(candidate)).resolves.toBe(
        false,
      );
    }
  });

  it("rejects rehashed Bet branches that name different external predecessors", async () => {
    const fixture = await betConflictPairFixture();
    const valid = validBetPairInput(fixture);
    const localBundle = structuredClone(valid.localBundle);
    const created = localBundle.operations
      .flatMap(({ cells }) => cells)
      .find((cell) => cell.kind === "create" && cell.entity === "BetVersion");
    if (
      created === undefined ||
      created.kind !== "create" ||
      created.entity !== "BetVersion"
    ) {
      throw new Error("Expected local Bet create");
    }
    created.value.supersedesId = "bet-unrelated-root";
    const rehashed = await rehashBundle(localBundle);
    const localValue = {
      ...(valid.localValue as Record<string, JsonValue>),
      supersedesId: "bet-unrelated-root",
    } as JsonValue;

    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...valid,
        localValue,
        localBundle: rehashed,
      }),
    ).resolves.toBe(false);
  });

  it("rejects branching, cyclic, and disconnected Daily supersession graphs", async () => {
    const base = createEmptyWorkspaceV2("workspace-daily-invalid-graphs");
    const localDate = "2026-07-12";
    const projection = (
      id: string,
      version: number,
      seed: number,
      supersedesId?: string,
    ) =>
      actionOnlyDailyProjection({
        workspace: base,
        id,
        localDate,
        version,
        createdAt: `2026-07-12T00:${String(seed - 750).padStart(2, "0")}:00.000Z`,
        seed,
        ...(supersedesId === undefined ? {} : { supersedesId }),
      });
    const peer = await projection("commitment-graph-peer", 1, 751);

    const branchRoot = await projection("commitment-branch-root", 1, 752);
    const branchLeft = await projection(
      "commitment-branch-left",
      2,
      753,
      branchRoot.value.id,
    );
    const branchRight = await projection(
      "commitment-branch-right",
      2,
      754,
      branchRoot.value.id,
    );

    const cycleLeft = await projection(
      "commitment-cycle-left",
      1,
      755,
      "commitment-cycle-right",
    );
    const cycleRight = await projection(
      "commitment-cycle-right",
      2,
      756,
      cycleLeft.value.id,
    );

    const disconnectedLeaf = await projection(
      "commitment-disconnected-leaf",
      1,
      757,
    );
    const disconnectedCycleLeft = await projection(
      "commitment-disconnected-cycle-left",
      2,
      758,
      "commitment-disconnected-cycle-right",
    );
    const disconnectedCycleRight = await projection(
      "commitment-disconnected-cycle-right",
      3,
      759,
      disconnectedCycleLeft.value.id,
    );

    const cases = [
      {
        name: "branching",
        projections: [branchRoot, branchLeft, branchRight],
        wrapper: branchLeft.value,
      },
      {
        name: "cycle",
        projections: [cycleLeft, cycleRight],
        wrapper: cycleLeft.value,
      },
      {
        name: "disconnected component",
        projections: [
          disconnectedLeaf,
          disconnectedCycleLeft,
          disconnectedCycleRight,
        ],
        wrapper: disconnectedLeaf.value,
      },
    ];

    for (const candidate of cases) {
      const bundle = await combineProtectedEffectBundles(
        candidate.projections.map(({ bundle }) => bundle),
      );
      await expect(
        validateProtectedEffectBundle(bundle),
        candidate.name,
      ).resolves.toBe(true);
      const affectedRecordIds = [
        ...new Set([
          candidate.wrapper.id,
          peer.value.id,
          ...protectedEffectBundleTouchedEntityIds(bundle),
          ...protectedEffectBundleTouchedEntityIds(peer.bundle),
        ]),
      ].sort();

      await expect(
        validateProtectedEffectBundlePairMetadata({
          workspace: base,
          conflictId: `conflict-daily-${candidate.name}`,
          recordType: "daily_commitment",
          projectId: undefined,
          logicalKey: bundle.logicalKey,
          recordId: candidate.wrapper.id,
          remoteRecordId: peer.value.id,
          localValue: candidate.wrapper as unknown as JsonValue,
          remoteValue: peer.value as unknown as JsonValue,
          affectedRecordIds,
          affectedProjectIds: [],
          localBundle: bundle,
          remoteBundle: peer.bundle,
        }),
        candidate.name,
      ).resolves.toBe(false);
    }
  });

  it("rejects a primary scalar identity outside the created Bet chain and its external root", async () => {
    const fixture = await betConflictPairFixture();
    const activeBrief = fixture.local.workspace.directionBriefs.find(
      ({ id }) =>
        id === fixture.local.workspace.projects[0]?.activeDirectionBriefId,
    );
    if (activeBrief === undefined)
      throw new Error("Expected active Direction Brief");
    const {
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...briefDraft
    } = activeBrief;
    const command = {
      type: "update_direction" as const,
      projectId: "project-1",
      brief: {
        ...briefDraft,
        successEvidence: "A materially different success signal.",
      },
    };
    const result = await executeCommand(fixture.local.workspace, command, {
      commandId: "command-off-chain-bet-scalar",
      expectedRevision: fixture.local.workspace.revision,
      actorId: "human-local",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "verified-human-local",
        verified: true,
        capabilities: ["human_decision"],
      },
      now: "2026-07-12T00:03:00.000Z",
    });
    if (!result.ok) {
      throw new Error(
        `Expected material Direction update: ${result.rejection.reason}`,
      );
    }
    const updateBundle = await projectProtectedEffectBundle({
      ...operationProvenance(760),
      workspace: fixture.local.workspace,
      command,
      commandId: result.receipt.commandId,
      createdAt: result.receipt.createdAt,
      diff: result.receipt.diff,
    });
    if (updateBundle === undefined) {
      throw new Error("Expected material Direction bundle");
    }
    const forged = await combineProtectedEffectBundles([
      fixture.local.bundle,
      updateBundle,
    ]);
    const updateOperation = forged.operations.find(
      ({ commandType }) => commandType === "update_direction",
    );
    if (updateOperation === undefined)
      throw new Error("Expected update operation");
    const primaryScalars = updateOperation.cells.filter(
      (cell) => cell.kind === "scalar" && cell.entity === "BetVersion",
    );
    expect(primaryScalars).toHaveLength(2);
    for (const scalar of primaryScalars) {
      if (scalar.kind !== "scalar") throw new Error("Expected Bet scalar");
      scalar.entityId = "bet-off-chain";
    }
    const rebetHold = updateOperation.cells.find(
      (cell) => cell.kind === "project_hold_delta",
    );
    if (
      rebetHold === undefined ||
      rebetHold.kind !== "project_hold_delta" ||
      rebetHold.after === null
    ) {
      throw new Error("Expected added Re-bet hold");
    }
    rebetHold.after.value.sourceId = "bet-off-chain";
    rebetHold.after.value.affectedRecordIds =
      rebetHold.after.value.affectedRecordIds.map((id) =>
        id === fixture.local.value.id ? "bet-off-chain" : id,
      );
    rebetHold.holdKey = JSON.stringify(["rebet_required", "bet-off-chain"]);
    const rehashed = await rehashBundle(forged);
    await expect(validateProtectedEffectBundle(rehashed)).resolves.toBe(true);
    const affectedRecordIds = [
      ...new Set([
        fixture.local.value.id,
        fixture.remote.value.id,
        ...protectedEffectBundleTouchedEntityIds(rehashed),
        ...protectedEffectBundleTouchedEntityIds(fixture.remote.bundle),
      ]),
    ].sort();
    const affectedProjectIds = [
      ...new Set([
        ...protectedEffectBundleAffectedProjectIds(rehashed),
        ...protectedEffectBundleAffectedProjectIds(fixture.remote.bundle),
      ]),
    ].sort();

    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...validBetPairInput(fixture),
        affectedRecordIds,
        affectedProjectIds,
        localBundle: rehashed,
      }),
    ).resolves.toBe(false);
  });

  it("binds a resolved conflict retainedVersion to the exact selected bundle hash", async () => {
    const fixture = await betConflictPairFixture();
    const valid = validBetPairInput(fixture);

    await expect(
      validateProtectedEffectBundlePair({
        ...valid,
        retainedVersion: "local",
        retainedBundleHash: valid.localBundle.hash,
      }),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePair({
        ...valid,
        retainedVersion: "local",
        retainedBundleHash: valid.remoteBundle.hash,
      }),
    ).resolves.toBe(false);
    await expect(
      validateProtectedEffectBundlePair({
        ...valid,
        retainedBundleHash: valid.localBundle.hash,
      }),
    ).resolves.toBe(false);

    const remoteWorkspace = await applyRemoteProtectedEffectBundle({
      workspace: valid.workspace,
      localBundle: valid.localBundle,
      remoteBundle: valid.remoteBundle,
      conflictId: valid.conflictId,
      now: "2026-07-12T00:04:00.000Z",
    });
    await expect(
      validateProtectedEffectBundlePair({
        ...valid,
        workspace: remoteWorkspace,
        retainedVersion: "remote",
        retainedBundleHash: valid.remoteBundle.hash,
      }),
    ).resolves.toBe(true);

    const laterWorkspace = structuredClone(remoteWorkspace);
    const laterBet = {
      ...structuredClone(fixture.remote.value),
      id: "bet-later",
      version: fixture.remote.value.version + 1,
      supersedesId: fixture.remote.value.id,
    };
    laterWorkspace.bets.push(laterBet);
    laterWorkspace.projects[0]!.activeBetId = laterBet.id;
    const historical = {
      ...valid,
      workspace: laterWorkspace,
      retainedVersion: "remote" as const,
      retainedBundleHash: valid.remoteBundle.hash,
    };
    await expect(
      validateProtectedEffectBundlePairMetadata(historical),
    ).resolves.toBe(true);
    await expect(validateProtectedEffectBundlePair(historical)).resolves.toBe(
      false,
    );

    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...historical,
        remoteValue: {
          ...(historical.remoteValue as Record<string, JsonValue>),
          id: "forged-history-id",
        },
      }),
    ).resolves.toBe(false);

    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...historical,
        remoteValue: {
          ...(historical.remoteValue as Record<string, JsonValue>),
          actorId: "forged-historical-actor",
        },
      }),
    ).resolves.toBe(false);
  });

  it("keeps a resolved remote Bet exportable after a material Direction change and completed Re-bet", async () => {
    const fixture = await betConflictPairFixture();
    const pair = validBetPairInput(fixture);
    const conflictId = "conflict-bet-history";
    const openedAt = "2026-07-12T00:03:00.000Z";
    const openCommand = {
      type: "open_sync_conflict",
      conflict: {
        id: conflictId,
        recordType: "bet",
        recordId: fixture.local.value.id,
        remoteRecordId: fixture.remote.value.id,
        logicalKey: fixture.local.bundle.logicalKey,
        affectedProjectIds: fixture.affectedProjectIds,
        affectedRecordIds: fixture.affectedRecordIds,
        commonAncestorHash: "genesis:workspace-bundle-pair",
        localValue: fixture.local.value as unknown as JsonValue,
        remoteValue: fixture.remote.value as unknown as JsonValue,
        localBundle: fixture.local.bundle,
        remoteBundle: fixture.remote.bundle,
      },
    } as const satisfies V2Command;
    const conflict = buildSyncConflictRecord(
      openCommand.conflict,
      {
        record: structuredClone(fixture.local.value) as unknown as JsonValue,
        projectIds: ["project-1"],
        projectId: "project-1",
      },
      openedAt,
    );
    const provisional = {
      ...structuredClone(fixture.local.workspace),
      syncConflicts: [conflict],
    };
    const reviewDraft = deriveReviewQueue(provisional, openedAt).find(
      ({ triggerKey }) => triggerKey === `sync_conflict:${conflictId}`,
    );
    if (reviewDraft === undefined) throw new Error("Expected conflict Review");
    const openReceiptBase: Omit<CommandReceipt, "receiptHash"> = {
      id: "open-bet-history",
      commandId: "open-bet-history",
      commandType: "open_sync_conflict",
      baseRevision: 1,
      revision: 2,
      payloadHash: await stableHash(openCommand as unknown as JsonValue),
      actorId: "sync-conflict-detector",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "verified-sync-conflict-detector",
        verified: true,
        capabilities: ["open_conflict"],
      },
      status: "applied",
      createdAt: openedAt,
      diff: [
        {
          entity: "SyncConflictRecord",
          entityId: conflictId,
          field: "created",
          before: null,
          after: structuredClone(conflict) as unknown as JsonValue,
        },
      ],
    };
    const openReceipt: CommandReceipt = {
      ...openReceiptBase,
      receiptHash: await stableHash(openReceiptBase as unknown as JsonValue),
    };
    const opened: WorkspaceV2 = {
      ...structuredClone(fixture.local.workspace),
      revision: 2,
      syncConflicts: [conflict],
      reviews: [{ ...reviewDraft, status: "open", createdAt: openedAt }],
      projects: fixture.local.workspace.projects.map((project) => ({
        ...structuredClone(project),
        holds: [
          ...structuredClone(project.holds),
          {
            type: "sync_conflict",
            sourceId: conflictId,
            affectedRecordIds: structuredClone(fixture.affectedRecordIds),
            createdAt: openedAt,
          },
        ],
        updatedAt: openedAt,
      })),
      commandReceipts: [
        ...structuredClone(fixture.local.workspace.commandReceipts),
        openReceipt,
      ],
    };
    await expect(
      validateProtectedEffectBundlePair({ ...pair, workspace: opened }),
    ).resolves.toBe(true);

    const resolved = await executeCommand(
      opened,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: fixture.remote.value as unknown as JsonValue,
          retainedBundleHash: fixture.remote.bundle.hash,
          rationale: "Keep the verified remote Bet.",
        },
      },
      {
        commandId: "resolve-bet-history",
        expectedRevision: 2,
        actorId: "resolving-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-resolving-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T00:04:00.000Z",
      },
    );
    if (!resolved.ok) {
      throw new Error(
        `Expected Bet conflict resolution: ${resolved.rejection.reason}`,
      );
    }
    const activeBrief = resolved.workspace.directionBriefs.find(
      ({ id }) => id === resolved.workspace.projects[0]?.activeDirectionBriefId,
    );
    if (activeBrief === undefined) throw new Error("Expected active Direction");
    const {
      version: _activeBriefVersion,
      createdAt: _activeBriefCreatedAt,
      updatedAt: _activeBriefUpdatedAt,
      ...activeBriefDraft
    } = activeBrief;
    const invalidated = await executeCommand(
      resolved.workspace,
      {
        type: "update_direction",
        projectId: "project-1",
        brief: {
          ...activeBriefDraft,
          audienceAndProblem:
            "A materially different operator now needs the flow.",
        },
      },
      {
        commandId: "invalidate-remote-bet",
        expectedRevision: resolved.workspace.revision,
        actorId: "resolving-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-resolving-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T00:05:00.000Z",
      },
    );
    if (!invalidated.ok) throw new Error("Expected material Direction change");
    await expect(
      buildWorkspaceBackupV2({
        snapshot: { workspace: invalidated.workspace, rejectedReceipts: [] },
        exportedAt: "2026-07-12T00:05:30.000Z",
      }),
    ).resolves.toMatchObject({ schemaVersion: 2 });

    const rebet = await executeCommand(
      invalidated.workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-after-conflict",
        start: "2026-07-12T00:06:00.000Z",
      },
      {
        commandId: "rebet-after-conflict",
        expectedRevision: invalidated.workspace.revision,
        actorId: "resolving-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-resolving-human",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T00:06:00.000Z",
      },
    );
    if (!rebet.ok) throw new Error("Expected post-conflict Re-bet");
    await expect(
      buildWorkspaceBackupV2({
        snapshot: { workspace: rebet.workspace, rejectedReceipts: [] },
        exportedAt: "2026-07-12T00:07:00.000Z",
      }),
    ).resolves.toMatchObject({
      workspace: {
        projects: [
          expect.objectContaining({ activeBetId: "bet-after-conflict" }),
        ],
      },
    });
  });

  it("rejects valid same-owner Bet bundles reparented to an unrelated Bet identity", async () => {
    const fixture = await betConflictPairFixture();
    const unrelated = {
      ...structuredClone(fixture.local.value),
      id: "bet-unrelated",
    };
    const workspace = structuredClone(fixture.local.workspace);
    workspace.bets.push(unrelated);

    await expect(
      validateProtectedEffectBundlePair({
        workspace,
        conflictId: "conflict-reparented-bet",
        recordType: "bet",
        projectId: "project-1",
        logicalKey: fixture.local.bundle.logicalKey,
        recordId: unrelated.id,
        remoteRecordId: unrelated.id,
        localValue: unrelated as unknown as JsonValue,
        remoteValue: unrelated as unknown as JsonValue,
        affectedRecordIds: [
          ...new Set([unrelated.id, ...fixture.affectedRecordIds]),
        ].sort(),
        affectedProjectIds: fixture.affectedProjectIds,
        localBundle: fixture.local.bundle,
        remoteBundle: fixture.remote.bundle,
      }),
    ).resolves.toBe(false);
  });

  it("keeps an action-only Daily Commitment conflict ownerless like lookupConflictTarget", async () => {
    const base = createEmptyWorkspaceV2("workspace-action-only-pair");
    const localDate = "2026-07-12";
    const buildSide = async (side: "local" | "remote", minute: string) => {
      const committedAt = `2026-07-12T00:${minute}:00.000Z`;
      const commitment = {
        id: `commitment-${side}`,
        localDate,
        version: 1,
        proposalHash: `proposal-${side}`,
        capacitySnapshot: {
          timeZone: "UTC",
          weeklyWindows: [],
          dailyBudgets: [],
          unavailableBlocks: [],
          updatedAt: committedAt,
          updatedBy: `human-${side}`,
        },
        slots: [
          {
            id: `slot-${side}`,
            target: { kind: "action" as const, actionId: "action-1" },
            targetRevision: 1,
            start: committedAt,
            finish: `2026-07-12T00:${String(Number(minute) + 1).padStart(2, "0")}:00.000Z`,
            attention: "deep" as const,
          },
        ],
        actorId: `human-${side}`,
        committedAt,
      };
      const command = {
        type: "commit_today" as const,
        commitment: {
          id: commitment.id,
          localDate,
          workspaceRevision: 0,
          generatedAt: committedAt,
          proposalHash: commitment.proposalHash,
          slots: commitment.slots,
        },
      };
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(side === "local" ? 711 : 712),
        workspace: base,
        command,
        commandId: `command-${side}`,
        createdAt: committedAt,
        diff: [
          {
            entity: "DailyCommitment",
            entityId: commitment.id,
            field: "created",
            before: null,
            after: commitment as unknown as JsonValue,
          },
        ],
      });
      if (bundle === undefined) throw new Error("Expected commitment bundle");
      return { bundle, commitment };
    };
    const local = await buildSide("local", "01");
    const remote = await buildSide("remote", "03");
    const workspace = structuredClone(base);
    workspace.dailyCommitments.push(local.commitment);

    const pair = {
      workspace,
      conflictId: "conflict-action-only",
      recordType: "daily_commitment",
      projectId: undefined,
      logicalKey: local.bundle.logicalKey,
      recordId: local.commitment.id,
      remoteRecordId: remote.commitment.id,
      localValue: local.commitment as unknown as JsonValue,
      remoteValue: remote.commitment as unknown as JsonValue,
      affectedRecordIds: [local.commitment.id, remote.commitment.id].sort(),
      affectedProjectIds: [],
      localBundle: local.bundle,
      remoteBundle: remote.bundle,
    } as const;
    await expect(validateProtectedEffectBundlePair(pair)).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...pair,
        retainedVersion: "local",
        retainedBundleHash: local.bundle.hash,
      }),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...pair,
        retainedVersion: "local",
        retainedBundleHash: local.bundle.hash,
        remoteValue: {
          ...(remote.commitment as unknown as Record<string, JsonValue>),
          proposalHash: "forged-historical-proposal",
        },
      }),
    ).resolves.toBe(false);
  });

  it("binds a combined Daily bundle wrapper to its unique supersession leaf", async () => {
    const base = createEmptyWorkspaceV2("workspace-daily-leaf-pair");
    const localDate = "2026-07-12";
    const first = await actionOnlyDailyProjection({
      workspace: base,
      id: "commitment-chain-1",
      localDate,
      version: 1,
      createdAt: "2026-07-12T00:01:00.000Z",
      seed: 731,
    });
    const afterFirst = structuredClone(base);
    afterFirst.dailyCommitments.push(first.value);
    const leaf = await actionOnlyDailyProjection({
      workspace: afterFirst,
      id: "commitment-chain-2",
      localDate,
      version: 2,
      createdAt: "2026-07-12T00:02:00.000Z",
      seed: 732,
      supersedesId: first.value.id,
    });
    const peer = await actionOnlyDailyProjection({
      workspace: base,
      id: "commitment-peer",
      localDate,
      version: 1,
      createdAt: "2026-07-12T00:03:00.000Z",
      seed: 733,
    });
    const combined = await combineProtectedEffectBundles([
      first.bundle,
      leaf.bundle,
    ]);
    const affectedRecordIds = [
      ...new Set([
        first.value.id,
        leaf.value.id,
        peer.value.id,
        ...protectedEffectBundleTouchedEntityIds(combined),
        ...protectedEffectBundleTouchedEntityIds(peer.bundle),
      ]),
    ].sort();
    const valid = {
      workspace: afterFirst,
      conflictId: "conflict-daily-leaf",
      recordType: "daily_commitment" as const,
      projectId: undefined,
      logicalKey: combined.logicalKey,
      recordId: leaf.value.id,
      remoteRecordId: peer.value.id,
      localValue: leaf.value as unknown as JsonValue,
      remoteValue: peer.value as unknown as JsonValue,
      affectedRecordIds,
      affectedProjectIds: [],
      localBundle: combined,
      remoteBundle: peer.bundle,
    };

    await expect(
      validateProtectedEffectBundlePairMetadata(valid),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...valid,
        recordId: first.value.id,
        localValue: first.value as unknown as JsonValue,
      }),
    ).resolves.toBe(false);
  });

  it("accepts a proposal-only Daily branch only when the created successor names that exact predecessor", async () => {
    const base = createEmptyWorkspaceV2("workspace-daily-existing-created");
    const localDate = "2026-07-12";
    const baseline = await actionOnlyDailyProjection({
      workspace: base,
      id: "commitment-existing",
      localDate,
      version: 1,
      createdAt: "2026-07-12T00:00:00.000Z",
      seed: 741,
    });
    base.dailyCommitments.push(baseline.value);
    const proposal = (
      id: string,
      createdAt: string,
    ): WorkspaceV2["replanProposals"][number] => ({
      id,
      localDate,
      baseCommitmentId: baseline.value.id,
      baseRevision: 0,
      reasonCodes: ["ACTUAL_CHANGED"],
      proposedSlots: [],
      proposalHash: `proposal-hash:${id}`,
      createdAt,
      createdBy: `human:${id}`,
      status: "open",
    });
    const localProposal = proposal(
      "proposal-local-existing",
      "2026-07-12T00:01:00.000Z",
    );
    const remoteProposal = proposal(
      "proposal-remote-created",
      "2026-07-12T00:02:00.000Z",
    );
    const proposalBundle = async (
      value: WorkspaceV2["replanProposals"][number],
      seed: number,
    ) => {
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(seed),
        workspace: base,
        command: { type: "propose_replan", proposal: value },
        commandId: `command:${value.id}`,
        createdAt: value.createdAt,
        diff: [
          {
            entity: "ReplanProposal",
            entityId: value.id,
            field: "created",
            before: null,
            after: value as unknown as JsonValue,
          },
        ],
      });
      if (bundle === undefined)
        throw new Error("Expected Replan proposal bundle");
      return bundle;
    };
    const localBundle = await proposalBundle(localProposal, 742);
    const remoteProposed = await proposalBundle(remoteProposal, 743);
    const successor: WorkspaceV2["dailyCommitments"][number] = {
      ...structuredClone(baseline.value),
      id: "commitment-created-successor",
      version: 2,
      proposalHash: remoteProposal.proposalHash,
      actorId: "human:remote-successor",
      committedAt: "2026-07-12T00:03:00.000Z",
      supersedesId: baseline.value.id,
    };
    const beforeAccept = structuredClone(base);
    beforeAccept.replanProposals.push(remoteProposal);
    const accepted = await projectProtectedEffectBundle({
      ...operationProvenance(744),
      workspace: beforeAccept,
      command: {
        type: "accept_replan",
        proposalId: remoteProposal.id,
        commitmentId: successor.id,
      },
      commandId: "command:accept-created-successor",
      createdAt: successor.committedAt,
      diff: [
        {
          entity: "DailyCommitment",
          entityId: successor.id,
          field: "created",
          before: null,
          after: successor as unknown as JsonValue,
        },
        {
          entity: "ReplanProposal",
          entityId: remoteProposal.id,
          field: "status",
          before: "open",
          after: "accepted",
        },
      ],
    });
    if (accepted === undefined)
      throw new Error("Expected accepted Replan bundle");
    const remoteBundle = await combineProtectedEffectBundles([
      remoteProposed,
      accepted,
    ]);
    const workspace = structuredClone(base);
    workspace.replanProposals.push(localProposal);
    const affectedRecordIds = [
      ...new Set([
        baseline.value.id,
        successor.id,
        ...protectedEffectBundleTouchedEntityIds(localBundle),
        ...protectedEffectBundleTouchedEntityIds(remoteBundle),
      ]),
    ].sort();
    const valid = {
      workspace,
      conflictId: "conflict-daily-existing-created",
      recordType: "daily_commitment" as const,
      projectId: undefined,
      logicalKey: localBundle.logicalKey,
      recordId: baseline.value.id,
      remoteRecordId: successor.id,
      localValue: baseline.value as unknown as JsonValue,
      remoteValue: successor as unknown as JsonValue,
      affectedRecordIds,
      affectedProjectIds: [],
      localBundle,
      remoteBundle,
    };

    await expect(validateProtectedEffectBundlePair(valid)).resolves.toBe(true);

    const forgedBundle = structuredClone(remoteBundle);
    const created = forgedBundle.operations
      .flatMap(({ cells }) => cells)
      .find(
        (cell) => cell.kind === "create" && cell.entity === "DailyCommitment",
      );
    if (
      created === undefined ||
      created.kind !== "create" ||
      created.entity !== "DailyCommitment"
    ) {
      throw new Error("Expected successor create");
    }
    created.value.supersedesId = "commitment-unrelated-root";
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...valid,
        remoteValue: {
          ...(successor as unknown as Record<string, JsonValue>),
          supersedesId: "commitment-unrelated-root",
        },
        remoteBundle: await rehashBundle(forgedBundle),
      }),
    ).resolves.toBe(false);
  });

  it("rejects scalar-only Review bundles whose mutation identity differs from the wrapper", async () => {
    const triggerKey = "hard_gate:wrapper-identity";
    const wrapper: ReviewRecord = {
      id: "review-wrapper",
      kind: "event",
      triggerKey,
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T01:00:00.000Z",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const completionBundle = async (
      id: string,
      minute: string,
      seed: number,
    ) => {
      const review = { ...wrapper, id };
      const workspace = createEmptyWorkspaceV2(`workspace-${id}`);
      workspace.reviews.push(review);
      const completedAt = `2026-07-12T00:${minute}:00.000Z`;
      const conclusion = {
        summary: `Conclusion for ${id}`,
        decisionCodes: ["continue"],
        followUpCommandIds: [],
        actorId: `human:${id}`,
        completedAt,
      };
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(seed),
        workspace,
        command: {
          type: "complete_review",
          reviewId: id,
          conclusion: {
            summary: conclusion.summary,
            decisionCodes: conclusion.decisionCodes,
            followUpCommandIds: conclusion.followUpCommandIds,
          },
        },
        commandId: `command:${id}`,
        createdAt: completedAt,
        diff: [
          {
            entity: "ReviewRecord",
            entityId: id,
            field: "status",
            before: "open",
            after: "completed",
          },
          {
            entity: "ReviewRecord",
            entityId: id,
            field: "conclusion",
            before: null,
            after: conclusion as unknown as JsonValue,
          },
        ],
      });
      if (bundle === undefined)
        throw new Error("Expected Review completion bundle");
      return bundle;
    };
    const localBundle = await completionBundle("review-local-other", "01", 751);
    const remoteBundle = await completionBundle(
      "review-remote-other",
      "02",
      752,
    );

    await expect(
      validateProtectedEffectBundlePairMetadata({
        workspace: createEmptyWorkspaceV2("workspace-review-wrapper-pair"),
        conflictId: "conflict-review-wrapper",
        recordType: "review",
        projectId: undefined,
        logicalKey: localBundle.logicalKey,
        recordId: wrapper.id,
        remoteRecordId: wrapper.id,
        localValue: wrapper as unknown as JsonValue,
        remoteValue: wrapper as unknown as JsonValue,
        affectedRecordIds: [
          wrapper.id,
          "review-local-other",
          "review-remote-other",
        ].sort(),
        affectedProjectIds: [],
        localBundle,
        remoteBundle,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a combined Close bundle containing two independently valid decisions", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-close-primary-pair");
    workspace.projects.push(
      buildProjectV2({
        id: "project-close-primary",
        activeDirectionBriefId: "brief-close-primary",
        stage: "closed",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      }),
    );
    const closeBundle = async (id: string, minute: string, seed: number) => {
      const closedAt = `2026-07-12T00:${minute}:00.000Z`;
      const decision: WorkspaceV2["closeDecisions"][number] = {
        id,
        projectId: "project-close-primary",
        successComparison: `Comparison ${id}`,
        outcome: "achieved",
        keyLearning: `Learning ${id}`,
        unfinishedDisposition: "discard",
        actorId: `human:${id}`,
        closedAt,
      };
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(seed),
        workspace,
        command: {
          type: "close_project",
          projectId: decision.projectId,
          decision: {
            id: decision.id,
            projectId: decision.projectId,
            successComparison: decision.successComparison,
            outcome: decision.outcome,
            keyLearning: decision.keyLearning,
            unfinishedDisposition: decision.unfinishedDisposition,
          },
        },
        commandId: `command:${id}`,
        createdAt: closedAt,
        diff: [
          {
            entity: "CloseDecision",
            entityId: decision.id,
            field: "created",
            before: null,
            after: decision as unknown as JsonValue,
          },
        ],
      });
      if (bundle === undefined) throw new Error("Expected Close bundle");
      return { bundle, decision };
    };
    const first = await closeBundle("close-primary-1", "01", 761);
    const second = await closeBundle("close-primary-2", "02", 762);
    const peer = await closeBundle("close-primary-peer", "03", 763);
    const combined = await combineProtectedEffectBundles([
      first.bundle,
      second.bundle,
    ]);

    await expect(
      validateProtectedEffectBundlePairMetadata({
        workspace,
        conflictId: "conflict-close-primary",
        recordType: "close",
        projectId: "project-close-primary",
        logicalKey: combined.logicalKey,
        recordId: first.decision.id,
        remoteRecordId: peer.decision.id,
        localValue: first.decision as unknown as JsonValue,
        remoteValue: peer.decision as unknown as JsonValue,
        affectedRecordIds: [
          first.decision.id,
          second.decision.id,
          peer.decision.id,
        ].sort(),
        affectedProjectIds: ["project-close-primary"],
        localBundle: combined,
        remoteBundle: peer.bundle,
      }),
    ).resolves.toBe(false);
  });

  it("rejects an Exception bundle that keeps the logical ID but changes Project owner", async () => {
    const base = createEmptyWorkspaceV2("workspace-exception-owner-pair");
    for (const id of ["project-local", "project-remote"]) {
      base.projects.push(
        buildProjectV2({
          id,
          activeDirectionBriefId: `${id}:brief:1`,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
        }),
      );
    }
    const buildSide = async (
      side: "local" | "remote",
      projectId: string,
      minute: string,
    ) => {
      const createdAt = `2026-07-12T00:${minute}:00.000Z`;
      const value = {
        id: "exception-1",
        projectId,
        requirementId: "requirement-1",
        rationale: `${side} rationale`,
        knownConsequence: `${side} consequence`,
        reviewAt: "2026-07-13T00:00:00.000Z",
        expiresAt: "2026-07-14T00:00:00.000Z",
        approvedBy: `human-${side}`,
        createdAt,
        history: [
          {
            action: "created" as const,
            actorId: `human-${side}`,
            at: createdAt,
            note: `${side} rationale`,
          },
        ],
      };
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(side === "local" ? 721 : 722),
        workspace: base,
        command: {
          type: "approve_evidence_exception",
          exception: {
            id: value.id,
            projectId,
            requirementId: value.requirementId,
            rationale: value.rationale,
            knownConsequence: value.knownConsequence,
            reviewAt: value.reviewAt,
            expiresAt: value.expiresAt,
          },
        },
        commandId: `command-${side}`,
        createdAt,
        diff: [
          {
            entity: "ExceptionRecord",
            entityId: value.id,
            field: "created",
            before: null,
            after: value as unknown as JsonValue,
          },
        ],
      });
      if (bundle === undefined) throw new Error("Expected Exception bundle");
      return { bundle, value };
    };
    const local = await buildSide("local", "project-local", "01");
    const remote = await buildSide("remote", "project-remote", "02");
    const workspace = structuredClone(base);
    workspace.exceptions.push(local.value);

    await expect(
      validateProtectedEffectBundlePair({
        workspace,
        conflictId: "conflict-exception-owner",
        recordType: "exception",
        projectId: "project-local",
        logicalKey: local.bundle.logicalKey,
        recordId: local.value.id,
        remoteRecordId: remote.value.id,
        localValue: local.value as unknown as JsonValue,
        remoteValue: remote.value as unknown as JsonValue,
        affectedRecordIds: [local.value.id],
        affectedProjectIds: ["project-local", "project-remote"],
        localBundle: local.bundle,
        remoteBundle: remote.bundle,
      }),
    ).resolves.toBe(false);

    const sameOwnerRemote = await buildSide("remote", "project-local", "03");
    const historicalPair = {
      workspace,
      conflictId: "conflict-exception-history",
      recordType: "exception" as const,
      projectId: "project-local",
      logicalKey: local.bundle.logicalKey,
      recordId: local.value.id,
      remoteRecordId: sameOwnerRemote.value.id,
      localValue: local.value as unknown as JsonValue,
      remoteValue: sameOwnerRemote.value as unknown as JsonValue,
      retainedVersion: "local" as const,
      retainedBundleHash: local.bundle.hash,
      affectedRecordIds: [local.value.id],
      affectedProjectIds: ["project-local"],
      localBundle: local.bundle,
      remoteBundle: sameOwnerRemote.bundle,
    };
    await expect(
      validateProtectedEffectBundlePairMetadata(historicalPair),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...historicalPair,
        remoteValue: {
          ...(sameOwnerRemote.value as unknown as Record<string, JsonValue>),
          rationale: "forged historical rationale",
        },
      }),
    ).resolves.toBe(false);
  });

  it("keeps ordinary lifecycle writers on the normal replay path", () => {
    const at = "2026-07-12T00:00:00.000Z";
    expect(
      isKnownUnprotectedLifecycleWriter({
        command: {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "midpoint",
          triggerKey: "bet-1:midpoint",
        },
        createdAt: at,
        diff: [],
      }),
    ).toBe(true);
    expect(
      isKnownUnprotectedLifecycleWriter({
        command: { type: "request_validation", projectId: "project-1" },
        createdAt: at,
        diff: [
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "stage",
            before: "executing",
            after: "validating",
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "updatedAt",
            before: "2026-07-11T00:00:00.000Z",
            after: at,
          },
        ],
      }),
    ).toBe(true);
    expect(
      isKnownUnprotectedLifecycleWriter({
        command: { type: "satisfy_validation", projectId: "project-1" },
        createdAt: at,
        diff: [
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "stage",
            before: "validating",
            after: "closing",
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "updatedAt",
            before: "2026-07-11T00:00:00.000Z",
            after: at,
          },
        ],
      }),
    ).toBe(true);
    const editorialBrief = buildDirectionBrief({
      id: "project-1:direction-brief:2",
      projectId: "project-1",
      version: 2,
      advancedNotes: "Editorial wording only.",
      createdAt: at,
      updatedAt: at,
    });
    expect(
      isKnownUnprotectedLifecycleWriter({
        command: {
          type: "update_direction",
          projectId: "project-1",
          brief: editorialBrief,
        },
        createdAt: at,
        diff: [
          {
            entity: "DirectionBrief",
            entityId: editorialBrief.id,
            field: "created",
            before: null,
            after: editorialBrief as unknown as JsonValue,
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "activeDirectionBriefId",
            before: "project-1:direction-brief:1",
            after: editorialBrief.id,
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "updatedAt",
            before: "2026-07-11T00:00:00.000Z",
            after: at,
          },
        ],
      }),
    ).toBe(true);
  });

  it("uses command-aware logical identities instead of generated record IDs", () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    workspace.replanProposals.push({
      id: "proposal-remote",
      localDate: "2026-07-12",
      baseCommitmentId: "commitment-base",
      baseRevision: 4,
      reasonCodes: ["ACTUAL_CHANGED"],
      proposedSlots: [],
      proposalHash: "proposal-hash",
      createdAt: "2026-07-12T01:00:00.000Z",
      createdBy: "human-1",
      status: "open",
    });
    workspace.reviews.push({
      id: "review:weekly:2026-07-06",
      kind: "weekly",
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T09:00:00.000Z",
      cadenceTimeZone: "UTC",
      createdAt: "2026-07-06T09:00:00.000Z",
    } satisfies ReviewRecord);

    expect(
      protectedCommandLogicalKey(workspace, {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-a",
        start: "2026-07-12T00:00:00.000Z",
      }),
    ).toBe('["bet","project-1"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-b",
        start: "2026-07-12T00:01:00.000Z",
      }),
    ).toBe('["bet","project-1"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "commit_today",
        commitment: {
          id: "commitment-a",
          localDate: "2026-07-12",
          workspaceRevision: 4,
          generatedAt: "2026-07-12T01:00:00.000Z",
          proposalHash: "proposal-hash",
          slots: [],
        },
      }),
    ).toBe('["daily_commitment","2026-07-12"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "propose_replan",
        proposal: workspace.replanProposals[0],
      }),
    ).toBe('["daily_commitment","2026-07-12"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "accept_replan",
        proposalId: "proposal-remote",
        commitmentId: "commitment-replanned",
      }),
    ).toBe('["daily_commitment","2026-07-12"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "mark_review_overdue",
        reviewId: "review:weekly:2026-07-06",
        triggerKey: "review:weekly:2026-07-06:overdue",
      }),
    ).toBe('["review","weekly:2026-07-06"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "resolve_evidence_exception",
        exceptionId: "exception-1",
        resolution: "Resolved.",
      }),
    ).toBe('["exception","exception-1"]');
    expect(
      protectedCommandLogicalKey(workspace, {
        type: "close_project",
        projectId: "project-1",
        decision: {
          id: "close-a",
          projectId: "project-1",
          successComparison: "Compared.",
          outcome: "achieved",
          keyLearning: "Learned.",
          unfinishedDisposition: "discard",
        },
      }),
    ).toBe('["close","project-1"]');
  });

  it("projects a material active Direction edit into the Project Bet bundle", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-material-direction");
    const now = "2026-07-12T00:00:00.000Z";
    const oldBrief = {
      id: "brief-1",
      projectId: "project-1",
      version: 1,
      audienceAndProblem: "Audience",
      successEvidence: "Evidence",
      appetiteSeconds: 3_600,
      validationMethod: "Validate",
      firstScope: [{ id: "scope-1", title: "Scope", description: "Bounded" }],
      noGoOrKill: "Stop",
      advancedNotes: "",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const newBrief = {
      ...oldBrief,
      id: "project-1:direction-brief:2",
      version: 2,
      successEvidence: "Changed evidence",
      createdAt: now,
      updatedAt: now,
    };
    workspace.projects.push({
      id: "project-1",
      name: "Project",
      priority: 1,
      notes: "",
      stage: "executing",
      holds: [],
      activeDirectionBriefId: oldBrief.id,
      activeBetId: "bet-1",
      createdAt: oldBrief.createdAt,
      updatedAt: oldBrief.updatedAt,
    });
    workspace.directionBriefs.push(oldBrief);
    workspace.bets.push({
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: oldBrief.id,
      briefHash: "brief-hash",
      briefSnapshot: oldBrief,
      committedScope: oldBrief.firstScope,
      appetiteStart: oldBrief.createdAt,
      appetiteEnd: "2026-07-13T00:00:00.000Z",
      actorId: "human-1",
      approvedAt: oldBrief.createdAt,
    });
    const {
      version: _oldBriefVersion,
      createdAt: _oldBriefCreatedAt,
      updatedAt: _oldBriefUpdatedAt,
      ...oldBriefDraft
    } = oldBrief;
    const command = {
      type: "update_direction",
      projectId: "project-1",
      brief: {
        ...oldBriefDraft,
        successEvidence: newBrief.successEvidence,
      },
    } as const satisfies V2Command;
    const hold = {
      type: "rebet_required" as const,
      sourceId: "bet-1",
      affectedRecordIds: ["project-1", oldBrief.id, newBrief.id, "bet-1"],
      createdAt: now,
    };

    expect(protectedCommandLogicalKey(workspace, command)).toBe(
      '["bet","project-1"]',
    );
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(91),
      workspace,
      command,
      commandId: "material-direction",
      createdAt: now,
      diff: [
        {
          entity: "BetVersion",
          entityId: "bet-1",
          field: "invalidatedAt",
          before: null,
          after: now,
        },
        {
          entity: "BetVersion",
          entityId: "bet-1",
          field: "invalidationReason",
          before: null,
          after: "Material Direction change requires Re-bet.",
        },
        {
          entity: "DirectionBrief",
          entityId: newBrief.id,
          field: "created",
          before: null,
          after: newBrief,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "activeDirectionBriefId",
          before: oldBrief.id,
          after: newBrief.id,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "holds",
          before: [],
          after: [hold],
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "updatedAt",
          before: oldBrief.updatedAt,
          after: now,
        },
      ],
    });

    expect(bundle).toBeDefined();
    expect(bundle?.logicalKey).toBe('["bet","project-1"]');
    expect(bundle?.operations[0].cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "create",
          entity: "DirectionBrief",
          entityId: newBrief.id,
        }),
        expect.objectContaining({
          kind: "scalar",
          entity: "BetVersion",
          entityId: "bet-1",
          field: "invalidatedAt",
        }),
        expect.objectContaining({
          kind: "project_hold_delta",
          projectId: "project-1",
          after: expect.objectContaining({ value: hold }),
        }),
      ]),
    );
    await expect(validateProtectedEffectBundle(bundle!)).resolves.toBe(true);

    const editorialBrief = {
      ...oldBrief,
      id: "project-1:direction-brief:2",
      version: 2,
      advancedNotes: "Editorial only",
      createdAt: now,
      updatedAt: now,
    };
    await expect(
      projectProtectedEffectBundle({
        ...operationProvenance(92),
        workspace,
        command: {
          type: "update_direction",
          projectId: "project-1",
          brief: { ...oldBrief, advancedNotes: "Editorial only" },
        },
        commandId: "editorial-direction",
        createdAt: now,
        diff: [
          {
            entity: "DirectionBrief",
            entityId: editorialBrief.id,
            field: "created",
            before: null,
            after: editorialBrief,
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "activeDirectionBriefId",
            before: oldBrief.id,
            after: editorialBrief.id,
          },
          {
            entity: "ProjectV2",
            entityId: "project-1",
            field: "updatedAt",
            before: oldBrief.updatedAt,
            after: now,
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it("projects a Re-bet into typed cells without copying Project updatedAt or whole hold arrays", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const oldHold = {
      type: "rebet_required" as const,
      sourceId: "bet-old",
      affectedRecordIds: ["project-1", "bet-old"],
      createdAt: "2026-07-11T23:00:00.000Z",
    };
    const unrelatedHold = {
      type: "review_overdue" as const,
      sourceId: "review-1",
      affectedRecordIds: ["review-1"],
      createdAt: "2026-07-11T23:30:00.000Z",
    };
    workspace.projects.push({
      id: "project-1",
      name: "Project",
      priority: 1,
      notes: "Keep me",
      stage: "executing",
      holds: [oldHold, unrelatedHold],
      activeDirectionBriefId: "brief-1",
      activeBetId: "bet-old",
      activePlanVersionId: "plan-old",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T23:30:00.000Z",
    });
    const now = "2026-07-12T00:00:00.000Z";
    const bet = {
      id: "bet-new",
      projectId: "project-1",
      version: 2,
      briefId: "brief-1",
      briefHash: "brief-hash",
      briefSnapshot: {
        id: "brief-1",
        projectId: "project-1",
        version: 1,
        audienceAndProblem: "Audience",
        successEvidence: "Evidence",
        appetiteSeconds: 3600,
        validationMethod: "Validate",
        firstScope: [{ id: "scope-1", title: "Scope", description: "Bounded" }],
        noGoOrKill: "Stop",
        advancedNotes: "",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      },
      committedScope: [
        { id: "scope-1", title: "Scope", description: "Bounded" },
      ],
      appetiteStart: now,
      appetiteEnd: "2026-07-12T01:00:00.000Z",
      actorId: "human-1",
      approvedAt: now,
      supersedesId: "bet-old",
    };
    const { supersedesId: _supersedesId, ...oldBetBase } = bet;
    workspace.bets.push({
      ...oldBetBase,
      id: "bet-old",
      version: 1,
    });
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(1),
      workspace,
      command: {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-new",
        start: now,
      },
      commandId: "command-rebet",
      createdAt: now,
      diff: [
        {
          entity: "BetVersion",
          entityId: "bet-old",
          field: "invalidatedAt",
          before: null,
          after: now,
        },
        {
          entity: "BetVersion",
          entityId: "bet-old",
          field: "invalidationReason",
          before: null,
          after: "Superseded by Re-bet bet-new.",
        },
        {
          entity: "BetVersion",
          entityId: "bet-new",
          field: "created",
          before: null,
          after: bet as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "activeBetId",
          before: "bet-old",
          after: "bet-new",
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "activePlanVersionId",
          before: "plan-old",
          after: null,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "holds",
          before: [oldHold, unrelatedHold] as unknown as JsonValue,
          after: [unrelatedHold] as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "stage",
          before: "executing",
          after: "planning",
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "updatedAt",
          before: "2026-07-11T23:30:00.000Z",
          after: now,
        },
      ],
    });

    expect(bundle?.logicalKey).toBe('["bet","project-1"]');
    expect(bundle?.operations[0]).toMatchObject(operationProvenance(1));
    expect(bundle?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(bundle?.operations[0].cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "create",
          entity: "BetVersion",
          entityId: "bet-new",
        }),
        {
          kind: "project_hold_delta",
          projectId: "project-1",
          holdKey: '["rebet_required","bet-old"]',
          before: { index: 0, value: oldHold },
          after: null,
        },
      ]),
    );
    expect(bundle?.operations[0].cells).not.toContainEqual(
      expect.objectContaining({ field: "updatedAt" }),
    );
    expect(bundle?.operations[0].cells).not.toContainEqual(
      expect.objectContaining({ field: "holds" }),
    );
  });

  it("combines propose and accept Replan operations into one Daily Commitment bundle", async () => {
    const beforeProposal = createEmptyWorkspaceV2("workspace-bundles");
    const proposal = {
      id: "proposal-1",
      localDate: "2026-07-12",
      baseCommitmentId: "commitment-base",
      baseRevision: 3,
      reasonCodes: ["ACTUAL_CHANGED"],
      proposedSlots: [],
      proposalHash: "proposal-hash",
      createdAt: "2026-07-12T01:00:00.000Z",
      createdBy: "human-1",
      status: "open" as const,
    };
    const proposed = await projectProtectedEffectBundle({
      ...operationProvenance(2),
      workspace: beforeProposal,
      command: { type: "propose_replan", proposal },
      commandId: "command-propose",
      createdAt: proposal.createdAt,
      diff: [
        {
          entity: "ReplanProposal",
          entityId: proposal.id,
          field: "created",
          before: null,
          after: proposal as unknown as JsonValue,
        },
      ],
    });
    expect(proposed).toBeDefined();

    const beforeAccept = structuredClone(beforeProposal);
    beforeAccept.replanProposals.push(proposal);
    const capacitySnapshot = {
      timeZone: "UTC",
      weeklyWindows: [],
      dailyBudgets: [],
      unavailableBlocks: [],
      updatedAt: "2026-07-12T00:00:00.000Z",
      updatedBy: "human-1",
    };
    const commitment = {
      id: "commitment-replanned",
      localDate: proposal.localDate,
      version: 2,
      proposalHash: proposal.proposalHash,
      capacitySnapshot,
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-12T01:01:00.000Z",
      supersedesId: proposal.baseCommitmentId,
    };
    const plan = {
      id: "plan:project-1:commitment-replanned",
      projectId: "project-1",
      version: 2,
      betId: "bet-1",
      workItemRevisions: {},
      dependencyRevisions: {},
      scopeMapping: {},
      scheduleHash: "schedule-hash",
      capacityIndependentDates: {},
      actorId: "human-1",
      createdAt: commitment.committedAt,
      supersedesId: "plan-old",
    };
    const accepted = await projectProtectedEffectBundle({
      ...operationProvenance(3),
      workspace: beforeAccept,
      command: {
        type: "accept_replan",
        proposalId: proposal.id,
        commitmentId: commitment.id,
      },
      commandId: "command-accept",
      createdAt: commitment.committedAt,
      diff: [
        {
          entity: "DailyCommitment",
          entityId: commitment.id,
          field: "created",
          before: null,
          after: commitment as unknown as JsonValue,
        },
        {
          entity: "PlanVersion",
          entityId: plan.id,
          field: "created",
          before: null,
          after: plan as unknown as JsonValue,
        },
        {
          entity: "ReplanProposal",
          entityId: proposal.id,
          field: "status",
          before: "open",
          after: "accepted",
        },
      ],
    });
    expect(accepted).toBeDefined();

    const bundle = await combineProtectedEffectBundles([proposed!, accepted!]);
    expect(bundle.logicalKey).toBe('["daily_commitment","2026-07-12"]');
    expect(bundle.operations.map(({ commandType }) => commandType)).toEqual([
      "propose_replan",
      "accept_replan",
    ]);
    expect(bundle.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("atomically swaps different-ID Close bundles and preserves unrelated Workspace state", async () => {
    const base = createEmptyWorkspaceV2("workspace-bundles");
    const sourceProject = {
      id: "project-1",
      name: "Original name",
      priority: 3,
      notes: "Do not overwrite",
      stage: "closing" as const,
      holds: [],
      activeDirectionBriefId: "brief-1",
      activeBetId: "bet-1",
      activePlanVersionId: "plan-1",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    base.projects.push(sourceProject);
    const localAt = "2026-07-12T01:00:00.000Z";
    const remoteAt = "2026-07-12T01:01:00.000Z";
    const localDecision = {
      id: "close-local",
      projectId: sourceProject.id,
      successComparison: "Local comparison",
      outcome: "partial" as const,
      keyLearning: "Local learning",
      unfinishedDisposition: "return_to_inbox" as const,
      actorId: "human-local",
      closedAt: localAt,
    };
    const localInbox = {
      id: JSON.stringify(["close_return_to_inbox", localDecision.id, "work-1"]),
      originalText: "Unfinished work",
      sourceId: "work-1",
      actorId: "human-local",
      capturedAt: localAt,
      triageStatus: "untriaged" as const,
    };
    const localBundle = await projectProtectedEffectBundle({
      ...operationProvenance(4),
      workspace: base,
      command: {
        type: "close_project",
        projectId: sourceProject.id,
        decision: {
          id: localDecision.id,
          projectId: sourceProject.id,
          successComparison: localDecision.successComparison,
          outcome: localDecision.outcome,
          keyLearning: localDecision.keyLearning,
          unfinishedDisposition: localDecision.unfinishedDisposition,
        },
      },
      commandId: "command-close-local",
      createdAt: localAt,
      diff: [
        {
          entity: "CloseDecision",
          entityId: localDecision.id,
          field: "created",
          before: null,
          after: localDecision as unknown as JsonValue,
        },
        {
          entity: "InboxItem",
          entityId: localInbox.id,
          field: "created",
          before: null,
          after: localInbox as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: sourceProject.id,
          field: "stage",
          before: "closing",
          after: "closed",
        },
        {
          entity: "ProjectV2",
          entityId: sourceProject.id,
          field: "updatedAt",
          before: sourceProject.updatedAt,
          after: localAt,
        },
      ],
    });
    expect(localBundle).toBeDefined();

    const remoteDecision = {
      id: "close-remote",
      projectId: sourceProject.id,
      successComparison: "Remote comparison",
      outcome: "partial" as const,
      keyLearning: "Remote learning",
      unfinishedDisposition: "follow_up_project" as const,
      followUpProjectId: "project-follow-up",
      actorId: "human-remote",
      closedAt: remoteAt,
    };
    const remoteBriefId = JSON.stringify([
      "close_follow_up_direction",
      remoteDecision.id,
      remoteDecision.followUpProjectId,
    ]);
    const remoteProject = {
      id: remoteDecision.followUpProjectId,
      name: "Original name follow-up",
      priority: sourceProject.priority,
      notes: "Follow-up provenance",
      stage: "direction" as const,
      holds: [],
      activeDirectionBriefId: remoteBriefId,
      createdAt: remoteAt,
      updatedAt: remoteAt,
    };
    const remoteBrief = {
      id: remoteBriefId,
      projectId: remoteProject.id,
      version: 1,
      audienceAndProblem: "",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [],
      noGoOrKill: "",
      advancedNotes: "Follow-up provenance",
      createdAt: remoteAt,
      updatedAt: remoteAt,
    };
    const remoteBundle = await projectProtectedEffectBundle({
      ...operationProvenance(5),
      workspace: base,
      command: {
        type: "close_project",
        projectId: sourceProject.id,
        decision: {
          id: remoteDecision.id,
          projectId: sourceProject.id,
          successComparison: remoteDecision.successComparison,
          outcome: remoteDecision.outcome,
          keyLearning: remoteDecision.keyLearning,
          unfinishedDisposition: remoteDecision.unfinishedDisposition,
          followUpProjectId: remoteDecision.followUpProjectId,
        },
      },
      commandId: "command-close-remote",
      createdAt: remoteAt,
      diff: [
        {
          entity: "CloseDecision",
          entityId: remoteDecision.id,
          field: "created",
          before: null,
          after: remoteDecision as unknown as JsonValue,
        },
        {
          entity: "DirectionBrief",
          entityId: remoteBrief.id,
          field: "created",
          before: null,
          after: remoteBrief as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: remoteProject.id,
          field: "created",
          before: null,
          after: remoteProject as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: sourceProject.id,
          field: "stage",
          before: "closing",
          after: "closed",
        },
        {
          entity: "ProjectV2",
          entityId: sourceProject.id,
          field: "updatedAt",
          before: sourceProject.updatedAt,
          after: remoteAt,
        },
      ],
    });
    expect(remoteBundle).toBeDefined();

    const current = structuredClone(base);
    current.revision = 12;
    current.projects[0] = {
      ...current.projects[0],
      stage: "closed",
      holds: [
        {
          type: "sync_conflict",
          sourceId: "conflict-close",
          affectedRecordIds: [localDecision.id, remoteDecision.id],
          createdAt: "2026-07-12T01:02:00.000Z",
        },
      ],
      updatedAt: "2026-07-12T01:02:00.000Z",
    };
    current.closeDecisions.push(localDecision);
    current.inboxItems.push(localInbox);
    const original = structuredClone(current);
    const resolvedAt = "2026-07-12T01:03:00.000Z";

    const resolved = await applyRemoteProtectedEffectBundle({
      workspace: current,
      localBundle: localBundle!,
      remoteBundle: remoteBundle!,
      conflictId: "conflict-close",
      now: resolvedAt,
    });

    expect(current).toEqual(original);
    expect(resolved.revision).toBe(12);
    expect(resolved.commandReceipts).toEqual(original.commandReceipts);
    expect(resolved.closeDecisions).toEqual([remoteDecision]);
    expect(resolved.inboxItems).toEqual([]);
    expect(resolved.directionBriefs).toEqual([remoteBrief]);
    expect(resolved.projects).toEqual([
      {
        ...sourceProject,
        stage: "closed",
        holds: [],
        updatedAt: resolvedAt,
      },
      { ...remoteProject, updatedAt: resolvedAt },
    ]);
  });

  it("normalizes Exception history to one append and swaps resolutions without array overwrite", async () => {
    const base = createEmptyWorkspaceV2("workspace-bundles");
    base.projects.push({
      id: "project-1",
      name: "Project",
      priority: 1,
      notes: "",
      stage: "validating",
      holds: [],
      activeDirectionBriefId: "brief-1",
      activeBetId: "bet-1",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const createdEntry = {
      action: "created" as const,
      actorId: "human-creator",
      at: "2026-07-10T00:00:00.000Z",
      note: "Accepted consequence",
    };
    const exception = {
      id: "exception-1",
      projectId: "project-1",
      requirementId: "work-1",
      rationale: "Need bounded exception",
      knownConsequence: "Known risk",
      reviewAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-07-14T00:00:00.000Z",
      approvedBy: "human-creator",
      createdAt: createdEntry.at,
      history: [createdEntry],
    };
    base.exceptions.push(exception);

    const projection = async (actor: string, at: string, note: string) => {
      const resolvedEntry = {
        action: "resolved" as const,
        actorId: actor,
        at,
        note,
      };
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(actor === "human-local" ? 6 : 7),
        workspace: base,
        command: {
          type: "resolve_evidence_exception",
          exceptionId: exception.id,
          resolution: note,
        },
        commandId: `resolve-${actor}`,
        createdAt: at,
        diff: [
          {
            entity: "ExceptionRecord",
            entityId: exception.id,
            field: "resolvedAt",
            before: null,
            after: at,
          },
          {
            entity: "ExceptionRecord",
            entityId: exception.id,
            field: "history",
            before: [createdEntry] as unknown as JsonValue,
            after: [createdEntry, resolvedEntry] as unknown as JsonValue,
          },
        ],
      });
      return { bundle: bundle!, resolvedEntry };
    };
    const local = await projection(
      "human-local",
      "2026-07-12T01:00:00.000Z",
      "Local resolution",
    );
    const remote = await projection(
      "human-remote",
      "2026-07-12T01:01:00.000Z",
      "Remote resolution",
    );
    expect(local.bundle.operations[0].cells).toContainEqual({
      kind: "exception_history_append",
      exceptionId: exception.id,
      index: 1,
      entry: local.resolvedEntry,
    });

    const current = structuredClone(base);
    current.exceptions[0] = {
      ...current.exceptions[0],
      resolvedAt: local.resolvedEntry.at,
      history: [createdEntry, local.resolvedEntry],
    };
    current.projects[0].holds.push({
      type: "sync_conflict",
      sourceId: "conflict-exception",
      affectedRecordIds: [exception.id],
      createdAt: "2026-07-12T01:02:00.000Z",
    });
    const remoteValue = {
      ...exception,
      resolvedAt: remote.resolvedEntry.at,
      history: [createdEntry, remote.resolvedEntry],
    };
    await expect(
      validateProtectedEffectBundlePair({
        workspace: current,
        conflictId: "conflict-exception",
        recordType: "exception",
        projectId: "project-1",
        logicalKey: local.bundle.logicalKey,
        recordId: exception.id,
        remoteRecordId: exception.id,
        localValue: current.exceptions[0] as unknown as JsonValue,
        remoteValue: remoteValue as unknown as JsonValue,
        affectedRecordIds: [exception.id],
        affectedProjectIds: ["project-1"],
        localBundle: local.bundle,
        remoteBundle: remote.bundle,
      }),
    ).resolves.toBe(true);
    const resolvedAt = "2026-07-12T01:03:00.000Z";
    const resolved = await applyRemoteProtectedEffectBundle({
      workspace: current,
      localBundle: local.bundle,
      remoteBundle: remote.bundle,
      conflictId: "conflict-exception",
      now: resolvedAt,
    });

    expect(resolved.exceptions[0]).toEqual(remoteValue);
    expect(resolved.projects[0].holds).toEqual([]);
    expect(resolved.projects[0].updatedAt).toBe(resolvedAt);
  });

  it("rejects a rehashed bundle whose typed whitelist was tampered", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const review = {
      id: "review:weekly:2026-07-06",
      kind: "weekly" as const,
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly" as const,
      status: "open" as const,
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T09:00:00.000Z",
      cadenceTimeZone: "UTC",
      createdAt: "2026-07-12T00:00:00.000Z",
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(8),
      workspace,
      command: {
        type: "create_review",
        review: {
          id: review.id,
          kind: review.kind,
          triggerKey: review.triggerKey,
          triggerType: review.triggerType,
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: review.dueAt,
          cadenceTimeZone: review.cadenceTimeZone,
        },
      },
      commandId: "command-create-review",
      createdAt: review.createdAt,
      diff: [
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "created",
          before: null,
          after: review as unknown as JsonValue,
        },
      ],
    });
    expect(bundle).toBeDefined();
    expect(await validateProtectedEffectBundle(bundle)).toBe(true);

    const tampered = structuredClone(bundle!);
    tampered.operations[0].cells = [
      {
        kind: "scalar",
        entity: "ProjectV2",
        entityId: "project-1",
        field: "name",
        before: "Before",
        after: "Overwritten",
      },
    ];
    tampered.hash = await sha256Hex(
      canonicalJson({
        schemaVersion: tampered.schemaVersion,
        logicalKey: tampered.logicalKey,
        operations: tampered.operations,
      }),
    );

    expect(await validateProtectedEffectBundle(tampered)).toBe(false);

    const exactShapeMutations = [
      (candidate: Record<string, unknown>) => {
        candidate.unexpected = true;
      },
      (candidate: Record<string, unknown>) => {
        const operation = (
          candidate.operations as Array<Record<string, unknown>>
        )[0]!;
        operation.unexpected = true;
      },
      (candidate: Record<string, unknown>) => {
        const operation = (
          candidate.operations as Array<Record<string, unknown>>
        )[0]!;
        (operation.command as Record<string, unknown>).unexpected = true;
      },
      (candidate: Record<string, unknown>) => {
        const operation = (
          candidate.operations as Array<Record<string, unknown>>
        )[0]!;
        const cell = (operation.cells as Array<Record<string, unknown>>)[0]!;
        cell.unexpected = true;
      },
      (candidate: Record<string, unknown>) => {
        const operation = (
          candidate.operations as Array<Record<string, unknown>>
        )[0]!;
        const cell = (operation.cells as Array<Record<string, unknown>>)[0]!;
        (cell.value as Record<string, unknown>).unexpected = true;
      },
    ];
    for (const mutate of exactShapeMutations) {
      const candidate = structuredClone(bundle!) as unknown as Record<
        string,
        unknown
      >;
      mutate(candidate);
      const resigned = await rehashBundle(
        candidate as unknown as ProtectedEffectBundle,
      );
      await expect(validateProtectedEffectBundle(resigned)).resolves.toBe(
        false,
      );
    }
  });

  it("persists verified Review bundles and resolves by stable bundle hash", async () => {
    const base = createEmptyWorkspaceV2("workspace-bundles");
    base.capacityProfile = {
      timeZone: "UTC",
      weeklyWindows: [],
      dailyBudgets: [],
      unavailableBlocks: [],
      updatedAt: "2026-07-05T00:00:00.000Z",
      updatedBy: "human-capacity",
    };
    const reviewDraft = deriveReviewQueue(
      base,
      "2026-07-12T00:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "weekly");
    if (reviewDraft === undefined)
      throw new Error("Expected weekly Review draft");
    const localCreateCommand = {
      type: "create_review",
      review: reviewDraft,
    } as const satisfies V2Command;
    const remoteCreateCommand = structuredClone(localCreateCommand);
    const remoteCompleteCommand = {
      type: "complete_review",
      reviewId: reviewDraft.id,
      conclusion: {
        summary: "Remote human conclusion",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
      },
    } as const satisfies V2Command;
    const systemContext = (
      commandId: string,
      expectedRevision: number,
    ): CommandContext => ({
      commandId,
      expectedRevision,
      actorId: "review-clock",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "verified-review-clock",
        verified: true,
        capabilities: ["system_time"],
      },
      now: "2026-07-12T00:00:00.000Z",
    });
    const localCreated = await executeCommand(
      base,
      localCreateCommand,
      systemContext("create-local-review", 0),
    );
    const remoteCreatedResult = await executeCommand(
      base,
      remoteCreateCommand,
      systemContext("create-remote-review", 0),
    );
    if (!localCreated.ok || !remoteCreatedResult.ok) {
      throw new Error(
        `Expected both Review creates to apply: ${
          localCreated.ok
            ? "local-ok"
            : `${localCreated.rejection.code}:${localCreated.rejection.gate}`
        } / ${
          remoteCreatedResult.ok
            ? "remote-ok"
            : `${remoteCreatedResult.rejection.code}:${remoteCreatedResult.rejection.gate}`
        }`,
      );
    }
    const remoteCompletedResult = await executeCommand(
      remoteCreatedResult.workspace,
      remoteCompleteCommand,
      {
        commandId: "complete-remote-review",
        expectedRevision: remoteCreatedResult.workspace.revision,
        actorId: "human-remote",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-human-remote",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T01:01:00.000Z",
      },
    );
    if (!remoteCompletedResult.ok) {
      throw new Error("Expected remote Review completion to apply");
    }
    const localReview = localCreated.workspace.reviews[0];
    const remoteReview = remoteCompletedResult.workspace.reviews[0];
    const localCreatedOperation = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "local-device",
      sequence: 1,
      operationId: "operation-create-local-review",
      command: localCreateCommand,
      receipt: localCreated.receipt,
      passphrase: PASSPHRASE,
    });
    const remoteCreatedOperation = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "remote-device",
      sequence: 1,
      operationId: "operation-create-remote-review",
      command: remoteCreateCommand,
      receipt: remoteCreatedResult.receipt,
      passphrase: PASSPHRASE,
    });
    const remoteCompletedOperation = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "remote-device",
      sequence: 2,
      operationId: "operation-complete-remote-review",
      command: remoteCompleteCommand,
      receipt: remoteCompletedResult.receipt,
      previousOperationHash: remoteCreatedOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const [localReplay, remoteCreateReplay, remoteCompleteReplay] =
      await Promise.all(
        [
          localCreatedOperation,
          remoteCreatedOperation,
          remoteCompletedOperation,
        ].map((created) =>
          decryptAndVerifySyncOperationV2({
            envelope: created.envelope,
            path: created.path,
            passphrase: PASSPHRASE,
            expectedWorkspaceId: base.workspaceId,
            expectedOperationHash: created.operationHash,
          }),
        ),
      );
    const manifest = createSyncManifestV2({
      workspaceId: base.workspaceId,
      heads: {
        "local-device": {
          sequence: 1,
          operationHash: localReplay.operationHash,
          revision: localReplay.receipt.revision,
          updatedAt: localReplay.receipt.createdAt,
        },
        "remote-device": {
          sequence: 2,
          operationHash: remoteCompleteReplay.operationHash,
          revision: remoteCompleteReplay.receipt.revision,
          updatedAt: remoteCompleteReplay.receipt.createdAt,
        },
      },
      updatedAt: remoteCompleteReplay.receipt.createdAt,
    });
    const history = verifySyncHistoryV2(manifest, [
      localReplay,
      remoteCreateReplay,
      remoteCompleteReplay,
    ]);
    const [localBranch, remoteBranch] = await Promise.all([
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: base,
        headOperationHash: localReplay.operationHash,
      }),
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: base,
        headOperationHash: remoteCompleteReplay.operationHash,
      }),
    ]);
    const localBundle = await projectProtectedEffectBundle({
      workspace: base,
      command: localReplay.command,
      commandId: localReplay.receipt.commandId,
      authorityRootOperationHash: localReplay.operationHash,
      sourceOperationHash: localReplay.operationHash,
      receiptHash: localReplay.receipt.receiptHash,
      payloadHash: localReplay.receipt.payloadHash,
      createdAt: localReplay.receipt.createdAt,
      diff: localReplay.receipt.diff,
    });
    const remoteCreated = await projectProtectedEffectBundle({
      workspace: base,
      command: remoteCreateReplay.command,
      commandId: remoteCreateReplay.receipt.commandId,
      authorityRootOperationHash: remoteCreateReplay.operationHash,
      sourceOperationHash: remoteCreateReplay.operationHash,
      receiptHash: remoteCreateReplay.receipt.receiptHash,
      payloadHash: remoteCreateReplay.receipt.payloadHash,
      createdAt: remoteCreateReplay.receipt.createdAt,
      diff: remoteCreateReplay.receipt.diff,
    });
    const remoteCompleted = await projectProtectedEffectBundle({
      workspace: remoteCreatedResult.workspace,
      command: remoteCompleteReplay.command,
      commandId: remoteCompleteReplay.receipt.commandId,
      authorityRootOperationHash: remoteCompleteReplay.operationHash,
      sourceOperationHash: remoteCompleteReplay.operationHash,
      receiptHash: remoteCompleteReplay.receipt.receiptHash,
      payloadHash: remoteCompleteReplay.receipt.payloadHash,
      createdAt: remoteCompleteReplay.receipt.createdAt,
      diff: remoteCompleteReplay.receipt.diff,
    });
    const remoteBundle = await combineProtectedEffectBundles([
      remoteCreated!,
      remoteCompleted!,
    ]);
    const workspace = localCreated.workspace;
    const conflictId = "conflict-review-bundle";
    const openCommand = {
      type: "open_sync_conflict",
      conflict: {
        id: conflictId,
        recordType: "review",
        recordId: localReview.id,
        remoteRecordId: remoteReview.id,
        logicalKey: localBundle!.logicalKey,
        commonAncestorHash: "ancestor-review-bundle",
        localValue: localReview as unknown as JsonValue,
        remoteValue: remoteReview as unknown as JsonValue,
        affectedProjectIds: [],
        affectedRecordIds: [localReview.id],
        localBundle: localBundle!,
        remoteBundle,
      },
    } as const satisfies V2Command;
    const openContext: CommandContext = {
      commandId: "open-review-bundle",
      expectedRevision: workspace.revision,
      actorId: "sync-conflict-detector",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "sync-merge:ancestor-review-bundle",
        verified: true,
        capabilities: ["open_conflict"],
      },
      now: "2026-07-12T01:02:00.000Z",
    };
    if (openCommand.type !== "open_sync_conflict") {
      throw new Error("Expected open command");
    }
    const authority = await authorizeConflictOpenFromBranchesV2({
      localBranch,
      remoteBranch,
      currentWorkspace: workspace,
      command: openCommand,
      context: openContext,
    });
    const tamperedProvenanceCommand = structuredClone(openCommand) as Extract<
      V2Command,
      { type: "open_sync_conflict" }
    >;
    const tamperedRemoteBundle =
      tamperedProvenanceCommand.conflict.remoteBundle;
    if (tamperedRemoteBundle === undefined) {
      throw new Error("Expected remote provenance bundle");
    }
    tamperedRemoteBundle.operations[0].receiptHash =
      tamperedRemoteBundle.operations[0].receiptHash.startsWith("f")
        ? "e".repeat(64)
        : "f".repeat(64);
    tamperedProvenanceCommand.conflict.remoteBundle =
      await rehashBundle(tamperedRemoteBundle);
    await expect(
      authorizeConflictOpenFromBranchesV2({
        localBranch,
        remoteBranch,
        currentWorkspace: workspace,
        command: tamperedProvenanceCommand,
        context: openContext,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT_PROJECTION_MISMATCH" });
    const leakedCommandCopy = authority.command as {
      conflict: { id: string; localBundle: { hash: string } };
    };
    leakedCommandCopy.conflict.id = "mutated-after-authorization";
    leakedCommandCopy.conflict.localBundle.hash = "0".repeat(64);
    expect(authority.command.conflict.id).toBe(conflictId);
    expect(authority.command.conflict.localBundle?.hash).toBe(
      localBundle!.hash,
    );
    const substitutedCommand = {
      ...structuredClone(openCommand),
      conflict: {
        ...structuredClone(openCommand.conflict),
        id: "conflict-token-substitution",
      },
    } as V2Command;
    const substituted = await executeCommand(
      workspace,
      substitutedCommand,
      openContext,
      { authorizedConflictOpen: authority },
    );
    expect(substituted.ok).toBe(false);
    if (substituted.ok)
      throw new Error("Expected token substitution rejection");
    expect(substituted.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: "sync_conflict:conflict-token-substitution:provenance_authority",
    });
    const opened = await executeCommand(workspace, openCommand, openContext, {
      authorizedConflictOpen: authority,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("Expected bundle conflict to open");
    expect(opened.workspace.syncConflicts[0]).toMatchObject({
      logicalKey: localBundle!.logicalKey,
      affectedRecordIds: [localReview.id],
      localBundle: { hash: localBundle!.hash },
      remoteBundle: { hash: remoteBundle.hash },
    });
    await expect(
      validateProtectedEffectBundle(
        opened.workspace.syncConflicts[0].localBundle,
      ),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundle(
        opened.workspace.syncConflicts[0].remoteBundle,
      ),
    ).resolves.toBe(true);

    const tamperedBeforeResolve = structuredClone(opened.workspace);
    const tamperedConflict = tamperedBeforeResolve.syncConflicts[0];
    if (tamperedConflict.remoteBundle === undefined) {
      throw new Error("Expected persisted remote bundle");
    }
    const tamperedBundle = structuredClone(tamperedConflict.remoteBundle);
    const tamperedConclusionCell = tamperedBundle.operations
      .flatMap(({ cells }) => cells)
      .find(
        (cell) =>
          cell.kind === "scalar" &&
          cell.entity === "ReviewRecord" &&
          cell.field === "conclusion",
      );
    if (
      tamperedConclusionCell === undefined ||
      tamperedConclusionCell.kind !== "scalar" ||
      tamperedConclusionCell.after === null ||
      Array.isArray(tamperedConclusionCell.after) ||
      typeof tamperedConclusionCell.after !== "object"
    ) {
      throw new Error("Expected persisted conclusion cell");
    }
    tamperedConclusionCell.after = {
      ...tamperedConclusionCell.after,
      summary: "Locally tampered after conflict creation.",
    };
    tamperedConflict.remoteBundle = await rehashBundle(tamperedBundle);
    tamperedConflict.remoteValue = {
      ...(tamperedConflict.remoteValue as Record<string, JsonValue>),
      conclusion: {
        ...(remoteReview.conclusion as unknown as Record<string, JsonValue>),
        summary: "Locally tampered after conflict creation.",
      },
    };
    const tamperedResolution = await executeCommand(
      tamperedBeforeResolve,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: structuredClone(tamperedConflict.remoteValue),
          retainedBundleHash: tamperedConflict.remoteBundle.hash,
          rationale: "Attempt to retain locally rehashed tamper.",
        },
      },
      {
        commandId: "resolve-tampered-review-bundle",
        expectedRevision: tamperedBeforeResolve.revision,
        actorId: "resolving-human",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-human-session",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: "2026-07-12T01:02:30.000Z",
      },
    );
    expect(tamperedResolution.ok).toBe(false);
    if (tamperedResolution.ok)
      throw new Error("Expected receipt-bound tamper rejection");
    expect(tamperedResolution.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: `sync_conflict:${conflictId}:creation_receipt`,
    });

    const resolveCommand = {
      type: "resolve_sync_conflict",
      reviewId: `review:sync_conflict:${conflictId}`,
      resolution: {
        conflictId,
        retainedVersion: "remote",
        retainedValue: remoteReview as unknown as JsonValue,
        retainedBundleHash: remoteBundle.hash,
        rationale: "Keep the verified remote conclusion.",
      },
    } as const satisfies V2Command;
    const resolveContext: CommandContext = {
      commandId: "resolve-review-bundle",
      expectedRevision: opened.workspace.revision,
      actorId: "resolving-human",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "verified-human-session",
        verified: true,
        capabilities: ["human_decision"],
      },
      now: "2026-07-12T01:03:00.000Z",
    };
    await expect(
      validateProtectedEffectBundle(
        opened.workspace.syncConflicts[0].localBundle,
      ),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundle(
        opened.workspace.syncConflicts[0].remoteBundle,
      ),
    ).resolves.toBe(true);
    const resolved = await executeCommand(
      opened.workspace,
      resolveCommand,
      resolveContext,
    );
    if (!resolved.ok) {
      throw new Error(
        `Expected bundle conflict resolution: ${resolved.rejection.code} ${resolved.rejection.gate ?? ""} ${resolved.rejection.reason}`,
      );
    }
    expect(resolved.workspace.reviews).toContainEqual(remoteReview);
    expect(resolved.workspace.syncConflicts[0]).toMatchObject({
      retainedBundleHash: remoteBundle.hash,
      retainedVersion: "remote",
    });
    const resolvedConflict = resolved.workspace.syncConflicts[0]!;
    const historicalReviewPair = {
      workspace: resolved.workspace,
      conflictId: resolvedConflict.id,
      recordType: resolvedConflict.recordType,
      projectId: resolvedConflict.projectId,
      logicalKey: resolvedConflict.logicalKey,
      recordId: resolvedConflict.recordId,
      remoteRecordId: resolvedConflict.remoteRecordId,
      localValue: resolvedConflict.localValue,
      remoteValue: resolvedConflict.remoteValue,
      retainedVersion: resolvedConflict.retainedVersion,
      retainedBundleHash: resolvedConflict.retainedBundleHash,
      affectedRecordIds: resolvedConflict.affectedRecordIds,
      affectedProjectIds: resolvedConflict.affectedProjectIds,
      localBundle: resolvedConflict.localBundle,
      remoteBundle: resolvedConflict.remoteBundle,
    };
    await expect(
      validateProtectedEffectBundlePairMetadata(historicalReviewPair),
    ).resolves.toBe(true);
    await expect(
      validateProtectedEffectBundlePairMetadata({
        ...historicalReviewPair,
        localValue: {
          ...(resolvedConflict.localValue as Record<string, JsonValue>),
          dueAt: "2099-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toBe(false);
    const bundledBackup = await buildWorkspaceBackupV2({
      snapshot: { workspace: resolved.workspace, rejectedReceipts: [] },
      exportedAt: "2026-07-12T01:04:00.000Z",
    });
    const restoreRepository = new BrowserWorkspaceRepository({
      databaseName: "bundled-review-restore",
      indexedDB: new IDBFactory(),
    });
    await restoreRepository.initialize(
      createEmptyWorkspaceV2(base.workspaceId),
    );
    await expect(
      restoreVerifiedBackup({
        repository: restoreRepository,
        backup: bundledBackup,
        validationNow: "2026-07-12T01:05:00.000Z",
      }),
    ).resolves.toMatchObject({ status: "restored" });
    const persistedOpen = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "local-device",
      sequence: 2,
      operationId: "operation-open-review-conflict",
      command: openCommand,
      receipt: opened.receipt,
      previousOperationHash: localCreatedOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const persistedResolution = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "local-device",
      sequence: 3,
      operationId: "operation-resolve-review-conflict",
      command: resolveCommand,
      receipt: resolved.receipt,
      previousOperationHash: persistedOpen.operationHash,
      passphrase: PASSPHRASE,
    });
    const [persistedOpenReplay, persistedResolutionReplay] = await Promise.all([
      decryptAndVerifySyncOperationV2({
        envelope: persistedOpen.envelope,
        path: persistedOpen.path,
        passphrase: PASSPHRASE,
        expectedWorkspaceId: base.workspaceId,
        expectedOperationHash: persistedOpen.operationHash,
      }),
      decryptAndVerifySyncOperationV2({
        envelope: persistedResolution.envelope,
        path: persistedResolution.path,
        passphrase: PASSPHRASE,
        expectedWorkspaceId: base.workspaceId,
        expectedOperationHash: persistedResolution.operationHash,
      }),
    ]);
    const persistedManifest = createSyncManifestV2({
      workspaceId: base.workspaceId,
      heads: {
        "local-device": {
          sequence: 3,
          operationHash: persistedResolutionReplay.operationHash,
          revision: persistedResolutionReplay.receipt.revision,
          updatedAt: persistedResolutionReplay.receipt.createdAt,
        },
        "remote-device": manifest.heads["remote-device"],
      },
      updatedAt: persistedResolutionReplay.receipt.createdAt,
    });
    const persistedHistory = verifySyncHistoryV2(persistedManifest, [
      localReplay,
      remoteCreateReplay,
      remoteCompleteReplay,
      persistedOpenReplay,
      persistedResolutionReplay,
    ]);
    const propagated = await authorizeSyncBranchV2({
      history: persistedHistory,
      trustedAncestorWorkspace: base,
      headOperationHash: persistedResolutionReplay.operationHash,
    });
    expect(propagated.workspace.syncConflicts[0]).toMatchObject({
      id: conflictId,
      retainedBundleHash: remoteBundle.hash,
      retainedVersion: "remote",
    });
    expect(propagated.workspace.reviews).toContainEqual(remoteReview);

    const authorizedPersistedOpen = propagated.replays.find(
      ({ operationHash }) =>
        operationHash === persistedOpenReplay.operationHash,
    );
    if (authorizedPersistedOpen === undefined) {
      throw new Error("Expected the history-proven persisted open replay");
    }
    const persistedOpenAuthority =
      await authorizePersistedConflictOpenFromVerifiedReplayV2(
        authorizedPersistedOpen,
        workspace,
      );
    const exactPersistedReplay = await executeCommand(
      workspace,
      openCommand,
      openContext,
      { authorizedConflictOpen: persistedOpenAuthority },
    );
    expect(exactPersistedReplay.ok).toBe(true);
    const substitutedPersistedContext: CommandContext = {
      ...structuredClone(openContext),
      actorId: "substituted-conflict-detector",
    };
    const contextSubstitution = await executeCommand(
      workspace,
      openCommand,
      substitutedPersistedContext,
      { authorizedConflictOpen: persistedOpenAuthority },
    );
    expect(contextSubstitution.ok).toBe(false);
    if (contextSubstitution.ok) {
      throw new Error("Expected persisted-open context substitution rejection");
    }
    expect(contextSubstitution.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: `sync_conflict:${conflictId}:provenance_authority`,
    });

    const forgedOpenCommand = structuredClone(openCommand) as Extract<
      V2Command,
      { type: "open_sync_conflict" }
    >;
    const forgedRemoteBundle = structuredClone(remoteBundle);
    forgedRemoteBundle.operations[
      forgedRemoteBundle.operations.length - 1
    ].sourceOperationHash = "f".repeat(64);
    forgedOpenCommand.conflict.remoteBundle =
      await rehashBundle(forgedRemoteBundle);
    const forgedOpenReceipt = structuredClone(opened.receipt);
    forgedOpenReceipt.payloadHash = await stableHash(
      forgedOpenCommand as unknown as JsonValue,
    );
    forgedOpenReceipt.diff = forgedOpenReceipt.diff.map((diff) => {
      if (
        diff.entity !== "SyncConflictRecord" ||
        diff.entityId !== conflictId ||
        diff.field !== "created" ||
        diff.after === null ||
        Array.isArray(diff.after) ||
        typeof diff.after !== "object"
      )
        return diff;
      return {
        ...diff,
        after: {
          ...structuredClone(diff.after),
          remoteBundle: structuredClone(
            forgedOpenCommand.conflict.remoteBundle,
          ),
        } as unknown as JsonValue,
      };
    });
    const { receiptHash: _forgedOldReceiptHash, ...forgedOpenReceiptBase } =
      forgedOpenReceipt;
    forgedOpenReceipt.receiptHash = await stableHash(
      forgedOpenReceiptBase as unknown as JsonValue,
    );
    const forgedPersistedOpen = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "local-forged-device",
      sequence: 1,
      operationId: "operation-forged-open-review-conflict",
      command: forgedOpenCommand,
      receipt: forgedOpenReceipt,
      previousOperationHash: localCreatedOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const forgedPersistedOpenReplay = await decryptAndVerifySyncOperationV2({
      envelope: forgedPersistedOpen.envelope,
      path: forgedPersistedOpen.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: base.workspaceId,
      expectedOperationHash: forgedPersistedOpen.operationHash,
    });
    const forgedManifest = createSyncManifestV2({
      workspaceId: base.workspaceId,
      heads: {
        "local-device": {
          sequence: 1,
          operationHash: localReplay.operationHash,
          revision: localReplay.receipt.revision,
          updatedAt: localReplay.receipt.createdAt,
        },
        "local-forged-device": {
          sequence: 1,
          operationHash: forgedPersistedOpenReplay.operationHash,
          revision: forgedPersistedOpenReplay.receipt.revision,
          updatedAt: forgedPersistedOpenReplay.receipt.createdAt,
        },
        "remote-device": manifest.heads["remote-device"],
      },
      updatedAt: forgedPersistedOpenReplay.receipt.createdAt,
    });
    const forgedHistory = verifySyncHistoryV2(forgedManifest, [
      localReplay,
      remoteCreateReplay,
      remoteCompleteReplay,
      forgedPersistedOpenReplay,
    ]);
    await expect(
      authorizeSyncBranchV2({
        history: forgedHistory,
        trustedAncestorWorkspace: base,
        headOperationHash: forgedPersistedOpenReplay.operationHash,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });

    const borrowedOpenCommand = structuredClone(openCommand) as Extract<
      V2Command,
      { type: "open_sync_conflict" }
    >;
    const borrowedRemoteBundle = structuredClone(remoteBundle);
    const completionOperation =
      borrowedRemoteBundle.operations[
        borrowedRemoteBundle.operations.length - 1
      ];
    const conclusionCell = completionOperation.cells.find(
      (cell) =>
        cell.kind === "scalar" &&
        cell.entity === "ReviewRecord" &&
        cell.field === "conclusion",
    );
    if (
      conclusionCell === undefined ||
      conclusionCell.kind !== "scalar" ||
      conclusionCell.after === null ||
      Array.isArray(conclusionCell.after) ||
      typeof conclusionCell.after !== "object"
    ) {
      throw new Error("Expected projected Review conclusion");
    }
    conclusionCell.after = {
      ...conclusionCell.after,
      summary: "Borrowed provenance with altered conclusion.",
    };
    borrowedOpenCommand.conflict.remoteBundle =
      await rehashBundle(borrowedRemoteBundle);
    borrowedOpenCommand.conflict.remoteValue = {
      ...(structuredClone(remoteReview) as unknown as Record<
        string,
        JsonValue
      >),
      conclusion: {
        ...(structuredClone(remoteReview.conclusion) as unknown as Record<
          string,
          JsonValue
        >),
        summary: "Borrowed provenance with altered conclusion.",
      },
    };
    expect(
      await validateProtectedEffectBundle(
        borrowedOpenCommand.conflict.remoteBundle,
      ),
    ).toBe(true);
    const borrowedOpenReceipt = structuredClone(opened.receipt);
    borrowedOpenReceipt.payloadHash = await stableHash(
      borrowedOpenCommand as unknown as JsonValue,
    );
    borrowedOpenReceipt.diff = borrowedOpenReceipt.diff.map((diff) => {
      if (
        diff.entity !== "SyncConflictRecord" ||
        diff.entityId !== conflictId ||
        diff.field !== "created" ||
        diff.after === null ||
        Array.isArray(diff.after) ||
        typeof diff.after !== "object"
      )
        return diff;
      return {
        ...diff,
        after: {
          ...structuredClone(diff.after),
          remoteValue: structuredClone(
            borrowedOpenCommand.conflict.remoteValue,
          ),
          remoteBundle: structuredClone(
            borrowedOpenCommand.conflict.remoteBundle,
          ),
        } as unknown as JsonValue,
      };
    });
    const { receiptHash: _borrowedOldReceiptHash, ...borrowedOpenReceiptBase } =
      borrowedOpenReceipt;
    borrowedOpenReceipt.receiptHash = await stableHash(
      borrowedOpenReceiptBase as unknown as JsonValue,
    );
    const borrowedPersistedOpen = await createSyncOperationV2({
      workspaceId: base.workspaceId,
      deviceId: "local-borrowed-device",
      sequence: 1,
      operationId: "operation-borrowed-open-review-conflict",
      command: borrowedOpenCommand,
      receipt: borrowedOpenReceipt,
      previousOperationHash: localCreatedOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const borrowedPersistedOpenReplay = await decryptAndVerifySyncOperationV2({
      envelope: borrowedPersistedOpen.envelope,
      path: borrowedPersistedOpen.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: base.workspaceId,
      expectedOperationHash: borrowedPersistedOpen.operationHash,
    });
    const borrowedManifest = createSyncManifestV2({
      workspaceId: base.workspaceId,
      heads: {
        "local-device": {
          sequence: 1,
          operationHash: localReplay.operationHash,
          revision: localReplay.receipt.revision,
          updatedAt: localReplay.receipt.createdAt,
        },
        "local-borrowed-device": {
          sequence: 1,
          operationHash: borrowedPersistedOpenReplay.operationHash,
          revision: borrowedPersistedOpenReplay.receipt.revision,
          updatedAt: borrowedPersistedOpenReplay.receipt.createdAt,
        },
        "remote-device": manifest.heads["remote-device"],
      },
      updatedAt: borrowedPersistedOpenReplay.receipt.createdAt,
    });
    const borrowedHistory = verifySyncHistoryV2(borrowedManifest, [
      localReplay,
      remoteCreateReplay,
      remoteCompleteReplay,
      borrowedPersistedOpenReplay,
    ]);
    await expect(
      authorizeSyncBranchV2({
        history: borrowedHistory,
        trustedAncestorWorkspace: base,
        headOperationHash: borrowedPersistedOpenReplay.operationHash,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  it("replays four independent persisted conflicts with linear branch authorization", async () => {
    const workspaceId = "workspace-recursive-conflicts";
    const boundaryAt = "2026-07-12T00:00:00.000Z";
    const briefs = Array.from({ length: 4 }, (_, index) =>
      buildDirectionBrief({
        id: `brief-recursive-${index + 1}`,
        projectId: `project-recursive-${index + 1}`,
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }),
    );
    const bets = briefs.map((brief, index) =>
      buildBetVersion({
        id: `bet-recursive-${index + 1}`,
        projectId: brief.projectId,
        briefId: brief.id,
        briefSnapshot: structuredClone(brief),
        appetiteStart: "2026-07-11T00:00:00.000Z",
        appetiteEnd: "2026-07-13T00:00:00.000Z",
        actorId: "human-recursive",
        approvedAt: "2026-07-11T00:00:00.000Z",
      }),
    );
    const base = buildWorkspaceV2(workspaceId, {
      projects: briefs.map((brief, index) =>
        buildProjectV2({
          id: brief.projectId,
          stage: "executing",
          activeDirectionBriefId: brief.id,
          activeBetId: bets[index].id,
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        }),
      ),
      directionBriefs: briefs,
      bets,
    });
    const reviewDrafts = deriveReviewQueue(base, boundaryAt)
      .filter(({ triggerType }) => triggerType === "bet_midpoint")
      .slice(0, 4);
    expect(reviewDrafts).toHaveLength(4);

    const persistReplay = async (input: {
      deviceId: string;
      sequence: number;
      operationId: string;
      command: V2Command;
      receipt: WorkspaceV2["commandReceipts"][number];
      previousOperationHash?: string;
    }): Promise<VerifiedSyncReplay> => {
      const created = await createSyncOperationV2({
        workspaceId,
        deviceId: input.deviceId,
        sequence: input.sequence,
        operationId: input.operationId,
        command: input.command,
        receipt: input.receipt,
        ...(input.previousOperationHash === undefined
          ? {}
          : { previousOperationHash: input.previousOperationHash }),
        passphrase: PASSPHRASE,
      });
      return decryptAndVerifySyncOperationV2({
        envelope: created.envelope,
        path: created.path,
        passphrase: PASSPHRASE,
        expectedWorkspaceId: workspaceId,
        expectedOperationHash: created.operationHash,
      });
    };
    const systemContext = (
      commandId: string,
      expectedRevision: number,
      now: string,
    ): CommandContext => ({
      commandId,
      expectedRevision,
      actorId: "review-clock-recursive",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "verified-review-clock-recursive",
        verified: true,
        capabilities: ["system_time"],
      },
      now,
    });

    let localWorkspace = structuredClone(base);
    let localPreviousHash: string | undefined;
    const localReplays: VerifiedSyncReplay[] = [];
    const localBundles: ProtectedEffectBundle[] = [];
    for (const [index, draft] of reviewDrafts.entries()) {
      const command = {
        type: "create_review",
        review: structuredClone(draft),
      } as const satisfies V2Command;
      const before = localWorkspace;
      const result = await executeCommand(
        before,
        command,
        systemContext(
          `create-local-recursive-${index + 1}`,
          before.revision,
          `2026-07-12T00:0${index}:00.000Z`,
        ),
      );
      if (!result.ok) throw new Error("Expected local Review create");
      const replay = await persistReplay({
        deviceId: "local-recursive-device",
        sequence: index + 1,
        operationId: `operation-local-recursive-${index + 1}`,
        command,
        receipt: result.receipt,
        ...(localPreviousHash === undefined
          ? {}
          : { previousOperationHash: localPreviousHash }),
      });
      const bundle = await projectProtectedEffectBundle({
        workspace: before,
        command,
        commandId: replay.receipt.commandId,
        authorityRootOperationHash: replay.operationHash,
        sourceOperationHash: replay.operationHash,
        receiptHash: replay.receipt.receiptHash,
        payloadHash: replay.receipt.payloadHash,
        createdAt: replay.receipt.createdAt,
        diff: replay.receipt.diff,
      });
      if (bundle === undefined) throw new Error("Expected local Review bundle");
      localBundles.push(bundle);
      localReplays.push(replay);
      localPreviousHash = replay.operationHash;
      localWorkspace = result.workspace;
    }

    let remoteWorkspace = structuredClone(base);
    let remotePreviousHash: string | undefined;
    let remoteSequence = 0;
    const remoteReplays: VerifiedSyncReplay[] = [];
    const remoteBundles: ProtectedEffectBundle[] = [];
    const remoteReviews: ReviewRecord[] = [];
    const remoteHeads: VerifiedSyncReplay[] = [];
    for (const [index, draft] of reviewDrafts.entries()) {
      const createCommand = {
        type: "create_review",
        review: structuredClone(draft),
      } as const satisfies V2Command;
      const beforeCreate = remoteWorkspace;
      const created = await executeCommand(
        beforeCreate,
        createCommand,
        systemContext(
          `create-remote-recursive-${index + 1}`,
          beforeCreate.revision,
          `2026-07-12T00:0${index * 2}:00.000Z`,
        ),
      );
      if (!created.ok) throw new Error("Expected remote Review create");
      remoteSequence += 1;
      const createReplay = await persistReplay({
        deviceId: "remote-recursive-device",
        sequence: remoteSequence,
        operationId: `operation-remote-create-recursive-${index + 1}`,
        command: createCommand,
        receipt: created.receipt,
        ...(remotePreviousHash === undefined
          ? {}
          : { previousOperationHash: remotePreviousHash }),
      });
      const completeCommand = {
        type: "complete_review",
        reviewId: draft.id,
        conclusion: {
          summary: `Remote conclusion ${index + 1}`,
          decisionCodes: ["continue"],
          followUpCommandIds: [],
        },
      } as const satisfies V2Command;
      const completed = await executeCommand(
        created.workspace,
        completeCommand,
        {
          commandId: `complete-remote-recursive-${index + 1}`,
          expectedRevision: created.workspace.revision,
          actorId: "human-remote-recursive",
          actorKind: "human",
          origin: "ui",
          source: {
            sourceId: "verified-human-remote-recursive",
            verified: true,
            capabilities: ["human_decision"],
          },
          now: `2026-07-12T00:0${index * 2 + 1}:00.000Z`,
        },
      );
      if (!completed.ok) throw new Error("Expected remote Review completion");
      remoteSequence += 1;
      const completeReplay = await persistReplay({
        deviceId: "remote-recursive-device",
        sequence: remoteSequence,
        operationId: `operation-remote-complete-recursive-${index + 1}`,
        command: completeCommand,
        receipt: completed.receipt,
        previousOperationHash: createReplay.operationHash,
      });
      const [createdBundle, completedBundle] = await Promise.all([
        projectProtectedEffectBundle({
          workspace: beforeCreate,
          command: createCommand,
          commandId: createReplay.receipt.commandId,
          authorityRootOperationHash: createReplay.operationHash,
          sourceOperationHash: createReplay.operationHash,
          receiptHash: createReplay.receipt.receiptHash,
          payloadHash: createReplay.receipt.payloadHash,
          createdAt: createReplay.receipt.createdAt,
          diff: createReplay.receipt.diff,
        }),
        projectProtectedEffectBundle({
          workspace: created.workspace,
          command: completeCommand,
          commandId: completeReplay.receipt.commandId,
          authorityRootOperationHash: completeReplay.operationHash,
          sourceOperationHash: completeReplay.operationHash,
          receiptHash: completeReplay.receipt.receiptHash,
          payloadHash: completeReplay.receipt.payloadHash,
          createdAt: completeReplay.receipt.createdAt,
          diff: completeReplay.receipt.diff,
        }),
      ]);
      if (createdBundle === undefined || completedBundle === undefined) {
        throw new Error("Expected remote Review bundles");
      }
      remoteBundles.push(
        await combineProtectedEffectBundles([createdBundle, completedBundle]),
      );
      remoteReviews.push(
        structuredClone(
          completed.workspace.reviews.find(({ id }) => id === draft.id)!,
        ),
      );
      remoteReplays.push(createReplay, completeReplay);
      remoteHeads.push(completeReplay);
      remotePreviousHash = completeReplay.operationHash;
      remoteWorkspace = completed.workspace;
    }

    const allReplays = [...localReplays, ...remoteReplays];
    let mergeWorkspace = localWorkspace;
    let mergeHead = localReplays[localReplays.length - 1];
    let mergeSequence = 0;
    let history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId,
        heads: {
          "local-recursive-device": {
            sequence: localReplays.length,
            operationHash: mergeHead.operationHash,
            revision: mergeHead.receipt.revision,
            updatedAt: mergeHead.receipt.createdAt,
          },
          "remote-recursive-device": {
            sequence: remoteSequence,
            operationHash:
              remoteReplays[remoteReplays.length - 1].operationHash,
            revision: remoteReplays[remoteReplays.length - 1].receipt.revision,
            updatedAt:
              remoteReplays[remoteReplays.length - 1].receipt.createdAt,
          },
        },
        updatedAt: remoteReplays[remoteReplays.length - 1].receipt.createdAt,
      }),
      allReplays,
    );

    for (const [index, draft] of reviewDrafts.entries()) {
      const [localBranch, remoteBranch] = await Promise.all([
        authorizeSyncBranchV2({
          history,
          trustedAncestorWorkspace: base,
          headOperationHash: mergeHead.operationHash,
        }),
        authorizeSyncBranchV2({
          history,
          trustedAncestorWorkspace: base,
          headOperationHash: remoteHeads[index].operationHash,
        }),
      ]);
      const conflictId = `conflict-recursive-${index + 1}`;
      const command = {
        type: "open_sync_conflict",
        conflict: {
          id: conflictId,
          recordType: "review",
          recordId: draft.id,
          remoteRecordId: draft.id,
          logicalKey: localBundles[index].logicalKey,
          commonAncestorHash: `genesis:${workspaceId}`,
          localValue: structuredClone(
            mergeWorkspace.reviews.find(({ id }) => id === draft.id)!,
          ) as unknown as JsonValue,
          remoteValue: structuredClone(
            remoteReviews[index],
          ) as unknown as JsonValue,
          affectedProjectIds: [
            ...new Set([
              ...protectedEffectBundleAffectedProjectIds(localBundles[index]),
              ...protectedEffectBundleAffectedProjectIds(remoteBundles[index]),
            ]),
          ].sort(),
          affectedRecordIds: [
            ...new Set([
              draft.id,
              ...protectedEffectBundleTouchedEntityIds(localBundles[index]),
              ...protectedEffectBundleTouchedEntityIds(remoteBundles[index]),
            ]),
          ].sort(),
          localBundle: localBundles[index],
          remoteBundle: remoteBundles[index],
        },
      } as const satisfies V2Command;
      const openContext: CommandContext = {
        commandId: `open-recursive-${index + 1}`,
        expectedRevision: mergeWorkspace.revision,
        actorId: "sync-conflict-detector-recursive",
        actorKind: "system",
        origin: "agent",
        source: {
          sourceId: `sync-merge:recursive-${index + 1}`,
          verified: true,
          capabilities: ["open_conflict"],
        },
        now: `2026-07-12T01:0${index * 2}:00.000Z`,
      };
      const authority = await authorizeConflictOpenFromBranchesV2({
        localBranch,
        remoteBranch,
        currentWorkspace: mergeWorkspace,
        command,
        context: openContext,
      });
      const opened = await executeCommand(
        mergeWorkspace,
        command,
        openContext,
        { authorizedConflictOpen: authority },
      );
      if (!opened.ok) {
        throw new Error(
          `Expected independent conflict ${index + 1} to open: ${opened.rejection.code} ${opened.rejection.reason}`,
        );
      }
      mergeSequence += 1;
      const openReplay = await persistReplay({
        deviceId: "merge-recursive-device",
        sequence: mergeSequence,
        operationId: `operation-open-recursive-${index + 1}`,
        command,
        receipt: opened.receipt,
        previousOperationHash: mergeHead.operationHash,
      });
      const resolveCommand = {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: structuredClone(
            remoteReviews[index],
          ) as unknown as JsonValue,
          retainedBundleHash: remoteBundles[index].hash,
          rationale: `Keep verified remote Review ${index + 1}.`,
        },
      } as const satisfies V2Command;
      const resolved = await executeCommand(opened.workspace, resolveCommand, {
        commandId: `resolve-recursive-${index + 1}`,
        expectedRevision: opened.workspace.revision,
        actorId: "human-resolver-recursive",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "verified-human-resolver-recursive",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: `2026-07-12T01:0${index * 2 + 1}:00.000Z`,
      });
      if (!resolved.ok)
        throw new Error("Expected independent conflict resolution");
      mergeSequence += 1;
      const resolveReplay = await persistReplay({
        deviceId: "merge-recursive-device",
        sequence: mergeSequence,
        operationId: `operation-resolve-recursive-${index + 1}`,
        command: resolveCommand,
        receipt: resolved.receipt,
        previousOperationHash: openReplay.operationHash,
      });
      allReplays.push(openReplay, resolveReplay);
      mergeHead = resolveReplay;
      mergeWorkspace = resolved.workspace;
      history = verifySyncHistoryV2(
        createSyncManifestV2({
          workspaceId,
          heads: {
            "local-recursive-device": {
              sequence: localReplays.length,
              operationHash:
                localReplays[localReplays.length - 1].operationHash,
              revision: localReplays[localReplays.length - 1].receipt.revision,
              updatedAt:
                localReplays[localReplays.length - 1].receipt.createdAt,
            },
            "merge-recursive-device": {
              sequence: mergeSequence,
              operationHash: mergeHead.operationHash,
              revision: mergeHead.receipt.revision,
              updatedAt: mergeHead.receipt.createdAt,
            },
            "remote-recursive-device": {
              sequence: remoteSequence,
              operationHash:
                remoteReplays[remoteReplays.length - 1].operationHash,
              revision:
                remoteReplays[remoteReplays.length - 1].receipt.revision,
              updatedAt:
                remoteReplays[remoteReplays.length - 1].receipt.createdAt,
            },
          },
          updatedAt: mergeHead.receipt.createdAt,
        }),
        allReplays,
      );
    }

    const authorized = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: base,
      headOperationHash: mergeHead.operationHash,
    });
    expect(authorized.workspace.syncConflicts).toHaveLength(4);
    expect(
      authorized.workspace.syncConflicts.every(
        ({ resolvedAt }) => resolvedAt !== undefined,
      ),
    ).toBe(true);
    expect(authorized.replays).toHaveLength(12);
    expect(authorized.authorizationEvaluationCount).toBeLessThanOrEqual(9);
  }, 15_000);

  it("rejects a first Bet create whose command and typed owner disagree", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const forgedBet = {
      id: "bet-1",
      projectId: "project-forged",
      version: 1,
      briefId: "brief-1",
      briefHash: "brief-hash",
      briefSnapshot: {},
      committedScope: [],
      appetiteStart: now,
      appetiteEnd: "2026-07-12T01:00:00.000Z",
      actorId: "human-1",
      approvedAt: now,
    };

    await expect(
      projectProtectedEffectBundle({
        ...operationProvenance(9),
        workspace,
        command: {
          type: "place_bet",
          projectId: "project-1",
          betId: forgedBet.id,
          start: now,
        },
        commandId: "command-first-bet",
        createdAt: now,
        diff: [
          {
            entity: "BetVersion",
            entityId: forgedBet.id,
            field: "created",
            before: null,
            after: forgedBet as unknown as JsonValue,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_DIFF" });
  });

  it("swaps Review outcomes through hold identity cells while preserving unrelated holds", async () => {
    const base = createEmptyWorkspaceV2("workspace-bundles");
    const unrelatedHold = {
      type: "migration_review" as const,
      sourceId: "migration-1",
      affectedRecordIds: ["project-1"],
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    base.projects.push({
      id: "project-1",
      name: "Project",
      priority: 1,
      notes: "",
      stage: "executing",
      holds: [unrelatedHold],
      activeDirectionBriefId: "brief-1",
      activeBetId: "bet-1",
      activePlanVersionId: "plan-1",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const review = {
      id: "review:event-1",
      kind: "event" as const,
      triggerKey: "event-1",
      triggerType: "hard_gate" as const,
      status: "open" as const,
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["project-1"],
      dueAt: "2026-07-12T00:00:00.000Z",
      createdAt: "2026-07-11T00:00:00.000Z",
    };
    base.reviews.push(review);
    const markedAt = "2026-07-12T01:00:00.000Z";
    const overdueHold = {
      type: "review_overdue" as const,
      sourceId: review.id,
      affectedRecordIds: [review.id, "project-1"].sort(),
      createdAt: markedAt,
    };
    const localBundle = await projectProtectedEffectBundle({
      ...operationProvenance(10),
      workspace: base,
      command: {
        type: "mark_review_overdue",
        reviewId: review.id,
        triggerKey: `${review.id}:overdue`,
      },
      commandId: "command-mark-review",
      createdAt: markedAt,
      diff: [
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "overdueMarkedAt",
          before: null,
          after: markedAt,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "holds",
          before: [unrelatedHold] as unknown as JsonValue,
          after: [unrelatedHold, overdueHold] as unknown as JsonValue,
        },
        {
          entity: "ProjectV2",
          entityId: "project-1",
          field: "updatedAt",
          before: "2026-07-10T00:00:00.000Z",
          after: markedAt,
        },
      ],
    });
    const completedAt = "2026-07-12T01:01:00.000Z";
    const conclusion = {
      summary: "Remote conclusion",
      decisionCodes: ["continue"],
      followUpCommandIds: [],
      actorId: "human-remote",
      completedAt,
    };
    const remoteBundle = await projectProtectedEffectBundle({
      ...operationProvenance(11),
      workspace: base,
      command: {
        type: "complete_review",
        reviewId: review.id,
        conclusion: {
          summary: conclusion.summary,
          decisionCodes: conclusion.decisionCodes,
          followUpCommandIds: conclusion.followUpCommandIds,
        },
      },
      commandId: "command-complete-review",
      createdAt: completedAt,
      diff: [
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "status",
          before: "open",
          after: "completed",
        },
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "conclusion",
          before: null,
          after: conclusion as unknown as JsonValue,
        },
      ],
    });
    const current = structuredClone(base);
    current.reviews[0] = { ...current.reviews[0], overdueMarkedAt: markedAt };
    current.projects[0].holds.push(overdueHold, {
      type: "sync_conflict",
      sourceId: "conflict-review",
      affectedRecordIds: [review.id],
      createdAt: "2026-07-12T01:02:00.000Z",
    });

    const resolved = await applyRemoteProtectedEffectBundle({
      workspace: current,
      localBundle: localBundle!,
      remoteBundle: remoteBundle!,
      conflictId: "conflict-review",
      now: "2026-07-12T01:03:00.000Z",
    });

    expect(resolved.reviews[0]).toEqual({
      ...review,
      status: "completed",
      conclusion,
    });
    expect(resolved.projects[0].holds).toEqual([unrelatedHold]);
  });

  it("rejects a rehashed Bet bundle whose created owner no longer matches its logical key", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: "brief-1",
      briefHash: "brief-hash",
      briefSnapshot: {},
      committedScope: [],
      appetiteStart: now,
      appetiteEnd: "2026-07-12T01:00:00.000Z",
      actorId: "human-1",
      approvedAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(12),
      workspace,
      command: {
        type: "place_bet",
        projectId: "project-1",
        betId: bet.id,
        start: now,
      },
      commandId: "command-bet",
      createdAt: now,
      diff: [
        {
          entity: "BetVersion",
          entityId: bet.id,
          field: "created",
          before: null,
          after: bet as unknown as JsonValue,
        },
      ],
    });
    expect(bundle).toBeDefined();
    const tampered = structuredClone(bundle!);
    const created = tampered.operations[0].cells[0];
    if (created.kind !== "create" || created.entity !== "BetVersion") {
      throw new Error("Expected projected Bet create");
    }
    created.value.projectId = "project-forged";
    tampered.hash = await sha256Hex(
      canonicalJson({
        schemaVersion: tampered.schemaVersion,
        logicalKey: tampered.logicalKey,
        operations: tampered.operations,
      }),
    );

    expect(await validateProtectedEffectBundle(tampered)).toBe(false);
  });

  it("rejects a rehashed Bet bundle that mutates a Bet owned by another Project", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const bet = {
      id: "bet-project-1",
      projectId: "project-1",
      version: 1,
      briefId: "brief-1",
      briefHash: "brief-hash",
      briefSnapshot: {},
      committedScope: [],
      appetiteStart: now,
      appetiteEnd: "2026-07-12T01:00:00.000Z",
      actorId: "human-1",
      approvedAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(30),
      workspace,
      command: {
        type: "place_bet",
        projectId: "project-1",
        betId: bet.id,
        start: now,
      },
      commandId: "place-bet-project-1",
      createdAt: now,
      diff: [
        {
          entity: "BetVersion",
          entityId: bet.id,
          field: "created",
          before: null,
          after: bet as unknown as JsonValue,
        },
      ],
    });
    if (bundle === undefined) throw new Error("Expected Bet bundle");
    const forged = structuredClone(bundle);
    forged.operations[0].cells.push({
      kind: "scalar",
      entity: "BetVersion",
      entityId: "bet-project-2",
      ownerProjectId: "project-2",
      field: "invalidatedAt",
      before: null,
      after: now,
    });

    expect(
      await validateProtectedEffectBundle(await rehashBundle(forged)),
    ).toBe(false);
  });

  it("rejects a rehashed Review bundle that mutates a different trigger", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const review = {
      id: "review-trigger-a",
      kind: "event" as const,
      triggerKey: "hard_gate:trigger-a",
      triggerType: "hard_gate" as const,
      status: "open" as const,
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: now,
      createdAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(31),
      workspace,
      command: {
        type: "create_review",
        review: {
          id: review.id,
          kind: review.kind,
          triggerKey: review.triggerKey,
          triggerType: review.triggerType,
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: review.dueAt,
        },
      },
      commandId: "create-review-trigger-a",
      createdAt: now,
      diff: [
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "created",
          before: null,
          after: review as unknown as JsonValue,
        },
      ],
    });
    if (bundle === undefined) throw new Error("Expected Review bundle");
    const forged = structuredClone(bundle);
    forged.operations.push({
      commandType: "complete_review",
      commandId: "complete-review-trigger-b",
      command: {
        type: "complete_review",
        reviewId: "review-trigger-b",
        conclusion: {
          summary: "Forged cross-trigger conclusion.",
          decisionCodes: ["continue"],
          followUpCommandIds: [],
        },
      },
      ...operationProvenance(131),
      createdAt: "2026-07-12T00:01:00.000Z",
      cells: [
        {
          kind: "scalar",
          entity: "ReviewRecord",
          entityId: "review-trigger-b",
          field: "status",
          before: "open",
          after: "completed",
        },
        {
          kind: "scalar",
          entity: "ReviewRecord",
          entityId: "review-trigger-b",
          field: "conclusion",
          before: null,
          after: {
            summary: "Forged cross-trigger conclusion.",
            decisionCodes: ["continue"],
            followUpCommandIds: [],
            actorId: "human-2",
            completedAt: "2026-07-12T00:01:00.000Z",
          },
        },
      ],
    });

    expect(
      await validateProtectedEffectBundle(await rehashBundle(forged)),
    ).toBe(false);
  });

  it("rejects a rehashed Daily bundle that writes an unrelated Project plan", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const commitment = {
      id: "commitment-daily",
      localDate: "2026-07-12",
      version: 1,
      proposalHash: "proposal-hash",
      capacitySnapshot: {
        timeZone: "UTC",
        weeklyWindows: [],
        dailyBudgets: [],
        unavailableBlocks: [],
        updatedAt: now,
        updatedBy: "human-1",
      },
      slots: [],
      actorId: "human-1",
      committedAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(32),
      workspace,
      command: {
        type: "commit_today",
        commitment: {
          id: commitment.id,
          localDate: commitment.localDate,
          workspaceRevision: workspace.revision,
          generatedAt: now,
          proposalHash: commitment.proposalHash,
          slots: [],
        },
      },
      commandId: "commit-daily",
      createdAt: now,
      diff: [
        {
          entity: "DailyCommitment",
          entityId: commitment.id,
          field: "created",
          before: null,
          after: commitment as unknown as JsonValue,
        },
      ],
    });
    if (bundle === undefined) throw new Error("Expected Daily bundle");
    expect(await validateProtectedEffectBundle(bundle)).toBe(true);
    const forged = structuredClone(bundle);
    forged.operations[0].cells.push({
      kind: "scalar",
      entity: "ProjectV2",
      entityId: "project-2",
      field: "stage",
      before: "planning",
      after: "executing",
    });

    expect(
      await validateProtectedEffectBundle(await rehashBundle(forged)),
    ).toBe(false);
  });

  it("rejects a rehashed Close bundle that creates two decisions", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const decision = {
      id: "close-project-1-a",
      projectId: "project-1",
      successComparison: "Compared.",
      outcome: "achieved" as const,
      keyLearning: "Learned.",
      unfinishedDisposition: "discard" as const,
      actorId: "human-1",
      closedAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(33),
      workspace,
      command: {
        type: "close_project",
        projectId: "project-1",
        decision: {
          id: decision.id,
          projectId: decision.projectId,
          successComparison: decision.successComparison,
          outcome: decision.outcome,
          keyLearning: decision.keyLearning,
          unfinishedDisposition: decision.unfinishedDisposition,
        },
      },
      commandId: "close-project-1",
      createdAt: now,
      diff: [
        {
          entity: "CloseDecision",
          entityId: decision.id,
          field: "created",
          before: null,
          after: decision as unknown as JsonValue,
        },
      ],
    });
    if (bundle === undefined) throw new Error("Expected Close bundle");
    const forged = structuredClone(bundle);
    forged.operations[0].cells.push({
      kind: "create",
      entity: "CloseDecision",
      entityId: "close-project-1-b",
      value: {
        ...decision,
        id: "close-project-1-b",
      },
    });

    expect(
      await validateProtectedEffectBundle(await rehashBundle(forged)),
    ).toBe(false);
  });

  it("rejects self-asserted provenance hashes that are not backed by an authorized replay", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-bundles");
    const now = "2026-07-12T00:00:00.000Z";
    const review = {
      id: "review-provenance",
      kind: "event" as const,
      triggerKey: "hard_gate:provenance",
      triggerType: "hard_gate" as const,
      status: "open" as const,
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: now,
      createdAt: now,
    };
    const bundle = await projectProtectedEffectBundle({
      ...operationProvenance(34),
      workspace,
      command: {
        type: "create_review",
        review: {
          id: review.id,
          kind: review.kind,
          triggerKey: review.triggerKey,
          triggerType: review.triggerType,
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: now,
        },
      },
      commandId: "create-review-provenance",
      createdAt: now,
      diff: [
        {
          entity: "ReviewRecord",
          entityId: review.id,
          field: "created",
          before: null,
          after: review as unknown as JsonValue,
        },
      ],
    });
    if (bundle === undefined) throw new Error("Expected Review bundle");
    const forged = structuredClone(bundle);
    forged.operations[0] = {
      ...forged.operations[0],
      ...operationProvenance(999),
    };
    const selfRehashed = await rehashBundle(forged);
    // A checksum can prove only self-consistency, never replay authority.
    expect(await validateProtectedEffectBundle(selfRehashed)).toBe(true);
    workspace.reviews.push(review);
    const result = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-self-asserted-provenance",
          recordType: "review",
          recordId: review.id,
          remoteRecordId: review.id,
          logicalKey: bundle.logicalKey,
          commonAncestorHash: "ancestor-self-asserted-provenance",
          localValue: review as unknown as JsonValue,
          remoteValue: review as unknown as JsonValue,
          affectedProjectIds: [],
          affectedRecordIds: [review.id],
          localBundle: bundle,
          remoteBundle: selfRehashed,
        },
      } as never,
      {
        commandId: "open-self-asserted-provenance",
        expectedRevision: workspace.revision,
        actorId: "sync-conflict-detector",
        actorKind: "system",
        origin: "sync",
        source: {
          sourceId: "verified-sync-conflict-detector",
          verified: true,
          capabilities: ["replay_receipt", "open_conflict"],
        },
        now: "2026-07-12T00:02:00.000Z",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected opaque authority rejection");
    expect(result.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: "sync_conflict:conflict-self-asserted-provenance:provenance_authority",
    });
  });

  it("fails atomically when a locally owned create drifted after projection", async () => {
    const base = createEmptyWorkspaceV2("workspace-bundles");
    const createdAt = "2026-07-12T00:00:00.000Z";
    const exceptionValue = (rationale: string, actorId: string) => ({
      id: "exception-1",
      projectId: "project-1",
      requirementId: "work-1",
      rationale,
      knownConsequence: "Known consequence",
      reviewAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-07-14T00:00:00.000Z",
      approvedBy: actorId,
      createdAt,
      history: [
        {
          action: "created" as const,
          actorId,
          at: createdAt,
          note: rationale,
        },
      ],
    });
    const projection = async (rationale: string, actorId: string) => {
      const value = exceptionValue(rationale, actorId);
      const bundle = await projectProtectedEffectBundle({
        ...operationProvenance(actorId === "human-local" ? 13 : 14),
        workspace: base,
        command: {
          type: "approve_evidence_exception",
          exception: {
            id: value.id,
            projectId: value.projectId,
            requirementId: value.requirementId,
            rationale: value.rationale,
            knownConsequence: value.knownConsequence,
            reviewAt: value.reviewAt,
            expiresAt: value.expiresAt,
          },
        },
        commandId: `approve-${actorId}`,
        createdAt,
        diff: [
          {
            entity: "ExceptionRecord",
            entityId: value.id,
            field: "created",
            before: null,
            after: value as unknown as JsonValue,
          },
        ],
      });
      return { bundle: bundle!, value };
    };
    const local = await projection("Local rationale", "human-local");
    const remote = await projection("Remote rationale", "human-remote");
    const current = structuredClone(base);
    current.exceptions.push({
      ...local.value,
      knownConsequence: "Drifted consequence",
    });
    const original = structuredClone(current);

    await expect(
      applyRemoteProtectedEffectBundle({
        workspace: current,
        localBundle: local.bundle,
        remoteBundle: remote.bundle,
        conflictId: "conflict-exception-create",
        now: "2026-07-12T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PROJECTION_DRIFT" });
    expect(current).toEqual(original);
  });
});
