import type { WorkspaceV2 } from "../domain/types";

export class WorkspaceBackupSchemaError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "WorkspaceBackupSchemaError";
  }
}

type UnknownRecord = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new WorkspaceBackupSchemaError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype) {
    fail(path, "expected a plain JSON object");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail(path, "expected only string-keyed JSON fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail(`${path}.${key}`, "expected an enumerable data field");
    }
  }
  return value as UnknownRecord;
}

function objectShape(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const candidate = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
      fail(`${path}.${key}`, "missing required field");
    }
  }
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string") {
      fail(path, "expected only string-keyed JSON fields");
    }
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail(`${path}.${key}`, "expected an enumerable data field");
    }
    if (!allowed.has(key)) fail(`${path}.${key}`, "unknown field");
  }
  return candidate;
}

function hasOwn(value: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function stringValue(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(path, "expected a string");
}

function canonicalIso(value: unknown, path: string): asserts value is string {
  stringValue(value, path);
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    fail(path, "expected a canonical ISO timestamp");
  }
}

function safeFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    fail(path, "expected a safe finite number");
  }
}

function safeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(path, "expected a safe integer");
  }
}

function nonNegativeSafeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  safeInteger(value, path);
  if (value < 0) fail(path, "expected a nonnegative safe integer");
}

function nonNegativeFiniteNumber(
  value: unknown,
  path: string,
): asserts value is number {
  safeFiniteNumber(value, path);
  if (value < 0) fail(path, "expected a nonnegative finite number");
}

function positiveSafeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  safeInteger(value, path);
  if (value <= 0) fail(path, "expected a positive safe integer");
}

function booleanValue(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    fail(path, "expected a plain JSON array");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== value.length + 1 || !ownKeys.includes("length")) {
    fail(path, "expected a dense array");
  }
  for (const key of ownKeys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      fail(path, "expected only array indexes");
    }
    const index = Number(key);
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= value.length ||
      String(index) !== key
    ) {
      fail(path, "expected only array indexes");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      fail(path, "expected enumerable array data entries");
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(path, "expected a dense array");
    }
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    fail(path, `expected one of ${options.join(", ")}`);
  }
}

function stringArray(value: unknown, path: string): void {
  arrayValue(value, path).forEach((item, index) =>
    stringValue(item, `${path}[${index}]`),
  );
}

function inboxItem(value: unknown, path: string): void {
  const item = objectShape(
    value,
    path,
    ["id", "originalText", "sourceId", "actorId", "capturedAt", "triageStatus"],
    ["desiredDate", "recommendation", "actionId", "projectId"],
  );
  stringValue(item.id, `${path}.id`);
  stringValue(item.originalText, `${path}.originalText`);
  stringValue(item.sourceId, `${path}.sourceId`);
  stringValue(item.actorId, `${path}.actorId`);
  canonicalIso(item.capturedAt, `${path}.capturedAt`);
  if (hasOwn(item, "desiredDate")) {
    stringValue(item.desiredDate, `${path}.desiredDate`);
  }
  if (hasOwn(item, "recommendation")) {
    const recommendationPath = `${path}.recommendation`;
    const recommendation = objectShape(
      item.recommendation,
      recommendationPath,
      ["kind", "ruleCodes", "explanation"],
    );
    enumValue(recommendation.kind, `${recommendationPath}.kind`, [
      "action",
      "project",
    ]);
    stringArray(recommendation.ruleCodes, `${recommendationPath}.ruleCodes`);
    stringValue(
      recommendation.explanation,
      `${recommendationPath}.explanation`,
    );
  }
  enumValue(item.triageStatus, `${path}.triageStatus`, [
    "untriaged",
    "action",
    "project",
  ]);
  if (hasOwn(item, "actionId")) stringValue(item.actionId, `${path}.actionId`);
  if (hasOwn(item, "projectId")) {
    stringValue(item.projectId, `${path}.projectId`);
  }
}

function actionEligibility(value: unknown, path: string): void {
  const eligibility = objectShape(value, path, [
    "singleSession",
    "estimateSeconds",
    "dependencyIds",
    "requiresMilestoneEvidence",
    "outcomeCount",
    "solutionKnown",
  ]);
  booleanValue(eligibility.singleSession, `${path}.singleSession`);
  safeFiniteNumber(eligibility.estimateSeconds, `${path}.estimateSeconds`);
  stringArray(eligibility.dependencyIds, `${path}.dependencyIds`);
  booleanValue(
    eligibility.requiresMilestoneEvidence,
    `${path}.requiresMilestoneEvidence`,
  );
  safeFiniteNumber(eligibility.outcomeCount, `${path}.outcomeCount`);
  booleanValue(eligibility.solutionKnown, `${path}.solutionKnown`);
}

function action(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    [
      "id",
      "inboxItemId",
      "title",
      "revision",
      "status",
      "eligibility",
      "attention",
      "createdAt",
      "updatedAt",
    ],
    [
      "desiredDate",
      "fixedStart",
      "resultStatus",
      "outcomeNote",
      "promotedProjectId",
    ],
  );
  stringValue(candidate.id, `${path}.id`);
  stringValue(candidate.inboxItemId, `${path}.inboxItemId`);
  stringValue(candidate.title, `${path}.title`);
  positiveSafeInteger(candidate.revision, `${path}.revision`);
  enumValue(candidate.status, `${path}.status`, [
    "open",
    "completed",
    "promoted",
  ]);
  actionEligibility(candidate.eligibility, `${path}.eligibility`);
  enumValue(candidate.attention, `${path}.attention`, [
    "deep",
    "medium",
    "shallow",
  ]);
  if (hasOwn(candidate, "desiredDate")) {
    stringValue(candidate.desiredDate, `${path}.desiredDate`);
  }
  if (hasOwn(candidate, "fixedStart")) {
    stringValue(candidate.fixedStart, `${path}.fixedStart`);
  }
  if (hasOwn(candidate, "resultStatus")) {
    enumValue(candidate.resultStatus, `${path}.resultStatus`, [
      "completed",
      "learned",
      "blocked",
    ]);
  }
  if (hasOwn(candidate, "outcomeNote")) {
    stringValue(candidate.outcomeNote, `${path}.outcomeNote`);
  }
  if (hasOwn(candidate, "promotedProjectId")) {
    stringValue(candidate.promotedProjectId, `${path}.promotedProjectId`);
  }
  canonicalIso(candidate.createdAt, `${path}.createdAt`);
  canonicalIso(candidate.updatedAt, `${path}.updatedAt`);
}

function projectHold(value: unknown, path: string): void {
  const hold = objectShape(value, path, [
    "type",
    "sourceId",
    "affectedRecordIds",
    "createdAt",
  ]);
  enumValue(hold.type, `${path}.type`, [
    "migration_review",
    "rebet_required",
    "review_overdue",
    "sync_conflict",
  ]);
  stringValue(hold.sourceId, `${path}.sourceId`);
  stringArray(hold.affectedRecordIds, `${path}.affectedRecordIds`);
  canonicalIso(hold.createdAt, `${path}.createdAt`);
}

