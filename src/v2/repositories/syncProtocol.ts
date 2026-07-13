import type { Id, ISODate } from "@/domain/types";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import {
  decryptSyncPayload,
  encryptSyncPayload,
  type EncryptedSyncPayload,
} from "../../domain/sync";
import {
  executeCommand,
  type CommandContext,
  type ProposableV2Command,
  type V2Command,
} from "../domain/commands";
import {
  buildReplanProposal,
  generateTodayProposal,
} from "../domain/today";
import { stableHash } from "../domain/stableHash";
import type {
  AuditDiff,
  CommandReceipt,
  CommandSource,
  JsonValue,
  WorkspaceV2,
} from "../domain/types";
import {
  validateProtectedEffectBundle,
  verifyProtectedOperationProjectionFromReceiptDiff,
} from "./syncConflictBundles";
import {
  authorizeConflictOpenFromVerifiedReplayV2,
  authorizePersistedEquivalentConflictResolutionV2,
  authorizePersistedConflictOpenFromVerifiedReplayV2,
} from "./syncConflictOpenAuthorization";

export const V2_SYNC_PROTOCOL = "omniplan-v2-command-log" as const;

export type SyncProtocolErrorCode =
  | "V2_SCHEMA_REQUIRED"
  | "INVALID_ENVELOPE"
  | "INVALID_MANIFEST"
  | "V2_PATH_REQUIRED"
  | "OPERATION_HASH_MISMATCH"
  | "DECRYPTION_FAILED"
  | "RECEIPT_REQUIRED"
  | "RECEIPT_MISMATCH"
  | "RECEIPT_HASH_MISMATCH"
  | "BROKEN_HASH_CHAIN"
  | "MISSING_ANCESTOR";

export class SyncProtocolError extends Error {
  constructor(
    readonly code: SyncProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyncProtocolError";
  }
}

export interface SyncEnvelopeV2 {
  schemaVersion: 2;
  protocol: typeof V2_SYNC_PROTOCOL;
  workspaceId: Id;
  deviceId: Id;
  sequence: number;
  operationId: Id;
  commandId: Id;
  baseRevision: number;
  revision: number;
  previousOperationHash?: string;
  payloadHash: string;
  createdAt: ISODate;
  payload: EncryptedSyncPayload;
}

export interface SyncManifestHeadV2 {
  sequence: number;
  operationHash: string;
  revision: number;
  updatedAt: ISODate;
}

export interface SyncManifestV2 {
  schemaVersion: 2;
  protocol: typeof V2_SYNC_PROTOCOL;
  workspaceId: Id;
  heads: Record<Id, SyncManifestHeadV2>;
  updatedAt: ISODate;
}

export interface CreateSyncManifestV2Input {
  workspaceId: Id;
  heads?: Record<Id, SyncManifestHeadV2>;
  updatedAt: ISODate;
}

interface SyncOperationBindingV2 {
  schemaVersion: 2;
  protocol: typeof V2_SYNC_PROTOCOL;
  workspaceId: Id;
  deviceId: Id;
  sequence: number;
  operationId: Id;
  commandId: Id;
  baseRevision: number;
  revision: number;
  previousOperationHash: string | null;
  payloadHash: string;
  createdAt: ISODate;
}

interface SyncOperationPayloadV2 {
  binding: SyncOperationBindingV2;
  command: V2Command;
  receipt: CommandReceipt;
}

export interface CreateSyncOperationV2Input {
  workspaceId: Id;
  deviceId: Id;
  sequence: number;
  operationId: Id;
  command: V2Command;
  receipt: CommandReceipt;
  previousOperationHash?: string;
  passphrase: string;
}

export interface CreatedSyncOperationV2 {
  /**
   * One immutable upload unit. Encryption uses a random salt and IV, so a
   * transport must persist and reuse this exact envelope/path/hash across
   * retries instead of calling createSyncOperationV2 again.
   */
  readonly envelope: Readonly<SyncEnvelopeV2>;
  readonly operationHash: string;
  readonly path: string;
}

export interface DecryptAndVerifySyncOperationV2Input {
  envelope: unknown;
  path: string;
  passphrase: string;
  expectedWorkspaceId?: Id;
  expectedDeviceId?: Id;
  expectedSequence?: number;
  expectedOperationHash?: string;
  /** `null` explicitly requires a root operation with no parent. */
  expectedPreviousOperationHash?: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

function pathSegment(value: string, label: string): string {
  if (!isCanonicalId(value)) {
    throw new SyncProtocolError(
      "INVALID_ENVELOPE",
      `${label} must be a canonical non-empty identifier.`,
    );
  }
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalId(value: unknown): value is Id {
  return isNonEmptyText(value) && value === value.trim();
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isISODate(value: unknown): value is ISODate {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (item) => item === undefined || isJsonValue(item),
  );
}

function isEncryptedPayload(value: unknown): value is EncryptedSyncPayload {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "algorithm",
      "kdf",
      "iterations",
      "salt",
      "iv",
      "ciphertext",
    ]) &&
    value.algorithm === "AES-GCM" &&
    value.kdf === "PBKDF2-SHA256" &&
    value.iterations === 210_000 &&
    isNonEmptyText(value.salt) &&
    isNonEmptyText(value.iv) &&
    isNonEmptyText(value.ciphertext)
  );
}

export function parseSyncEnvelopeV2(value: unknown): Readonly<SyncEnvelopeV2> {
  if (isRecord(value) && value.schemaVersion !== 2) {
    throw new SyncProtocolError(
      "V2_SCHEMA_REQUIRED",
      "Only schema-version 2 command-log envelopes are accepted here.",
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "schemaVersion",
        "protocol",
        "workspaceId",
        "deviceId",
        "sequence",
        "operationId",
        "commandId",
        "baseRevision",
        "revision",
        "payloadHash",
        "createdAt",
        "payload",
      ],
      ["previousOperationHash"],
    ) ||
    value.schemaVersion !== 2 ||
    value.protocol !== V2_SYNC_PROTOCOL ||
    !isCanonicalId(value.workspaceId) ||
    !isCanonicalId(value.deviceId) ||
    !isPositiveInteger(value.sequence) ||
    !isCanonicalId(value.operationId) ||
    !isCanonicalId(value.commandId) ||
    !isNonNegativeInteger(value.baseRevision) ||
    !isPositiveInteger(value.revision) ||
    value.revision !== value.baseRevision + 1 ||
    (value.previousOperationHash !== undefined &&
      !isHash(value.previousOperationHash)) ||
    (value.baseRevision === 0) !==
      (value.previousOperationHash === undefined) ||
    !isHash(value.payloadHash) ||
    !isISODate(value.createdAt) ||
    !isEncryptedPayload(value.payload)
  ) {
    throw new SyncProtocolError(
      "INVALID_ENVELOPE",
      "The V2 sync envelope has an invalid or mutable shape.",
    );
  }
  return deepFreeze(clone(value as unknown as SyncEnvelopeV2));
}

export function parseSyncManifestV2(value: unknown): Readonly<SyncManifestV2> {
  if (isRecord(value) && value.schemaVersion !== 2) {
    throw new SyncProtocolError(
      "V2_SCHEMA_REQUIRED",
      "Only schema-version 2 command-log manifests are accepted here.",
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "protocol",
      "workspaceId",
      "heads",
      "updatedAt",
    ]) ||
    value.schemaVersion !== 2 ||
    value.protocol !== V2_SYNC_PROTOCOL ||
    !isCanonicalId(value.workspaceId) ||
    !isRecord(value.heads) ||
    !isISODate(value.updatedAt)
  ) {
    throw new SyncProtocolError(
      "INVALID_MANIFEST",
      "The V2 sync manifest has an invalid or mutable shape.",
    );
  }
  const headHashes = new Set<string>();
  for (const [deviceId, head] of Object.entries(value.heads)) {
    if (
      !isCanonicalId(deviceId) ||
      !isRecord(head) ||
      !hasExactKeys(head, [
        "sequence",
        "operationHash",
        "revision",
        "updatedAt",
      ]) ||
      !isPositiveInteger(head.sequence) ||
      !isHash(head.operationHash) ||
      !isPositiveInteger(head.revision) ||
      !isISODate(head.updatedAt)
    ) {
      throw new SyncProtocolError(
        "INVALID_MANIFEST",
        "The V2 sync manifest contains an invalid device head.",
      );
    }
    if (head.updatedAt > value.updatedAt || headHashes.has(head.operationHash)) {
      throw new SyncProtocolError(
        "INVALID_MANIFEST",
        "The V2 sync manifest time or immutable head identity is inconsistent.",
      );
    }
    headHashes.add(head.operationHash);
  }
  return deepFreeze(clone(value as unknown as SyncManifestV2));
}

export function createSyncManifestV2(
  input: CreateSyncManifestV2Input,
): Readonly<SyncManifestV2> {
  return parseSyncManifestV2({
    schemaVersion: 2,
    protocol: V2_SYNC_PROTOCOL,
    workspaceId: input.workspaceId,
    heads: clone(input.heads ?? {}),
    updatedAt: input.updatedAt,
  });
}

export interface AdvanceSyncManifestV2Options {
  /**
   * A non-head parent is accepted only when this branded history proves that
   * the exact current manifest still reaches it.
   */
  verifiedHistory?: VerifiedSyncHistory;
}

