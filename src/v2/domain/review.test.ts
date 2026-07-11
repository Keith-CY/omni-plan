import { describe, expect, it } from "vitest";

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
  type CommandContext,
  type V2Command,
} from "./commands";
import { applyCommandHandler } from "./commandHandlers";
import { validateWorkspaceInvariants } from "./invariants";
import { evaluateBetBoundary } from "./lifecycle";
import { authorizeCommand, type AuthorizationContext } from "./policy";
import { deriveReviewQueue, reviewPolicy } from "./review";
import type {
  ProjectHold,
  ProjectWorkItem,
  ReviewRecord,
  WorkspaceV2,
} from "./types";

const NOW = "2026-07-08T00:00:00.000Z";

function commandContext(
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
    now: NOW,
    ...overrides,
  };
}

function systemContext(
  revision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return commandContext(revision, {
    actorId: "system-1",
    actorKind: "system",
    origin: "agent",
    source: {
      sourceId: "clock-1",
      verified: true,
      capabilities: ["system_time"],
    },
    ...overrides,
  });
}

function profile(timeZone = "Asia/Tokyo") {
  return buildCapacityProfile({
    timeZone,
    weeklyWindows: [
      { weekday: 1, startMinute: 540, finishMinute: 1_020 },
    ],
    dailyBudgets: [
      {
        weekday: 1,
        deepSeconds: 3_600,
        mediumSeconds: 1_800,
        shallowSeconds: 900,
      },
    ],
    updatedAt: "2026-07-01T00:00:00.000Z",
    updatedBy: "human-1",
  });
}

function activeProjectWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    firstScope: [
      { id: "scope-1", title: "Validate", description: "Validate it" },
    ],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const project = buildProjectV2({
    id: "project-1",
    stage: "executing",
    activeDirectionBriefId: brief.id,
    activeBetId: "bet-1",
    holds: [
      {
        type: "rebet_required",
        sourceId: "bet-1",
        affectedRecordIds: ["project-1", "bet-1", "scope-1"],
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: project.id,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-01T00:00:00.000Z",
    appetiteEnd: "2026-07-15T00:00:00.000Z",
    actorId: "human-1",
    approvedAt: "2026-07-01T00:00:00.000Z",
  });
  const requirement: ProjectWorkItem = {
    id: "requirement-1",
    projectId: project.id,
    kind: "milestone",
    title: "Prove the result",
    outline: "1",
    durationSeconds: 3_600,
    estimate: { mostLikelySeconds: 3_600 },
    assignmentIds: [],
    percentComplete: 0,
    evidenceRequired: true,
    revision: 1,
    betScopeId: "scope-1",
  };
  return buildWorkspaceV2("workspace-1", {
    revision: 7,
    capacityProfile: profile(),
    inboxItems: [
      buildInboxItem({
        id: "inbox-aging",
        sourceId: "capture-1",
        actorId: "human-1",
        capturedAt: "2026-06-30T00:00:00.000Z",
      }),
    ],
    projects: [
      project,
      buildProjectV2({
        id: "project-closed",
        stage: "closed",
        activeDirectionBriefId: "brief-closed",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
    workItems: [requirement],
    evidence: [
      {
        id: "evidence-stale",
        kind: "metric",
        summary: "Old validation result",
        projectId: project.id,
        workItemId: requirement.id,
        createdAt: "2026-06-20T00:00:00.000Z",
        confidence: 1,
        tags: [],
      },
    ],
    exceptions: [
      {
        id: "exception-open",
        projectId: project.id,
        requirementId: requirement.id,
        rationale: "Waiting on an external metric",
        knownConsequence: "Validation confidence is reduced",
        reviewAt: "2026-07-07T00:00:00.000Z",
        expiresAt: "2026-07-09T00:00:00.000Z",
        approvedBy: "human-1",
        createdAt: "2026-07-01T00:00:00.000Z",
        history: [
          {
            action: "created",
            actorId: "human-1",
            at: "2026-07-01T00:00:00.000Z",
            note: "Waiting on an external metric",
          },
        ],
      },
    ],
    syncConflicts: [
      {
        id: "conflict-open",
        recordType: "bet",
        recordId: bet.id,
        projectId: project.id,
        commonAncestorHash: "ancestor",
        localValue: { side: "local" },
        remoteValue: { side: "remote" },
        openedAt: "2026-07-07T00:00:00.000Z",
      },
    ],
  });
}

function capacityVarianceWorkspace(
  actualSeconds: number[],
): WorkspaceV2 {
  const capacity = buildCapacityProfile({
    timeZone: "UTC",
    weeklyWindows: Array.from({ length: 7 }, (_, weekday) => ({
      weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      startMinute: 540,
      finishMinute: 560,
    })),
    dailyBudgets: Array.from({ length: 7 }, (_, weekday) => ({
      weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      deepSeconds: 1_200,
      mediumSeconds: 0,
      shallowSeconds: 0,
    })),
    updatedAt: "2026-06-01T00:00:00.000Z",
    updatedBy: "human-1",
  });
  const inbox = buildInboxItem({
    id: "inbox-action",
    sourceId: "capture-1",
    actorId: "human-1",
    capturedAt: "2026-06-01T00:00:00.000Z",
  });
  const localDates = actualSeconds.map(
    (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`,
  );
  return buildWorkspaceV2("capacity-workspace", {
    capacityProfile: capacity,
    inboxItems: [
      { ...inbox, triageStatus: "action", actionId: "action-1" },
    ],
    actions: [
      {
        id: "action-1",
        inboxItemId: inbox.id,
        title: "Use capacity",
        revision: 1,
        status: "open",
        eligibility: {
          singleSession: true,
          estimateSeconds: 1_200,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 1,
          solutionKnown: true,
        },
        attention: "deep",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      },
    ],
    dailyCommitments: localDates.map((localDate, index) => ({
      id: `commitment-${index + 1}`,
      localDate,
      version: 1,
      proposalHash: `proposal-${index + 1}`,
      capacitySnapshot: structuredClone(capacity),
      slots: [],
      actorId: "human-1",
      committedAt: `${localDate}T08:00:00.000Z`,
    })),
    actuals: localDates.map((localDate, index) => ({
      id: `actual-${index + 1}`,
      revision: 1,
      target: { kind: "action" as const, actionId: "action-1" },
      actualWorkSeconds: actualSeconds[index],
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: `${localDate}T12:00:00.000Z`,
    })),
  });
}

function reviewCommandWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "review-brief",
    projectId: "review-project",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const project = buildProjectV2({
    id: "review-project",
    activeDirectionBriefId: brief.id,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  return buildWorkspaceV2("review-command-workspace", {
    revision: 3,
    capacityProfile: profile("UTC"),
    projects: [project],
    directionBriefs: [brief],
    reviews: [
      {
        id: "review-overdue",
        kind: "weekly",
        triggerKey: "weekly:2026-06-29",
        triggerType: "weekly",
        cadenceTimeZone: "UTC",
        status: "open",
        affectedProjectIds: [project.id],
        affectedRecordIds: [project.id],
        dueAt: "2026-07-05T18:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  });
}

function overdueActionWorkspace(committed: boolean): WorkspaceV2 {
  const capacity = buildCapacityProfile({
    timeZone: "UTC",
    weeklyWindows: [
      { weekday: 3, startMinute: 0, finishMinute: 60 },
    ],
    dailyBudgets: [
      {
        weekday: 3,
        deepSeconds: 0,
        mediumSeconds: 0,
        shallowSeconds: 3_600,
      },
    ],
    updatedAt: "2026-07-01T00:00:00.000Z",
    updatedBy: "human-1",
  });
  const inbox = buildInboxItem({
    id: "action-inbox",
    sourceId: "human-session-1",
    actorId: "human-1",
    capturedAt: "2026-07-01T00:00:00.000Z",
  });
  return buildWorkspaceV2("overdue-action-workspace", {
    revision: 4,
    capacityProfile: capacity,
    inboxItems: [
      { ...inbox, triageStatus: "action", actionId: "action-current" },
    ],
    actions: [
      {
        id: "action-current",
        inboxItemId: inbox.id,
        title: "Finish committed action",
        revision: 1,
        status: "open",
        eligibility: {
          singleSession: true,
          estimateSeconds: 300,
          dependencyIds: [],
          requiresMilestoneEvidence: false,
          outcomeCount: 1,
          solutionKnown: true,
        },
        attention: "shallow",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
    dailyCommitments: committed
      ? [
          {
            id: "action-commitment",
            localDate: "2026-07-08",
            version: 1,
            proposalHash: "action-proposal",
            capacitySnapshot: structuredClone(capacity),
            slots: [
              {
                id: "action-slot",
                target: { kind: "action", actionId: "action-current" },
                targetRevision: 1,
                start: NOW,
                finish: "2026-07-08T00:05:00.000Z",
                attention: "shallow",
              },
            ],
            actorId: "human-1",
            committedAt: "2026-07-07T23:59:00.000Z",
          },
        ]
      : [],
    reviews: [
      {
        id: "weekly-global",
        kind: "weekly",
        triggerKey: "weekly:2026-06-29",
        triggerType: "weekly",
        cadenceTimeZone: "UTC",
        status: "open",
        affectedProjectIds: [],
        affectedRecordIds: [],
        dueAt: "2026-07-05T18:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  });
}

function projectlessConflictWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "portfolio-brief",
    projectId: "portfolio-project",
    audienceAndProblem: "A defined user has a bounded problem.",
    successEvidence: "A measured outcome proves the result.",
    appetiteSeconds: 3_600,
    validationMethod: "Observe the measured outcome.",
    firstScope: [
      { id: "portfolio-scope", title: "Slice", description: "Bounded" },
    ],
    noGoOrKill: "Stop on failed validation.",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });
  const commitment = {
    id: "portfolio-commitment",
    localDate: "2026-07-07",
    version: 1,
    proposalHash: "portfolio-proposal",
    capacitySnapshot: profile("UTC"),
    slots: [],
    actorId: "human-1",
    committedAt: "2026-07-07T00:00:00.000Z",
  } satisfies WorkspaceV2["dailyCommitments"][number];
  return buildWorkspaceV2("portfolio-conflict-workspace", {
    revision: 2,
    projects: [
      buildProjectV2({
        id: "portfolio-project",
        stage: "awaiting_bet",
        activeDirectionBriefId: brief.id,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    ],
    directionBriefs: [brief],
    dailyCommitments: [commitment],
    syncConflicts: [
      {
        id: "portfolio-conflict",
        recordType: "daily_commitment",
        recordId: commitment.id,
        commonAncestorHash: "ancestor",
        localValue: { side: "local" },
        remoteValue: { side: "remote" },
        openedAt: NOW,
      },
    ],
  });
}

function overdueScopeWorkspace(): WorkspaceV2 {
  const workspace = activeProjectWorkspace();
  workspace.projects = workspace.projects.filter(
    ({ id }) => id !== "project-closed",
  );
  workspace.projects[0].holds = [];
  workspace.evidence = [];
  workspace.exceptions = [];
  workspace.syncConflicts = [];
  const secondScope = {
    id: "scope-2",
    title: "Second slice",
    description: "Also committed",
  };
  workspace.directionBriefs[0].firstScope.push(structuredClone(secondScope));
  workspace.bets[0].briefSnapshot.firstScope.push(
    structuredClone(secondScope),
  );
  workspace.bets[0].committedScope.push(structuredClone(secondScope));
  workspace.reviews = [
    {
      id: "scope-overdue",
      kind: "weekly",
      triggerKey: "weekly:2026-06-29",
      triggerType: "weekly",
      cadenceTimeZone: "Asia/Tokyo",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-05T09:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
  ];
  return workspace;
}

describe("fixed Review policy", () => {
  it("exposes the non-configurable best-practice thresholds", () => {
    expect(reviewPolicy).toEqual({
      weeklyDueWeekday: 0,
      weeklyDueMinute: 18 * 60,
      inboxAgingDays: 7,
      evidenceStaleDays: 14,
      capacityVarianceWindowDays: 5,
      capacityVarianceThreshold: 0.25,
      capacityVarianceBreachesRequired: 3,
    });
  });
});

describe("weekly portfolio Review derivation", () => {
  it("uses the CapacityProfile timezone and includes every active portfolio concern", () => {
    const workspace = activeProjectWorkspace();

    const weekly = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "weekly",
    );

    expect(weekly).toMatchObject({
      id: "review:weekly:2026-07-06",
      kind: "weekly",
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly",
      cadenceTimeZone: "Asia/Tokyo",
      affectedProjectIds: ["project-1"],
      dueAt: "2026-07-12T09:00:00.000Z",
    });
    expect(weekly?.affectedRecordIds).toEqual(
      expect.arrayContaining([
        "inbox-aging",
        "project-1",
        "bet-1",
        "scope-1",
        "requirement-1",
        "evidence-stale",
        "exception-open",
        "conflict-open",
      ]),
    );
    expect(weekly?.affectedRecordIds).not.toContain("project-closed");
  });

  it("still derives the fixed weekly occurrence for an empty active portfolio", () => {
    const workspace = buildWorkspaceV2("workspace-empty", {
      capacityProfile: profile("UTC"),
    });

    const weekly = deriveReviewQueue(workspace, NOW).filter(
      ({ triggerType }) => triggerType === "weekly",
    );

    expect(weekly).toEqual([
      expect.objectContaining({
        triggerKey: "weekly:2026-07-06",
        affectedProjectIds: [],
        affectedRecordIds: [],
        dueAt: "2026-07-12T18:00:00.000Z",
      }),
    ]);
  });

  it("keeps the Sunday deadline DST-aware in America/New_York", () => {
    const workspace = buildWorkspaceV2("workspace-dst", {
      capacityProfile: profile("America/New_York"),
    });

    const weekly = deriveReviewQueue(
      workspace,
      "2026-03-04T12:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "weekly");

    expect(weekly).toMatchObject({
      triggerKey: "weekly:2026-03-02",
      dueAt: "2026-03-08T22:00:00.000Z",
    });
  });

  it("catches up every unpersisted full cadence week after a restart", () => {
    const workspace = buildWorkspaceV2("workspace-weekly-catch-up", {
      capacityProfile: profile("UTC"),
    });

    const firstRestart = deriveReviewQueue(
      workspace,
      "2026-07-13T00:00:00.000Z",
    ).filter(({ triggerType }) => triggerType === "weekly");
    expect(firstRestart.map(({ triggerKey }) => triggerKey)).toEqual([
      "weekly:2026-07-06",
      "weekly:2026-07-13",
    ]);
    expect(firstRestart[0]).toMatchObject({
      dueAt: "2026-07-12T18:00:00.000Z",
    });

    const laterRestart = deriveReviewQueue(
      workspace,
      "2026-07-27T00:00:00.000Z",
    ).filter(({ triggerType }) => triggerType === "weekly");
    expect(laterRestart.map(({ triggerKey }) => triggerKey)).toEqual([
      "weekly_catchup:2026-07-06:2026-07-20",
      "weekly:2026-07-27",
    ]);
    expect(laterRestart.map(({ triggerKey }) => triggerKey)).not.toContain(
      "weekly:2026-06-29",
    );
  });

  it("suppresses a persisted missed week while keeping later catch-up stable", () => {
    const workspace = buildWorkspaceV2("workspace-weekly-persisted", {
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "review:weekly:2026-07-06",
          kind: "weekly",
          triggerKey: "weekly:2026-07-06",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "completed",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-07-12T18:00:00.000Z",
          createdAt: "2026-07-12T18:00:00.000Z",
          conclusion: {
            summary: "Week reviewed.",
            decisionCodes: ["continue"],
            followUpCommandIds: [],
            actorId: "human-1",
            completedAt: "2026-07-12T18:00:00.000Z",
          },
        },
      ],
    });

    expect(
      deriveReviewQueue(workspace, "2026-07-20T00:00:00.000Z")
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toEqual(["weekly:2026-07-13", "weekly:2026-07-20"]);
  });

  it("stops a catch-up range before the next persisted covered week", () => {
    const workspace = buildWorkspaceV2("workspace-weekly-middle-coverage", {
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "review:weekly:2026-07-20",
          kind: "weekly",
          triggerKey: "weekly:2026-07-20",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "completed",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-07-26T18:00:00.000Z",
          createdAt: "2026-07-26T18:00:00.000Z",
          conclusion: {
            summary: "Week reviewed.",
            decisionCodes: ["continue"],
            followUpCommandIds: [],
            actorId: "human-1",
            completedAt: "2026-07-26T18:00:00.000Z",
          },
        },
      ],
    });

    expect(
      deriveReviewQueue(workspace, "2026-07-27T00:00:00.000Z")
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toEqual([
      "weekly_catchup:2026-07-06:2026-07-13",
      "weekly:2026-07-27",
    ]);
  });

  it("rejects forged future catch-up coverage and keeps the real gap visible", () => {
    const workspace = buildWorkspaceV2("workspace-forged-weekly-coverage", {
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "review:forged-future-catchup",
          kind: "weekly",
          triggerKey: "weekly_catchup:2026-07-13:2026-08-31",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "open",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-07-13T00:00:00.000Z",
          createdAt: "2026-07-13T00:00:00.000Z",
        },
      ],
    });
    const evaluatedAt = "2026-08-24T00:00:00.000Z";

    expect(validateWorkspaceInvariants(workspace, evaluatedAt)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: "review:review:forged-future-catchup:semantics",
      }),
    );
    expect(
      deriveReviewQueue(workspace, evaluatedAt)
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toEqual([
      "weekly_catchup:2026-07-06:2026-08-17",
      "weekly:2026-08-24",
    ]);
  });

  it("does not trust internally consistent catch-up coverage created in the future", () => {
    const workspace = buildWorkspaceV2("workspace-future-weekly-record", {
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "review:future-catchup-record",
          kind: "weekly",
          triggerKey: "weekly_catchup:2026-07-06:2026-08-31",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "open",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-09-06T18:00:00.000Z",
          createdAt: "2026-09-06T18:00:00.000Z",
        },
      ],
    });
    const evaluatedAt = "2026-08-24T00:00:00.000Z";

    expect(validateWorkspaceInvariants(workspace, evaluatedAt)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: "review:review:future-catchup-record:semantics",
      }),
    );
    expect(
      deriveReviewQueue(workspace, evaluatedAt)
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toEqual([
      "weekly_catchup:2026-07-06:2026-08-17",
      "weekly:2026-08-24",
    ]);
  });

  it("rejects a single weekly occurrence created before its week begins", () => {
    const workspace = buildWorkspaceV2("workspace-precreated-weekly", {
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "review:precreated-weekly",
          kind: "weekly",
          triggerKey: "weekly:2026-08-31",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "open",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-09-06T18:00:00.000Z",
          createdAt: NOW,
        },
      ],
    });

    expect(validateWorkspaceInvariants(workspace, NOW)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: "review:review:precreated-weekly:semantics",
      }),
    );
    expect(
      deriveReviewQueue(workspace, "2026-08-31T00:00:00.000Z")
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toContain("weekly:2026-08-31");
  });

  it("surfaces overlapping persisted catch-up coverage as a conflict", () => {
    const catchUpReview = (
      id: string,
      start: string,
      end: string,
      dueAt: string,
    ): ReviewRecord => ({
      id,
      kind: "weekly",
      triggerKey: `weekly_catchup:${start}:${end}`,
      triggerType: "weekly",
      cadenceTimeZone: "UTC",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt,
      createdAt: dueAt,
    });
    const workspace = buildWorkspaceV2("workspace-overlapping-weekly", {
      capacityProfile: profile("UTC"),
      reviews: [
        catchUpReview(
          "review:catchup-one",
          "2026-07-06",
          "2026-07-13",
          "2026-07-19T18:00:00.000Z",
        ),
        catchUpReview(
          "review:catchup-two",
          "2026-07-13",
          "2026-07-20",
          "2026-07-26T18:00:00.000Z",
        ),
      ],
    });
    const evaluatedAt = "2026-07-27T00:00:00.000Z";

    expect(validateWorkspaceInvariants(workspace, evaluatedAt)).toContainEqual(
      expect.objectContaining({
        code: "SYNC_CONFLICT",
        gate: "weekly_coverage:2026-07-13",
        permittedNextCommand: "resolve_sync_conflict",
      }),
    );
    expect(
      deriveReviewQueue(workspace, evaluatedAt)
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toContain("weekly_catchup:2026-07-06:2026-07-20");
  });

  it("keeps the first applied capacity configuration as an immutable cadence anchor", async () => {
    const initial = buildWorkspaceV2("workspace-cadence-anchor");
    const configured = await executeCommand(
      initial,
      { type: "configure_capacity", profile: profile("UTC") },
      commandContext(initial.revision, {
        commandId: "configure-capacity-first",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(configured.ok).toBe(true);
    if (!configured.ok) throw new Error("Expected first capacity configuration");
    const reconfigured = await executeCommand(
      configured.workspace,
      { type: "configure_capacity", profile: profile("UTC") },
      commandContext(configured.workspace.revision, {
        commandId: "configure-capacity-again",
        now: "2026-07-13T00:00:00.000Z",
      }),
    );
    expect(reconfigured.ok).toBe(true);
    if (!reconfigured.ok) throw new Error("Expected capacity reconfiguration");

    expect(
      deriveReviewQueue(reconfigured.workspace, "2026-07-13T00:00:00.000Z")
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toEqual(["weekly:2026-07-06", "weekly:2026-07-13"]);
  });

  it("uses the latest same-instant capacity timezone for a new Review", async () => {
    const initial = buildWorkspaceV2("workspace-same-instant-timezone");
    const configuredUtc = await executeCommand(
      initial,
      { type: "configure_capacity", profile: profile("UTC") },
      commandContext(initial.revision, {
        commandId: "z-first",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(configuredUtc.ok).toBe(true);
    if (!configuredUtc.ok) throw new Error("Expected UTC configuration");
    const configuredTokyo = await executeCommand(
      configuredUtc.workspace,
      { type: "configure_capacity", profile: profile("Asia/Tokyo") },
      commandContext(configuredUtc.workspace.revision, {
        commandId: "a-second",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(configuredTokyo.ok).toBe(true);
    if (!configuredTokyo.ok) throw new Error("Expected Tokyo configuration");
    const draft = deriveReviewQueue(
      configuredTokyo.workspace,
      NOW,
    ).find(({ triggerKey }) => triggerKey === "weekly:2026-07-06");
    expect(draft?.dueAt).toBe("2026-07-12T09:00:00.000Z");
    if (draft === undefined) throw new Error("Expected weekly Review draft");

    const created = await executeCommand(
      configuredTokyo.workspace,
      { type: "create_review", review: draft },
      systemContext(configuredTokyo.workspace.revision, {
        commandId: "create-after-timezone-change",
      }),
    );

    expect(created.ok).toBe(true);
  });

  it("keeps an existing weekly Review valid across a same-instant timezone change", async () => {
    const configuredUtc = await executeCommand(
      buildWorkspaceV2("workspace-review-timezone-snapshot"),
      { type: "configure_capacity", profile: profile("UTC") },
      commandContext(0, {
        commandId: "configure-utc-before-review",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(configuredUtc.ok).toBe(true);
    if (!configuredUtc.ok) throw new Error("Expected UTC configuration");
    const draft = deriveReviewQueue(
      configuredUtc.workspace,
      "2026-07-01T00:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "weekly");
    if (draft === undefined) throw new Error("Expected weekly Review draft");
    const created = await executeCommand(
      configuredUtc.workspace,
      { type: "create_review", review: draft },
      systemContext(configuredUtc.workspace.revision, {
        commandId: "create-before-timezone-change",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected weekly Review creation");
    const configuredTokyo = await executeCommand(
      created.workspace,
      { type: "configure_capacity", profile: profile("Asia/Tokyo") },
      commandContext(created.workspace.revision, {
        commandId: "configure-tokyo-after-review",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(configuredTokyo.ok).toBe(true);
    if (!configuredTokyo.ok) throw new Error("Expected Tokyo configuration");

    expect(
      validateWorkspaceInvariants(
        configuredTokyo.workspace,
        "2026-07-01T00:00:00.000Z",
      ),
    ).toEqual([]);
    const next = await executeCommand(
      configuredTokyo.workspace,
      {
        type: "capture_inbox",
        id: "capture-after-timezone-change",
        text: "Workspace remains writable.",
      },
      commandContext(configuredTokyo.workspace.revision, {
        commandId: "capture-after-timezone-change",
        now: "2026-07-01T00:00:00.000Z",
      }),
    );
    expect(next.ok).toBe(true);
  });

  it("aggregates long cadence gaps explicitly instead of materializing every week", () => {
    const workspace = buildWorkspaceV2("workspace-long-cadence-gap", {
      capacityProfile: {
        ...profile("UTC"),
        updatedAt: "1900-07-01T00:00:00.000Z",
      },
    });

    const weekly = deriveReviewQueue(
      workspace,
      "2026-07-13T00:00:00.000Z",
    ).filter(({ triggerType }) => triggerType === "weekly");

    expect(weekly).toHaveLength(2);
    expect(weekly[0]?.triggerKey).toBe(
      "weekly_catchup:1900-07-02:2026-07-06",
    );
    expect(weekly[weekly.length - 1]?.triggerKey).toBe(
      "weekly:2026-07-13",
    );
  });

  it("still derives the current week when the cadence anchor is malformed", () => {
    const workspace = buildWorkspaceV2("workspace-invalid-cadence-anchor", {
      capacityProfile: {
        ...profile("UTC"),
        updatedAt: "not-a-timestamp",
      },
    });

    expect(
      deriveReviewQueue(workspace, NOW)
        .filter(({ triggerType }) => triggerType === "weekly")
        .map(({ triggerKey }) => triggerKey),
    ).toContain("weekly:2026-07-06");
  });
});

describe("event-triggered Review derivation", () => {
  it("opens deterministic Bet midpoint and appetite-boundary occurrences", () => {
    const workspace = activeProjectWorkspace();

    const midpoint = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "bet_midpoint",
    );
    const expired = deriveReviewQueue(
      workspace,
      "2026-07-15T00:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "bet_expired");

    expect(midpoint).toMatchObject({
      id: "review:bet-1:midpoint",
      triggerKey: "bet-1:midpoint",
      triggerType: "bet_midpoint",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["bet-1"],
      dueAt: NOW,
    });
    expect(expired).toMatchObject({
      id: "review:bet-1:expired",
      triggerKey: "bet-1:expired",
      triggerType: "bet_expired",
      dueAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("reuses the canonical lifecycle Bet Review draft through persistence", async () => {
    const workspace = activeProjectWorkspace();
    workspace.projects = workspace.projects.filter(
      ({ id }) => id !== "project-closed",
    );
    const proposal = evaluateBetBoundary(workspace, NOW).find(
      ({ review }) => review.triggerType === "bet_midpoint",
    );
    if (proposal === undefined) throw new Error("Expected lifecycle proposal");
    const derived = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "bet_midpoint",
    );
    expect(derived).toEqual(proposal.review);

    const created = await executeCommand(
      workspace,
      { type: "create_review", review: proposal.review },
      systemContext(workspace.revision, {
        commandId: "create-canonical-bet-review",
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected canonical Bet Review creation");
    expect(
      deriveReviewQueue(created.workspace, NOW).some(
        ({ triggerKey }) => triggerKey === proposal.review.triggerKey,
      ),
    ).toBe(false);
  });

  it.each([
    ["future", "2026-07-09T00:00:00.000Z", true],
    ["exact-now", NOW, false],
    ["past", "2026-07-07T00:00:00.000Z", false],
    ["malformed", "not-a-timestamp", true],
  ] as const)(
    "treats %s Bet invalidation with canonical as-of semantics",
    (_label, invalidatedAt, expectedActive) => {
      const workspace = activeProjectWorkspace();
      workspace.bets[0].invalidatedAt = invalidatedAt;
      workspace.bets[0].invalidationReason = "Test as-of state.";

      expect(
        evaluateBetBoundary(workspace, NOW).some(
          ({ review }) => review.triggerType === "bet_midpoint",
        ),
      ).toBe(expectedActive);
      expect(
        deriveReviewQueue(workspace, NOW).some(
          ({ triggerType }) => triggerType === "bet_midpoint",
        ),
      ).toBe(expectedActive);
    },
  );

  it("fails Bet-boundary derivation closed for duplicate identities in either order", () => {
    const workspace = activeProjectWorkspace();
    const active = structuredClone(workspace.bets[0]);
    const invalidated = {
      ...structuredClone(active),
      invalidatedAt: "2026-07-07T00:00:00.000Z",
      invalidationReason: "Duplicate imported tombstone.",
    };

    for (const bets of [
      [active, invalidated],
      [invalidated, active],
    ]) {
      workspace.bets = structuredClone(bets);
      expect(evaluateBetBoundary(workspace, NOW)).toEqual([]);
      expect(
        deriveReviewQueue(workspace, NOW).some(
          ({ triggerType }) =>
            triggerType === "bet_midpoint" || triggerType === "bet_expired",
        ),
      ).toBe(false);
    }
  });

  it.each([
    ["future", "2026-07-09T00:00:00.000Z", false],
    ["exact-now", NOW, true],
    ["past", "2026-07-07T00:00:00.000Z", true],
  ] as const)(
    "treats %s hard gates and sync conflicts with as-of opening semantics",
    (_label, openedAt, expectedOpen) => {
      const workspace = activeProjectWorkspace();
      workspace.projects[0].holds[0].createdAt = openedAt;
      workspace.syncConflicts[0].openedAt = openedAt;
      const drafts = deriveReviewQueue(workspace, NOW);

      expect(
        drafts.some(({ triggerKey }) =>
          triggerKey.startsWith(
            'hard_gate:["project-1","rebet_required","bet-1",',
          ),
        ),
      ).toBe(expectedOpen);
      expect(
        drafts.some(
          ({ triggerKey }) => triggerKey === "sync_conflict:conflict-open",
        ),
      ).toBe(expectedOpen);
      expect(
        drafts
          .find(({ triggerKey }) => triggerKey === "weekly:2026-07-06")
          ?.affectedRecordIds.includes("conflict-open"),
      ).toBe(expectedOpen);
    },
  );

  it.each([
    ["future", "2026-07-09T00:00:00.000Z", true],
    ["exact-now", NOW, false],
    ["past", "2026-07-07T00:00:00.000Z", false],
    ["malformed", "not-a-timestamp", true],
  ] as const)(
    "treats %s Exception resolution with canonical as-of semantics",
    (_label, resolvedAt, expectedUnresolved) => {
      const workspace = activeProjectWorkspace();
      workspace.exceptions[0].resolvedAt = resolvedAt;
      workspace.exceptions[0].history.push({
        action: "resolved",
        actorId: "human-1",
        at: resolvedAt,
        note: "Test as-of state.",
      });
      const drafts = deriveReviewQueue(workspace, NOW);
      expect(
        drafts.some(
          ({ triggerKey }) =>
            triggerKey ===
            "exception:exception-open:review:2026-07-07T00:00:00.000Z",
        ),
      ).toBe(expectedUnresolved);
      expect(
        drafts
          .find(({ triggerKey }) => triggerKey === "weekly:2026-07-06")
          ?.affectedRecordIds.includes("exception-open"),
      ).toBe(expectedUnresolved);
    },
  );

  it.each([
    ["future", "2026-07-09T00:00:00.000Z", true],
    ["exact-now", NOW, false],
    ["past", "2026-07-07T00:00:00.000Z", false],
    ["malformed", "not-a-timestamp", true],
  ] as const)(
    "treats %s sync resolution with canonical as-of semantics",
    (_label, resolvedAt, expectedUnresolved) => {
      const workspace = activeProjectWorkspace();
      workspace.syncConflicts[0].resolvedAt = resolvedAt;
      const drafts = deriveReviewQueue(workspace, NOW);
      expect(
        drafts.some(
          ({ triggerKey }) => triggerKey === "sync_conflict:conflict-open",
        ),
      ).toBe(expectedUnresolved);
      expect(
        drafts
          .find(({ triggerKey }) => triggerKey === "weekly:2026-07-06")
          ?.affectedRecordIds.includes("conflict-open"),
      ).toBe(expectedUnresolved);
    },
  );

  it("uses only latest Evidence per concrete requirement and opens exception, hard-gate, and conflict events", () => {
    const workspace = activeProjectWorkspace();
    const initial = deriveReviewQueue(workspace, NOW);

    expect(initial.map(({ triggerType }) => triggerType)).toEqual(
      expect.arrayContaining([
        "evidence_stale",
        "hard_gate",
        "sync_conflict",
      ]),
    );

    workspace.evidence.push({
      ...structuredClone(workspace.evidence[0]),
      id: "evidence-fresh",
      createdAt: "2026-07-07T00:00:00.000Z",
    });
    const refreshed = deriveReviewQueue(workspace, NOW);
    expect(
      refreshed.some(({ triggerType }) => triggerType === "evidence_stale"),
    ).toBe(false);

    const expired = deriveReviewQueue(
      workspace,
      "2026-07-09T00:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "exception_expired");
    expect(expired).toMatchObject({
      triggerKey: "exception:exception-open:expired",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: [
        "exception-open",
        "project-1",
        "requirement-1",
      ],
      dueAt: "2026-07-09T00:00:00.000Z",
    });

    workspace.projects[0].holds.push(
      {
        type: "review_overdue",
        sourceId: "weekly-review",
        affectedRecordIds: ["project-1"],
        createdAt: NOW,
      },
      {
        type: "sync_conflict",
        sourceId: "conflict-open",
        affectedRecordIds: ["bet-1"],
        createdAt: NOW,
      },
    );
    const hardGateKeys = deriveReviewQueue(workspace, NOW)
      .filter(({ triggerType }) => triggerType === "hard_gate")
      .map(({ triggerKey }) => triggerKey);
    expect(hardGateKeys).toEqual([
      "exception:exception-open:review:2026-07-07T00:00:00.000Z",
      'hard_gate:["project-1","rebet_required","bet-1","2026-07-07T00:00:00.000Z"]',
    ]);
  });

  it("does not let future or malformed Evidence displace the latest usable stale result", () => {
    const workspace = activeProjectWorkspace();
    workspace.evidence.push(
      {
        ...structuredClone(workspace.evidence[0]),
        id: "evidence-future",
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      {
        ...structuredClone(workspace.evidence[0]),
        id: "evidence-malformed",
        summary: "   ",
        createdAt: "2026-07-07T00:00:00.000Z",
        confidence: 2,
        tags: [" bad "],
      },
    );

    expect(
      deriveReviewQueue(workspace, NOW).find(
        ({ triggerType }) => triggerType === "evidence_stale",
      ),
    ).toMatchObject({
      triggerKey: "evidence:evidence-stale:stale",
    });
  });

  it("turns an unresolved Exception reviewAt into a real hard-gate occurrence", () => {
    const workspace = activeProjectWorkspace();
    const atReview = deriveReviewQueue(
      workspace,
      "2026-07-07T00:00:00.000Z",
    ).find(
      ({ triggerKey }) =>
        triggerKey ===
        "exception:exception-open:review:2026-07-07T00:00:00.000Z",
    );

    expect(atReview).toMatchObject({
      kind: "event",
      triggerType: "hard_gate",
      dueAt: "2026-07-07T00:00:00.000Z",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: [
        "exception-open",
        "project-1",
        "requirement-1",
      ],
    });

    workspace.exceptions[0].resolvedAt = "2026-07-07T00:00:00.000Z";
    workspace.exceptions[0].history.push({
      action: "resolved",
      actorId: "human-1",
      at: "2026-07-07T00:00:00.000Z",
      note: "Reviewed and resolved",
    });
    expect(
      deriveReviewQueue(workspace, "2026-07-07T00:00:00.000Z").some(
        ({ triggerKey }) => triggerKey === atReview?.triggerKey,
      ),
    ).toBe(false);
  });

  it("opens capacity variance only for three breaches across exactly the latest five completed sole days", () => {
    const breached = deriveReviewQueue(
      capacityVarianceWorkspace([900, 900, 900, 1080, 1080]),
      NOW,
    ).find(({ triggerType }) => triggerType === "capacity_variance");
    const onlyTwo = deriveReviewQueue(
      capacityVarianceWorkspace([900, 900, 1080, 1080, 1080]),
      NOW,
    );
    const onlyFourDays = deriveReviewQueue(
      capacityVarianceWorkspace([900, 900, 900, 1080]),
      NOW,
    );

    expect(breached).toMatchObject({
      kind: "event",
      triggerType: "capacity_variance",
      affectedRecordIds: expect.arrayContaining([
        "commitment-1",
        "commitment-5",
        "actual-1",
        "actual-5",
      ]),
    });
    expect(breached?.triggerKey).toMatch(/^capacity_variance:/);
    expect(
      onlyTwo.some(({ triggerType }) => triggerType === "capacity_variance"),
    ).toBe(false);
    expect(
      onlyFourDays.some(
        ({ triggerType }) => triggerType === "capacity_variance",
      ),
    ).toBe(false);
  });

  it("always carries the latest valid capacity window into weekly Review", () => {
    const twoBreaches = capacityVarianceWorkspace([
      900,
      900,
      1080,
      1080,
      1080,
    ]);
    const weekly = deriveReviewQueue(twoBreaches, NOW).find(
      ({ triggerKey }) => triggerKey === "weekly:2026-07-06",
    );

    expect(weekly?.affectedRecordIds).toEqual(
      expect.arrayContaining([
        "commitment-1",
        "commitment-5",
        "actual-1",
        "actual-5",
      ]),
    );
    expect(
      deriveReviewQueue(twoBreaches, NOW).some(
        ({ triggerType }) => triggerType === "capacity_variance",
      ),
    ).toBe(false);

    const oneDay = capacityVarianceWorkspace([1080]);
    expect(
      deriveReviewQueue(oneDay, NOW).find(
        ({ triggerKey }) => triggerKey === "weekly:2026-07-06",
      )?.affectedRecordIds,
    ).toEqual(expect.arrayContaining(["commitment-1", "actual-1"]));
  });

  it("uses exact 25 percent variance and keeps wall capacity separate from attention budget", () => {
    const justBelow = capacityVarianceWorkspace([
      901,
      901,
      901,
      1080,
      1080,
    ]);
    expect(
      deriveReviewQueue(justBelow, NOW).some(
        ({ triggerType }) => triggerType === "capacity_variance",
      ),
    ).toBe(false);

    const wallOnly = capacityVarianceWorkspace([
      1800,
      1800,
      1800,
      1200,
      1200,
    ]);
    for (const commitment of wallOnly.dailyCommitments) {
      for (const budget of commitment.capacitySnapshot.dailyBudgets) {
        budget.deepSeconds = 1800;
      }
    }
    expect(
      deriveReviewQueue(wallOnly, NOW).some(
        ({ triggerType }) => triggerType === "capacity_variance",
      ),
    ).toBe(true);
  });

  it("subtracts unavailable intervals from configured wall capacity", () => {
    const workspace = capacityVarianceWorkspace([900, 900, 900, 900, 900]);
    for (const commitment of workspace.dailyCommitments) {
      const { localDate, capacitySnapshot } = commitment;
      for (const budget of capacitySnapshot.dailyBudgets) {
        budget.deepSeconds = 900;
      }
      capacitySnapshot.unavailableBlocks = [
        {
          id: `unavailable-${localDate}`,
          start: `${localDate}T09:15:00.000Z`,
          finish: `${localDate}T09:20:00.000Z`,
        },
      ];
    }

    expect(
      deriveReviewQueue(workspace, NOW).some(
        ({ triggerType }) => triggerType === "capacity_variance",
      ),
    ).toBe(false);
  });

  it.each(["actual", "snapshot"] as const)(
    "surfaces an invalid capacity %s as a deterministic hard gate and weekly concern",
    (invalidKind) => {
      const workspace = capacityVarianceWorkspace([
        900,
        900,
        900,
        1080,
        1080,
      ]);
      if (invalidKind === "actual") {
        workspace.actuals[0].actualWorkSeconds = -1;
      } else {
        workspace.dailyCommitments[0].capacitySnapshot.weeklyWindows[0]
          .finishMinute = 2_000;
      }

      const drafts = deriveReviewQueue(workspace, NOW);
      const weekly = drafts.find(
        ({ triggerKey }) => triggerKey === "weekly:2026-07-06",
      );
      expect(weekly?.affectedRecordIds).toEqual(
        expect.arrayContaining(["commitment-1", "actual-1"]),
      );
      expect(
        drafts.some(({ triggerKey }) =>
          triggerKey.startsWith("capacity_assessment_invalid:"),
        ),
      ).toBe(true);
      expect(
        drafts.some(
          ({ triggerType }) => triggerType === "capacity_variance",
        ),
      ).toBe(false);
    },
  );

  it("surfaces an invalid leaf timezone instead of skipping capacity assessment", () => {
    const workspace = capacityVarianceWorkspace([900]);
    workspace.dailyCommitments[0].capacitySnapshot.timeZone = "Mars/Olympus";

    const invalid = deriveReviewQueue(workspace, NOW).find(({ triggerKey }) =>
      triggerKey.startsWith("capacity_assessment_invalid:"),
    );

    expect(invalid).toMatchObject({
      triggerType: "hard_gate",
      affectedRecordIds: ["actual-1", "commitment-1"],
    });
  });

  it("keeps a malformed Actual traceable in the invalid capacity assessment", () => {
    const workspace = capacityVarianceWorkspace([900, 900, 900, 1080, 1080]);
    workspace.actuals[0].recordedAt = "not-a-timestamp";

    const invalid = deriveReviewQueue(workspace, NOW).find(({ triggerKey }) =>
      triggerKey.startsWith("capacity_assessment_invalid:"),
    );

    expect(invalid?.affectedRecordIds).toContain("actual-1");
    expect(
      deriveReviewQueue(workspace, NOW)
        .find(({ triggerKey }) => triggerKey === "weekly:2026-07-06")
        ?.affectedRecordIds,
    ).toContain("actual-1");
  });

  it("suppresses every persisted occurrence with the same stable trigger key", () => {
    const workspace = activeProjectWorkspace();
    const event = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "bet_midpoint",
    );
    if (event === undefined) throw new Error("Expected Bet midpoint event");
    workspace.reviews.push({
      ...event,
      status: "open",
      createdAt: NOW,
    });

    expect(
      deriveReviewQueue(workspace, NOW).some(
        ({ triggerKey }) => triggerKey === event.triggerKey,
      ),
    ).toBe(false);
  });

  it("deduplicates identical currently-derived occurrences by trigger key", () => {
    const workspace = activeProjectWorkspace();
    workspace.projects[0].holds.push(
      structuredClone(workspace.projects[0].holds[0]),
    );
    const triggerKey =
      'hard_gate:["project-1","rebet_required","bet-1","2026-07-07T00:00:00.000Z"]';

    expect(
      deriveReviewQueue(workspace, NOW).filter(
        (draft) => draft.triggerKey === triggerKey,
      ),
    ).toHaveLength(1);
  });

  it("keeps valid hard-gate occurrences distinct when IDs contain separators", () => {
    const records = [
      {
        projectId: "a",
        briefId: "brief-a",
        betId: "b:rebet_required:c",
        scopeId: "scope-a",
      },
      {
        projectId: "a:rebet_required:b",
        briefId: "brief-b",
        betId: "c",
        scopeId: "scope-b",
      },
    ].map((record) => {
      const brief = buildDirectionBrief({
        id: record.briefId,
        projectId: record.projectId,
        appetiteSeconds: 1_209_600,
        firstScope: [
          {
            id: record.scopeId,
            title: "Validate",
            description: "Validate the bounded outcome.",
          },
        ],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
      const project = buildProjectV2({
        id: record.projectId,
        stage: "executing",
        activeDirectionBriefId: brief.id,
        activeBetId: record.betId,
        holds: [
          {
            type: "rebet_required",
            sourceId: record.betId,
            affectedRecordIds: [record.projectId, record.betId],
            createdAt: "2026-07-07T00:00:00.000Z",
          },
        ],
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      });
      const bet = buildBetVersion({
        id: record.betId,
        projectId: project.id,
        briefId: brief.id,
        briefSnapshot: structuredClone(brief),
        committedScope: structuredClone(brief.firstScope),
        appetiteStart: "2026-07-01T00:00:00.000Z",
        appetiteEnd: "2026-07-15T00:00:00.000Z",
        actorId: "human-1",
        approvedAt: "2026-07-01T00:00:00.000Z",
      });
      return { brief, project, bet };
    });
    const workspace = buildWorkspaceV2("hard-gate-key-collision", {
      projects: records.map(({ project }) => project),
      directionBriefs: records.map(({ brief }) => brief),
      bets: records.map(({ bet }) => bet),
    });

    expect(validateWorkspaceInvariants(workspace, NOW)).toEqual([]);
    const hardGates = deriveReviewQueue(workspace, NOW).filter(
      ({ triggerType }) => triggerType === "hard_gate",
    );
    expect(hardGates).toHaveLength(2);
    expect(new Set(hardGates.map(({ triggerKey }) => triggerKey)).size).toBe(2);
    expect(
      hardGates.map(({ affectedProjectIds }) => affectedProjectIds[0]).sort(),
    ).toEqual(["a", "a:rebet_required:b"]);
  });

  it("does not emit project events after their affected Project is closed", () => {
    const workspace = activeProjectWorkspace();
    workspace.projects[0].stage = "closed";

    const projectEvents = deriveReviewQueue(
      workspace,
      "2026-07-15T00:00:00.000Z",
    ).filter(({ kind }) => kind === "event");

    expect(projectEvents).toEqual([]);
  });

  it("resolves projectless conflict ownership from its commitment record", () => {
    const workspace = activeProjectWorkspace();
    workspace.dailyCommitments = [
      {
        id: "project-commitment",
        localDate: "2026-07-07",
        version: 1,
        proposalHash: "project-proposal",
        capacitySnapshot: profile("UTC"),
        slots: [
          {
            id: "project-slot",
            target: {
              kind: "work_item",
              projectId: "project-1",
              workItemId: "requirement-1",
            },
            targetRevision: 1,
            start: "2026-07-07T00:00:00.000Z",
            finish: "2026-07-07T00:30:00.000Z",
            attention: "deep",
          },
        ],
        actorId: "human-1",
        committedAt: "2026-07-07T00:00:00.000Z",
      },
    ];
    workspace.syncConflicts = [
      {
        id: "commitment-conflict",
        recordType: "daily_commitment",
        recordId: "project-commitment",
        commonAncestorHash: "ancestor",
        localValue: { side: "local" },
        remoteValue: { side: "remote" },
        openedAt: NOW,
      },
    ];

    expect(
      deriveReviewQueue(workspace, NOW).find(
        ({ triggerKey }) => triggerKey === "sync_conflict:commitment-conflict",
      ),
    ).toMatchObject({ affectedProjectIds: ["project-1"] });
  });

  it("does not promote a conflict owned by a closed Project to portfolio scope", () => {
    const workspace = activeProjectWorkspace();
    workspace.projects[0].stage = "closed";
    workspace.dailyCommitments = [
      {
        id: "closed-project-commitment",
        localDate: "2026-07-07",
        version: 1,
        proposalHash: "closed-project-proposal",
        capacitySnapshot: profile("UTC"),
        slots: [
          {
            id: "closed-project-slot",
            target: {
              kind: "work_item",
              projectId: "project-1",
              workItemId: "requirement-1",
            },
            targetRevision: 1,
            start: "2026-07-07T00:00:00.000Z",
            finish: "2026-07-07T00:30:00.000Z",
            attention: "deep",
          },
        ],
        actorId: "human-1",
        committedAt: "2026-07-07T00:00:00.000Z",
      },
    ];
    workspace.syncConflicts = [
      {
        id: "closed-project-conflict",
        recordType: "daily_commitment",
        recordId: "closed-project-commitment",
        commonAncestorHash: "ancestor",
        localValue: { side: "local" },
        remoteValue: { side: "remote" },
        openedAt: NOW,
      },
    ];

    expect(
      deriveReviewQueue(workspace, NOW).some(
        ({ triggerKey }) =>
          triggerKey === "sync_conflict:closed-project-conflict",
      ),
    ).toBe(false);
  });

  it.each([
    ["weekly portfolio", "weekly", ["project-1"], []],
    ["projectless event", "event", [], []],
    ["project event", "event", ["project-1"], ["project-1"]],
  ] as const)(
    "inherits %s scope when a projectless conflict targets a Review",
    (_label, kind, affectedProjectIds, expectedProjectIds) => {
      const workspace = activeProjectWorkspace();
      workspace.reviews = [
        {
          id: "review-conflict-target",
          kind,
          triggerKey:
            kind === "weekly"
              ? "weekly:2026-06-29"
              : `hard_gate:${affectedProjectIds.length}`,
          triggerType: kind === "weekly" ? "weekly" : "hard_gate",
          cadenceTimeZone: kind === "weekly" ? "Asia/Tokyo" : undefined,
          status: "completed",
          affectedProjectIds: [...affectedProjectIds],
          affectedRecordIds: ["project-1"],
          dueAt: "2026-07-01T00:00:00.000Z",
          createdAt: "2026-07-01T00:00:00.000Z",
          conclusion: {
            summary: "Review snapshot completed.",
            decisionCodes: ["continue"],
            followUpCommandIds: [],
            actorId: "human-1",
            completedAt: "2026-07-01T00:00:00.000Z",
          },
        },
      ];
      workspace.syncConflicts = [
        {
          id: "review-scope-conflict",
          recordType: "review",
          recordId: "review-conflict-target",
          commonAncestorHash: "review-scope-ancestor",
          localValue: { side: "local" },
          remoteValue: { side: "remote" },
          openedAt: NOW,
        },
      ];

      expect(
        deriveReviewQueue(workspace, NOW).find(
          ({ triggerKey }) =>
            triggerKey === "sync_conflict:review-scope-conflict",
        )?.affectedProjectIds,
      ).toEqual(expectedProjectIds);
    },
  );

  it("uses each commitment leaf snapshot timezone to decide whether its day completed", () => {
    const workspace = capacityVarianceWorkspace([900, 900, 900, 900, 900]);
    workspace.capacityProfile = profile("Asia/Tokyo");

    const event = deriveReviewQueue(
      workspace,
      "2026-07-05T16:00:00.000Z",
    ).find(({ triggerType }) => triggerType === "capacity_variance");

    expect(event).toBeUndefined();
  });

  it("fails capacity variance closed when any of the latest five date lineages is invalid", () => {
    const workspace = capacityVarianceWorkspace([
      900,
      900,
      900,
      900,
      900,
      900,
    ]);
    const fifth = workspace.dailyCommitments[4];
    fifth.slots = [
      {
        id: "commitment-5-project-slot",
        target: {
          kind: "work_item",
          projectId: "project-1",
          workItemId: "work-item-1",
        },
        targetRevision: 1,
        start: "2026-07-05T09:00:00.000Z",
        finish: "2026-07-05T09:05:00.000Z",
        attention: "deep",
      },
    ];
    workspace.dailyCommitments.push({
      ...structuredClone(fifth),
      id: "commitment-5-fork",
      proposalHash: "proposal-5-fork",
    });

    const drafts = deriveReviewQueue(workspace, NOW);
    expect(
      drafts.some(({ triggerType }) => triggerType === "capacity_variance"),
    ).toBe(false);
    const invalid = drafts.find(({ triggerKey }) =>
      triggerKey.startsWith("capacity_assessment_invalid:"),
    );
    expect(invalid?.affectedRecordIds).toEqual(
      expect.arrayContaining(["commitment-5", "commitment-5-fork"]),
    );
    expect(invalid?.affectedProjectIds).toEqual(["project-1"]);
  });

  it("keeps capacity variance occurrence stable across late Actuals", () => {
    const workspace = capacityVarianceWorkspace([900, 900, 900, 1080, 1080]);
    const before = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "capacity_variance",
    );
    workspace.actuals.push({
      id: "actual-late",
      revision: 1,
      target: { kind: "action", actionId: "action-1" },
      actualWorkSeconds: 10,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: "2026-07-04T13:00:00.000Z",
    });
    const after = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "capacity_variance",
    );

    expect(before?.triggerKey).toBe(
      'capacity_variance:["commitment-1","commitment-2","commitment-3","commitment-4","commitment-5"]',
    );
    expect(after?.triggerKey).toBe(before?.triggerKey);
    expect(after?.dueAt).toBe(before?.dueAt);
  });

  it("keeps capacity occurrences distinct for separator-bearing commitment IDs", () => {
    const left = capacityVarianceWorkspace([900, 900, 900, 1080, 1080]);
    const right = capacityVarianceWorkspace([900, 900, 900, 1080, 1080]);
    const leftIds = ["a+b", "c", "d", "e", "f"];
    const rightIds = ["a", "b+c", "d", "e", "f"];
    left.dailyCommitments.forEach((commitment, index) => {
      commitment.id = leftIds[index];
    });
    right.dailyCommitments.forEach((commitment, index) => {
      commitment.id = rightIds[index];
    });

    const leftKey = deriveReviewQueue(left, NOW).find(
      ({ triggerType }) => triggerType === "capacity_variance",
    )?.triggerKey;
    const rightKey = deriveReviewQueue(right, NOW).find(
      ({ triggerType }) => triggerType === "capacity_variance",
    )?.triggerKey;

    expect(leftKey).toBeDefined();
    expect(rightKey).toBeDefined();
    expect(leftKey).not.toBe(rightKey);
  });

  it("derives zero-Actual capacity variance at the stable next-day boundary", () => {
    const workspace = capacityVarianceWorkspace([900, 900, 900, 1080, 1080]);
    workspace.actuals = [];

    const event = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "capacity_variance",
    );

    expect(event).toMatchObject({
      triggerKey:
        'capacity_variance:["commitment-1","commitment-2","commitment-3","commitment-4","commitment-5"]',
      dueAt: "2026-07-06T00:00:00.000Z",
    });
  });
});

describe("persisted Review commands", () => {
  it("persists only an exact derived occurrence and replays it without duplication", async () => {
    const workspace = buildWorkspaceV2("review-create-workspace", {
      revision: 2,
      capacityProfile: profile("UTC"),
    });
    const draft = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "weekly",
    );
    if (draft === undefined) throw new Error("Expected weekly Review draft");
    const command = { type: "create_review", review: draft } as const;

    const created = await executeCommand(
      workspace,
      command,
      systemContext(workspace.revision, { commandId: "create-review-1" }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected Review creation");
    expect(created.workspace.reviews).toEqual([
      {
        ...draft,
        status: "open",
        createdAt: NOW,
      },
    ]);

    const replayed = await executeCommand(
      created.workspace,
      command,
      systemContext(created.workspace.revision, {
        commandId: "create-review-replay",
      }),
    );
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error("Expected duplicate Review occurrence");
    expect(replayed.rejection).toMatchObject({
      code: "DUPLICATE_COMMAND",
      gate: `review_trigger:${draft.triggerKey}`,
    });
    expect(replayed.workspace).toBe(created.workspace);
    expect(deriveReviewQueue(created.workspace, NOW)).not.toContainEqual(draft);
  });

  it("rejects a system Review draft that does not exactly match derivation", async () => {
    const workspace = buildWorkspaceV2("review-create-invalid", {
      revision: 2,
      capacityProfile: profile("UTC"),
    });
    const draft = deriveReviewQueue(workspace, NOW)[0];
    if (draft === undefined) throw new Error("Expected weekly Review draft");

    const result = await executeCommand(
      workspace,
      {
        type: "create_review",
        review: {
          ...draft,
          dueAt: "2026-07-12T18:01:00.000Z",
        },
      },
      systemContext(workspace.revision, { commandId: "create-review-invalid" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected derived Review mismatch");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: `review:${draft.id}:derivation`,
      permittedNextCommand: "create_review",
    });
    expect(result.workspace.reviews).toEqual([]);
  });

  it("persists derived Review references to nested planning records", async () => {
    const workspace = reviewCommandWorkspace();
    workspace.directionBriefs[0].firstScope = [
      {
        id: "nested-scope",
        title: "Nested scope",
        description: "A Review-addressable nested record.",
      },
    ];
    workspace.projects[0].holds = [
      {
        type: "rebet_required",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-project", "nested-scope"],
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ];
    const draft = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "hard_gate",
    );
    if (draft === undefined) throw new Error("Expected nested hard-gate Review");
    expect(draft.affectedRecordIds).toContain("nested-scope");

    const result = await executeCommand(
      workspace,
      { type: "create_review", review: draft },
      systemContext(workspace.revision, {
        commandId: "create-nested-review",
      }),
    );

    expect(result.ok).toBe(true);
  });

  it("marks an exact open occurrence overdue once at its due boundary", async () => {
    const workspace = reviewCommandWorkspace();
    const command = {
      type: "mark_review_overdue",
      reviewId: "review-overdue",
      triggerKey: "review-overdue:overdue",
    } as const satisfies V2Command;

    const marked = await executeCommand(
      workspace,
      command,
      systemContext(workspace.revision, { commandId: "mark-overdue-1" }),
    );
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw new Error("Expected overdue Review mark");
    expect(marked.workspace.projects[0].holds).toEqual([
      {
        type: "review_overdue",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-overdue", "review-project"],
        createdAt: NOW,
      },
    ]);
    expect(marked.workspace.projects[0].updatedAt).toBe(NOW);

    const replayed = await executeCommand(
      marked.workspace,
      command,
      systemContext(marked.workspace.revision, {
        commandId: "mark-overdue-replay",
      }),
    );
    expect(replayed.ok).toBe(false);
    if (replayed.ok) throw new Error("Expected duplicate overdue mark");
    expect(replayed.rejection).toMatchObject({
      code: "DUPLICATE_COMMAND",
      gate: "review:review-overdue:overdue",
    });
    expect(replayed.workspace.projects[0].holds).toEqual(
      marked.workspace.projects[0].holds,
    );
  });

  it("rejects an early or mismatched overdue occurrence", async () => {
    const workspace = reviewCommandWorkspace();
    workspace.reviews[0].dueAt = "2026-07-08T01:00:00.000Z";

    for (const [commandId, triggerKey] of [
      ["mark-early", "review-overdue:overdue"],
      ["mark-wrong-key", "wrong:overdue"],
    ] as const) {
      const result = await executeCommand(
        workspace,
        {
          type: "mark_review_overdue",
          reviewId: "review-overdue",
          triggerKey,
        },
        systemContext(workspace.revision, { commandId }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected invalid overdue occurrence");
      expect(result.rejection.code).toBe("INVALID_COMMAND");
      expect(result.workspace.projects[0].holds).toEqual([]);
    }
  });

  it("rejects a non-canonical authoritative clock before marking overdue", async () => {
    const workspace = reviewCommandWorkspace();
    const before = structuredClone(workspace);
    const result = await applyCommandHandler(
      workspace,
      {
        type: "mark_review_overdue",
        reviewId: "review-overdue",
        triggerKey: "review-overdue:overdue",
      },
      systemContext(workspace.revision, {
        commandId: "mark-overdue-bad-clock",
        now: "2026-07-08T00:00:00Z",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected bad-clock rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command:mark-overdue-bad-clock:time",
    });
    expect(workspace).toEqual(before);
  });

  it("preflights every affected Project before marking overdue", async () => {
    const workspace = reviewCommandWorkspace();
    const secondBrief = buildDirectionBrief({
      id: "review-brief-2",
      projectId: "review-project-2",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    workspace.directionBriefs.push(secondBrief);
    workspace.projects.push(
      buildProjectV2({
        id: "review-project-2",
        activeDirectionBriefId: secondBrief.id,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    workspace.reviews[0].affectedProjectIds.push("review-project-2");
    const existingHold = {
      type: "review_overdue" as const,
      sourceId: "review-overdue",
      affectedRecordIds: ["review-overdue", "review-project"],
      createdAt: NOW,
    };
    workspace.projects[0].holds = [existingHold];
    const before = structuredClone(workspace);

    const partial = await executeCommand(
      workspace,
      {
        type: "mark_review_overdue",
        reviewId: "review-overdue",
        triggerKey: "review-overdue:overdue",
      },
      systemContext(workspace.revision, {
        commandId: "mark-overdue-partial",
      }),
    );

    expect(partial.ok).toBe(false);
    if (partial.ok) throw new Error("Expected partial overdue conflict");
    expect(partial.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "review:review-overdue:overdue",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(partial.workspace).toBe(workspace);
    expect(workspace).toEqual(before);
  });

  it("persists an empty portfolio overdue mark exactly once", async () => {
    const workspace = buildWorkspaceV2("empty-overdue", {
      revision: 1,
      capacityProfile: profile("UTC"),
      reviews: [
        {
          id: "empty-weekly",
          kind: "weekly",
          triggerKey: "weekly:2026-06-29",
          triggerType: "weekly",
          cadenceTimeZone: "UTC",
          status: "open",
          affectedProjectIds: [],
          affectedRecordIds: [],
          dueAt: "2026-07-05T18:00:00.000Z",
          createdAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const result = await executeCommand(
      workspace,
      {
        type: "mark_review_overdue",
        reviewId: "empty-weekly",
        triggerKey: "empty-weekly:overdue",
      },
      systemContext(workspace.revision, {
        commandId: "mark-empty-overdue",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected portfolio overdue marker");
    expect(result.workspace.reviews[0]).toMatchObject({
      overdueMarkedAt: NOW,
    });
    const retry = await executeCommand(
      result.workspace,
      {
        type: "mark_review_overdue",
        reviewId: "empty-weekly",
        triggerKey: "empty-weekly:overdue",
      },
      systemContext(result.workspace.revision, {
        commandId: "mark-empty-overdue-retry",
      }),
    );
    expect(retry.ok).toBe(false);
    if (retry.ok) throw new Error("Expected duplicate portfolio marker");
    expect(retry.rejection).toMatchObject({
      code: "DUPLICATE_COMMAND",
      gate: "review:empty-weekly:overdue",
    });
    expect(retry.workspace).toBe(result.workspace);
  });

  it("stores a human conclusion and removes only that Review's overdue holds", async () => {
    const workspace = reviewCommandWorkspace();
    workspace.reviews.push({
      id: "another-review",
      kind: "event",
      triggerKey: "hard_gate:another-review",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: ["review-project"],
      affectedRecordIds: ["review-project"],
      dueAt: NOW,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    workspace.projects[0].holds = [
      {
        type: "review_overdue",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-overdue", "review-project"],
        createdAt: NOW,
      },
      {
        type: "review_overdue",
        sourceId: "another-review",
        affectedRecordIds: ["review-project"],
        createdAt: NOW,
      },
    ];
    const result = await executeCommand(
      workspace,
      {
        type: "complete_review",
        reviewId: "review-overdue",
        conclusion: {
          summary: "  Portfolio reviewed.  ",
          decisionCodes: [" continue ", "rebet"],
          followUpCommandIds: [" command-follow-up "],
        },
      },
      commandContext(workspace.revision, { commandId: "complete-review-1" }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected human Review conclusion");
    expect(result.workspace.reviews[0]).toMatchObject({
      status: "completed",
      conclusion: {
        summary: "Portfolio reviewed.",
        decisionCodes: ["continue", "rebet"],
        followUpCommandIds: ["command-follow-up"],
        actorId: "human-1",
        completedAt: NOW,
      },
    });
    expect(result.workspace.projects[0].holds).toEqual([
      expect.objectContaining({ sourceId: "another-review" }),
    ]);
    expect(result.workspace.projects[0].updatedAt).toBe(NOW);
  });

  it("rejects non-human and malformed Review conclusions without removing holds", async () => {
    const workspace = reviewCommandWorkspace();
    workspace.projects[0].holds = [
      {
        type: "review_overdue",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-overdue", "review-project"],
        createdAt: NOW,
      },
    ];
    const command = {
      type: "complete_review",
      reviewId: "review-overdue",
      conclusion: {
        summary: "Reviewed",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
      },
    } as const satisfies V2Command;
    const agent = await executeCommand(
      workspace,
      command,
      commandContext(workspace.revision, {
        commandId: "complete-review-agent",
        actorId: "agent-1",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-1",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    const malformed = await executeCommand(
      workspace,
      {
        ...command,
        conclusion: {
          summary: "   ",
          decisionCodes: ["continue", " continue "],
          followUpCommandIds: ["   "],
        },
      },
      commandContext(workspace.revision, {
        commandId: "complete-review-malformed",
      }),
    );

    expect(agent.ok).toBe(false);
    if (agent.ok) throw new Error("Expected human-only Review conclusion");
    expect(agent.rejection.code).toBe("HUMAN_CONFIRMATION_REQUIRED");
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error("Expected invalid Review conclusion");
    expect(malformed.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "review:review-overdue:conclusion",
    });
    expect(workspace.projects[0].holds).toHaveLength(1);
  });

  it("fails closed before selecting a duplicate Review identity or trigger", async () => {
    const workspace = reviewCommandWorkspace();
    workspace.reviews.push({
      ...structuredClone(workspace.reviews[0]),
      dueAt: "2026-07-08T01:00:00.000Z",
    });
    const mark = await applyCommandHandler(
      workspace,
      {
        type: "mark_review_overdue",
        reviewId: "review-overdue",
        triggerKey: "review-overdue:overdue",
      },
      systemContext(workspace.revision, { commandId: "mark-duplicate-review" }),
    );
    const complete = await applyCommandHandler(
      workspace,
      {
        type: "complete_review",
        reviewId: "review-overdue",
        conclusion: {
          summary: "Must not select either duplicate",
          decisionCodes: ["repair"],
          followUpCommandIds: [],
        },
      },
      commandContext(workspace.revision, {
        commandId: "complete-duplicate-review",
      }),
    );
    const { status: _status, createdAt: _createdAt, ...duplicateTriggerDraft } =
      workspace.reviews[0];
    const create = await applyCommandHandler(
      workspace,
      { type: "create_review", review: duplicateTriggerDraft },
      systemContext(workspace.revision, {
        commandId: "create-duplicate-trigger",
      }),
    );

    for (const result of [mark, complete]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected duplicate Review identity");
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:ReviewRecord:review-overdue",
        permittedNextCommand: "resolve_sync_conflict",
      });
    }
    expect(create.ok).toBe(false);
    if (create.ok) throw new Error("Expected duplicate Review trigger");
    expect(create.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "entity_identity:ReviewTrigger:weekly:2026-06-29",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("fails Review completion closed on a duplicate affected Project identity", async () => {
    const original = structuredClone(reviewCommandWorkspace().projects[0]);
    const duplicate = {
      ...structuredClone(original),
      name: "Imported duplicate Project",
    };
    for (const [index, projects] of [
      [original, duplicate],
      [duplicate, original],
    ].entries()) {
      const workspace = reviewCommandWorkspace();
      workspace.projects = structuredClone(projects);
      const result = await applyCommandHandler(
        workspace,
        {
          type: "complete_review",
          reviewId: "review-overdue",
          conclusion: {
            summary: "Must not select duplicate Projects",
            decisionCodes: ["repair"],
            followUpCommandIds: [],
          },
        },
        commandContext(workspace.revision, {
          commandId: `complete-review-duplicate-project-${index}`,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected duplicate Project conflict");
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:ProjectV2:review-project",
        permittedNextCommand: "resolve_sync_conflict",
      });
    }
  });
});

describe("portfolio-wide overdue enforcement", () => {
  it("allows capture, Project triage, and Direction drafting while blocking new commitments", async () => {
    const source = reviewCommandWorkspace();
    source.inboxItems.push(
      buildInboxItem({
        id: "new-project-inbox",
        sourceId: "human-session-1",
        actorId: "human-1",
        capturedAt: NOW,
      }),
    );
    const capture = await executeCommand(
      structuredClone(source),
      { type: "capture_inbox", id: "captured-during-review", text: "Allowed" },
      commandContext(source.revision, { commandId: "capture-during-review" }),
    );
    const triage = await executeCommand(
      structuredClone(source),
      {
        type: "confirm_project_triage",
        inboxItemId: "new-project-inbox",
        eligibility: {
          singleSession: false,
          estimateSeconds: 14_400,
          dependencyIds: ["external-dependency"],
          requiresMilestoneEvidence: true,
          outcomeCount: 2,
          solutionKnown: false,
        },
        project: {
          id: "new-direction-project",
          name: "Direction remains draftable",
          priority: 1,
          notes: "",
        },
      },
      commandContext(source.revision, { commandId: "triage-during-review" }),
    );
    const direction = await executeCommand(
      structuredClone(source),
      {
        type: "update_direction",
        projectId: "review-project",
        brief: {
          ...structuredClone(source.directionBriefs[0]),
          audienceAndProblem: "Refined during overdue review",
        },
      },
      commandContext(source.revision, { commandId: "direction-during-review" }),
    );

    expect(capture.ok).toBe(true);
    expect(triage.ok).toBe(true);
    expect(direction.ok).toBe(true);
    if (!triage.ok) throw new Error("Expected Project triage during Review");
    const newProject = triage.workspace.projects.find(
      ({ id }) => id === "new-direction-project",
    );
    if (newProject === undefined) throw new Error("Expected new Project");
    const completedDirection = await executeCommand(
      triage.workspace,
      {
        type: "update_direction",
        projectId: newProject.id,
        brief: {
          id: newProject.activeDirectionBriefId,
          projectId: newProject.id,
          audienceAndProblem: "A specific user needs this outcome.",
          successEvidence: "A measured result proves success.",
          appetiteSeconds: 3_600,
          validationMethod: "Observe the result.",
          firstScope: [
            {
              id: "new-project-scope",
              title: "First slice",
              description: "The bounded validation slice.",
            },
          ],
          noGoOrKill: "Stop if validation fails.",
          advancedNotes: "",
        },
      },
      commandContext(triage.workspace.revision, {
        commandId: "complete-new-direction-during-review",
      }),
    );
    expect(completedDirection.ok).toBe(true);
    if (!completedDirection.ok) {
      throw new Error("Expected Direction completion during Review");
    }
    const newProjectBet = await executeCommand(
      completedDirection.workspace,
      {
        type: "place_bet",
        projectId: newProject.id,
        betId: "blocked-new-project-bet",
        start: NOW,
      },
      commandContext(completedDirection.workspace.revision, {
        commandId: "place-new-project-bet-during-review",
      }),
    );
    expect(newProjectBet.ok).toBe(false);
    if (newProjectBet.ok) throw new Error("Expected global new-Project Bet block");
    expect(newProjectBet.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });

    const blockedCommands: V2Command[] = [
      {
        type: "commit_today",
        commitment: {
          id: "blocked-commitment",
          localDate: "2026-07-08",
          workspaceRevision: source.revision,
          generatedAt: NOW,
          proposalHash: "blocked-proposal",
          slots: [],
        },
      },
      {
        type: "accept_replan",
        proposalId: "blocked-replan",
        commitmentId: "blocked-replan-commitment",
      },
      {
        type: "update_work_item",
        projectId: "review-project",
        workItemId: "blocked-scope-expansion",
        patch: { isScopeExpansion: true },
      },
    ];
    for (const [index, command] of blockedCommands.entries()) {
      const result = await executeCommand(
        structuredClone(source),
        command,
        commandContext(source.revision, {
          commandId: `blocked-overdue-${index}`,
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected global overdue block");
      expect(result.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "review_overdue",
        permittedNextCommand: "complete_review",
      });
    }
  });

  it("blocks an uncommitted Action completion but preserves the exact current commitment", async () => {
    const command = {
      type: "complete_action",
      actionId: "action-current",
      actualSeconds: 300,
      resultStatus: "completed",
      outcomeNote: "Committed action finished.",
    } as const satisfies V2Command;
    const uncommitted = overdueActionWorkspace(false);
    const committed = overdueActionWorkspace(true);

    const blocked = await executeCommand(
      uncommitted,
      command,
      commandContext(uncommitted.revision, {
        commandId: "complete-uncommitted-action",
      }),
    );
    const allowed = await executeCommand(
      committed,
      command,
      commandContext(committed.revision, {
        commandId: "complete-committed-action",
      }),
    );

    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("Expected uncommitted Action block");
    expect(blocked.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
    expect(allowed.ok).toBe(true);
  });

  it("persists and completes a projectless overdue event as a portfolio fact", async () => {
    const workspace = projectlessConflictWorkspace();
    const draft = deriveReviewQueue(workspace, NOW).find(
      ({ triggerType }) => triggerType === "sync_conflict",
    );
    if (draft === undefined) throw new Error("Expected projectless conflict Review");
    expect(draft.affectedProjectIds).toEqual([]);

    const created = await executeCommand(
      workspace,
      { type: "create_review", review: draft },
      systemContext(workspace.revision, {
        commandId: "create-portfolio-conflict-review",
        source: {
          sourceId: "conflict-source",
          verified: true,
          capabilities: ["open_conflict"],
        },
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected portfolio Review creation");
    const marked = await executeCommand(
      created.workspace,
      {
        type: "mark_review_overdue",
        reviewId: draft.id,
        triggerKey: `${draft.id}:overdue`,
      },
      systemContext(created.workspace.revision, {
        commandId: "mark-portfolio-conflict-overdue",
      }),
    );
    expect(marked.ok).toBe(true);
    if (!marked.ok) throw new Error("Expected portfolio overdue mark");
    expect(marked.workspace.reviews[0]).toMatchObject({
      overdueMarkedAt: NOW,
    });

    const blockedBet = await executeCommand(
      marked.workspace,
      {
        type: "place_bet",
        projectId: "portfolio-project",
        betId: "blocked-portfolio-bet",
        start: NOW,
      },
      commandContext(marked.workspace.revision, {
        commandId: "blocked-portfolio-bet",
      }),
    );
    expect(blockedBet.ok).toBe(false);
    if (blockedBet.ok) throw new Error("Expected portfolio Bet block");
    expect(blockedBet.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });

    const completed = await executeCommand(
      marked.workspace,
      {
        type: "complete_review",
        reviewId: draft.id,
        conclusion: {
          summary: "Portfolio conflict reviewed.",
          decisionCodes: ["resolve_conflict"],
          followUpCommandIds: [],
        },
      },
      commandContext(marked.workspace.revision, {
        commandId: "complete-portfolio-review",
      }),
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error("Expected portfolio Review completion");
    const allowedBet = await executeCommand(
      completed.workspace,
      {
        type: "place_bet",
        projectId: "portfolio-project",
        betId: "allowed-after-portfolio-review",
        start: NOW,
      },
      commandContext(completed.workspace.revision, {
        commandId: "allow-bet-after-portfolio-review",
      }),
    );
    expect(allowedBet.ok).toBe(true);
  });
});

describe("Review policy recovery commands", () => {
  it.each([
    "migration_review",
    "rebet_required",
    "review_overdue",
  ] as const)("allows Review recovery commands through %s", (holdType) => {
    const hold = {
      type: holdType,
      sourceId: `${holdType}-source`,
      affectedRecordIds: ["review-1", "project-1"],
      createdAt: NOW,
    };
    const base = {
      origin: "agent" as const,
      workspaceRevision: 1,
      projectHolds: [hold],
      affectedRecordIds: ["review-1", "project-1"],
      deterministicTriggerKey: "review-trigger",
    };
    const system: AuthorizationContext = {
      ...base,
      actorKind: "system",
      source: {
        sourceId: "clock-1",
        verified: true,
        capabilities: ["system_time"],
      },
    };
    const human: AuthorizationContext = {
      ...base,
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "human-session-1",
        verified: true,
        capabilities: ["human_decision"],
      },
      deterministicTriggerKey: undefined,
    };

    expect(authorizeCommand("create_review", system)).toBeUndefined();
    expect(authorizeCommand("mark_review_overdue", system)).toBeUndefined();
    expect(authorizeCommand("complete_review", human)).toBeUndefined();
  });

  it("blocks Review recovery on only the Review identity under sync hold", () => {
    const system: AuthorizationContext = {
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "clock-1",
        verified: true,
        capabilities: ["system_time"],
      },
      workspaceRevision: 1,
      deterministicTriggerKey: "review-trigger",
      projectHolds: [
        {
          type: "sync_conflict",
          sourceId: "sync-source",
          affectedRecordIds: ["review-1"],
          createdAt: NOW,
        },
      ],
      affectedRecordIds: ["review-1"],
    };
    const human: AuthorizationContext = {
      ...system,
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "human-session-1",
        verified: true,
        capabilities: ["human_decision"],
      },
      deterministicTriggerKey: undefined,
    };

    expect(authorizeCommand("create_review", system)).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
    expect(authorizeCommand("mark_review_overdue", system)).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
    expect(authorizeCommand("complete_review", human)).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });

    const underlyingOnly = {
      ...system,
      projectHolds: [
        {
          ...system.projectHolds[0],
          affectedRecordIds: ["bet-1"],
        },
      ],
    };
    expect(authorizeCommand("create_review", underlyingOnly)).toBeUndefined();
    expect(
      authorizeCommand("mark_review_overdue", underlyingOnly),
    ).toBeUndefined();
    expect(
      authorizeCommand("complete_review", {
        ...human,
        projectHolds: underlyingOnly.projectHolds,
      }),
    ).toBeUndefined();
  });

  it("creates and completes a conflict Review through an underlying-record sync hold", async () => {
    const workspace = activeProjectWorkspace();
    workspace.projects = workspace.projects.filter(
      ({ id }) => id !== "project-closed",
    );
    workspace.projects[0].holds = [
      {
        type: "sync_conflict",
        sourceId: "conflict-open",
        affectedRecordIds: ["bet-1"],
        createdAt: "2026-07-07T00:00:00.000Z",
      },
    ];
    const draft = deriveReviewQueue(workspace, NOW).find(
      ({ triggerKey }) => triggerKey === "sync_conflict:conflict-open",
    );
    if (draft === undefined) throw new Error("Expected sync Review draft");

    const created = await executeCommand(
      workspace,
      { type: "create_review", review: draft },
      systemContext(workspace.revision, {
        commandId: "create-sync-review",
        source: {
          sourceId: "sync-engine",
          verified: true,
          capabilities: ["open_conflict"],
        },
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("Expected sync Review creation");
    const completed = await executeCommand(
      created.workspace,
      {
        type: "complete_review",
        reviewId: draft.id,
        conclusion: {
          summary: "Conflict reviewed.",
          decisionCodes: ["resolve_conflict"],
          followUpCommandIds: [],
        },
      },
      commandContext(created.workspace.revision, {
        commandId: "complete-sync-review",
      }),
    );
    expect(completed.ok).toBe(true);
  });

  it("does not mutate a late-added portfolio Project through its sync conflict", async () => {
    const workspace = reviewCommandWorkspace();
    const lateBrief = buildDirectionBrief({
      id: "late-review-brief",
      projectId: "late-review-project",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const lateProject = buildProjectV2({
      id: "late-review-project",
      activeDirectionBriefId: lateBrief.id,
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    workspace.directionBriefs.push(lateBrief);
    workspace.syncConflicts.push({
      id: "late-project-conflict",
      recordType: "review",
      recordId: "review-overdue",
      projectId: lateProject.id,
      commonAncestorHash: "late-project-ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: NOW,
    });
    lateProject.holds = [
      {
        type: "review_overdue",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-overdue", lateProject.id],
        createdAt: NOW,
      },
      {
        type: "sync_conflict",
        sourceId: "late-project-conflict",
        affectedRecordIds: [lateProject.id],
        createdAt: NOW,
      },
    ];
    workspace.projects.push(lateProject);
    workspace.reviews[0].overdueMarkedAt = NOW;
    const before = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "complete_review",
        reviewId: "review-overdue",
        conclusion: {
          summary: "Must not mutate the late Project.",
          decisionCodes: ["resolve_conflict_first"],
          followUpCommandIds: [],
        },
      },
      commandContext(workspace.revision, {
        commandId: "complete-review-with-late-project-conflict",
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected late Project sync hold block");
    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });
    expect(workspace).toEqual(before);
  });

  it("finds Review-identity sync holds globally without blocking unrelated ones", async () => {
    const related = reviewCommandWorkspace();
    related.reviews[0].affectedProjectIds = [];
    related.syncConflicts.push({
      id: "portfolio-review-conflict",
      recordType: "review",
      recordId: "review-overdue",
      projectId: "review-project",
      commonAncestorHash: "portfolio-review-ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: NOW,
    });
    related.projects[0].holds = [
      {
        type: "sync_conflict",
        sourceId: "portfolio-review-conflict",
        affectedRecordIds: ["review-overdue"],
        createdAt: NOW,
      },
    ];

    const blocked = await executeCommand(
      related,
      {
        type: "complete_review",
        reviewId: "review-overdue",
        conclusion: {
          summary: "Must resolve the Review conflict first.",
          decisionCodes: ["resolve_conflict_first"],
          followUpCommandIds: [],
        },
      },
      commandContext(related.revision, {
        commandId: "complete-projectless-conflicted-review",
      }),
    );
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("Expected global Review sync hold block");
    expect(blocked.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "sync_conflict",
    });

    const unrelated = reviewCommandWorkspace();
    unrelated.reviews[0].affectedProjectIds = [];
    unrelated.reviews.push({
      id: "review-unrelated",
      kind: "event",
      triggerKey: "hard_gate:unrelated",
      triggerType: "hard_gate",
      status: "completed",
      affectedProjectIds: ["review-project"],
      affectedRecordIds: ["review-project"],
      dueAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      conclusion: {
        summary: "Already reviewed.",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: "2026-07-01T00:00:00.000Z",
      },
    });
    unrelated.syncConflicts.push({
      id: "unrelated-review-conflict",
      recordType: "review",
      recordId: "review-unrelated",
      projectId: "review-project",
      commonAncestorHash: "unrelated-review-ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: NOW,
    });
    unrelated.projects[0].holds = [
      {
        type: "sync_conflict",
        sourceId: "unrelated-review-conflict",
        affectedRecordIds: ["review-unrelated"],
        createdAt: NOW,
      },
    ];

    const allowed = await executeCommand(
      unrelated,
      {
        type: "complete_review",
        reviewId: "review-overdue",
        conclusion: {
          summary: "The unrelated conflict remains untouched.",
          decisionCodes: ["continue"],
          followUpCommandIds: [],
        },
      },
      commandContext(unrelated.revision, {
        commandId: "complete-review-through-unrelated-conflict",
      }),
    );
    expect(allowed.ok).toBe(true);
  });

  it("does not treat an untouched portfolio Project as a completion mutation", async () => {
    const workspace = activeProjectWorkspace();
    workspace.projects = workspace.projects.filter(
      ({ id }) => id === "project-1",
    );
    workspace.projects[0].holds = [
      {
        type: "sync_conflict",
        sourceId: "conflict-open",
        affectedRecordIds: ["project-1", "bet-1"],
        createdAt: NOW,
      },
    ];
    workspace.reviews = [
      {
        id: "portfolio-review-without-project-hold",
        kind: "weekly",
        triggerKey: "weekly:2026-06-29",
        triggerType: "weekly",
        cadenceTimeZone: "Asia/Tokyo",
        status: "open",
        affectedProjectIds: [],
        affectedRecordIds: ["project-1"],
        dueAt: "2026-07-05T09:00:00.000Z",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ];

    const result = await executeCommand(
      workspace,
      {
        type: "complete_review",
        reviewId: "portfolio-review-without-project-hold",
        conclusion: {
          summary: "The conflicted Project is not mutated.",
          decisionCodes: ["leave_conflict_open"],
          followUpCommandIds: [],
        },
      },
      commandContext(workspace.revision, {
        commandId: "complete-review-with-untouched-conflicted-project",
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected unrelated Project conflict allowance");
    expect(result.workspace.projects[0]).toEqual(workspace.projects[0]);
  });

  it("blocks only scope-expanding Work Item updates during overdue Review", () => {
    const base: AuthorizationContext = {
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "human-session-1",
        verified: true,
        capabilities: ["human_decision"],
      },
      workspaceRevision: 1,
      projectHolds: [
        {
          type: "review_overdue",
          sourceId: "weekly-review",
          affectedRecordIds: ["project-1", "work-item-1"],
          createdAt: NOW,
        },
      ],
      affectedRecordIds: ["project-1", "work-item-1"],
    };

    expect(
      authorizeCommand("update_work_item", {
        ...base,
        expandsScope: false,
      }),
    ).toBeUndefined();
    expect(
      authorizeCommand("update_work_item", {
        ...base,
        expandsScope: true,
      }),
    ).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });

  it("classifies overdue Work Item updates from merged persisted scope semantics", async () => {
    const executeUpdate = async (
      workspace: WorkspaceV2,
      patch: Extract<V2Command, { type: "update_work_item" }>["patch"],
      commandId: string,
      workItemId = "requirement-1",
    ) =>
      executeCommand(
        workspace,
        {
          type: "update_work_item",
          projectId: "project-1",
          workItemId,
          patch,
        },
        commandContext(workspace.revision, { commandId }),
      );

    for (const patch of [
      { title: "Cannot clear historical expansion", isScopeExpansion: false },
      { durationSeconds: 3_601 },
    ]) {
      const historical = overdueScopeWorkspace();
      historical.workItems[0].isScopeExpansion = true;
      const result = await executeUpdate(
        historical,
        patch,
        `block-historical-${patch.durationSeconds ?? 0}`,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected historical expansion block");
      expect(result.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "review_overdue",
      });
    }

    const explicit = await executeUpdate(
      overdueScopeWorkspace(),
      { title: "Explicitly expanding", isScopeExpansion: true },
      "block-explicit-expansion",
    );
    expect(explicit.ok).toBe(false);
    if (explicit.ok) throw new Error("Expected explicit expansion block");
    expect(explicit.rejection.code).toBe("HOLD_BLOCKS_COMMAND");

    const refinement = await executeUpdate(
      overdueScopeWorkspace(),
      { durationSeconds: 3_601 },
      "allow-duration-refinement",
    );
    expect(refinement.ok).toBe(true);

    const remapped = await executeUpdate(
      overdueScopeWorkspace(),
      { betScopeId: "scope-2" },
      "allow-committed-remap",
    );
    expect(remapped.ok).toBe(true);

    const outside = await executeUpdate(
      overdueScopeWorkspace(),
      { betScopeId: "scope-outside" },
      "reject-outside-in-handler",
    );
    expect(outside.ok).toBe(false);
    if (outside.ok) throw new Error("Expected outside-scope rejection");
    expect(outside.rejection).toMatchObject({
      code: "SCOPE_OUTSIDE_BET",
    });

    const missing = await executeUpdate(
      overdueScopeWorkspace(),
      { title: "Missing target" },
      "block-missing-item",
      "missing-item",
    );
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("Expected missing-item fail closed");
    expect(missing.rejection.code).toBe("HOLD_BLOCKS_COMMAND");

    const duplicateWorkspace = overdueScopeWorkspace();
    duplicateWorkspace.workItems.push(
      structuredClone(duplicateWorkspace.workItems[0]),
    );
    const duplicate = await executeUpdate(
      duplicateWorkspace,
      { title: "Duplicate target" },
      "block-duplicate-item",
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("Expected duplicate fail closed");
    expect(duplicate.rejection.code).toBe("HOLD_BLOCKS_COMMAND");

    const missingBetWorkspace = overdueScopeWorkspace();
    delete missingBetWorkspace.projects[0].activeBetId;
    const missingBet = await executeUpdate(
      missingBetWorkspace,
      { title: "Missing active Bet" },
      "block-missing-bet",
    );
    expect(missingBet.ok).toBe(false);
    if (missingBet.ok) throw new Error("Expected missing Bet fail closed");
    expect(missingBet.rejection.code).toBe("HOLD_BLOCKS_COMMAND");
  });
});

describe("Review semantic invariants", () => {
  function validReview(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
    return {
      id: "review-semantic",
      kind: "weekly",
      triggerKey: "weekly:2026-07-06",
      triggerType: "weekly",
      cadenceTimeZone: "UTC",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: "2026-07-12T18:00:00.000Z",
      createdAt: NOW,
      ...overrides,
    };
  }

  it("rejects duplicate Review identities and occurrences deterministically", () => {
    const duplicateId = buildWorkspaceV2("duplicate-review-id", {
      reviews: [
        validReview(),
        validReview({ triggerKey: "weekly:other", dueAt: NOW }),
      ],
    });
    const duplicateTrigger = buildWorkspaceV2("duplicate-review-trigger", {
      reviews: [
        validReview(),
        validReview({ id: "review-other" }),
      ],
    });

    expect(validateWorkspaceInvariants(duplicateId, NOW)).toContainEqual(
      expect.objectContaining({
        code: "SYNC_CONFLICT",
        gate: "review:review-semantic:identity",
        permittedNextCommand: "resolve_sync_conflict",
      }),
    );
    expect(validateWorkspaceInvariants(duplicateTrigger, NOW)).toContainEqual(
      expect.objectContaining({
        code: "SYNC_CONFLICT",
        gate: "review_trigger:weekly:2026-07-06",
        permittedNextCommand: "resolve_sync_conflict",
      }),
    );
  });

  it.each([
    [
      "open Review with conclusion",
      validReview({
        conclusion: {
          summary: "Should not exist yet",
          decisionCodes: ["continue"],
          followUpCommandIds: [],
          actorId: "human-1",
          completedAt: NOW,
        },
      }),
    ],
    ["completed Review without conclusion", validReview({ status: "completed" })],
    [
      "non-canonical Review time",
      validReview({ dueAt: "2026-07-12T18:00:00Z" }),
    ],
    [
      "event Review with a cadence timezone snapshot",
      validReview({
        kind: "event",
        triggerKey: "hard_gate:event-cadence",
        triggerType: "hard_gate",
        cadenceTimeZone: "UTC",
      }),
    ],
    [
      "malformed conclusion arrays",
      validReview({
        status: "completed",
        conclusion: {
          summary: "   ",
          decisionCodes: ["continue", " continue "],
          followUpCommandIds: ["   "],
          actorId: "human-1",
          completedAt: NOW,
        },
      }),
    ],
  ] as const)("rejects %s", (_name, review) => {
    const workspace = buildWorkspaceV2(`invalid-${review.id}`, {
      reviews: [structuredClone(review)],
    });

    expect(validateWorkspaceInvariants(workspace, NOW)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: `review:${review.id}:semantics`,
        permittedNextCommand: "repair_workspace_reference",
      }),
    );
  });

  it("fails malformed runtime cadence timezone values closed without throwing", () => {
    const workspace = buildWorkspaceV2("malformed-review-cadence", {
      capacityProfile: profile("UTC"),
      reviews: [validReview()],
    });
    (
      workspace.reviews[0] as unknown as { cadenceTimeZone: unknown }
    ).cadenceTimeZone = 123;

    expect(() => validateWorkspaceInvariants(workspace, NOW)).not.toThrow();
    expect(validateWorkspaceInvariants(workspace, NOW)).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: "review:review-semantic:semantics",
      }),
    );
    expect(() => deriveReviewQueue(workspace, NOW)).not.toThrow();
  });

  it("keeps legacy V2 weekly Reviews without a cadence snapshot writable", async () => {
    const workspace = buildWorkspaceV2("legacy-weekly-review", {
      capacityProfile: profile("UTC"),
      reviews: [validReview({ cadenceTimeZone: undefined })],
    });

    expect(validateWorkspaceInvariants(workspace, NOW)).toEqual([]);
    const captured = await executeCommand(
      workspace,
      {
        type: "capture_inbox",
        id: "legacy-workspace-capture",
        text: "The legacy workspace remains writable.",
      },
      commandContext(workspace.revision, {
        commandId: "capture-in-legacy-workspace",
      }),
    );
    expect(captured.ok).toBe(true);
  });

  it("keeps the cadence timezone snapshot byte-for-byte immutable", () => {
    const previous = buildWorkspaceV2("immutable-review-cadence", {
      capacityProfile: profile("UTC"),
      reviews: [validReview()],
    });
    const candidate = structuredClone(previous);
    candidate.reviews[0].cadenceTimeZone = "Etc/UTC";

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous),
    ).toContainEqual(
      expect.objectContaining({
        code: "INVALID_COMMAND",
        gate: "review:review-semantic:cadence_timezone",
      }),
    );
  });

  it("orders overdue marker time after creation and before conclusion", () => {
    const earlyMarker = buildWorkspaceV2("review-marker-before-create", {
      reviews: [
        validReview({
          dueAt: "2026-07-07T00:00:00.000Z",
          overdueMarkedAt: "2026-07-07T12:00:00.000Z",
        }),
      ],
    });
    const markerAfterConclusion = buildWorkspaceV2(
      "review-marker-after-conclusion",
      {
        reviews: [
          validReview({
            status: "completed",
            dueAt: "2026-07-09T00:00:00.000Z",
            overdueMarkedAt: "2026-07-10T00:00:00.000Z",
            conclusion: {
              summary: "Already concluded.",
              decisionCodes: ["continue"],
              followUpCommandIds: [],
              actorId: "human-1",
              completedAt: "2026-07-09T12:00:00.000Z",
            },
          }),
        ],
      },
    );

    for (const workspace of [earlyMarker, markerAfterConclusion]) {
      expect(
        validateWorkspaceInvariants(
          workspace,
          "2026-07-11T00:00:00.000Z",
        ),
      ).toContainEqual(
        expect.objectContaining({
          code: "INVALID_COMMAND",
          gate: "review:review-semantic:semantics",
        }),
      );
    }
  });

  it("rejects a completed Review that still owns an overdue Project hold", () => {
    const workspace = reviewCommandWorkspace();
    workspace.reviews[0] = {
      ...workspace.reviews[0],
      status: "completed",
      overdueMarkedAt: NOW,
      conclusion: {
        summary: "The Review was completed.",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: NOW,
      },
    };
    workspace.projects[0].holds = [
      {
        type: "review_overdue",
        sourceId: "review-overdue",
        affectedRecordIds: ["review-overdue", "review-project"],
        createdAt: NOW,
      },
    ];

    expect(validateWorkspaceInvariants(workspace, NOW)).toContainEqual(
      expect.objectContaining({
        code: "SYNC_CONFLICT",
        gate: "review:review-overdue:completed_hold",
      }),
    );
  });
});
