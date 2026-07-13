import {
  duplicateCommandResult,
  executeCommand,
  isStructurallyValidCommandContext,
  revisionConflictResult,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import type { ISODate } from "@/domain/types";
import { canonicalJson } from "../../domain/canonical";
import { stableHash } from "../domain/stableHash";
import type { CommandReceipt, JsonValue, WorkspaceV2 } from "../domain/types";
import type {
  AtomicWorkspaceRepository,
  SyncOutboxEntry,
} from "./browserWorkspaceRepository";
import {
  isAuthorizedEquivalentConflictResolutionFor,
  isAuthorizedConflictOpenFor,
  type AuthorizedEquivalentConflictResolution,
  type AuthorizedConflictOpen,
} from "./syncConflictOpenAuthorization";
import {
  isAuthorizedSemanticSyncReplay,
  isAuthorizedSyncReplay,
  type AuthorizedSemanticSyncReplay,
  type AuthorizedSyncReplay,
} from "./syncProtocol";

const RETRYABLE_SYSTEM_COMMANDS = new Set<V2Command["type"]>([
  "record_bet_boundary",
  "create_review",
  "mark_review_overdue",
]);

async function sameStableValue(left: unknown, right: unknown): Promise<boolean> {
  return (
    (await stableHash(left as JsonValue)) ===
    (await stableHash(right as JsonValue))
  );
}

async function canRetrySystemCasConflict(
  receipt: CommandReceipt,
  command: V2Command,
  context: CommandContext,
): Promise<boolean> {
  if (
    receipt.status !== "rejected" ||
    receipt.rejectionCode !== "REVISION_CONFLICT" ||
    receipt.commandId !== context.commandId ||
    receipt.commandType !== command.type ||
    receipt.actorKind !== "system" ||
    context.actorKind !== "system" ||
    !RETRYABLE_SYSTEM_COMMANDS.has(command.type) ||
    !context.source.verified ||
    !context.source.capabilities.includes("system_time") ||
    receipt.actorId !== context.actorId ||
    receipt.origin !== context.origin ||
    !(await sameStableValue(receipt.source, context.source))
  ) {
    return false;
  }
  return (
    receipt.payloadHash ===
    (await stableHash(command as unknown as JsonValue))
  );
}

export type CommandServiceBoundaryErrorCode =
  | "INVALID_COMMAND_CONTEXT"
  | "VERIFIED_SYNC_REPLAY_REQUIRED"
  | "SYNC_WORKSPACE_MISMATCH"
  | "AUTHORIZED_CONFLICT_OPEN_REQUIRED"
  | "AUTHORIZED_EQUIVALENT_RESOLUTION_REQUIRED";

export class CommandServiceBoundaryError extends Error {
  constructor(
    readonly code: CommandServiceBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommandServiceBoundaryError";
  }
}

function assertValidCommandContext(
  value: unknown,
): asserts value is CommandContext {
  if (!isStructurallyValidCommandContext(value)) {
    throw new CommandServiceBoundaryError(
      "INVALID_COMMAND_CONTEXT",
      "Command context must match the exact V2 schema.",
    );
  }
}

function snapshotCommandContext(value: unknown): CommandContext {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    throw new CommandServiceBoundaryError(
      "INVALID_COMMAND_CONTEXT",
      "Command context must be cloneable canonical V2 data.",
    );
  }
  assertValidCommandContext(snapshot);
  return snapshot;
}

export class CommandService {
  constructor(
    private readonly repository: AtomicWorkspaceRepository,
    private readonly workspaceId: string,
  ) {}