export async function advanceSyncManifestV2(
  current: unknown,
  operation: CreatedSyncOperationV2,
  options: AdvanceSyncManifestV2Options = {},
): Promise<Readonly<SyncManifestV2>> {
  const manifest = parseSyncManifestV2(current);
  const envelope = parseSyncEnvelopeV2(operation.envelope);
  const operationHash = await sha256Hex(canonicalJson(envelope));
  const expectedPath = syncOperationPathV2(
    envelope.workspaceId,
    envelope.deviceId,
    envelope.sequence,
    operationHash,
  );
  if (
    operationHash !== operation.operationHash ||
    operation.path !== expectedPath
  ) {
    throw new SyncProtocolError(
      "OPERATION_HASH_MISMATCH",
      "The uploaded operation unit is not the immutable envelope it claims to be.",
    );
  }
  if (manifest.workspaceId !== envelope.workspaceId) {
    throw new SyncProtocolError(
      "INVALID_MANIFEST",
      "The operation cannot advance a manifest for another workspace.",
    );
  }
  const previousDeviceHead = manifest.heads[envelope.deviceId];
  const expectedSequence = (previousDeviceHead?.sequence ?? 0) + 1;
  if (envelope.sequence !== expectedSequence) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "The operation does not advance its per-device sequence exactly once.",
    );
  }
  const currentHeads = Object.values(manifest.heads);
  const concurrentGenesisRoot =
    previousDeviceHead === undefined &&
    envelope.sequence === 1 &&
    envelope.previousOperationHash === undefined &&
    envelope.baseRevision === 0;
  if (currentHeads.length === 0 || concurrentGenesisRoot) {
    if (
      envelope.previousOperationHash !== undefined ||
      envelope.baseRevision !== 0
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "The first manifest operation must be a revision-zero root.",
      );
    }
  } else {
    const parentHead = currentHeads.find(
      ({ operationHash: headHash }) =>
        headHash === envelope.previousOperationHash,
    );
    let parentRevision = parentHead?.revision;
    if (parentHead === undefined && options.verifiedHistory !== undefined) {
      if (
        canonicalJson(options.verifiedHistory.manifest) !==
        canonicalJson(manifest)
      ) {
        throw new SyncProtocolError(
          "BROKEN_HASH_CHAIN",
          "Historical ancestry proof does not belong to the current manifest snapshot.",
        );
      }
      const historicalParent =
        envelope.previousOperationHash === undefined
          ? undefined
          : historyOperation(
              options.verifiedHistory,
              envelope.previousOperationHash,
            );
      if (
        previousDeviceHead === undefined &&
        envelope.sequence === 1 &&
        historicalParent !== undefined
      ) {
        parentRevision = historicalParent.receipt.revision;
      }
    }
    if (parentRevision === undefined) {
      throw new SyncProtocolError(
        "MISSING_ANCESTOR",
        "The operation parent is neither a current manifest head nor a verified reachable historical ancestor.",
      );
    }
    if (envelope.baseRevision !== parentRevision) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "The operation base revision does not match its manifest parent head.",
      );
    }
  }
  return createSyncManifestV2({
    workspaceId: manifest.workspaceId,
    heads: {
      ...clone(manifest.heads),
      [envelope.deviceId]: {
        sequence: envelope.sequence,
        operationHash,
        revision: envelope.revision,
        updatedAt: envelope.createdAt,
      },
    },
    updatedAt:
      compareText(manifest.updatedAt, envelope.createdAt) >= 0
        ? manifest.updatedAt
        : envelope.createdAt,
  });
}

export function syncManifestPathV2(workspaceId: Id): string {
  return `v2/workspaces/${pathSegment(workspaceId, "Workspace ID")}/manifest.json`;
}

export function syncOperationPathV2(
  workspaceId: Id,
  deviceId: Id,
  sequence: number,
  operationHash: string,
): string {
  if (!isPositiveInteger(sequence) || !isHash(operationHash)) {
    throw new SyncProtocolError(
      "INVALID_ENVELOPE",
      "A V2 operation path requires a positive sequence and canonical hash.",
    );
  }
  return `v2/workspaces/${pathSegment(workspaceId, "Workspace ID")}/operations/${pathSegment(deviceId, "Device ID")}/${sequence}-${operationHash}.json.enc`;
}

const actorKinds = new Set(["human", "agent", "system"]);
const commandOrigins = new Set(["ui", "agent", "import", "sync", "migration"]);
const sourceCapabilities = new Set([
  "human_decision",
  "capture_inbox",
  "record_actual",
  "attach_evidence",
  "submit_proposal",
  "import_portable",
  "replay_receipt",
  "system_time",
  "open_conflict",
]);

function isCommandSource(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["sourceId", "verified", "capabilities"]) ||
    !isCanonicalId(value.sourceId) ||
    typeof value.verified !== "boolean" ||
    !Array.isArray(value.capabilities)
  ) {
    return false;
  }
  const capabilities = value.capabilities;
  return (
    capabilities.every(
      (capability) =>
        typeof capability === "string" && sourceCapabilities.has(capability),
    ) &&
    new Set(capabilities).size === capabilities.length &&
    value.verified === true
  );
}

function isAuditDiff(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["entity", "entityId", "field", "before", "after"]) &&
    isNonEmptyText(value.entity) &&
    isCanonicalId(value.entityId) &&
    isNonEmptyText(value.field) &&
    isJsonValue(value.before) &&
    isJsonValue(value.after)
  );
}

function isAppliedReceiptShape(value: unknown): value is CommandReceipt {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "id",
      "commandId",
      "commandType",
      "baseRevision",
      "revision",
      "payloadHash",
      "receiptHash",
      "actorId",
      "actorKind",
      "origin",
      "source",
      "status",
      "createdAt",
      "diff",
    ]) &&
    isCanonicalId(value.id) &&
    isCanonicalId(value.commandId) &&
    isNonEmptyText(value.commandType) &&
    isNonNegativeInteger(value.baseRevision) &&
    isPositiveInteger(value.revision) &&
    value.revision === value.baseRevision + 1 &&
    isHash(value.payloadHash) &&
    isHash(value.receiptHash) &&
    isCanonicalId(value.actorId) &&
    typeof value.actorKind === "string" &&
    actorKinds.has(value.actorKind) &&
    typeof value.origin === "string" &&
    commandOrigins.has(value.origin) &&
    isCommandSource(value.source) &&
    value.status === "applied" &&
    isISODate(value.createdAt) &&
    Array.isArray(value.diff) &&
    value.diff.every(isAuditDiff)
  );
}

function parseCommandReceiptTupleV2(
  value: unknown,
): Pick<SyncOperationPayloadV2, "command" | "receipt"> {
  if (
    !isRecord(value) ||
    !isRecord(value.command) ||
    !isNonEmptyText(value.command.type) ||
    !isJsonValue(value.command) ||
    !isRecord(value.receipt) ||
    value.receipt.status !== "applied"
  ) {
    throw new SyncProtocolError(
      "RECEIPT_REQUIRED",
      "A raw sync origin or capability cannot replace an applied command receipt.",
    );
  }
  if (!isAppliedReceiptShape(value.receipt)) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The applied command receipt has an invalid shape.",
    );
  }
  return {
    command: clone(value.command as unknown as V2Command),
    receipt: clone(value.receipt),
  };
}

function parseOperationBindingV2(value: unknown): SyncOperationBindingV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "protocol",
      "workspaceId",
      "deviceId",
      "sequence",
      "operationId",
      "commandId",
      "baseRevision",
      "revision",
      "previousOperationHash",
      "payloadHash",
      "createdAt",
    ]) ||
    value.schemaVersion !== 2 ||
    value.protocol !== V2_SYNC_PROTOCOL ||
    !isCanonicalId(value.workspaceId) ||
    !isCanonicalId(value.deviceId) ||
    !isPositiveInteger(value.sequence) ||
    !isCanonicalId(value.operationId) ||
    !isCanonicalId(value.commandId) ||
    !isNonNegativeInteger(value.baseRevision) ||
    !isPositiveInteger(value.revision) ||
    value.revision !== value.baseRevision + 1 ||
    !(
      value.previousOperationHash === null ||
      isHash(value.previousOperationHash)
    ) ||
    (value.baseRevision === 0) !==
      (value.previousOperationHash === null) ||
    !isHash(value.payloadHash) ||
    !isISODate(value.createdAt)
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The encrypted V2 operation binding has an invalid or mutable shape.",
    );
  }
  return clone(value as unknown as SyncOperationBindingV2);
}

function parseOperationPayloadV2(value: unknown): SyncOperationPayloadV2 {
  const tuple = parseCommandReceiptTupleV2(value);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["binding", "command", "receipt"])
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The encrypted V2 operation payload must contain one exact header binding.",
    );
  }
  return {
    binding: parseOperationBindingV2(value.binding),
    ...tuple,
  };
}

function operationBindingFromEnvelope(
  envelope: Readonly<SyncEnvelopeV2>,
): SyncOperationBindingV2 {
  return {
    schemaVersion: envelope.schemaVersion,
    protocol: envelope.protocol,
    workspaceId: envelope.workspaceId,
    deviceId: envelope.deviceId,
    sequence: envelope.sequence,
    operationId: envelope.operationId,
    commandId: envelope.commandId,
    baseRevision: envelope.baseRevision,
    revision: envelope.revision,
    previousOperationHash: envelope.previousOperationHash ?? null,
    payloadHash: envelope.payloadHash,
    createdAt: envelope.createdAt,
  };
}

async function commandPayloadHash(command: V2Command): Promise<string> {
  return stableHash(command as unknown as JsonValue);
}

async function assertReceiptHash(receipt: CommandReceipt): Promise<void> {
  const { receiptHash, ...receiptBase } = receipt;
  if ((await stableHash(receiptBase as unknown as JsonValue)) !== receiptHash) {
    throw new SyncProtocolError(
      "RECEIPT_HASH_MISMATCH",
      "The V2 sync operation receipt hash is invalid.",
    );
  }
}

async function assertReceiptMatchesCommand(
  command: V2Command,
  receipt: CommandReceipt,
): Promise<string> {
  const payloadHash = await commandPayloadHash(command);
  if (
    receipt.id !== receipt.commandId ||
    receipt.commandType !== command.type ||
    receipt.payloadHash !== payloadHash
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The V2 sync operation does not match its applied receipt.",
    );
  }
  await assertReceiptHash(receipt);
  return payloadHash;
}

export async function createSyncOperationV2(
  input: CreateSyncOperationV2Input,
): Promise<CreatedSyncOperationV2> {
  const operationTuple = parseCommandReceiptTupleV2({
    command: input.command,
    receipt: input.receipt,
  });
  const payloadHash = await assertReceiptMatchesCommand(
    operationTuple.command,
    operationTuple.receipt,
  );
  const binding = parseOperationBindingV2({
    schemaVersion: 2,
    protocol: V2_SYNC_PROTOCOL,
    workspaceId: input.workspaceId,
    deviceId: input.deviceId,
    sequence: input.sequence,
    operationId: input.operationId,
    commandId: input.receipt.commandId,
    baseRevision: input.receipt.baseRevision,
    revision: input.receipt.revision,
    previousOperationHash: input.previousOperationHash ?? null,
    payloadHash,
    createdAt: input.receipt.createdAt,
  });
  const operationPayload = parseOperationPayloadV2({
    binding,
    ...operationTuple,
  });
  const payload = await encryptSyncPayload(
    operationPayload,
    input.passphrase,
  );
  const envelope = parseSyncEnvelopeV2({
    schemaVersion: binding.schemaVersion,
    protocol: binding.protocol,
    workspaceId: binding.workspaceId,
    deviceId: binding.deviceId,
    sequence: binding.sequence,
    operationId: binding.operationId,
    commandId: binding.commandId,
    baseRevision: binding.baseRevision,
    revision: binding.revision,
    ...(binding.previousOperationHash === null
      ? {}
      : { previousOperationHash: binding.previousOperationHash }),
    payloadHash: binding.payloadHash,
    createdAt: binding.createdAt,
    payload,
  } satisfies SyncEnvelopeV2);
  const operationHash = await sha256Hex(canonicalJson(envelope));
  return Object.freeze({
    envelope,
    operationHash,
    path: syncOperationPathV2(
      envelope.workspaceId,
      envelope.deviceId,
      envelope.sequence,
      operationHash,
    ),
  });
}

