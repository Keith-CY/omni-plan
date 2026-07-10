import { createCommandRejection, type CommandRejection } from "./errors";
import type { CommandContext, V2Command } from "./commands";
import type { WorkspaceV2 } from "./types";

function assertNever(value: never): never {
  throw new Error(`Unexpected command: ${JSON.stringify(value)}`);
}

function notImplemented(
  workspace: WorkspaceV2,
  context: CommandContext,
): CommandRejection {
  return createCommandRejection("COMMAND_NOT_IMPLEMENTED", {
    actorKind: context.actorKind,
    origin: context.origin,
    workspaceRevision: workspace.revision,
  });
}

export async function applyCommandHandler(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandRejection | undefined> {
  switch (command.type) {
    case "configure_capacity":
      workspace.capacityProfile = structuredClone(command.profile);
      return undefined;

    case "capture_inbox": {
      if (workspace.inboxItems.some(({ id }) => id === command.id)) {
        return createCommandRejection(
          "DUPLICATE_COMMAND",
          {
            actorKind: context.actorKind,
            origin: context.origin,
            workspaceRevision: workspace.revision,
          },
          {
            reason: `InboxItem ${command.id} already exists.`,
            gate: `entity_id:InboxItem:${command.id}`,
            permittedNextCommand: "capture_inbox",
          },
        );
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
      workspace.inboxItems.push(inboxItem);
      return undefined;
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
