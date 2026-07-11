import { describe, expect, it } from "vitest";

import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type DailyCommitmentDraft,
  type V2Command,
} from "./commands";
import {
  buildReplanProposal,
  generateTodayProposal,
  TODAY_PROPOSAL_MAX_AGE_SECONDS,
  type TodayProposal,
} from "./today";
import type {
  ActualV2,
  CapacityProfile,
  DailyCommitment,
  ProjectDependency,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

const LOCAL_DATE = "2026-07-13";
const GENERATED_AT = "2026-07-13T00:00:00.000Z";
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

const WORK_ITEM_1: ProjectWorkItem = {
  id: "work-1",
  projectId: "project-1",
  kind: "task",
  title: "First",
  outline: "1",
  durationSeconds: 1_800,
  estimate: { mostLikelySeconds: 1_800 },
  assignmentIds: [],
  percentComplete: 0,
  revision: 3,
  betScopeId: "scope-1",
};

const WORK_ITEM_2: ProjectWorkItem = {
  ...WORK_ITEM_1,
  id: "work-2",
  title: "Second",
  outline: "2",
  revision: 5,
};

const DEPENDENCY: ProjectDependency = {
  id: "dependency-1",
  projectId: "project-1",
  fromId: WORK_ITEM_1.id,
  toId: WORK_ITEM_2.id,
  type: "FS",
  lagSeconds: 0,
  revision: 2,
};

function context(
  revision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId: `command-${revision}`,
    expectedRevision: revision,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "human-session-1",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: GENERATED_AT,
    ...overrides,
  };
}

function projectWorkspace(
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    appetiteSeconds: 691_200,
    firstScope: [
      { id: "scope-1", title: "Scope", description: "Committed scope" },
    ],
    createdAt: BET_START,
    updatedAt: BET_START,
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: "project-1",
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: BET_START,
    appetiteEnd: BET_END,
    actorId: "human-1",
    approvedAt: BET_START,
  });
  return buildWorkspaceV2("workspace-1", {
    revision: 7,
    capacityProfile: structuredClone(CAPACITY),
    projects: [
      buildProjectV2({
        id: "project-1",
        stage: "planning",
        priority: 4,
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: BET_START,
        updatedAt: BET_START,
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
    workItems: [structuredClone(WORK_ITEM_1), structuredClone(WORK_ITEM_2)],
    dependencies: [structuredClone(DEPENDENCY)],
    ...overrides,
  });
}

function addSecondPlanningProject(source: WorkspaceV2): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-2",
    projectId: "project-2",
    appetiteSeconds: 691_200,
    firstScope: [
      { id: "scope-2", title: "Second scope", description: "Bounded" },
    ],
    createdAt: BET_START,
    updatedAt: BET_START,
  });
  const bet = buildBetVersion({
    id: "bet-2",
    projectId: "project-2",
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: BET_START,
    appetiteEnd: BET_END,
    actorId: "human-1",
    approvedAt: BET_START,
  });
  source.projects.push(
    buildProjectV2({
      id: "project-2",
      stage: "planning",
      priority: 3,
      activeDirectionBriefId: brief.id,
      activeBetId: bet.id,
      createdAt: BET_START,
      updatedAt: BET_START,
    }),
  );
  source.directionBriefs.push(brief);
  source.bets.push(bet);
  source.workItems.push({
    ...structuredClone(WORK_ITEM_1),
    id: "work-project-2",
    projectId: "project-2",
    betScopeId: "scope-2",
    revision: 4,
  });
  return source;
}

function draftFromProposal(
  id: string,
  proposal: TodayProposal,
): DailyCommitmentDraft {
  return {
    id,
    localDate: proposal.localDate,
    workspaceRevision: proposal.workspaceRevision,
    generatedAt: proposal.generatedAt,
    proposalHash: proposal.proposalHash,
    slots: structuredClone(proposal.slots),
  };
}

function applied(result: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(
      `Expected applied command: ${result.rejection.code} ${result.rejection.reason}`,
    );
  }
  expect(result.ok).toBe(true);
  return result;
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejected command");
  return result;
}

async function commitProjectToday(
  source = projectWorkspace(),
  commitmentId = "commitment-1",
): Promise<Extract<CommandResult, { ok: true }>> {
  const proposal = await generateTodayProposal(
    source,
    LOCAL_DATE,
    GENERATED_AT,
  );
  return applied(
    await executeCommand(
      source,
      { type: "commit_today", commitment: draftFromProposal(commitmentId, proposal) },
      context(source.revision, { commandId: `commit-${commitmentId}` }),
    ),
  );
}

