import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  type CommandContext,
  type V2Command,
} from "../domain/commands";
import type { JsonValue, WorkspaceV2 } from "../domain/types";
import {
  applyRemoteProtectedEffectBundle,
  combineProtectedEffectBundles,
  isKnownUnprotectedLifecycleWriterForView,
  projectProtectedEffectBundle,
  type ProtectedEffectBundle,
} from "./syncConflictBundles";
import {
  isAuthorizedSyncBranchV2,
  isAuthorizedSyncReplay,
  type AuthorizedSyncBranchV2,
  type AuthorizedSyncReplay,
} from "./syncProtocol";

type OpenSyncConflictCommand = Extract<
  V2Command,
  { type: "open_sync_conflict" }
>;
type ResolveSyncConflictCommand = Extract<
  V2Command,
  { type: "resolve_sync_conflict" }
>;

const authorizedConflictOpenBrand: unique symbol = Symbol(
  "AuthorizedConflictOpen",
);

export interface AuthorizedConflictOpen {
  readonly [authorizedConflictOpenBrand]: true;
  readonly command: Readonly<OpenSyncConflictCommand>;
  readonly context: Readonly<CommandContext>;
}

const authorizedConflictOpens = new WeakSet<object>();

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

class AuthorizedConflictOpenValue implements AuthorizedConflictOpen {
  readonly [authorizedConflictOpenBrand] = true as const;
  readonly #workspaceCanonical: string;
  readonly #commandCanonical: string;
  readonly #contextCanonical: string;

  constructor(
    workspace: Readonly<WorkspaceV2>,
    command: Readonly<OpenSyncConflictCommand>,
    context: Readonly<CommandContext>,
  ) {
    this.#workspaceCanonical = canonicalJson(workspace);
    this.#commandCanonical = canonicalJson(command);
    this.#contextCanonical = canonicalJson(context);
    Object.freeze(this);
    authorizedConflictOpens.add(this);
  }

