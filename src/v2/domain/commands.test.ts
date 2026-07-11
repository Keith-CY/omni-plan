import { describe, expect, it } from "vitest";

import type { Evidence } from "@/domain/types";

import {
  buildCapacityProfile,
  buildInboxItem,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "./commands";
import { stableHash } from "./stableHash";
import type {
  Action,
  ActualV2,
  CapacityProfile,
  CommandReceipt,
  DailyCommitment,
  JsonValue,
  ProjectHold,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

const NOW = "2026-07-11T09:00:00.000Z";
const LATER = "2026-07-11T10:00:00.000Z";

const PROFILE: CapacityProfile = {
  timeZone: "Asia/Tokyo",
  weeklyWindows: [{ weekday: 6, startMinute: 540, finishMinute: 1_020 }],
  dailyBudgets: [
    {
      weekday: 6,
      deepSeconds: 7_200,
      mediumSeconds: 3_600,
      shallowSeconds: 1_800,
    },
  ],
  unavailableBlocks: [
    { id: "away-1", start: NOW, finish: "2026-07-11T09:30:00.000Z" },
  ],
  updatedAt: NOW,
  updatedBy: "human-1",
};

const WORK_ITEM: ProjectWorkItem = {
  id: "work-item-1",
  projectId: "project-1",
  kind: "task",
  title: "Implement the command engine",
  outline: "Keep command application atomic",
  durationSeconds: 3_600,
  estimate: { mostLikelySeconds: 3_600 },
  assignmentIds: [],
  percentComplete: 0,
  revision: 1,
  betScopeId: "scope-1",
};

const ACTUAL: ActualV2 = {
  id: "actual-1",
  revision: 1,
  target: { kind: "work_item", workItemId: WORK_ITEM.id },
  actualWorkSeconds: 600,
  remainingWorkSeconds: 3_000,
  actualCost: 0,
  recordedAt: NOW,
};

const EVIDENCE: Evidence = {
  id: "evidence-1",
  kind: "note",
  summary: "Command engine behavior verified",
  projectId: "project-1",
  workItemId: WORK_ITEM.id,
  createdAt: NOW,
  confidence: 1,
  tags: ["command"],
};

const COMMITMENT_SLOT = {
  id: "slot-1",
  target: {
    kind: "work_item" as const,
    workItemId: WORK_ITEM.id,
    projectId: WORK_ITEM.projectId,
  },
  targetRevision: WORK_ITEM.revision,
  start: NOW,
  finish: LATER,
  attention: "deep" as const,
};

function buildContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: "command-1",
    expectedRevision: 0,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "source-1",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: NOW,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected command rejection");
  }
  return result;
}

async function expectCanonicalReceiptHashes(
  receipt: CommandReceipt,
  command: V2Command,
): Promise<void> {
  expect(receipt.payloadHash).toBe(
    await stableHash(command as unknown as JsonValue),
  );
  const { receiptHash, ...receiptBase } = receipt;
  expect(receiptHash).toBe(
    await stableHash(receiptBase as unknown as JsonValue),
  );
}

function buildStoredAppliedReceipt(
  commandId: string,
  revision: number,
): CommandReceipt {
  return {
    id: commandId,
    commandId,
    commandType: "capture_inbox",
    baseRevision: revision - 1,
    revision,
    payloadHash: "persisted-payload-hash",
    receiptHash: "persisted-receipt-hash",
    actorId: "human-previous",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "source-previous",
      verified: true,
      capabilities: ["human_decision"],
    },
    status: "applied",
    createdAt: NOW,
    diff: [],
  };
}

