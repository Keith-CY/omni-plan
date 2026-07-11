import { createCommandRejection, type CommandRejection } from "./errors";
import type { CommandContext, V2Command } from "./commands";
import { evaluateActionEligibility } from "./actionPolicy";
import {
  buildBetVersion,
  isDirectionComplete,
  isMaterialDirectionChange,
} from "./direction";
import { transitionLifecycle } from "./lifecycle";
import {
  resolvePlanningContext,
  type PlanningContextRejection,
} from "./planning";
import type {
  Action,
  DirectionBrief,
  InboxItem,
  ProjectV2,
  WorkspaceV2,
} from "./types";

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

function entityNotFound(
  workspace: WorkspaceV2,
  context: CommandContext,
  entity: string,
  id: string,
  permittedNextCommand: string,
): CommandHandlerResult {
  return rejection(workspace, context, "ENTITY_NOT_FOUND", {
    reason: `${entity} ${id} does not exist.`,
    gate: `entity:${entity}:${id}`,
    permittedNextCommand,
  });
}

function entityAlreadyExists(
  workspace: WorkspaceV2,
  context: CommandContext,
  entity: string,
  id: string,
  permittedNextCommand: string,
): CommandHandlerResult {
  return rejection(workspace, context, "ENTITY_ALREADY_EXISTS", {
    reason: `${entity} ${id} already exists.`,
    gate: `entity_id:${entity}:${id}`,
    permittedNextCommand,
  });
}

function directionBriefId(projectId: string): string {
  return `${projectId}:direction-brief:1`;
}

function buildDirectionProject(
  draft: Extract<
    V2Command,
    { type: "confirm_project_triage" | "promote_action_to_project" }
  >["project"],
  now: string,
): { project: ProjectV2; brief: DirectionBrief } {
  const briefId = directionBriefId(draft.id);
  return {
    project: {
      id: draft.id,
      name: draft.name,
      priority: draft.priority,
      notes: draft.notes,
      stage: "direction",
      holds: [],
      activeDirectionBriefId: briefId,
      createdAt: now,
      updatedAt: now,
    },
    brief: {
      id: briefId,
      projectId: draft.id,
      version: 1,
      audienceAndProblem: "",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [],
      noGoOrKill: "",
      advancedNotes: "",
      createdAt: now,
      updatedAt: now,
    },
  };
}

function projectArtifactsCollision(
  workspace: WorkspaceV2,
  projectId: string,
): { entity: string; id: string } | undefined {
  if (workspace.projects.some(({ id }) => id === projectId)) {
    return { entity: "ProjectV2", id: projectId };
  }
  if (workspace.actions.some(({ id }) => id === projectId)) {
    return { entity: "Action", id: projectId };
  }
  const briefId = directionBriefId(projectId);
  if (workspace.directionBriefs.some(({ id }) => id === briefId)) {
    return { entity: "DirectionBrief", id: briefId };
  }
  return undefined;
}

