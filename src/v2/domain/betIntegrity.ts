import { stableHashSync } from "./stableHash";
import type {
  BetVersion,
  BetScope,
  DirectionBrief,
  JsonValue,
  ProjectV2,
  ReviewRecord,
  WorkspaceV2,
} from "./types";

export const MAX_BET_INTEGRITY_PAYLOAD_BYTES = 262_144;
export const MAX_DIRECTION_SCOPE_RECORDS = 1_024;

const BET_VERSION_KEYS = new Set([
  "id",
  "projectId",
  "version",
  "briefId",
  "briefHash",
  "briefSnapshot",
  "committedScope",
  "appetiteStart",
  "appetiteEnd",
  "actorId",
  "approvedAt",
  "supersedesId",
  "replacementReason",
  "sourceReviewId",
  "invalidatedAt",
  "invalidationReason",
]);
const REQUIRED_BET_VERSION_KEYS = [
  "id",
  "projectId",
  "version",
  "briefId",
  "briefHash",
  "briefSnapshot",
  "committedScope",
  "appetiteStart",
  "appetiteEnd",
  "actorId",
  "approvedAt",
] as const;
const OPTIONAL_BET_STRING_KEYS = [
  "supersedesId",
  "replacementReason",
  "sourceReviewId",
  "invalidatedAt",
  "invalidationReason",
] as const;
const DIRECTION_BRIEF_KEYS = new Set([
  "id",
  "projectId",
  "version",
  "audienceAndProblem",
  "successEvidence",
  "appetiteSeconds",
  "validationMethod",
  "firstScope",
  "noGoOrKill",
  "advancedNotes",
  "createdAt",
  "updatedAt",
]);
const REQUIRED_DIRECTION_BRIEF_KEYS = [...DIRECTION_BRIEF_KEYS];
const DIRECTION_STRING_KEYS = [
  "id",
  "projectId",
  "audienceAndProblem",
  "successEvidence",
  "validationMethod",
  "noGoOrKill",
  "advancedNotes",
  "createdAt",
  "updatedAt",
] as const;
const BET_SCOPE_KEYS = new Set(["id", "title", "description"]);
const REQUIRED_BET_SCOPE_KEYS = [...BET_SCOPE_KEYS];
const BET_SCOPE_STRING_KEYS = ["id", "title", "description"] as const;

type PlainDataRecord = Record<string, unknown>;

class JsonPayloadBudget {
  private usedBytes = 0;

  consumeStructuralBytes(bytes: number): boolean {
    if (bytes > MAX_BET_INTEGRITY_PAYLOAD_BYTES - this.usedBytes) {
      return false;
    }
    this.usedBytes += bytes;
    return true;
  }

  consumeJsonString(value: string): boolean {
    if (!this.consumeStructuralBytes(2)) return false;
    for (let index = 0; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      let bytes: number;
      if (codeUnit === 0x22 || codeUnit === 0x5c) {
        bytes = 2;
      } else if (
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
      ) {
        bytes = 2;
      } else if (codeUnit <= 0x1f) {
        bytes = 6;
      } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes = 4;
          index += 1;
        } else {
          bytes = 6;
        }
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        bytes = 6;
      } else if (codeUnit <= 0x7f) {
        bytes = 1;
      } else if (codeUnit <= 0x7ff) {
        bytes = 2;
      } else {
        bytes = 3;
      }
      if (!this.consumeStructuralBytes(bytes)) return false;
    }
    return true;
  }

  consumePropertyName(name: string): boolean {
    // The extra comma for the final property is a safe one-byte overestimate.
    return this.consumeJsonString(name) && this.consumeStructuralBytes(2);
  }

  consumeNumber(value: number): boolean {
    return this.consumeStructuralBytes(String(value).length);
  }
}

type ExactRecordResult =
  | { ok: true; record: PlainDataRecord }
  | { ok: false; issue: string };

type ExactArrayResult =
  | { ok: true; values: unknown[] }
  | { ok: false; issue: string };

function exactDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  label: string,
): ExactRecordResult {
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    return { ok: false, issue: `${label} is not a plain data record.` };
  }
  if (value === null || typeof value !== "object" || isArray) {
    return { ok: false, issue: `${label} is not a plain data record.` };
  }
  const record = value as PlainDataRecord;
  const snapshot: PlainDataRecord = {};
  try {
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, issue: `${label} is not a plain data record.` };
    }
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== "string" || !allowedKeys.has(key)) {
        return { ok: false, issue: `${label} contains an unknown own field.` };
      }
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return {
          ok: false,
          issue: `${label} fields must be enumerable own data properties.`,
        };
      }
      snapshot[key] = descriptor.value;
    }
    for (const key of requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) {
        return { ok: false, issue: `${label} is missing required field ${key}.` };
      }
    }
  } catch {
    return {
      ok: false,
      issue: `${label} fields must be enumerable own data properties.`,
    };
  }
  return { ok: true, record: snapshot };
}

function exactDenseDataArray(value: unknown, label: string): ExactArrayResult {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return { ok: false, issue: `${label} is not a plain dense data array.` };
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > MAX_DIRECTION_SCOPE_RECORDS
    ) {
      return { ok: false, issue: payloadLimitIssue(label) };
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    const allowedKeys = new Set<string>(["length"]);
    for (let index = 0; index < length; index += 1) {
      allowedKeys.add(String(index));
    }
    if (
      keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
    ) {
      return { ok: false, issue: `${label} contains an unknown own field.` };
    }
    if (keys.length !== length + 1 || !keys.includes("length")) {
      return { ok: false, issue: `${label} must be a dense data array.` };
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (!keys.includes(key)) {
        return { ok: false, issue: `${label} must be a dense data array.` };
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return {
          ok: false,
          issue: `${label} entries must be enumerable own data properties.`,
        };
      }
      values.push(descriptor.value);
    }
    return { ok: true, values };
  } catch {
    return {
      ok: false,
      issue: `${label} must be a plain dense array of own data properties.`,
    };
  }
}

function payloadLimitIssue(label: string): string {
  return `${label} exceeds the safe synchronous verification limit.`;
}

function consumeStringProperty(
  record: PlainDataRecord,
  key: string,
  budget: JsonPayloadBudget,
  label: string,
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return `${label} field ${key} must be text.`;
  }
  return budget.consumePropertyName(key) && budget.consumeJsonString(value)
    ? undefined
    : payloadLimitIssue(label);
}

type ScopeValidationResult =
  | { ok: true; scopes: BetScope[] }
  | { ok: false; issue: string };

function validateScopePayload(
  value: unknown,
  label: string,
  budget: JsonPayloadBudget,
): ScopeValidationResult {
  const exactArray = exactDenseDataArray(value, label);
  if (!exactArray.ok) return exactArray;
  if (!budget.consumeStructuralBytes(2)) {
    return { ok: false, issue: payloadLimitIssue(label) };
  }
  const scopes: BetScope[] = [];
  for (const candidate of exactArray.values) {
    if (!budget.consumeStructuralBytes(1)) {
      return { ok: false, issue: payloadLimitIssue(label) };
    }
    const exact = exactDataRecord(
      candidate,
      BET_SCOPE_KEYS,
      REQUIRED_BET_SCOPE_KEYS,
      `${label} scope record`,
    );
    if (!exact.ok) return exact;
    if (!budget.consumeStructuralBytes(2)) {
      return { ok: false, issue: payloadLimitIssue(label) };
    }
    for (const key of BET_SCOPE_STRING_KEYS) {
      const issue = consumeStringProperty(exact.record, key, budget, label);
      if (issue !== undefined) return { ok: false, issue };
    }
    scopes.push({
      id: exact.record.id as string,
      title: exact.record.title as string,
      description: exact.record.description as string,
    });
  }
  return { ok: true, scopes };
}

