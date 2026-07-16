import { describe, expect, it } from "vitest";

import { calculateEvm } from "@/domain/evm";
import { runMonteCarlo } from "@/domain/monteCarlo";
import { generateRecurringOccurrences } from "@/domain/recurring";
import { scheduleProject } from "@/domain/scheduler";
import type {
  Baseline,
  Dependency,
  Project,
  Resource,
  WorkItem,
} from "@/domain/types";

import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import type {
  BetVersion,
  CommitmentSlot,
  ProjectHoldState,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "../domain/types";
import {
  projectRecurringOccurrences,
  recurringOccurrencesForV2,
} from "./recurringAdapter";
import {
  projectToSchedulerInput,
  scheduleExecutablePortfolio,
  scheduleV2Project,
  workItemToSchedulerInput,
} from "./schedulerAdapter";
import {
  actualsForProjectReporting,
  calculateV2Evm,
  runV2MonteCarlo,
  selectV2Baseline,
} from "./reportingAdapter";

const START = "2026-07-11T09:00:00.000Z";
const MIDPOINT = "2026-07-11T11:00:00.000Z";
const END = "2026-07-11T13:00:00.000Z";

const BRIEF = buildDirectionBrief({
  id: "brief-1",
  projectId: "project-1",
  version: 1,
  audienceAndProblem: "Operators cannot see the next executable step.",
  successEvidence: "The correct next step is visible within one minute.",
  appetiteSeconds: 14_400,
  validationMethod: "Observe five operators.",
  firstScope: [
    { id: "scope-1", title: "Plan", description: "Plan the workflow." },
  ],
  noGoOrKill: "Stop if the plan needs hidden state.",
  advancedNotes: "",
  createdAt: START,
  updatedAt: START,
});

const BET = buildBetVersion({
  id: "bet-1",
  projectId: "project-1",
  version: 1,
  briefId: BRIEF.id,
  briefSnapshot: structuredClone(BRIEF),
  committedScope: structuredClone(BRIEF.firstScope),
  appetiteStart: START,
  appetiteEnd: END,
  actorId: "human-1",
  approvedAt: START,
});

const PROJECT = buildProjectV2({
  id: "project-1",
  name: "Executable project",
  priority: 7,
  notes: "",
  stage: "planning",
  activeDirectionBriefId: BRIEF.id,
  activeBetId: BET.id,
  activePlanVersionId: "plan-1",
  createdAt: START,
  updatedAt: START,
});

const FIRST_ITEM: ProjectWorkItem = {
  id: "work-1",
  projectId: PROJECT.id,
  kind: "task",
  title: "Shape the plan",
  outline: "1",
  durationSeconds: 3_600,
  estimate: {
    optimisticSeconds: 1_800,
    mostLikelySeconds: 3_600,
    pessimisticSeconds: 7_200,
  },
  assignmentIds: [
    { resourceId: "resource-1", attention: "deep", effortSeconds: 3_600 },
  ],
  percentComplete: 50,
  revision: 2,
  betScopeId: "scope-1",
  repeatRule: {
    cadence: "weekly",
    count: 2,
    startMode: "fixed-time",
    startAt: START,
  },
};

const SECOND_ITEM: ProjectWorkItem = {
  ...structuredClone(FIRST_ITEM),
  id: "work-2",
  title: "Validate the plan",
  outline: "2",
  durationSeconds: 1_800,
  estimate: { mostLikelySeconds: 1_800 },
  assignmentIds: [],
  percentComplete: 0,
  revision: 1,
  repeatRule: undefined,
};

const V1_PROJECT: Project = {
  id: "project-1",
  name: "Executable project",
  status: "active",
  mode: "build",
  priority: 7,
  northStar: "The correct next step is visible within one minute.",
  currentOutcome: "Operators cannot see the next executable step.",
  horizon: END,
  start: START,
  reviewCadenceDays: 7,
};

const V1_FIRST_ITEM: WorkItem = {
  id: "work-1",
  projectId: "project-1",
  kind: "task",
  title: "Shape the plan",
  outline: "1",
  durationSeconds: 3_600,
  estimate: {
    optimisticSeconds: 1_800,
    mostLikelySeconds: 3_600,
    pessimisticSeconds: 7_200,
  },
  assignmentIds: [
    { resourceId: "resource-1", attention: "deep", effortSeconds: 3_600 },
  ],
  percentComplete: 50,
  repeatRule: {
    cadence: "weekly",
    count: 2,
    startMode: "fixed-time",
    startAt: START,
  },
  shapeUpScopeId: "scope-1",
};

const V1_SECOND_ITEM: WorkItem = {
  id: "work-2",
  projectId: "project-1",
  kind: "task",
  title: "Validate the plan",
  outline: "2",
  durationSeconds: 1_800,
  estimate: { mostLikelySeconds: 1_800 },
  assignmentIds: [],
  percentComplete: 0,
  shapeUpScopeId: "scope-1",
};

const V1_DEPENDENCY: Dependency = {
  id: "dependency-1",
  projectId: "project-1",
  fromId: "work-1",
  toId: "work-2",
  type: "FS",
  lagSeconds: 0,
};

const RESOURCE: Resource = {
  id: "resource-1",
  name: "Planner",
  role: "Owner",
  capacityByAttention: {
    deep: 28_800,
    medium: 28_800,
    shallow: 28_800,
  },
  hourlyRate: 120,
};

const BASELINE: Baseline = {
  id: "baseline-1",
  projectId: PROJECT.id,
  name: "Approved baseline",
  capturedAt: START,
  plannedStartByItem: { [FIRST_ITEM.id]: START, [SECOND_ITEM.id]: MIDPOINT },
  plannedFinishByItem: {
    [FIRST_ITEM.id]: MIDPOINT,
    [SECOND_ITEM.id]: END,
  },
  plannedWorkSecondsByItem: {
    [FIRST_ITEM.id]: FIRST_ITEM.durationSeconds,
    [SECOND_ITEM.id]: SECOND_ITEM.durationSeconds,
  },
};

const COMMITTED_SLOT: CommitmentSlot = {
  id: "slot-1",
  target: {
    kind: "work_item",
    workItemId: FIRST_ITEM.id,
    projectId: PROJECT.id,
  },
  targetRevision: FIRST_ITEM.revision,
  start: START,
  finish: MIDPOINT,
  attention: "deep",
};

function hold(
  type: ProjectHoldState["type"],
  affectedRecordIds: string[] = [],
): ProjectHoldState {
  return {
    type,
    sourceId: `${type}-source`,
    affectedRecordIds,
    createdAt: START,
  };
}

function workspace(
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  return buildWorkspaceV2("workspace-projections", {
    projects: [structuredClone(PROJECT)],
    directionBriefs: [structuredClone(BRIEF)],
    bets: [structuredClone(BET)],
    planVersions: [
      {
        id: "plan-1",
        projectId: PROJECT.id,
        version: 1,
        betId: BET.id,
        workItemRevisions: {
          [FIRST_ITEM.id]: FIRST_ITEM.revision,
          [SECOND_ITEM.id]: SECOND_ITEM.revision,
        },
        dependencyRevisions: { "dependency-1": 1 },
        scopeMapping: {
          [FIRST_ITEM.id]: FIRST_ITEM.betScopeId,
          [SECOND_ITEM.id]: SECOND_ITEM.betScopeId,
        },
        scheduleHash: "schedule-hash",
        capacityIndependentDates: {
          [FIRST_ITEM.id]: { start: START, finish: MIDPOINT },
          [SECOND_ITEM.id]: { start: MIDPOINT, finish: END },
        },
        actorId: "human-1",
        createdAt: START,
      },
    ],
    workItems: [structuredClone(FIRST_ITEM), structuredClone(SECOND_ITEM)],
    dependencies: [
      {
        id: "dependency-1",
        projectId: PROJECT.id,
        fromId: FIRST_ITEM.id,
        toId: SECOND_ITEM.id,
        type: "FS",
        lagSeconds: 0,
        revision: 1,
      },
    ],
    resources: [structuredClone(RESOURCE)],
    baselines: [structuredClone(BASELINE)],
    actuals: [
      {
        id: "actual-work",
        revision: 1,
        target: { kind: "work_item", workItemId: FIRST_ITEM.id },
        actualWorkSeconds: 1_800,
        remainingWorkSeconds: 1_800,
        actualCost: 60,
        recordedAt: MIDPOINT,
      },
      {
        id: "actual-action",
        revision: 1,
        target: { kind: "action", actionId: "action-1" },
        actualWorkSeconds: 300,
        remainingWorkSeconds: 0,
        actualCost: 5,
        recordedAt: MIDPOINT,
      },
    ],
    dailyCommitments: [
      {
        id: "commitment-1",
        localDate: "2026-07-11",
        version: 1,
        proposalHash: "proposal-hash",
        capacitySnapshot: {
          timeZone: "UTC",
          weeklyWindows: [],
          dailyBudgets: [],
          unavailableBlocks: [],
          updatedAt: START,
          updatedBy: "human-1",
        },
        slots: [structuredClone(COMMITTED_SLOT)],
        actorId: "human-1",
        committedAt: START,
      },
    ],
    ...overrides,
  });
}

function scheduleSummary(result: NonNullable<ReturnType<typeof scheduleV2Project>>) {
  return {
    ids: result.items.map(({ workItem }) => workItem.id),
    dates: result.items.map(({ workItem, start, finish }) => ({
      id: workItem.id,
      start,
      finish,
    })),
    critical: result.items.map(({ workItem, isCritical }) => ({
      id: workItem.id,
      isCritical,
    })),
    diagnostics: result.diagnostics,
  };
}

describe("scheduler projection parity", () => {
  it("projects V2 records into the existing scheduler without changing results", () => {
    const source = workspace();
    const expected = scheduleProject(
      V1_PROJECT,
      [V1_FIRST_ITEM, V1_SECOND_ITEM],
      [V1_DEPENDENCY],
    );
    const actual = scheduleV2Project(source, PROJECT.id, MIDPOINT);

    expect(projectToSchedulerInput(source, source.projects[0])).toEqual(
      V1_PROJECT,
    );
    expect(source.workItems.map(workItemToSchedulerInput)).toEqual([
      V1_FIRST_ITEM,
      V1_SECOND_ITEM,
    ]);
    expect(actual).toBeDefined();
    if (actual === undefined) throw new Error("Expected V2 schedule");
    expect(scheduleSummary(actual)).toEqual(scheduleSummary(expected));
  });

  it("surfaces unsupported cross-project dependency edges explicitly", () => {
    const foreignItem: ProjectWorkItem = {
      ...structuredClone(SECOND_ITEM),
      id: "foreign-work",
      projectId: "project-2",
    };
    const source = workspace({
      workItems: [FIRST_ITEM, SECOND_ITEM, foreignItem],
      dependencies: [
        {
          id: "cross-project",
          projectId: PROJECT.id,
          fromId: FIRST_ITEM.id,
          toId: foreignItem.id,
          type: "FS",
          lagSeconds: 0,
          revision: 1,
        },
      ],
    });

    const result = scheduleV2Project(source, PROJECT.id, MIDPOINT);

    expect(result?.unsupported).toContain(
      "Cross-project dependency cross-project is unsupported in V2.",
    );
  });
});

describe("executable projection policy", () => {
  it("fails closed when a Project has more than one uninvalidated Bet", () => {
    const duplicateCurrentBet: BetVersion = {
      ...structuredClone(BET),
      id: "bet-duplicate-current",
      version: 2,
      supersedesId: BET.id,
    };
    const source = workspace({
      bets: [structuredClone(BET), duplicateCurrentBet],
    });

    expect(projectToSchedulerInput(source, source.projects[0])).toBeUndefined();
    expect(scheduleV2Project(source, PROJECT.id, MIDPOINT)).toBeUndefined();
    expect(scheduleExecutablePortfolio(source, MIDPOINT)).toEqual([]);
  });

  it.each([
    ["extended appetite", (bet: BetVersion) => {
      bet.appetiteEnd = "2026-07-11T14:00:00.000Z";
    }],
    ["approval/start mismatch", (bet: BetVersion) => {
      bet.appetiteStart = "2026-07-11T08:00:00.000Z";
    }],
    ["committed scope drift", (bet: BetVersion) => {
      bet.committedScope = [{
        id: "scope-forged",
        title: "Forged",
        description: "Not present in the immutable snapshot.",
      }];
    }],
    ["snapshot hash drift", (bet: BetVersion) => {
      const forgedScope = [{
        id: "scope-forged",
        title: "Forged expansion",
        description: "Changed in both duplicated fields after approval.",
      }];
      bet.briefSnapshot.firstScope = structuredClone(forgedScope);
      bet.committedScope = structuredClone(forgedScope);
    }],
  ])("fails closed for internally inconsistent Bet %s", (_failure, mutate) => {
    const source = workspace();
    mutate(source.bets[0]);

    expect(projectToSchedulerInput(source, source.projects[0])).toBeUndefined();
    expect(scheduleV2Project(source, PROJECT.id, MIDPOINT)).toBeUndefined();
    expect(scheduleExecutablePortfolio(source, MIDPOINT)).toEqual([]);
  });

  it.each([
    ["unbet", { projects: [{ ...PROJECT, activeBetId: undefined }], bets: [] }],
    ["expired", {}],
    [
      "migration review",
      { projects: [{ ...PROJECT, holds: [hold("migration_review")] }] },
    ],
    [
      "Re-bet required",
      { projects: [{ ...PROJECT, holds: [hold("rebet_required", [BET.id])] }] },
    ],
  ] as const)("excludes %s project work from new scheduling", (name, overrides) => {
    const source = workspace(overrides as Partial<WorkspaceV2>);
    const now = name === "expired" ? END : MIDPOINT;

    expect(scheduleExecutablePortfolio(source, now)).toEqual([]);
  });

  it("retains only already committed work while Review is overdue", () => {
    const source = workspace({
      projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
    });

    const [result] = scheduleExecutablePortfolio(source, MIDPOINT);

    expect(result.items.map(({ workItem }) => workItem.id)).toEqual([
      FIRST_ITEM.id,
    ]);
  });

  it("selects one current commitment fork deterministically", () => {
    const template = workspace().dailyCommitments[0];
    const retainedBranch = {
      ...structuredClone(template),
      id: "branch-a",
      version: 2,
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-retained",
          target: {
            kind: "work_item" as const,
            workItemId: SECOND_ITEM.id,
            projectId: PROJECT.id,
          },
          targetRevision: SECOND_ITEM.revision,
        },
      ],
    };
    const discardedBranch = {
      ...structuredClone(template),
      id: "branch-b",
      version: 2,
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-discarded",
          targetRevision: FIRST_ITEM.revision,
        },
      ],
    };
    const scheduleIds = (commitments: WorkspaceV2["dailyCommitments"]) => {
      const source = workspace({
        projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
        dailyCommitments: commitments,
      });
      return scheduleExecutablePortfolio(source, MIDPOINT)[0].items.map(
        ({ workItem }) => workItem.id,
      );
    };

    expect(scheduleIds([retainedBranch, discardedBranch])).toEqual([
      SECOND_ITEM.id,
    ]);
    expect(scheduleIds([discardedBranch, retainedBranch])).toEqual([
      SECOND_ITEM.id,
    ]);
  });

  it("selects one current commitment across snapshot time zones by instant", () => {
    const template = workspace().dailyCommitments[0];
    const retained = {
      ...structuredClone(template),
      id: "commitment-retained-by-instant",
      version: 2,
      committedAt: "2026-07-11T10:30:00.000Z",
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-retained-by-instant",
          target: {
            kind: "work_item" as const,
            workItemId: SECOND_ITEM.id,
            projectId: PROJECT.id,
          },
          targetRevision: SECOND_ITEM.revision,
        },
      ],
    };
    const discarded = {
      ...structuredClone(template),
      id: "commitment-discarded-by-instant",
      localDate: "2026-07-12",
      version: 2,
      committedAt: "2026-07-11T20:00:00.000+10:00",
      capacitySnapshot: {
        ...structuredClone(template.capacitySnapshot),
        timeZone: "Pacific/Kiritimati",
      },
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-discarded-by-instant",
        },
      ],
    };
    const source = workspace({
      projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
      dailyCommitments: [discarded, retained],
    });

    const [result] = scheduleExecutablePortfolio(source, MIDPOINT);

    expect(result.items.map(({ workItem }) => workItem.id)).toEqual([
      SECOND_ITEM.id,
    ]);
  });

  it("does not resurrect a losing fork when its winner is no longer current", () => {
    const template = workspace().dailyCommitments[0];
    const winner = {
      ...structuredClone(template),
      id: "fork-winner-not-current",
      version: 2,
      capacitySnapshot: {
        ...structuredClone(template.capacitySnapshot),
        timeZone: "Pacific/Kiritimati",
      },
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-winner-not-current",
          target: {
            kind: "work_item" as const,
            workItemId: SECOND_ITEM.id,
            projectId: PROJECT.id,
          },
          targetRevision: SECOND_ITEM.revision,
        },
      ],
    };
    const losingFork = {
      ...structuredClone(template),
      id: "fork-loser-current",
      version: 1,
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          id: "slot-loser-current",
        },
      ],
    };
    const source = workspace({
      projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
      dailyCommitments: [losingFork, winner],
    });

    const [result] = scheduleExecutablePortfolio(source, MIDPOINT);

    expect(result.items).toEqual([]);
  });

  it("excludes a Work Item whose committed revision is stale", () => {
    const staleCommitment = {
      ...structuredClone(workspace().dailyCommitments[0]),
      slots: [
        {
          ...structuredClone(COMMITTED_SLOT),
          targetRevision: FIRST_ITEM.revision - 1,
        },
      ],
    };
    const source = workspace({
      projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
      dailyCommitments: [staleCommitment],
    });

    const [result] = scheduleExecutablePortfolio(source, MIDPOINT);

    expect(result.items).toEqual([]);
  });

  it("does not treat an earlier local day's commitment as today's committed work", () => {
    const source = workspace({
      projects: [{ ...PROJECT, holds: [hold("review_overdue")] }],
      dailyCommitments: [
        {
          ...workspace().dailyCommitments[0],
          id: "commitment-yesterday",
          localDate: "2026-07-10",
          slots: [
            {
              ...COMMITTED_SLOT,
              id: "slot-yesterday",
              target: {
                kind: "work_item",
                workItemId: SECOND_ITEM.id,
                projectId: PROJECT.id,
              },
              targetRevision: SECOND_ITEM.revision,
            },
          ],
        },
        workspace().dailyCommitments[0],
      ],
    });

    const [result] = scheduleExecutablePortfolio(source, MIDPOINT);

    expect(result.items.map(({ workItem }) => workItem.id)).toEqual([
      FIRST_ITEM.id,
    ]);
  });

  it("limits sync conflict fallout to the affected lifecycle record", () => {
    const commitmentConflict = workspace({
      projects: [
        {
          ...PROJECT,
          holds: [hold("sync_conflict", ["commitment-1"])],
        },
      ],
    });
    const unrelatedConflict = workspace({
      projects: [
        {
          ...PROJECT,
          holds: [hold("sync_conflict", ["review-unrelated"])],
        },
      ],
    });

    const [limited] = scheduleExecutablePortfolio(commitmentConflict, MIDPOINT);
    const [unrelated] = scheduleExecutablePortfolio(unrelatedConflict, MIDPOINT);

    expect(limited.items.map(({ workItem }) => workItem.id)).toEqual([
      SECOND_ITEM.id,
    ]);
    expect(unrelated.items.map(({ workItem }) => workItem.id)).toEqual([
      FIRST_ITEM.id,
      SECOND_ITEM.id,
    ]);
  });

  it.each([PROJECT.id, BET.id, "plan-1"])(
    "excludes all project work when sync conflict affects %s",
    (recordId) => {
      const source = workspace({
        projects: [
          { ...PROJECT, holds: [hold("sync_conflict", [recordId])] },
        ],
      });

      expect(scheduleExecutablePortfolio(source, MIDPOINT)).toEqual([]);
    },
  );

  it("never delegates with an invalid or ambient scheduler start", () => {
    const source = workspace({
      bets: [{ ...BET, appetiteStart: "not-a-date" }],
    });

    expect(projectToSchedulerInput(source, source.projects[0])).toBeUndefined();
    expect(scheduleV2Project(source, PROJECT.id, MIDPOINT)).toBeUndefined();
  });
});

