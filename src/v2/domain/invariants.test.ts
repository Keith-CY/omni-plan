import { describe, expect, it } from "vitest";

import type { Baseline, Evidence, ISODate } from "@/domain/types";

import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  validateWorkspaceInvariants,
  type InvariantViolation,
} from "./invariants";
import { stableHashSync } from "./stableHash";
import type {
  Action,
  CloseDecision,
  DailyCommitment,
  DirectionBrief,
  ExceptionRecord,
  LegacyAuditRecord,
  PlanVersion,
  ProjectDependency,
  ProjectV2,
  ProjectWorkItem,
  JsonValue,
  WorkspaceV2,
} from "./types";

const NOW = "2026-07-10T12:00:00.000Z";
const CREATED_AT = "2026-07-10T08:00:00.000Z";
const FUTURE = "2026-07-11T12:00:00.000Z";

function buildWorkItem(
  overrides: Partial<ProjectWorkItem> = {},
): ProjectWorkItem {
  return {
    id: "work-item-1",
    projectId: "project-1",
    kind: "task",
    title: "Implement invariant",
    outline: "Keep the fixture explicit",
    durationSeconds: 3_600,
    estimate: { mostLikelySeconds: 3_600 },
    assignmentIds: [],
    percentComplete: 0,
    revision: 1,
    betScopeId: "scope-1",
    ...overrides,
  };
}

function buildPlan(overrides: Partial<PlanVersion> = {}): PlanVersion {
  return {
    id: "plan-1",
    projectId: "project-1",
    version: 1,
    betId: "bet-1",
    workItemRevisions: { "work-item-1": 1 },
    dependencyRevisions: {},
    scopeMapping: { "work-item-1": "scope-1" },
    scheduleHash: "schedule-hash",
    capacityIndependentDates: {},
    actorId: "human-1",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function buildValidWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    appetiteSeconds: 100_800,
    firstScope: [
      { id: "scope-1", title: "Scope one", description: "Committed scope" },
    ],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: "project-1",
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: CREATED_AT,
    appetiteEnd: FUTURE,
    actorId: "human-1",
    approvedAt: CREATED_AT,
  });
  const project = buildProjectV2({
    id: "project-1",
    stage: "executing",
    activeDirectionBriefId: brief.id,
    activeBetId: bet.id,
    activePlanVersionId: "plan-1",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });

  return buildWorkspaceV2("workspace-1", {
    revision: 12,
    projects: [project],
    directionBriefs: [brief],
    bets: [bet],
    planVersions: [buildPlan()],
    workItems: [buildWorkItem()],
  });
}

function setCurrentBetAppetiteEnd(
  workspace: WorkspaceV2,
  appetiteEnd: ISODate,
): void {
  const bet = workspace.bets[0];
  bet.appetiteEnd = appetiteEnd;
  bet.briefSnapshot.appetiteSeconds =
    (Date.parse(appetiteEnd) - Date.parse(bet.appetiteStart)) / 1_000;
  bet.briefHash = stableHashSync(
    bet.briefSnapshot as unknown as JsonValue,
  );
}

function codes(violations: InvariantViolation[]): string[] {
  return violations.map(({ code }) => code);
}

function violationsWithCode(
  workspace: WorkspaceV2,
  code: InvariantViolation["code"],
  previousWorkspace?: WorkspaceV2,
): InvariantViolation[] {
  return validateWorkspaceInvariants(workspace, NOW, previousWorkspace).filter(
    (violation) => violation.code === code,
  );
}

function buildRebetPausedWorkspaces(): {
  previous: WorkspaceV2;
  candidate: WorkspaceV2;
} {
  const previous = buildValidWorkspace();
  previous.dependencies = [
    {
      id: "dependency-history",
      projectId: "project-1",
      fromId: "work-item-1",
      toId: "work-item-1",
      type: "FS",
      lagSeconds: 0,
      revision: 1,
    },
    {
      id: "dependency-unrelated",
      projectId: "project-1",
      fromId: "work-item-1",
      toId: "work-item-1",
      type: "SS",
      lagSeconds: 300,
      revision: 1,
    },
  ];
  previous.planVersions[0].dependencyRevisions = {
    "dependency-history": 1,
  };
  previous.actuals = [
    {
      id: "actual-history",
      revision: 1,
      target: { kind: "work_item", workItemId: "work-item-1" },
      actualWorkSeconds: 600,
      remainingWorkSeconds: 3_000,
      actualCost: 0,
      recordedAt: CREATED_AT,
    },
  ];
  previous.dailyCommitments = [
    {
      id: "commitment-history",
      localDate: "2026-07-10",
      version: 1,
      proposalHash: "historical-commitment",
      capacitySnapshot: buildCapacityProfile({
        dailyBudgets: [
          {
            weekday: 5,
            deepSeconds: 3_600,
            mediumSeconds: 3_600,
            shallowSeconds: 3_600,
          },
        ],
        updatedAt: CREATED_AT,
        updatedBy: "human-1",
      }),
      slots: [
        {
          id: "slot-history",
          target: {
            kind: "work_item",
            workItemId: "work-item-1",
            projectId: "project-1",
          },
          targetRevision: 1,
          start: "2026-07-10T09:00:00.000Z",
          finish: "2026-07-10T09:30:00.000Z",
          attention: "deep",
        },
      ],
      actorId: "human-1",
      committedAt: CREATED_AT,
    },
  ];

  const candidate = structuredClone(previous);
  candidate.bets[0].invalidatedAt = NOW;
  candidate.bets[0].invalidationReason = "Direction changed materially";
  candidate.projects[0].holds.push({
    type: "rebet_required",
    sourceId: "bet-1",
    affectedRecordIds: [
      "project-1",
      "bet-1",
      "plan-1",
      "work-item-1",
      "dependency-history",
      "actual-history",
      "commitment-history",
    ],
    createdAt: NOW,
  });

  return { previous, candidate };
}

function buildPersistedRebetPausedWorkspaces(): {
  previous: WorkspaceV2;
  candidate: WorkspaceV2;
} {
  const paused = buildRebetPausedWorkspaces().candidate;
  return {
    previous: structuredClone(paused),
    candidate: structuredClone(paused),
  };
}

function advanceReferencedDependencyBeyondPlanSnapshot(
  workspace: WorkspaceV2,
): void {
  const dependency = workspace.dependencies.find(
    ({ id }) => id === "dependency-history",
  );
  if (dependency === undefined) {
    throw new Error("Expected dependency-history fixture");
  }
  dependency.lagSeconds = 600;
  dependency.revision = 2;
}

function buildPendingReplanRebetPausedWorkspaces(): {
  previous: WorkspaceV2;
  candidate: WorkspaceV2;
} {
  const workspaces = buildRebetPausedWorkspaces();
  advanceReferencedDependencyBeyondPlanSnapshot(workspaces.previous);
  advanceReferencedDependencyBeyondPlanSnapshot(workspaces.candidate);
  return workspaces;
}

function buildPersistedPendingReplanRebetPausedWorkspaces(): {
  previous: WorkspaceV2;
  candidate: WorkspaceV2;
} {
  const paused = buildPendingReplanRebetPausedWorkspaces().candidate;
  return {
    previous: structuredClone(paused),
    candidate: structuredClone(paused),
  };
}

