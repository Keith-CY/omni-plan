import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "./commands";
import { applyCommandHandler } from "./commandHandlers";
import { isExceptionActive, requirementStatus } from "./evidence";
import { validateWorkspaceInvariants } from "./invariants";
import { generateTodayProposal } from "./today";
import type {
  ExceptionRecord,
  ProjectHoldState,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";
import {
  buildBetVersion,
  buildDirectionBrief,
  buildInboxItem,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";

const CREATED_AT = "2026-07-11T09:00:00.000Z";
const EXPIRES_AT = "2026-07-12T09:00:00.000Z";

function context(
  revision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: "command-1",
    expectedRevision: revision,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "human-session-1",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: CREATED_AT,
    ...overrides,
  };
}

function actionWorkspace() {
  const inboxItem = buildInboxItem({
    id: "inbox-1",
    sourceId: "human-session-1",
    actorId: "human-1",
    capturedAt: CREATED_AT,
  });
  return buildWorkspaceV2("workspace-1", {
    revision: 3,
    inboxItems: [
      { ...inboxItem, triageStatus: "action", actionId: "action-1" },
    ],
    actions: [
      {
        id: "action-1",
        inboxItemId: inboxItem.id,
        title: "Publish the concise result",
        revision: 1,
        status: "open",
        eligibility: {
          singleSession: true,
          estimateSeconds: 900,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 1,
          solutionKnown: true,
        },
        attention: "shallow",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ],
  });
}

function projectWorkspace(
  overrides: {
    evidenceRequired?: boolean;
    kind?: ProjectWorkItem["kind"];
    stage?: WorkspaceV2["projects"][number]["stage"];
    holds?: ProjectHoldState[];
  } = {},
): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    appetiteSeconds: 864_000,
    firstScope: [
      {
        id: "scope-1",
        title: "Ship the validation slice",
        description: "Complete and validate the selected milestone.",
      },
    ],
    createdAt: "2026-07-10T08:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: "project-1",
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-10T08:00:00.000Z",
    appetiteEnd: "2026-07-20T08:00:00.000Z",
    actorId: "human-1",
    approvedAt: "2026-07-10T08:00:00.000Z",
  });
  const workItem: ProjectWorkItem = {
    id: "work-item-1",
    projectId: "project-1",
    kind: overrides.kind ?? "task",
    title: "Deliver the result",
    outline: "1",
    durationSeconds: 900,
    estimate: { mostLikelySeconds: 900 },
    assignmentIds: [],
    percentComplete: 0,
    evidenceRequired: overrides.evidenceRequired ?? false,
    revision: 1,
    betScopeId: "scope-1",
  };
  const project = buildProjectV2({
    id: "project-1",
    activeDirectionBriefId: brief.id,
    activeBetId: bet.id,
    activePlanVersionId: "plan-1",
    stage: overrides.stage ?? "executing",
    holds: structuredClone(overrides.holds ?? []),
    createdAt: "2026-07-10T08:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z",
  });
  return buildWorkspaceV2("workspace-1", {
    revision: 7,
    projects: [project],
    directionBriefs: [brief],
    bets: [bet],
    workItems: [workItem],
    planVersions: [
      {
        id: "plan-1",
        projectId: project.id,
        version: 1,
        betId: bet.id,
        workItemRevisions: { [workItem.id]: workItem.revision },
        dependencyRevisions: {},
        scopeMapping: { [workItem.id]: workItem.betScopeId },
        scheduleHash: "schedule-1",
        capacityIndependentDates: {
          [workItem.id]: {
            start: "2026-07-11T09:00:00.000Z",
            finish: "2026-07-11T09:15:00.000Z",
          },
        },
        actorId: "human-1",
        createdAt: "2026-07-10T08:00:00.000Z",
      },
    ],
  });
}

function commitWorkItemForDate(
  workspace: WorkspaceV2,
  localDate: string,
  targetRevision = workspace.workItems[0].revision,
): void {
  const day = localDate === "2026-07-10" ? 10 : 11;
  const capacity = {
    timeZone: "UTC",
    weeklyWindows: [
      { weekday: 5 as const, startMinute: 480, finishMinute: 720 },
      { weekday: 6 as const, startMinute: 480, finishMinute: 720 },
    ],
    dailyBudgets: [
      {
        weekday: 5 as const,
        deepSeconds: 14_400,
        mediumSeconds: 0,
        shallowSeconds: 0,
      },
      {
        weekday: 6 as const,
        deepSeconds: 14_400,
        mediumSeconds: 0,
        shallowSeconds: 0,
      },
    ],
    unavailableBlocks: [],
    updatedAt: "2026-07-10T08:00:00.000Z",
    updatedBy: "human-1",
  };
  workspace.capacityProfile = structuredClone(capacity);
  workspace.dailyCommitments = [
    {
      id: `commitment-${localDate}`,
      localDate,
      version: 1,
      proposalHash: `proposal-${localDate}`,
      capacitySnapshot: structuredClone(capacity),
      slots: [
        {
          id: `slot-${localDate}`,
          target: {
            kind: "work_item",
            workItemId: "work-item-1",
            projectId: "project-1",
          },
          targetRevision,
          start: `2026-07-${String(day).padStart(2, "0")}T09:00:00.000Z`,
          finish: `2026-07-${String(day).padStart(2, "0")}T09:15:00.000Z`,
          attention: "deep",
        },
      ],
      actorId: "human-1",
      committedAt: `2026-07-${String(day).padStart(2, "0")}T08:00:00.000Z`,
    },
  ];
}