const verifiedReplayBrand: unique symbol = Symbol("VerifiedSyncReplay");

export interface VerifiedSyncReplay {
  readonly [verifiedReplayBrand]: true;
  readonly operationHash: string;
  readonly path: string;
  readonly workspaceId: Id;
  readonly deviceId: Id;
  readonly sequence: number;
  readonly operationId: Id;
  readonly previousOperationHash: string | undefined;
  readonly command: Readonly<V2Command>;
  readonly receipt: Readonly<CommandReceipt>;
}

const verifiedReplays = new WeakSet<object>();

class VerifiedSyncReplayValue implements VerifiedSyncReplay {
  readonly [verifiedReplayBrand] = true as const;
  readonly #envelope: Readonly<SyncEnvelopeV2>;
  readonly #operationHash: string;
  readonly #path: string;
  readonly #command: V2Command;
  readonly #receipt: CommandReceipt;

  constructor(input: {
    envelope: Readonly<SyncEnvelopeV2>;
    operationHash: string;
    path: string;
    command: V2Command;
    receipt: CommandReceipt;
  }) {
    this.#envelope = input.envelope;
    this.#operationHash = input.operationHash;
    this.#path = input.path;
    this.#command = deepFreeze(clone(input.command));
    this.#receipt = deepFreeze(clone(input.receipt));
    Object.freeze(this);
    verifiedReplays.add(this);
  }

  get operationHash(): string {
    return this.#operationHash;
  }

  get path(): string {
    return this.#path;
  }

  get workspaceId(): Id {
    return this.#envelope.workspaceId;
  }

  get deviceId(): Id {
    return this.#envelope.deviceId;
  }

  get sequence(): number {
    return this.#envelope.sequence;
  }

  get operationId(): Id {
    return this.#envelope.operationId;
  }

  get previousOperationHash(): string | undefined {
    return this.#envelope.previousOperationHash;
  }

  get command(): Readonly<V2Command> {
    return this.#command;
  }

  get receipt(): Readonly<CommandReceipt> {
    return this.#receipt;
  }
}

export function isVerifiedSyncReplay(value: unknown): value is VerifiedSyncReplay {
  return typeof value === "object" && value !== null && verifiedReplays.has(value);
}

const authorizedReplayBrand: unique symbol = Symbol("AuthorizedSyncReplay");

export interface AuthorizedSyncReplay {
  readonly [authorizedReplayBrand]: true;
  readonly operationHash: string;
  readonly path: string;
  readonly workspaceId: Id;
  readonly deviceId: Id;
  readonly sequence: number;
  readonly operationId: Id;
  readonly previousOperationHash: string | undefined;
  readonly command: Readonly<V2Command>;
  readonly receipt: Readonly<CommandReceipt>;
  /**
   * The non-sync operation whose human/system authority every replay in this
   * chain must terminate at. This identity is derived only from a fully
   * verified history; callers must not infer authority from commandId alone.
   */
  readonly authorityRoot: Readonly<SyncAuthorityRootV2>;
}

export interface SyncAuthorityRootV2 {
  readonly operationHash: string;
  readonly command: Readonly<V2Command>;
  readonly receipt: Readonly<CommandReceipt>;
  readonly commandId: Id;
  readonly commandType: CommandReceipt["commandType"];
  readonly actorId: Id;
  readonly actorKind: CommandReceipt["actorKind"];
  readonly createdAt: ISODate;
  readonly payloadHash: string;
}

const authorizedReplays = new WeakSet<object>();

interface AuthorizedProposalAcceptanceBindingV2 {
  readonly proposalId: Id;
  readonly immutableProposalCanonical: string;
  readonly submissionAuthorityRootOperationHash: string;
  readonly submissionAuthorityReceiptCanonical: string;
  readonly submissionOperationHash: string;
  readonly submissionSource: Readonly<CommandSource>;
  readonly submissionCommandId: Id;
  readonly submissionPayloadHash: string;
  readonly submissionActorId: Id;
  readonly submissionCreatedAt: ISODate;
}

const authorizedProposalAcceptanceBindings = new WeakMap<
  object,
  Readonly<AuthorizedProposalAcceptanceBindingV2>
>();

class AuthorizedSyncReplayValue implements AuthorizedSyncReplay {
  readonly [authorizedReplayBrand] = true as const;

  constructor(
    private readonly replay: VerifiedSyncReplay,
    authorityRoot: VerifiedSyncReplay,
    proposalAcceptanceBinding?: AuthorizedProposalAcceptanceBindingV2,
  ) {
    this.authorityRoot = deepFreeze({
      operationHash: authorityRoot.operationHash,
      command: clone(authorityRoot.command) as V2Command,
      receipt: clone(authorityRoot.receipt),
      commandId: authorityRoot.receipt.commandId,
      commandType: authorityRoot.receipt.commandType,
      actorId: authorityRoot.receipt.actorId,
      actorKind: authorityRoot.receipt.actorKind,
      createdAt: authorityRoot.receipt.createdAt,
      payloadHash: authorityRoot.receipt.payloadHash,
    });
    Object.freeze(this);
    authorizedReplays.add(this);
    if (proposalAcceptanceBinding !== undefined) {
      authorizedProposalAcceptanceBindings.set(
        this,
        deepFreeze(clone(proposalAcceptanceBinding)),
      );
    }
  }

  readonly authorityRoot: Readonly<SyncAuthorityRootV2>;

  get operationHash(): string {
    return this.replay.operationHash;
  }

  get path(): string {
    return this.replay.path;
  }

  get workspaceId(): Id {
    return this.replay.workspaceId;
  }

  get deviceId(): Id {
    return this.replay.deviceId;
  }

  get sequence(): number {
    return this.replay.sequence;
  }

  get operationId(): Id {
    return this.replay.operationId;
  }

  get previousOperationHash(): string | undefined {
    return this.replay.previousOperationHash;
  }

  get command(): Readonly<V2Command> {
    return this.replay.command;
  }

  get receipt(): Readonly<CommandReceipt> {
    return this.replay.receipt;
  }
}

export function isAuthorizedSyncReplay(
  value: unknown,
): value is AuthorizedSyncReplay {
  return (
    typeof value === "object" &&
    value !== null &&
    authorizedReplays.has(value)
  );
}

function immutableProposalCanonical(
  proposal: WorkspaceV2["commandProposals"][number],
): string {
  return canonicalJson({
    id: proposal.id,
    commandType: proposal.commandType,
    payload: proposal.payload,
    rationale: proposal.rationale,
    agentActorId: proposal.agentActorId,
    createdAt: proposal.createdAt,
  });
}

/**
 * Confirms that an opaque acceptance replay is still pointed at the exact
 * locally open proposal submission whose immutable identity the human
 * authorized. Rebased revision/status fields are deliberately excluded; the
 * direct submission receipt supplies the stable authority identity instead.
 */
export function isAuthorizedProposalAcceptanceFor(
  replay: AuthorizedSyncReplay,
  workspace: WorkspaceV2,
): boolean {
  if (
    !isAuthorizedSyncReplay(replay) ||
    replay.command.type !== "accept_command_proposal" ||
    replay.workspaceId !== workspace.workspaceId
  ) {
    return false;
  }
  const binding = authorizedProposalAcceptanceBindings.get(replay);
  if (
    binding === undefined ||
    binding.proposalId !== replay.command.proposalId
  ) {
    return false;
  }
  const proposals = workspace.commandProposals.filter(
    ({ id }) => id === binding.proposalId,
  );
  if (proposals.length !== 1) return false;
  const proposal = proposals[0];
  if (
    proposal.status !== "open" ||
    workspace.revision !== proposal.baseRevision + 1 ||
    immutableProposalCanonical(proposal) !== binding.immutableProposalCanonical
  ) {
    return false;
  }
  const directSubmissionReceipts = workspace.commandReceipts.filter(
    ({ status, baseRevision, revision }) =>
      status === "applied" &&
      baseRevision === proposal.baseRevision &&
      revision === proposal.baseRevision + 1,
  );
  if (directSubmissionReceipts.length !== 1) return false;
  const receipt = directSubmissionReceipts[0];
  const exactAuthorityReceipt =
    canonicalJson(receipt) === binding.submissionAuthorityReceiptCanonical;
  const expectedReplaySource = {
    sourceId: `sync-replay:${binding.submissionOperationHash}:${binding.submissionSource.sourceId}`,
    verified: binding.submissionSource.verified,
    capabilities: Array.from(
      new Set([
        ...binding.submissionSource.capabilities,
        "replay_receipt" as const,
      ]),
    ),
  };
  const exactDirectSubmissionReplay =
    receipt.origin === "sync" &&
    canonicalJson(receipt.source) === canonicalJson(expectedReplaySource);
  return (
    isHash(binding.submissionAuthorityRootOperationHash) &&
    isHash(binding.submissionOperationHash) &&
    receipt.commandType === "submit_command_proposal" &&
    receipt.commandId === binding.submissionCommandId &&
    receipt.payloadHash === binding.submissionPayloadHash &&
    receipt.actorId === binding.submissionActorId &&
    receipt.actorId === proposal.agentActorId &&
    receipt.actorKind === "agent" &&
    receipt.createdAt === binding.submissionCreatedAt &&
    receipt.createdAt === proposal.createdAt &&
    receipt.source.verified &&
    receipt.source.capabilities.includes("submit_proposal") &&
    (exactAuthorityReceipt || exactDirectSubmissionReplay)
  );
}

export type SemanticSyncReplayKind = "commit_today" | "propose_replan";

function semanticReplayKind(
  source: Readonly<V2Command>,
  derived: Readonly<V2Command>,
): SemanticSyncReplayKind | undefined {
  if (source.type === "commit_today" && derived.type === "commit_today") {
    const normalized = clone(derived);
    normalized.commitment.workspaceRevision =
      source.commitment.workspaceRevision;
    return canonicalJson(normalized) === canonicalJson(source)
      ? "commit_today"
      : undefined;
  }
  if (source.type === "propose_replan" && derived.type === "propose_replan") {
    const normalized = clone(derived);
    normalized.proposal.baseRevision = source.proposal.baseRevision;
    return canonicalJson(normalized) === canonicalJson(source)
      ? "propose_replan"
      : undefined;
  }
  return undefined;
}

const authorizedSemanticReplayBrand: unique symbol = Symbol(
  "AuthorizedSemanticSyncReplay",
);

export interface AuthorizedSemanticSyncReplay {
  readonly [authorizedSemanticReplayBrand]: true;
  readonly semanticKind: SemanticSyncReplayKind;
  readonly operationHash: string;
  readonly workspaceId: Id;
  readonly command: Readonly<V2Command>;
  readonly receipt: Readonly<CommandReceipt>;
  readonly authorityRoot: Readonly<SyncAuthorityRootV2>;
  readonly expectedWorkspaceCanonical: string;
}