describe("validateWorkspaceInvariants Bet rules", () => {
  it("accepts a valid deterministic workspace without mutation", () => {
    const workspace = buildValidWorkspace();
    const original = structuredClone(workspace);

    expect(validateWorkspaceInvariants(workspace, NOW)).toEqual([]);
    expect(workspace).toEqual(original);
  });

  it("requires an executing project to point at a current Bet", () => {
    const workspace = buildValidWorkspace();
    delete workspace.projects[0].activeBetId;

    expect(violationsWithCode(workspace, "BET_REQUIRED")).toEqual([
      {
        code: "BET_REQUIRED",
        reason:
          "Active Plan plan-1 must use current Bet none, not historical or mismatched Bet bet-1.",
        gate: "plan:plan-1:current_bet",
        permittedNextCommand: "place_bet",
      },
      {
        code: "BET_REQUIRED",
        reason: "Executing project project-1 has no valid current Bet.",
        gate: "project:project-1:current_bet",
        permittedNextCommand: "place_bet",
      },
    ]);
  });

  it.each(["planning", "validating", "closing"] as const)(
    "requires a %s project to point at a valid current Bet",
    (stage) => {
      const workspace = buildValidWorkspace();
      workspace.projects[0].stage = stage;
      delete workspace.projects[0].activeBetId;

      expect(violationsWithCode(workspace, "BET_REQUIRED")).toContainEqual({
        code: "BET_REQUIRED",
        reason: `Active project project-1 has no valid current Bet while ${stage}.`,
        gate: "project:project-1:current_bet",
        permittedNextCommand: "place_bet",
      });
    },
  );

  it.each([
    ["dangling", (workspace: WorkspaceV2) => {
      workspace.projects[0].activeBetId = "bet-missing";
    }],
    ["invalidated", (workspace: WorkspaceV2) => {
      workspace.bets[0].invalidatedAt = NOW;
      workspace.bets[0].invalidationReason = "Replaced";
    }],
    ["wrong owner", (workspace: WorkspaceV2) => {
      workspace.bets[0].projectId = "project-other";
    }],
  ] as const)("rejects an executing project's %s active Bet", (_name, mutate) => {
    const workspace = buildValidWorkspace();
    mutate(workspace);

    expect(codes(validateWorkspaceInvariants(workspace, NOW))).toContain(
      "BET_REQUIRED",
    );
  });

  it("rejects multiple current uninvalidated Bets in an active lifecycle stage", () => {
    const workspace = buildValidWorkspace();
    workspace.projects[0].stage = "planning";
    workspace.bets.push(
      buildBetVersion({
        ...structuredClone(workspace.bets[0]),
        id: "bet-2",
        version: 2,
        supersedesId: "bet-1",
      }),
    );

    expect(violationsWithCode(workspace, "BET_REQUIRED")).toEqual([
      {
        code: "BET_REQUIRED",
        reason:
          "Active project project-1 has multiple current Bets: bet-1, bet-2.",
        gate: "project:project-1:single_current_bet",
        permittedNextCommand: "place_bet",
      },
    ]);
  });

  it("does not count invalidated historical Bets as current", () => {
    const workspace = buildValidWorkspace();
    workspace.bets.push(
      buildBetVersion({
        ...structuredClone(workspace.bets[0]),
        id: "bet-history",
        version: 0,
        invalidatedAt: CREATED_AT,
        invalidationReason: "Superseded",
      }),
    );

    expect(violationsWithCode(workspace, "BET_REQUIRED")).toEqual([]);
  });

  it("expires an executing Bet at the exact appetite boundary without extending it", () => {
    const workspace = buildValidWorkspace();
    setCurrentBetAppetiteEnd(workspace, NOW);
    const originalEnd = workspace.bets[0].appetiteEnd;

    expect(violationsWithCode(workspace, "BET_EXPIRED")).toEqual([
      {
        code: "BET_EXPIRED",
        reason:
          "Current Bet bet-1 for executing project project-1 expired at 2026-07-10T12:00:00.000Z.",
        gate: "bet:bet-1:appetite_end",
        permittedNextCommand: "record_bet_boundary",
      },
    ]);
    expect(workspace.bets[0].appetiteEnd).toBe(originalEnd);
  });

  it("rejects an active Plan tied to an invalidated historical Bet", () => {
    const workspace = buildValidWorkspace();
    workspace.bets.push({
      ...structuredClone(workspace.bets[0]),
      id: "bet-history",
      version: 0,
      invalidatedAt: CREATED_AT,
      invalidationReason: "Superseded",
    });
    workspace.planVersions[0].betId = "bet-history";

    expect(violationsWithCode(workspace, "BET_REQUIRED")).toContainEqual({
      code: "BET_REQUIRED",
      reason:
        "Active Plan plan-1 must use current Bet bet-1, not historical or mismatched Bet bet-history.",
      gate: "plan:plan-1:current_bet",
      permittedNextCommand: "place_bet",
    });
  });

  it.each(["actual", "commitment"] as const)(
    "rejects a project Work Item %s without a valid current Bet",
    (kind) => {
      const workspace = buildValidWorkspace();
      workspace.projects[0].stage = "direction";
      delete workspace.projects[0].activeBetId;

      if (kind === "actual") {
        workspace.actuals.push({
          id: "actual-without-bet",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-item-1" },
          actualWorkSeconds: 60,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: CREATED_AT,
        });
      } else {
        workspace.dailyCommitments.push({
          id: "commitment-without-bet",
          localDate: "2026-07-10",
          version: 1,
          proposalHash: "hash",
          capacitySnapshot: buildCapacityProfile({
            dailyBudgets: [
              {
                weekday: 5,
                deepSeconds: 3_600,
                mediumSeconds: 3_600,
                shallowSeconds: 3_600,
              },
            ],
            updatedAt: CREATED_AT,
            updatedBy: "human-1",
          }),
          slots: [
            {
              id: "slot-without-bet",
              target: {
                kind: "work_item",
                workItemId: "work-item-1",
                projectId: "project-1",
              },
              targetRevision: 1,
              start: "2026-07-10T09:00:00.000Z",
              finish: "2026-07-10T09:30:00.000Z",
              attention: "deep",
            },
          ],
          actorId: "human-1",
          committedAt: CREATED_AT,
        });
      }

      expect(violationsWithCode(workspace, "BET_REQUIRED")).toContainEqual({
        code: "BET_REQUIRED",
        reason:
          kind === "actual"
            ? "Actual actual-without-bet targets Work Item work-item-1 without a valid current Bet for Project project-1."
            : "Daily Commitment commitment-without-bet slot slot-without-bet targets Work Item work-item-1 without a valid current Bet for Project project-1.",
        gate:
          kind === "actual"
            ? "actual:actual-without-bet:current_bet"
            : "daily_commitment:commitment-without-bet:slot:slot-without-bet:current_bet",
        permittedNextCommand: "place_bet",
      });
    },
  );

  it("preserves frozen Plan and execution history during an intentional Re-bet pause", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();

    const violations = validateWorkspaceInvariants(candidate, NOW, previous);

    expect(
      violations.filter(({ code }) =>
        ["BET_REQUIRED", "BET_EXPIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("rejects a Re-bet pause that swaps the retained active Bet pointer", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    candidate.bets.push({
      ...structuredClone(candidate.bets[0]),
      id: "bet-substituted",
      version: 2,
      supersedesId: "bet-1",
    });
    candidate.projects[0].activeBetId = "bet-substituted";

    const gates = violationsWithCode(candidate, "BET_REQUIRED", previous).map(
      ({ gate }) => gate,
    );

    expect(gates).toContain("project:project-1:current_bet");
    expect(gates).toContain("plan:plan-1:current_bet");
  });

  it("rejects a Re-bet pause while an unselected current Bet exists", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    const replacementBet = structuredClone(candidate.bets[0]);
    replacementBet.id = "bet-replacement";
    replacementBet.version = 2;
    replacementBet.supersedesId = "bet-1";
    delete replacementBet.invalidatedAt;
    delete replacementBet.invalidationReason;
    candidate.bets.push(replacementBet);

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toContainEqual(
      expect.objectContaining({
        code: "BET_REQUIRED",
        gate: "project:project-1:current_bet",
      }),
    );
  });

  it("rejects a Re-bet pause that mutates retained Bet data beyond invalidation", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    candidate.bets[0].briefHash = "mutated-brief-hash";

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toContainEqual(
      expect.objectContaining({
        code: "BET_REQUIRED",
        gate: "project:project-1:current_bet",
      }),
    );
  });

  it("accepts the atomic pause when only Bet invalidation fields and the hold change", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "BET_EXPIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("tracks the active Plan's ProjectDependency revision in the Re-bet fixture", () => {
    const { previous } = buildRebetPausedWorkspaces();
    const dependency = previous.dependencies.find(
      ({ id }) => id === "dependency-history",
    );

    expect(previous.planVersions[0].dependencyRevisions).toEqual({
      "dependency-history": 1,
    });
    expect(dependency?.revision).toBe(1);
  });

  it.each(["atomic", "persisted"] as const)(
    "rejects a referenced ProjectDependency change from a pending Replan during an %s Re-bet pause",
    (mode) => {
      const { previous, candidate } =
        mode === "atomic"
          ? buildPendingReplanRebetPausedWorkspaces()
          : buildPersistedPendingReplanRebetPausedWorkspaces();
      const dependency = candidate.dependencies.find(
        ({ id }) => id === "dependency-history",
      );
      if (dependency === undefined) {
        throw new Error("Expected dependency-history fixture");
      }
      dependency.lagSeconds = 900;
      dependency.revision = 3;

      expect(
        validateWorkspaceInvariants(candidate, NOW, previous),
      ).toContainEqual(
        expect.objectContaining({
          code: "BET_REQUIRED",
          gate: "plan:plan-1:current_bet",
        }),
      );
    },
  );

  it("allows an atomic Re-bet pause when a pending Replan has advanced the live dependency", () => {
    const { previous, candidate } = buildPendingReplanRebetPausedWorkspaces();

    expect(previous.planVersions[0].dependencyRevisions).toEqual({
      "dependency-history": 1,
    });
    expect(
      previous.dependencies.find(({ id }) => id === "dependency-history")
        ?.revision,
    ).toBe(2);
    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("sustains a persisted Re-bet pause with a newer unchanged live dependency", () => {
    const { previous, candidate } =
      buildPersistedPendingReplanRebetPausedWorkspaces();

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("allows a Direction edit during a persisted Re-bet pause with a pending Replan", () => {
    const { previous, candidate } =
      buildPersistedPendingReplanRebetPausedWorkspaces();
    const direction = buildDirectionBrief({
      ...structuredClone(candidate.directionBriefs[0]),
      id: "brief-pending-replan-edit",
      version: 2,
      audienceAndProblem: "Refined while pending Replan remains frozen",
      createdAt: NOW,
      updatedAt: NOW,
    });
    candidate.directionBriefs.push(direction);
    candidate.projects[0].activeDirectionBriefId = direction.id;

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("rejects deletion of a ProjectDependency referenced by the frozen Plan", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    candidate.dependencies = candidate.dependencies.filter(
      ({ id }) => id !== "dependency-history",
    );

    expect(
      violationsWithCode(candidate, "ENTITY_NOT_FOUND", previous),
    ).toContainEqual(
      expect.objectContaining({
        gate:
          "reference:PlanVersion:plan-1:dependencyRevisions:dependency-history",
      }),
    );
  });

  it("keeps a Re-bet pause valid when unchanged dependencies are reordered", () => {
    const { previous, candidate } = buildPersistedRebetPausedWorkspaces();
    candidate.dependencies.reverse();

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("ignores changes to dependencies not referenced by the frozen Plan", () => {
    const { previous, candidate } = buildPersistedRebetPausedWorkspaces();
    const dependency = candidate.dependencies.find(
      ({ id }) => id === "dependency-unrelated",
    );
    if (dependency === undefined) {
      throw new Error("Expected dependency-unrelated fixture");
    }
    dependency.lagSeconds = 600;
    dependency.revision += 1;

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("sustains an unchanged persisted Re-bet pause", () => {
    const { previous, candidate } = buildPersistedRebetPausedWorkspaces();

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it("allows a Direction-only edit during a persisted Re-bet pause", () => {
    const { previous, candidate } = buildPersistedRebetPausedWorkspaces();
    const direction = buildDirectionBrief({
      ...structuredClone(candidate.directionBriefs[0]),
      id: "brief-rebet-edit",
      version: 2,
      audienceAndProblem: "Refined during Re-bet pause",
      createdAt: NOW,
      updatedAt: NOW,
    });
    candidate.directionBriefs.push(direction);
    candidate.projects[0].activeDirectionBriefId = direction.id;

    expect(
      validateWorkspaceInvariants(candidate, NOW, previous).filter(({ code }) =>
        ["BET_REQUIRED", "SCOPE_OUTSIDE_BET"].includes(code),
      ),
    ).toEqual([]);
  });

  it.each(["atomic", "persisted"] as const)(
    "rejects removal of a historical project-work Actual during an %s Re-bet pause",
    (mode) => {
      const { previous, candidate } =
        mode === "atomic"
          ? buildRebetPausedWorkspaces()
          : buildPersistedRebetPausedWorkspaces();
      candidate.actuals = [];

      expect(
        violationsWithCode(candidate, "BET_REQUIRED", previous),
      ).toContainEqual(
        expect.objectContaining({
          code: "BET_REQUIRED",
          gate: "actual:actual-history:current_bet",
        }),
      );
    },
  );

  it.each(["slot", "commitment"] as const)(
    "rejects removal of a historical project-work %s during a Re-bet pause",
    (kind) => {
      const { previous, candidate } = buildRebetPausedWorkspaces();
      if (kind === "slot") {
        candidate.dailyCommitments[0].slots = [];
      } else {
        candidate.dailyCommitments = [];
      }

      expect(
        violationsWithCode(candidate, "BET_REQUIRED", previous),
      ).toContainEqual(
        expect.objectContaining({
          code: "BET_REQUIRED",
          gate:
            "daily_commitment:commitment-history:slot:slot-history:current_bet",
        }),
      );
    },
  );

  it.each(["clear_pointer", "change_pointer", "remove_plan"] as const)(
    "rejects frozen active Plan mutation %s during a Re-bet pause",
    (kind) => {
      const { previous, candidate } = buildRebetPausedWorkspaces();
      if (kind === "clear_pointer") {
        delete candidate.projects[0].activePlanVersionId;
      } else if (kind === "change_pointer") {
        candidate.projects[0].activePlanVersionId = "plan-missing";
      } else {
        candidate.planVersions = [];
      }

      expect(
        validateWorkspaceInvariants(candidate, NOW, previous).some(({ code }) =>
          ["BET_REQUIRED", "SCOPE_OUTSIDE_BET", "ENTITY_NOT_FOUND"].includes(
            code,
          ),
        ),
      ).toBe(true);
    },
  );

  it("ignores removal of unrelated Action-only execution history", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    const inbox = {
      id: "inbox-action-history",
      originalText: "Historical action",
      sourceId: "source-1",
      actorId: "human-1",
      capturedAt: CREATED_AT,
      triageStatus: "action" as const,
      actionId: "action-history",
    };
    const action: Action = {
      id: "action-history",
      inboxItemId: inbox.id,
      title: "Historical action",
      revision: 1,
      status: "completed",
      eligibility: {
        singleSession: true,
        estimateSeconds: 600,
        dependencyIds: [],
        requiresMilestoneEvidence: false,
        outcomeCount: 1,
        solutionKnown: true,
      },
      attention: "shallow",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    for (const workspace of [previous, candidate]) {
      workspace.inboxItems.push(structuredClone(inbox));
      workspace.actions.push(structuredClone(action));
      workspace.actuals.push({
        id: "actual-action-history",
        revision: 1,
        target: { kind: "action", actionId: action.id },
        actualWorkSeconds: 600,
        remainingWorkSeconds: 0,
        actualCost: 0,
        recordedAt: CREATED_AT,
      });
      workspace.dailyCommitments[0].slots.push({
        id: "slot-action-history",
        target: { kind: "action", actionId: action.id },
        targetRevision: 1,
        start: "2026-07-10T10:00:00.000Z",
        finish: "2026-07-10T10:10:00.000Z",
        attention: "shallow",
      });
    }
    candidate.actuals = candidate.actuals.filter(
      ({ id }) => id !== "actual-action-history",
    );
    candidate.dailyCommitments[0].slots = candidate.dailyCommitments[0].slots.filter(
      ({ id }) => id !== "slot-action-history",
    );

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toEqual([]);
  });

  it("keeps persisted project-work history valid across canonical reordering", () => {
    const { previous, candidate } = buildPersistedRebetPausedWorkspaces();
    const secondActual = {
      ...structuredClone(previous.actuals[0]),
      id: "actual-history-2",
    };
    const secondSlot = {
      ...structuredClone(previous.dailyCommitments[0].slots[0]),
      id: "slot-history-2",
      start: "2026-07-10T09:30:00.000Z",
      finish: "2026-07-10T10:00:00.000Z",
    };
    previous.actuals.push(structuredClone(secondActual));
    candidate.actuals.push(structuredClone(secondActual));
    previous.dailyCommitments[0].slots.push(structuredClone(secondSlot));
    candidate.dailyCommitments[0].slots.push(structuredClone(secondSlot));
    candidate.actuals.reverse();
    candidate.dailyCommitments[0].slots.reverse();

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toEqual([]);
  });

  it("requires a current Bet for a new Actual during a Re-bet pause", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    candidate.actuals.push({
      ...structuredClone(candidate.actuals[0]),
      id: "actual-new",
      recordedAt: NOW,
    });

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toContainEqual({
      code: "BET_REQUIRED",
      reason:
        "Actual actual-new targets Work Item work-item-1 without a valid current Bet for Project project-1.",
      gate: "actual:actual-new:current_bet",
      permittedNextCommand: "place_bet",
    });
  });

  it.each(["new", "changed"] as const)(
    "requires a current Bet for a %s project-work Commitment slot during a Re-bet pause",
    (kind) => {
      const { previous, candidate } = buildRebetPausedWorkspaces();
      if (kind === "new") {
        candidate.dailyCommitments[0].slots.push({
          ...structuredClone(candidate.dailyCommitments[0].slots[0]),
          id: "slot-new",
          start: "2026-07-10T09:30:00.000Z",
          finish: "2026-07-10T10:00:00.000Z",
        });
      } else {
        candidate.dailyCommitments[0].slots[0].finish =
          "2026-07-10T09:45:00.000Z";
      }

      const slotId = kind === "new" ? "slot-new" : "slot-history";
      expect(
        violationsWithCode(candidate, "BET_REQUIRED", previous),
      ).toContainEqual({
        code: "BET_REQUIRED",
        reason: `Daily Commitment commitment-history slot ${slotId} targets Work Item work-item-1 without a valid current Bet for Project project-1.`,
        gate: `daily_commitment:commitment-history:slot:${slotId}:current_bet`,
        permittedNextCommand: "place_bet",
      });
    },
  );

  it("keeps unchanged historical commitments exempt across unrelated record reordering", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    const evidence = [
      {
        id: "evidence-a",
        kind: "note" as const,
        summary: "First",
        projectId: "project-1",
        workItemId: "work-item-1",
        createdAt: CREATED_AT,
        confidence: 1,
        tags: [],
      },
      {
        id: "evidence-b",
        kind: "note" as const,
        summary: "Second",
        projectId: "project-1",
        workItemId: "work-item-1",
        createdAt: CREATED_AT,
        confidence: 1,
        tags: [],
      },
    ];
    previous.evidence = structuredClone(evidence);
    candidate.evidence = structuredClone(evidence).reverse();

    expect(
      violationsWithCode(candidate, "BET_REQUIRED", previous),
    ).toEqual([]);
  });

  it.each(["changed", "new"] as const)(
    "does not hide a %s active Plan during a Re-bet pause",
    (kind) => {
      const { previous, candidate } = buildRebetPausedWorkspaces();
      if (kind === "changed") {
        candidate.planVersions[0].scheduleHash = "changed-schedule";
      } else {
        candidate.planVersions.push({
          ...structuredClone(candidate.planVersions[0]),
          id: "plan-new",
          version: 2,
          supersedesId: "plan-1",
        });
        candidate.projects[0].activePlanVersionId = "plan-new";
      }

      const planId = kind === "new" ? "plan-new" : "plan-1";
      expect(
        violationsWithCode(candidate, "BET_REQUIRED", previous),
      ).toContainEqual(
        expect.objectContaining({
          code: "BET_REQUIRED",
          gate: `plan:${planId}:current_bet`,
        }),
      );
    },
  );

  it("does not hide malformed active Plan scope during a Re-bet pause", () => {
    const { previous, candidate } = buildRebetPausedWorkspaces();
    candidate.planVersions[0].scopeMapping = {};

    expect(
      violationsWithCode(candidate, "SCOPE_OUTSIDE_BET", previous),
    ).toContainEqual(
      expect.objectContaining({
        code: "SCOPE_OUTSIDE_BET",
        gate: "plan:plan-1:work_item:work-item-1:bet_scope",
      }),
    );
  });
});

describe("validateWorkspaceInvariants Daily Commitment capacity", () => {
  function buildCommitment(
    slots: DailyCommitment["slots"],
    deepSeconds = 3_600,
  ): DailyCommitment {
    return {
      id: "commitment-1",
      localDate: "2026-07-13",
      version: 1,
      proposalHash: "proposal-hash",
      capacitySnapshot: buildCapacityProfile({
        timeZone: "Pacific/Honolulu",
        dailyBudgets: [
          {
            weekday: 0,
            deepSeconds: 99_999,
            mediumSeconds: 99_999,
            shallowSeconds: 99_999,
          },
          {
            weekday: 1,
            deepSeconds,
            mediumSeconds: 3_600,
            shallowSeconds: 3_600,
          },
        ],
        updatedAt: CREATED_AT,
        updatedBy: "human-1",
      }),
      slots,
      actorId: "human-1",
      committedAt: CREATED_AT,
    };
  }

  function deepSlot(id: string, start: ISODate, finish: ISODate) {
    return {
      id,
      target: {
        kind: "work_item" as const,
        workItemId: "work-item-1",
        projectId: "project-1",
      },
      targetRevision: 1,
      start,
      finish,
      attention: "deep" as const,
    };
  }

  it("groups slot seconds by attention against the UTC-derived local weekday", () => {
    const workspace = buildValidWorkspace();
    workspace.dailyCommitments = [
      buildCommitment([
        deepSlot(
          "slot-2",
          "2026-07-13T10:00:00.000Z",
          "2026-07-13T10:30:00.000Z",
        ),
        deepSlot(
          "slot-1",
          "2026-07-13T09:00:00.000Z",
          "2026-07-13T09:45:00.000Z",
        ),
      ]),
    ];

    const forward = violationsWithCode(workspace, "CAPACITY_EXCEEDED");
    workspace.dailyCommitments[0].slots.reverse();
    const reversed = violationsWithCode(workspace, "CAPACITY_EXCEEDED");

    expect(forward).toEqual([
      {
        code: "CAPACITY_EXCEEDED",
        reason:
          "Daily Commitment commitment-1 exceeds Monday deep capacity: 4500 seconds scheduled for a 3600 second budget.",
        gate: "daily_commitment:commitment-1:capacity:deep",
        permittedNextCommand: "commit_today",
      },
    ]);
    expect(reversed).toEqual(forward);
  });

  it("allows a group exactly at its attention budget", () => {
    const workspace = buildValidWorkspace();
    workspace.dailyCommitments = [
      buildCommitment([
        deepSlot(
          "slot-1",
          "2026-07-13T09:00:00.000Z",
          "2026-07-13T10:00:00.000Z",
        ),
      ]),
    ];

    expect(violationsWithCode(workspace, "CAPACITY_EXCEEDED")).toEqual([]);
  });

  it.each([
    ["zero", "2026-07-13T09:00:00.000Z", "2026-07-13T09:00:00.000Z"],
    ["negative", "2026-07-13T10:00:00.000Z", "2026-07-13T09:00:00.000Z"],
    ["invalid", "not-a-date", "2026-07-13T09:00:00.000Z"],
  ])("rejects a %s slot range instead of subtracting it", (_name, start, finish) => {
    const workspace = buildValidWorkspace();
    workspace.dailyCommitments = [
      buildCommitment([deepSlot("slot-invalid", start, finish)]),
    ];

    expect(violationsWithCode(workspace, "CAPACITY_EXCEEDED")).toEqual([
      {
        code: "CAPACITY_EXCEEDED",
        reason:
          "Daily Commitment commitment-1 has invalid or nonpositive slot ranges: slot-invalid.",
        gate: "daily_commitment:commitment-1:slot_ranges",
        permittedNextCommand: "commit_today",
      },
    ]);
  });
});

describe("validateWorkspaceInvariants active Plan scope", () => {
  it.each([
    ["missing Work Item", (workspace: WorkspaceV2) => {
      workspace.planVersions[0].workItemRevisions = { "work-item-missing": 1 };
      workspace.planVersions[0].scopeMapping = {
        "work-item-missing": "scope-1",
      };
    }],
    ["missing scope mapping", (workspace: WorkspaceV2) => {
      workspace.planVersions[0].scopeMapping = {};
    }],
    ["mismatched Work Item scope", (workspace: WorkspaceV2) => {
      workspace.planVersions[0].scopeMapping["work-item-1"] = "scope-2";
    }],
    ["scope outside committed Bet", (workspace: WorkspaceV2) => {
      workspace.workItems[0].betScopeId = "scope-uncommitted";
      workspace.planVersions[0].scopeMapping["work-item-1"] =
        "scope-uncommitted";
    }],
  ] as const)("rejects %s", (_name, mutate) => {
    const workspace = buildValidWorkspace();
    mutate(workspace);

    expect(violationsWithCode(workspace, "SCOPE_OUTSIDE_BET")).toHaveLength(1);
    expect(
      violationsWithCode(workspace, "SCOPE_OUTSIDE_BET")[0],
    ).toMatchObject({
      code: "SCOPE_OUTSIDE_BET",
      gate: expect.stringContaining("plan:plan-1:work_item:"),
      permittedNextCommand: "update_work_item",
    });
  });

  it("does not apply active Plan scope rules to an inactive historical Plan", () => {
    const workspace = buildValidWorkspace();
    workspace.planVersions.push(
      buildPlan({
        id: "plan-history",
        version: 0,
        workItemRevisions: { "work-item-1": 1 },
        scopeMapping: {},
      }),
    );

    expect(violationsWithCode(workspace, "SCOPE_OUTSIDE_BET")).toEqual([]);
  });
});

describe("validateWorkspaceInvariants exceptions", () => {
  function buildException(
    overrides: Partial<ExceptionRecord> = {},
  ): ExceptionRecord {
    return {
      id: "exception-1",
      projectId: "project-1",
      requirementId: "work-item-1",
      rationale: "Temporary allowance",
      knownConsequence: "Review at expiry",
      reviewAt: NOW,
      expiresAt: NOW,
      approvedBy: "human-1",
      createdAt: CREATED_AT,
      history: [],
      ...overrides,
    };
  }

  it("does not globally block on an unrelated unresolved expired exception", () => {
    const workspace = buildValidWorkspace();
    workspace.exceptions = [buildException()];

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });

  it("leaves expired exception enforcement to the command that consumes it", () => {
    const workspace = buildValidWorkspace();
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "completed";
    workspace.exceptions = [buildException()];

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });

  it("does not rely on an expired exception when evidence is attached", () => {
    const workspace = buildValidWorkspace();
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "learned";
    workspace.exceptions = [buildException()];
    workspace.evidence.push({
      id: "evidence-1",
      kind: "note",
      summary: "Supplied",
      projectId: "project-1",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 1,
      tags: [],
    });

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });

  it("does not turn wrong-project Evidence into a global invariant failure", () => {
    const workspace = buildValidWorkspace();
    const otherBrief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    workspace.directionBriefs.push(otherBrief);
    workspace.projects.push(
      buildProjectV2({
        id: "project-2",
        activeDirectionBriefId: otherBrief.id,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }),
    );
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "completed";
    workspace.exceptions = [buildException()];
    workspace.evidence.push({
      id: "evidence-wrong-project",
      kind: "note",
      summary: "Wrong owner",
      projectId: "project-2",
      workItemId: "work-item-1",
      createdAt: CREATED_AT,
      confidence: 1,
      tags: [],
    });

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });

  it("does not treat resolved or future exceptions as expired", () => {
    const workspace = buildValidWorkspace();
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "blocked";
    workspace.exceptions = [
      buildException({ id: "exception-resolved", resolvedAt: NOW }),
      buildException({ id: "exception-future", expiresAt: FUTURE }),
    ];

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });

  it("treats malformed exception dates as inactive without a global violation", () => {
    const workspace = buildValidWorkspace();
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "completed";
    workspace.exceptions = [
      buildException({ createdAt: "not-a-date", expiresAt: "also-not-a-date" }),
    ];

    expect(violationsWithCode(workspace, "EXCEPTION_EXPIRED")).toEqual([]);
  });
});

describe("validateWorkspaceInvariants closed-project immutability", () => {
  function buildClosedWorkspace(): WorkspaceV2 {
    const workspace = buildValidWorkspace();
    workspace.projects[0].stage = "closed";
    workspace.workItems[0].evidenceRequired = true;
    workspace.dependencies = [
      {
        id: "dependency-1",
        projectId: "project-1",
        fromId: "work-item-1",
        toId: "work-item-1",
        type: "FS",
        lagSeconds: 0,
        revision: 1,
      },
    ];
    workspace.planVersions[0].dependencyRevisions = { "dependency-1": 1 };
    workspace.baselines = [
      {
        id: "baseline-1",
        projectId: "project-1",
        name: "Close baseline",
        capturedAt: CREATED_AT,
        plannedStartByItem: {},
        plannedFinishByItem: {},
        plannedWorkSecondsByItem: {},
      },
    ];
    workspace.evidence = [
      {
        id: "evidence-1",
        kind: "note",
        summary: "Validated",
        projectId: "project-1",
        workItemId: "work-item-1",
        createdAt: CREATED_AT,
        confidence: 1,
        tags: [],
      },
    ];
    workspace.exceptions = [
      {
        id: "exception-1",
        projectId: "project-1",
        requirementId: "work-item-1",
        rationale: "Historical",
        knownConsequence: "None",
        reviewAt: CREATED_AT,
        expiresAt: FUTURE,
        approvedBy: "human-1",
        createdAt: CREATED_AT,
        resolvedAt: CREATED_AT,
        history: [],
      },
    ];
    workspace.closeDecisions = [
      {
        id: "close-1",
        projectId: "project-1",
        successComparison: "Met",
        outcome: "achieved",
        keyLearning: "Invariant fixture",
        unfinishedDisposition: "discard",
        actorId: "human-1",
        closedAt: CREATED_AT,
      },
    ];
    workspace.legacyAuditRecords = [
      {
        id: "legacy-1",
        projectId: "project-1",
        recordType: "legacy_closure",
        sourcePayload: { status: "done" },
        sourceChecksum: "legacy-checksum",
      },
    ];
    workspace.actuals = [
      {
        id: "actual-closed-1",
        revision: 1,
        target: { kind: "work_item", workItemId: "work-item-1" },
        actualWorkSeconds: 600,
        remainingWorkSeconds: 0,
        actualCost: 0,
        recordedAt: CREATED_AT,
      },
    ];
    const closedSlot = {
      id: "slot-closed-1",
      target: {
        kind: "work_item" as const,
        workItemId: "work-item-1",
        projectId: "project-1",
      },
      targetRevision: 1,
      start: "2026-07-10T09:00:00.000Z",
      finish: "2026-07-10T09:30:00.000Z",
      attention: "deep" as const,
    };
    workspace.dailyCommitments = [
      {
        id: "commitment-closed-1",
        localDate: "2026-07-10",
        version: 1,
        proposalHash: "closed-commitment-hash",
        capacitySnapshot: buildCapacityProfile({
          dailyBudgets: [
            {
              weekday: 5,
              deepSeconds: 3_600,
              mediumSeconds: 3_600,
              shallowSeconds: 3_600,
            },
          ],
          updatedAt: CREATED_AT,
          updatedBy: "human-1",
        }),
        slots: [closedSlot],
        actorId: "human-1",
        committedAt: CREATED_AT,
      },
    ];
    workspace.replanProposals = [
      {
        id: "replan-closed-1",
        localDate: "2026-07-10",
        baseCommitmentId: "commitment-closed-1",
        baseRevision: 1,
        reasonCodes: ["capacity_variance"],
        proposedSlots: [structuredClone(closedSlot)],
        proposalHash: "closed-replan-hash",
        createdAt: CREATED_AT,
        createdBy: "human-1",
        status: "open",
      },
    ];
    workspace.reviews = [
      {
        id: "review-closed-1",
        kind: "event",
        triggerKey: "close-review",
        triggerType: "hard_gate",
        status: "completed",
        affectedProjectIds: ["project-1"],
        affectedRecordIds: ["work-item-1"],
        dueAt: FUTURE,
        createdAt: CREATED_AT,
        conclusion: {
          summary: "Closed",
          decisionCodes: [],
          followUpCommandIds: [],
          actorId: "human-1",
          completedAt: CREATED_AT,
        },
      },
    ];
    workspace.syncConflicts = [
      {
        id: "sync-conflict-closed-1",
        recordType: "bet",
        recordId: "bet-1",
        projectId: "project-1",
        commonAncestorHash: "ancestor-hash",
        localValue: { bet: "local" },
        remoteValue: { bet: "remote" },
        openedAt: CREATED_AT,
      },
    ];
    return workspace;
  }

  const mutations: Array<
    [
      string,
      (workspace: WorkspaceV2) => void,
    ]
  > = [
    ["ProjectV2", (workspace) => {
      workspace.projects[0].notes = "Changed after close";
    }],
    ["DirectionBrief", (workspace) => {
      workspace.directionBriefs[0].advancedNotes = "Changed";
    }],
    ["Bet", (workspace) => {
      workspace.bets[0].invalidationReason = "Changed";
    }],
    ["Plan", (workspace) => {
      workspace.planVersions[0].scheduleHash = "changed";
    }],
    ["Work Item", (workspace) => {
      workspace.workItems[0].title = "Changed";
    }],
    ["Dependency", (workspace) => {
      workspace.dependencies[0].lagSeconds = 60;
    }],
    ["Baseline", (workspace) => {
      workspace.baselines[0].name = "Changed";
    }],
    ["Evidence", (workspace) => {
      workspace.evidence[0].summary = "Changed";
    }],
    ["Exception", (workspace) => {
      workspace.exceptions[0].rationale = "Changed";
    }],
    ["Close decision", (workspace) => {
      workspace.closeDecisions[0].keyLearning = "Changed";
    }],
    ["Legacy audit record", (workspace) => {
      workspace.legacyAuditRecords[0].sourceChecksum = "changed";
    }],
    ["Actual", (workspace) => {
      workspace.actuals[0].actualWorkSeconds = 601;
    }],
    ["Daily Commitment", (workspace) => {
      workspace.dailyCommitments[0].proposalHash = "changed";
    }],
    ["Replan Proposal", (workspace) => {
      workspace.replanProposals[0].reasonCodes.push("changed");
    }],
    ["Review", (workspace) => {
      workspace.reviews[0].dueAt = CREATED_AT;
    }],
    ["Sync Conflict", (workspace) => {
      workspace.syncConflicts[0].commonAncestorHash = "changed";
    }],
  ];

  it.each(mutations)("rejects a post-close %s mutation", (_name, mutate) => {
    const previous = buildClosedWorkspace();
    const candidate = structuredClone(previous);
    mutate(candidate);

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([
      {
        code: "PROJECT_CLOSED",
        reason:
          "Closed project project-1 and its project-linked records are immutable.",
        gate: "project:project-1:closed_snapshot",
        permittedNextCommand: "create_follow_up_project",
      },
    ]);
  });

  it("does not reject an unchanged closed project or a first close transition", () => {
    const closed = buildClosedWorkspace();
    expect(
      violationsWithCode(structuredClone(closed), "PROJECT_CLOSED", closed),
    ).toEqual([]);

    const open = buildClosedWorkspace();
    open.projects[0].stage = "closing";
    expect(violationsWithCode(closed, "PROJECT_CLOSED", open)).toEqual([]);
  });

  it("protects a Review linked indirectly through a closed Work Item", () => {
    const previous = buildClosedWorkspace();
    previous.reviews[0].affectedProjectIds = [];
    previous.reviews[0].affectedRecordIds = ["work-item-1"];
    const candidate = structuredClone(previous);
    candidate.reviews[0].dueAt = CREATED_AT;

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([
      {
        code: "PROJECT_CLOSED",
        reason:
          "Closed project project-1 and its project-linked records are immutable.",
        gate: "project:project-1:closed_snapshot",
        permittedNextCommand: "create_follow_up_project",
      },
    ]);
  });

  it("protects a sync conflict linked through an indirectly linked Review", () => {
    const previous = buildClosedWorkspace();
    previous.reviews[0].affectedProjectIds = [];
    previous.reviews[0].affectedRecordIds = ["bet-1"];
    previous.syncConflicts.push({
      id: "review-conflict-1",
      recordType: "review",
      recordId: "review-closed-1",
      commonAncestorHash: "review-ancestor",
      localValue: { review: "local" },
      remoteValue: { review: "remote" },
      openedAt: CREATED_AT,
    });
    const candidate = structuredClone(previous);
    candidate.syncConflicts.find(({ id }) => id === "review-conflict-1")!
      .commonAncestorHash = "changed";

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([
      {
        code: "PROJECT_CLOSED",
        reason:
          "Closed project project-1 and its project-linked records are immutable.",
        gate: "project:project-1:closed_snapshot",
        permittedNextCommand: "create_follow_up_project",
      },
    ]);
  });

  it("ignores reorder-only changes to Review affected-ID sets", () => {
    const previous = buildClosedWorkspace();
    const otherBrief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    previous.directionBriefs.push(otherBrief);
    previous.projects.push(
      buildProjectV2({
        id: "project-2",
        activeDirectionBriefId: otherBrief.id,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }),
    );
    previous.reviews[0].affectedProjectIds = ["project-1", "project-2"];
    previous.reviews[0].affectedRecordIds = ["bet-1", "work-item-1"];
    const candidate = structuredClone(previous);
    candidate.reviews[0].affectedProjectIds.reverse();
    candidate.reviews[0].affectedRecordIds.reverse();

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([]);
  });

  it("ignores reorder-only changes to Project holds and their affected IDs", () => {
    const previous = buildClosedWorkspace();
    previous.projects[0].holds = [
      {
        type: "review_overdue",
        sourceId: "review-closed-1",
        affectedRecordIds: ["bet-1", "work-item-1"],
        createdAt: CREATED_AT,
      },
      {
        type: "sync_conflict",
        sourceId: "sync-conflict-closed-1",
        affectedRecordIds: ["work-item-1", "bet-1"],
        createdAt: CREATED_AT,
      },
    ];
    const candidate = structuredClone(previous);
    candidate.projects[0].holds.reverse();
    for (const hold of candidate.projects[0].holds) {
      hold.affectedRecordIds.reverse();
    }

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([]);
  });

  it("keeps Exception history order meaningful", () => {
    const previous = buildClosedWorkspace();
    previous.exceptions[0].history = [
      {
        action: "created",
        actorId: "human-1",
        at: CREATED_AT,
        note: "Created first",
      },
      {
        action: "resolved",
        actorId: "human-1",
        at: NOW,
        note: "Resolved second",
      },
    ];
    const candidate = structuredClone(previous);
    candidate.exceptions[0].history.reverse();

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toHaveLength(
      1,
    );
  });

  it("ignores canonical entity-array reordering", () => {
    const previous = buildClosedWorkspace();
    previous.bets[0].committedScope.push({
      id: "scope-2",
      title: "Second scope",
      description: "Nested entity arrays are canonical too",
    });
    previous.bets[0].briefSnapshot.firstScope.push(
      structuredClone(previous.bets[0].committedScope[1]),
    );
    const secondBrief: DirectionBrief = {
      ...structuredClone(previous.directionBriefs[0]),
      id: "brief-2",
      version: 2,
    };
    const secondWorkItem = buildWorkItem({ id: "work-item-2" });
    const secondDependency: ProjectDependency = {
      ...structuredClone(previous.dependencies[0]),
      id: "dependency-2",
      fromId: "work-item-2",
      toId: "work-item-2",
    };
    const secondBaseline: Baseline = {
      ...structuredClone(previous.baselines[0]),
      id: "baseline-2",
    };
    const secondEvidence: Evidence = {
      ...structuredClone(previous.evidence[0]),
      id: "evidence-2",
      workItemId: "work-item-2",
    };
    const secondClose: CloseDecision = {
      ...structuredClone(previous.closeDecisions[0]),
      id: "close-2",
    };
    const secondLegacy: LegacyAuditRecord = {
      ...structuredClone(previous.legacyAuditRecords[0]),
      id: "legacy-2",
    };
    previous.directionBriefs.push(secondBrief);
    previous.workItems.push(secondWorkItem);
    previous.dependencies.push(secondDependency);
    previous.baselines.push(secondBaseline);
    previous.evidence.push(secondEvidence);
    previous.closeDecisions.push(secondClose);
    previous.legacyAuditRecords.push(secondLegacy);

    const candidate = structuredClone(previous);
    candidate.directionBriefs.reverse();
    candidate.workItems.reverse();
    candidate.dependencies.reverse();
    candidate.baselines.reverse();
    candidate.evidence.reverse();
    candidate.closeDecisions.reverse();
    candidate.legacyAuditRecords.reverse();
    candidate.bets[0].committedScope.reverse();
    candidate.bets[0].briefSnapshot.firstScope.reverse();

    expect(violationsWithCode(candidate, "PROJECT_CLOSED", previous)).toEqual([]);
  });

  it("selects duplicate project IDs canonically regardless of input order", () => {
    const previous = buildClosedWorkspace();
    previous.projects.push({
      ...structuredClone(previous.projects[0]),
      notes: "Duplicate that sorts differently",
    });
    const candidate = structuredClone(previous);
    candidate.projects.reverse();

    const forward = validateWorkspaceInvariants(candidate, NOW, previous);
    candidate.projects.reverse();
    const reversed = validateWorkspaceInvariants(candidate, NOW, previous);

    expect(forward).toEqual(reversed);
    expect(forward.some(({ code }) => code === "PROJECT_CLOSED")).toBe(false);
  });
});

describe("validateWorkspaceInvariants dangling references", () => {
  type ReferenceCase = {
    name: string;
    gate: string;
    mutate: (workspace: WorkspaceV2) => void;
  };

  const referenceCases: ReferenceCase[] = [
    {
      name: "Project active Direction Brief",
      gate: "reference:ProjectV2:project-1:activeDirectionBriefId",
      mutate: (workspace) => {
        workspace.projects[0].activeDirectionBriefId = "brief-missing";
      },
    },
    {
      name: "Project active Bet",
      gate: "reference:ProjectV2:project-1:activeBetId",
      mutate: (workspace) => {
        workspace.projects[0].activeBetId = "bet-missing";
      },
    },
    {
      name: "Project active Plan",
      gate: "reference:ProjectV2:project-1:activePlanVersionId",
      mutate: (workspace) => {
        workspace.projects[0].activePlanVersionId = "plan-missing";
      },
    },
    {
      name: "Project legacy closure audit record",
      gate: "reference:ProjectV2:project-1:legacyClosure.legacyRecordId",
      mutate: (workspace) => {
        workspace.projects[0].legacyClosure = {
          sourceStatus: "done",
          legacyRecordId: "legacy-missing",
          sourceChecksum: "checksum",
        };
      },
    },
    {
      name: "Project Hold source",
      gate: "reference:ProjectHold:project-1:review_overdue:sourceId",
      mutate: (workspace) => {
        workspace.projects[0].holds.push({
          type: "review_overdue",
          sourceId: "review-missing",
          affectedRecordIds: ["project-1"],
          createdAt: CREATED_AT,
        });
      },
    },
    ...(["migration_review", "rebet_required", "sync_conflict"] as const).map(
      (type): ReferenceCase => ({
        name: `Project Hold typed ${type} source`,
        gate: `reference:ProjectHold:project-1:${type}:sourceId`,
        mutate: (workspace) => {
          workspace.projects[0].holds.push({
            type,
            sourceId: `${type}-source-missing`,
            affectedRecordIds: ["project-1"],
            createdAt: CREATED_AT,
          });
        },
      }),
    ),
    {
      name: "Project Hold affected record",
      gate:
        "reference:ProjectHold:project-1:review_overdue:affectedRecordIds:record-missing",
      mutate: (workspace) => {
        workspace.reviews.push({
          id: "review-1",
          kind: "event",
          triggerKey: "overdue",
          triggerType: "hard_gate",
          status: "open",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: ["project-1"],
          dueAt: FUTURE,
          createdAt: CREATED_AT,
        });
        workspace.projects[0].holds.push({
          type: "review_overdue",
          sourceId: "review-1",
          affectedRecordIds: ["record-missing"],
          createdAt: CREATED_AT,
        });
      },
    },
    {
      name: "Inbox Action",
      gate: "reference:InboxItem:inbox-1:actionId",
      mutate: (workspace) => {
        workspace.inboxItems.push({
          id: "inbox-1",
          originalText: "Broken action",
          sourceId: "source-1",
          actorId: "human-1",
          capturedAt: CREATED_AT,
          triageStatus: "action",
          actionId: "action-missing",
        });
      },
    },
    {
      name: "Inbox Project",
      gate: "reference:InboxItem:inbox-1:projectId",
      mutate: (workspace) => {
        workspace.inboxItems.push({
          id: "inbox-1",
          originalText: "Broken project",
          sourceId: "source-1",
          actorId: "human-1",
          capturedAt: CREATED_AT,
          triageStatus: "project",
          projectId: "project-missing",
        });
      },
    },
    {
      name: "Action Inbox",
      gate: "reference:Action:action-1:inboxItemId",
      mutate: (workspace) => {
        workspace.actions.push(buildAction({ inboxItemId: "inbox-missing" }));
      },
    },
    {
      name: "Action promoted Project",
      gate: "reference:Action:action-1:promotedProjectId",
      mutate: (workspace) => {
        workspace.actions.push(
          buildAction({
            inboxItemId: "inbox-missing",
            status: "promoted",
            promotedProjectId: "project-missing",
          }),
        );
      },
    },
    {
      name: "Direction Brief Project",
      gate: "reference:DirectionBrief:brief-orphan:projectId",
      mutate: (workspace) => {
        workspace.directionBriefs.push(
          buildDirectionBrief({
            id: "brief-orphan",
            projectId: "project-missing",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          }),
        );
      },
    },
    {
      name: "Bet Project",
      gate: "reference:BetVersion:bet-orphan:projectId",
      mutate: (workspace) => {
        workspace.bets.push({
          ...structuredClone(workspace.bets[0]),
          id: "bet-orphan",
          projectId: "project-missing",
          invalidatedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Bet brief",
      gate: "reference:BetVersion:bet-orphan:briefId",
      mutate: (workspace) => {
        workspace.bets.push({
          ...structuredClone(workspace.bets[0]),
          id: "bet-orphan",
          briefId: "brief-missing",
          invalidatedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Plan Project",
      gate: "reference:PlanVersion:plan-orphan:projectId",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({ id: "plan-orphan", projectId: "project-missing" }),
        );
      },
    },
    {
      name: "Plan Bet",
      gate: "reference:PlanVersion:plan-orphan:betId",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({ id: "plan-orphan", betId: "bet-missing" }),
        );
      },
    },
    {
      name: "Plan Work Item",
      gate: "reference:PlanVersion:plan-orphan:workItemRevisions:work-missing",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({
            id: "plan-orphan",
            workItemRevisions: { "work-missing": 1 },
            scopeMapping: { "work-missing": "scope-1" },
          }),
        );
      },
    },
    {
      name: "Plan Dependency",
      gate: "reference:PlanVersion:plan-orphan:dependencyRevisions:dependency-missing",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({
            id: "plan-orphan",
            dependencyRevisions: { "dependency-missing": 1 },
          }),
        );
      },
    },
    {
      name: "Plan extra scope-mapped Work Item",
      gate: "reference:PlanVersion:plan-orphan:scopeMapping:work-missing",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({
            id: "plan-orphan",
            scopeMapping: {
              "work-item-1": "scope-1",
              "work-missing": "scope-1",
            },
          }),
        );
      },
    },
    {
      name: "Plan extra scheduled Work Item",
      gate:
        "reference:PlanVersion:plan-orphan:capacityIndependentDates:work-missing",
      mutate: (workspace) => {
        workspace.planVersions.push(
          buildPlan({
            id: "plan-orphan",
            capacityIndependentDates: {
              "work-missing": { start: CREATED_AT, finish: FUTURE },
            },
          }),
        );
      },
    },
    {
      name: "Work Item Project",
      gate: "reference:ProjectWorkItem:work-orphan:projectId",
      mutate: (workspace) => {
        workspace.workItems.push(
          buildWorkItem({ id: "work-orphan", projectId: "project-missing" }),
        );
      },
    },
    {
      name: "Work Item parent",
      gate: "reference:ProjectWorkItem:work-orphan:parentId",
      mutate: (workspace) => {
        workspace.workItems.push(
          buildWorkItem({ id: "work-orphan", parentId: "work-missing" }),
        );
      },
    },
    {
      name: "Work Item hammock start",
      gate: "reference:ProjectWorkItem:work-orphan:hammockStartId",
      mutate: (workspace) => {
        workspace.workItems.push(
          buildWorkItem({ id: "work-orphan", hammockStartId: "work-missing" }),
        );
      },
    },
    {
      name: "Work Item hammock finish",
      gate: "reference:ProjectWorkItem:work-orphan:hammockFinishId",
      mutate: (workspace) => {
        workspace.workItems.push(
          buildWorkItem({ id: "work-orphan", hammockFinishId: "work-missing" }),
        );
      },
    },
    {
      name: "Work Item assignment Resource",
      gate: "reference:ProjectWorkItem:work-orphan:assignmentIds:resource-missing",
      mutate: (workspace) => {
        workspace.workItems.push(
          buildWorkItem({
            id: "work-orphan",
            assignmentIds: [
              {
                resourceId: "resource-missing",
                attention: "deep",
                effortSeconds: 60,
              },
            ],
          }),
        );
      },
    },
    {
      name: "Dependency Project",
      gate: "reference:ProjectDependency:dependency-orphan:projectId",
      mutate: (workspace) => {
        workspace.dependencies.push(
          buildDependency({ projectId: "project-missing" }),
        );
      },
    },
    {
      name: "Dependency from endpoint",
      gate: "reference:ProjectDependency:dependency-orphan:fromId",
      mutate: (workspace) => {
        workspace.dependencies.push(buildDependency({ fromId: "work-missing" }));
      },
    },
    {
      name: "Dependency to endpoint",
      gate: "reference:ProjectDependency:dependency-orphan:toId",
      mutate: (workspace) => {
        workspace.dependencies.push(buildDependency({ toId: "work-missing" }));
      },
    },
    {
      name: "Actual Action target",
      gate: "reference:ActualV2:actual-1:target.actionId",
      mutate: (workspace) => {
        workspace.actuals.push({
          id: "actual-1",
          revision: 1,
          target: { kind: "action", actionId: "action-missing" },
          actualWorkSeconds: 1,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Actual Work Item target",
      gate: "reference:ActualV2:actual-1:target.workItemId",
      mutate: (workspace) => {
        workspace.actuals.push({
          id: "actual-1",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-missing" },
          actualWorkSeconds: 1,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Commitment slot target",
      gate: "reference:DailyCommitment:commitment-1:slots:slot-1:actionId",
      mutate: (workspace) => {
        workspace.dailyCommitments.push({
          id: "commitment-1",
          localDate: "2026-07-10",
          version: 1,
          proposalHash: "hash",
          capacitySnapshot: buildCapacityProfile({
            dailyBudgets: [
              {
                weekday: 5,
                deepSeconds: 3_600,
                mediumSeconds: 3_600,
                shallowSeconds: 3_600,
              },
            ],
            updatedAt: CREATED_AT,
            updatedBy: "human-1",
          }),
          slots: [
            {
              id: "slot-1",
              target: { kind: "action", actionId: "action-missing" },
              targetRevision: 1,
              start: "2026-07-10T09:00:00.000Z",
              finish: "2026-07-10T09:30:00.000Z",
              attention: "deep",
            },
          ],
          actorId: "human-1",
          committedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Replan base Commitment",
      gate: "reference:ReplanProposal:replan-1:baseCommitmentId",
      mutate: (workspace) => {
        workspace.replanProposals.push({
          id: "replan-1",
          localDate: "2026-07-10",
          baseCommitmentId: "commitment-missing",
          baseRevision: 1,
          reasonCodes: [],
          proposedSlots: [],
          proposalHash: "hash",
          createdAt: CREATED_AT,
          createdBy: "human-1",
          status: "open",
        });
      },
    },
    {
      name: "Review affected Project",
      gate: "reference:ReviewRecord:review-orphan:affectedProjectIds:project-missing",
      mutate: (workspace) => {
        workspace.reviews.push({
          id: "review-orphan",
          kind: "event",
          triggerKey: "orphan-project",
          triggerType: "hard_gate",
          status: "open",
          affectedProjectIds: ["project-missing"],
          affectedRecordIds: ["project-1"],
          dueAt: FUTURE,
          createdAt: CREATED_AT,
        });
      },
    },
    {
      name: "Review affected Record",
      gate: "reference:ReviewRecord:review-orphan:affectedRecordIds:record-missing",
      mutate: (workspace) => {
        workspace.reviews.push({
          id: "review-orphan",
          kind: "event",
          triggerKey: "orphan-record",
          triggerType: "hard_gate",
          status: "open",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: ["record-missing"],
          dueAt: FUTURE,
          createdAt: CREATED_AT,
        });
      },
    },
    {
      name: "Sync Conflict Project",
      gate: "reference:SyncConflictRecord:conflict-orphan:projectId",
      mutate: (workspace) => {
        workspace.syncConflicts.push({
          id: "conflict-orphan",
          recordType: "bet",
          recordId: "bet-1",
          projectId: "project-missing",
          commonAncestorHash: "hash",
          localValue: {},
          remoteValue: {},
          openedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Sync Conflict typed record",
      gate: "reference:SyncConflictRecord:conflict-orphan:recordId",
      mutate: (workspace) => {
        workspace.syncConflicts.push({
          id: "conflict-orphan",
          recordType: "bet",
          recordId: "bet-missing",
          projectId: "project-1",
          commonAncestorHash: "hash",
          localValue: {},
          remoteValue: {},
          openedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Evidence Project",
      gate: "reference:Evidence:evidence-orphan:projectId",
      mutate: (workspace) => {
        workspace.evidence.push({
          id: "evidence-orphan",
          kind: "note",
          summary: "Orphan",
          projectId: "project-missing",
          createdAt: CREATED_AT,
          confidence: 1,
          tags: [],
        });
      },
    },
    {
      name: "Evidence Work Item",
      gate: "reference:Evidence:evidence-orphan:workItemId",
      mutate: (workspace) => {
        workspace.evidence.push({
          id: "evidence-orphan",
          kind: "note",
          summary: "Orphan",
          projectId: "project-1",
          workItemId: "work-missing",
          createdAt: CREATED_AT,
          confidence: 1,
          tags: [],
        });
      },
    },
    {
      name: "Baseline Project",
      gate: "reference:Baseline:baseline-orphan:projectId",
      mutate: (workspace) => {
        workspace.baselines.push({
          id: "baseline-orphan",
          projectId: "project-missing",
          name: "Orphan",
          capturedAt: CREATED_AT,
          plannedStartByItem: {},
          plannedFinishByItem: {},
          plannedWorkSecondsByItem: {},
        });
      },
    },
    {
      name: "Baseline planned Work Item",
      gate: "reference:Baseline:baseline-orphan:plannedItems:work-missing",
      mutate: (workspace) => {
        workspace.baselines.push({
          id: "baseline-orphan",
          projectId: "project-1",
          name: "Orphan item",
          capturedAt: CREATED_AT,
          plannedStartByItem: { "work-missing": CREATED_AT },
          plannedFinishByItem: {},
          plannedWorkSecondsByItem: {},
        });
      },
    },
    {
      name: "Baseline approval decision provenance",
      gate:
        "reference:Baseline:baseline-orphan:approvedByDecisionId:legacy-missing",
      mutate: (workspace) => {
        workspace.baselines.push({
          id: "baseline-orphan",
          projectId: "project-1",
          name: "Orphan approval",
          capturedAt: CREATED_AT,
          plannedStartByItem: {},
          plannedFinishByItem: {},
          plannedWorkSecondsByItem: {},
          approvedByDecisionId: "legacy-missing",
        });
      },
    },
    {
      name: "Close Project",
      gate: "reference:CloseDecision:close-orphan:projectId",
      mutate: (workspace) => {
        workspace.closeDecisions.push({
          id: "close-orphan",
          projectId: "project-missing",
          successComparison: "None",
          outcome: "partial",
          keyLearning: "Orphan",
          unfinishedDisposition: "discard",
          actorId: "human-1",
          closedAt: CREATED_AT,
        });
      },
    },
    {
      name: "Exception Project",
      gate: "reference:ExceptionRecord:exception-orphan:projectId",
      mutate: (workspace) => {
        workspace.exceptions.push({
          id: "exception-orphan",
          projectId: "project-missing",
          requirementId: "requirement-1",
          rationale: "Orphan",
          knownConsequence: "None",
          reviewAt: FUTURE,
          expiresAt: FUTURE,
          approvedBy: "human-1",
          createdAt: CREATED_AT,
          history: [],
        });
      },
    },
    {
      name: "Exception evidence requirement",
      gate: "reference:ExceptionRecord:exception-orphan:requirementId",
      mutate: (workspace) => {
        workspace.exceptions.push({
          id: "exception-orphan",
          projectId: "project-1",
          requirementId: "work-missing",
          rationale: "Orphan requirement",
          knownConsequence: "None",
          reviewAt: FUTURE,
          expiresAt: FUTURE,
          approvedBy: "human-1",
          createdAt: CREATED_AT,
          history: [],
        });
      },
    },
    {
      name: "Legacy Audit Project",
      gate: "reference:LegacyAuditRecord:legacy-orphan:projectId",
      mutate: (workspace) => {
        workspace.legacyAuditRecords.push({
          id: "legacy-orphan",
          projectId: "project-missing",
          recordType: "decision",
          sourcePayload: {},
          sourceChecksum: "checksum",
        });
      },
    },
    {
      name: "archived Project",
      gate: "reference:VisibilityPreferences:visibility:archivedProjectIds:project-missing",
      mutate: (workspace) => {
        workspace.visibility.archivedProjectIds.push("project-missing");
      },
    },
  ];

  function buildAction(overrides: Partial<Action> = {}): Action {
    return {
      id: "action-1",
      inboxItemId: "inbox-1",
      title: "Action",
      revision: 1,
      status: "open",
      eligibility: {
        singleSession: true,
        estimateSeconds: 60,
        dependencyIds: [],
        requiresMilestoneEvidence: false,
        outcomeCount: 1,
        solutionKnown: true,
      },
      attention: "shallow",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      ...overrides,
    };
  }

  function buildDependency(
    overrides: Partial<ProjectDependency> = {},
  ): ProjectDependency {
    return {
      id: "dependency-orphan",
      projectId: "project-1",
      fromId: "work-item-1",
      toId: "work-item-1",
      type: "FS",
      lagSeconds: 0,
      revision: 1,
      ...overrides,
    };
  }

  it.each(referenceCases)("reports the dangling $name edge", ({ gate, mutate }) => {
    const workspace = buildValidWorkspace();
    mutate(workspace);

    const referenceViolations = violationsWithCode(
      workspace,
      "ENTITY_NOT_FOUND",
    );

    expect(referenceViolations.map((violation) => violation.gate)).toContain(gate);
    expect(new Set(referenceViolations.map((violation) => violation.gate)).size).toBe(
      referenceViolations.length,
    );
    expect(referenceViolations.every((violation) =>
      violation.permittedNextCommand === "repair_workspace_reference"
    )).toBe(true);
  });
});

describe("validateWorkspaceInvariants Baseline approval provenance", () => {
  function legacyDecision(
    overrides: Partial<LegacyAuditRecord> = {},
  ): LegacyAuditRecord {
    return {
      id: "legacy-decision-1",
      projectId: "project-1",
      recordType: "decision",
      sourcePayload: {},
      sourceChecksum: "checksum",
      ...overrides,
    };
  }

  function addBaseline(
    workspace: WorkspaceV2,
    approvedByDecisionId: string,
  ): void {
    workspace.baselines.push({
      id: "baseline-provenance",
      projectId: "project-1",
      name: "Approved Baseline",
      capturedAt: CREATED_AT,
      plannedStartByItem: { "work-item-1": CREATED_AT },
      plannedFinishByItem: { "work-item-1": FUTURE },
      plannedWorkSecondsByItem: { "work-item-1": 3_600 },
      approvedByDecisionId,
    });
  }

  it.each(["decision", "audit_decision"] as const)(
    "accepts a same-project legacy %s",
    (recordType) => {
      const workspace = buildValidWorkspace();
      const record = legacyDecision({ recordType });
      workspace.legacyAuditRecords.push(record);
      addBaseline(workspace, record.id);

      expect(
        violationsWithCode(workspace, "ENTITY_NOT_FOUND").filter(
          ({ gate }) => gate?.includes("approvedByDecisionId"),
        ),
      ).toEqual([]);
    },
  );

  it("rejects a same-project legacy record of the wrong type", () => {
    const workspace = buildValidWorkspace();
    const record = legacyDecision({ recordType: "audit_gate" });
    workspace.legacyAuditRecords.push(record);
    addBaseline(workspace, record.id);

    expect(violationsWithCode(workspace, "ENTITY_NOT_FOUND")).toContainEqual(
      expect.objectContaining({
        gate: `reference:Baseline:baseline-provenance:approvedByDecisionId:${record.id}`,
      }),
    );
  });

  it("rejects a legacy decision from another Project", () => {
    const workspace = buildValidWorkspace();
    const otherBrief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    workspace.projects.push(
      buildProjectV2({
        id: "project-2",
        activeDirectionBriefId: otherBrief.id,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }),
    );
    workspace.directionBriefs.push(otherBrief);
    const record = legacyDecision({ projectId: "project-2" });
    workspace.legacyAuditRecords.push(record);
    addBaseline(workspace, record.id);

    expect(violationsWithCode(workspace, "ENTITY_NOT_FOUND")).toContainEqual(
      expect.objectContaining({
        gate: `reference:Baseline:baseline-provenance:approvedByDecisionId:${record.id}`,
      }),
    );
  });
});

describe("validateWorkspaceInvariants determinism", () => {
  it("returns serializable violations in stable order and mutates neither input", () => {
    const previous = buildValidWorkspace();
    previous.projects[0].stage = "closed";
    const workspace = structuredClone(previous);
    workspace.projects[0].notes = "Illegal closed mutation";
    workspace.projects[0].stage = "executing";
    setCurrentBetAppetiteEnd(workspace, NOW);
    workspace.workItems[0].evidenceRequired = true;
    workspace.workItems[0].resultStatus = "completed";
    workspace.exceptions.push({
      id: "exception-z",
      projectId: "project-1",
      requirementId: "work-item-1",
      rationale: "Expired",
      knownConsequence: "None",
      reviewAt: NOW,
      expiresAt: NOW,
      approvedBy: "human-1",
      createdAt: CREATED_AT,
      history: [],
    });
    workspace.visibility.archivedProjectIds.push("project-missing");
    const originalWorkspace = structuredClone(workspace);
    const originalPrevious = structuredClone(previous);

    const first = validateWorkspaceInvariants(workspace, NOW, previous);
    const second = validateWorkspaceInvariants(workspace, NOW, previous);

    expect(first).toEqual(second);
    expect(codes(first)).toEqual([
      "BET_EXPIRED",
      "PROJECT_CLOSED",
      "ENTITY_NOT_FOUND",
      "ENTITY_NOT_FOUND",
    ]);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(workspace).toEqual(originalWorkspace);
    expect(previous).toEqual(originalPrevious);
  });
});