function reviewOverdueWorkspace(): WorkspaceV2 {
  const workspace = projectWorkspace({
    holds: [
      {
        type: "review_overdue",
        sourceId: "review-1",
        affectedRecordIds: ["project-1", "work-item-1"],
        createdAt: CREATED_AT,
      },
    ],
  });
  workspace.reviews.push({
    id: "review-1",
    kind: "event",
    triggerKey: "review-overdue-1",
    triggerType: "hard_gate",
    status: "open",
    affectedProjectIds: ["project-1"],
    affectedRecordIds: ["project-1", "work-item-1"],
    dueAt: CREATED_AT,
    createdAt: CREATED_AT,
  });
  return workspace;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

function exception(
  overrides: Partial<ExceptionRecord> = {},
): ExceptionRecord {
  return {
    id: "exception-1",
    projectId: "project-1",
    requirementId: "milestone-1",
    rationale: "Evidence will arrive after the validation meeting.",
    knownConsequence: "The validation decision may need to be revisited.",
    reviewAt: "2026-07-11T17:00:00.000Z",
    expiresAt: EXPIRES_AT,
    approvedBy: "human-1",
    createdAt: CREATED_AT,
    history: [
      {
        action: "created",
        actorId: "human-1",
        at: CREATED_AT,
        note: "Approved with a bounded review and expiry.",
      },
    ],
    ...overrides,
  };
}

describe("controlled evidence exceptions", () => {
  it("is active only from creation until, but not including, expiry", () => {
    const record = exception();

    expect(isExceptionActive(record, CREATED_AT)).toBe(true);
    expect(isExceptionActive(record, EXPIRES_AT)).toBe(false);
    expect(
      isExceptionActive(record, "2026-07-11T08:59:59.999Z"),
    ).toBe(false);
    expect(
      isExceptionActive(record, "2026-07-11T10:00:00.000Z"),
    ).toBe(true);
    expect(
      isExceptionActive(
        exception({ resolvedAt: "2026-07-11T09:30:00.000Z" }),
        "2026-07-11T10:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("never activates a malformed imported controlled Exception", () => {
    const malformed = [
      exception({ rationale: "   " }),
      exception({ knownConsequence: "   " }),
      exception({ approvedBy: "   " }),
      exception({ reviewAt: EXPIRES_AT }),
      exception({ history: [] }),
    ];

    for (const record of malformed) {
      const workspace = projectWorkspace({
        kind: "milestone",
        evidenceRequired: true,
      });
      record.requirementId = "work-item-1";
      workspace.exceptions = [record];

      expect(isExceptionActive(record, CREATED_AT)).toBe(false);
      expect(
        requirementStatus(workspace, "project-1", "work-item-1", CREATED_AT),
      ).toEqual({ satisfied: false, code: "EVIDENCE_REQUIRED" });
    }
  });

  it("satisfies only an exact same-project concrete requirement with current Evidence", () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.evidence.push({
      id: "evidence-1",
      kind: "metric",
      summary: "Observed result",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 1,
      tags: [],
    });

    expect(
      requirementStatus(
        workspace,
        "project-1",
        "work-item-1",
        CREATED_AT,
      ),
    ).toEqual({ satisfied: true, via: "evidence" });
  });

  it("records every bounded Exception field with human approval history", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const draft = {
      id: "exception-1",
      projectId: "project-1",
      requirementId: "work-item-1",
      rationale: "Evidence will arrive after the validation meeting.",
      knownConsequence: "The validation conclusion may need revision.",
      reviewAt: "2026-07-11T17:00:00.000Z",
      expiresAt: EXPIRES_AT,
    };

    const result = await executeCommand(
      workspace,
      { type: "approve_evidence_exception", exception: draft },
      context(workspace.revision, { commandId: "approve-exception-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected human Exception approval");
    expect(result.workspace.exceptions).toEqual([
      {
        ...draft,
        approvedBy: "human-1",
        createdAt: CREATED_AT,
        history: [
          {
            action: "created",
            actorId: "human-1",
            at: CREATED_AT,
            note: draft.rationale,
          },
        ],
      },
    ]);
    expect(workspace.exceptions).toEqual([]);
  });

  it("rejects an Exception whose review is after expiry", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const result = await executeCommand(
      workspace,
      {
        type: "approve_evidence_exception",
        exception: {
          id: "exception-invalid-window",
          projectId: "project-1",
          requirementId: "work-item-1",
          rationale: "Temporary allowance",
          knownConsequence: "Validation may be revisited",
          reviewAt: EXPIRES_AT,
          expiresAt: "2026-07-11T17:00:00.000Z",
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid Exception window");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "exception:exception-invalid-window:window",
    });
    expect(result.workspace.exceptions).toEqual([]);
  });

  it("requires Exception review strictly before expiry", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const result = await executeCommand(
      workspace,
      {
        type: "approve_evidence_exception",
        exception: {
          id: "exception-equal-boundary",
          projectId: "project-1",
          requirementId: "work-item-1",
          rationale: "Temporary allowance",
          knownConsequence: "Validation may be revisited",
          reviewAt: EXPIRES_AT,
          expiresAt: EXPIRES_AT,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected equal review and expiry to reject");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "exception:exception-equal-boundary:window",
    });
  });

  it("rejects injected Exception authority fields at the exact command boundary", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const command = {
      type: "approve_evidence_exception",
      exception: {
        id: "exception-injected",
        projectId: "project-1",
        requirementId: "work-item-1",
        rationale: "Bounded temporary allowance",
        knownConsequence: "Validation may need revision",
        reviewAt: "2026-07-11T17:00:00.000Z",
        expiresAt: EXPIRES_AT,
        approvedBy: "attacker",
        createdAt: "2020-01-01T00:00:00.000Z",
        resolvedAt: CREATED_AT,
        history: [{ action: "resolved", actorId: "attacker", at: CREATED_AT }],
        forged: true,
      },
    } as unknown as V2Command;

    const result = await executeCommand(
      workspace,
      command,
      context(workspace.revision, { commandId: "approve-injected" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected injected authority rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:approve_evidence_exception",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace.exceptions).toEqual([]);
  });

  it("rejects an Exception without rationale and known consequence", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const result = await executeCommand(
      workspace,
      {
        type: "approve_evidence_exception",
        exception: {
          id: "exception-empty-reason",
          projectId: "project-1",
          requirementId: "work-item-1",
          rationale: "   ",
          knownConsequence: "   ",
          reviewAt: "2026-07-11T17:00:00.000Z",
          expiresAt: EXPIRES_AT,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected empty Exception reason to reject");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "exception:exception-empty-reason:details",
    });
  });

  it("resolves an active Exception with immutable history and reopens its gate", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const activeException = exception({ requirementId: "work-item-1" });
    workspace.exceptions.push(activeException);
    const resolvedAt = "2026-07-11T10:00:00.000Z";

    const result = await executeCommand(
      workspace,
      {
        type: "resolve_evidence_exception",
        exceptionId: "exception-1",
        resolution: "Evidence will be attached directly.",
      },
      context(workspace.revision, {
        commandId: "resolve-exception-1",
        now: resolvedAt,
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Exception resolution");
    expect(result.workspace.exceptions[0]).toEqual({
      ...activeException,
      resolvedAt,
      history: [
        ...activeException.history,
        {
          action: "resolved",
          actorId: "human-1",
          at: resolvedAt,
          note: "Evidence will be attached directly.",
        },
      ],
    });
    expect(
      requirementStatus(
        result.workspace,
        "project-1",
        "work-item-1",
        resolvedAt,
      ),
    ).toEqual({ satisfied: false, code: "EVIDENCE_REQUIRED" });
    expect(workspace.exceptions[0].resolvedAt).toBeUndefined();
  });

  it("does not let an expired requirement Exception block unrelated commands", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.workItems[0].resultStatus = "completed";
    workspace.workItems[0].outcomeNote = "Historical completion";
    workspace.exceptions.push(
      exception({
        requirementId: "work-item-1",
        createdAt: "2026-07-10T09:00:00.000Z",
        reviewAt: "2026-07-10T17:00:00.000Z",
        expiresAt: CREATED_AT,
      }),
    );

    const result = await executeCommand(
      workspace,
      { type: "capture_inbox", id: "inbox-unrelated", text: "Unrelated" },
      context(workspace.revision, { commandId: "capture-unrelated" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected unrelated capture to apply");
    expect(result.workspace.inboxItems).toHaveLength(1);
    expect(result.workspace.exceptions).toEqual(workspace.exceptions);
  });

  it("ignores future or cross-project Evidence for requirement satisfaction", () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.evidence.push(
      {
        id: "evidence-future",
        kind: "metric",
        summary: "Future observation",
        projectId: "project-1",
        workItemId: "work-item-1",
        createdAt: "2026-07-11T09:00:00.001Z",
        confidence: 1,
        tags: [],
      },
      {
        id: "evidence-wrong-project",
        kind: "metric",
        summary: "Wrong project",
        projectId: "project-2",
        workItemId: "work-item-1",
        createdAt: CREATED_AT,
        confidence: 1,
        tags: [],
      },
    );

    expect(
      requirementStatus(
        workspace,
        "project-1",
        "work-item-1",
        CREATED_AT,
      ),
    ).toEqual({ satisfied: false, code: "EVIDENCE_REQUIRED" });
  });

  it("rejects non-human approval and non-concrete Exception targets", async () => {
    const workspace = projectWorkspace({
      kind: "task",
      evidenceRequired: true,
    });
    const draft = {
      id: "exception-invalid-target",
      projectId: "project-1",
      requirementId: "work-item-1",
      rationale: "Temporary allowance",
      knownConsequence: "May revisit",
      reviewAt: "2026-07-11T17:00:00.000Z",
      expiresAt: EXPIRES_AT,
    };
    const nonHuman = await executeCommand(
      workspace,
      { type: "approve_evidence_exception", exception: draft },
      context(workspace.revision, {
        actorId: "agent-1",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-source-1",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    expect(nonHuman.ok).toBe(false);
    if (nonHuman.ok) throw new Error("Expected non-human approval rejection");
    expect(nonHuman.rejection.code).toBe("HUMAN_CONFIRMATION_REQUIRED");

    const wrongTarget = await executeCommand(
      workspace,
      { type: "approve_evidence_exception", exception: draft },
      context(workspace.revision),
    );
    expect(wrongTarget.ok).toBe(false);
    if (wrongTarget.ok) throw new Error("Expected concrete target rejection");
    expect(wrongTarget.rejection).toMatchObject({
      code: "EVIDENCE_REQUIRED",
      gate: "exception:exception-invalid-target:requirement",
    });
  });

  it("reports a persisted Exception that does not target a concrete milestone", () => {
    const workspace = projectWorkspace({ evidenceRequired: true, kind: "task" });
    workspace.exceptions.push(
      exception({ requirementId: "work-item-1" }),
    );

    expect(validateWorkspaceInvariants(workspace, CREATED_AT)).toContainEqual(
      expect.objectContaining({
        code: "ENTITY_NOT_FOUND",
        gate: "reference:ExceptionRecord:exception-1:requirementId",
      }),
    );
  });
});

describe("tiered completion evidence", () => {
  it("rejects Action completion without positive actual effort atomically", async () => {
    const workspace = actionWorkspace();
    const before = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 0,
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing effort to be rejected");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "action_actual:action-1",
    });
    expect(result.workspace).toEqual(before);
    expect(result.receipt.diff).toEqual([]);
  });

  it("requires Action actual effort to be a positive safe integer", async () => {
    for (const actualSeconds of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const workspace = actionWorkspace();
      const result = await executeCommand(
        workspace,
        {
          type: "complete_action",
          actionId: "action-1",
          actualSeconds,
          resultStatus: "completed",
          outcomeNote: "Finished",
        },
        context(workspace.revision, { commandId: `action-${actualSeconds}` }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unsafe Action effort to reject");
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: "action_actual:action-1",
      });
    }
  });

  it("rejects completion command IDs already owned by another entity", async () => {
    const actionState = actionWorkspace();
    const actionResult = await executeCommand(
      actionState,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(actionState.revision, { commandId: actionState.workspaceId }),
    );

    const workItemState = projectWorkspace();
    workItemState.actuals.push({
      id: "actual-completion-collision",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });
    const workItemResult = await executeCommand(
      workItemState,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(workItemState.revision, {
        commandId: workItemState.workspaceId,
      }),
    );

    for (const result of [actionResult, workItemResult]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected CommandReceipt ID collision");
      expect(result.rejection).toMatchObject({
        code: "ENTITY_ALREADY_EXISTS",
        gate: "entity_id:WorkspaceV2:workspace-1",
      });
    }
    expect(actionState.actions[0].resultStatus).toBeUndefined();
    expect(workItemState.workItems[0].resultStatus).toBeUndefined();
  });

  it("rejects completion at a non-canonical authoritative time", async () => {
    const nonCanonicalNow = "2026-07-11T09:00:00Z";
    const actionState = actionWorkspace();
    const actionResult = await executeCommand(
      actionState,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(actionState.revision, {
        commandId: "complete-action-noncanonical",
        now: nonCanonicalNow,
      }),
    );

    const workItemState = projectWorkspace();
    workItemState.actuals.push({
      id: "actual-before-noncanonical-completion",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });
    const workItemResult = await executeCommand(
      workItemState,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(workItemState.revision, {
        commandId: "complete-work-item-noncanonical",
        now: nonCanonicalNow,
      }),
    );

    for (const [commandId, result] of [
      ["complete-action-noncanonical", actionResult],
      ["complete-work-item-noncanonical", workItemResult],
    ] as const) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected non-canonical completion time");
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: `command:${commandId}:time`,
      });
    }
    expect(actionState.actuals).toEqual([]);
    expect(workItemState.workItems[0].resultStatus).toBeUndefined();
  });

  it("rejects blank command and actor identities at the public handler boundary", async () => {
    const actionState = actionWorkspace();
    const blankCommandId = await executeCommand(
      actionState,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "completed",
        outcomeNote: "Finished",
      },
      context(actionState.revision, { commandId: "   " }),
    );

    const exceptionState = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const blankActorId = await executeCommand(
      exceptionState,
      {
        type: "approve_evidence_exception",
        exception: {
          id: "exception-blank-actor",
          projectId: "project-1",
          requirementId: "work-item-1",
          rationale: "Temporary allowance",
          knownConsequence: "Validation may be revisited",
          reviewAt: "2026-07-11T17:00:00.000Z",
          expiresAt: EXPIRES_AT,
        },
      },
      context(exceptionState.revision, {
        commandId: "approve-blank-actor",
        actorId: "   ",
      }),
    );

    expect(blankCommandId.ok).toBe(false);
    if (blankCommandId.ok) throw new Error("Expected blank Command ID rejection");
    expect(blankCommandId.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_context:command_id",
    });
    expect(blankActorId.ok).toBe(false);
    if (blankActorId.ok) throw new Error("Expected blank actor ID rejection");
    expect(blankActorId.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_context:actor_id",
    });
  });

  it("rejects Action completion without a concise outcome", async () => {
    const workspace = actionWorkspace();

    const result = await executeCommand(
      workspace,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "blocked",
        outcomeNote: "   ",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected blank outcome to be rejected");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "action_outcome:action-1",
    });
  });

  it("persists an Action result of completed, learned, or blocked with its Actual", async () => {
    const workspace = actionWorkspace();

    const result = await executeCommand(
      workspace,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "learned",
        outcomeNote: "A smaller note is enough.",
      } satisfies V2Command,
      context(workspace.revision),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Action completion to apply");
    expect(result.workspace.actions[0]).toMatchObject({
      status: "completed",
      resultStatus: "learned",
      outcomeNote: "A smaller note is enough.",
    });
    expect(result.workspace.actuals).toEqual([
      expect.objectContaining({
        target: { kind: "action", actionId: "action-1" },
        actualWorkSeconds: 300,
      }),
    ]);
    expect(result.workspace.evidence).toEqual([]);
  });

  it("rejects a derived Action Actual ID owned by any other entity", async () => {
    const workspace = actionWorkspace();
    workspace.inboxItems.push(
      buildInboxItem({
        id: "complete-action-collision:actual",
        sourceId: "human-session-1",
        actorId: "human-1",
        capturedAt: CREATED_AT,
      }),
    );

    const result = await executeCommand(
      workspace,
      {
        type: "complete_action",
        actionId: "action-1",
        actualSeconds: 300,
        resultStatus: "completed",
        outcomeNote: "Should remain atomic.",
      },
      context(workspace.revision, {
        commandId: "complete-action-collision",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected derived Actual ID collision");
    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:InboxItem:complete-action-collision:actual",
    });
    expect(result.workspace.actions[0].status).toBe("open");
    expect(result.workspace.actuals).toEqual([]);
  });

  it("rejects ordinary Work Item completion until actual effort is recorded", async () => {
    const workspace = projectWorkspace();

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "learned",
        outcomeNote: "The smaller delivery is sufficient.",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing Actual to be rejected");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:actual_effort",
      permittedNextCommand: "record_actual",
    });
  });

  it("rejects Work Item completion without a concise outcome", async () => {
    const workspace = projectWorkspace();
    workspace.actuals.push({
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "blocked",
        outcomeNote: "   ",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected blank outcome to be rejected");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:outcome",
    });
  });

  it("makes Work Item completion a one-shot immutable result", async () => {
    const workspace = projectWorkspace();
    workspace.workItems[0].resultStatus = "completed";
    workspace.workItems[0].outcomeNote = "Original result";
    workspace.actuals.push({
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "learned",
        outcomeNote: "Replacement result",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected repeated completion to reject");
    expect(result.rejection).toMatchObject({
      code: "REVISION_CONFLICT",
      gate: "work_item:work-item-1:result",
    });
    expect(result.workspace.workItems[0]).toMatchObject({
      resultStatus: "completed",
      outcomeNote: "Original result",
    });
  });

  it("does not use future Actual effort to authorize completion", async () => {
    const workspace = projectWorkspace();
    workspace.actuals.push({
      id: "actual-future",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: "2026-07-11T09:00:00.001Z",
    });

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Should wait for authoritative time.",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected future Actual to be ignored");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:actual_effort",
    });
  });

  it("does not use fractional Actual effort to authorize completion", async () => {
    const workspace = projectWorkspace();
    workspace.actuals.push({
      id: "actual-fractional",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 0.5,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Fractional effort must not satisfy completion.",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected fractional Actual to be ignored");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:actual_effort",
    });
  });

  it("blocks an evidence-required milestone without exact Evidence or Exception", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.actuals.push({
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Validation milestone reached.",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected milestone evidence gate");
    expect(result.rejection).toMatchObject({
      code: "EVIDENCE_REQUIRED",
      gate: "work_item:work-item-1:evidence",
      permittedNextCommand: "attach_evidence",
    });
  });

  it("returns EXCEPTION_EXPIRED at expiry without deleting history", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.actuals.push({
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });
    const expired = exception({
      requirementId: "work-item-1",
      createdAt: "2026-07-10T09:00:00.000Z",
      reviewAt: "2026-07-10T17:00:00.000Z",
      expiresAt: CREATED_AT,
      history: [
        {
          action: "created",
          actorId: "human-1",
          at: "2026-07-10T09:00:00.000Z",
          note: "Approved with a bounded review and expiry.",
        },
      ],
    });
    workspace.exceptions.push(expired);

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        resultStatus: "completed",
        outcomeNote: "Should be blocked again at expiry.",
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected expired Exception rejection");
    expect(result.rejection).toMatchObject({
      code: "EXCEPTION_EXPIRED",
      gate: "work_item:work-item-1:evidence",
    });
    expect(result.workspace.exceptions).toEqual([expired]);
    expect(result.workspace.workItems[0].resultStatus).toBeUndefined();
  });
});

