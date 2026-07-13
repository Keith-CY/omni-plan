import { canonicalJson } from "../../domain/canonical";
import type { V2Command } from "../domain/commands";
import type { CommandReceipt } from "../domain/types";

const retryableSystemCommands = new Set<V2Command["type"]>([
  "record_bet_boundary",
  "create_review",
  "mark_review_overdue",
]);

/**
 * The sole legal cross-ledger identity overlap: one append-only system CAS
 * rejection followed by the exact same deterministic system command applying
 * at the same or a later Workspace revision.
 */
export function isExactSystemCasRetryOverlap(input: {
  applied: Readonly<CommandReceipt>;
  rejected: Readonly<CommandReceipt>;
}): boolean {
  const { applied, rejected } = input;
  const appliedAt = Date.parse(applied.createdAt);
  const rejectedAt = Date.parse(rejected.createdAt);
  return (
    applied.status === "applied" &&
    rejected.status === "rejected" &&
    rejected.rejectionCode === "REVISION_CONFLICT" &&
    applied.id === applied.commandId &&
    rejected.id === rejected.commandId &&
    applied.commandId === rejected.commandId &&
    applied.commandType === rejected.commandType &&
    retryableSystemCommands.has(applied.commandType as V2Command["type"]) &&
    applied.payloadHash === rejected.payloadHash &&
    applied.actorId === rejected.actorId &&
    applied.actorKind === "system" &&
    rejected.actorKind === "system" &&
    applied.origin === rejected.origin &&
    Number.isFinite(appliedAt) &&
    Number.isFinite(rejectedAt) &&
    new Date(appliedAt).toISOString() === applied.createdAt &&
    new Date(rejectedAt).toISOString() === rejected.createdAt &&
    appliedAt >= rejectedAt &&
    applied.source.verified === true &&
    rejected.source.verified === true &&
    applied.source.capabilities.includes("system_time") &&
    rejected.source.capabilities.includes("system_time") &&
    canonicalJson(applied.source) === canonicalJson(rejected.source) &&
    rejected.revision === rejected.baseRevision &&
    applied.revision === applied.baseRevision + 1 &&
    rejected.baseRevision <= applied.baseRevision
  );
}