function buildProjectWorkspace(
  hold?: ProjectHold,
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  return buildWorkspaceV2("workspace-1", {
    revision: 11,
    projects: [
      buildProjectV2({
        id: "project-1",
        activeDirectionBriefId: "brief-1",
        holds:
          hold === undefined
            ? []
            : [
                {
                  type: hold,
                  sourceId: `${hold}-source`,
                  affectedRecordIds: [WORK_ITEM.id],
                  createdAt: NOW,
                },
              ],
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
    ...overrides,
  });
}

function buildCommitment(
  overrides: Partial<DailyCommitment> = {},
): DailyCommitment {
  return {
    id: "commitment-1",
    localDate: "2026-07-11",
    version: 1,
    proposalHash: "commitment-hash",
    capacitySnapshot: structuredClone(PROFILE),
    slots: [COMMITMENT_SLOT],
    actorId: "human-1",
    committedAt: NOW,
    ...overrides,
  };
}

const ALL_COMMANDS = [
  { type: "configure_capacity", profile: PROFILE },
  { type: "capture_inbox", id: "inbox-1", text: "Capture this" },
  {
    type: "confirm_action_triage",
    inboxItemId: "inbox-1",
    action: {
      id: "action-1",
      title: "Single action",
      eligibility: {
        singleSession: true,
        estimateSeconds: 1_800,
        dependencyIds: [],
        requiresMilestoneEvidence: false,
        outcomeCount: 1,
        solutionKnown: true,
      },
      attention: "medium",
    },
  },
  {
    type: "confirm_project_triage",
    inboxItemId: "inbox-1",
    eligibility: {
      singleSession: true,
      estimateSeconds: 1_800,
      dependencyIds: [],
      requiresMilestoneEvidence: false,
      outcomeCount: 1,
      solutionKnown: true,
    },
    project: { id: "project-1", name: "Project", priority: 1, notes: "" },
  },
  {
    type: "update_project_metadata",
    projectId: "project-1",
    name: "Renamed project",
  },
  { type: "update_action", actionId: "action-1", patch: { title: "Next" } },
  {
    type: "complete_action",
    actionId: "action-1",
    actualSeconds: 900,
    outcomeNote: "Done",
  },
  {
    type: "promote_action_to_project",
    actionId: "action-1",
    project: { id: "project-1", name: "Project", priority: 1, notes: "" },
  },
  {
    type: "update_direction",
    projectId: "project-1",
    brief: {
      id: "brief-1",
      projectId: "project-1",
      audienceAndProblem: "Audience and problem",
      successEvidence: "Success evidence",
      appetiteSeconds: 86_400,
      validationMethod: "Run tests",
      firstScope: [
        { id: "scope-1", title: "Scope", description: "Committed scope" },
      ],
      noGoOrKill: "Stop on invariant failure",
      advancedNotes: "",
    },
  },
  { type: "place_bet", projectId: "project-1", betId: "bet-1", start: NOW },
  { type: "create_work_item", projectId: "project-1", workItem: WORK_ITEM },
  {
    type: "update_work_item",
    projectId: "project-1",
    workItemId: WORK_ITEM.id,
    patch: { title: "Updated work", betScopeId: "scope-2" },
  },
  {
    type: "propose_replan",
    proposal: {
      id: "proposal-1",
      localDate: "2026-07-11",
      baseCommitmentId: "commitment-1",
      baseRevision: 0,
      reasonCodes: ["actual_changed"],
      proposedSlots: [COMMITMENT_SLOT],
      proposalHash: "proposal-hash",
      createdAt: NOW,
      createdBy: "human-1",
      status: "open",
    },
  },
  {
    type: "commit_today",
    commitment: {
      id: "commitment-1",
      localDate: "2026-07-11",
      proposalHash: "proposal-hash",
      slots: [COMMITMENT_SLOT],
    },
  },
  {
    type: "accept_replan",
    proposalId: "proposal-1",
    commitmentId: "commitment-1",
  },
  { type: "record_actual", actual: ACTUAL },
  { type: "attach_evidence", evidence: EVIDENCE },
  {
    type: "approve_evidence_exception",
    exception: {
      id: "exception-1",
      projectId: "project-1",
      requirementId: WORK_ITEM.id,
      rationale: "External service unavailable",
      knownConsequence: "Evidence arrives later",
      reviewAt: LATER,
      expiresAt: "2026-07-12T09:00:00.000Z",
    },
  },
  {
    type: "resolve_evidence_exception",
    exceptionId: "exception-1",
    resolution: "Evidence attached",
  },
  { type: "request_validation", projectId: "project-1" },
  { type: "satisfy_validation", projectId: "project-1" },
  {
    type: "record_bet_boundary",
    projectId: "project-1",
    boundary: "midpoint",
    triggerKey: "bet-1:midpoint",
  },
  {
    type: "mark_review_overdue",
    reviewId: "review-1",
    triggerKey: "review-1:overdue",
  },
  {
    type: "create_review",
    review: {
      id: "review-1",
      kind: "event",
      triggerKey: "review-1:create",
      triggerType: "hard_gate",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: [WORK_ITEM.id],
      dueAt: LATER,
    },
  },
  {
    type: "complete_review",
    reviewId: "review-1",
    conclusion: {
      summary: "Continue",
      decisionCodes: ["continue"],
      followUpCommandIds: [],
    },
  },
  {
    type: "resolve_sync_conflict",
    reviewId: "review-1",
    resolution: {
      conflictId: "conflict-1",
      retainedVersion: "local",
      rationale: "Local decision was authoritative",
    },
  },
  {
    type: "close_project",
    projectId: "project-1",
    decision: {
      id: "close-1",
      projectId: "project-1",
      successComparison: "Target met",
      outcome: "achieved",
      keyLearning: "Atomicity matters",
      unfinishedDisposition: "discard",
    },
  },
  {
    type: "abandon_project",
    projectId: "project-1",
    decision: {
      id: "close-2",
      projectId: "project-1",
      successComparison: "No longer valuable",
      outcome: "abandoned",
      keyLearning: "Stop deliberately",
      unfinishedDisposition: "historical_incomplete",
    },
  },
  { type: "archive_project", projectId: "project-1", archived: true },
] as const satisfies readonly V2Command[];

const EXPECTED_COMMAND_TYPES = [
  "configure_capacity",
  "capture_inbox",
  "confirm_action_triage",
  "confirm_project_triage",
  "update_project_metadata",
  "update_action",
  "complete_action",
  "promote_action_to_project",
  "update_direction",
  "place_bet",
  "create_work_item",
  "update_work_item",
  "propose_replan",
  "commit_today",
  "accept_replan",
  "record_actual",
  "attach_evidence",
  "approve_evidence_exception",
  "resolve_evidence_exception",
  "request_validation",
  "satisfy_validation",
  "record_bet_boundary",
  "mark_review_overdue",
  "create_review",
  "complete_review",
  "resolve_sync_conflict",
  "close_project",
  "abandon_project",
  "archive_project",
] as const;

describe("V2Command public contract", () => {
  it("exercises every command variant exhaustively", () => {
    const exhaustive: Exclude<
      V2Command["type"],
      (typeof ALL_COMMANDS)[number]["type"]
    > extends never
      ? true
      : false = true;

    expect(exhaustive).toBe(true);
    expect(ALL_COMMANDS.map(({ type }) => type)).toEqual(
      EXPECTED_COMMAND_TYPES,
    );
  });

  it.each(ALL_COMMANDS)(
    "accepts the typed sample structure for $type",
    async (command) => {
      const isSystemCommand = [
        "record_bet_boundary",
        "mark_review_overdue",
        "create_review",
      ].includes(command.type);
      const context = isSystemCommand
        ? buildContext({
            actorId: "system-1",
            actorKind: "system",
            origin: "agent",
            source: {
              sourceId: "clock-1",
              verified: true,
              capabilities: ["system_time"],
            },
          })
        : buildContext();

      const result = await executeCommand(
        buildWorkspaceV2("workspace-1"),
        structuredClone(command),
        context,
      );

      if (!result.ok) {
        expect(result.rejection.code).not.toBe("INVALID_COMMAND");
      }
    },
  );
});

describe("executeCommand applied receipts", () => {
  it("applies configure_capacity atomically with one exact deterministic diff", async () => {
    const workspace = deepFreeze(
      buildWorkspaceV2("workspace-1", { revision: 7 }),
    );
    const command = deepFreeze({
      type: "configure_capacity",
      profile: structuredClone(PROFILE),
    } as const satisfies V2Command);
    const context = buildContext({ expectedRevision: 7 });

    const result = await executeCommand(workspace, command, context);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected applied command");
    const expectedDiff = [
      {
        entity: "WorkspaceV2",
        entityId: "workspace-1",
        field: "capacityProfile",
        before: null,
        after: PROFILE,
      },
    ];
    const receiptBase = {
      id: "command-1",
      commandId: "command-1",
      commandType: "configure_capacity",
      baseRevision: 7,
      revision: 8,
      payloadHash: await stableHash(command as unknown as JsonValue),
      actorId: "human-1",
      actorKind: "human" as const,
      origin: "ui" as const,
      source: {
        sourceId: "source-1",
        verified: true,
        capabilities: ["human_decision" as const],
      },
      status: "applied" as const,
      createdAt: NOW,
      diff: expectedDiff,
    };

    expect(result.workspace).not.toBe(workspace);
    expect(result.workspace.revision).toBe(8);
    expect(result.workspace.capacityProfile).toEqual(PROFILE);
    expect(result.workspace.capacityProfile).not.toBe(command.profile);
    expect(result.workspace.commandReceipts).toHaveLength(1);
    expect(result.receipt).toEqual({
      ...receiptBase,
      receiptHash: await stableHash(receiptBase as unknown as JsonValue),
    });
    expect(result.workspace.commandReceipts[0]).toEqual(result.receipt);
    expect(result.workspace.commandReceipts[0]).not.toBe(result.receipt);
    expect(result.workspace.commandReceipts[0].source).not.toBe(
      result.receipt.source,
    );
    expect(workspace.revision).toBe(7);
    expect(workspace.capacityProfile).toBeUndefined();
    expect(workspace.commandReceipts).toEqual([]);
    await expectCanonicalReceiptHashes(result.receipt, command);
  });

  it("defers semantic capacity rules while accepting a structurally typed profile", async () => {
    const deferredProfile: CapacityProfile = {
      timeZone: "",
      weeklyWindows: [
        { weekday: 6, startMinute: -60, finishMinute: 2_000 },
      ],
      dailyBudgets: [
        {
          weekday: 6,
          deepSeconds: -1,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
      unavailableBlocks: [{ id: "", start: "", finish: "" }],
      updatedAt: "",
      updatedBy: "",
    };
    const workspace = buildWorkspaceV2("workspace-1");

    const result = await executeCommand(
      workspace,
      { type: "configure_capacity", profile: deferredProfile },
      buildContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected typed profile to apply");
    expect(result.workspace.capacityProfile).toEqual(deferredProfile);
    expect(result.workspace.revision).toBe(1);
  });

  it("captures only an InboxItem and emits the exact creation diff", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "capture_inbox",
      id: "inbox-1",
      text: "Prepare launch notes",
      desiredDate: "2026-07-12T09:00:00.000Z",
    } as const satisfies V2Command;

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected applied command");
    const inboxItem = {
      id: "inbox-1",
      originalText: "Prepare launch notes",
      sourceId: "source-1",
      actorId: "human-1",
      capturedAt: NOW,
      desiredDate: "2026-07-12T09:00:00.000Z",
      triageStatus: "untriaged" as const,
    };

    expect(result.workspace.revision).toBe(1);
    expect(result.workspace.inboxItems).toEqual([inboxItem]);
    expect(result.workspace.actions).toEqual([]);
    expect(result.workspace.projects).toEqual([]);
    expect(result.workspace.dailyCommitments).toEqual([]);
    expect(result.workspace.commandReceipts).toHaveLength(1);
    expect(result.receipt.diff).toEqual([
      {
        entity: "InboxItem",
        entityId: "inbox-1",
        field: "created",
        before: null,
        after: inboxItem,
      },
    ]);
    expect(workspace.inboxItems).toEqual([]);
    expect(workspace.revision).toBe(0);
    expect(workspace.commandReceipts).toEqual([]);
    await expectCanonicalReceiptHashes(result.receipt, command);
  });

  it("rejects a duplicate InboxItem ID without storing a misleading receipt", async () => {
    const existing = buildInboxItem({
      id: "duplicate-inbox",
      originalText: "aaa",
      sourceId: "source-1",
      actorId: "human-1",
      capturedAt: NOW,
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      inboxItems: [existing],
    });
    const command = {
      type: "capture_inbox",
      id: existing.id,
      text: "zzz",
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.workspace.revision).toBe(0);
    expect(result.workspace.inboxItems).toEqual([existing]);
    expect(result.workspace.commandReceipts).toEqual([]);
    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      reason: "InboxItem duplicate-inbox already exists.",
      gate: "entity_id:InboxItem:duplicate-inbox",
      permittedNextCommand: "capture_inbox",
    });
    expect(result.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "ENTITY_ALREADY_EXISTS",
      diff: [],
    });
  });

  it.each([
    {
      name: "null capacity profile",
      command: { type: "configure_capacity", profile: null },
      gate: "command_payload:configure_capacity",
    },
    {
      name: "non-string Inbox text",
      command: { type: "capture_inbox", id: "inbox-invalid", text: null },
      gate: "command_payload:capture_inbox",
    },
    {
      name: "non-finite capacity number",
      command: {
        type: "configure_capacity",
        profile: {
          ...PROFILE,
          dailyBudgets: [
            { ...PROFILE.dailyBudgets[0], deepSeconds: Number.NaN },
          ],
        },
      },
      gate: "command_payload:configure_capacity",
    },
  ])("rejects a malformed runtime payload: $name", async ({ command, gate }) => {
    const workspace = buildWorkspaceV2("workspace-1");

    const result = rejected(
      await executeCommand(
        workspace,
        command as unknown as V2Command,
        buildContext(),
      ),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.workspace.revision).toBe(0);
    expect(result.workspace.capacityProfile).toBeUndefined();
    expect(result.workspace.inboxItems).toEqual([]);
    expect(result.workspace.commandReceipts).toEqual([]);
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate,
      permittedNextCommand: command.type,
    });
    expect(result.receipt).toMatchObject({
      status: "rejected",
      rejectionCode: "INVALID_COMMAND",
      revision: 0,
      diff: [],
    });
  });

  it("rejects an unknown runtime command type instead of throwing", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = { type: "erase_workspace" } as unknown as V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_type:erase_workspace",
      permittedNextCommand: "use_supported_command",
    });
    expect(result.receipt).toMatchObject({
      commandType: "erase_workspace",
      status: "rejected",
      rejectionCode: "INVALID_COMMAND",
      revision: 0,
      diff: [],
    });
  });

  it.each([
    { name: "null command", command: null },
    { name: "missing command type", command: {} },
    { name: "object-valued command type", command: { type: { x: 1 } } },
  ])(
    "normalizes the receipt type for an invalid runtime envelope: $name",
    async ({ command }) => {
      const workspace = buildWorkspaceV2("workspace-1");

      const result = rejected(
        await executeCommand(
          workspace,
          command as unknown as V2Command,
          buildContext(),
        ),
      );

      expect(result.workspace).toBe(workspace);
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: "command_type:invalid_command",
      });
      expect(result.receipt).toMatchObject({
        commandType: "invalid_command",
        status: "rejected",
        rejectionCode: "INVALID_COMMAND",
        revision: 0,
        diff: [],
      });
      expect(typeof result.receipt.commandType).toBe("string");
    },
  );

  it.each([
    { type: "record_actual", actual: null },
    { type: "close_project", projectId: "project-1", decision: null },
    { type: "propose_replan", proposal: null },
  ])(
    "rejects malformed nested payloads for known command $type without throwing",
    async (command) => {
      const workspace = buildWorkspaceV2("workspace-1");

      const result = rejected(
        await executeCommand(
          workspace,
          command as unknown as V2Command,
          buildContext(),
        ),
      );

      expect(result.workspace).toBe(workspace);
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: `command_payload:${command.type}`,
        permittedNextCommand: command.type,
      });
      expect(result.receipt).toMatchObject({
        commandType: command.type,
        status: "rejected",
        rejectionCode: "INVALID_COMMAND",
        revision: 0,
        diff: [],
      });
    },
  );

  it("rejects a malformed system command after system authorization", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "create_review",
      review: null,
    } as unknown as V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          actorId: "system-1",
          actorKind: "system",
          origin: "agent",
          source: {
            sourceId: "clock-1",
            verified: true,
            capabilities: ["system_time"],
          },
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:create_review",
      permittedNextCommand: "create_review",
    });
    expect(result.receipt).toMatchObject({
      commandType: "create_review",
      rejectionCode: "INVALID_COMMAND",
    });
  });

  it.each([
    {
      name: "incomplete ProjectDraft",
      command: {
        type: "confirm_project_triage",
        inboxItemId: "inbox-1",
        project: { id: "project-1" },
      },
    },
    {
      name: "incomplete CommitmentSlot",
      command: {
        type: "commit_today",
        commitment: {
          id: "commitment-1",
          localDate: "2026-07-11",
          proposalHash: "proposal-hash",
          slots: [
            {
              id: "slot-1",
              target: { kind: "action", actionId: "action-1" },
            },
          ],
        },
      },
    },
  ])("rejects an exact-contract violation: $name", async ({ command }) => {
    const workspace = buildWorkspaceV2("workspace-1");

    const result = rejected(
      await executeCommand(
        workspace,
        command as unknown as V2Command,
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: `command_payload:${command.type}`,
      permittedNextCommand: command.type,
    });
    expect(result.receipt.rejectionCode).toBe("INVALID_COMMAND");
  });

  it("checks source authority before rejecting a malformed known payload", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "record_actual",
      actual: null,
    } as unknown as V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          source: {
            sourceId: "unverified",
            verified: false,
            capabilities: [],
          },
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: "verified_source",
    });
    expect(result.receipt).toMatchObject({
      commandType: "record_actual",
      rejectionCode: "SOURCE_NOT_AUTHORIZED",
    });
  });

  it("produces equal receipts for repeated inputs on fresh equal workspaces", async () => {
    const command = {
      type: "capture_inbox",
      id: "inbox-repeat",
      text: "Repeat deterministically",
    } as const satisfies V2Command;
    const context = buildContext({ commandId: "command-repeat" });

    const first = await executeCommand(
      buildWorkspaceV2("workspace-1"),
      structuredClone(command),
      structuredClone(context),
    );
    const second = await executeCommand(
      buildWorkspaceV2("workspace-1"),
      structuredClone(command),
      structuredClone(context),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.receipt).toEqual(second.receipt);
    expect(first.workspace).toEqual(second.workspace);
  });

  it("snapshots source identity and capabilities into stored history", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const source: CommandContext["source"] = {
      sourceId: "source-snapshot",
      verified: true,
      capabilities: ["human_decision"],
    };
    const context = buildContext({ source });

    const result = await executeCommand(
      workspace,
      { type: "configure_capacity", profile: structuredClone(PROFILE) },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected applied command");

    source.sourceId = "mutated-source";
    source.capabilities.push("capture_inbox");

    expect(result.receipt.source).toEqual({
      sourceId: "source-snapshot",
      verified: true,
      capabilities: ["human_decision"],
    });
    expect(result.workspace.commandReceipts[0].source).toEqual(
      result.receipt.source,
    );
    await expectCanonicalReceiptHashes(
      result.workspace.commandReceipts[0],
      { type: "configure_capacity", profile: PROFILE },
    );
  });

  it("snapshots command and context inputs before the first async yield", async () => {
    const profile = structuredClone(PROFILE);
    const command: V2Command = { type: "configure_capacity", profile };
    const source: CommandContext["source"] = {
      sourceId: "source-before-yield",
      verified: true,
      capabilities: ["human_decision"],
    };
    const context = buildContext({ source });
    const originalCommand = structuredClone(command);

    const workspace = buildWorkspaceV2("workspace-1");
    const execution = executeCommand(workspace, command, context);
    profile.timeZone = "Mutated/Zone";
    source.sourceId = "source-after-yield";
    source.capabilities.push("capture_inbox");
    context.now = LATER;
    workspace.revision = 9;
    workspace.inboxItems.push(
      buildInboxItem({
        id: "concurrent-inbox",
        sourceId: "concurrent-source",
        actorId: "concurrent-actor",
        capturedAt: LATER,
      }),
    );
    const result = await execution;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected applied command");
    expect(result.workspace.capacityProfile).toEqual(PROFILE);
    expect(result.workspace.revision).toBe(1);
    expect(result.workspace.inboxItems).toEqual([]);
    expect(result.receipt).toMatchObject({
      baseRevision: 0,
      revision: 1,
      payloadHash: await stableHash(originalCommand as unknown as JsonValue),
      source: {
        sourceId: "source-before-yield",
        verified: true,
        capabilities: ["human_decision"],
      },
      createdAt: NOW,
      diff: [
        {
          entity: "WorkspaceV2",
          entityId: "workspace-1",
          field: "capacityProfile",
          before: null,
          after: PROFILE,
        },
      ],
    });
  });
});