function project(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    [
      "id",
      "name",
      "priority",
      "notes",
      "stage",
      "holds",
      "activeDirectionBriefId",
      "createdAt",
      "updatedAt",
    ],
    ["activeBetId", "activePlanVersionId", "legacyClosure"],
  );
  stringValue(candidate.id, `${path}.id`);
  stringValue(candidate.name, `${path}.name`);
  safeFiniteNumber(candidate.priority, `${path}.priority`);
  stringValue(candidate.notes, `${path}.notes`);
  enumValue(candidate.stage, `${path}.stage`, [
    "direction",
    "awaiting_bet",
    "planning",
    "executing",
    "validating",
    "closing",
    "closed",
  ]);
  arrayValue(candidate.holds, `${path}.holds`).forEach((hold, index) =>
    projectHold(hold, `${path}.holds[${index}]`),
  );
  stringValue(
    candidate.activeDirectionBriefId,
    `${path}.activeDirectionBriefId`,
  );
  if (hasOwn(candidate, "activeBetId")) {
    stringValue(candidate.activeBetId, `${path}.activeBetId`);
  }
  if (hasOwn(candidate, "activePlanVersionId")) {
    stringValue(candidate.activePlanVersionId, `${path}.activePlanVersionId`);
  }
  if (hasOwn(candidate, "legacyClosure")) {
    const closurePath = `${path}.legacyClosure`;
    const closure = objectShape(candidate.legacyClosure, closurePath, [
      "sourceStatus",
      "legacyRecordId",
      "sourceChecksum",
    ]);
    enumValue(closure.sourceStatus, `${closurePath}.sourceStatus`, [
      "done",
      "archived",
    ]);
    stringValue(closure.legacyRecordId, `${closurePath}.legacyRecordId`);
    stringValue(closure.sourceChecksum, `${closurePath}.sourceChecksum`);
  }
  canonicalIso(candidate.createdAt, `${path}.createdAt`);
  canonicalIso(candidate.updatedAt, `${path}.updatedAt`);
}

function betScope(value: unknown, path: string): void {
  const scope = objectShape(value, path, ["id", "title", "description"]);
  stringValue(scope.id, `${path}.id`);
  stringValue(scope.title, `${path}.title`);
  stringValue(scope.description, `${path}.description`);
}

function directionBrief(value: unknown, path: string, stored: boolean): void {
  const required = [
    "id",
    "projectId",
    ...(stored ? ["version"] : []),
    "audienceAndProblem",
    "successEvidence",
    "appetiteSeconds",
    "validationMethod",
    "firstScope",
    "noGoOrKill",
    "advancedNotes",
    ...(stored ? ["createdAt", "updatedAt"] : []),
  ];
  const brief = objectShape(value, path, required);
  stringValue(brief.id, `${path}.id`);
  stringValue(brief.projectId, `${path}.projectId`);
  if (stored) positiveSafeInteger(brief.version, `${path}.version`);
  stringValue(brief.audienceAndProblem, `${path}.audienceAndProblem`);
  stringValue(brief.successEvidence, `${path}.successEvidence`);
  safeFiniteNumber(brief.appetiteSeconds, `${path}.appetiteSeconds`);
  stringValue(brief.validationMethod, `${path}.validationMethod`);
  arrayValue(brief.firstScope, `${path}.firstScope`).forEach((scope, index) =>
    betScope(scope, `${path}.firstScope[${index}]`),
  );
  stringValue(brief.noGoOrKill, `${path}.noGoOrKill`);
  stringValue(brief.advancedNotes, `${path}.advancedNotes`);
  if (stored) {
    canonicalIso(brief.createdAt, `${path}.createdAt`);
    canonicalIso(brief.updatedAt, `${path}.updatedAt`);
  }
}

function betVersion(value: unknown, path: string): void {
  const bet = objectShape(
    value,
    path,
    [
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
    ],
    ["supersedesId", "sourceReviewId", "invalidatedAt", "invalidationReason"],
  );
  stringValue(bet.id, `${path}.id`);
  stringValue(bet.projectId, `${path}.projectId`);
  positiveSafeInteger(bet.version, `${path}.version`);
  stringValue(bet.briefId, `${path}.briefId`);
  stringValue(bet.briefHash, `${path}.briefHash`);
  directionBrief(bet.briefSnapshot, `${path}.briefSnapshot`, true);
  arrayValue(bet.committedScope, `${path}.committedScope`).forEach(
    (scope, index) => betScope(scope, `${path}.committedScope[${index}]`),
  );
  canonicalIso(bet.appetiteStart, `${path}.appetiteStart`);
  canonicalIso(bet.appetiteEnd, `${path}.appetiteEnd`);
  stringValue(bet.actorId, `${path}.actorId`);
  canonicalIso(bet.approvedAt, `${path}.approvedAt`);
  if (hasOwn(bet, "supersedesId")) {
    stringValue(bet.supersedesId, `${path}.supersedesId`);
  }
  if (hasOwn(bet, "sourceReviewId")) {
    stringValue(bet.sourceReviewId, `${path}.sourceReviewId`);
  }
  if (hasOwn(bet, "invalidatedAt")) {
    canonicalIso(bet.invalidatedAt, `${path}.invalidatedAt`);
  }
  if (hasOwn(bet, "invalidationReason")) {
    stringValue(bet.invalidationReason, `${path}.invalidationReason`);
  }
}

function estimate(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    ["mostLikelySeconds"],
    ["optimisticSeconds", "pessimisticSeconds"],
  );
  if (hasOwn(candidate, "optimisticSeconds")) {
    safeFiniteNumber(candidate.optimisticSeconds, `${path}.optimisticSeconds`);
  }
  safeFiniteNumber(candidate.mostLikelySeconds, `${path}.mostLikelySeconds`);
  if (hasOwn(candidate, "pessimisticSeconds")) {
    safeFiniteNumber(
      candidate.pessimisticSeconds,
      `${path}.pessimisticSeconds`,
    );
  }
}

function constraint(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    [],
    ["noEarlierThan", "noLaterThan", "fixedStart", "fixedFinish"],
  );
  for (const field of [
    "noEarlierThan",
    "noLaterThan",
    "fixedStart",
    "fixedFinish",
  ] as const) {
    if (hasOwn(candidate, field))
      stringValue(candidate[field], `${path}.${field}`);
  }
}

function assignment(value: unknown, path: string): void {
  const candidate = objectShape(value, path, [
    "resourceId",
    "attention",
    "effortSeconds",
  ]);
  stringValue(candidate.resourceId, `${path}.resourceId`);
  enumValue(candidate.attention, `${path}.attention`, [
    "deep",
    "medium",
    "shallow",
  ]);
  safeFiniteNumber(candidate.effortSeconds, `${path}.effortSeconds`);
}

function projectWorkItem(value: unknown, path: string): void {
  const item = objectShape(
    value,
    path,
    [
      "id",
      "projectId",
      "kind",
      "title",
      "outline",
      "durationSeconds",
      "estimate",
      "assignmentIds",
      "percentComplete",
      "revision",
      "betScopeId",
    ],
    [
      "parentId",
      "constraint",
      "isKeyTask",
      "isScopeExpansion",
      "isFastDelivery",
      "splitSegments",
      "repeatRule",
      "hammockStartId",
      "hammockFinishId",
      "evidenceRequired",
      "resultStatus",
      "outcomeNote",
    ],
  );
  stringValue(item.id, `${path}.id`);
  stringValue(item.projectId, `${path}.projectId`);
  if (hasOwn(item, "parentId")) stringValue(item.parentId, `${path}.parentId`);
  enumValue(item.kind, `${path}.kind`, [
    "phase",
    "task",
    "milestone",
    "hammock",
  ]);
  stringValue(item.title, `${path}.title`);
  stringValue(item.outline, `${path}.outline`);
  safeFiniteNumber(item.durationSeconds, `${path}.durationSeconds`);
  estimate(item.estimate, `${path}.estimate`);
  if (hasOwn(item, "constraint"))
    constraint(item.constraint, `${path}.constraint`);
  arrayValue(item.assignmentIds, `${path}.assignmentIds`).forEach(
    (entry, index) => assignment(entry, `${path}.assignmentIds[${index}]`),
  );
  safeFiniteNumber(item.percentComplete, `${path}.percentComplete`);
  for (const field of [
    "isKeyTask",
    "isScopeExpansion",
    "isFastDelivery",
    "evidenceRequired",
  ] as const) {
    if (hasOwn(item, field)) booleanValue(item[field], `${path}.${field}`);
  }
  if (hasOwn(item, "splitSegments")) {
    arrayValue(item.splitSegments, `${path}.splitSegments`).forEach(
      (segment, index) => {
        const segmentPath = `${path}.splitSegments[${index}]`;
        const candidate = objectShape(segment, segmentPath, [
          "offsetSeconds",
          "durationSeconds",
        ]);
        safeFiniteNumber(
          candidate.offsetSeconds,
          `${segmentPath}.offsetSeconds`,
        );
        safeFiniteNumber(
          candidate.durationSeconds,
          `${segmentPath}.durationSeconds`,
        );
      },
    );
  }
  if (hasOwn(item, "repeatRule")) {
    const rulePath = `${path}.repeatRule`;
    const rule = objectShape(
      item.repeatRule,
      rulePath,
      ["count"],
      ["cadence", "everyDays", "startMode", "startAt"],
    );
    if (hasOwn(rule, "cadence")) {
      enumValue(rule.cadence, `${rulePath}.cadence`, [
        "every-n-days",
        "weekly",
        "monthly",
      ]);
    }
    if (hasOwn(rule, "everyDays")) {
      safeFiniteNumber(rule.everyDays, `${rulePath}.everyDays`);
    }
    safeFiniteNumber(rule.count, `${rulePath}.count`);
    if (hasOwn(rule, "startMode")) {
      enumValue(rule.startMode, `${rulePath}.startMode`, [
        "fixed-time",
        "after-previous-finish",
      ]);
    }
    if (hasOwn(rule, "startAt"))
      stringValue(rule.startAt, `${rulePath}.startAt`);
  }
  for (const field of [
    "hammockStartId",
    "hammockFinishId",
    "outcomeNote",
  ] as const) {
    if (hasOwn(item, field)) stringValue(item[field], `${path}.${field}`);
  }
  if (hasOwn(item, "resultStatus")) {
    enumValue(item.resultStatus, `${path}.resultStatus`, [
      "completed",
      "learned",
      "blocked",
    ]);
  }
  positiveSafeInteger(item.revision, `${path}.revision`);
  stringValue(item.betScopeId, `${path}.betScopeId`);
}