const authorizedSemanticReplays = new WeakSet<object>();

class AuthorizedSemanticSyncReplayValue
  implements AuthorizedSemanticSyncReplay
{
  readonly [authorizedSemanticReplayBrand] = true as const;

  constructor(
    private readonly replay: AuthorizedSyncReplay,
    readonly semanticKind: SemanticSyncReplayKind,
    command: V2Command,
    readonly expectedWorkspaceCanonical: string,
  ) {
    this.command = deepFreeze(clone(command));
    Object.freeze(this);
    authorizedSemanticReplays.add(this);
  }

  readonly command: Readonly<V2Command>;

  get operationHash(): string {
    return this.replay.operationHash;
  }

  get workspaceId(): Id {
    return this.replay.workspaceId;
  }

  get receipt(): Readonly<CommandReceipt> {
    return this.replay.receipt;
  }

  get authorityRoot(): Readonly<SyncAuthorityRootV2> {
    return this.replay.authorityRoot;
  }
}

export function isAuthorizedSemanticSyncReplay(
  value: unknown,
): value is AuthorizedSemanticSyncReplay {
  return (
    typeof value === "object" &&
    value !== null &&
    authorizedSemanticReplays.has(value)
  );
}

export async function authorizeSemanticSyncReplayV2(
  replay: AuthorizedSyncReplay,
  workspaceInput: WorkspaceV2,
): Promise<AuthorizedSemanticSyncReplay> {
  if (!isAuthorizedSyncReplay(replay)) {
    throw new SyncProtocolError(
      "RECEIPT_REQUIRED",
      "Semantic replay requires an authorized sync operation.",
    );
  }
  const workspace = clone(workspaceInput);
  if (workspace.workspaceId !== replay.workspaceId) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Semantic replay cannot cross Workspace identity.",
    );
  }
  const authorityCommand = replay.authorityRoot.command;
  let derived: V2Command;
  if (authorityCommand.type === "commit_today") {
    const source = authorityCommand;
    const authoritative = await generateTodayProposal(
      workspace,
      source.commitment.localDate,
      source.commitment.generatedAt,
    );
    const {
      proposalHash: _authoritativeHash,
      ...normalizedProposalBase
    } = clone(authoritative);
    normalizedProposalBase.workspaceRevision =
      source.commitment.workspaceRevision;
    const normalizedProposalHash = await stableHash(
      normalizedProposalBase as unknown as JsonValue,
    );
    if (
      normalizedProposalHash !== source.commitment.proposalHash ||
      canonicalJson(authoritative.slots) !==
        canonicalJson(source.commitment.slots)
    ) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "Today semantic replay changed its human-approved proposal read-set.",
      );
    }
    derived = {
      type: "commit_today",
      commitment: {
        ...clone(source.commitment),
        workspaceRevision: workspace.revision,
      },
    };
  } else if (authorityCommand.type === "propose_replan") {
    const source = authorityCommand;
    const today = await generateTodayProposal(
      workspace,
      source.proposal.localDate,
      source.proposal.createdAt,
    );
    const { proposalHash: _todayHash, ...normalizedTodayBase } = clone(today);
    normalizedTodayBase.workspaceRevision = source.proposal.baseRevision;
    if (
      (await stableHash(normalizedTodayBase as unknown as JsonValue)) !==
      source.proposal.proposalHash
    ) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "Replan semantic replay changed its human-approved proposal read-set.",
      );
    }
    const authoritative = await buildReplanProposal(workspace, {
      id: source.proposal.id,
      localDate: source.proposal.localDate,
      reasonCodes: clone(source.proposal.reasonCodes),
      createdAt: source.proposal.createdAt,
      createdBy: source.proposal.createdBy,
    });
    const derivedProposal = {
      ...clone(authoritative),
      baseRevision: source.proposal.baseRevision,
      proposalHash: source.proposal.proposalHash,
    };
    const normalized = {
      ...clone(derivedProposal),
      baseRevision: source.proposal.baseRevision,
    };
    if (canonicalJson(normalized) !== canonicalJson(source.proposal)) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "Replan semantic replay changed its human-approved base, reasons, or slots.",
      );
    }
    derived = { type: "propose_replan", proposal: derivedProposal };
  } else {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      `Command ${authorityCommand.type} has no bounded semantic replay contract.`,
    );
  }
  const kind = semanticReplayKind(replay.command, derived);
  if (kind === undefined) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Derived semantic replay exceeded its allowed revision-bound fields.",
    );
  }
  return new AuthorizedSemanticSyncReplayValue(
    replay,
    kind,
    derived,
    canonicalJson(workspace),
  );
}

const verifiedHistoryBrand: unique symbol = Symbol("VerifiedSyncHistory");

export interface VerifiedSyncHistory {
  readonly [verifiedHistoryBrand]: true;
  readonly workspaceId: Id;
  readonly manifest: Readonly<SyncManifestV2>;
  readonly operations: readonly VerifiedSyncReplay[];
}

const verifiedHistories = new WeakSet<object>();

class VerifiedSyncHistoryValue implements VerifiedSyncHistory {
  readonly [verifiedHistoryBrand] = true as const;
  readonly #workspaceId: Id;
  readonly #manifest: Readonly<SyncManifestV2>;
  readonly #operations: readonly VerifiedSyncReplay[];
  readonly #byHash: ReadonlyMap<string, VerifiedSyncReplay>;

  constructor(
    manifest: Readonly<SyncManifestV2>,
    operations: readonly VerifiedSyncReplay[],
  ) {
    this.#workspaceId = manifest.workspaceId;
    this.#manifest = manifest;
    this.#operations = Object.freeze([...operations]);
    this.#byHash = new Map(
      operations.map((operation) => [operation.operationHash, operation]),
    );
    Object.freeze(this);
    verifiedHistories.add(this);
  }

  get workspaceId(): Id {
    return this.#workspaceId;
  }

  get manifest(): Readonly<SyncManifestV2> {
    return this.#manifest;
  }

  get operations(): readonly VerifiedSyncReplay[] {
    return this.#operations;
  }

  operation(operationHash: string): VerifiedSyncReplay | undefined {
    return this.#byHash.get(operationHash);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function latestEvaluationNow(
  current: ISODate | undefined,
  candidate: ISODate,
): ISODate {
  return current === undefined || compareText(current, candidate) < 0
    ? candidate
    : current;
}

function historyOperation(
  history: VerifiedSyncHistory,
  operationHash: string,
): VerifiedSyncReplay | undefined {
  if (!verifiedHistories.has(history as object)) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "Common-ancestor discovery requires a verified sync history.",
    );
  }
  return (history as VerifiedSyncHistoryValue).operation(operationHash);
}

function syncSourceOperationHash(
  receipt: Readonly<CommandReceipt>,
): string | undefined {
  if (receipt.origin !== "sync") return undefined;
  return (
    /^sync-replay:([a-f0-9]{64}):/s.exec(receipt.source.sourceId)?.[1] ??
    /^sync-semantic:([a-f0-9]{64}):(commit_today|propose_replan):/s.exec(
      receipt.source.sourceId,
    )?.[1]
  );
}

function semanticSyncSourceLink(
  receipt: Readonly<CommandReceipt>,
): { operationHash: string; kind: SemanticSyncReplayKind } | undefined {
  if (receipt.origin !== "sync") return undefined;
  const match =
    /^sync-semantic:([a-f0-9]{64}):(commit_today|propose_replan):/s.exec(
      receipt.source.sourceId,
    );
  if (match === null) return undefined;
  return {
    operationHash: match[1],
    kind: match[2] as SemanticSyncReplayKind,
  };
}

function verifiedAuthorityRootOperation(
  history: VerifiedSyncHistory,
  operation: VerifiedSyncReplay,
): VerifiedSyncReplay {
  const seen = new Set<string>();
  let cursor = operation;
  while (cursor.receipt.origin === "sync") {
    if (seen.has(cursor.operationHash)) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A verified sync authority chain contains a cycle.",
      );
    }
    seen.add(cursor.operationHash);
    const sourceHash = syncSourceOperationHash(cursor.receipt);
    const source =
      sourceHash === undefined ? undefined : historyOperation(history, sourceHash);
    if (source === undefined) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A verified sync replay no longer reaches its authority root.",
      );
    }
    cursor = source;
  }
  return cursor;
}

function authorityRootIdentity(
  operation: VerifiedSyncReplay,
): Readonly<SyncAuthorityRootV2> {
  return deepFreeze({
    operationHash: operation.operationHash,
    command: clone(operation.command) as V2Command,
    receipt: clone(operation.receipt),
    commandId: operation.receipt.commandId,
    commandType: operation.receipt.commandType,
    actorId: operation.receipt.actorId,
    actorKind: operation.receipt.actorKind,
    createdAt: operation.receipt.createdAt,
    payloadHash: operation.receipt.payloadHash,
  });
}

/** Resolve an operation only through a branded, fully verified history. */
export function verifiedSyncAuthorityRootV2(
  history: VerifiedSyncHistory,
  operationHash: string,
): Readonly<SyncAuthorityRootV2> | undefined {
  const operation = historyOperation(history, operationHash);
  return operation === undefined
    ? undefined
    : authorityRootIdentity(verifiedAuthorityRootOperation(history, operation));
}

