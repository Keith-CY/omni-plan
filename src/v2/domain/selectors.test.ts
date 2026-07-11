import { describe, expect, it } from "vitest";

import {
  buildCapacityProfile,
  buildDirectionBrief,
  buildInboxItem,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "./commands";
import type {
  Action,
  CapacityProfile,
  DailyCommitment,
  ProjectWorkItem,
  ReplanProposal,
  ReviewRecord,
  SyncConflictRecord,
} from "./types";
import type { TodayProposal } from "./today";
import {
  selectActiveHolds,
  selectCommandAvailability,
  selectLockedStages,
  selectProjectLifecycle,
  selectRecommendedNextAction,
  selectReviewSummary,
  selectTodayStatus,
  type RecommendedNextAction,
} from "./selectors";

const NOW = "2026-07-11T09:00:00.000Z";

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    commandId: "command-1",
    expectedRevision: 0,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "ui-source",
      verified: true,
      capabilities: ["human_decision", "capture_inbox"],
    },
    now: NOW,
    ...overrides,
  };
}

function selectorCapacity(): CapacityProfile {
  return buildCapacityProfile({
    timeZone: "UTC",
    weeklyWindows: [{ weekday: 6, startMinute: 540, finishMinute: 720 }],
    dailyBudgets: [
      {
        weekday: 6,
        deepSeconds: 7_200,
        mediumSeconds: 7_200,
        shallowSeconds: 7_200,
      },
    ],
    updatedAt: "2026-07-10T09:00:00.000Z",
    updatedBy: "human-1",
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }
  return value;
}

describe("selectProjectLifecycle", () => {
  it("exposes the six user stages and exact unlock actions", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      audienceAndProblem: "",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [],
      noGoOrKill: "",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [
        buildProjectV2({
          id: "project-1",
          stage: "direction",
          activeDirectionBriefId: brief.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [brief],
    });

    const selection = selectProjectLifecycle(workspace, "project-1");

    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error("Expected a lifecycle selection");
    expect(selection.steps.map(({ stage, label, status }) => ({
      stage,
      label,
      status,
    }))).toEqual([
      { stage: "direction", label: "Direction", status: "current" },
      { stage: "bet", label: "Bet", status: "locked" },
      { stage: "plan", label: "Plan", status: "locked" },
      { stage: "execute", label: "Execute", status: "locked" },
      { stage: "evidence", label: "Evidence", status: "locked" },
      { stage: "close", label: "Close", status: "locked" },
    ]);
    expect(selection.steps[1]).toMatchObject({
      reason: "Complete the Direction brief before placing a Bet.",
      permittedNextCommand: "update_direction",
    });
    expect(selection.steps[5]).toMatchObject({
      reason: "Satisfy every validation requirement before Close.",
      permittedNextCommand: "satisfy_validation",
    });
  });

  it("fails closed for missing or duplicate Project identities", () => {
    const project = buildProjectV2({
      id: "project-1",
      activeDirectionBriefId: "brief-1",
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(
      selectProjectLifecycle(
        buildWorkspaceV2("workspace-1"),
        "project-missing",
      ),
    ).toEqual({
      ok: false,
      reason: "Project project-missing does not exist.",
      permittedNextCommand: "confirm_project_triage",
    });
    expect(
      selectProjectLifecycle(
        buildWorkspaceV2("workspace-1", {
          projects: [project, structuredClone(project)],
        }),
        project.id,
      ),
    ).toEqual({
      ok: false,
      reason: "Project project-1 has duplicate records for one identity.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("links completed stages to their immutable domain history", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: NOW,
      appetiteEnd: "2026-07-12T09:00:00.000Z",
      actorId: "human-1",
      approvedAt: NOW,
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "planning",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const selected = selectProjectLifecycle(
      buildWorkspaceV2("workspace-1", {
        projects: [project],
        directionBriefs: [brief],
        bets: [bet],
      }),
      project.id,
    );

    if (!selected.ok) throw new Error("Expected lifecycle history");
    expect(selected.steps[0]).toMatchObject({
      status: "completed",
      historyRecordIds: [brief.id],
    });
    expect(selected.steps[1]).toMatchObject({
      status: "completed",
      historyRecordIds: [bet.id],
    });
  });
});

describe("weekly Review selector hardening", () => {
  it("fails Review selectors closed when an affected ID contains surrounding whitespace", () => {
    const projectId = " project-1 ";
    const brief = buildDirectionBrief({
      id: "brief-whitespace-project",
      projectId,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const review: ReviewRecord = {
      id: "review-whitespace-affected-id",
      kind: "event",
      triggerKey: "hard_gate:whitespace-affected-id",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [projectId],
      affectedRecordIds: [],
      dueAt: "2026-07-12T00:00:00.000Z",
      createdAt: "2026-07-10T00:00:00.000Z",
    };
    const workspace = buildWorkspaceV2("workspace-whitespace-affected-id", {
      projects: [
        buildProjectV2({
          id: projectId,
          activeDirectionBriefId: brief.id,
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        }),
      ],
      directionBriefs: [brief],
      reviews: [review],
    });

    expect(selectReviewSummary(workspace, NOW)).toEqual({
      ok: false,
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(
      selectRecommendedNextAction(workspace, undefined, { now: NOW }),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: review.id,
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Review selectors closed for an invalid weekly cadence time zone", () => {
    const review: ReviewRecord = {
      id: "review-invalid-weekly-time-zone",
      kind: "weekly",
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T18:00:00.000Z",
      cadenceTimeZone: "Mars/Olympus",
      createdAt: "2026-07-06T00:00:00.000Z",
    };
    const workspace = buildWorkspaceV2("workspace-invalid-weekly-time-zone", {
      reviews: [review],
    });

    expect(selectReviewSummary(workspace, NOW)).toEqual({
      ok: false,
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(
      selectRecommendedNextAction(workspace, undefined, { now: NOW }),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: review.id,
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Review selectors closed for overlapping weekly coverage", () => {
    const catchup: ReviewRecord = {
      id: "review-weekly-catchup",
      kind: "weekly",
      triggerKey: "weekly_catchup:2026-06-29:2026-07-06",
      triggerType: "weekly",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T18:00:00.000Z",
      cadenceTimeZone: "UTC",
      createdAt: "2026-07-12T18:00:00.000Z",
    };
    const weekly: ReviewRecord = {
      id: "review-weekly-single",
      kind: "weekly",
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T18:00:00.000Z",
      cadenceTimeZone: "UTC",
      createdAt: "2026-07-12T18:00:00.000Z",
    };
    const workspace = buildWorkspaceV2("workspace-overlapping-weekly", {
      reviews: [catchup, weekly],
    });
    const evaluatedAt = "2026-07-13T00:00:00.000Z";
    const reason =
      "Weekly Reviews review-weekly-catchup and review-weekly-single have overlapping coverage at 2026-07-06.";

    expect(selectReviewSummary(workspace, evaluatedAt)).toEqual({
      ok: false,
      reason,
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(
      selectRecommendedNextAction(workspace, undefined, { now: evaluatedAt }),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: catchup.id,
      reason,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });
});

describe("selectLockedStages", () => {
  it("returns future stage locks and fails every stage closed for an unknown Project", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: NOW,
      appetiteEnd: "2026-07-12T09:00:00.000Z",
      actorId: "human-1",
      approvedAt: NOW,
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "planning",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [project],
      directionBriefs: [brief],
      bets: [bet],
    });

    expect(selectLockedStages(workspace, project.id).map(({ stage }) => stage))
      .toEqual(["execute", "evidence", "close"]);

    const missing = selectLockedStages(workspace, "missing");
    expect(missing.map(({ stage }) => stage)).toEqual([
      "direction",
      "bet",
      "plan",
      "execute",
      "evidence",
      "close",
    ]);
    expect(missing[0]).toMatchObject({
      reason: "Project missing does not exist.",
      permittedNextCommand: "confirm_project_triage",
    });
  });

  it("locks the current execution stage when Re-bet is required", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: NOW,
      appetiteEnd: "2026-07-12T09:00:00.000Z",
      actorId: "human-1",
      approvedAt: NOW,
      invalidatedAt: NOW,
      invalidationReason: "Material Direction change",
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "executing",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      holds: [
        {
          type: "rebet_required",
          sourceId: "bet-1",
          affectedRecordIds: ["project-1", "bet-1"],
          createdAt: NOW,
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(
      selectLockedStages(
        buildWorkspaceV2("workspace-1", {
          projects: [project],
          directionBriefs: [brief],
          bets: [bet],
        }),
        project.id,
      )[0],
    ).toEqual({
      stage: "execute",
      reason:
        "A new human Bet is required before planning or execution can continue.",
      permittedNextCommand: "place_bet",
    });
  });
});

describe("selectActiveHolds", () => {
  it("returns every hold with its narrow effect in deterministic policy order", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: "2026-07-11T08:00:00.000Z",
      updatedAt: "2026-07-11T08:00:00.000Z",
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: "2026-07-11T08:00:00.000Z",
      appetiteEnd: "2026-07-12T08:00:00.000Z",
      actorId: "human-1",
      approvedAt: "2026-07-11T08:00:00.000Z",
      invalidatedAt: "2026-07-11T08:01:00.000Z",
      invalidationReason: "Material Direction change",
    };
    const workItem: ProjectWorkItem = {
      id: "work-item-1",
      projectId: "project-1",
      kind: "task",
      title: "Affected work",
      outline: "Affected by conflict",
      durationSeconds: 600,
      estimate: { mostLikelySeconds: 600 },
      assignmentIds: [],
      percentComplete: 0,
      revision: 1,
      betScopeId: "scope-1",
    };
    const review: ReviewRecord = {
      id: "review-1",
      kind: "event",
      triggerKey: "hard_gate:review-1",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: [workItem.id],
      dueAt: "2026-07-11T08:02:00.000Z",
      createdAt: "2026-07-11T08:00:00.000Z",
    };
    const conflict: SyncConflictRecord = {
      id: "conflict-1",
      recordType: "bet",
      recordId: workItem.id,
      projectId: "project-1",
      commonAncestorHash: "ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: "2026-07-11T08:00:00.000Z",
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "executing",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      holds: [
        {
          type: "sync_conflict",
          sourceId: "conflict-1",
          affectedRecordIds: ["work-item-1"],
          createdAt: "2026-07-11T08:03:00.000Z",
        },
        {
          type: "review_overdue",
          sourceId: "review-1",
          affectedRecordIds: ["project-1"],
          createdAt: "2026-07-11T08:02:00.000Z",
        },
        {
          type: "rebet_required",
          sourceId: "bet-1",
          affectedRecordIds: ["project-1", "bet-1"],
          createdAt: "2026-07-11T08:01:00.000Z",
        },
        {
          type: "migration_review",
          sourceId: "migration-1",
          affectedRecordIds: ["project-1"],
          createdAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [project],
      directionBriefs: [brief],
      bets: [bet],
      workItems: [workItem],
      reviews: [review],
      syncConflicts: [conflict],
      migration: {
        sourceSchemaVersion: 1,
        sourceChecksum: "source-checksum",
        backupId: "migration-1",
        backupChecksum: "backup-checksum",
        migratedAt: "2026-07-11T08:00:00.000Z",
        entityCounts: {},
        deterministicIdMap: {},
      },
    });

    const selection = selectActiveHolds(workspace, project.id);

    expect(selection.ok).toBe(true);
    if (!selection.ok) throw new Error("Expected active holds");
    expect(selection.holds.map(({ type, permittedNextCommand }) => ({
      type,
      permittedNextCommand,
    }))).toEqual([
      { type: "migration_review", permittedNextCommand: "place_bet" },
      { type: "rebet_required", permittedNextCommand: "place_bet" },
      { type: "review_overdue", permittedNextCommand: "complete_review" },
      { type: "sync_conflict", permittedNextCommand: "resolve_sync_conflict" },
    ]);
    expect(selection.holds[1]).toMatchObject({
      sourceId: "bet-1",
      affectedRecordIds: ["bet-1", "project-1"],
      reason:
        "A new human Bet is required before planning or execution can continue.",
    });
  });
});

describe("selectCommandAvailability", () => {
  it.each([
    {
      name: "an available command",
      command: { type: "capture_inbox", id: "inbox-1", text: "Capture" },
      context: context(),
    },
    {
      name: "a domain-rejected command",
      command: {
        type: "confirm_action_triage",
        inboxItemId: "missing",
        action: {
          id: "action-1",
          title: "Missing Inbox",
          eligibility: {
            singleSession: true,
            estimateSeconds: 600,
            dependencyIds: [],
            requiresMilestoneEvidence: false,
            outcomeCount: 1,
            solutionKnown: true,
          },
          attention: "shallow",
        },
      },
      context: context({ commandId: "command-2" }),
    },
  ] as const satisfies readonly {
    name: string;
    command: V2Command;
    context: CommandContext;
  }[])("matches executeCommand for $name without mutating inputs", async ({
    command,
    context: commandContext,
  }) => {
    const workspace = buildWorkspaceV2("workspace-1");
    const before = structuredClone(workspace);
    const expected = await executeCommand(workspace, command, commandContext);

    const availability = await selectCommandAvailability(
      workspace,
      command,
      commandContext,
    );

    expect(workspace).toEqual(before);
    if (expected.ok) {
      expect(availability).toEqual({
        available: true,
        reason: "Command is available.",
        permittedNextCommand: command.type,
      });
    } else {
      expect(availability).toMatchObject({
        available: false,
        code: expected.rejection.code,
        reason: expected.rejection.reason,
        permittedNextCommand: expected.rejection.permittedNextCommand,
      });
    }
  });
});

describe("selectTodayStatus", () => {
  it("returns an exact setup action when capacity is not configured", async () => {
    await expect(
      selectTodayStatus(
        buildWorkspaceV2("workspace-1"),
        "2026-07-11",
        NOW,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "Configure capacity before generating Today.",
      permittedNextCommand: "configure_capacity",
    });
  });

  it("derives a pure Today proposal and exposes Commit Today", async () => {
    const capacityProfile = selectorCapacity();
    const action: Action = {
      id: "action-1",
      inboxItemId: "inbox-1",
      title: "Do the next thing",
      revision: 1,
      status: "open",
      eligibility: {
        singleSession: true,
        estimateSeconds: 600,
        dependencyIds: [],
        requiresMilestoneEvidence: false,
        outcomeCount: 1,
        solutionKnown: true,
      },
      attention: "shallow",
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T08:00:00.000Z",
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      capacityProfile,
      actions: [action],
    });
    const before = structuredClone(workspace);

    const selection = await selectTodayStatus(
      workspace,
      "2026-07-11",
      NOW,
    );

    expect(selection.status).toBe("proposed");
    if (selection.status !== "proposed") {
      throw new Error("Expected a Today proposal");
    }
    expect(selection.proposal.slots.map(({ target }) => target)).toEqual([
      { kind: "action", actionId: action.id },
    ]);
    expect(selection).toMatchObject({
      reason: "Review the proposed agenda before committing Today.",
      permittedNextCommand: "commit_today",
    });
    expect(workspace).toEqual(before);
  });

  it("preserves the committed agenda while exposing an open Replan decision", async () => {
    const capacityProfile = selectorCapacity();
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "proposal-1",
      capacitySnapshot: structuredClone(capacityProfile),
      slots: [
        {
          id: "slot-1",
          target: { kind: "action", actionId: "action-1" },
          targetRevision: 1,
          start: "2026-07-11T09:00:00.000Z",
          finish: "2026-07-11T09:10:00.000Z",
          attention: "shallow",
        },
      ],
      actorId: "human-1",
      committedAt: "2026-07-11T08:30:00.000Z",
    };
    const replan: ReplanProposal = {
      id: "replan-1",
      localDate: commitment.localDate,
      baseCommitmentId: commitment.id,
      baseRevision: 0,
      reasonCodes: ["calendar_change"],
      proposedSlots: [],
      proposalHash: "replan-hash",
      createdAt: "2026-07-11T08:45:00.000Z",
      createdBy: "human-1",
      status: "open",
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      capacityProfile,
      dailyCommitments: [commitment],
      replanProposals: [replan],
    });

    await expect(
      selectTodayStatus(workspace, commitment.localDate, NOW),
    ).resolves.toEqual({
      status: "replan_pending",
      commitment,
      proposal: replan,
      reason:
        "Keep the committed agenda until a human accepts the pending Replan.",
      permittedNextCommand: "accept_replan",
    });
  });

  it("fails closed when commitment history has multiple current leaves", async () => {
    const capacityProfile = selectorCapacity();
    const commitment = (id: string): DailyCommitment => ({
      id,
      localDate: "2026-07-11",
      version: 1,
      proposalHash: id,
      capacitySnapshot: structuredClone(capacityProfile),
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-11T08:30:00.000Z",
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      capacityProfile,
      dailyCommitments: [commitment("commitment-b"), commitment("commitment-a")],
    });

    await expect(
      selectTodayStatus(workspace, "2026-07-11", NOW),
    ).resolves.toEqual({
      status: "blocked",
      reason:
        "Today commitment history for 2026-07-11 has multiple current leaves.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("returns a stable blocked result instead of throwing for invalid selector time", async () => {
    await expect(
      selectTodayStatus(
        buildWorkspaceV2("workspace-1", {
          capacityProfile: selectorCapacity(),
        }),
        "2026-07-11",
        "not-a-date",
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason: "Today status requires a canonical evaluation time and local date.",
      permittedNextCommand: "retry_with_valid_time",
    });
  });

  it("fails closed instead of selecting one of multiple open Replans", async () => {
    const capacityProfile = selectorCapacity();
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "commitment-1",
      capacitySnapshot: capacityProfile,
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-11T08:00:00.000Z",
    };
    const replan = (id: string): ReplanProposal => ({
      id,
      localDate: commitment.localDate,
      baseCommitmentId: commitment.id,
      baseRevision: 0,
      reasonCodes: ["calendar_change"],
      proposedSlots: [],
      proposalHash: id,
      createdAt: "2026-07-11T08:30:00.000Z",
      createdBy: "human-1",
      status: "open",
    });

    await expect(
      selectTodayStatus(
        buildWorkspaceV2("workspace-1", {
          capacityProfile,
          dailyCommitments: [commitment],
          replanProposals: [replan("replan-b"), replan("replan-a")],
        }),
        commitment.localDate,
        NOW,
      ),
    ).resolves.toEqual({
      status: "blocked",
      reason:
        "Today has multiple open Replans for current commitment commitment-1.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });
});

describe("selectReviewSummary", () => {
  it("summarizes pending, open, overdue, and completed Reviews at the explicit time", () => {
    const open: ReviewRecord = {
      id: "review-open",
      kind: "event",
      triggerKey: "hard_gate:[\"project-1\"]",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: NOW,
      createdAt: "2026-07-11T08:00:00.000Z",
    };
    const completed: ReviewRecord = {
      ...open,
      id: "review-completed",
      triggerKey: "sync_conflict:conflict-1",
      triggerType: "sync_conflict",
      status: "completed",
      dueAt: "2026-07-11T08:30:00.000Z",
      conclusion: {
        summary: "Resolved",
        decisionCodes: ["retain_local"],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: "2026-07-11T08:45:00.000Z",
      },
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      reviews: [completed, open],
    });
    const before = structuredClone(workspace);

    const summary = selectReviewSummary(workspace, NOW);

    expect(summary).toMatchObject({
      ok: true,
      reason: "Complete the oldest overdue Review.",
      permittedNextCommand: "complete_review",
    });
    if (!summary.ok) throw new Error("Expected a Review summary");
    expect(summary.pending).toEqual([]);
    expect(summary.open.map(({ id }) => id)).toEqual([open.id]);
    expect(summary.overdue.map(({ id }) => id)).toEqual([open.id]);
    expect(summary.completed.map(({ id }) => id)).toEqual([completed.id]);
    expect(workspace).toEqual(before);
  });

  it("fails closed for duplicate Review identities or trigger keys", () => {
    const review: ReviewRecord = {
      id: "review-1",
      kind: "event",
      triggerKey: "sync_conflict:conflict-1",
      triggerType: "sync_conflict",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: NOW,
      createdAt: NOW,
    };

    expect(
      selectReviewSummary(
        buildWorkspaceV2("workspace-1", {
          reviews: [review, { ...review, id: "review-2" }],
        }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason:
        "Review trigger sync_conflict:conflict-1 has duplicate stored occurrences.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });
});

describe("selectRecommendedNextAction", () => {
  it("uses explicit recovery input and deterministically selects its oldest stable identity", () => {
    const workspace = buildWorkspaceV2("workspace-1");

    expect(
      selectRecommendedNextAction(workspace, undefined, {
        now: NOW,
        recoveryErrors: [
          {
            id: "recovery-b",
            reason: "Second stable identity",
            occurredAt: "2026-07-11T08:00:00.000Z",
            permittedNextCommand: "retry_recovery",
          },
          {
            id: "recovery-a",
            reason: "First stable identity",
            occurredAt: "2026-07-11T08:00:00.000Z",
            permittedNextCommand: "restore_backup",
          },
        ],
      }),
    ).toEqual({
      kind: "recovery_error",
      recordId: "recovery-a",
      triggeredAt: "2026-07-11T08:00:00.000Z",
      reason: "First stable identity",
      permittedNextCommand: "restore_backup",
    });
  });

  it("enforces the single eight-level priority chain", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      appetiteSeconds: 86_400,
      firstScope: [
        { id: "scope-1", title: "Scope", description: "Bounded scope" },
      ],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const project = buildProjectV2({
      id: "project-1",
      stage: "validating",
      activeDirectionBriefId: brief.id,
      activeBetId: "bet-1",
      holds: [
        {
          type: "rebet_required",
          sourceId: "bet-1",
          affectedRecordIds: ["project-1", "bet-1"],
          createdAt: "2026-07-11T08:20:00.000Z",
        },
        {
          type: "migration_review",
          sourceId: "migration-1",
          affectedRecordIds: ["project-1"],
          createdAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T08:30:00.000Z",
    });
    const workItem: ProjectWorkItem = {
      id: "work-item-1",
      projectId: project.id,
      kind: "milestone",
      title: "Validate the outcome",
      outline: "Attach proof",
      durationSeconds: 600,
      estimate: { mostLikelySeconds: 600 },
      assignmentIds: [],
      percentComplete: 0,
      evidenceRequired: true,
      revision: 1,
      betScopeId: "scope-1",
    };
    const conflict: SyncConflictRecord = {
      id: "conflict-1",
      recordType: "bet",
      recordId: "bet-1",
      projectId: project.id,
      commonAncestorHash: "ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: "2026-07-11T08:10:00.000Z",
    };
    const review: ReviewRecord = {
      id: "review-1",
      kind: "event",
      triggerKey: "hard_gate:[\"project-1\",\"work-item-1\"]",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [project.id],
      affectedRecordIds: [workItem.id],
      dueAt: "2026-07-11T08:40:00.000Z",
      createdAt: "2026-07-11T08:35:00.000Z",
    };
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "proposal-1",
      capacitySnapshot: selectorCapacity(),
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-11T08:45:00.000Z",
    };
    const replan: ReplanProposal = {
      id: "replan-1",
      localDate: commitment.localDate,
      baseCommitmentId: commitment.id,
      baseRevision: 0,
      reasonCodes: ["calendar_change"],
      proposedSlots: [],
      proposalHash: "replan-1",
      createdAt: "2026-07-11T08:50:00.000Z",
      createdBy: "human-1",
      status: "open",
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      capacityProfile: selectorCapacity(),
      projects: [project],
      directionBriefs: [brief],
      bets: [
        {
          id: "bet-1",
          projectId: project.id,
          version: 1,
          briefId: brief.id,
          briefHash: "brief-hash",
          briefSnapshot: structuredClone(brief),
          committedScope: structuredClone(brief.firstScope),
          appetiteStart: "2026-07-10T00:00:00.000Z",
          appetiteEnd: "2026-07-12T00:00:00.000Z",
          actorId: "human-1",
          approvedAt: "2026-07-10T00:00:00.000Z",
        },
      ],
      workItems: [workItem],
      syncConflicts: [conflict],
      reviews: [review],
      dailyCommitments: [commitment],
      replanProposals: [replan],
      inboxItems: [
        buildInboxItem({
          id: "inbox-1",
          sourceId: "ui-source",
          actorId: "human-1",
          capturedAt: "2026-07-01T08:00:00.000Z",
        }),
      ],
      migration: {
        sourceSchemaVersion: 1,
        sourceChecksum: "source-checksum",
        backupId: "migration-1",
        backupChecksum: "backup-checksum",
        migratedAt: "2026-07-11T08:00:00.000Z",
        entityCounts: {},
        deterministicIdMap: {},
      },
    });
    const next = (
      source: typeof workspace,
      recoveryErrors: Array<{
        id: string;
        reason: string;
        occurredAt: string;
        permittedNextCommand: string;
      }> = [],
    ) => selectRecommendedNextAction(source, undefined, {
      now: NOW,
      recoveryErrors,
    });

    const selected: RecommendedNextAction[] = [];
    selected.push(next(workspace, [{
      id: "recovery-1",
      reason: "Restore the verified workspace.",
      occurredAt: "2026-07-11T07:00:00.000Z",
      permittedNextCommand: "restore_backup",
    }])!);

    const withoutMigration = structuredClone(workspace);
    selected.push(next(withoutMigration)!);
    withoutMigration.projects[0].holds = withoutMigration.projects[0].holds
      .filter(({ type }) => type !== "migration_review");
    selected.push(next(withoutMigration)!);

    withoutMigration.syncConflicts[0].resolvedAt = "2026-07-11T08:15:00.000Z";
    withoutMigration.syncConflicts[0].retainedVersion = "local";
    selected.push(next(withoutMigration)!);

    withoutMigration.projects[0].holds = [];
    selected.push(next(withoutMigration)!);

    withoutMigration.workItems[0] = {
      ...withoutMigration.workItems[0],
      evidenceRequired: false,
    };
    selected.push(next(withoutMigration)!);

    withoutMigration.reviews[0] = {
      ...withoutMigration.reviews[0],
      status: "completed",
      conclusion: {
        summary: "Reviewed",
        decisionCodes: [],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: "2026-07-11T08:55:00.000Z",
      },
    };
    selected.push(next(withoutMigration)!);

    withoutMigration.replanProposals[0].status = "accepted";
    selected.push(next(withoutMigration)!);

    expect(selected.map(({ kind, recordId }) => ({ kind, recordId }))).toEqual([
      { kind: "recovery_error", recordId: "recovery-1" },
      { kind: "migration_review", recordId: "migration-1" },
      { kind: "sync_conflict", recordId: "conflict-1" },
      { kind: "rebet_required", recordId: "bet-1" },
      { kind: "evidence_gate", recordId: "work-item-1" },
      { kind: "review_overdue", recordId: "review-1" },
      { kind: "today_decision", recordId: "replan-1" },
      { kind: "aging_inbox", recordId: "inbox-1" },
    ]);
    expect(selected.every(({ reason, permittedNextCommand }) =>
      reason.length > 0 && permittedNextCommand.length > 0)).toBe(true);
  });

  it("does not age Inbox from ambient time and applies the exact seven-day boundary", () => {
    const sixDaysOld = buildWorkspaceV2("workspace-1", {
      inboxItems: [
        buildInboxItem({
          id: "inbox-six-days",
          sourceId: "ui-source",
          actorId: "human-1",
          capturedAt: "2026-07-05T09:00:00.000Z",
        }),
      ],
    });

    expect(selectRecommendedNextAction(sixDaysOld)).toBeUndefined();
    expect(
      selectRecommendedNextAction(sixDaysOld, undefined, { now: NOW }),
    ).toBeUndefined();

    sixDaysOld.inboxItems[0].capturedAt = "2026-07-04T09:00:00.000Z";
    expect(
      selectRecommendedNextAction(sixDaysOld, undefined, { now: NOW }),
    ).toMatchObject({
      kind: "aging_inbox",
      recordId: "inbox-six-days",
      permittedNextCommand: "confirm_action_triage",
    });
  });

  it("scopes an explicit Today proposal to its affected Project", () => {
    const project = buildProjectV2({
      id: "project-1",
      activeDirectionBriefId: "brief-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const capacity = selectorCapacity();
    const todayProposal: TodayProposal = {
      localDate: "2026-07-11",
      workspaceRevision: 0,
      generatedAt: NOW,
      capacity,
      localCapacity: {
        localDate: "2026-07-11",
        timeZone: "UTC",
        weekday: 6,
        availableIntervals: [
          {
            start: "2026-07-11T09:00:00.000Z",
            finish: "2026-07-11T12:00:00.000Z",
          },
        ],
        budgets: {
          deepSeconds: 7_200,
          mediumSeconds: 7_200,
          shallowSeconds: 7_200,
        },
      },
      capacityUsage: {
        deepSeconds: 600,
        mediumSeconds: 0,
        shallowSeconds: 0,
      },
      slots: [
        {
          id: "slot-1",
          target: {
            kind: "work_item",
            projectId: project.id,
            workItemId: "work-item-1",
          },
          targetRevision: 1,
          start: "2026-07-11T09:00:00.000Z",
          finish: "2026-07-11T09:10:00.000Z",
          attention: "deep",
        },
      ],
      later: [],
      proposalHash: "today-proposal-1",
    };
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [project],
    });

    expect(
      selectRecommendedNextAction(workspace, project.id, { todayProposal }),
    ).toEqual({
      kind: "today_decision",
      recordId: todayProposal.proposalHash,
      projectId: project.id,
      triggeredAt: todayProposal.generatedAt,
      reason: "Review the uncommitted Today proposal.",
      permittedNextCommand: "commit_today",
    });
    expect(
      selectRecommendedNextAction(workspace, "project-missing", {
        todayProposal,
      })?.kind,
    ).toBe("recovery_error");
  });

  it("fails closed for duplicate Review triggers instead of choosing one occurrence", () => {
    const review = (id: string): ReviewRecord => ({
      id,
      kind: "event",
      triggerKey: "sync_conflict:conflict-1",
      triggerType: "sync_conflict",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: NOW,
      createdAt: "2026-07-11T08:00:00.000Z",
    });

    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", {
          reviews: [review("review-b"), review("review-a")],
        }),
        undefined,
        { now: NOW },
      ),
    ).toMatchObject({
      kind: "recovery_error",
      reason:
        "Review trigger sync_conflict:conflict-1 has duplicate stored occurrences.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails closed when a sync conflict has a missing or duplicate affected owner", () => {
    const conflict: SyncConflictRecord = {
      id: "conflict-1",
      recordType: "bet",
      recordId: "bet-1",
      commonAncestorHash: "ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: "2026-07-11T08:00:00.000Z",
    };
    const missing = selectRecommendedNextAction(
      buildWorkspaceV2("workspace-1", { syncConflicts: [conflict] }),
      undefined,
      { now: NOW },
    );
    expect(missing).toMatchObject({
      kind: "recovery_error",
      recordId: conflict.id,
      reason:
        "Sync conflict conflict-1 does not resolve to exactly one affected record owner.",
      permittedNextCommand: "resolve_sync_conflict",
    });

    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: brief,
      committedScope: [],
      appetiteStart: NOW,
      appetiteEnd: "2026-07-12T09:00:00.000Z",
      actorId: "human-1",
      approvedAt: NOW,
    };
    const duplicate = selectRecommendedNextAction(
      buildWorkspaceV2("workspace-1", {
        directionBriefs: [brief],
        bets: [bet, structuredClone(bet)],
        syncConflicts: [conflict],
      }),
      undefined,
      { now: NOW },
    );
    expect(duplicate).toMatchObject({
      kind: "recovery_error",
      recordId: conflict.id,
      reason:
        "Sync conflict conflict-1 does not resolve to exactly one affected record owner.",
    });
  });

  it("ignores future triggers without letting a future hold suppress an expired Bet", () => {
    const brief = buildDirectionBrief({
      id: "brief-1",
      projectId: "project-1",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const bet = {
      id: "bet-1",
      projectId: "project-1",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: brief,
      committedScope: [],
      appetiteStart: "2026-07-10T00:00:00.000Z",
      appetiteEnd: "2026-07-11T08:00:00.000Z",
      actorId: "human-1",
      approvedAt: "2026-07-10T00:00:00.000Z",
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "validating",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      holds: [
        {
          type: "rebet_required",
          sourceId: bet.id,
          affectedRecordIds: [bet.id, "project-1"],
          createdAt: "2026-07-11T10:00:00.000Z",
        },
      ],
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T08:00:00.000Z",
    });

    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", {
          projects: [project],
          directionBriefs: [brief],
          bets: [bet],
        }),
        undefined,
        {
          now: NOW,
          recoveryErrors: [
            {
              id: "future-recovery",
              reason: "Not effective yet",
              occurredAt: "2026-07-11T10:00:00.000Z",
              permittedNextCommand: "restore_backup",
            },
          ],
        },
      ),
    ).toEqual({
      kind: "rebet_required",
      recordId: bet.id,
      projectId: project.id,
      triggeredAt: bet.appetiteEnd,
      reason: `Resolve expired Bet ${bet.id} for Project ${project.id}.`,
      permittedNextCommand: "record_bet_boundary",
    });
  });

  it("fails closed for duplicate operational identities and orphan Re-bet holds", () => {
    const duplicateInbox = buildInboxItem({
      id: "inbox-1",
      sourceId: "ui-source",
      actorId: "human-1",
      capturedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", {
          inboxItems: [duplicateInbox, structuredClone(duplicateInbox)],
        }),
        undefined,
        { now: NOW },
      ),
    ).toMatchObject({
      kind: "recovery_error",
      reason: "Inbox item inbox-1 has duplicate records for one identity.",
    });

    const project = buildProjectV2({
      id: "project-1",
      stage: "executing",
      activeDirectionBriefId: "brief-1",
      holds: [
        {
          type: "rebet_required",
          sourceId: "bet-missing",
          affectedRecordIds: ["project-1"],
          createdAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", { projects: [project] }),
        undefined,
        { now: NOW },
      ),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: "bet-missing",
      reason:
        "Re-bet hold bet-missing has no unique same-project source.",
    });
  });

  it("is pure and stable across Project, Bet, hold, and affected-ID permutations", () => {
    const buildSource = (reverse: boolean) => {
      const entries = ["a", "b"].map((suffix) => {
        const brief = buildDirectionBrief({
          id: `brief:${suffix}`,
          projectId: `project:${suffix}`,
          createdAt: NOW,
          updatedAt: NOW,
        });
        const bet = {
          id: `bet:${suffix}`,
          projectId: `project:${suffix}`,
          version: 1,
          briefId: brief.id,
          briefHash: `hash:${suffix}`,
          briefSnapshot: brief,
          committedScope: [],
          appetiteStart: NOW,
          appetiteEnd: "2026-07-12T09:00:00.000Z",
          actorId: "human-1",
          approvedAt: NOW,
        };
        const affectedRecordIds = [bet.id, `project:${suffix}`];
        const project = buildProjectV2({
          id: `project:${suffix}`,
          stage: "executing",
          activeDirectionBriefId: brief.id,
          activeBetId: bet.id,
          holds: [
            {
              type: "rebet_required",
              sourceId: bet.id,
              affectedRecordIds: reverse
                ? [...affectedRecordIds].reverse()
                : affectedRecordIds,
              createdAt: "2026-07-11T08:00:00.000Z",
            },
          ],
          createdAt: NOW,
          updatedAt: NOW,
        });
        return { brief, bet, project };
      });
      if (reverse) entries.reverse();
      return buildWorkspaceV2("workspace-1", {
        projects: entries.map(({ project }) => project),
        directionBriefs: entries.map(({ brief }) => brief),
        bets: entries.map(({ bet }) => bet),
      });
    };
    const forward = deepFreeze(buildSource(false));
    const reversed = deepFreeze(buildSource(true));

    expect(
      selectRecommendedNextAction(forward, undefined, { now: NOW }),
    ).toEqual(
      selectRecommendedNextAction(reversed, undefined, { now: NOW }),
    );
    expect(
      selectRecommendedNextAction(forward, undefined, { now: NOW }),
    ).toMatchObject({
      kind: "rebet_required",
      recordId: "bet:a",
      projectId: "project:a",
    });
  });
});

describe("selector fail-closed hardening", () => {
  function projectBrief(projectId = "project-1") {
    return buildDirectionBrief({
      id: `brief:${projectId}`,
      projectId,
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T08:00:00.000Z",
    });
  }

  function projectBet(
    projectId = "project-1",
    overrides: Partial<{
      id: string;
      invalidatedAt: string;
      appetiteEnd: string;
    }> = {},
  ) {
    const brief = projectBrief(projectId);
    return {
      brief,
      bet: {
        id: overrides.id ?? `bet:${projectId}`,
        projectId,
        version: 1,
        briefId: brief.id,
        briefHash: `hash:${projectId}`,
        briefSnapshot: structuredClone(brief),
        committedScope: [],
        appetiteStart: "2026-07-10T08:00:00.000Z",
        appetiteEnd:
          overrides.appetiteEnd ?? "2026-07-12T08:00:00.000Z",
        actorId: "human-1",
        approvedAt: "2026-07-10T08:00:00.000Z",
        ...(overrides.invalidatedAt === undefined
          ? {}
          : { invalidatedAt: overrides.invalidatedAt, invalidationReason: "Changed" }),
      },
    };
  }

  it("fails lifecycle projection closed when active records do not resolve exactly", () => {
    const project = buildProjectV2({
      id: "project-1",
      stage: "planning",
      activeDirectionBriefId: "brief-missing",
      activeBetId: "bet-missing",
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T08:00:00.000Z",
    });

    expect(
      selectProjectLifecycle(
        buildWorkspaceV2("workspace-1", { projects: [project] }),
        project.id,
      ),
    ).toEqual({
      ok: false,
      reason:
        "Project project-1 does not resolve to exactly one same-project active Direction brief.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it.each(["migration_review", "review_overdue", "sync_conflict"] as const)(
    "fails closed for a dangling %s hold instead of recommending an unusable unlock",
    (type) => {
      const project = buildProjectV2({
        id: "project-1",
        stage: "executing",
        activeDirectionBriefId: "brief-1",
        holds: [
          {
            type,
            sourceId: `${type}:missing`,
            affectedRecordIds: ["project-1"],
            createdAt: "2026-07-11T08:00:00.000Z",
          },
        ],
        createdAt: "2026-07-10T08:00:00.000Z",
        updatedAt: "2026-07-11T08:00:00.000Z",
      });
      const workspace = buildWorkspaceV2("workspace-1", { projects: [project] });

      expect(selectActiveHolds(workspace, project.id)).toMatchObject({
        ok: false,
        permittedNextCommand: "resolve_sync_conflict",
      });
      expect(
        selectRecommendedNextAction(workspace, project.id, { now: NOW }),
      ).toMatchObject({
        kind: "recovery_error",
        recordId: `${type}:missing`,
        permittedNextCommand: "resolve_sync_conflict",
      });
    },
  );

  it("blocks Today for future or ambiguous open Replans", async () => {
    const commitment: DailyCommitment = {
      id: "commitment-1",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: "commitment-hash",
      capacitySnapshot: selectorCapacity(),
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-11T08:00:00.000Z",
    };
    const replan: ReplanProposal = {
      id: "replan-1",
      localDate: commitment.localDate,
      baseCommitmentId: commitment.id,
      baseRevision: 0,
      reasonCodes: ["calendar_change"],
      proposedSlots: [],
      proposalHash: "replan-hash",
      createdAt: "2026-07-11T10:00:00.000Z",
      createdBy: "human-1",
      status: "open",
    };

    await expect(
      selectTodayStatus(
        buildWorkspaceV2("workspace-1", {
          capacityProfile: selectorCapacity(),
          dailyCommitments: [commitment],
          replanProposals: [replan],
        }),
        commitment.localDate,
        NOW,
      ),
    ).resolves.toMatchObject({
      status: "blocked",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Review summary closed for impossible status and time semantics", () => {
    const review: ReviewRecord = {
      id: "review-1",
      kind: "event",
      triggerKey: "hard_gate:review-1",
      triggerType: "hard_gate",
      status: "completed",
      affectedProjectIds: [],
      affectedRecordIds: [],
      createdAt: "2026-07-11T10:00:00.000Z",
      dueAt: "2026-07-11T08:00:00.000Z",
    };

    expect(
      selectReviewSummary(
        buildWorkspaceV2("workspace-1", { reviews: [review] }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason: "Review review-1 has invalid stored semantics.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("treats an invalidated active Bet without its effective Re-bet hold as recovery", () => {
    const { brief, bet } = projectBet("project-1", {
      invalidatedAt: "2026-07-11T08:00:00.000Z",
    });
    const project = buildProjectV2({
      id: "project-1",
      stage: "executing",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-11T08:00:00.000Z",
    });

    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", {
          projects: [project],
          directionBriefs: [brief],
          bets: [bet],
        }),
        project.id,
        { now: NOW },
      ),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: bet.id,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Replan ownership closed and stays stable across duplicate-base permutations", () => {
    const commitment = (projectId: string): DailyCommitment => ({
      id: "commitment-duplicate",
      localDate: "2026-07-11",
      version: 1,
      proposalHash: projectId,
      capacitySnapshot: selectorCapacity(),
      slots: [
        {
          id: `slot:${projectId}`,
          target: {
            kind: "work_item",
            projectId,
            workItemId: `work:${projectId}`,
          },
          targetRevision: 1,
          start: "2026-07-11T09:00:00.000Z",
          finish: "2026-07-11T09:10:00.000Z",
          attention: "deep",
        },
      ],
      actorId: "human-1",
      committedAt: "2026-07-11T08:00:00.000Z",
    });
    const proposal: ReplanProposal = {
      id: "replan-1",
      localDate: "2026-07-11",
      baseCommitmentId: "commitment-duplicate",
      baseRevision: 0,
      reasonCodes: ["calendar_change"],
      proposedSlots: [],
      proposalHash: "replan-1",
      createdAt: "2026-07-11T08:30:00.000Z",
      createdBy: "human-1",
      status: "open",
    };
    const select = (dailyCommitments: DailyCommitment[]) =>
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-1", {
          dailyCommitments,
          replanProposals: [proposal],
        }),
        undefined,
        { now: NOW },
      );

    const forward = select([commitment("project-a"), commitment("project-b")]);
    const reversed = select([commitment("project-b"), commitment("project-a")]);
    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject({
      kind: "recovery_error",
      recordId: proposal.id,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("rejects future evidence-gate trigger time and never accepts future Evidence", () => {
    const { brief, bet } = projectBet("project-1");
    const requirement: ProjectWorkItem = {
      id: "milestone-1",
      projectId: "project-1",
      kind: "milestone",
      title: "Prove it",
      outline: "Evidence",
      durationSeconds: 600,
      estimate: { mostLikelySeconds: 600 },
      assignmentIds: [],
      percentComplete: 100,
      evidenceRequired: true,
      revision: 1,
      betScopeId: "scope-1",
      resultStatus: "completed",
    };
    const project = buildProjectV2({
      id: "project-1",
      stage: "validating",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    });
    const workspace = buildWorkspaceV2("workspace-1", {
      projects: [project],
      directionBriefs: [brief],
      bets: [bet],
      workItems: [requirement],
      evidence: [
        {
          id: "evidence-future",
          kind: "metric",
          summary: "Not effective yet",
          projectId: project.id,
          workItemId: requirement.id,
          createdAt: "2026-07-11T10:00:00.000Z",
          confidence: 1,
          tags: [],
        },
      ],
    });

    expect(
      selectRecommendedNextAction(workspace, project.id, { now: NOW }),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: project.id,
      permittedNextCommand: "resolve_sync_conflict",
    });

    workspace.projects[0] = { ...workspace.projects[0], updatedAt: NOW };
    expect(
      selectRecommendedNextAction(workspace, project.id, { now: NOW }),
    ).toMatchObject({
      kind: "evidence_gate",
      recordId: requirement.id,
      permittedNextCommand: "attach_evidence",
    });
  });
});

describe("selector P2 regressions", () => {
  function invalidatedClosingWorkspace() {
    const brief = buildDirectionBrief({
      id: "brief-closing",
      projectId: "project-closing",
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T08:00:00.000Z",
    });
    const bet = {
      id: "bet-closing",
      projectId: "project-closing",
      version: 1,
      briefId: brief.id,
      briefHash: "brief-hash",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: "2026-07-10T08:00:00.000Z",
      appetiteEnd: "2026-07-12T08:00:00.000Z",
      actorId: "human-1",
      approvedAt: "2026-07-10T08:00:00.000Z",
      invalidatedAt: "2026-07-11T08:00:00.000Z",
      invalidationReason: "Material Direction change",
    };
    const project = buildProjectV2({
      id: "project-closing",
      stage: "closing",
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      holds: [
        {
          type: "rebet_required",
          sourceId: bet.id,
          affectedRecordIds: ["project-closing", bet.id],
          createdAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-11T08:00:00.000Z",
    });
    return buildWorkspaceV2("workspace-closing", {
      projects: [project],
      directionBriefs: [brief],
      bets: [bet],
    });
  }

  it("fails lifecycle closed for a closing Project whose Bet was invalidated", () => {
    expect(
      selectProjectLifecycle(
        invalidatedClosingWorkspace(),
        "project-closing",
      ),
    ).toEqual({
      ok: false,
      reason:
        "Project project-closing cannot Close with invalidated Bet bet-closing.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("recommends recovery without selector time for a closing Project whose Bet was invalidated", () => {
    expect(
      selectRecommendedNextAction(
        invalidatedClosingWorkspace(),
        "project-closing",
      ),
    ).toEqual({
      kind: "recovery_error",
      recordId: "bet-closing",
      projectId: "project-closing",
      triggeredAt: "1970-01-01T00:00:00.000Z",
      reason:
        "Project project-closing cannot Close with invalidated Bet bet-closing.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it.each([
    {
      name: "one direct and one nested record",
      affectedId: "project-identity",
      blockIds: ["project-identity"],
    },
    {
      name: "two nested records",
      affectedId: "nested-duplicate",
      blockIds: ["nested-duplicate", "nested-duplicate"],
    },
  ])("fails holds closed when an affected ID resolves to $name", ({ affectedId, blockIds }) => {
    const project = buildProjectV2({
      id: "project-identity",
      activeDirectionBriefId: "brief-identity",
      holds: [
        {
          type: "migration_review",
          sourceId: "migration-backup",
          affectedRecordIds: [affectedId],
          createdAt: "2026-07-11T08:00:00.000Z",
        },
      ],
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-11T08:00:00.000Z",
    });
    const profile = selectorCapacity();
    profile.unavailableBlocks = blockIds.map((id, index) => ({
      id,
      start: `2026-07-11T0${index + 1}:00:00.000Z`,
      finish: `2026-07-11T0${index + 2}:00:00.000Z`,
    }));
    const workspace = buildWorkspaceV2("workspace-identity", {
      projects: [project],
      capacityProfile: profile,
      migration: {
        sourceSchemaVersion: 1,
        sourceChecksum: "source",
        backupId: "migration-backup",
        backupChecksum: "backup",
        migratedAt: "2026-07-11T08:00:00.000Z",
        entityCounts: {},
        deterministicIdMap: {},
      },
    });

    expect(selectActiveHolds(workspace, project.id)).toEqual({
      ok: false,
      reason:
        "Project hold migration-backup has ambiguous affected record identities.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Today closed for a Commitment ID duplicated on another date", async () => {
    const profile = selectorCapacity();
    const commitment = (localDate: string): DailyCommitment => ({
      id: "commitment-duplicate-date",
      localDate,
      version: 1,
      proposalHash: localDate,
      capacitySnapshot: structuredClone(profile),
      slots: [],
      actorId: "human-1",
      committedAt: "2026-07-11T08:00:00.000Z",
    });
    const selection = await selectTodayStatus(
      buildWorkspaceV2("workspace-commitment-identity", {
        capacityProfile: profile,
        dailyCommitments: [
          commitment("2026-07-11"),
          commitment("2026-07-12"),
        ],
      }),
      "2026-07-11",
      NOW,
    );

    expect(selection).toEqual({
      status: "blocked",
      reason:
        "Daily Commitment identity commitment-duplicate-date has duplicate stored records.",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails lifecycle and recommendation closed for duplicate historical Bet identity", () => {
    const brief = buildDirectionBrief({
      id: "brief-bet-identity",
      projectId: "project-bet-identity",
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T08:00:00.000Z",
    });
    const activeBet = {
      id: "bet-active",
      projectId: "project-bet-identity",
      version: 2,
      briefId: brief.id,
      briefHash: "active",
      briefSnapshot: structuredClone(brief),
      committedScope: [],
      appetiteStart: "2026-07-10T08:00:00.000Z",
      appetiteEnd: "2026-07-12T08:00:00.000Z",
      actorId: "human-1",
      approvedAt: "2026-07-10T08:00:00.000Z",
    };
    const historicalBet = {
      ...structuredClone(activeBet),
      id: "bet-history-duplicate",
      version: 1,
      invalidatedAt: "2026-07-10T09:00:00.000Z",
      invalidationReason: "Replaced",
    };
    const project = buildProjectV2({
      id: "project-bet-identity",
      stage: "planning",
      activeDirectionBriefId: brief.id,
      activeBetId: activeBet.id,
      createdAt: "2026-07-10T08:00:00.000Z",
      updatedAt: "2026-07-10T09:00:00.000Z",
    });
    const workspace = buildWorkspaceV2("workspace-bet-identity", {
      projects: [project],
      directionBriefs: [brief],
      bets: [
        activeBet,
        historicalBet,
        { ...structuredClone(historicalBet), briefHash: "duplicate" },
      ],
    });

    expect(selectProjectLifecycle(workspace, project.id)).toMatchObject({
      ok: false,
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(
      selectRecommendedNextAction(workspace, project.id, { now: NOW }),
    ).toMatchObject({
      kind: "recovery_error",
      recordId: historicalBet.id,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("uses a persisted overdue marker without requiring selector time", () => {
    const review: ReviewRecord = {
      id: "review-persisted-overdue",
      kind: "event",
      triggerKey: "hard_gate:persisted-overdue",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      createdAt: "2026-07-10T08:00:00.000Z",
      dueAt: "2026-07-10T09:00:00.000Z",
      overdueMarkedAt: "2026-07-10T09:05:00.000Z",
    };

    expect(
      selectRecommendedNextAction(
        buildWorkspaceV2("workspace-overdue", { reviews: [review] }),
      ),
    ).toEqual({
      kind: "review_overdue",
      recordId: review.id,
      triggeredAt: review.dueAt,
      reason: `Complete overdue Review ${review.id}.`,
      permittedNextCommand: "complete_review",
    });
  });

  it("fails Review summary closed when overdue was marked after completion", () => {
    const review: ReviewRecord = {
      id: "review-impossible-timeline",
      kind: "event",
      triggerKey: "hard_gate:impossible-timeline",
      triggerType: "hard_gate",
      status: "completed",
      affectedProjectIds: [],
      affectedRecordIds: [],
      createdAt: "2026-07-10T08:00:00.000Z",
      dueAt: "2026-07-10T09:00:00.000Z",
      overdueMarkedAt: "2026-07-10T11:00:00.000Z",
      conclusion: {
        summary: "Completed earlier",
        decisionCodes: ["complete"],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: "2026-07-10T10:00:00.000Z",
      },
    };

    expect(
      selectReviewSummary(
        buildWorkspaceV2("workspace-review-timeline", { reviews: [review] }),
        NOW,
      ),
    ).toEqual({
      ok: false,
      reason: `Review ${review.id} has invalid stored semantics.`,
      permittedNextCommand: "resolve_sync_conflict",
    });
  });
});