function projectDependency(value: unknown, path: string): void {
  const dependency = objectShape(value, path, [
    "id",
    "projectId",
    "fromId",
    "toId",
    "type",
    "lagSeconds",
    "revision",
  ]);
  stringValue(dependency.id, `${path}.id`);
  stringValue(dependency.projectId, `${path}.projectId`);
  stringValue(dependency.fromId, `${path}.fromId`);
  stringValue(dependency.toId, `${path}.toId`);
  enumValue(dependency.type, `${path}.type`, ["FS", "SS", "FF", "SF"]);
  safeFiniteNumber(dependency.lagSeconds, `${path}.lagSeconds`);
  positiveSafeInteger(dependency.revision, `${path}.revision`);
}

function recordValues(
  value: unknown,
  path: string,
  validate: (entry: unknown, entryPath: string) => void,
): void {
  const candidate = record(value, path);
  for (const [key, entry] of Object.entries(candidate)) {
    validate(entry, `${path}.${key}`);
  }
}

function commitmentTarget(value: unknown, path: string): void {
  const candidate = record(value, path);
  if (candidate.kind === "action") {
    const target = objectShape(value, path, ["kind", "actionId"]);
    stringValue(target.actionId, `${path}.actionId`);
    return;
  }
  if (candidate.kind === "work_item") {
    const target = objectShape(value, path, [
      "kind",
      "workItemId",
      "projectId",
    ]);
    stringValue(target.workItemId, `${path}.workItemId`);
    stringValue(target.projectId, `${path}.projectId`);
    return;
  }
  fail(`${path}.kind`, "expected action or work_item");
}

function actualTarget(value: unknown, path: string): void {
  const candidate = record(value, path);
  if (candidate.kind === "action") {
    const target = objectShape(value, path, ["kind", "actionId"]);
    stringValue(target.actionId, `${path}.actionId`);
    return;
  }
  if (candidate.kind === "work_item") {
    const target = objectShape(value, path, ["kind", "workItemId"]);
    stringValue(target.workItemId, `${path}.workItemId`);
    return;
  }
  fail(`${path}.kind`, "expected action or work_item");
}

function commitmentSlot(value: unknown, path: string): void {
  const slot = objectShape(value, path, [
    "id",
    "target",
    "targetRevision",
    "start",
    "finish",
    "attention",
  ]);
  stringValue(slot.id, `${path}.id`);
  commitmentTarget(slot.target, `${path}.target`);
  positiveSafeInteger(slot.targetRevision, `${path}.targetRevision`);
  canonicalIso(slot.start, `${path}.start`);
  canonicalIso(slot.finish, `${path}.finish`);
  enumValue(slot.attention, `${path}.attention`, ["deep", "medium", "shallow"]);
}

function planVersion(value: unknown, path: string): void {
  const plan = objectShape(
    value,
    path,
    [
      "id",
      "projectId",
      "version",
      "betId",
      "workItemRevisions",
      "dependencyRevisions",
      "scopeMapping",
      "scheduleHash",
      "capacityIndependentDates",
      "actorId",
      "createdAt",
    ],
    ["supersedesId"],
  );
  stringValue(plan.id, `${path}.id`);
  stringValue(plan.projectId, `${path}.projectId`);
  positiveSafeInteger(plan.version, `${path}.version`);
  stringValue(plan.betId, `${path}.betId`);
  recordValues(
    plan.workItemRevisions,
    `${path}.workItemRevisions`,
    positiveSafeInteger,
  );
  recordValues(
    plan.dependencyRevisions,
    `${path}.dependencyRevisions`,
    positiveSafeInteger,
  );
  recordValues(plan.scopeMapping, `${path}.scopeMapping`, stringValue);
  stringValue(plan.scheduleHash, `${path}.scheduleHash`);
  recordValues(
    plan.capacityIndependentDates,
    `${path}.capacityIndependentDates`,
    (entry, entryPath) => {
      const dates = objectShape(entry, entryPath, ["start", "finish"]);
      canonicalIso(dates.start, `${entryPath}.start`);
      canonicalIso(dates.finish, `${entryPath}.finish`);
    },
  );
  stringValue(plan.actorId, `${path}.actorId`);
  canonicalIso(plan.createdAt, `${path}.createdAt`);
  if (hasOwn(plan, "supersedesId")) {
    stringValue(plan.supersedesId, `${path}.supersedesId`);
  }
}

function dailyCommitment(value: unknown, path: string): void {
  const commitment = objectShape(
    value,
    path,
    [
      "id",
      "localDate",
      "version",
      "proposalHash",
      "capacitySnapshot",
      "slots",
      "actorId",
      "committedAt",
    ],
    ["supersedesId"],
  );
  stringValue(commitment.id, `${path}.id`);
  stringValue(commitment.localDate, `${path}.localDate`);
  positiveSafeInteger(commitment.version, `${path}.version`);
  stringValue(commitment.proposalHash, `${path}.proposalHash`);
  capacityProfile(commitment.capacitySnapshot, `${path}.capacitySnapshot`);
  arrayValue(commitment.slots, `${path}.slots`).forEach((slot, index) =>
    commitmentSlot(slot, `${path}.slots[${index}]`),
  );
  stringValue(commitment.actorId, `${path}.actorId`);
  canonicalIso(commitment.committedAt, `${path}.committedAt`);
  if (hasOwn(commitment, "supersedesId")) {
    stringValue(commitment.supersedesId, `${path}.supersedesId`);
  }
}

function replanProposal(value: unknown, path: string): void {
  const proposal = objectShape(value, path, [
    "id",
    "localDate",
    "baseCommitmentId",
    "baseRevision",
    "reasonCodes",
    "proposedSlots",
    "proposalHash",
    "createdAt",
    "createdBy",
    "status",
  ]);
  stringValue(proposal.id, `${path}.id`);
  stringValue(proposal.localDate, `${path}.localDate`);
  stringValue(proposal.baseCommitmentId, `${path}.baseCommitmentId`);
  nonNegativeSafeInteger(proposal.baseRevision, `${path}.baseRevision`);
  stringArray(proposal.reasonCodes, `${path}.reasonCodes`);
  arrayValue(proposal.proposedSlots, `${path}.proposedSlots`).forEach(
    (slot, index) => commitmentSlot(slot, `${path}.proposedSlots[${index}]`),
  );
  stringValue(proposal.proposalHash, `${path}.proposalHash`);
  canonicalIso(proposal.createdAt, `${path}.createdAt`);
  stringValue(proposal.createdBy, `${path}.createdBy`);
  enumValue(proposal.status, `${path}.status`, [
    "open",
    "accepted",
    "dismissed",
  ]);
}

