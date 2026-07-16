import { createCommandRejection, type CommandRejection } from "./errors";
import type {
  CloseDecisionDraft,
  CommandContext,
  V2Command,
} from "./commands";
import { evaluateActionEligibility } from "./actionPolicy";
import {
  buildCloseArtifacts,
  exactCanonicalAppetiteBoundaryHold,
  selectExactCurrentCloseBet,
  validateCloseDecisionDraft,
  type CloseArtifacts,
  type CloseValidationIssue,
  type ExactCurrentCloseBet,
} from "./close";
import {
  buildSyncConflictRecord,
  conflictRemoteResolutionIsSafe,
  conflictRemoteSemanticsAreValid,
  lookupConflictTarget,
  replaceConflictTargetWithRemote,
} from "./conflicts";
import {
  buildBetVersion,
  isDirectionComplete,
  isMaterialDirectionChange,
} from "./direction";
import {
  betIntegrityIssue,
  betReplacementProvenanceIssue,
  directionSnapshotIntegrityIssue,
  selectCompletedExpiryRebetReview,
} from "./betIntegrity";
import {
  hasActualEffort,
  isConcreteEvidenceRequirement,
  requirementStatus,
} from "./evidence";
import { transitionLifecycle } from "./lifecycle";
import {
  capacityForLocalDate,
  createCapacityLedger,
  localDateAt,
  validateCapacityProfile,
} from "./localTime";
import {
  buildPlanVersionsForCommitment,
  PlanVersionBuildError,
  resolvePlanningContext,
  type PlanningContextRejection,
} from "./planning";
import {
  deriveReviewQueue,
  reviewAffectedActiveProjectIds,
  reviewOverdueTriggerKey,
} from "./review";
import {
  actualAttentionUsageForToday,
  canonicalReplanReasonCodes,
  generateTodayProposal,
  replanHasMaterialChange,
  soleCommitmentLeafForLocalDate,
  TODAY_PROPOSAL_MAX_AGE_SECONDS,
} from "./today";
import { stableHash } from "./stableHash";
import type {
  Action,
  CommandReceipt,
  CommitmentSlot,
  DailyCommitment,
  DirectionBrief,
  ExceptionRecord,
  InboxItem,
  JsonValue,
  ProjectV2,
  ProjectHoldState,
  ReplanProposal,
  ReviewRecord,
  WorkspaceV2,
} from "./types";
import {
  applyRemoteProtectedEffectBundle,
  validateProtectedEffectBundlePair,
} from "../repositories/syncConflictBundles";

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

function isBoundedSemanticReplay(
  context: CommandContext,
  kind: "commit_today" | "propose_replan",
): boolean {
  return (
    context.origin === "sync" &&
    context.source.verified &&
    context.source.capabilities.includes("replay_receipt") &&
    new RegExp(`^sync-semantic:[a-f0-9]{64}:${kind}:`, "s").test(
      context.source.sourceId,
    )
  );
}

function isBoundedSemanticReceipt(
  receipt: Readonly<CommandReceipt>,
  kind: "commit_today" | "propose_replan",
): boolean {
  return (
    receipt.origin === "sync" &&
    receipt.source.verified &&
    receipt.source.capabilities.includes("replay_receipt") &&
    new RegExp(`^sync-semantic:[a-f0-9]{64}:${kind}:`, "s").test(
      receipt.source.sourceId,
    )
  );
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

function duplicateEntityIdentity(
  workspace: WorkspaceV2,
  context: CommandContext,
  entity: string,
  id: string,
): CommandHandlerResult {
  return rejection(workspace, context, "SYNC_CONFLICT", {
    reason: `${entity} ${id} has duplicate records for one identity.`,
    gate: `entity_identity:${entity}:${id}`,
    permittedNextCommand: "resolve_sync_conflict",
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

function entityIdOwnerOccurrences(
  workspace: WorkspaceV2,
  id: string,
  reservedIds: readonly { entity: string; id: string }[] = [],
): string[] {
  const owners = reservedIds
    .filter((reserved) => reserved.id === id)
    .map(({ entity }) => entity);
  if (workspace.workspaceId === id) owners.push("WorkspaceV2");
  if (workspace.migration?.backupId === id) owners.push("MigrationBackup");
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

  for (const [entity, records] of collections) {
    for (const record of records) {
      if (record.id === id) owners.push(entity);
    }
  }
  return owners;
}

function entityIdOwners(
  workspace: WorkspaceV2,
  id: string,
  reservedIds: readonly { entity: string; id: string }[] = [],
): string[] {
  const owners = entityIdOwnerOccurrences(workspace, id, reservedIds);
  return [...new Set(owners)];
}

function entityIdCollision(
  workspace: WorkspaceV2,
  id: string,
  reservedIds: readonly { entity: string; id: string }[] = [],
): string | undefined {
  return entityIdOwners(workspace, id, reservedIds)[0];
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function projectHoldRecordSetIsCanonical(
  workspace: WorkspaceV2,
  hold: ProjectHoldState,
  now: string,
): boolean {
  return (
    isCanonicalIsoTimestamp(hold.createdAt) &&
    Date.parse(hold.createdAt) <= Date.parse(now) &&
    hold.affectedRecordIds.length > 0 &&
    new Set(hold.affectedRecordIds).size === hold.affectedRecordIds.length &&
    hold.affectedRecordIds.every(
      (id) => entityIdOwnerOccurrences(workspace, id).length === 1,
    )
  );
}

function sortedUniqueIds(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
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
        command.decision.projectId,
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
    case "open_sync_conflict":
    case "resolve_sync_conflict":
    case "submit_command_proposal":
    case "accept_command_proposal":
    case "dismiss_command_proposal":
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

function canonicalSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSnapshot);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalSnapshot(item)]),
    );
  }
  return value;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalSnapshot(left)) ===
    JSON.stringify(canonicalSnapshot(right));
}

function jsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function isAcceptedCommandProposalReplanReceipt(
  workspace: WorkspaceV2,
  proposal: ReplanProposal,
  receipt: CommandReceipt,
): Promise<boolean> {
  if (
    receipt.status !== "applied" ||
    receipt.commandType !== "accept_command_proposal" ||
    receipt.actorKind !== "human" ||
    !receipt.source.verified ||
    receipt.baseRevision + 1 !== receipt.revision
  ) return false;
  const statusDiffs = receipt.diff.filter(
    (diff) =>
      diff.entity === "CommandProposal" &&
      diff.field === "status" &&
      diff.before === "open" &&
      diff.after === "accepted",
  );
  const replanCreates = receipt.diff.filter(
    (diff) =>
      diff.entity === "ReplanProposal" &&
      diff.entityId === proposal.id &&
      diff.field === "created" &&
      diff.before === null &&
      sameSnapshot(diff.after, proposal),
  );
  if (statusDiffs.length !== 1 || replanCreates.length !== 1) return false;
  const commandProposalMatches = workspace.commandProposals.filter(
    (candidate) =>
      candidate.id === statusDiffs[0].entityId &&
      candidate.status === "accepted" &&
      candidate.commandType === "propose_replan",
  );
  const commandProposal = commandProposalMatches[0];
  if (commandProposalMatches.length !== 1 || commandProposal === undefined) {
    return false;
  }
  if (
    receipt.baseRevision !== commandProposal.baseRevision + 1 ||
    proposal.baseRevision !== receipt.baseRevision ||
    proposal.createdAt !== receipt.createdAt ||
    proposal.createdBy !== receipt.actorId ||
    !jsonRecord(commandProposal.payload) ||
    commandProposal.payload.type !== "propose_replan" ||
    !jsonRecord(commandProposal.payload.proposal)
  ) return false;
  const submittedProposal = commandProposal.payload.proposal;
  for (const field of [
    "id",
    "localDate",
    "baseCommitmentId",
    "reasonCodes",
    "proposedSlots",
    "status",
  ] as const) {
    if (!sameSnapshot(submittedProposal[field], proposal[field])) return false;
  }
  const submitReceipts = workspace.commandReceipts.filter(
    (candidate) =>
      candidate.status === "applied" &&
      candidate.commandType === "submit_command_proposal" &&
      candidate.baseRevision === commandProposal.baseRevision &&
      candidate.revision === commandProposal.baseRevision + 1,
  );
  const submitReceipt = submitReceipts[0];
  if (
    submitReceipts.length !== 1 ||
    submitReceipt === undefined ||
    submitReceipt.actorKind !== "agent" ||
    submitReceipt.actorId !== commandProposal.agentActorId ||
    submitReceipt.createdAt !== commandProposal.createdAt ||
    !submitReceipt.source.verified ||
    !submitReceipt.source.capabilities.includes("submit_proposal")
  ) return false;
  const openSnapshot = { ...commandProposal, status: "open" as const };
  const submitCreates = submitReceipt.diff.filter(
    (diff) =>
      diff.entity === "CommandProposal" &&
      diff.entityId === commandProposal.id &&
      diff.field === "created" &&
      diff.before === null &&
      sameSnapshot(diff.after, openSnapshot),
  );
  const expectedSubmit = {
    type: "submit_command_proposal",
    proposalId: commandProposal.id,
    command: commandProposal.payload,
    rationale: commandProposal.rationale,
  };
  const expectedAccept = {
    type: "accept_command_proposal",
    proposalId: commandProposal.id,
  };
  const { receiptHash: submitHash, ...submitBase } = submitReceipt;
  const { receiptHash: acceptHash, ...acceptBase } = receipt;
  return (
    submitCreates.length === 1 &&
    submitReceipt.payloadHash ===
      (await stableHash(expectedSubmit as unknown as JsonValue)) &&
    submitHash === (await stableHash(submitBase as unknown as JsonValue)) &&
    receipt.payloadHash ===
      (await stableHash(expectedAccept as unknown as JsonValue)) &&
    acceptHash === (await stableHash(acceptBase as unknown as JsonValue))
  );
}

function protectedRecordSnapshot(
  workspace: Readonly<WorkspaceV2>,
  recordType: "bet" | "daily_commitment" | "review" | "exception" | "close",
  recordId: string,
): JsonValue | undefined {
  const collection = (() => {
    switch (recordType) {
      case "bet":
        return workspace.bets;
      case "daily_commitment":
        return workspace.dailyCommitments;
      case "review":
        return workspace.reviews;
      case "exception":
        return workspace.exceptions;
      case "close":
        return workspace.closeDecisions;
    }
  })();
  const matches = collection.filter(({ id }) => id === recordId);
  return matches.length === 1
    ? structuredClone(matches[0]) as unknown as JsonValue
    : undefined;
}

function hasReviewOverdue(workspace: WorkspaceV2): boolean {
  return workspace.projects.some((project) =>
    project.holds.some(({ type }) => type === "review_overdue"),
  );
}

function proposalTimestampIsFresh(
  generatedAt: string,
  now: string,
): boolean {
  const generated = Date.parse(generatedAt);
  const current = Date.parse(now);
  return (
    Number.isFinite(generated) &&
    Number.isFinite(current) &&
    new Date(generated).toISOString() === generatedAt &&
    new Date(current).toISOString() === now &&
    current >= generated &&
    current - generated <= TODAY_PROPOSAL_MAX_AGE_SECONDS * 1_000
  );
}

function capacityErrorForSlots(
  workspace: WorkspaceV2,
  localDate: string,
  generatedAt: string,
  slots: CommitmentSlot[],
): string | undefined {
  if (workspace.capacityProfile === undefined) {
    return "A Capacity Profile is required before committing Today.";
  }
  try {
    const capacity = capacityForLocalDate(
      workspace.capacityProfile,
      localDate,
    );
    const ledger = createCapacityLedger(
      capacity,
      generatedAt,
      actualAttentionUsageForToday(
        workspace,
        localDate,
        generatedAt,
        capacity.timeZone,
      ),
    );
    const slotIds = new Set<string>();
    for (const slot of slots) {
      if (slotIds.has(slot.id)) {
        return `Daily draft repeats slot ID ${slot.id}.`;
      }
      slotIds.add(slot.id);
      ledger.consume(slot);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Daily draft exceeds available capacity.";
  }
}

function reviewOverdueRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  commandType: "commit_today" | "accept_replan",
): CommandHandlerResult {
  return rejection(workspace, context, "HOLD_BLOCKS_COMMAND", {
    reason: `Portfolio review_overdue freezes new Daily Commitments and blocks ${commandType}.`,
    gate: "project_hold:review_overdue",
    hold: "review_overdue",
    permittedNextCommand: "complete_review",
  });
}

function planBuildRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  error: unknown,
  permittedNextCommand: string,
): CommandHandlerResult {
  if (error instanceof PlanVersionBuildError) {
    return rejection(workspace, context, error.code, {
      reason: error.message,
      gate: error.gate,
      ...(error.hold === undefined ? {} : { hold: error.hold }),
      permittedNextCommand:
        error.permittedNextCommand ??
        (error.code === "SYNC_CONFLICT"
          ? "resolve_sync_conflict"
          : permittedNextCommand),
    });
  }
  throw error;
}

function commandReceiptCollisionRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  permittedNextCommand: string,
): CommandHandlerResult | undefined {
  const collision = entityIdCollision(workspace, context.commandId);
  return collision === undefined
    ? undefined
    : entityAlreadyExists(
        workspace,
        context,
        collision,
        context.commandId,
        permittedNextCommand,
      );
}

function closeArtifactCollisionRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  artifacts: CloseArtifacts,
  permittedNextCommand: "close_project" | "abandon_project",
): CommandHandlerResult | undefined {
  const prospectiveEntities = [
    { entity: "CloseDecision", id: artifacts.decision.id },
    ...artifacts.returnedInboxItems.map(({ id }) => ({
      entity: "InboxItem",
      id,
    })),
    ...(artifacts.followUpProject === undefined
      ? []
      : [{ entity: "ProjectV2", id: artifacts.followUpProject.id }]),
    ...(artifacts.followUpBrief === undefined
      ? []
      : [{ entity: "DirectionBrief", id: artifacts.followUpBrief.id }]),
  ];
  for (const prospective of prospectiveEntities) {
    const collision = entityIdCollision(workspace, prospective.id, [
      { entity: "CommandReceipt", id: context.commandId },
      ...prospectiveEntities.filter((candidate) => candidate !== prospective),
    ]);
    if (collision !== undefined) {
      return entityAlreadyExists(
        workspace,
        context,
        collision,
        prospective.id,
        permittedNextCommand,
      );
    }
  }
  return undefined;
}

type CloseCommandType = "close_project" | "abandon_project";

type PreparedCloseSubject =
  | {
      ok: true;
      project: ProjectV2;
      projectIndex: number;
      currentBet: ExactCurrentCloseBet;
    }
  | { ok: false; result: CommandHandlerResult };

function prepareCloseSubject(
  workspace: WorkspaceV2,
  context: CommandContext,
  projectId: string,
  commandType: CloseCommandType,
): PreparedCloseSubject {
  const receiptCollision = commandReceiptCollisionRejection(
    workspace,
    context,
    commandType,
  );
  if (receiptCollision !== undefined) {
    return { ok: false, result: receiptCollision };
  }
  const matches = workspace.projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => project.id === projectId);
  if (matches.length === 0) {
    return {
      ok: false,
      result: entityNotFound(
        workspace,
        context,
        "ProjectV2",
        projectId,
        "confirm_project_triage",
      ),
    };
  }
  if (matches.length !== 1) {
    return {
      ok: false,
      result: duplicateEntityIdentity(
        workspace,
        context,
        "ProjectV2",
        projectId,
      ),
    };
  }
  const { project, index: projectIndex } = matches[0];
  return {
    ok: true,
    project,
    projectIndex,
    currentBet: selectExactCurrentCloseBet(workspace, project),
  };
}

function closeValidationRejection(
  workspace: WorkspaceV2,
  context: CommandContext,
  issue: CloseValidationIssue,
): CommandHandlerResult {
  return rejection(workspace, context, issue.code, {
    reason: issue.reason,
    gate: issue.gate,
    permittedNextCommand: issue.permittedNextCommand,
  });
}

type PreparedCloseArtifacts =
  | { ok: true; artifacts: CloseArtifacts }
  | { ok: false; result: CommandHandlerResult };

function prepareCloseArtifacts(
  workspace: WorkspaceV2,
  context: CommandContext,
  project: ProjectV2,
  decision: CloseDecisionDraft,
  commandType: CloseCommandType,
): PreparedCloseArtifacts {
  const activeBriefMatches = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (activeBriefMatches.length === 0) {
    return {
      ok: false,
      result: entityNotFound(
        workspace,
        context,
        "DirectionBrief",
        project.activeDirectionBriefId,
        "update_direction",
      ),
    };
  }
  if (activeBriefMatches.length !== 1) {
    return {
      ok: false,
      result: duplicateEntityIdentity(
        workspace,
        context,
        "DirectionBrief",
        project.activeDirectionBriefId,
      ),
    };
  }
  if (activeBriefMatches[0].projectId !== project.id) {
    return {
      ok: false,
      result: entityNotFound(
        workspace,
        context,
        "DirectionBrief",
        project.activeDirectionBriefId,
        "update_direction",
      ),
    };
  }
  const validationIssue = validateCloseDecisionDraft(
    workspace,
    project,
    decision,
    context.actorId,
    context.now,
    commandType,
  );
  if (validationIssue !== undefined) {
    return {
      ok: false,
      result: closeValidationRejection(workspace, context, validationIssue),
    };
  }
  const artifacts = buildCloseArtifacts(
    workspace,
    project,
    decision,
    context.actorId,
    context.now,
  );
  const artifactCollision = closeArtifactCollisionRejection(
    workspace,
    context,
    artifacts,
    commandType,
  );
  if (artifactCollision !== undefined) {
    return { ok: false, result: artifactCollision };
  }
  if (
    workspace.closeDecisions.some(
      ({ projectId }) => projectId === project.id,
    )
  ) {
    return {
      ok: false,
      result: rejection(workspace, context, "SYNC_CONFLICT", {
        reason: `Project ${project.id} already has an ambiguous Close decision.`,
        gate: `project:${project.id}:close_identity`,
        permittedNextCommand: "resolve_sync_conflict",
      }),
    };
  }
  return { ok: true, artifacts };
}

function applyCloseArtifacts(
  workspace: WorkspaceV2,
  projectIndex: number,
  closedProject: ProjectV2,
  artifacts: CloseArtifacts,
): CommandHandlerResult {
  const projects = [...workspace.projects];
  projects[projectIndex] = closedProject;
  if (artifacts.followUpProject !== undefined) {
    projects.push(artifacts.followUpProject);
  }
  return {
    ok: true,
    workspace: {
      ...workspace,
      projects,
      directionBriefs:
        artifacts.followUpBrief === undefined
          ? workspace.directionBriefs
          : [...workspace.directionBriefs, artifacts.followUpBrief],
      inboxItems: [...workspace.inboxItems, ...artifacts.returnedInboxItems],
      closeDecisions: [...workspace.closeDecisions, artifacts.decision],
    },
  };
}

function nonSlotEntityCollisionForSlots(
  workspace: WorkspaceV2,
  slots: CommitmentSlot[],
): { entity: string; id: string } | undefined {
  for (const slot of slots) {
    const entity = entityIdOwners(workspace, slot.id).find(
      (owner) => owner !== "CommitmentSlot",
    );
    if (entity !== undefined) {
      return { entity, id: slot.id };
    }
  }
  return undefined;
}

