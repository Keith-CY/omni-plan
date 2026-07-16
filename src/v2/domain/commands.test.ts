import { describe, expect, it } from "vitest";

import type { Evidence } from "@/domain/types";

import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildInboxItem,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  isCanonicalCommandRuntimeGraph,
  isStructurallyValidCommand,
  isStructurallyValidCommandContext,
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
  DirectionBrief,
  JsonValue,
  LifecycleStage,
  ProjectHold,
  ProjectHoldState,
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
    resultStatus: "completed",
    outcomeNote: "Done",
  },
  {
    type: "promote_action_to_project",
    actionId: "action-1",
    eligibility: {
      singleSession: true,
      estimateSeconds: 1_800,
      dependencyIds: ["dependency-1"],
      requiresMilestoneEvidence: false,
      outcomeCount: 1,
      solutionKnown: true,
    },
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
    type: "upsert_dependency",
    dependency: {
      id: "dependency-1",
      projectId: "project-1",
      fromId: WORK_ITEM.id,
      toId: "work-item-2",
      type: "FS",
      lagSeconds: 0,
      revision: 1,
    },
  },
  { type: "remove_dependency", dependencyId: "dependency-1" },
  {
    type: "remove_work_item",
    projectId: "project-1",
    workItemId: WORK_ITEM.id,
  },
  {
    type: "capture_baseline",
    baseline: {
      id: "baseline-1",
      projectId: "project-1",
      name: "Baseline",
      capturedAt: NOW,
      plannedStartByItem: { [WORK_ITEM.id]: NOW },
      plannedFinishByItem: { [WORK_ITEM.id]: LATER },
      plannedWorkSecondsByItem: { [WORK_ITEM.id]: 3_600 },
    },
  },
  {
    type: "complete_work_item",
    projectId: "project-1",
    workItemId: WORK_ITEM.id,
    resultStatus: "completed",
    outcomeNote: "Completed",
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
      workspaceRevision: 0,
      generatedAt: NOW,
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
    type: "open_sync_conflict",
    conflict: {
      id: "conflict-1",
      recordType: "bet",
      recordId: "bet-1",
      commonAncestorHash: "ancestor-1",
      remoteValue: { id: "bet-1" },
    },
  },
  {
    type: "resolve_sync_conflict",
    reviewId: "review-1",
    resolution: {
      conflictId: "conflict-1",
      retainedVersion: "local",
      retainedValue: { id: "bet-1" },
      retainedBundleHash: "a".repeat(64),
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
  {
    type: "submit_command_proposal",
    proposalId: "command-proposal-1",
    command: {
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
    rationale: "Agent found a clearer Direction.",
  },
  { type: "accept_command_proposal", proposalId: "command-proposal-1" },
  { type: "dismiss_command_proposal", proposalId: "command-proposal-1" },
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
  "upsert_dependency",
  "remove_dependency",
  "remove_work_item",
  "capture_baseline",
  "complete_work_item",
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
  "open_sync_conflict",
  "resolve_sync_conflict",
  "close_project",
  "abandon_project",
  "archive_project",
  "submit_command_proposal",
  "accept_command_proposal",
  "dismiss_command_proposal",
] as const;

function commandSample(type: V2Command["type"]): V2Command {
  const sample = ALL_COMMANDS.find((command) => command.type === type);
  if (sample === undefined) throw new Error(`Missing command sample ${type}`);
  const command = structuredClone(sample) as V2Command;
  if (command.type === "open_sync_conflict") {
    command.conflict = {
      ...command.conflict,
      remoteRecordId: "bet-remote",
      logicalKey: '["bet","project-1"]',
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["bet-1", "bet-remote"],
      localValue: { id: "bet-1", vendor: { arbitrary: true } },
      remoteValue: { id: "bet-remote", vendor: { arbitrary: true } },
      localBundle: {} as never,
      remoteBundle: {} as never,
    };
  }
  return command;
}

type ExactKeyPath = readonly (string | number)[];

function poisonObjectAtPath(command: V2Command, path: ExactKeyPath): void {
  let current: unknown = command;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      throw new Error(`Missing exact-key path ${path.join(".")}`);
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Exact-key path ${path.join(".")} is not an object`);
  }
  (current as Record<string, unknown>).__unexpected = "must-reject";
}

interface NestedExactKeyCase {
  name: string;
  type: V2Command["type"];
  path: ExactKeyPath;
  prepare?: (command: V2Command) => void;
}

const NESTED_EXACT_KEY_CASES: readonly NestedExactKeyCase[] = [
  { name: "capacity profile", type: "configure_capacity", path: ["profile"] },
  {
    name: "weekly window",
    type: "configure_capacity",
    path: ["profile", "weeklyWindows", 0],
  },
  {
    name: "daily budget",
    type: "configure_capacity",
    path: ["profile", "dailyBudgets", 0],
  },
  {
    name: "unavailable block",
    type: "configure_capacity",
    path: ["profile", "unavailableBlocks", 0],
  },
  { name: "Action draft", type: "confirm_action_triage", path: ["action"] },
  {
    name: "Action eligibility",
    type: "confirm_action_triage",
    path: ["action", "eligibility"],
  },
  {
    name: "Project triage eligibility",
    type: "confirm_project_triage",
    path: ["eligibility"],
  },
  {
    name: "Project triage draft",
    type: "confirm_project_triage",
    path: ["project"],
  },
  { name: "Action patch", type: "update_action", path: ["patch"] },
  {
    name: "Action patch eligibility",
    type: "update_action",
    path: ["patch", "eligibility"],
    prepare(command) {
      if (command.type !== "update_action") throw new Error("Expected update Action");
      const sample = commandSample("confirm_action_triage");
      if (sample.type !== "confirm_action_triage") throw new Error("Expected Action");
      command.patch.eligibility = structuredClone(sample.action.eligibility);
    },
  },
  {
    name: "promotion eligibility",
    type: "promote_action_to_project",
    path: ["eligibility"],
  },
  {
    name: "promotion Project draft",
    type: "promote_action_to_project",
    path: ["project"],
  },
  { name: "Direction draft", type: "update_direction", path: ["brief"] },
  {
    name: "Bet scope",
    type: "update_direction",
    path: ["brief", "firstScope", 0],
  },
  { name: "Work Item", type: "create_work_item", path: ["workItem"] },
  {
    name: "Work Item estimate",
    type: "create_work_item",
    path: ["workItem", "estimate"],
  },
  {
    name: "Work Item constraint",
    type: "create_work_item",
    path: ["workItem", "constraint"],
    prepare(command) {
      if (command.type !== "create_work_item") throw new Error("Expected Work Item");
      command.workItem.constraint = {};
    },
  },
  {
    name: "Work Item assignment",
    type: "create_work_item",
    path: ["workItem", "assignmentIds", 0],
    prepare(command) {
      if (command.type !== "create_work_item") throw new Error("Expected Work Item");
      command.workItem.assignmentIds = [{
        resourceId: "resource-1",
        attention: "deep",
        effortSeconds: 1_800,
      }];
    },
  },
  {
    name: "Work Item split segment",
    type: "create_work_item",
    path: ["workItem", "splitSegments", 0],
    prepare(command) {
      if (command.type !== "create_work_item") throw new Error("Expected Work Item");
      command.workItem.splitSegments = [{ offsetSeconds: 0, durationSeconds: 900 }];
    },
  },
  {
    name: "Work Item repeat rule",
    type: "create_work_item",
    path: ["workItem", "repeatRule"],
    prepare(command) {
      if (command.type !== "create_work_item") throw new Error("Expected Work Item");
      command.workItem.repeatRule = { count: 2 };
    },
  },
  { name: "Work Item patch", type: "update_work_item", path: ["patch"] },
  {
    name: "Work Item patch estimate",
    type: "update_work_item",
    path: ["patch", "estimate"],
    prepare(command) {
      if (command.type !== "update_work_item") throw new Error("Expected patch");
      command.patch.estimate = { mostLikelySeconds: 900 };
    },
  },
  {
    name: "Work Item patch constraint",
    type: "update_work_item",
    path: ["patch", "constraint"],
    prepare(command) {
      if (command.type !== "update_work_item") throw new Error("Expected patch");
      command.patch.constraint = {};
    },
  },
  {
    name: "Work Item patch assignment",
    type: "update_work_item",
    path: ["patch", "assignmentIds", 0],
    prepare(command) {
      if (command.type !== "update_work_item") throw new Error("Expected patch");
      command.patch.assignmentIds = [{
        resourceId: "resource-1",
        attention: "medium",
        effortSeconds: 900,
      }];
    },
  },
  {
    name: "Work Item patch split segment",
    type: "update_work_item",
    path: ["patch", "splitSegments", 0],
    prepare(command) {
      if (command.type !== "update_work_item") throw new Error("Expected patch");
      command.patch.splitSegments = [{ offsetSeconds: 0, durationSeconds: 900 }];
    },
  },
  {
    name: "Work Item patch repeat rule",
    type: "update_work_item",
    path: ["patch", "repeatRule"],
    prepare(command) {
      if (command.type !== "update_work_item") throw new Error("Expected patch");
      command.patch.repeatRule = { count: 2 };
    },
  },
  { name: "Dependency", type: "upsert_dependency", path: ["dependency"] },
  { name: "Baseline", type: "capture_baseline", path: ["baseline"] },
  { name: "Replan proposal", type: "propose_replan", path: ["proposal"] },
  {
    name: "Replan slot",
    type: "propose_replan",
    path: ["proposal", "proposedSlots", 0],
  },
  {
    name: "Replan target",
    type: "propose_replan",
    path: ["proposal", "proposedSlots", 0, "target"],
  },
  { name: "Daily commitment", type: "commit_today", path: ["commitment"] },
  {
    name: "Daily commitment slot",
    type: "commit_today",
    path: ["commitment", "slots", 0],
  },
  {
    name: "Daily commitment target",
    type: "commit_today",
    path: ["commitment", "slots", 0, "target"],
  },
  { name: "Actual", type: "record_actual", path: ["actual"] },
  {
    name: "Actual Work Item target",
    type: "record_actual",
    path: ["actual", "target"],
  },
  {
    name: "Actual Action target",
    type: "record_actual",
    path: ["actual", "target"],
    prepare(command) {
      if (command.type !== "record_actual") throw new Error("Expected Actual");
      command.actual.target = { kind: "action", actionId: "action-1" };
    },
  },
  { name: "Evidence", type: "attach_evidence", path: ["evidence"] },
  {
    name: "Exception draft",
    type: "approve_evidence_exception",
    path: ["exception"],
  },
  { name: "Review draft", type: "create_review", path: ["review"] },
  {
    name: "Review conclusion",
    type: "complete_review",
    path: ["conclusion"],
  },
  { name: "Sync conflict draft", type: "open_sync_conflict", path: ["conflict"] },
  {
    name: "Conflict resolution",
    type: "resolve_sync_conflict",
    path: ["resolution"],
  },
  { name: "Close decision", type: "close_project", path: ["decision"] },
  { name: "Abandon decision", type: "abandon_project", path: ["decision"] },
];

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

  it.each(EXPECTED_COMMAND_TYPES)(
    "rejects an unknown top-level key for %s",
    (type) => {
      const command = commandSample(type);
      expect(isStructurallyValidCommand(command)).toBe(true);
      (command as unknown as Record<string, unknown>).__unexpected =
        "must-reject";
      expect(isStructurallyValidCommand(command)).toBe(false);
    },
  );

  it("rejects a top-level enumerable accessor without invoking it", () => {
    const command = commandSample("capture_inbox");
    let getterCalls = 0;
    Object.defineProperty(command, "text", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Accessor text";
      },
    });

    expect(isStructurallyValidCommand(command)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects a CommandContext accessor without invoking it", () => {
    const context = buildContext();
    let getterCalls = 0;
    Object.defineProperty(context.source, "sourceId", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor-source";
      },
    });

    expect(isStructurallyValidCommandContext(context)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects an accessor inside a submitted command without invoking it", () => {
    const proposal = commandSample("submit_command_proposal");
    if (proposal.type !== "submit_command_proposal") {
      throw new Error("Expected command proposal");
    }
    let getterCalls = 0;
    Object.defineProperty(proposal.command, "projectId", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "project-accessor";
      },
    });

    expect(isStructurallyValidCommand(proposal)).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it("rejects a top-level command accessor before executeCommand can clone it", async () => {
    const command = commandSample("capture_inbox");
    let getterCalls = 0;
    Object.defineProperty(command, "text", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Accessor text";
      },
    });

    await expect(
      executeCommand(
        buildWorkspaceV2("workspace-accessor-command"),
        command,
        buildContext(),
      ),
    ).rejects.toThrow("canonical data-property graph");
    expect(getterCalls).toBe(0);
  });

  it("rejects a nested proposal accessor before executeCommand can clone it", async () => {
    const proposal = commandSample("submit_command_proposal");
    if (proposal.type !== "submit_command_proposal") {
      throw new Error("Expected command proposal");
    }
    let getterCalls = 0;
    Object.defineProperty(proposal.command, "projectId", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "project-accessor";
      },
    });

    await expect(
      executeCommand(
        buildWorkspaceV2("workspace-accessor-proposal"),
        proposal,
        buildContext(),
      ),
    ).rejects.toThrow("canonical data-property graph");
    expect(getterCalls).toBe(0);
  });

  it("rejects a context accessor before executeCommand can clone it", async () => {
    const context = buildContext();
    let getterCalls = 0;
    Object.defineProperty(context.source, "sourceId", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor-source";
      },
    });

    await expect(
      executeCommand(
        buildWorkspaceV2("workspace-accessor-context"),
        commandSample("capture_inbox"),
        context,
      ),
    ).rejects.toThrow("canonical data-property graph");
    expect(getterCalls).toBe(0);
  });

  it("rejects non-canonical runtime graph topology before cloning", () => {
    const withSymbolKey = { type: "capture_inbox" } as Record<
      PropertyKey,
      unknown
    >;
    withSymbolKey[Symbol("unexpected")] = true;

    const withSymbolValue = { type: Symbol("capture_inbox") };

    const withNonEnumerable = { type: "capture_inbox" };
    Object.defineProperty(withNonEnumerable, "id", {
      configurable: true,
      enumerable: false,
      value: "hidden-id",
    });

    const cyclic: Record<string, unknown> = { type: "capture_inbox" };
    cyclic.self = cyclic;

    expect(isCanonicalCommandRuntimeGraph(withSymbolKey)).toBe(false);
    expect(isCanonicalCommandRuntimeGraph(withSymbolValue)).toBe(false);
    expect(isCanonicalCommandRuntimeGraph(withNonEnumerable)).toBe(false);
    expect(isCanonicalCommandRuntimeGraph(cyclic)).toBe(false);
  });

  it("allows clone-safe leaves to reach the exact structural validator", () => {
    const ordinaryButInvalid = {
      type: "capture_inbox",
      id: undefined,
      text: 1n,
      desiredDate: Number.NaN,
      nested: [undefined, 1n, Number.POSITIVE_INFINITY],
    };

    expect(isCanonicalCommandRuntimeGraph(ordinaryButInvalid)).toBe(true);
    expect(isStructurallyValidCommand(ordinaryButInvalid)).toBe(false);
  });

  it.each(NESTED_EXACT_KEY_CASES)(
    "rejects an unknown key in $name",
    ({ type, path, prepare }) => {
      const command = commandSample(type);
      prepare?.(command);
      expect(isStructurallyValidCommand(command)).toBe(true);
      poisonObjectAtPath(command, path);
      expect(isStructurallyValidCommand(command)).toBe(false);
    },
  );

  it("keeps only explicitly open JsonValue and Baseline map keys extensible", () => {
    const resolution = commandSample("resolve_sync_conflict");
    if (resolution.type !== "resolve_sync_conflict") {
      throw new Error("Expected conflict resolution");
    }
    resolution.resolution.retainedValue = {
      vendorExtension: { arbitrary: true, nested: [1, 2, 3] },
    };
    expect(isStructurallyValidCommand(resolution)).toBe(true);

    const conflict = commandSample("open_sync_conflict");
    if (conflict.type !== "open_sync_conflict") {
      throw new Error("Expected conflict open");
    }
    conflict.conflict.localValue = {
      id: "bet-1",
      vendorExtension: { arbitrary: true },
    };
    conflict.conflict.remoteValue = {
      id: "bet-remote",
      anotherExtension: { arbitrary: true },
    };
    expect(isStructurallyValidCommand(conflict)).toBe(true);

    const baseline = commandSample("capture_baseline");
    if (baseline.type !== "capture_baseline") {
      throw new Error("Expected Baseline");
    }
    baseline.baseline.plannedStartByItem["vendor-work-item"] = NOW;
    baseline.baseline.plannedFinishByItem["vendor-work-item"] = LATER;
    baseline.baseline.plannedWorkSecondsByItem["vendor-work-item"] = 30;
    expect(isStructurallyValidCommand(baseline)).toBe(true);
  });

  it.each([
    { name: "Map", value: new Map() },
    { name: "Date", value: new Date(NOW) },
    {
      name: "class instance",
      value: new (class RuntimePatch {})(),
    },
  ])("rejects a non-plain $name at a closed object boundary", ({ value }) => {
    const command = commandSample("update_action");
    if (command.type !== "update_action") throw new Error("Expected Action patch");
    command.patch = value as never;

    expect(isStructurallyValidCommand(command)).toBe(false);
  });

  it.each([
    {
      name: "sparse capacity windows",
      command(): V2Command {
        const command = commandSample("configure_capacity");
        if (command.type !== "configure_capacity") {
          throw new Error("Expected capacity command");
        }
        command.profile.weeklyWindows = new Array(1);
        return command;
      },
    },
    {
      name: "custom Direction scope array key",
      command(): V2Command {
        const command = commandSample("update_direction");
        if (command.type !== "update_direction") {
          throw new Error("Expected Direction command");
        }
        (command.brief.firstScope as unknown as Record<string, unknown>).
          unexpected = true;
        return command;
      },
    },
    {
      name: "sparse Work Item assignments",
      command(): V2Command {
        const command = commandSample("create_work_item");
        if (command.type !== "create_work_item") {
          throw new Error("Expected Work Item command");
        }
        command.workItem.assignmentIds = new Array(1);
        return command;
      },
    },
    {
      name: "custom commitment slots array key",
      command(): V2Command {
        const command = commandSample("commit_today");
        if (command.type !== "commit_today") {
          throw new Error("Expected commitment command");
        }
        (command.commitment.slots as unknown as Record<string, unknown>).
          unexpected = true;
        return command;
      },
    },
    {
      name: "sparse string array",
      command(): V2Command {
        const command = commandSample("attach_evidence");
        if (command.type !== "attach_evidence") {
          throw new Error("Expected Evidence command");
        }
        command.evidence.tags = new Array(1);
        return command;
      },
    },
  ])("rejects a non-canonical closed array: $name", ({ command }) => {
    expect(isStructurallyValidCommand(command())).toBe(false);
  });

  it.each(["sparse", "custom-key"] as const)(
    "rejects a %s JsonValue array even though JsonValue object keys are open",
    (kind) => {
      const command = commandSample("resolve_sync_conflict");
      if (command.type !== "resolve_sync_conflict") {
        throw new Error("Expected conflict resolution");
      }
      const retainedValue: JsonValue[] =
        kind === "sparse" ? new Array(1) : [{ id: "bet-1" }];
      if (kind === "custom-key") {
        (retainedValue as unknown as Record<string, unknown>).unexpected = true;
      }
      command.resolution.retainedValue = retainedValue;

      expect(isStructurallyValidCommand(command)).toBe(false);
    },
  );

  it("returns one strict atomic rejection receipt for an unknown payload key", async () => {
    const workspace = buildWorkspaceV2("workspace-exact-command");
    const command = {
      type: "capture_inbox",
      id: "inbox-exact-command",
      text: "Reject the extension",
      __unexpected: "must-reject",
    } as unknown as V2Command;
    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:capture_inbox",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace.revision).toBe(0);
    expect(workspace.commandReceipts).toEqual([]);
    expect(Object.keys(result.receipt).sort()).toEqual([
      "actorId",
      "actorKind",
      "baseRevision",
      "commandId",
      "commandType",
      "createdAt",
      "diff",
      "id",
      "origin",
      "payloadHash",
      "receiptHash",
      "rejectionCode",
      "revision",
      "source",
      "status",
    ]);
    expect(Object.keys(result.receipt.source).sort()).toEqual([
      "capabilities",
      "sourceId",
      "verified",
    ]);
    expect(result.receipt).toMatchObject({
      status: "rejected",
      baseRevision: 0,
      revision: 0,
      diff: [],
      rejectionCode: "INVALID_COMMAND",
    });
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
        expect(result.rejection.gate).not.toBe(
          `command_payload:${command.type}`,
        );
      }
    },
  );

  it("rejects an explicitly undefined required Work Item patch field without throwing", async () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      appetiteSeconds: 3_600,
      firstScope: [
        { id: "scope-1", title: "Scope", description: "Committed scope" },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bet = buildBetVersion({
      id: "bet-1",
      projectId: "project-1",
      briefId: brief.id,
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: NOW,
      appetiteEnd: LATER,
      actorId: "human-1",
      approvedAt: NOW,
    });
    const workspace = buildProjectWorkspace(undefined, {
      projects: [
        buildProjectV2({
          id: "project-1",
          stage: "planning",
          activeDirectionBriefId: brief.id,
          activeBetId: bet.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [brief],
      bets: [bet],
      workItems: [WORK_ITEM],
    });
    const command = {
      type: "update_work_item",
      projectId: "project-1",
      workItemId: WORK_ITEM.id,
      patch: { assignmentIds: undefined },
    } as unknown as V2Command;

    const pending = executeCommand(
      workspace,
      command,
      buildContext({ expectedRevision: workspace.revision }),
    );

    await expect(pending).resolves.toMatchObject({
      ok: false,
      workspace,
      rejection: {
        code: "INVALID_COMMAND",
        gate: "command_payload:update_work_item",
      },
    });
    expect(workspace.workItems).toEqual([WORK_ITEM]);
  });
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

  it("rejects a structurally typed profile that violates semantic capacity rules", async () => {
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

    expect(result).toMatchObject({
      ok: false,
      workspace,
      rejection: {
        code: "INVALID_COMMAND",
        gate: "capacity_profile:time_zone",
        permittedNextCommand: "configure_capacity",
      },
    });
    expect(workspace.capacityProfile).toBeUndefined();
    expect(workspace.revision).toBe(0);
  });

  it("uses authoritative audit fields and deep-copies capacity input", async () => {
    const workspace = deepFreeze(buildWorkspaceV2("workspace-1"));
    const command = deepFreeze({
      type: "configure_capacity",
      profile: {
        ...structuredClone(PROFILE),
        updatedAt: "2000-01-01T00:00:00.000Z",
        updatedBy: "untrusted-client",
      },
    } as const satisfies V2Command);

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected applied command");
    expect(result.workspace.capacityProfile).toEqual({
      ...PROFILE,
      updatedAt: NOW,
      updatedBy: "human-1",
    });
    expect(result.workspace.capacityProfile).not.toBe(command.profile);
    expect(result.workspace.capacityProfile?.weeklyWindows).not.toBe(
      command.profile.weeklyWindows,
    );
    expect(command.profile.updatedAt).toBe("2000-01-01T00:00:00.000Z");
    expect(command.profile.updatedBy).toBe("untrusted-client");
  });

  it("rejects a zero-capacity weekday even when another working day is usable", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const profile: CapacityProfile = {
      ...structuredClone(PROFILE),
      weeklyWindows: [
        { weekday: 1, startMinute: 540, finishMinute: 1_020 },
        { weekday: 2, startMinute: 540, finishMinute: 1_020 },
      ],
      dailyBudgets: [
        {
          weekday: 1,
          deepSeconds: 0,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
        {
          weekday: 2,
          deepSeconds: 3_600,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
    };

    const result = await executeCommand(
      workspace,
      { type: "configure_capacity", profile },
      buildContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      workspace,
      rejection: {
        code: "INVALID_COMMAND",
        reason:
          "Daily budget 0 for weekday 1 has no usable attention capacity for its configured working window.",
        gate: "capacity_profile:daily_budget:0:usable_capacity",
        permittedNextCommand: "configure_capacity",
      },
    });
  });

  it.each([
    {
      name: "a non-integer weekly minute",
      gate: "capacity_profile:weekly_window:0",
      patch: { weeklyWindows: [{ weekday: 6, startMinute: 540.5, finishMinute: 1_020 }] },
    },
    {
      name: "an inverted weekly window",
      gate: "capacity_profile:weekly_window:0",
      patch: { weeklyWindows: [{ weekday: 6, startMinute: 1_020, finishMinute: 540 }] },
    },
    {
      name: "overlapping same-weekday windows",
      gate: "capacity_profile:weekly_window:1",
      patch: {
        weeklyWindows: [
          { weekday: 6, startMinute: 540, finishMinute: 720 },
          { weekday: 6, startMinute: 600, finishMinute: 800 },
        ],
      },
    },
    {
      name: "duplicate weekday budgets",
      gate: "capacity_profile:daily_budget:1",
      patch: { dailyBudgets: [PROFILE.dailyBudgets[0], PROFILE.dailyBudgets[0]] },
    },
    {
      name: "a negative attention budget",
      gate: "capacity_profile:daily_budget:0",
      patch: {
        dailyBudgets: [
          { ...PROFILE.dailyBudgets[0], deepSeconds: -1 },
        ],
      },
    },
    {
      name: "a non-integer attention budget",
      gate: "capacity_profile:daily_budget:0",
      patch: {
        dailyBudgets: [
          { ...PROFILE.dailyBudgets[0], mediumSeconds: 0.5 },
        ],
      },
    },
    {
      name: "a missing budget for a window weekday",
      gate: "capacity_profile:weekly_window:0:budget",
      patch: { dailyBudgets: [] },
    },
    {
      name: "no usable window and budget pair",
      gate: "capacity_profile:usable_capacity",
      patch: {
        dailyBudgets: [
          {
            weekday: 6,
            deepSeconds: 0,
            mediumSeconds: 0,
            shallowSeconds: 0,
          },
        ],
      },
    },
    {
      name: "a non-canonical unavailable start",
      gate: "capacity_profile:unavailable_block:0",
      patch: {
        unavailableBlocks: [
          {
            id: "away-1",
            start: "2026-07-11T09:00:00Z",
            finish: "2026-07-11T09:30:00.000Z",
          },
        ],
      },
    },
    {
      name: "an inverted unavailable interval",
      gate: "capacity_profile:unavailable_block:0",
      patch: {
        unavailableBlocks: [
          { id: "away-1", start: LATER, finish: NOW },
        ],
      },
    },
    {
      name: "duplicate unavailable IDs",
      gate: "capacity_profile:unavailable_block:1",
      patch: {
        unavailableBlocks: [PROFILE.unavailableBlocks[0], PROFILE.unavailableBlocks[0]],
      },
    },
  ])("rejects $name", async ({ gate, patch }) => {
    const workspace = buildWorkspaceV2("workspace-1");
    const profile = {
      ...structuredClone(PROFILE),
      ...structuredClone(patch),
    } as CapacityProfile;

    const result = await executeCommand(
      workspace,
      { type: "configure_capacity", profile },
      buildContext(),
    );

    expect(result).toMatchObject({
      ok: false,
      workspace,
      rejection: {
        code: "INVALID_COMMAND",
        gate,
        permittedNextCommand: "configure_capacity",
      },
    });
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
          workspaceRevision: 0,
          generatedAt: NOW,
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

  it("returns an exact missing-project rejection for archive", async () => {
    const workspace = buildWorkspaceV2("workspace-1");
    const command = {
      type: "archive_project",
      projectId: "missing-project",
      archived: true,
    } as const satisfies V2Command;

    const result = rejected(
      await executeCommand(workspace, command, buildContext()),
    );

    expect(result.workspace).toBe(workspace);
    expect(result.rejection).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      permittedNextCommand: "confirm_project_triage",
    });
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
      capacityProfile: structuredClone(commitment.capacitySnapshot),
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
    expect(committed.rejection.code).toBe("BET_REQUIRED");
  });

  it("allows only committed Work Items to complete during overdue review", async () => {
    const commitment: DailyCommitment = {
      id: "commitment-completion",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "proposal-completion",
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
      capacityProfile: structuredClone(commitment.capacitySnapshot),
    });
    const command = {
      type: "complete_work_item",
      projectId: "project-1",
      workItemId: WORK_ITEM.id,
      resultStatus: "completed",
      outcomeNote: "Committed outcome delivered.",
    } as const satisfies V2Command;
    const commandContext = buildContext({ expectedRevision: 11 });

    const uncommitted = rejected(
      await executeCommand(uncommittedWorkspace, command, commandContext),
    );
    const committed = rejected(
      await executeCommand(committedWorkspace, command, {
        ...commandContext,
        commandId: "command-complete-committed",
      }),
    );

    expect(uncommitted.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
    expect(committed.rejection.code).toBe("BET_REQUIRED");
  });

  it("blocks Work Item completion when its effective commitment is from yesterday", async () => {
    const yesterday: DailyCommitment = {
      id: "commitment-yesterday",
      localDate: "2026-07-10",
      version: 1,
      proposalHash: "proposal-yesterday",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "Asia/Tokyo",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
      slots: [COMMITMENT_SLOT],
      actorId: "human-1",
      committedAt: "2026-07-10T09:00:00.000Z",
    };
    const workspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [yesterday],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "complete_work_item",
          projectId: "project-1",
          workItemId: WORK_ITEM.id,
          resultStatus: "completed",
          outcomeNote: "Too late for yesterday's commitment.",
        },
        buildContext({
          commandId: "complete-yesterday",
          expectedRevision: workspace.revision,
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("does not revive a historical commitment after the workspace timezone changes", async () => {
    const snapshot = buildCapacityProfile({
      timeZone: "Asia/Tokyo",
      dailyBudgets: [
        {
          weekday: 6,
          deepSeconds: 7_200,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
      updatedAt: NOW,
      updatedBy: "human-1",
    });
    const commitment = buildCommitment({
      localDate: "2026-07-11",
      capacitySnapshot: snapshot,
    });
    const workspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [commitment],
      capacityProfile: buildCapacityProfile({
        timeZone: "UTC",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });

    const result = rejected(
      await executeCommand(
        workspace,
        { type: "record_actual", actual: ACTUAL },
        buildContext({
          commandId: "record-after-timezone-change",
          expectedRevision: workspace.revision,
          now: "2026-07-11T23:30:00.000Z",
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("keeps a commitment current by its immutable snapshot timezone", async () => {
    const snapshot = buildCapacityProfile({
      timeZone: "Asia/Tokyo",
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 7_200,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
      updatedAt: NOW,
      updatedBy: "human-1",
    });
    const commitment = buildCommitment({
      localDate: "2026-07-12",
      capacitySnapshot: snapshot,
      committedAt: "2026-07-11T23:00:00.000Z",
      slots: [
        {
          ...COMMITMENT_SLOT,
          start: "2026-07-11T23:00:00.000Z",
          finish: "2026-07-11T23:30:00.000Z",
        },
      ],
    });
    const workspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [commitment],
      capacityProfile: buildCapacityProfile({
        timeZone: "UTC",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });

    const result = rejected(
      await executeCommand(
        workspace,
        { type: "record_actual", actual: ACTUAL },
        buildContext({
          commandId: "record-current-snapshot-timezone",
          expectedRevision: workspace.revision,
          now: "2026-07-11T23:30:00.000Z",
        }),
      ),
    );

    expect(result.rejection.code).toBe("BET_REQUIRED");
  });

  it("fails closed when multiple sole leaves are current in their snapshot timezones", async () => {
    const utcCommitment = buildCommitment({
      id: "commitment-utc",
      localDate: "2026-07-11",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "UTC",
        dailyBudgets: [
          {
            weekday: 6,
            deepSeconds: 7_200,
            mediumSeconds: 0,
            shallowSeconds: 0,
          },
        ],
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });
    const tokyoCommitment = buildCommitment({
      id: "commitment-tokyo",
      localDate: "2026-07-12",
      proposalHash: "commitment-tokyo-hash",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "Asia/Tokyo",
        dailyBudgets: [
          {
            weekday: 0,
            deepSeconds: 7_200,
            mediumSeconds: 0,
            shallowSeconds: 0,
          },
        ],
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
      committedAt: "2026-07-11T23:00:00.000Z",
      slots: [
        {
          ...COMMITMENT_SLOT,
          id: "slot-tokyo",
          start: "2026-07-11T23:00:00.000Z",
          finish: "2026-07-11T23:30:00.000Z",
        },
      ],
    });
    const workspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [utcCommitment, tokyoCommitment],
      capacityProfile: buildCapacityProfile({
        timeZone: "UTC",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });

    const result = rejected(
      await executeCommand(
        workspace,
        { type: "record_actual", actual: ACTUAL },
        buildContext({
          commandId: "record-ambiguous-current-leaves",
          expectedRevision: workspace.revision,
          now: "2026-07-11T23:30:00.000Z",
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("blocks Work Item completion when the current slot has a stale revision", async () => {
    const commitment: DailyCommitment = {
      id: "commitment-stale",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "proposal-stale",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "UTC",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
      slots: [{ ...COMMITMENT_SLOT, targetRevision: WORK_ITEM.revision - 1 }],
      actorId: "human-1",
      committedAt: NOW,
    };
    const workspace = buildProjectWorkspace("review_overdue", {
      workItems: [WORK_ITEM],
      dailyCommitments: [commitment],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "complete_work_item",
          projectId: "project-1",
          workItemId: WORK_ITEM.id,
          resultStatus: "completed",
          outcomeNote: "Stale committed revision.",
        },
        buildContext({
          commandId: "complete-stale",
          expectedRevision: workspace.revision,
        }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("uses the deterministic fork winner for overdue-review completion", async () => {
    const winner: DailyCommitment = {
      id: "commitment-a",
      localDate: "2026-07-11",
      version: 2,
      proposalHash: "proposal-a",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "UTC",
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
      slots: [{ ...COMMITMENT_SLOT, targetRevision: WORK_ITEM.revision - 1 }],
      actorId: "human-1",
      committedAt: NOW,
    };
    const losingFork: DailyCommitment = {
      ...structuredClone(winner),
      id: "commitment-z",
      proposalHash: "proposal-z",
      slots: [COMMITMENT_SLOT],
    };
    const command = {
      type: "complete_work_item",
      projectId: "project-1",
      workItemId: WORK_ITEM.id,
      resultStatus: "completed",
      outcomeNote: "Only the winning fork authorizes completion.",
    } as const satisfies V2Command;

    for (const [index, commitments] of [
      [winner, losingFork],
      [losingFork, winner],
    ].entries()) {
      const workspace = buildProjectWorkspace("review_overdue", {
        workItems: [WORK_ITEM],
        dailyCommitments: commitments,
      });
      const result = rejected(
        await executeCommand(
          workspace,
          command,
          buildContext({
            commandId: `complete-fork-${index}`,
            expectedRevision: workspace.revision,
          }),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "review_overdue",
      });
    }
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
    expect(unrelatedResult.rejection.code).toBe("BET_REQUIRED");
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
        workspaceRevision: 11,
        generatedAt: NOW,
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

  it("does not policy-block resolve_sync_conflict through an overlapping hold", async () => {
    const targetReview = {
      id: "review-target",
      kind: "event" as const,
      triggerKey: "hard_gate:review-target",
      triggerType: "hard_gate" as const,
      status: "open" as const,
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["project-1"],
      dueAt: LATER,
      createdAt: NOW,
    };
    const workspace = buildProjectWorkspace(undefined, {
      directionBriefs: [
        buildDirectionBrief({
          id: "brief-1",
          projectId: "project-1",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      reviews: [
        targetReview,
        {
          id: "review:sync_conflict:conflict-1",
          kind: "event",
          triggerKey: "sync_conflict:conflict-1",
          triggerType: "sync_conflict",
          status: "open",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: ["conflict-1", "project-1", "review-target"],
          dueAt: NOW,
          createdAt: NOW,
        },
      ],
      syncConflicts: [
        {
          id: "conflict-1",
          recordType: "review",
          recordId: targetReview.id,
          projectId: "project-1",
          commonAncestorHash: "ancestor-hash",
          localValue: targetReview,
          remoteValue: targetReview,
          openedAt: NOW,
        },
      ],
    });
    workspace.projects[0].holds = [
      {
        type: "sync_conflict",
        sourceId: "conflict-1",
        affectedRecordIds: [targetReview.id],
        createdAt: NOW,
      },
    ];
    const command = {
      type: "resolve_sync_conflict",
      reviewId: "review:sync_conflict:conflict-1",
      resolution: {
        conflictId: "conflict-1",
        retainedVersion: "local",
        retainedValue: targetReview as unknown as JsonValue,
        retainedBundleHash: "a".repeat(64),
        rationale: "Local is authoritative",
      },
    } as const satisfies V2Command;

    const result = await executeCommand(
      workspace,
      command,
      buildContext({ expectedRevision: 11 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing bundle provenance rejection");
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "sync_conflict:conflict-1:bundle",
    });
    expect(result.rejection.code).not.toBe("HOLD_BLOCKS_COMMAND");
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
      capacityProfile: structuredClone(retained.capacitySnapshot),
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
    expect(retainedResult.rejection.code).toBe("BET_REQUIRED");
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

    expect(validResult.rejection.code).toBe("BET_REQUIRED");
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
        resultStatus: "completed",
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
      name: "Direction brief",
      command: {
        type: "update_direction",
        projectId: "project-1",
        brief: {
          id: "action-triaged",
          projectId: "project-1",
          audienceAndProblem: "Not a Direction brief",
          successEvidence: "None",
          appetiteSeconds: 3_600,
          validationMethod: "None",
          firstScope: [
            { id: "scope-1", title: "None", description: "None" },
          ],
          noGoOrKill: "Promote first",
          advancedNotes: "",
        },
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

  it("rejects promotion when no Action eligibility rule requires Project structure", async () => {
    const workspace = buildOpenActionWorkspace();

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "promote_action_to_project",
          actionId: "action-triaged",
          eligibility,
          project: {
            id: "project-promoted",
            name: "Promoted launch",
            priority: 3,
            notes: "No Project rule supplied",
          },
        } as const,
        buildContext({ expectedRevision: 4 }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      reason: "Action promotion requires at least one failed eligibility rule.",
      gate: "action_promotion_eligibility:action-triaged",
      permittedNextCommand: "update_action",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("promotes an Action without deleting capture, Action, actual, or outcome history", async () => {
    const workspace = buildOpenActionWorkspace();
    const original = structuredClone(workspace);
    const promotionEligibility: Action["eligibility"] = {
      ...eligibility,
      dependencyIds: ["dependency-1"],
    };
    const command = {
      type: "promote_action_to_project",
      actionId: "action-triaged",
      eligibility: promotionEligibility,
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
      eligibility: promotionEligibility,
      outcomeNote: "Existing outcome history",
      updatedAt: NOW,
    });
    expect(result.workspace.inboxItems[0]).toMatchObject({
      id: original.inboxItems[0].id,
      actionId: "action-triaged",
      projectId: "project-promoted",
      triageStatus: "project",
      recommendation: {
        kind: "project",
        ruleCodes: ["NO_DEPENDENCY"],
        explanation: "Has a dependency.",
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

describe("executeCommand Direction and Bet", () => {
  const COMPLETE_DIRECTION = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    version: 4,
    audienceAndProblem: "Operators cannot see the next best action.",
    successEvidence: "Five users start the right action within one minute.",
    appetiteSeconds: 7_200,
    validationMethod: "Observe five users completing the workflow.",
    firstScope: [
      {
        id: "scope-1",
        title: "Guided project start",
        description: "Direction through the first committed plan.",
      },
    ],
    noGoOrKill: "Stop if expert coaching is required.",
    advancedNotes: "Editorial context.",
    createdAt: "2026-07-10T09:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
  });

  function buildDirectionWorkspace(
    stage: LifecycleStage = "direction",
    brief: DirectionBrief = COMPLETE_DIRECTION,
    overrides: Partial<WorkspaceV2> = {},
  ): WorkspaceV2 {
    return buildWorkspaceV2("workspace-direction", {
      projects: [
        buildProjectV2({
          id: "project-1",
          name: "Guided planning",
          priority: 1,
          notes: "Project metadata",
          stage,
          activeDirectionBriefId: brief.id,
          createdAt: "2026-07-10T09:00:00.000Z",
          updatedAt: "2026-07-10T10:00:00.000Z",
        }),
      ],
      directionBriefs: [structuredClone(brief)],
      ...overrides,
    });
  }

  function directionDraft() {
    const {
      version: _version,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      ...draft
    } = structuredClone(COMPLETE_DIRECTION);
    return draft;
  }

  function buildReplacementDirectionWorkspace(
    holds: ProjectHoldState[],
  ): WorkspaceV2 {
    const replacementBrief = {
      ...structuredClone(COMPLETE_DIRECTION),
      createdAt: "2026-07-10T09:00:00.000Z",
      updatedAt: "2026-07-10T09:00:00.000Z",
    };
    const predecessorBrief = {
      ...structuredClone(COMPLETE_DIRECTION),
      id: "brief-before-material-change",
      version: COMPLETE_DIRECTION.version - 1,
      audienceAndProblem: "Operators previously needed a different flow.",
      createdAt: "2026-07-10T07:00:00.000Z",
      updatedAt: "2026-07-10T07:30:00.000Z",
    };
    const currentBet = buildBetVersion({
      id: "bet-current",
      projectId: "project-1",
      briefId: predecessorBrief.id,
      briefSnapshot: predecessorBrief,
      committedScope: structuredClone(predecessorBrief.firstScope),
      appetiteStart: "2026-07-10T08:00:00.000Z",
      appetiteEnd: "2026-07-10T10:00:00.000Z",
      actorId: "human-old",
      approvedAt: "2026-07-10T08:00:00.000Z",
      invalidatedAt: replacementBrief.updatedAt,
      invalidationReason: "Material Direction change requires Re-bet.",
    });
    const workspace = buildDirectionWorkspace("planning", replacementBrief);
    workspace.directionBriefs.unshift(predecessorBrief);
    workspace.projects[0] = {
      ...workspace.projects[0],
      activeBetId: currentBet.id,
      holds,
    };
    workspace.bets = [currentBet];
    return workspace;
  }

  function buildExpiredReplacementDirectionWorkspace(
    reviewState: "completed" | "missing" | "open" | "wrong_decision" = "completed",
  ): WorkspaceV2 {
    const workspace = buildReplacementDirectionWorkspace([
      {
        type: "rebet_required",
        sourceId: "bet-current",
        affectedRecordIds: ["project-1", "bet-current"],
        createdAt: NOW,
      },
    ]);
    workspace.bets[0] = {
      ...workspace.bets[0],
      appetiteStart: "2026-07-11T07:00:00.000Z",
      appetiteEnd: NOW,
      approvedAt: "2026-07-11T07:00:00.000Z",
    };
    delete workspace.bets[0].invalidatedAt;
    delete workspace.bets[0].invalidationReason;
    if (reviewState === "missing") return workspace;
    workspace.reviews = [
      {
        id: "review:bet-current:expired",
        kind: "event",
        triggerKey: "bet-current:expired",
        triggerType: "bet_expired",
        status: reviewState === "open" ? "open" : "completed",
        affectedProjectIds: ["project-1"],
        affectedRecordIds: ["bet-current"],
        dueAt: NOW,
        createdAt: NOW,
        ...(reviewState === "open"
          ? {}
          : {
              conclusion: {
                summary: "Choose an explicit boundary after the appetite ended.",
                decisionCodes: reviewState === "wrong_decision"
                  ? ["close"]
                  : ["rebet"],
                followUpCommandIds: [],
                actorId: "human-reviewer",
                completedAt: NOW,
              },
            }),
      },
    ];
    return workspace;
  }

  it("saves an incomplete active brief as an editable Direction draft", async () => {
    const workspace = deepFreeze(buildDirectionWorkspace("awaiting_bet"));
    const original = structuredClone(workspace);
    const command = deepFreeze({
      type: "update_direction",
      projectId: "project-1",
      brief: {
        ...directionDraft(),
        audienceAndProblem: "   ",
        firstScope: [
          {
            id: "scope-1",
            title: "Still copied safely",
            description: "A bounded scope",
          },
        ],
      },
    } as const satisfies V2Command);

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Direction draft to apply");
    expect(result.workspace.projects[0]).toMatchObject({
      id: "project-1",
      stage: "direction",
      updatedAt: NOW,
    });
    expect(result.workspace.directionBriefs).toHaveLength(1);
    expect(result.workspace.directionBriefs[0]).toEqual({
      ...command.brief,
      version: COMPLETE_DIRECTION.version + 1,
      createdAt: COMPLETE_DIRECTION.createdAt,
      updatedAt: NOW,
    });
    expect(result.workspace.directionBriefs[0].firstScope).not.toBe(
      command.brief.firstScope,
    );
    expect(result.workspace.bets).toEqual([]);
    expect(workspace).toEqual(original);
  });

  it("moves a complete Direction brief to awaiting Bet without synthesizing approval", async () => {
    const incomplete = {
      ...COMPLETE_DIRECTION,
      version: 1,
      successEvidence: "",
    };
    const workspace = buildDirectionWorkspace("direction", incomplete);
    const command = {
      type: "update_direction",
      projectId: "project-1",
      brief: directionDraft(),
    } as const satisfies V2Command;

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected complete Direction to apply");
    expect(result.workspace.projects[0]).toMatchObject({
      stage: "awaiting_bet",
      activeDirectionBriefId: "brief-1",
      updatedAt: NOW,
    });
    expect(result.workspace.directionBriefs[0]).toMatchObject({
      ...command.brief,
      version: 2,
      createdAt: COMPLETE_DIRECTION.createdAt,
      updatedAt: NOW,
    });
    expect(result.workspace.bets).toEqual([]);
    expect(result.workspace.projects[0].activeBetId).toBeUndefined();
  });

  it.each([
    {
      name: "a different Project owner",
      command: {
        type: "update_direction",
        projectId: "project-1",
        brief: { ...directionDraft(), projectId: "project-2" },
      },
    },
    {
      name: "a non-active brief ID",
      command: {
        type: "update_direction",
        projectId: "project-1",
        brief: { ...directionDraft(), id: "brief-other" },
      },
    },
  ] as const)(
    "rejects Direction updates targeting $name atomically",
    async ({ command }) => {
      const workspace = buildDirectionWorkspace();
      const original = structuredClone(workspace);

      const result = rejected(
        await executeCommand(workspace, command, buildContext()),
      );

      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: "project:project-1:active_direction",
        permittedNextCommand: "update_direction",
      });
      expect(result.workspace).toBe(workspace);
      expect(workspace).toEqual(original);
    },
  );

  it.each(["planning", "executing", "validating", "closing", "closed"] as const)(
    "does not overwrite Direction history from illegal %s stage",
    async (stage) => {
      const workspace = buildDirectionWorkspace(stage);

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "update_direction",
            projectId: "project-1",
            brief: directionDraft(),
          },
          buildContext(),
        ),
      );

      expect(result.rejection).toMatchObject(
        stage === "closed"
          ? {
              code: "PROJECT_CLOSED",
              gate: "project:project-1:closed",
              permittedNextCommand: "create_follow_up_project",
            }
          : {
              code: "ILLEGAL_LIFECYCLE_TRANSITION",
              gate: `project:project-1:stage:${stage}`,
              permittedNextCommand: "update_direction",
            },
      );
      expect(result.workspace).toBe(workspace);
    },
  );

  it("places a human Bet with an immutable complete brief and exact appetite", async () => {
    const workspace = deepFreeze(
      buildDirectionWorkspace("awaiting_bet", COMPLETE_DIRECTION, {
        workItems: [
          {
            ...WORK_ITEM,
            durationSeconds: 9_999_999,
            estimate: { mostLikelySeconds: 9_999_999 },
          },
        ],
      }),
    );
    const command = deepFreeze({
      type: "place_bet",
      projectId: "project-1",
      betId: "bet-1",
      start: NOW,
    } as const satisfies V2Command);

    const result = await executeCommand(workspace, command, buildContext());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected human Bet to apply");
    expect(result.workspace.projects[0]).toMatchObject({
      id: "project-1",
      stage: "planning",
      activeBetId: "bet-1",
      updatedAt: NOW,
    });
    expect(result.workspace.bets).toHaveLength(1);
    expect(result.workspace.bets[0]).toEqual({
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: "brief-1",
      briefHash: await stableHash(COMPLETE_DIRECTION as unknown as JsonValue),
      briefSnapshot: COMPLETE_DIRECTION,
      committedScope: COMPLETE_DIRECTION.firstScope,
      appetiteStart: NOW,
      appetiteEnd: "2026-07-11T11:00:00.000Z",
      actorId: "human-1",
      approvedAt: NOW,
    });
    expect(result.workspace.bets[0].briefSnapshot).not.toBe(
      result.workspace.directionBriefs[0],
    );
    expect(result.workspace.bets[0].committedScope).not.toBe(
      result.workspace.bets[0].briefSnapshot.firstScope,
    );
    expect(workspace.projects[0].stage).toBe("awaiting_bet");
    expect(workspace.bets).toEqual([]);
  });

  it("uses the first human Bet to clear the guided migration review hold", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    workspace.projects[0] = {
      ...workspace.projects[0],
      holds: [
        {
          type: "migration_review",
          sourceId: "migration-backup-1",
          affectedRecordIds: ["project-1", COMPLETE_DIRECTION.id],
          createdAt: NOW,
        },
      ],
    };
    workspace.legacyAuditRecords = [
      {
        id: "migration-backup-1",
        projectId: "project-1",
        recordType: "audit_gate",
        sourcePayload: { reason: "guided migration review" },
        sourceChecksum: "migration-source-checksum",
      },
    ];
    const original = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-after-migration-review",
        start: NOW,
      },
      buildContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected migration review Bet to apply");
    expect(result.workspace.projects[0]).toMatchObject({
      stage: "planning",
      activeBetId: "bet-after-migration-review",
      holds: [],
    });
    expect(result.workspace.legacyAuditRecords).toEqual(
      original.legacyAuditRecords,
    );
    expect(result.workspace.bets[0]).toMatchObject({
      id: "bet-after-migration-review",
      actorId: "human-1",
      approvedAt: NOW,
    });
    expect(workspace).toEqual(original);
  });

  it("rejects a first Bet when migration review holds are not unique", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    workspace.projects[0] = {
      ...workspace.projects[0],
      holds: ["migration-backup-1", "migration-backup-2"].map((sourceId) => ({
        type: "migration_review" as const,
        sourceId,
        affectedRecordIds: ["project-1", COMPLETE_DIRECTION.id],
        createdAt: NOW,
      })),
    };
    workspace.legacyAuditRecords = ["migration-backup-1", "migration-backup-2"].map(
      (id) => ({
        id,
        projectId: "project-1",
        recordType: "audit_gate" as const,
        sourcePayload: { reason: "guided migration review" },
        sourceChecksum: `${id}:checksum`,
      }),
    );
    const original = structuredClone(workspace);

    const result = rejected(await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-ambiguous-migration",
        start: NOW,
      },
      buildContext(),
    ));

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      gate: "project:project-1:bet_holds",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(original);
  });

  it("rejects a migration review hold that omits the Project or active Direction", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    workspace.projects[0] = {
      ...workspace.projects[0],
      holds: [{
        type: "migration_review",
        sourceId: "migration-backup-1",
        affectedRecordIds: ["project-1"],
        createdAt: NOW,
      }],
    };
    workspace.legacyAuditRecords = [{
      id: "migration-backup-1",
      projectId: "project-1",
      recordType: "audit_gate",
      sourcePayload: { reason: "guided migration review" },
      sourceChecksum: "migration-source-checksum",
    }];
    const original = structuredClone(workspace);

    const result = rejected(await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-incomplete-migration-review",
        start: NOW,
      },
      buildContext(),
    ));

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      gate: "project:project-1:bet_holds",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(original);
  });

  it("rejects a replacement Bet unless one matching Re-bet hold is the only hold", async () => {
    const workspace = buildReplacementDirectionWorkspace([
      {
        type: "rebet_required",
        sourceId: "bet-current",
        affectedRecordIds: ["project-1", "bet-current"],
        createdAt: NOW,
      },
      {
        type: "migration_review",
        sourceId: "migration-backup-1",
        affectedRecordIds: ["project-1", COMPLETE_DIRECTION.id],
        createdAt: NOW,
      },
    ]);
    workspace.legacyAuditRecords = [{
      id: "migration-backup-1",
      projectId: "project-1",
      recordType: "audit_gate",
      sourcePayload: { reason: "guided migration review" },
      sourceChecksum: "migration-source-checksum",
    }];
    const original = structuredClone(workspace);

    const result = rejected(await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-illegal-replacement",
        start: NOW,
      },
      buildContext(),
    ));

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      gate: "project:project-1:bet_holds",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(original);
  });

  it.each([
    {
      name: "no Re-bet hold",
      holds: [],
    },
    {
      name: "a future-dated Re-bet hold",
      holds: [
        {
          type: "rebet_required" as const,
          sourceId: "bet-current",
          affectedRecordIds: ["project-1", "bet-current"],
          createdAt: LATER,
        },
      ],
    },
    {
      name: "ambiguous affected record IDs",
      holds: [
        {
          type: "rebet_required" as const,
          sourceId: "bet-current",
          affectedRecordIds: ["project-1", "project-1"],
          createdAt: NOW,
        },
      ],
    },
    {
      name: "a Re-bet hold missing the active Bet from affected records",
      holds: [
        {
          type: "rebet_required" as const,
          sourceId: "bet-current",
          affectedRecordIds: ["project-1"],
          createdAt: NOW,
        },
      ],
    },
  ])("rejects a replacement Bet with $name", async ({ holds }) => {
    const workspace = buildReplacementDirectionWorkspace(holds);
    const original = structuredClone(workspace);

    const result = rejected(await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-illegal-replacement",
        start: NOW,
      },
      buildContext(),
    ));

    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      gate: "project:project-1:bet_holds",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(original);
  });

  it("links an expiry Re-bet to its unique completed Review", async () => {
    const workspace = buildExpiredReplacementDirectionWorkspace();
    const originalReview = structuredClone(workspace.reviews[0]);

    const result = await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-after-expiry-review",
        start: NOW,
      },
      buildContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected expiry Re-bet to apply");
    expect(result.workspace.bets[1]).toMatchObject({
      id: "bet-after-expiry-review",
      supersedesId: "bet-current",
      replacementReason: "appetite_expiry",
      sourceReviewId: "review:bet-current:expired",
    });
    expect(result.workspace.bets[0]).toMatchObject({
      id: "bet-current",
      invalidatedAt: NOW,
    });
    expect(result.workspace.reviews).toEqual([originalReview]);
    expect(result.workspace.projects[0].holds).toEqual([]);
  });

  it.each([
    "missing",
    "open",
    "wrong_decision",
  ] as const)(
    "rejects an expiry Re-bet atomically when its Review is %s",
    async (reviewState) => {
      const workspace = buildExpiredReplacementDirectionWorkspace(reviewState);
      const original = structuredClone(workspace);

      const result = rejected(await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-without-approved-expiry-review",
          start: NOW,
        },
        buildContext(),
      ));

      expect(result.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        gate: reviewState === "open"
          ? "project_hold:review_overdue"
          : "project:project-1:expiry_review",
        permittedNextCommand: "complete_review",
      });
      if (reviewState !== "open") {
        expect(result.rejection.reason).toMatch(/completed expiry Review/i);
      }
      expect(result.workspace).toBe(workspace);
      expect(workspace).toEqual(original);
    },
  );

  it("does not invent Review provenance for a material-change Re-bet", async () => {
    const workspace = buildReplacementDirectionWorkspace([
      {
        type: "rebet_required",
        sourceId: "bet-current",
        affectedRecordIds: ["project-1", "bet-current"],
        createdAt: NOW,
      },
    ]);

    const result = await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-after-direction-change",
        start: NOW,
      },
      buildContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected material-change Re-bet to apply");
    expect(result.workspace.bets[1]).toMatchObject({
      id: "bet-after-direction-change",
      supersedesId: "bet-current",
      replacementReason: "material_direction_change",
    });
    expect(result.workspace.bets[1].sourceReviewId).toBeUndefined();
  });

  it("applies the same Bet policy result for human UI and verified sync replay", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    const command = {
      type: "place_bet",
      projectId: "project-1",
      betId: "bet-1",
      start: NOW,
    } as const satisfies V2Command;

    const uiResult = await executeCommand(
      workspace,
      command,
      buildContext({ commandId: "ui-place-bet" }),
    );
    const syncResult = await executeCommand(
      workspace,
      command,
      buildContext({
        commandId: "sync-place-bet",
        origin: "sync",
        source: {
          sourceId: "verified-replay",
          verified: true,
          capabilities: ["replay_receipt"],
        },
      }),
    );

    expect(uiResult.ok).toBe(true);
    expect(syncResult.ok).toBe(true);
    if (!uiResult.ok || !syncResult.ok) {
      throw new Error("Expected both human decision origins to apply");
    }
    expect(syncResult.workspace.projects).toEqual(uiResult.workspace.projects);
    expect(syncResult.workspace.directionBriefs).toEqual(
      uiResult.workspace.directionBriefs,
    );
    expect(syncResult.workspace.bets).toEqual(uiResult.workspace.bets);
  });

  it.each([
    ["agent", "ui", ["submit_proposal"]],
    ["agent", "agent", ["submit_proposal"]],
    ["agent", "import", ["import_portable", "submit_proposal"]],
    ["agent", "sync", ["replay_receipt", "submit_proposal"]],
    ["agent", "migration", ["submit_proposal"]],
    ["system", "ui", []],
    ["system", "agent", []],
    ["system", "import", ["import_portable"]],
    ["system", "sync", ["replay_receipt"]],
    ["system", "migration", []],
  ] as const)(
    "requires human confirmation for %s place_bet through authorized %s origin",
    async (actorKind, origin, capabilities) => {
      const workspace = buildDirectionWorkspace("awaiting_bet");

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "place_bet",
            projectId: "project-1",
            betId: "bet-1",
            start: NOW,
          },
          buildContext({
            actorId: `${actorKind}-1`,
            actorKind,
            origin,
            source: {
              sourceId: `${origin}-source`,
              verified: true,
              capabilities: [...capabilities],
            },
          }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        reason: "Only a human can place or replace a Bet.",
        permittedNextCommand: "place_bet",
        actorKind,
        origin,
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it.each([
    ["import", ["import_portable"]],
    ["migration", ["human_decision"]],
  ] as const)(
    "never treats human %s origin as fresh Bet approval",
    async (origin, capabilities) => {
      const workspace = buildDirectionWorkspace("awaiting_bet");
      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "place_bet",
            projectId: "project-1",
            betId: "bet-1",
            start: NOW,
          },
          buildContext({
            origin,
            source: {
              sourceId: `${origin}-source`,
              verified: true,
              capabilities: [...capabilities],
            },
          }),
        ),
      );

      expect(result.workspace).toBe(workspace);
      expect(result.rejection.code).toBe(
        origin === "import"
          ? "HUMAN_CONFIRMATION_REQUIRED"
          : "SOURCE_NOT_AUTHORIZED",
      );
    },
  );

  it("rejects an incomplete active brief before Bet approval", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet", {
      ...COMPLETE_DIRECTION,
      noGoOrKill: " ",
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-1",
          start: NOW,
        },
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "BRIEF_INCOMPLETE",
      gate: "project:project-1:direction_complete",
      permittedNextCommand: "update_direction",
    });
    expect(result.workspace).toBe(workspace);
  });

  it.each(["direction", "planning", "executing", "validating", "closing", "closed"] as const)(
    "places a first Bet only from awaiting_bet, not %s",
    async (stage) => {
      const workspace = buildDirectionWorkspace(stage);
      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "place_bet",
            projectId: "project-1",
            betId: "bet-1",
            start: NOW,
          },
          buildContext(),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "ILLEGAL_LIFECYCLE_TRANSITION",
        gate: `project:project-1:stage:${stage}`,
        permittedNextCommand: "place_bet",
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it("does not treat an awaiting project with historical Bet versions as a first Bet", async () => {
    const historicalBet = {
      id: "bet-historical",
      projectId: "project-1",
      version: 1,
      briefId: "brief-1",
      briefHash: "historical-hash",
      briefSnapshot: structuredClone(COMPLETE_DIRECTION),
      committedScope: structuredClone(COMPLETE_DIRECTION.firstScope),
      appetiteStart: NOW,
      appetiteEnd: LATER,
      actorId: "human-old",
      approvedAt: NOW,
      invalidatedAt: LATER,
      invalidationReason: "Historical Bet awaiting replacement",
    } as const;
    const workspace = buildDirectionWorkspace("awaiting_bet", COMPLETE_DIRECTION, {
      bets: [historicalBet],
    });
    const original = structuredClone(workspace);

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-new",
          start: NOW,
        },
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      reason: "Project project-1 already has Bet history; use the Re-bet path.",
      gate: "project:project-1:bet_history",
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(original);
  });

  it("rejects a duplicate Bet ID without changing Project state", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet", COMPLETE_DIRECTION, {
      bets: [
        {
          id: "bet-1",
          projectId: "project-1",
          version: 1,
          briefId: "brief-1",
          briefHash: "existing-hash",
          briefSnapshot: structuredClone(COMPLETE_DIRECTION),
          committedScope: structuredClone(COMPLETE_DIRECTION.firstScope),
          appetiteStart: NOW,
          appetiteEnd: LATER,
          actorId: "human-old",
          approvedAt: NOW,
          invalidatedAt: NOW,
          invalidationReason: "Historical Bet",
        },
      ],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-1",
          start: NOW,
        },
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:BetVersion:bet-1",
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
  });

  it.each([
    {
      name: "the pending CommandReceipt",
      betId: "command-reserved-id",
      commandId: "command-reserved-id",
      entity: "CommandReceipt",
      arrange: (_workspace: WorkspaceV2) => undefined,
    },
    {
      name: "an existing BetScope",
      betId: "scope-1",
      commandId: "command-scope-collision",
      entity: "BetScope",
      arrange: (_workspace: WorkspaceV2) => undefined,
    },
    {
      name: "a Daily Commitment slot",
      betId: "slot-reserved",
      commandId: "command-slot-collision",
      entity: "CommitmentSlot",
      arrange: (workspace: WorkspaceV2) => {
        workspace.capacityProfile = structuredClone(PROFILE);
        workspace.workItems = [structuredClone(WORK_ITEM)];
        workspace.dailyCommitments = [
          buildCommitment({
            slots: [{ ...COMMITMENT_SLOT, id: "slot-reserved" }],
          }),
        ];
      },
    },
    {
      name: "a Replan proposal slot",
      betId: "proposal-slot-reserved",
      commandId: "command-proposal-slot-collision",
      entity: "CommitmentSlot",
      arrange: (workspace: WorkspaceV2) => {
        workspace.capacityProfile = structuredClone(PROFILE);
        workspace.workItems = [structuredClone(WORK_ITEM)];
        workspace.dailyCommitments = [buildCommitment()];
        workspace.replanProposals = [
          {
            id: "proposal-with-reserved-slot",
            localDate: "2026-07-11",
            baseCommitmentId: "commitment-1",
            baseRevision: 0,
            reasonCodes: ["actual_changed"],
            proposedSlots: [
              { ...COMMITMENT_SLOT, id: "proposal-slot-reserved" },
            ],
            proposalHash: "proposal-hash",
            createdAt: NOW,
            createdBy: "human-1",
            status: "open",
          },
        ];
      },
    },
    {
      name: "a current capacity unavailable block",
      betId: "away-1",
      commandId: "command-away-collision",
      entity: "UnavailableBlock",
      arrange: (workspace: WorkspaceV2) => {
        workspace.capacityProfile = structuredClone(PROFILE);
      },
    },
    {
      name: "a committed capacity unavailable block",
      betId: "committed-away",
      commandId: "command-committed-away-collision",
      entity: "UnavailableBlock",
      arrange: (workspace: WorkspaceV2) => {
        workspace.capacityProfile = structuredClone(PROFILE);
        workspace.workItems = [structuredClone(WORK_ITEM)];
        workspace.dailyCommitments = [
          buildCommitment({
            capacitySnapshot: {
              ...structuredClone(PROFILE),
              unavailableBlocks: [
                {
                  id: "committed-away",
                  start: NOW,
                  finish: LATER,
                },
              ],
            },
          }),
        ];
      },
    },
    {
      name: "a migration backup",
      betId: "backup-reserved",
      commandId: "command-backup-collision",
      entity: "MigrationBackup",
      arrange: (workspace: WorkspaceV2) => {
        workspace.migration = {
          sourceSchemaVersion: 1,
          sourceChecksum: "source-checksum",
          backupId: "backup-reserved",
          backupChecksum: "backup-checksum",
          migratedAt: NOW,
          entityCounts: {},
          deterministicIdMap: {},
        };
      },
    },
  ])("rejects a Bet ID owned by $name", async ({ betId, commandId, entity, arrange }) => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    arrange(workspace);

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId,
          start: NOW,
        },
        buildContext({ commandId }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:${entity}:${betId}`,
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("rejects a Bet ID already owned by another entity type", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "brief-1",
          start: NOW,
        },
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:DirectionBrief:brief-1",
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("rejects an invalid ISO Bet start without throwing", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");
    const result = await executeCommand(
      workspace,
      {
        type: "place_bet",
        projectId: "project-1",
        betId: "bet-1",
        start: "not-a-date",
      },
      buildContext(),
    );
    const rejectedResult = rejected(result);
    expect(rejectedResult.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      reason: "Bet start must be a valid ISO timestamp.",
      gate: "bet:bet-1:appetite_start",
      permittedNextCommand: "place_bet",
    });
    expect(rejectedResult.workspace).toBe(workspace);
  });

  it("rejects a command start that differs from the authoritative approval time", async () => {
    const workspace = buildDirectionWorkspace("awaiting_bet");

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-1",
          start: "2026-07-12T09:00:00.000Z",
        },
        buildContext(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      reason: "Bet start must equal the authoritative approval timestamp.",
      gate: "bet:bet-1:appetite_start",
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
  });
});
