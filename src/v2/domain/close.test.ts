import { describe, expect, it } from "vitest";

import {
  buildBetVersion,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import {
  executeCommand,
  type CloseDecisionDraft,
  type CommandContext,
  type CommandResult,
} from "./commands";
import {
  returnedInboxItemId,
  unfinishedProjectWorkItems,
} from "./close";
import { stableHashSync } from "./stableHash";
import type {
  Action,
  InboxItem,
  JsonValue,
  ProjectDependency,
  ProjectWorkItem,
  WorkspaceV2,
  WorkDisposition,
} from "./types";

const CREATED_AT = "2026-07-11T08:00:00.000Z";
const NOW = "2026-07-11T10:00:00.000Z";
const APPETITE_END = "2026-07-12T08:00:00.000Z";

const BRIEF = buildDirectionBrief({
  id: "brief-1",
  projectId: "project-1",
  appetiteSeconds: 86_400,
  firstScope: [
    { id: "scope-1", title: "Core", description: "Close the core scope." },
  ],
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
});

const BET = buildBetVersion({
  id: "bet-1",
  projectId: "project-1",
  briefId: BRIEF.id,
  briefSnapshot: structuredClone(BRIEF),
  committedScope: structuredClone(BRIEF.firstScope),
  appetiteStart: CREATED_AT,
  appetiteEnd: APPETITE_END,
  actorId: "human-1",
  approvedAt: CREATED_AT,
});

const COMPLETE_ITEM: ProjectWorkItem = {
  id: "work-complete",
  projectId: "project-1",
  kind: "task",
  title: "Completed scope",
  outline: "Already finished.",
  durationSeconds: 1_800,
  estimate: { mostLikelySeconds: 1_800 },
  assignmentIds: [],
  percentComplete: 100,
  revision: 1,
  betScopeId: "scope-1",
  resultStatus: "completed",
  outcomeNote: "Done.",
};

const INCOMPLETE_ITEM: ProjectWorkItem = {
  id: "work-incomplete",
  projectId: "project-1",
  kind: "task",
  title: "Unfinished scope",
  outline: "Needs an explicit disposition.",
  durationSeconds: 3_600,
  estimate: { mostLikelySeconds: 3_600 },
  assignmentIds: [],
  percentComplete: 40,
  revision: 1,
  betScopeId: "scope-1",
};

const DEPENDENCY: ProjectDependency = {
  id: "dependency-1",
  projectId: "project-1",
  fromId: COMPLETE_ITEM.id,
  toId: INCOMPLETE_ITEM.id,
  type: "FS",
  lagSeconds: 0,
  revision: 1,
};

function closingWorkspace(overrides: Partial<WorkspaceV2> = {}): WorkspaceV2 {
  return buildWorkspaceV2("workspace-close", {
    projects: [
      buildProjectV2({
        id: "project-1",
        name: "Close safely",
        priority: 3,
        notes: "Source project notes.",
        stage: "closing",
        activeDirectionBriefId: BRIEF.id,
        activeBetId: BET.id,
        activePlanVersionId: "plan-1",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
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
        workItemRevisions: {
          [COMPLETE_ITEM.id]: COMPLETE_ITEM.revision,
          [INCOMPLETE_ITEM.id]: INCOMPLETE_ITEM.revision,
        },
        dependencyRevisions: { [DEPENDENCY.id]: DEPENDENCY.revision },
        scopeMapping: {
          [COMPLETE_ITEM.id]: "scope-1",
          [INCOMPLETE_ITEM.id]: "scope-1",
        },
        scheduleHash: "schedule-hash",
        capacityIndependentDates: {
          [COMPLETE_ITEM.id]: { start: CREATED_AT, finish: CREATED_AT },
          [INCOMPLETE_ITEM.id]: { start: CREATED_AT, finish: APPETITE_END },
        },
        actorId: "human-1",
        createdAt: CREATED_AT,
      },
    ],
    workItems: [structuredClone(COMPLETE_ITEM), structuredClone(INCOMPLETE_ITEM)],
    dependencies: [structuredClone(DEPENDENCY)],
    evidence: [
      {
        id: "evidence-1",
        kind: "metric",
        summary: "Observed result",
        projectId: "project-1",
        workItemId: COMPLETE_ITEM.id,
        createdAt: CREATED_AT,
        confidence: 1,
        tags: ["close"],
      },
    ],
    baselines: [
      {
        id: "baseline-1",
        projectId: "project-1",
        name: "Approved plan",
        capturedAt: CREATED_AT,
        plannedStartByItem: { [COMPLETE_ITEM.id]: CREATED_AT },
        plannedFinishByItem: { [COMPLETE_ITEM.id]: CREATED_AT },
        plannedWorkSecondsByItem: { [COMPLETE_ITEM.id]: 1_800 },
      },
    ],
    ...overrides,
  });
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    commandId: "command-close",
    expectedRevision: 0,
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

function applied(result: CommandResult): Extract<CommandResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.rejection.code);
  return result;
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected rejected command");
  return result;
}

function decision(
  unfinishedDisposition: WorkDisposition,
  overrides: Partial<CloseDecisionDraft> = {},
): CloseDecisionDraft {
  return {
    id: `close-${unfinishedDisposition}`,
    projectId: "project-1",
    successComparison: "The observed metric met the Direction success evidence.",
    outcome: "achieved",
    keyLearning: "A narrow scope made validation decisive.",
    unfinishedDisposition,
    ...(unfinishedDisposition === "follow_up_project"
      ? { followUpProjectId: "project-follow-up" }
      : {}),
    ...overrides,
  };
}

function appetiteBoundaryWorkspace(
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  const workspace = closingWorkspace();
  workspace.projects[0] = {
    ...workspace.projects[0],
    stage: "validating",
    holds: [
      {
        type: "rebet_required",
        sourceId: BET.id,
        affectedRecordIds: ["project-1", BET.id],
        createdAt: NOW,
      },
    ],
  };
  setCurrentBetAppetiteEnd(workspace, NOW);
  return { ...workspace, ...overrides };
}

function setCurrentBetAppetiteEnd(
  workspace: WorkspaceV2,
  appetiteEnd: string,
): void {
  const bet = workspace.bets[0];
  bet.appetiteEnd = appetiteEnd;
  bet.briefSnapshot.appetiteSeconds =
    (Date.parse(appetiteEnd) - Date.parse(bet.appetiteStart)) / 1_000;
  bet.briefHash = stableHashSync(
    bet.briefSnapshot as unknown as JsonValue,
  );
}

describe("structured Close", () => {
  it("treats only work without any recorded result as unfinished", () => {
    const variants = ([
      { id: "result-completed", resultStatus: "completed", percentComplete: 0 },
      { id: "result-learned", resultStatus: "learned", percentComplete: 0 },
      { id: "result-blocked", resultStatus: "blocked", percentComplete: 0 },
      { id: "no-result", resultStatus: undefined, percentComplete: 100 },
    ] as const).map((variant) => ({
      ...structuredClone(INCOMPLETE_ITEM),
      ...variant,
    }));
    const workspace = closingWorkspace({ workItems: variants });

    expect(
      unfinishedProjectWorkItems(workspace, "project-1").map(({ id }) => id),
    ).toEqual(["no-result"]);
  });

  it("tuple-encodes generated Inbox identities without delimiter collisions", () => {
    expect(returnedInboxItemId("a:b", "c")).not.toBe(
      returnedInboxItemId("a", "b:c"),
    );
  });

  it.each([
    "discard",
    "return_to_inbox",
    "follow_up_project",
    "historical_incomplete",
  ] as const)(
    "closes with %s while preserving every source artifact and link",
    async (disposition) => {
      const workspace = closingWorkspace();
      const sourceArtifacts = {
        project: structuredClone(workspace.projects[0]),
        bet: structuredClone(workspace.bets),
        plan: structuredClone(workspace.planVersions),
        workItems: structuredClone(workspace.workItems),
        dependencies: structuredClone(workspace.dependencies),
        evidence: structuredClone(workspace.evidence),
        baselines: structuredClone(workspace.baselines),
      };

      const result = applied(
        await executeCommand(
          workspace,
          {
            type: "close_project",
            projectId: "project-1",
            decision: decision(disposition),
          },
          context({ commandId: `command-${disposition}` }),
        ),
      );

      expect(result.workspace.projects[0]).toEqual({
        ...sourceArtifacts.project,
        stage: "closed",
        updatedAt: NOW,
      });
      expect(result.workspace.closeDecisions).toEqual([
        {
          ...decision(disposition),
          actorId: "human-1",
          closedAt: NOW,
        },
      ]);
      expect(result.workspace.bets).toEqual(sourceArtifacts.bet);
      expect(result.workspace.planVersions).toEqual(sourceArtifacts.plan);
      expect(result.workspace.workItems).toEqual(sourceArtifacts.workItems);
      expect(result.workspace.dependencies).toEqual(sourceArtifacts.dependencies);
      expect(result.workspace.evidence).toEqual(sourceArtifacts.evidence);
      expect(result.workspace.baselines).toEqual(sourceArtifacts.baselines);

      if (disposition === "return_to_inbox") {
        expect(result.workspace.inboxItems).toEqual([
          expect.objectContaining({
            sourceId: INCOMPLETE_ITEM.id,
            actorId: "human-1",
            originalText: INCOMPLETE_ITEM.title,
            capturedAt: NOW,
            triageStatus: "untriaged",
          }),
        ]);
      } else {
        expect(result.workspace.inboxItems).toEqual([]);
      }

      if (disposition === "follow_up_project") {
        expect(result.workspace.projects[1]).toMatchObject({
          id: "project-follow-up",
          stage: "direction",
          name: "Close safely follow-up",
        });
        expect(result.workspace.closeDecisions[0].followUpProjectId).toBe(
          result.workspace.projects[1].id,
        );
        expect(result.workspace.directionBriefs[1]).toMatchObject({
          projectId: "project-follow-up",
          audienceAndProblem: "",
          firstScope: [],
        });
      } else {
        expect(result.workspace.projects).toHaveLength(1);
        expect(result.workspace.directionBriefs).toHaveLength(1);
      }
    },
  );

  it("requires a complete decision and records the human actor and canonical command time", async () => {
    const result = await executeCommand(
      closingWorkspace(),
      {
        type: "close_project",
        projectId: "project-1",
        decision: decision("discard", { successComparison: "   " }),
      },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected rejection");
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "project:project-1:close_decision",
      permittedNextCommand: "close_project",
    });
  });

  it.each([
    {
      name: "a missing follow-up ID",
      draft: decision("follow_up_project", { followUpProjectId: undefined }),
      gate: "command_payload:close_project",
    },
    {
      name: "a blank follow-up ID",
      draft: decision("follow_up_project", { followUpProjectId: "   " }),
      gate: "project:project-1:close_decision",
    },
    {
      name: "an untrimmed follow-up ID",
      draft: decision("follow_up_project", {
        followUpProjectId: " project-follow-up ",
      }),
      gate: "project:project-1:close_decision",
    },
    {
      name: "a stray follow-up ID on another disposition",
      draft: decision("discard", { followUpProjectId: "stray-project" }),
      gate: "project:project-1:close_decision",
    },
  ])("rejects $name", async ({ draft, gate }) => {
    const result = rejected(
      await executeCommand(
        closingWorkspace(),
        { type: "close_project", projectId: "project-1", decision: draft },
        context(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate,
      permittedNextCommand: "close_project",
    });
  });

  it.each(["achieved", "partial", "invalidated", "abandoned"] as const)(
    "records the explicit %s outcome",
    async (outcome) => {
      const result = applied(
        await executeCommand(
          closingWorkspace(),
          {
            type: "close_project",
            projectId: "project-1",
            decision: decision("discard", {
              id: `close-${outcome}`,
              outcome,
            }),
          },
          context({ commandId: `command-outcome-${outcome}` }),
        ),
      );
      expect(result.workspace.closeDecisions[0].outcome).toBe(outcome);
    },
  );

  it.each([
    "direction",
    "awaiting_bet",
    "planning",
    "executing",
    "validating",
  ] as const)("rejects close_project from %s", async (stage) => {
    const workspace = closingWorkspace();
    workspace.projects[0] = { ...workspace.projects[0], stage };
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      gate: `project:project-1:stage:${stage}`,
      permittedNextCommand: "satisfy_validation",
    });
  });

  it("rejects close_project from closed with PROJECT_CLOSED", async () => {
    const workspace = closingWorkspace();
    workspace.projects[0] = { ...workspace.projects[0], stage: "closed" };
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "PROJECT_CLOSED",
      gate: "project:project-1:closed",
      permittedNextCommand: "create_follow_up_project",
    });
  });

  it.each(["original-first", "duplicate-first"] as const)(
    "fails closed on duplicate Project identity regardless of %s ordering",
    async (order) => {
      const workspace = closingWorkspace();
      const duplicate = {
        ...structuredClone(workspace.projects[0]),
        name: "Ambiguous duplicate",
      };
      workspace.projects =
        order === "original-first"
          ? [workspace.projects[0], duplicate]
          : [duplicate, workspace.projects[0]];

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "close_project",
            projectId: "project-1",
            decision: decision("discard"),
          },
          context(),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:ProjectV2:project-1",
        permittedNextCommand: "resolve_sync_conflict",
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it("requires the active Bet to be the sole uninvalidated same-project Bet", async () => {
    const workspace = closingWorkspace();
    workspace.bets.push({
      ...structuredClone(BET),
      id: "bet-another-current",
      version: 2,
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:current_bet",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("rejects an invalidated active Bet before ordinary Close", async () => {
    const workspace = closingWorkspace();
    delete workspace.projects[0].activePlanVersionId;
    workspace.planVersions = [];
    workspace.bets[0] = {
      ...workspace.bets[0],
      invalidatedAt: "2026-07-11T09:00:00.000Z",
      invalidationReason: "Material Direction change requires Re-bet.",
    };

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "BET_REQUIRED",
      gate: "project:project-1:current_bet",
      permittedNextCommand: "place_bet",
    });
    expect(result.workspace).toBe(workspace);
  });

  it.each(["original-first", "duplicate-first"] as const)(
    "fails closed on duplicate active Bet identity regardless of %s ordering",
    async (order) => {
      const workspace = closingWorkspace();
      const duplicate = {
        ...structuredClone(workspace.bets[0]),
        briefHash: "ambiguous-duplicate",
      };
      workspace.bets =
        order === "original-first"
          ? [workspace.bets[0], duplicate]
          : [duplicate, workspace.bets[0]];

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "close_project",
            projectId: "project-1",
            decision: decision("discard"),
          },
          context(),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:BetVersion:bet-1",
      });
    },
  );

  it("fails closed on duplicate active Direction brief identity", async () => {
    const workspace = closingWorkspace();
    workspace.directionBriefs.push({
      ...structuredClone(BRIEF),
      successEvidence: "Ambiguous duplicate",
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "entity_identity:DirectionBrief:brief-1",
    });
  });

  it.each([
    {
      name: "Bet",
      arrange: (workspace: WorkspaceV2) => {
        workspace.bets.push({
          ...structuredClone(BET),
          projectId: "project-other",
        });
      },
      entity: "BetVersion",
      id: BET.id,
    },
    {
      name: "Direction brief",
      arrange: (workspace: WorkspaceV2) => {
        workspace.directionBriefs.push({
          ...structuredClone(BRIEF),
          projectId: "project-other",
        });
      },
      entity: "DirectionBrief",
      id: BRIEF.id,
    },
  ])("fails closed on a cross-project duplicate $name identity", async ({ arrange, entity, id }) => {
    const workspace = closingWorkspace();
    arrange(workspace);
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: `entity_identity:${entity}:${id}`,
    });
  });

  it("fails closed when the project already has a different Close decision", async () => {
    const workspace = closingWorkspace();
    workspace.closeDecisions.push({
      ...decision("historical_incomplete", { id: "close-existing" }),
      actorId: "human-old",
      closedAt: CREATED_AT,
    });
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:close_identity",
      permittedNextCommand: "resolve_sync_conflict",
    });
  });

  it("rejects a Close timestamp before the Project existed", async () => {
    const workspace = closingWorkspace();
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("discard"),
        },
        context({ now: "2026-07-11T07:59:59.999Z" }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "project:project-1:close_decision",
    });
  });

  it.each([
    {
      name: "CloseDecision",
      disposition: "discard" as const,
      arrange: (workspace: WorkspaceV2) => {
        workspace.closeDecisions.push({
          ...decision("discard"),
          actorId: "human-old",
          closedAt: CREATED_AT,
        });
      },
    },
    {
      name: "generated returned Inbox item",
      disposition: "return_to_inbox" as const,
      arrange: (workspace: WorkspaceV2) => {
        workspace.inboxItems.push({
          id: JSON.stringify([
            "close_return_to_inbox",
            "close-return_to_inbox",
            INCOMPLETE_ITEM.id,
          ]),
          originalText: "Collision",
          sourceId: "source-existing",
          actorId: "human-old",
          capturedAt: CREATED_AT,
          triageStatus: "untriaged",
        });
      },
    },
    {
      name: "follow-up Project",
      disposition: "follow_up_project" as const,
      arrange: (workspace: WorkspaceV2) => {
        workspace.projects.push(
          buildProjectV2({
            id: "project-follow-up",
            activeDirectionBriefId: "brief-existing-follow-up",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          }),
        );
        workspace.directionBriefs.push(
          buildDirectionBrief({
            id: "brief-existing-follow-up",
            projectId: "project-follow-up",
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
          }),
        );
      },
    },
  ])("atomically rejects a $name ID collision", async ({ disposition, arrange }) => {
    const workspace = closingWorkspace();
    arrange(workspace);
    const before = structuredClone(workspace);

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision(disposition),
        },
        context(),
      ),
    );

    expect(result.rejection.code).toBe("ENTITY_ALREADY_EXISTS");
    expect(result.workspace).toBe(workspace);
    expect(result.workspace).toEqual(before);
  });

  it.each([
    {
      name: "Close decision",
      build: () => closingWorkspace(),
      command: () => ({
        type: "close_project" as const,
        projectId: "project-1",
        decision: decision("discard", { id: "action-close-collision" }),
      }),
    },
    {
      name: "Close follow-up Project",
      build: () => closingWorkspace(),
      command: () => ({
        type: "close_project" as const,
        projectId: "project-1",
        decision: decision("follow_up_project", {
          followUpProjectId: "action-close-collision",
        }),
      }),
    },
    {
      name: "Abandon decision",
      build: () => appetiteBoundaryWorkspace(),
      command: () => ({
        type: "abandon_project" as const,
        projectId: "project-1",
        decision: decision("discard", {
          id: "action-close-collision",
          outcome: "abandoned",
        }) as CloseDecisionDraft & { outcome: "abandoned" },
      }),
    },
    {
      name: "Abandon follow-up Project",
      build: () => appetiteBoundaryWorkspace(),
      command: () => ({
        type: "abandon_project" as const,
        projectId: "project-1",
        decision: decision("follow_up_project", {
          outcome: "abandoned",
          followUpProjectId: "action-close-collision",
        }) as CloseDecisionDraft & { outcome: "abandoned" },
      }),
    },
  ])("reports an Action collision on the generated $name identity", async ({ build, command }) => {
    const workspace = build();
    const inbox: InboxItem = {
      id: "inbox-close-collision",
      originalText: "Existing Action",
      sourceId: "ui-source",
      actorId: "human-1",
      capturedAt: CREATED_AT,
      triageStatus: "action",
      actionId: "action-close-collision",
    };
    const action: Action = {
      id: "action-close-collision",
      inboxItemId: inbox.id,
      title: "Existing Action",
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
      attention: "medium",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    workspace.inboxItems.push(inbox);
    workspace.actions.push(action);

    const result = rejected(
      await executeCommand(workspace, command(), context()),
    );

    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: "entity_id:Action:action-close-collision",
      permittedNextCommand: command().type,
    });
    expect(result.workspace).toBe(workspace);
  });

  it("rechecks an evidence exception that expired after validation but before Close", async () => {
    const requirement: ProjectWorkItem = {
      ...structuredClone(INCOMPLETE_ITEM),
      id: "validation-milestone",
      kind: "milestone",
      evidenceRequired: true,
      resultStatus: "learned",
    };
    const workspace = closingWorkspace({
      workItems: [requirement],
      dependencies: [],
      planVersions: [
        {
          ...closingWorkspace().planVersions[0],
          workItemRevisions: { [requirement.id]: requirement.revision },
          dependencyRevisions: {},
          scopeMapping: { [requirement.id]: requirement.betScopeId },
          capacityIndependentDates: {
            [requirement.id]: { start: CREATED_AT, finish: NOW },
          },
        },
      ],
      exceptions: [
        {
          id: "exception-expired",
          projectId: "project-1",
          requirementId: requirement.id,
          rationale: "Allowed validation to proceed.",
          knownConsequence: "Close still needs current evidence.",
          reviewAt: "2026-07-11T09:00:00.000Z",
          expiresAt: "2026-07-11T09:30:00.000Z",
          approvedBy: "human-1",
          createdAt: CREATED_AT,
          history: [
            {
              action: "created",
              actorId: "human-1",
              at: CREATED_AT,
              note: "Allowed validation to proceed.",
            },
          ],
        },
      ],
      evidence: [],
      baselines: [],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("historical_incomplete"),
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "EXCEPTION_EXPIRED",
      gate: "project:project-1:evidence:validation-milestone",
      permittedNextCommand: "attach_evidence",
    });
    expect(result.workspace).toBe(workspace);
  });
});

