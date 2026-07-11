import { describe, expect, it } from "vitest";

import type { AttentionKind } from "@/domain/types";

import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  compareTodayCandidate,
  generateTodayProposal,
  type TodayCandidate,
} from "./today";
import type {
  Action,
  BetVersion,
  CapacityProfile,
  CommitmentSlot,
  DirectionBrief,
  ProjectDependency,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

const LOCAL_DATE = "2026-07-13";
const NOW = "2026-07-13T00:00:00.000Z";
const LOCAL_DAY_START = "2026-07-13T00:00:00.000Z";
const BET_START = "2026-07-12T00:00:00.000Z";
const BET_END = "2026-07-20T00:00:00.000Z";

const CAPACITY = buildCapacityProfile({
  timeZone: "Asia/Tokyo",
  weeklyWindows: [{ weekday: 1, startMinute: 540, finishMinute: 720 }],
  dailyBudgets: [
    {
      weekday: 1,
      deepSeconds: 7_200,
      mediumSeconds: 7_200,
      shallowSeconds: 7_200,
    },
  ],
  unavailableBlocks: [],
  updatedAt: BET_START,
  updatedBy: "human-1",
});

function action(
  id: string,
  overrides: Partial<Action> = {},
): Action {
  return {
    id,
    inboxItemId: `inbox-${id}`,
    title: id,
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
    attention: "deep",
    createdAt: BET_START,
    updatedAt: BET_START,
    ...overrides,
  };
}

function projectBundle(
  id: string,
  overrides: {
    project?: Partial<ProjectV2>;
    bet?: Partial<BetVersion>;
  } = {},
): {
  project: ProjectV2;
  brief: DirectionBrief;
  bet: BetVersion;
} {
  const brief = buildDirectionBrief({
    id: `brief-${id}`,
    projectId: id,
    firstScope: [
      { id: `scope-${id}`, title: "Scope", description: "Bounded scope" },
    ],
    appetiteSeconds: 691_200,
    createdAt: BET_START,
    updatedAt: BET_START,
  });
  const bet = buildBetVersion({
    id: `bet-${id}`,
    projectId: id,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: BET_START,
    appetiteEnd: BET_END,
    actorId: "human-1",
    approvedAt: BET_START,
    ...overrides.bet,
  });
  const project = buildProjectV2({
    id,
    stage: "planning",
    priority: 3,
    activeDirectionBriefId: brief.id,
    activeBetId: bet.id,
    createdAt: BET_START,
    updatedAt: BET_START,
    ...overrides.project,
  });
  return { project, brief, bet };
}

function workItem(
  projectId: string,
  id: string,
  overrides: Partial<ProjectWorkItem> = {},
): ProjectWorkItem {
  return {
    id,
    projectId,
    kind: "task",
    title: id,
    outline: id,
    durationSeconds: 1_800,
    estimate: { mostLikelySeconds: 1_800 },
    assignmentIds: [
      {
        resourceId: "resource-1",
        attention: "medium",
        effortSeconds: 1_800,
      },
    ],
    percentComplete: 0,
    revision: 1,
    betScopeId: `scope-${projectId}`,
    ...overrides,
  };
}

function workspace(
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  return buildWorkspaceV2("workspace-today", {
    revision: 7,
    capacityProfile: structuredClone(CAPACITY),
    ...overrides,
  });
}

function candidate(
  targetId: string,
  overrides: Partial<TodayCandidate> = {},
): TodayCandidate {
  return {
    targetId,
    targetRevision: 1,
    target: { kind: "action", actionId: targetId },
    durationSeconds: 900,
    attention: "shallow",
    hasFixedTimeOrHardDeadline: false,
    appetiteAndCriticalUrgency: 0,
    dependencyUnlockValue: 0,
    projectPriority: 0,
    eligibleSince: "2026-07-12T00:00:00.000Z",
    ...overrides,
  };
}

function slotTargets(slots: CommitmentSlot[]): string[] {
  return slots.map(({ target }) =>
    target.kind === "action" ? target.actionId : target.workItemId,
  );
}

describe("Today candidate ordering", () => {
  it("applies every ranking key in the required order", () => {
    const ordered = [
      candidate("id-z"),
      candidate("oldest", { eligibleSince: "2026-07-11T00:00:00.000Z" }),
      candidate("priority", { projectPriority: 4 }),
      candidate("unlock", { dependencyUnlockValue: 5 }),
      candidate("urgency", { appetiteAndCriticalUrgency: 6 }),
      candidate("fixed", { hasFixedTimeOrHardDeadline: true }),
      candidate("id-a"),
    ].sort(compareTodayCandidate);

    expect(ordered.map(({ targetId }) => targetId)).toEqual([
      "fixed",
      "urgency",
      "unlock",
      "priority",
      "oldest",
      "id-a",
      "id-z",
    ]);
  });
});

describe("generateTodayProposal", () => {
  it("is timezone-aware, deterministic, capacity-accounted, and pure", async () => {
    const bundle = projectBundle("project-1");
    const fixedAction = action("action-fixed", {
      fixedStart: LOCAL_DAY_START,
      attention: "deep",
    });
    const item = workItem(bundle.project.id, "work-item-1");
    const source = workspace({
      actions: [fixedAction],
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [item],
    });
    const before = structuredClone(source);

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);
    const repeated = await generateTodayProposal(source, LOCAL_DATE, NOW);
    const reversed = await generateTodayProposal(
      {
        ...structuredClone(source),
        actions: [...source.actions].reverse(),
        projects: [...source.projects].reverse(),
        directionBriefs: [...source.directionBriefs].reverse(),
        bets: [...source.bets].reverse(),
        workItems: [...source.workItems].reverse(),
      },
      LOCAL_DATE,
      NOW,
    );

    expect(proposal).toEqual(repeated);
    expect(proposal).toEqual(reversed);
    expect(source).toEqual(before);
    expect(proposal.workspaceRevision).toBe(7);
    expect(proposal.capacity).toEqual(source.capacityProfile);
    expect(proposal.capacity).not.toBe(source.capacityProfile);
    expect(proposal.localCapacity).toMatchObject({
      localDate: LOCAL_DATE,
      timeZone: "Asia/Tokyo",
      weekday: 1,
      availableIntervals: [
        {
          start: "2026-07-13T00:00:00.000Z",
          finish: "2026-07-13T03:00:00.000Z",
        },
      ],
    });
    expect(proposal.localCapacity).not.toBe(proposal.capacity);
    expect(slotTargets(proposal.slots)).toEqual([
      fixedAction.id,
      item.id,
    ]);
    expect(proposal.slots[0]).toMatchObject({
      id: `today-slot:${LOCAL_DATE}:action:${fixedAction.id}:1`,
      start: "2026-07-13T00:00:00.000Z",
      finish: "2026-07-13T00:30:00.000Z",
      attention: "deep" satisfies AttentionKind,
    });
    expect(proposal.capacityUsage).toEqual({
      deepSeconds: 1_800,
      mediumSeconds: 1_800,
      shallowSeconds: 0,
    });
    expect(proposal.later).toEqual([]);
    expect(proposal.proposalHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a defensive snapshot of the complete Capacity Profile", async () => {
    const source = workspace({ actions: [action("action-capacity-hash")] });
    const changedProfile = structuredClone(source);
    if (changedProfile.capacityProfile === undefined) {
      throw new Error("Expected Capacity Profile");
    }
    changedProfile.capacityProfile.dailyBudgets.push({
      weekday: 2,
      deepSeconds: 1_800,
      mediumSeconds: 900,
      shallowSeconds: 900,
    });

    const first = await generateTodayProposal(source, LOCAL_DATE, NOW);
    const changed = await generateTodayProposal(
      changedProfile,
      LOCAL_DATE,
      NOW,
    );

    expect(changed.localCapacity).toEqual(first.localCapacity);
    expect(changed.capacity).toEqual(changedProfile.capacityProfile);
    expect(changed.proposalHash).not.toBe(first.proposalHash);
  });

  it("ranks Actions and Work Items by the unfinished dependents they unlock", async () => {
    const actionUnlocker = action("action-z-unlocker", {
      createdAt: "2026-07-12T00:00:00.000Z",
    });
    const actionOrdinary = action("action-a-ordinary", {
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    const actionDependent = action("action-dependent", {
      eligibility: {
        ...action("template").eligibility,
        dependencyIds: [actionUnlocker.id],
      },
    });
    const actionProposal = await generateTodayProposal(
      workspace({
        actions: [actionOrdinary, actionUnlocker, actionDependent],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(slotTargets(actionProposal.slots)).toEqual([
      actionUnlocker.id,
      actionOrdinary.id,
    ]);
    expect(actionProposal.later).toContainEqual({
      targetId: actionDependent.id,
      reason: "DEPENDENCY_BLOCKED",
    });

    const bundle = projectBundle("unlock-project");
    const itemUnlocker = workItem(bundle.project.id, "work-z-unlocker");
    const itemOrdinary = workItem(bundle.project.id, "work-a-ordinary");
    const itemFalseUnlocker = workItem(bundle.project.id, "work-a-false-unlocker");
    const itemDependent = workItem(bundle.project.id, "work-dependent");
    const blockedDependent = workItem(bundle.project.id, "work-blocked-dependent", {
      resultStatus: "blocked",
    });
    const itemProposal = await generateTodayProposal(
      workspace({
        projects: [bundle.project],
        directionBriefs: [bundle.brief],
        bets: [bundle.bet],
        workItems: [
          itemOrdinary,
          itemFalseUnlocker,
          itemUnlocker,
          itemDependent,
          blockedDependent,
        ],
        dependencies: [
          {
            id: "dependency-unlock-ranking",
            projectId: bundle.project.id,
            fromId: itemUnlocker.id,
            toId: itemDependent.id,
            type: "FS",
            lagSeconds: 0,
            revision: 1,
          },
          {
            id: "dependency-does-not-unlock-terminal-work",
            projectId: bundle.project.id,
            fromId: itemFalseUnlocker.id,
            toId: blockedDependent.id,
            type: "FS",
            lagSeconds: 0,
            revision: 1,
          },
        ],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(slotTargets(itemProposal.slots)).toEqual([
      itemUnlocker.id,
      itemFalseUnlocker.id,
      itemOrdinary.id,
    ]);
    expect(itemProposal.later).toContainEqual({
      targetId: itemDependent.id,
      reason: "DEPENDENCY_BLOCKED",
    });
  });

  it("ages project work from the Bet eligibility boundary instead of project creation", async () => {
    const newerBet = projectBundle("project-created-first", {
      project: { createdAt: "2026-07-01T00:00:00.000Z" },
      bet: {
        appetiteStart: "2026-07-12T00:00:00.000Z",
        approvedAt: "2026-07-12T00:00:00.000Z",
      },
    });
    const olderBet = projectBundle("project-created-last", {
      project: { createdAt: "2026-07-12T00:00:00.000Z" },
      bet: {
        appetiteStart: "2026-07-10T00:00:00.000Z",
        approvedAt: "2026-07-10T00:00:00.000Z",
      },
    });
    const newerBetItem = workItem(newerBet.project.id, "work-a-newer-bet");
    const olderBetItem = workItem(olderBet.project.id, "work-z-older-bet");
    const proposal = await generateTodayProposal(
      workspace({
        projects: [newerBet.project, olderBet.project],
        directionBriefs: [newerBet.brief, olderBet.brief],
        bets: [newerBet.bet, olderBet.bet],
        workItems: [newerBetItem, olderBetItem],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(slotTargets(proposal.slots)).toEqual([
      olderBetItem.id,
      newerBetItem.id,
    ]);
  });

  it("keeps blocked and expired work in Later while excluding ineligible records", async () => {
    const active = projectBundle("active");
    const expired = projectBundle("expired", {
      bet: { appetiteEnd: NOW },
    });
    const unbet = projectBundle("unbet", {
      project: { activeBetId: undefined },
    });
    const invalid = projectBundle("invalid", {
      bet: { invalidatedAt: NOW },
    });
    const migration = projectBundle("migration", {
      project: {
        holds: [
          {
            type: "migration_review",
            sourceId: "migration-source",
            affectedRecordIds: ["migration"],
            createdAt: BET_START,
          },
        ],
      },
    });
    const rebet = projectBundle("rebet", {
      project: {
        holds: [
          {
            type: "rebet_required",
            sourceId: "rebet-source",
            affectedRecordIds: ["rebet"],
            createdAt: BET_START,
          },
        ],
      },
    });
    const blocker = workItem(active.project.id, "work-blocker");
    const blocked = workItem(active.project.id, "work-blocked");
    const completed = workItem(active.project.id, "work-completed", {
      resultStatus: "completed",
    });
    const dependency: ProjectDependency = {
      id: "dependency-blocked",
      projectId: active.project.id,
      fromId: blocker.id,
      toId: blocked.id,
      type: "FS",
      lagSeconds: 0,
      revision: 1,
    };
    const source = workspace({
      actions: [
        action("action-open", { fixedStart: LOCAL_DAY_START }),
        action("action-completed", { status: "completed" }),
        action("action-promoted", { status: "promoted" }),
      ],
      projects: [
        active.project,
        expired.project,
        unbet.project,
        invalid.project,
        migration.project,
        rebet.project,
      ],
      directionBriefs: [
        active.brief,
        expired.brief,
        unbet.brief,
        invalid.brief,
        migration.brief,
        rebet.brief,
      ],
      bets: [
        active.bet,
        expired.bet,
        invalid.bet,
        migration.bet,
        rebet.bet,
      ],
      workItems: [
        blocker,
        blocked,
        completed,
        workItem(expired.project.id, "work-expired", {
          constraint: { fixedStart: "2026-07-14T00:00:00.000Z" },
        }),
        workItem(unbet.project.id, "work-unbet"),
        workItem(invalid.project.id, "work-invalid"),
        workItem(migration.project.id, "work-migration"),
        workItem(rebet.project.id, "work-rebet"),
      ],
      dependencies: [dependency],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);
    const reversedSource = structuredClone(source);
    reversedSource.actions.reverse();
    reversedSource.projects.reverse();
    reversedSource.directionBriefs.reverse();
    reversedSource.bets.reverse();
    reversedSource.workItems.reverse();
    reversedSource.dependencies.reverse();
    const reversedProposal = await generateTodayProposal(
      reversedSource,
      LOCAL_DATE,
      NOW,
    );
    const scheduledOrLater = [
      ...slotTargets(proposal.slots),
      ...proposal.later.map(({ targetId }) => targetId),
    ];

    expect(reversedProposal).toEqual(proposal);
    expect(slotTargets(proposal.slots)).toEqual([
      "action-open",
      blocker.id,
    ]);
    expect(proposal.later).toEqual([
      { targetId: "work-expired", reason: "BET_EXPIRED" },
      { targetId: blocked.id, reason: "DEPENDENCY_BLOCKED" },
    ]);
    for (const excludedId of [
        "action-completed",
        "action-promoted",
        completed.id,
        "work-unbet",
        "work-invalid",
        "work-migration",
        "work-rebet",
    ]) {
      expect(scheduledOrLater).not.toContain(excludedId);
    }
  });

  it("removes globally affected Action, Project, Bet, Plan, and Work Item records only", async () => {
    const affectedAction = action("action-sync-affected");
    const unrelatedAction = action("action-sync-unrelated", {
      fixedStart: LOCAL_DAY_START,
    });
    const affectedProject = projectBundle("sync-affected-project");
    const affectedBet = projectBundle("sync-affected-bet");
    const affectedPlan = projectBundle("sync-affected-plan", {
      project: { activePlanVersionId: "plan-sync-affected" },
    });
    const affectedItem = projectBundle("sync-affected-item");
    const carrier = projectBundle("sync-carrier", {
      project: {
        holds: [
          {
            type: "sync_conflict",
            sourceId: "conflict-1",
            affectedRecordIds: [
              affectedAction.id,
              affectedProject.project.id,
              affectedBet.bet.id,
              "plan-sync-affected",
              "work-sync-affected",
            ],
            createdAt: BET_START,
          },
        ],
      },
    });
    const bundles = [
      carrier,
      affectedProject,
      affectedBet,
      affectedPlan,
      affectedItem,
    ];
    const source = workspace({
      actions: [affectedAction, unrelatedAction],
      projects: bundles.map(({ project }) => project),
      directionBriefs: bundles.map(({ brief }) => brief),
      bets: bundles.map(({ bet }) => bet),
      workItems: [
        workItem(carrier.project.id, "work-sync-unrelated"),
        workItem(affectedProject.project.id, "work-project-affected"),
        workItem(affectedBet.project.id, "work-bet-affected"),
        workItem(affectedPlan.project.id, "work-plan-affected"),
        workItem(affectedItem.project.id, "work-sync-affected"),
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(slotTargets(proposal.slots)).toEqual([
      unrelatedAction.id,
      "work-sync-unrelated",
    ]);
    expect(proposal.later).toEqual([]);
  });

  it("requires ordinary Work Items to survive the executable projection", async () => {
    const item = workItem("projection-project", "work-in-conflicted-commitment");
    const bundle = projectBundle("projection-project", {
      project: {
        holds: [
          {
            type: "sync_conflict",
            sourceId: "conflict-commitment",
            affectedRecordIds: ["commitment-conflicted"],
            createdAt: BET_START,
          },
        ],
      },
    });
    const source = workspace({
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [item],
      dailyCommitments: [
        {
          id: "commitment-conflicted",
          localDate: LOCAL_DATE,
          version: 1,
          proposalHash: "conflicted",
          capacitySnapshot: structuredClone(CAPACITY),
          slots: [
            {
              id: "slot-conflicted",
              target: {
                kind: "work_item",
                workItemId: item.id,
                projectId: bundle.project.id,
              },
              targetRevision: item.revision,
              start: LOCAL_DAY_START,
              finish: "2026-07-13T00:30:00.000Z",
              attention: "medium",
            },
          ],
          actorId: "human-1",
          committedAt: NOW,
        },
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([]);
  });

  it("treats blocked work as terminal without letting it unlock successors", async () => {
    const bundle = projectBundle("blocked-project");
    const blocker = workItem(bundle.project.id, "work-terminal-blocked", {
      resultStatus: "blocked",
    });
    const successor = workItem(bundle.project.id, "work-after-blocked");
    const source = workspace({
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [blocker, successor],
      dependencies: [
        {
          id: "dependency-after-blocked",
          projectId: bundle.project.id,
          fromId: blocker.id,
          toId: successor.id,
          type: "FS",
          lagSeconds: 0,
          revision: 1,
        },
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([
      { targetId: successor.id, reason: "DEPENDENCY_BLOCKED" },
    ]);
  });

  it("freezes effective committed slots despite entity deletion or revision drift", async () => {
    const committedAction = action("action-preserved", {
      attention: "shallow",
      eligibility: {
        ...action("template").eligibility,
        estimateSeconds: 900,
      },
    });
    const uncommittedAction = action("action-not-committed");
    const actionSlot: CommitmentSlot = {
      id: "slot-action-effective",
      target: { kind: "action", actionId: committedAction.id },
      targetRevision: committedAction.revision,
      start: "2026-07-13T00:00:00.000Z",
      finish: "2026-07-13T00:15:00.000Z",
      attention: "shallow",
    };
    const other = projectBundle("other-project");
    const otherItem = workItem(other.project.id, "work-other-project");
    const uncommittedOtherItem = workItem(
      other.project.id,
      "work-not-committed",
    );
    const otherProjectSlot: CommitmentSlot = {
      id: "slot-other-project-effective",
      target: {
        kind: "work_item",
        workItemId: otherItem.id,
        projectId: other.project.id,
      },
      targetRevision: otherItem.revision,
      start: "2026-07-13T00:15:00.000Z",
      finish: "2026-07-13T00:30:00.000Z",
      attention: "medium",
    };
    const exactSlot: CommitmentSlot = {
      id: "slot-effective",
      target: {
        kind: "work_item",
        workItemId: "work-preserved",
        projectId: "review-project",
      },
      targetRevision: 2,
      start: "2026-07-13T00:30:00.000Z",
      finish: "2026-07-13T01:00:00.000Z",
      attention: "medium",
    };
    const bundle = projectBundle("review-project", {
      project: {
        holds: [
          {
            type: "review_overdue",
            sourceId: "review-1",
            affectedRecordIds: ["review-project"],
            createdAt: BET_START,
          },
        ],
      },
    });
    const losingSlot: CommitmentSlot = {
      ...structuredClone(exactSlot),
      id: "slot-losing-fork",
      target: {
        kind: "work_item",
        workItemId: "work-not-preserved",
        projectId: bundle.project.id,
      },
      targetRevision: 1,
    };
    const effectiveSlots = [actionSlot, otherProjectSlot, exactSlot];
    const source = workspace({
      actions: [uncommittedAction],
      projects: [bundle.project, other.project],
      directionBriefs: [bundle.brief, other.brief],
      bets: [bundle.bet, other.bet],
      workItems: [
        workItem(bundle.project.id, "work-preserved", { revision: 3 }),
        workItem(bundle.project.id, "work-not-preserved"),
        otherItem,
        uncommittedOtherItem,
      ],
      dailyCommitments: [
        {
          id: "commitment-losing-fork",
          localDate: LOCAL_DATE,
          version: 1,
          proposalHash: "losing",
          capacitySnapshot: structuredClone(CAPACITY),
          slots: [losingSlot],
          actorId: "human-1",
          committedAt: "2026-07-12T23:00:00.000Z",
        },
        {
          id: "commitment-effective",
          localDate: LOCAL_DATE,
          version: 2,
          proposalHash: "effective",
          capacitySnapshot: structuredClone(CAPACITY),
          slots: effectiveSlots,
          actorId: "human-1",
          committedAt: NOW,
        },
      ],
    });
    const before = structuredClone(source.dailyCommitments);

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(proposal.slots).toEqual(effectiveSlots);
    expect(proposal.capacityUsage).toEqual({
      deepSeconds: 0,
      mediumSeconds: 2_700,
      shallowSeconds: 900,
    });
    expect(source.dailyCommitments).toEqual(before);
    expect(proposal.slots[0]).not.toBe(effectiveSlots[0]);
  });

  it("filters frozen slots only when structured sync conflict IDs hit them", async () => {
    const affectedAction = action("action-sync-affected", {
      attention: "shallow",
    });
    const unrelatedAction = action("action-sync-unrelated", {
      attention: "shallow",
    });
    const affectedSlot: CommitmentSlot = {
      id: "slot-sync-affected",
      target: { kind: "action", actionId: affectedAction.id },
      targetRevision: affectedAction.revision,
      start: "2026-07-13T00:00:00.000Z",
      finish: "2026-07-13T00:30:00.000Z",
      attention: "shallow",
    };
    const unrelatedSlot: CommitmentSlot = {
      id: "slot-sync-unrelated",
      target: { kind: "action", actionId: unrelatedAction.id },
      targetRevision: unrelatedAction.revision,
      start: "2026-07-13T00:30:00.000Z",
      finish: "2026-07-13T01:00:00.000Z",
      attention: "shallow",
    };
    const bundle = projectBundle("review-sync-project", {
      project: {
        holds: [
          {
            type: "review_overdue",
            sourceId: "review-overdue-1",
            affectedRecordIds: ["review-sync-project"],
            createdAt: BET_START,
          },
          {
            type: "sync_conflict",
            sourceId: "sync-conflict-1",
            affectedRecordIds: [affectedSlot.id],
            createdAt: BET_START,
          },
        ],
      },
    });
    const source = workspace({
      actions: [affectedAction, unrelatedAction],
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      dailyCommitments: [
        {
          id: "commitment-sync-filter",
          localDate: LOCAL_DATE,
          version: 1,
          proposalHash: "sync-filter",
          capacitySnapshot: structuredClone(CAPACITY),
          slots: [affectedSlot, unrelatedSlot],
          actorId: "human-1",
          committedAt: NOW,
        },
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(proposal.slots).toEqual([unrelatedSlot]);
  });

  it("keeps every capacity rejection in Later with a stable reason", async () => {
    const constrainedCapacity: CapacityProfile = {
      ...structuredClone(CAPACITY),
      dailyBudgets: [
        {
          weekday: 1,
          deepSeconds: 3_600,
          mediumSeconds: 7_200,
          shallowSeconds: 7_200,
        },
      ],
      unavailableBlocks: [
        {
          id: "unavailable-1",
          start: "2026-07-13T01:00:00.000Z",
          finish: "2026-07-13T01:30:00.000Z",
        },
      ],
    };
    const source = workspace({
      capacityProfile: constrainedCapacity,
      actions: [
        action("action-deep-a", {
          eligibility: {
            ...action("template").eligibility,
            estimateSeconds: 3_600,
          },
          createdAt: "2026-07-10T00:00:00.000Z",
        }),
        action("action-deep-b", {
          eligibility: {
            ...action("template").eligibility,
            estimateSeconds: 3_600,
          },
          createdAt: "2026-07-11T00:00:00.000Z",
        }),
        action("action-unavailable", {
          fixedStart: "2026-07-13T01:00:00.000Z",
          attention: "shallow",
        }),
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);
    const allTargetIds = [
      ...slotTargets(proposal.slots),
      ...proposal.later.map(({ targetId }) => targetId),
    ].sort();

    expect(slotTargets(proposal.slots)).toEqual(["action-deep-a"]);
    expect(proposal.later).toEqual([
      { targetId: "action-unavailable", reason: "OUTSIDE_WORK_WINDOW" },
      { targetId: "action-deep-b", reason: "DEEP_CAPACITY_EXHAUSTED" },
    ]);
    expect(allTargetIds).toEqual([
      "action-deep-a",
      "action-deep-b",
      "action-unavailable",
    ]);
  });

  it("uses projected dependency dates instead of scheduling lagged work early", async () => {
    const bundle = projectBundle("lagged-project");
    const predecessor = workItem(bundle.project.id, "work-predecessor", {
      resultStatus: "completed",
    });
    const lagged = workItem(bundle.project.id, "work-lagged");
    const source = workspace({
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [predecessor, lagged],
      dependencies: [
        {
          id: "dependency-with-lag",
          projectId: bundle.project.id,
          fromId: predecessor.id,
          toId: lagged.id,
          type: "FS",
          lagSeconds: 172_800,
          revision: 1,
        },
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([
      { targetId: lagged.id, reason: "DEPENDENCY_BLOCKED" },
    ]);
  });

  it("does not place a successor before its same-day projected 15:00 start", async () => {
    const bundle = projectBundle("same-day-projection-project");
    const predecessor = workItem(bundle.project.id, "work-same-day-predecessor", {
      resultStatus: "completed",
    });
    const successor = workItem(bundle.project.id, "work-same-day-successor");
    const fullDayCapacity: CapacityProfile = {
      ...structuredClone(CAPACITY),
      weeklyWindows: [
        { weekday: 1, startMinute: 9 * 60, finishMinute: 17 * 60 },
      ],
    };
    const proposal = await generateTodayProposal(
      workspace({
        capacityProfile: fullDayCapacity,
        projects: [bundle.project],
        directionBriefs: [bundle.brief],
        bets: [bundle.bet],
        workItems: [predecessor, successor],
        dependencies: [
          {
            id: "dependency-same-day-15",
            projectId: bundle.project.id,
            fromId: predecessor.id,
            toId: successor.id,
            type: "FS",
            lagSeconds: 106_200,
            revision: 1,
          },
        ],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(proposal.slots).toMatchObject([
      {
        target: { kind: "work_item", workItemId: successor.id },
        start: "2026-07-13T06:00:00.000Z",
        finish: "2026-07-13T06:30:00.000Z",
      },
    ]);
  });

  it("uses the scheduler projection for an unfinished SS lag-zero successor", async () => {
    const bundle = projectBundle("ss-project");
    const predecessor = workItem(bundle.project.id, "work-ss-predecessor");
    const successor = workItem(bundle.project.id, "work-ss-successor");
    const source = workspace({
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [predecessor, successor],
      dependencies: [
        {
          id: "dependency-ss-zero",
          projectId: bundle.project.id,
          fromId: predecessor.id,
          toId: successor.id,
          type: "SS",
          lagSeconds: 0,
          revision: 1,
        },
      ],
    });

    const proposal = await generateTodayProposal(source, LOCAL_DATE, NOW);

    expect(slotTargets(proposal.slots)).toEqual([
      predecessor.id,
      successor.id,
    ]);
    expect(proposal.later).toEqual([]);
  });

  it("enforces same-day 11:00 earliest-start and 15:00 latest-finish bounds", async () => {
    const earliestBundle = projectBundle("earliest-bound-project");
    const earliestItem = workItem(
      earliestBundle.project.id,
      "work-earliest-11",
      {
        constraint: { noEarlierThan: "2026-07-13T02:00:00.000Z" },
      },
    );
    const earliestProposal = await generateTodayProposal(
      workspace({
        projects: [earliestBundle.project],
        directionBriefs: [earliestBundle.brief],
        bets: [earliestBundle.bet],
        workItems: [earliestItem],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(earliestProposal.slots).toMatchObject([
      {
        target: { kind: "work_item", workItemId: earliestItem.id },
        start: "2026-07-13T02:00:00.000Z",
        finish: "2026-07-13T02:30:00.000Z",
      },
    ]);

    const latestBundle = projectBundle("latest-bound-project");
    const latestItem = workItem(latestBundle.project.id, "work-latest-15", {
      durationSeconds: 7_200,
      estimate: { mostLikelySeconds: 7_200 },
      constraint: { noLaterThan: "2026-07-13T06:00:00.000Z" },
    });
    const afternoonCapacity: CapacityProfile = {
      ...structuredClone(CAPACITY),
      weeklyWindows: [
        { weekday: 1, startMinute: 14 * 60, finishMinute: 17 * 60 },
      ],
    };
    const latestProposal = await generateTodayProposal(
      workspace({
        capacityProfile: afternoonCapacity,
        projects: [latestBundle.project],
        directionBriefs: [latestBundle.brief],
        bets: [latestBundle.bet],
        workItems: [latestItem],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(latestProposal.slots).toEqual([]);
    expect(latestProposal.later).toEqual([
      { targetId: latestItem.id, reason: "OUTSIDE_WORK_WINDOW" },
    ]);
  });

  it("keeps an active-Bet Work Item with a future fixed constraint in Later", async () => {
    const bundle = projectBundle("future-constraint-project");
    const item = workItem(bundle.project.id, "work-future-constraint", {
      constraint: { fixedStart: "2026-07-14T00:00:00.000Z" },
    });
    const proposal = await generateTodayProposal(
      workspace({
        projects: [bundle.project],
        directionBriefs: [bundle.brief],
        bets: [bundle.bet],
        workItems: [item],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([
      { targetId: item.id, reason: "OUTSIDE_WORK_WINDOW" },
    ]);
  });

  it("rejects generation for a local date before today", async () => {
    const source = workspace();

    await expect(
      generateTodayProposal(source, "2026-07-12", NOW),
    ).rejects.toThrowError(RangeError);
  });

  it("allows future dates only while the Bet is still active", async () => {
    const within = projectBundle("future-within", {
      bet: { appetiteEnd: "2026-07-21T00:00:00.000Z" },
    });
    const expired = projectBundle("future-expired", {
      bet: { appetiteEnd: "2026-07-15T00:00:00.000Z" },
    });
    const withinItem = workItem(within.project.id, "work-future-within");
    const expiredItem = workItem(expired.project.id, "work-future-expired");

    const withinProposal = await generateTodayProposal(
      workspace({
        projects: [within.project],
        directionBriefs: [within.brief],
        bets: [within.bet],
        workItems: [withinItem],
      }),
      "2026-07-20",
      NOW,
    );
    const expiredProposal = await generateTodayProposal(
      workspace({
        projects: [expired.project],
        directionBriefs: [expired.brief],
        bets: [expired.bet],
        workItems: [expiredItem],
      }),
      "2026-07-20",
      NOW,
    );

    expect(slotTargets(withinProposal.slots)).toEqual([withinItem.id]);
    expect(withinProposal.later).toEqual([]);
    expect(expiredProposal.slots).toEqual([]);
    expect(expiredProposal.later).toEqual([
      { targetId: expiredItem.id, reason: "BET_EXPIRED" },
    ]);
  });

  it.each([
    {
      name: "fixed start outside the work window",
      constraint: { fixedStart: "2026-07-20T04:00:00.000Z" },
    },
    {
      name: "no-earlier bound after the work window",
      constraint: { noEarlierThan: "2026-07-20T04:00:00.000Z" },
    },
    {
      name: "fixed start inside the work window",
      constraint: { fixedStart: "2026-07-20T00:30:00.000Z" },
    },
  ])(
    "classifies a future $name as Bet-expired before capacity placement",
    async ({ constraint }) => {
      const expired = projectBundle(`future-expired-${Object.keys(constraint)[0]}`, {
        bet: { appetiteEnd: "2026-07-15T00:00:00.000Z" },
      });
      const expiredItem = workItem(
        expired.project.id,
        `work-${expired.project.id}`,
        { constraint },
      );

      const proposal = await generateTodayProposal(
        workspace({
          projects: [expired.project],
          directionBriefs: [expired.brief],
          bets: [expired.bet],
          workItems: [expiredItem],
        }),
        "2026-07-20",
        NOW,
      );

      expect(proposal.slots).toEqual([]);
      expect(proposal.later).toEqual([
        { targetId: expiredItem.id, reason: "BET_EXPIRED" },
      ]);
    },
  );

  it.each([
    {
      name: "fixed start beyond the work window",
      constraint: { fixedStart: "2026-07-13T04:00:00.000Z" },
    },
    {
      name: "no-earlier bound beyond the work window",
      constraint: { noEarlierThan: "2026-07-13T04:00:00.000Z" },
    },
    {
      name: "fixed start inside capacity but after the boundary",
      constraint: { fixedStart: "2026-07-13T01:30:00.000Z" },
    },
  ])(
    "classifies a same-day $name as Bet-expired before capacity placement",
    async ({ constraint }) => {
      const expired = projectBundle(`same-day-expired-${Object.keys(constraint)[0]}`, {
        bet: { appetiteEnd: "2026-07-13T01:00:00.000Z" },
      });
      const expiredItem = workItem(
        expired.project.id,
        `work-${expired.project.id}`,
        { constraint },
      );

      const proposal = await generateTodayProposal(
        workspace({
          projects: [expired.project],
          directionBriefs: [expired.brief],
          bets: [expired.bet],
          workItems: [expiredItem],
        }),
        LOCAL_DATE,
        NOW,
      );

      expect(proposal.slots).toEqual([]);
      expect(proposal.later).toEqual([
        { targetId: expiredItem.id, reason: "BET_EXPIRED" },
      ]);
    },
  );

  it("allows a project slot at the Bet boundary but rejects one crossing it", async () => {
    const exact = projectBundle("boundary-exact", {
      bet: { appetiteEnd: "2026-07-13T00:30:00.000Z" },
    });
    const crossing = projectBundle("boundary-crossing", {
      bet: { appetiteEnd: "2026-07-13T00:30:00.000Z" },
    });
    const exactItem = workItem(exact.project.id, "work-boundary-exact");
    const crossingItem = workItem(crossing.project.id, "work-boundary-crossing", {
      durationSeconds: 1_801,
      estimate: { mostLikelySeconds: 1_801 },
    });

    const exactProposal = await generateTodayProposal(
      workspace({
        projects: [exact.project],
        directionBriefs: [exact.brief],
        bets: [exact.bet],
        workItems: [exactItem],
      }),
      LOCAL_DATE,
      NOW,
    );
    const crossingProposal = await generateTodayProposal(
      workspace({
        projects: [crossing.project],
        directionBriefs: [crossing.brief],
        bets: [crossing.bet],
        workItems: [crossingItem],
      }),
      LOCAL_DATE,
      NOW,
    );

    expect(exactProposal.slots[0]?.finish).toBe(
      "2026-07-13T00:30:00.000Z",
    );
    expect(exactProposal.later).toEqual([]);
    expect(crossingProposal.slots).toEqual([]);
    expect(crossingProposal.later).toEqual([
      { targetId: crossingItem.id, reason: "BET_EXPIRED" },
    ]);
  });

  it("keeps work that exceeds the current day's remaining wall time in Later", async () => {
    const bundle = projectBundle("remaining-time-project");
    const item = workItem(bundle.project.id, "work-too-long", {
      durationSeconds: 3_600,
      estimate: { mostLikelySeconds: 3_600 },
    });
    const source = workspace({
      projects: [bundle.project],
      directionBriefs: [bundle.brief],
      bets: [bundle.bet],
      workItems: [item],
    });

    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      "2026-07-13T02:30:00.000Z",
    );

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([
      { targetId: item.id, reason: "OUTSIDE_WORK_WINDOW" },
    ]);
  });

  it("subtracts every same-day Actual recorded by now from remaining attention capacity", async () => {
    const completed = action("action-actual-completed", { status: "completed" });
    const candidate = action("action-after-actual", {
      eligibility: {
        ...action("template").eligibility,
        estimateSeconds: 1_800,
      },
    });
    const constrainedCapacity: CapacityProfile = {
      ...structuredClone(CAPACITY),
      dailyBudgets: [
        {
          weekday: 1,
          deepSeconds: 3_600,
          mediumSeconds: 7_200,
          shallowSeconds: 7_200,
        },
      ],
    };
    const source = workspace({
      capacityProfile: constrainedCapacity,
      actions: [completed, candidate],
      actuals: [
        {
          id: "actual-before-now-1",
          revision: 1,
          target: { kind: "action", actionId: completed.id },
          actualWorkSeconds: 1_800,
          remainingWorkSeconds: 1_800,
          actualCost: 0,
          recordedAt: "2026-07-13T00:15:00.000Z",
        },
        {
          id: "actual-before-now-2",
          revision: 1,
          target: { kind: "action", actionId: completed.id },
          actualWorkSeconds: 1_800,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: "2026-07-13T00:45:00.000Z",
        },
        {
          id: "actual-previous-day",
          revision: 1,
          target: { kind: "action", actionId: completed.id },
          actualWorkSeconds: 3_600,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: "2026-07-12T00:45:00.000Z",
        },
        {
          id: "actual-after-now",
          revision: 1,
          target: { kind: "action", actionId: completed.id },
          actualWorkSeconds: 3_600,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: "2026-07-13T01:15:00.000Z",
        },
      ],
    });

    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      "2026-07-13T01:00:00.000Z",
    );

    expect(proposal.slots).toEqual([]);
    expect(proposal.later).toEqual([
      { targetId: candidate.id, reason: "DEEP_CAPACITY_EXHAUSTED" },
    ]);
    expect(proposal.capacityUsage).toEqual({
      deepSeconds: 3_600,
      mediumSeconds: 0,
      shallowSeconds: 0,
    });
  });

  it("does not let a future Actual complete or resize a candidate early", async () => {
    const candidate = action("action-future-actual", {
      eligibility: {
        ...action("template").eligibility,
        estimateSeconds: 1_800,
      },
    });
    const proposal = await generateTodayProposal(
      workspace({
        actions: [candidate],
        actuals: [
          {
            id: "actual-not-yet-recorded",
            revision: 1,
            target: { kind: "action", actionId: candidate.id },
            actualWorkSeconds: 1_800,
            remainingWorkSeconds: 0,
            actualCost: 0,
            recordedAt: "2026-07-13T01:15:00.000Z",
          },
        ],
      }),
      LOCAL_DATE,
      "2026-07-13T01:00:00.000Z",
    );

    expect(proposal.slots).toMatchObject([
      {
        target: { kind: "action", actionId: candidate.id },
        start: "2026-07-13T01:00:00.000Z",
        finish: "2026-07-13T01:30:00.000Z",
      },
    ]);
    expect(proposal.capacityUsage.deepSeconds).toBe(1_800);
  });

  it("fails closed when a counted Actual has no current target attention", async () => {
    await expect(
      generateTodayProposal(
        workspace({
          actuals: [
            {
              id: "actual-missing-target",
              revision: 1,
              target: { kind: "action", actionId: "action-missing" },
              actualWorkSeconds: 900,
              remainingWorkSeconds: 0,
              actualCost: 0,
              recordedAt: "2026-07-13T00:30:00.000Z",
            },
          ],
        }),
        LOCAL_DATE,
        "2026-07-13T01:00:00.000Z",
      ),
    ).rejects.toThrow(/Actual actual-missing-target.*target attention/i);
  });

  it("keeps review-overdue slots exact while usage counts Actuals and only unelapsed committed time", async () => {
    const committedAction = action("action-review-usage", {
      attention: "shallow",
    });
    const bundle = projectBundle("review-usage-project", {
      project: {
        holds: [
          {
            type: "review_overdue",
            sourceId: "review-usage",
            affectedRecordIds: ["review-usage-project"],
            createdAt: BET_START,
          },
        ],
      },
    });
    const committedSlots: CommitmentSlot[] = [
      {
        id: "slot-review-past",
        target: { kind: "action", actionId: committedAction.id },
        targetRevision: committedAction.revision,
        start: "2026-07-13T00:00:00.000Z",
        finish: "2026-07-13T00:30:00.000Z",
        attention: "shallow",
      },
      {
        id: "slot-review-future",
        target: {
          kind: "work_item",
          workItemId: "deleted-work-item",
          projectId: bundle.project.id,
        },
        targetRevision: 4,
        start: "2026-07-13T01:00:00.000Z",
        finish: "2026-07-13T01:30:00.000Z",
        attention: "medium",
      },
    ];
    const proposal = await generateTodayProposal(
      workspace({
        actions: [committedAction],
        projects: [bundle.project],
        directionBriefs: [bundle.brief],
        bets: [bundle.bet],
        actuals: [
          {
            id: "actual-review-past",
            revision: 1,
            target: { kind: "action", actionId: committedAction.id },
            actualWorkSeconds: 600,
            remainingWorkSeconds: 1_200,
            actualCost: 0,
            recordedAt: "2026-07-13T00:15:00.000Z",
          },
        ],
        dailyCommitments: [
          {
            id: "commitment-review-usage",
            localDate: LOCAL_DATE,
            version: 1,
            proposalHash: "review-usage",
            capacitySnapshot: structuredClone(CAPACITY),
            slots: committedSlots,
            actorId: "human-1",
            committedAt: NOW,
          },
        ],
      }),
      LOCAL_DATE,
      "2026-07-13T00:45:00.000Z",
    );

    expect(proposal.slots).toEqual(committedSlots);
    expect(proposal.capacityUsage).toEqual({
      deepSeconds: 0,
      mediumSeconds: 1_800,
      shallowSeconds: 600,
    });
  });
});