type DirectionValidationResult =
  | { ok: true; snapshot: DirectionBrief }
  | { ok: false; issue: string };

function canonicalTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function validateDirectionSnapshot(
  brief: unknown,
  approvedAt?: string,
  budget = new JsonPayloadBudget(),
): DirectionValidationResult {
  const exact = exactDataRecord(
    brief,
    DIRECTION_BRIEF_KEYS,
    REQUIRED_DIRECTION_BRIEF_KEYS,
    "Direction snapshot",
  );
  if (!exact.ok) return exact;
  if (!budget.consumeStructuralBytes(2)) {
    return { ok: false, issue: payloadLimitIssue("Direction snapshot") };
  }
  for (const key of DIRECTION_STRING_KEYS) {
    const issue = consumeStringProperty(
      exact.record,
      key,
      budget,
      "Direction snapshot",
    );
    if (issue !== undefined) return { ok: false, issue };
  }
  const version = exact.record.version;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) {
    return {
      ok: false,
      issue: "Direction snapshot version must be a positive whole number.",
    };
  }
  if (
    !budget.consumePropertyName("version") ||
    !budget.consumeNumber(version as number)
  ) {
    return { ok: false, issue: payloadLimitIssue("Direction snapshot") };
  }
  const appetiteSeconds = exact.record.appetiteSeconds;
  if (!Number.isSafeInteger(appetiteSeconds)) {
    return {
      ok: false,
      issue: "Direction snapshot appetite must be a whole number of seconds.",
    };
  }
  if (
    !budget.consumePropertyName("appetiteSeconds") ||
    !budget.consumeNumber(appetiteSeconds as number) ||
    !budget.consumePropertyName("firstScope")
  ) {
    return { ok: false, issue: payloadLimitIssue("Direction snapshot") };
  }
  const scope = validateScopePayload(
    exact.record.firstScope,
    "Direction snapshot scope",
    budget,
  );
  if (!scope.ok) return scope;
  const createdAtValue = exact.record.createdAt as string;
  const updatedAtValue = exact.record.updatedAt as string;
  const createdAt = canonicalTimestamp(createdAtValue);
  const updatedAt = canonicalTimestamp(updatedAtValue);
  const approval = approvedAt === undefined
    ? undefined
    : canonicalTimestamp(approvedAt);
  if (
    createdAt === undefined ||
    updatedAt === undefined ||
    createdAt > updatedAt ||
    (approvedAt !== undefined &&
      (approval === undefined || updatedAt > approval))
  ) {
    return {
      ok: false,
      issue: "Direction snapshot chronology must be canonical and ordered creation <= update <= approval.",
    };
  }
  return {
    ok: true,
    snapshot: {
      id: exact.record.id as string,
      projectId: exact.record.projectId as string,
      version: version as number,
      audienceAndProblem: exact.record.audienceAndProblem as string,
      successEvidence: exact.record.successEvidence as string,
      appetiteSeconds: appetiteSeconds as number,
      validationMethod: exact.record.validationMethod as string,
      firstScope: scope.scopes,
      noGoOrKill: exact.record.noGoOrKill as string,
      advancedNotes: exact.record.advancedNotes as string,
      createdAt: createdAtValue,
      updatedAt: updatedAtValue,
    },
  };
}

export function directionSnapshotIntegrityIssue(
  brief: DirectionBrief,
  approvedAt?: string,
): string | undefined {
  const validation = validateDirectionSnapshot(brief, approvedAt);
  return validation.ok ? undefined : validation.issue;
}

function scopesAreEqual(left: BetScope[], right: BetScope[]): boolean {
  return left.length === right.length && left.every((scope, index) => {
    const candidate = right[index];
    return candidate !== undefined &&
      scope.id === candidate.id &&
      scope.title === candidate.title &&
      scope.description === candidate.description;
  });
}

/**
 * Synchronous integrity checks for every field that can change executable
 * scope or time. Cryptographic snapshot provenance remains in briefHash, while
 * scheduling must never trust a Bet whose duplicated authoritative fields
 * disagree with its immutable Direction snapshot.
 */