export async function applyCommandHandler(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext,
): Promise<CommandHandlerResult> {
  if (context.commandId.trim().length === 0) {
    return rejection(workspace, context, "INVALID_COMMAND", {
      reason: "Command ID cannot be empty.",
      gate: "command_context:command_id",
      permittedNextCommand: command.type,
    });
  }
  if (context.actorId.trim().length === 0) {
    return rejection(workspace, context, "INVALID_COMMAND", {
      reason: "Actor ID cannot be empty.",
      gate: "command_context:actor_id",
      permittedNextCommand: command.type,
    });
  }
  if (!isCanonicalIsoTimestamp(context.now)) {
    return rejection(workspace, context, "INVALID_COMMAND", {
      reason: "Command time must be a canonical authoritative timestamp.",
      gate: `command:${context.commandId}:time`,
      permittedNextCommand: command.type,
    });
  }
  const receiptCollision = commandReceiptCollisionRejection(
    workspace,
    context,
    command.type,
  );
  if (receiptCollision !== undefined) return receiptCollision;

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
      const validation = validateCapacityProfile(command.profile);
      if (!validation.ok) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: validation.reason,
          gate: validation.gate,
          permittedNextCommand: "configure_capacity",
        });
      }
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      for (const block of command.profile.unavailableBlocks) {
        if (block.id === context.commandId) {
          return entityAlreadyExists(
            workspace,
            context,
            "UnavailableBlock",
            block.id,
            "configure_capacity",
          );
        }
        const nonUnavailableOwner = entityIdOwners(workspace, block.id).find(
          (owner) => owner !== "UnavailableBlock",
        );
        if (nonUnavailableOwner !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            nonUnavailableOwner,
            block.id,
            "configure_capacity",
          );
        }
      }
      const profile = {
        timeZone: validation.canonicalTimeZone,
        weeklyWindows: command.profile.weeklyWindows.map((window) => ({
          ...window,
        })),
        dailyBudgets: command.profile.dailyBudgets.map((budget) => ({
          ...budget,
        })),
        unavailableBlocks: command.profile.unavailableBlocks.map((block) => ({
          ...block,
        })),
        updatedAt: context.now,
        updatedBy: context.actorId,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          capacityProfile: profile,
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
      const actionsWithIdentity = workspace.actions.filter(
        ({ id }) => id === command.actionId,
      );
      if (actionsWithIdentity.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "Action",
          command.actionId,
          "confirm_action_triage",
        );
      }
      if (actionsWithIdentity.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "Action",
          command.actionId,
        );
      }
      const action = actionsWithIdentity[0];
      const actionIndex = workspace.actions.findIndex(
        ({ id }) => id === action.id,
      );
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
      if (
        !Number.isSafeInteger(command.actualSeconds) ||
        command.actualSeconds <= 0
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Action completion requires positive actual effort.",
          gate: `action_actual:${action.id}`,
          permittedNextCommand: "complete_action",
        });
      }
      const outcomeNote = command.outcomeNote.trim();
      if (outcomeNote.length === 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Action completion requires a concise outcome.",
          gate: `action_outcome:${action.id}`,
          permittedNextCommand: "complete_action",
        });
      }
      const actualId = `${context.commandId}:actual`;
      const actualCollision = entityIdCollision(workspace, actualId, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (actualCollision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          actualCollision,
          actualId,
          "read_existing_command_receipt",
        );
      }
      const actions = [...workspace.actions];
      actions[actionIndex] = {
        ...action,
        revision: action.revision + 1,
        status: "completed",
        resultStatus: command.resultStatus,
        outcomeNote,
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
      if (project.stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${project.id} cannot replace its Direction.`,
          gate: `project:${project.id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
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
      const migrationHolds = project.holds.filter(
        ({ type }) => type === "migration_review",
      );
      const rebetHolds = project.holds.filter(
        ({ type }) => type === "rebet_required",
      );
      const migrationHold = migrationHolds[0];
      const rebetHold = rebetHolds[0];
      const migrationSourceCount = migrationHold === undefined
        ? 0
        : workspace.legacyAuditRecords.filter(
            ({ id, projectId }) =>
              id === migrationHold.sourceId && projectId === project.id,
          ).length + (workspace.migration?.backupId === migrationHold.sourceId ? 1 : 0);
      const rebetSourceCount = rebetHold === undefined
        ? 0
        : workspace.bets.filter(
            ({ id, projectId }) =>
              id === rebetHold.sourceId && projectId === project.id,
          ).length;
      const canonicalMigrationHold =
        project.holds.length === 1 &&
        migrationHolds.length === 1 &&
        migrationSourceCount === 1 &&
        migrationHold!.affectedRecordIds.includes(project.id) &&
        migrationHold!.affectedRecordIds.includes(project.activeDirectionBriefId) &&
        projectHoldRecordSetIsCanonical(workspace, migrationHold!, context.now);
      const canonicalRebetHold =
        project.holds.length === 1 &&
        rebetHolds.length === 1 &&
        rebetSourceCount === 1 &&
        rebetHold!.sourceId === project.activeBetId &&
        rebetHold!.affectedRecordIds.includes(project.id) &&
        rebetHold!.affectedRecordIds.includes(project.activeBetId!) &&
        projectHoldRecordSetIsCanonical(workspace, rebetHold!, context.now);
      const holdsPermitBet = placingFirstBet
        ? project.holds.length === 0 || canonicalMigrationHold
        : canonicalRebetHold;
      if (!holdsPermitBet) {
        return rejection(workspace, context, "HOLD_BLOCKS_COMMAND", {
          reason: placingFirstBet
            ? `Project ${project.id} requires no hold or one canonical migration review before its first Bet.`
            : `Project ${project.id} requires exactly one matching Re-bet hold before replacing its Bet.`,
          gate: `project:${project.id}:bet_holds`,
          permittedNextCommand: "resolve_sync_conflict",
        });
      }
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
      const directionIntegrityIssue = directionSnapshotIntegrityIssue(
        brief,
        context.now,
      );
      if (directionIntegrityIssue !== undefined) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: directionIntegrityIssue,
          gate: `project:${project.id}:direction_integrity`,
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
      let sourceReviewId: string | undefined;
      let replacementReason:
        | "material_direction_change"
        | "appetite_expiry"
        | undefined;
      if (!placingFirstBet && supersededBet !== undefined) {
        const integrityIssue = betIntegrityIssue(supersededBet, context.now);
        if (integrityIssue !== undefined) {
          return rejection(workspace, context, "SYNC_CONFLICT", {
            reason: integrityIssue,
            gate: `project:${project.id}:current_bet_integrity`,
            permittedNextCommand: "resolve_sync_conflict",
          });
        }
        if (supersededBet.invalidatedAt === undefined) {
          replacementReason = "appetite_expiry";
          const reviewSelection = selectCompletedExpiryRebetReview(
            workspace,
            project,
            supersededBet,
            context.now,
          );
          if (!reviewSelection.ok) {
            return rejection(workspace, context, "HOLD_BLOCKS_COMMAND", {
              reason: reviewSelection.reason,
              gate: `project:${project.id}:expiry_review`,
              permittedNextCommand: "complete_review",
            });
          }
          sourceReviewId = reviewSelection.review.id;
        } else {
          replacementReason = "material_direction_change";
        }
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
        ...(replacementReason === undefined ? {} : { replacementReason }),
        ...(sourceReviewId === undefined ? {} : { sourceReviewId }),
      });
      const projects = [...workspace.projects];
      const transitionedProject = { ...transition.project };
      if (!placingFirstBet) {
        delete transitionedProject.activePlanVersionId;
      }
      projects[projectIndex] = {
        ...transitionedProject,
        holds: [],
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
      const replacementProvenanceIssue = placingFirstBet
        ? undefined
        : betReplacementProvenanceIssue(
            { ...workspace, bets: [...bets, bet] },
            bet,
          );
      if (replacementProvenanceIssue !== undefined) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: replacementProvenanceIssue,
          gate: `bet:${bet.id}:replacement_provenance`,
          permittedNextCommand: "resolve_sync_conflict",
        });
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
      if (
        command.workItem.resultStatus !== undefined ||
        command.workItem.outcomeNote !== undefined ||
        command.workItem.percentComplete >= 100
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "A new Work Item cannot bypass completion state or outcome recording.",
          gate: `work_item:${command.workItem.id}:completion_state`,
          permittedNextCommand: "complete_work_item",
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
      const workItemsWithIdentity = workspace.workItems.filter(
        ({ id }) => id === command.workItemId,
      );
      if (workItemsWithIdentity.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      if (workItemsWithIdentity.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
        );
      }
      const workItem = workItemsWithIdentity[0];
      const workItemIndex = workspace.workItems.findIndex(
        ({ id }) => id === workItem.id,
      );
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "update_work_item",
        });
      }
      if (
        Object.prototype.hasOwnProperty.call(command.patch, "resultStatus") ||
        Object.prototype.hasOwnProperty.call(command.patch, "outcomeNote") ||
        (command.patch.percentComplete !== undefined &&
          command.patch.percentComplete >= 100)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Work Item completion state and outcome may only be written by complete_work_item.",
          gate: `work_item:${workItem.id}:completion_state`,
          permittedNextCommand: "complete_work_item",
        });
      }
      if (isConcreteEvidenceRequirement(workItem)) {
        if (
          (Object.prototype.hasOwnProperty.call(
            command.patch,
            "evidenceRequired",
          ) && command.patch.evidenceRequired !== true) ||
          (Object.prototype.hasOwnProperty.call(command.patch, "kind") &&
            command.patch.kind !== "milestone")
        ) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Evidence requirement ${workItem.id} cannot be downgraded or cleared.`,
            gate: `work_item:${workItem.id}:evidence_requirement`,
            permittedNextCommand: "attach_evidence",
          });
        }
        const nextKind = command.patch.kind ?? workItem.kind;
        const nextEvidenceRequired =
          command.patch.evidenceRequired ?? workItem.evidenceRequired;
        if (nextKind !== "milestone" || nextEvidenceRequired !== true) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Evidence requirement ${workItem.id} cannot be downgraded or cleared.`,
            gate: `work_item:${workItem.id}:evidence_requirement`,
            permittedNextCommand: "attach_evidence",
          });
        }
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
      const workItemsWithIdentity = workspace.workItems.filter(
        ({ id }) => id === command.workItemId,
      );
      if (workItemsWithIdentity.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      if (workItemsWithIdentity.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
        );
      }
      const workItem = workItemsWithIdentity[0];
      const workItemIndex = workspace.workItems.findIndex(
        ({ id }) => id === workItem.id,
      );
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "complete_work_item",
        });
      }
      if (workItem.resultStatus !== undefined) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Work Item ${workItem.id} already has an immutable completion result.`,
          gate: `work_item:${workItem.id}:result`,
          permittedNextCommand: "read_completed_work_item",
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
      if (
        !hasActualEffort(
          workspace,
          {
            kind: "work_item",
            workItemId: workItem.id,
          },
          context.now,
        )
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} requires recorded actual effort before completion.`,
          gate: `work_item:${workItem.id}:actual_effort`,
          permittedNextCommand: "record_actual",
        });
      }
      const outcomeNote = command.outcomeNote.trim();
      if (outcomeNote.length === 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} completion requires a concise outcome.`,
          gate: `work_item:${workItem.id}:outcome`,
          permittedNextCommand: command.type,
        });
      }
      if (isConcreteEvidenceRequirement(workItem)) {
        const status = requirementStatus(
          workspace,
          workItem.projectId,
          workItem.id,
          context.now,
        );
        if (!status.satisfied) {
          return rejection(workspace, context, status.code, {
            reason:
              status.code === "EXCEPTION_EXPIRED"
                ? `Evidence exception ${status.exceptionId} expired before Work Item ${workItem.id} completion.`
                : `Work Item ${workItem.id} requires exact linked Evidence or an active evidence exception.`,
            gate: `work_item:${workItem.id}:evidence`,
            permittedNextCommand:
              status.code === "EXCEPTION_EXPIRED"
                ? "approve_evidence_exception"
                : "attach_evidence",
          });
        }
      }
      const workItems = [...workspace.workItems];
      workItems[workItemIndex] = {
        ...workItem,
        revision: workItem.revision + 1,
        resultStatus: command.resultStatus,
        outcomeNote,
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
      const workItemsWithIdentity = workspace.workItems.filter(
        ({ id }) => id === command.workItemId,
      );
      if (workItemsWithIdentity.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
          "create_work_item",
        );
      }
      if (workItemsWithIdentity.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ProjectWorkItem",
          command.workItemId,
        );
      }
      const workItem = workItemsWithIdentity[0];
      if (workItem.projectId !== access.project.id) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Work Item ${workItem.id} does not belong to Project ${access.project.id}.`,
          gate: `work_item:${workItem.id}:project`,
          permittedNextCommand: "remove_work_item",
        });
      }
      if (isConcreteEvidenceRequirement(workItem)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Evidence requirement ${workItem.id} cannot be deleted or cleared.`,
          gate: `work_item:${workItem.id}:evidence_requirement`,
          permittedNextCommand: "attach_evidence",
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

    case "commit_today": {
      if (hasReviewOverdue(workspace)) {
        return reviewOverdueRejection(workspace, context, command.type);
      }
      if (workspace.capacityProfile === undefined) {
        return rejection(workspace, context, "CAPACITY_EXCEEDED", {
          reason: "Configure capacity before committing Today.",
          gate: "capacity_profile:required",
          permittedNextCommand: "configure_capacity",
        });
      }
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const slotCollision = nonSlotEntityCollisionForSlots(
        workspace,
        command.commitment.slots,
      );
      if (slotCollision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          slotCollision.entity,
          slotCollision.id,
          "commit_today",
        );
      }
      if (command.commitment.workspaceRevision !== workspace.revision) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Today draft revision ${command.commitment.workspaceRevision} does not match Workspace revision ${workspace.revision}.`,
          gate: "today_proposal:workspace_revision",
          permittedNextCommand: "regenerate_today",
        });
      }
      if (
        !proposalTimestampIsFresh(command.commitment.generatedAt, context.now) ||
        localDateAt(
          command.commitment.generatedAt,
          workspace.capacityProfile.timeZone,
        ) !== command.commitment.localDate ||
        localDateAt(context.now, workspace.capacityProfile.timeZone) !==
          command.commitment.localDate
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Today proposal is no longer fresh for the current local date.",
          gate: "today_proposal:freshness",
          permittedNextCommand: "regenerate_today",
        });
      }
      if (
        workspace.dailyCommitments.some(
          ({ localDate }) => localDate === command.commitment.localDate,
        )
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Today ${command.commitment.localDate} is already committed; changes require a Replan.`,
          gate: `daily_commitment:${command.commitment.localDate}:already_committed`,
          permittedNextCommand: "propose_replan",
        });
      }
      const receiptReservation = [
        { entity: "CommandReceipt", id: context.commandId },
      ];
      const draftReservations = [
        ...receiptReservation,
        ...command.commitment.slots.map(({ id }) => ({
          entity: "CommitmentSlot",
          id,
        })),
      ];
      if (
        command.commitment.slots.some(({ id }) => id === context.commandId)
      ) {
        return entityAlreadyExists(
          workspace,
          context,
          "CommitmentSlot",
          context.commandId,
          "commit_today",
        );
      }
      const commitmentCollision = entityIdCollision(
        workspace,
        command.commitment.id,
        draftReservations,
      );
      if (commitmentCollision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          commitmentCollision,
          command.commitment.id,
          "commit_today",
        );
      }
      const committedProjectIds = [
        ...new Set(
          command.commitment.slots.flatMap(({ target }) =>
            target.kind === "work_item" ? [target.projectId] : [],
          ),
        ),
      ].sort();
      for (const projectId of committedProjectIds) {
        const access = resolvePlanningContext(
          workspace,
          projectId,
          context.now,
          command.type,
        );
        if (!access.ok) {
          return planningAccessRejection(workspace, context, access);
        }
      }
      const capacityError = capacityErrorForSlots(
        workspace,
        command.commitment.localDate,
        command.commitment.generatedAt,
        command.commitment.slots,
      );
      if (capacityError !== undefined) {
        return rejection(workspace, context, "CAPACITY_EXCEEDED", {
          reason: capacityError,
          gate: `daily_commitment:${command.commitment.id}:capacity`,
          permittedNextCommand: "edit_today_draft",
        });
      }

      let authoritative;
      try {
        authoritative = await generateTodayProposal(
          workspace,
          command.commitment.localDate,
          command.commitment.generatedAt,
        );
      } catch (error) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            error instanceof Error
              ? error.message
              : "Today proposal could not be regenerated.",
          gate: "today_proposal:freshness",
          permittedNextCommand: "regenerate_today",
        });
      }
      if (
        authoritative.workspaceRevision !== command.commitment.workspaceRevision ||
        authoritative.generatedAt !== command.commitment.generatedAt ||
        (!isBoundedSemanticReplay(context, "commit_today") &&
          authoritative.proposalHash !== command.commitment.proposalHash) ||
        !sameSnapshot(authoritative.slots, command.commitment.slots)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Today draft does not match its authoritative fresh proposal.",
          gate: "today_proposal:freshness",
          permittedNextCommand: "regenerate_today",
        });
      }

      let planBuild;
      try {
        planBuild = await buildPlanVersionsForCommitment(
          workspace,
          authoritative.slots,
          command.commitment.id,
          context.actorId,
          context.now,
          "initial",
        );
      } catch (error) {
        return planBuildRejection(
          workspace,
          context,
          error,
          "regenerate_today",
        );
      }
      const reservedIds = [
        ...draftReservations,
        { entity: "DailyCommitment", id: command.commitment.id },
      ];
      for (const plan of planBuild.plans) {
        const collision = entityIdCollision(workspace, plan.id, reservedIds);
        if (collision !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            collision,
            plan.id,
            "commit_today",
          );
        }
        reservedIds.push({ entity: "PlanVersion", id: plan.id });
      }
      const commitment: DailyCommitment = {
        id: command.commitment.id,
        localDate: command.commitment.localDate,
        version: 1,
        proposalHash: command.commitment.proposalHash,
        capacitySnapshot: structuredClone(workspace.capacityProfile),
        slots: structuredClone(authoritative.slots),
        actorId: context.actorId,
        committedAt: context.now,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          projects: planBuild.projects,
          planVersions: [...workspace.planVersions, ...planBuild.plans],
          dailyCommitments: [...workspace.dailyCommitments, commitment],
        },
      };
    }

    case "propose_replan": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const proposal = command.proposal;
      const slotCollision = nonSlotEntityCollisionForSlots(
        workspace,
        proposal.proposedSlots,
      );
      if (slotCollision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          slotCollision.entity,
          slotCollision.id,
          "propose_replan",
        );
      }
      if (proposal.status !== "open") {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Only an open Replan Proposal may be recorded.",
          gate: `replan:${proposal.id}:status`,
          permittedNextCommand: "propose_replan",
        });
      }
      if (
        proposal.baseRevision !== workspace.revision &&
        !isBoundedSemanticReplay(context, "propose_replan")
      ) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Replan base revision ${proposal.baseRevision} does not match Workspace revision ${workspace.revision}.`,
          gate: `replan:${proposal.id}:base_revision`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        proposal.createdBy !== context.actorId ||
        !proposalTimestampIsFresh(proposal.createdAt, context.now) ||
        workspace.capacityProfile === undefined ||
        localDateAt(proposal.createdAt, workspace.capacityProfile.timeZone) !==
          proposal.localDate ||
        localDateAt(context.now, workspace.capacityProfile.timeZone) !==
          proposal.localDate ||
        proposal.reasonCodes.length === 0 ||
        !sameSnapshot(
          proposal.reasonCodes,
          canonicalReplanReasonCodes(proposal.reasonCodes),
        )
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Replan Proposal metadata is stale or invalid.",
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const baseCommitment = soleCommitmentLeafForLocalDate(
        workspace,
        proposal.localDate,
      );
      if (
        baseCommitment === undefined ||
        baseCommitment.id !== proposal.baseCommitmentId
      ) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: "Replan does not target the sole current Daily Commitment.",
          gate: `replan:${proposal.id}:base_commitment`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (Date.parse(proposal.createdAt) < Date.parse(baseCommitment.committedAt)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} cannot predate its base Daily Commitment.`,
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const proposalReservations = [
        { entity: "CommandReceipt", id: context.commandId },
        ...proposal.proposedSlots.map(({ id }) => ({
          entity: "CommitmentSlot",
          id,
        })),
      ];
      if (proposal.proposedSlots.some(({ id }) => id === context.commandId)) {
        return entityAlreadyExists(
          workspace,
          context,
          "CommitmentSlot",
          context.commandId,
          "propose_replan",
        );
      }
      const collision = entityIdCollision(
        workspace,
        proposal.id,
        proposalReservations,
      );
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          proposal.id,
          "propose_replan",
        );
      }
      const frozenReviewProposal =
        hasReviewOverdue(workspace) &&
        sameSnapshot(baseCommitment.slots, proposal.proposedSlots);
      const capacityError = frozenReviewProposal
        ? undefined
        : capacityErrorForSlots(
            workspace,
            proposal.localDate,
            proposal.createdAt,
            proposal.proposedSlots,
          );
      if (capacityError !== undefined) {
        return rejection(workspace, context, "CAPACITY_EXCEEDED", {
          reason: capacityError,
          gate: `replan:${proposal.id}:capacity`,
          permittedNextCommand: "edit_today_draft",
        });
      }
      let authoritative;
      try {
        authoritative = await generateTodayProposal(
          workspace,
          proposal.localDate,
          proposal.createdAt,
        );
      } catch (error) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            error instanceof Error
              ? error.message
              : "Replan could not be regenerated.",
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        (!isBoundedSemanticReplay(context, "propose_replan") &&
          authoritative.proposalHash !== proposal.proposalHash) ||
        !sameSnapshot(authoritative.slots, proposal.proposedSlots)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Replan does not match the authoritative current proposal.",
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        !hasReviewOverdue(workspace) &&
        !(await replanHasMaterialChange(
          workspace,
          baseCommitment,
          authoritative,
        ))
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} does not contain a material change from the current Daily Commitment.`,
          gate: `replan:${proposal.id}:material_change`,
          permittedNextCommand: "keep_current_commitment",
        });
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          replanProposals: [
            ...workspace.replanProposals,
            structuredClone(proposal),
          ],
        },
      };
    }

    case "accept_replan": {
      if (hasReviewOverdue(workspace)) {
        return reviewOverdueRejection(workspace, context, command.type);
      }
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const matching = workspace.replanProposals.filter(
        ({ id }) => id === command.proposalId,
      );
      if (matching.length !== 1) {
        return entityNotFound(
          workspace,
          context,
          "ReplanProposal",
          command.proposalId,
          "propose_replan",
        );
      }
      const proposal = matching[0];
      if (proposal.status !== "open") {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} is not open.`,
          gate: `replan:${proposal.id}:status`,
          permittedNextCommand: "propose_replan",
        });
      }
      if (command.commitmentId === proposal.baseCommitmentId) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Accepting a Replan must create a new Daily Commitment ID.",
          gate: `replan:${proposal.id}:commitment_id`,
          permittedNextCommand: "accept_replan",
        });
      }
      const receiptReservation = [
        { entity: "CommandReceipt", id: context.commandId },
      ];
      const commitmentCollision = entityIdCollision(
        workspace,
        command.commitmentId,
        receiptReservation,
      );
      if (commitmentCollision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          commitmentCollision,
          command.commitmentId,
          "accept_replan",
        );
      }
      const semanticCreationReceipts = workspace.commandReceipts.filter(
        (receipt) =>
          receipt.status === "applied" &&
          receipt.commandType === "propose_replan" &&
          isBoundedSemanticReceipt(receipt, "propose_replan") &&
          receipt.diff.length === 1 &&
          receipt.diff[0].entity === "ReplanProposal" &&
          receipt.diff[0].entityId === proposal.id &&
          receipt.diff[0].field === "created" &&
          sameSnapshot(receipt.diff[0].after, proposal),
      );
      const semanticCreationReceipt = semanticCreationReceipts[0];
      if (semanticCreationReceipts.length > 1) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} has ambiguous semantic creation authority.`,
          gate: `replan:${proposal.id}:creation_receipt`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const creationBaseRevision =
        semanticCreationReceipt?.baseRevision ?? proposal.baseRevision;
      if (workspace.revision !== creationBaseRevision + 1) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Replan Proposal ${proposal.id} is stale after an intervening Workspace revision.`,
          gate: `replan:${proposal.id}:base_revision`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const directRevisionReceipts = workspace.commandReceipts.filter(
        (receipt) =>
          receipt.status === "applied" &&
          receipt.baseRevision === creationBaseRevision &&
          receipt.revision === creationBaseRevision + 1,
      );
      const creationReceipt = directRevisionReceipts[0];
      const isDirectReplanCreation =
        creationReceipt !== undefined &&
        creationReceipt.commandType === "propose_replan" &&
        creationReceipt.diff.length === 1 &&
        creationReceipt.diff[0].entity === "ReplanProposal" &&
        creationReceipt.diff[0].entityId === proposal.id &&
        creationReceipt.diff[0].field === "created" &&
        creationReceipt.diff[0].before === null &&
        sameSnapshot(creationReceipt.diff[0].after, proposal);
      const isAcceptedProposalCreation =
        creationReceipt === undefined
          ? false
          : await isAcceptedCommandProposalReplanReceipt(
              workspace,
              proposal,
              creationReceipt,
            );
      if (
        directRevisionReceipts.length !== 1 ||
        creationReceipt === undefined ||
        (!isDirectReplanCreation && !isAcceptedProposalCreation)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} lacks its unique direct creation receipt.`,
          gate: `replan:${proposal.id}:creation_receipt`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const { receiptHash, ...receiptBase } = creationReceipt;
      const directReceiptHashIsValid =
        !isDirectReplanCreation ||
        (creationReceipt.payloadHash ===
          (await stableHash({
            type: "propose_replan",
            proposal,
          } as unknown as JsonValue)) &&
          receiptHash ===
            (await stableHash(receiptBase as unknown as JsonValue)));
      if (!directReceiptHashIsValid) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} has an invalid creation receipt hash.`,
          gate: `replan:${proposal.id}:creation_receipt`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        workspace.capacityProfile === undefined ||
        !proposalTimestampIsFresh(proposal.createdAt, context.now) ||
        localDateAt(proposal.createdAt, workspace.capacityProfile.timeZone) !==
          proposal.localDate ||
        localDateAt(context.now, workspace.capacityProfile.timeZone) !==
          proposal.localDate
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} is no longer fresh.`,
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const baseCommitment = soleCommitmentLeafForLocalDate(
        workspace,
        proposal.localDate,
      );
      if (
        baseCommitment === undefined ||
        baseCommitment.id !== proposal.baseCommitmentId
      ) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: "Replan base Daily Commitment is no longer current.",
          gate: `replan:${proposal.id}:base_commitment`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (Date.parse(proposal.createdAt) < Date.parse(baseCommitment.committedAt)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} cannot predate its base Daily Commitment.`,
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      const capacityError = capacityErrorForSlots(
        workspace,
        proposal.localDate,
        proposal.createdAt,
        proposal.proposedSlots,
      );
      if (capacityError !== undefined) {
        return rejection(workspace, context, "CAPACITY_EXCEEDED", {
          reason: capacityError,
          gate: `replan:${proposal.id}:capacity`,
          permittedNextCommand: "edit_today_draft",
        });
      }
      const proposalWorkspace: WorkspaceV2 = {
        ...workspace,
        revision: proposal.baseRevision,
      };
      let authoritative;
      try {
        authoritative = await generateTodayProposal(
          proposalWorkspace,
          proposal.localDate,
          proposal.createdAt,
        );
      } catch (error) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            error instanceof Error
              ? error.message
              : "Replan could not be regenerated.",
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        authoritative.proposalHash !== proposal.proposalHash ||
        !sameSnapshot(authoritative.slots, proposal.proposedSlots)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Replan Proposal does not match its authoritative snapshot.",
          gate: `replan:${proposal.id}:freshness`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      if (
        !(await replanHasMaterialChange(
          proposalWorkspace,
          baseCommitment,
          authoritative,
        ))
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Replan Proposal ${proposal.id} does not contain a material change from the current Daily Commitment.`,
          gate: `replan:${proposal.id}:material_change`,
          permittedNextCommand: "keep_current_commitment",
        });
      }

      let planBuild;
      try {
        planBuild = await buildPlanVersionsForCommitment(
          workspace,
          proposal.proposedSlots,
          command.commitmentId,
          context.actorId,
          context.now,
          "replan",
          [
            ...new Set(
              baseCommitment.slots.flatMap(({ target }) =>
                target.kind === "work_item" ? [target.projectId] : [],
              ),
            ),
          ],
        );
      } catch (error) {
        return planBuildRejection(
          workspace,
          context,
          error,
          "regenerate_replan",
        );
      }
      const reservedIds = [
        ...receiptReservation,
        { entity: "DailyCommitment", id: command.commitmentId },
      ];
      for (const plan of planBuild.plans) {
        const collision = entityIdCollision(workspace, plan.id, reservedIds);
        if (collision !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            collision,
            plan.id,
            "accept_replan",
          );
        }
        reservedIds.push({ entity: "PlanVersion", id: plan.id });
      }
      const commitment: DailyCommitment = {
        id: command.commitmentId,
        localDate: proposal.localDate,
        version: baseCommitment.version + 1,
        proposalHash: proposal.proposalHash,
        capacitySnapshot: structuredClone(workspace.capacityProfile),
        slots: structuredClone(proposal.proposedSlots),
        actorId: context.actorId,
        committedAt: context.now,
        supersedesId: baseCommitment.id,
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          projects: planBuild.projects,
          planVersions: [...workspace.planVersions, ...planBuild.plans],
          dailyCommitments: [...workspace.dailyCommitments, commitment],
          replanProposals: workspace.replanProposals.map((candidate) =>
            candidate.id === proposal.id
              ? { ...candidate, status: "accepted" }
              : candidate,
          ),
        },
      };
    }

    case "record_actual": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      if (command.actual.id.trim().length === 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Actual ID cannot be empty.",
          gate: `actual:${command.actual.id}:id`,
          permittedNextCommand: command.type,
        });
      }
      const collision = entityIdCollision(workspace, command.actual.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.actual.id,
          command.type,
        );
      }
      if (command.actual.revision !== 1) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "A new append-only Actual must start at revision 1.",
          gate: `actual:${command.actual.id}:revision`,
          permittedNextCommand: command.type,
        });
      }
      if (
        !Number.isSafeInteger(command.actual.actualWorkSeconds) ||
        command.actual.actualWorkSeconds <= 0
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Actual work seconds must be a positive safe integer.",
          gate: `actual:${command.actual.id}:actualWorkSeconds`,
          permittedNextCommand: command.type,
        });
      }
      if (
        !Number.isSafeInteger(command.actual.remainingWorkSeconds) ||
        command.actual.remainingWorkSeconds < 0
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Remaining work seconds must be a nonnegative safe integer.",
          gate: `actual:${command.actual.id}:remainingWorkSeconds`,
          permittedNextCommand: command.type,
        });
      }
      if (
        !Number.isFinite(command.actual.actualCost) ||
        command.actual.actualCost < 0 ||
        command.actual.actualCost > Number.MAX_SAFE_INTEGER
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Actual cost must be a nonnegative safe number.",
          gate: `actual:${command.actual.id}:actualCost`,
          permittedNextCommand: command.type,
        });
      }
      const actualStart = command.actual.actualStart;
      const actualFinish = command.actual.actualFinish;
      const recordedAt = command.actual.recordedAt;
      const timestampsAreCanonical =
        isCanonicalIsoTimestamp(recordedAt) &&
        (actualStart === undefined || isCanonicalIsoTimestamp(actualStart)) &&
        (actualFinish === undefined || isCanonicalIsoTimestamp(actualFinish));
      const timestampsAreOrdered =
        (actualStart === undefined ||
          Date.parse(actualStart) <= Date.parse(recordedAt)) &&
        (actualFinish === undefined ||
          Date.parse(actualFinish) <= Date.parse(recordedAt)) &&
        (actualStart === undefined ||
          actualFinish === undefined ||
          Date.parse(actualStart) <= Date.parse(actualFinish)) &&
        Date.parse(recordedAt) <= Date.parse(context.now);
      if (!timestampsAreCanonical || !timestampsAreOrdered) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Actual timestamps must be canonical, ordered, and no later than the command time.",
          gate: `actual:${command.actual.id}:timestamps`,
          permittedNextCommand: command.type,
        });
      }
      if (command.actual.target.kind === "action") {
        const actionId = command.actual.target.actionId;
        const actions = workspace.actions.filter(
          ({ id }) => id === actionId,
        );
        if (actions.length === 0) {
          return entityNotFound(
            workspace,
            context,
            "Action",
            actionId,
            "confirm_action_triage",
          );
        }
        if (actions.length !== 1) {
          return rejection(workspace, context, "SYNC_CONFLICT", {
            reason: `Actual ${command.actual.id} target Action ${actionId} is duplicated.`,
            gate: `actual:${command.actual.id}:target`,
            permittedNextCommand: "resolve_sync_conflict",
          });
        }
      } else {
        const workItemId = command.actual.target.workItemId;
        const workItems = workspace.workItems.filter(
          ({ id }) => id === workItemId,
        );
        if (workItems.length === 0) {
          return entityNotFound(
            workspace,
            context,
            "ProjectWorkItem",
            workItemId,
            "create_work_item",
          );
        }
        if (workItems.length !== 1) {
          return rejection(workspace, context, "SYNC_CONFLICT", {
            reason: `Actual ${command.actual.id} target Work Item ${workItemId} is duplicated.`,
            gate: `actual:${command.actual.id}:target`,
            permittedNextCommand: "resolve_sync_conflict",
          });
        }
        const workItem = workItems[0];
        const access = resolvePlanningContext(
          workspace,
          workItem.projectId,
          context.now,
          command.type,
        );
        if (!access.ok) {
          return planningAccessRejection(workspace, context, access);
        }
        if (
          !access.bet.committedScope.some(({ id }) => id === workItem.betScopeId)
        ) {
          return scopeOutsideBet(
            workspace,
            context,
            workItem.projectId,
            access.bet.id,
            workItem.betScopeId,
          );
        }
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          actuals: [...workspace.actuals, structuredClone(command.actual)],
        },
      };
    }

    case "attach_evidence": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      if (
        command.evidence.id.trim().length === 0 ||
        command.evidence.summary.trim().length === 0 ||
        command.evidence.projectId.trim().length === 0 ||
        (command.evidence.workItemId !== undefined &&
          command.evidence.workItemId.trim().length === 0) ||
        (command.evidence.url !== undefined &&
          command.evidence.url.trim().length === 0) ||
        (command.evidence.localFileRef !== undefined &&
          command.evidence.localFileRef.trim().length === 0)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Evidence requires non-empty identity, summary, ownership, and optional reference fields.",
          gate: `evidence:${command.evidence.id}:details`,
          permittedNextCommand: command.type,
        });
      }
      if (
        command.evidence.confidence < 0 ||
        command.evidence.confidence > 1
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Evidence confidence must be between zero and one.",
          gate: `evidence:${command.evidence.id}:confidence`,
          permittedNextCommand: command.type,
        });
      }
      if (
        !isCanonicalIsoTimestamp(context.now) ||
        !isCanonicalIsoTimestamp(command.evidence.createdAt) ||
        Date.parse(command.evidence.createdAt) > Date.parse(context.now)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Evidence creation time must be canonical and no later than the command time.",
          gate: `evidence:${command.evidence.id}:created_at`,
          permittedNextCommand: command.type,
        });
      }
      const normalizedTags = command.evidence.tags.map((tag) => tag.trim());
      if (
        normalizedTags.some((tag) => tag.length === 0) ||
        normalizedTags.some(
          (tag, index) => tag !== command.evidence.tags[index],
        ) ||
        new Set(normalizedTags).size !== normalizedTags.length
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Evidence tags must be non-empty, trimmed, and unique.",
          gate: `evidence:${command.evidence.id}:tags`,
          permittedNextCommand: command.type,
        });
      }
      const collision = entityIdCollision(workspace, command.evidence.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.evidence.id,
          command.type,
        );
      }
      const projects = workspace.projects.filter(
        ({ id }) => id === command.evidence.projectId,
      );
      if (projects.length !== 1) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.evidence.projectId,
          "confirm_project_triage",
        );
      }
      if (projects[0].stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${projects[0].id} cannot accept new Evidence.`,
          gate: `project:${projects[0].id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      if (command.evidence.workItemId !== undefined) {
        const workItems = workspace.workItems.filter(
          ({ id, projectId }) =>
            id === command.evidence.workItemId &&
            projectId === command.evidence.projectId,
        );
        if (workItems.length !== 1) {
          return entityNotFound(
            workspace,
            context,
            "ProjectWorkItem",
            command.evidence.workItemId,
            "create_work_item",
          );
        }
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          evidence: [...workspace.evidence, structuredClone(command.evidence)],
        },
      };
    }

    case "approve_evidence_exception": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const collision = entityIdCollision(workspace, command.exception.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.exception.id,
          command.type,
        );
      }
      const projects = workspace.projects.filter(
        ({ id }) => id === command.exception.projectId,
      );
      if (projects.length !== 1) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.exception.projectId,
          "confirm_project_triage",
        );
      }
      if (projects[0].stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${projects[0].id} cannot approve an evidence exception.`,
          gate: `project:${projects[0].id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      const rationale = command.exception.rationale.trim();
      const knownConsequence = command.exception.knownConsequence.trim();
      if (
        command.exception.id.trim().length === 0 ||
        rationale.length === 0 ||
        knownConsequence.length === 0
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "An evidence exception requires an ID, rationale, and known consequence.",
          gate: `exception:${command.exception.id}:details`,
          permittedNextCommand: command.type,
        });
      }
      const reviewAt = command.exception.reviewAt;
      const expiresAt = command.exception.expiresAt;
      if (
        !isCanonicalIsoTimestamp(reviewAt) ||
        !isCanonicalIsoTimestamp(expiresAt) ||
        !isCanonicalIsoTimestamp(context.now) ||
        Date.parse(context.now) > Date.parse(reviewAt) ||
        Date.parse(reviewAt) >= Date.parse(expiresAt) ||
        Date.parse(context.now) >= Date.parse(expiresAt)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "An evidence exception requires canonical dates with creation <= review < expiry and a future expiry.",
          gate: `exception:${command.exception.id}:window`,
          permittedNextCommand: command.type,
        });
      }
      const requirements = workspace.workItems.filter(
        (item) =>
          item.id === command.exception.requirementId &&
          item.projectId === command.exception.projectId &&
          isConcreteEvidenceRequirement(item),
      );
      if (requirements.length !== 1) {
        return rejection(workspace, context, "EVIDENCE_REQUIRED", {
          reason: `Exception ${command.exception.id} must target one exact same-project evidence-required milestone.`,
          gate: `exception:${command.exception.id}:requirement`,
          permittedNextCommand: "create_work_item",
        });
      }
      const record: ExceptionRecord = {
        id: command.exception.id,
        projectId: command.exception.projectId,
        requirementId: command.exception.requirementId,
        rationale,
        knownConsequence,
        reviewAt,
        expiresAt,
        approvedBy: context.actorId,
        createdAt: context.now,
        history: [
          {
            action: "created" as const,
            actorId: context.actorId,
            at: context.now,
            note: rationale,
          },
        ],
      };
      return {
        ok: true,
        workspace: {
          ...workspace,
          exceptions: [...workspace.exceptions, record],
        },
      };
    }

    case "resolve_evidence_exception": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const matches = workspace.exceptions
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => record.id === command.exceptionId);
      if (matches.length !== 1) {
        return entityNotFound(
          workspace,
          context,
          "ExceptionRecord",
          command.exceptionId,
          "approve_evidence_exception",
        );
      }
      const { record, index } = matches[0];
      const project = workspace.projects.find(({ id }) => id === record.projectId);
      if (project?.stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${project.id} cannot mutate Exception ${record.id}.`,
          gate: `project:${project.id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      if (record.resolvedAt !== undefined) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Exception ${record.id} is already resolved.`,
          gate: `exception:${record.id}:resolution`,
          permittedNextCommand: "read_resolved_exception",
        });
      }
      const resolution = command.resolution.trim();
      if (
        resolution.length === 0 ||
        !isCanonicalIsoTimestamp(context.now) ||
        Date.parse(context.now) < Date.parse(record.createdAt)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "Exception resolution requires a non-empty note at or after creation.",
          gate: `exception:${record.id}:resolution`,
          permittedNextCommand: command.type,
        });
      }
      const exceptions = [...workspace.exceptions];
      exceptions[index] = {
        ...record,
        resolvedAt: context.now,
        history: [
          ...record.history.map((entry) => structuredClone(entry)),
          {
            action: "resolved",
            actorId: context.actorId,
            at: context.now,
            note: resolution,
          },
        ],
      };
      return { ok: true, workspace: { ...workspace, exceptions } };
    }

    case "request_validation": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const access = resolvePlanningContext(
        workspace,
        command.projectId,
        context.now,
        command.type,
      );
      if (!access.ok) {
        return planningAccessRejection(workspace, context, access);
      }
      const projectIndex = workspace.projects.findIndex(
        ({ id }) => id === access.project.id,
      );
      const event =
        access.project.stage === "planning"
          ? "closure_requested"
          : "validation_requested";
      const transition = transitionLifecycle(access.project, event);
      if (!transition.ok) {
        return rejection(workspace, context, transition.code, {
          reason: `Project ${access.project.id} cannot request validation from ${access.project.stage}.`,
          gate: `project:${access.project.id}:stage:${access.project.stage}`,
          permittedNextCommand: "use_legal_lifecycle_command",
        });
      }
      const projects = [...workspace.projects];
      projects[projectIndex] = {
        ...transition.project,
        updatedAt: context.now,
      };
      return { ok: true, workspace: { ...workspace, projects } };
    }

    case "satisfy_validation": {
      const receiptCollision = commandReceiptCollisionRejection(
        workspace,
        context,
        command.type,
      );
      if (receiptCollision !== undefined) return receiptCollision;
      const matches = workspace.projects
        .map((project, index) => ({ project, index }))
        .filter(({ project }) => project.id === command.projectId);
      if (matches.length !== 1) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      const { project, index } = matches[0];
      if (project.stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${project.id} cannot satisfy validation.`,
          gate: `project:${project.id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      if (project.stage !== "validating") {
        return rejection(workspace, context, "ILLEGAL_LIFECYCLE_TRANSITION", {
          reason: `Project ${project.id} cannot satisfy validation from ${project.stage}.`,
          gate: `project:${project.id}:stage:${project.stage}`,
          permittedNextCommand: "request_validation",
        });
      }
      const requirements = workspace.workItems
        .filter(
          (item) =>
            item.projectId === project.id &&
            isConcreteEvidenceRequirement(item),
        )
        .sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
        );
      for (const requirement of requirements) {
        const status = requirementStatus(
          workspace,
          project.id,
          requirement.id,
          context.now,
        );
        if (!status.satisfied) {
          return rejection(workspace, context, status.code, {
            reason:
              status.code === "EXCEPTION_EXPIRED"
                ? `Evidence exception ${status.exceptionId} expired before Project ${project.id} validation was satisfied.`
                : `Project ${project.id} requires exact Evidence or an active exception for milestone ${requirement.id}.`,
            gate: `project:${project.id}:requirement:${requirement.id}`,
            permittedNextCommand:
              status.code === "EXCEPTION_EXPIRED"
                ? "approve_evidence_exception"
                : "attach_evidence",
          });
        }
      }
      const transition = transitionLifecycle(project, "validation_satisfied");
      if (!transition.ok) {
        return rejection(workspace, context, transition.code, {
          reason: `Project ${project.id} cannot satisfy validation from ${project.stage}.`,
          gate: `project:${project.id}:stage:${project.stage}`,
          permittedNextCommand: "request_validation",
        });
      }
      const projects = [...workspace.projects];
      projects[index] = { ...transition.project, updatedAt: context.now };
      return { ok: true, workspace: { ...workspace, projects } };
    }

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

    case "create_review": {
      const matchingOccurrences = workspace.reviews.filter(
        ({ triggerKey }) => triggerKey === command.review.triggerKey,
      );
      if (matchingOccurrences.length > 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ReviewTrigger",
          command.review.triggerKey,
        );
      }
      if (matchingOccurrences.length === 1) {
        return rejection(workspace, context, "DUPLICATE_COMMAND", {
          reason: `Review occurrence ${command.review.triggerKey} is already persisted.`,
          gate: `review_trigger:${command.review.triggerKey}`,
          permittedNextCommand: "read_existing_review",
        });
      }
      const derivedMatches = deriveReviewQueue(workspace, context.now).filter(
        ({ triggerKey }) => triggerKey === command.review.triggerKey,
      );
      const exactDerived = derivedMatches.length === 1 &&
        (await stableHash(command.review as unknown as JsonValue)) ===
          (await stableHash(derivedMatches[0] as unknown as JsonValue));
      if (!exactDerived) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Review ${command.review.id} must exactly match one currently derived occurrence.`,
          gate: `review:${command.review.id}:derivation`,
          permittedNextCommand: command.type,
        });
      }
      const collision = entityIdCollision(workspace, command.review.id, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.review.id,
          command.type,
        );
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          reviews: [
            ...workspace.reviews,
            {
              ...structuredClone(command.review),
              status: "open",
              createdAt: context.now,
            },
          ],
        },
      };
    }

    case "mark_review_overdue": {
      const matches = workspace.reviews
        .map((review, index) => ({ review, index }))
        .filter(({ review }) => review.id === command.reviewId);
      if (matches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
          "create_review",
        );
      }
      if (matches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
        );
      }
      const { review, index: reviewIndex } = matches[0];
      if (review.status !== "open") {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Review ${review.id} is already completed.`,
          gate: `review:${review.id}:status`,
          permittedNextCommand: "read_completed_review",
        });
      }
      if (review.overdueMarkedAt !== undefined) {
        return rejection(workspace, context, "DUPLICATE_COMMAND", {
          reason: `Review ${review.id} is already marked overdue.`,
          gate: `review:${review.id}:overdue`,
          permittedNextCommand: "complete_review",
        });
      }
      const expectedTriggerKey = reviewOverdueTriggerKey(review);
      if (
        command.triggerKey !== expectedTriggerKey ||
        !isCanonicalIsoTimestamp(review.dueAt) ||
        Date.parse(context.now) < Date.parse(review.dueAt)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Review ${review.id} is not due for exact overdue trigger ${expectedTriggerKey}.`,
          gate: `review:${review.id}:overdue`,
          permittedNextCommand: command.type,
        });
      }
      const projectIds = reviewAffectedActiveProjectIds(workspace, review);
      const affectedRecordIds = sortedUniqueIds([
        review.id,
        ...review.affectedRecordIds,
      ]);
      const affectedProjects: Array<{
        project: ProjectV2;
        index: number;
        alreadyHeld: boolean;
      }> = [];
      for (const projectId of projectIds) {
        const projectMatches = workspace.projects
          .map((project, index) => ({ project, index }))
          .filter(({ project }) => project.id === projectId);
        if (projectMatches.length === 0) {
          return entityNotFound(
            workspace,
            context,
            "ProjectV2",
            projectId,
            "repair_workspace_reference",
          );
        }
        if (projectMatches.length !== 1) {
          return duplicateEntityIdentity(
            workspace,
            context,
            "ProjectV2",
            projectId,
          );
        }
        const { project, index } = projectMatches[0];
        affectedProjects.push({
          project,
          index,
          alreadyHeld: project.holds.some(
            ({ type, sourceId }) =>
              type === "review_overdue" && sourceId === review.id,
          ),
        });
      }
      const alreadyHeldCount = affectedProjects.filter(
        ({ alreadyHeld }) => alreadyHeld,
      ).length;
      if (
        affectedProjects.length > 0 &&
        alreadyHeldCount === affectedProjects.length
      ) {
        return rejection(workspace, context, "DUPLICATE_COMMAND", {
          reason: `Review ${review.id} is already marked overdue.`,
          gate: `review:${review.id}:overdue`,
          permittedNextCommand: "complete_review",
        });
      }
      if (alreadyHeldCount > 0) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Review ${review.id} is only partially marked overdue across its affected Projects.`,
          gate: `review:${review.id}:overdue`,
          permittedNextCommand: "resolve_sync_conflict",
        });
      }
      const projects = [...workspace.projects];
      for (const { project, index } of affectedProjects) {
        projects[index] = {
          ...project,
          holds: [
            ...project.holds,
            {
              type: "review_overdue",
              sourceId: review.id,
              affectedRecordIds,
              createdAt: context.now,
            },
          ],
          updatedAt: context.now,
        };
      }
      const reviews = [...workspace.reviews];
      reviews[reviewIndex] = { ...review, overdueMarkedAt: context.now };
      return { ok: true, workspace: { ...workspace, projects, reviews } };
    }

    case "complete_review": {
      const matches = workspace.reviews
        .map((review, index) => ({ review, index }))
        .filter(({ review }) => review.id === command.reviewId);
      if (matches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
          "create_review",
        );
      }
      if (matches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
        );
      }
      const { review, index: reviewIndex } = matches[0];
      if (review.status !== "open" || review.conclusion !== undefined) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Review ${review.id} already has an immutable conclusion.`,
          gate: `review:${review.id}:conclusion`,
          permittedNextCommand: "read_completed_review",
        });
      }
      const summary = command.conclusion.summary.trim();
      const decisionCodes = command.conclusion.decisionCodes.map((value) =>
        value.trim(),
      );
      const followUpCommandIds = command.conclusion.followUpCommandIds.map(
        (value) => value.trim(),
      );
      const arraysAreValid =
        decisionCodes.length > 0 &&
        decisionCodes.every((value) => value.length > 0) &&
        new Set(decisionCodes).size === decisionCodes.length &&
        followUpCommandIds.every((value) => value.length > 0) &&
        new Set(followUpCommandIds).size === followUpCommandIds.length;
      if (
        summary.length === 0 ||
        !arraysAreValid ||
        !isCanonicalIsoTimestamp(review.createdAt) ||
        Date.parse(context.now) < Date.parse(review.createdAt)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Review ${review.id} requires one concise conclusion, unique decisions, and valid follow-up command IDs.`,
          gate: `review:${review.id}:conclusion`,
          permittedNextCommand: command.type,
        });
      }
      const affectedProjectIds = new Set(
        reviewAffectedActiveProjectIds(workspace, review),
      );
      for (const projectId of affectedProjectIds) {
        const projectMatches = workspace.projects.filter(
          ({ id }) => id === projectId,
        );
        if (projectMatches.length !== 1) {
          return duplicateEntityIdentity(
            workspace,
            context,
            "ProjectV2",
            projectId,
          );
        }
      }
      const reviews = [...workspace.reviews];
      reviews[reviewIndex] = {
        ...review,
        status: "completed",
        conclusion: {
          summary,
          decisionCodes,
          followUpCommandIds,
          actorId: context.actorId,
          completedAt: context.now,
        },
      };
      const projects = workspace.projects.map((project) => {
        if (!affectedProjectIds.has(project.id)) return project;
        const holds = project.holds.filter(
          ({ type, sourceId }) =>
            !(type === "review_overdue" && sourceId === review.id),
        );
        return holds.length === project.holds.length
          ? project
          : { ...project, holds, updatedAt: context.now };
      });
      return { ok: true, workspace: { ...workspace, reviews, projects } };
    }

    case "open_sync_conflict": {
      const draft = command.conflict;
      if (
        draft.id.trim().length === 0 ||
        draft.recordId.trim().length === 0 ||
        draft.remoteRecordId === undefined ||
        draft.remoteRecordId.trim().length === 0 ||
        draft.logicalKey === undefined ||
        draft.logicalKey.trim().length === 0 ||
        draft.affectedProjectIds === undefined ||
        draft.affectedRecordIds === undefined ||
        draft.localValue === undefined ||
        draft.localBundle === undefined ||
        draft.remoteBundle === undefined ||
        draft.commonAncestorHash.trim().length === 0
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Sync conflict identity, target, and common ancestor are required.",
          gate: `sync_conflict:${draft.id || "missing"}:payload`,
          permittedNextCommand: command.type,
        });
      }
      const existingTargetConflict = workspace.syncConflicts.find(
        (conflict) =>
          conflict.resolvedAt === undefined &&
          (conflict.logicalKey === draft.logicalKey ||
            (conflict.logicalKey === undefined &&
              conflict.recordType === draft.recordType &&
              conflict.recordId === draft.recordId)),
      );
      if (existingTargetConflict !== undefined) {
        return rejection(workspace, context, "DUPLICATE_COMMAND", {
          reason: `Sync conflict ${existingTargetConflict.id} already protects ${draft.recordType} ${draft.recordId}.`,
          gate: `sync_conflict_target:${draft.recordType}:${draft.recordId}`,
          permittedNextCommand: "read_existing_sync_conflict",
        });
      }
      const target = lookupConflictTarget(workspace, draft);
      if (
        !(await validateProtectedEffectBundlePair({
          workspace,
          conflictId: draft.id,
          recordType: draft.recordType,
          projectId: target.ok ? target.target.projectId : undefined,
          logicalKey: draft.logicalKey,
          recordId: draft.recordId,
          remoteRecordId: draft.remoteRecordId,
          localValue: draft.localValue,
          remoteValue: draft.remoteValue,
          affectedRecordIds: draft.affectedRecordIds,
          affectedProjectIds: draft.affectedProjectIds,
          localBundle: draft.localBundle,
          remoteBundle: draft.remoteBundle,
        }))
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${draft.id} requires two distinct, validated bundles and exact affected identities for one logical record.`,
          gate: `sync_conflict:${draft.id}:bundle`,
          permittedNextCommand: command.type,
        });
      }
      const expectedAffectedRecordIds = sortedUniqueIds(
        draft.affectedRecordIds,
      );
      const reviewId = `review:sync_conflict:${draft.id}`;
      for (const id of [draft.id, reviewId]) {
        const collision = entityIdCollision(workspace, id, [
          { entity: "CommandReceipt", id: context.commandId },
        ]);
        if (collision !== undefined) {
          return entityAlreadyExists(
            workspace,
            context,
            collision,
            id,
            command.type,
          );
        }
      }
      if (!target.ok) {
        if (target.reason === "missing") {
          return entityNotFound(
            workspace,
            context,
            draft.recordType,
            draft.recordId,
            "repair_workspace_reference",
          );
        }
        if (target.reason === "duplicate") {
          return duplicateEntityIdentity(
            workspace,
            context,
            draft.recordType,
            draft.recordId,
          );
        }
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Remote ${draft.recordType} must retain the exact record identity ${draft.recordId}.`,
          gate: `sync_conflict:${draft.id}:remote_identity`,
          permittedNextCommand: command.type,
        });
      }
      if (!sameSnapshot(target.target.record, draft.localValue)) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${draft.id} local primary snapshot does not match its current protected record.`,
          gate: `sync_conflict:${draft.id}:local_snapshot`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      let remoteProjection: WorkspaceV2;
      try {
        remoteProjection = await applyRemoteProtectedEffectBundle({
          workspace,
          localBundle: draft.localBundle,
          remoteBundle: draft.remoteBundle,
          conflictId: draft.id,
          now: context.now,
        });
      } catch {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${draft.id} bundle projection no longer descends from the current local state.`,
          gate: `sync_conflict:${draft.id}:bundle_projection`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const projectedRemote = protectedRecordSnapshot(
        remoteProjection,
        draft.recordType,
        draft.remoteRecordId,
      );
      if (
        projectedRemote === undefined ||
        !sameSnapshot(projectedRemote, draft.remoteValue)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${draft.id} remote primary snapshot is not produced by its verified bundle.`,
          gate: `sync_conflict:${draft.id}:remote_projection`,
          permittedNextCommand: command.type,
        });
      }
      if (!(await conflictRemoteSemanticsAreValid(workspace, draft))) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Remote ${draft.recordType} violates its authoritative lifecycle semantics.`,
          gate: `sync_conflict:${draft.id}:remote_semantics`,
          permittedNextCommand: command.type,
        });
      }
      const conflict = buildSyncConflictRecord(
        draft,
        target.target,
        context.now,
      );
      const provisionalWorkspace: WorkspaceV2 = {
        ...workspace,
        syncConflicts: [...workspace.syncConflicts, conflict],
      };
      const triggerKey = `sync_conflict:${draft.id}`;
      const matchingReviewDrafts = deriveReviewQueue(
        provisionalWorkspace,
        context.now,
      ).filter((review) => review.triggerKey === triggerKey);
      if (matchingReviewDrafts.length !== 1) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${draft.id} must derive exactly one event Review.`,
          gate: `sync_conflict:${draft.id}:review_derivation`,
          permittedNextCommand: command.type,
        });
      }
      const reviewDraft = matchingReviewDrafts[0];
      if (reviewDraft.id !== reviewId) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${draft.id} derived an invalid Review identity.`,
          gate: `sync_conflict:${draft.id}:review_identity`,
          permittedNextCommand: command.type,
        });
      }
      const projectIndexes: number[] = [];
      for (const projectId of reviewDraft.affectedProjectIds) {
        const matches = workspace.projects
          .map((project, index) => ({ project, index }))
          .filter(({ project }) => project.id === projectId);
        if (matches.length === 0) {
          return entityNotFound(
            workspace,
            context,
            "ProjectV2",
            projectId,
            "repair_workspace_reference",
          );
        }
        if (matches.length !== 1) {
          return duplicateEntityIdentity(
            workspace,
            context,
            "ProjectV2",
            projectId,
          );
        }
        projectIndexes.push(matches[0].index);
      }
      const projects = [...workspace.projects];
      for (const index of projectIndexes) {
        const project = projects[index];
        projects[index] = {
          ...project,
          holds: [
            ...project.holds,
            {
              type: "sync_conflict",
              sourceId: conflict.id,
              affectedRecordIds: structuredClone(expectedAffectedRecordIds),
              createdAt: context.now,
            },
          ],
          updatedAt: context.now,
        };
      }
      return {
        ok: true,
        workspace: {
          ...provisionalWorkspace,
          projects,
          reviews: [
            ...workspace.reviews,
            {
              ...reviewDraft,
              status: "open",
              createdAt: context.now,
            },
          ],
        },
      };
    }

    case "resolve_sync_conflict": {
      const conflictMatches = workspace.syncConflicts
        .map((conflict, index) => ({ conflict, index }))
        .filter(({ conflict }) => conflict.id === command.resolution.conflictId);
      if (conflictMatches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "SyncConflictRecord",
          command.resolution.conflictId,
          "open_sync_conflict",
        );
      }
      if (conflictMatches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "SyncConflictRecord",
          command.resolution.conflictId,
        );
      }
      const { conflict, index: conflictIndex } = conflictMatches[0];
      if (conflict.resolvedAt !== undefined || conflict.retainedVersion !== undefined) {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Sync conflict ${conflict.id} is already resolved.`,
          gate: `sync_conflict:${conflict.id}:resolution`,
          permittedNextCommand: "read_resolved_sync_conflict",
        });
      }
      if (
        conflict.logicalKey === undefined ||
        conflict.affectedProjectIds === undefined ||
        conflict.affectedRecordIds === undefined ||
        conflict.localBundle === undefined ||
        conflict.remoteBundle === undefined ||
        conflict.remoteRecordId === undefined ||
        command.resolution.retainedBundleHash === undefined
      ) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} has no complete verified bundle provenance.`,
          gate: `sync_conflict:${conflict.id}:bundle`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const exactOpenCommand = {
        type: "open_sync_conflict",
        conflict: {
          id: conflict.id,
          recordType: conflict.recordType,
          recordId: conflict.recordId,
          remoteRecordId: conflict.remoteRecordId,
          logicalKey: conflict.logicalKey,
          affectedProjectIds: conflict.affectedProjectIds,
          affectedRecordIds: conflict.affectedRecordIds,
          commonAncestorHash: conflict.commonAncestorHash,
          localValue: conflict.localValue,
          remoteValue: conflict.remoteValue,
          localBundle: conflict.localBundle,
          remoteBundle: conflict.remoteBundle,
        },
      } as const;
      const expectedOpenPayloadHash = await stableHash(
        exactOpenCommand as unknown as JsonValue,
      );
      const conflictCreationReceipts = workspace.commandReceipts.filter(
        (receipt) => {
          if (
            receipt.status !== "applied" ||
            receipt.commandType !== "open_sync_conflict" ||
            receipt.payloadHash !== expectedOpenPayloadHash
          ) return false;
          const conflictCreates = receipt.diff.filter(
            (diff) =>
              diff.entity === "SyncConflictRecord" &&
              diff.entityId === conflict.id &&
              diff.field === "created" &&
              diff.before === null &&
              sameSnapshot(diff.after, conflict),
          );
          return conflictCreates.length === 1;
        },
      );
      const conflictCreationReceipt = conflictCreationReceipts[0];
      if (conflictCreationReceipts.length !== 1 || conflictCreationReceipt === undefined) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} lacks its unique exact applied creation receipt.`,
          gate: `sync_conflict:${conflict.id}:creation_receipt`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const {
        receiptHash: storedConflictReceiptHash,
        ...conflictCreationReceiptBase
      } = conflictCreationReceipt;
      if (
        storedConflictReceiptHash !==
          (await stableHash(conflictCreationReceiptBase as unknown as JsonValue))
      ) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} creation receipt hash is invalid.`,
          gate: `sync_conflict:${conflict.id}:creation_receipt`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const reviewMatches = workspace.reviews
        .map((review, index) => ({ review, index }))
        .filter(({ review }) => review.id === command.reviewId);
      if (reviewMatches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
          "open_sync_conflict",
        );
      }
      if (reviewMatches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ReviewRecord",
          command.reviewId,
        );
      }
      const { review } = reviewMatches[0];
      const expectedTriggerKey = `sync_conflict:${conflict.id}`;
      const expectedReviewId = `review:${expectedTriggerKey}`;
      if (
        review.id !== expectedReviewId ||
        review.triggerKey !== expectedTriggerKey ||
        review.kind !== "event" ||
        review.triggerType !== "sync_conflict" ||
        review.status !== "open" ||
        review.conclusion !== undefined
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${conflict.id} must resolve through its exact open Review ${expectedReviewId}.`,
          gate: `sync_conflict:${conflict.id}:review`,
          permittedNextCommand: "open_sync_conflict",
        });
      }
      const rationale = command.resolution.rationale.trim();
      if (rationale.length === 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "Conflict resolution requires a rationale.",
          gate: `sync_conflict:${conflict.id}:rationale`,
          permittedNextCommand: command.type,
        });
      }
      if (
        !(await conflictRemoteSemanticsAreValid(workspace, {
          id: conflict.id,
          recordType: conflict.recordType,
          recordId: conflict.recordId,
          remoteRecordId: conflict.remoteRecordId,
          logicalKey: conflict.logicalKey,
          affectedProjectIds: conflict.affectedProjectIds,
          affectedRecordIds: conflict.affectedRecordIds,
          commonAncestorHash: conflict.commonAncestorHash,
          localValue: conflict.localValue,
          remoteValue: conflict.remoteValue,
          localBundle: conflict.localBundle,
          remoteBundle: conflict.remoteBundle,
        }))
      ) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} remote snapshot no longer satisfies authoritative semantics.`,
          gate: `sync_conflict:${conflict.id}:remote_semantics`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      if (
        !(await validateProtectedEffectBundlePair({
          workspace,
          conflictId: conflict.id,
          recordType: conflict.recordType,
          projectId: conflict.projectId,
          logicalKey: conflict.logicalKey,
          recordId: conflict.recordId,
          remoteRecordId: conflict.remoteRecordId,
          localValue: conflict.localValue,
          remoteValue: conflict.remoteValue,
          retainedVersion: conflict.retainedVersion,
          retainedBundleHash: conflict.retainedBundleHash,
          affectedRecordIds: conflict.affectedRecordIds,
          affectedProjectIds: conflict.affectedProjectIds,
          localBundle: conflict.localBundle,
          remoteBundle: conflict.remoteBundle,
        }))
      ) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} bundle provenance was tampered after opening.`,
          gate: `sync_conflict:${conflict.id}:bundle`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const selectsLocal =
        command.resolution.retainedBundleHash === conflict.localBundle.hash;
      const selectsRemote =
        command.resolution.retainedBundleHash === conflict.remoteBundle.hash;
      if (selectsLocal === selectsRemote) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${conflict.id} resolution must identify one preserved bundle hash.`,
          gate: `sync_conflict:${conflict.id}:retained_bundle`,
          permittedNextCommand: command.type,
        });
      }
      const retainedVersion = selectsLocal ? "local" : "remote";
      const selectedValue = selectsLocal
        ? conflict.localValue
        : conflict.remoteValue;
      if (!sameSnapshot(command.resolution.retainedValue, selectedValue)) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${conflict.id} retained value does not match its retained bundle hash.`,
          gate: `sync_conflict:${conflict.id}:retained_value`,
          permittedNextCommand: command.type,
        });
      }
      if (
        context.origin !== "sync" &&
        command.resolution.retainedVersion !== retainedVersion
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${conflict.id} retained snapshot does not match the selected local or remote side.`,
          gate: `sync_conflict:${conflict.id}:retained_value`,
          permittedNextCommand: command.type,
        });
      }
      const expectedProjectIds = [...conflict.affectedProjectIds].sort();
      const expectedAffectedRecordIds = sortedUniqueIds([
        conflict.id,
        ...conflict.affectedRecordIds,
        ...conflict.affectedProjectIds,
      ]);
      if (
        JSON.stringify([...review.affectedProjectIds].sort()) !==
          JSON.stringify([...expectedProjectIds].sort()) ||
        JSON.stringify([...review.affectedRecordIds].sort()) !==
          JSON.stringify(expectedAffectedRecordIds) ||
        review.createdAt !== conflict.openedAt ||
        review.dueAt !== conflict.openedAt ||
        review.cadenceTimeZone !== undefined ||
        review.overdueMarkedAt !== undefined
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: `Sync conflict ${conflict.id} Review artifacts no longer match the protected record.`,
          gate: `sync_conflict:${conflict.id}:review_artifacts`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const expectedOwners = new Set(expectedProjectIds);
      for (const project of workspace.projects) {
        const matchingHolds = project.holds.filter(
          ({ type, sourceId }) =>
            type === "sync_conflict" && sourceId === conflict.id,
        );
        if (!expectedOwners.has(project.id)) {
          if (matchingHolds.length !== 0) {
            return rejection(workspace, context, "INVALID_COMMAND", {
              reason: `Sync conflict ${conflict.id} has a hold on unrelated Project ${project.id}.`,
              gate: `sync_conflict:${conflict.id}:hold_ownership`,
              permittedNextCommand: "repair_workspace_reference",
            });
          }
          continue;
        }
        if (
          matchingHolds.length !== 1 ||
          matchingHolds[0].createdAt !== conflict.openedAt ||
          JSON.stringify([...matchingHolds[0].affectedRecordIds].sort()) !==
            JSON.stringify([...conflict.affectedRecordIds].sort())
        ) {
          return rejection(workspace, context, "INVALID_COMMAND", {
            reason: `Sync conflict ${conflict.id} must own one exact affected-record hold on Project ${project.id}.`,
            gate: `sync_conflict:${conflict.id}:hold_artifacts`,
            permittedNextCommand: "repair_workspace_reference",
          });
        }
      }
      const currentLocalValue = protectedRecordSnapshot(
        workspace,
        conflict.recordType,
        conflict.recordId,
      );
      if (!sameSnapshot(currentLocalValue, conflict.localValue)) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} local snapshot no longer matches its protected record.`,
          gate: `sync_conflict:${conflict.id}:local_snapshot`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      let resolvedWorkspace: WorkspaceV2;
      try {
        resolvedWorkspace = await applyRemoteProtectedEffectBundle({
          workspace,
          localBundle: conflict.localBundle,
          remoteBundle: selectsLocal
            ? conflict.localBundle
            : conflict.remoteBundle,
          conflictId: conflict.id,
          now: context.now,
        });
      } catch {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} current bundle projection drifted before resolution.`,
          gate: `sync_conflict:${conflict.id}:bundle_projection`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const selectedRecordId = selectsLocal
        ? conflict.recordId
        : conflict.remoteRecordId;
      const retainedPrimary = protectedRecordSnapshot(
        resolvedWorkspace,
        conflict.recordType,
        selectedRecordId,
      );
      if (!sameSnapshot(retainedPrimary, selectedValue)) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} retained bundle did not produce its declared primary record.`,
          gate: `sync_conflict:${conflict.id}:retained_projection`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      const syncConflicts = [...resolvedWorkspace.syncConflicts];
      syncConflicts[conflictIndex] = {
        ...conflict,
        resolvedAt: context.now,
        retainedVersion,
        retainedBundleHash: command.resolution.retainedBundleHash,
      };
      const reviews = [...resolvedWorkspace.reviews];
      const resolvedReviewIndex = reviews.findIndex(
        ({ id }) => id === review.id,
      );
      if (resolvedReviewIndex < 0) {
        return rejection(workspace, context, "SYNC_CONFLICT", {
          reason: `Sync conflict ${conflict.id} lost its resolution Review during bundle projection.`,
          gate: `sync_conflict:${conflict.id}:review_projection`,
          permittedNextCommand: "repair_workspace_reference",
        });
      }
      reviews[resolvedReviewIndex] = {
        ...review,
        status: "completed",
        conclusion: {
          summary: rationale,
          decisionCodes: [
            `sync_conflict_retained_${retainedVersion}`,
          ],
          followUpCommandIds:
            command.resolution.reappliedCommandId === undefined
              ? []
              : [command.resolution.reappliedCommandId],
          actorId: context.actorId,
          completedAt: context.now,
        },
      };
      const projects = resolvedWorkspace.projects.map((project) => {
        const holds = project.holds.filter(
          ({ type, sourceId }) =>
            !(type === "sync_conflict" && sourceId === conflict.id),
        );
        return holds.length === project.holds.length
          ? project
          : { ...project, holds, updatedAt: context.now };
      });
      return {
        ok: true,
        workspace: {
          ...resolvedWorkspace,
          syncConflicts,
          reviews,
          projects,
        },
      };
    }

    case "close_project": {
      const subject = prepareCloseSubject(
        workspace,
        context,
        command.projectId,
        command.type,
      );
      if (!subject.ok) return subject.result;
      const { project, projectIndex } = subject;
      if (project.stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${project.id} cannot be closed again.`,
          gate: `project:${project.id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      if (project.stage !== "closing") {
        return rejection(workspace, context, "ILLEGAL_LIFECYCLE_TRANSITION", {
          reason: `Project ${project.id} cannot close from ${project.stage}.`,
          gate: `project:${project.id}:stage:${project.stage}`,
          permittedNextCommand: "satisfy_validation",
        });
      }
      const currentBet = subject.currentBet;
      if (!currentBet.ok) {
        return closeValidationRejection(workspace, context, currentBet.issue);
      }
      const activeBet = currentBet.bet;
      const rebetHolds = project.holds.filter(
        ({ type }) => type === "rebet_required",
      );
      const boundaryHold = exactCanonicalAppetiteBoundaryHold(
        project,
        activeBet,
        context.now,
      );
      if (rebetHolds.length > 0 && boundaryHold === undefined) {
        return rejection(
          workspace,
          context,
          "ILLEGAL_LIFECYCLE_TRANSITION",
          {
            reason: `Project ${project.id} has no exact canonical appetite-boundary hold for Close.`,
            gate: `project:${project.id}:appetite_boundary`,
            permittedNextCommand: "record_bet_boundary",
          },
        );
      }
      const prepared = prepareCloseArtifacts(
        workspace,
        context,
        project,
        command.decision,
        command.type,
      );
      if (!prepared.ok) return prepared.result;
      const transition = transitionLifecycle(project, "project_closed");
      if (!transition.ok) {
        return rejection(workspace, context, transition.code, {
          gate: `project:${project.id}:stage:${project.stage}`,
          permittedNextCommand: "satisfy_validation",
        });
      }
      const closedProject: ProjectV2 = {
        ...transition.project,
        holds:
          boundaryHold === undefined
            ? transition.project.holds
            : transition.project.holds.filter((hold) => hold !== boundaryHold),
        updatedAt: context.now,
      };
      return applyCloseArtifacts(
        workspace,
        projectIndex,
        closedProject,
        prepared.artifacts,
      );
    }

    case "abandon_project": {
      const subject = prepareCloseSubject(
        workspace,
        context,
        command.projectId,
        command.type,
      );
      if (!subject.ok) return subject.result;
      const { project, projectIndex } = subject;
      if (project.stage === "closed") {
        return rejection(workspace, context, "PROJECT_CLOSED", {
          reason: `Closed Project ${project.id} cannot be abandoned again.`,
          gate: `project:${project.id}:closed`,
          permittedNextCommand: "create_follow_up_project",
        });
      }
      const currentBet = subject.currentBet;
      if (!currentBet.ok && currentBet.issue.code === "SYNC_CONFLICT") {
        return closeValidationRejection(workspace, context, currentBet.issue);
      }
      const boundaryBet = currentBet.ok ? currentBet.bet : undefined;
      const boundaryHold =
        boundaryBet === undefined
          ? undefined
          : exactCanonicalAppetiteBoundaryHold(
              project,
              boundaryBet,
              context.now,
            );
      const atRecordedAppetiteBoundary =
        project.stage === "validating" &&
        boundaryBet !== undefined &&
        boundaryHold !== undefined;
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
      const prepared = prepareCloseArtifacts(
        workspace,
        context,
        project,
        command.decision,
        command.type,
      );
      if (!prepared.ok) return prepared.result;
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
      const closedProject: ProjectV2 = {
        ...closeTransition.project,
        holds: closeTransition.project.holds.filter(
          (hold) => hold !== boundaryHold,
        ),
        updatedAt: context.now,
      };
      return applyCloseArtifacts(
        workspace,
        projectIndex,
        closedProject,
        prepared.artifacts,
      );
    }

    case "submit_command_proposal": {
      if (command.rationale.trim().length === 0) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason: "A command proposal requires a non-empty rationale.",
          gate: `command_proposal:${command.proposalId}:rationale`,
          permittedNextCommand: "submit_command_proposal",
        });
      }
      const collision = entityIdCollision(workspace, command.proposalId, [
        { entity: "CommandReceipt", id: context.commandId },
      ]);
      if (collision !== undefined) {
        return entityAlreadyExists(
          workspace,
          context,
          collision,
          command.proposalId,
          "submit_command_proposal",
        );
      }
      if (
        command.command.type === "propose_replan" &&
        ((command.command.proposal.baseRevision !== workspace.revision &&
          context.origin !== "sync") ||
          command.command.proposal.createdBy !== context.actorId ||
          command.command.proposal.createdAt !== context.now)
      ) {
        return rejection(workspace, context, "INVALID_COMMAND", {
          reason:
            "A proposed Replan must be generated by the submitting Agent from the current Workspace revision.",
          gate: `command_proposal:${command.proposalId}:replan_provenance`,
          permittedNextCommand: "regenerate_replan",
        });
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          commandProposals: [
            ...workspace.commandProposals,
            {
              id: command.proposalId,
              commandType: command.command.type,
              payload: structuredClone(command.command) as unknown as JsonValue,
              baseRevision: workspace.revision,
              rationale: command.rationale,
              agentActorId: context.actorId,
              createdAt: context.now,
              status: "open",
            },
          ],
        },
      };
    }

    case "accept_command_proposal":
      return rejection(workspace, context, "COMMAND_NOT_IMPLEMENTED", {
        reason:
          "Proposal acceptance must be orchestrated atomically by the command engine.",
        gate: `command_proposal:${command.proposalId}:atomic_acceptance`,
        permittedNextCommand: "accept_command_proposal",
      });

    case "dismiss_command_proposal": {
      const matches = workspace.commandProposals.filter(
        ({ id }) => id === command.proposalId,
      );
      if (matches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "CommandProposal",
          command.proposalId,
          "submit_command_proposal",
        );
      }
      if (matches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "CommandProposal",
          command.proposalId,
        );
      }
      if (matches[0].status !== "open") {
        return rejection(workspace, context, "REVISION_CONFLICT", {
          reason: `Command Proposal ${command.proposalId} is no longer open.`,
          gate: `command_proposal:${command.proposalId}:status`,
          permittedNextCommand: "read_current_command_proposal",
        });
      }
      return {
        ok: true,
        workspace: {
          ...workspace,
          commandProposals: workspace.commandProposals.map((proposal) =>
            proposal.id === command.proposalId
              ? { ...proposal, status: "dismissed" as const }
              : proposal,
          ),
        },
      };
    }

    case "archive_project": {
      const matches = workspace.projects.filter(
        ({ id }) => id === command.projectId,
      );
      if (matches.length === 0) {
        return entityNotFound(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
          "confirm_project_triage",
        );
      }
      if (matches.length !== 1) {
        return duplicateEntityIdentity(
          workspace,
          context,
          "ProjectV2",
          command.projectId,
        );
      }
      const project = matches[0];
      if (project.stage !== "closed") {
        return rejection(workspace, context, "ILLEGAL_LIFECYCLE_TRANSITION", {
          reason: `Project ${project.id} can be archived only after Close.`,
          gate: `project:${project.id}:stage:${project.stage}`,
          permittedNextCommand: "close_project",
        });
      }
      const archived = new Set(workspace.visibility.archivedProjectIds);
      if (command.archived) archived.add(project.id);
      else archived.delete(project.id);
      return {
        ok: true,
        workspace: {
          ...workspace,
          visibility: {
            ...workspace.visibility,
            archivedProjectIds: [...archived].sort(),
          },
        },
      };
    }
  }

  return assertNever(command);
}
