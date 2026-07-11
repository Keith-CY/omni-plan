import { describe, expect, it } from "vitest";

import type { Baseline } from "@/domain/types";

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
  type V2Command,
} from "./commands";
import { resolvePlanningContext } from "./planning";
import type {
  Action,
  BetScope,
  LegacyAuditRecord,
  ProjectDependency,
  ProjectWorkItem,
  WorkspaceV2,
} from "./types";

const NOW = "2026-07-11T09:00:00.000Z";
const BET_END = "2026-07-11T17:00:00.000Z";
const SCOPE_ONE: BetScope = {
  id: "scope-1",
  title: "First outcome",
  description: "Deliver the first bounded outcome",
};
const SCOPE_TWO: BetScope = {
  id: "scope-2",
  title: "Second outcome",
  description: "Refine a second bounded outcome",
};

const WORK_ITEM: ProjectWorkItem = {
  id: "work-item-1",
  projectId: "project-1",
  kind: "task",
  title: "Implement bounded work",
  outline: "Stay inside the Bet",
  durationSeconds: 3_600,
  estimate: { mostLikelySeconds: 3_600 },
  assignmentIds: [],
  percentComplete: 0,
  revision: 1,
  betScopeId: SCOPE_ONE.id,
};

const SECOND_WORK_ITEM: ProjectWorkItem = {
  ...WORK_ITEM,
  id: "work-item-2",
  title: "Verify bounded work",
};

const DEPENDENCY: ProjectDependency = {
  id: "dependency-1",
  projectId: "project-1",
  fromId: WORK_ITEM.id,
  toId: SECOND_WORK_ITEM.id,
  type: "FS",
  lagSeconds: 0,
  revision: 1,
};

