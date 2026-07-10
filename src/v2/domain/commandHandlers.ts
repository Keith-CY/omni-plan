import { createCommandRejection, type CommandRejection } from "./errors";
import type { CommandContext, V2Command } from "./commands";
import type { CapacityProfile, WorkspaceV2 } from "./types";

export type CommandHandlerResult =
  | { ok: true; workspace: WorkspaceV2 }
  | { ok: false; rejection: CommandRejection };

function assertNever(value: never): never {
  throw new Error(`Unexpected command: ${JSON.stringify(value)}`);
}

function rejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  code: Parameters<typeof createCommandRejection>[0],
  overrides: Parameters<typeof createCommandRejection>[2] = {},
): CommandHandlerResult {
  return {
    ok: false,
    rejection: createCommandRejection(
      code,
      {
        actorKind: context.actorKind,
        origin: context.origin,
        workspaceRevision: workspace.revision,
      },
      overrides,
    ),
  };
}

function notImplemented(
  workspace: WorkspaceV2,
  context: CommandContext,
): CommandHandlerResult {
  return rejection(workspace, context, "COMMAND_NOT_IMPLEMENTED");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonblankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isWeekday(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

function isMinute(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 1_440;
}

function isCapacityProfile(value: unknown): value is CapacityProfile {
  if (
    !isRecord(value) ||
    !isNonblankString(value.timeZone) ||
    !isNonblankString(value.updatedAt) ||
    !isNonblankString(value.updatedBy) ||
    !Array.isArray(value.weeklyWindows) ||
    !Array.isArray(value.dailyBudgets) ||
    !Array.isArray(value.unavailableBlocks)
  ) {
    return false;
  }

  const windowsAreValid = value.weeklyWindows.every(
    (window) =>
      isRecord(window) &&
      isWeekday(window.weekday) &&
      isMinute(window.startMinute) &&
      isMinute(window.finishMinute),
  );
  const budgetsAreValid = value.dailyBudgets.every(
    (budget) =>
      isRecord(budget) &&
      isWeekday(budget.weekday) &&
      isFiniteNonnegativeNumber(budget.deepSeconds) &&
      isFiniteNonnegativeNumber(budget.mediumSeconds) &&
      isFiniteNonnegativeNumber(budget.shallowSeconds),
  );
  const blocksAreValid = value.unavailableBlocks.every(
    (block) =>
      isRecord(block) &&
      isNonblankString(block.id) &&
      isNonblankString(block.start) &&
      isNonblankString(block.finish),
  );

  return windowsAreValid && budgetsAreValid && blocksAreValid;
}

function invalidPayload(
  workspace: WorkspaceV2,
  context: CommandContext,
  commandType: "configure_capacity" | "capture_inbox",
): CommandHandlerResult {
  return rejection(workspace, context, "INVALID_COMMAND", {
    reason: `The ${commandType} payload is invalid.`,
    gate: `command_payload:${commandType}`,
    permittedNextCommand: commandType,
  });
}

export async function applyCommandHandler(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandHandlerResult> {
  switch (command.type) {
    case "configure_capacity": {
      if (!isCapacityProfile(command.profile)) {
        return invalidPayload(workspace, context, command.type);
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          capacityProfile: structuredClone(command.profile),
        },
      };
    }

    case "capture_inbox": {
      if (
        !isNonblankString(command.id) ||
        !isNonblankString(command.text) ||
        (command.desiredDate !== undefined &&
          !isNonblankString(command.desiredDate))
      ) {
        return invalidPayload(workspace, context, command.type);
      }
      if (workspace.inboxItems.some(({ id }) => id === command.id)) {
        return rejection(workspace, context, "ENTITY_ALREADY_EXISTS", {
          reason: `InboxItem ${command.id} already exists.`,
          gate: `entity_id:InboxItem:${command.id}`,
          permittedNextCommand: "capture_inbox",
        });
      }
      const inboxItem = {
        id: command.id,
        originalText: command.text,
        sourceId: context.source.sourceId,
        actorId: context.actorId,
        capturedAt: context.now,
        triageStatus: "untriaged" as const,
        ...(command.desiredDate === undefined
          ? {}
          : { desiredDate: command.desiredDate }),
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          inboxItems: [...workspace.inboxItems, inboxItem],
        },
      };
    }

    case "confirm_action_triage":
    case "confirm_project_triage":
    case "update_project_metadata":
    case "update_action":
    case "complete_action":
    case "promote_action_to_project":
    case "update_direction":
    case "place_bet":
    case "create_work_item":
    case "update_work_item":
    case "propose_replan":
    case "commit_today":
    case "accept_replan":
    case "record_actual":
    case "attach_evidence":
    case "approve_evidence_exception":
    case "resolve_evidence_exception":
    case "request_validation":
    case "satisfy_validation":
    case "record_bet_boundary":
    case "mark_review_overdue":
    case "create_review":
    case "complete_review":
    case "resolve_sync_conflict":
    case "close_project":
    case "abandon_project":
    case "archive_project":
      return notImplemented(workspace, context);
  }

  return assertNever(command);
}
