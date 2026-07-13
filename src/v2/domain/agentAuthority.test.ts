import { describe, expect, it } from "vitest";

import type { Evidence } from "@/domain/types";

import {
  AGENT_COMMAND_AUTHORITY,
  PROPOSABLE_COMMAND_TYPES,
} from "./agentAuthority";
import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "./commands";
import { authorizeCommand, type AuthorizationContext } from "./policy";
import type { Action, CommandProposal, JsonValue, WorkspaceV2 } from "./types";
import {
  buildDirectionBrief,
  buildInboxItem,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";

const NOW = "2026-07-14T09:00:00.000Z";

type AgentDisposition =
  | "automatic"
  | "proposal_submission"
  | "proposal_only"
  | "human_confirmation"
  | "human_mutation"
  | "system_only";

const EXPECTED_AGENT_COMMAND_DISPOSITIONS = {
  configure_capacity: "human_mutation",
  capture_inbox: "automatic",
  confirm_action_triage: "human_confirmation",
  confirm_project_triage: "human_confirmation",
  update_project_metadata: "human_mutation",
  update_action: "human_mutation",
  complete_action: "human_mutation",
  promote_action_to_project: "human_confirmation",
  update_direction: "proposal_only",
  place_bet: "human_confirmation",
  create_work_item: "proposal_only",
  update_work_item: "proposal_only",
  upsert_dependency: "proposal_only",
  remove_dependency: "proposal_only",
  remove_work_item: "human_mutation",
  capture_baseline: "human_mutation",
  complete_work_item: "human_mutation",
  propose_replan: "proposal_only",
  commit_today: "human_confirmation",
  accept_replan: "human_confirmation",
  record_actual: "automatic",
  attach_evidence: "automatic",
  approve_evidence_exception: "human_confirmation",
  resolve_evidence_exception: "human_mutation",
  request_validation: "human_mutation",
  satisfy_validation: "human_mutation",
  record_bet_boundary: "system_only",
  mark_review_overdue: "system_only",
  create_review: "system_only",
  complete_review: "human_confirmation",
  open_sync_conflict: "system_only",
  resolve_sync_conflict: "human_confirmation",
  submit_command_proposal: "proposal_submission",
  accept_command_proposal: "human_confirmation",
  dismiss_command_proposal: "human_confirmation",
  close_project: "human_confirmation",
  abandon_project: "human_confirmation",
  archive_project: "human_mutation",
} as const satisfies Record<V2Command["type"], AgentDisposition>;

const PROPOSABLE_TYPES = [
  "update_direction",
  "create_work_item",
  "update_work_item",
  "propose_replan",
  "upsert_dependency",
  "remove_dependency",
] as const;

const DIRECT_AGENT_REJECTIONS = Object.entries(
  EXPECTED_AGENT_COMMAND_DISPOSITIONS,
).filter(([, disposition]) =>
  disposition === "proposal_only" ||
  disposition === "human_confirmation" ||
  disposition === "human_mutation"
);

function command(value: unknown): V2Command {
  return value as V2Command;
}

function context(
  overrides: Partial<CommandContext> = {},
): CommandContext {
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
    now: NOW,
    ...overrides,
  };
}

function agentContext(
  capability:
    | "capture_inbox"
    | "record_actual"
    | "attach_evidence"
    | "submit_proposal",
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return context({
    actorId: "agent-1",
    actorKind: "agent",
    origin: "agent",
    source: {
      sourceId: "agent-source-1",
      verified: true,
      capabilities: [capability],
    },
    ...overrides,
  });
}

function authorizationContext(
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  return {
    actorKind: "agent",
    origin: "agent",
    source: {
      sourceId: "agent-source-1",
      verified: true,
      capabilities: ["submit_proposal"],
    },
    workspaceRevision: 0,
    projectHolds: [],
    ...overrides,
  };
}

function rejected(result: CommandResult): Extract<CommandResult, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected command rejection");
  return result;
}