describe("appetite-boundary Close and Abandon", () => {
  it.each(["return_to_inbox", "follow_up_project"] as const)(
    "applies the same traceable %s disposition when abandoning",
    async (disposition) => {
      const workspace = appetiteBoundaryWorkspace();
      const sourceArtifacts = {
        bets: structuredClone(workspace.bets),
        plans: structuredClone(workspace.planVersions),
        workItems: structuredClone(workspace.workItems),
        dependencies: structuredClone(workspace.dependencies),
        evidence: structuredClone(workspace.evidence),
      };
      const draft = decision(disposition, {
        id: `abandon-${disposition}`,
        outcome: "abandoned",
      }) as CloseDecisionDraft & { outcome: "abandoned" };

      const result = applied(
        await executeCommand(
          workspace,
          {
            type: "abandon_project",
            projectId: "project-1",
            decision: draft,
          },
          context({ commandId: `command-abandon-${disposition}` }),
        ),
      );

      expect(result.workspace.projects[0]).toMatchObject({
        id: "project-1",
        stage: "closed",
        holds: [],
      });
      expect(result.workspace.closeDecisions).toEqual([
        { ...draft, actorId: "human-1", closedAt: NOW },
      ]);
      expect(result.workspace.bets).toEqual(sourceArtifacts.bets);
      expect(result.workspace.planVersions).toEqual(sourceArtifacts.plans);
      expect(result.workspace.workItems).toEqual(sourceArtifacts.workItems);
      expect(result.workspace.dependencies).toEqual(sourceArtifacts.dependencies);
      expect(result.workspace.evidence).toEqual(sourceArtifacts.evidence);
      if (disposition === "return_to_inbox") {
        expect(result.workspace.inboxItems).toEqual([
          expect.objectContaining({ sourceId: INCOMPLETE_ITEM.id }),
        ]);
      } else {
        expect(result.workspace.projects[1]).toMatchObject({
          id: "project-follow-up",
          stage: "direction",
        });
      }
    },
  );

  it("allows evidence, validation satisfaction, and ordinary Close at a recorded appetite boundary", async () => {
    const requirement: ProjectWorkItem = {
      ...structuredClone(INCOMPLETE_ITEM),
      id: "boundary-evidence",
      kind: "milestone",
      evidenceRequired: true,
      resultStatus: "learned",
    };
    const workspace = appetiteBoundaryWorkspace({
      workItems: [requirement],
      dependencies: [],
      evidence: [],
      baselines: [],
      planVersions: [
        {
          ...closingWorkspace().planVersions[0],
          workItemRevisions: { [requirement.id]: requirement.revision },
          dependencyRevisions: {},
          scopeMapping: { [requirement.id]: requirement.betScopeId },
          capacityIndependentDates: {
            [requirement.id]: { start: CREATED_AT, finish: NOW },
          },
        },
      ],
    });

    const withEvidence = applied(
      await executeCommand(
        workspace,
        {
          type: "attach_evidence",
          evidence: {
            id: "boundary-evidence-record",
            kind: "metric",
            summary: "Boundary validation result",
            projectId: "project-1",
            workItemId: requirement.id,
            createdAt: NOW,
            confidence: 1,
            tags: ["boundary"],
          },
        },
        context({ commandId: "attach-boundary-evidence" }),
      ),
    );
    const closing = applied(
      await executeCommand(
        withEvidence.workspace,
        { type: "satisfy_validation", projectId: "project-1" },
        context({
          commandId: "satisfy-boundary-validation",
          expectedRevision: withEvidence.workspace.revision,
        }),
      ),
    );
    const closed = applied(
      await executeCommand(
        closing.workspace,
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("historical_incomplete"),
        },
        context({
          commandId: "close-at-boundary",
          expectedRevision: closing.workspace.revision,
        }),
      ),
    );

    expect(closed.workspace.projects[0]).toMatchObject({
      stage: "closed",
      holds: [],
    });
  });

  it("keeps material-change Re-bet validation blocked", async () => {
    const workspace = appetiteBoundaryWorkspace();
    workspace.bets[0] = {
      ...workspace.bets[0],
      invalidatedAt: CREATED_AT,
      invalidationReason: "Material Direction change requires Re-bet.",
    };

    const result = rejected(
      await executeCommand(
        workspace,
        { type: "satisfy_validation", projectId: "project-1" },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "rebet_required",
      permittedNextCommand: "place_bet",
    });
  });

  it.each([
    {
      name: "duplicate boundary holds",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds.push(
          structuredClone(workspace.projects[0].holds[0]),
        );
      },
    },
    {
      name: "a hold recorded before appetite expiry",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          createdAt: CREATED_AT,
        };
      },
    },
    {
      name: "a future hold timestamp",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          createdAt: APPETITE_END,
        };
      },
    },
    {
      name: "a malformed hold timestamp",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          createdAt: "not-a-timestamp",
        };
      },
    },
    {
      name: "duplicate affected record IDs",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          affectedRecordIds: ["project-1", BET.id, BET.id],
        };
      },
    },
  ])("does not relax validation policy for $name", async ({ mutate }) => {
    const workspace = appetiteBoundaryWorkspace();
    mutate(workspace);
    const result = rejected(
      await executeCommand(
        workspace,
        { type: "satisfy_validation", projectId: "project-1" },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "HOLD_BLOCKS_COMMAND",
      hold: "rebet_required",
      permittedNextCommand: "place_bet",
    });
  });

  it.each(["original-first", "duplicate-first"] as const)(
    "fails closed on duplicate appetite-boundary Project identity with %s ordering",
    async (order) => {
      const workspace = appetiteBoundaryWorkspace();
      const duplicate = {
        ...structuredClone(workspace.projects[0]),
        name: "Ambiguous boundary project",
      };
      workspace.projects =
        order === "original-first"
          ? [workspace.projects[0], duplicate]
          : [duplicate, workspace.projects[0]];
      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "abandon_project",
            projectId: "project-1",
            decision: decision("discard", {
              id: "abandon-duplicate-project",
              outcome: "abandoned",
            }) as CloseDecisionDraft & { outcome: "abandoned" },
          },
          context(),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:ProjectV2:project-1",
      });
    },
  );

  it.each(["original-first", "duplicate-first"] as const)(
    "fails closed on duplicate appetite-boundary Direction brief with %s ordering",
    async (order) => {
      const workspace = appetiteBoundaryWorkspace();
      const duplicate = {
        ...structuredClone(workspace.directionBriefs[0]),
        successEvidence: "Ambiguous boundary evidence",
      };
      workspace.directionBriefs =
        order === "original-first"
          ? [workspace.directionBriefs[0], duplicate]
          : [duplicate, workspace.directionBriefs[0]];
      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "abandon_project",
            projectId: "project-1",
            decision: decision("discard", {
              id: "abandon-duplicate-brief",
              outcome: "abandoned",
            }) as CloseDecisionDraft & { outcome: "abandoned" },
          },
          context(),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "SYNC_CONFLICT",
        gate: "entity_identity:DirectionBrief:brief-1",
      });
    },
  );

  it.each([
    {
      name: "a hold owned by another Bet",
      mutate: (workspace: WorkspaceV2) => {
        workspace.bets.push({
          ...structuredClone(workspace.bets[0]),
          id: "bet-2",
          invalidatedAt: CREATED_AT,
          invalidationReason: "Superseded before the boundary.",
        });
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          sourceId: "bet-2",
          affectedRecordIds: ["project-1", "bet-2"],
        };
      },
    },
    {
      name: "a future appetite boundary",
      mutate: (workspace: WorkspaceV2) => {
        setCurrentBetAppetiteEnd(workspace, APPETITE_END);
      },
    },
    {
      name: "an invalidated active Bet",
      mutate: (workspace: WorkspaceV2) => {
        workspace.bets[0] = {
          ...workspace.bets[0],
          invalidatedAt: CREATED_AT,
          invalidationReason: "Material change",
        };
      },
    },
    {
      name: "duplicate boundary affected record IDs",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0] = {
          ...workspace.projects[0].holds[0],
          affectedRecordIds: ["project-1", BET.id, BET.id],
        };
      },
    },
  ])("rejects Abandon from $name", async ({ mutate }) => {
    const workspace = appetiteBoundaryWorkspace();
    mutate(workspace);
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "abandon_project",
          projectId: "project-1",
          decision: decision("historical_incomplete", {
            id: "abandon-invalid-boundary",
            outcome: "abandoned",
          }) as CloseDecisionDraft & { outcome: "abandoned" },
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      gate: "project:project-1:appetite_boundary",
      permittedNextCommand: "record_bet_boundary",
    });
    expect(result.workspace).toBe(workspace);
  });

  it("fails closed when the appetite-boundary Bet identity is duplicated", async () => {
    const workspace = appetiteBoundaryWorkspace();
    workspace.bets.push({
      ...structuredClone(workspace.bets[0]),
      briefHash: "ambiguous-boundary-bet",
    });
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "abandon_project",
          projectId: "project-1",
          decision: decision("discard", {
            id: "abandon-duplicate-bet",
            outcome: "abandoned",
          }) as CloseDecisionDraft & { outcome: "abandoned" },
        },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "entity_identity:BetVersion:bet-1",
    });
  });

  it("rejects Abandon when another same-project Bet is also current", async () => {
    const workspace = appetiteBoundaryWorkspace();
    workspace.bets.push({
      ...structuredClone(workspace.bets[0]),
      id: "bet-another-current",
      version: 2,
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "abandon_project",
          projectId: "project-1",
          decision: decision("historical_incomplete", {
            id: "abandon-multiple-current-bets",
            outcome: "abandoned",
          }) as CloseDecisionDraft & { outcome: "abandoned" },
        },
        context(),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "project:project-1:current_bet",
      permittedNextCommand: "resolve_sync_conflict",
    });
    expect(result.workspace).toBe(workspace);
  });

  it.each([
    {
      name: "duplicate matching holds",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds.push(
          structuredClone(workspace.projects[0].holds[0]),
        );
      },
    },
    {
      name: "a malformed hold timestamp",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0].createdAt = "not-a-timestamp";
      },
    },
    {
      name: "a future hold timestamp",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0].createdAt = APPETITE_END;
      },
    },
    {
      name: "duplicate affected record IDs",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0].affectedRecordIds = [
          "project-1",
          BET.id,
          BET.id,
        ];
      },
    },
    {
      name: "the wrong affected record IDs",
      mutate: (workspace: WorkspaceV2) => {
        workspace.projects[0].holds[0].affectedRecordIds = [
          "project-1",
          "work-incomplete",
        ];
      },
    },
  ])(
    "does not silently clear $name during ordinary Close",
    async ({ mutate }) => {
      const workspace = appetiteBoundaryWorkspace();
      workspace.projects[0].stage = "closing";
      mutate(workspace);
      const before = structuredClone(workspace);

      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "close_project",
            projectId: "project-1",
            decision: decision("historical_incomplete", {
              id: `close-invalid-boundary-${workspace.projects[0].holds.length}`,
            }),
          },
          context({ commandId: `ordinary-close-${workspace.projects[0].holds.length}` }),
        ),
      );

      expect(result.rejection).toMatchObject({
        code: "ILLEGAL_LIFECYCLE_TRANSITION",
        gate: "project:project-1:appetite_boundary",
        permittedNextCommand: "record_bet_boundary",
      });
      expect(result.workspace).toBe(workspace);
      expect(result.workspace).toEqual(before);
    },
  );
});