describe("recording Actual effort", () => {
  it("appends one immutable positive Actual for an exact existing target", async () => {
    const workspace = projectWorkspace();
    const before = structuredClone(workspace);
    const actual = {
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item" as const, workItemId: "work-item-1" },
      actualStart: "2026-07-11T08:55:00.000Z",
      actualFinish: CREATED_AT,
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 25,
      recordedAt: CREATED_AT,
    };

    const result = await executeCommand(
      workspace,
      { type: "record_actual", actual },
      context(workspace.revision, { commandId: "record-actual-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Actual to be recorded");
    expect(result.workspace.actuals).toEqual([actual]);
    expect(result.workspace.revision).toBe(workspace.revision + 1);
    expect(result.receipt.diff).toEqual([
      expect.objectContaining({
        entity: "ActualV2",
        entityId: actual.id,
        field: "created",
      }),
    ]);
    expect(workspace).toEqual(before);
  });

  it("rejects a new Actual whose append-only revision is not one", async () => {
    const workspace = projectWorkspace();
    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-1",
          revision: 2,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: CREATED_AT,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid Actual revision");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "actual:actual-1:revision",
    });
    expect(result.workspace.actuals).toEqual([]);
  });

  it("rejects an empty Actual ID and command-ID reuse", async () => {
    const workspace = projectWorkspace();
    const baseActual = {
      revision: 1,
      target: { kind: "work_item" as const, workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    };
    const emptyId = await executeCommand(
      workspace,
      { type: "record_actual", actual: { id: "   ", ...baseActual } },
      context(workspace.revision, { commandId: "record-empty-id" }),
    );
    expect(emptyId.ok).toBe(false);
    if (emptyId.ok) throw new Error("Expected empty Actual ID rejection");
    expect(emptyId.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "actual:   :id",
    });

    const commandIdReuse = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: { id: "record-reused-id", ...baseActual },
      },
      context(workspace.revision, { commandId: "record-reused-id" }),
    );
    expect(commandIdReuse.ok).toBe(false);
    if (commandIdReuse.ok) throw new Error("Expected command ID collision");
    expect(commandIdReuse.rejection.code).toBe("ENTITY_ALREADY_EXISTS");
  });

  it("rejects non-positive or unsafe Actual work seconds", async () => {
    const workspace = projectWorkspace();
    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-1",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 0,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: CREATED_AT,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid Actual work seconds");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "actual:actual-1:actualWorkSeconds",
    });
  });

  it("rejects negative or unsafe remaining effort and cost", async () => {
    const workspace = projectWorkspace();
    const baseActual = {
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item" as const, workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    };
    for (const [patch, gate] of [
      [{ remainingWorkSeconds: -1 }, "remainingWorkSeconds"],
      [{ actualCost: -1 }, "actualCost"],
    ] as const) {
      const result = await executeCommand(
        workspace,
        {
          type: "record_actual",
          actual: {
            ...baseActual,
            ...patch,
          },
        },
        context(workspace.revision),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unsafe Actual quantities");
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: `actual:actual-1:${gate}`,
      });
    }
  });

  it("rejects non-canonical or ill-ordered Actual timestamps", async () => {
    const workspace = projectWorkspace();
    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-1",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: "2026-07-11T09:00:00Z",
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected non-canonical Actual time");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "actual:actual-1:timestamps",
    });
  });

  it("does not treat a historical commitment as current during review overdue", async () => {
    const workspace = reviewOverdueWorkspace();
    commitWorkItemForDate(workspace, "2026-07-10");

    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-historical",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: CREATED_AT,
        },
      },
      context(workspace.revision, { commandId: "record-historical" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected historical target to be frozen");
    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
    expect(result.workspace.actuals).toEqual([]);
  });

  it("ignores malformed historical commitment lineage when selecting today's sole commitment", async () => {
    const workspace = reviewOverdueWorkspace();
    commitWorkItemForDate(workspace, "2026-07-11");
    const snapshot = structuredClone(
      workspace.dailyCommitments[0].capacitySnapshot,
    );
    const historicalRoot = {
      id: "historical-commitment-root",
      localDate: "2026-07-10",
      version: 1,
      proposalHash: "historical-root-proposal",
      capacitySnapshot: snapshot,
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-10T08:00:00.000Z",
    } satisfies WorkspaceV2["dailyCommitments"][number];
    workspace.dailyCommitments.push(
      historicalRoot,
      {
        ...structuredClone(historicalRoot),
        id: "historical-commitment-branch-a",
        version: 2,
        proposalHash: "historical-branch-a-proposal",
        supersedesId: historicalRoot.id,
      },
      {
        ...structuredClone(historicalRoot),
        id: "historical-commitment-branch-b",
        version: 2,
        proposalHash: "historical-branch-b-proposal",
        supersedesId: historicalRoot.id,
      },
    );

    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-with-historical-fork",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: CREATED_AT,
        },
      },
      context(workspace.revision, {
        commandId: "record-with-historical-fork",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected historical fork to be irrelevant");
    expect(result.workspace.actuals).toEqual([
      expect.objectContaining({ id: "actual-with-historical-fork" }),
    ]);
  });

  it("allows only the exact current revision in one unforked current commitment during review overdue", async () => {
    const actual = {
      id: "actual-review-current",
      revision: 1,
      target: { kind: "work_item" as const, workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 600,
      actualCost: 0,
      recordedAt: CREATED_AT,
    };
    const current = reviewOverdueWorkspace();
    commitWorkItemForDate(current, "2026-07-11");
    const allowed = await executeCommand(
      current,
      { type: "record_actual", actual },
      context(current.revision, { commandId: "record-review-current" }),
    );
    expect(allowed.ok).toBe(true);

    const stale = reviewOverdueWorkspace();
    commitWorkItemForDate(stale, "2026-07-11", 0);
    const staleResult = await executeCommand(
      stale,
      { type: "record_actual", actual: { ...actual, id: "actual-stale" } },
      context(stale.revision, { commandId: "record-review-stale" }),
    );
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) throw new Error("Expected stale slot to be frozen");
    expect(staleResult.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });

    const forked = reviewOverdueWorkspace();
    commitWorkItemForDate(forked, "2026-07-11");
    forked.dailyCommitments.push({
      ...structuredClone(forked.dailyCommitments[0]),
      id: "commitment-fork",
      proposalHash: "proposal-fork",
    });
    const forkedResult = await executeCommand(
      forked,
      { type: "record_actual", actual: { ...actual, id: "actual-fork" } },
      context(forked.revision, { commandId: "record-review-fork" }),
    );
    expect(forkedResult.ok).toBe(false);
    if (forkedResult.ok) throw new Error("Expected forked Today to freeze");
    expect(forkedResult.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("fails closed when an Actual target identity is duplicated", async () => {
    const workspace = projectWorkspace();
    workspace.workItems.push(structuredClone(workspace.workItems[0]));

    const result = await executeCommand(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: "actual-duplicate-target",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 600,
          actualCost: 0,
          recordedAt: CREATED_AT,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected duplicate target rejection");
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "actual:actual-duplicate-target:target",
    });
    expect(result.workspace.actuals).toEqual([]);
  });
});