describe("human Daily Commitment", () => {
  it("requires a human and a fresh revision-bound authoritative proposal", async () => {
    const source = projectWorkspace();
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const draft = draftFromProposal("commitment-1", proposal);

    const agentAttempt = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, {
          commandId: "agent-commit",
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
    expect(agentAttempt.rejection.code).toBe("HUMAN_CONFIRMATION_REQUIRED");

    const staleRevision = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: { ...draft, workspaceRevision: source.revision - 1 },
        },
        context(source.revision, { commandId: "stale-revision" }),
      ),
    );
    expect(staleRevision.rejection).toMatchObject({
      code: "REVISION_CONFLICT",
      workspaceRevision: source.revision,
    });
    expect(staleRevision.workspace).toBe(source);

    const fractionalRevision = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: {
            ...draft,
            workspaceRevision: source.revision + 0.5,
          },
        },
        context(source.revision, { commandId: "fractional-revision" }),
      ),
    );
    expect(fractionalRevision.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:commit_today",
    });

    const staleHash = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: { ...draft, proposalHash: "stale-proposal-hash" },
        },
        context(source.revision, { commandId: "stale-hash" }),
      ),
    );
    expect(staleHash.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "today_proposal:freshness",
      permittedNextCommand: "regenerate_today",
    });

    const receiptCollision = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, { commandId: "work-1" }),
      ),
    );
    expect(receiptCollision.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:ProjectWorkItem:work-1",
    });

    const ownSlotId = draft.slots[0].id;
    const commitmentSlotCollision = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: { ...draft, id: ownSlotId },
        },
        context(source.revision, { commandId: "slot-id-commitment" }),
      ),
    );
    expect(commitmentSlotCollision.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:CommitmentSlot:${ownSlotId}`,
    });
    const receiptSlotCollision = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, { commandId: ownSlotId }),
      ),
    );
    expect(receiptSlotCollision.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:CommitmentSlot:${ownSlotId}`,
    });

    const expiredAt = new Date(
      Date.parse(GENERATED_AT) +
        (TODAY_PROPOSAL_MAX_AGE_SECONDS + 1) * 1_000,
    ).toISOString();
    const expired = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, {
          commandId: "expired-proposal",
          now: expiredAt,
        }),
      ),
    );
    expect(expired.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "today_proposal:freshness",
      permittedNextCommand: "regenerate_today",
    });
    expect(source.dailyCommitments).toEqual([]);
  });

  it("stores an immutable full snapshot and creates the first capacity-independent Plan Version", async () => {
    const source = projectWorkspace({
      baselines: [
        {
          id: "baseline-1",
          projectId: "project-1",
          name: "Explicit baseline",
          capturedAt: BET_START,
          plannedStartByItem: { "work-1": BET_START },
          plannedFinishByItem: { "work-1": GENERATED_AT },
          plannedWorkSecondsByItem: { "work-1": 1_800 },
        },
      ],
    });
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const before = structuredClone(source);
    const result = applied(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: draftFromProposal("commitment-1", proposal),
        },
        context(source.revision, { commandId: "commit-first" }),
      ),
    );

    expect(source).toEqual(before);
    expect(result.workspace.dailyCommitments).toHaveLength(1);
    const commitment = result.workspace.dailyCommitments[0];
    expect(commitment).toEqual({
      id: "commitment-1",
      localDate: LOCAL_DATE,
      version: 1,
      proposalHash: proposal.proposalHash,
      capacitySnapshot: CAPACITY,
      slots: proposal.slots,
      actorId: "human-1",
      committedAt: GENERATED_AT,
    });
    expect(commitment.capacitySnapshot).not.toBe(source.capacityProfile);
    expect(commitment.slots).not.toBe(proposal.slots);

    expect(result.workspace.projects[0]).toMatchObject({
      stage: "executing",
      activePlanVersionId: "plan:project-1:commitment-1",
    });
    expect(result.workspace.planVersions).toHaveLength(1);
    expect(result.workspace.planVersions[0]).toMatchObject({
      id: "plan:project-1:commitment-1",
      projectId: "project-1",
      version: 1,
      betId: "bet-1",
      workItemRevisions: { "work-1": 3, "work-2": 5 },
      dependencyRevisions: { "dependency-1": 2 },
      scopeMapping: { "work-1": "scope-1", "work-2": "scope-1" },
      actorId: "human-1",
      createdAt: GENERATED_AT,
    });
    expect(result.workspace.planVersions[0].scheduleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.workspace.planVersions[0].capacityIndependentDates).toEqual({
      "work-1": {
        start: BET_START,
        finish: "2026-07-12T00:30:00.000Z",
      },
      "work-2": {
        start: "2026-07-12T00:30:00.000Z",
        finish: "2026-07-12T01:00:00.000Z",
      },
    });
    expect(result.workspace.baselines).toEqual(source.baselines);
  });

  it("fails closed when same-Bet Plan history has lost its active pointer", async () => {
    const committed = (await commitProjectToday()).workspace;
    const dirty = structuredClone(committed);
    dirty.revision += 1;
    dirty.dailyCommitments = [];
    dirty.projects[0] = { ...dirty.projects[0], stage: "planning" };
    delete dirty.projects[0].activePlanVersionId;
    const proposal = await generateTodayProposal(
      dirty,
      LOCAL_DATE,
      GENERATED_AT,
    );

    const result = rejected(
      await executeCommand(
        dirty,
        {
          type: "commit_today",
          commitment: draftFromProposal("commitment-dirty-plan", proposal),
        },
        context(dirty.revision, { commandId: "commit-dirty-plan" }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:plan_lineage",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("preserves the Bet-boundary recovery action when a fresh proposal expires before commit", async () => {
    const source = projectWorkspace();
    source.bets[0].appetiteEnd = "2026-07-13T00:01:00.000Z";
    source.workItems = [
      {
        ...structuredClone(WORK_ITEM_1),
        durationSeconds: 30,
        estimate: { mostLikelySeconds: 30 },
      },
    ];
    source.dependencies = [];
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    expect(proposal.slots).toHaveLength(1);

    const result = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: draftFromProposal("commitment-expired-bet", proposal),
        },
        context(source.revision, {
          commandId: "commit-expired-bet",
          now: "2026-07-13T00:01:01.000Z",
        }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "BET_EXPIRED",
      permittedNextCommand: "record_bet_boundary",
    });
  });

  it("rejects an overflowing edited draft atomically with recovery actions", async () => {
    const source = projectWorkspace();
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const draft = draftFromProposal("commitment-overflow", proposal);
    draft.slots[0] = {
      ...draft.slots[0],
      finish: "2026-07-13T04:00:00.000Z",
    };

    const result = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, { commandId: "overflow" }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      workspaceRevision: source.revision,
      permittedNextCommand: "edit_today_draft",
    });
    expect(result.workspace).toBe(source);
    expect(result.receipt.revision).toBe(source.revision);
    expect(source.dailyCommitments).toEqual([]);
  });

  it("directs missing capacity to setup and includes recorded attention in strict capacity", async () => {
    const noCapacity = buildWorkspaceV2("workspace-no-capacity", {
      revision: 3,
    });
    const missing = rejected(
      await executeCommand(
        noCapacity,
        {
          type: "commit_today",
          commitment: {
            id: "commitment-no-capacity",
            localDate: LOCAL_DATE,
            workspaceRevision: 3,
            generatedAt: GENERATED_AT,
            proposalHash: "unavailable-without-capacity",
            slots: [],
          },
        },
        context(3, { commandId: "missing-capacity" }),
      ),
    );
    expect(missing.rejection).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      permittedNextCommand: "configure_capacity",
    });

    const source = projectWorkspace({
      actuals: [
        {
          id: "actual-capacity",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-1" },
          actualStart: GENERATED_AT,
          actualWorkSeconds: 7_000,
          remainingWorkSeconds: 1_800,
          actualCost: 0,
          recordedAt: GENERATED_AT,
        },
      ],
    });
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const draft = draftFromProposal("commitment-actual-overflow", proposal);
    draft.slots = [
      {
        id: "today-slot:manual-overflow",
        target: {
          kind: "work_item",
          projectId: "project-1",
          workItemId: "work-1",
        },
        targetRevision: 3,
        start: GENERATED_AT,
        finish: "2026-07-13T00:30:00.000Z",
        attention: "deep",
      },
    ];
    const overflow = rejected(
      await executeCommand(
        source,
        { type: "commit_today", commitment: draft },
        context(source.revision, { commandId: "actual-overflow" }),
      ),
    );
    expect(overflow.rejection).toMatchObject({
      code: "CAPACITY_EXCEEDED",
      permittedNextCommand: "edit_today_draft",
    });
  });

  it("creates one deterministic Plan Version for every project in a commitment", async () => {
    const source = projectWorkspace();
    const brief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      appetiteSeconds: 691_200,
      firstScope: [
        { id: "scope-2", title: "Second scope", description: "Bounded" },
      ],
      createdAt: BET_START,
      updatedAt: BET_START,
    });
    const bet = buildBetVersion({
      id: "bet-2",
      projectId: "project-2",
      briefId: brief.id,
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: BET_START,
      appetiteEnd: BET_END,
      actorId: "human-1",
      approvedAt: BET_START,
    });
    source.projects.push(
      buildProjectV2({
        id: "project-2",
        stage: "planning",
        priority: 3,
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: BET_START,
        updatedAt: BET_START,
      }),
    );
    source.directionBriefs.push(brief);
    source.bets.push(bet);
    source.workItems.push({
      ...structuredClone(WORK_ITEM_1),
      id: "work-project-2",
      projectId: "project-2",
      betScopeId: "scope-2",
      revision: 4,
    });
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const result = applied(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: draftFromProposal("commitment-multi", proposal),
        },
        context(source.revision, { commandId: "commit-multi" }),
      ),
    );

    expect(result.workspace.planVersions.map(({ id }) => id)).toEqual([
      "plan:project-1:commitment-multi",
      "plan:project-2:commitment-multi",
    ]);
    expect(result.workspace.projects.map(({ stage }) => stage)).toEqual([
      "executing",
      "executing",
    ]);
  });

  it("commits an Action-only Today without fabricating a Project Plan", async () => {
    const source = buildWorkspaceV2("workspace-action-only", {
      revision: 4,
      capacityProfile: structuredClone(CAPACITY),
      inboxItems: [
        {
          id: "inbox-action-only",
          originalText: "Handle the action",
          sourceId: "human-session-1",
          actorId: "human-1",
          capturedAt: BET_START,
          triageStatus: "action",
          actionId: "action-only",
        },
      ],
      actions: [
        {
          id: "action-only",
          inboxItemId: "inbox-action-only",
          title: "Handle the action",
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
          createdAt: BET_START,
          updatedAt: BET_START,
        },
      ],
    });
    const proposal = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    expect(proposal.slots).toHaveLength(1);
    expect(proposal.slots[0].target).toEqual({
      kind: "action",
      actionId: "action-only",
    });

    const result = applied(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: draftFromProposal("commitment-action-only", proposal),
        },
        context(source.revision, { commandId: "commit-action-only" }),
      ),
    );
    expect(result.workspace.planVersions).toEqual([]);
    expect(result.workspace.projects).toEqual([]);
    expect(result.workspace.dailyCommitments[0]).toMatchObject({
      id: "commitment-action-only",
      version: 1,
      slots: proposal.slots,
      actorId: "human-1",
    });
  });

  it("globally freezes even Action-only new commitments during review overdue", async () => {
    const source = projectWorkspace({
      actions: [
        {
          id: "action-1",
          inboxItemId: "inbox-1",
          title: "Action",
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
          createdAt: BET_START,
          updatedAt: BET_START,
        },
      ],
    });
    source.projects[0].holds.push({
      type: "review_overdue",
      sourceId: "review-global",
      affectedRecordIds: ["project-1"],
      createdAt: GENERATED_AT,
    });

    const frozen = rejected(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: {
            id: "commitment-action-only",
            localDate: LOCAL_DATE,
            workspaceRevision: source.revision,
            generatedAt: GENERATED_AT,
            proposalHash: "cannot-bypass-global-review",
            slots: [
              {
                id: "slot-action-only",
                target: { kind: "action", actionId: "action-1" },
                targetRevision: 1,
                start: GENERATED_AT,
                finish: "2026-07-13T00:15:00.000Z",
                attention: "shallow",
              },
            ],
          },
        },
        context(source.revision, { commandId: "action-only-review" }),
      ),
    );
    expect(frozen.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });
  });
});

