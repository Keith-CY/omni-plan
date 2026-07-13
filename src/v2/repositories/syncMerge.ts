import type { Id, ISODate } from "@/domain/types";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  executeCommand,
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import type {
  CommandReceipt,
  JsonValue,
  SyncConflictRecord,
  WorkspaceV2,
} from "../domain/types";
import type { AtomicWorkspaceRepository } from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import {
  combineProtectedEffectBundles,
  isKnownUnprotectedLifecycleWriter,
  projectProtectedEffectBundle,
  protectedEffectBundlePairAffectedProjectIds,
  protectedEffectBundleTouchedEntityIds,
  type ProtectedEffectBundle,
} from "./syncConflictBundles";
import {
  authorizeEquivalentConflictResolutionFromVerifiedReplayV2,
  authorizeConflictOpenFromBranchesV2,
  authorizeConflictOpenFromResolutionBranchesV2,
  authorizeConflictOpenFromVerifiedReplayV2,
  resolutionSuccessorIdentityV2,
  type AuthorizedEquivalentConflictResolution,
  type AuthorizedConflictOpen,
} from "./syncConflictOpenAuthorization";
import {
  authorizeSemanticSyncReplayV2,
  authorizeSyncBranchV2,
  decryptAndVerifySyncOperationV2,
  findLatestCommonAncestorV2,
  parseSyncEnvelopeV2,
  parseSyncManifestV2,
  SyncProtocolError,
  syncManifestPathV2,
  syncOperationPathV2,
  verifiedSyncAuthorityRootV2,
  verifySyncHistoryV2,
  type VerifiedSyncHistory,
  type VerifiedSyncReplay,
  type AuthorizedSyncBranchV2,
  type AuthorizedSemanticSyncReplay,
  type AuthorizedSyncReplay,
} from "./syncProtocol";
import type { SyncKeyProviderV2, SyncRemoteFileV2 } from "./syncAdapter";

export interface SyncRemoteHistoryPortV2 {
  read(path: string): Promise<SyncRemoteFileV2 | undefined>;
  list(prefix: string): Promise<readonly string[]>;
}

export type SyncMergeErrorCode =
  | "SYNC_KEY_LOCKED"
  | "REMOTE_MANIFEST_MISSING"
  | "REMOTE_READ_FAILED"
  | "REMOTE_MANIFEST_INVALID"
  | "REMOTE_HISTORY_LIST_FAILED"
  | "REMOTE_HISTORY_INVALID"
  | "REMOTE_OPERATION_MISSING"
  | "REMOTE_OPERATION_INVALID"
  | "WORKSPACE_NOT_READY"
  | "LOCAL_CHECKPOINT_STALE"
  | "REPLAY_AUTHORITY_MISMATCH"
  | "MERGE_REPLAY_REJECTED"
  | "MERGE_PROGRESS_DIVERGED"
  | "CONCURRENT_CONFLICT_RESOLUTION"
  | "PROTECTED_RECORD_INVALID"
  | "CONFLICT_OPEN_REJECTED";

export class SyncMergeError extends Error {
  constructor(
    readonly code: SyncMergeErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SyncMergeError";
  }
}

export interface MaterializeRemoteSyncHistoryV2Input {
  remote: SyncRemoteHistoryPortV2;
  workspaceId: Id;
  passphrase: string;
}

export function syncOperationsPrefixV2(workspaceId: Id): string {
  const manifestPath = syncManifestPathV2(workspaceId);
  return `${manifestPath.slice(0, -"manifest.json".length)}operations/`;
}

function validRemoteFile(value: unknown): value is SyncRemoteFileV2 {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as SyncRemoteFileV2).content === "string" &&
    typeof (value as SyncRemoteFileV2).version === "string" &&
    (value as SyncRemoteFileV2).version.trim().length > 0
  );
}

function parseRemoteJson(
  content: string,
  code: "REMOTE_MANIFEST_INVALID" | "REMOTE_OPERATION_INVALID",
  message: string,
): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new SyncMergeError(code, message, error);
  }
}

function listedOperationHash(
  path: string,
  prefix: string,
  workspaceId: Id,
): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const match = /^([^/]+)\/([1-9]\d*)-([a-f0-9]{64})\.json\.enc$/.exec(
    path.slice(prefix.length),
  );
  if (match === null) return undefined;
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) return undefined;
  try {
    return syncOperationPathV2(
      workspaceId,
      deviceId,
      sequence,
      match[3],
    ) === path
      ? match[3]
      : undefined;
  } catch {
    return undefined;
  }
}