export function verifySyncHistoryV2(
  manifestInput: unknown,
  replayInputs: readonly VerifiedSyncReplay[],
): VerifiedSyncHistory {
  const manifest = parseSyncManifestV2(manifestInput);
  const operations = [...replayInputs];
  if (operations.length === 0 && Object.keys(manifest.heads).length !== 0) {
    throw new SyncProtocolError(
      "MISSING_ANCESTOR",
      "The manifest heads are missing from the downloaded operation history.",
    );
  }
  const byHash = new Map<string, VerifiedSyncReplay>();
  const operationIds = new Set<string>();
  const byCommandId = new Map<string, VerifiedSyncReplay[]>();
  for (const operation of operations) {
    if (!isVerifiedSyncReplay(operation)) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "Unverified remote data cannot enter the sync history.",
      );
    }
    if (operation.workspaceId !== manifest.workspaceId) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A sync history cannot mix workspaces.",
      );
    }
    if (
      byHash.has(operation.operationHash) ||
      operationIds.has(operation.operationId)
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "The sync history contains duplicate immutable operation identity.",
      );
    }
    byHash.set(operation.operationHash, operation);
    operationIds.add(operation.operationId);
    const sameCommand = byCommandId.get(operation.receipt.commandId) ?? [];
    sameCommand.push(operation);
    byCommandId.set(operation.receipt.commandId, sameCommand);
  }

  const replaySources = new Map<
    string,
    { source: VerifiedSyncReplay; semanticKind?: SemanticSyncReplayKind }
  >();
  for (const operation of operations) {
    if (operation.receipt.origin !== "sync") continue;
    const exactMatch = /^sync-replay:([a-f0-9]{64}):(.*)$/s.exec(
      operation.receipt.source.sourceId,
    );
    const semanticMatch =
      /^sync-semantic:([a-f0-9]{64}):(commit_today|propose_replan):(.*)$/s.exec(
        operation.receipt.source.sourceId,
      );
    const sourceHash = exactMatch?.[1] ?? semanticMatch?.[1];
    const source =
      sourceHash === undefined ? undefined : byHash.get(sourceHash);
    const linkedSourceId = exactMatch?.[2] ?? semanticMatch?.[3];
    const claimedSemanticKind = semanticMatch?.[2] as
      | SemanticSyncReplayKind
      | undefined;
    const expectedCapabilities = [
      ...new Set([
        ...(source?.receipt.source.capabilities ?? []),
        "replay_receipt",
      ]),
    ];
    if (
      !operation.receipt.source.verified ||
      !operation.receipt.source.capabilities.includes("replay_receipt") ||
      (exactMatch === null && semanticMatch === null) ||
      source === undefined ||
      source === operation ||
      source.receipt.commandId !== operation.receipt.commandId ||
      source.receipt.commandType !== operation.receipt.commandType ||
      linkedSourceId !== source.receipt.source.sourceId ||
      source.receipt.actorId !== operation.receipt.actorId ||
      source.receipt.actorKind !== operation.receipt.actorKind ||
      source.receipt.createdAt !== operation.receipt.createdAt ||
      (claimedSemanticKind === undefined
        ? canonicalJson(source.command) !== canonicalJson(operation.command) ||
          source.receipt.payloadHash !== operation.receipt.payloadHash
        : semanticReplayKind(source.command, operation.command) !==
          claimedSemanticKind) ||
      canonicalJson(expectedCapabilities) !==
        canonicalJson(operation.receipt.source.capabilities)
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "Every sync-origin receipt must link to the exact prior applied authority operation.",
      );
    }
    replaySources.set(operation.operationHash, {
      source,
      ...(claimedSemanticKind === undefined
        ? {}
        : { semanticKind: claimedSemanticKind }),
    });
  }

  for (const sameCommand of byCommandId.values()) {
    const authorityRoots = sameCommand.filter(
      ({ receipt }) => receipt.origin !== "sync",
    );
    if (sameCommand.length > 1 && authorityRoots.length !== 1) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A repeated command identity must have exactly one non-sync authority root.",
      );
    }
    for (const operation of sameCommand) {
      if (operation.receipt.origin !== "sync") continue;
      const seen = new Set<string>();
      let cursor: VerifiedSyncReplay = operation;
      while (cursor.receipt.origin === "sync") {
        if (seen.has(cursor.operationHash)) {
          throw new SyncProtocolError(
            "BROKEN_HASH_CHAIN",
            "A sync replay authority chain contains a cycle.",
          );
        }
        seen.add(cursor.operationHash);
        const link = replaySources.get(cursor.operationHash);
        if (link === undefined) {
          throw new SyncProtocolError(
            "BROKEN_HASH_CHAIN",
            "A sync replay has no prior applied authority operation.",
          );
        }
        cursor = link.source;
      }
      if (!sameCommand.includes(cursor)) {
        throw new SyncProtocolError(
          "BROKEN_HASH_CHAIN",
          "A sync replay does not terminate at its command authority root.",
        );
      }
    }
  }

  let roots = 0;
  for (const operation of operations) {
    const parentHash = operation.previousOperationHash;
    if (parentHash === undefined) {
      roots += 1;
      if (operation.receipt.baseRevision !== 0) {
        throw new SyncProtocolError(
          "MISSING_ANCESTOR",
          "A non-initial operation is missing its ancestor hash.",
        );
      }
      continue;
    }
    const parent = byHash.get(parentHash);
    if (parent === undefined) {
      throw new SyncProtocolError(
        "MISSING_ANCESTOR",
        `Operation ${operation.operationHash} references an unavailable ancestor.`,
      );
    }
    if (operation.receipt.baseRevision !== parent.receipt.revision) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A child operation base revision does not equal its parent revision.",
      );
    }
  }
  if (operations.length > 0 && roots === 0) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "A complete V2 command history must reach the shared Workspace genesis.",
    );
  }

  for (const operation of operations) {
    const seen = new Set<string>();
    let current: VerifiedSyncReplay | undefined = operation;
    while (current !== undefined) {
      if (seen.has(current.operationHash)) {
        throw new SyncProtocolError(
          "BROKEN_HASH_CHAIN",
          "The V2 operation graph contains a cycle.",
        );
      }
      seen.add(current.operationHash);
      current =
        current.previousOperationHash === undefined
          ? undefined
          : byHash.get(current.previousOperationHash);
    }
  }

  const byDevice = new Map<string, VerifiedSyncReplay[]>();
  for (const operation of operations) {
    const deviceOperations = byDevice.get(operation.deviceId) ?? [];
    deviceOperations.push(operation);
    byDevice.set(operation.deviceId, deviceOperations);
  }
  for (const [deviceId, deviceOperations] of byDevice) {
    const sorted = deviceOperations.sort(
      (left, right) => left.sequence - right.sequence,
    );
    if (
      sorted.some((operation, index) => operation.sequence !== index + 1)
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        `Device ${deviceId} has a missing or duplicate sequence.`,
      );
    }
    for (let index = 1; index < sorted.length; index += 1) {
      const requiredAncestorHash = sorted[index - 1].operationHash;
      let cursor: VerifiedSyncReplay | undefined = sorted[index];
      let foundPriorDeviceSequence = false;
      while (cursor?.previousOperationHash !== undefined) {
        if (cursor.previousOperationHash === requiredAncestorHash) {
          foundPriorDeviceSequence = true;
          break;
        }
        cursor = byHash.get(cursor.previousOperationHash);
      }
      if (!foundPriorDeviceSequence) {
        throw new SyncProtocolError(
          "BROKEN_HASH_CHAIN",
          `Device ${deviceId} abandoned an earlier operation branch.`,
        );
      }
    }
    const latest = sorted[sorted.length - 1];
    const manifestHead = manifest.heads[deviceId];
    if (
      manifestHead === undefined ||
      manifestHead.sequence !== latest.sequence ||
      manifestHead.operationHash !== latest.operationHash ||
      manifestHead.revision !== latest.receipt.revision ||
      manifestHead.updatedAt !== latest.receipt.createdAt
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        `Device ${deviceId} does not match its manifest head.`,
      );
    }
  }

  const reachableFromHeads = new Set<string>();
  for (const head of Object.values(manifest.heads)) {
    let cursor = byHash.get(head.operationHash);
    while (cursor !== undefined && !reachableFromHeads.has(cursor.operationHash)) {
      reachableFromHeads.add(cursor.operationHash);
      cursor =
        cursor.previousOperationHash === undefined
          ? undefined
          : byHash.get(cursor.previousOperationHash);
    }
  }
  if (reachableFromHeads.size !== operations.length) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "The sync history contains an operation abandoned by every manifest head.",
    );
  }
  for (const [deviceId, manifestHead] of Object.entries(manifest.heads)) {
    const operation = byHash.get(manifestHead.operationHash);
    if (operation === undefined) {
      throw new SyncProtocolError(
        "MISSING_ANCESTOR",
        `Manifest head ${manifestHead.operationHash} is unavailable.`,
      );
    }
    if (operation.deviceId !== deviceId) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "A manifest head points at an operation from another device.",
      );
    }
  }

  const sorted = operations.sort(
    (left, right) =>
      left.receipt.revision - right.receipt.revision ||
      compareText(left.receipt.createdAt, right.receipt.createdAt) ||
      compareText(left.deviceId, right.deviceId) ||
      compareText(left.operationHash, right.operationHash),
  );
  return new VerifiedSyncHistoryValue(manifest, sorted);
}

export interface AuthorizeSyncBranchV2Input {
  history: VerifiedSyncHistory;
  trustedAncestorWorkspace: WorkspaceV2;
  /** Omit only when the trusted checkpoint is the shared revision-zero genesis. */
  ancestorOperationHash?: string;
  headOperationHash: string;
}

const authorizedSyncBranchBrand: unique symbol = Symbol(
  "AuthorizedSyncBranchV2",
);

export interface AuthorizedSyncBranchV2 {
  readonly [authorizedSyncBranchBrand]: true;
  readonly workspaceId: Id;
  readonly trustedAncestorCanonical: string;
  readonly trustedAncestorHash: string;
  readonly ancestorOperationHash: string | undefined;
  readonly headOperationHash: string;
  readonly replays: readonly AuthorizedSyncReplay[];
  readonly workspaceAfterReplays: readonly Readonly<WorkspaceV2>[];
  readonly workspace: Readonly<WorkspaceV2>;
  /** Unique branch evaluations performed in the shared authorization session. */
  readonly authorizationEvaluationCount: number;
}

const authorizedSyncBranches = new WeakSet<object>();

class AuthorizedSyncBranchV2Value implements AuthorizedSyncBranchV2 {
  readonly [authorizedSyncBranchBrand] = true as const;
  readonly workspaceId: Id;
  readonly trustedAncestorCanonical: string;
  readonly trustedAncestorHash: string;
  readonly ancestorOperationHash: string | undefined;
  readonly headOperationHash: string;
  readonly replays: readonly AuthorizedSyncReplay[];
  readonly workspaceAfterReplays: readonly Readonly<WorkspaceV2>[];
  readonly workspace: Readonly<WorkspaceV2>;
  readonly authorizationEvaluationCount: number;

  constructor(input: {
    trustedAncestorWorkspace: Readonly<WorkspaceV2>;
    trustedAncestorHash: string;
    ancestorOperationHash: string | undefined;
    headOperationHash: string;
    replays: readonly AuthorizedSyncReplay[];
    workspaceAfterReplays: readonly Readonly<WorkspaceV2>[];
    workspace: Readonly<WorkspaceV2>;
    authorizationEvaluationCount: number;
  }) {
    this.workspaceId = input.trustedAncestorWorkspace.workspaceId;
    this.trustedAncestorCanonical = canonicalJson(
      input.trustedAncestorWorkspace,
    );
    this.trustedAncestorHash = input.trustedAncestorHash;
    this.ancestorOperationHash = input.ancestorOperationHash;
    this.headOperationHash = input.headOperationHash;
    this.replays = Object.freeze([...input.replays]);
    this.workspaceAfterReplays = Object.freeze(
      input.workspaceAfterReplays.map((snapshot) =>
        deepFreeze(clone(snapshot)),
      ),
    );
    this.workspace = deepFreeze(clone(input.workspace));
    this.authorizationEvaluationCount = input.authorizationEvaluationCount;
    Object.freeze(this);
    authorizedSyncBranches.add(this);
  }
}

