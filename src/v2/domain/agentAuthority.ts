import type { V2Command } from "./commands";
import { stableHash } from "./stableHash";
import type {
  CommandProposal,
  CommandReceipt,
  JsonValue,
  WorkspaceV2,
} from "./types";

export type AgentAuthorityDisposition =
  | "automatic"
  | "proposal_submission"
  | "proposal_only"
  | "human_confirmation"
  | "human_mutation"
  | "system_only";

/**
 * One exhaustive authority table for every public V2 command. Adding a command
 * without making an explicit Agent decision is a compile-time error.
 */
export const AGENT_COMMAND_AUTHORITY = {
  configure_capacity: "human_mutation",
  capture_inbox: "automatic",
  confirm_action_triage: "human_confirmation",
  confirm_project_triage: "human_confirmation",
  update_project_metadata: "human_mutation",
  update_action: "human_mutation",
  complete_action: "human_mutation",
  promote_action_to_project: "human_confirmation",
  update_direction: "proposal_only",
  place_bet: "human_confirmation",
  create_work_item: "proposal_only",
  update_work_item: "proposal_only",
  upsert_dependency: "proposal_only",
  remove_dependency: "proposal_only",
  remove_work_item: "human_mutation",
  capture_baseline: "human_mutation",
  complete_work_item: "human_mutation",
  propose_replan: "proposal_only",
  commit_today: "human_confirmation",
  accept_replan: "human_confirmation",
  record_actual: "automatic",
  attach_evidence: "automatic",
  approve_evidence_exception: "human_confirmation",
  resolve_evidence_exception: "human_mutation",
  request_validation: "human_mutation",
  satisfy_validation: "human_mutation",
  record_bet_boundary: "system_only",
  mark_review_overdue: "system_only",
  create_review: "system_only",
  complete_review: "human_confirmation",
  open_sync_conflict: "system_only",
  resolve_sync_conflict: "human_confirmation",
  close_project: "human_confirmation",
  abandon_project: "human_confirmation",
  archive_project: "human_mutation",
  submit_command_proposal: "proposal_submission",
  accept_command_proposal: "human_confirmation",
  dismiss_command_proposal: "human_confirmation",
} as const satisfies Record<V2Command["type"], AgentAuthorityDisposition>;

export const PROPOSABLE_COMMAND_TYPES = [
  "update_direction",
  "create_work_item",
  "update_work_item",
  "propose_replan",
  "upsert_dependency",
  "remove_dependency",
] as const;

export type ProposableCommandType =
  (typeof PROPOSABLE_COMMAND_TYPES)[number];

export function isProposableCommandType(
  value: unknown,
): value is ProposableCommandType {
  return (
    typeof value === "string" &&
    (PROPOSABLE_COMMAND_TYPES as readonly string[]).includes(value)
  );
}

export function agentCommandDisposition(
  commandType: V2Command["type"],
): AgentAuthorityDisposition {
  return AGENT_COMMAND_AUTHORITY[commandType];
}

function sameJson(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([leftKey], [rightKey]) =>
            leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0,
          )
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export interface VerifiedAcceptedCommandProposal {
  proposal: CommandProposal;
  command: Record<string, unknown>;
  submitReceipt: CommandReceipt;
  acceptReceipt: CommandReceipt;
}

/**
 * Verifies the complete post-acceptance lineage without trusting a mutable
 * proposal payload or a receipt commandType in isolation.
 */
export async function verifyAcceptedCommandProposalReceipt(
  workspace: Readonly<WorkspaceV2>,
  receipt: Readonly<CommandReceipt>,
  expectedCommandType?: ProposableCommandType,
): Promise<VerifiedAcceptedCommandProposal | undefined> {
  if (
    receipt.status !== "applied" ||
    receipt.commandType !== "accept_command_proposal" ||
    receipt.actorKind !== "human" ||
    !receipt.source.verified ||
    receipt.revision !== receipt.baseRevision + 1
  ) return undefined;
  const acceptedDiffs = receipt.diff.filter(
    (diff) =>
      diff.entity === "CommandProposal" &&
      diff.field === "status" &&
      diff.before === "open" &&
      diff.after === "accepted",
  );
  if (acceptedDiffs.length !== 1) return undefined;
  const proposalMatches = workspace.commandProposals.filter(
    (proposal) =>
      proposal.id === acceptedDiffs[0].entityId &&
      proposal.status === "accepted" &&
      (expectedCommandType === undefined ||
        proposal.commandType === expectedCommandType),
  );
  const proposal = proposalMatches[0];
  if (
    proposalMatches.length !== 1 ||
    proposal === undefined ||
    receipt.baseRevision !== proposal.baseRevision + 1 ||
    proposal.payload === null ||
    Array.isArray(proposal.payload) ||
    typeof proposal.payload !== "object" ||
    proposal.payload.type !== proposal.commandType
  ) return undefined;
  const expectedAccept = {
    type: "accept_command_proposal",
    proposalId: proposal.id,
  };
  const { receiptHash: acceptHash, ...acceptBase } = receipt;
  if (
    receipt.payloadHash !==
      (await stableHash(expectedAccept as unknown as JsonValue)) ||
    acceptHash !== (await stableHash(acceptBase as unknown as JsonValue))
  ) return undefined;
  const submitMatches = workspace.commandReceipts.filter(
    (candidate) =>
      candidate.status === "applied" &&
      candidate.commandType === "submit_command_proposal" &&
      candidate.baseRevision === proposal.baseRevision &&
      candidate.revision === proposal.baseRevision + 1,
  );
  const submitReceipt = submitMatches[0];
  if (
    submitMatches.length !== 1 ||
    submitReceipt === undefined ||
    submitReceipt.actorKind !== "agent" ||
    submitReceipt.actorId !== proposal.agentActorId ||
    submitReceipt.createdAt !== proposal.createdAt ||
    !submitReceipt.source.verified ||
    !submitReceipt.source.capabilities.includes("submit_proposal")
  ) return undefined;
  const openSnapshot = { ...proposal, status: "open" as const };
  const creates = submitReceipt.diff.filter(
    (diff) =>
      diff.entity === "CommandProposal" &&
      diff.entityId === proposal.id &&
      diff.field === "created" &&
      diff.before === null &&
      sameJson(diff.after, openSnapshot),
  );
  const expectedSubmit = {
    type: "submit_command_proposal",
    proposalId: proposal.id,
    command: proposal.payload,
    rationale: proposal.rationale,
  };
  const { receiptHash: submitHash, ...submitBase } = submitReceipt;
  if (
    creates.length !== 1 ||
    submitReceipt.payloadHash !==
      (await stableHash(expectedSubmit as unknown as JsonValue)) ||
    submitHash !== (await stableHash(submitBase as unknown as JsonValue))
  ) return undefined;
  return {
    proposal: structuredClone(proposal),
    command: structuredClone(proposal.payload) as Record<string, unknown>,
    submitReceipt: structuredClone(submitReceipt),
    acceptReceipt: structuredClone(receipt),
  };
}