  get command(): Readonly<OpenSyncConflictCommand> {
    return JSON.parse(this.#commandCanonical) as OpenSyncConflictCommand;
  }

  get context(): Readonly<CommandContext> {
    return JSON.parse(this.#contextCanonical) as CommandContext;
  }

  matches(
    workspace: Readonly<WorkspaceV2>,
    command: Readonly<OpenSyncConflictCommand>,
    context: Readonly<CommandContext>,
  ): boolean {
    return (
      this.#workspaceCanonical === canonicalJson(workspace) &&
      this.#commandCanonical === canonicalJson(command) &&
      this.#contextCanonical === canonicalJson(context)
    );
  }
}

export function isAuthorizedConflictOpenFor(
  value: unknown,
  workspace: Readonly<WorkspaceV2>,
  command: Readonly<OpenSyncConflictCommand>,
  context: Readonly<CommandContext>,
): value is AuthorizedConflictOpen {
  return (
    typeof value === "object" &&
    value !== null &&
    authorizedConflictOpens.has(value) &&
    value instanceof AuthorizedConflictOpenValue &&
    value.matches(workspace, command, context)
  );
}

const authorizedEquivalentResolutionBrand: unique symbol = Symbol(
  "AuthorizedEquivalentConflictResolution",
);

export interface AuthorizedEquivalentConflictResolution {
  readonly [authorizedEquivalentResolutionBrand]: true;
  readonly command: Readonly<ResolveSyncConflictCommand>;
  readonly context: Readonly<CommandContext>;
}

const authorizedEquivalentResolutions = new WeakSet<object>();

class AuthorizedEquivalentConflictResolutionValue
  implements AuthorizedEquivalentConflictResolution
{
  readonly [authorizedEquivalentResolutionBrand] = true as const;
  readonly #workspaceCanonical: string;
  readonly #commandCanonical: string;
  readonly #contextCanonical: string;

  constructor(
    workspace: Readonly<WorkspaceV2>,
    command: Readonly<ResolveSyncConflictCommand>,
    context: Readonly<CommandContext>,
  ) {
    this.#workspaceCanonical = canonicalJson(workspace);
    this.#commandCanonical = canonicalJson(command);
    this.#contextCanonical = canonicalJson(context);
    Object.freeze(this);
    authorizedEquivalentResolutions.add(this);
  }

  get command(): Readonly<ResolveSyncConflictCommand> {
    return JSON.parse(this.#commandCanonical) as ResolveSyncConflictCommand;
  }

  get context(): Readonly<CommandContext> {
    return JSON.parse(this.#contextCanonical) as CommandContext;
  }

  matches(
    workspace: Readonly<WorkspaceV2>,
    command: Readonly<ResolveSyncConflictCommand>,
    context: Readonly<CommandContext>,
  ): boolean {
    return (
      this.#workspaceCanonical === canonicalJson(workspace) &&
      this.#commandCanonical === canonicalJson(command) &&
      this.#contextCanonical === canonicalJson(context)
    );
  }
}

export function isAuthorizedEquivalentConflictResolutionFor(
  value: unknown,
  workspace: Readonly<WorkspaceV2>,
  command: Readonly<ResolveSyncConflictCommand>,
  context: Readonly<CommandContext>,
): value is AuthorizedEquivalentConflictResolution {
  return (
    typeof value === "object" &&
    value !== null &&
    authorizedEquivalentResolutions.has(value) &&
    value instanceof AuthorizedEquivalentConflictResolutionValue &&
    value.matches(workspace, command, context)
  );
}

export class ConflictOpenAuthorizationError extends Error {
  constructor(
    readonly code:
      | "AUTHORIZED_BRANCH_REQUIRED"
      | "AUTHORIZED_REPLAY_REQUIRED"
      | "BRANCH_PROVENANCE_MISMATCH"
      | "REPLAY_REPRODUCTION_FAILED"
      | "UNKNOWN_PROTECTED_WRITER"
      | "CONFLICT_PROJECTION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ConflictOpenAuthorizationError";
  }
}

const protectedRecordEntities = new Set([
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

async function replayTouchesProtectedLifecycle(
  replay: AuthorizedSyncReplay,
  workspace: WorkspaceV2,
): Promise<boolean> {
  const touches = replay.receipt.diff.some(
    ({ entity, field }) =>
      protectedRecordEntities.has(entity) ||
      (entity === "ProjectV2" && protectedProjectFields.has(field)),
  );
  return touches && !(await isKnownUnprotectedLifecycleWriterForView({
    workspace,
    command: replay.command,
    commandId: replay.receipt.commandId,
    authorityRootOperationHash: replay.authorityRoot.operationHash,
    sourceOperationHash: replay.operationHash,
    receiptHash: replay.receipt.receiptHash,
    payloadHash: replay.receipt.payloadHash,
    createdAt: replay.receipt.createdAt,
    diff: replay.receipt.diff,
  }));
}

interface ProjectedBranch {
  workspace: WorkspaceV2;
  bundles: Map<string, ProtectedEffectBundle>;
}

async function projectAuthorizedBranch(input: {
  branch: AuthorizedSyncBranchV2;
}): Promise<ProjectedBranch> {
  if (!isAuthorizedSyncBranchV2(input.branch)) {
    throw new ConflictOpenAuthorizationError(
      "AUTHORIZED_BRANCH_REQUIRED",
      "Conflict projection accepts only opaque protocol-authorized branches.",
    );
  }
  const ancestorWorkspace = JSON.parse(
    input.branch.trustedAncestorCanonical,
  ) as WorkspaceV2;
  if (
    ancestorWorkspace.workspaceId !== input.branch.workspaceId ||
    canonicalJson(ancestorWorkspace) !== input.branch.trustedAncestorCanonical ||
    (await sha256Hex(input.branch.trustedAncestorCanonical)) !==
      input.branch.trustedAncestorHash
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "The authorized branch no longer matches its trusted checkpoint.",
    );
  }
  let workspace = structuredClone(ancestorWorkspace) as WorkspaceV2;
  const grouped = new Map<string, ProtectedEffectBundle[]>();
  let expectedPreviousOperationHash = input.branch.ancestorOperationHash;
  if (
    input.branch.workspaceAfterReplays.length !== input.branch.replays.length
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "The authorized branch does not carry one trusted workspace snapshot per replay.",
    );
  }

  for (const [index, replay] of input.branch.replays.entries()) {
    if (!isAuthorizedSyncReplay(replay)) {
      throw new ConflictOpenAuthorizationError(
        "AUTHORIZED_REPLAY_REQUIRED",
        "Conflict projection accepts only opaque protocol-authorized replays.",
      );
    }
    if (
      replay.workspaceId !== input.branch.workspaceId ||
      replay.previousOperationHash !== expectedPreviousOperationHash
    ) {
      throw new ConflictOpenAuthorizationError(
        "BRANCH_PROVENANCE_MISMATCH",
        `Replay ${replay.operationHash} is not the next operation in the authorized branch hash chain.`,
      );
    }
    expectedPreviousOperationHash = replay.operationHash;
    if (replay.receipt.baseRevision !== workspace.revision) {
      throw new ConflictOpenAuthorizationError(
        "REPLAY_REPRODUCTION_FAILED",
        `Replay ${replay.operationHash} does not follow the projected branch revision.`,
      );
    }
    const isDerivedConflictArtifact =
      replay.command.type === "open_sync_conflict" ||
      replay.command.type === "resolve_sync_conflict";
    if (!isDerivedConflictArtifact) {
      const projected = await projectProtectedEffectBundle({
        workspace,
        command: replay.command,
        commandId: replay.receipt.commandId,
        authorityRootOperationHash: replay.authorityRoot.operationHash,
        sourceOperationHash: replay.operationHash,
        receiptHash: replay.receipt.receiptHash,
        payloadHash: replay.receipt.payloadHash,
        createdAt: replay.receipt.createdAt,
        diff: replay.receipt.diff,
      });
      if (
        projected === undefined &&
        (await replayTouchesProtectedLifecycle(replay, workspace))
      ) {
        throw new ConflictOpenAuthorizationError(
          "UNKNOWN_PROTECTED_WRITER",
          `Replay ${replay.operationHash} writes protected lifecycle state without a known projection.`,
        );
      }
      if (projected !== undefined) {
        const bundles = grouped.get(projected.logicalKey) ?? [];
        bundles.push(projected);
        grouped.set(projected.logicalKey, bundles);
      }
    }
    const resultWorkspace = input.branch.workspaceAfterReplays[index];
    const matchingReceipts = resultWorkspace?.commandReceipts.filter(
      ({ commandId, status }) =>
        status === "applied" && commandId === replay.receipt.commandId,
    );
    if (
      resultWorkspace === undefined ||
      resultWorkspace.workspaceId !== input.branch.workspaceId ||
      resultWorkspace.revision !== replay.receipt.revision ||
      matchingReceipts?.length !== 1 ||
      canonicalJson(matchingReceipts[0]) !== canonicalJson(replay.receipt)
    ) {
      throw new ConflictOpenAuthorizationError(
        "REPLAY_REPRODUCTION_FAILED",
        `Replay ${replay.operationHash} has no exact trusted post-replay workspace.`,
      );
    }
    workspace = structuredClone(resultWorkspace) as WorkspaceV2;
  }

  if (
    expectedPreviousOperationHash !== input.branch.headOperationHash ||
    workspace.workspaceId !== input.branch.workspaceId ||
    canonicalJson(workspace) !== canonicalJson(input.branch.workspace)
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "The authorized branch head does not match its ordered replay chain and final workspace.",
    );
  }

  const bundles = new Map<string, ProtectedEffectBundle>();
  for (const [logicalKey, parts] of grouped) {
    bundles.set(logicalKey, await combineProtectedEffectBundles(parts));
  }
  return { workspace, bundles };
}

function protectedSnapshot(
  workspace: Readonly<WorkspaceV2>,
  recordType: OpenSyncConflictCommand["conflict"]["recordType"],
  recordId: string,
): JsonValue | undefined {
  const collection = {
    bet: workspace.bets,
    daily_commitment: workspace.dailyCommitments,
    review: workspace.reviews,
    exception: workspace.exceptions,
    close: workspace.closeDecisions,
  }[recordType] as readonly { id: string }[];
  const matches = collection.filter(({ id }) => id === recordId);
  return matches.length === 1
    ? (structuredClone(matches[0]) as unknown as JsonValue)
    : undefined;
}

export async function authorizeConflictOpenFromBranchesV2(input: {
  localBranch: AuthorizedSyncBranchV2;
  remoteBranch: AuthorizedSyncBranchV2;
  currentWorkspace: Readonly<WorkspaceV2>;
  command: Readonly<OpenSyncConflictCommand>;
  context: Readonly<CommandContext>;
}): Promise<AuthorizedConflictOpen> {
  if (
    !isAuthorizedSyncBranchV2(input.localBranch) ||
    !isAuthorizedSyncBranchV2(input.remoteBranch)
  ) {
    throw new ConflictOpenAuthorizationError(
      "AUTHORIZED_BRANCH_REQUIRED",
      "Conflict authorization accepts only opaque protocol-authorized branches.",
    );
  }
  if (
    input.localBranch.workspaceId !== input.remoteBranch.workspaceId ||
    input.currentWorkspace.workspaceId !== input.localBranch.workspaceId ||
    input.localBranch.trustedAncestorCanonical !==
      input.remoteBranch.trustedAncestorCanonical ||
    input.localBranch.trustedAncestorHash !==
      input.remoteBranch.trustedAncestorHash ||
    input.localBranch.ancestorOperationHash !==
      input.remoteBranch.ancestorOperationHash
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "Conflict branches must share one workspace, trusted checkpoint, and common ancestor.",
    );
  }
  const draft = input.command.conflict;
  if (
    draft.logicalKey === undefined ||
    draft.localBundle === undefined ||
    draft.remoteBundle === undefined ||
    draft.remoteRecordId === undefined
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Conflict command is missing its complete local and remote projection.",
    );
  }
  const [local, remote] = await Promise.all([
    projectAuthorizedBranch({
      branch: input.localBranch,
    }),
    projectAuthorizedBranch({
      branch: input.remoteBranch,
    }),
  ]);
  const expectedLocalBundle = local.bundles.get(draft.logicalKey);
  const expectedRemoteBundle = remote.bundles.get(draft.logicalKey);
  const expectedLocalValue = protectedSnapshot(
    local.workspace,
    draft.recordType,
    draft.recordId,
  );
  const expectedRemoteValue = protectedSnapshot(
    remote.workspace,
    draft.recordType,
    draft.remoteRecordId,
  );
  if (
    expectedLocalBundle === undefined ||
    expectedRemoteBundle === undefined ||
    canonicalJson(expectedLocalBundle) !== canonicalJson(draft.localBundle) ||
    canonicalJson(expectedRemoteBundle) !== canonicalJson(draft.remoteBundle) ||
    expectedLocalValue === undefined ||
    expectedRemoteValue === undefined ||
    canonicalJson(expectedLocalValue) !== canonicalJson(draft.localValue) ||
    canonicalJson(expectedRemoteValue) !== canonicalJson(draft.remoteValue)
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Conflict command does not exactly match its locally reconstructed authorized branches.",
    );
  }
  if (
    input.context.expectedRevision !== input.currentWorkspace.revision ||
    input.context.commandId.trim().length === 0
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Conflict authority context does not target the exact current revision.",
    );
  }
  return new AuthorizedConflictOpenValue(
    input.currentWorkspace,
    input.command,
    input.context,
  );
}

