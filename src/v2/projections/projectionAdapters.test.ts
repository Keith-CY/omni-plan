import { describe, expect, it } from "vitest";

import { calculateEvm } from "@/domain/evm";
import { runMonteCarlo } from "@/domain/monteCarlo";
import { generateRecurringOccurrences } from "@/domain/recurring";
import { scheduleProject } from "@/domain/scheduler";
import type { Baseline, Resource } from "@/domain/types";

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
  briefHash: "brief-hash",
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
    const project = projectToSchedulerInput(source, source.projects[0]);
    expect(project).toBeDefined();
    if (project === undefined) throw new Error("Expected scheduler project");

    const expected = scheduleProject(
      project,
      source.workItems.map(workItemToSchedulerInput),
      source.dependencies.map(({ revision: _revision, ...dependency }) => dependency),
    );
    const actual = scheduleV2Project(source, PROJECT.id, MIDPOINT);

    expect(actual).toBeDefined();
    if (actual === undefined) throw new Error("Expected V2 schedule");
    expect(scheduleSummary(actual)).toEqual(scheduleSummary(expected));
    expect(project.start).toBe(START);
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