describe("closed immutability and archive visibility", () => {
  async function closedWorkspace(): Promise<WorkspaceV2> {
    return applied(
      await executeCommand(
        closingWorkspace(),
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("historical_incomplete"),
        },
        context(),
      ),
    ).workspace;
  }

  async function closedWorkspaceWithPromotedAction(): Promise<WorkspaceV2> {
    const inbox: InboxItem = {
      id: "inbox-promoted",
      originalText: "Promoted work",
      sourceId: "ui-source",
      actorId: "human-1",
      capturedAt: CREATED_AT,
      triageStatus: "action",
      actionId: "action-promoted",
    };
    const action: Action = {
      id: "action-promoted",
      inboxItemId: inbox.id,
      title: "Promoted work",
      revision: 2,
      status: "promoted",
      eligibility: {
        singleSession: false,
        estimateSeconds: 10_800,
        dependencyIds: [],
        requiresMilestoneEvidence: false,
        outcomeCount: 1,
        solutionKnown: true,
      },
      attention: "deep",
      promotedProjectId: "project-1",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    };
    return applied(
      await executeCommand(
        closingWorkspace({ inboxItems: [inbox], actions: [action] }),
        {
          type: "close_project",
          projectId: "project-1",
          decision: decision("historical_incomplete"),
        },
        context({ commandId: "close-with-promoted-action" }),
      ),
    ).workspace;
  }

  it.each([
    {
      origin: "ui" as const,
      capabilities: ["human_decision"] as const,
    },
    {
      origin: "sync" as const,
      capabilities: ["replay_receipt"] as const,
    },
    {
      origin: "import" as const,
      capabilities: ["import_portable"] as const,
    },
  ])("rejects post-Close mutation from $origin", async ({ origin, capabilities }) => {
    const workspace = await closedWorkspace();
    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "update_project_metadata",
          projectId: "project-1",
          name: "Forbidden rewrite",
        },
        context({
          commandId: `mutate-closed-${origin}`,
          expectedRevision: workspace.revision,
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
      code: "PROJECT_CLOSED",
      permittedNextCommand: "create_follow_up_project",
    });
    expect(result.workspace).toBe(workspace);
  });

  it.each([
    {
      origin: "ui" as const,
      capabilities: ["human_decision"] as const,
    },
    {
      origin: "sync" as const,
      capabilities: ["replay_receipt"] as const,
    },
    {
      origin: "import" as const,
      capabilities: ["import_portable"] as const,
    },
  ])(
    "rejects Actuals against a closed Project's promoted Action from $origin",
    async ({ origin, capabilities }) => {
      const workspace = await closedWorkspaceWithPromotedAction();
      const result = rejected(
        await executeCommand(
          workspace,
          {
            type: "record_actual",
            actual: {
              id: `actual-promoted-${origin}`,
              revision: 1,
              target: { kind: "action", actionId: "action-promoted" },
              actualWorkSeconds: 600,
              remainingWorkSeconds: 0,
              actualCost: 0,
              recordedAt: NOW,
            },
          },
          context({
            commandId: `record-promoted-actual-${origin}`,
            expectedRevision: workspace.revision,
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
        code: "PROJECT_CLOSED",
        permittedNextCommand: "create_follow_up_project",
      });
      expect(result.workspace).toBe(workspace);
    },
  );

  it("archives and unarchives only visibility while preserving all lifecycle hashes", async () => {
    let workspace = await closedWorkspace();
    const immutable = {
      projects: structuredClone(workspace.projects),
      bets: structuredClone(workspace.bets),
      plans: structuredClone(workspace.planVersions),
      close: structuredClone(workspace.closeDecisions),
    };

    for (const [archived, expected] of [
      [true, ["project-1"]],
      [true, ["project-1"]],
      [false, []],
      [false, []],
    ] as const) {
      workspace = applied(
        await executeCommand(
          workspace,
          { type: "archive_project", projectId: "project-1", archived },
          context({
            commandId: `archive-${archived}-${workspace.revision}`,
            expectedRevision: workspace.revision,
          }),
        ),
      ).workspace;
      expect(workspace.visibility.archivedProjectIds).toEqual(expected);
      expect(workspace.projects).toEqual(immutable.projects);
      expect(workspace.bets).toEqual(immutable.bets);
      expect(workspace.planVersions).toEqual(immutable.plans);
      expect(workspace.closeDecisions).toEqual(immutable.close);
    }
  });

  it("rejects archive for a project that is not closed", async () => {
    const workspace = closingWorkspace();
    const result = rejected(
      await executeCommand(
        workspace,
        { type: "archive_project", projectId: "project-1", archived: true },
        context(),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "ILLEGAL_LIFECYCLE_TRANSITION",
      gate: "project:project-1:stage:closing",
      permittedNextCommand: "close_project",
    });
  });

  it("fails closed on duplicate archived Project identity", async () => {
    const workspace = await closedWorkspace();
    workspace.projects.push({
      ...structuredClone(workspace.projects[0]),
      name: "Ambiguous closed duplicate",
    });
    const result = rejected(
      await executeCommand(
        workspace,
        { type: "archive_project", projectId: "project-1", archived: true },
        context({
          commandId: "archive-duplicate-project",
          expectedRevision: workspace.revision,
        }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "SYNC_CONFLICT",
      gate: "entity_identity:ProjectV2:project-1",
    });
  });

  it("rejects an archive receipt ID that collides with an immutable project entity", async () => {
    const workspace = await closedWorkspace();
    const result = rejected(
      await executeCommand(
        workspace,
        { type: "archive_project", projectId: "project-1", archived: true },
        context({
          commandId: INCOMPLETE_ITEM.id,
          expectedRevision: workspace.revision,
        }),
      ),
    );
    expect(result.rejection).toMatchObject({
      code: "ENTITY_ALREADY_EXISTS",
      gate: `entity_id:ProjectWorkItem:${INCOMPLETE_ITEM.id}`,
      permittedNextCommand: "archive_project",
    });
    expect(result.workspace).toBe(workspace);
  });
});