function entityIdCollision(
  workspace: WorkspaceV2,
  id: string,
  reservedIds: readonly { entity: string; id: string }[] = [],
): string | undefined {
  const reservation = reservedIds.find((reserved) => reserved.id === id);
  if (reservation !== undefined) return reservation.entity;
  if (workspace.workspaceId === id) return "WorkspaceV2";
  if (workspace.migration?.backupId === id) return "MigrationBackup";
  const collections: readonly [string, readonly { id: string }[]][] = [
    ["InboxItem", workspace.inboxItems],
    ["Action", workspace.actions],
    ["ProjectV2", workspace.projects],
    ["DirectionBrief", workspace.directionBriefs],
    ["BetVersion", workspace.bets],
    ["PlanVersion", workspace.planVersions],
    ["DailyCommitment", workspace.dailyCommitments],
    ["ReplanProposal", workspace.replanProposals],
    ["ReviewRecord", workspace.reviews],
    ["ExceptionRecord", workspace.exceptions],
    ["CloseDecision", workspace.closeDecisions],
    ["CommandProposal", workspace.commandProposals],
    ["SyncConflictRecord", workspace.syncConflicts],
    ["CommandReceipt", workspace.commandReceipts],
    ["ProjectWorkItem", workspace.workItems],
    ["ProjectDependency", workspace.dependencies],
    ["Resource", workspace.resources],
    ["Baseline", workspace.baselines],
    ["Evidence", workspace.evidence],
    ["ActualV2", workspace.actuals],
    ["LegacyAuditRecord", workspace.legacyAuditRecords],
    [
      "BetScope",
      [
        ...workspace.directionBriefs.flatMap((brief) => brief.firstScope),
        ...workspace.bets.flatMap((bet) => [
          ...bet.briefSnapshot.firstScope,
          ...bet.committedScope,
        ]),
      ],
    ],
    [
      "CommitmentSlot",
      [
        ...workspace.dailyCommitments.flatMap(
          (commitment) => commitment.slots,
        ),
        ...workspace.replanProposals.flatMap(
          (proposal) => proposal.proposedSlots,
        ),
      ],
    ],
    [
      "UnavailableBlock",
      [
        ...(workspace.capacityProfile?.unavailableBlocks ?? []),
        ...workspace.dailyCommitments.flatMap(
          (commitment) => commitment.capacitySnapshot.unavailableBlocks,
        ),
      ],
    ],
  ];

  return collections.find(([, records]) =>
    records.some((record) => record.id === id),
  )?.[0];
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function updatedInboxForAction(
  inboxItem: InboxItem,
  action: Action,
): InboxItem {
  return {
    ...inboxItem,
    recommendation: evaluateActionEligibility(action.eligibility),
    triageStatus: "action",
    actionId: action.id,
  };
}

function prospectiveActionIdConflict(
  workspace: WorkspaceV2,
  actionId: string,
): string | undefined {
  if (workspace.projects.some(({ id }) => id === actionId)) return "Project";
  if (workspace.workItems.some(({ id }) => id === actionId)) {
    return "Gantt Work Item";
  }
  if (
    workspace.dependencies.some(
      ({ fromId, toId }) => fromId === actionId || toId === actionId,
    )
  ) {
    return "dependency network";
  }
  if (
    workspace.baselines.some(
      (baseline) =>
        Object.prototype.hasOwnProperty.call(
          baseline.plannedStartByItem,
          actionId,
        ) ||
        Object.prototype.hasOwnProperty.call(
          baseline.plannedFinishByItem,
          actionId,
        ) ||
        Object.prototype.hasOwnProperty.call(
          baseline.plannedWorkSecondsByItem,
          actionId,
        ),
    )
  ) {
    return "Baseline";
  }
  if (workspace.evidence.some(({ workItemId }) => workItemId === actionId)) {
    return "project Evidence milestone";
  }
  if (
    workspace.bets.some(
      ({ id, projectId }) => id === actionId || projectId === actionId,
    )
  ) {
    return "Bet";
  }
  if (
    workspace.closeDecisions.some(
      ({ id, projectId }) => id === actionId || projectId === actionId,
    )
  ) {
    return "Close decision";
  }
  return undefined;
}

function actionIdentityCandidates(command: V2Command): string[] {
  switch (command.type) {
    case "confirm_project_triage":
      return [command.project.id];
    case "promote_action_to_project":
      return [command.project.id];
    case "update_project_metadata":
    case "request_validation":
    case "satisfy_validation":
    case "record_bet_boundary":
    case "archive_project":
      return [command.projectId];
    case "update_direction":
      return [command.projectId, command.brief.projectId, command.brief.id];
    case "place_bet":
      return [command.projectId, command.betId];
    case "create_work_item":
      return [
        command.projectId,
        command.workItem.projectId,
        command.workItem.id,
      ];
    case "update_work_item":
      return [command.projectId, command.workItemId];
    case "upsert_dependency":
      return [
        command.dependency.id,
        command.dependency.projectId,
        command.dependency.fromId,
        command.dependency.toId,
      ];
    case "remove_dependency":
      return [command.dependencyId];
    case "remove_work_item":
    case "complete_work_item":
      return [command.projectId, command.workItemId];
    case "capture_baseline":
      return [
        command.baseline.id,
        command.baseline.projectId,
        ...(command.baseline.approvedByDecisionId === undefined
          ? []
          : [command.baseline.approvedByDecisionId]),
        ...Object.keys(command.baseline.plannedStartByItem),
        ...Object.keys(command.baseline.plannedFinishByItem),
        ...Object.keys(command.baseline.plannedWorkSecondsByItem),
      ];
    case "propose_replan":
      return command.proposal.proposedSlots.flatMap(({ target }) =>
        target.kind === "work_item"
          ? [target.projectId, target.workItemId]
          : [],
      );
    case "commit_today":
      return command.commitment.slots.flatMap(({ target }) =>
        target.kind === "work_item"
          ? [target.projectId, target.workItemId]
          : [],
      );
    case "record_actual":
      return command.actual.target.kind === "work_item"
        ? [command.actual.target.workItemId]
        : [];
    case "attach_evidence":
      return [
        command.evidence.projectId,
        ...(command.evidence.workItemId === undefined
          ? []
          : [command.evidence.workItemId]),
      ];
    case "approve_evidence_exception":
      return [command.exception.projectId, command.exception.requirementId];
    case "close_project":
    case "abandon_project":
      return [
        command.projectId,
        command.decision.id,
        command.decision.projectId,
        ...(command.decision.followUpProjectId === undefined
          ? []
          : [command.decision.followUpProjectId]),
      ];
    case "configure_capacity":
    case "capture_inbox":
    case "confirm_action_triage":
    case "update_action":
    case "complete_action":
    case "accept_replan":
    case "resolve_evidence_exception":
    case "mark_review_overdue":
    case "create_review":
    case "complete_review":
    case "resolve_sync_conflict":
      return [];
  }
}

function actionIdentityMisuse(
  workspace: WorkspaceV2,
  command: V2Command,
): string | undefined {
  const actionIds = new Set(workspace.actions.map(({ id }) => id));
  return actionIdentityCandidates(command).find((id) => actionIds.has(id));
}

function planningAccessRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  access: PlanningContextRejection,
): CommandHandlerResult {
  return rejection(workspace, context, access.code, {
    reason: access.reason,
    gate: access.gate,
    permittedNextCommand: access.permittedNextCommand,
    ...(access.hold === undefined ? {} : { hold: access.hold }),
  });
}

function scopeOutsideBet(
  workspace: WorkspaceV2,
  context: CommandContext,
  projectId: string,
  betId: string,
  scopeId: string,
): CommandHandlerResult {
  return rejection(workspace, context, "SCOPE_OUTSIDE_BET", {
    reason: `Scope ${scopeId} is not committed by current Bet ${betId} for Project ${projectId}.`,
    gate: `project:${projectId}:bet:${betId}:scope:${scopeId}`,
    permittedNextCommand: "update_direction",
  });
}