export interface ResolutionAuthorityRootIdentityV2 {
  operationHash: string;
  createdAt: string;
}

export async function resolutionSuccessorIdentityV2(input: {
  workspaceId: string;
  originalConflictId: string;
  commonAncestorHash: string;
  localHeadOperationHash: string;
  authorityRoots: readonly ResolutionAuthorityRootIdentityV2[];
  retainedBundleHashes: readonly string[];
  canonicalOutcomes: readonly string[];
}): Promise<{
  conflictId: string;
  commandId: string;
  commonAncestorHash: string;
  openedAt: string;
}> {
  const rootsByHash = new Map<string, string>();
  for (const root of input.authorityRoots) {
    const existing = rootsByHash.get(root.operationHash);
    if (existing !== undefined && existing !== root.createdAt) {
      throw new ConflictOpenAuthorizationError(
        "BRANCH_PROVENANCE_MISMATCH",
        `Resolution authority root ${root.operationHash} changed its timestamp.`,
      );
    }
    rootsByHash.set(root.operationHash, root.createdAt);
  }
  const authorityRootOperationHashes = [...rootsByHash.keys()].sort(compareText);
  const resolutionTimes = [...rootsByHash.values()].sort(compareText);
  const openedAt = resolutionTimes[resolutionTimes.length - 1];
  if (authorityRootOperationHashes.length < 2 || openedAt === undefined) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "A successor conflict requires two independent human resolution roots.",
    );
  }
  const retainedBundleHashes = [...input.retainedBundleHashes].sort(compareText);
  const canonicalOutcomeHashes = (await Promise.all(
    input.canonicalOutcomes.map((outcome) => sha256Hex(outcome)),
  )).sort(compareText);
  const digest = await sha256Hex(canonicalJson({
    workspaceId: input.workspaceId,
    kind: "concurrent_resolution_successor",
    originalConflictId: input.originalConflictId,
    authorityRootOperationHashes,
    retainedBundleHashes,
    canonicalOutcomeHashes,
  }));
  return {
    conflictId: `sync-conflict-${digest.slice(0, 32)}`,
    commandId:
      `open-sync-conflict-${digest.slice(0, 32)}-branch-${input.localHeadOperationHash}`,
    commonAncestorHash: input.commonAncestorHash,
    openedAt,
  };
}