export function isAuthorizedSyncBranchV2(
  value: unknown,
): value is AuthorizedSyncBranchV2 {
  return (
    typeof value === "object" &&
    value !== null &&
    authorizedSyncBranches.has(value) &&
    value instanceof AuthorizedSyncBranchV2Value
  );
}

interface SyncBranchAuthorizationSession {
  readonly memo: Map<string, Promise<AuthorizedSyncBranchV2>>;
  readonly activeProvenanceEdges: Set<SyncProvenanceEdge>;
  evaluationCount: number;
}

interface SyncProvenanceEdge {
  readonly sourceKey: string;
  readonly targetKey: string;
}

function branchAuthorizationKey(input: AuthorizeSyncBranchV2Input): string {
  return [
    canonicalJson(input.trustedAncestorWorkspace),
    input.ancestorOperationHash ?? "genesis",
    input.headOperationHash,
  ].join("\u0000");
}

export function assertAcyclicSyncProvenanceEdgeV2(
  activeEdges: ReadonlySet<Readonly<SyncProvenanceEdge>>,
  sourceKey: string,
  targetKey: string,
): void {
  const pending = [targetKey];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceKey) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "Persisted conflict provenance contains an authorization cycle.",
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of activeEdges) {
      if (edge.sourceKey === current) pending.push(edge.targetKey);
    }
  }
}

export async function withAcyclicSyncProvenanceEdgeV2<T>(
  activeEdges: Set<SyncProvenanceEdge>,
  sourceKey: string,
  targetKey: string,
  authorizeTarget: () => Promise<T>,
): Promise<T> {
  const existingEdge = [...activeEdges].find(
    (edge) => edge.sourceKey === sourceKey && edge.targetKey === targetKey,
  );
  if (existingEdge !== undefined) return authorizeTarget();

  assertAcyclicSyncProvenanceEdgeV2(activeEdges, sourceKey, targetKey);
  const edge: SyncProvenanceEdge = { sourceKey, targetKey };
  activeEdges.add(edge);
  try {
    return await authorizeTarget();
  } finally {
    activeEdges.delete(edge);
  }
}

async function authorizeSyncBranchInSession(
  input: AuthorizeSyncBranchV2Input,
  session: SyncBranchAuthorizationSession,
): Promise<AuthorizedSyncBranchV2> {
  const authorizationKey = branchAuthorizationKey(input);
  const memoized = session.memo.get(authorizationKey);
  if (memoized !== undefined) return memoized;

  const pending = Promise.resolve().then(async () => {
    session.evaluationCount += 1;
    return authorizeSyncBranchUncached(input, session, authorizationKey);
  });
  session.memo.set(authorizationKey, pending);
  try {
    return await pending;
  } catch (error) {
    session.memo.delete(authorizationKey);
    throw error;
  }
}

async function authorizeProvenanceBranch(
  input: AuthorizeSyncBranchV2Input,
  session: SyncBranchAuthorizationSession,
  sourceAuthorizationKey: string,
): Promise<AuthorizedSyncBranchV2> {
  const targetAuthorizationKey = branchAuthorizationKey(input);
  return withAcyclicSyncProvenanceEdgeV2(
    session.activeProvenanceEdges,
    sourceAuthorizationKey,
    targetAuthorizationKey,
    () => authorizeSyncBranchInSession(input, session),
  );
}

export async function authorizeSyncBranchV2(
  input: AuthorizeSyncBranchV2Input,
): Promise<AuthorizedSyncBranchV2> {
  return authorizeSyncBranchInSession(input, {
    memo: new Map(),
    activeProvenanceEdges: new Set(),
    evaluationCount: 0,
  });
}

interface VerifiedProposalSubmissionAncestry {
  readonly command: ProposableV2Command;
  readonly authorityRoot: VerifiedSyncReplay;
  readonly submissionCommand: Extract<
    V2Command,
    { type: "submit_command_proposal" }
  >;
}

interface VerifiedAcceptedProposalOperationAncestry {
  readonly command: ProposableV2Command;
  readonly binding: AuthorizedProposalAcceptanceBindingV2;
}

function verifyProposalSubmissionOperation(
  history: VerifiedSyncHistory,
  submission: VerifiedSyncReplay,
  proposalId: Id,
  acceptanceBaseRevision: number,
): VerifiedProposalSubmissionAncestry {
  const submittedCommand = submission.command;
  if (submittedCommand.type !== "submit_command_proposal") {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Accepted proposal authority does not point to an Agent submission.",
    );
  }
  const authorityRoot = verifiedAuthorityRootOperation(history, submission);
  const authorityCommand = authorityRoot.command;
  if (
    submittedCommand.proposalId !== proposalId ||
    submission.receipt.status !== "applied" ||
    submission.receipt.commandType !== "submit_command_proposal" ||
    submission.receipt.actorKind !== "agent" ||
    !submission.receipt.source.verified ||
    !submission.receipt.source.capabilities.includes("submit_proposal") ||
    submission.receipt.revision !== submission.receipt.baseRevision + 1 ||
    submission.receipt.revision !== acceptanceBaseRevision ||
    authorityCommand.type !== "submit_command_proposal" ||
    authorityCommand.proposalId !== proposalId ||
    canonicalJson(authorityCommand) !== canonicalJson(submittedCommand) ||
    authorityRoot.receipt.status !== "applied" ||
    authorityRoot.receipt.commandType !== "submit_command_proposal" ||
    authorityRoot.receipt.actorKind !== "agent" ||
    !authorityRoot.receipt.source.verified ||
    !authorityRoot.receipt.source.capabilities.includes("submit_proposal") ||
    authorityRoot.receipt.revision !== authorityRoot.receipt.baseRevision + 1
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Accepted proposal authority has an invalid Agent submission chain.",
    );
  }

  const exactOpenSnapshot = (
    operation: VerifiedSyncReplay,
    command: Extract<V2Command, { type: "submit_command_proposal" }>,
  ) => ({
    id: proposalId,
    commandType: command.command.type,
    payload: command.command,
    baseRevision: operation.receipt.baseRevision,
    rationale: command.rationale,
    agentActorId: operation.receipt.actorId,
    createdAt: operation.receipt.createdAt,
    status: "open",
  });
  const hasExactSingleCreation = (
    operation: VerifiedSyncReplay,
    command: Extract<V2Command, { type: "submit_command_proposal" }>,
  ): boolean => {
    const proposalDiffs = operation.receipt.diff.filter(
      ({ entity }) => entity === "CommandProposal",
    );
    const creations = proposalDiffs.filter(
      (diff) =>
        diff.entityId === proposalId &&
        diff.field === "created" &&
        diff.before === null,
    );
    const seenStaleProposalIds = new Set<Id>();
    const hasOnlyExactStaleness = proposalDiffs.every((diff) => {
      if (diff === creations[0]) return true;
      if (
        diff.entityId === proposalId ||
        diff.field !== "status" ||
        diff.before !== "open" ||
        diff.after !== "stale" ||
        seenStaleProposalIds.has(diff.entityId)
      ) return false;
      seenStaleProposalIds.add(diff.entityId);
      return true;
    });
    return (
      creations.length === 1 &&
      hasOnlyExactStaleness &&
      canonicalJson(creations[0].after) ===
        canonicalJson(exactOpenSnapshot(operation, command))
    );
  };
  if (
    !hasExactSingleCreation(submission, submittedCommand) ||
    !hasExactSingleCreation(authorityRoot, authorityCommand)
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Accepted proposal authority lacks the exact stored Agent proposal snapshot.",
    );
  }
  return {
    command: clone(submittedCommand.command),
    authorityRoot,
    submissionCommand: clone(authorityCommand),
  };
}

function verifyAcceptedProposalOperationAncestry(
  history: VerifiedSyncHistory,
  acceptance: VerifiedSyncReplay,
): VerifiedAcceptedProposalOperationAncestry {
  const acceptanceCommand = acceptance.command;
  if (acceptanceCommand.type !== "accept_command_proposal") {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Proposal acceptance ancestry requires an acceptance operation.",
    );
  }
  const proposalId = acceptanceCommand.proposalId;
  const authorityRoot = verifiedAuthorityRootOperation(history, acceptance);
  const authorityCommand = authorityRoot.command;
  const hasExactAcceptedStatus = (operation: VerifiedSyncReplay): boolean => {
    const statusDiffs = operation.receipt.diff.filter(
      ({ entity, field }) =>
        entity === "CommandProposal" && field === "status",
    );
    const targetDiffs = statusDiffs.filter(
      ({ entityId }) => entityId === proposalId,
    );
    if (
      operation.receipt.diff.some(
        ({ entity, field }) =>
          entity === "CommandProposal" && field !== "status",
      ) ||
      targetDiffs.length !== 1 ||
      targetDiffs[0]?.before !== "open" ||
      targetDiffs[0]?.after !== "accepted"
    ) return false;
    const seenStaleProposalIds = new Set<Id>();
    for (const diff of statusDiffs) {
      if (diff.entityId === proposalId) continue;
      if (
        diff.before !== "open" ||
        diff.after !== "stale" ||
        seenStaleProposalIds.has(diff.entityId)
      ) return false;
      seenStaleProposalIds.add(diff.entityId);
    }
    return true;
  };
  const hasHumanAcceptanceAuthority = (
    operation: VerifiedSyncReplay,
  ): boolean =>
    operation.receipt.status === "applied" &&
    operation.receipt.commandType === "accept_command_proposal" &&
    operation.receipt.actorKind === "human" &&
    operation.receipt.source.verified &&
    operation.receipt.source.capabilities.includes("human_decision") &&
    operation.receipt.revision === operation.receipt.baseRevision + 1 &&
    hasExactAcceptedStatus(operation);
  if (
    !hasHumanAcceptanceAuthority(acceptance) ||
    authorityCommand.type !== "accept_command_proposal" ||
    authorityCommand.proposalId !== proposalId ||
    !hasHumanAcceptanceAuthority(authorityRoot)
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Accepted proposal projection lacks exact human acceptance authority.",
    );
  }

  const submission =
    acceptance.previousOperationHash === undefined
      ? undefined
      : historyOperation(history, acceptance.previousOperationHash);
  const authoritySubmission =
    authorityRoot.previousOperationHash === undefined
      ? undefined
      : historyOperation(history, authorityRoot.previousOperationHash);
  if (submission === undefined || authoritySubmission === undefined) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Accepted proposal is not the direct child of both its replay and human-authority submissions.",
    );
  }
  const verifiedSubmission = verifyProposalSubmissionOperation(
    history,
    submission,
    proposalId,
    acceptance.receipt.baseRevision,
  );
  const verifiedAuthoritySubmission = verifyProposalSubmissionOperation(
    history,
    authoritySubmission,
    proposalId,
    authorityRoot.receipt.baseRevision,
  );
  if (
    verifiedSubmission.authorityRoot.operationHash !==
    verifiedAuthoritySubmission.authorityRoot.operationHash
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Replayed proposal acceptance is not bound to the exact Agent submission the human accepted.",
    );
  }
  const submissionAuthority = verifiedSubmission.authorityRoot;
  const submissionCommand = verifiedSubmission.submissionCommand;
  return {
    command: clone(verifiedSubmission.command),
    binding: {
      proposalId,
      immutableProposalCanonical: immutableProposalCanonical({
        id: proposalId,
        commandType: submissionCommand.command.type,
        payload: clone(submissionCommand.command) as unknown as JsonValue,
        baseRevision: submissionAuthority.receipt.baseRevision,
        rationale: submissionCommand.rationale,
        agentActorId: submissionAuthority.receipt.actorId,
        createdAt: submissionAuthority.receipt.createdAt,
        status: "open",
      }),
      submissionAuthorityRootOperationHash: submissionAuthority.operationHash,
      submissionAuthorityReceiptCanonical: canonicalJson(
        submissionAuthority.receipt,
      ),
      submissionOperationHash: submission.operationHash,
      submissionSource: clone(submission.receipt.source),
      submissionCommandId: submissionAuthority.receipt.commandId,
      submissionPayloadHash: submissionAuthority.receipt.payloadHash,
      submissionActorId: submissionAuthority.receipt.actorId,
      submissionCreatedAt: submissionAuthority.receipt.createdAt,
    },
  };
}