describe("recurring and reporting adapters", () => {
  it("delegates recurring projection with preserved cadence and explicit fallback", () => {
    const item = structuredClone(FIRST_ITEM);
    const expected = generateRecurringOccurrences(
      workItemToSchedulerInput(item),
      START,
      8,
    );

    expect(recurringOccurrencesForV2(item, START, 8)).toEqual(expected);
    expect(projectRecurringOccurrences(workspace(), PROJECT.id, 8)).toEqual([
      { workItemId: item.id, occurrences: expected },
    ]);
  });

  it("keeps superseded Bet scope out of recurring and risk projections", () => {
    const supersededItem: ProjectWorkItem = {
      ...structuredClone(FIRST_ITEM),
      id: "work-from-old-bet",
      betScopeId: "scope-from-old-bet",
    };
    const source = workspace({
      workItems: [FIRST_ITEM, SECOND_ITEM, supersededItem],
    });
    const projectedProject = projectToSchedulerInput(source, source.projects[0]);
    expect(projectedProject).toBeDefined();
    if (projectedProject === undefined) throw new Error("Expected project");

    expect(projectRecurringOccurrences(source, PROJECT.id, 8)).toEqual([
      {
        workItemId: FIRST_ITEM.id,
        occurrences: generateRecurringOccurrences(
          workItemToSchedulerInput(FIRST_ITEM),
          START,
          8,
        ),
      },
    ]);
    expect(runV2MonteCarlo(source, PROJECT.id, 40, 17)).toEqual(
      runMonteCarlo(
        projectedProject,
        [FIRST_ITEM, SECOND_ITEM].map(workItemToSchedulerInput),
        source.dependencies.map(({ revision: _revision, ...dependency }) =>
          dependency,
        ),
        40,
        17,
      ),
    );
  });

  it("maps only Work Item actuals and delegates EVM with the selected baseline", () => {
    const source = workspace();
    const projectedProject = projectToSchedulerInput(source, source.projects[0]);
    const schedule = scheduleV2Project(source, PROJECT.id, MIDPOINT);
    expect(projectedProject).toBeDefined();
    expect(schedule).toBeDefined();
    if (projectedProject === undefined || schedule === undefined) {
      throw new Error("Expected reporting inputs");
    }
    const actuals = actualsForProjectReporting(source, PROJECT.id);
    const baseline = selectV2Baseline(source, PROJECT.id);

    expect(actuals).toEqual([
      {
        workItemId: FIRST_ITEM.id,
        actualWorkSeconds: 1_800,
        remainingWorkSeconds: 1_800,
        actualCost: 60,
        recordedAt: MIDPOINT,
      },
    ]);
    expect(baseline).toEqual(BASELINE);
    expect(calculateV2Evm(source, PROJECT.id, MIDPOINT)).toEqual(
      calculateEvm(
        projectedProject,
        schedule.items,
        BASELINE,
        actuals,
        source.resources,
        MIDPOINT,
      ),
    );
  });

  it.each([
    {
      name: "captured timestamp",
      build: () => ({ ...structuredClone(BASELINE), capturedAt: "not-a-date" }),
    },
    {
      name: "planned start timestamp",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedStartByItem: {
          ...BASELINE.plannedStartByItem,
          [FIRST_ITEM.id]: "not-a-date",
        },
      }),
    },
    {
      name: "planned finish timestamp",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedFinishByItem: {
          ...BASELINE.plannedFinishByItem,
          [FIRST_ITEM.id]: "not-a-date",
        },
      }),
    },
    {
      name: "mismatched item keys",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedFinishByItem: { [FIRST_ITEM.id]: MIDPOINT },
      }),
    },
    {
      name: "finish before start",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedStartByItem: {
          ...BASELINE.plannedStartByItem,
          [FIRST_ITEM.id]: MIDPOINT,
        },
        plannedFinishByItem: {
          ...BASELINE.plannedFinishByItem,
          [FIRST_ITEM.id]: START,
        },
      }),
    },
    {
      name: "negative planned work",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedWorkSecondsByItem: {
          ...BASELINE.plannedWorkSecondsByItem,
          [FIRST_ITEM.id]: -1,
        },
      }),
    },
    {
      name: "nonfinite planned work",
      build: () => ({
        ...structuredClone(BASELINE),
        plannedWorkSecondsByItem: {
          ...BASELINE.plannedWorkSecondsByItem,
          [FIRST_ITEM.id]: Number.NaN,
        },
      }),
    },
  ])("ignores an imported Baseline with invalid $name", ({ build }) => {
    const candidate = build();
    const invalid = {
      ...candidate,
      id: "baseline-invalid",
      capturedAt:
        candidate.capturedAt === "not-a-date"
          ? "not-a-date"
          : "2026-07-12T09:00:00.000Z",
    } satisfies Baseline;
    const source = workspace({
      baselines: [structuredClone(BASELINE), invalid],
    });

    expect(selectV2Baseline(source, PROJECT.id)).toEqual(BASELINE);
    const evm = calculateV2Evm(source, PROJECT.id, MIDPOINT);
    expect(evm).toBeDefined();
    expect(
      evm === undefined
        ? []
        : [
            evm.plannedValue,
            evm.earnedValue,
            evm.actualCost,
            evm.schedulePerformanceIndex,
            evm.costPerformanceIndex,
            evm.estimateAtCompletion,
          ].every(Number.isFinite),
    ).toBe(true);
  });

  it("selects equivalent Baseline capture instants by stable ID", () => {
    const baselineA = {
      ...structuredClone(BASELINE),
      id: "baseline-a",
      capturedAt: START,
    };
    const baselineZ = {
      ...structuredClone(BASELINE),
      id: "baseline-z",
      capturedAt: "2026-07-11T18:00:00.000+09:00",
    };
    const selectedId = (baselines: Baseline[]) =>
      selectV2Baseline(workspace({ baselines }), PROJECT.id)?.id;

    expect(selectedId([baselineA, baselineZ])).toBe(baselineA.id);
    expect(selectedId([baselineZ, baselineA])).toBe(baselineA.id);
  });

  it("aggregates incremental Work Item actuals independent of input order", () => {
    const events: WorkspaceV2["actuals"] = [
      {
        id: "actual-a",
        revision: 1,
        target: { kind: "work_item", workItemId: FIRST_ITEM.id },
        actualStart: "2026-07-11T09:15:00.000Z",
        actualFinish: "2026-07-11T10:00:00.000Z",
        actualWorkSeconds: 600,
        remainingWorkSeconds: 3_000,
        actualCost: 10,
        recordedAt: "2026-07-11T10:00:00.000Z",
      },
      {
        id: "actual-b",
        revision: 2,
        target: { kind: "work_item", workItemId: FIRST_ITEM.id },
        actualStart: START,
        actualFinish: "2026-07-11T10:30:00.000Z",
        actualWorkSeconds: 1_200,
        remainingWorkSeconds: 1_200,
        actualCost: 30,
        recordedAt: MIDPOINT,
      },
      {
        id: "actual-c",
        revision: 2,
        target: { kind: "work_item", workItemId: FIRST_ITEM.id },
        actualFinish: END,
        actualWorkSeconds: 300,
        remainingWorkSeconds: 999,
        actualCost: 5,
        recordedAt: "2026-07-11T20:00:00.000+09:00",
      },
      {
        id: "actual-action",
        revision: 1,
        target: { kind: "action", actionId: "action-1" },
        actualWorkSeconds: 900,
        remainingWorkSeconds: 0,
        actualCost: 15,
        recordedAt: MIDPOINT,
      },
    ];
    const forward = workspace({ actuals: events });
    const reverse = workspace({ actuals: [...events].reverse() });
    const expected = [
      {
        workItemId: FIRST_ITEM.id,
        actualStart: START,
        actualFinish: END,
        actualWorkSeconds: 2_100,
        remainingWorkSeconds: 1_200,
        actualCost: 45,
        recordedAt: MIDPOINT,
      },
    ];

    expect(actualsForProjectReporting(forward, PROJECT.id)).toEqual(expected);
    expect(actualsForProjectReporting(reverse, PROJECT.id)).toEqual(expected);
    expect(calculateV2Evm(forward, PROJECT.id, MIDPOINT)).toEqual(
      calculateV2Evm(reverse, PROJECT.id, MIDPOINT),
    );
  });

  it("sums each Actual event using the V1 EVM-effective cost", () => {
    const source = workspace({
      actuals: [
        {
          id: "actual-explicit-cost",
          revision: 1,
          target: { kind: "work_item", workItemId: FIRST_ITEM.id },
          actualWorkSeconds: 1_800,
          remainingWorkSeconds: 1_800,
          actualCost: 60,
          recordedAt: START,
        },
        {
          id: "actual-work-fallback",
          revision: 2,
          target: { kind: "work_item", workItemId: FIRST_ITEM.id },
          actualWorkSeconds: 1_800,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: MIDPOINT,
        },
      ],
    });

    expect(actualsForProjectReporting(source, PROJECT.id)[0]?.actualCost).toBe(
      60.5,
    );
    expect(calculateV2Evm(source, PROJECT.id, MIDPOINT)?.actualCost).toBe(60.5);
  });

  it("delegates deterministic Monte Carlo through preserved V2 IDs", () => {
    const source = workspace();
    const projectedProject = projectToSchedulerInput(source, source.projects[0]);
    expect(projectedProject).toBeDefined();
    if (projectedProject === undefined) throw new Error("Expected project");
    const projectedItems = source.workItems.map(workItemToSchedulerInput);
    const projectedDependencies = source.dependencies.map(
      ({ revision: _revision, ...dependency }) => dependency,
    );

    expect(runV2MonteCarlo(source, PROJECT.id, 40, 17)).toEqual(
      runMonteCarlo(
        projectedProject,
        projectedItems,
        projectedDependencies,
        40,
        17,
      ),
    );
  });
});