interface ResolutionBranchProjection {
  workspace: WorkspaceV2;
  retainedBundleHash: string;
  retainedValue: JsonValue;
  outcomeIdentity: string;
  authorityRoots: ResolutionAuthorityRootIdentityV2[];
}

async function projectResolutionBranch(input: {
  branch: AuthorizedSyncBranchV2;
  conflictId: string;
}): Promise<ResolutionBranchProjection> {
  const projected = await projectAuthorizedBranch({ branch: input.branch });
  const resolutionReplays = input.branch.replays.filter(
    (replay) =>
      replay.command.type === "resolve_sync_conflict" &&
      replay.command.resolution.conflictId === input.conflictId,
  );
  if (resolutionReplays.length === 0) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      `Resolution branch does not resolve predecessor conflict ${input.conflictId}.`,
    );
  }
  let outcomeIdentity: string | undefined;
  let retainedBundleHash: string | undefined;
  let retainedValue: JsonValue | undefined;
  const authorityRoots = new Map<string, string>();
  for (const replay of resolutionReplays) {
    if (
      replay.command.type !== "resolve_sync_conflict" ||
      replay.authorityRoot.command.type !== "resolve_sync_conflict" ||
      replay.authorityRoot.receipt.actorKind !== "human" ||
      replay.authorityRoot.receipt.status !== "applied"
    ) {
      throw new ConflictOpenAuthorizationError(
        "BRANCH_PROVENANCE_MISMATCH",
        `Resolution replay ${replay.operationHash} has no exact human authority root.`,
      );
    }
    const replayCommand = replay.command;
    const authorityCommand = replay.authorityRoot.command;
    const replayOutcome = canonicalJson({
      retainedBundleHash: replayCommand.resolution.retainedBundleHash,
      retainedValue: replayCommand.resolution.retainedValue,
    });
    const authorityOutcome = canonicalJson({
      retainedBundleHash: authorityCommand.resolution.retainedBundleHash,
      retainedValue: authorityCommand.resolution.retainedValue,
    });
    if (
      replayCommand.resolution.conflictId !==
        authorityCommand.resolution.conflictId ||
      replayOutcome !== authorityOutcome ||
      (outcomeIdentity !== undefined && outcomeIdentity !== replayOutcome)
    ) {
      throw new ConflictOpenAuthorizationError(
        "BRANCH_PROVENANCE_MISMATCH",
        `Resolution branch changes the retained outcome for ${input.conflictId}.`,
      );
    }
    outcomeIdentity = replayOutcome;
    retainedBundleHash = replayCommand.resolution.retainedBundleHash;
    retainedValue = structuredClone(replayCommand.resolution.retainedValue);
    authorityRoots.set(
      replay.authorityRoot.operationHash,
      replay.authorityRoot.createdAt,
    );
  }
  const conflictMatches = projected.workspace.syncConflicts.filter(
    ({ id }) => id === input.conflictId,
  );
  const conflict = conflictMatches[0];
  const retainedRecordId =
    conflict?.retainedVersion === "remote"
      ? conflict.remoteRecordId ?? conflict.recordId
      : conflict?.recordId;
  const selected =
    conflict === undefined || retainedRecordId === undefined
      ? undefined
      : protectedSnapshot(
          projected.workspace,
          conflict.recordType,
          retainedRecordId,
        );
  if (
    conflictMatches.length !== 1 ||
    conflict === undefined ||
    conflict.resolvedAt === undefined ||
    retainedBundleHash === undefined ||
    retainedValue === undefined ||
    outcomeIdentity === undefined ||
    conflict.retainedBundleHash !== retainedBundleHash ||
    selected === undefined ||
    canonicalJson(selected) !== canonicalJson(retainedValue)
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      `Resolution branch final state does not retain its exact declared outcome for ${input.conflictId}.`,
    );
  }
  return {
    workspace: projected.workspace,
    retainedBundleHash,
    retainedValue,
    outcomeIdentity,
    authorityRoots: [...authorityRoots]
      .map(([operationHash, createdAt]) => ({ operationHash, createdAt }))
      .sort((left, right) => compareText(left.operationHash, right.operationHash)),
  };
}

