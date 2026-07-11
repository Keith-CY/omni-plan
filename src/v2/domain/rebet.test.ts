import { describe, expect, it } from "vitest";

import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type DirectionBriefDraft,
  type V2Command,
} from "./commands";
import { evaluateBetBoundary } from "./lifecycle";
import type {
  BetVersion,
  DirectionBrief,
  LifecycleStage,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

const APPROVED_AT = "2026-07-11T09:00:00.000Z";
const EDITED_AT = "2026-07-11T09:30:00.000Z";
const MIDPOINT = "2026-07-11T10:00:00.000Z";
const APPETITE_END = "2026-07-11T11:00:00.000Z";
const REBET_AT = "2026-07-11T10:15:00.000Z";

const BRIEF = buildDirectionBrief({
  id: "brief-1",
  projectId: "project-1",
  version: 1,
  audienceAndProblem: "Operators lose the next best action in planning noise.",
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
  createdAt: APPROVED_AT,
  updatedAt: APPROVED_AT,
});

const BET = buildBetVersion({
  id: "bet-1",
  projectId: "project-1",
  version: 1,
  briefId: BRIEF.id,
  briefHash: "approved-brief-hash",
  briefSnapshot: structuredClone(BRIEF),
  committedScope: structuredClone(BRIEF.firstScope),
  appetiteStart: APPROVED_AT,
  appetiteEnd: APPETITE_END,
  actorId: "human-1",
  approvedAt: APPROVED_AT,
});

const WORK_ITEM: ProjectWorkItem = {
  id: "work-item-1",
  projectId: "project-1",
  kind: "task",
  title: "Continue the Bet",
  outline: "Work already inside the approved scope.",
  durationSeconds: 1_800,
  estimate: { mostLikelySeconds: 1_800 },
  assignmentIds: [],
  percentComplete: 0,
  revision: 1,
  betScopeId: "scope-1",
};

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    commandId: "command-1",
    expectedRevision: 0,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "human-session-1",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: EDITED_AT,
    ...overrides,
  };
}

function systemContext(
  now: string,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return context({
    commandId: `boundary-${now}`,
    actorId: "system-clock",
    actorKind: "system",
    origin: "agent",
    source: {
      sourceId: "system-clock-source",
      verified: true,
      capabilities: ["system_time"],
    },
    now,
    ...overrides,
  });
}

