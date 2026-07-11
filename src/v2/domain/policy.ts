import type { Id } from "@/domain/types";

import { createCommandRejection, type CommandRejection } from "./errors";
import type {
  ActorKind,
  CommandOrigin,
  CommandSource,
  ProjectHold,
  ProjectHoldState,
  SourceCapability,
} from "./types";

export interface AuthorizationContext {
  actorKind: ActorKind;
  origin: CommandOrigin;
  source: CommandSource;
  workspaceRevision: number;
  projectHolds: ProjectHoldState[];
  affectedRecordIds?: Id[];
  targetWasCommitted?: boolean;
  deterministicTriggerKey?: string;
}

const humanOnly = new Set([
  "confirm_action_triage",
  "confirm_project_triage",
  "promote_action_to_project",
  "place_bet",
  "commit_today",
  "accept_replan",
  "approve_evidence_exception",
  "complete_review",
  "resolve_sync_conflict",
  "accept_command_proposal",
  "dismiss_command_proposal",
  "close_project",
  "abandon_project",
]);

const agentAutomatic = new Set([
  "capture_inbox",
  "record_actual",
  "attach_evidence",
]);

const agentProposal = new Set(["submit_command_proposal"]);

const systemOnly = new Set([
  "record_bet_boundary",
  "mark_review_overdue",
  "create_review",
  "open_sync_conflict",
]);

const projectDrafts = new Set([
  "update_direction",
  "create_work_item",
  "update_work_item",
  "propose_replan",
  "upsert_dependency",
  "remove_dependency",
  "remove_work_item",
  "capture_baseline",
  "complete_work_item",
]);

const automaticCapabilities = {
  capture_inbox: "capture_inbox",
  record_actual: "record_actual",
  attach_evidence: "attach_evidence",
} as const satisfies Record<string, SourceCapability>;

const systemCapabilities = {
  record_bet_boundary: ["system_time"],
  mark_review_overdue: ["system_time"],
  create_review: ["system_time", "open_conflict"],
  open_sync_conflict: ["open_conflict"],
} as const satisfies Record<string, readonly SourceCapability[]>;

const humanOnlyReasons = {
  confirm_action_triage: "Only a human can confirm Action triage.",
  confirm_project_triage: "Only a human can confirm Project triage.",
  promote_action_to_project: "Only a human can promote an Action to a Project.",
  place_bet: "Only a human can place or replace a Bet.",
  commit_today: "Only a human can commit today's plan.",
  accept_replan: "Only a human can accept a Replan.",
  approve_evidence_exception:
    "Only a human can approve an evidence exception.",
  complete_review: "Only a human can conclude a Review.",
  resolve_sync_conflict: "Only a human can resolve a sync conflict.",
  accept_command_proposal: "Only a human can accept a command proposal.",
  dismiss_command_proposal: "Only a human can dismiss a command proposal.",
  close_project: "Only a human can close a Project.",
  abandon_project: "Only a human can abandon a Project.",
} as const satisfies Record<string, string>;

const projectMutationCommands = new Set([
  "confirm_project_triage",
  "update_direction",
  "place_bet",
  "create_work_item",
  "update_work_item",
  "propose_replan",
  "upsert_dependency",
  "remove_dependency",
  "remove_work_item",
  "capture_baseline",
  "complete_work_item",
  "commit_today",
  "accept_replan",
  "record_actual",
  "attach_evidence",
  "record_bet_boundary",
  "mark_review_overdue",
  "create_review",
  "open_sync_conflict",
  "approve_evidence_exception",
  "complete_review",
  "resolve_sync_conflict",
  "accept_command_proposal",
  "close_project",
  "abandon_project",
  "update_project_metadata",
  "resolve_evidence_exception",
  "request_validation",
  "satisfy_validation",
  "archive_project",
]);

const rebetBlockedCommands = new Set([
  "create_work_item",
  "update_work_item",
  "upsert_dependency",
  "remove_dependency",
  "remove_work_item",
  "capture_baseline",
  "complete_work_item",
  "propose_replan",
  "commit_today",
  "accept_replan",
  "record_actual",
  "attach_evidence",
  "request_validation",
  "satisfy_validation",
]);

const overdueReviewBlockedCommands = new Set([
  "place_bet",
  "create_work_item",
  "update_work_item",
  "upsert_dependency",
  "remove_dependency",
  "remove_work_item",
  "capture_baseline",
  "commit_today",
  "accept_replan",
]);

const holdPriority: Record<ProjectHold, number> = {
  migration_review: 0,
  rebet_required: 1,
  review_overdue: 2,
  sync_conflict: 3,
};

const holdNextCommand: Record<ProjectHold, string> = {
  migration_review: "place_bet",
  rebet_required: "place_bet",
  review_overdue: "complete_review",
  sync_conflict: "resolve_sync_conflict",
};