/**
 * Mint a successor-conflict open only from two exact opaque resolution
 * branches that retained different protected outcomes of one predecessor.
 */
export async function authorizeConflictOpenFromResolutionBranchesV2(input: {
  localBranch: AuthorizedSyncBranchV2;
  remoteBranch: AuthorizedSyncBranchV2;
  predecessorConflictId: string;
  currentWorkspace: Readonly<WorkspaceV2>;
  command: Readonly<OpenSyncConflictCommand>;
  context: Readonly<CommandContext>;
}): Promise<AuthorizedConflictOpen> {
  if (
    !isAuthorizedSyncBranchV2(input.localBranch) ||
    !isAuthorizedSyncBranchV2(input.remoteBranch)
  ) {
    throw new ConflictOpenAuthorizationError(
      "AUTHORIZED_BRANCH_REQUIRED",
      "Successor conflict authorization requires opaque resolution branches.",
    );
  }
  if (
    input.localBranch.workspaceId !== input.remoteBranch.workspaceId ||
    input.currentWorkspace.workspaceId !== input.localBranch.workspaceId ||
    input.localBranch.trustedAncestorCanonical !==
      input.remoteBranch.trustedAncestorCanonical ||
    input.localBranch.trustedAncestorHash !==
      input.remoteBranch.trustedAncestorHash ||
    input.localBranch.ancestorOperationHash !==
      input.remoteBranch.ancestorOperationHash
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "Successor conflict branches must share one exact ancestor and current local projection.",
    );
  }
  const ancestor = JSON.parse(
    input.localBranch.trustedAncestorCanonical,
  ) as WorkspaceV2;
  const predecessorMatches = ancestor.syncConflicts.filter(
    ({ id }) => id === input.predecessorConflictId,
  );
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
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Successor conflict predecessor is not one complete unresolved protected conflict at the shared ancestor.",
    );
  }
  const [local, remote] = await Promise.all([
    projectResolutionBranch({
      branch: input.localBranch,
      conflictId: predecessor.id,
    }),
    projectResolutionBranch({
      branch: input.remoteBranch,
      conflictId: predecessor.id,
    }),
  ]);
  const localResolvedConflict = local.workspace.syncConflicts.find(
    ({ id }) => id === predecessor.id,
  );
  const currentResolvedConflict = input.currentWorkspace.syncConflicts.find(
    ({ id }) => id === predecessor.id,
  );
  const reviewId = `review:sync_conflict:${predecessor.id}`;
  const localResolutionReview = local.workspace.reviews.find(
    ({ id }) => id === reviewId,
  );
  const currentResolutionReview = input.currentWorkspace.reviews.find(
    ({ id }) => id === reviewId,
  );
  const localResolutionReceipts = input.localBranch.replays
    .filter(
      (replay) =>
        replay.command.type === "resolve_sync_conflict" &&
        replay.command.resolution.conflictId === predecessor.id,
    )
    .map(({ receipt }) => receipt);
  const currentHasExactLocalResolutionReceipts =
    localResolutionReceipts.every((receipt) =>
      input.currentWorkspace.commandReceipts.some(
        (candidate) => canonicalJson(candidate) === canonicalJson(receipt),
      )
    );
  if (
    localResolvedConflict === undefined ||
    currentResolvedConflict === undefined ||
    canonicalJson(currentResolvedConflict) !==
      canonicalJson(localResolvedConflict) ||
    localResolutionReview === undefined ||
    currentResolutionReview === undefined ||
    canonicalJson(currentResolutionReview) !==
      canonicalJson(localResolutionReview) ||
    !currentHasExactLocalResolutionReceipts
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Current Workspace changed the local resolution marker, Review, or exact applied receipt before successor open.",
    );
  }
  const sharedRoots = local.authorityRoots.filter((root) =>
    remote.authorityRoots.some(
      ({ operationHash }) => operationHash === root.operationHash,
    )
  );
  const predecessorLocalBundle = predecessor.localBundle;
  const predecessorRemoteBundle = predecessor.remoteBundle;
  const predecessorRemoteRecordId = predecessor.remoteRecordId;
  const sideFor = (
    retainedBundleHash: string,
    retainedValue: JsonValue,
  ) => {
    if (
      retainedBundleHash === predecessorLocalBundle.hash &&
      canonicalJson(retainedValue) === canonicalJson(predecessor.localValue)
    ) {
      return {
        bundle: predecessorLocalBundle,
        value: predecessor.localValue,
        recordId: predecessor.recordId,
      };
    }
    if (
      retainedBundleHash === predecessorRemoteBundle.hash &&
      canonicalJson(retainedValue) === canonicalJson(predecessor.remoteValue)
    ) {
      return {
        bundle: predecessorRemoteBundle,
        value: predecessor.remoteValue,
        recordId: predecessorRemoteRecordId,
      };
    }
    return undefined;
  };
  const localSide = sideFor(local.retainedBundleHash, local.retainedValue);
  const remoteSide = sideFor(remote.retainedBundleHash, remote.retainedValue);
  const currentLocalValue =
    localSide === undefined
      ? undefined
      : protectedSnapshot(
          input.currentWorkspace,
          predecessor.recordType,
          localSide.recordId,
        );
  const draft = input.command.conflict;
  const commonAncestorHash =
    input.localBranch.ancestorOperationHash ??
    `genesis:${input.localBranch.workspaceId}`;
  const expectedIdentity =
    localSide === undefined || remoteSide === undefined
      ? undefined
      : await resolutionSuccessorIdentityV2({
          workspaceId: input.localBranch.workspaceId,
          originalConflictId: predecessor.id,
          commonAncestorHash,
          localHeadOperationHash: input.localBranch.headOperationHash,
          authorityRoots: [...local.authorityRoots, ...remote.authorityRoots],
          retainedBundleHashes: [
            localSide.bundle.hash,
            remoteSide.bundle.hash,
          ],
          canonicalOutcomes: [local.outcomeIdentity, remote.outcomeIdentity],
        });
  const expectedContext: CommandContext | undefined =
    expectedIdentity === undefined
      ? undefined
      : {
          commandId: expectedIdentity.commandId,
          expectedRevision: input.currentWorkspace.revision,
          actorId: "sync-conflict-detector",
          actorKind: "system",
          origin: "agent",
          source: {
            sourceId: `sync-merge:${expectedIdentity.commonAncestorHash}`,
            verified: true,
            capabilities: ["open_conflict"],
          },
          now: expectedIdentity.openedAt,
        };
  if (
    local.outcomeIdentity === remote.outcomeIdentity ||
    sharedRoots.length > 0 ||
    localSide === undefined ||
    remoteSide === undefined ||
    currentLocalValue === undefined ||
    canonicalJson(currentLocalValue) !== canonicalJson(localSide.value) ||
    expectedIdentity === undefined ||
    expectedContext === undefined ||
    localSide.bundle.hash === remoteSide.bundle.hash ||
    draft.id !== expectedIdentity.conflictId ||
    draft.commonAncestorHash !== expectedIdentity.commonAncestorHash ||
    draft.recordType !== predecessor.recordType ||
    draft.recordId !== localSide.recordId ||
    draft.remoteRecordId !== remoteSide.recordId ||
    draft.logicalKey !== predecessor.logicalKey ||
    canonicalJson(draft.affectedProjectIds) !==
      canonicalJson(predecessor.affectedProjectIds) ||
    canonicalJson(draft.affectedRecordIds) !==
      canonicalJson(predecessor.affectedRecordIds) ||
    canonicalJson(draft.localBundle) !== canonicalJson(localSide.bundle) ||
    canonicalJson(draft.remoteBundle) !== canonicalJson(remoteSide.bundle) ||
    canonicalJson(draft.localValue) !== canonicalJson(localSide.value) ||
    canonicalJson(draft.remoteValue) !== canonicalJson(remoteSide.value) ||
    canonicalJson(input.context) !== canonicalJson(expectedContext)
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Successor conflict command does not exactly compare the two verified resolution outcomes.",
    );
  }
  return new AuthorizedConflictOpenValue(
    input.currentWorkspace,
    input.command,
    input.context,
  );
}