describe("versioned Replan acceptance", () => {
  async function deriveChangedProposals(committed: WorkspaceV2) {
    const actual: ActualV2 = {
      id: "actual-1",
      revision: 1,
      target: { kind: "work_item", workItemId: WORK_ITEM_1.id },
      actualStart: GENERATED_AT,
      actualWorkSeconds: 600,
      remainingWorkSeconds: 1_200,
      actualCost: 0,
      recordedAt: GENERATED_AT,
    };
    const actualChanged = {
      ...structuredClone(committed),
      revision: committed.revision + 1,
      actuals: [actual],
    };
    const dependencyChanged = structuredClone(committed);
    dependencyChanged.revision += 1;
    dependencyChanged.dependencies[0].lagSeconds = 900;
    dependencyChanged.dependencies[0].revision += 1;
    const unavailableChanged = structuredClone(committed);
    unavailableChanged.revision += 1;
    if (unavailableChanged.capacityProfile === undefined) {
      throw new Error("Expected capacity profile");
    }
    unavailableChanged.capacityProfile.unavailableBlocks.push({
      id: "unavailable-1",
      start: "2026-07-13T00:30:00.000Z",
      finish: "2026-07-13T01:00:00.000Z",
    });

    return Promise.all(
      [
        [actualChanged, "ACTUAL_CHANGED", "replan-actual"],
        [dependencyChanged, "DEPENDENCY_CHANGED", "replan-dependency"],
        [unavailableChanged, "UNAVAILABLE_CHANGED", "replan-unavailable"],
      ].map(async ([changed, reason, id]) => ({
        changed: changed as WorkspaceV2,
        proposal: await buildReplanProposal(changed as WorkspaceV2, {
          id: id as string,
          localDate: LOCAL_DATE,
          reasonCodes: [reason as string],
          createdAt: GENERATED_AT,
          createdBy: "human-1",
        }),
      })),
    );
  }

  it("derives proposal-only responses to actual, dependency, and unavailable changes", async () => {
    const committed = (await commitProjectToday()).workspace;
    const commitmentBytes = JSON.stringify(committed.dailyCommitments[0]);
    const changes = await deriveChangedProposals(committed);

    for (const { changed, proposal } of changes) {
      expect(JSON.stringify(changed.dailyCommitments[0])).toBe(commitmentBytes);
      expect(proposal).toMatchObject({
        localDate: LOCAL_DATE,
        baseCommitmentId: "commitment-1",
        baseRevision: changed.revision,
        status: "open",
        createdAt: GENERATED_AT,
        createdBy: "human-1",
      });
      expect(proposal.proposalHash).toMatch(/^[0-9a-f]{64}$/);
      expect(proposal.proposedSlots).not.toBe(changed.dailyCommitments[0].slots);
      expect(changed.replanProposals).toEqual([]);
    }
  });

  it("rejects an immediate no-op Replan even when its reason code claims a change", async () => {
    const committed = (await commitProjectToday()).workspace;
    await expect(
      buildReplanProposal(committed, {
        id: "replan-no-op-builder",
        localDate: LOCAL_DATE,
        reasonCodes: ["ACTUAL_CHANGED"],
        createdAt: GENERATED_AT,
        createdBy: "human-1",
      }),
    ).rejects.toThrow(/material change/i);

    const today = await generateTodayProposal(
      committed,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const directNoOp = rejected(
      await executeCommand(
        committed,
        {
          type: "propose_replan",
          proposal: {
            id: "replan-no-op-direct",
            localDate: LOCAL_DATE,
            baseCommitmentId: "commitment-1",
            baseRevision: committed.revision,
            reasonCodes: ["ACTUAL_CHANGED"],
            proposedSlots: structuredClone(today.slots),
            proposalHash: today.proposalHash,
            createdAt: GENERATED_AT,
            createdBy: "human-1",
            status: "open",
          },
        },
        context(committed.revision, { commandId: "propose-no-op-direct" }),
      ),
    );
    expect(directNoOp.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "replan:replan-no-op-direct:material_change",
      permittedNextCommand: "keep_current_commitment",
    });

    const identicalCapacity = applied(
      await executeCommand(
        committed,
        {
          type: "configure_capacity",
          profile: structuredClone(committed.capacityProfile!),
        },
        context(committed.revision, {
          commandId: "configure-identical-capacity",
        }),
      ),
    ).workspace;
    await expect(
      buildReplanProposal(identicalCapacity, {
        id: "replan-identical-capacity",
        localDate: LOCAL_DATE,
        reasonCodes: ["CAPACITY_CHANGED"],
        createdAt: GENERATED_AT,
        createdBy: "human-1",
      }),
    ).rejects.toThrow(/material change/i);

    const source = projectWorkspace();
    const originalToday = await generateTodayProposal(
      source,
      LOCAL_DATE,
      GENERATED_AT,
    );
    const committedLater = applied(
      await executeCommand(
        source,
        {
          type: "commit_today",
          commitment: draftFromProposal(
            "commitment-after-generation",
            originalToday,
          ),
        },
        context(source.revision, {
          commandId: "commit-after-generation",
          now: "2026-07-13T00:00:01.000Z",
        }),
      ),
    ).workspace;
    await expect(
      buildReplanProposal(committedLater, {
        id: "replan-predates-commitment",
        localDate: LOCAL_DATE,
        reasonCodes: ["ACTUAL_CHANGED"],
        createdAt: GENERATED_AT,
        createdBy: "human-1",
      }),
    ).rejects.toThrow(/cannot predate/i);
  });

  it("rejects stable slot ID reuse when that ID also belongs to a non-slot entity", async () => {
    const committed = (await commitProjectToday()).workspace;
    const slotId = committed.dailyCommitments[0].slots[0].id;
    const conflictingProfile = structuredClone(committed.capacityProfile!);
    conflictingProfile.unavailableBlocks.push({
      id: slotId,
      start: "2026-07-14T00:00:00.000Z",
      finish: "2026-07-14T00:15:00.000Z",
    });
    const configureResult = rejected(
      await executeCommand(
        committed,
        { type: "configure_capacity", profile: conflictingProfile },
        context(committed.revision, {
          commandId: "configure-cross-type-slot",
        }),
      ),
    );
    expect(configureResult.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:CommitmentSlot:${slotId}`,
    });

    const changed = structuredClone(committed);
    changed.revision += 1;
    changed.capacityProfile = conflictingProfile;
    changed.dependencies[0].revision += 1;
    const proposal = await buildReplanProposal(changed, {
      id: "replan-cross-type-slot",
      localDate: LOCAL_DATE,
      reasonCodes: ["UNAVAILABLE_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });

    const result = rejected(
      await executeCommand(
        changed,
        { type: "propose_replan", proposal },
        context(changed.revision, { commandId: "propose-cross-type-slot" }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:UnavailableBlock:${slotId}`,
    });
  });

  it("accepts only the directly-created proposal and appends superseding commitment and Plan records", async () => {
    const committed = (await commitProjectToday()).workspace;
    const [{ changed, proposal }] = await deriveChangedProposals(committed);
    const oldCommitmentBytes = JSON.stringify(changed.dailyCommitments[0]);
    const oldPlanBytes = JSON.stringify(changed.planVersions[0]);

    const proposed = applied(
      await executeCommand(
        changed,
        { type: "propose_replan", proposal },
        context(changed.revision, {
          commandId: "propose-replan-actual",
        }),
      ),
    );
    expect(proposed.workspace.revision).toBe(proposal.baseRevision + 1);
    expect(proposed.receipt).toMatchObject({
      commandType: "propose_replan",
      baseRevision: proposal.baseRevision,
      revision: proposal.baseRevision + 1,
      status: "applied",
      diff: [
        expect.objectContaining({
          entity: "ReplanProposal",
          entityId: proposal.id,
          field: "created",
        }),
      ],
    });

    const accepted = applied(
      await executeCommand(
        proposed.workspace,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-2",
        },
        context(proposed.workspace.revision, {
          commandId: "accept-replan-actual",
        }),
      ),
    );

    expect(JSON.stringify(accepted.workspace.dailyCommitments[0])).toBe(
      oldCommitmentBytes,
    );
    expect(JSON.stringify(accepted.workspace.planVersions[0])).toBe(oldPlanBytes);
    expect(accepted.workspace.dailyCommitments[1]).toMatchObject({
      id: "commitment-2",
      localDate: LOCAL_DATE,
      version: 2,
      proposalHash: proposal.proposalHash,
      capacitySnapshot: changed.capacityProfile,
      slots: proposal.proposedSlots,
      actorId: "human-1",
      committedAt: GENERATED_AT,
      supersedesId: "commitment-1",
    });
    expect(accepted.workspace.planVersions[1]).toMatchObject({
      id: "plan:project-1:commitment-2",
      version: 2,
      supersedesId: "plan:project-1:commitment-1",
      dependencyRevisions: { "dependency-1": 2 },
      actorId: "human-1",
      createdAt: GENERATED_AT,
    });
    expect(accepted.workspace.projects[0].activePlanVersionId).toBe(
      "plan:project-1:commitment-2",
    );
    expect(accepted.workspace.replanProposals[0].status).toBe("accepted");
  });

  it("starts a first Plan for project work added by Replan and versions a project removed from its slots", async () => {
    const committed = (await commitProjectToday()).workspace;
    const expanded = addSecondPlanningProject(structuredClone(committed));
    expanded.revision += 1;
    const expansionProposal = await buildReplanProposal(expanded, {
      id: "replan-add-project",
      localDate: LOCAL_DATE,
      reasonCodes: ["PROJECT_ADDED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    expect(
      expansionProposal.proposedSlots.some(
        ({ target }) =>
          target.kind === "work_item" && target.projectId === "project-2",
      ),
    ).toBe(true);
    const expansionRecorded = applied(
      await executeCommand(
        expanded,
        { type: "propose_replan", proposal: expansionProposal },
        context(expanded.revision, { commandId: "propose-add-project" }),
      ),
    );
    const expansionAccepted = applied(
      await executeCommand(
        expansionRecorded.workspace,
        {
          type: "accept_replan",
          proposalId: expansionProposal.id,
          commitmentId: "commitment-add-project",
        },
        context(expansionRecorded.workspace.revision, {
          commandId: "accept-add-project",
        }),
      ),
    );
    expect(
      expansionAccepted.workspace.planVersions.find(
        ({ id }) => id === "plan:project-2:commitment-add-project",
      ),
    ).toMatchObject({
      version: 1,
      betId: "bet-2",
      actorId: "human-1",
    });
    expect(
      expansionAccepted.workspace.projects.find(({ id }) => id === "project-2"),
    ).toMatchObject({
      stage: "executing",
      activePlanVersionId: "plan:project-2:commitment-add-project",
    });

    const completedSecondProject = structuredClone(expansionAccepted.workspace);
    completedSecondProject.revision += 1;
    completedSecondProject.actuals.push({
      id: "actual-project-2-complete",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-project-2" },
      actualStart: GENERATED_AT,
      actualWorkSeconds: 1_800,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: GENERATED_AT,
    });

    const missingPointer = structuredClone(completedSecondProject);
    delete missingPointer.projects.find(({ id }) => id === "project-2")!
      .activePlanVersionId;
    const dirtyRemovalProposal = await buildReplanProposal(missingPointer, {
      id: "replan-remove-project-dirty-plan",
      localDate: LOCAL_DATE,
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    const dirtyRemovalRecorded = applied(
      await executeCommand(
        missingPointer,
        { type: "propose_replan", proposal: dirtyRemovalProposal },
        context(missingPointer.revision, {
          commandId: "propose-remove-project-dirty-plan",
        }),
      ),
    );
    const dirtyRemoval = rejected(
      await executeCommand(
        dirtyRemovalRecorded.workspace,
        {
          type: "accept_replan",
          proposalId: dirtyRemovalProposal.id,
          commitmentId: "commitment-remove-project-dirty-plan",
        },
        context(dirtyRemovalRecorded.workspace.revision, {
          commandId: "accept-remove-project-dirty-plan",
        }),
      ),
    );
    expect(dirtyRemoval.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-2:plan_lineage",
      permittedNextCommand: "resolve_sync_conflict",
    });

    const removalProposal = await buildReplanProposal(completedSecondProject, {
      id: "replan-remove-project",
      localDate: LOCAL_DATE,
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    expect(
      removalProposal.proposedSlots.some(
        ({ target }) =>
          target.kind === "work_item" && target.projectId === "project-2",
      ),
    ).toBe(false);
    const removalRecorded = applied(
      await executeCommand(
        completedSecondProject,
        { type: "propose_replan", proposal: removalProposal },
        context(completedSecondProject.revision, {
          commandId: "propose-remove-project",
        }),
      ),
    );
    const removalAccepted = applied(
      await executeCommand(
        removalRecorded.workspace,
        {
          type: "accept_replan",
          proposalId: removalProposal.id,
          commitmentId: "commitment-remove-project",
        },
        context(removalRecorded.workspace.revision, {
          commandId: "accept-remove-project",
        }),
      ),
    );
    expect(
      removalAccepted.workspace.planVersions.find(
        ({ id }) => id === "plan:project-2:commitment-remove-project",
      ),
    ).toMatchObject({
      version: 2,
      supersedesId: "plan:project-2:commitment-add-project",
      betId: "bet-2",
    });
  });

  it("continues Plan history after Re-bet clears the active Plan pointer", async () => {
    const committed = (await commitProjectToday()).workspace;
    const rebet = structuredClone(committed);
    rebet.revision += 1;
    rebet.bets[0] = {
      ...rebet.bets[0],
      invalidatedAt: GENERATED_AT,
      invalidationReason: "Superseded by Re-bet bet-rebet.",
    };
    const nextBet = buildBetVersion({
      id: "bet-rebet",
      projectId: "project-1",
      version: 2,
      briefId: rebet.directionBriefs[0].id,
      briefSnapshot: structuredClone(rebet.directionBriefs[0]),
      committedScope: structuredClone(rebet.directionBriefs[0].firstScope),
      appetiteStart: BET_START,
      appetiteEnd: BET_END,
      actorId: "human-1",
      approvedAt: GENERATED_AT,
      supersedesId: "bet-1",
    });
    rebet.bets.push(nextBet);
    rebet.projects[0] = {
      ...rebet.projects[0],
      stage: "planning",
      activeBetId: nextBet.id,
    };
    delete rebet.projects[0].activePlanVersionId;

    const proposal = await buildReplanProposal(rebet, {
      id: "replan-after-rebet",
      localDate: LOCAL_DATE,
      reasonCodes: ["BET_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    const recorded = applied(
      await executeCommand(
        rebet,
        { type: "propose_replan", proposal },
        context(rebet.revision, { commandId: "propose-after-rebet" }),
      ),
    );
    const accepted = applied(
      await executeCommand(
        recorded.workspace,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-after-rebet",
        },
        context(recorded.workspace.revision, {
          commandId: "accept-after-rebet",
        }),
      ),
    );
    expect(
      accepted.workspace.planVersions.find(
        ({ id }) => id === "plan:project-1:commitment-after-rebet",
      ),
    ).toMatchObject({
      version: 2,
      supersedesId: "plan:project-1:commitment-1",
      betId: "bet-rebet",
    });
    expect(accepted.workspace.projects[0]).toMatchObject({
      stage: "executing",
      activePlanVersionId: "plan:project-1:commitment-after-rebet",
    });
  });

  it("rejects an active Plan pointer attached to the wrong stage or current Bet", async () => {
    const committed = (await commitProjectToday()).workspace;
    const wrongStage = structuredClone(committed);
    wrongStage.revision += 1;
    wrongStage.projects[0].stage = "planning";
    wrongStage.actuals.push({
      id: "actual-wrong-stage",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-1" },
      actualStart: GENERATED_AT,
      actualWorkSeconds: 600,
      remainingWorkSeconds: 1_200,
      actualCost: 0,
      recordedAt: GENERATED_AT,
    });
    const wrongStageProposal = await buildReplanProposal(wrongStage, {
      id: "replan-wrong-stage",
      localDate: LOCAL_DATE,
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    const wrongStageRecorded = applied(
      await executeCommand(
        wrongStage,
        { type: "propose_replan", proposal: wrongStageProposal },
        context(wrongStage.revision, { commandId: "propose-wrong-stage" }),
      ),
    );
    const stageRejected = rejected(
      await executeCommand(
        wrongStageRecorded.workspace,
        {
          type: "accept_replan",
          proposalId: wrongStageProposal.id,
          commitmentId: "commitment-wrong-stage",
        },
        context(wrongStageRecorded.workspace.revision, {
          commandId: "accept-wrong-stage",
        }),
      ),
    );
    expect(stageRejected.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:plan_lineage",
    });

    const wrongBet = structuredClone(committed);
    wrongBet.revision += 1;
    wrongBet.bets[0] = {
      ...wrongBet.bets[0],
      invalidatedAt: GENERATED_AT,
      invalidationReason: "Superseded by Re-bet bet-wrong-pointer.",
    };
    const currentBet = buildBetVersion({
      id: "bet-wrong-pointer",
      projectId: "project-1",
      version: 2,
      briefId: wrongBet.directionBriefs[0].id,
      briefSnapshot: structuredClone(wrongBet.directionBriefs[0]),
      committedScope: structuredClone(wrongBet.directionBriefs[0].firstScope),
      appetiteStart: BET_START,
      appetiteEnd: BET_END,
      actorId: "human-1",
      approvedAt: GENERATED_AT,
      supersedesId: "bet-1",
    });
    wrongBet.bets.push(currentBet);
    wrongBet.projects[0].activeBetId = currentBet.id;
    const wrongBetProposal = await buildReplanProposal(wrongBet, {
      id: "replan-wrong-bet-pointer",
      localDate: LOCAL_DATE,
      reasonCodes: ["BET_CHANGED"],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    const wrongBetRecorded = rejected(
      await executeCommand(
        wrongBet,
        { type: "propose_replan", proposal: wrongBetProposal },
        context(wrongBet.revision, { commandId: "propose-wrong-bet-pointer" }),
      ),
    );
    expect(wrongBetRecorded.rejection).toMatchObject({
      code: "BET_REQUIRED",
    });
  });

  it("rejects acceptance after any intervening revision or forged proposal receipt", async () => {
    const committed = (await commitProjectToday()).workspace;
    const [{ changed, proposal }] = await deriveChangedProposals(committed);
    const proposed = applied(
      await executeCommand(
        changed,
        { type: "propose_replan", proposal },
        context(changed.revision, { commandId: "proposal-direct" }),
      ),
    );
    const intervened = {
      ...structuredClone(proposed.workspace),
      revision: proposed.workspace.revision + 1,
    };
    const stale = rejected(
      await executeCommand(
        intervened,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-stale",
        },
        context(intervened.revision, { commandId: "accept-stale" }),
      ),
    );
    expect(stale.rejection).toMatchObject({
      code: "REVISION_CONFLICT",
      permittedNextCommand: "regenerate_replan",
    });

    const forgedReceipt = structuredClone(proposed.workspace);
    forgedReceipt.commandReceipts[forgedReceipt.commandReceipts.length - 1].diff = [];
    const forged = rejected(
      await executeCommand(
        forgedReceipt,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-forged",
        },
        context(forgedReceipt.revision, { commandId: "accept-forged" }),
      ),
    );
    expect(forged.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: `replan:${proposal.id}:creation_receipt`,
    });

    const forgedHashes = structuredClone(proposed.workspace);
    forgedHashes.commandReceipts[
      forgedHashes.commandReceipts.length - 1
    ].payloadHash = "forged-payload-hash";
    const hashRejected = rejected(
      await executeCommand(
        forgedHashes,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-forged-hashes",
        },
        context(forgedHashes.revision, { commandId: "accept-forged-hashes" }),
      ),
    );
    expect(hashRejected.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: `replan:${proposal.id}:creation_receipt`,
    });
  });

  it("canonicalizes reasons and fails closed on forked Plan and Daily Commitment histories", async () => {
    const committed = (await commitProjectToday()).workspace;
    const commitmentFork = structuredClone(committed);
    commitmentFork.dailyCommitments.push(
      {
        ...structuredClone(commitmentFork.dailyCommitments[0]),
        id: "commitment-fork-a",
        version: 2,
        supersedesId: "commitment-1",
      },
      {
        ...structuredClone(commitmentFork.dailyCommitments[0]),
        id: "commitment-fork-b",
        version: 2,
        supersedesId: "commitment-1",
      },
    );
    await expect(
      buildReplanProposal(commitmentFork, {
        id: "replan-commitment-fork",
        localDate: LOCAL_DATE,
        reasonCodes: ["SYNC_CHANGED"],
        createdAt: GENERATED_AT,
        createdBy: "human-1",
      }),
    ).rejects.toThrow(/exactly one current Daily Commitment/);

    const [{ changed }] = await deriveChangedProposals(committed);
    changed.planVersions.push(
      {
        ...structuredClone(changed.planVersions[0]),
        id: "plan-fork-a",
        version: 2,
        supersedesId: changed.planVersions[0].id,
      },
      {
        ...structuredClone(changed.planVersions[0]),
        id: "plan-fork-b",
        version: 2,
        supersedesId: changed.planVersions[0].id,
      },
    );
    const proposal = await buildReplanProposal(changed, {
      id: "replan-fork",
      localDate: LOCAL_DATE,
      reasonCodes: [
        " 日本語_REASON ",
        "Ä_REASON",
        "A_REASON",
        "A_REASON",
      ],
      createdAt: GENERATED_AT,
      createdBy: "human-1",
    });
    expect(proposal.reasonCodes).toEqual([
      "A_REASON",
      "Ä_REASON",
      "日本語_REASON",
    ]);
    const proposed = applied(
      await executeCommand(
        changed,
        { type: "propose_replan", proposal },
        context(changed.revision, { commandId: "propose-fork" }),
      ),
    );
    const forked = rejected(
      await executeCommand(
        proposed.workspace,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-forked",
        },
        context(proposed.workspace.revision, { commandId: "accept-fork" }),
      ),
    );
    expect(forked.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:plan_lineage",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("keeps review-overdue commitment exact and blocks new commitments or accepted movement", async () => {
    const committed = (await commitProjectToday()).workspace;
    committed.projects[0].holds.push({
      type: "review_overdue",
      sourceId: "review-1",
      affectedRecordIds: ["project-1", "work-1"],
      createdAt: GENERATED_AT,
    });
    committed.reviews.push({
      id: "review-1",
      kind: "event",
      triggerKey: "review-overdue-1",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: ["project-1"],
      affectedRecordIds: ["project-1", "work-1"],
      dueAt: GENERATED_AT,
      createdAt: GENERATED_AT,
    });
    committed.revision += 1;
    const reviewProposalAt = "2026-07-13T00:10:00.000Z";
    const proposal = await buildReplanProposal(committed, {
      id: "replan-review-overdue",
      localDate: LOCAL_DATE,
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: reviewProposalAt,
      createdBy: "human-1",
    });
    expect(proposal.proposedSlots).toEqual(
      committed.dailyCommitments[0].slots,
    );

    const newCommit = rejected(
      await executeCommand(
        committed,
        {
          type: "commit_today",
          commitment: {
            id: "commitment-new",
            localDate: LOCAL_DATE,
            workspaceRevision: committed.revision,
            generatedAt: GENERATED_AT,
            proposalHash: proposal.proposalHash,
            slots: proposal.proposedSlots,
          },
        },
        context(committed.revision, { commandId: "review-new-commit" }),
      ),
    );
    expect(newCommit.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });

    const proposed = applied(
      await executeCommand(
        committed,
        { type: "propose_replan", proposal },
        context(committed.revision, {
          commandId: "review-propose",
          now: reviewProposalAt,
        }),
      ),
    );
    const moved = rejected(
      await executeCommand(
        proposed.workspace,
        {
          type: "accept_replan",
          proposalId: proposal.id,
          commitmentId: "commitment-review-2",
        },
        context(proposed.workspace.revision, {
          commandId: "review-accept",
          now: reviewProposalAt,
        }),
      ),
    );
    expect(moved.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "review_overdue",
    });

    const actualCommand: V2Command = {
      type: "record_actual",
      actual: {
        id: "actual-review",
        revision: 1,
        target: { kind: "work_item", workItemId: "work-1" },
        actualWorkSeconds: 300,
        remainingWorkSeconds: 1_500,
        actualCost: 0,
        recordedAt: GENERATED_AT,
      },
    };
    const actual = rejected(
      await executeCommand(
        committed,
        actualCommand,
        context(committed.revision, { commandId: "review-actual" }),
      ),
    );
    expect(actual.rejection.code).toBe("COMMAND_NOT_IMPLEMENTED");
    expect(actual.rejection.code).not.toBe("HOLD_BLOCKS_COMMAND");
    expect(JSON.stringify(actual.workspace.dailyCommitments[0])).toBe(
      JSON.stringify(committed.dailyCommitments[0]),
    );
  });
});