export async function applyCommandHandler(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandHandlerResult> {
  const misusedActionId = actionIdentityMisuse(workspace, command);
  if (misusedActionId !== undefined) {
    return rejection(workspace, context, "ACTION_PROMOTION_REQUIRED", {
      reason: `Action ${misusedActionId} must be promoted before it can be used as a Project record.`,
      gate: `action_identity:${misusedActionId}`,
      permittedNextCommand: "promote_action_to_project",
    });
  }

  switch (command.type) {
    case "configure_capacity": {
      return {
        ok: true,
        workspace: {
          ...workspace,
          capacityProfile: structuredClone(command.profile),
        },
      };
    }

    case "capture_inbox": {
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

    case "confirm_action_triage": {
      const inboxIndex = workspace.inboxItems.findIndex(
        ({ id }) => id === command.inboxItemId,
      );
      if (inboxIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "InboxItem",
          command.inboxItemId,
          "capture_inbox",
        );
      }
      const inboxItem = workspace.inboxItems[inboxIndex];
      if (inboxItem.triageStatus !== "untriaged") {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `InboxItem ${inboxItem.id} was already triaged.`,
          gate: `inbox_triage:${inboxItem.id}`,
          permittedNextCommand: "read_current_inbox_item",
        });
      }
      const recommendation = evaluateActionEligibility(
        command.action.eligibility,
      );
      if (recommendation.kind === "project") {
        return rejection(workspace, context, "ACTION_INELIGIBLE", {
          reason: recommendation.explanation,
          gate: `action_eligibility:${command.action.id}`,
          permittedNextCommand: "confirm_project_triage",
        });
      }
      if (workspace.actions.some(({ id }) => id === command.action.id)) {
        return entityAlreadyExists(
          workspace,
          context,
          "Action",
          command.action.id,
          "confirm_action_triage",
        );
      }
      const projectOnlyUse = prospectiveActionIdConflict(
        workspace,
        command.action.id,
      );
      if (projectOnlyUse !== undefined) {
        return rejection(workspace, context, "ACTION_INELIGIBLE", {
          reason: `Action ID ${command.action.id} is already used by ${projectOnlyUse}.`,
          gate: `action_identity:${command.action.id}`,
          permittedNextCommand: "confirm_project_triage",
        });
      }
      const action: Action = {
        id: command.action.id,
        inboxItemId: inboxItem.id,
        title: command.action.title,
        revision: 1,
        status: "open",
        eligibility: structuredClone(command.action.eligibility),
        attention: command.action.attention,
        ...(command.action.desiredDate === undefined
          ? {}
          : { desiredDate: command.action.desiredDate }),
        ...(command.action.fixedStart === undefined
          ? {}
          : { fixedStart: command.action.fixedStart }),
        createdAt: context.now,
        updatedAt: context.now,
      };
      const inboxItems = [...workspace.inboxItems];
      inboxItems[inboxIndex] = updatedInboxForAction(inboxItem, action);
      return {
        ok: true,
        workspace: {
          ...workspace,
          inboxItems,
          actions: [...workspace.actions, action],
        },
      };
    }

    case "confirm_project_triage": {
      const inboxIndex = workspace.inboxItems.findIndex(
        ({ id }) => id === command.inboxItemId,
      );
      if (inboxIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "InboxItem",
          command.inboxItemId,
          "capture_inbox",
        );
      }
      const inboxItem = workspace.inboxItems[inboxIndex];
      if (inboxItem.triageStatus !== "untriaged") {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `InboxItem ${inboxItem.id} was already triaged.`,
          gate: `inbox_triage:${inboxItem.id}`,
          permittedNextCommand: "read_current_inbox_item",
        });
      }
      const collision = projectArtifactsCollision(workspace, command.project.id);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision.entity,
          collision.id,
          "confirm_project_triage",
        );
      }
      const { project, brief } = buildDirectionProject(
        command.project,
        context.now,
      );
      const inboxItems = [...workspace.inboxItems];
      inboxItems[inboxIndex] = {
        ...inboxItem,
        recommendation: evaluateActionEligibility(command.eligibility),
        triageStatus: "project",
        projectId: project.id,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          inboxItems,
          projects: [...workspace.projects, project],
          directionBriefs: [...workspace.directionBriefs, brief],
        },
      };
    }

    case "update_action": {
      const actionIndex = workspace.actions.findIndex(
        ({ id }) => id === command.actionId,
      );
      if (actionIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "Action",
          command.actionId,
          "confirm_action_triage",
        );
      }
      const action = workspace.actions[actionIndex];
      if (action.status === "promoted") {
        return rejection(workspace, context, "ACTION_PROMOTION_REQUIRED", {
          reason: `Action ${action.id} was already promoted.`,
          gate: `action_promotion:${action.id}`,
          permittedNextCommand: "read_promoted_project",
        });
      }
      const updated: Action = {
        ...action,
        ...structuredClone(command.patch),
        revision: action.revision + 1,
        updatedAt: context.now,
      };
      const recommendation = evaluateActionEligibility(updated.eligibility);
      if (recommendation.kind === "project") {
        return rejection(workspace, context, "ACTION_PROMOTION_REQUIRED", {
          reason: recommendation.explanation,
          gate: `action_eligibility:${action.id}`,
          permittedNextCommand: "promote_action_to_project",
        });
      }
      const inboxIndex = workspace.inboxItems.findIndex(
        ({ id }) => id === action.inboxItemId,
      );
      if (inboxIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "InboxItem",
          action.inboxItemId,
          "repair_workspace_reference",
        );
      }
      const actions = [...workspace.actions];
      actions[actionIndex] = updated;
      const inboxItems = [...workspace.inboxItems];
      inboxItems[inboxIndex] = {
        ...inboxItems[inboxIndex],
        recommendation,
      };
      return {
        ok: true,
        workspace: { ...workspace, actions, inboxItems },
      };
    }

    case "complete_action": {
      const actionIndex = workspace.actions.findIndex(
        ({ id }) => id === command.actionId,
      );
      if (actionIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "Action",
          command.actionId,
          "confirm_action_triage",
        );
      }
      const action = workspace.actions[actionIndex];
      if (action.status !== "open") {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Action ${action.id} is already ${action.status}.`,
          gate: `action_status:${action.id}`,
          permittedNextCommand:
            action.status === "promoted"
              ? "read_promoted_project"
              : "read_completed_action",
        });
      }
      if (command.actualSeconds < 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Action actual effort cannot be negative.",
          gate: `action_actual:${action.id}`,
          permittedNextCommand: "complete_action",
        });
      }
      const actualId = `${context.commandId}:actual`;
      if (workspace.actuals.some(({ id }) => id === actualId)) {
        return entityAlreadyExists(
          workspace,
          context,
          "ActualV2",
          actualId,
          "read_existing_command_receipt",
        );
      }
      const actions = [...workspace.actions];
      actions[actionIndex] = {
        ...action,
        revision: action.revision + 1,
        status: "completed",
        outcomeNote: command.outcomeNote,
        updatedAt: context.now,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          actions,
          actuals: [
            ...workspace.actuals,
            {
              id: actualId,
              revision: 1,
              target: { kind: "action", actionId: action.id },
              actualWorkSeconds: command.actualSeconds,
              remainingWorkSeconds: 0,
              actualCost: 0,
              recordedAt: context.now,
            },
          ],
        },
      };
    }

    case "promote_action_to_project": {
      const actionIndex = workspace.actions.findIndex(
        ({ id }) => id === command.actionId,
      );
      if (actionIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "Action",
          command.actionId,
          "confirm_action_triage",
        );
      }
      const action = workspace.actions[actionIndex];
      if (action.status === "promoted") {
        return rejection(workspace, context, "ACTION_PROMOTION_REQUIRED", {
          reason: `Action ${action.id} is already promoted.`,
          gate: `action_promotion:${action.id}`,
          permittedNextCommand: "read_promoted_project",
        });
      }
      const recommendation = evaluateActionEligibility(command.eligibility);
      if (recommendation.kind !== "project") {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Action promotion requires at least one failed eligibility rule.",
          gate: `action_promotion_eligibility:${action.id}`,
          permittedNextCommand: "update_action",
        });
      }
      const inboxIndex = workspace.inboxItems.findIndex(
        ({ id }) => id === action.inboxItemId,
      );
      if (inboxIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "InboxItem",
          action.inboxItemId,
          "repair_workspace_reference",
        );
      }
      const collision = projectArtifactsCollision(workspace, command.project.id);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision.entity,
          collision.id,
          "promote_action_to_project",
        );
      }
      const { project, brief } = buildDirectionProject(
        command.project,
        context.now,
      );
      const actions = [...workspace.actions];
      actions[actionIndex] = {
        ...action,
        eligibility: structuredClone(command.eligibility),
        revision: action.revision + 1,
        status: "promoted",
        promotedProjectId: project.id,
        updatedAt: context.now,
      };
      const inboxItem = workspace.inboxItems[inboxIndex];
      const inboxItems = [...workspace.inboxItems];
      inboxItems[inboxIndex] = {
        ...inboxItem,
        recommendation,
        triageStatus: "project",
        projectId: project.id,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          inboxItems,
          actions,
          projects: [...workspace.projects, project],
          directionBriefs: [...workspace.directionBriefs, brief],
        },
      };
    }

    case "update_direction": {
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === command.projectId,
      );
      if (projectIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const project = workspace.projects[projectIndex];
      const briefIndex = workspace.directionBriefs.findIndex(
        ({ id }) => id === project.activeDirectionBriefId,
      );
      const activeBrief = workspace.directionBriefs[briefIndex];
      if (
        command.brief.id !== project.activeDirectionBriefId ||
        command.brief.projectId !== project.id ||
        activeBrief === undefined ||
        activeBrief.projectId !== project.id
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Direction update must target the active brief for Project ${project.id}.`,
          gate: `project:${project.id}:active_direction`,
          permittedNextCommand: "update_direction",
        });
      }
      const activeBetStage =
        project.stage === "planning" ||
        project.stage === "executing" ||
        project.stage === "validating";
      if (activeBetStage && project.activeBetId === undefined) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} cannot replace its active Direction draft from ${project.stage} without an active Bet.`,
            gate: `project:${project.id}:stage:${project.stage}`,
            permittedNextCommand: "update_direction",
          },
        );
      }
      if (
        !activeBetStage &&
        project.stage !== "direction" &&
        project.stage !== "awaiting_bet"
      ) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} cannot replace its active Direction draft from ${project.stage}.`,
            gate: `project:${project.id}:stage:${project.stage}`,
            permittedNextCommand: "update_direction",
          },
        );
      }

      if (activeBetStage) {
        const comparisonBrief: DirectionBrief = {
          ...structuredClone(command.brief),
          version: activeBrief.version + 1,
          createdAt: context.now,
          updatedAt: context.now,
        };
        if (!(await isMaterialDirectionChange(activeBrief, comparisonBrief))) {
          const nextVersion =
            Math.max(
              0,
              ...workspace.directionBriefs
                .filter(({ projectId }) => projectId === project.id)
                .map(({ version }) => version),
            ) + 1;
          const nextBriefId = `${project.id}:direction-brief:${nextVersion}`;
          const collision = entityIdCollision(workspace, nextBriefId, [
            { entity: "CommandReceipt", id: context.commandId },
          ]);
          if (collision !== undefined) {
            return entityAlreadyExists(
              workspace,
              context,
              collision,
              nextBriefId,
              "update_direction",
            );
          }
          const editorialBrief: DirectionBrief = {
            ...structuredClone(command.brief),
            id: nextBriefId,
            version: nextVersion,
            createdAt: context.now,
            updatedAt: context.now,
          };
          const projects = [...workspace.projects];
          projects[projectIndex] = {
            ...project,
            activeDirectionBriefId: editorialBrief.id,
            updatedAt: context.now,
          };
          return {
            ok: true,
            workspace: {
              ...workspace,
              projects,
              directionBriefs: [
                ...workspace.directionBriefs,
                editorialBrief,
              ],
            },
          };
        }

        if (project.activeBetId === undefined) {
          return rejection(workspace, context, "BET_REQUIRED", {
            reason: `Project ${project.id} has no Bet to invalidate.`,
            gate: `project:${project.id}:current_bet`,
            permittedNextCommand: "place_bet",
          });
        }
        const betIndex = workspace.bets.findIndex(
          ({ id }) => id === project.activeBetId,
        );
        const activeBet = workspace.bets[betIndex];
        if (activeBet === undefined || activeBet.projectId !== project.id) {
          return entityNotFound(
            workspace,
            context,
            "BetVersion",
            project.activeBetId,
            "place_bet",
          );
        }

        const nextVersion =
          Math.max(
            0,
            ...workspace.directionBriefs
              .filter(({ projectId }) => projectId === project.id)
              .map(({ version }) => version),
          ) + 1;
        const nextBriefId = `${project.id}:direction-brief:${nextVersion}`;
        const collision = entityIdCollision(workspace, nextBriefId, [
          { entity: "CommandReceipt", id: context.commandId },
        ]);
        if (collision !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            collision,
            nextBriefId,
            "update_direction",
          );
        }

        const updatedBrief: DirectionBrief = {
          ...structuredClone(command.brief),
          id: nextBriefId,
          version: nextVersion,
          createdAt: context.now,
          updatedAt: context.now,
        };
        const affectedRecordIds = [
          project.id,
          activeBrief.id,
          updatedBrief.id,
          activeBet.id,
        ];
        const projects = [...workspace.projects];
        const existingRebetHold = project.holds.find(
          ({ type, sourceId }) =>
            type === "rebet_required" && sourceId === activeBet.id,
        );
        projects[projectIndex] = {
          ...project,
          holds:
            activeBet.invalidatedAt !== undefined &&
            existingRebetHold !== undefined
              ? project.holds
              : [
                  ...project.holds.filter(
                    ({ type }) => type !== "rebet_required",
                  ),
                  {
                    type: "rebet_required",
                    sourceId: activeBet.id,
                    affectedRecordIds,
                    createdAt: context.now,
                  },
                ],
          activeDirectionBriefId: updatedBrief.id,
          updatedAt: context.now,
        };
        const bets = [...workspace.bets];
        bets[betIndex] =
          activeBet.invalidatedAt === undefined
            ? {
                ...activeBet,
                invalidatedAt: context.now,
                invalidationReason: "Material Direction change requires Re-bet.",
              }
            : activeBet;

        return {
          ok: true,
          workspace: {
            ...workspace,
            projects,
            directionBriefs: [...workspace.directionBriefs, updatedBrief],
            bets,
          },
        };
      }

      const complete = isDirectionComplete(command.brief);
      let transitionedProject = project;
      if (project.stage === "direction" && complete) {
        const transition = transitionLifecycle(project, "brief_completed");
        if (!transition.ok) {
          return rejection(
            workspace,
            context,
            "ILLEGAL_LIFECYCLE_TRANSITION",
            {
              gate: `project:${project.id}:stage:${project.stage}`,
              permittedNextCommand: "update_direction",
            },
          );
        }
        transitionedProject = transition.project;
      } else if (project.stage === "awaiting_bet" && !complete) {
        const transition = transitionLifecycle(
          project,
          "brief_became_incomplete",
        );
        if (!transition.ok) {
          return rejection(
            workspace,
            context,
            "ILLEGAL_LIFECYCLE_TRANSITION",
            {
              gate: `project:${project.id}:stage:${project.stage}`,
              permittedNextCommand: "update_direction",
            },
          );
        }
        transitionedProject = transition.project;
      }

      const updatedBrief: DirectionBrief = {
        ...structuredClone(command.brief),
        version: activeBrief.version + 1,
        createdAt: activeBrief.createdAt,
        updatedAt: context.now,
      };
      const projects = [...workspace.projects];
      projects[projectIndex] = {
        ...transitionedProject,
        updatedAt: context.now,
      };
      const directionBriefs = [...workspace.directionBriefs];
      directionBriefs[briefIndex] = updatedBrief;

      return {
        ok: true,
        workspace: { ...workspace, projects, directionBriefs },
      };
    }

    case "place_bet": {
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === command.projectId,
      );
      if (projectIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const project = workspace.projects[projectIndex];
      const projectBets = workspace.bets.filter(
        ({ projectId }) => projectId === project.id,
      );
      const placingFirstBet = project.activeBetId === undefined;
      const transition = transitionLifecycle(
        project,
        placingFirstBet ? "bet_placed" : "bet_replaced",
      );
      if (
        !transition.ok ||
        (placingFirstBet
          ? project.stage !== "awaiting_bet"
          : project.activeBetId === undefined)
      ) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: placingFirstBet
              ? `Project ${project.id} cannot place a first Bet from ${project.stage}.`
              : `Project ${project.id} cannot place a replacement Bet from ${project.stage}.`,
            gate: `project:${project.id}:stage:${project.stage}`,
            permittedNextCommand: "place_bet",
          },
        );
      }
      const brief = workspace.directionBriefs.find(
        ({ id }) => id === project.activeDirectionBriefId,
      );
      if (brief === undefined || brief.projectId !== project.id) {
        return entityNotFound(
          workspace,
          context,
          "DirectionBrief",
          project.activeDirectionBriefId,
          "update_direction",
        );
      }
      if (!isDirectionComplete(brief)) {
        return rejection(workspace, context, "BRIEF_INCOMPLETE", {
          reason: `Project ${project.id} requires all six Direction decisions before a Bet.`,
          gate: `project:${project.id}:direction_complete`,
          permittedNextCommand: "update_direction",
        });
      }

      const collision = entityIdCollision(workspace, command.betId, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.betId,
          "place_bet",
        );
      }
      if (placingFirstBet && projectBets.length > 0) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} already has Bet history; use the Re-bet path.`,
            gate: `project:${project.id}:bet_history`,
            permittedNextCommand: "place_bet",
          },
        );
      }
      if (!isCanonicalIsoTimestamp(command.start)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Bet start must be a valid ISO timestamp.",
          gate: `bet:${command.betId}:appetite_start`,
          permittedNextCommand: "place_bet",
        });
      }
      if (
        !isCanonicalIsoTimestamp(context.now) ||
        command.start !== context.now
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Bet start must equal the authoritative approval timestamp.",
          gate: `bet:${command.betId}:appetite_start`,
          permittedNextCommand: "place_bet",
        });
      }
      const appetiteEndMilliseconds =
        Date.parse(context.now) + brief.appetiteSeconds * 1_000;
      if (
        !Number.isFinite(appetiteEndMilliseconds) ||
        Math.abs(appetiteEndMilliseconds) > 8.64e15
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Direction appetite does not produce a valid Bet boundary.",
          gate: `bet:${command.betId}:appetite_end`,
          permittedNextCommand: "update_direction",
        });
      }

      const supersededBetIndex = placingFirstBet
        ? -1
        : workspace.bets.findIndex(({ id }) => id === project.activeBetId);
      const supersededBet = workspace.bets[supersededBetIndex];
      if (
        !placingFirstBet &&
        (supersededBet === undefined || supersededBet.projectId !== project.id)
      ) {
        return entityNotFound(
          workspace,
          context,
          "BetVersion",
          project.activeBetId!,
          "place_bet",
        );
      }
      const bet = await buildBetVersion(brief, {
        id: command.betId,
        version: placingFirstBet
          ? 1
          : Math.max(0, ...projectBets.map(({ version }) => version)) + 1,
        actorId: context.actorId,
        approvedAt: context.now,
        ...(placingFirstBet
          ? {}
          : { supersedesId: project.activeBetId! }),
      });
      const projects = [...workspace.projects];
      const transitionedProject = { ...transition.project };
      if (!placingFirstBet) {
        delete transitionedProject.activePlanVersionId;
      }
      projects[projectIndex] = {
        ...transitionedProject,
        holds: placingFirstBet
          ? transition.project.holds
          : transition.project.holds.filter(
              ({ type }) => type !== "rebet_required",
            ),
        activeBetId: bet.id,
        updatedAt: context.now,
      };
      const bets = [...workspace.bets];
      if (
        !placingFirstBet &&
        supersededBet !== undefined &&
        supersededBet.invalidatedAt === undefined
      ) {
        bets[supersededBetIndex] = {
          ...supersededBet,
          invalidatedAt: context.now,
          invalidationReason: `Superseded by Re-bet ${bet.id}.`,
        };
      }

      return {
        ok: true,
        workspace: {
          ...workspace,
          projects,
          bets: [...bets, bet],
        },
      };
    }

    case "update_project_metadata": {
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === command.projectId,
      );
      if (projectIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const project = workspace.projects[projectIndex];
      const projects = [...workspace.projects];
      projects[projectIndex] = {
        ...project,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.priority === undefined
          ? {}
          : { priority: command.priority }),
        ...(command.notes === undefined ? {} : { notes: command.notes }),
        updatedAt: context.now,
      };
      return { ok: true, workspace: { ...workspace, projects } };
    }

    case "create_work_item": {
      const access = resolvePlanningContext(
        workspace,
        command.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      if (command.workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${command.workItem.id} must belong to Project ${access.project.id}.`,
          gate: `work_item:${command.workItem.id}:project`,
          permittedNextCommand: "create_work_item",
        });
      }
      if (command.workItem.revision !== 1) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "A new Work Item must start at revision 1.",
          gate: `work_item:${command.workItem.id}:revision`,
          permittedNextCommand: "create_work_item",
        });
      }
      const collision = entityIdCollision(workspace, command.workItem.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.workItem.id,
          "create_work_item",
        );
      }
      if (
        !access.bet.committedScope.some(
          ({ id }) => id === command.workItem.betScopeId,
        )
      ) {
        return scopeOutsideBet(
          workspace,
          context,
          access.project.id,
          access.bet.id,
          command.workItem.betScopeId,
        );
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          workItems: [
            ...workspace.workItems,
            structuredClone(command.workItem),
          ],
        },
      };
    }

    case "update_work_item": {
      const access = resolvePlanningContext(
        workspace,
        command.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const workItemIndex = workspace.workItems.findIndex(
        ({ id }) => id === command.workItemId,
      );
      if (workItemIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      const workItem = workspace.workItems[workItemIndex];
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "update_work_item",
        });
      }
      const nextScopeId = command.patch.betScopeId ?? workItem.betScopeId;
      if (
        !access.bet.committedScope.some(({ id }) => id === nextScopeId)
      ) {
        return scopeOutsideBet(
          workspace,
          context,
          access.project.id,
          access.bet.id,
          nextScopeId,
        );
      }
      const workItems = [...workspace.workItems];
      workItems[workItemIndex] = {
        ...workItem,
        ...structuredClone(command.patch),
        id: workItem.id,
        projectId: workItem.projectId,
        revision: workItem.revision + 1,
        betScopeId: nextScopeId,
      };
      return { ok: true, workspace: { ...workspace, workItems } };
    }

    case "complete_work_item": {
      const access = resolvePlanningContext(
        workspace,
        command.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const workItemIndex = workspace.workItems.findIndex(
        ({ id }) => id === command.workItemId,
      );
      if (workItemIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      const workItem = workspace.workItems[workItemIndex];
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "complete_work_item",
        });
      }
      if (
        !access.bet.committedScope.some(({ id }) => id === workItem.betScopeId)
      ) {
        return scopeOutsideBet(
          workspace,
          context,
          access.project.id,
          access.bet.id,
          workItem.betScopeId,
        );
      }
      const workItems = [...workspace.workItems];
      workItems[workItemIndex] = {
        ...workItem,
        revision: workItem.revision + 1,
        resultStatus: command.resultStatus,
        outcomeNote: command.outcomeNote,
      };
      return { ok: true, workspace: { ...workspace, workItems } };
    }

    case "remove_work_item": {
      const access = resolvePlanningContext(
        workspace,
        command.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const workItem = workspace.workItems.find(
        ({ id }) => id === command.workItemId,
      );
      if (workItem === undefined) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "remove_work_item",
        });
      }
      const linkedDependency = workspace.dependencies.find(
        ({ fromId, toId }) => fromId === workItem.id || toId === workItem.id,
      );
      if (linkedDependency !== undefined) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} is linked by Dependency ${linkedDependency.id}; dependencies are never removed implicitly.`,
          gate: `work_item:${workItem.id}:dependency:${linkedDependency.id}`,
          permittedNextCommand: "remove_dependency",
        });
      }
      const referencedByHistory =
        workspace.planVersions.some(
          (plan) =>
            Object.prototype.hasOwnProperty.call(
              plan.workItemRevisions,
              workItem.id,
            ) ||
            Object.prototype.hasOwnProperty.call(plan.scopeMapping, workItem.id) ||
            Object.prototype.hasOwnProperty.call(
              plan.capacityIndependentDates,
              workItem.id,
            ),
        ) ||
        workspace.baselines.some(
          (baseline) =>
            Object.prototype.hasOwnProperty.call(
              baseline.plannedStartByItem,
              workItem.id,
            ) ||
            Object.prototype.hasOwnProperty.call(
              baseline.plannedFinishByItem,
              workItem.id,
            ) ||
            Object.prototype.hasOwnProperty.call(
              baseline.plannedWorkSecondsByItem,
              workItem.id,
            ),
        ) ||
        workspace.evidence.some(({ workItemId }) => workItemId === workItem.id) ||
        workspace.actuals.some(
          ({ target }) =>
            target.kind === "work_item" && target.workItemId === workItem.id,
        ) ||
        workspace.dailyCommitments.some((commitment) =>
          commitment.slots.some(
            ({ target }) =>
              target.kind === "work_item" && target.workItemId === workItem.id,
          ),
        ) ||
        workspace.replanProposals.some((proposal) =>
          proposal.proposedSlots.some(
            ({ target }) =>
              target.kind === "work_item" && target.workItemId === workItem.id,
          ),
        ) ||
        workspace.workItems.some(
          (candidate) =>
            candidate.id !== workItem.id &&
            (candidate.parentId === workItem.id ||
              candidate.hammockStartId === workItem.id ||
              candidate.hammockFinishId === workItem.id),
        );
      if (referencedByHistory) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} is referenced by planning history and must keep its ID.`,
          gate: `work_item:${workItem.id}:history`,
          permittedNextCommand: "update_work_item",
        });
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          workItems: workspace.workItems.filter(({ id }) => id !== workItem.id),
        },
      };
    }

    case "upsert_dependency": {
      const access = resolvePlanningContext(
        workspace,
        command.dependency.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const dependencyIndex = workspace.dependencies.findIndex(
        ({ id }) => id === command.dependency.id,
      );
      const existingDependency = workspace.dependencies[dependencyIndex];
      if (
        existingDependency !== undefined &&
        existingDependency.projectId !== command.dependency.projectId
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Dependency ${existingDependency.id} cannot move between Projects.`,
          gate: `dependency:${existingDependency.id}:project`,
          permittedNextCommand: "upsert_dependency",
        });
      }
      const fromItem = workspace.workItems.find(
        ({ id }) => id === command.dependency.fromId,
      );
      const toItem = workspace.workItems.find(
        ({ id }) => id === command.dependency.toId,
      );
      if (fromItem === undefined) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.dependency.fromId,
          "create_work_item",
        );
      }
      if (toItem === undefined) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.dependency.toId,
          "create_work_item",
        );
      }
      if (
        fromItem.projectId !== access.project.id ||
        toItem.projectId !== access.project.id
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Cross-project dependency edges are unsupported in OmniPlan V2; both endpoints must belong to the Dependency Project.",
          gate: `dependency:${command.dependency.id}:cross_project`,
          permittedNextCommand: "create_project_local_dependency",
        });
      }
      if (fromItem.id === toItem.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "A Dependency cannot connect a Work Item to itself.",
          gate: `dependency:${command.dependency.id}:self_edge`,
          permittedNextCommand: "upsert_dependency",
        });
      }
      for (const workItem of [fromItem, toItem]) {
        if (
          !access.bet.committedScope.some(
            ({ id }) => id === workItem.betScopeId,
          )
        ) {
          return scopeOutsideBet(
            workspace,
            context,
            access.project.id,
            access.bet.id,
            workItem.betScopeId,
          );
        }
      }
      if (existingDependency === undefined) {
        if (command.dependency.revision !== 1) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: "A new Dependency must start at revision 1.",
            gate: `dependency:${command.dependency.id}:revision`,
            permittedNextCommand: "upsert_dependency",
          });
        }
        const collision = entityIdCollision(workspace, command.dependency.id, [
          { entity: "CommandReceipt", id: context.commandId },
        ]);
        if (collision !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            collision,
            command.dependency.id,
            "upsert_dependency",
          );
        }
        return {
          ok: true,
          workspace: {
            ...workspace,
            dependencies: [
              ...workspace.dependencies,
              structuredClone(command.dependency),
            ],
          },
        };
      }
      if (command.dependency.revision !== existingDependency.revision) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Dependency ${existingDependency.id} is at revision ${existingDependency.revision}.`,
          gate: `dependency:${existingDependency.id}:revision`,
          permittedNextCommand: "upsert_dependency",
        });
      }
      const dependencies = [...workspace.dependencies];
      dependencies[dependencyIndex] = {
        ...structuredClone(command.dependency),
        id: existingDependency.id,
        projectId: existingDependency.projectId,
        revision: existingDependency.revision + 1,
      };
      return { ok: true, workspace: { ...workspace, dependencies } };
    }

    case "remove_dependency": {
      const dependency = workspace.dependencies.find(
        ({ id }) => id === command.dependencyId,
      );
      if (dependency === undefined) {
        return entityNotFound(
          workspace,
          context,
          "ProjectDependency",
          command.dependencyId,
          "upsert_dependency",
        );
      }
      const access = resolvePlanningContext(
        workspace,
        dependency.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const historicalPlan = workspace.planVersions.find((plan) =>
        Object.prototype.hasOwnProperty.call(
          plan.dependencyRevisions,
          dependency.id,
        ),
      );
      if (historicalPlan !== undefined) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Dependency ${dependency.id} is preserved by Plan Version ${historicalPlan.id}.`,
          gate: `dependency:${dependency.id}:history`,
          permittedNextCommand: "upsert_dependency",
        });
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          dependencies: workspace.dependencies.filter(
            ({ id }) => id !== dependency.id,
          ),
        },
      };
    }

    case "capture_baseline": {
      if (!isCanonicalIsoTimestamp(command.baseline.capturedAt)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Baseline capture time must be a canonical ISO timestamp.",
          gate: `baseline:${command.baseline.id}:captured_at`,
          permittedNextCommand: "capture_baseline",
        });
      }
      const startIds = Object.keys(
        command.baseline.plannedStartByItem,
      ).sort();
      const finishIds = Object.keys(
        command.baseline.plannedFinishByItem,
      ).sort();
      const workIds = Object.keys(
        command.baseline.plannedWorkSecondsByItem,
      ).sort();
      if (
        JSON.stringify(startIds) !== JSON.stringify(finishIds) ||
        JSON.stringify(startIds) !== JSON.stringify(workIds)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Baseline planned start, finish, and work maps must contain the same Work Item IDs.",
          gate: `baseline:${command.baseline.id}:item_keys`,
          permittedNextCommand: "capture_baseline",
        });
      }
      for (const workItemId of startIds) {
        const start = command.baseline.plannedStartByItem[workItemId];
        const finish = command.baseline.plannedFinishByItem[workItemId];
        const plannedWork =
          command.baseline.plannedWorkSecondsByItem[workItemId];
        if (!isCanonicalIsoTimestamp(start)) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Baseline planned start for Work Item ${workItemId} must be a canonical ISO timestamp.`,
            gate: `baseline:${command.baseline.id}:item:${workItemId}:planned_start`,
            permittedNextCommand: "capture_baseline",
          });
        }
        if (!isCanonicalIsoTimestamp(finish)) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Baseline planned finish for Work Item ${workItemId} must be a canonical ISO timestamp.`,
            gate: `baseline:${command.baseline.id}:item:${workItemId}:planned_finish`,
            permittedNextCommand: "capture_baseline",
          });
        }
        if (Date.parse(finish) < Date.parse(start)) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Baseline planned finish for Work Item ${workItemId} cannot precede its planned start.`,
            gate: `baseline:${command.baseline.id}:item:${workItemId}:range`,
            permittedNextCommand: "capture_baseline",
          });
        }
        if (!Number.isFinite(plannedWork) || plannedWork < 0) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Baseline planned work for Work Item ${workItemId} must be finite and nonnegative.`,
            gate: `baseline:${command.baseline.id}:item:${workItemId}:planned_work`,
            permittedNextCommand: "capture_baseline",
          });
        }
      }
      const access = resolvePlanningContext(
        workspace,
        command.baseline.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      if (command.baseline.approvedByDecisionId !== undefined) {
        const approval = workspace.legacyAuditRecords.find(
          ({ id }) => id === command.baseline.approvedByDecisionId,
        );
        if (
          approval === undefined ||
          approval.projectId !== access.project.id ||
          (approval.recordType !== "decision" &&
            approval.recordType !== "audit_decision")
        ) {
          return rejection(workspace, context, "ENTITY_NOT_FOUND", {
            reason: `Baseline ${command.baseline.id} approval must reference a same-project legacy Decision or Audit Decision.`,
            gate: `baseline:${command.baseline.id}:approved_by_decision`,
            permittedNextCommand: "capture_baseline",
          });
        }
      }
      const collision = entityIdCollision(workspace, command.baseline.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.baseline.id,
          "capture_baseline",
        );
      }
      const workItemIds = [
        ...new Set([
          ...Object.keys(command.baseline.plannedStartByItem),
          ...Object.keys(command.baseline.plannedFinishByItem),
          ...Object.keys(command.baseline.plannedWorkSecondsByItem),
        ]),
      ].sort();
      for (const workItemId of workItemIds) {
        const workItem = workspace.workItems.find(({ id }) => id === workItemId);
        if (workItem === undefined) {
          return entityNotFound(
            workspace,
            context,
            "ProjectWorkItem",
            workItemId,
            "create_work_item",
          );
        }
        if (workItem.projectId !== access.project.id) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Baseline ${command.baseline.id} cannot include Work Item ${workItem.id} from another Project.`,
            gate: `baseline:${command.baseline.id}:cross_project`,
            permittedNextCommand: "capture_baseline",
          });
        }
        if (
          !access.bet.committedScope.some(
            ({ id }) => id === workItem.betScopeId,
          )
        ) {
          return scopeOutsideBet(
            workspace,
            context,
            access.project.id,
            access.bet.id,
            workItem.betScopeId,
          );
        }
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          baselines: [
            ...workspace.baselines,
            structuredClone(command.baseline),
          ],
        },
      };
    }

    case "propose_replan":
    case "commit_today":
    case "accept_replan":
    case "record_actual":
    case "attach_evidence":
    case "approve_evidence_exception":
    case "resolve_evidence_exception":
    case "request_validation":
    case "satisfy_validation":
      return notImplemented(workspace, context);

    case "record_bet_boundary": {
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === command.projectId,
      );
      if (projectIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const project = workspace.projects[projectIndex];
      if (project.activeBetId === undefined) {
        return rejection(workspace, context, "BET_REQUIRED", {
          reason: `Project ${project.id} has no active Bet boundary to record.`,
          gate: `project:${project.id}:current_bet`,
          permittedNextCommand: "place_bet",
        });
      }
      const bet = workspace.bets.find(({ id }) => id === project.activeBetId);
      if (
        bet === undefined ||
        bet.projectId !== project.id ||
        bet.invalidatedAt !== undefined
      ) {
        return rejection(workspace, context, "BET_REQUIRED", {
          reason: `Project ${project.id} has no current Bet boundary to record.`,
          gate: `project:${project.id}:current_bet`,
          permittedNextCommand: "place_bet",
        });
      }
      const expectedTriggerKey = `${bet.id}:${command.boundary}`;
      if (command.triggerKey !== expectedTriggerKey) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Bet boundary trigger must be ${expectedTriggerKey}.`,
          gate: `bet:${bet.id}:${command.boundary}:trigger_key`,
          permittedNextCommand: "record_bet_boundary",
        });
      }
      if (!isCanonicalIsoTimestamp(context.now)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Bet boundary time must be a canonical ISO timestamp.",
          gate: `bet:${bet.id}:${command.boundary}:time`,
          permittedNextCommand: "record_bet_boundary",
        });
      }
      const start = Date.parse(bet.appetiteStart);
      const end = Date.parse(bet.appetiteEnd);
      const now = Date.parse(context.now);
      const midpoint = start + (end - start) / 2;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start ||
        (command.boundary === "midpoint"
          ? now < midpoint
          : now < end)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Bet ${bet.id} has not reached its ${command.boundary} boundary.`,
          gate: `bet:${bet.id}:${command.boundary}`,
          permittedNextCommand: "record_bet_boundary",
        });
      }
      if (
        project.stage !== "planning" &&
        project.stage !== "executing" &&
        project.stage !== "validating"
      ) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} cannot record a Bet boundary from ${project.stage}.`,
            gate: `project:${project.id}:stage:${project.stage}`,
            permittedNextCommand: "record_bet_boundary",
          },
        );
      }

      if (command.boundary === "midpoint") {
        return { ok: true, workspace };
      }

      let transitionedProject = project;
      if (project.stage === "planning" || project.stage === "executing") {
        const transition = transitionLifecycle(project, "appetite_expired");
        if (!transition.ok) {
          return rejection(
            workspace,
            context,
            "ILLEGAL_LIFECYCLE_TRANSITION",
            {
              gate: `project:${project.id}:stage:${project.stage}`,
              permittedNextCommand: "record_bet_boundary",
            },
          );
        }
        transitionedProject = transition.project;
      }
      const projects = [...workspace.projects];
      const existingBoundaryHold = project.holds.find(
        ({ type, sourceId }) =>
          type === "rebet_required" && sourceId === bet.id,
      );
      projects[projectIndex] = {
        ...transitionedProject,
        holds:
          existingBoundaryHold === undefined
            ? [
                ...project.holds.filter(
                  ({ type }) => type !== "rebet_required",
                ),
                {
                  type: "rebet_required",
                  sourceId: bet.id,
                  affectedRecordIds: [project.id, bet.id],
                  createdAt: context.now,
                },
              ]
            : project.holds,
        updatedAt: context.now,
      };
      return { ok: true, workspace: { ...workspace, projects } };
    }

    case "mark_review_overdue":
    case "create_review":
    case "complete_review":
    case "resolve_sync_conflict":
    case "close_project":
      return notImplemented(workspace, context);

    case "abandon_project": {
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === command.projectId,
      );
      if (projectIndex < 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const project = workspace.projects[projectIndex];
      const boundaryBet =
        project.activeBetId === undefined
          ? undefined
          : workspace.bets.find(({ id }) => id === project.activeBetId);
      const atRecordedAppetiteBoundary =
        project.stage === "validating" &&
        boundaryBet !== undefined &&
        boundaryBet.projectId === project.id &&
        boundaryBet.invalidatedAt === undefined &&
        isCanonicalIsoTimestamp(boundaryBet.appetiteEnd) &&
        isCanonicalIsoTimestamp(context.now) &&
        Date.parse(context.now) >= Date.parse(boundaryBet.appetiteEnd) &&
        project.holds.some(
          ({ type, sourceId }) =>
            type === "rebet_required" && sourceId === boundaryBet.id,
        );
      if (!atRecordedAppetiteBoundary) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} may use abandon_project only after its recorded appetite boundary.`,
            gate: `project:${project.id}:appetite_boundary`,
            permittedNextCommand: "record_bet_boundary",
          },
        );
      }
      if (
        command.decision.projectId !== project.id ||
        command.decision.successComparison.trim().length === 0 ||
        command.decision.keyLearning.trim().length === 0 ||
        (command.decision.unfinishedDisposition === "follow_up_project" &&
          (command.decision.followUpProjectId === undefined ||
            command.decision.followUpProjectId.trim().length === 0))
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Abandon requires a structured comparison, learning, and unfinished-work disposition.",
          gate: `project:${project.id}:abandon_decision`,
          permittedNextCommand: "abandon_project",
        });
      }
      const collision = entityIdCollision(workspace, command.decision.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.decision.id,
          "abandon_project",
        );
      }
      const abandonTransition = transitionLifecycle(
        project,
        "abandon_confirmed",
      );
      if (!abandonTransition.ok) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} cannot be abandoned from ${project.stage}.`,
            gate: `project:${project.id}:stage:${project.stage}`,
            permittedNextCommand: "abandon_project",
          },
        );
      }
      const closeTransition = transitionLifecycle(
        abandonTransition.project,
        "project_closed",
      );
      if (!closeTransition.ok) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            gate: `project:${project.id}:stage:${abandonTransition.project.stage}`,
            permittedNextCommand: "abandon_project",
          },
        );
      }
      const projects = [...workspace.projects];
      projects[projectIndex] = {
        ...closeTransition.project,
        holds: closeTransition.project.holds.filter(
          ({ type, sourceId }) =>
            !(
              type === "rebet_required" &&
              sourceId === boundaryBet?.id
            ),
        ),
        updatedAt: context.now,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          projects,
          closeDecisions: [
            ...workspace.closeDecisions,
            {
              ...structuredClone(command.decision),
              actorId: context.actorId,
              closedAt: context.now,
            },
          ],
        },
      };
    }

    case "archive_project":
      return notImplemented(workspace, context);
  }

  return assertNever(command);
}