describe("completion-only result writes", () => {
  it("rejects a pre-completed Work Item at creation", async () => {
    const workspace = projectWorkspace();
    const result = await executeCommand(
      workspace,
      {
        type: "create_work_item",
        projectId: "project-1",
        workItem: {
          ...structuredClone(workspace.workItems[0]),
          id: "work-item-precompleted",
          outline: "2",
          resultStatus: "completed",
          outcomeNote: "Bypassed completion command",
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected pre-completion to be rejected");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-precompleted:completion_state",
      permittedNextCommand: "complete_work_item",
    });
    expect(result.workspace.workItems).toEqual(workspace.workItems);
  });

  it("rejects completion state injected through a Work Item update", async () => {
    const workspace = projectWorkspace();
    const result = await executeCommand(
      workspace,
      {
        type: "update_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        patch: {
          resultStatus: "completed",
          outcomeNote: "Bypassed completion command",
          percentComplete: 100,
        },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected injected completion to reject");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:completion_state",
      permittedNextCommand: "complete_work_item",
    });
    expect(result.workspace.workItems[0].resultStatus).toBeUndefined();
  });

  it("keeps an evidence-required milestone concrete once created", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const result = await executeCommand(
      workspace,
      {
        type: "update_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        patch: { kind: "task", evidenceRequired: false },
      },
      context(workspace.revision),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected evidence requirement to stick");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:evidence_requirement",
    });
    expect(result.workspace.workItems[0]).toMatchObject({
      kind: "milestone",
      evidenceRequired: true,
    });
  });

  it("does not clear a concrete requirement with an explicit undefined patch", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    const result = await executeCommand(
      workspace,
      {
        type: "update_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
        patch: { evidenceRequired: undefined },
      },
      context(workspace.revision, { commandId: "undefined-requirement" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected undefined requirement rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:update_work_item",
      permittedNextCommand: "update_work_item",
    });
    expect(result.workspace.workItems[0]).toMatchObject({
      kind: "milestone",
      evidenceRequired: true,
    });
  });

  it.each([
    ["evidenceRequired", { evidenceRequired: undefined }],
    ["kind", { kind: undefined }],
  ] as const)(
    "fails closed when the public handler receives undefined %s",
    async (_field, patch) => {
      const workspace = projectWorkspace({
        kind: "milestone",
        evidenceRequired: true,
      });
      const before = structuredClone(workspace);
      const result = await applyCommandHandler(
        workspace,
        {
          type: "update_work_item",
          projectId: "project-1",
          workItemId: "work-item-1",
          patch,
        },
        context(workspace.revision, { commandId: `undefined-${_field}` }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected undefined marker rejection");
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: "work_item:work-item-1:evidence_requirement",
        permittedNextCommand: "attach_evidence",
      });
      expect(workspace).toEqual(before);
    },
  );

  it("does not delete a concrete evidence requirement with no history", async () => {
    const workspace = projectWorkspace({
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.planVersions = [];
    delete workspace.projects[0].activePlanVersionId;
    const before = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "remove_work_item",
        projectId: "project-1",
        workItemId: "work-item-1",
      },
      context(workspace.revision, { commandId: "remove-requirement" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected evidence requirement deletion to reject");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "work_item:work-item-1:evidence_requirement",
      permittedNextCommand: "attach_evidence",
    });
    expect(result.workspace).toEqual(before);
  });
});