export function betStaticIntegrityIssue(bet: BetVersion): string | undefined {
  const exact = exactDataRecord(
    bet,
    BET_VERSION_KEYS,
    REQUIRED_BET_VERSION_KEYS,
    "Bet",
  );
  const betId = exact.ok && typeof exact.record.id === "string"
    ? exact.record.id
    : "unknown";
  if (!exact.ok) return `Bet integrity failed for ${betId}: ${exact.issue}`;
  const budget = new JsonPayloadBudget();
  if (!budget.consumeStructuralBytes(2)) {
    return `Bet integrity failed for ${betId}: ${payloadLimitIssue("Bet")}`;
  }
  const requiredStringKeys = [
    "id",
    "projectId",
    "briefId",
    "briefHash",
    "appetiteStart",
    "appetiteEnd",
    "actorId",
    "approvedAt",
  ] as const;
  for (const key of requiredStringKeys) {
    const issue = consumeStringProperty(exact.record, key, budget, "Bet");
    if (issue !== undefined) {
      return `Bet integrity failed for ${betId}: ${issue}`;
    }
  }
  for (const key of OPTIONAL_BET_STRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(exact.record, key)) continue;
    const issue = consumeStringProperty(exact.record, key, budget, "Bet");
    if (issue !== undefined) {
      return `Bet integrity failed for ${betId}: ${issue}`;
    }
  }
  const version = exact.record.version;
  if (!Number.isSafeInteger(version) || (version as number) <= 0) {
    return `Bet integrity failed for ${betId}: Bet version must be a positive whole number.`;
  }
  if (
    !budget.consumePropertyName("version") ||
    !budget.consumeNumber(version as number) ||
    !budget.consumePropertyName("briefSnapshot")
  ) {
    return `Bet integrity failed for ${betId}: ${payloadLimitIssue("Bet")}`;
  }
  const direction = validateDirectionSnapshot(
    exact.record.briefSnapshot,
    exact.record.approvedAt as string,
    budget,
  );
  if (!direction.ok) {
    return `Bet integrity failed for ${betId}: ${direction.issue}`;
  }
  if (!budget.consumePropertyName("committedScope")) {
    return `Bet integrity failed for ${betId}: ${payloadLimitIssue("Bet")}`;
  }
  const committedScope = validateScopePayload(
    exact.record.committedScope,
    "Committed Bet scope",
    budget,
  );
  if (!committedScope.ok) {
    return `Bet integrity failed for ${betId}: ${committedScope.issue}`;
  }

  const isReplacement = exact.record.supersedesId !== undefined;
  const replacementReasonIsValid =
    exact.record.replacementReason === "material_direction_change" ||
    exact.record.replacementReason === "appetite_expiry";
  if (!isReplacement) {
    if (
      exact.record.replacementReason !== undefined ||
      exact.record.sourceReviewId !== undefined
    ) {
      return `Bet integrity failed for ${betId}: an initial Bet cannot claim replacement provenance.`;
    }
  } else if (!replacementReasonIsValid) {
    return `Bet integrity failed for ${betId}: every replacement Bet requires an explicit replacement reason.`;
  } else if (
    exact.record.replacementReason === "appetite_expiry" &&
    exact.record.sourceReviewId === undefined
  ) {
    return `Bet integrity failed for ${betId}: appetite expiry replacement requires its source Review.`;
  } else if (
    exact.record.replacementReason === "material_direction_change" &&
    exact.record.sourceReviewId !== undefined
  ) {
    return `Bet integrity failed for ${betId}: material Direction replacement cannot claim an expiry source Review.`;
  }
  if (
    exact.record.projectId !== direction.snapshot.projectId ||
    exact.record.briefId !== direction.snapshot.id
  ) {
    return `Bet integrity failed for ${betId}: snapshot ownership does not match the Bet.`;
  }
  if (!scopesAreEqual(committedScope.scopes, direction.snapshot.firstScope)) {
    return `Bet integrity failed for ${betId}: committed scope differs from the approved Direction snapshot.`;
  }
  const briefHash = exact.record.briefHash as string;
  if (!/^[0-9a-f]{64}$/.test(briefHash)) {
    return `Bet integrity failed for ${betId}: Direction snapshot hash is not canonical SHA-256.`;
  }
  if (
    briefHash !== stableHashSync(direction.snapshot as unknown as JsonValue)
  ) {
    return `Bet integrity failed for ${betId}: Direction snapshot hash does not match its immutable approval.`;
  }
  const approvedAtValue = exact.record.approvedAt as string;
  const appetiteStartValue = exact.record.appetiteStart as string;
  const approvedAt = canonicalTimestamp(approvedAtValue);
  const appetiteStart = canonicalTimestamp(appetiteStartValue);
  if (
    approvedAt === undefined ||
    appetiteStart === undefined ||
    appetiteStartValue !== approvedAtValue
  ) {
    return `Bet integrity failed for ${betId}: appetite start is not the canonical human approval time.`;
  }
  if (
    !Number.isSafeInteger(direction.snapshot.appetiteSeconds) ||
    direction.snapshot.appetiteSeconds <= 0
  ) {
    return `Bet integrity failed for ${betId}: the approved appetite is not a positive whole number of seconds.`;
  }
  const expectedEnd = approvedAt + direction.snapshot.appetiteSeconds * 1_000;
  const appetiteEndValue = exact.record.appetiteEnd as string;
  const appetiteEnd = canonicalTimestamp(appetiteEndValue);
  if (
    appetiteEnd === undefined ||
    !Number.isFinite(expectedEnd) ||
    Math.abs(expectedEnd) > 8.64e15 ||
    appetiteEndValue !== new Date(expectedEnd).toISOString()
  ) {
    return `Bet integrity failed for ${betId}: appetite end differs from the exact approved appetite.`;
  }
  return undefined;
}