function resource(value: unknown, path: string): void {
  const candidate = objectShape(value, path, [
    "id",
    "name",
    "role",
    "capacityByAttention",
    "hourlyRate",
  ]);
  stringValue(candidate.id, `${path}.id`);
  stringValue(candidate.name, `${path}.name`);
  stringValue(candidate.role, `${path}.role`);
  const capacity = objectShape(
    candidate.capacityByAttention,
    `${path}.capacityByAttention`,
    ["deep", "medium", "shallow"],
  );
  safeFiniteNumber(capacity.deep, `${path}.capacityByAttention.deep`);
  safeFiniteNumber(capacity.medium, `${path}.capacityByAttention.medium`);
  safeFiniteNumber(capacity.shallow, `${path}.capacityByAttention.shallow`);
  safeFiniteNumber(candidate.hourlyRate, `${path}.hourlyRate`);
}

function attentionCapacity(value: unknown, path: string): void {
  const capacity = objectShape(value, path, [
    "date",
    "deepSeconds",
    "mediumSeconds",
    "shallowSeconds",
    "unavailableBlocks",
  ]);
  stringValue(capacity.date, `${path}.date`);
  safeFiniteNumber(capacity.deepSeconds, `${path}.deepSeconds`);
  safeFiniteNumber(capacity.mediumSeconds, `${path}.mediumSeconds`);
  safeFiniteNumber(capacity.shallowSeconds, `${path}.shallowSeconds`);
  arrayValue(capacity.unavailableBlocks, `${path}.unavailableBlocks`).forEach(
    (block, index) => {
      const blockPath = `${path}.unavailableBlocks[${index}]`;
      const candidate = objectShape(block, blockPath, ["start", "finish"]);
      stringValue(candidate.start, `${blockPath}.start`);
      stringValue(candidate.finish, `${blockPath}.finish`);
    },
  );
}

function baseline(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    [
      "id",
      "projectId",
      "name",
      "capturedAt",
      "plannedStartByItem",
      "plannedFinishByItem",
      "plannedWorkSecondsByItem",
    ],
    ["approvedByDecisionId"],
  );
  stringValue(candidate.id, `${path}.id`);
  stringValue(candidate.projectId, `${path}.projectId`);
  stringValue(candidate.name, `${path}.name`);
  stringValue(candidate.capturedAt, `${path}.capturedAt`);
  recordValues(
    candidate.plannedStartByItem,
    `${path}.plannedStartByItem`,
    stringValue,
  );
  recordValues(
    candidate.plannedFinishByItem,
    `${path}.plannedFinishByItem`,
    stringValue,
  );
  recordValues(
    candidate.plannedWorkSecondsByItem,
    `${path}.plannedWorkSecondsByItem`,
    safeFiniteNumber,
  );
  if (hasOwn(candidate, "approvedByDecisionId")) {
    stringValue(candidate.approvedByDecisionId, `${path}.approvedByDecisionId`);
  }
}

function evidence(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    ["id", "kind", "summary", "projectId", "createdAt", "confidence", "tags"],
    ["url", "localFileRef", "workItemId"],
  );
  stringValue(candidate.id, `${path}.id`);
  enumValue(candidate.kind, `${path}.kind`, [
    "note",
    "commit",
    "pr",
    "ci",
    "doc",
    "screenshot",
    "release",
    "feedback",
    "metric",
    "email",
    "calendar",
    "minutes",
    "booking",
  ]);
  stringValue(candidate.summary, `${path}.summary`);
  for (const field of ["url", "localFileRef", "workItemId"] as const) {
    if (hasOwn(candidate, field))
      stringValue(candidate[field], `${path}.${field}`);
  }
  stringValue(candidate.projectId, `${path}.projectId`);
  stringValue(candidate.createdAt, `${path}.createdAt`);
  safeFiniteNumber(candidate.confidence, `${path}.confidence`);
  stringArray(candidate.tags, `${path}.tags`);
}

function actual(value: unknown, path: string): void {
  const candidate = objectShape(
    value,
    path,
    [
      "id",
      "revision",
      "target",
      "actualWorkSeconds",
      "remainingWorkSeconds",
      "actualCost",
      "recordedAt",
    ],
    ["actualStart", "actualFinish"],
  );
  stringValue(candidate.id, `${path}.id`);
  positiveSafeInteger(candidate.revision, `${path}.revision`);
  actualTarget(candidate.target, `${path}.target`);
  if (hasOwn(candidate, "actualStart")) {
    stringValue(candidate.actualStart, `${path}.actualStart`);
  }
  if (hasOwn(candidate, "actualFinish")) {
    stringValue(candidate.actualFinish, `${path}.actualFinish`);
  }
  safeFiniteNumber(candidate.actualWorkSeconds, `${path}.actualWorkSeconds`);
  safeFiniteNumber(
    candidate.remainingWorkSeconds,
    `${path}.remainingWorkSeconds`,
  );
  safeFiniteNumber(candidate.actualCost, `${path}.actualCost`);
  stringValue(candidate.recordedAt, `${path}.recordedAt`);
}

function jsonValue(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object> = new Set(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    safeFiniteNumber(value, path);
    return;
  }
  if (typeof value !== "object") fail(path, "expected JSON-safe data");
  if (ancestors.has(value)) fail(path, "cyclic values are not JSON-safe");
  const nested = new Set(ancestors);
  nested.add(value);
  if (Array.isArray(value)) {
    arrayValue(value, path).forEach((entry, index) =>
      jsonValue(entry, `${path}[${index}]`, nested),
    );
    return;
  }
  const candidate = record(value, path);
  for (const [key, entry] of Object.entries(candidate)) {
    jsonValue(entry, `${path}.${key}`, nested);
  }
}

function reviewConclusion(value: unknown, path: string, stored: boolean): void {
  const conclusion = objectShape(value, path, [
    "summary",
    "decisionCodes",
    "followUpCommandIds",
    ...(stored ? ["actorId", "completedAt"] : []),
  ]);
  stringValue(conclusion.summary, `${path}.summary`);
  stringArray(conclusion.decisionCodes, `${path}.decisionCodes`);
  stringArray(conclusion.followUpCommandIds, `${path}.followUpCommandIds`);
  if (stored) {
    stringValue(conclusion.actorId, `${path}.actorId`);
    canonicalIso(conclusion.completedAt, `${path}.completedAt`);
  }
}

function reviewRecord(value: unknown, path: string): void {
  const review = objectShape(
    value,
    path,
    [
      "id",
      "kind",
      "triggerKey",
      "triggerType",
      "status",
      "affectedProjectIds",
      "affectedRecordIds",
      "dueAt",
      "createdAt",
    ],
    ["cadenceTimeZone", "overdueMarkedAt", "conclusion"],
  );
  stringValue(review.id, `${path}.id`);
  enumValue(review.kind, `${path}.kind`, ["weekly", "event"]);
  stringValue(review.triggerKey, `${path}.triggerKey`);
  enumValue(review.triggerType, `${path}.triggerType`, [
    "weekly",
    "bet_midpoint",
    "bet_expired",
    "evidence_stale",
    "exception_expired",
    "capacity_variance",
    "hard_gate",
    "sync_conflict",
  ]);
  enumValue(review.status, `${path}.status`, ["open", "completed"]);
  stringArray(review.affectedProjectIds, `${path}.affectedProjectIds`);
  stringArray(review.affectedRecordIds, `${path}.affectedRecordIds`);
  canonicalIso(review.dueAt, `${path}.dueAt`);
  if (hasOwn(review, "cadenceTimeZone")) {
    stringValue(review.cadenceTimeZone, `${path}.cadenceTimeZone`);
  }
  canonicalIso(review.createdAt, `${path}.createdAt`);
  if (hasOwn(review, "overdueMarkedAt")) {
    canonicalIso(review.overdueMarkedAt, `${path}.overdueMarkedAt`);
  }
  if (hasOwn(review, "conclusion")) {
    reviewConclusion(review.conclusion, `${path}.conclusion`, true);
  }
}

