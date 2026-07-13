import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import {
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import {
  deleteV2Database,
  openV2Database,
  requestResult,
  transactionComplete,
  V2_OBJECT_STORES,
} from "./indexedDb";
import {
  authorizeSyncBranchV2,
  createSyncOperationV2,
  createSyncManifestV2,
  decryptAndVerifySyncOperationV2,
  isAuthorizedProposalAcceptanceFor,
  type AuthorizedSyncReplay,
  type VerifiedSyncReplay,
  verifySyncHistoryV2,
} from "./syncProtocol";

const NOW = "2026-07-12T04:00:00.000Z";
const PASSPHRASE = "sync replay secret";

function humanContext(
  commandId: string,
  expectedRevision: number,
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    commandId,
    expectedRevision,
    actorId: "human-remote",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "remote-human-session",
      verified: true,
      capabilities: ["human_decision"],
    },
    now: NOW,
    ...overrides,
  };
}

function capture(id: string): V2Command {
  return {
    type: "capture_inbox",
    id: `inbox-${id}`,
    text: `Captured ${id}`,
  };
}

async function verifiedOperation(
  workspaceId: string,
  commandId: string,
): Promise<VerifiedSyncReplay> {
  const command = capture(commandId);
  const result = await executeCommand(
    buildWorkspaceV2(workspaceId),
    command,
    humanContext(commandId, 0),
  );
  if (!result.ok) throw new Error(`Expected remote fixture: ${result.rejection.code}`);
  const operation = await createSyncOperationV2({
    workspaceId,
    deviceId: "device-remote",
    sequence: 1,
    operationId: `operation-${commandId}`,
    command,
    receipt: result.receipt,
    passphrase: PASSPHRASE,
  });
  return decryptAndVerifySyncOperationV2({
    envelope: operation.envelope,
    path: operation.path,
    passphrase: PASSPHRASE,
    expectedWorkspaceId: workspaceId,
    expectedOperationHash: operation.operationHash,
    expectedPreviousOperationHash: null,
  });
}

async function authorizedReplay(
  workspaceId: string,
  commandId: string,
): Promise<AuthorizedSyncReplay> {
  const operation = await verifiedOperation(workspaceId, commandId);
  const history = verifySyncHistoryV2(
    createSyncManifestV2({
      workspaceId,
      heads: {
        [operation.deviceId]: {
          sequence: operation.sequence,
          operationHash: operation.operationHash,
          revision: operation.receipt.revision,
          updatedAt: operation.receipt.createdAt,
        },
      },
      updatedAt: operation.receipt.createdAt,
    }),
    [operation],
  );
  const branch = await authorizeSyncBranchV2({
    history,
    trustedAncestorWorkspace: buildWorkspaceV2(workspaceId),
    headOperationHash: operation.operationHash,
  });
  return branch.replays[0];
}

