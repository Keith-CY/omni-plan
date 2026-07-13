import type {
  Actual,
  AttentionCapacity,
  Baseline,
  Dependency,
  Evidence,
  Id,
  ISODate,
  Project,
  Resource,
  ShapeUpPitch,
  WorkItem,
  WorkspaceSnapshot,
} from "@/domain/types";
import { isDirectionComplete } from "@/v2/domain/direction";
import type {
  BetScope,
  DirectionBrief,
  JsonValue,
  LegacyAuditRecord,
  MigrationRecord,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "@/v2/domain/types";
import { createEmptyWorkspaceV2 } from "@/v2/domain/workspace";

const WORKDAY_SECONDS = 8 * 60 * 60;

export interface MigrationOptions {
  workspaceId: Id;
  sourceChecksum: string;
  backupId: Id;
  backupChecksum: string;
  actorId: Id;
  now: ISODate;
}

export interface ActualIdDerivation {
  sourceIndex: number;
  workItemId: Id;
  recordedAt: ISODate;
  derivationKey: string;
  actualId: Id;
}

export interface MigrationReport {
  actualIdDerivations: ActualIdDerivation[];
}

export interface MigratedV1Workspace {
  workspace: WorkspaceV2;
  migration: MigrationRecord;
  report: MigrationReport;
}

export class MigrationSourceError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join("\n"));
    this.name = "MigrationSourceError";
    this.issues = [...issues];
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string {
  const candidate = value?.[field];
  return typeof candidate === "string" ? candidate.trim() : "";
}

function positiveNumberField(
  value: Record<string, unknown> | undefined,
  field: string,
): number {
  const candidate = value?.[field];
  return typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate > 0
    ? candidate
    : 0;
}

function canonicalTimestamp(value: unknown): ISODate | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? value
    : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function labeledLines(
  entries: ReadonlyArray<readonly [label: string, value: string]>,
): string {
  return entries
    .filter(([, value]) => value.length > 0)
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}

function directionBriefId(projectId: Id): Id {
  return `migration:direction:${projectId}`;
}

function unscopedWorkId(projectId: Id): Id {
  return `migration:unscoped:${projectId}`;
}

function shapeUpPitchRecordId(projectId: Id): Id {
  return `migration:shape-up-pitch:${projectId}`;
}

function legacyClosureRecordId(projectId: Id): Id {
  return `migration:legacy-closure:${projectId}`;
}

export function actualDerivationKey(
  actual: Pick<Actual, "workItemId" | "recordedAt">,
  sourceIndex: number,
): string {
  return `${actual.workItemId}+${actual.recordedAt}+${sourceIndex}`;
}

export function deterministicActualId(
  actual: Pick<Actual, "workItemId" | "recordedAt">,
  sourceIndex: number,
): Id {
  return `migration:actual:${encodeURIComponent(actual.workItemId)}:${encodeURIComponent(actual.recordedAt)}:${sourceIndex}`;
}