function exceptionHistoryEntry(value: unknown, path: string): void {
  const entry = objectShape(value, path, ["action", "actorId", "at", "note"]);
  enumValue(entry.action, `${path}.action`, ["created", "resolved", "expired"]);
  stringValue(entry.actorId, `${path}.actorId`);
  canonicalIso(entry.at, `${path}.at`);
  stringValue(entry.note, `${path}.note`);
}

function exceptionRecord(value: unknown, path: string): void {
  const exception = objectShape(
    value,
    path,
    [
      "id",
      "projectId",
      "requirementId",
      "rationale",
      "knownConsequence",
      "reviewAt",
      "expiresAt",
      "approvedBy",
      "createdAt",
      "history",
    ],
    ["resolvedAt"],
  );
  for (const field of [
    "id",
    "projectId",
    "requirementId",
    "rationale",
    "knownConsequence",
    "approvedBy",
  ] as const) {
    stringValue(exception[field], `${path}.${field}`);
  }
  canonicalIso(exception.reviewAt, `${path}.reviewAt`);
  canonicalIso(exception.expiresAt, `${path}.expiresAt`);
  canonicalIso(exception.createdAt, `${path}.createdAt`);
  if (hasOwn(exception, "resolvedAt")) {
    canonicalIso(exception.resolvedAt, `${path}.resolvedAt`);
  }
  arrayValue(exception.history, `${path}.history`).forEach((entry, index) =>
    exceptionHistoryEntry(entry, `${path}.history[${index}]`),
  );
}

function closeDecision(value: unknown, path: string, stored: boolean): void {
  const decision = objectShape(
    value,
    path,
    [
      "id",
      "projectId",
      "successComparison",
      "outcome",
      "keyLearning",
      "unfinishedDisposition",
      ...(stored ? ["actorId", "closedAt"] : []),
    ],
    ["followUpProjectId"],
  );
  stringValue(decision.id, `${path}.id`);
  stringValue(decision.projectId, `${path}.projectId`);
  stringValue(decision.successComparison, `${path}.successComparison`);
  enumValue(decision.outcome, `${path}.outcome`, [
    "achieved",
    "partial",
    "invalidated",
    "abandoned",
  ]);
  stringValue(decision.keyLearning, `${path}.keyLearning`);
  enumValue(decision.unfinishedDisposition, `${path}.unfinishedDisposition`, [
    "discard",
    "return_to_inbox",
    "follow_up_project",
    "historical_incomplete",
  ]);
  if (hasOwn(decision, "followUpProjectId")) {
    stringValue(decision.followUpProjectId, `${path}.followUpProjectId`);
  }
  if (stored) {
    stringValue(decision.actorId, `${path}.actorId`);
    canonicalIso(decision.closedAt, `${path}.closedAt`);
  }
}

function commandProposal(value: unknown, path: string): void {
  const proposal = objectShape(value, path, [
    "id",
    "commandType",
    "payload",
    "baseRevision",
    "rationale",
    "agentActorId",
    "createdAt",
    "status",
  ]);
  stringValue(proposal.id, `${path}.id`);
  enumValue(proposal.commandType, `${path}.commandType`, [
    "update_direction",
    "create_work_item",
    "update_work_item",
    "propose_replan",
    "upsert_dependency",
    "remove_dependency",
  ]);
  jsonValue(proposal.payload, `${path}.payload`);
  nonNegativeSafeInteger(proposal.baseRevision, `${path}.baseRevision`);
  stringValue(proposal.rationale, `${path}.rationale`);
  stringValue(proposal.agentActorId, `${path}.agentActorId`);
  canonicalIso(proposal.createdAt, `${path}.createdAt`);
  enumValue(proposal.status, `${path}.status`, [
    "open",
    "accepted",
    "dismissed",
    "stale",
  ]);
}

function legacyAuditRecord(value: unknown, path: string): void {
  const audit = objectShape(value, path, [
    "id",
    "projectId",
    "recordType",
    "sourcePayload",
    "sourceChecksum",
  ]);
  stringValue(audit.id, `${path}.id`);
  stringValue(audit.projectId, `${path}.projectId`);
  enumValue(audit.recordType, `${path}.recordType`, [
    "decision",
    "audit_decision",
    "audit_gate",
    "change_set",
    "shape_up_pitch",
    "legacy_closure",
  ]);
  jsonValue(audit.sourcePayload, `${path}.sourcePayload`);
  stringValue(audit.sourceChecksum, `${path}.sourceChecksum`);
}

function migrationRecord(value: unknown, path: string): void {
  const migration = objectShape(value, path, [
    "sourceSchemaVersion",
    "sourceChecksum",
    "backupId",
    "backupChecksum",
    "migratedAt",
    "entityCounts",
    "deterministicIdMap",
  ]);
  if (migration.sourceSchemaVersion !== 1) {
    fail(`${path}.sourceSchemaVersion`, "expected literal 1");
  }
  stringValue(migration.sourceChecksum, `${path}.sourceChecksum`);
  stringValue(migration.backupId, `${path}.backupId`);
  stringValue(migration.backupChecksum, `${path}.backupChecksum`);
  canonicalIso(migration.migratedAt, `${path}.migratedAt`);
  recordValues(
    migration.entityCounts,
    `${path}.entityCounts`,
    nonNegativeSafeInteger,
  );
  recordValues(
    migration.deterministicIdMap,
    `${path}.deterministicIdMap`,
    stringValue,
  );
}

function commandSource(value: unknown, path: string): void {
  const source = objectShape(value, path, [
    "sourceId",
    "verified",
    "capabilities",
  ]);
  stringValue(source.sourceId, `${path}.sourceId`);
  booleanValue(source.verified, `${path}.verified`);
  arrayValue(source.capabilities, `${path}.capabilities`).forEach(
    (capability, index) =>
      enumValue(capability, `${path}.capabilities[${index}]`, [
        "human_decision",
        "capture_inbox",
        "record_actual",
        "attach_evidence",
        "submit_proposal",
        "import_portable",
        "replay_receipt",
        "system_time",
        "open_conflict",
      ]),
  );
}

function auditDiff(value: unknown, path: string): void {
  const diff = objectShape(value, path, [
    "entity",
    "entityId",
    "field",
    "before",
    "after",
  ]);
  stringValue(diff.entity, `${path}.entity`);
  stringValue(diff.entityId, `${path}.entityId`);
  stringValue(diff.field, `${path}.field`);
  jsonValue(diff.before, `${path}.before`);
  jsonValue(diff.after, `${path}.after`);
}

function commandReceipt(value: unknown, path: string): void {
  const receipt = objectShape(
    value,
    path,
    [
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
    ],
    ["rejectionCode"],
  );
  stringValue(receipt.id, `${path}.id`);
  stringValue(receipt.commandId, `${path}.commandId`);
  stringValue(receipt.commandType, `${path}.commandType`);
  nonNegativeSafeInteger(receipt.baseRevision, `${path}.baseRevision`);
  nonNegativeSafeInteger(receipt.revision, `${path}.revision`);
  stringValue(receipt.payloadHash, `${path}.payloadHash`);
  stringValue(receipt.receiptHash, `${path}.receiptHash`);
  stringValue(receipt.actorId, `${path}.actorId`);
  enumValue(receipt.actorKind, `${path}.actorKind`, [
    "human",
    "agent",
    "system",
  ]);
  enumValue(receipt.origin, `${path}.origin`, [
    "ui",
    "agent",
    "import",
    "sync",
    "migration",
  ]);
  commandSource(receipt.source, `${path}.source`);
  enumValue(receipt.status, `${path}.status`, ["applied", "rejected"]);
  canonicalIso(receipt.createdAt, `${path}.createdAt`);
  arrayValue(receipt.diff, `${path}.diff`).forEach((entry, index) =>
    auditDiff(entry, `${path}.diff[${index}]`),
  );
  if (hasOwn(receipt, "rejectionCode")) {
    stringValue(receipt.rejectionCode, `${path}.rejectionCode`);
  }
}