function rejectionContext(context: AuthorizationContext) {
  return {
    actorKind: context.actorKind,
    origin: context.origin,
    workspaceRevision: context.workspaceRevision,
  };
}

function lacksCapability(
  source: CommandSource,
  capability: SourceCapability,
): boolean {
  return !source.capabilities.includes(capability);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function missingCapabilityRejection(
  capability: SourceCapability,
  context: AuthorizationContext,
): CommandRejection {
  return createCommandRejection(
    "SOURCE_NOT_AUTHORIZED",
    rejectionContext(context),
    {
      reason: `Source lacks required capability: ${capability}.`,
      gate: `source_capability:${capability}`,
      permittedNextCommand: "retry_with_authorized_source",
    },
  );
}

function authorizeSource(
  commandType: string,
  context: AuthorizationContext,
): CommandRejection | undefined {
  if (!context.source.verified) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Command source must be verified.",
        gate: "verified_source",
        permittedNextCommand: "retry_with_verified_source",
      },
    );
  }

  const nonHumanBetAttempt =
    commandType === "place_bet" && context.actorKind !== "human";
  if (context.origin === "migration" && !nonHumanBetAttempt) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason:
          "Migration-origin commands must use the validated migration pipeline.",
        gate: "validated_migration",
        permittedNextCommand: "run_validated_migration",
      },
    );
  }

  if (
    context.origin === "sync" &&
    lacksCapability(context.source, "replay_receipt")
  ) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Sync commands require a verified replay receipt.",
        gate: "source_capability:replay_receipt",
        permittedNextCommand: "replay_with_receipt",
      },
    );
  }

  if (
    context.origin === "import" &&
    lacksCapability(context.source, "import_portable")
  ) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Import commands require a verified portable import source.",
        gate: "source_capability:import_portable",
        permittedNextCommand: "import_portable_workspace",
      },
    );
  }

  if (systemOnly.has(commandType)) {
    const required = systemCapabilities[
      commandType as keyof typeof systemCapabilities
    ];
    if (!required.some((capability) => !lacksCapability(context.source, capability))) {
      const gateCapability =
        required.length === 1
          ? required[0]
          : (`${required[0]}_or_${required[1]}` as const);
      return createCommandRejection(
        "SOURCE_NOT_AUTHORIZED",
        rejectionContext(context),
        {
          reason:
            required.length === 1
              ? `Source lacks required capability: ${required[0]}.`
              : `Source requires one of these capabilities: ${required.join(
                  ", ",
                )}.`,
          gate: `source_capability:${gateCapability}`,
          permittedNextCommand: "retry_with_authorized_source",
        },
      );
    }
  }

  if (context.actorKind === "agent") {
    const automaticCapability =
      automaticCapabilities[
        commandType as keyof typeof automaticCapabilities
      ];
    if (
      automaticCapability !== undefined &&
      lacksCapability(context.source, automaticCapability)
    ) {
      return missingCapabilityRejection(automaticCapability, context);
    }

    if (
      !agentAutomatic.has(commandType) &&
      !systemOnly.has(commandType) &&
      lacksCapability(context.source, "submit_proposal")
    ) {
      return missingCapabilityRejection("submit_proposal", context);
    }
  }

  if (
    context.actorKind === "human" &&
    context.origin !== "sync" &&
    context.origin !== "import" &&
    lacksCapability(context.source, "human_decision")
  ) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Human session commands require a verified decision source.",
        gate: "source_capability:human_decision",
        permittedNextCommand: "retry_from_human_session",
      },
    );
  }

  return undefined;
}

function authorizeActor(
  commandType: string,
  context: AuthorizationContext,
): CommandRejection | undefined {
  if (systemOnly.has(commandType)) {
    if (context.actorKind === "system") {
      return undefined;
    }
    return createCommandRejection(
      "ACTOR_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: `Only the system actor can apply ${commandType}.`,
        gate: "system_actor",
        permittedNextCommand: commandType,
      },
    );
  }

  if (commandType === "place_bet" && context.actorKind === "system") {
    return createCommandRejection(
      "HUMAN_CONFIRMATION_REQUIRED",
      rejectionContext(context),
      {
        reason: humanOnlyReasons.place_bet,
        gate: undefined,
        permittedNextCommand: "place_bet",
      },
    );
  }

  if (context.actorKind === "system") {
    return createCommandRejection(
      "ACTOR_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "System actors may only execute system commands.",
        gate: "non_system_command",
        permittedNextCommand: "use_authorized_actor",
      },
    );
  }

  if (humanOnly.has(commandType)) {
    if (context.actorKind === "human" && context.origin !== "import") {
      return undefined;
    }
    return createCommandRejection(
      "HUMAN_CONFIRMATION_REQUIRED",
      rejectionContext(context),
      {
        reason:
          humanOnlyReasons[commandType as keyof typeof humanOnlyReasons],
        gate: undefined,
        permittedNextCommand: commandType,
      },
    );
  }

  if (agentAutomatic.has(commandType)) {
    return undefined;
  }

  if (projectDrafts.has(commandType)) {
    if (context.actorKind === "human") {
      return undefined;
    }
    return createCommandRejection(
      "ACTOR_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason:
          "Agents must submit a command proposal instead of mutating project plans directly.",
        gate: "agent_proposal_required",
        permittedNextCommand: "submit_command_proposal",
      },
    );
  }

  if (agentProposal.has(commandType)) {
    if (context.actorKind === "agent") {
      return undefined;
    }
    return createCommandRejection(
      "ACTOR_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Only an Agent can submit a command proposal.",
        gate: "agent_actor",
        permittedNextCommand: "submit_command_proposal",
      },
    );
  }

  if (context.actorKind === "human") {
    return undefined;
  }

  return createCommandRejection(
    "ACTOR_NOT_AUTHORIZED",
    rejectionContext(context),
    {
      reason:
        "Agents must submit a command proposal instead of mutating workspace state directly.",
      gate: "agent_proposal_required",
      permittedNextCommand: "submit_command_proposal",
    },
  );
}

