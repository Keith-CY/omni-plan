import { describe, expect, it } from "vitest";

import { stableHash } from "../domain/stableHash";
import { createEmptyWorkspaceV2 } from "../domain/workspace";
import type { V2Command } from "../domain/commands";
import type {
  AuditDiff,
  CommandProposal,
  CommandReceipt,
  JsonValue,
  WorkspaceV2,
} from "../domain/types";
import {
  isKnownUnprotectedLifecycleWriter,
  projectProtectedEffectBundle,
  type ProtectedOperationView,
} from "./syncConflictBundles";

const SUBMITTED_AT = "2026-07-12T00:00:00.000Z";
const ACCEPTED_AT = "2026-07-12T00:01:00.000Z";

type ProposedCommand = Extract<
  V2Command,
  { type: "update_direction" | "propose_replan" }
>;

interface AcceptedProposalFixture {
  workspace: WorkspaceV2;
  proposal: CommandProposal;
  submitCommand: V2Command;
  submitReceipt: CommandReceipt;
  view: ProtectedOperationView;
  nestedDiff: AuditDiff[];
}

function asV2Command(value: unknown): V2Command {
  return value as V2Command;
}

async function exactSubmitReceipt(input: {
  proposal: CommandProposal;
  submitCommand: V2Command;
}): Promise<CommandReceipt> {
  const base: Omit<CommandReceipt, "receiptHash"> = {
    id: `command:submit:${input.proposal.id}`,
    commandId: `command:submit:${input.proposal.id}`,
    commandType: "submit_command_proposal",
    baseRevision: input.proposal.baseRevision,
    revision: input.proposal.baseRevision + 1,
    payloadHash: await stableHash(
      input.submitCommand as unknown as JsonValue,
    ),
    actorId: input.proposal.agentActorId,
    actorKind: "agent",
    origin: "agent",
    source: {
      sourceId: "verified-agent-bridge",
      verified: true,
      capabilities: ["submit_proposal"],
    },
    status: "applied",
    createdAt: input.proposal.createdAt,
    diff: [
      {
        entity: "CommandProposal",
        entityId: input.proposal.id,
        field: "created",
        before: null,
        after: input.proposal as unknown as JsonValue,
      },
    ],
  };
  return {
    ...base,
    receiptHash: await stableHash(base as unknown as JsonValue),
  };
}

async function acceptedProposalFixture(input: {
  workspace: WorkspaceV2;
  proposalId: string;
  command: ProposedCommand;
  nestedDiff: AuditDiff[];
  provenanceSeed: number;
}): Promise<AcceptedProposalFixture> {
  const baseRevision = 7;
  const proposal: CommandProposal = {
    id: input.proposalId,
    commandType: input.command.type,
    payload: input.command as unknown as JsonValue,
    baseRevision,
    rationale: "Bounded Agent recommendation for human review.",
    agentActorId: "agent:planner",
    createdAt: SUBMITTED_AT,
    status: "open",
  };
  const submitCommand = asV2Command({
    type: "submit_command_proposal",
    proposalId: proposal.id,
    command: input.command,
    rationale: proposal.rationale,
  });
  const submitReceipt = await exactSubmitReceipt({ proposal, submitCommand });
  input.workspace.revision = baseRevision + 1;
  input.workspace.commandProposals.push(structuredClone(proposal));
  input.workspace.commandReceipts.push(structuredClone(submitReceipt));

  const hash = (offset: number) =>
    (input.provenanceSeed + offset).toString(16).padStart(64, "0");
  const view: ProtectedOperationView = {
    workspace: input.workspace,
    command: asV2Command({
      type: "accept_command_proposal",
      proposalId: proposal.id,
    }),
    commandId: `command:accept:${proposal.id}`,
    authorityRootOperationHash: hash(0),
    sourceOperationHash: hash(1),
    receiptHash: hash(2),
    payloadHash: hash(3),
    createdAt: ACCEPTED_AT,
    diff: [
      ...input.nestedDiff,
      {
        entity: "CommandProposal",
        entityId: proposal.id,
        field: "status",
        before: "open",
        after: "accepted",
      },
    ],
  };
  return {
    workspace: input.workspace,
    proposal,
    submitCommand,
    submitReceipt,
    view,
    nestedDiff: input.nestedDiff,
  };
}