  async dispatch(
    commandInput: V2Command,
    contextInput: CommandContext,
    options: { evaluationNow?: ISODate } = {},
  ): Promise<CommandResult> {
    // Snapshot synchronously before the first await and validate only that
    // single snapshot. Accessors on an untrusted input must not show validation
    // one value and persistence another.
    const context = snapshotCommandContext(contextInput);
    const command = structuredClone(commandInput);
    if (command.type === "open_sync_conflict") {
      throw new CommandServiceBoundaryError(
        "AUTHORIZED_CONFLICT_OPEN_REQUIRED",
        "Raw conflict-open commands are forbidden; use a locally reconstructed opaque conflict authority.",
      );
    }
    if (context.origin === "sync") {
      throw new CommandServiceBoundaryError(
        "VERIFIED_SYNC_REPLAY_REQUIRED",
        "Raw sync-origin contexts are forbidden; replay an opaque verified operation.",
      );
    }

    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }
    return this.dispatchAgainstWorkspace(
      command,
      context,
      workspace,
      options.evaluationNow,
    );
  }

  async dispatchVerifiedReplay(
    replayInput: AuthorizedSyncReplay,
    options: { evaluationNow?: ISODate } = {},
  ): Promise<CommandResult> {
    if (!isAuthorizedSyncReplay(replayInput)) {
      throw new CommandServiceBoundaryError(
        "VERIFIED_SYNC_REPLAY_REQUIRED",
        "Only protocol-verified sync replay values may cross this boundary.",
      );
    }
    if (replayInput.workspaceId !== this.workspaceId) {
      throw new CommandServiceBoundaryError(
        "SYNC_WORKSPACE_MISMATCH",
        "The verified operation belongs to another Workspace.",
      );
    }
    if (replayInput.command.type === "open_sync_conflict") {
      throw new CommandServiceBoundaryError(
        "AUTHORIZED_CONFLICT_OPEN_REQUIRED",
        "A replayed conflict-open command must be re-authorized from its exact source-operation bundles.",
      );
    }
    const replay = replayInput;
    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }
    const sourceCapabilities = Array.from(
      new Set([...replay.receipt.source.capabilities, "replay_receipt" as const]),
    );
    const context: CommandContext = {
      commandId: replay.receipt.commandId,
      expectedRevision: workspace.revision,
      actorId: replay.receipt.actorId,
      actorKind: replay.receipt.actorKind,
      origin: "sync",
      source: {
        sourceId: `sync-replay:${replay.operationHash}:${replay.receipt.source.sourceId}`,
        verified: replay.receipt.source.verified,
        capabilities: sourceCapabilities,
      },
      now: replay.receipt.createdAt,
    };
    assertValidCommandContext(context);
    return this.dispatchAgainstWorkspace(
      structuredClone(replay.command) as V2Command,
      context,
      workspace,
      options.evaluationNow,
    );
  }

  async dispatchAuthorizedConflictOpen(
    authorization: AuthorizedConflictOpen,
    options: { evaluationNow?: ISODate } = {},
  ): Promise<CommandResult> {
    const context = snapshotCommandContext(
      (authorization as { context?: unknown }).context,
    );
    const command = structuredClone(authorization.command);
    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }
    if (
      !isAuthorizedConflictOpenFor(
        authorization,
        workspace,
        command,
        context,
      )
    ) {
      throw new CommandServiceBoundaryError(
        "AUTHORIZED_CONFLICT_OPEN_REQUIRED",
        "Conflict authority is not an opaque proof for the exact current Workspace.",
      );
    }
    return this.dispatchAgainstWorkspace(
      command as V2Command,
      context,
      workspace,
      options.evaluationNow,
      authorization,
    );
  }

  async dispatchAuthorizedEquivalentConflictResolution(
    authorization: AuthorizedEquivalentConflictResolution,
    options: { evaluationNow?: ISODate } = {},
  ): Promise<CommandResult> {
    const context = snapshotCommandContext(
      (authorization as { context?: unknown }).context,
    );
    const command = structuredClone(authorization.command);
    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }
    if (
      !isAuthorizedEquivalentConflictResolutionFor(
        authorization,
        workspace,
        command,
        context,
      )
    ) {
      throw new CommandServiceBoundaryError(
        "AUTHORIZED_EQUIVALENT_RESOLUTION_REQUIRED",
        "Equivalent resolution confirmation requires opaque authority for the exact current Workspace.",
      );
    }
    return this.dispatchAgainstWorkspace(
      command as V2Command,
      context,
      workspace,
      options.evaluationNow,
      undefined,
      authorization,
    );
  }

  async dispatchAuthorizedSemanticReplay(
    replayInput: AuthorizedSemanticSyncReplay,
    options: { evaluationNow?: ISODate } = {},
  ): Promise<CommandResult> {
    if (!isAuthorizedSemanticSyncReplay(replayInput)) {
      throw new CommandServiceBoundaryError(
        "VERIFIED_SYNC_REPLAY_REQUIRED",
        "Only protocol-authorized semantic sync replay may cross this boundary.",
      );
    }
    if (replayInput.workspaceId !== this.workspaceId) {
      throw new CommandServiceBoundaryError(
        "SYNC_WORKSPACE_MISMATCH",
        "The semantic replay belongs to another Workspace.",
      );
    }
    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }
    if (canonicalJson(workspace) !== replayInput.expectedWorkspaceCanonical) {
      throw new CommandServiceBoundaryError(
        "SYNC_WORKSPACE_MISMATCH",
        "The Workspace changed after semantic replay authorization.",
      );
    }
    const sourceCapabilities = Array.from(
      new Set([
        ...replayInput.receipt.source.capabilities,
        "replay_receipt" as const,
      ]),
    );
    const context: CommandContext = {
      commandId: replayInput.receipt.commandId,
      expectedRevision: workspace.revision,
      actorId: replayInput.receipt.actorId,
      actorKind: replayInput.receipt.actorKind,
      origin: "sync",
      source: {
        sourceId: `sync-semantic:${replayInput.operationHash}:${replayInput.semanticKind}:${replayInput.receipt.source.sourceId}`,
        verified: replayInput.receipt.source.verified,
        capabilities: sourceCapabilities,
      },
      now: replayInput.receipt.createdAt,
    };
    assertValidCommandContext(context);
    return this.dispatchAgainstWorkspace(
      structuredClone(replayInput.command) as V2Command,
      context,
      workspace,
      options.evaluationNow,
    );
  }

  private async dispatchAgainstWorkspace(
    command: V2Command,
    context: CommandContext,
    workspace: WorkspaceV2,
    evaluationNow?: ISODate,
    authorizedConflictOpen?: AuthorizedConflictOpen,
    authorizedEquivalentConflictResolution?: AuthorizedEquivalentConflictResolution,
  ): Promise<CommandResult> {

    assertValidCommandContext(context);

    // The pure domain contract deliberately checks revision before duplicate
    // identity. Preserve that order at the persistence boundary.
    if (context.expectedRevision !== workspace.revision) {
      const stale = await executeCommand(workspace, command, context, {
        ...(evaluationNow === undefined ? {} : { evaluationNow }),
        ...(authorizedConflictOpen === undefined
          ? {}
          : { authorizedConflictOpen }),
        ...(authorizedEquivalentConflictResolution === undefined
          ? {}
          : { authorizedEquivalentConflictResolution }),
      });
      if (stale.ok) {
        throw new Error("A stale command unexpectedly passed domain validation.");
      }
      // Revision precedence is a domain contract: even if a separate receipt
      // already owns this commandId, a stale caller must be told to refresh
      // before any identity/dedupe decision. The existing append-only receipt
      // remains authoritative and is never overwritten.
      await this.persistRejectedOnce(stale.receipt);
      return stale;
    }

    const appliedReceipt = workspace.commandReceipts.find(
      (receipt) =>
        receipt.commandId === context.commandId && receipt.status === "applied",
    );
    if (appliedReceipt !== undefined) {
      return duplicateCommandResult(
        workspace,
        command,
        context,
        appliedReceipt,
      );
    }

    const storedReceipt = await this.repository.findReceipt(context.commandId);
    if (
      storedReceipt !== undefined &&
      !(await canRetrySystemCasConflict(storedReceipt, command, context))
    ) {
      return duplicateCommandResult(
        workspace,
        command,
        context,
        storedReceipt,
      );
    }

    const result = await executeCommand(workspace, command, context, {
      ...(evaluationNow === undefined ? {} : { evaluationNow }),
      ...(authorizedConflictOpen === undefined
        ? {}
        : { authorizedConflictOpen }),
      ...(authorizedEquivalentConflictResolution === undefined
        ? {}
        : { authorizedEquivalentConflictResolution }),
    });
    if (!result.ok) {
      const collision = await this.persistRejectedOnce(result.receipt);
      return collision === undefined
        ? result
        : duplicateCommandResult(workspace, command, context, collision);
    }

    const outboxEntry: SyncOutboxEntry = {
      id: `outbox-${context.commandId}`,
      workspaceId: workspace.workspaceId,
      commandId: context.commandId,
      baseRevision: workspace.revision,
      revision: result.workspace.revision,
      command: structuredClone(command),
      actor: {
        actorId: context.actorId,
        actorKind: context.actorKind,
        origin: context.origin,
        source: structuredClone(context.source),
      },
      payloadHash: result.receipt.payloadHash,
      receiptId: result.receipt.id,
      createdAt: context.now,
      status: "pending",
    };
    const committed = await this.repository.commit({
      expectedRevision: workspace.revision,
      workspace: result.workspace,
      outboxEntry,
    });
    if (committed === "committed") return result;

    const latest = await this.repository.load();
    const appliedWinner = latest?.commandReceipts.find(
      (receipt) =>
        receipt.commandId === context.commandId && receipt.status === "applied",
    );
    if (latest !== undefined && appliedWinner !== undefined) {
      return (await sameStableValue(appliedWinner, result.receipt))
        ? {
            ok: true,
            workspace: latest,
            receipt: structuredClone(appliedWinner),
          }
        : duplicateCommandResult(latest, command, context, appliedWinner);
    }

    const conflict = await revisionConflictResult(workspace, command, context);
    const collision = await this.persistRejectedOnce(conflict.receipt);
    return collision === undefined
      ? conflict
      : duplicateCommandResult(workspace, command, context, collision);
  }

  private async persistRejectedOnce(
    receipt: CommandReceipt,
  ): Promise<CommandReceipt | undefined> {
    const observed = await this.repository.findReceipt(receipt.commandId);
    if (observed !== undefined) {
      return (await sameStableValue(observed, receipt))
        ? undefined
        : observed;
    }
    try {
      await this.repository.appendRejectedReceipt(receipt);
      const winner = await this.repository.findReceipt(receipt.commandId);
      if (winner === undefined) {
        throw new Error(
          `Receipt ${receipt.commandId} lost atomic ownership after append.`,
        );
      }
      return (await sameStableValue(winner, receipt)) ? undefined : winner;
    } catch (error) {
      // Two tabs may race to record the same deterministic rejection. Treat an
      // observed append-only winner as success, but propagate real storage
      // failures (including transaction aborts).
      const winner = await this.repository.findReceipt(receipt.commandId);
      if (winner === undefined) {
        throw error;
      }
      return (await sameStableValue(winner, receipt)) ? undefined : winner;
    }
  }
}

export type { AtomicWorkspaceRepository, SyncOutboxEntry } from "./browserWorkspaceRepository";
export type { WorkspaceV2 };