const protectedCommandTypes = [
  "place_bet",
  "update_direction",
  "record_bet_boundary",
  "commit_today",
  "propose_replan",
  "accept_replan",
  "create_review",
  "mark_review_overdue",
  "complete_review",
  "approve_evidence_exception",
  "resolve_evidence_exception",
  "close_project",
  "abandon_project",
] as const;

function reviewDraft(value: unknown, path: string): void {
  const review = objectShape(
    value,
    path,
    [
      "id",
      "kind",
      "triggerKey",
      "triggerType",
      "affectedProjectIds",
      "affectedRecordIds",
      "dueAt",
    ],
    ["cadenceTimeZone"],
  );
  stringValue(review.id, `${path}.id`);
  enumValue(review.kind, `${path}.kind`, ["weekly", "event"]);
  stringValue(review.triggerKey, `${path}.triggerKey`);
  enumValue(review.triggerType, `${path}.triggerType`, [
    "weekly",
    "bet_midpoint",
    "bet_expired",
    "evidence_stale",
    "exception_expired",
    "capacity_variance",
    "hard_gate",
    "sync_conflict",
  ]);
  stringArray(review.affectedProjectIds, `${path}.affectedProjectIds`);
  stringArray(review.affectedRecordIds, `${path}.affectedRecordIds`);
  canonicalIso(review.dueAt, `${path}.dueAt`);
  if (hasOwn(review, "cadenceTimeZone")) {
    stringValue(review.cadenceTimeZone, `${path}.cadenceTimeZone`);
  }
}

function exceptionDraft(value: unknown, path: string): void {
  const exception = objectShape(value, path, [
    "id",
    "projectId",
    "requirementId",
    "rationale",
    "knownConsequence",
    "reviewAt",
    "expiresAt",
  ]);
  for (const field of [
    "id",
    "projectId",
    "requirementId",
    "rationale",
    "knownConsequence",
  ] as const) {
    stringValue(exception[field], `${path}.${field}`);
  }
  canonicalIso(exception.reviewAt, `${path}.reviewAt`);
  canonicalIso(exception.expiresAt, `${path}.expiresAt`);
}

function protectedCommand(value: unknown, path: string): string {
  const candidate = record(value, path);
  enumValue(candidate.type, `${path}.type`, protectedCommandTypes);
  switch (candidate.type) {
    case "place_bet": {
      const command = objectShape(value, path, [
        "type",
        "projectId",
        "betId",
        "start",
      ]);
      stringValue(command.projectId, `${path}.projectId`);
      stringValue(command.betId, `${path}.betId`);
      canonicalIso(command.start, `${path}.start`);
      return candidate.type;
    }
    case "update_direction": {
      const command = objectShape(value, path, ["type", "projectId", "brief"]);
      stringValue(command.projectId, `${path}.projectId`);
      directionBrief(command.brief, `${path}.brief`, false);
      return candidate.type;
    }
    case "record_bet_boundary": {
      const command = objectShape(value, path, [
        "type",
        "projectId",
        "boundary",
        "triggerKey",
      ]);
      stringValue(command.projectId, `${path}.projectId`);
      enumValue(command.boundary, `${path}.boundary`, ["midpoint", "expired"]);
      stringValue(command.triggerKey, `${path}.triggerKey`);
      return candidate.type;
    }
    case "commit_today": {
      const command = objectShape(value, path, ["type", "commitment"]);
      const commitmentPath = `${path}.commitment`;
      const commitment = objectShape(command.commitment, commitmentPath, [
        "id",
        "localDate",
        "workspaceRevision",
        "generatedAt",
        "proposalHash",
        "slots",
      ]);
      stringValue(commitment.id, `${commitmentPath}.id`);
      stringValue(commitment.localDate, `${commitmentPath}.localDate`);
      nonNegativeSafeInteger(
        commitment.workspaceRevision,
        `${commitmentPath}.workspaceRevision`,
      );
      canonicalIso(commitment.generatedAt, `${commitmentPath}.generatedAt`);
      stringValue(commitment.proposalHash, `${commitmentPath}.proposalHash`);
      arrayValue(commitment.slots, `${commitmentPath}.slots`).forEach(
        (slot, index) =>
          commitmentSlot(slot, `${commitmentPath}.slots[${index}]`),
      );
      return candidate.type;
    }
    case "propose_replan": {
      const command = objectShape(value, path, ["type", "proposal"]);
      replanProposal(command.proposal, `${path}.proposal`);
      return candidate.type;
    }
    case "accept_replan": {
      const command = objectShape(value, path, [
        "type",
        "proposalId",
        "commitmentId",
      ]);
      stringValue(command.proposalId, `${path}.proposalId`);
      stringValue(command.commitmentId, `${path}.commitmentId`);
      return candidate.type;
    }
    case "create_review": {
      const command = objectShape(value, path, ["type", "review"]);
      reviewDraft(command.review, `${path}.review`);
      return candidate.type;
    }
    case "mark_review_overdue": {
      const command = objectShape(value, path, [
        "type",
        "reviewId",
        "triggerKey",
      ]);
      stringValue(command.reviewId, `${path}.reviewId`);
      stringValue(command.triggerKey, `${path}.triggerKey`);
      return candidate.type;
    }
    case "complete_review": {
      const command = objectShape(value, path, [
        "type",
        "reviewId",
        "conclusion",
      ]);
      stringValue(command.reviewId, `${path}.reviewId`);
      reviewConclusion(command.conclusion, `${path}.conclusion`, false);
      return candidate.type;
    }
    case "approve_evidence_exception": {
      const command = objectShape(value, path, ["type", "exception"]);
      exceptionDraft(command.exception, `${path}.exception`);
      return candidate.type;
    }
    case "resolve_evidence_exception": {
      const command = objectShape(value, path, [
        "type",
        "exceptionId",
        "resolution",
      ]);
      stringValue(command.exceptionId, `${path}.exceptionId`);
      stringValue(command.resolution, `${path}.resolution`);
      return candidate.type;
    }
    case "close_project":
    case "abandon_project": {
      const command = objectShape(value, path, [
        "type",
        "projectId",
        "decision",
      ]);
      stringValue(command.projectId, `${path}.projectId`);
      closeDecision(command.decision, `${path}.decision`, false);
      if (
        candidate.type === "abandon_project" &&
        record(command.decision, `${path}.decision`).outcome !== "abandoned"
      ) {
        fail(`${path}.decision.outcome`, "expected abandoned");
      }
      return candidate.type;
    }
  }
}

function indexedProjectHold(value: unknown, path: string): void {
  const indexed = objectShape(value, path, ["index", "value"]);
  nonNegativeSafeInteger(indexed.index, `${path}.index`);
  projectHold(indexed.value, `${path}.value`);
}

function protectedCreatedValue(
  entity: string,
  value: unknown,
  path: string,
): void {
  switch (entity) {
    case "BetVersion":
      betVersion(value, path);
      return;
    case "DailyCommitment":
      dailyCommitment(value, path);
      return;
    case "PlanVersion":
      planVersion(value, path);
      return;
    case "ReplanProposal":
      replanProposal(value, path);
      return;
    case "ReviewRecord":
      reviewRecord(value, path);
      return;
    case "ExceptionRecord":
      exceptionRecord(value, path);
      return;
    case "CloseDecision":
      closeDecision(value, path, true);
      return;
    case "InboxItem":
      inboxItem(value, path);
      return;
    case "ProjectV2":
      project(value, path);
      return;
    case "DirectionBrief":
      directionBrief(value, path, true);
      return;
    default:
      fail(path, "unsupported protected created entity");
  }
}