export function betTemporalIntegrityIssue(
  bet: BetVersion,
  evaluatedAt?: string,
): string | undefined {
  if (evaluatedAt === undefined) return undefined;
  const evaluation = canonicalTimestamp(evaluatedAt);
  if (evaluation === undefined) {
    return `Bet integrity failed for ${bet.id}: evaluation time is not canonical.`;
  }
  const approvedAt = canonicalTimestamp(bet.approvedAt);
  if (approvedAt === undefined) {
    return `Bet integrity failed for ${bet.id}: human approval time is not canonical.`;
  }
  return approvedAt > evaluation
    ? `Bet integrity failed for ${bet.id}: human approval is future-dated.`
    : undefined;
}

export function betIntegrityIssue(
  bet: BetVersion,
  evaluatedAt?: string,
): string | undefined {
  return betStaticIntegrityIssue(bet) ??
    betTemporalIntegrityIssue(bet, evaluatedAt);
}

function betIntegrityIssueFromStaticResults(
  bet: BetVersion,
  evaluatedAt: string | undefined,
  staticIssues?: ReadonlyMap<BetVersion, string | undefined>,
): string | undefined {
  const staticIssue = staticIssues?.has(bet)
    ? staticIssues.get(bet)
    : betStaticIntegrityIssue(bet);
  return staticIssue ?? betTemporalIntegrityIssue(bet, evaluatedAt);
}

export function betIsInternallyConsistent(
  bet: BetVersion,
  evaluatedAt?: string,
): boolean {
  return betIntegrityIssue(bet, evaluatedAt) === undefined;
}

export type ExpiryRebetReviewSelection =
  | { ok: true; review: ReviewRecord }
  | { ok: false; reason: string };

function expiryReviewFailure(detail: string): ExpiryRebetReviewSelection {
  return {
    ok: false,
    reason: `A unique completed expiry Review with a Re-bet decision is required. ${detail}`,
  };
}