describe("CommandService verified sync replay boundary", () => {
  let indexedDB: IDBFactory;
  let databaseNames: string[];

  beforeEach(() => {
    indexedDB = new IDBFactory();
    databaseNames = [];
  });

  afterEach(async () => {
    await Promise.all(
      databaseNames.map((databaseName) =>
        deleteV2Database({ databaseName, indexedDB }).catch(() => undefined),
      ),
    );
  });

  function repository(suffix: string): BrowserWorkspaceRepository {
    const databaseName = `omni-plan-v2-sync-replay-${suffix}`;
    databaseNames.push(databaseName);
    return new BrowserWorkspaceRepository({ databaseName, indexedDB });
  }

  async function seed(
    target: BrowserWorkspaceRepository,
    workspace: ReturnType<typeof buildWorkspaceV2>,
  ): Promise<void> {
    const database = await openV2Database({
      databaseName: target.databaseName,
      indexedDB,
    });
    try {
      const transaction = database.transaction(
        V2_OBJECT_STORES.workspace,
        "readwrite",
      );
      const completion = transactionComplete(transaction);
      await requestResult(
        transaction
          .objectStore(V2_OBJECT_STORES.workspace)
          .add(structuredClone(workspace), "current"),
      );
      await completion;
    } finally {
      database.close();
    }
  }

  it("rejects raw sync-origin authority before repository or domain mutation", async () => {
    const workspaceId = "workspace-raw-sync";
    const repo = repository("raw");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatch(capture("raw"), {
        ...humanContext("raw", 0),
        origin: "sync",
        source: {
          sourceId: "forged-sync-source",
          verified: true,
          capabilities: ["replay_receipt"],
        },
      }),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("rejects raw conflict-open commands before persistence", async () => {
    const workspaceId = "workspace-raw-conflict-open";
    const repo = repository("raw-conflict-open");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatch(
        {
          type: "open_sync_conflict",
          conflict: {
            id: "conflict-raw",
            recordType: "review",
            recordId: "review-local",
            commonAncestorHash: "ancestor-raw",
            remoteValue: { id: "review-remote" },
          },
        },
        {
          commandId: "open-conflict-raw",
          expectedRevision: initial.revision,
          actorId: "sync-conflict-detector",
          actorKind: "system",
          origin: "agent",
          source: {
            sourceId: "sync-merge:ancestor-raw",
            verified: true,
            capabilities: ["open_conflict"],
          },
          now: NOW,
        },
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZED_CONFLICT_OPEN_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
    expect(await repo.listReceipts()).toEqual([]);
  });

  it("rejects structural lookalikes that were not created by protocol verification", async () => {
    const workspaceId = "workspace-fake-replay";
    const repo = repository("fake");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const service = new CommandService(repo, workspaceId);

    await expect(
      service.dispatchVerifiedReplay({
        operationHash: "a".repeat(64),
        path: "v2/workspaces/workspace-fake-replay/operations/device/1-fake.json.enc",
        workspaceId,
        deviceId: "device",
        sequence: 1,
        command: capture("fake"),
        receipt: {},
      } as unknown as AuthorizedSyncReplay),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
  });

  it("re-authorizes a history-proven receipt at the local revision and logs the merge causally", async () => {
    const workspaceId = "workspace-verified-replay";
    const repo = repository("verified");
    await repo.initialize(buildWorkspaceV2(workspaceId));
    const service = new CommandService(repo, workspaceId);
    const local = await service.dispatch(
      capture("local"),
      humanContext("local", 0, {
        actorId: "human-local",
        source: {
          sourceId: "local-human-session",
          verified: true,
          capabilities: ["human_decision"],
        },
      }),
    );
    if (!local.ok) throw new Error(`Expected local fixture: ${local.rejection.code}`);
    const replay = await authorizedReplay(workspaceId, "remote");

    const result = await service.dispatchVerifiedReplay(replay);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`Expected replay: ${result.rejection.code}`);
    expect(result.workspace.revision).toBe(2);
    expect(result.receipt).toMatchObject({
      commandId: "remote",
      baseRevision: 1,
      revision: 2,
      actorId: "human-remote",
      actorKind: "human",
      origin: "sync",
      status: "applied",
      source: {
        verified: true,
        capabilities: expect.arrayContaining(["human_decision", "replay_receipt"]),
      },
    });
    expect(result.receipt.source.sourceId).toContain(replay.operationHash);
    expect(await repo.listPendingOutbox()).toEqual([
      expect.objectContaining({ commandId: "local", status: "pending" }),
      expect.objectContaining({
        commandId: "remote",
        baseRevision: 1,
        revision: 2,
        status: "pending",
      }),
    ]);
    expect((await repo.load())?.inboxItems.map(({ id }) => id).sort()).toEqual([
      "inbox-local",
      "inbox-remote",
    ]);
  });

  it("replays an Agent submit plus human acceptance pair after an unrelated local revision", async () => {
    const workspaceId = "workspace-proposal-replay";
    const brief = buildDirectionBrief({
      id: "brief-proposal-replay",
      projectId: "project-proposal-replay",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const initial = buildWorkspaceV2(workspaceId, {
      projects: [
        buildProjectV2({
          id: "project-proposal-replay",
          stage: "direction",
          activeDirectionBriefId: brief.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [brief],
    });
    const submitCommand = {
      type: "submit_command_proposal",
      proposalId: "proposal-replayed-direction",
      command: {
        type: "update_direction",
        projectId: "project-proposal-replay",
        brief: {
          id: brief.id,
          projectId: brief.projectId,
          audienceAndProblem: "Operators need one binding replayed Direction.",
          successEvidence: "The verified replay reaches awaiting Bet.",
          appetiteSeconds: 3_600,
          validationMethod: "Inspect the replayed lifecycle.",
          firstScope: [
            { id: "scope-replayed", title: "Replay", description: "Bounded" },
          ],
          noGoOrKill: "Stop if authority cannot be proven.",
          advancedNotes: "",
        },
      },
      rationale: "The Agent found the smallest bounded Direction.",
    } as const satisfies V2Command;
    const remoteSubmit = await executeCommand(
      initial,
      submitCommand,
      humanContext("submit-replayed-direction", 0, {
        actorId: "agent-remote",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "remote-agent-source",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!remoteSubmit.ok) throw new Error("Expected remote proposal submission");
    const acceptCommand = {
      type: "accept_command_proposal",
      proposalId: submitCommand.proposalId,
    } as const satisfies V2Command;
    const remoteAccept = await executeCommand(
      remoteSubmit.workspace,
      acceptCommand,
      humanContext("accept-replayed-direction", 1),
    );
    if (!remoteAccept.ok) throw new Error("Expected remote proposal acceptance");
    const first = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-remote",
      sequence: 1,
      operationId: "operation-submit-replayed-direction",
      command: submitCommand,
      receipt: remoteSubmit.receipt,
      passphrase: PASSPHRASE,
    });
    const second = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-remote",
      sequence: 2,
      operationId: "operation-accept-replayed-direction",
      command: acceptCommand,
      receipt: remoteAccept.receipt,
      previousOperationHash: first.operationHash,
      passphrase: PASSPHRASE,
    });
    const verifiedFirst = await decryptAndVerifySyncOperationV2({
      envelope: first.envelope,
      path: first.path,
      passphrase: PASSPHRASE,
      expectedPreviousOperationHash: null,
    });
    const verifiedSecond = await decryptAndVerifySyncOperationV2({
      envelope: second.envelope,
      path: second.path,
      passphrase: PASSPHRASE,
      expectedPreviousOperationHash: first.operationHash,
    });
    const history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId,
        heads: {
          [verifiedSecond.deviceId]: {
            sequence: verifiedSecond.sequence,
            operationHash: verifiedSecond.operationHash,
            revision: verifiedSecond.receipt.revision,
            updatedAt: verifiedSecond.receipt.createdAt,
          },
        },
        updatedAt: NOW,
      }),
      [verifiedFirst, verifiedSecond],
    );
    const branch = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: initial,
      headOperationHash: verifiedSecond.operationHash,
    });

    const repo = repository("proposal-pair");
    await seed(repo, initial);
    const service = new CommandService(repo, workspaceId);
    const local = await service.dispatch(
      capture("local-before-proposal"),
      humanContext("local-before-proposal", 0),
    );
    if (!local.ok) throw new Error("Expected unrelated local revision");
    const replayedSubmit = await service.dispatchVerifiedReplay(
      branch.replays[0],
    );
    if (!replayedSubmit.ok) throw new Error("Expected replayed submission");
    expect(
      isAuthorizedProposalAcceptanceFor(
        branch.replays[1],
        replayedSubmit.workspace,
      ),
    ).toBe(true);
    const replayedAccept = await service.dispatchVerifiedReplay(
      branch.replays[1],
    );
    if (!replayedAccept.ok) throw new Error("Expected replayed acceptance");

    expect(replayedAccept.workspace.revision).toBe(3);
    expect(replayedAccept.receipt.commandType).toBe(
      "accept_command_proposal",
    );
    expect(replayedAccept.workspace.commandProposals[0].status).toBe(
      "accepted",
    );
    expect(replayedAccept.workspace.projects[0].stage).toBe("awaiting_bet");
  });

  it("rejects dispatching only proposal A acceptance when the local same-id proposal is B", async () => {
    const workspaceId = "workspace-proposal-dispatch-binding";
    const brief = buildDirectionBrief({
      id: "brief-proposal-dispatch-binding",
      projectId: "project-proposal-dispatch-binding",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const initial = buildWorkspaceV2(workspaceId, {
      projects: [
        buildProjectV2({
          id: brief.projectId,
          stage: "direction",
          activeDirectionBriefId: brief.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [brief],
    });
    const directionCommand = (successEvidence: string) => ({
      type: "update_direction" as const,
      projectId: brief.projectId,
      brief: {
        id: brief.id,
        projectId: brief.projectId,
        audienceAndProblem: "Operators need one authority-bound proposal.",
        successEvidence,
        appetiteSeconds: 3_600,
        validationMethod: "Inspect the accepted Direction.",
        firstScope: [
          {
            id: "scope-proposal-dispatch-binding",
            title: "Bind acceptance",
            description: "Apply only the proposal the human reviewed.",
          },
        ],
        noGoOrKill: "Stop if proposal identity cannot be proven.",
        advancedNotes: "",
      },
    });
    const proposalA = {
      type: "submit_command_proposal" as const,
      proposalId: "proposal-dispatch-shared-id",
      command: directionCommand("Proposal A is the reviewed payload."),
      rationale: "The human should review proposal A.",
    } satisfies V2Command;
    const submittedA = await executeCommand(
      initial,
      proposalA,
      humanContext("submit-proposal-dispatch-a", 0, {
        actorId: "agent-proposal-dispatch-a",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-proposal-dispatch-source-a",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!submittedA.ok) throw new Error("Expected proposal A submission");
    const acceptA = {
      type: "accept_command_proposal" as const,
      proposalId: proposalA.proposalId,
    } satisfies V2Command;
    const acceptedA = await executeCommand(
      submittedA.workspace,
      acceptA,
      humanContext("accept-proposal-dispatch-a", 1),
    );
    if (!acceptedA.ok) throw new Error("Expected proposal A acceptance");
    const submitAOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-dispatch-a",
      sequence: 1,
      operationId: "operation-submit-proposal-dispatch-a",
      command: proposalA,
      receipt: submittedA.receipt,
      passphrase: PASSPHRASE,
    });
    const acceptAOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-dispatch-a",
      sequence: 2,
      operationId: "operation-accept-proposal-dispatch-a",
      command: acceptA,
      receipt: acceptedA.receipt,
      previousOperationHash: submitAOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const verifiedSubmitA = await decryptAndVerifySyncOperationV2({
      envelope: submitAOperation.envelope,
      path: submitAOperation.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: workspaceId,
      expectedOperationHash: submitAOperation.operationHash,
      expectedPreviousOperationHash: null,
    });
    const verifiedAcceptA = await decryptAndVerifySyncOperationV2({
      envelope: acceptAOperation.envelope,
      path: acceptAOperation.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: workspaceId,
      expectedOperationHash: acceptAOperation.operationHash,
      expectedPreviousOperationHash: submitAOperation.operationHash,
    });
    const history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId,
        heads: {
          [verifiedAcceptA.deviceId]: {
            sequence: verifiedAcceptA.sequence,
            operationHash: verifiedAcceptA.operationHash,
            revision: verifiedAcceptA.receipt.revision,
            updatedAt: verifiedAcceptA.receipt.createdAt,
          },
        },
        updatedAt: acceptedA.receipt.createdAt,
      }),
      [verifiedSubmitA, verifiedAcceptA],
    );
    const authorizedA = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: initial,
      headOperationHash: verifiedAcceptA.operationHash,
    });

    const unrelatedLocal = await executeCommand(
      initial,
      capture("before-byte-identical-proposal-a"),
      humanContext("before-byte-identical-proposal-a", 0),
    );
    if (!unrelatedLocal.ok) throw new Error("Expected unrelated local command");
    const independentlySubmittedA = await executeCommand(
      unrelatedLocal.workspace,
      proposalA,
      humanContext("submit-proposal-dispatch-a", 1, {
        actorId: "agent-proposal-dispatch-a",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-proposal-dispatch-source-a",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!independentlySubmittedA.ok) {
      throw new Error("Expected byte-identical independent proposal A submission");
    }
    expect(
      isAuthorizedProposalAcceptanceFor(
        authorizedA.replays[1],
        independentlySubmittedA.workspace,
      ),
    ).toBe(false);

    const proposalB = {
      ...proposalA,
      command: directionCommand("Proposal B was never accepted by the human."),
      rationale: "A different Agent independently submitted proposal B.",
    } satisfies V2Command;
    const repo = repository("proposal-dispatch-binding");
    await seed(repo, initial);
    const service = new CommandService(repo, workspaceId);
    const submittedB = await service.dispatch(
      proposalB,
      humanContext("submit-proposal-dispatch-b", 0, {
        actorId: "agent-proposal-dispatch-b",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-proposal-dispatch-source-b",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!submittedB.ok) throw new Error("Expected local proposal B submission");
    expect(
      isAuthorizedProposalAcceptanceFor(
        authorizedA.replays[1],
        submittedA.workspace,
      ),
    ).toBe(true);
    expect(
      isAuthorizedProposalAcceptanceFor(
        authorizedA.replays[1],
        submittedB.workspace,
      ),
    ).toBe(false);

    await expect(
      service.dispatchVerifiedReplay(authorizedA.replays[1]),
    ).rejects.toMatchObject({ code: "SYNC_PROPOSAL_MISMATCH" });
    const persisted = await repo.load();
    expect(persisted?.revision).toBe(1);
    expect(persisted?.commandProposals).toEqual([
      expect.objectContaining({
        id: proposalB.proposalId,
        payload: proposalB.command,
        rationale: proposalB.rationale,
        status: "open",
      }),
    ]);
    expect(
      persisted?.directionBriefs.find(({ id }) => id === brief.id)
        ?.successEvidence,
    ).toBe(brief.successEvidence);
  });

  it("rejects a replayed human acceptance rebound to a different same-id Agent proposal", async () => {
    const workspaceId = "workspace-proposal-acceptance-rebinding";
    const brief = buildDirectionBrief({
      id: "brief-proposal-acceptance-rebinding",
      projectId: "project-proposal-acceptance-rebinding",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const initial = buildWorkspaceV2(workspaceId, {
      projects: [
        buildProjectV2({
          id: "project-proposal-acceptance-rebinding",
          stage: "direction",
          activeDirectionBriefId: brief.id,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      directionBriefs: [brief],
    });
    const directionCommand = (successEvidence: string) => ({
      type: "update_direction" as const,
      projectId: brief.projectId,
      brief: {
        id: brief.id,
        projectId: brief.projectId,
        audienceAndProblem: "Operators need one bounded accepted Direction.",
        successEvidence,
        appetiteSeconds: 3_600,
        validationMethod: "Inspect the accepted lifecycle.",
        firstScope: [
          {
            id: "scope-acceptance-rebinding",
            title: "Bind authority",
            description: "Only the command the human actually accepted.",
          },
        ],
        noGoOrKill: "Stop if proposal authority can be rebound.",
        advancedNotes: "",
      },
    });
    const authoritySubmitCommand = {
      type: "submit_command_proposal" as const,
      proposalId: "proposal-shared-id",
      command: directionCommand("Proposal A is the only accepted payload."),
      rationale: "Submit proposal A for explicit human review.",
    } satisfies V2Command;
    const authoritySubmit = await executeCommand(
      initial,
      authoritySubmitCommand,
      humanContext("submit-proposal-authority-a", 0, {
        actorId: "agent-authority-a",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-authority-source-a",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!authoritySubmit.ok) throw new Error("Expected proposal A submission");
    const acceptCommand = {
      type: "accept_command_proposal" as const,
      proposalId: authoritySubmitCommand.proposalId,
    } satisfies V2Command;
    const authorityAccept = await executeCommand(
      authoritySubmit.workspace,
      acceptCommand,
      humanContext("accept-proposal-authority-a", 1),
    );
    if (!authorityAccept.ok) throw new Error("Expected proposal A acceptance");

    const authoritySubmitOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-authority",
      sequence: 1,
      operationId: "operation-submit-proposal-authority-a",
      command: authoritySubmitCommand,
      receipt: authoritySubmit.receipt,
      passphrase: PASSPHRASE,
    });
    const authorityAcceptOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-authority",
      sequence: 2,
      operationId: "operation-accept-proposal-authority-a",
      command: acceptCommand,
      receipt: authorityAccept.receipt,
      previousOperationHash: authoritySubmitOperation.operationHash,
      passphrase: PASSPHRASE,
    });

    const reboundSubmitCommand = {
      type: "submit_command_proposal" as const,
      proposalId: authoritySubmitCommand.proposalId,
      command: directionCommand("Proposal B was never accepted by the human."),
      rationale: "Submit a different proposal B under the same identifier.",
    } satisfies V2Command;
    const reboundSubmit = await executeCommand(
      initial,
      reboundSubmitCommand,
      humanContext("submit-proposal-rebound-b", 0, {
        actorId: "agent-authority-b",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "agent-authority-source-b",
          verified: true,
          capabilities: ["submit_proposal"],
        },
      }),
    );
    if (!reboundSubmit.ok) throw new Error("Expected proposal B submission");
    const reboundAccept = await executeCommand(
      reboundSubmit.workspace,
      acceptCommand,
      humanContext(authorityAccept.receipt.commandId, 1, {
        actorId: authorityAccept.receipt.actorId,
        actorKind: authorityAccept.receipt.actorKind,
        origin: "sync",
        source: {
          sourceId: `sync-replay:${authorityAcceptOperation.operationHash}:${authorityAccept.receipt.source.sourceId}`,
          verified: true,
          capabilities: ["human_decision", "replay_receipt"],
        },
        now: authorityAccept.receipt.createdAt,
      }),
    );
    if (!reboundAccept.ok) {
      throw new Error("Expected the forged replay fixture to reach protocol authorization");
    }
    expect(
      reboundAccept.workspace.directionBriefs.find(({ id }) => id === brief.id)
        ?.successEvidence,
    ).toBe("Proposal B was never accepted by the human.");

    const reboundSubmitOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-rebound",
      sequence: 1,
      operationId: "operation-submit-proposal-rebound-b",
      command: reboundSubmitCommand,
      receipt: reboundSubmit.receipt,
      passphrase: PASSPHRASE,
    });
    const reboundAcceptOperation = await createSyncOperationV2({
      workspaceId,
      deviceId: "device-proposal-rebound",
      sequence: 2,
      operationId: "operation-accept-proposal-rebound-b",
      command: acceptCommand,
      receipt: reboundAccept.receipt,
      previousOperationHash: reboundSubmitOperation.operationHash,
      passphrase: PASSPHRASE,
    });
    const verifyOperation = (created: Awaited<ReturnType<typeof createSyncOperationV2>>) =>
      decryptAndVerifySyncOperationV2({
        envelope: created.envelope,
        path: created.path,
        passphrase: PASSPHRASE,
        expectedWorkspaceId: workspaceId,
        expectedOperationHash: created.operationHash,
      });
    const [
      verifiedAuthoritySubmit,
      verifiedAuthorityAccept,
      verifiedReboundSubmit,
      verifiedReboundAccept,
    ] = await Promise.all([
      authoritySubmitOperation,
      authorityAcceptOperation,
      reboundSubmitOperation,
      reboundAcceptOperation,
    ].map(verifyOperation));
    const manifestHead = (operation: VerifiedSyncReplay) => ({
      sequence: operation.sequence,
      operationHash: operation.operationHash,
      revision: operation.receipt.revision,
      updatedAt: operation.receipt.createdAt,
    });
    const history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId,
        heads: {
          [verifiedAuthorityAccept.deviceId]: manifestHead(
            verifiedAuthorityAccept,
          ),
          [verifiedReboundAccept.deviceId]: manifestHead(verifiedReboundAccept),
        },
        updatedAt: authorityAccept.receipt.createdAt,
      }),
      [
        verifiedAuthoritySubmit,
        verifiedAuthorityAccept,
        verifiedReboundSubmit,
        verifiedReboundAccept,
      ],
    );

    await expect(
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: initial,
        headOperationHash: verifiedReboundAccept.operationHash,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  it("rejects a verified operation for another Workspace without persisting anything", async () => {
    const repo = repository("workspace-mismatch");
    const initial = buildWorkspaceV2("workspace-local-only");
    await repo.initialize(initial);
    const replay = await authorizedReplay(
      "workspace-remote-only",
      "remote-other",
    );

    await expect(
      new CommandService(repo, initial.workspaceId).dispatchVerifiedReplay(replay),
    ).rejects.toMatchObject({ code: "SYNC_WORKSPACE_MISMATCH" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });

  it("does not grant authority to a decrypted operation before verified-history domain replay", async () => {
    const workspaceId = "workspace-unproven-operation";
    const repo = repository("unproven");
    const initial = buildWorkspaceV2(workspaceId);
    await repo.initialize(initial);
    const operation = await verifiedOperation(workspaceId, "unproven");

    await expect(
      new CommandService(repo, workspaceId).dispatchVerifiedReplay(
        operation as unknown as AuthorizedSyncReplay,
      ),
    ).rejects.toMatchObject({ code: "VERIFIED_SYNC_REPLAY_REQUIRED" });
    expect(await repo.load()).toEqual(initial);
    expect(await repo.listPendingOutbox()).toEqual([]);
  });
});
