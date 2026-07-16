import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  executeCommand as executeDomainCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import { applyCommandHandler } from "../domain/commandHandlers";
import { validateWorkspaceInvariants } from "../domain/invariants";
import { stableHash } from "../domain/stableHash";
import type {
  BetVersion,
  CloseDecision,
  DailyCommitment,
  ExceptionRecord,
  JsonValue,
  ReviewRecord,
  SyncConflictRecord,
  WorkspaceV2,
} from "../domain/types";
import {
  protectedEffectBundleAffectedProjectIds,
  protectedEffectBundleTouchedEntityIds,
  type ProtectedEffectBundle,
  type ProtectedOperationProjection,
} from "../repositories/syncConflictBundles";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildExceptionRecord,
  buildInboxItem,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "./builders";

const NOW = "2026-07-12T01:00:00.000Z";
const RESOLVED_AT = "2026-07-12T01:05:00.000Z";
const APPETITE_END = "2026-07-18T01:00:00.000Z";

function jsonRecord(value: JsonValue): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : undefined;
}

function protectedSnapshot(
  workspace: Readonly<WorkspaceV2>,
  recordType: SyncConflictRecord["recordType"],
  recordId: string,
): JsonValue | undefined {
  const values = {
    bet: workspace.bets,
    daily_commitment: workspace.dailyCommitments,
    review: workspace.reviews,
    exception: workspace.exceptions,
    close: workspace.closeDecisions,
  }[recordType] as readonly { id: string }[];
  const matches = values.filter(({ id }) => id === recordId);
  return matches.length === 1
    ? structuredClone(matches[0]) as unknown as JsonValue
    : undefined;
}

async function syntheticBundle(
  recordType: SyncConflictRecord["recordType"],
  logicalKey: string,
  value: JsonValue,
  side: "local" | "remote",
): Promise<ProtectedEffectBundle> {
  const record = jsonRecord(value);
  if (record === undefined || typeof record.id !== "string") {
    throw new Error("Protected handler fixture requires an object identity.");
  }
  const command = (() => {
    switch (recordType) {
      case "bet":
        return {
          type: "place_bet",
          projectId: String(record.projectId ?? "missing-project"),
          betId: record.id,
          start: String(record.approvedAt ?? NOW),
        } as const satisfies V2Command;
      case "daily_commitment":
        return {
          type: "commit_today",
          commitment: {
            id: record.id,
            localDate: String(record.localDate ?? "missing-date"),
            workspaceRevision: 0,
            generatedAt: String(record.committedAt ?? NOW),
            proposalHash: String(record.proposalHash ?? "missing-proposal"),
            slots: structuredClone((record.slots ?? []) as never[]),
          },
        } as const satisfies V2Command;
      case "review":
        return {
          type: "create_review",
          review: {
            id: record.id,
            kind: record.kind as ReviewRecord["kind"],
            triggerKey: String(record.triggerKey ?? "missing-trigger"),
            triggerType: record.triggerType as ReviewRecord["triggerType"],
            affectedProjectIds: structuredClone(
              (record.affectedProjectIds ?? []) as string[],
            ),
            affectedRecordIds: structuredClone(
              (record.affectedRecordIds ?? []) as string[],
            ),
            dueAt: String(record.dueAt ?? NOW),
            ...(typeof record.cadenceTimeZone === "string"
              ? { cadenceTimeZone: record.cadenceTimeZone }
              : {}),
          },
        } as const satisfies V2Command;
      case "exception":
        return {
          type: "approve_evidence_exception",
          exception: {
            id: record.id,
            projectId: String(record.projectId ?? "missing-project"),
            requirementId: String(record.requirementId ?? "missing-requirement"),
            rationale: String(record.rationale ?? ""),
            knownConsequence: String(record.knownConsequence ?? ""),
            reviewAt: String(record.reviewAt ?? NOW),
            expiresAt: String(record.expiresAt ?? NOW),
          },
        } as const satisfies V2Command;
      case "close":
        return {
          type: "close_project",
          projectId: String(record.projectId ?? "missing-project"),
          decision: {
            id: record.id,
            projectId: String(record.projectId ?? "missing-project"),
            successComparison: String(record.successComparison ?? ""),
            outcome: record.outcome as CloseDecision["outcome"],
            keyLearning: String(record.keyLearning ?? ""),
            unfinishedDisposition:
              record.unfinishedDisposition as CloseDecision["unfinishedDisposition"],
            ...(typeof record.followUpProjectId === "string"
              ? { followUpProjectId: record.followUpProjectId }
              : {}),
          },
        } as const satisfies V2Command;
    }
  })();
  const entity = {
    bet: "BetVersion",
    daily_commitment: "DailyCommitment",
    review: "ReviewRecord",
    exception: "ExceptionRecord",
    close: "CloseDecision",
  }[recordType] as Extract<
    ProtectedOperationProjection["cells"][number],
    { kind: "create" }
  >["entity"];
  const provenance = async (label: string) => sha256Hex(
    `${side}:${recordType}:${record.id}:${label}`,
  );
  const operation = {
    commandType: command.type,
    commandId: `handler-fixture:${side}:${recordType}:${record.id}`,
    command,
    authorityRootOperationHash: await provenance("operation"),
    sourceOperationHash: await provenance("operation"),
    receiptHash: await provenance("receipt"),
    payloadHash: await provenance("payload"),
    createdAt: NOW,
    cells: [{
      kind: "create",
      entity,
      entityId: record.id,
      value: structuredClone(value),
    }],
  } as unknown as ProtectedOperationProjection;
  const body = {
    schemaVersion: 1 as const,
    logicalKey,
    operations: [operation],
  };
  return { ...body, hash: await sha256Hex(canonicalJson(body)) };
}