function activeWorkspace(
  overrides: Partial<WorkspaceV2> = {},
): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: "brief-1",
    projectId: "project-1",
    appetiteSeconds: 28_800,
    firstScope: [SCOPE_ONE, SCOPE_TWO],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const bet = buildBetVersion({
    id: "bet-1",
    projectId: "project-1",
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: [SCOPE_ONE, SCOPE_TWO],
    appetiteStart: NOW,
    appetiteEnd: BET_END,
    actorId: "human-1",
    approvedAt: NOW,
  });
  return buildWorkspaceV2("workspace-1", {
    projects: [
      buildProjectV2({
        id: "project-1",
        stage: "planning",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
    ...overrides,
  });
}

function context(
  workspace: WorkspaceV2,
  commandId = "planning-command",
  now = NOW,
): CommandContext {
  return {
    commandId,
    expectedRevision: workspace.revision,
    actorId: "human-1",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "human-session",
      verified: true,
      capabilities: ["human_decision"],
    },
    now,
  };
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected command rejection");
  return result;
}

describe("planning mutation preconditions", () => {
  it("returns the current unexpired Bet without mutating the workspace", () => {
    const workspace = activeWorkspace();
    const before = structuredClone(workspace);

    const result = resolvePlanningContext(
      workspace,
      "project-1",
      NOW,
      "create_work_item",
    );

    expect(result).toMatchObject({
      ok: true,
      project: { id: "project-1" },
      bet: { id: "bet-1" },
    });
    expect(workspace).toEqual(before);
  });

  it("requires a Bet before plan mutation", () => {
    const workspace = activeWorkspace({
      projects: [
        buildProjectV2({
          id: "project-1",
          stage: "awaiting_bet",
          activeDirectionBriefId: "brief-1",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      bets: [],
    });

    expect(
      resolvePlanningContext(
        workspace,
        "project-1",
        NOW,
        "create_work_item",
      ),
    ).toMatchObject({
      ok: false,
      code: "BET_REQUIRED",
      permittedNextCommand: "place_bet",
    });
  });

  it.each(["migration_review", "rebet_required"] as const)(
    "blocks plan mutation during %s",
    (hold) => {
      const workspace = activeWorkspace();
      workspace.projects[0].holds = [
        {
          type: hold,
          sourceId: `${hold}-source`,
          affectedRecordIds: ["project-1"],
          createdAt: NOW,
        },
      ];

      expect(
        resolvePlanningContext(
          workspace,
          "project-1",
          NOW,
          "create_work_item",
        ),
      ).toMatchObject({
        ok: false,
        code: "HOLD_BLOCKS_COMMAND",
        hold,
      });
    },
  );

  it("uses stable hold priority when multiple planning holds exist", () => {
    const workspace = activeWorkspace();
    workspace.projects[0].holds = [
      {
        type: "rebet_required",
        sourceId: "rebet-source",
        affectedRecordIds: ["project-1"],
        createdAt: NOW,
      },
      {
        type: "migration_review",
        sourceId: "migration-source",
        affectedRecordIds: ["project-1"],
        createdAt: NOW,
      },
    ];

    expect(
      resolvePlanningContext(
        workspace,
        "project-1",
        NOW,
        "create_work_item",
      ),
    ).toMatchObject({
      ok: false,
      code: "HOLD_BLOCKS_COMMAND",
      hold: "migration_review",
    });
  });

  it("rejects planning at the appetite boundary", () => {
    const workspace = activeWorkspace();

    expect(
      resolvePlanningContext(
        workspace,
        "project-1",
        BET_END,
        "update_work_item",
      ),
    ).toMatchObject({
      ok: false,
      code: "BET_EXPIRED",
      gate: "bet:bet-1:appetite_end",
      permittedNextCommand: "record_bet_boundary",
    });
  });

  it("rejects planning after Close", () => {
    const workspace = activeWorkspace();
    workspace.projects[0].stage = "closed";

    expect(
      resolvePlanningContext(
        workspace,
        "project-1",
        NOW,
        "update_work_item",
      ),
    ).toMatchObject({
      ok: false,
      code: "PROJECT_CLOSED",
      permittedNextCommand: "create_follow_up_project",
    });
  });

  it.each(["validating", "closing"] as const)(
    "rejects plan mutation from the %s stage",
    (stage) => {
      const workspace = activeWorkspace();
      workspace.projects[0].stage = stage;

      expect(
        resolvePlanningContext(
          workspace,
          "project-1",
          NOW,
          "update_work_item",
        ),
      ).toMatchObject({
        ok: false,
        code: "ILLEGAL_LIFECYCLE_TRANSITION",
      });
    },
  );
});

describe("Bet-scoped Work Item planning", () => {
  it("creates a Work Item in committed scope at revision one copy-on-write", async () => {
    const workspace = activeWorkspace();
    const before = structuredClone(workspace);
    const input = structuredClone(WORK_ITEM);

    const result = await executeCommand(
      workspace,
      { type: "create_work_item", projectId: "project-1", workItem: input },
      context(workspace),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.workItems).toEqual([WORK_ITEM]);
    expect(result.workspace.workItems[0]).not.toBe(input);
    expect(workspace).toEqual(before);
  });

  it.each([
    { name: "unknown", scopeId: "scope-unknown", bets: undefined },
    {
      name: "superseded",
      scopeId: "scope-old",
      bets: "with-superseded" as const,
    },
  ])("rejects a $name Bet scope and recommends Direction", async ({ scopeId, bets }) => {
    const workspace = activeWorkspace();
    if (bets === "with-superseded") {
      const oldBrief = buildDirectionBrief({
        id: "brief-old",
        projectId: "project-1",
        firstScope: [
          { id: scopeId, title: "Old", description: "Superseded scope" },
        ],
        createdAt: NOW,
        updatedAt: NOW,
      });
      workspace.directionBriefs.push(oldBrief);
      workspace.bets.unshift(
        buildBetVersion({
          id: "bet-old",
          projectId: "project-1",
          briefId: oldBrief.id,
          briefSnapshot: structuredClone(oldBrief),
          committedScope: structuredClone(oldBrief.firstScope),
          appetiteStart: "2026-07-10T09:00:00.000Z",
          appetiteEnd: "2026-07-10T17:00:00.000Z",
          actorId: "human-1",
          approvedAt: "2026-07-10T09:00:00.000Z",
          invalidatedAt: NOW,
          invalidationReason: "Superseded by Re-bet bet-1.",
        }),
      );
    }
    const before = structuredClone(workspace);

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "create_work_item",
          projectId: "project-1",
          workItem: { ...WORK_ITEM, betScopeId: scopeId },
        },
        context(workspace, `scope-${scopeId}`),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "SCOPE_OUTSIDE_BET",
      gate: `project:project-1:bet:bet-1:scope:${scopeId}`,
      permittedNextCommand: "update_direction",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(before);
  });

  it("refines a Work Item inside committed scope and increments its revision", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });
    const before = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "update_work_item",
        projectId: "project-1",
        workItemId: WORK_ITEM.id,
        patch: {
          title: "Refined bounded work",
          durationSeconds: 2_700,
          betScopeId: SCOPE_TWO.id,
        },
      },
      context(workspace, "update-work-item"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.workItems[0]).toMatchObject({
      id: WORK_ITEM.id,
      title: "Refined bounded work",
      durationSeconds: 2_700,
      betScopeId: SCOPE_TWO.id,
      revision: 2,
    });
    expect(workspace).toEqual(before);
  });

  it("rejects an update that moves work outside active Bet scope", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "update_work_item",
          projectId: "project-1",
          workItemId: WORK_ITEM.id,
          patch: { betScopeId: "scope-unknown" },
        },
        context(workspace, "update-outside-scope"),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "SCOPE_OUTSIDE_BET",
      permittedNextCommand: "update_direction",
    });
  });

  it("completes a Work Item without changing its identity or prior workspace", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });
    workspace.actuals.push({
      id: "actual-complete-work-item",
      revision: 1,
      target: { kind: "work_item", workItemId: WORK_ITEM.id },
      actualWorkSeconds: 300,
      remainingWorkSeconds: 0,
      actualCost: 0,
      recordedAt: NOW,
    });
    const before = structuredClone(workspace);

    const result = await executeCommand(
      workspace,
      {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: WORK_ITEM.id,
        resultStatus: "learned",
        outcomeNote: "The smaller approach is sufficient.",
      },
      context(workspace, "complete-work-item"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.workItems[0]).toMatchObject({
      id: WORK_ITEM.id,
      revision: 2,
      resultStatus: "learned",
      outcomeNote: "The smaller approach is sufficient.",
    });
    expect(workspace).toEqual(before);
  });

  it("removes only an unreferenced Work Item and never cascades dependency history", async () => {
    const freeWorkspace = activeWorkspace({ workItems: [WORK_ITEM] });
    const removed = await executeCommand(
      freeWorkspace,
      {
        type: "remove_work_item",
        projectId: "project-1",
        workItemId: WORK_ITEM.id,
      },
      context(freeWorkspace, "remove-free-item"),
    );
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.workspace.workItems).toEqual([]);

    const linkedWorkspace = activeWorkspace({
      workItems: [WORK_ITEM, SECOND_WORK_ITEM],
      dependencies: [DEPENDENCY],
    });
    const blocked = rejected(
      await executeCommand(
        linkedWorkspace,
        {
          type: "remove_work_item",
          projectId: "project-1",
          workItemId: WORK_ITEM.id,
        },
        context(linkedWorkspace, "remove-linked-item"),
      ),
    );
    expect(blocked.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      permittedNextCommand: "remove_dependency",
    });
    expect(blocked.workspace).toBe(linkedWorkspace);
  });
});