function applied(result: CommandResult): Extract<CommandResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected applied command: ${result.rejection.code}`);
  return result;
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejected command");
  return result;
}

function directionDraft(brief: DirectionBrief = BRIEF): DirectionBriefDraft {
  const {
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...draft
  } = structuredClone(brief);
  return draft;
}

function activeWorkspace(
  stage: LifecycleStage = "executing",
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  return buildWorkspaceV2("workspace-rebet", {
    projects: [
      buildProjectV2({
        id: "project-1",
        name: "Guided planning",
        priority: 1,
        notes: "Project notes",
        stage,
        activeDirectionBriefId: BRIEF.id,
        activeBetId: BET.id,
        activePlanVersionId: "plan-1",
        createdAt: APPROVED_AT,
        updatedAt: APPROVED_AT,
      }),
    ],
    directionBriefs: [structuredClone(BRIEF)],
    bets: [structuredClone(BET)],
    planVersions: [
      {
        id: "plan-1",
        projectId: "project-1",
        version: 1,
        betId: BET.id,
        workItemRevisions: { [WORK_ITEM.id]: WORK_ITEM.revision },
        dependencyRevisions: {},
        scopeMapping: { [WORK_ITEM.id]: WORK_ITEM.betScopeId },
        scheduleHash: "plan-hash",
        capacityIndependentDates: {
          [WORK_ITEM.id]: { start: APPROVED_AT, finish: MIDPOINT },
        },
        actorId: "human-1",
        createdAt: APPROVED_AT,
      },
    ],
    workItems: [structuredClone(WORK_ITEM)],
    ...overrides,
  });
}

function rebetWorkspace(stage: LifecycleStage): WorkspaceV2 {
  const nextBrief: DirectionBrief = {
    ...structuredClone(BRIEF),
    id: "project-1:direction-brief:2",
    version: 2,
    appetiteSeconds: 10_800,
    firstScope: [
      ...structuredClone(BRIEF.firstScope),
      {
        id: "scope-2",
        title: "Guided recovery",
        description: "The newly approved bounded scope.",
      },
    ],
    createdAt: EDITED_AT,
    updatedAt: EDITED_AT,
  };
  const invalidatedBet: BetVersion = {
    ...structuredClone(BET),
    invalidatedAt: EDITED_AT,
    invalidationReason: "Material Direction change requires Re-bet.",
  };

  return activeWorkspace(stage, {
    projects: [
      buildProjectV2({
        id: "project-1",
        name: "Guided planning",
        priority: 1,
        notes: "Project notes",
        stage,
        holds: [
          {
            type: "rebet_required",
            sourceId: BET.id,
            affectedRecordIds: [
              "project-1",
              BRIEF.id,
              nextBrief.id,
              BET.id,
            ],
            createdAt: EDITED_AT,
          },
        ],
        activeDirectionBriefId: nextBrief.id,
        activeBetId: BET.id,
        activePlanVersionId: "plan-1",
        createdAt: APPROVED_AT,
        updatedAt: EDITED_AT,
      }),
    ],
    directionBriefs: [structuredClone(BRIEF), nextBrief],
    bets: [invalidatedBet],
  });
}

describe("material Direction edits", () => {
  it.each([
    ["audienceAndProblem", "A different audience and problem"],
    ["successEvidence", "A different observable result"],
    ["appetiteSeconds", 10_800],
    ["validationMethod", "A different validation method"],
    [
      "firstScope",
      [{ id: "scope-2", title: "Different scope", description: "Changed" }],
    ],
    ["noGoOrKill", "A different kill condition"],
  ] as const)(
    "invalidates the active Bet atomically when %s changes",
    async (field, value) => {
      const workspace = activeWorkspace("executing");
      const beforeWorkspace = structuredClone(workspace);
      const draft = {
        ...directionDraft(),
        [field]: structuredClone(value),
      } as DirectionBriefDraft;

      const result = applied(
        await executeCommand(
          workspace,
          { type: "update_direction", projectId: "project-1", brief: draft },
          context(),
        ),
      );

      expect(workspace).toEqual(beforeWorkspace);
      expect(result.workspace.directionBriefs).toHaveLength(2);
      expect(result.workspace.directionBriefs[0]).toEqual(beforeWorkspace.directionBriefs[0]);
      const activeBrief = result.workspace.directionBriefs.find(
        ({ id }) => id === result.workspace.projects[0].activeDirectionBriefId,
      );
      expect(activeBrief).toMatchObject({
        projectId: "project-1",
        version: 2,
        [field]: value,
        createdAt: EDITED_AT,
        updatedAt: EDITED_AT,
      });
      expect(activeBrief?.id).not.toBe(BRIEF.id);
      expect(result.workspace.bets[0]).toEqual({
        ...beforeWorkspace.bets[0],
        invalidatedAt: EDITED_AT,
        invalidationReason: "Material Direction change requires Re-bet.",
      });
      expect(result.workspace.projects[0]).toMatchObject({
        stage: "executing",
        activeBetId: BET.id,
        holds: [
          {
            type: "rebet_required",
            sourceId: BET.id,
            createdAt: EDITED_AT,
          },
        ],
      });
    },
  );

  it.each([
    {
      name: "new planning",
      command: {
        type: "create_work_item",
        projectId: "project-1",
        workItem: { ...WORK_ITEM, id: "work-item-new" },
      },
    },
    {
      name: "continuing execution",
      command: {
        type: "record_actual",
        actual: {
          id: "actual-after-change",
          revision: 1,
          target: { kind: "work_item", workItemId: WORK_ITEM.id },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 1_500,
          actualCost: 0,
          recordedAt: EDITED_AT,
        },
      },
    },
  ] as const satisfies readonly { name: string; command: V2Command }[])(
    "blocks $name after material Direction invalidation",
    async ({ command }) => {
      const first = applied(
        await executeCommand(
          activeWorkspace("executing"),
          {
            type: "update_direction",
            projectId: "project-1",
            brief: {
              ...directionDraft(),
              successEvidence: "Changed success evidence",
            },
          },
          context(),
        ),
      );

      const blocked = rejected(
        await executeCommand(
          first.workspace,
          command,
          context({
            commandId: `blocked-${command.type}`,
            expectedRevision: first.workspace.revision,
          }),
        ),
      );

      expect(blocked.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "rebet_required",
        gate: "project_hold:rebet_required",
        permittedNextCommand: "place_bet",
      });
      expect(blocked.workspace).toBe(first.workspace);
    },
  );

  it("preserves the original pause record across repeated material edits", async () => {
    const first = applied(
      await executeCommand(
        activeWorkspace("executing"),
        {
          type: "update_direction",
          projectId: "project-1",
          brief: {
            ...directionDraft(),
            successEvidence: "First changed success evidence",
          },
        },
        context(),
      ),
    );
    const firstProject = structuredClone(first.workspace.projects[0]);
    const firstBet = structuredClone(first.workspace.bets[0]);
    const firstActiveBrief = first.workspace.directionBriefs.find(
      ({ id }) => id === firstProject.activeDirectionBriefId,
    );
    if (firstActiveBrief === undefined) throw new Error("Missing first edit");

    const second = applied(
      await executeCommand(
        first.workspace,
        {
          type: "update_direction",
          projectId: "project-1",
          brief: {
            ...directionDraft(firstActiveBrief),
            validationMethod: "Second changed validation method",
          },
        },
        context({
          commandId: "second-material-edit",
          expectedRevision: first.workspace.revision,
          now: "2026-07-11T09:45:00.000Z",
        }),
      ),
    );

    expect(second.workspace.projects[0].holds).toEqual(firstProject.holds);
    expect(second.workspace.projects[0]).toMatchObject({
      stage: firstProject.stage,
      activeBetId: firstProject.activeBetId,
      activePlanVersionId: firstProject.activePlanVersionId,
    });
    expect(second.workspace.bets[0]).toEqual(firstBet);
    expect(second.workspace.directionBriefs).toHaveLength(3);
  });

  it.each([
    ["name", { name: "Renamed Project" }],
    ["priority", { priority: 99 }],
    ["formatted optional notes", { notes: "## Editorial\n\n- Reformatted" }],
  ] as const)("keeps the Bet valid after editing %s metadata", async (_name, patch) => {
    const workspace = activeWorkspace("executing");
    const beforeBet = structuredClone(workspace.bets[0]);
    const beforeBriefs = structuredClone(workspace.directionBriefs);

    const result = applied(
      await executeCommand(
        workspace,
        { type: "update_project_metadata", projectId: "project-1", ...patch },
        context(),
      ),
    );

    expect(result.workspace.projects[0]).toMatchObject(patch);
    expect(result.workspace.projects[0].holds).toEqual([]);
    expect(result.workspace.bets[0]).toEqual(beforeBet);
    expect(result.workspace.directionBriefs).toEqual(beforeBriefs);
  });

  it("versions editorial Direction notes without invalidating the Bet", async () => {
    const workspace = activeWorkspace("executing");
    const beforeBet = structuredClone(workspace.bets[0]);

    const result = applied(
      await executeCommand(
        workspace,
        {
          type: "update_direction",
          projectId: "project-1",
          brief: {
            ...directionDraft(),
            advancedNotes: "Reformatted editorial notes only.",
          },
        },
        context(),
      ),
    );

    expect(result.workspace.bets[0]).toEqual(beforeBet);
    expect(result.workspace.projects[0].holds).toEqual([]);
    expect(result.workspace.directionBriefs).toHaveLength(2);
    expect(result.workspace.directionBriefs[0]).toEqual(BRIEF);
    expect(result.workspace.directionBriefs[1]).toMatchObject({
      version: 2,
      advancedNotes: "Reformatted editorial notes only.",
    });
  });
});

describe("human Re-bet", () => {
  it.each(["planning", "executing", "validating"] as const)(
    "replaces an invalidated Bet from %s without rewriting history",
    async (stage) => {
      const workspace = rebetWorkspace(stage);
      const oldBet = structuredClone(workspace.bets[0]);
      const oldBriefs = structuredClone(workspace.directionBriefs);

      const result = applied(
        await executeCommand(
          workspace,
          {
            type: "place_bet",
            projectId: "project-1",
            betId: `bet-2-${stage}`,
            start: REBET_AT,
          },
          context({
            commandId: `rebet-${stage}`,
            now: REBET_AT,
          }),
        ),
      );

      expect(result.workspace.bets[0]).toEqual(oldBet);
      expect(result.workspace.directionBriefs).toEqual(oldBriefs);
      expect(result.workspace.bets[1]).toMatchObject({
        id: `bet-2-${stage}`,
        projectId: "project-1",
        version: 2,
        briefId: "project-1:direction-brief:2",
        supersedesId: BET.id,
        appetiteStart: REBET_AT,
        appetiteEnd: "2026-07-11T13:15:00.000Z",
        actorId: "human-1",
        approvedAt: REBET_AT,
      });
      expect(result.workspace.projects[0]).toMatchObject({
        stage: "planning",
        activeBetId: `bet-2-${stage}`,
        holds: [],
      });
      expect(result.workspace.projects[0].activePlanVersionId).toBeUndefined();
    },
  );
});

describe("Bet appetite boundary", () => {
  it("produces deterministic midpoint and expiry commands without mutating state", () => {
    const workspace = activeWorkspace("executing");
    const original = structuredClone(workspace);

    expect(evaluateBetBoundary(workspace, "2026-07-11T09:59:59.999Z")).toEqual([]);
    expect(evaluateBetBoundary(workspace, MIDPOINT)).toEqual([
      {
        command: {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "midpoint",
          triggerKey: "bet-1:midpoint",
        },
        review: {
          id: "review:bet-1:midpoint",
          kind: "event",
          triggerKey: "bet-1:midpoint",
          triggerType: "bet_midpoint",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: [BET.id],
          dueAt: MIDPOINT,
        },
      },
    ]);
    expect(evaluateBetBoundary(workspace, APPETITE_END)).toEqual([
      {
        command: {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "midpoint",
          triggerKey: "bet-1:midpoint",
        },
        review: {
          id: "review:bet-1:midpoint",
          kind: "event",
          triggerKey: "bet-1:midpoint",
          triggerType: "bet_midpoint",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: [BET.id],
          dueAt: MIDPOINT,
        },
      },
      {
        command: {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        review: {
          id: "review:bet-1:expired",
          kind: "event",
          triggerKey: "bet-1:expired",
          triggerType: "bet_expired",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: [BET.id],
          dueAt: APPETITE_END,
        },
      },
    ]);
    expect(workspace).toEqual(original);
  });

  it("suppresses each already persisted boundary Review independently", () => {
    const workspace = activeWorkspace("executing", {
      reviews: [
        {
          id: "review:bet-1:midpoint",
          kind: "event",
          triggerKey: "bet-1:midpoint",
          triggerType: "bet_midpoint",
          status: "open",
          affectedProjectIds: ["project-1"],
          affectedRecordIds: [BET.id],
          dueAt: MIDPOINT,
          createdAt: MIDPOINT,
        },
      ],
    });

    expect(evaluateBetBoundary(workspace, APPETITE_END)).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ boundary: "expired" }),
      }),
    ]);
  });

  it("records the midpoint without changing stage or Bet; Review persistence stays explicit", async () => {
    const workspace = activeWorkspace("executing");
    const beforeBet = structuredClone(workspace.bets[0]);

    const result = applied(
      await executeCommand(
        workspace,
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "midpoint",
          triggerKey: "bet-1:midpoint",
        },
        systemContext(MIDPOINT),
      ),
    );

    expect(result.workspace.projects[0].stage).toBe("executing");
    expect(result.workspace.projects[0].holds).toEqual([]);
    expect(result.workspace.bets[0]).toEqual(beforeBet);
    expect(result.workspace.reviews).toEqual([]);
  });

  it.each(["planning", "executing"] as const)(
    "expires %s immediately into validation and opens a blocking event Review",
    async (stage) => {
      const workspace = activeWorkspace(stage);
      const beforeBet = structuredClone(workspace.bets[0]);

      const result = applied(
        await executeCommand(
          workspace,
          {
            type: "record_bet_boundary",
            projectId: "project-1",
            boundary: "expired",
            triggerKey: "bet-1:expired",
          },
          systemContext(APPETITE_END),
        ),
      );

      expect(result.workspace.projects[0]).toMatchObject({
        stage: "validating",
        activeBetId: BET.id,
        holds: [
          {
            type: "rebet_required",
            sourceId: BET.id,
            affectedRecordIds: ["project-1", BET.id],
            createdAt: APPETITE_END,
          },
        ],
      });
      expect(result.workspace.bets[0]).toEqual(beforeBet);
      expect(result.workspace.reviews).toEqual([]);
    },
  );

  it("blocks new scheduling and continuing execution immediately after expiry", async () => {
    const expired = applied(
      await executeCommand(
        activeWorkspace("executing"),
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        systemContext(APPETITE_END),
      ),
    );

    const commands: V2Command[] = [
      {
        type: "commit_today",
        commitment: {
          id: "commitment-after-expiry",
          localDate: "2026-07-11",
          proposalHash: "proposal-after-expiry",
          slots: [
            {
              id: "slot-after-expiry",
              target: {
                kind: "work_item",
                projectId: "project-1",
                workItemId: WORK_ITEM.id,
              },
              targetRevision: 1,
              start: APPETITE_END,
              finish: "2026-07-11T11:30:00.000Z",
              attention: "deep",
            },
          ],
        },
      },
      {
        type: "record_actual",
        actual: {
          id: "actual-after-expiry",
          revision: 1,
          target: { kind: "work_item", workItemId: WORK_ITEM.id },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 1_500,
          actualCost: 0,
          recordedAt: APPETITE_END,
        },
      },
      { type: "request_validation", projectId: "project-1" },
      { type: "satisfy_validation", projectId: "project-1" },
    ];

    for (const [index, command] of commands.entries()) {
      const blocked = rejected(
        await executeCommand(
          expired.workspace,
          command,
          context({
            commandId: `blocked-after-expiry-${index}`,
            expectedRevision: expired.workspace.revision,
            now: APPETITE_END,
          }),
        ),
      );
      expect(blocked.rejection).toMatchObject({
        code: "HOLD_BLOCKS_COMMAND",
        hold: "rebet_required",
        permittedNextCommand: "place_bet",
      });
    }
  });

  it("records late midpoint and repeated expiry without duplicating or rewriting the hold", async () => {
    const expired = applied(
      await executeCommand(
        activeWorkspace("executing"),
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        systemContext(APPETITE_END),
      ),
    );
    const originalHold = structuredClone(expired.workspace.projects[0].holds[0]);

    const lateMidpoint = applied(
      await executeCommand(
        expired.workspace,
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "midpoint",
          triggerKey: "bet-1:midpoint",
        },
        systemContext("2026-07-11T11:05:00.000Z", {
          commandId: "late-midpoint",
          expectedRevision: expired.workspace.revision,
        }),
      ),
    );
    const repeated = applied(
      await executeCommand(
        lateMidpoint.workspace,
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        systemContext("2026-07-11T11:10:00.000Z", {
          commandId: "repeated-expiry",
          expectedRevision: lateMidpoint.workspace.revision,
        }),
      ),
    );

    expect(repeated.workspace.projects[0].holds).toEqual([originalHold]);
  });

  it.each(["request_validation", "satisfy_validation"] as const)(
    "does not broaden Agent authority for %s while blocking the human path",
    async (type) => {
      const workspace = rebetWorkspace("executing");
      const result = rejected(
        await executeCommand(
          workspace,
          { type, projectId: "project-1" },
          context({
            commandId: `agent-${type}`,
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
        code: "ACTOR_NOT_AUTHORIZED",
        permittedNextCommand: "submit_command_proposal",
      });
    },
  );

  it.each(["place_bet", "abandon_project"] as const)(
    "keeps the post-expiry %s decision human-only",
    async (commandType) => {
      const expired = applied(
        await executeCommand(
          activeWorkspace("executing"),
          {
            type: "record_bet_boundary",
            projectId: "project-1",
            boundary: "expired",
            triggerKey: "bet-1:expired",
          },
          systemContext(APPETITE_END),
        ),
      );
      const command: V2Command =
        commandType === "place_bet"
          ? {
              type: "place_bet",
              projectId: "project-1",
              betId: "bet-agent",
              start: APPETITE_END,
            }
          : {
              type: "abandon_project",
              projectId: "project-1",
              decision: {
                id: "abandon-agent",
                projectId: "project-1",
                successComparison: "The target was not achieved.",
                outcome: "abandoned",
                keyLearning: "The appetite exposed a poor premise.",
                unfinishedDisposition: "historical_incomplete",
              },
            };

      const result = rejected(
        await executeCommand(
          expired.workspace,
          command,
          context({
            commandId: `agent-${commandType}`,
            expectedRevision: expired.workspace.revision,
            actorId: "agent-1",
            actorKind: "agent",
            origin: "agent",
            source: {
              sourceId: "agent-source",
              verified: true,
              capabilities: ["submit_proposal"],
            },
            now: APPETITE_END,
          }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        permittedNextCommand: commandType,
      });
    },
  );

  it("allows a human to abandon at expiry only with a structured close decision", async () => {
    const expired = applied(
      await executeCommand(
        activeWorkspace("executing"),
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        systemContext(APPETITE_END),
      ),
    );
    const revision = expired.workspace.revision;

    const incomplete = rejected(
      await executeCommand(
        expired.workspace,
        {
          type: "abandon_project",
          projectId: "project-1",
          decision: {
            id: "abandon-incomplete",
            projectId: "project-1",
            successComparison: "   ",
            outcome: "abandoned",
            keyLearning: "No learning recorded",
            unfinishedDisposition: "historical_incomplete",
          },
        },
        context({
          commandId: "abandon-incomplete",
          expectedRevision: revision,
          now: APPETITE_END,
        }),
      ),
    );
    expect(incomplete.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "project:project-1:abandon_decision",
      permittedNextCommand: "abandon_project",
    });

    const completed = applied(
      await executeCommand(
        expired.workspace,
        {
          type: "abandon_project",
          projectId: "project-1",
          decision: {
            id: "abandon-1",
            projectId: "project-1",
            successComparison: "The target evidence was not achieved.",
            outcome: "abandoned",
            keyLearning: "The premise was weaker than expected.",
            unfinishedDisposition: "historical_incomplete",
          },
        },
        context({
          commandId: "abandon-complete",
          expectedRevision: revision,
          now: APPETITE_END,
        }),
      ),
    );

    expect(completed.workspace.projects[0].stage).toBe("closed");
    expect(completed.workspace.closeDecisions).toEqual([
      {
        id: "abandon-1",
        projectId: "project-1",
        successComparison: "The target evidence was not achieved.",
        outcome: "abandoned",
        keyLearning: "The premise was weaker than expected.",
        unfinishedDisposition: "historical_incomplete",
        actorId: "human-1",
        closedAt: APPETITE_END,
      },
    ]);
  });

  it("never rewrites an existing appetite end while expiring or Re-betting", async () => {
    const workspace = activeWorkspace("executing");
    const originalEnd = workspace.bets[0].appetiteEnd;
    const expired = applied(
      await executeCommand(
        workspace,
        {
          type: "record_bet_boundary",
          projectId: "project-1",
          boundary: "expired",
          triggerKey: "bet-1:expired",
        },
        systemContext(APPETITE_END),
      ),
    );
    expect(expired.workspace.bets[0].appetiteEnd).toBe(originalEnd);

    const replaced = applied(
      await executeCommand(
        expired.workspace,
        {
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-after-expiry",
          start: APPETITE_END,
        },
        context({
          commandId: "rebet-after-expiry",
          expectedRevision: expired.workspace.revision,
          now: APPETITE_END,
        }),
      ),
    );

    expect(replaced.workspace.bets[0].appetiteEnd).toBe(originalEnd);
    expect(replaced.workspace.bets[1].appetiteEnd).toBe(
      "2026-07-11T13:00:00.000Z",
    );
  });
});