async function enrichHandlerOpen(
  workspace: Readonly<WorkspaceV2>,
  command: Extract<V2Command, { type: "open_sync_conflict" }>,
): Promise<Extract<V2Command, { type: "open_sync_conflict" }>> {
  const localValue = protectedSnapshot(
    workspace,
    command.conflict.recordType,
    command.conflict.recordId,
  );
  const remote = jsonRecord(command.conflict.remoteValue);
  if (localValue === undefined || remote === undefined) return command;
  const local = jsonRecord(localValue);
  if (local === undefined) return command;
  const logicalKey = (() => {
    switch (command.conflict.recordType) {
      case "bet": return JSON.stringify(["bet", local.projectId]);
      case "daily_commitment":
        return JSON.stringify(["daily_commitment", local.localDate]);
      case "review": return JSON.stringify(["review", local.triggerKey]);
      case "exception": return JSON.stringify(["exception", local.id]);
      case "close": return JSON.stringify(["close", local.projectId]);
    }
  })();
  let localBundle = await syntheticBundle(
    command.conflict.recordType,
    logicalKey,
    localValue,
    "local",
  );
  let remoteBundle = await syntheticBundle(
    command.conflict.recordType,
    logicalKey,
    command.conflict.remoteValue,
    "remote",
  );
  const remoteRecordId = typeof remote.id === "string"
    ? remote.id
    : command.conflict.recordId;
  if (
    command.conflict.recordType === "bet" &&
    remoteRecordId !== command.conflict.recordId &&
    typeof local.projectId === "string"
  ) {
    const addActiveBetCell = async (
      bundle: ProtectedEffectBundle,
      activeBetId: string,
    ): Promise<ProtectedEffectBundle> => {
      const next = structuredClone(bundle);
      next.operations[0].cells.push({
        kind: "scalar",
        entity: "ProjectV2",
        entityId: local.projectId as string,
        field: "activeBetId",
        before: null,
        after: activeBetId,
      });
      const { hash: _oldHash, ...body } = next;
      return { ...body, hash: await sha256Hex(canonicalJson(body)) };
    };
    localBundle = await addActiveBetCell(
      localBundle,
      command.conflict.recordId,
    );
    remoteBundle = await addActiveBetCell(remoteBundle, remoteRecordId);
  }
  const affectedRecordIds = [...new Set([
    command.conflict.recordId,
    remoteRecordId,
    ...protectedEffectBundleTouchedEntityIds(localBundle),
    ...protectedEffectBundleTouchedEntityIds(remoteBundle),
  ])].sort();
  const currentProjectIds = new Set(workspace.projects.map(({ id }) => id));
  const affectedProjectIds = [...new Set([
    ...protectedEffectBundleAffectedProjectIds(localBundle),
    ...protectedEffectBundleAffectedProjectIds(remoteBundle),
  ])].filter((id) => currentProjectIds.has(id)).sort();
  return {
    ...structuredClone(command),
    conflict: {
      ...structuredClone(command.conflict),
      remoteRecordId,
      logicalKey,
      localValue,
      affectedProjectIds,
      affectedRecordIds,
      localBundle,
      remoteBundle,
    },
  };
}

async function fixtureReceipt(input: {
  workspace: Readonly<WorkspaceV2>;
  command: V2Command;
  context: CommandContext;
  status: "applied" | "rejected";
  diff: Array<{
    entity: string;
    entityId: string;
    field: string;
    before: JsonValue;
    after: JsonValue;
  }>;
  rejectionCode?: string;
}) {
  const base = {
    id: input.context.commandId,
    commandId: input.context.commandId,
    commandType: input.command.type,
    baseRevision: input.workspace.revision,
    revision:
      input.status === "applied"
        ? input.workspace.revision + 1
        : input.workspace.revision,
    payloadHash: await stableHash(input.command as unknown as JsonValue),
    actorId: input.context.actorId,
    actorKind: input.context.actorKind,
    origin: input.context.origin,
    source: structuredClone(input.context.source),
    status: input.status,
    createdAt: input.context.now,
    diff: structuredClone(input.diff),
    ...(input.rejectionCode === undefined
      ? {}
      : { rejectionCode: input.rejectionCode }),
  };
  return {
    ...base,
    receiptHash: await stableHash(base as unknown as JsonValue),
  } as WorkspaceV2["commandReceipts"][number];
}

async function executeCommand(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
  options: { evaluationNow?: string } = {},
): ReturnType<typeof executeDomainCommand> {
  if (command.type === "resolve_sync_conflict" &&
      command.resolution.retainedBundleHash === undefined) {
    const resolution = command.resolution;
    const conflict = workspace.syncConflicts.find(
      ({ id }) => id === resolution.conflictId,
    );
    if (conflict?.localBundle !== undefined && conflict.remoteBundle !== undefined) {
      const retainedCanonical = canonicalJson(resolution.retainedValue);
      const retainedBundleHash = retainedCanonical === canonicalJson(conflict.remoteValue)
        ? conflict.remoteBundle.hash
        : conflict.localBundle.hash;
      command = {
        ...structuredClone(command),
        resolution: { ...structuredClone(resolution), retainedBundleHash },
      };
    }
  }
  if (
    command.type !== "open_sync_conflict" ||
    command.conflict.localBundle !== undefined ||
    context.actorKind !== "system" ||
    !context.source.verified ||
    !context.source.capabilities.includes("open_conflict")
  ) {
    return executeDomainCommand(workspace, command, context, options);
  }
  const enriched = await enrichHandlerOpen(workspace, command);
  if (workspace.commandReceipts.some(({ commandId }) => commandId === context.commandId)) {
    return executeDomainCommand(workspace, enriched, context, options);
  }
  const handled = await applyCommandHandler(
    structuredClone(workspace),
    enriched,
    structuredClone(context),
  );
  if (!handled.ok) {
    return {
      ok: false,
      workspace,
      rejection: handled.rejection,
      receipt: await fixtureReceipt({
        workspace,
        command: enriched,
        context,
        status: "rejected",
        diff: [],
        rejectionCode: handled.rejection.code,
      }),
    };
  }
  const conflict = handled.workspace.syncConflicts.find(
    ({ id }) => id === enriched.conflict.id,
  );
  if (conflict === undefined) throw new Error("Handler did not persist conflict");
  const receipt = await fixtureReceipt({
    workspace,
    command: enriched,
    context,
    status: "applied",
    diff: [{
      entity: "SyncConflictRecord",
      entityId: conflict.id,
      field: "created",
      before: null,
      after: structuredClone(conflict) as unknown as JsonValue,
    }],
  });
  return {
    ok: true,
    workspace: {
      ...handled.workspace,
      revision: workspace.revision + 1,
      commandReceipts: [...handled.workspace.commandReceipts, receipt],
    },
    receipt,
  };
}

function conflictSourceContext(
  revision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: "open-conflict-command",
    expectedRevision: revision,
    actorId: "sync-conflict-detector",
    actorKind: "system",
    origin: "sync",
    source: {
      sourceId: "verified-sync-conflict-detector",
      verified: true,
      capabilities: ["replay_receipt", "open_conflict"],
    },
    now: NOW,
    ...overrides,
  };
}

function buildBetConflictWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    appetiteSeconds: 7 * 24 * 60 * 60,
    firstScope: [
      { id: "scope-1", title: "Bounded scope", description: "One result" },
    ],
    createdAt: "2026-07-11T01:00:00.000Z",
    updatedAt: "2026-07-11T01:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: "project-1",
    briefId: brief.id,
    briefHash: "c65ad459c2a5d39be7cceaabb2ce1e12981086989872a954f1e6182b6d7fb712",
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-11T01:00:00.000Z",
    appetiteEnd: APPETITE_END,
    actorId: "local-human",
    approvedAt: "2026-07-11T01:00:00.000Z",
  });
  return buildWorkspaceV2("workspace-conflicts", {
    revision: 4,
    projects: [
      buildProjectV2({
        id: "project-1",
        stage: "planning",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: "2026-07-11T01:00:00.000Z",
        updatedAt: "2026-07-11T01:00:00.000Z",
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
  });
}

function humanResolutionContext(
  revision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: "resolve-conflict-command",
    expectedRevision: revision,
    actorId: "resolving-human",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "verified-human-session",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: RESOLVED_AT,
    ...overrides,
  };
}

function openBetCommand(remoteBet: BetVersion): V2Command {
  return {
    type: "open_sync_conflict",
    conflict: {
      id: "conflict-bet-1",
      recordType: "bet",
      recordId: "bet-1",
      commonAncestorHash: "ancestor-bet-1",
      remoteValue: remoteBet as unknown as JsonValue,
    },
  };
}

type NonCloseConflictCase = {
  name: string;
  workspace: WorkspaceV2;
  recordType: Exclude<SyncConflictRecord["recordType"], "close">;
  recordId: string;
  localValue: JsonValue;
  remoteValue: JsonValue;
};

function buildActionCommitmentCase(): NonCloseConflictCase {
  const capacity = buildCapacityProfile({
    weeklyWindows: [{ weekday: 0, startMinute: 60, finishMinute: 180 }],
    dailyBudgets: [
      {
        weekday: 0,
        deepSeconds: 3_600,
        mediumSeconds: 3_600,
        shallowSeconds: 3_600,
      },
    ],
    updatedAt: "2026-07-11T00:00:00.000Z",
    updatedBy: "local-human",
  });
  const commitment: DailyCommitment = {
    id: "commitment-action-only",
    localDate: "2026-07-12",
    version: 1,
    proposalHash: "local-proposal",
    capacitySnapshot: capacity,
    slots: [
      {
        id: "slot-action-only",
        target: { kind: "action", actionId: "action-1" },
        targetRevision: 1,
        start: "2026-07-12T02:00:00.000Z",
        finish: "2026-07-12T02:30:00.000Z",
        attention: "medium",
      },
    ],
    actorId: "local-human",
    committedAt: "2026-07-11T23:00:00.000Z",
  };
  const remote: DailyCommitment = {
    ...structuredClone(commitment),
    proposalHash: "remote-proposal",
    actorId: "remote-human",
  };
  return {
    name: "DailyCommitment",
    workspace: buildWorkspaceV2("workspace-action-commitment", {
      revision: 2,
      inboxItems: [
        buildInboxItem({
          id: "inbox-action-1",
          sourceId: "local-source",
          actorId: "local-human",
          capturedAt: "2026-07-11T00:00:00.000Z",
          triageStatus: "action",
          actionId: "action-1",
        }),
      ],
      actions: [
        {
          id: "action-1",
          inboxItemId: "inbox-action-1",
          title: "Bounded Action",
          revision: 1,
          status: "open",
          eligibility: {
            singleSession: true,
            estimateSeconds: 1_800,
            dependencyIds: [],
            requiresMilestoneEvidence: false,
            outcomeCount: 1,
            solutionKnown: true,
          },
          attention: "medium",
          createdAt: "2026-07-11T00:00:00.000Z",
          updatedAt: "2026-07-11T00:00:00.000Z",
        },
      ],
      dailyCommitments: [commitment],
    }),
    recordType: "daily_commitment",
    recordId: commitment.id,
    localValue: structuredClone(commitment) as unknown as JsonValue,
    remoteValue: remote as unknown as JsonValue,
  };
}

function buildPortfolioReviewCase(): NonCloseConflictCase {
  const review: ReviewRecord = {
    id: "portfolio-event-review",
    kind: "event",
    triggerKey: "hard_gate:portfolio",
    triggerType: "hard_gate",
    status: "open",
    affectedProjectIds: [],
    affectedRecordIds: [],
    dueAt: "2026-07-13T01:00:00.000Z",
    createdAt: "2026-07-11T01:00:00.000Z",
  };
  const remote: ReviewRecord = {
    ...structuredClone(review),
    status: "completed",
    conclusion: {
      summary: "Remote human completed the hard-gate Review.",
      decisionCodes: ["continue"],
      followUpCommandIds: [],
      actorId: "remote-human",
      completedAt: "2026-07-11T02:00:00.000Z",
    },
  };
  return {
    name: "ReviewRecord",
    workspace: buildWorkspaceV2("workspace-portfolio-review", {
      revision: 2,
      reviews: [review],
    }),
    recordType: "review",
    recordId: review.id,
    localValue: structuredClone(review) as unknown as JsonValue,
    remoteValue: remote as unknown as JsonValue,
  };
}

function buildExceptionCase(): NonCloseConflictCase {
  const workspace = buildBetConflictWorkspace();
  const milestone = buildProjectWorkItem({
    id: "milestone-1",
    projectId: "project-1",
    betScopeId: "scope-1",
    kind: "milestone",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    evidenceRequired: true,
  });
  workspace.workItems.push(milestone);
  workspace.planVersions.push({
    id: "plan-1",
    projectId: "project-1",
    version: 1,
    betId: "bet-1",
    workItemRevisions: { [milestone.id]: milestone.revision },
    dependencyRevisions: {},
    scopeMapping: { [milestone.id]: milestone.betScopeId },
    scheduleHash: "plan-hash",
    capacityIndependentDates: {},
    actorId: "local-human",
    createdAt: "2026-07-11T01:00:00.000Z",
  });
  workspace.projects[0].activePlanVersionId = "plan-1";
  const exception: ExceptionRecord = buildExceptionRecord({
    id: "exception-1",
    projectId: "project-1",
    requirementId: milestone.id,
    approvedBy: "local-human",
    createdAt: "2026-07-11T01:00:00.000Z",
    reviewAt: "2026-07-13T01:00:00.000Z",
    expiresAt: "2026-07-14T01:00:00.000Z",
  });
  workspace.exceptions.push(exception);
  const remote: ExceptionRecord = {
    ...structuredClone(exception),
    rationale: "Remote bounded rationale.",
  };
  return {
    name: "ExceptionRecord",
    workspace,
    recordType: "exception",
    recordId: exception.id,
    localValue: structuredClone(exception) as unknown as JsonValue,
    remoteValue: remote as unknown as JsonValue,
  };
}

function buildBetCase(): NonCloseConflictCase {
  const workspace = buildBetConflictWorkspace();
  const remote: BetVersion = {
    ...structuredClone(workspace.bets[0]),
    actorId: "remote-human",
    approvedAt: "2026-07-11T02:00:00.000Z",
    appetiteStart: "2026-07-11T02:00:00.000Z",
    appetiteEnd: "2026-07-18T02:00:00.000Z",
  };
  return {
    name: "BetVersion",
    workspace,
    recordType: "bet",
    recordId: workspace.bets[0].id,
    localValue: structuredClone(workspace.bets[0]) as unknown as JsonValue,
    remoteValue: remote as unknown as JsonValue,
  };
}

function protectedValue(
  workspace: WorkspaceV2,
  type: NonCloseConflictCase["recordType"],
  id: string,
): JsonValue | undefined {
  const values = {
    bet: workspace.bets,
    daily_commitment: workspace.dailyCommitments,
    review: workspace.reviews,
    exception: workspace.exceptions,
  }[type] as readonly { id: string }[];
  return structuredClone(values.find((value) => value.id === id)) as
    | JsonValue
    | undefined;
}

describe("sync conflict commands", () => {
  it("opens a Bet conflict from the current record without picking a last writer", async () => {
    const workspace = buildBetConflictWorkspace();
    const original = structuredClone(workspace);
    const remoteBet: BetVersion = {
      ...structuredClone(workspace.bets[0]),
      actorId: "remote-human",
      approvedAt: "2026-07-11T02:00:00.000Z",
      appetiteStart: "2026-07-11T02:00:00.000Z",
      appetiteEnd: "2026-07-18T02:00:00.000Z",
    };
    const command = openBetCommand(remoteBet);

    const result = await executeCommand(
      workspace,
      command,
      conflictSourceContext(workspace.revision),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected conflict to open");
    expect(workspace).toEqual(original);
    expect(result.workspace.bets).toEqual(original.bets);
    expect(result.workspace.syncConflicts).toHaveLength(1);
    expect(result.workspace.syncConflicts[0]).toMatchObject({
      id: "conflict-bet-1",
      recordType: "bet",
      recordId: "bet-1",
      remoteRecordId: "bet-1",
      projectId: "project-1",
      logicalKey: '["bet","project-1"]',
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["bet-1"],
      commonAncestorHash: "ancestor-bet-1",
      localValue: original.bets[0],
      remoteValue: remoteBet,
      localBundle: { logicalKey: '["bet","project-1"]' },
      remoteBundle: { logicalKey: '["bet","project-1"]' },
      openedAt: NOW,
    });
    expect(result.workspace.reviews).toEqual([
      {
        id: "review:sync_conflict:conflict-bet-1",
        kind: "event",
        triggerKey: "sync_conflict:conflict-bet-1",
        triggerType: "sync_conflict",
        status: "open",
        affectedProjectIds: ["project-1"],
        affectedRecordIds: ["bet-1", "conflict-bet-1", "project-1"],
        dueAt: NOW,
        createdAt: NOW,
      },
    ]);
    expect(result.workspace.projects[0].holds).toEqual([
      {
        type: "sync_conflict",
        sourceId: "conflict-bet-1",
        affectedRecordIds: ["bet-1"],
        createdAt: NOW,
      },
    ]);
  });

  it("resolves a Bet conflict by retaining local and clears only its exact artifacts", async () => {
    const workspace = buildBetConflictWorkspace();
    const localBet = structuredClone(workspace.bets[0]);
    const remoteBet: BetVersion = {
      ...structuredClone(localBet),
      actorId: "remote-human",
      approvedAt: "2026-07-11T02:00:00.000Z",
      appetiteStart: "2026-07-11T02:00:00.000Z",
      appetiteEnd: "2026-07-18T02:00:00.000Z",
    };
    const opened = await executeCommand(
      workspace,
      openBetCommand(remoteBet),
      conflictSourceContext(workspace.revision),
    );
    if (!opened.ok) throw new Error("Expected fixture conflict to open");
    const unrelatedHistoricalBet: BetVersion = {
      ...structuredClone(localBet),
      id: "bet-unrelated",
      version: 2,
      invalidatedAt: NOW,
      invalidationReason: "Historical branch",
    };
    opened.workspace.bets.push(unrelatedHistoricalBet);
    opened.workspace.syncConflicts.push({
      id: "conflict-unrelated",
      recordType: "bet",
      recordId: "bet-unrelated",
      projectId: "project-1",
      commonAncestorHash: "ancestor-unrelated",
      localValue: structuredClone(unrelatedHistoricalBet) as unknown as JsonValue,
      remoteValue: structuredClone(unrelatedHistoricalBet) as unknown as JsonValue,
      openedAt: NOW,
    });
    opened.workspace.projects[0].holds.push({
      type: "sync_conflict",
      sourceId: "conflict-unrelated",
      affectedRecordIds: ["bet-unrelated"],
      createdAt: NOW,
    });

    const result = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-bet-1",
        resolution: {
          conflictId: "conflict-bet-1",
          retainedVersion: "local",
          retainedValue: localBet as unknown as JsonValue,
          rationale: "Keep the locally approved Bet.",
        },
      },
      humanResolutionContext(opened.workspace.revision),
    );

    if (!result.ok) {
      throw new Error(
        `Expected local resolution: ${result.rejection.code}:${result.rejection.gate}:${result.rejection.reason}`,
      );
    }
    expect(result.ok).toBe(true);
    expect(result.workspace.bets[0]).toEqual(localBet);
    expect(result.workspace.bets[1]).toEqual(unrelatedHistoricalBet);
    expect(result.workspace.syncConflicts[0]).toMatchObject({
      resolvedAt: RESOLVED_AT,
      retainedVersion: "local",
      localValue: localBet,
      remoteValue: remoteBet,
    });
    expect(result.workspace.reviews[0]).toEqual({
      id: "review:sync_conflict:conflict-bet-1",
      kind: "event",
      triggerKey: "sync_conflict:conflict-bet-1",
      triggerType: "sync_conflict",
      status: "completed",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["bet-1", "conflict-bet-1", "project-1"],
      dueAt: NOW,
      createdAt: NOW,
      conclusion: {
        summary: "Keep the locally approved Bet.",
        decisionCodes: ["sync_conflict_retained_local"],
        followUpCommandIds: [],
        actorId: "resolving-human",
        completedAt: RESOLVED_AT,
      },
    });
    expect(result.workspace.projects[0].holds).toEqual([
      {
        type: "sync_conflict",
        sourceId: "conflict-unrelated",
        affectedRecordIds: ["bet-unrelated"],
        createdAt: NOW,
      },
    ]);
  });

  it("maps a verified remote resolution by stable retained value instead of device-relative side", async () => {
    const fixture = buildBetCase();
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-stable-resolution",
          recordType: "bet",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-stable-resolution",
          remoteValue: fixture.remoteValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-stable-resolution",
      }),
    );
    if (!opened.ok) throw new Error("Expected stable-resolution conflict");

    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-stable-resolution",
        resolution: {
          conflictId: "conflict-stable-resolution",
          // This was `local` on the originating device. On this device the
          // exact retained snapshot is stored on the opposite side.
          retainedVersion: "local",
          retainedValue: fixture.remoteValue,
          rationale: "Retain the human-selected snapshot by stable identity.",
        },
      } as unknown as V2Command,
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-stable-resolution",
        origin: "sync",
        source: {
          sourceId: "sync-replay:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:verified-human-session",
          verified: true,
          capabilities: ["human_decision", "replay_receipt"],
        },
      }),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("Expected stable remote resolution");
    expect(resolved.workspace.bets[0]).toEqual(fixture.remoteValue);
    expect(resolved.workspace.syncConflicts[0]).toMatchObject({
      retainedVersion: "remote",
      resolvedAt: RESOLVED_AT,
    });
  });

  it("rejects a local resolution whose stable retained value contradicts its selected side", async () => {
    const fixture = buildBetCase();
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-contradictory-resolution",
          recordType: "bet",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-contradictory-resolution",
          remoteValue: fixture.remoteValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-contradictory-resolution",
      }),
    );
    if (!opened.ok) throw new Error("Expected contradictory-resolution conflict");

    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-contradictory-resolution",
        resolution: {
          conflictId: "conflict-contradictory-resolution",
          retainedVersion: "local",
          retainedValue: fixture.remoteValue,
          rationale: "Contradict the visible selection.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-contradictory-resolution",
      }),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("Expected contradictory selection rejection");
    expect(resolved.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "sync_conflict:conflict-contradictory-resolution:retained_value",
    });
    expect(resolved.workspace).toEqual(opened.workspace);
  });

  it.each([
    buildBetCase,
    buildActionCommitmentCase,
    buildPortfolioReviewCase,
    buildExceptionCase,
  ])("retains a typed remote protected record for %s", async (buildCase) => {
    const fixture = buildCase();
    const conflictId = `conflict-remote-${fixture.recordType}`;
    const open = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: conflictId,
          recordType: fixture.recordType,
          recordId: fixture.recordId,
          commonAncestorHash: `ancestor-${fixture.recordType}`,
          remoteValue: structuredClone(fixture.remoteValue),
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: `open-${fixture.recordType}`,
      }),
    );
    expect(open.ok).toBe(true);
    if (!open.ok) throw new Error(`Expected ${fixture.name} conflict to open`);
    expect(protectedValue(open.workspace, fixture.recordType, fixture.recordId))
      .toEqual(fixture.localValue);

    const resolved = await executeCommand(
      open.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: structuredClone(fixture.remoteValue),
          rationale: `Retain remote ${fixture.name}.`,
        },
      },
      humanResolutionContext(open.workspace.revision, {
        commandId: `resolve-${fixture.recordType}`,
      }),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(
        `Expected ${fixture.name} remote resolution: ${resolved.rejection.code}`,
      );
    }
    expect(
      protectedValue(resolved.workspace, fixture.recordType, fixture.recordId),
    ).toEqual(fixture.remoteValue);
    expect(
      resolved.workspace.syncConflicts.find(({ id }) => id === conflictId),
    ).toMatchObject({
      localValue: fixture.localValue,
      remoteValue: fixture.remoteValue,
      retainedVersion: "remote",
      resolvedAt: RESOLVED_AT,
    });
  });

  it("atomically retains a different-ID remote Bet and updates references", async () => {
    const fixture = buildBetCase();
    const localBet = fixture.localValue as unknown as BetVersion;
    const remoteBet = {
      ...(structuredClone(fixture.remoteValue) as unknown as BetVersion),
      id: "bet-remote-lineage",
      version: localBet.version,
    };
    const conflictId = "conflict-bet-different-id";
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: conflictId,
          recordType: "bet",
          recordId: localBet.id,
          commonAncestorHash: "ancestor-bet-different-id",
          remoteValue: remoteBet as unknown as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-bet-different-id",
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("Expected different-ID Bet conflict");
    expect(opened.workspace.syncConflicts[0]).toMatchObject({
      recordId: localBet.id,
      remoteRecordId: remoteBet.id,
      affectedRecordIds: expect.arrayContaining([
        localBet.id,
        remoteBet.id,
        "project-1",
      ]),
    });

    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: remoteBet as unknown as JsonValue,
          rationale: "Retain the verified remote Bet lineage.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-bet-different-id",
      }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error(
        `Expected different-ID Bet resolution: ${resolved.rejection.code}:${resolved.rejection.gate}`,
      );
    }
    expect(resolved.workspace.bets).toContainEqual(remoteBet);
    expect(resolved.workspace.bets).not.toContainEqual(localBet);
    expect(resolved.workspace.projects[0].activeBetId).toBe(remoteBet.id);
    expect(
      validateWorkspaceInvariants(
        resolved.workspace,
        RESOLVED_AT,
        opened.workspace,
      ),
    ).toEqual([]);
  });

  it("blocks only an action-only commitment record through a synthetic global hold", async () => {
    const fixture = buildActionCommitmentCase();
    const open = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-action-commitment",
          recordType: "daily_commitment",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-action-commitment",
          remoteValue: fixture.remoteValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-action-commitment",
      }),
    );
    if (!open.ok) throw new Error("Expected action commitment conflict");
    expect(open.workspace.projects).toEqual([]);

    const blocked = await executeCommand(
      open.workspace,
      {
        type: "commit_today",
        commitment: {
          id: "replacement-commitment",
          localDate: "2026-07-12",
          workspaceRevision: open.workspace.revision,
          generatedAt: RESOLVED_AT,
          proposalHash: "replacement-proposal",
          slots: [],
        },
      },
      humanResolutionContext(open.workspace.revision, {
        commandId: "replace-conflicted-commitment",
      }),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("Expected conflict hold rejection");
    expect(blocked.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
      gate: "project_hold:sync_conflict",
      permittedNextCommand: "resolve_sync_conflict",
    });

    const unrelated = await executeCommand(
      open.workspace,
      {
        type: "capture_inbox",
        id: "unrelated-inbox",
        text: "Unrelated capture remains available",
      },
      humanResolutionContext(open.workspace.revision, {
        commandId: "capture-through-conflict",
      }),
    );
    expect(unrelated.ok).toBe(true);
  });

  it("rejects a remote snapshot from the wrong protected record type", async () => {
    const workspace = buildBetConflictWorkspace();
    const before = structuredClone(workspace);
    const wrongType = {
      id: "bet-1",
      kind: "event",
      triggerKey: "wrong-type",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: NOW,
      createdAt: NOW,
    } as unknown as JsonValue;

    const result = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-wrong-type",
          recordType: "bet",
          recordId: "bet-1",
          commonAncestorHash: "ancestor-wrong-type",
          remoteValue: wrongType,
        },
      },
      conflictSourceContext(workspace.revision, {
        commandId: "open-wrong-type",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected typed remote rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "sync_conflict:conflict-wrong-type:bundle",
    });
    expect(workspace).toEqual(before);
  });

  it("requires a verified open-conflict system source and a human resolver", async () => {
    const fixture = buildBetCase();
    const command: V2Command = {
      type: "open_sync_conflict",
      conflict: {
        id: "conflict-authority",
        recordType: "bet",
        recordId: fixture.recordId,
        commonAncestorHash: "ancestor-authority",
        remoteValue: fixture.remoteValue,
      },
    };
    const unverified = await executeCommand(
      fixture.workspace,
      command,
      conflictSourceContext(fixture.workspace.revision, {
        source: {
          sourceId: "unverified-detector",
          verified: false,
          capabilities: ["replay_receipt", "open_conflict"],
        },
      }),
    );
    expect(unverified.ok).toBe(false);
    if (unverified.ok) throw new Error("Expected unverified rejection");
    expect(unverified.rejection.code).toBe("SOURCE_NOT_AUTHORIZED");

    const humanOpen = await executeCommand(
      fixture.workspace,
      command,
      {
        ...humanResolutionContext(fixture.workspace.revision),
        commandId: "human-open-conflict",
        source: {
          sourceId: "human-with-conflict-capability",
          verified: true,
          capabilities: ["human_decision", "open_conflict"],
        },
      },
    );
    expect(humanOpen.ok).toBe(false);
    if (humanOpen.ok) throw new Error("Expected human open rejection");
    expect(humanOpen.rejection.code).toBe("ACTOR_NOT_AUTHORIZED");

    const opened = await executeCommand(
      fixture.workspace,
      command,
      conflictSourceContext(fixture.workspace.revision),
    );
    if (!opened.ok) throw new Error("Expected system open");
    const agentResolve = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-authority",
        resolution: {
          conflictId: "conflict-authority",
          retainedVersion: "local",
          retainedValue: structuredClone(fixture.localValue),
          rationale: "Agent must not decide this.",
        },
      },
      {
        commandId: "agent-resolve-conflict",
        expectedRevision: opened.workspace.revision,
        actorId: "agent-1",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "verified-agent",
          verified: true,
          capabilities: ["submit_proposal"],
        },
        now: RESOLVED_AT,
      },
    );
    expect(agentResolve.ok).toBe(false);
    if (agentResolve.ok) throw new Error("Expected agent resolve rejection");
    expect(agentResolve.rejection).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "Only a human can resolve a sync conflict.",
    });
  });

  it("rejects duplicate conflict commands and duplicate unresolved targets idempotently", async () => {
    const fixture = buildBetCase();
    const firstCommand: V2Command = {
      type: "open_sync_conflict",
      conflict: {
        id: "conflict-idempotent",
        recordType: "bet",
        recordId: fixture.recordId,
        commonAncestorHash: "ancestor-idempotent",
        remoteValue: fixture.remoteValue,
      },
    };
    const opened = await executeCommand(
      fixture.workspace,
      firstCommand,
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-idempotent",
      }),
    );
    if (!opened.ok) throw new Error("Expected first open");
    const before = structuredClone(opened.workspace);

    const sameCommand = await executeCommand(
      opened.workspace,
      firstCommand,
      conflictSourceContext(opened.workspace.revision, {
        commandId: "open-idempotent",
      }),
    );
    expect(sameCommand.ok).toBe(false);
    if (sameCommand.ok) throw new Error("Expected duplicate command rejection");
    expect(sameCommand.rejection.code).toBe("DUPLICATE_COMMAND");

    const duplicateTarget = await executeCommand(
      opened.workspace,
      {
        ...firstCommand,
        conflict: {
          ...firstCommand.conflict,
          id: "conflict-same-target",
        },
      },
      conflictSourceContext(opened.workspace.revision, {
        commandId: "open-same-target",
      }),
    );
    expect(duplicateTarget.ok).toBe(false);
    if (duplicateTarget.ok) throw new Error("Expected duplicate target rejection");
    expect(duplicateTarget.rejection).toMatchObject({
      code: "DUPLICATE_COMMAND",
      gate: "sync_conflict_target:bet:bet-1",
      permittedNextCommand: "read_existing_sync_conflict",
    });
    expect(opened.workspace).toEqual(before);
  });

  it("allows only the exact conflict artifact transition for a closed CloseDecision", async () => {
    const workspace = buildBetConflictWorkspace();
    workspace.projects[0].stage = "closed";
    workspace.closeDecisions = [
      {
        id: "close-1",
        projectId: "project-1",
        successComparison: "The success evidence was achieved.",
        outcome: "achieved",
        keyLearning: "Local close learning.",
        unfinishedDisposition: "historical_incomplete",
        actorId: "local-human",
        closedAt: "2026-07-11T23:00:00.000Z",
      },
    ];
    const remoteClose = {
      ...structuredClone(workspace.closeDecisions[0]),
      id: "close-remote-1",
      keyLearning: "Remote close learning.",
      actorId: "remote-human",
    };
    const opened = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-close-1",
          recordType: "close",
          recordId: "close-1",
          commonAncestorHash: "ancestor-close-1",
          remoteValue: remoteClose as unknown as JsonValue,
        },
      },
      conflictSourceContext(workspace.revision, {
        commandId: "open-close-conflict",
      }),
      { evaluationNow: "2026-07-12T02:00:00.000Z" },
    );

    expect(opened.ok).toBe(true);
    if (!opened.ok) {
      throw new Error(`Expected closed conflict open: ${opened.rejection.code}`);
    }
    expect(opened.workspace.projects[0]).toMatchObject({
      stage: "closed",
      holds: [
        {
          type: "sync_conflict",
          sourceId: "conflict-close-1",
          affectedRecordIds: ["close-1", "close-remote-1"],
        },
      ],
    });
    expect(opened.workspace.syncConflicts[0].openedAt).toBe(NOW);
    expect(opened.workspace.reviews[0]).toMatchObject({
      createdAt: NOW,
      dueAt: NOW,
    });
    const openCandidate = structuredClone(opened.workspace);
    openCandidate.revision = workspace.revision;
    openCandidate.commandReceipts = [];
    expect(
      validateWorkspaceInvariants(openCandidate, NOW, workspace),
    ).toEqual([]);

    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-close-1",
        resolution: {
          conflictId: "conflict-close-1",
          retainedVersion: "remote",
          retainedValue: remoteClose as unknown as JsonValue,
          rationale: "Retain the remote Close decision.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-close-conflict",
      }),
      { evaluationNow: "2026-07-12T02:00:00.000Z" },
    );
    if (!resolved.ok) {
      throw new Error(
        `Expected closed conflict resolve: ${resolved.rejection.code}:${resolved.rejection.gate}:${resolved.rejection.reason}`,
      );
    }
    expect(resolved.ok).toBe(true);
    expect(resolved.workspace.closeDecisions).toEqual([remoteClose]);
    expect(resolved.workspace.syncConflicts[0]).toMatchObject({
      recordId: "close-1",
      remoteRecordId: "close-remote-1",
      retainedVersion: "remote",
    });
    expect(resolved.workspace.syncConflicts[0].resolvedAt).toBe(RESOLVED_AT);
    expect(
      resolved.workspace.reviews[0].conclusion?.completedAt,
    ).toBe(RESOLVED_AT);
    expect(resolved.workspace.projects[0]).toMatchObject({
      stage: "closed",
      holds: [],
    });

    const smuggled = structuredClone(opened.workspace);
    smuggled.revision = workspace.revision;
    smuggled.commandReceipts = [];
    smuggled.projects[0].notes = "Smuggled closed mutation";
    expect(
      validateWorkspaceInvariants(smuggled, NOW, workspace),
    ).toContainEqual({
      code: "PROJECT_CLOSED",
      reason:
        "Closed project project-1 and its project-linked records are immutable.",
      gate: "project:project-1:closed_snapshot",
      permittedNextCommand: "create_follow_up_project",
    });
  });

  it("blocks the affected lifecycle record while unrelated Inbox, Actual, and Evidence continue", async () => {
    const fixture = buildExceptionCase();
    const remoteBet = {
      ...structuredClone(fixture.workspace.bets[0]),
      actorId: "remote-human",
      approvedAt: "2026-07-11T02:00:00.000Z",
      appetiteStart: "2026-07-11T02:00:00.000Z",
      appetiteEnd: "2026-07-18T02:00:00.000Z",
    } as unknown as JsonValue;
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-affected-only",
          recordType: "bet",
          recordId: "bet-1",
          commonAncestorHash: "ancestor-affected-only",
          remoteValue: remoteBet,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-affected-only",
      }),
    );
    if (!opened.ok) throw new Error("Expected affected-only conflict");

    const blocked = await executeCommand(
      opened.workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "replacement-bet",
        start: RESOLVED_AT,
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "replace-affected-bet",
      }),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("Expected affected Bet hold");
    expect(blocked.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });

    const commands: V2Command[] = [
      {
        type: "capture_inbox",
        id: "unrelated-capture",
        text: "Still capturable",
      },
      {
        type: "record_actual",
        actual: {
          id: "unrelated-actual",
          revision: 1,
          target: { kind: "work_item", workItemId: "milestone-1" },
          actualWorkSeconds: 60,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: RESOLVED_AT,
        },
      },
      {
        type: "attach_evidence",
        evidence: {
          id: "unrelated-evidence",
          kind: "note",
          summary: "Exact validation evidence",
          projectId: "project-1",
          workItemId: "milestone-1",
          createdAt: RESOLVED_AT,
          confidence: 1,
          tags: ["conflict-unrelated"],
        },
      },
    ];
    for (const [index, command] of commands.entries()) {
      const result = await executeCommand(
        opened.workspace,
        command,
        humanResolutionContext(opened.workspace.revision, {
          commandId: `unrelated-through-conflict-${index}`,
        }),
      );
      expect(result.ok, `${command.type} should remain available`).toBe(true);
    }
  });

  it("keeps deep immutable snapshots isolated from caller mutation", async () => {
    const workspace = buildBetConflictWorkspace();
    const expectedLocal = structuredClone(workspace.bets[0]);
    const remote = {
      ...structuredClone(expectedLocal),
      actorId: "remote-human",
      approvedAt: "2026-07-11T02:00:00.000Z",
      appetiteStart: "2026-07-11T02:00:00.000Z",
      appetiteEnd: "2026-07-18T02:00:00.000Z",
    };
    const expectedRemote = structuredClone(remote);
    const opened = await executeCommand(
      workspace,
      openBetCommand(remote),
      conflictSourceContext(workspace.revision, {
        commandId: "open-deep-snapshot",
      }),
    );
    if (!opened.ok) throw new Error("Expected deep snapshot conflict");

    remote.actorId = "tampered-caller";
    remote.briefSnapshot.firstScope[0].title = "tampered nested caller";
    workspace.bets[0].actorId = "tampered-local-input";
    workspace.bets[0].briefSnapshot.firstScope[0].title = "tampered nested input";

    expect(opened.workspace.syncConflicts[0].localValue).toEqual(expectedLocal);
    expect(opened.workspace.syncConflicts[0].remoteValue).toEqual(expectedRemote);
  });

  it("rejects a semantically invalid typed remote before opening a conflict", async () => {
    const fixture = buildBetCase();
    const invalidRemote = {
      ...(structuredClone(fixture.remoteValue) as unknown as BetVersion),
      briefId: "missing-brief",
    };
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-invalid-remote",
          recordType: "bet",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-invalid-remote",
          remoteValue: invalidRemote as unknown as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-invalid-remote",
      }),
    );
    expect(opened.ok).toBe(false);
    if (opened.ok) throw new Error("Expected invalid remote rejection");
    expect(opened.rejection.code).toBe("INVALID_COMMAND");
    expect(opened.workspace).toEqual(fixture.workspace);
  });

  it.each([
    {
      name: "forged brief hash",
      mutate(remote: BetVersion) {
        remote.briefHash = "0".repeat(64);
      },
    },
    {
      name: "scope that no longer matches the approved brief",
      mutate(remote: BetVersion) {
        remote.committedScope[0].title = "Forged remote scope";
      },
    },
    {
      name: "appetite end outside the approved boundary",
      mutate(remote: BetVersion) {
        remote.appetiteEnd = "2026-07-18T03:00:00.000Z";
      },
    },
  ])("rejects a remote Bet with $name", async ({ name, mutate }) => {
    const fixture = buildBetCase();
    const remote = structuredClone(fixture.remoteValue) as unknown as BetVersion;
    mutate(remote);

    const result = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: `conflict-forged-bet-${name.split(" ").join("-")}`,
          recordType: "bet",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-forged-bet",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: `open-forged-bet-${name.split(" ").join("-")}`,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected forged Bet rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: expect.stringContaining(":remote_semantics"),
    });
    expect(result.workspace).toEqual(fixture.workspace);
  });

  it("rejects a DailyCommitment whose capacity snapshot is structurally typed but not authoritative", async () => {
    const fixture = buildActionCommitmentCase();
    const remote = structuredClone(
      fixture.remoteValue,
    ) as unknown as DailyCommitment;
    remote.capacitySnapshot.weeklyWindows.push({
      weekday: 0,
      startMinute: 120,
      finishMinute: 240,
    });

    const result = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-invalid-capacity-snapshot",
          recordType: "daily_commitment",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-invalid-capacity",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-invalid-capacity-snapshot",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid capacity rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "sync_conflict:conflict-invalid-capacity-snapshot:remote_semantics",
    });
    expect(result.workspace).toEqual(fixture.workspace);
  });

  it("accepts a legal overdue Review whose due time precedes its creation time", async () => {
    const local: ReviewRecord = {
      id: "review-due-before-created",
      kind: "event",
      triggerKey: "hard_gate:due-before-created",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-10T01:00:00.000Z",
      createdAt: "2026-07-11T01:00:00.000Z",
    };
    const remote: ReviewRecord = {
      ...structuredClone(local),
      status: "completed",
      conclusion: {
        summary: "Remote human completed the already-due Review.",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
        actorId: "remote-human",
        completedAt: "2026-07-11T02:00:00.000Z",
      },
    };
    const workspace = buildWorkspaceV2("workspace-overdue-review-conflict", {
      revision: 2,
      reviews: [local],
    });

    const result = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-overdue-review",
          recordType: "review",
          recordId: local.id,
          commonAncestorHash: "ancestor-overdue-review",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(workspace.revision, {
        commandId: "open-overdue-review-conflict",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected legal overdue Review: ${result.rejection.code}`);
    expect(result.workspace.reviews[0]).toEqual(local);
    expect(result.workspace.syncConflicts[0]).toMatchObject({
      localValue: local,
      remoteValue: remote,
    });
  });

  it("preserves both Review snapshots but refuses remote retention when affected ownership drifted", async () => {
    const fixture = buildPortfolioReviewCase();
    const remote = structuredClone(fixture.remoteValue) as Record<
      string,
      JsonValue
    >;
    remote.affectedRecordIds = ["remote-only-record"];
    const conflictId = "conflict-review-owner-drift";
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: conflictId,
          recordType: "review",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-review-owner-drift",
          remoteValue: remote as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-review-owner-drift",
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("Expected Review conflict to preserve both versions");
    const beforeResolve = structuredClone(opened.workspace);

    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: remote as JsonValue,
          rationale: "Attempt unsafe remote Review retention.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-review-owner-drift",
      }),
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("Expected ownership-drift rejection");
    expect(resolved.rejection).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      gate:
        "reference:ReviewRecord:portfolio-event-review:affectedRecordIds:remote-only-record",
    });
    expect(resolved.workspace).toEqual(beforeResolve);
  });

  it("retains a Close return disposition when there are no unfinished artifacts to derive", async () => {
    const workspace = buildBetConflictWorkspace();
    workspace.projects[0].stage = "closed";
    workspace.closeDecisions = [
      {
        id: "close-side-effect-drift",
        projectId: "project-1",
        successComparison: "Compared against success evidence.",
        outcome: "partial",
        keyLearning: "Local learning.",
        unfinishedDisposition: "historical_incomplete",
        actorId: "local-human",
        closedAt: "2026-07-11T23:00:00.000Z",
      },
    ];
    const remote = {
      ...structuredClone(workspace.closeDecisions[0]),
      keyLearning: "Remote learning.",
      unfinishedDisposition: "return_to_inbox" as const,
      actorId: "remote-human",
    };
    const conflictId = "conflict-close-side-effect-drift";
    const opened = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: conflictId,
          recordType: "close",
          recordId: remote.id,
          commonAncestorHash: "ancestor-close-side-effect-drift",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(workspace.revision, {
        commandId: "open-close-side-effect-drift",
      }),
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("Expected Close conflict to preserve both versions");
    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: `review:sync_conflict:${conflictId}`,
        resolution: {
          conflictId,
          retainedVersion: "remote",
          retainedValue: remote as unknown as JsonValue,
          rationale: "No unfinished work exists, so no Inbox artifact is derived.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-close-side-effect-drift",
      }),
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("Expected zero-artifact Close retention");
    expect(resolved.workspace.closeDecisions).toEqual([remote]);
    expect(resolved.workspace.inboxItems).toEqual([]);
  });

  it.each([
    {
      name: "empty rationale",
      mutate(remote: ExceptionRecord) {
        remote.rationale = "";
      },
    },
    {
      name: "empty known consequence",
      mutate(remote: ExceptionRecord) {
        remote.knownConsequence = "";
      },
    },
    {
      name: "empty history note",
      mutate(remote: ExceptionRecord) {
        remote.history[0].note = "";
      },
    },
  ])("rejects a remote Exception with $name", async ({ name, mutate }) => {
    const fixture = buildExceptionCase();
    const remote = structuredClone(
      fixture.remoteValue,
    ) as unknown as ExceptionRecord;
    mutate(remote);

    const result = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: `conflict-invalid-exception-${name.split(" ").join("-")}`,
          recordType: "exception",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-invalid-exception",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: `open-invalid-exception-${name.split(" ").join("-")}`,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid Exception rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: expect.stringContaining(":remote_semantics"),
    });
    expect(result.workspace).toEqual(fixture.workspace);
  });

  it.each([
    {
      name: "empty success comparison",
      mutate(remote: CloseDecision) {
        remote.successComparison = "";
      },
    },
    {
      name: "empty key learning",
      mutate(remote: CloseDecision) {
        remote.keyLearning = "";
      },
    },
  ])("rejects a remote Close with $name", async ({ name, mutate }) => {
    const workspace = buildBetConflictWorkspace();
    workspace.projects[0].stage = "closed";
    workspace.closeDecisions = [
      {
        id: "close-invalid-semantic",
        projectId: "project-1",
        successComparison: "Compared against success evidence.",
        outcome: "achieved",
        keyLearning: "A useful learning.",
        unfinishedDisposition: "historical_incomplete",
        actorId: "local-human",
        closedAt: "2026-07-11T23:00:00.000Z",
      },
    ];
    const remote = structuredClone(workspace.closeDecisions[0]);
    mutate(remote);

    const result = await executeCommand(
      workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: `conflict-invalid-close-${name.split(" ").join("-")}`,
          recordType: "close",
          recordId: remote.id,
          commonAncestorHash: "ancestor-invalid-close",
          remoteValue: remote as unknown as JsonValue,
        },
      },
      conflictSourceContext(workspace.revision, {
        commandId: `open-invalid-close-${name.split(" ").join("-")}`,
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid Close rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: expect.stringContaining(":remote_semantics"),
    });
    expect(result.workspace).toEqual(workspace);
  });

  it("rejects non-canonical timestamps for every protected remote type", async () => {
    const cases = [
      { fixture: buildBetCase(), field: "appetiteStart" },
      { fixture: buildActionCommitmentCase(), field: "committedAt" },
      { fixture: buildPortfolioReviewCase(), field: "dueAt" },
      { fixture: buildExceptionCase(), field: "expiresAt" },
    ];
    for (const { fixture, field } of cases) {
      const remote = structuredClone(fixture.remoteValue) as Record<
        string,
        JsonValue
      >;
      remote[field] = "not-an-iso-date";
      const result = await executeCommand(
        fixture.workspace,
        {
          type: "open_sync_conflict",
          conflict: {
            id: `conflict-invalid-time-${fixture.recordType}`,
            recordType: fixture.recordType,
            recordId: fixture.recordId,
            commonAncestorHash: "ancestor-invalid-time",
            remoteValue: remote as JsonValue,
          },
        },
        conflictSourceContext(fixture.workspace.revision, {
          commandId: `open-invalid-time-${fixture.recordType}`,
        }),
      );
      expect(result.ok, fixture.name).toBe(false);
      if (result.ok) throw new Error(`Expected invalid ${fixture.name}`);
      expect(result.rejection.code).toBe("INVALID_COMMAND");
      expect(result.workspace).toEqual(fixture.workspace);
    }

    const closeWorkspace = buildBetConflictWorkspace();
    closeWorkspace.projects[0].stage = "closed";
    closeWorkspace.closeDecisions = [
      {
        id: "close-invalid-time",
        projectId: "project-1",
        successComparison: "Compared.",
        outcome: "achieved",
        keyLearning: "Learned.",
        unfinishedDisposition: "historical_incomplete",
        actorId: "local-human",
        closedAt: "2026-07-11T23:00:00.000Z",
      },
    ];
    const invalidClose = {
      ...structuredClone(closeWorkspace.closeDecisions[0]),
      closedAt: "not-an-iso-date",
    };
    const closeResult = await executeCommand(
      closeWorkspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-close-invalid-time",
          recordType: "close",
          recordId: invalidClose.id,
          commonAncestorHash: "ancestor-invalid-close-time",
          remoteValue: invalidClose as unknown as JsonValue,
        },
      },
      conflictSourceContext(closeWorkspace.revision, {
        commandId: "open-close-invalid-time",
      }),
    );
    expect(closeResult.ok).toBe(false);
    if (closeResult.ok) throw new Error("Expected invalid CloseDecision");
    expect(closeResult.rejection.code).toBe("INVALID_COMMAND");
    expect(closeResult.workspace).toEqual(closeWorkspace);
  });

  it("does not treat reappliedCommandId as authority or execute it", async () => {
    const fixture = buildBetCase();
    const opened = await executeCommand(
      fixture.workspace,
      {
        type: "open_sync_conflict",
        conflict: {
          id: "conflict-no-forged-reapply",
          recordType: "bet",
          recordId: fixture.recordId,
          commonAncestorHash: "ancestor-no-forged-reapply",
          remoteValue: fixture.remoteValue,
        },
      },
      conflictSourceContext(fixture.workspace.revision, {
        commandId: "open-no-forged-reapply",
      }),
    );
    if (!opened.ok) throw new Error("Expected conflict fixture");
    const resolved = await executeCommand(
      opened.workspace,
      {
        type: "resolve_sync_conflict",
        reviewId: "review:sync_conflict:conflict-no-forged-reapply",
        resolution: {
          conflictId: "conflict-no-forged-reapply",
          retainedVersion: "local",
          retainedValue: structuredClone(fixture.localValue),
          reappliedCommandId: "forged-human-command",
          rationale: "Resolve only; do not execute the claimed command.",
        },
      },
      humanResolutionContext(opened.workspace.revision, {
        commandId: "resolve-no-forged-reapply",
      }),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("Expected explicit human resolution");
    expect(
      resolved.workspace.commandReceipts.some(
        ({ commandId }) => commandId === "forged-human-command",
      ),
    ).toBe(false);
    expect(resolved.workspace.bets[0]).toEqual(fixture.workspace.bets[0]);
  });
});
