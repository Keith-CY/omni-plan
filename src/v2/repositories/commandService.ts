import {
  duplicateCommandResult,
  executeCommand,
  revisionConflictResult,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import { stableHash } from "../domain/stableHash";
import type { CommandReceipt, JsonValue, WorkspaceV2 } from "../domain/types";
import type {
  AtomicWorkspaceRepository,
  SyncOutboxEntry,
} from "./browserWorkspaceRepository";

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

export class CommandService {
  constructor(
    private readonly repository: AtomicWorkspaceRepository,
    private readonly workspaceId: string,
  ) {}

  async dispatch(
    commandInput: V2Command,
    contextInput: CommandContext,
  ): Promise<CommandResult> {
    // Snapshot synchronously before the first await. Callers may reuse mutable
    // form objects while IndexedDB is opening; those later writes must not alter
    // the command, receipt, or outbox tuple being persisted.
    const command = structuredClone(commandInput);
    const context = structuredClone(contextInput);

    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error(
        "V2 Workspace must be initialized by BootstrapService before dispatch.",
      );
    }

    // The pure domain contract deliberately checks revision before duplicate
    // identity. Preserve that order at the persistence boundary.
    if (context.expectedRevision !== workspace.revision) {
      const stale = await executeCommand(workspace, command, context);
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

    const result = await executeCommand(workspace, command, context);
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
      return undefined;
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