async function validateConflictOpenReplayProjection(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): Promise<OpenSyncConflictCommand> {
  if (
    !isAuthorizedSyncReplay(replay) ||
    replay.command.type !== "open_sync_conflict"
  ) {
    throw new ConflictOpenAuthorizationError(
      "AUTHORIZED_REPLAY_REQUIRED",
      "Persisted conflict propagation requires an opaque authorized open replay.",
    );
  }
  if (
    replay.workspaceId !== currentWorkspace.workspaceId ||
    replay.receipt.status !== "applied" ||
    replay.receipt.commandType !== "open_sync_conflict"
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "Persisted conflict propagation targets another Workspace or receipt.",
    );
  }
  const command = structuredClone(replay.command) as OpenSyncConflictCommand;
  const draft = command.conflict;
  if (
    draft.remoteRecordId === undefined ||
    draft.localBundle === undefined ||
    draft.remoteBundle === undefined ||
    protectedSnapshot(
      currentWorkspace,
      draft.recordType,
      draft.recordId,
    ) === undefined ||
    canonicalJson(
      protectedSnapshot(
        currentWorkspace,
        draft.recordType,
        draft.recordId,
      ),
    ) !== canonicalJson(draft.localValue)
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Persisted conflict local projection does not match the current branch.",
    );
  }
  let remoteProjection: WorkspaceV2;
  try {
    remoteProjection = await applyRemoteProtectedEffectBundle({
      workspace: currentWorkspace,
      localBundle: draft.localBundle,
      remoteBundle: draft.remoteBundle,
      conflictId: draft.id,
      now: replay.receipt.createdAt,
    });
  } catch (error) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      `Persisted conflict bundles do not descend from the current branch: ${String(error)}.`,
    );
  }
  const remoteValue = protectedSnapshot(
    remoteProjection,
    draft.recordType,
    draft.remoteRecordId,
  );
  if (
    remoteValue === undefined ||
    canonicalJson(remoteValue) !== canonicalJson(draft.remoteValue)
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Persisted conflict remote projection does not match its verified bundle.",
    );
  }
  return command;
}