function validateSourceReferences(source: WorkspaceSnapshot): void {
  const issues: string[] = [];
  const projectById = new Map(source.projects.map((project) => [project.id, project]));
  const workItemById = new Map(source.workItems.map((item) => [item.id, item]));
  const resourceById = new Map(source.resources.map((resource) => [resource.id, resource]));
  const baselineById = new Map(source.baselines.map((baseline) => [baseline.id, baseline]));
  const evidenceById = new Map(source.evidence.map((evidence) => [evidence.id, evidence]));
  const decisionById = new Map(source.decisions.map((decision) => [decision.id, decision]));
  const auditGateById = new Map(source.auditGates.map((gate) => [gate.id, gate]));
  const auditDecisionById = new Map(
    source.auditDecisions.map((decision) => [decision.id, decision]),
  );

  function checkDuplicateIds(
    label: string,
    records: readonly { id: Id }[],
  ): void {
    const counts = new Map<Id, number>();
    for (const { id } of records) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of counts) {
      if (count > 1) {
        issues.push(`Duplicate ${label} ID ${id}.`);
      }
    }
  }

  checkDuplicateIds("Project", source.projects);
  checkDuplicateIds("Work Item", source.workItems);
  checkDuplicateIds("Dependency", source.dependencies);
  checkDuplicateIds("Resource", source.resources);
  checkDuplicateIds("Baseline", source.baselines);
  checkDuplicateIds("Evidence", source.evidence);
  checkDuplicateIds("Decision", source.decisions);
  checkDuplicateIds("ChangeSet", source.changeSets);
  checkDuplicateIds("Audit Gate", source.auditGates);
  checkDuplicateIds("Audit Decision", source.auditDecisions);

  const legacySourceRecords = [
    ...source.decisions,
    ...source.auditDecisions,
    ...source.auditGates,
    ...source.changeSets,
  ];
  const legacyIdCounts = new Map<Id, number>();
  for (const { id } of legacySourceRecords) {
    legacyIdCounts.set(id, (legacyIdCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of legacyIdCounts) {
    if (count > 1) {
      issues.push(`Duplicate LegacyAuditRecord ID ${id}.`);
    }
  }
  const generatedLegacyIds = new Map<Id, string>();
  for (const project of source.projects) {
    if (asRecord(project.shapeUpPitch) !== undefined) {
      generatedLegacyIds.set(
        shapeUpPitchRecordId(project.id),
        "shape-up pitch",
      );
    }
    if (sourceWasClosed(project)) {
      generatedLegacyIds.set(legacyClosureRecordId(project.id), "closure");
    }
  }
  for (const { id } of legacySourceRecords) {
    const generatedKind = generatedLegacyIds.get(id);
    if (generatedKind !== undefined) {
      issues.push(
        `LegacyAuditRecord ID ${id} collides with generated ${generatedKind} history.`,
      );
    }
  }

  const scopeIdsByProjectId = new Map<Id, Set<Id>>();
  for (const project of source.projects) {
    const pitch = asRecord(project.shapeUpPitch);
    const rawScopes = Array.isArray(pitch?.scopes) ? pitch.scopes : [];
    const legacyScopeIds = rawScopes.flatMap((value) => {
      const id = asRecord(value)?.id;
      return typeof id === "string" ? [id] : [];
    });
    const scopeIdCounts = new Map<Id, number>();
    for (const id of legacyScopeIds) {
      scopeIdCounts.set(id, (scopeIdCounts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of scopeIdCounts) {
      if (count > 1) {
        issues.push(
          `Duplicate Shape Up scope ID ${id} in Project ${project.id}.`,
        );
      }
      if (id === unscopedWorkId(project.id)) {
        issues.push(
          `Shape Up scope ID ${id} collides with generated unscoped migration scope for Project ${project.id}.`,
        );
      }
    }
    const scopeIds = new Set(legacyScopeIds);
    scopeIdsByProjectId.set(project.id, scopeIds);
    const legacyBet = asRecord(pitch?.bet);
    const auditDecisionId = legacyBet?.auditDecisionId;
    if (
      typeof auditDecisionId === "string" &&
      auditDecisionById.get(auditDecisionId)?.projectId !== project.id
    ) {
      issues.push(
        `Shape Up Bet for Project ${project.id} references missing same-project Audit Decision ${auditDecisionId}.`,
      );
    }
  }

  for (const workItem of source.workItems) {
    const project = projectById.get(workItem.projectId);
    if (project === undefined) {
      issues.push(
        `Work Item ${workItem.id} references missing Project ${workItem.projectId}.`,
      );
    }
    if (
      typeof workItem.parentId === "string" &&
      (workItemById.get(workItem.parentId)?.projectId !== workItem.projectId)
    ) {
      issues.push(
        `Work Item ${workItem.id} references missing parent Work Item ${workItem.parentId}.`,
      );
    }
    for (const assignment of workItem.assignmentIds) {
      if (!resourceById.has(assignment.resourceId)) {
        issues.push(
          `Work Item ${workItem.id} references missing Resource ${assignment.resourceId}.`,
        );
      }
    }
    if (
      typeof workItem.shapeUpScopeId === "string" &&
      !scopeIdsByProjectId.get(workItem.projectId)?.has(workItem.shapeUpScopeId)
    ) {
      issues.push(
        `Work Item ${workItem.id} references missing Shape Up scope ${workItem.shapeUpScopeId}.`,
      );
    }
    for (const [field, targetId] of [
      ["hammock start", workItem.hammockStartId],
      ["hammock finish", workItem.hammockFinishId],
    ] as const) {
      if (
        typeof targetId === "string" &&
        workItemById.get(targetId)?.projectId !== workItem.projectId
      ) {
        issues.push(
          `Work Item ${workItem.id} references missing ${field} Work Item ${targetId}.`,
        );
      }
    }
  }

  for (const dependency of source.dependencies) {
    if (!projectById.has(dependency.projectId)) {
      issues.push(
        `Dependency ${dependency.id} references missing Project ${dependency.projectId}.`,
      );
    }
    if (workItemById.get(dependency.fromId)?.projectId !== dependency.projectId) {
      issues.push(
        `Dependency ${dependency.id} references missing from Work Item ${dependency.fromId}.`,
      );
    }
    if (workItemById.get(dependency.toId)?.projectId !== dependency.projectId) {
      issues.push(
        `Dependency ${dependency.id} references missing to Work Item ${dependency.toId}.`,
      );
    }
  }

  for (const baseline of source.baselines) {
    if (!projectById.has(baseline.projectId)) {
      issues.push(
        `Baseline ${baseline.id} references missing Project ${baseline.projectId}.`,
      );
    }
    const plannedWorkItemIds = new Set([
      ...Object.keys(baseline.plannedStartByItem),
      ...Object.keys(baseline.plannedFinishByItem),
      ...Object.keys(baseline.plannedWorkSecondsByItem),
    ]);
    for (const workItemId of plannedWorkItemIds) {
      if (workItemById.get(workItemId)?.projectId !== baseline.projectId) {
        issues.push(
          `Baseline ${baseline.id} references missing planned Work Item ${workItemId}.`,
        );
      }
    }
    if (typeof baseline.approvedByDecisionId === "string") {
      const approval =
        decisionById.get(baseline.approvedByDecisionId) ??
        auditDecisionById.get(baseline.approvedByDecisionId);
      if (approval?.projectId !== baseline.projectId) {
        issues.push(
          `Baseline ${baseline.id} references missing approval Decision ${baseline.approvedByDecisionId}.`,
        );
      }
    }
  }

  source.actuals.forEach((actual, sourceIndex) => {
    if (!workItemById.has(actual.workItemId)) {
      issues.push(
        `Actual at source index ${sourceIndex} references missing Work Item ${actual.workItemId}.`,
      );
    }
  });

  for (const evidence of source.evidence) {
    if (!projectById.has(evidence.projectId)) {
      issues.push(
        `Evidence ${evidence.id} references missing Project ${evidence.projectId}.`,
      );
    }
    if (
      typeof evidence.workItemId === "string" &&
      workItemById.get(evidence.workItemId)?.projectId !== evidence.projectId
    ) {
      issues.push(
        `Evidence ${evidence.id} references missing Work Item ${evidence.workItemId}.`,
      );
    }
  }

  for (const decision of source.decisions) {
    if (!projectById.has(decision.projectId)) {
      issues.push(
        `Decision ${decision.id} references missing Project ${decision.projectId}.`,
      );
    }
    for (const evidenceId of decision.linkedEvidenceIds) {
      if (evidenceById.get(evidenceId)?.projectId !== decision.projectId) {
        issues.push(
          `Decision ${decision.id} references missing Evidence ${evidenceId}.`,
        );
      }
    }
  }

  for (const changeSet of source.changeSets) {
    if (!projectById.has(changeSet.projectId)) {
      issues.push(
        `ChangeSet ${changeSet.id} references missing Project ${changeSet.projectId}.`,
      );
    }
    for (const gateId of changeSet.auditGateIds) {
      if (auditGateById.get(gateId)?.projectId !== changeSet.projectId) {
        issues.push(
          `ChangeSet ${changeSet.id} references missing Audit Gate ${gateId}.`,
        );
      }
    }
  }

  for (const gate of source.auditGates) {
    if (!projectById.has(gate.projectId)) {
      issues.push(
        `Audit Gate ${gate.id} references missing Project ${gate.projectId}.`,
      );
    }
    const targetIsValid = (() => {
      switch (gate.targetType) {
        case "project":
          return gate.targetId === gate.projectId;
        case "baseline":
          return baselineById.get(gate.targetId)?.projectId === gate.projectId;
        case "milestone": {
          const item = workItemById.get(gate.targetId);
          return item?.projectId === gate.projectId && item.kind === "milestone";
        }
        case "scope":
        case "delivery":
          return workItemById.get(gate.targetId)?.projectId === gate.projectId;
      }
    })();
    if (!targetIsValid) {
      issues.push(
        `Audit Gate ${gate.id} references missing same-project ${gate.targetType} target ${gate.targetId}.`,
      );
    }
  }

  for (const decision of source.auditDecisions) {
    if (!projectById.has(decision.projectId)) {
      issues.push(
        `Audit Decision ${decision.id} references missing Project ${decision.projectId}.`,
      );
    }
    for (const gateId of decision.sourceGateIds) {
      if (auditGateById.get(gateId)?.projectId !== decision.projectId) {
        issues.push(
          `Audit Decision ${decision.id} references missing Audit Gate ${gateId}.`,
        );
      }
    }
  }

  issues.sort((left, right) => left.localeCompare(right));
  if (issues.length > 0) {
    throw new MigrationSourceError(issues);
  }
}

function legacyScopes(pitch: Record<string, unknown> | undefined): BetScope[] {
  const scopes = pitch?.scopes;
  if (!Array.isArray(scopes)) {
    return [];
  }
  const result: BetScope[] = [];
  for (const value of scopes) {
    const scope = asRecord(value);
    if (scope === undefined) {
      continue;
    }
    const id = scope.id;
    const title = scope.title;
    if (typeof id !== "string" || typeof title !== "string") {
      continue;
    }
    result.push({
      id,
      title,
      description:
        typeof scope.description === "string" ? scope.description : "",
    });
  }
  return result;
}

function buildDirectionBrief(
  project: Project,
  now: ISODate,
): DirectionBrief {
  const direction = asRecord(project.directionCard);
  const pitch = asRecord(project.shapeUpPitch);
  const pitchDays = positiveNumberField(pitch, "appetiteDays");
  const directionDays = positiveNumberField(direction, "timeboxDays");
  const appetiteDays = pitchDays || directionDays;
  const createdAt =
    canonicalTimestamp(pitch?.createdAt) ??
    canonicalTimestamp(project.start) ??
    now;
  const updatedAt = canonicalTimestamp(pitch?.updatedAt) ?? now;

  return {
    id: directionBriefId(project.id),
    projectId: project.id,
    version: 1,
    audienceAndProblem: labeledLines([
      ["Audience", stringField(direction, "targetUser")],
      ["Problem", stringField(direction, "userProblem")],
    ]),
    successEvidence: labeledLines([
      ["Success metric", stringField(direction, "successMetric")],
      ["Legacy Shape Up baseline", stringField(pitch, "successBaseline")],
    ]),
    appetiteSeconds: appetiteDays * WORKDAY_SECONDS,
    validationMethod: stringField(direction, "validationMethod"),
    firstScope: legacyScopes(pitch),
    noGoOrKill: labeledLines([
      ["No-go", stringField(pitch, "noGos")],
      ["Kill condition", stringField(direction, "failureCondition")],
    ]),
    advancedNotes: labeledLines([
      ["North star", project.northStar],
      ["Current outcome", project.currentOutcome],
      ["Business goal", stringField(direction, "businessGoal")],
      ["Core hypothesis", stringField(direction, "coreHypothesis")],
      ["Opportunity cost", stringField(direction, "opportunityCost")],
      ["Legacy Shape Up problem", stringField(pitch, "problem")],
      ["Legacy solution sketch", stringField(pitch, "solutionSketch")],
      ["Legacy rabbit holes", stringField(pitch, "rabbitHoles")],
      ["Legacy mode", project.mode],
      ["Legacy horizon", project.horizon],
      ["Legacy review cadence days", String(project.reviewCadenceDays)],
    ]),
    createdAt,
    updatedAt,
  };
}

function projectNotes(project: Project): string {
  return labeledLines([
    ["North star", project.northStar],
    ["Current outcome", project.currentOutcome],
    ["Legacy mode", project.mode],
    ["Legacy horizon", project.horizon],
    ["Legacy review cadence days", String(project.reviewCadenceDays)],
  ]);
}

function sourceWasArchived(project: Project): boolean {
  return project.status === "archived" || project.archived === true;
}

function sourceWasClosed(project: Project): boolean {
  return project.status === "done" || project.status === "archived";
}

function buildProject(
  project: Project,
  brief: DirectionBrief,
  options: MigrationOptions,
): ProjectV2 {
  const closed = sourceWasClosed(project);
  const stage = closed
    ? "closed"
    : isDirectionComplete(brief)
      ? "awaiting_bet"
      : "direction";
  const createdAt = canonicalTimestamp(project.start) ?? options.now;
  const result: ProjectV2 = {
    id: project.id,
    name: project.name,
    priority: project.priority,
    notes: projectNotes(project),
    stage,
    holds: closed
      ? []
      : [
          {
            type: "migration_review",
            sourceId: options.backupId,
            affectedRecordIds: [project.id, brief.id],
            createdAt: options.now,
          },
        ],
    activeDirectionBriefId: brief.id,
    createdAt,
    updatedAt: options.now,
  };
  if (closed) {
    result.legacyClosure = {
      sourceStatus: sourceWasArchived(project) ? "archived" : "done",
      legacyRecordId: legacyClosureRecordId(project.id),
      sourceChecksum: options.sourceChecksum,
    };
  }
  return result;
}

function cleanWorkItem(workItem: WorkItem): ProjectWorkItem {
  const result: ProjectWorkItem = {
    id: workItem.id,
    projectId: workItem.projectId,
    kind: workItem.kind,
    title: workItem.title,
    outline: workItem.outline,
    durationSeconds: workItem.durationSeconds,
    estimate: {
      mostLikelySeconds: workItem.estimate.mostLikelySeconds,
      ...(workItem.estimate.optimisticSeconds === undefined
        ? {}
        : { optimisticSeconds: workItem.estimate.optimisticSeconds }),
      ...(workItem.estimate.pessimisticSeconds === undefined
        ? {}
        : { pessimisticSeconds: workItem.estimate.pessimisticSeconds }),
    },
    assignmentIds: workItem.assignmentIds.map(
      ({ resourceId, attention, effortSeconds }) => ({
        resourceId,
        attention,
        effortSeconds,
      }),
    ),
    percentComplete: workItem.percentComplete,
    revision: 1,
    betScopeId:
      typeof workItem.shapeUpScopeId === "string"
        ? workItem.shapeUpScopeId
        : unscopedWorkId(workItem.projectId),
  };
  for (const field of [
    "parentId",
    "hammockStartId",
    "hammockFinishId",
  ] as const) {
    if (typeof workItem[field] === "string") result[field] = workItem[field];
  }
  for (const field of [
    "isKeyTask",
    "isScopeExpansion",
    "isFastDelivery",
    "evidenceRequired",
  ] as const) {
    if (typeof workItem[field] === "boolean") result[field] = workItem[field];
  }
  const rawConstraint = asRecord(workItem.constraint);
  if (rawConstraint !== undefined) {
    const constraint: NonNullable<ProjectWorkItem["constraint"]> = {};
    for (const field of [
      "noEarlierThan",
      "noLaterThan",
      "fixedStart",
      "fixedFinish",
    ] as const) {
      if (typeof rawConstraint[field] === "string") {
        constraint[field] = rawConstraint[field];
      }
    }
    result.constraint = constraint;
  }
  if (Array.isArray(workItem.splitSegments)) {
    result.splitSegments = workItem.splitSegments.map(
      ({ offsetSeconds, durationSeconds }) => ({
        offsetSeconds,
        durationSeconds,
      }),
    );
  }
  const rawRepeatRule = asRecord(workItem.repeatRule);
  if (rawRepeatRule !== undefined) {
    const repeatRule: NonNullable<ProjectWorkItem["repeatRule"]> = {
      count: rawRepeatRule.count as number,
    };
    if (
      rawRepeatRule.cadence === "every-n-days" ||
      rawRepeatRule.cadence === "weekly" ||
      rawRepeatRule.cadence === "monthly"
    ) {
      repeatRule.cadence = rawRepeatRule.cadence;
    }
    if (typeof rawRepeatRule.everyDays === "number") {
      repeatRule.everyDays = rawRepeatRule.everyDays;
    }
    if (
      rawRepeatRule.startMode === "fixed-time" ||
      rawRepeatRule.startMode === "after-previous-finish"
    ) {
      repeatRule.startMode = rawRepeatRule.startMode;
    }
    if (typeof rawRepeatRule.startAt === "string") {
      repeatRule.startAt = rawRepeatRule.startAt;
    }
    result.repeatRule = repeatRule;
  }
  return result;
}

function cleanActual(
  actual: Actual,
  sourceIndex: number,
): WorkspaceV2["actuals"][number] {
  const result: WorkspaceV2["actuals"][number] = {
    id: deterministicActualId(actual, sourceIndex),
    revision: 1,
    target: { kind: "work_item", workItemId: actual.workItemId },
    actualWorkSeconds: actual.actualWorkSeconds,
    remainingWorkSeconds: actual.remainingWorkSeconds,
    actualCost: actual.actualCost,
    recordedAt: actual.recordedAt,
  };
  const actualStart = canonicalTimestamp(actual.actualStart);
  const actualFinish = canonicalTimestamp(actual.actualFinish);
  if (actualStart !== undefined) {
    result.actualStart = actualStart;
  }
  if (actualFinish !== undefined) {
    result.actualFinish = actualFinish;
  }
  return result;
}

function cleanEvidence(evidence: Evidence): Evidence {
  return {
    id: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    projectId: evidence.projectId,
    createdAt: evidence.createdAt,
    confidence: evidence.confidence,
    tags: structuredClone(evidence.tags),
    ...(typeof evidence.url === "string" ? { url: evidence.url } : {}),
    ...(typeof evidence.localFileRef === "string"
      ? { localFileRef: evidence.localFileRef }
      : {}),
    ...(typeof evidence.workItemId === "string"
      ? { workItemId: evidence.workItemId }
      : {}),
  };
}

function cleanResource(resource: Resource): Resource {
  return {
    id: resource.id,
    name: resource.name,
    role: resource.role,
    capacityByAttention: {
      deep: resource.capacityByAttention.deep,
      medium: resource.capacityByAttention.medium,
      shallow: resource.capacityByAttention.shallow,
    },
    hourlyRate: resource.hourlyRate,
  };
}

function cleanAttentionCapacity(
  capacity: AttentionCapacity,
): AttentionCapacity {
  return {
    date: capacity.date,
    deepSeconds: capacity.deepSeconds,
    mediumSeconds: capacity.mediumSeconds,
    shallowSeconds: capacity.shallowSeconds,
    unavailableBlocks: capacity.unavailableBlocks.map(({ start, finish }) => ({
      start,
      finish,
    })),
  };
}

function cleanDependency(
  dependency: Dependency,
): WorkspaceV2["dependencies"][number] {
  return {
    id: dependency.id,
    projectId: dependency.projectId,
    fromId: dependency.fromId,
    toId: dependency.toId,
    type: dependency.type,
    lagSeconds: dependency.lagSeconds,
    revision: 1,
  };
}

function cleanBaseline(baseline: Baseline): Baseline {
  return {
    id: baseline.id,
    projectId: baseline.projectId,
    name: baseline.name,
    capturedAt: baseline.capturedAt,
    plannedStartByItem: structuredClone(baseline.plannedStartByItem),
    plannedFinishByItem: structuredClone(baseline.plannedFinishByItem),
    plannedWorkSecondsByItem: structuredClone(
      baseline.plannedWorkSecondsByItem,
    ),
    ...(typeof baseline.approvedByDecisionId === "string"
      ? { approvedByDecisionId: baseline.approvedByDecisionId }
      : {}),
  };
}

function legacyAuditRecord(
  source: { id: Id; projectId: Id },
  recordType: LegacyAuditRecord["recordType"],
  sourceChecksum: string,
): LegacyAuditRecord {
  return {
    id: source.id,
    projectId: source.projectId,
    recordType,
    sourcePayload: toJsonValue(source),
    sourceChecksum,
  };
}

function shapeUpRecord(
  project: Project,
  pitch: ShapeUpPitch,
  sourceChecksum: string,
): LegacyAuditRecord {
  return {
    id: shapeUpPitchRecordId(project.id),
    projectId: project.id,
    recordType: "shape_up_pitch",
    sourcePayload: toJsonValue(pitch),
    sourceChecksum,
  };
}

function closureRecord(
  project: Project,
  sourceChecksum: string,
): LegacyAuditRecord {
  const sourceStatus = sourceWasArchived(project) ? "archived" : "done";
  return {
    id: legacyClosureRecordId(project.id),
    projectId: project.id,
    recordType: "legacy_closure",
    sourcePayload: toJsonValue({
      projectId: project.id,
      sourceStatus,
      project,
    }),
    sourceChecksum,
  };
}

function entityCounts(source: WorkspaceSnapshot): Record<string, number> {
  return {
    projects: source.projects.length,
    workItems: source.workItems.length,
    dependencies: source.dependencies.length,
    resources: source.resources.length,
    capacities: source.capacities.length,
    baselines: source.baselines.length,
    actuals: source.actuals.length,
    evidence: source.evidence.length,
    decisions: source.decisions.length,
    changeSets: source.changeSets.length,
    auditGates: source.auditGates.length,
    auditDecisions: source.auditDecisions.length,
  };
}

export function migrateV1Workspace(
  sourceInput: WorkspaceSnapshot,
  optionsInput: MigrationOptions,
): MigratedV1Workspace {
  const source = structuredClone(sourceInput);
  const options = structuredClone(optionsInput);
  validateSourceReferences(source);

  const workspace = createEmptyWorkspaceV2(options.workspaceId);
  const deterministicIdMap: Record<string, Id> = {};
  const report: MigrationReport = { actualIdDerivations: [] };

  workspace.directionBriefs = source.projects.map((project) => {
    const brief = buildDirectionBrief(project, options.now);
    deterministicIdMap[`directionBrief:${project.id}`] = brief.id;
    return brief;
  });
  const briefsByProjectId = new Map(
    workspace.directionBriefs.map((brief) => [brief.projectId, brief]),
  );
  workspace.projects = source.projects.map((project) =>
    buildProject(project, briefsByProjectId.get(project.id)!, options),
  );
  workspace.workItems = source.workItems.map((workItem) => {
    const migrated = cleanWorkItem(workItem);
    deterministicIdMap[`workItemBetScope:${workItem.id}`] =
      migrated.betScopeId;
    return migrated;
  });
  workspace.dependencies = source.dependencies.map(cleanDependency);
  workspace.resources = source.resources.map(cleanResource);
  workspace.capacities = source.capacities.map(cleanAttentionCapacity);
  workspace.baselines = source.baselines.map(cleanBaseline);
  workspace.evidence = source.evidence.map(cleanEvidence);
  workspace.actuals = source.actuals.map((actual, sourceIndex) => {
    const derivationKey = actualDerivationKey(actual, sourceIndex);
    const actualId = deterministicActualId(actual, sourceIndex);
    deterministicIdMap[derivationKey] = actualId;
    report.actualIdDerivations.push({
      sourceIndex,
      workItemId: actual.workItemId,
      recordedAt: actual.recordedAt,
      derivationKey,
      actualId,
    });
    return cleanActual(actual, sourceIndex);
  });

  workspace.legacyAuditRecords = [
    ...source.decisions.map((record) =>
      legacyAuditRecord(record, "decision", options.sourceChecksum),
    ),
    ...source.auditDecisions.map((record) =>
      legacyAuditRecord(record, "audit_decision", options.sourceChecksum),
    ),
    ...source.auditGates.map((record) =>
      legacyAuditRecord(record, "audit_gate", options.sourceChecksum),
    ),
    ...source.changeSets.map((record) =>
      legacyAuditRecord(record, "change_set", options.sourceChecksum),
    ),
    ...source.projects.flatMap((project) => {
      const records: LegacyAuditRecord[] = [];
      if (asRecord(project.shapeUpPitch) !== undefined) {
        const id = shapeUpPitchRecordId(project.id);
        deterministicIdMap[`shapeUpPitch:${project.id}`] = id;
        records.push(
          shapeUpRecord(
            project,
            project.shapeUpPitch as ShapeUpPitch,
            options.sourceChecksum,
          ),
        );
      }
      if (sourceWasClosed(project)) {
        const id = legacyClosureRecordId(project.id);
        deterministicIdMap[`legacyClosure:${project.id}`] = id;
        records.push(closureRecord(project, options.sourceChecksum));
      }
      return records;
    }),
  ];
  workspace.visibility.archivedProjectIds = source.projects
    .filter(sourceWasArchived)
    .map(({ id }) => id);

  const migration: MigrationRecord = {
    sourceSchemaVersion: 1,
    sourceChecksum: options.sourceChecksum,
    backupId: options.backupId,
    backupChecksum: options.backupChecksum,
    migratedAt: options.now,
    entityCounts: entityCounts(source),
    deterministicIdMap,
  };
  workspace.migration = structuredClone(migration);

  return { workspace, migration, report };
}