export async function materializeRemoteSyncHistoryV2(
  input: MaterializeRemoteSyncHistoryV2Input,
): Promise<VerifiedSyncHistory> {
  let manifestFile: SyncRemoteFileV2 | undefined;
  try {
    manifestFile = await input.remote.read(
      syncManifestPathV2(input.workspaceId),
    );
  } catch (error) {
    throw new SyncMergeError(
      "REMOTE_READ_FAILED",
      "The V2 remote manifest could not be read.",
      error,
    );
  }
  if (manifestFile === undefined) {
    throw new SyncMergeError(
      "REMOTE_MANIFEST_MISSING",
      "The V2 remote manifest is missing.",
    );
  }
  if (!validRemoteFile(manifestFile)) {
    throw new SyncMergeError(
      "REMOTE_MANIFEST_INVALID",
      "The V2 remote manifest file is malformed.",
    );
  }
  const manifest = parseSyncManifestV2(
    parseRemoteJson(
      manifestFile.content,
      "REMOTE_MANIFEST_INVALID",
      "The V2 remote manifest is not valid JSON.",
    ),
  );
  if (manifest.workspaceId !== input.workspaceId) {
    throw new SyncMergeError(
      "REMOTE_MANIFEST_INVALID",
      "The V2 remote manifest belongs to another Workspace.",
    );
  }

  const prefix = syncOperationsPrefixV2(input.workspaceId);
  let listedPaths: readonly string[];
  try {
    listedPaths = await input.remote.list(prefix);
  } catch (error) {
    throw new SyncMergeError(
      "REMOTE_HISTORY_LIST_FAILED",
      "The immutable V2 operation history could not be listed.",
      error,
    );
  }
  if (!Array.isArray(listedPaths) || new Set(listedPaths).size !== listedPaths.length) {
    throw new SyncMergeError(
      "REMOTE_HISTORY_INVALID",
      "The remote provider returned an invalid V2 operation listing.",
    );
  }
  const paths = [...listedPaths].sort(compareText);
  const pathByHash = new Map<string, string>();
  for (const path of paths) {
    const operationHash =
      typeof path === "string"
        ? listedOperationHash(path, prefix, input.workspaceId)
        : undefined;
    if (operationHash === undefined || pathByHash.has(operationHash)) {
      throw new SyncMergeError(
        "REMOTE_HISTORY_INVALID",
        "The remote provider returned an invalid or duplicate V2 operation path.",
      );
    }
    pathByHash.set(operationHash, path);
  }

  const verifiedByHash = new Map<string, VerifiedSyncReplay>();
  const visiting = new Set<string>();
  const loadReachableOperation = async (
    operationHash: string,
  ): Promise<void> => {
    if (verifiedByHash.has(operationHash)) return;
    if (visiting.has(operationHash)) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "The reachable V2 operation graph contains a cycle.",
      );
    }
    const path = pathByHash.get(operationHash);
    if (path === undefined) {
      throw new SyncProtocolError(
        "MISSING_ANCESTOR",
        `Reachable operation ${operationHash} is missing from remote storage.`,
      );
    }
    visiting.add(operationHash);
    try {
      let file: SyncRemoteFileV2 | undefined;
      try {
        file = await input.remote.read(path);
      } catch (error) {
        throw new SyncMergeError(
          "REMOTE_READ_FAILED",
          `The remote operation ${path} could not be read.`,
          error,
        );
      }
      if (file === undefined) {
        throw new SyncMergeError(
          "REMOTE_OPERATION_MISSING",
          `The remote operation ${path} is missing.`,
        );
      }
      if (!validRemoteFile(file)) {
        throw new SyncMergeError(
          "REMOTE_OPERATION_INVALID",
          `The remote operation ${path} is malformed.`,
        );
      }
      const envelope = parseSyncEnvelopeV2(
        parseRemoteJson(
          file.content,
          "REMOTE_OPERATION_INVALID",
          `The remote operation ${path} is not valid JSON.`,
        ),
      );
      const replay = await decryptAndVerifySyncOperationV2({
        envelope,
        path,
        passphrase: input.passphrase,
        expectedWorkspaceId: input.workspaceId,
        expectedOperationHash: operationHash,
      });
      if (envelope.previousOperationHash !== undefined) {
        await loadReachableOperation(envelope.previousOperationHash);
      }
      verifiedByHash.set(operationHash, replay);
    } finally {
      visiting.delete(operationHash);
    }
  };
  for (const head of Object.values(manifest.heads)) {
    await loadReachableOperation(head.operationHash);
  }
  return verifySyncHistoryV2(manifest, [...verifiedByHash.values()]);
}

export interface SyncMergeV2Options {
  repository: AtomicWorkspaceRepository;
  remote: SyncRemoteHistoryPortV2;
  workspaceId: Id;
  keyProvider: SyncKeyProviderV2;
}

export interface MergeSyncBranchesV2Input {
  trustedAncestorWorkspace: WorkspaceV2;
  localHeadHash: string;
  remoteHeadHash: string;
  now: ISODate;
}

export interface SyncMergeResultV2 {
  status: "merged" | "already_merged";
  commonAncestorHash: string;
  replayedOperationHashes: string[];
  openedConflictIds: string[];
  revision: number;
}

interface BranchProtectedBundle {
  bundle: ProtectedEffectBundle;
  operationHashes: Set<string>;
}

interface BranchResolutionOutcome {
  conflictId: Id;
  retainedBundleHash: string | undefined;
  retainedValue: JsonValue;
  outcomeIdentity: string;
  replaysByAuthorityRoot: Map<string, AuthorizedSyncReplay[]>;
}

function branchResolutionOutcomes(
  branch: AuthorizedSyncBranchV2,
): Map<Id, BranchResolutionOutcome> {
  const outcomes = new Map<Id, BranchResolutionOutcome>();
  for (const replay of branch.replays) {
    if (replay.command.type !== "resolve_sync_conflict") continue;
    const conflictId = replay.command.resolution.conflictId;
    const outcomeIdentity = canonicalJson({
      retainedBundleHash: replay.command.resolution.retainedBundleHash,
      retainedValue: replay.command.resolution.retainedValue,
    });
    const existing = outcomes.get(conflictId);
    const rootHash = replay.authorityRoot.operationHash;
    const sameRoot = existing?.replaysByAuthorityRoot.get(rootHash);
    if (
      sameRoot !== undefined &&
      existing?.outcomeIdentity !== outcomeIdentity
    ) {
      throw new SyncMergeError(
        "REPLAY_AUTHORITY_MISMATCH",
        `Sync conflict ${conflictId} changed its retained decision under authority root ${rootHash}.`,
      );
    }
    if (existing !== undefined && existing.outcomeIdentity !== outcomeIdentity) {
      throw new SyncMergeError(
        "PROTECTED_RECORD_INVALID",
        `Authorized branch records incompatible retained outcomes for sync conflict ${conflictId}.`,
      );
    }
    const outcome = existing ?? {
      conflictId,
      retainedBundleHash: replay.command.resolution.retainedBundleHash,
      retainedValue: structuredClone(replay.command.resolution.retainedValue),
      outcomeIdentity,
      replaysByAuthorityRoot: new Map<string, AuthorizedSyncReplay[]>(),
    };
    const rootReplays = outcome.replaysByAuthorityRoot.get(rootHash) ?? [];
    rootReplays.push(replay);
    outcome.replaysByAuthorityRoot.set(rootHash, rootReplays);
    outcomes.set(conflictId, outcome);
  }
  return outcomes;
}

function bundleAuthorityRoots(bundle: ProtectedEffectBundle): string {
  return canonicalJson(
    [...new Set(
      bundle.operations.map(({ authorityRootOperationHash }) =>
        authorityRootOperationHash
      ),
    )].sort(compareText),
  );
}

/**
 * Semantic replays legitimately change envelope/receipt identity and a bounded
 * revision field in the command. Their protected cell projection must remain
 * byte-for-byte equivalent for each opaque authority root, or the history is
 * not safe to collapse as the same writer lineage.
 */
function bundleSemanticProjection(bundle: ProtectedEffectBundle): string {
  return canonicalJson(
    bundle.operations
      .map(({ authorityRootOperationHash, commandType, cells }) => ({
        authorityRootOperationHash,
        commandType,
        cells,
      }))
      .sort((left, right) =>
        compareText(
          canonicalJson(left),
          canonicalJson(right),
        )
      ),
  );
}

const protectedLifecycleEntities = new Set([
  "BetVersion",
  "DailyCommitment",
  "PlanVersion",
  "ReplanProposal",
  "ReviewRecord",
  "ExceptionRecord",
  "CloseDecision",
]);

const protectedProjectFields = new Set([
  "stage",
  "activeBetId",
  "activePlanVersionId",
  "holds",
]);