function protectedEffectCell(value: unknown, path: string): void {
  const candidate = record(value, path);
  switch (candidate.kind) {
    case "create": {
      const cell = objectShape(value, path, [
        "kind",
        "entity",
        "entityId",
        "value",
      ]);
      enumValue(cell.entity, `${path}.entity`, [
        "BetVersion",
        "DailyCommitment",
        "PlanVersion",
        "ReplanProposal",
        "ReviewRecord",
        "ExceptionRecord",
        "CloseDecision",
        "InboxItem",
        "ProjectV2",
        "DirectionBrief",
      ]);
      stringValue(cell.entityId, `${path}.entityId`);
      protectedCreatedValue(cell.entity, cell.value, `${path}.value`);
      return;
    }
    case "scalar": {
      const cell = objectShape(
        value,
        path,
        ["kind", "entity", "entityId", "field", "before", "after"],
        ["ownerProjectId"],
      );
      enumValue(cell.entity, `${path}.entity`, [
        "BetVersion",
        "ProjectV2",
        "ReplanProposal",
        "ReviewRecord",
        "ExceptionRecord",
      ]);
      stringValue(cell.entityId, `${path}.entityId`);
      if (hasOwn(cell, "ownerProjectId")) {
        stringValue(cell.ownerProjectId, `${path}.ownerProjectId`);
      }
      stringValue(cell.field, `${path}.field`);
      jsonValue(cell.before, `${path}.before`);
      jsonValue(cell.after, `${path}.after`);
      return;
    }
    case "project_hold_delta": {
      const cell = objectShape(value, path, [
        "kind",
        "projectId",
        "holdKey",
        "before",
        "after",
      ]);
      stringValue(cell.projectId, `${path}.projectId`);
      stringValue(cell.holdKey, `${path}.holdKey`);
      if (cell.before !== null)
        indexedProjectHold(cell.before, `${path}.before`);
      if (cell.after !== null) indexedProjectHold(cell.after, `${path}.after`);
      return;
    }
    case "exception_history_append": {
      const cell = objectShape(value, path, [
        "kind",
        "exceptionId",
        "index",
        "entry",
      ]);
      stringValue(cell.exceptionId, `${path}.exceptionId`);
      nonNegativeSafeInteger(cell.index, `${path}.index`);
      exceptionHistoryEntry(cell.entry, `${path}.entry`);
      return;
    }
    default:
      fail(`${path}.kind`, "unknown protected effect cell kind");
  }
}

function protectedOperation(value: unknown, path: string): void {
  const operation = objectShape(value, path, [
    "commandType",
    "commandId",
    "command",
    "authorityRootOperationHash",
    "sourceOperationHash",
    "receiptHash",
    "payloadHash",
    "createdAt",
    "cells",
  ]);
  enumValue(
    operation.commandType,
    `${path}.commandType`,
    protectedCommandTypes,
  );
  stringValue(operation.commandId, `${path}.commandId`);
  const commandType = protectedCommand(operation.command, `${path}.command`);
  if (operation.commandType !== commandType) {
    fail(`${path}.command.type`, "must match commandType");
  }
  stringValue(
    operation.authorityRootOperationHash,
    `${path}.authorityRootOperationHash`,
  );
  stringValue(operation.sourceOperationHash, `${path}.sourceOperationHash`);
  stringValue(operation.receiptHash, `${path}.receiptHash`);
  stringValue(operation.payloadHash, `${path}.payloadHash`);
  canonicalIso(operation.createdAt, `${path}.createdAt`);
  arrayValue(operation.cells, `${path}.cells`).forEach((cell, index) =>
    protectedEffectCell(cell, `${path}.cells[${index}]`),
  );
}

function protectedEffectBundle(value: unknown, path: string): void {
  const bundle = objectShape(value, path, [
    "schemaVersion",
    "logicalKey",
    "operations",
    "hash",
  ]);
  if (bundle.schemaVersion !== 1) {
    fail(`${path}.schemaVersion`, "expected literal 1");
  }
  stringValue(bundle.logicalKey, `${path}.logicalKey`);
  arrayValue(bundle.operations, `${path}.operations`).forEach(
    (operation, index) =>
      protectedOperation(operation, `${path}.operations[${index}]`),
  );
  stringValue(bundle.hash, `${path}.hash`);
}

/**
 * Reuses the backup schema's exact protected-bundle shape at every runtime
 * boundary that accepts an opaque bundle. Hash validation and logical-owner
 * semantics remain the responsibility of `validateProtectedEffectBundle`.
 */
export function assertProtectedEffectBundleSchema(
  value: unknown,
  path = "protectedEffectBundle",
): void {
  protectedEffectBundle(value, path);
}

function syncConflict(value: unknown, path: string): void {
  const conflict = objectShape(
    value,
    path,
    [
      "id",
      "recordType",
      "recordId",
      "commonAncestorHash",
      "localValue",
      "remoteValue",
      "openedAt",
    ],
    [
      "remoteRecordId",
      "projectId",
      "logicalKey",
      "affectedProjectIds",
      "affectedRecordIds",
      "localBundle",
      "remoteBundle",
      "resolvedAt",
      "retainedVersion",
      "retainedBundleHash",
    ],
  );
  stringValue(conflict.id, `${path}.id`);
  enumValue(conflict.recordType, `${path}.recordType`, [
    "bet",
    "daily_commitment",
    "review",
    "exception",
    "close",
  ]);
  stringValue(conflict.recordId, `${path}.recordId`);
  for (const field of ["remoteRecordId", "projectId", "logicalKey"] as const) {
    if (hasOwn(conflict, field))
      stringValue(conflict[field], `${path}.${field}`);
  }
  for (const field of ["affectedProjectIds", "affectedRecordIds"] as const) {
    if (hasOwn(conflict, field))
      stringArray(conflict[field], `${path}.${field}`);
  }
  stringValue(conflict.commonAncestorHash, `${path}.commonAncestorHash`);
  jsonValue(conflict.localValue, `${path}.localValue`);
  jsonValue(conflict.remoteValue, `${path}.remoteValue`);
  if (hasOwn(conflict, "localBundle")) {
    protectedEffectBundle(conflict.localBundle, `${path}.localBundle`);
  }
  if (hasOwn(conflict, "remoteBundle")) {
    protectedEffectBundle(conflict.remoteBundle, `${path}.remoteBundle`);
  }
  canonicalIso(conflict.openedAt, `${path}.openedAt`);
  if (hasOwn(conflict, "resolvedAt")) {
    canonicalIso(conflict.resolvedAt, `${path}.resolvedAt`);
  }
  if (hasOwn(conflict, "retainedVersion")) {
    enumValue(conflict.retainedVersion, `${path}.retainedVersion`, [
      "local",
      "remote",
    ]);
  }
  if (hasOwn(conflict, "retainedBundleHash")) {
    stringValue(conflict.retainedBundleHash, `${path}.retainedBundleHash`);
  }
}