/**
 * Mint authority for the exact persisted open being replayed. The protocol
 * calls this only after binding every protected projection to verified history;
 * this boundary additionally proves that the bundles swap the current local
 * projection into the claimed remote projection.
 */
export async function authorizePersistedConflictOpenFromVerifiedReplayV2(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): Promise<AuthorizedConflictOpen> {
  const command = await validateConflictOpenReplayProjection(
    replay,
    currentWorkspace,
  );
  const context: CommandContext = {
    commandId: replay.receipt.commandId,
    expectedRevision: replay.receipt.baseRevision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: replay.receipt.origin,
    source: structuredClone(replay.receipt.source),
    now: replay.receipt.createdAt,
  };
  return new AuthorizedConflictOpenValue(
    currentWorkspace,
    command,
    context,
  );
}

/**
 * A persisted conflict open has already been reproduced from verified history.
 * Re-target only its revision and sync source link for propagation; the
 * protected command payload remains byte-for-byte identical.
 */
export async function authorizeConflictOpenFromVerifiedReplayV2(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): Promise<AuthorizedConflictOpen> {
  const command = await validateConflictOpenReplayProjection(
    replay,
    currentWorkspace,
  );
  const context: CommandContext = {
    commandId: replay.receipt.commandId,
    expectedRevision: currentWorkspace.revision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: "sync",
    source: {
      sourceId: `sync-replay:${replay.operationHash}:${replay.receipt.source.sourceId}`,
      verified: replay.receipt.source.verified,
      capabilities: Array.from(new Set([
        ...replay.receipt.source.capabilities,
        "replay_receipt" as const,
      ])),
    },
    now: replay.receipt.createdAt,
  };
  return new AuthorizedConflictOpenValue(
    currentWorkspace,
    command,
    context,
  );
}