function canonicalUniqueStrings(
  values: string[],
  requireNonEmpty: boolean,
): boolean {
  return (
    (!requireNonEmpty || values.length > 0) &&
    values.every((value) => value.length > 0 && value === value.trim()) &&
    new Set(values).size === values.length
  );
}

function selectCompletedExpiryReviewForBet(
  workspace: WorkspaceV2,
  projectId: string,
  bet: BetVersion,
  now: string,
  staticIssues?: ReadonlyMap<BetVersion, string | undefined>,
): ExpiryRebetReviewSelection {
  const integrityIssue = betIntegrityIssueFromStaticResults(
    bet,
    now,
    staticIssues,
  );
  if (integrityIssue !== undefined) {
    return expiryReviewFailure(integrityIssue);
  }
  if (bet.projectId !== projectId) {
    return expiryReviewFailure("The Project and Bet ownership is ambiguous.");
  }
  const evaluatedAt = canonicalTimestamp(now);
  const appetiteEnd = canonicalTimestamp(bet.appetiteEnd);
  if (
    evaluatedAt === undefined ||
    appetiteEnd === undefined ||
    evaluatedAt < appetiteEnd
  ) {
    return expiryReviewFailure("The exact appetite boundary has not been reached safely.");
  }

  const expectedTriggerKey = `${bet.id}:expired`;
  const expectedReviewId = `review:${expectedTriggerKey}`;
  const matches = workspace.reviews.filter(
    (review) =>
      review.id === expectedReviewId ||
      review.triggerKey === expectedTriggerKey,
  );
  if (matches.length !== 1) {
    return expiryReviewFailure("The deterministic expiry occurrence is missing or duplicated.");
  }

  const review = matches[0];
  const createdAt = canonicalTimestamp(review.createdAt);
  const dueAt = canonicalTimestamp(review.dueAt);
  const completedAt = review.conclusion === undefined
    ? undefined
    : canonicalTimestamp(review.conclusion.completedAt);
  const overdueMarkedAt = review.overdueMarkedAt === undefined
    ? undefined
    : canonicalTimestamp(review.overdueMarkedAt);
  const exactIdentity =
    review.id === expectedReviewId &&
    review.kind === "event" &&
    review.triggerKey === expectedTriggerKey &&
    review.triggerType === "bet_expired";
  const exactAffectedRecords =
    review.affectedProjectIds.length === 1 &&
    review.affectedProjectIds[0] === projectId &&
    review.affectedRecordIds.length === 1 &&
    review.affectedRecordIds[0] === bet.id;
  const canonicalTiming =
    review.dueAt === bet.appetiteEnd &&
    dueAt === appetiteEnd &&
    createdAt !== undefined &&
    createdAt >= appetiteEnd &&
    createdAt <= evaluatedAt &&
    completedAt !== undefined &&
    completedAt >= createdAt &&
    completedAt <= evaluatedAt &&
    (review.overdueMarkedAt === undefined ||
      (overdueMarkedAt !== undefined &&
        overdueMarkedAt >= appetiteEnd &&
        overdueMarkedAt >= createdAt &&
        overdueMarkedAt <= completedAt));
  const conclusion = review.conclusion;
  const canonicalConclusion =
    review.status === "completed" &&
    conclusion !== undefined &&
    conclusion.summary.length > 0 &&
    conclusion.summary === conclusion.summary.trim() &&
    conclusion.actorId.length > 0 &&
    conclusion.actorId === conclusion.actorId.trim() &&
    canonicalUniqueStrings(conclusion.decisionCodes, true) &&
    conclusion.decisionCodes.includes("rebet") &&
    canonicalUniqueStrings(conclusion.followUpCommandIds, false);
  if (
    !exactIdentity ||
    review.cadenceTimeZone !== undefined ||
    !exactAffectedRecords ||
    !canonicalTiming ||
    !canonicalConclusion
  ) {
    return expiryReviewFailure("The stored expiry conclusion or its provenance is invalid.");
  }

  return { ok: true, review };
}