function applied(result: CommandResult): Extract<CommandResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected command application: ${result.rejection.code}`);
  return result;
}

function directionWorkspace(): WorkspaceV2 {
  return buildWorkspaceV2("workspace-agent", {
    projects: [
      buildProjectV2({
        id: "project-1",
        activeDirectionBriefId: "brief-1",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
    directionBriefs: [
      buildDirectionBrief({
        id: "brief-1",
        projectId: "project-1",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
  });
}

function directionCommand(): V2Command {
  return command({
    type: "update_direction",
    projectId: "project-1",
    brief: {
      id: "brief-1",
      projectId: "project-1",
      audienceAndProblem: "Teams cannot see the next binding decision.",
      successEvidence: "A verified workflow test reaches the decision.",
      appetiteSeconds: 7_200,
      validationMethod: "Run the workflow test.",
      firstScope: [
        {
          id: "scope-1",
          title: "Bounded slice",
          description: "Make one binding decision obvious.",
        },
      ],
      noGoOrKill: "Stop if the lifecycle can be bypassed.",
      advancedNotes: "",
    },
  });
}

function proposalCommand(
  nested: V2Command = directionCommand(),
  proposalId = "command-proposal-1",
): V2Command {
  return command({
    type: "submit_command_proposal",
    proposalId,
    command: nested,
    rationale: "This is the smallest safe next change.",
  });
}

async function submittedDirectionProposal(): Promise<
  Extract<CommandResult, { ok: true }>
> {
  return applied(
    await executeCommand(
      directionWorkspace(),
      proposalCommand(),
      agentContext("submit_proposal", { commandId: "submit-proposal-1" }),
    ),
  );
}

const PROPOSABLE_COMMANDS: readonly V2Command[] = [
  directionCommand(),
  command({
    type: "create_work_item",
    projectId: "project-1",
    workItem: {
      id: "work-item-new",
      projectId: "project-1",
      kind: "task",
      title: "Implement a bounded slice",
      outline: "Keep it reviewable.",
      durationSeconds: 1_800,
      estimate: { mostLikelySeconds: 1_800 },
      assignmentIds: [],
      percentComplete: 0,
      revision: 1,
      betScopeId: "scope-1",
    },
  }),
  command({
    type: "update_work_item",
    projectId: "project-1",
    workItemId: "work-item-1",
    patch: { title: "Clarify the bounded slice" },
  }),
  command({
    type: "propose_replan",
    proposal: {
      id: "replan-1",
      localDate: "2026-07-14",
      baseCommitmentId: "commitment-1",
      baseRevision: 0,
      reasonCodes: ["actual_changed"],
      proposedSlots: [],
      proposalHash: "proposal-hash",
      createdAt: NOW,
      createdBy: "agent-1",
      status: "open",
    },
  }),
  command({
    type: "upsert_dependency",
    dependency: {
      id: "dependency-1",
      projectId: "project-1",
      fromId: "work-item-1",
      toId: "work-item-2",
      type: "FS",
      lagSeconds: 0,
      revision: 1,
    },
  }),
  command({ type: "remove_dependency", dependencyId: "dependency-1" }),
];

describe("exhaustive Agent authority", () => {
  it("assigns one explicit disposition to all 38 commands", () => {
    expect(Object.keys(AGENT_COMMAND_AUTHORITY)).toHaveLength(38);
    expect(AGENT_COMMAND_AUTHORITY).toEqual(
      EXPECTED_AGENT_COMMAND_DISPOSITIONS,
    );
  });

  it("keeps the proposal-only allowlist at exactly six command types", () => {
    expect(PROPOSABLE_COMMAND_TYPES).toEqual(PROPOSABLE_TYPES);
    expect(
      Object.entries(AGENT_COMMAND_AUTHORITY)
        .filter(([, disposition]) => disposition === "proposal_only")
        .map(([type]) => type)
        .sort(),
    ).toEqual([...PROPOSABLE_TYPES].sort());
  });

  it.each(DIRECT_AGENT_REJECTIONS)(
    "rejects direct Agent execution of %s (%s)",
    (commandType, disposition) => {
      expect(
        authorizeCommand(commandType, authorizationContext()),
      ).toMatchObject({
        code:
          disposition === "human_mutation" || disposition === "proposal_only"
            ? "ACTOR_NOT_AUTHORIZED"
            : "HUMAN_CONFIRMATION_REQUIRED",
        actorKind: "agent",
        origin: "agent",
      });
    },
  );

  it("never partially applies a proposal-only command executed directly", async () => {
    const workspace = directionWorkspace();
    const before = structuredClone(workspace);
    const result = rejected(
      await executeCommand(
        workspace,
        directionCommand(),
        agentContext("submit_proposal", { commandId: "direct-direction" }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "ACTOR_NOT_AUTHORIZED",
      gate: "agent_proposal_required",
      permittedNextCommand: "submit_command_proposal",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace).toEqual(before);
  });
});

describe("automatic Agent commands", () => {
  const inbox = buildInboxItem({
    id: "inbox-action-1",
    sourceId: "human-source",
    actorId: "human-1",
    capturedAt: NOW,
    actionId: "action-1",
    triageStatus: "action",
  });
  const action: Action = {
    id: "action-1",
    inboxItemId: inbox.id,
    title: "Small action",
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
    createdAt: NOW,
    updatedAt: NOW,
  };
  const evidence: Evidence = {
    id: "evidence-agent-1",
    kind: "note",
    summary: "Verified evidence from the authorized source.",
    projectId: "project-1",
    createdAt: NOW,
    confidence: 1,
    tags: ["agent"],
  };
  const cases = [
    {
      type: "capture_inbox" as const,
      capability: "capture_inbox" as const,
      workspace: buildWorkspaceV2("workspace-capture"),
      command: command({ type: "capture_inbox", id: "inbox-agent-1", text: "Capture" }),
      collection: "inboxItems" as const,
    },
    {
      type: "record_actual" as const,
      capability: "record_actual" as const,
      workspace: buildWorkspaceV2("workspace-actual", { inboxItems: [inbox], actions: [action] }),
      command: command({
        type: "record_actual",
        actual: {
          id: "actual-agent-1",
          revision: 1,
          target: { kind: "action", actionId: action.id },
          actualWorkSeconds: 300,
          remainingWorkSeconds: 300,
          actualCost: 0,
          recordedAt: NOW,
        },
      }),
      collection: "actuals" as const,
    },
    {
      type: "attach_evidence" as const,
      capability: "attach_evidence" as const,
      workspace: directionWorkspace(),
      command: command({ type: "attach_evidence", evidence }),
      collection: "evidence" as const,
    },
  ];

  it.each(cases)(
    "auto-applies $type only with its exact verified capability",
    async ({ capability, workspace, command: automaticCommand, collection }) => {
      const result = applied(
        await executeCommand(
          workspace,
          automaticCommand,
          agentContext(capability, { commandId: `auto-${capability}` }),
        ),
      );
      expect(result.workspace[collection]).toHaveLength(1);
    },
  );

  it.each(cases)(
    "rejects unverified Agent $type without mutation",
    async ({ capability, workspace, command: automaticCommand }) => {
      const result = rejected(
        await executeCommand(
          workspace,
          automaticCommand,
          agentContext(capability, {
            commandId: `unverified-${capability}`,
            source: {
              sourceId: "unverified-agent-source",
              verified: false,
              capabilities: [capability],
            },
          }),
        ),
      );
      expect(result.rejection.code).toBe("SOURCE_NOT_AUTHORIZED");
      expect(result.workspace).toBe(workspace);
    },
  );

  it.each(cases)(
    "rejects Agent $type when its exact capability is absent",
    async ({ capability, workspace, command: automaticCommand }) => {
      const result = rejected(
        await executeCommand(
          workspace,
          automaticCommand,
          agentContext("submit_proposal", { commandId: `missing-${capability}` }),
        ),
      );
      expect(result.rejection).toMatchObject({
        code: "SOURCE_NOT_AUTHORIZED",
        gate: `source_capability:${capability}`,
      });
      expect(result.workspace).toBe(workspace);
    },
  );
});

describe("Command proposal lifecycle", () => {
  it.each(PROPOSABLE_COMMANDS)(
    "stores the full $type command without applying its domain mutation",
    async (nested) => {
      const workspace = directionWorkspace();
      const before = structuredClone(workspace);
      const proposalId = `proposal-${nested.type}`;
      const result = applied(
        await executeCommand(
          workspace,
          proposalCommand(nested, proposalId),
          agentContext("submit_proposal", {
            commandId: `submit-${nested.type}`,
          }),
        ),
      );

      expect(result.workspace.commandProposals).toEqual([
        {
          id: proposalId,
          commandType: nested.type as CommandProposal["commandType"],
          payload: nested as unknown as JsonValue,
          baseRevision: 0,
          rationale: "This is the smallest safe next change.",
          agentActorId: "agent-1",
          createdAt: NOW,
          status: "open",
        },
      ] satisfies CommandProposal[]);
      expect(result.workspace.revision).toBe(1);
      expect(result.workspace.commandReceipts).toHaveLength(1);
      expect({
        ...result.workspace,
        revision: 0,
        commandProposals: [],
        commandReceipts: [],
      }).toEqual(before);
    },
  );

  it("rejects a submitted nested command outside the exact six-type allowlist", async () => {
    const workspace = directionWorkspace();
    const result = rejected(
      await executeCommand(
        workspace,
        proposalCommand(command({
          type: "place_bet",
          projectId: "project-1",
          betId: "bet-1",
          start: NOW,
        })),
        agentContext("submit_proposal", { commandId: "submit-human-only" }),
      ),
    );

    expect(result.rejection.code).toBe("INVALID_COMMAND");
    expect(result.workspace).toBe(workspace);
    expect(workspace.commandProposals).toEqual([]);
  });

  it("rejects a proposed command with an explicitly undefined optional field", async () => {
    const workspace = directionWorkspace();
    const submitted = {
      type: "submit_command_proposal",
      proposalId: "proposal-non-json",
      command: {
        type: "update_work_item",
        projectId: "project-1",
        workItemId: "work-1",
        patch: { parentId: undefined },
      },
      rationale: "This graph must remain backup-safe.",
    } as unknown as V2Command;

    const result = rejected(
      await executeCommand(
        workspace,
        submitted,
        agentContext("submit_proposal", { commandId: "submit-non-json" }),
      ),
    );

    expect(result.rejection).toMatchObject({
      code: "INVALID_COMMAND",
      gate: "command_payload:submit_command_proposal",
    });
    expect(result.workspace).toBe(workspace);
    expect(workspace.commandProposals).toEqual([]);
  });

  it("stales every open proposal on the next successful command", async () => {
    const submitted = await submittedDirectionProposal();
    const result = applied(
      await executeCommand(
        submitted.workspace,
        command({ type: "capture_inbox", id: "inbox-after-proposal", text: "Next" }),
        agentContext("capture_inbox", {
          commandId: "next-successful-command",
          expectedRevision: submitted.workspace.revision,
        }),
      ),
    );

    expect(result.workspace.commandProposals[0].status).toBe("stale");
  });

  it("does not stale an open proposal when the next command is rejected", async () => {
    const submitted = await submittedDirectionProposal();
    const result = rejected(
      await executeCommand(
        submitted.workspace,
        directionCommand(),
        agentContext("submit_proposal", {
          commandId: "rejected-after-proposal",
          expectedRevision: submitted.workspace.revision,
        }),
      ),
    );

    expect(result.workspace).toBe(submitted.workspace);
    expect(result.workspace.commandProposals[0].status).toBe("open");
    expect(result.workspace.revision).toBe(1);
    expect(result.workspace.commandReceipts).toHaveLength(1);
  });

  it("atomically accepts one fresh proposal as one revision and one receipt", async () => {
    const submitted = await submittedDirectionProposal();
    const result = applied(
      await executeCommand(
        submitted.workspace,
        command({ type: "accept_command_proposal", proposalId: "command-proposal-1" }),
        context({
          commandId: "accept-proposal-1",
          expectedRevision: submitted.workspace.revision,
        }),
      ),
    );

    expect(result.workspace.revision).toBe(2);
    expect(result.workspace.commandReceipts).toHaveLength(2);
    expect(result.workspace.commandReceipts.map(({ commandType }) => commandType)).toEqual([
      "submit_command_proposal",
      "accept_command_proposal",
    ]);
    expect(result.receipt.commandType).toBe("accept_command_proposal");
    expect(result.workspace.commandProposals[0].status).toBe("accepted");
    expect(result.workspace.projects[0].stage).toBe("awaiting_bet");
    expect(result.workspace.directionBriefs[0]).toMatchObject({
      audienceAndProblem: "Teams cannot see the next binding decision.",
      version: 2,
    });
    expect(result.receipt.diff.some(({ entity }) => entity === "CommandProposal")).toBe(true);
    expect(result.receipt.diff.some(({ entity }) => entity === "DirectionBrief")).toBe(true);
  });

  it("rejects acceptance of a proposal staled by a successful command", async () => {
    const submitted = await submittedDirectionProposal();
    const advanced = applied(
      await executeCommand(
        submitted.workspace,
        command({ type: "capture_inbox", id: "inbox-stale", text: "Advance" }),
        agentContext("capture_inbox", {
          commandId: "advance-after-proposal",
          expectedRevision: 1,
        }),
      ),
    );
    const result = rejected(
      await executeCommand(
        advanced.workspace,
        command({ type: "accept_command_proposal", proposalId: "command-proposal-1" }),
        context({ commandId: "accept-stale", expectedRevision: 2 }),
      ),
    );

    expect(result.rejection.code).toBe("REVISION_CONFLICT");
    expect(result.workspace).toBe(advanced.workspace);
    expect(result.workspace.projects[0].stage).toBe("direction");
  });

  it("rejects a malformed stored nested command without mutation", async () => {
    const submitted = await submittedDirectionProposal();
    const malformed = structuredClone(submitted.workspace);
    malformed.commandProposals[0].payload = {
      type: "update_direction",
      projectId: "project-1",
    };
    const before = structuredClone(malformed);
    const result = rejected(
      await executeCommand(
        malformed,
        command({ type: "accept_command_proposal", proposalId: "command-proposal-1" }),
        context({ commandId: "accept-malformed", expectedRevision: 1 }),
      ),
    );

    expect(result.rejection.code).toBe("INVALID_COMMAND");
    expect(result.workspace).toBe(malformed);
    expect(malformed).toEqual(before);
  });

  it("rejects acceptance without the exact applied submit receipt", async () => {
    const submitted = await submittedDirectionProposal();
    const forged = {
      ...structuredClone(submitted.workspace),
      commandReceipts: [],
    };
    const result = rejected(
      await executeCommand(
        forged,
        command({ type: "accept_command_proposal", proposalId: "command-proposal-1" }),
        context({ commandId: "accept-without-submit", expectedRevision: 1 }),
      ),
    );

    expect(result.rejection.code).toBe("REVISION_CONFLICT");
    expect(result.workspace).toBe(forged);
    expect(forged.projects[0].stage).toBe("direction");
  });

  it("lets only a human dismiss an open proposal without applying it", async () => {
    const submitted = await submittedDirectionProposal();
    const agentAttempt = rejected(
      await executeCommand(
        submitted.workspace,
        command({ type: "dismiss_command_proposal", proposalId: "command-proposal-1" }),
        agentContext("submit_proposal", {
          commandId: "agent-dismiss",
          expectedRevision: 1,
        }),
      ),
    );
    expect(agentAttempt.rejection.code).toBe("HUMAN_CONFIRMATION_REQUIRED");
    expect(agentAttempt.workspace.commandProposals[0].status).toBe("open");

    const dismissed = applied(
      await executeCommand(
        submitted.workspace,
        command({ type: "dismiss_command_proposal", proposalId: "command-proposal-1" }),
        context({ commandId: "human-dismiss", expectedRevision: 1 }),
      ),
    );
    expect(dismissed.workspace.revision).toBe(2);
    expect(dismissed.workspace.commandReceipts).toHaveLength(2);
    expect(dismissed.workspace.commandProposals[0].status).toBe("dismissed");
    expect(dismissed.workspace.projects[0].stage).toBe("direction");
    expect(dismissed.workspace.directionBriefs[0].version).toBe(1);
  });
});