describe("dependency revisions and project boundaries", () => {
  it("upserts a project-local dependency with monotonic revisions", async () => {
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM, SECOND_WORK_ITEM],
    });
    const created = await executeCommand(
      workspace,
      { type: "upsert_dependency", dependency: DEPENDENCY },
      context(workspace, "create-dependency"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.workspace.dependencies).toEqual([DEPENDENCY]);

    const updated = await executeCommand(
      created.workspace,
      {
        type: "upsert_dependency",
        dependency: { ...DEPENDENCY, type: "SS", lagSeconds: 600 },
      },
      context(created.workspace, "update-dependency"),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.workspace.dependencies).toEqual([
      { ...DEPENDENCY, type: "SS", lagSeconds: 600, revision: 2 },
    ]);
    expect(created.workspace.dependencies).toEqual([DEPENDENCY]);
  });

  it("rejects cross-project dependency edges with an explicit unsupported diagnostic", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });
    const otherBrief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      firstScope: [SCOPE_ONE],
      createdAt: NOW,
      updatedAt: NOW,
    });
    const otherBet = buildBetVersion({
      id: "bet-2",
      projectId: "project-2",
      briefId: otherBrief.id,
      briefSnapshot: structuredClone(otherBrief),
      committedScope: [SCOPE_ONE],
      appetiteStart: NOW,
      appetiteEnd: BET_END,
      actorId: "human-1",
      approvedAt: NOW,
    });
    workspace.projects.push(
      buildProjectV2({
        id: "project-2",
        stage: "planning",
        activeDirectionBriefId: otherBrief.id,
        activeBetId: otherBet.id,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    workspace.directionBriefs.push(otherBrief);
    workspace.bets.push(otherBet);
    workspace.workItems.push({
      ...SECOND_WORK_ITEM,
      id: "project-2-item",
      projectId: "project-2",
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "upsert_dependency",
          dependency: {
            ...DEPENDENCY,
            toId: "project-2-item",
          },
        },
        context(workspace, "cross-project-dependency"),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "dependency:dependency-1:cross_project",
    });
    expect(result.rejection.reason).toContain(
      "Cross-project dependency edges are unsupported",
    );
  });

  it("removes an uncommitted dependency without rewriting other IDs", async () => {
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM, SECOND_WORK_ITEM],
      dependencies: [DEPENDENCY, { ...DEPENDENCY, id: "dependency-2" }],
    });

    const result = await executeCommand(
      workspace,
      { type: "remove_dependency", dependencyId: DEPENDENCY.id },
      context(workspace, "remove-dependency"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.dependencies.map(({ id }) => id)).toEqual([
      "dependency-2",
    ]);
    expect(workspace.dependencies).toHaveLength(2);
  });
});

