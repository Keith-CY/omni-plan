import type { ActorKind, CommandOrigin, ProjectHold } from "./types";

export type RejectionCode =
  | "REVISION_CONFLICT"
  | "DUPLICATE_COMMAND"
  | "INVALID_COMMAND"
  | "SOURCE_NOT_AUTHORIZED"
  | "ACTOR_NOT_AUTHORIZED"
  | "HUMAN_CONFIRMATION_REQUIRED"
  | "ILLEGAL_LIFECYCLE_TRANSITION"
  | "HOLD_BLOCKS_COMMAND"
  | "BRIEF_INCOMPLETE"
  | "BET_REQUIRED"
  | "BET_EXPIRED"
  | "SCOPE_OUTSIDE_BET"
  | "ACTION_INELIGIBLE"
  | "ACTION_PROMOTION_REQUIRED"
  | "CAPACITY_EXCEEDED"
  | "EVIDENCE_REQUIRED"
  | "EXCEPTION_EXPIRED"
  | "REVIEW_OVERDUE"
  | "SYNC_CONFLICT"
  | "PROJECT_CLOSED"
  | "ENTITY_NOT_FOUND"
  | "ENTITY_ALREADY_EXISTS"
  | "COMMAND_NOT_IMPLEMENTED";

export interface CommandRejection {
  code: RejectionCode;
  reason: string;
  gate?: string;
  hold?: ProjectHold;
  permittedNextCommand: string;
  actorKind: ActorKind;
  origin: CommandOrigin;
  workspaceRevision: number;
}

export interface RejectionDetails {
  reason: string;
  permittedNextCommand: string;
}

export const REJECTION_DETAILS = {
  REVISION_CONFLICT: {
    reason: "The workspace revision changed before this command could apply.",
    permittedNextCommand: "retry_at_current_revision",
  },
  DUPLICATE_COMMAND: {
    reason: "This command was already received.",
    permittedNextCommand: "read_existing_command_receipt",
  },
  INVALID_COMMAND: {
    reason: "The command payload is invalid.",
    permittedNextCommand: "repair_command_payload",
  },
  SOURCE_NOT_AUTHORIZED: {
    reason: "The command source is not authorized for this operation.",
    permittedNextCommand: "retry_with_authorized_source",
  },
  ACTOR_NOT_AUTHORIZED: {
    reason: "The actor is not authorized for this command.",
    permittedNextCommand: "retry_with_authorized_actor",
  },
  HUMAN_CONFIRMATION_REQUIRED: {
    reason: "This command requires an explicit human decision.",
    permittedNextCommand: "request_human_confirmation",
  },
  ILLEGAL_LIFECYCLE_TRANSITION: {
    reason: "The requested lifecycle transition is not legal from this stage.",
    permittedNextCommand: "use_legal_lifecycle_command",
  },
  HOLD_BLOCKS_COMMAND: {
    reason: "A project hold blocks this command.",
    permittedNextCommand: "resolve_project_hold",
  },
  BRIEF_INCOMPLETE: {
    reason: "The Direction Brief is incomplete.",
    permittedNextCommand: "update_direction",
  },
  BET_REQUIRED: {
    reason: "A current Bet is required before project execution can continue.",
    permittedNextCommand: "place_bet",
  },
  BET_EXPIRED: {
    reason: "The current Bet reached its appetite boundary.",
    permittedNextCommand: "record_bet_boundary",
  },
  SCOPE_OUTSIDE_BET: {
    reason: "The active Plan contains work outside its committed Bet scope.",
    permittedNextCommand: "update_work_item",
  },
  ACTION_INELIGIBLE: {
    reason: "The Inbox item is not eligible to remain a standalone Action.",
    permittedNextCommand: "confirm_project_triage",
  },
  ACTION_PROMOTION_REQUIRED: {
    reason: "The Action must be promoted to a Project before it can continue.",
    permittedNextCommand: "confirm_project_triage",
  },
  CAPACITY_EXCEEDED: {
    reason: "The Daily Commitment exceeds its captured capacity budget.",
    permittedNextCommand: "commit_today",
  },
  EVIDENCE_REQUIRED: {
    reason: "Required completion evidence has not been supplied.",
    permittedNextCommand: "attach_evidence",
  },
  EXCEPTION_EXPIRED: {
    reason: "An unresolved evidence exception has expired.",
    permittedNextCommand: "approve_evidence_exception",
  },
  REVIEW_OVERDUE: {
    reason: "A required Review is overdue.",
    permittedNextCommand: "complete_review",
  },
  SYNC_CONFLICT: {
    reason: "A sync conflict must be resolved before the affected record changes.",
    permittedNextCommand: "resolve_sync_conflict",
  },
  PROJECT_CLOSED: {
    reason: "Closed projects and their linked records are immutable.",
    permittedNextCommand: "create_follow_up_project",
  },
  ENTITY_NOT_FOUND: {
    reason: "A referenced workspace entity does not exist.",
    permittedNextCommand: "repair_workspace_reference",
  },
  ENTITY_ALREADY_EXISTS: {
    reason: "A workspace entity already uses this ID.",
    permittedNextCommand: "use_unique_entity_id",
  },
  COMMAND_NOT_IMPLEMENTED: {
    reason: "This command is not implemented by OmniPlan V2.",
    permittedNextCommand: "use_supported_command",
  },
} as const satisfies Record<RejectionCode, RejectionDetails>;

export interface RejectionContext {
  actorKind: ActorKind;
  origin: CommandOrigin;
  workspaceRevision: number;
}

type RejectionOverrides = Partial<
  Pick<CommandRejection, "reason" | "gate" | "hold" | "permittedNextCommand">
>;

export function createCommandRejection(
  code: RejectionCode,
  context: RejectionContext,
  overrides: RejectionOverrides = {},
): CommandRejection {
  const details = REJECTION_DETAILS[code];
  const rejection: CommandRejection = {
    code,
    reason: overrides.reason ?? details.reason,
    permittedNextCommand:
      overrides.permittedNextCommand ?? details.permittedNextCommand,
    actorKind: context.actorKind,
    origin: context.origin,
    workspaceRevision: context.workspaceRevision,
  };

  if (overrides.gate !== undefined) {
    rejection.gate = overrides.gate;
  }
  if (overrides.hold !== undefined) {
    rejection.hold = overrides.hold;
  }

  return rejection;
}