/**
 * Selects the human Review that authorizes replacing an uninvalidated Bet
 * after its exact appetite boundary. The deterministic trigger identity and
 * exact affected records make the provenance safe to persist on the new Bet.
 */
export function selectCompletedExpiryRebetReview(
  workspace: WorkspaceV2,
  project: ProjectV2,
  bet: BetVersion,
  now: string,
): ExpiryRebetReviewSelection {
  if (bet.projectId !== project.id || project.activeBetId !== bet.id) {
    return expiryReviewFailure("The active Project and Bet ownership is ambiguous.");
  }
  if (bet.invalidatedAt !== undefined) {
    return expiryReviewFailure("The active Bet was invalidated by another boundary.");
  }
  return selectCompletedExpiryReviewForBet(
    workspace,
    project.id,
    bet,
    now,
  );
}

export function betReplacementProvenanceIssue(
  workspace: WorkspaceV2,
  bet: BetVersion,
  staticIssues?: ReadonlyMap<BetVersion, string | undefined>,
): string | undefined {
  const successorIssue = betIntegrityIssueFromStaticResults(
    bet,
    bet.approvedAt,
    staticIssues,
  );
  if (successorIssue !== undefined) return successorIssue;
  if (bet.supersedesId === undefined) {
    return undefined;
  }
  const predecessors = workspace.bets.filter(
    (candidate) =>
      candidate.id === bet.supersedesId && candidate.projectId === bet.projectId,
  );
  if (predecessors.length !== 1) {
    return `Bet ${bet.id} does not resolve to one same-Project predecessor.`;
  }
  const predecessor = predecessors[0];
  const predecessorIssue = betIntegrityIssueFromStaticResults(
    predecessor,
    bet.approvedAt,
    staticIssues,
  );
  if (predecessorIssue !== undefined) return predecessorIssue;
  if (bet.replacementReason === "material_direction_change") {
    const invalidatedAt = predecessor.invalidatedAt === undefined
      ? undefined
      : canonicalTimestamp(predecessor.invalidatedAt);
    const appetiteEnd = canonicalTimestamp(predecessor.appetiteEnd);
    const approvedAt = canonicalTimestamp(bet.approvedAt);
    const exactMaterialDirectionBoundary =
      invalidatedAt !== undefined &&
      appetiteEnd !== undefined &&
      approvedAt !== undefined &&
      invalidatedAt < appetiteEnd &&
      invalidatedAt <= approvedAt &&
      predecessor.invalidationReason ===
        "Material Direction change requires Re-bet." &&
      predecessor.briefId !== bet.briefId &&
      bet.briefSnapshot.createdAt === predecessor.invalidatedAt &&
      bet.briefSnapshot.updatedAt === predecessor.invalidatedAt;
    return exactMaterialDirectionBoundary
      ? undefined
      : `Bet ${bet.id} does not resolve to an exact pre-expiry material Direction replacement boundary.`;
  }
  if (bet.replacementReason !== "appetite_expiry") {
    return `Bet ${bet.id} has an invalid replacement reason.`;
  }
  const replacedAtApproval =
    predecessor.invalidatedAt === bet.approvedAt &&
    predecessor.invalidationReason === `Superseded by Re-bet ${bet.id}.`;
  const expiryReplacement =
    replacedAtApproval &&
    canonicalTimestamp(predecessor.appetiteEnd) !== undefined &&
    Date.parse(predecessor.appetiteEnd) <= Date.parse(bet.approvedAt);
  if (!expiryReplacement) {
    return `Bet ${bet.id} claims an expiry source Review without an exact expiry replacement boundary.`;
  }
  const selection = selectCompletedExpiryReviewForBet(
    workspace,
    bet.projectId,
    predecessor,
    bet.approvedAt,
    staticIssues,
  );
  if (!selection.ok) return selection.reason;
  if (selection.review.id !== bet.sourceReviewId) {
    return `Bet ${bet.id} source Review does not match its predecessor expiry occurrence.`;
  }
  return undefined;
}