describe("duplicate command-target identities", () => {
  it("fails Action completion closed independent of duplicate record order", async () => {
    const source = actionWorkspace();
    const openAction = structuredClone(source.actions[0]);
    const completedAction = {
      ...structuredClone(openAction),
      status: "completed" as const,
      resultStatus: "completed" as const,
      outcomeNote: "An imported duplicate already completed this identity.",
    };

    for (const [index, actions] of [
      [openAction, completedAction],
      [completedAction, openAction],
    ].entries()) {
      const workspace = actionWorkspace();
      workspace.actions = structuredClone(actions);
      const before = structuredClone(workspace);
      const result = await applyCommandHandler(
        workspace,
        {
          type: "complete_action",
          actionId: "action-1",
          actualSeconds: 300,
          resultStatus: "completed",
          outcomeNote: "This must not select either duplicate.",
        },
        context(workspace.revision, {
          commandId: `complete-duplicate-action-${index}`,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected duplicate Action rejection");
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:Action:action-1",
        permittedNextCommand: "resolve_sync_conflict",
      });
      expect(workspace).toEqual(before);
    }
  });

  it.each([
    "update_work_item",
    "complete_work_item",
    "remove_work_item",
  ] as const)(
    "fails %s closed independent of duplicate Work Item order",
    async (commandType) => {
      const ordinary = structuredClone(projectWorkspace().workItems[0]);
      const requirement = {
        ...structuredClone(ordinary),
        kind: "milestone" as const,
        evidenceRequired: true,
        title: "Imported concrete evidence requirement",
      };

      for (const [index, workItems] of [
        [ordinary, requirement],
        [requirement, ordinary],
      ].entries()) {
        const workspace = projectWorkspace();
        workspace.workItems = structuredClone(workItems);
        workspace.actuals.push({
          id: `actual-before-duplicate-${commandType}-${index}`,
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: CREATED_AT,
        });
        if (commandType === "remove_work_item") {
          workspace.planVersions = [];
          delete workspace.projects[0].activePlanVersionId;
          workspace.actuals = [];
        }
        const before = structuredClone(workspace);
        const command: V2Command =
          commandType === "update_work_item"
            ? {
                type: commandType,
                projectId: "project-1",
                workItemId: "work-item-1",
                patch: { evidenceRequired: false },
              }
            : commandType === "complete_work_item"
              ? {
                  type: commandType,
                  projectId: "project-1",
                  workItemId: "work-item-1",
                  resultStatus: "completed",
                  outcomeNote: "This must not select either duplicate.",
                }
              : {
                  type: commandType,
                  projectId: "project-1",
                  workItemId: "work-item-1",
                };
        const result = await applyCommandHandler(
          workspace,
          command,
          context(workspace.revision, {
            commandId: `${commandType}-duplicate-${index}`,
          }),
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected duplicate Work Item rejection");
        expect(result.rejection).toMatchObject({
          code: "SYNC_CONFLICT",
          gate: "entity_identity:ProjectWorkItem:work-item-1",
          permittedNextCommand: "resolve_sync_conflict",
        });
        expect(workspace).toEqual(before);
      }
    },
  );

  it("fails validation request closed independent of duplicate Project order", async () => {
    const original = structuredClone(projectWorkspace().projects[0]);
    const duplicate = {
      ...structuredClone(original),
      name: "Imported duplicate Project identity",
    };

    for (const [index, projects] of [
      [original, duplicate],
      [duplicate, original],
    ].entries()) {
      const workspace = projectWorkspace();
      workspace.projects = structuredClone(projects);
      const before = structuredClone(workspace);
      const result = await applyCommandHandler(
        workspace,
        { type: "request_validation", projectId: "project-1" },
        context(workspace.revision, {
          commandId: `request-validation-duplicate-${index}`,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected duplicate Project rejection");
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:ProjectV2:project-1",
        permittedNextCommand: "resolve_sync_conflict",
      });
      expect(workspace).toEqual(before);
    }
  });
});

describe("attaching project Evidence", () => {
  it("attaches exact Work Item Evidence while the Project is validating", async () => {
    const workspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
    });
    const evidence = {
      id: "evidence-1",
      kind: "metric" as const,
      summary: "Five users completed the validation path.",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 0.9,
      tags: ["validation"],
    };

    const result = await executeCommand(
      workspace,
      { type: "attach_evidence", evidence },
      context(workspace.revision, { commandId: "attach-evidence-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected Evidence attachment to apply");
    expect(result.workspace.evidence).toEqual([evidence]);
    expect(workspace.evidence).toEqual([]);
  });

  it("rejects empty, out-of-range, future, or malformed Evidence atomically", async () => {
    const base = {
      id: "evidence-invalid",
      kind: "metric" as const,
      summary: "Observed result",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 0.9,
      tags: ["validation"],
    };
    const cases = [
      { evidence: { ...base, id: "   " }, gate: "evidence:   :details" },
      {
        evidence: { ...base, summary: "   " },
        gate: "evidence:evidence-invalid:details",
      },
      {
        evidence: { ...base, confidence: 1.1 },
        gate: "evidence:evidence-invalid:confidence",
      },
      {
        evidence: { ...base, createdAt: "2026-07-11T09:00:00.001Z" },
        gate: "evidence:evidence-invalid:created_at",
      },
      {
        evidence: { ...base, createdAt: "not-a-date" },
        gate: "evidence:evidence-invalid:created_at",
      },
      {
        evidence: { ...base, tags: ["validation", "   "] },
        gate: "evidence:evidence-invalid:tags",
      },
    ];

    for (const [index, sample] of cases.entries()) {
      const workspace = projectWorkspace({
        stage: "validating",
        kind: "milestone",
        evidenceRequired: true,
      });
      const result = await executeCommand(
        workspace,
        { type: "attach_evidence", evidence: sample.evidence },
        context(workspace.revision, { commandId: `attach-invalid-${index}` }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected malformed Evidence to reject");
      expect(result.rejection).toMatchObject({
        code: "INVALID_COMMAND",
        gate: sample.gate,
      });
      expect(result.workspace.evidence).toEqual([]);
    }
  });

  it("does not let malformed imported Evidence satisfy a requirement", () => {
    const workspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.evidence.push({
      id: "evidence-malformed",
      kind: "metric",
      summary: "   ",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 2,
      tags: ["   "],
    });

    expect(
      requirementStatus(workspace, "project-1", "work-item-1", CREATED_AT),
    ).toEqual({ satisfied: false, code: "EVIDENCE_REQUIRED" });
  });
});

describe("Evidence lifecycle transitions", () => {
  it("rejects validation satisfaction at a non-canonical authoritative time", async () => {
    const workspace = projectWorkspace({ stage: "validating" });

    const result = await executeCommand(
      workspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(workspace.revision, {
        commandId: "satisfy-validation-noncanonical",
        now: "2026-07-11T09:00:00Z",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid validation time");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command:satisfy-validation-noncanonical:time",
    });
    expect(result.workspace.projects[0].stage).toBe("validating");
  });

  it("moves an executing Project into validation without changing its Plan", async () => {
    const workspace = projectWorkspace();
    const planBefore = structuredClone(workspace.planVersions);

    const result = await executeCommand(
      workspace,
      { type: "request_validation", projectId: "project-1" },
      context(workspace.revision, { commandId: "request-validation-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected validation request");
    expect(result.workspace.projects[0]).toMatchObject({
      stage: "validating",
      updatedAt: CREATED_AT,
    });
    expect(result.workspace.planVersions).toEqual(planBefore);
  });

  it("blocks validation satisfaction until every concrete requirement is satisfied", async () => {
    const workspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
    });

    const result = await executeCommand(
      workspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(workspace.revision, { commandId: "satisfy-validation-1" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected validation evidence gate");
    expect(result.rejection).toMatchObject({
      code: "EVIDENCE_REQUIRED",
      gate: "project:project-1:requirement:work-item-1",
      permittedNextCommand: "attach_evidence",
    });
    expect(result.workspace.projects[0].stage).toBe("validating");
  });

  it("uses closure_requested when validation starts from planning", async () => {
    const workspace = projectWorkspace({ stage: "planning" });
    delete workspace.projects[0].activePlanVersionId;
    workspace.planVersions = [];

    const result = await executeCommand(
      workspace,
      { type: "request_validation", projectId: "project-1" },
      context(workspace.revision, { commandId: "request-planning-close" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected planning closure request");
    expect(result.workspace.projects[0].stage).toBe("validating");
  });

  it("moves validation to closing with exact current Evidence", async () => {
    const workspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
    });
    workspace.evidence.push({
      id: "evidence-validation",
      kind: "metric",
      summary: "Observed validation result",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 1,
      tags: [],
    });

    const result = await executeCommand(
      workspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(workspace.revision, { commandId: "satisfy-with-evidence" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected validation satisfaction");
    expect(result.workspace.projects[0].stage).toBe("closing");
  });

  it("accepts an exact active Exception but not a resolved one", async () => {
    const activeWorkspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
    });
    const active = exception({ requirementId: "work-item-1" });
    activeWorkspace.exceptions.push(active);
    const activeResult = await executeCommand(
      activeWorkspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(activeWorkspace.revision, {
        commandId: "satisfy-with-exception",
      }),
    );
    expect(activeResult.ok).toBe(true);

    const resolvedWorkspace = structuredClone(activeWorkspace);
    resolvedWorkspace.exceptions[0] = {
      ...active,
      resolvedAt: CREATED_AT,
      history: [
        ...active.history,
        {
          action: "resolved",
          actorId: "human-1",
          at: CREATED_AT,
          note: "Reopened",
        },
      ],
    };
    const resolvedResult = await executeCommand(
      resolvedWorkspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(resolvedWorkspace.revision, {
        commandId: "satisfy-resolved-exception",
      }),
    );
    expect(resolvedResult.ok).toBe(false);
    if (resolvedResult.ok) throw new Error("Expected reopened evidence gate");
    expect(resolvedResult.rejection.code).toBe("EVIDENCE_REQUIRED");
  });

  it("never lets an evidence Exception bypass an overdue Review hold", async () => {
    const workspace = projectWorkspace({
      stage: "validating",
      kind: "milestone",
      evidenceRequired: true,
      holds: [
        {
          type: "review_overdue",
          sourceId: "review-1",
          affectedRecordIds: ["project-1", "work-item-1"],
          createdAt: CREATED_AT,
        },
      ],
    });
    workspace.reviews.push({
      id: "review-1",
      kind: "event",
      triggerKey: "validation-review-overdue",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["project-1", "work-item-1"],
      dueAt: CREATED_AT,
      createdAt: CREATED_AT,
    });
    workspace.exceptions.push(exception({ requirementId: "work-item-1" }));

    const result = await executeCommand(
      workspace,
      { type: "satisfy_validation", projectId: "project-1" },
      context(workspace.revision, { commandId: "satisfy-held-review" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected Review hold to remain binding");
    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
      permittedNextCommand: "complete_review",
    });
    expect(result.workspace.projects[0].stage).toBe("validating");
  });
});

describe("explicit completion semantics", () => {
  it("does not let percent complete or zero remaining Actual unlock dependencies", async () => {
    const workspace = projectWorkspace();
    workspace.workItems[0].percentComplete = 100;
    workspace.workItems.push({
      ...structuredClone(workspace.workItems[0]),
      id: "work-item-2",
      outline: "2",
      title: "Dependent delivery",
      percentComplete: 0,
    });
    workspace.dependencies.push({
      id: "dependency-1",
      projectId: "project-1",
      fromId: "work-item-1",
      toId: "work-item-2",
      type: "FS",
      lagSeconds: 0,
      revision: 1,
    });
    workspace.capacityProfile = {
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 6, startMinute: 480, finishMinute: 720 },
      ],
      dailyBudgets: [
        {
          weekday: 6,
          deepSeconds: 14_400,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
      unavailableBlocks: [],
      updatedAt: CREATED_AT,
      updatedBy: "human-1",
    };
    workspace.actuals.push({
      id: "actual-zero-remaining",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: CREATED_AT,
    });

    const today = await generateTodayProposal(
      workspace,
      "2026-07-11",
      CREATED_AT,
    );
    const scheduledIds = today.slots.flatMap(({ target }) =>
      target.kind === "work_item" ? [target.workItemId] : [],
    );

    expect(scheduledIds).toContain("work-item-1");
    expect(scheduledIds).not.toContain("work-item-2");
    expect(today.later).toContainEqual({
      targetId: "work-item-2",
      reason: "DEPENDENCY_BLOCKED",
    });
  });
});

describe("evidence gate vocabulary", () => {
  it("contains no generic gate-clearing command or UI contract", () => {
    const v2Root = fileURLToPath(new URL("../", import.meta.url));
    const forbidden = new RegExp(["clear", "[_ -]?", "gate"].join(""), "i");
    const matches = sourceFiles(v2Root).filter((path) =>
      forbidden.test(readFileSync(path, "utf8")),
    );

    expect(matches).toEqual([]);
  });
});