async function assertPersistedConflictOpenHistoryProof(
  history: VerifiedSyncHistory,
  openOperation: VerifiedSyncReplay,
  command: Readonly<Extract<V2Command, { type: "open_sync_conflict" }>>,
): Promise<void> {
  const draft = command.conflict;
  const localBundle = draft.localBundle;
  const remoteBundle = draft.remoteBundle;
  if (
    draft.logicalKey === undefined ||
    localBundle === undefined ||
    remoteBundle === undefined ||
    localBundle.logicalKey !== draft.logicalKey ||
    remoteBundle.logicalKey !== draft.logicalKey ||
    !(await validateProtectedEffectBundle(localBundle)) ||
    !(await validateProtectedEffectBundle(remoteBundle))
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "Persisted conflict-open bundles are incomplete or fail their typed checksum.",
    );
  }

  const boundSourceOperations = new Set<string>();
  for (const bundle of [localBundle, remoteBundle]) {
    for (const projection of bundle.operations) {
      if (
        projection.sourceOperationHash === openOperation.operationHash ||
        boundSourceOperations.has(projection.sourceOperationHash)
      ) {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "Persisted conflict-open provenance contains a circular or duplicated source operation.",
        );
      }
      boundSourceOperations.add(projection.sourceOperationHash);
      const source = historyOperation(
        history,
        projection.sourceOperationHash,
      );
      if (source === undefined) {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "Persisted conflict-open provenance references an unavailable history operation.",
        );
      }
      const authorityRoot = verifiedAuthorityRootOperation(history, source);
      let effectiveCommand = source.command;
      let effectiveDiff = source.receipt.diff;
      const acceptanceCommand = source.command;
      if (acceptanceCommand.type === "accept_command_proposal") {
        effectiveCommand = verifyAcceptedProposalOperationAncestry(
          history,
          source,
        ).command;
        effectiveDiff = source.receipt.diff.filter(
          ({ entity }) => entity !== "CommandProposal",
        );
        const proposedCommand = effectiveCommand;
        if (proposedCommand.type === "propose_replan") {
          const created = effectiveDiff.filter(
            (diff) =>
              diff.entity === "ReplanProposal" &&
              diff.field === "created" &&
              diff.before === null &&
              isRecord(diff.after) &&
              diff.after.id === proposedCommand.proposal.id,
          );
          if (created.length !== 1 || !isRecord(created[0].after)) {
            throw new SyncProtocolError(
              "RECEIPT_MISMATCH",
              "Accepted Replan projection lacks its exact rebased creation.",
            );
          }
          effectiveCommand = {
            type: "propose_replan",
            proposal: clone(created[0].after) as unknown as Extract<
              V2Command,
              { type: "propose_replan" }
            >["proposal"],
          };
        }
      }
      if (
        !verifyProtectedOperationProjectionFromReceiptDiff({
          logicalKey: bundle.logicalKey,
          projection,
          command: effectiveCommand,
          commandId: source.receipt.commandId,
          authorityRootOperationHash: authorityRoot.operationHash,
          sourceOperationHash: source.operationHash,
          receiptHash: source.receipt.receiptHash,
          payloadHash: source.receipt.payloadHash,
          createdAt: source.receipt.createdAt,
          diff: effectiveDiff,
        })
      ) {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "Persisted conflict-open projection is not the exact typed receipt diff of its verified source operation.",
        );
      }
    }
  }
}

async function authorizeSyncBranchUncached(
  input: AuthorizeSyncBranchV2Input,
  session: SyncBranchAuthorizationSession,
  authorizationKey: string,
): Promise<AuthorizedSyncBranchV2> {
  if (!verifiedHistories.has(input.history as object)) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "Sync authority requires a complete verified history.",
    );
  }
  let workspace = clone(input.trustedAncestorWorkspace);
  if (
    workspace.schemaVersion !== 2 ||
    workspace.workspaceId !== input.history.workspaceId ||
    !isNonNegativeInteger(workspace.revision)
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The trusted ancestor checkpoint does not match the verified history.",
    );
  }

  if (input.ancestorOperationHash === undefined) {
    if (workspace.revision !== 0) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "Only a revision-zero checkpoint may represent the shared genesis.",
      );
    }
  } else {
    const ancestor = historyOperation(
      input.history,
      input.ancestorOperationHash,
    );
    const trustedReceipts =
      ancestor === undefined
        ? []
        : workspace.commandReceipts.filter(
            ({ commandId, status }) =>
              status === "applied" && commandId === ancestor.receipt.commandId,
          );
    if (
      ancestor === undefined ||
      workspace.revision !== ancestor.receipt.revision ||
      trustedReceipts.length !== 1 ||
      canonicalJson(trustedReceipts[0]) !== canonicalJson(ancestor.receipt)
    ) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "The trusted checkpoint does not contain the exact ancestor receipt.",
      );
    }
  }

  const head = historyOperation(input.history, input.headOperationHash);
  if (head === undefined) {
    throw new SyncProtocolError(
      "MISSING_ANCESTOR",
      "The requested branch head is absent from verified history.",
    );
  }
  const reverseBranch: VerifiedSyncReplay[] = [];
  let cursor: VerifiedSyncReplay | undefined = head;
  let reachedAncestor = input.ancestorOperationHash === undefined;
  while (cursor !== undefined) {
    if (cursor.operationHash === input.ancestorOperationHash) {
      reachedAncestor = true;
      break;
    }
    reverseBranch.push(cursor);
    if (cursor.previousOperationHash === undefined) break;
    cursor = historyOperation(input.history, cursor.previousOperationHash);
  }
  if (!reachedAncestor) {
    throw new SyncProtocolError(
      "MISSING_ANCESTOR",
      "The requested branch does not descend from the trusted checkpoint.",
    );
  }

  const authorized: AuthorizedSyncReplay[] = [];
  const workspaceAfterReplays: WorkspaceV2[] = [];
  let evaluationNow = workspace.commandReceipts.reduce<ISODate | undefined>(
    (latest, receipt) => latestEvaluationNow(latest, receipt.createdAt),
    undefined,
  );
  for (const operation of reverseBranch.reverse()) {
    if (operation.receipt.baseRevision !== workspace.revision) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "The claimed applied receipt does not follow the trusted checkpoint revision.",
      );
    }
    const receipt = operation.receipt;
    evaluationNow = latestEvaluationNow(evaluationNow, receipt.createdAt);
    const context: CommandContext = {
      commandId: receipt.commandId,
      expectedRevision: workspace.revision,
      actorId: receipt.actorId,
      actorKind: receipt.actorKind,
      origin: receipt.origin,
      source: clone(receipt.source),
      now: receipt.createdAt,
    };
    let replayCommand = clone(operation.command) as V2Command;
    const semanticLink = semanticSyncSourceLink(receipt);
    if (semanticLink !== undefined) {
      const immediateSource = historyOperation(
        input.history,
        semanticLink.operationHash,
      );
      if (immediateSource === undefined) {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "A persisted semantic replay has no verified immediate source.",
        );
      }
      const authorizedSource = new AuthorizedSyncReplayValue(
        immediateSource,
        verifiedAuthorityRootOperation(input.history, immediateSource),
      );
      let semanticReplay: AuthorizedSemanticSyncReplay;
      try {
        semanticReplay = await authorizeSemanticSyncReplayV2(
          authorizedSource,
          workspace,
        );
      } catch {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "A persisted semantic replay no longer satisfies its authority root read-set.",
        );
      }
      if (
        semanticReplay.semanticKind !== semanticLink.kind ||
        canonicalJson(semanticReplay.command) !==
          canonicalJson(operation.command)
      ) {
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "A persisted semantic replay command is not the exact authorized derivation for this branch.",
        );
      }
      replayCommand = clone(semanticReplay.command) as V2Command;
    }
    const proposalAcceptanceBinding =
      replayCommand.type === "accept_command_proposal"
        ? verifyAcceptedProposalOperationAncestry(input.history, operation)
            .binding
        : undefined;
    let authorizedConflictOpen;
    if (replayCommand.type === "open_sync_conflict") {
      try {
        await assertPersistedConflictOpenHistoryProof(
          input.history,
          operation,
          replayCommand,
        );
        const currentReplay = new AuthorizedSyncReplayValue(
          operation,
          verifiedAuthorityRootOperation(input.history, operation),
        );
        if (receipt.origin === "sync") {
          const immediateSourceHash = syncSourceOperationHash(receipt);
          const immediateSource = immediateSourceHash === undefined
            ? undefined
            : historyOperation(input.history, immediateSourceHash);
          if (
            immediateSourceHash === undefined ||
            immediateSource === undefined ||
            immediateSource.command.type !== "open_sync_conflict"
          ) {
            throw new SyncProtocolError(
              "RECEIPT_MISMATCH",
              "A propagated conflict open has no exact authorized source open.",
            );
          }
          const sourceReplay = new AuthorizedSyncReplayValue(
            immediateSource,
            verifiedAuthorityRootOperation(input.history, immediateSource),
          );
          const expectedChildAuthority =
            await authorizeConflictOpenFromVerifiedReplayV2(
              sourceReplay,
              workspace,
            );
          if (
            canonicalJson(expectedChildAuthority.command) !==
              canonicalJson(replayCommand) ||
            canonicalJson(expectedChildAuthority.context) !==
              canonicalJson(context)
          ) {
            throw new SyncProtocolError(
              "RECEIPT_MISMATCH",
              "A propagated conflict open changed its exact command or replay context.",
            );
          }
        }
        authorizedConflictOpen =
          await authorizePersistedConflictOpenFromVerifiedReplayV2(
            currentReplay,
            workspace,
          );
        if (
          canonicalJson(authorizedConflictOpen.command) !==
            canonicalJson(replayCommand) ||
          canonicalJson(authorizedConflictOpen.context) !==
            canonicalJson(context)
        ) {
          throw new SyncProtocolError(
            "RECEIPT_MISMATCH",
            "Persisted conflict-open authority changed its exact command or receipt context.",
          );
        }
      } catch (error) {
        if (
          error instanceof SyncProtocolError &&
          error.code === "BROKEN_HASH_CHAIN"
        ) {
          throw error;
        }
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "Persisted conflict-open replay does not exactly rebuild from its verified source operations.",
        );
      }
    }
    let authorizedEquivalentConflictResolution;
    if (
      replayCommand.type === "resolve_sync_conflict" &&
      receipt.origin === "sync" &&
      workspace.syncConflicts.some(
        ({ id, resolvedAt }) =>
          id === replayCommand.resolution.conflictId &&
          resolvedAt !== undefined,
      )
    ) {
      try {
        const currentReplay = new AuthorizedSyncReplayValue(
          operation,
          verifiedAuthorityRootOperation(input.history, operation),
        );
        authorizedEquivalentConflictResolution =
          authorizePersistedEquivalentConflictResolutionV2(
            currentReplay,
            workspace,
          );
        if (
          canonicalJson(authorizedEquivalentConflictResolution.command) !==
            canonicalJson(replayCommand) ||
          canonicalJson(authorizedEquivalentConflictResolution.context) !==
            canonicalJson(context)
        ) {
          throw new SyncProtocolError(
            "RECEIPT_MISMATCH",
            "Persisted equivalent resolution changed its exact command or receipt context.",
          );
        }
      } catch (error) {
        if (error instanceof SyncProtocolError) throw error;
        throw new SyncProtocolError(
          "RECEIPT_MISMATCH",
          "Persisted equivalent resolution does not match the already-retained protected value.",
        );
      }
    }
    const result = await executeCommand(
      workspace,
      replayCommand,
      context,
      {
        evaluationNow,
        ...(authorizedConflictOpen === undefined
          ? {}
          : { authorizedConflictOpen }),
        ...(authorizedEquivalentConflictResolution === undefined
          ? {}
          : { authorizedEquivalentConflictResolution }),
      },
    );
    if (
      !result.ok ||
      canonicalJson(result.receipt) !== canonicalJson(receipt)
    ) {
      throw new SyncProtocolError(
        "RECEIPT_MISMATCH",
        "The encrypted applied receipt cannot be reproduced by the domain engine.",
      );
    }
    workspace = result.workspace;
    workspaceAfterReplays.push(clone(workspace));
    authorized.push(
      new AuthorizedSyncReplayValue(
        operation,
        verifiedAuthorityRootOperation(input.history, operation),
        proposalAcceptanceBinding,
      ),
    );
  }

  return new AuthorizedSyncBranchV2Value({
    trustedAncestorWorkspace: input.trustedAncestorWorkspace,
    trustedAncestorHash: await sha256Hex(
      canonicalJson(input.trustedAncestorWorkspace),
    ),
    ancestorOperationHash: input.ancestorOperationHash,
    headOperationHash: input.headOperationHash,
    replays: authorized,
    workspaceAfterReplays,
    workspace,
    authorizationEvaluationCount: session.evaluationCount,
  });
}