function sameResolutionOutcome(
  left: Readonly<ResolveSyncConflictCommand>,
  right: Readonly<ResolveSyncConflictCommand>,
): boolean {
  return (
    left.resolution.conflictId === right.resolution.conflictId &&
    left.resolution.retainedBundleHash ===
      right.resolution.retainedBundleHash &&
    canonicalJson(left.resolution.retainedValue) ===
      canonicalJson(right.resolution.retainedValue)
  );
}

function validateEquivalentResolutionReplay(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): ResolveSyncConflictCommand {
  if (
    !isAuthorizedSyncReplay(replay) ||
    replay.command.type !== "resolve_sync_conflict" ||
    replay.authorityRoot.command.type !== "resolve_sync_conflict"
  ) {
    throw new ConflictOpenAuthorizationError(
      "AUTHORIZED_REPLAY_REQUIRED",
      "Equivalent conflict confirmation requires an opaque resolution replay.",
    );
  }
  const command = structuredClone(replay.command) as ResolveSyncConflictCommand;
  const authorityCommand = replay.authorityRoot.command;
  if (
    replay.workspaceId !== currentWorkspace.workspaceId ||
    replay.receipt.status !== "applied" ||
    replay.receipt.commandType !== "resolve_sync_conflict" ||
    replay.authorityRoot.receipt.status !== "applied" ||
    replay.authorityRoot.receipt.commandType !== "resolve_sync_conflict" ||
    replay.authorityRoot.receipt.actorKind !== "human" ||
    !sameResolutionOutcome(command, authorityCommand)
  ) {
    throw new ConflictOpenAuthorizationError(
      "BRANCH_PROVENANCE_MISMATCH",
      "Equivalent conflict confirmation does not terminate at the exact human resolution authority root.",
    );
  }
  const matches = currentWorkspace.syncConflicts.filter(
    ({ id }) => id === command.resolution.conflictId,
  );
  const conflict = matches[0];
  const review = currentWorkspace.reviews.find(
    ({ id }) => id === `review:sync_conflict:${command.resolution.conflictId}`,
  );
  const retainedRecordId =
    conflict?.retainedVersion === "remote"
      ? conflict.remoteRecordId ?? conflict.recordId
      : conflict?.recordId;
  const retainedValue =
    conflict === undefined || retainedRecordId === undefined
      ? undefined
      : protectedSnapshot(
          currentWorkspace,
          conflict.recordType,
          retainedRecordId,
        );
  if (
    matches.length !== 1 ||
    conflict === undefined ||
    conflict.resolvedAt === undefined ||
    conflict.retainedVersion === undefined ||
    conflict.retainedBundleHash !== command.resolution.retainedBundleHash ||
    retainedValue === undefined ||
    canonicalJson(retainedValue) !==
      canonicalJson(command.resolution.retainedValue) ||
    review?.status !== "completed" ||
    currentWorkspace.commandReceipts.some(
      ({ commandId, status }) =>
        commandId === replay.receipt.commandId && status === "applied",
    )
  ) {
    throw new ConflictOpenAuthorizationError(
      "CONFLICT_PROJECTION_MISMATCH",
      "Equivalent conflict confirmation does not match the exact already-retained protected value.",
    );
  }
  return command;
}

/**
 * Re-target a different verified human resolution that selected the exact same
 * canonical outcome. The opaque value authorizes only an audit-only domain
 * transition against this exact Workspace revision.
 */
export function authorizeEquivalentConflictResolutionFromVerifiedReplayV2(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): AuthorizedEquivalentConflictResolution {
  const command = validateEquivalentResolutionReplay(replay, currentWorkspace);
  const context: CommandContext = {
    commandId: replay.receipt.commandId,
    expectedRevision: currentWorkspace.revision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: "sync",
    source: {
      sourceId: `sync-replay:${replay.operationHash}:${replay.receipt.source.sourceId}`,
      verified: replay.receipt.source.verified,
      capabilities: Array.from(new Set([
        ...replay.receipt.source.capabilities,
        "replay_receipt" as const,
      ])),
    },
    now: replay.receipt.createdAt,
  };
  return new AuthorizedEquivalentConflictResolutionValue(
    currentWorkspace,
    command,
    context,
  );
}

/** Reproduce a previously persisted equivalent confirmation receipt exactly. */
export function authorizePersistedEquivalentConflictResolutionV2(
  replay: AuthorizedSyncReplay,
  currentWorkspace: Readonly<WorkspaceV2>,
): AuthorizedEquivalentConflictResolution {
  const command = validateEquivalentResolutionReplay(replay, currentWorkspace);
  const context: CommandContext = {
    commandId: replay.receipt.commandId,
    expectedRevision: replay.receipt.baseRevision,
    actorId: replay.receipt.actorId,
    actorKind: replay.receipt.actorKind,
    origin: replay.receipt.origin,
    source: structuredClone(replay.receipt.source),
    now: replay.receipt.createdAt,
  };
  return new AuthorizedEquivalentConflictResolutionValue(
    currentWorkspace,
    command,
    context,
  );
}