function writesProtectedLifecycle(replay: AuthorizedSyncReplay): boolean {
  const touches = replay.receipt.diff.some(
    ({ entity, field }) =>
      protectedLifecycleEntities.has(entity) ||
      (entity === "ProjectV2" && protectedProjectFields.has(field)),
  );
  return touches && !isKnownUnprotectedLifecycleWriter({
    command: replay.command,
    createdAt: replay.receipt.createdAt,
    diff: replay.receipt.diff,
  });
}

async function branchProtectedBundles(
  branch: AuthorizedSyncBranchV2,
): Promise<Map<string, BranchProtectedBundle>> {
  const projectedByKey = new Map<string, ProtectedEffectBundle[]>();
  const operationsByKey = new Map<string, Set<string>>();
  let replayWorkspace = JSON.parse(
    branch.trustedAncestorCanonical,
  ) as WorkspaceV2;
  for (const [index, replay] of branch.replays.entries()) {
    const postReplayWorkspace = branch.workspaceAfterReplays[index];
    if (postReplayWorkspace === undefined) {
      throw new SyncMergeError(
        "PROTECTED_RECORD_INVALID",
        `Authorized branch replay ${replay.operationHash} has no post-replay projection.`,
      );
    }
    if (
      replay.command.type === "open_sync_conflict" ||
      replay.command.type === "resolve_sync_conflict"
    ) {
      replayWorkspace = structuredClone(
        postReplayWorkspace,
      ) as WorkspaceV2;
      continue;
    }
    const projected = await projectProtectedEffectBundle({
      workspace: replayWorkspace,
      command: replay.command,
      commandId: replay.receipt.commandId,
      authorityRootOperationHash: replay.authorityRoot.operationHash,
      sourceOperationHash: replay.operationHash,
      receiptHash: replay.receipt.receiptHash,
      payloadHash: replay.receipt.payloadHash,
      createdAt: replay.receipt.createdAt,
      diff: replay.receipt.diff,
    });
    if (projected === undefined) {
      if (writesProtectedLifecycle(replay)) {
        throw new SyncMergeError(
          "PROTECTED_RECORD_INVALID",
          `Verified operation ${replay.operationHash} is an unknown protected lifecycle writer.`,
        );
      }
      replayWorkspace = structuredClone(postReplayWorkspace) as WorkspaceV2;
      continue;
    }
    const parts = projectedByKey.get(projected.logicalKey) ?? [];
    parts.push(projected);
    projectedByKey.set(projected.logicalKey, parts);
    const hashes = operationsByKey.get(projected.logicalKey) ?? new Set<string>();
    hashes.add(replay.operationHash);
    operationsByKey.set(projected.logicalKey, hashes);
    replayWorkspace = structuredClone(
      postReplayWorkspace,
    ) as WorkspaceV2;
  }
  const bundles = new Map<string, BranchProtectedBundle>();
  for (const [logicalKey, parts] of projectedByKey) {
    bundles.set(logicalKey, {
      bundle: await combineProtectedEffectBundles(parts),
      operationHashes: operationsByKey.get(logicalKey) ?? new Set(),
    });
  }
  return bundles;
}

type ProtectedRecordType = SyncConflictRecord["recordType"];

interface ProtectedRecordProjection {
  recordType: ProtectedRecordType;
  recordId: Id;
  value: JsonValue;
}

function parsedLogicalKey(
  logicalKey: string,
): readonly [ProtectedRecordType, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(logicalKey);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !["bet", "daily_commitment", "review", "exception", "close"].includes(
      String(parsed[0]),
    ) ||
    typeof parsed[1] !== "string"
  ) {
    throw new SyncMergeError(
      "PROTECTED_RECORD_INVALID",
      `Protected logical key ${logicalKey} is malformed.`,
    );
  }
  return parsed as unknown as readonly [ProtectedRecordType, string];
}

function protectedRecordProjection(
  workspace: Readonly<WorkspaceV2>,
  logicalKey: string,
): ProtectedRecordProjection {
  const [recordType, owner] = parsedLogicalKey(logicalKey);
  const matches = (() => {
    switch (recordType) {
      case "bet": {
        const projects = workspace.projects.filter(({ id }) => id === owner);
        if (projects.length !== 1 || projects[0].activeBetId === undefined) {
          return [];
        }
        return workspace.bets.filter(({ id, projectId }) =>
          id === projects[0].activeBetId && projectId === owner,
        );
      }
      case "daily_commitment":
        return workspace.dailyCommitments.filter(
          (commitment) =>
            commitment.localDate === owner &&
            !workspace.dailyCommitments.some(
              ({ supersedesId }) => supersedesId === commitment.id,
            ),
        );
      case "review":
        return workspace.reviews.filter(({ triggerKey }) => triggerKey === owner);
      case "exception":
        return workspace.exceptions.filter(({ id }) => id === owner);
      case "close":
        return workspace.closeDecisions.filter(
          ({ projectId }) => projectId === owner,
        );
    }
  })();
  if (matches.length !== 1) {
    throw new SyncMergeError(
      "PROTECTED_RECORD_INVALID",
      `Protected ${logicalKey} must resolve to one final record.`,
    );
  }
  return {
    recordType,
    recordId: matches[0].id,
    value: structuredClone(matches[0]) as unknown as JsonValue,
  };
}

interface ProtectedDivergence {
  logicalKey: string;
  recordType: ProtectedRecordType;
  localRecordId: Id;
  remoteRecordId: Id;
  localValue: JsonValue;
  remoteValue: JsonValue;
  localBundle: ProtectedEffectBundle;
  remoteBundle: ProtectedEffectBundle;
  affectedProjectIds: Id[];
  affectedRecordIds: Id[];
}