function activeDirectionFixture(editorial: boolean) {
  const workspace = createEmptyWorkspaceV2(
    editorial
      ? "workspace-agent-editorial-direction"
      : "workspace-agent-material-direction",
  );
  const oldBrief = {
    id: "brief-1",
    projectId: "project-1",
    version: 1,
    audienceAndProblem: "Audience",
    successEvidence: "Evidence",
    appetiteSeconds: 3_600,
    validationMethod: "Validate",
    firstScope: [{ id: "scope-1", title: "Scope", description: "Bounded" }],
    noGoOrKill: "Stop",
    advancedNotes: "",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
  const nextBrief = {
    ...oldBrief,
    id: "project-1:direction-brief:2",
    version: 2,
    ...(editorial
      ? { advancedNotes: "Editorial clarification only." }
      : { successEvidence: "Materially changed evidence." }),
    createdAt: ACCEPTED_AT,
    updatedAt: ACCEPTED_AT,
  };
  workspace.projects.push({
    id: "project-1",
    name: "Project",
    priority: 1,
    notes: "",
    stage: "executing",
    holds: [],
    activeDirectionBriefId: oldBrief.id,
    activeBetId: "bet-1",
    createdAt: oldBrief.createdAt,
    updatedAt: oldBrief.updatedAt,
  });
  workspace.directionBriefs.push(oldBrief);
  workspace.bets.push({
    id: "bet-1",
    projectId: "project-1",
    version: 1,
    briefId: oldBrief.id,
    briefHash: "brief-hash",
    briefSnapshot: oldBrief,
    committedScope: oldBrief.firstScope,
    appetiteStart: oldBrief.createdAt,
    appetiteEnd: "2026-07-13T00:00:00.000Z",
    actorId: "human-1",
    approvedAt: oldBrief.createdAt,
  });

  const {
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...briefDraft
  } = nextBrief;
  const command = {
    type: "update_direction",
    projectId: "project-1",
    brief: { ...briefDraft, id: oldBrief.id },
  } as const satisfies ProposedCommand;
  const baseDiff: AuditDiff[] = [
    {
      entity: "DirectionBrief",
      entityId: nextBrief.id,
      field: "created",
      before: null,
      after: nextBrief as unknown as JsonValue,
    },
    {
      entity: "ProjectV2",
      entityId: "project-1",
      field: "activeDirectionBriefId",
      before: oldBrief.id,
      after: nextBrief.id,
    },
    {
      entity: "ProjectV2",
      entityId: "project-1",
      field: "updatedAt",
      before: oldBrief.updatedAt,
      after: ACCEPTED_AT,
    },
  ];
  if (editorial) return { workspace, command, nestedDiff: baseDiff };

  const hold = {
    type: "rebet_required" as const,
    sourceId: "bet-1",
    affectedRecordIds: ["project-1", oldBrief.id, nextBrief.id, "bet-1"],
    createdAt: ACCEPTED_AT,
  };
  return {
    workspace,
    command,
    nestedDiff: [
      {
        entity: "BetVersion",
        entityId: "bet-1",
        field: "invalidatedAt",
        before: null,
        after: ACCEPTED_AT,
      },
      {
        entity: "BetVersion",
        entityId: "bet-1",
        field: "invalidationReason",
        before: null,
        after: "Material Direction change requires Re-bet.",
      },
      ...baseDiff,
      {
        entity: "ProjectV2",
        entityId: "project-1",
        field: "holds",
        before: [],
        after: [hold] as unknown as JsonValue,
      },
    ] satisfies AuditDiff[],
  };
}

async function materialDirectionAcceptance() {
  const direction = activeDirectionFixture(false);
  return acceptedProposalFixture({
    ...direction,
    proposalId: "agent-proposal:material-direction",
    provenanceSeed: 901,
  });
}

describe("accepted Agent proposal sync provenance", () => {
  it("projects accepted material Direction as the effective protected command while retaining the outer human acceptance identity", async () => {
    const fixture = await materialDirectionAcceptance();

    const bundle = await projectProtectedEffectBundle(fixture.view);

    expect(bundle?.logicalKey).toBe('["bet","project-1"]');
    expect(bundle?.operations).toHaveLength(1);
    expect(bundle?.operations[0]).toMatchObject({
      commandType: "update_direction",
      command: fixture.proposal.payload,
      commandId: fixture.view.commandId,
      authorityRootOperationHash: fixture.view.authorityRootOperationHash,
      sourceOperationHash: fixture.view.sourceOperationHash,
      receiptHash: fixture.view.receiptHash,
      payloadHash: fixture.view.payloadHash,
      createdAt: ACCEPTED_AT,
    });
  });

  it("projects accepted propose_replan as the effective protected writer under the outer acceptance provenance", async () => {
    const workspace = createEmptyWorkspaceV2("workspace-agent-replan");
    const submittedReplan = {
      id: "replan-1",
      localDate: "2026-07-12",
      baseCommitmentId: "commitment-1",
      baseRevision: 7,
      reasonCodes: ["ACTUAL_CHANGED"],
      proposedSlots: [],
      proposalHash: "submitted-replan-hash",
      createdAt: SUBMITTED_AT,
      createdBy: "agent:planner",
      status: "open" as const,
    };
    const acceptedReplan = {
      ...submittedReplan,
      baseRevision: 8,
      proposalHash: "accepted-replan-hash",
      createdAt: ACCEPTED_AT,
      createdBy: "human:reviewer",
    };
    const command = {
      type: "propose_replan",
      proposal: submittedReplan,
    } as const satisfies ProposedCommand;
    const fixture = await acceptedProposalFixture({
      workspace,
      proposalId: "agent-proposal:replan",
      command,
      provenanceSeed: 911,
      nestedDiff: [
        {
          entity: "ReplanProposal",
          entityId: acceptedReplan.id,
          field: "created",
          before: null,
          after: acceptedReplan as unknown as JsonValue,
        },
      ],
    });

    const bundle = await projectProtectedEffectBundle(fixture.view);

    expect(bundle?.logicalKey).toBe('["daily_commitment","2026-07-12"]');
    expect(bundle?.operations[0]).toMatchObject({
      commandType: "propose_replan",
      command: { type: "propose_replan", proposal: acceptedReplan },
      commandId: fixture.view.commandId,
      receiptHash: fixture.view.receiptHash,
      payloadHash: fixture.view.payloadHash,
    });
  });

  it("strips CommandProposal bookkeeping from protected cells", async () => {
    const fixture = await materialDirectionAcceptance();

    const bundle = await projectProtectedEffectBundle(fixture.view);

    expect(bundle).toBeDefined();
    expect(bundle?.operations[0].cells).not.toContainEqual(
      expect.objectContaining({ entity: "CommandProposal" }),
    );
    expect(bundle?.operations[0].cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "create",
          entity: "DirectionBrief",
        }),
        expect.objectContaining({
          kind: "scalar",
          entity: "BetVersion",
          field: "invalidatedAt",
        }),
      ]),
    );
  });

  it("keeps accepted editorial Direction on the known-unprotected replay path", async () => {
    const direction = activeDirectionFixture(true);
    const fixture = await acceptedProposalFixture({
      ...direction,
      proposalId: "agent-proposal:editorial-direction",
      provenanceSeed: 921,
    });

    await expect(projectProtectedEffectBundle(fixture.view)).resolves.toBeUndefined();
    expect(
      isKnownUnprotectedLifecycleWriter({
        command: direction.command,
        createdAt: fixture.view.createdAt,
        diff: fixture.nestedDiff,
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: "missing exact submit receipt",
      mutate: (fixture: AcceptedProposalFixture) => {
        fixture.workspace.commandReceipts = [];
      },
    },
    {
      label: "forged submit payload hash",
      mutate: (fixture: AcceptedProposalFixture) => {
        fixture.workspace.commandReceipts[0].payloadHash = "forged-payload-hash";
      },
    },
    {
      label: "submit diff that does not create the exact stored proposal",
      mutate: (fixture: AcceptedProposalFixture) => {
        fixture.workspace.commandReceipts[0].diff[0].after = {
          ...(fixture.proposal as unknown as Record<string, JsonValue>),
          status: "accepted",
        };
      },
    },
    {
      label: "stored commandType that disagrees with its payload",
      mutate: (fixture: AcceptedProposalFixture) => {
        fixture.workspace.commandProposals[0].commandType = "propose_replan";
      },
    },
    {
      label: "acceptance diff that does not perform open to accepted",
      mutate: (fixture: AcceptedProposalFixture) => {
        const status = fixture.view.diff.find(
          ({ entity }) => entity === "CommandProposal",
        );
        if (status !== undefined) status.after = "stale";
      },
    },
  ])("rejects $label", async ({ mutate }) => {
    const fixture = await materialDirectionAcceptance();
    mutate(fixture);

    await expect(projectProtectedEffectBundle(fixture.view)).rejects.toThrow(
      /proposal|receipt|provenance|accept/i,
    );
  });
});