function capacityProfile(value: unknown, path: string): void {
  const profile = objectShape(value, path, [
    "timeZone",
    "weeklyWindows",
    "dailyBudgets",
    "unavailableBlocks",
    "updatedAt",
    "updatedBy",
  ]);
  stringValue(profile.timeZone, `${path}.timeZone`);
  arrayValue(profile.weeklyWindows, `${path}.weeklyWindows`).forEach(
    (item, index) => {
      const itemPath = `${path}.weeklyWindows[${index}]`;
      const window = objectShape(item, itemPath, [
        "weekday",
        "startMinute",
        "finishMinute",
      ]);
      if (
        !Number.isInteger(window.weekday) ||
        Number(window.weekday) < 0 ||
        Number(window.weekday) > 6
      ) {
        fail(`${itemPath}.weekday`, "expected a weekday from 0 through 6");
      }
      nonNegativeSafeInteger(window.startMinute, `${itemPath}.startMinute`);
      nonNegativeSafeInteger(window.finishMinute, `${itemPath}.finishMinute`);
    },
  );
  arrayValue(profile.dailyBudgets, `${path}.dailyBudgets`).forEach(
    (item, index) => {
      const itemPath = `${path}.dailyBudgets[${index}]`;
      const budget = objectShape(item, itemPath, [
        "weekday",
        "deepSeconds",
        "mediumSeconds",
        "shallowSeconds",
      ]);
      if (
        !Number.isInteger(budget.weekday) ||
        Number(budget.weekday) < 0 ||
        Number(budget.weekday) > 6
      ) {
        fail(`${itemPath}.weekday`, "expected a weekday from 0 through 6");
      }
      nonNegativeFiniteNumber(budget.deepSeconds, `${itemPath}.deepSeconds`);
      nonNegativeFiniteNumber(
        budget.mediumSeconds,
        `${itemPath}.mediumSeconds`,
      );
      nonNegativeFiniteNumber(
        budget.shallowSeconds,
        `${itemPath}.shallowSeconds`,
      );
    },
  );
  arrayValue(profile.unavailableBlocks, `${path}.unavailableBlocks`).forEach(
    (item, index) => {
      const itemPath = `${path}.unavailableBlocks[${index}]`;
      const block = objectShape(item, itemPath, ["id", "start", "finish"]);
      stringValue(block.id, `${itemPath}.id`);
      canonicalIso(block.start, `${itemPath}.start`);
      canonicalIso(block.finish, `${itemPath}.finish`);
    },
  );
  canonicalIso(profile.updatedAt, `${path}.updatedAt`);
  stringValue(profile.updatedBy, `${path}.updatedBy`);
}

const workspaceCollections = [
  "inboxItems",
  "actions",
  "projects",
  "directionBriefs",
  "bets",
  "planVersions",
  "dailyCommitments",
  "replanProposals",
  "reviews",
  "exceptions",
  "closeDecisions",
  "commandProposals",
  "syncConflicts",
  "commandReceipts",
  "workItems",
  "dependencies",
  "resources",
  "capacities",
  "baselines",
  "evidence",
  "actuals",
  "legacyAuditRecords",
] as const;

/**
 * Checks the complete JSON runtime shape accepted by a V2 workspace backup.
 * Domain and cross-record invariants deliberately remain the responsibility of
 * `validateWorkspaceInvariants` after this schema gate succeeds.
 */
export function assertWorkspaceV2Schema(
  value: unknown,
): asserts value is WorkspaceV2 {
  const workspace = objectShape(
    value,
    "workspace",
    [
      "schemaVersion",
      "workspaceId",
      "revision",
      ...workspaceCollections,
      "visibility",
    ],
    ["capacityProfile", "migration"],
  );
  if (workspace.schemaVersion !== 2) {
    fail("workspace.schemaVersion", "expected literal 2");
  }
  stringValue(workspace.workspaceId, "workspace.workspaceId");
  nonNegativeSafeInteger(workspace.revision, "workspace.revision");
  if (
    Object.prototype.hasOwnProperty.call(workspace, "capacityProfile") &&
    workspace.capacityProfile !== undefined
  ) {
    capacityProfile(workspace.capacityProfile, "workspace.capacityProfile");
  }
  for (const collection of workspaceCollections) {
    arrayValue(workspace[collection], `workspace.${collection}`);
  }
  arrayValue(workspace.inboxItems, "workspace.inboxItems").forEach(
    (item, index) => inboxItem(item, `workspace.inboxItems[${index}]`),
  );
  arrayValue(workspace.actions, "workspace.actions").forEach((item, index) =>
    action(item, `workspace.actions[${index}]`),
  );
  arrayValue(workspace.projects, "workspace.projects").forEach((item, index) =>
    project(item, `workspace.projects[${index}]`),
  );
  arrayValue(workspace.directionBriefs, "workspace.directionBriefs").forEach(
    (item, index) =>
      directionBrief(item, `workspace.directionBriefs[${index}]`, true),
  );
  arrayValue(workspace.bets, "workspace.bets").forEach((item, index) =>
    betVersion(item, `workspace.bets[${index}]`),
  );
  arrayValue(workspace.workItems, "workspace.workItems").forEach(
    (item, index) => projectWorkItem(item, `workspace.workItems[${index}]`),
  );
  arrayValue(workspace.dependencies, "workspace.dependencies").forEach(
    (item, index) =>
      projectDependency(item, `workspace.dependencies[${index}]`),
  );
  arrayValue(workspace.planVersions, "workspace.planVersions").forEach(
    (item, index) => planVersion(item, `workspace.planVersions[${index}]`),
  );
  arrayValue(workspace.dailyCommitments, "workspace.dailyCommitments").forEach(
    (item, index) =>
      dailyCommitment(item, `workspace.dailyCommitments[${index}]`),
  );
  arrayValue(workspace.replanProposals, "workspace.replanProposals").forEach(
    (item, index) =>
      replanProposal(item, `workspace.replanProposals[${index}]`),
  );
  arrayValue(workspace.resources, "workspace.resources").forEach(
    (item, index) => resource(item, `workspace.resources[${index}]`),
  );
  arrayValue(workspace.capacities, "workspace.capacities").forEach(
    (item, index) => attentionCapacity(item, `workspace.capacities[${index}]`),
  );
  arrayValue(workspace.baselines, "workspace.baselines").forEach(
    (item, index) => baseline(item, `workspace.baselines[${index}]`),
  );
  arrayValue(workspace.evidence, "workspace.evidence").forEach((item, index) =>
    evidence(item, `workspace.evidence[${index}]`),
  );
  arrayValue(workspace.actuals, "workspace.actuals").forEach((item, index) =>
    actual(item, `workspace.actuals[${index}]`),
  );
  arrayValue(workspace.reviews, "workspace.reviews").forEach((item, index) =>
    reviewRecord(item, `workspace.reviews[${index}]`),
  );
  arrayValue(workspace.exceptions, "workspace.exceptions").forEach(
    (item, index) => exceptionRecord(item, `workspace.exceptions[${index}]`),
  );
  arrayValue(workspace.closeDecisions, "workspace.closeDecisions").forEach(
    (item, index) =>
      closeDecision(item, `workspace.closeDecisions[${index}]`, true),
  );
  arrayValue(workspace.commandProposals, "workspace.commandProposals").forEach(
    (item, index) =>
      commandProposal(item, `workspace.commandProposals[${index}]`),
  );
  arrayValue(
    workspace.legacyAuditRecords,
    "workspace.legacyAuditRecords",
  ).forEach((item, index) =>
    legacyAuditRecord(item, `workspace.legacyAuditRecords[${index}]`),
  );
  if (hasOwn(workspace, "migration") && workspace.migration !== undefined) {
    migrationRecord(workspace.migration, "workspace.migration");
  }
  arrayValue(workspace.commandReceipts, "workspace.commandReceipts").forEach(
    (item, index) =>
      commandReceipt(item, `workspace.commandReceipts[${index}]`),
  );
  arrayValue(workspace.syncConflicts, "workspace.syncConflicts").forEach(
    (item, index) => syncConflict(item, `workspace.syncConflicts[${index}]`),
  );
  const visibility = objectShape(workspace.visibility, "workspace.visibility", [
    "archivedProjectIds",
  ]);
  stringArray(
    visibility.archivedProjectIds,
    "workspace.visibility.archivedProjectIds",
  );

  for (const collection of workspaceCollections) {
    if (collection === "capacities") continue;
    const collectionPath = `workspace.${collection}`;
    const seenIds = new Set<string>();
    for (const [index, item] of arrayValue(
      workspace[collection],
      collectionPath,
    ).entries()) {
      const candidate = record(item, `${collectionPath}[${index}]`);
      stringValue(candidate.id, `${collectionPath}[${index}].id`);
      if (seenIds.has(candidate.id)) {
        fail(collectionPath, `duplicate identity ${candidate.id}`);
      }
      seenIds.add(candidate.id);
    }
  }
}