describe("Baseline capture and structural command validation", () => {
  const BASELINE: Baseline = {
    id: "baseline-1",
    projectId: "project-1",
    name: "Initial approved schedule",
    capturedAt: NOW,
    plannedStartByItem: { [WORK_ITEM.id]: NOW },
    plannedFinishByItem: { [WORK_ITEM.id]: BET_END },
    plannedWorkSecondsByItem: { [WORK_ITEM.id]: 3_600 },
  };

  it("captures a Baseline by preserving its ID and maps copy-on-write", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });
    const baseline = structuredClone(BASELINE);

    const result = await executeCommand(
      workspace,
      { type: "capture_baseline", baseline },
      context(workspace, "capture-baseline"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.workspace.baselines).toEqual([BASELINE]);
    expect(result.workspace.baselines[0]).not.toBe(baseline);
    expect(result.workspace.baselines[0].plannedStartByItem).not.toBe(
      baseline.plannedStartByItem,
    );
  });

  it.each([
    {
      name: "noncanonical capture timestamp",
      baseline: { ...BASELINE, capturedAt: "2026-07-11" },
    },
    {
      name: "invalid planned start",
      baseline: {
        ...BASELINE,
        plannedStartByItem: { [WORK_ITEM.id]: "not-a-date" },
      },
    },
    {
      name: "noncanonical planned finish",
      baseline: {
        ...BASELINE,
        plannedFinishByItem: {
          [WORK_ITEM.id]: "2026-07-11T17:00:00Z",
        },
      },
    },
    {
      name: "mismatched Work Item key sets",
      baseline: { ...BASELINE, plannedFinishByItem: {} },
    },
    {
      name: "finish before start",
      baseline: {
        ...BASELINE,
        plannedStartByItem: { [WORK_ITEM.id]: BET_END },
        plannedFinishByItem: { [WORK_ITEM.id]: NOW },
      },
    },
    {
      name: "negative planned work",
      baseline: {
        ...BASELINE,
        plannedWorkSecondsByItem: { [WORK_ITEM.id]: -1 },
      },
    },
  ])("rejects a Baseline with $name", async ({ baseline }) => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });

    const result = rejected(
      await executeCommand(
        workspace,
        { type: "capture_baseline", baseline },
        context(workspace, `invalid-baseline-${baseline.id}`),
      ),
    );

    expect(result.rejection.code).toBe("INVALID_COMMAND");
    expect(result.workspace).toBe(workspace);
  });

  it("structurally rejects nonfinite planned work", async () => {
    const workspace = activeWorkspace({ workItems: [WORK_ITEM] });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "capture_baseline",
          baseline: {
            ...BASELINE,
            plannedWorkSecondsByItem: { [WORK_ITEM.id]: Number.POSITIVE_INFINITY },
          },
        },
        context(workspace, "nonfinite-baseline"),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:capture_baseline",
    });
  });

  function legacyDecision(
    overrides: Partial<LegacyAuditRecord> = {},
  ): LegacyAuditRecord {
    return {
      id: "legacy-decision-1",
      projectId: "project-1",
      recordType: "decision",
      sourcePayload: {},
      sourceChecksum: "decision-checksum",
      ...overrides,
    };
  }

  it.each(["decision", "audit_decision"] as const)(
    "accepts same-project legacy %s Baseline approval provenance",
    async (recordType) => {
      const decision = legacyDecision({ recordType });
      const workspace = activeWorkspace({
        workItems: [WORK_ITEM],
        legacyAuditRecords: [decision],
      });

      const result = await executeCommand(
        workspace,
        {
          type: "capture_baseline",
          baseline: { ...BASELINE, approvedByDecisionId: decision.id },
        },
        context(workspace, `baseline-${recordType}`),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.workspace.baselines[0].approvedByDecisionId).toBe(
          decision.id,
        );
      }
    },
  );

  it.each([
    {
      name: "nonexistent decision",
      records: [] as LegacyAuditRecord[],
      approvedByDecisionId: "legacy-missing",
    },
    {
      name: "wrong legacy record type",
      records: [legacyDecision({ recordType: "audit_gate" })],
      approvedByDecisionId: "legacy-decision-1",
    },
  ])("rejects $name as Baseline approval provenance", async ({ records, approvedByDecisionId }) => {
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM],
      legacyAuditRecords: records,
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "capture_baseline",
          baseline: { ...BASELINE, approvedByDecisionId },
        },
        context(workspace, `baseline-${approvedByDecisionId}`),
      ),
    );

    expect(result.rejection.code).toBe("ENTITY_NOT_FOUND");
    expect(result.rejection.gate).toBe(
      `baseline:${BASELINE.id}:approved_by_decision`,
    );
  });

  it("rejects cross-project legacy Baseline approval provenance", async () => {
    const otherBrief = buildDirectionBrief({
      id: "brief-2",
      projectId: "project-2",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const decision = legacyDecision({ projectId: "project-2" });
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM],
      projects: [
        ...activeWorkspace().projects,
        buildProjectV2({
          id: "project-2",
          activeDirectionBriefId: otherBrief.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [...activeWorkspace().directionBriefs, otherBrief],
      legacyAuditRecords: [decision],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "capture_baseline",
          baseline: { ...BASELINE, approvedByDecisionId: decision.id },
        },
        context(workspace, "baseline-cross-project-decision"),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ENTITY_NOT_FOUND",
      gate: `baseline:${BASELINE.id}:approved_by_decision`,
    });
  });

  it("rejects an Action ID as Baseline approval provenance", async () => {
    const action: Action = {
      id: "action-approval",
      inboxItemId: "inbox-action-approval",
      title: "Not an approval decision",
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
      createdAt: NOW,
      updatedAt: NOW,
    };
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM],
      inboxItems: [
        {
          id: action.inboxItemId,
          originalText: action.title,
          sourceId: "source-1",
          actorId: "human-1",
          capturedAt: NOW,
          triageStatus: "action",
          actionId: action.id,
        },
      ],
      actions: [action],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        {
          type: "capture_baseline",
          baseline: { ...BASELINE, approvedByDecisionId: action.id },
        },
        context(workspace, "baseline-action-approval"),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ACTION_PROMOTION_REQUIRED",
      permittedNextCommand: "promote_action_to_project",
    });
  });

  it.each([
    {
      name: "dependency revision",
      command: {
        type: "upsert_dependency",
        dependency: { ...DEPENDENCY, revision: "one" },
      },
    },
    {
      name: "remove dependency ID",
      command: { type: "remove_dependency", dependencyId: 42 },
    },
    {
      name: "remove Work Item ID",
      command: {
        type: "remove_work_item",
        projectId: "project-1",
        workItemId: false,
      },
    },
    {
      name: "Baseline work map",
      command: {
        type: "capture_baseline",
        baseline: {
          ...BASELINE,
          plannedWorkSecondsByItem: { [WORK_ITEM.id]: "3600" },
        },
      },
    },
    {
      name: "completion result status",
      command: {
        type: "complete_work_item",
        projectId: "project-1",
        workItemId: WORK_ITEM.id,
        resultStatus: "done",
        outcomeNote: "Done",
      },
    },
  ])("totally rejects an invalid $name payload", async ({ name, command }) => {
    const workspace = activeWorkspace({
      workItems: [WORK_ITEM, SECOND_WORK_ITEM],
    });

    const result = rejected(
      await executeCommand(
        workspace,
        command as unknown as V2Command,
        context(workspace, `invalid-${name}`),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: `command_payload:${command.type}`,
    });
  });
});