describe("executeCommand rejection precedence and atomicity", () => {
  it("lets stale revision win before duplicate, authorization, and handler", async () => {
    const workspace = deepFreeze(
      buildWorkspaceV2("workspace-1", {
        revision: 3,
        commandReceipts: [buildStoredAppliedReceipt("command-1", 3)],
      }),
    );
    const command = deepFreeze({
      type: "update_action",
      actionId: "missing-action",
      patch: { title: "Never applied" },
    } as const satisfies V2Command);
    const context = deepFreeze(
      buildContext({
        expectedRevision: 2,
        actorKind: "agent",
        origin: "agent",
        source: { sourceId: "unverified", verified: false, capabilities: [] },
      }),
    );

    const result = rejected(await executeCommand(workspace, command, context));

    expect(result.workspace).toBe(workspace);
    expect(result.rejection.code).toBe("REVISION_CONFLICT");
    expect(result.receipt).toMatchObject({
      id: "command-1",
      commandId: "command-1",
      commandType: "update_action",
      baseRevision: 3,
      revision: 3,
      actorId: "human-1",
      actorKind: "agent",
      origin: "agent",
      source: { sourceId: "unverified", verified: false, capabilities: [] },
      status: "rejected",
      createdAt: NOW,
      diff: [],
      rejectionCode: "REVISION_CONFLICT",
    });
    expect(result.workspace.commandReceipts).toHaveLength(1);
    await expectCanonicalReceiptHashes(result.receipt, command);
  });

  it("snapshots a rejected receipt before caller mutation and returns the original reference", async () => {
    const workspace = buildWorkspaceV2("workspace-1", { revision: 2 });
    const command: V2Command = {
      type: "update_action",
      actionId: "action-1",
      patch: { title: "Original title" },
    };
    const source: CommandContext["source"] = {
      sourceId: "source-original",
      verified: true,
      capabilities: ["human_decision"],
    };
    const context = buildContext({
      expectedRevision: 1,
      source,
    });
    const originalCommand = structuredClone(command);

    const execution = executeCommand(workspace, command, context);
    command.patch.title = "Mutated title";
    source.sourceId = "source-mutated";
    source.capabilities.push("capture_inbox");
    context.now = LATER;
    workspace.revision = 9;
    const result = rejected(await execution);

    expect(result.workspace).toBe(workspace);
    expect(result.rejection).toMatchObject({
      code: "REVISION_CONFLICT",
      workspaceRevision: 2,
    });
    expect(result.receipt).toMatchObject({
      baseRevision: 2,
      revision: 2,
      payloadHash: await stableHash(originalCommand as unknown as JsonValue),
      source: {
        sourceId: "source-original",
        verified: true,
        capabilities: ["human_decision"],
      },
      createdAt: NOW,
      status: "rejected",
      rejectionCode: "REVISION_CONFLICT",
      diff: [],
    });
  });

  it("lets a duplicate applied command ID win before authorization and handler", async () => {
    const workspace = buildWorkspaceV2("workspace-1", {
      revision: 3,
      commandReceipts: [buildStoredAppliedReceipt("command-1", 3)],
    });
    const command = {
      type: "place_bet",
      projectId: "missing-project",
      betId: "bet-1",
      start: NOW,
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          expectedRevision: 3,
          actorKind: "agent",
          origin: "agent",
          source: { sourceId: "unverified", verified: false, capabilities: [] },
        }),
      ),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection.code).toBe("DUPLICATE_COMMAND");
    expect(result.receipt.rejectionCode).toBe("DUPLICATE_COMMAND");
    expect(workspace.commandReceipts).toHaveLength(1);
  });

  it("treats any stored receipt status as reserving its command ID", async () => {
    const rejectedReceipt: CommandReceipt = {
      ...buildStoredAppliedReceipt("command-1", 3),
      status: "rejected",
      rejectionCode: "REVISION_CONFLICT",
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      revision: 3,
      commandReceipts: [rejectedReceipt],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "configure_capacity",
          profile: null,
        } as unknown as V2Command,
        buildContext({ expectedRevision: 3 }),
      ),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection.code).toBe("DUPLICATE_COMMAND");
    expect(result.receipt.rejectionCode).toBe("DUPLICATE_COMMAND");
    expect(workspace.commandReceipts).toEqual([rejectedReceipt]);
  });

  it.each(["stale revision", "unauthorized source"] as const)(
    "does not deep-clone the workspace history for a cheap %s rejection",
    async (scenario) => {
      const original = buildWorkspaceV2("workspace-1", { revision: 3 });
      const workspace = new Proxy(original, {});
      const context =
        scenario === "stale revision"
          ? buildContext({ expectedRevision: 2 })
          : buildContext({
              expectedRevision: 3,
              source: {
                sourceId: "unverified",
                verified: false,
                capabilities: [],
              },
            });

      const result = rejected(
        await executeCommand(
          workspace,
          { type: "configure_capacity", profile: PROFILE },
          context,
        ),
      );

      expect(result.workspace).toBe(workspace);
      expect(result.rejection.code).toBe(
        scenario === "stale revision"
          ? "REVISION_CONFLICT"
          : "SOURCE_NOT_AUTHORIZED",
      );
      expect(original.revision).toBe(3);
      expect(original.commandReceipts).toEqual([]);
    },
  );

  it("checks Agent source authority before human-only authority and the handler", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "place_bet",
      projectId: "missing-project",
      betId: "bet-1",
      start: NOW,
    } as const satisfies V2Command;

    const withoutProposalCapability = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          actorKind: "agent",
          origin: "agent",
          source: { sourceId: "agent-source", verified: true, capabilities: [] },
        }),
      ),
    );
    const withProposalCapability = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          commandId: "command-2",
          actorKind: "agent",
          origin: "agent",
          source: {
            sourceId: "agent-source",
            verified: true,
            capabilities: ["submit_proposal"],
          },
        }),
      ),
    );

    expect(withoutProposalCapability.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: "source_capability:submit_proposal",
    });
    expect(withProposalCapability.rejection).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      permittedNextCommand: "place_bet",
    });
    expect(withoutProposalCapability.workspace).toBe(workspace);
    expect(withProposalCapability.workspace).toBe(workspace);
  });

  it("returns COMMAND_NOT_IMPLEMENTED for a recognized human-authorized command", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "update_project_metadata",
      projectId: "missing-project",
      name: "Future handler",
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
    expect(result.receipt.diff).toEqual([]);
    expect(workspace.commandReceipts).toEqual([]);
  });

  it("rolls back a real handler when whole-workspace invariants fail", async () => {
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [
        buildProjectV2({
          id: "invalid-project",
          stage: "executing",
          activeDirectionBriefId: "missing-brief",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
    });
    const originalInbox = workspace.inboxItems;
    const command = {
      type: "capture_inbox",
      id: "rolled-back-inbox",
      text: "Must not leak",
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.rejection.code).toBe("BET_REQUIRED");
    expect(result.workspace).toBe(workspace);
    expect(result.workspace.revision).toBe(0);
    expect(result.workspace.inboxItems).toBe(originalInbox);
    expect(result.workspace.inboxItems).toEqual([]);
    expect(result.workspace.commandReceipts).toEqual([]);
    expect(result.receipt.diff).toEqual([]);
  });

  it("does not persist a rejected receipt, so the same command can be retried", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "capture_inbox",
      id: "retry-inbox",
      text: "Retry me",
    } as const satisfies V2Command;
    const staleContext = buildContext({
      commandId: "retry-command",
      expectedRevision: 99,
    });

    const first = rejected(
      await executeCommand(workspace, command, staleContext),
    );
    const second = await executeCommand(workspace, command, {
      ...staleContext,
      expectedRevision: 0,
    });

    expect(first.rejection.code).toBe("REVISION_CONFLICT");
    expect(first.workspace.commandReceipts).toEqual([]);
    expect(second.ok).toBe(true);
    expect(second.workspace.commandReceipts).toHaveLength(1);
  });
});