interface PlannedConflict extends ProtectedDivergence {
  id: string;
  openCommandId: string;
  openedAt: ISODate;
  resolutionPredecessorConflictId?: Id;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function replayWasApplied(
  workspace: Readonly<WorkspaceV2>,
  replay: AuthorizedSyncReplay,
  history: VerifiedSyncHistory,
): boolean {
  const authorityIdentity = canonicalJson({
    commandId: replay.receipt.commandId,
    commandType: replay.receipt.commandType,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    createdAt: replay.receipt.createdAt,
  });
  const matches = workspace.commandReceipts.filter(
    (receipt) =>
      receipt.status === "applied" &&
      canonicalJson({
        commandId: receipt.commandId,
        commandType: receipt.commandType,
        actorId: receipt.actorId,
        actorKind: receipt.actorKind,
        createdAt: receipt.createdAt,
      }) === authorityIdentity,
  );
  if (matches.length === 0) return false;
  if (matches.length !== 1) {
    throw new SyncMergeError(
      "REPLAY_AUTHORITY_MISMATCH",
      `Command authority ${replay.receipt.commandId} appears more than once in the local Workspace.`,
    );
  }
  const [localReceipt] = matches;
  if (localReceipt.origin !== "sync") {
    if (
      canonicalJson(localReceipt) !==
      canonicalJson(replay.authorityRoot.receipt)
    ) {
      throw new SyncMergeError(
        "REPLAY_AUTHORITY_MISMATCH",
        `Local command ${localReceipt.commandId} collides with a different verified authority-root payload.`,
      );
    }
    return true;
  }
  const sourceHash = syncReceiptSourceOperationHash(localReceipt);
  const localRoot =
    sourceHash === undefined
      ? undefined
      : verifiedSyncAuthorityRootV2(history, sourceHash);
  if (
    localRoot === undefined ||
    localRoot.operationHash !== replay.authorityRoot.operationHash ||
    localRoot.payloadHash !== replay.authorityRoot.payloadHash
  ) {
    throw new SyncMergeError(
      "REPLAY_AUTHORITY_MISMATCH",
      `Local sync receipt ${localReceipt.commandId} does not trace to the remote command's verified authority root.`,
    );
  }
  return true;
}

function syncReceiptSourceOperationHash(
  receipt: Readonly<CommandReceipt>,
): string | undefined {
  return (
    /^sync-replay:([a-f0-9]{64}):/s.exec(receipt.source.sourceId)?.[1] ??
    /^sync-semantic:([a-f0-9]{64}):(commit_today|propose_replan):/s.exec(
      receipt.source.sourceId,
    )?.[1]
  );
}

function conflictWasOpened(
  workspace: Readonly<WorkspaceV2>,
  conflict: PlannedConflict,
  commonAncestorHash: string,
): boolean {
  const expectedBundleHashes = [
    conflict.localBundle.hash,
    conflict.remoteBundle.hash,
  ].sort(compareText);
  const matches = workspace.syncConflicts.filter(
    (record) =>
      record.id === conflict.id &&
      record.logicalKey === conflict.logicalKey &&
      record.commonAncestorHash === commonAncestorHash &&
      record.localBundle !== undefined &&
      record.remoteBundle !== undefined &&
      canonicalJson([
        record.localBundle.hash,
        record.remoteBundle.hash,
      ].sort(compareText)) === canonicalJson(expectedBundleHashes),
  );
  return matches.length === 1;
}

function isDerivedConflictOpen(
  replay: AuthorizedSyncReplay,
  plannedConflicts: readonly PlannedConflict[],
  commonAncestorHash: string,
): boolean {
  if (replay.command.type !== "open_sync_conflict") return false;
  const draft = replay.command.conflict;
  const planned = plannedConflicts.find(
    (conflict) =>
      conflict.id === draft.id &&
      conflict.logicalKey === draft.logicalKey,
  );
  if (
    planned === undefined ||
    draft.commonAncestorHash !== commonAncestorHash
  ) {
    return false;
  }
  if (draft.localBundle === undefined || draft.remoteBundle === undefined) {
    return false;
  }
  return canonicalJson([
    draft.localBundle.hash,
    draft.remoteBundle.hash,
  ].sort(compareText)) === canonicalJson([
    planned.localBundle.hash,
    planned.remoteBundle.hash,
  ].sort(compareText));
}

function persistedConflictWasOpened(
  workspace: Readonly<WorkspaceV2>,
  replay: AuthorizedSyncReplay,
): boolean {
  if (replay.command.type !== "open_sync_conflict") return false;
  const draft = replay.command.conflict;
  if (
    draft.logicalKey === undefined ||
    draft.localBundle === undefined ||
    draft.remoteBundle === undefined
  ) return false;
  const expectedHashes = [
    draft.localBundle.hash,
    draft.remoteBundle.hash,
  ].sort(compareText);
  return workspace.syncConflicts.some(
    (conflict) =>
      conflict.id === draft.id &&
      conflict.logicalKey === draft.logicalKey &&
      conflict.commonAncestorHash === draft.commonAncestorHash &&
      conflict.localBundle !== undefined &&
      conflict.remoteBundle !== undefined &&
      canonicalJson([
        conflict.localBundle.hash,
        conflict.remoteBundle.hash,
      ].sort(compareText)) === canonicalJson(expectedHashes),
  );
}

function replayContext(
  workspace: Readonly<WorkspaceV2>,
  replay: AuthorizedSyncReplay,
): CommandContext {
  return {
    commandId: replay.receipt.commandId,
    expectedRevision: workspace.revision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: "sync",
    source: {
      sourceId: `sync-replay:${replay.operationHash}:${replay.receipt.source.sourceId}`,
      verified: replay.receipt.source.verified,
      capabilities: Array.from(
        new Set([...replay.receipt.source.capabilities, "replay_receipt" as const]),
      ),
    },
    now: replay.receipt.createdAt,
  };
}

function semanticReplayContext(
  workspace: Readonly<WorkspaceV2>,
  replay: AuthorizedSemanticSyncReplay,
): CommandContext {
  return {
    commandId: replay.receipt.commandId,
    expectedRevision: workspace.revision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: "sync",
    source: {
      sourceId: `sync-semantic:${replay.operationHash}:${replay.semanticKind}:${replay.receipt.source.sourceId}`,
      verified: replay.receipt.source.verified,
      capabilities: Array.from(
        new Set([...replay.receipt.source.capabilities, "replay_receipt" as const]),
      ),
    },
    now: replay.receipt.createdAt,
  };
}

function conflictCommand(
  conflict: PlannedConflict,
  commonAncestorHash: string,
  workspace: Readonly<WorkspaceV2>,
): V2Command {
  const currentProjectIds = new Set(
    workspace.projects.map(({ id }) => id),
  );
  return {
    type: "open_sync_conflict",
    conflict: {
      id: conflict.id,
      recordType: conflict.recordType,
      recordId: conflict.localRecordId,
      remoteRecordId: conflict.remoteRecordId,
      logicalKey: conflict.logicalKey,
      affectedProjectIds: conflict.affectedProjectIds.filter((projectId) =>
        currentProjectIds.has(projectId)
      ),
      affectedRecordIds: structuredClone(conflict.affectedRecordIds),
      commonAncestorHash,
      localValue: structuredClone(conflict.localValue),
      remoteValue: conflict.remoteValue,
      localBundle: structuredClone(conflict.localBundle),
      remoteBundle: structuredClone(conflict.remoteBundle),
    },
  };
}

function conflictContext(
  conflict: PlannedConflict,
  commonAncestorHash: string,
  expectedRevision: number,
): CommandContext {
  return {
    commandId: conflict.openCommandId,
    expectedRevision,
    actorId: "sync-conflict-detector",
    actorKind: "system",
    origin: "agent",
    source: {
      sourceId: `sync-merge:${commonAncestorHash}`,
      verified: true,
      capabilities: ["open_conflict"],
    },
    now: conflict.openedAt,
  };
}

type PlannedMergeEffect =
  | { kind: "replay"; replay: AuthorizedSyncReplay }
  | {
      kind: "equivalent_resolution";
      replay: AuthorizedSyncReplay;
      authorization: AuthorizedEquivalentConflictResolution;
    }
  | {
      kind: "semantic_replay";
      replay: AuthorizedSemanticSyncReplay;
      sourceOperationHash: string;
    }
  | {
      kind: "open_conflict";
      conflict: PlannedConflict;
      authorization: AuthorizedConflictOpen;
    }
  | {
      kind: "propagate_conflict_open";
      replay: AuthorizedSyncReplay;
      conflictId: Id;
      authorization: AuthorizedConflictOpen;
    };

interface PlannedMergeProgress {
  effects: PlannedMergeEffect[];
  states: WorkspaceV2[];
}

async function planMergeProgress(input: {
  localWorkspace: Readonly<WorkspaceV2>;
  localBranch: AuthorizedSyncBranchV2;
  remoteBranch: AuthorizedSyncBranchV2;
  history: VerifiedSyncHistory;
  remoteReplays: readonly AuthorizedSyncReplay[];
  skippedRemoteWriters: ReadonlySet<string>;
  equivalentResolutionOperationHashes: ReadonlySet<string>;
  conflicts: readonly PlannedConflict[];
  commonAncestorHash: string;
  evaluationNow: ISODate;
}): Promise<PlannedMergeProgress> {
  const candidates: Array<
    | { kind: "replay"; replay: AuthorizedSyncReplay }
    | { kind: "open_conflict"; conflict: PlannedConflict }
    | { kind: "propagate_conflict_open"; replay: AuthorizedSyncReplay }
  > = [];
  const scheduledConflictIds = new Set<string>();
  for (const replay of input.remoteReplays) {
    if (
      input.skippedRemoteWriters.has(replay.operationHash) ||
      replayWasApplied(input.localWorkspace, replay, input.history)
    ) continue;
    if (replay.command.type === "open_sync_conflict") {
      const planned = input.conflicts.find((conflict) =>
        isDerivedConflictOpen(
          replay,
          [conflict],
          input.commonAncestorHash,
        )
      );
      if (
        planned !== undefined &&
        !scheduledConflictIds.has(planned.id) &&
        !conflictWasOpened(
          input.localWorkspace,
          planned,
          input.commonAncestorHash,
        )
      ) {
        candidates.push({ kind: "open_conflict", conflict: planned });
        scheduledConflictIds.add(planned.id);
      } else if (
        planned === undefined &&
        !persistedConflictWasOpened(input.localWorkspace, replay)
      ) {
        candidates.push({ kind: "propagate_conflict_open", replay });
      }
      continue;
    }
    candidates.push({ kind: "replay", replay });
  }
  for (const conflict of input.conflicts) {
    if (
      scheduledConflictIds.has(conflict.id) ||
      conflictWasOpened(
        input.localWorkspace,
        conflict,
        input.commonAncestorHash,
      )
    ) continue;
    candidates.push({ kind: "open_conflict", conflict });
    scheduledConflictIds.add(conflict.id);
  }
  let workspace = structuredClone(input.localWorkspace) as WorkspaceV2;
  const states: WorkspaceV2[] = [structuredClone(workspace)];
  const effects: PlannedMergeEffect[] = [];
  for (const candidate of candidates) {
    let effect: PlannedMergeEffect | undefined =
      candidate.kind === "replay" ? candidate : undefined;
    let command =
      candidate.kind === "replay"
        ? (structuredClone(candidate.replay.command) as V2Command)
        : candidate.kind === "open_conflict"
          ? conflictCommand(
              candidate.conflict,
              input.commonAncestorHash,
              workspace,
            )
          : (structuredClone(candidate.replay.command) as V2Command);
    let context =
      candidate.kind === "replay"
        ? replayContext(workspace, candidate.replay)
        : candidate.kind === "open_conflict"
          ? conflictContext(
              candidate.conflict,
              input.commonAncestorHash,
              workspace.revision,
            )
          : replayContext(workspace, candidate.replay);
    let authorizedConflictOpen: AuthorizedConflictOpen | undefined;
    let authorizedEquivalentConflictResolution:
      | AuthorizedEquivalentConflictResolution
      | undefined;
    if (
      candidate.kind === "replay" &&
      input.equivalentResolutionOperationHashes.has(
        candidate.replay.operationHash,
      )
    ) {
      authorizedEquivalentConflictResolution =
        authorizeEquivalentConflictResolutionFromVerifiedReplayV2(
          candidate.replay,
          workspace,
        );
      command = structuredClone(
        authorizedEquivalentConflictResolution.command,
      ) as V2Command;
      context = structuredClone(
        authorizedEquivalentConflictResolution.context,
      );
      effect = {
        kind: "equivalent_resolution",
        replay: candidate.replay,
        authorization: authorizedEquivalentConflictResolution,
      };
    } else if (candidate.kind === "open_conflict") {
      if (command.type !== "open_sync_conflict") {
        throw new SyncMergeError(
          "CONFLICT_OPEN_REJECTED",
          `Planned conflict ${candidate.conflict.id} did not produce an open command.`,
        );
      }
      authorizedConflictOpen =
        candidate.conflict.resolutionPredecessorConflictId === undefined
          ? await authorizeConflictOpenFromBranchesV2({
              localBranch: input.localBranch,
              remoteBranch: input.remoteBranch,
              currentWorkspace: workspace,
              command,
              context,
            })
          : await authorizeConflictOpenFromResolutionBranchesV2({
              localBranch: input.localBranch,
              remoteBranch: input.remoteBranch,
              predecessorConflictId:
                candidate.conflict.resolutionPredecessorConflictId,
              currentWorkspace: workspace,
              command,
              context,
            });
      effect = {
        kind: "open_conflict",
        conflict: candidate.conflict,
        authorization: authorizedConflictOpen,
      };
    } else if (candidate.kind === "propagate_conflict_open") {
      if (candidate.replay.command.type !== "open_sync_conflict") {
        throw new SyncMergeError(
          "CONFLICT_OPEN_REJECTED",
          `Persisted operation ${candidate.replay.operationHash} is not a conflict open.`,
        );
      }
      authorizedConflictOpen =
        await authorizeConflictOpenFromVerifiedReplayV2(
          candidate.replay,
          workspace,
        );
      command = structuredClone(authorizedConflictOpen.command) as V2Command;
      context = structuredClone(authorizedConflictOpen.context);
      effect = {
        kind: "propagate_conflict_open",
        replay: candidate.replay,
        conflictId: candidate.replay.command.conflict.id,
        authorization: authorizedConflictOpen,
      };
    }
    let result = await executeCommand(workspace, command, context, {
      evaluationNow: input.evaluationNow,
      ...(authorizedConflictOpen === undefined
        ? {}
        : { authorizedConflictOpen }),
      ...(authorizedEquivalentConflictResolution === undefined
        ? {}
        : { authorizedEquivalentConflictResolution }),
    });
    if (
      !result.ok &&
      candidate.kind === "replay" &&
      (candidate.replay.command.type === "commit_today" ||
        candidate.replay.command.type === "propose_replan")
    ) {
      let semantic: AuthorizedSemanticSyncReplay;
      try {
        semantic = await authorizeSemanticSyncReplayV2(
          candidate.replay,
          workspace,
        );
      } catch (error) {
        throw new SyncMergeError(
          "MERGE_REPLAY_REJECTED",
          `Verified operation ${candidate.replay.operationHash} cannot be semantically rebased without changing its approved read-set.`,
          error,
        );
      }
      effect = {
        kind: "semantic_replay",
        replay: semantic,
        sourceOperationHash: candidate.replay.operationHash,
      };
      command = structuredClone(semantic.command) as V2Command;
      context = semanticReplayContext(workspace, semantic);
      result = await executeCommand(workspace, command, context, {
        evaluationNow: input.evaluationNow,
      });
    }
    if (!result.ok) {
      if (effect === undefined) {
        throw new SyncMergeError(
          "CONFLICT_OPEN_REJECTED",
          "A planned merge effect had no conflict authority.",
        );
      }
      const code =
        effect.kind === "replay" ||
          effect.kind === "equivalent_resolution" ||
          effect.kind === "semantic_replay"
          ? "MERGE_REPLAY_REJECTED"
          : "CONFLICT_OPEN_REJECTED";
      const identity =
        effect.kind === "replay" || effect.kind === "equivalent_resolution"
          ? effect.replay.operationHash
          : effect.kind === "semantic_replay"
            ? effect.sourceOperationHash
            : effect.kind === "open_conflict"
              ? effect.conflict.id
              : effect.replay.operationHash;
      throw new SyncMergeError(
        code,
        `Planned merge effect ${identity} was rejected: ${result.rejection.code} (${result.rejection.gate ?? "no_gate"}): ${result.rejection.reason}.`,
        result.rejection,
      );
    }
    if (effect === undefined) {
      throw new SyncMergeError(
        "CONFLICT_OPEN_REJECTED",
        "A planned merge effect had no authorized form.",
      );
    }
    effects.push(effect);
    workspace = result.workspace;
    states.push(structuredClone(workspace));
  }
  return { effects, states };
}

function provenProgressIndex(
  current: WorkspaceV2,
  states: readonly WorkspaceV2[],
): number | undefined {
  const currentJson = canonicalJson(current);
  for (let index = states.length - 1; index >= 0; index -= 1) {
    if (canonicalJson(states[index]) === currentJson) return index;
  }
  return undefined;
}

function checkpointRepository(
  repository: AtomicWorkspaceRepository,
  expectedWorkspace: WorkspaceV2,
): AtomicWorkspaceRepository {
  const expectedJson = canonicalJson(expectedWorkspace);
  return new Proxy(repository, {
    get(target, property) {
      if (property === "load") {
        return async () => {
          const current = await target.load();
          if (
            current === undefined ||
            canonicalJson(current) !== expectedJson
          ) {
            throw new SyncMergeError(
              "LOCAL_CHECKPOINT_STALE",
              "The proven merge prefix changed before its next effect.",
            );
          }
          return current;
        };
      }
      if (property === "commit") {
        return async (
          input: Parameters<AtomicWorkspaceRepository["commit"]>[0],
        ) => {
          if (input.expectedRevision !== expectedWorkspace.revision) {
            throw new SyncMergeError(
              "MERGE_PROGRESS_DIVERGED",
              "CommandService attempted to commit from an unproved merge revision.",
            );
          }
          return target.commit(input);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AtomicWorkspaceRepository;
}

export class SyncMergeV2 {
  readonly #repository: AtomicWorkspaceRepository;
  readonly #remote: SyncRemoteHistoryPortV2;
  readonly #workspaceId: Id;
  readonly #keyProvider: SyncKeyProviderV2;

  constructor(options: SyncMergeV2Options) {
    this.#repository = options.repository;
    this.#remote = options.remote;
    this.#workspaceId = options.workspaceId;
    this.#keyProvider = options.keyProvider;
  }

  async merge(input: MergeSyncBranchesV2Input): Promise<SyncMergeResultV2> {
    const passphrase = await this.#keyProvider.getPassphrase();
    if (passphrase === undefined || passphrase.trim().length === 0) {
      throw new SyncMergeError(
        "SYNC_KEY_LOCKED",
        "Unlock the sync key before merging remote history.",
      );
    }
    const history = await materializeRemoteSyncHistoryV2({
      remote: this.#remote,
      workspaceId: this.#workspaceId,
      passphrase,
    });
    const ancestor = findLatestCommonAncestorV2(
      history,
      input.localHeadHash,
      input.remoteHeadHash,
    );
    const ancestorOperationHash =
      "kind" in ancestor && ancestor.kind === "genesis"
        ? undefined
        : ancestor.operationHash;
    const [localBranch, remoteBranch] = await Promise.all([
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: input.trustedAncestorWorkspace,
        ...(ancestorOperationHash === undefined
          ? {}
          : { ancestorOperationHash }),
        headOperationHash: input.localHeadHash,
      }),
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: input.trustedAncestorWorkspace,
        ...(ancestorOperationHash === undefined
          ? {}
          : { ancestorOperationHash }),
        headOperationHash: input.remoteHeadHash,
      }),
    ]);
    const commonAncestorHash =
      ancestorOperationHash ?? `genesis:${this.#workspaceId}`;
    const localResolutionOutcomes = branchResolutionOutcomes(localBranch);
    const remoteResolutionOutcomes = branchResolutionOutcomes(remoteBranch);
    const equivalentResolutionOperationHashes = new Set<string>();
    const skippedRemoteWriters = new Set<string>();
    const resolutionConflicts: PlannedConflict[] = [];
    for (const [conflictId, remoteOutcome] of remoteResolutionOutcomes) {
      const localOutcome = localResolutionOutcomes.get(conflictId);
      if (localOutcome === undefined) continue;
      const sharedAuthorityRoots = [
        ...remoteOutcome.replaysByAuthorityRoot.keys(),
      ].filter((rootHash) =>
        localOutcome.replaysByAuthorityRoot.has(rootHash)
      );
      if (localOutcome.outcomeIdentity !== remoteOutcome.outcomeIdentity) {
        if (sharedAuthorityRoots.length > 0) {
          throw new SyncMergeError(
            "REPLAY_AUTHORITY_MISMATCH",
            `Sync conflict ${conflictId} changed its retained decision under authority root ${sharedAuthorityRoots[0]}.`,
          );
        }
        const predecessorMatches = input.trustedAncestorWorkspace.syncConflicts
          .filter(({ id }) => id === conflictId);
        const predecessor = predecessorMatches[0];
        if (
          predecessorMatches.length !== 1 ||
          predecessor === undefined ||
          predecessor.resolvedAt !== undefined ||
          predecessor.logicalKey === undefined ||
          predecessor.remoteRecordId === undefined ||
          predecessor.localBundle === undefined ||
          predecessor.remoteBundle === undefined ||
          predecessor.affectedProjectIds === undefined ||
          predecessor.affectedRecordIds === undefined
        ) {
          throw new SyncMergeError(
            "PROTECTED_RECORD_INVALID",
            `Concurrent resolution predecessor ${conflictId} is not one complete unresolved conflict at the trusted ancestor.`,
          );
        }
        const predecessorLocalBundle = predecessor.localBundle;
        const predecessorRemoteBundle = predecessor.remoteBundle;
        const predecessorRemoteRecordId = predecessor.remoteRecordId;
        const sideForOutcome = (outcome: BranchResolutionOutcome) => {
          if (
            outcome.retainedBundleHash === predecessorLocalBundle.hash &&
            canonicalJson(outcome.retainedValue) ===
              canonicalJson(predecessor.localValue)
          ) {
            return {
              bundle: predecessorLocalBundle,
              recordId: predecessor.recordId,
            };
          }
          if (
            outcome.retainedBundleHash === predecessorRemoteBundle.hash &&
            canonicalJson(outcome.retainedValue) ===
              canonicalJson(predecessor.remoteValue)
          ) {
            return {
              bundle: predecessorRemoteBundle,
              recordId: predecessorRemoteRecordId,
            };
          }
          return undefined;
        };
        const localSide = sideForOutcome(localOutcome);
        const remoteSide = sideForOutcome(remoteOutcome);
        if (
          localSide === undefined ||
          remoteSide === undefined ||
          localSide.bundle.hash === remoteSide.bundle.hash
        ) {
          throw new SyncMergeError(
            "REPLAY_AUTHORITY_MISMATCH",
            `Concurrent resolution outcomes for ${conflictId} do not select the predecessor's exact protected bundles.`,
          );
        }
        for (const replays of remoteOutcome.replaysByAuthorityRoot.values()) {
          for (const replay of replays) {
            skippedRemoteWriters.add(replay.operationHash);
          }
        }
        const authorityRoots = [
          ...localOutcome.replaysByAuthorityRoot.entries(),
          ...remoteOutcome.replaysByAuthorityRoot.entries(),
        ].map(([operationHash, replays]) => ({
          operationHash,
          createdAt: replays[0]?.authorityRoot.createdAt ?? "",
        }));
        const successorIdentity = await resolutionSuccessorIdentityV2({
          workspaceId: this.#workspaceId,
          originalConflictId: conflictId,
          commonAncestorHash,
          localHeadOperationHash: input.localHeadHash,
          authorityRoots,
          retainedBundleHashes: [
            localSide.bundle.hash,
            remoteSide.bundle.hash,
          ],
          canonicalOutcomes: [
            localOutcome.outcomeIdentity,
            remoteOutcome.outcomeIdentity,
          ],
        });
        resolutionConflicts.push({
          logicalKey: predecessor.logicalKey,
          recordType: predecessor.recordType,
          localRecordId: localSide.recordId,
          remoteRecordId: remoteSide.recordId,
          localValue: structuredClone(localOutcome.retainedValue),
          remoteValue: structuredClone(remoteOutcome.retainedValue),
          localBundle: structuredClone(localSide.bundle),
          remoteBundle: structuredClone(remoteSide.bundle),
          affectedProjectIds: [...predecessor.affectedProjectIds].sort(compareText),
          affectedRecordIds: [...predecessor.affectedRecordIds].sort(compareText),
          id: successorIdentity.conflictId,
          openCommandId: successorIdentity.commandId,
          openedAt: successorIdentity.openedAt,
          resolutionPredecessorConflictId: conflictId,
        });
        continue;
      }
      for (const [rootHash, replays] of remoteOutcome.replaysByAuthorityRoot) {
        if (!localOutcome.replaysByAuthorityRoot.has(rootHash)) {
          for (const replay of replays) {
            equivalentResolutionOperationHashes.add(replay.operationHash);
          }
        }
      }
    }
    const [localChanges, remoteChanges] = await Promise.all([
      branchProtectedBundles(localBranch),
      branchProtectedBundles(remoteBranch),
    ]);
    const divergences: ProtectedDivergence[] = [];
    for (const [logicalKey, remoteChange] of remoteChanges) {
      const localChange = localChanges.get(logicalKey);
      if (localChange === undefined) continue;
      const localRecord = protectedRecordProjection(
        localBranch.workspace,
        logicalKey,
      );
      const remoteRecord = protectedRecordProjection(
        remoteBranch.workspace,
        logicalKey,
      );
      for (const operationHash of remoteChange.operationHashes) {
        skippedRemoteWriters.add(operationHash);
      }
      if (
        bundleAuthorityRoots(localChange.bundle) ===
        bundleAuthorityRoots(remoteChange.bundle)
      ) {
        if (
          bundleSemanticProjection(localChange.bundle) !==
            bundleSemanticProjection(remoteChange.bundle) ||
          canonicalJson(localRecord.value) !== canonicalJson(remoteRecord.value)
        ) {
          throw new SyncMergeError(
            "PROTECTED_RECORD_INVALID",
            `Protected lineage ${logicalKey} kept one authority root but changed its primary or artifact projection.`,
          );
        }
        continue;
      }
      if (localChange.bundle.hash !== remoteChange.bundle.hash) {
        const affectedRecordIds = [...new Set([
          localRecord.recordId,
          remoteRecord.recordId,
          ...protectedEffectBundleTouchedEntityIds(localChange.bundle),
          ...protectedEffectBundleTouchedEntityIds(remoteChange.bundle),
        ])].sort(compareText);
        const affectedProjectIds = protectedEffectBundlePairAffectedProjectIds({
          recordType: localRecord.recordType,
          localValue: localRecord.value,
          remoteValue: remoteRecord.value,
          localBundle: localChange.bundle,
          remoteBundle: remoteChange.bundle,
        });
        divergences.push({
          logicalKey,
          recordType: localRecord.recordType,
          localRecordId: localRecord.recordId,
          remoteRecordId: remoteRecord.recordId,
          localValue: localRecord.value,
          remoteValue: remoteRecord.value,
          localBundle: localChange.bundle,
          remoteBundle: remoteChange.bundle,
          affectedProjectIds,
          affectedRecordIds,
        });
      }
    }
    divergences.sort(
      (left, right) =>
        compareText(left.logicalKey, right.logicalKey),
    );
    const ordinaryPlannedConflicts: PlannedConflict[] = await Promise.all(
      divergences.map(async (divergence) => {
        const writerTimes = [
          ...divergence.localBundle.operations,
          ...divergence.remoteBundle.operations,
        ].map(({ createdAt }) => createdAt);
        const sortedWriterTimes = [...writerTimes].sort(compareText);
        const openedAt = sortedWriterTimes[sortedWriterTimes.length - 1];
        if (openedAt === undefined) {
          throw new SyncMergeError(
            "PROTECTED_RECORD_INVALID",
            `Protected divergence ${divergence.logicalKey} has no verified writer timestamp.`,
          );
        }
        const bundleHashes = [
          divergence.localBundle.hash,
          divergence.remoteBundle.hash,
        ].sort(compareText);
        const digest = await sha256Hex(
          canonicalJson({
            workspaceId: this.#workspaceId,
            commonAncestorHash,
            logicalKey: divergence.logicalKey,
            bundleHashes,
          }),
        );
        return {
          ...divergence,
          id: `sync-conflict-${digest.slice(0, 32)}`,
          // The conflict identity is symmetric, but the open command is a
          // branch-local state transition whose local/remote payload is
          // necessarily oriented. Separate independent authority roots.
          openCommandId: `open-sync-conflict-${digest.slice(0, 32)}-branch-${input.localHeadHash}`,
          openedAt,
        };
      }),
    );
    const plannedConflicts = [
      ...resolutionConflicts,
      ...ordinaryPlannedConflicts,
    ].sort((left, right) =>
      compareText(
        `${left.logicalKey}:${left.id}`,
        `${right.logicalKey}:${right.id}`,
      )
    );
    const current = await this.#repository.load();
    if (current === undefined || current.workspaceId !== this.#workspaceId) {
      throw new SyncMergeError(
        "WORKSPACE_NOT_READY",
        "The expected V2 Workspace must be bootstrapped before merge.",
      );
    }
    const progress = await planMergeProgress({
      localWorkspace: localBranch.workspace,
      localBranch,
      remoteBranch,
      history,
      remoteReplays: remoteBranch.replays,
      skippedRemoteWriters,
      equivalentResolutionOperationHashes,
      conflicts: plannedConflicts,
      commonAncestorHash,
      evaluationNow: input.now,
    });
    const progressIndex = provenProgressIndex(current, progress.states);
    if (progressIndex === undefined) {
      throw new SyncMergeError(
        "LOCAL_CHECKPOINT_STALE",
        "The local Workspace is neither the verified local branch checkpoint nor a proven merge prefix.",
      );
    }
    if (progressIndex === progress.effects.length) {
      return {
        status: "already_merged",
        commonAncestorHash,
        replayedOperationHashes: [],
        openedConflictIds: [],
        revision: current.revision,
      };
    }

    for (
      let effectIndex = progressIndex;
      effectIndex < progress.effects.length;
      effectIndex += 1
    ) {
      const effect = progress.effects[effectIndex];
      const guardedRepository = checkpointRepository(
        this.#repository,
        progress.states[effectIndex],
      );
      const service = new CommandService(guardedRepository, this.#workspaceId);
      const result =
        effect.kind === "replay"
          ? await service.dispatchVerifiedReplay(effect.replay, {
              evaluationNow: input.now,
            })
          : effect.kind === "equivalent_resolution"
            ? await service.dispatchAuthorizedEquivalentConflictResolution(
                effect.authorization,
                { evaluationNow: input.now },
              )
          : effect.kind === "semantic_replay"
            ? await service.dispatchAuthorizedSemanticReplay(effect.replay, {
                evaluationNow: input.now,
              })
          : await service.dispatchAuthorizedConflictOpen(
              effect.authorization,
              { evaluationNow: input.now },
            );
      if (!result.ok) {
        const code =
          effect.kind === "replay" ||
            effect.kind === "equivalent_resolution" ||
            effect.kind === "semantic_replay"
            ? "MERGE_REPLAY_REJECTED"
            : "CONFLICT_OPEN_REJECTED";
        const identity =
          effect.kind === "replay" || effect.kind === "equivalent_resolution"
            ? effect.replay.operationHash
            : effect.kind === "semantic_replay"
              ? effect.sourceOperationHash
              : effect.kind === "open_conflict"
                ? effect.conflict.id
                : effect.replay.operationHash;
        throw new SyncMergeError(
          code,
          `Merge effect ${identity} was rejected: ${result.rejection.code} (${result.rejection.gate ?? "no_gate"}): ${result.rejection.reason}.`,
          result.rejection,
        );
      }
      if (
        canonicalJson(result.workspace) !==
        canonicalJson(progress.states[effectIndex + 1])
      ) {
        throw new SyncMergeError(
          "MERGE_PROGRESS_DIVERGED",
          "A persisted merge effect did not produce its proven next checkpoint.",
        );
      }
    }
    const merged = await this.#repository.load();
    if (merged === undefined) {
      throw new SyncMergeError(
        "WORKSPACE_NOT_READY",
        "The Workspace disappeared during merge.",
      );
    }
    return {
      status: "merged",
      commonAncestorHash,
      replayedOperationHashes: progress.effects.flatMap((effect) =>
        effect.kind === "replay" || effect.kind === "equivalent_resolution"
          ? [effect.replay.operationHash]
          : effect.kind === "semantic_replay"
            ? [effect.sourceOperationHash]
            : [],
      ),
      openedConflictIds: progress.effects.flatMap((effect) =>
        effect.kind === "open_conflict"
          ? [effect.conflict.id]
          : effect.kind === "propagate_conflict_open"
            ? [effect.conflictId]
            : [],
      ),
      revision: merged.revision,
    };
  }
}