function isBlockingHold(
  commandType: string,
  hold: ProjectHoldState,
  affectedRecordIds?: Id[],
  targetWasCommitted?: boolean,
): boolean {
  switch (hold.type) {
    case "migration_review":
      return (
        projectMutationCommands.has(commandType) &&
        commandType !== "update_direction" &&
        commandType !== "place_bet"
      );
    case "rebet_required":
      return rebetBlockedCommands.has(commandType);
    case "review_overdue":
      if (
        commandType === "record_actual" ||
        commandType === "attach_evidence" ||
        commandType === "complete_work_item"
      ) {
        return targetWasCommitted !== true;
      }
      return overdueReviewBlockedCommands.has(commandType);
    case "sync_conflict":
      if (commandType === "resolve_sync_conflict") {
        return false;
      }
      if (affectedRecordIds === undefined || affectedRecordIds.length === 0) {
        return true;
      }
      return affectedRecordIds.some((recordId) =>
        hold.affectedRecordIds.includes(recordId),
      );
  }
}

export function findBlockingHold(
  commandType: string,
  holds: ProjectHoldState[],
  affectedRecordIds?: Id[],
  targetWasCommitted?: boolean,
): ProjectHoldState | undefined {
  return [...holds]
    .sort(
      (left, right) =>
        holdPriority[left.type] - holdPriority[right.type] ||
        compareText(left.sourceId, right.sourceId) ||
        compareText(left.createdAt, right.createdAt) ||
        compareText(
          JSON.stringify([...left.affectedRecordIds].sort(compareText)),
          JSON.stringify([...right.affectedRecordIds].sort(compareText)),
        ),
    )
    .find((hold) =>
      isBlockingHold(
        commandType,
        hold,
        affectedRecordIds,
        targetWasCommitted,
      ),
    );
}

export function authorizeCommandIdentity(
  commandType: string,
  context: AuthorizationContext,
): CommandRejection | undefined {
  const sourceRejection = authorizeSource(commandType, context);
  if (sourceRejection !== undefined) {
    return sourceRejection;
  }

  return authorizeActor(commandType, context);
}

export function authorizeCommand(
  commandType: string,
  context: AuthorizationContext,
): CommandRejection | undefined {
  const identityRejection = authorizeCommandIdentity(commandType, context);
  if (identityRejection !== undefined) {
    return identityRejection;
  }

  if (context.projectHolds === undefined) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "Authorization context must include project hold facts.",
        gate: "policy_context:project_holds",
        permittedNextCommand: "load_project_holds",
      },
    );
  }

  if (
    systemOnly.has(commandType) &&
    (context.deterministicTriggerKey === undefined ||
      context.deterministicTriggerKey.trim().length === 0)
  ) {
    return createCommandRejection(
      "SOURCE_NOT_AUTHORIZED",
      rejectionContext(context),
      {
        reason: "System commands require a deterministic trigger key.",
        gate: "deterministic_trigger_key",
        permittedNextCommand: commandType,
      },
    );
  }

  const blockingHold = findBlockingHold(
    commandType,
    context.projectHolds,
    context.affectedRecordIds,
    context.targetWasCommitted,
  );
  if (blockingHold === undefined) {
    return undefined;
  }

  return createCommandRejection(
    "HOLD_BLOCKS_COMMAND",
    rejectionContext(context),
    {
      reason: `Project hold ${blockingHold.type} blocks command ${commandType}.`,
      gate: `project_hold:${blockingHold.type}`,
      hold: blockingHold.type,
      permittedNextCommand: holdNextCommand[blockingHold.type],
    },
  );
}