describe("executeCommand trusted policy projection", () => {
  it("aggregates holds across duplicate Project IDs independent of input order", async () => {
    const unheld = buildProjectV2({
      id: "project-1",
      activeDirectionBriefId: "brief-1",
      holds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const held = buildProjectV2({
      ...structuredClone(unheld),
      holds: [
        {
          type: "sync_conflict",
          sourceId: "conflict-1",
          affectedRecordIds: ["project-1"],
          createdAt: NOW,
        },
      ],
    });
    const command = {
      type: "update_project_metadata",
      projectId: "project-1",
      name: "Blocked by either duplicate",
    } as const satisfies V2Command;
    const context = buildContext({ expectedRevision: 11 });

    const forward = rejected(
      await executeCommand(
        buildWorkspaceV2("workspace-1", {
          revision: 11,
          projects: [unheld, held],
        }),
        command,
        context,
      ),
    );
    const reverse = rejected(
      await executeCommand(
        buildWorkspaceV2("workspace-1", {
          revision: 11,
          projects: [held, unheld],
        }),
        command,
        { ...context, commandId: "command-reverse-project-order" },
      ),
    );

    expect(forward.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
    expect(reverse.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it.each([
    { type: "request_validation", projectId: "project-1" },
    { type: "satisfy_validation", projectId: "project-1" },
    {
      type: "close_project",
      projectId: "project-1",
      decision: {
        id: "close-1",
        projectId: "project-1",
        successComparison: "Target met",
        outcome: "achieved",
        keyLearning: "Respect conflicts",
        unfinishedDisposition: "discard",
      },
    },
    {
      type: "abandon_project",
      projectId: "project-1",
      decision: {
        id: "close-2",
        projectId: "project-1",
        successComparison: "No longer valuable",
        outcome: "abandoned",
        keyLearning: "Respect conflicts",
        unfinishedDisposition: "historical_incomplete",
      },
    },
  ] as const satisfies readonly V2Command[])(
    "includes active lifecycle records when authorizing $type",
    async (command) => {
      const workspace = buildProjectWorkspace("sync_conflict");
      workspace.projects[0].activeBetId = "bet-current";
      workspace.projects[0].activePlanVersionId = "plan-current";
      workspace.projects[0].holds[0].affectedRecordIds = ["bet-current"];

      const result = rejected(
        await executeCommand(
          workspace,
          command,
          buildContext({
            commandId: `command-${command.type}`,
            expectedRevision: 11,
          }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "sync_conflict",
      });
    },
  );

  it("blocks uncommitted actuals during overdue review but reaches the handler for committed targets", async () => {
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "proposal-hash",
      capacitySnapshot: buildCapacityProfile({
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
      slots: [COMMITMENT_SLOT],
      actorId: "human-1",
      committedAt: NOW,
    };
    const uncommittedWorkspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
    });
    const committedWorkspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [commitment],
    });
    const command = { type: "record_actual", actual: ACTUAL } as const;
    const context = buildContext({ expectedRevision: 11 });

    const uncommitted = rejected(
      await executeCommand(uncommittedWorkspace, command, context),
    );
    const committed = rejected(
      await executeCommand(committedWorkspace, command, context),
    );

    expect(uncommitted.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
    expect(committed.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
  });

  it("blocks project metadata mutation during migration review before the handler", async () => {
    const workspace = buildProjectWorkspace("migration_review");
    const command = {
      type: "update_project_metadata",
      projectId: "project-1",
      name: "Must be blocked",
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "migration_review",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("derives affected target records for sync-conflict overlap checks", async () => {
    const workspace = buildProjectWorkspace("sync_conflict", {
      workItems: [WORK_ITEM],
    });
    const matching = {
      type: "update_work_item",
      projectId: "project-1",
      workItemId: WORK_ITEM.id,
      patch: { title: "Blocked overlap" },
    } as const satisfies V2Command;
    const unrelated = {
      ...matching,
      workItemId: "unrelated-work-item",
    } satisfies V2Command;
    const context = buildContext({ expectedRevision: 11 });

    const matchingResult = rejected(
      await executeCommand(workspace, matching, context),
    );
    const unrelatedResult = rejected(
      await executeCommand(workspace, unrelated, {
        ...context,
        commandId: "command-unrelated",
      }),
    );

    expect(matchingResult.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
    expect(unrelatedResult.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
  });

  it("includes stored Replan targets in sync-conflict overlap checks", async () => {
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "commitment-hash",
      capacitySnapshot: PROFILE,
      slots: [COMMITMENT_SLOT],
      actorId: "human-1",
      committedAt: NOW,
    };
    const workspace = buildProjectWorkspace("sync_conflict", {
      workItems: [WORK_ITEM],
      dailyCommitments: [commitment],
      replanProposals: [
        {
          id: "proposal-1",
          localDate: "2026-07-11",
          baseCommitmentId: commitment.id,
          baseRevision: 11,
          reasonCodes: ["actual_changed"],
          proposedSlots: [COMMITMENT_SLOT],
          proposalHash: "proposal-hash",
          createdAt: NOW,
          createdBy: "human-1",
          status: "open",
        },
      ],
    });
    const command = {
      type: "accept_replan",
      proposalId: "proposal-1",
      commitmentId: commitment.id,
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it("includes a proposal's persisted base-commitment targets in conflict checks", async () => {
    const baseCommitment = buildCommitment();
    const workspace = buildProjectWorkspace("sync_conflict", {
      workItems: [WORK_ITEM],
      dailyCommitments: [baseCommitment],
    });
    const command = {
      type: "propose_replan",
      proposal: {
        id: "proposal-new",
        localDate: baseCommitment.localDate,
        baseCommitmentId: baseCommitment.id,
        baseRevision: 11,
        reasonCodes: ["actual_changed"],
        proposedSlots: [],
        proposalHash: "proposal-new-hash",
        createdAt: NOW,
        createdBy: "human-1",
        status: "open",
      },
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it("includes the current Bet when placing its replacement", async () => {
    const workspace = buildProjectWorkspace("sync_conflict");
    workspace.projects[0].activeBetId = "bet-current";
    workspace.projects[0].holds[0].affectedRecordIds = ["bet-current"];
    const command = {
      type: "place_bet",
      projectId: "project-1",
      betId: "bet-next",
      start: NOW,
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it("includes the current Bet in a system boundary command", async () => {
    const workspace = buildProjectWorkspace("sync_conflict");
    workspace.projects[0].activeBetId = "bet-current";
    workspace.projects[0].holds[0].affectedRecordIds = ["bet-current"];
    const command = {
      type: "record_bet_boundary",
      projectId: "project-1",
      boundary: "expired",
      triggerKey: "bet-current:expired",
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({
          expectedRevision: 11,
          actorId: "system-1",
          actorKind: "system",
          origin: "agent",
          source: {
            sourceId: "clock-1",
            verified: true,
            capabilities: ["system_time"],
          },
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it("includes the effective commitment replaced by commit_today", async () => {
    const effectiveCommitment = buildCommitment();
    const workspace = buildProjectWorkspace("sync_conflict", {
      workItems: [WORK_ITEM],
      dailyCommitments: [effectiveCommitment],
    });
    const command = {
      type: "commit_today",
      commitment: {
        id: "commitment-next",
        localDate: effectiveCommitment.localDate,
        proposalHash: "replacement-hash",
        slots: [],
      },
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
  });

  it("keeps resolve_sync_conflict allowed through an overlapping hold", async () => {
    const workspace = buildProjectWorkspace("sync_conflict", {
      reviews: [
        {
          id: "review-conflict",
          kind: "event",
          triggerKey: "conflict-trigger",
          triggerType: "sync_conflict",
          status: "open",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: [WORK_ITEM.id],
          dueAt: LATER,
          createdAt: NOW,
        },
      ],
      syncConflicts: [
        {
          id: "conflict-1",
          recordType: "daily_commitment",
          recordId: WORK_ITEM.id,
          projectId: "project-1",
          commonAncestorHash: "ancestor-hash",
          localValue: { side: "local" },
          remoteValue: { side: "remote" },
          openedAt: NOW,
        },
      ],
    });
    const command = {
      type: "resolve_sync_conflict",
      reviewId: "review-conflict",
      resolution: {
        conflictId: "conflict-1",
        retainedVersion: "local",
        rationale: "Local is authoritative",
      },
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        command,
        buildContext({ expectedRevision: 11 }),
      ),
    );

    expect(result.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
  });

  it("uses only effective unsuperseded commitments for overdue-review execution", async () => {
    const historical = buildCommitment({ id: "commitment-old" });
    const removed = buildCommitment({
      id: "commitment-new",
      version: 2,
      slots: [],
      committedAt: LATER,
      supersedesId: historical.id,
    });
    const retained = {
      ...removed,
      id: "commitment-retained",
      slots: [COMMITMENT_SLOT],
    };
    const removedWorkspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [historical, removed],
    });
    const retainedWorkspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [historical, retained],
    });
    const command = { type: "record_actual", actual: ACTUAL } as const;
    const context = buildContext({ expectedRevision: 11 });

    const removedResult = rejected(
      await executeCommand(removedWorkspace, command, context),
    );
    const retainedResult = rejected(
      await executeCommand(retainedWorkspace, command, {
        ...context,
        commandId: "command-retained",
      }),
    );

    expect(removedResult.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
    expect(retainedResult.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
  });

  it("selects malformed commitment forks deterministically", async () => {
    const historical = buildCommitment({ id: "commitment-root" });
    const retainedBranch = buildCommitment({
      id: "branch-a",
      version: 2,
      committedAt: LATER,
      supersedesId: historical.id,
    });
    const removedBranch = buildCommitment({
      id: "branch-b",
      version: 3,
      slots: [],
      committedAt: LATER,
      supersedesId: historical.id,
    });
    const buildFork = (commitments: DailyCommitment[]) =>
      buildProjectWorkspace("review_overdue", {
        workItems: [WORK_ITEM],
        dailyCommitments: commitments,
      });
    const command = { type: "record_actual", actual: ACTUAL } as const;
    const context = buildContext({ expectedRevision: 11 });

    const forward = rejected(
      await executeCommand(
        buildFork([historical, retainedBranch, removedBranch]),
        command,
        context,
      ),
    );
    const reverse = rejected(
      await executeCommand(
        buildFork([removedBranch, retainedBranch, historical]),
        command,
        { ...context, commandId: "command-reverse" },
      ),
    );

    expect(forward.rejection.code).toBe("HOLD_BLOCKS_COMMAND");
    expect(reverse.rejection.code).toBe("HOLD_BLOCKS_COMMAND");
  });

  it("projects the typed system boundary trigger key instead of reading caller facts", async () => {
    const workspace = buildProjectWorkspace();
    const context = buildContext({
      expectedRevision: 11,
      actorId: "system-1",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "clock-1",
        verified: true,
        capabilities: ["system_time"],
      },
    });
    const valid = {
      type: "record_bet_boundary",
      projectId: "project-1",
      boundary: "midpoint",
      triggerKey: "project-1:midpoint",
    } as const satisfies V2Command;
    const missing = { ...valid, triggerKey: "   " } satisfies V2Command;

    const validResult = rejected(
      await executeCommand(workspace, valid, context),
    );
    const missingResult = rejected(
      await executeCommand(workspace, missing, {
        ...context,
        commandId: "command-missing-trigger",
      }),
    );

    expect(validResult.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
    expect(missingResult.rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      gate: "deterministic_trigger_key",
    });
  });
});

describe("executeCommand Action triage and promotion", () => {
  const eligibility: Action["eligibility"] = {
    singleSession: true,
    estimateSeconds: 1_800,
    dependencyIds: [],
    requiresMilestoneEvidence: false,
    outcomeCount: 1,
    solutionKnown: true,
  };

  const actionDraft: Extract<
    V2Command,
    { type: "confirm_action_triage" }
  >["action"] = {
    id: "action-triaged",
    title: "Prepare launch notes",
    eligibility,
    attention: "medium",
    desiredDate: "2026-07-12T09:00:00.000Z",
  };

  function buildCapturedWorkspace(): WorkspaceV2 {
    return buildWorkspaceV2("workspace-1", {
      inboxItems: [
        buildInboxItem({
          id: "inbox-triage",
          originalText: "Prepare launch notes",
          sourceId: "capture-source",
          actorId: "human-capture",
          capturedAt: NOW,
        }),
      ],
    });
  }

  function buildOpenActionWorkspace(): WorkspaceV2 {
    const inboxItem = buildInboxItem({
      id: "inbox-triage",
      originalText: "Prepare launch notes",
      sourceId: "capture-source",
      actorId: "human-capture",
      capturedAt: NOW,
      triageStatus: "action",
      actionId: "action-triaged",
      recommendation: {
        kind: "action",
        ruleCodes: [],
        explanation: "Fits the lightweight Action boundary.",
      },
    });
    const action: Action = {
      id: "action-triaged",
      inboxItemId: inboxItem.id,
      title: "Prepare launch notes",
      revision: 3,
      status: "open",
      eligibility: structuredClone(eligibility),
      attention: "medium",
      desiredDate: "2026-07-12T09:00:00.000Z",
      outcomeNote: "Existing outcome history",
      createdAt: NOW,
      updatedAt: NOW,
    };
    return buildWorkspaceV2("workspace-1", {
      revision: 4,
      inboxItems: [inboxItem],
      actions: [action],
      actuals: [
        {
          id: "actual-action-1",
          revision: 1,
          target: { kind: "action", actionId: action.id },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 1_500,
          actualCost: 0,
          recordedAt: NOW,
        },
      ],
    });
  }

  it("lets a human confirm an eligible Inbox item as an Action", async () => {
    const workspace = buildCapturedWorkspace();
    const command = {
      type: "confirm_action_triage",
      inboxItemId: "inbox-triage",
      action: actionDraft,
    } as const satisfies V2Command;

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Action triage to apply");
    expect(result.workspace.actions).toEqual([
      {
        ...actionDraft,
        inboxItemId: "inbox-triage",
        revision: 1,
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(result.workspace.inboxItems[0]).toMatchObject({
      id: "inbox-triage",
      triageStatus: "action",
      actionId: "action-triaged",
      recommendation: {
        kind: "action",
        ruleCodes: [],
        explanation: "Fits the lightweight Action boundary.",
      },
    });
    expect(result.workspace.projects).toEqual([]);
    expect(result.workspace.directionBriefs).toEqual([]);
  });

  it("rejects Action confirmation when deterministic policy recommends Project", async () => {
    const workspace = buildCapturedWorkspace();
    const projectEligibility = {
      ...eligibility,
      dependencyIds: ["dependency-1"],
    };
    const command = {
      type: "confirm_action_triage",
      inboxItemId: "inbox-triage",
      action: {
        ...actionDraft,
        eligibility: projectEligibility,
      },
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection).toMatchObject({
      code: "ACTION_INELIGIBLE",
      reason: "Has a dependency.",
      gate: "action_eligibility:action-triaged",
      permittedNextCommand: "confirm_project_triage",
    });
    expect(workspace.inboxItems[0].triageStatus).toBe("untriaged");
    expect(workspace.actions).toEqual([]);

    const projectResult = await executeCommand(
      result.workspace,
      {
        type: "confirm_project_triage",
        inboxItemId: "inbox-triage",
        eligibility: projectEligibility,
        project: {
          id: "project-triaged",
          name: "Launch project",
          priority: 2,
          notes: "Shape the launch",
        },
      } as const,
      buildContext({ commandId: "command-confirm-project" }),
    );

    expect(projectResult.ok).toBe(true);
    if (!projectResult.ok) throw new Error("Expected Project triage to apply");
    expect(projectResult.workspace.inboxItems[0].recommendation).toEqual({
      kind: "project",
      ruleCodes: ["NO_DEPENDENCY"],
      explanation: "Has a dependency.",
    });
  });

  it("lets a human confirm an Inbox item as a Direction-stage Project", async () => {
    const workspace = buildCapturedWorkspace();
    const command = {
      type: "confirm_project_triage",
      inboxItemId: "inbox-triage",
      eligibility,
      project: {
        id: "project-triaged",
        name: "Launch project",
        priority: 2,
        notes: "Shape the launch",
      },
    } as const satisfies V2Command;

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Project triage to apply");
    expect(result.workspace.projects).toEqual([
      {
        ...command.project,
        stage: "direction",
        holds: [],
        activeDirectionBriefId: "project-triaged:direction-brief:1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(result.workspace.directionBriefs).toEqual([
      {
        id: "project-triaged:direction-brief:1",
        projectId: "project-triaged",
        version: 1,
        audienceAndProblem: "",
        successEvidence: "",
        appetiteSeconds: 0,
        validationMethod: "",
        firstScope: [],
        noGoOrKill: "",
        advancedNotes: "",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    expect(result.workspace.inboxItems[0]).toMatchObject({
      id: "inbox-triage",
      triageStatus: "project",
      projectId: "project-triaged",
      recommendation: {
        kind: "action",
        ruleCodes: [],
        explanation: "Fits the lightweight Action boundary.",
      },
    });
    expect(result.workspace.actions).toEqual([]);
  });

  it.each(["confirm_action_triage", "confirm_project_triage"] as const)(
    "rejects Agent %s confirmation before the handler",
    async (type) => {
      const workspace = buildCapturedWorkspace();
      const command: V2Command =
        type === "confirm_action_triage"
          ? { type, inboxItemId: "inbox-triage", action: actionDraft }
          : {
              type,
              inboxItemId: "inbox-triage",
              eligibility,
              project: {
                id: "project-triaged",
                name: "Launch project",
                priority: 2,
                notes: "",
              },
            };

      const result = rejected(
        await executeCommand(
          workspace,
          command,
          buildContext({
            actorId: "agent-1",
            actorKind: "agent",
            origin: "agent",
            source: {
              sourceId: "agent-source",
              verified: true,
              capabilities: ["submit_proposal"],
            },
          }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        permittedNextCommand: type,
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it.each([
    {
      name: "a dependency",
      eligibility: { ...eligibility, dependencyIds: ["dependency-1"] },
      reason: "Has a dependency.",
    },
    {
      name: "milestone evidence",
      eligibility: { ...eligibility, requiresMilestoneEvidence: true },
      reason: "Requires milestone evidence.",
    },
    {
      name: "multiple outcomes",
      eligibility: { ...eligibility, outcomeCount: 2 },
      reason: "Contains multiple outcomes.",
    },
    {
      name: "an uncertain solution",
      eligibility: { ...eligibility, solutionKnown: false },
      reason: "Solution path is uncertain.",
    },
    {
      name: "more than two hours",
      eligibility: { ...eligibility, estimateSeconds: 7_201 },
      reason: "Estimate exceeds two hours.",
    },
  ])(
    "requires promotion when an Action update adds $name",
    async ({ eligibility: nextEligibility, reason }) => {
      const workspace = buildOpenActionWorkspace();
      const command = {
        type: "update_action",
        actionId: "action-triaged",
        patch: { eligibility: nextEligibility },
      } as const satisfies V2Command;

      const result = rejected(
        await executeCommand(
          workspace,
          command,
          buildContext({ expectedRevision: 4 }),
        ),
      );

      expect(result.workspace).toBe(workspace);
      expect(result.rejection).toMatchObject({
        code: "ACTION_PROMOTION_REQUIRED",
        reason,
        gate: "action_eligibility:action-triaged",
        permittedNextCommand: "promote_action_to_project",
      });
      expect(workspace.actions[0].revision).toBe(3);
    },
  );

  it("applies an eligible Action update without rewriting history", async () => {
    const workspace = buildOpenActionWorkspace();

    const result = await executeCommand(
      workspace,
      {
        type: "update_action",
        actionId: "action-triaged",
        patch: { title: "Updated launch notes", attention: "deep" },
      },
      buildContext({ expectedRevision: 4 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected eligible Action update");
    expect(result.workspace.actions[0]).toMatchObject({
      id: "action-triaged",
      title: "Updated launch notes",
      attention: "deep",
      revision: 4,
      outcomeNote: "Existing outcome history",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.workspace.actuals).toEqual(workspace.actuals);
    expect(workspace.actions[0].title).toBe("Prepare launch notes");
  });

  it("completes an Action with immutable actual and outcome history", async () => {
    const workspace = buildOpenActionWorkspace();

    const result = await executeCommand(
      workspace,
      {
        type: "complete_action",
        actionId: "action-triaged",
        actualSeconds: 1_200,
        outcomeNote: "Launch notes published",
      },
      buildContext({
        commandId: "command-complete-action",
        expectedRevision: 4,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Action completion");
    expect(result.workspace.actions[0]).toMatchObject({
      id: "action-triaged",
      revision: 4,
      status: "completed",
      outcomeNote: "Launch notes published",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(result.workspace.actuals).toEqual([
      ...workspace.actuals,
      {
        id: "command-complete-action:actual",
        revision: 1,
        target: { kind: "action", actionId: "action-triaged" },
        actualWorkSeconds: 1_200,
        remainingWorkSeconds: 0,
        actualCost: 0,
        recordedAt: NOW,
      },
    ]);
    expect(workspace.actions[0]).toMatchObject({
      revision: 3,
      status: "open",
      outcomeNote: "Existing outcome history",
    });
  });

  it.each([
    {
      name: "dependency network",
      arrange: (workspace: WorkspaceV2) => {
        workspace.dependencies.push({
          id: "dependency-action",
          projectId: "project-1",
          fromId: "action-triaged",
          toId: "work-item-2",
          type: "FS",
          lagSeconds: 0,
          revision: 1,
        });
      },
    },
    {
      name: "Gantt Work Item",
      arrange: (workspace: WorkspaceV2) => {
        workspace.workItems.push({ ...WORK_ITEM, id: "action-triaged" });
      },
    },
    {
      name: "Baseline",
      arrange: (workspace: WorkspaceV2) => {
        workspace.baselines.push({
          id: "baseline-action",
          projectId: "project-1",
          name: "Invalid Action baseline",
          capturedAt: NOW,
          plannedStartByItem: { "action-triaged": NOW },
          plannedFinishByItem: { "action-triaged": LATER },
          plannedWorkSecondsByItem: { "action-triaged": 1_800 },
        });
      },
    },
    {
      name: "project Evidence milestone",
      arrange: (workspace: WorkspaceV2) => {
        workspace.evidence.push({
          ...EVIDENCE,
          id: "evidence-action",
          workItemId: "action-triaged",
        });
      },
    },
    {
      name: "Bet",
      arrange: (workspace: WorkspaceV2) => {
        const brief = {
          id: "brief-action",
          projectId: "action-triaged",
          version: 1,
          audienceAndProblem: "",
          successEvidence: "",
          appetiteSeconds: 0,
          validationMethod: "",
          firstScope: [],
          noGoOrKill: "",
          advancedNotes: "",
          createdAt: NOW,
          updatedAt: NOW,
        };
        workspace.bets.push({
          id: "bet-action",
          projectId: "action-triaged",
          version: 1,
          briefId: brief.id,
          briefHash: "brief-hash",
          briefSnapshot: brief,
          committedScope: [],
          appetiteStart: NOW,
          appetiteEnd: LATER,
          actorId: "human-1",
          approvedAt: NOW,
        });
      },
    },
    {
      name: "Close decision",
      arrange: (workspace: WorkspaceV2) => {
        workspace.closeDecisions.push({
          id: "close-action",
          projectId: "action-triaged",
          successComparison: "Invalid Action close",
          outcome: "abandoned",
          keyLearning: "Promote first",
          unfinishedDisposition: "historical_incomplete",
          actorId: "human-1",
          closedAt: NOW,
        });
      },
    },
  ])(
    "will not classify an ID already used by $name as an Action",
    async ({ name, arrange }) => {
      const workspace = buildCapturedWorkspace();
      arrange(workspace);

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "confirm_action_triage",
            inboxItemId: "inbox-triage",
            action: actionDraft,
          },
          buildContext(),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "ACTION_INELIGIBLE",
        reason: `Action ID action-triaged is already used by ${name}.`,
        gate: "action_identity:action-triaged",
        permittedNextCommand: "confirm_project_triage",
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it.each([
    {
      name: "Gantt Work Item",
      command: {
        type: "create_work_item",
        projectId: "project-1",
        workItem: { ...WORK_ITEM, id: "action-triaged" },
      },
    },
    {
      name: "project Evidence milestone",
      command: {
        type: "attach_evidence",
        evidence: { ...EVIDENCE, id: "evidence-action", workItemId: "action-triaged" },
      },
    },
    {
      name: "Bet",
      command: {
        type: "place_bet",
        projectId: "action-triaged",
        betId: "bet-action",
        start: NOW,
      },
    },
    {
      name: "Close decision",
      command: {
        type: "close_project",
        projectId: "action-triaged",
        decision: {
          id: "close-action",
          projectId: "action-triaged",
          successComparison: "Not a Project",
          outcome: "abandoned",
          keyLearning: "Promote first",
          unfinishedDisposition: "historical_incomplete",
        },
      },
    },
  ] as const satisfies readonly { name: string; command: V2Command }[])(
    "does not let an Action ID masquerade as a $name",
    async ({ command }) => {
      const workspace = buildOpenActionWorkspace();
      const result = rejected(
        await executeCommand(
          workspace,
          command,
          buildContext({ expectedRevision: 4 }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "ACTION_PROMOTION_REQUIRED",
        gate: "action_identity:action-triaged",
        permittedNextCommand: "promote_action_to_project",
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it("promotes an Action without deleting capture, Action, actual, or outcome history", async () => {
    const workspace = buildOpenActionWorkspace();
    const original = structuredClone(workspace);
    const command = {
      type: "promote_action_to_project",
      actionId: "action-triaged",
      project: {
        id: "project-promoted",
        name: "Promoted launch",
        priority: 3,
        notes: "Now needs project structure",
      },
    } as const satisfies V2Command;

    const result = await executeCommand(
      workspace,
      command,
      buildContext({ expectedRevision: 4 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Action promotion to apply");
    expect(result.workspace.actions[0]).toMatchObject({
      ...original.actions[0],
      revision: 4,
      status: "promoted",
      promotedProjectId: "project-promoted",
      outcomeNote: "Existing outcome history",
      updatedAt: NOW,
    });
    expect(result.workspace.inboxItems[0]).toMatchObject({
      id: original.inboxItems[0].id,
      actionId: "action-triaged",
      projectId: "project-promoted",
      triageStatus: "project",
      recommendation: {
        kind: "action",
        ruleCodes: [],
        explanation: "Fits the lightweight Action boundary.",
      },
    });
    expect(result.workspace.actuals).toEqual(original.actuals);
    expect(result.workspace.projects[0]).toMatchObject({
      id: "project-promoted",
      stage: "direction",
      activeDirectionBriefId: "project-promoted:direction-brief:1",
    });
    expect(result.workspace.directionBriefs[0]).toMatchObject({
      id: "project-promoted:direction-brief:1",
      projectId: "project-promoted",
      version: 1,
    });
    expect(workspace).toEqual(original);
  });
});