export interface VerifiedSyncGenesis {
  readonly kind: "genesis";
  readonly workspaceId: Id;
  readonly revision: 0;
  readonly operationHash?: undefined;
}

export function findLatestCommonAncestorV2(
  history: VerifiedSyncHistory,
  leftHeadHash: string,
  rightHeadHash: string,
): VerifiedSyncReplay | VerifiedSyncGenesis {
  const leftHead = historyOperation(history, leftHeadHash);
  const rightHead = historyOperation(history, rightHeadHash);
  if (leftHead === undefined || rightHead === undefined) {
    throw new SyncProtocolError(
      "MISSING_ANCESTOR",
      "Common-ancestor discovery requires both branch heads.",
    );
  }
  const leftAncestors = new Set<string>();
  let current: VerifiedSyncReplay | undefined = leftHead;
  while (current !== undefined) {
    leftAncestors.add(current.operationHash);
    current =
      current.previousOperationHash === undefined
        ? undefined
        : historyOperation(history, current.previousOperationHash);
  }
  current = rightHead;
  while (current !== undefined) {
    if (leftAncestors.has(current.operationHash)) return current;
    current =
      current.previousOperationHash === undefined
        ? undefined
        : historyOperation(history, current.previousOperationHash);
  }
  return Object.freeze({
    kind: "genesis" as const,
    workspaceId: history.workspaceId,
    revision: 0 as const,
  });
}

export type ProtectedSyncRecordType =
  | "bet"
  | "daily_commitment"
  | "review"
  | "exception"
  | "close";

export interface ProtectedSyncRecordChange {
  readonly recordType: ProtectedSyncRecordType;
  readonly recordId: Id;
  readonly projectId?: Id;
  readonly changedFields: readonly string[];
}

const protectedEntityTypes: Readonly<Record<string, ProtectedSyncRecordType>> =
  Object.freeze({
    BetVersion: "bet",
    DailyCommitment: "daily_commitment",
    ReviewRecord: "review",
    ExceptionRecord: "exception",
    CloseDecision: "close",
  });

function projectIdFromDiff(diff: AuditDiff): Id | undefined {
  for (const value of [diff.after, diff.before]) {
    if (isRecord(value) && isCanonicalId(value.projectId)) {
      return value.projectId;
    }
  }
  return undefined;
}

export function classifyProtectedRecordChanges(
  diffs: readonly AuditDiff[],
): readonly ProtectedSyncRecordChange[] {
  const classified = new Map<
    string,
    {
      recordType: ProtectedSyncRecordType;
      recordId: Id;
      projectId?: Id;
      changedFields: Set<string>;
    }
  >();
  for (const diff of diffs) {
    const recordType = protectedEntityTypes[diff.entity];
    if (recordType === undefined) continue;
    const key = `${recordType}\u0000${diff.entityId}`;
    const projectId = projectIdFromDiff(diff);
    const existing = classified.get(key);
    if (existing === undefined) {
      classified.set(key, {
        recordType,
        recordId: diff.entityId,
        ...(projectId === undefined ? {} : { projectId }),
        changedFields: new Set([diff.field]),
      });
      continue;
    }
    if (
      existing.projectId !== undefined &&
      projectId !== undefined &&
      existing.projectId !== projectId
    ) {
      throw new SyncProtocolError(
        "BROKEN_HASH_CHAIN",
        "Protected-record audit diffs disagree on project identity.",
      );
    }
    if (existing.projectId === undefined && projectId !== undefined) {
      existing.projectId = projectId;
    }
    existing.changedFields.add(diff.field);
  }
  return deepFreeze(
    [...classified.values()]
      .sort(
        (left, right) =>
          compareText(left.recordType, right.recordType) ||
          compareText(left.recordId, right.recordId),
      )
      .map(({ changedFields, ...change }) => ({
        ...change,
        changedFields: [...changedFields].sort(compareText),
      })),
  );
}

export function classifyReplayProtectedRecordChanges(
  replay: VerifiedSyncReplay,
): readonly ProtectedSyncRecordChange[] {
  if (!isVerifiedSyncReplay(replay)) {
    throw new SyncProtocolError(
      "RECEIPT_REQUIRED",
      "Protected sync changes require a verified replay receipt.",
    );
  }
  return classifyProtectedRecordChanges(replay.receipt.diff);
}

export async function decryptAndVerifySyncOperationV2(
  input: DecryptAndVerifySyncOperationV2Input,
): Promise<VerifiedSyncReplay> {
  const envelope = parseSyncEnvelopeV2(input.envelope);
  if (
    (input.expectedWorkspaceId !== undefined &&
      envelope.workspaceId !== input.expectedWorkspaceId) ||
    (input.expectedDeviceId !== undefined &&
      envelope.deviceId !== input.expectedDeviceId) ||
    (input.expectedSequence !== undefined &&
      envelope.sequence !== input.expectedSequence)
  ) {
    throw new SyncProtocolError(
      "INVALID_ENVELOPE",
      "The V2 sync operation belongs to a different workspace.",
    );
  }
  const operationHash = await sha256Hex(canonicalJson(envelope));
  if (
    input.expectedOperationHash !== undefined &&
    operationHash !== input.expectedOperationHash
  ) {
    throw new SyncProtocolError(
      "OPERATION_HASH_MISMATCH",
      "The V2 sync operation hash does not match the requested immutable operation.",
    );
  }
  if (
    input.expectedPreviousOperationHash !== undefined &&
    envelope.previousOperationHash !==
      (input.expectedPreviousOperationHash === null
        ? undefined
        : input.expectedPreviousOperationHash)
  ) {
    throw new SyncProtocolError(
      "BROKEN_HASH_CHAIN",
      "The V2 sync operation does not reference the expected parent hash.",
    );
  }
  const expectedPath = syncOperationPathV2(
    envelope.workspaceId,
    envelope.deviceId,
    envelope.sequence,
    operationHash,
  );
  if (input.path !== expectedPath) {
    throw new SyncProtocolError(
      "V2_PATH_REQUIRED",
      "The V2 sync operation path does not match its immutable envelope.",
    );
  }
  let decrypted: unknown;
  try {
    decrypted = await decryptSyncPayload<unknown>(
      envelope.payload,
      input.passphrase,
    );
  } catch {
    throw new SyncProtocolError(
      "DECRYPTION_FAILED",
      "The V2 sync operation could not be decrypted.",
    );
  }
  const plaintext = parseOperationPayloadV2(decrypted);
  if (
    canonicalJson(plaintext.binding) !==
      canonicalJson(operationBindingFromEnvelope(envelope))
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The encrypted V2 operation binding does not match its immutable envelope.",
    );
  }
  const payloadHash = await commandPayloadHash(plaintext.command);
  const receipt = plaintext.receipt;
  if (
    receipt.status !== "applied" ||
    receipt.id !== receipt.commandId ||
    receipt.commandId !== envelope.commandId ||
    receipt.commandType !== plaintext.command.type ||
    receipt.baseRevision !== envelope.baseRevision ||
    receipt.revision !== envelope.revision ||
    receipt.payloadHash !== envelope.payloadHash ||
    receipt.payloadHash !== payloadHash ||
    receipt.createdAt !== envelope.createdAt
  ) {
    throw new SyncProtocolError(
      "RECEIPT_MISMATCH",
      "The V2 sync operation does not match its applied receipt.",
    );
  }
  await assertReceiptHash(receipt);
  return new VerifiedSyncReplayValue({
    envelope,
    operationHash,
    path: input.path,
    command: plaintext.command,
    receipt,
  });
}
