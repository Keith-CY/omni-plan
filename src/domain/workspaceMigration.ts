import type {
  ConversionHistoryEntry,
  PlanningMethod,
  Project,
  ProjectStage,
  RepeatRule,
  Todo,
  WorkItem,
  WorkspaceSnapshot
} from "./types";

export type { PlanningMethod, ProjectStage } from "./types";

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 3 as const;

export type WorkspaceSchemaVersion = 1 | 2 | 3;
export type MigratedTodoChecklistItem = Todo["checklist"][number];
export type MigratedTodo = Todo;
export type MigratedConversionHistoryEntry = ConversionHistoryEntry;

export type MigratedProject = Project & {
  planningMethod: PlanningMethod;
  stage: ProjectStage;
};

export type WorkspaceSchema3Snapshot = Omit<
  WorkspaceSnapshot,
  "schemaVersion" | "projects" | "todos" | "conversionHistory"
> & {
  schemaVersion: 3;
  projects: MigratedProject[];
  todos: MigratedTodo[];
  conversionHistory: MigratedConversionHistoryEntry[];
};

export type WorkspaceSchema2Snapshot = Omit<
  WorkspaceSchema3Snapshot,
  "schemaVersion" | "projects" | "todos" | "conversionHistory"
> & {
  projects: Array<Omit<Project, "planningMethod" | "stage">>;
};

export interface WorkspaceEnvelope<TVersion extends number, TSnapshot> {
  schemaVersion: TVersion;
  exportedAt?: string;
  baseFingerprint?: string;
  snapshot: TSnapshot;
}

export interface WorkspaceEntityCounts {
  projects: number;
  todos: number;
  workItems: number;
  recurringOccurrences: number;
  dependencies: number;
  conversionHistory: number;
}

export type WorkspaceIntegritySeverity = "error" | "warning";

export interface WorkspaceIntegrityIssue {
  severity: WorkspaceIntegritySeverity;
  code: string;
  path: string;
  message: string;
  entityId?: string;
}

export interface TodoRollbackMapping {
  todoId: string;
  workItemId: string;
  status: "open" | "completed";
}

export interface WorkspaceMigrationReport {
  direction: "upgrade" | "normalize" | "noop" | "downgrade";
  fromSchemaVersion: WorkspaceSchemaVersion;
  toSchemaVersion: WorkspaceSchemaVersion;
  applied: boolean;
  before: WorkspaceEntityCounts;
  after: WorkspaceEntityCounts;
  changes: string[];
  warnings: string[];
  integrityIssues: WorkspaceIntegrityIssue[];
  todoRollback?: {
    projectId: string;
    mappings: TodoRollbackMapping[];
    openTodoIds: string[];
  };
  omitted?: {
    conversionHistoryEntries: number;
    projectPlanningFields: number;
  };
}

export interface WorkspaceMigrationResult<TVersion extends WorkspaceSchemaVersion, TSnapshot> {
  envelope: WorkspaceEnvelope<TVersion, TSnapshot>;
  snapshot: TSnapshot;
  report: WorkspaceMigrationReport;
}

export interface WorkspaceDowngradeOptions {
  todoPolicy?: "rollback-project" | "reject";
}

export class UnsupportedWorkspaceSchemaError extends Error {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    const qualifier = schemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION ? "future" : "unsupported";
    super(`Cannot migrate ${qualifier} workspace schema ${schemaVersion}; this build supports schemas 1-${CURRENT_WORKSPACE_SCHEMA_VERSION}.`);
    this.name = "UnsupportedWorkspaceSchemaError";
    this.schemaVersion = schemaVersion;
  }
}

export class InvalidWorkspaceEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWorkspaceEnvelopeError";
  }
}

export class WorkspaceIntegrityError extends Error {
  readonly issues: WorkspaceIntegrityIssue[];

  constructor(issues: WorkspaceIntegrityIssue[]) {
    super(`Workspace migration failed integrity validation (${issues.filter((issue) => issue.severity === "error").length} errors).`);
    this.name = "WorkspaceIntegrityError";
    this.issues = issues;
  }
}

export class TodoDowngradeBlockedError extends Error {
  readonly todoIds: string[];

  constructor(todoIds: string[]) {
    super(`Schema 2 cannot represent ${todoIds.length} Todo records without an explicit rollback mapping.`);
    this.name = "TodoDowngradeBlockedError";
    this.todoIds = todoIds;
  }
}

/**
 * Upgrades schema 1/2 workspace files to the schema 3 domain model. The
 * function is deterministic and does not mutate the supplied envelope.
 */
export function migrateWorkspaceToSchema3(
  input: unknown
): WorkspaceMigrationResult<3, WorkspaceSchema3Snapshot> {
  const sourceEnvelope = parseWorkspaceEnvelope(input);
  const fromSchemaVersion = readSupportedSchemaVersion(sourceEnvelope.schemaVersion);
  const sourceSnapshot = requireRecord(sourceEnvelope.snapshot, "snapshot");
  const before = countEntities(sourceSnapshot);
  const snapshot = normalizeSchema3Snapshot(sourceSnapshot, sourceEnvelope.exportedAt);
  const integrityIssues = validateWorkspaceIntegrity(snapshot);
  rejectIntegrityErrors(integrityIssues);

  const envelope = {
    ...sourceEnvelope,
    schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    snapshot
  } as unknown as WorkspaceEnvelope<3, WorkspaceSchema3Snapshot>;
  const sourceAlreadyNormalized = fromSchemaVersion === 3 && jsonEqual(sourceSnapshot, snapshot);
  const changes = describeUpgradeChanges(sourceSnapshot, snapshot, fromSchemaVersion);

  return {
    envelope,
    snapshot,
    report: {
      direction: fromSchemaVersion < 3 ? "upgrade" : sourceAlreadyNormalized ? "noop" : "normalize",
      fromSchemaVersion,
      toSchemaVersion: 3,
      applied: !sourceAlreadyNormalized,
      before,
      after: countEntities(snapshot),
      changes,
      warnings: integrityIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      integrityIssues
    }
  };
}

/**
 * Produces a schema 2-compatible file. Todos are mapped to deterministic
 * rollback tasks by default, including completed Todos, so open captures can
 * never disappear merely because an older build is opened.
 */
export function downgradeWorkspaceToSchema2(
  input: unknown,
  options: WorkspaceDowngradeOptions = {}
): WorkspaceMigrationResult<2, WorkspaceSchema2Snapshot> {
  const sourceEnvelope = parseWorkspaceEnvelope(input);
  const fromSchemaVersion = readSupportedSchemaVersion(sourceEnvelope.schemaVersion);
  if (fromSchemaVersion !== 3) {
    throw new UnsupportedWorkspaceSchemaError(fromSchemaVersion);
  }

  const upgraded = migrateWorkspaceToSchema3(sourceEnvelope);
  const source = upgraded.snapshot;
  const todoPolicy = options.todoPolicy ?? "rollback-project";
  if (todoPolicy === "reject" && source.todos.length > 0) {
    throw new TodoDowngradeBlockedError(source.todos.map((todo) => todo.id));
  }

  const existingProjectIds = new Set(source.projects.map((project) => project.id));
  const existingWorkItemIds = new Set(source.workItems.map((item) => item.id));
  const rollbackProjectId = reserveId("p-schema3-todo-rollback", existingProjectIds);
  const mappings: TodoRollbackMapping[] = [];
  const rollbackTasks = source.todos.map((todo, index) => {
    const preferredId = existingWorkItemIds.has(todo.id) ? `w-todo-rollback-${safeIdPart(todo.id)}` : todo.id;
    const workItemId = reserveId(preferredId, existingWorkItemIds);
    mappings.push({ todoId: todo.id, workItemId, status: todo.status });
    return todoToRollbackTask(todo, rollbackProjectId, workItemId, index);
  });

  const legacyProjects = source.projects.map(stripSchema3ProjectFields);
  if (rollbackTasks.length > 0) {
    legacyProjects.push(createTodoRollbackProject(source, rollbackProjectId));
  }

  const {
    schemaVersion: _schemaVersion,
    todos: _todos,
    conversionHistory: _conversionHistory,
    projects: _projects,
    workItems: _workItems,
    ...sharedSnapshot
  } = source;
  const snapshot: WorkspaceSchema2Snapshot = {
    ...sharedSnapshot,
    projects: legacyProjects,
    workItems: [...source.workItems.map(cloneWorkItem), ...rollbackTasks]
  };
  const integrityIssues = validateWorkspaceIntegrity(snapshot);
  rejectIntegrityErrors(integrityIssues);
  assertOpenTodosMapped(source.todos, mappings);

  const envelope = {
    ...sourceEnvelope,
    schemaVersion: 2 as const,
    snapshot
  } as unknown as WorkspaceEnvelope<2, WorkspaceSchema2Snapshot>;
  const openTodoIds = source.todos.filter((todo) => todo.status === "open").map((todo) => todo.id);
  const projectPlanningFields = source.projects.reduce(
    (total, project) => total + Number("planningMethod" in project) + Number("stage" in project),
    0
  );

  return {
    envelope,
    snapshot,
    report: {
      direction: "downgrade",
      fromSchemaVersion: 3,
      toSchemaVersion: 2,
      applied: true,
      before: countEntities(source),
      after: countEntities(snapshot),
      changes: [
        "Changed the workspace file schema from 3 to 2.",
        ...(mappings.length > 0
          ? [`Mapped ${mappings.length} Todo records to tasks in rollback project ${rollbackProjectId}.`]
          : []),
        "Removed schema 3 project planning fields from the schema 2 projection."
      ],
      warnings: [
        ...integrityIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
        ...(source.conversionHistory.length > 0
          ? [`Schema 2 omits ${source.conversionHistory.length} conversion-history entries; retain the schema 3 source as the reversible backup.`]
          : [])
      ],
      integrityIssues,
      todoRollback: mappings.length > 0
        ? { projectId: rollbackProjectId, mappings, openTodoIds }
        : undefined,
      omitted: {
        conversionHistoryEntries: source.conversionHistory.length,
        projectPlanningFields
      }
    }
  };
}

/**
 * Checks graph references without rejecting intentionally historical links.
 * Historical references are warnings; live scheduling graph failures are
 * errors and block migration.
 */
export function validateWorkspaceIntegrity(snapshotInput: unknown): WorkspaceIntegrityIssue[] {
  const issues: WorkspaceIntegrityIssue[] = [];
  if (!isRecord(snapshotInput)) {
    return [{
      severity: "error",
      code: "invalid-snapshot",
      path: "snapshot",
      message: "Workspace snapshot must be an object."
    }];
  }

  const snapshot = snapshotInput;
  const projects = readRecordArrayForValidation(snapshot, "projects", issues);
  const workItems = readRecordArrayForValidation(snapshot, "workItems", issues);
  const todos = readRecordArrayForValidation(snapshot, "todos", issues);
  const conversionHistory = readRecordArrayForValidation(snapshot, "conversionHistory", issues);
  const dependencies = readRecordArrayForValidation(snapshot, "dependencies", issues);
  const occurrences = readRecordArrayForValidation(snapshot, "recurringOccurrences", issues);
  const baselines = readRecordArrayForValidation(snapshot, "baselines", issues);
  const actuals = readRecordArrayForValidation(snapshot, "actuals", issues);
  const evidence = readRecordArrayForValidation(snapshot, "evidence", issues);
  const decisions = readRecordArrayForValidation(snapshot, "decisions", issues);
  const changeSets = readRecordArrayForValidation(snapshot, "changeSets", issues);
  const auditGates = readRecordArrayForValidation(snapshot, "auditGates", issues);
  const auditDecisions = readRecordArrayForValidation(snapshot, "auditDecisions", issues);

  const projectIds = collectUniqueIds(projects, "projects", issues);
  const workItemIds = collectUniqueIds(workItems, "workItems", issues);
  collectUniqueIds(todos, "todos", issues);
  collectUniqueIds(conversionHistory, "conversionHistory", issues);
  const baselineIds = collectUniqueIds(baselines, "baselines", issues);
  const changeSetIds = collectUniqueIds(changeSets, "changeSets", issues);
  const baselineAuditTargetIds = new Set([...baselineIds, ...changeSetIds]);

  todos.forEach((todo, index) => {
    const todoId = stringValue(todo.id);
    if (!stringValue(todo.title).trim()) {
      issues.push({
        severity: "error",
        code: "missing-todo-title",
        path: `todos[${index}].title`,
        entityId: todoId,
        message: `Todo ${todoId || index} is missing a title.`
      });
    }
    if (todo.status !== "open" && todo.status !== "completed") {
      issues.push({
        severity: "error",
        code: "invalid-todo-status",
        path: `todos[${index}].status`,
        entityId: todoId,
        message: `Todo ${todoId || index} has unsupported status ${String(todo.status)}.`
      });
    }
    const checklist = Array.isArray(todo.checklist) ? todo.checklist.filter(isRecord) : [];
    collectUniqueIds(checklist, `todos[${index}].checklist`, issues);
  });

  const conversionTypes = new Set(["todo_to_task", "task_to_todo", "todo_to_project"]);
  conversionHistory.forEach((entry, index) => {
    const entryId = stringValue(entry.id);
    if (!conversionTypes.has(stringValue(entry.type))) {
      issues.push({
        severity: "error",
        code: "invalid-conversion-type",
        path: `conversionHistory[${index}].type`,
        entityId: entryId,
        message: `Conversion history ${entryId || index} has unsupported type ${String(entry.type)}.`
      });
    }
    if (!stringValue(entry.itemId)) {
      issues.push({
        severity: "error",
        code: "missing-conversion-item",
        path: `conversionHistory[${index}].itemId`,
        entityId: entryId,
        message: `Conversion history ${entryId || index} is missing its item id.`
      });
    }
    const projectId = stringValue(entry.projectId);
    if (projectId && !projectIds.has(projectId)) {
      issues.push({
        severity: "warning",
        code: "historical-conversion-project",
        path: `conversionHistory[${index}].projectId`,
        entityId: entryId,
        message: `Conversion history ${entryId || index} retains historical project ${projectId}.`
      });
    }
  });

  const workItemsById = new Map(workItems.flatMap((item) => typeof item.id === "string" ? [[item.id, item] as const] : []));
  workItems.forEach((item, index) => {
    const itemId = stringValue(item.id);
    const projectId = stringValue(item.projectId);
    requireReference(projectId, projectIds, issues, {
      code: "missing-work-item-project",
      path: `workItems[${index}].projectId`,
      entityId: itemId,
      label: "project"
    });
    const parentId = stringValue(item.parentId);
    if (parentId) {
      requireReference(parentId, workItemIds, issues, {
        code: "missing-parent",
        path: `workItems[${index}].parentId`,
        entityId: itemId,
        label: "parent work item"
      });
      const parent = workItemsById.get(parentId);
      if (parent && stringValue(parent.projectId) !== projectId) {
        issues.push({
          severity: "error",
          code: "cross-project-parent",
          path: `workItems[${index}].parentId`,
          entityId: itemId,
          message: `Work item ${itemId || index} and parent ${parentId} belong to different projects.`
        });
      }
    }
  });

  dependencies.forEach((dependency, index) => {
    const dependencyId = stringValue(dependency.id);
    const projectId = stringValue(dependency.projectId);
    requireReference(projectId, projectIds, issues, {
      code: "missing-dependency-project",
      path: `dependencies[${index}].projectId`,
      entityId: dependencyId,
      label: "project"
    });
    for (const endpoint of ["fromId", "toId"] as const) {
      const workItemId = stringValue(dependency[endpoint]);
      requireReference(workItemId, workItemIds, issues, {
        code: "missing-dependency-endpoint",
        path: `dependencies[${index}].${endpoint}`,
        entityId: dependencyId,
        label: "work item"
      });
      const workItem = workItemsById.get(workItemId);
      if (workItem && stringValue(workItem.projectId) !== projectId) {
        issues.push({
          severity: "error",
          code: "cross-project-dependency",
          path: `dependencies[${index}].${endpoint}`,
          entityId: dependencyId,
          message: `Dependency ${dependencyId || index} references work item ${workItemId} outside project ${projectId}.`
        });
      }
    }
  });

  occurrences.forEach((occurrence, index) => {
    const occurrenceId = stringValue(occurrence.id);
    requireReference(stringValue(occurrence.projectId), projectIds, issues, {
      code: "missing-occurrence-project",
      path: `recurringOccurrences[${index}].projectId`,
      entityId: occurrenceId,
      label: "project"
    });
    const workItemId = stringValue(occurrence.workItemId);
    if (!workItemId || occurrence.status === "scheduled") {
      requireReference(workItemId, workItemIds, issues, {
        code: "missing-occurrence-work-item",
        path: `recurringOccurrences[${index}].workItemId`,
        entityId: occurrenceId,
        label: "work item"
      });
    } else if (!workItemIds.has(workItemId)) {
      issues.push({
        severity: "warning",
        code: "historical-occurrence-work-item",
        path: `recurringOccurrences[${index}].workItemId`,
        entityId: occurrenceId,
        message: `Historical occurrence ${occurrenceId || index} retains work item ${workItemId}.`
      });
    }
  });

  baselines.forEach((baseline, index) => {
    requireReference(stringValue(baseline.projectId), projectIds, issues, {
      code: "missing-baseline-project",
      path: `baselines[${index}].projectId`,
      entityId: stringValue(baseline.id),
      label: "project"
    });
    for (const field of ["plannedStartByItem", "plannedFinishByItem", "plannedWorkSecondsByItem"] as const) {
      const values = isRecord(baseline[field]) ? baseline[field] : {};
      for (const itemId of Object.keys(values)) {
        if (!workItemIds.has(itemId)) {
          issues.push({
            severity: "warning",
            code: "historical-baseline-item",
            path: `baselines[${index}].${field}.${itemId}`,
            entityId: stringValue(baseline.id),
            message: `Baseline ${stringValue(baseline.id) || index} retains historical work item ${itemId}.`
          });
        }
      }
    }
  });

  actuals.forEach((actual, index) => historicalWorkItemReference(actual, "workItemId", `actuals[${index}].workItemId`, workItemIds, issues));
  evidence.forEach((item, index) => {
    liveProjectReference(item, index, "evidence", projectIds, issues);
    if (typeof item.workItemId === "string") {
      historicalWorkItemReference(item, "workItemId", `evidence[${index}].workItemId`, workItemIds, issues);
    }
  });
  decisions.forEach((item, index) => liveProjectReference(item, index, "decisions", projectIds, issues));
  changeSets.forEach((item, index) => {
    const projectId = stringValue(item.projectId);
    if (projectId && projectIds.has(projectId)) return;
    if (projectId && item.status !== "draft" && item.status !== "queued-audit") {
      issues.push({
        severity: "warning",
        code: "historical-change-set-project",
        path: `changeSets[${index}].projectId`,
        entityId: stringValue(item.id),
        message: `ChangeSet ${stringValue(item.id) || index} retains deleted project ${projectId}.`
      });
      return;
    }
    requireReference(projectId, projectIds, issues, {
      code: "missing-changeSets-project",
      path: `changeSets[${index}].projectId`,
      entityId: stringValue(item.id),
      label: "project"
    });
  });
  auditGates.forEach((item, index) => {
    liveProjectReference(item, index, "auditGates", projectIds, issues);
    if (item.targetType === "baseline") {
      requireReference(stringValue(item.targetId), baselineAuditTargetIds, issues, {
        code: "missing-audit-target",
        path: `auditGates[${index}].targetId`,
        entityId: stringValue(item.id),
        label: "baseline or baseline ChangeSet"
      });
    }
  });
  auditDecisions.forEach((item, index) => liveProjectReference(item, index, "auditDecisions", projectIds, issues));

  return issues;
}

function normalizeSchema3Snapshot(source: Record<string, unknown>, envelopeDate: unknown): WorkspaceSchema3Snapshot {
  const projects = recordArray(source.projects, "snapshot.projects").map(normalizeProject);
  const workItems = recordArray(source.workItems, "snapshot.workItems").map(normalizeWorkItem);
  const todos = recordArray(source.todos, "snapshot.todos", true).map((todo) => normalizeTodo(todo, envelopeDate));
  const conversionHistory = recordArray(source.conversionHistory, "snapshot.conversionHistory", true)
    .map(normalizeConversionHistoryEntry);

  return {
    ...source,
    schemaVersion: 3,
    timeZone: validTimeZone(source.timeZone) ? source.timeZone : "UTC",
    projects,
    workItems,
    todos,
    conversionHistory,
    recurringOccurrences: deduplicateById(recordArray(source.recurringOccurrences, "snapshot.recurringOccurrences", true)),
    dependencies: recordArray(source.dependencies, "snapshot.dependencies", true),
    resources: recordArray(source.resources, "snapshot.resources", true),
    capacities: recordArray(source.capacities, "snapshot.capacities", true),
    baselines: recordArray(source.baselines, "snapshot.baselines", true),
    actuals: recordArray(source.actuals, "snapshot.actuals", true),
    evidence: recordArray(source.evidence, "snapshot.evidence", true),
    decisions: recordArray(source.decisions, "snapshot.decisions", true),
    changeSets: recordArray(source.changeSets, "snapshot.changeSets", true),
    auditGates: recordArray(source.auditGates, "snapshot.auditGates", true),
    auditDecisions: recordArray(source.auditDecisions, "snapshot.auditDecisions", true)
  } as unknown as WorkspaceSchema3Snapshot;
}

function normalizeProject(project: Record<string, unknown>): MigratedProject {
  const normalized = { ...project };
  if (normalized.status === "archived") {
    normalized.status = "done";
    normalized.archived = true;
  } else if (normalized.archived === false) {
    delete normalized.archived;
    delete normalized.archivedAt;
  }

  const planningMethod: PlanningMethod = normalized.planningMethod === "shape-up" || normalized.planningMethod === "omniplan"
    ? normalized.planningMethod
    : isRecord(normalized.shapeUpPitch) ? "shape-up" : "omniplan";
  normalized.planningMethod = planningMethod;
  normalized.stage = validStageForMethod(normalized.stage, planningMethod)
    ? normalized.stage
    : inferProjectStage(normalized, planningMethod);
  return normalized as unknown as MigratedProject;
}

function normalizeWorkItem(item: Record<string, unknown>): WorkItem {
  const normalized = { ...item };
  if (isRecord(normalized.repeatRule)) {
    normalized.repeatRule = normalizeRepeatRule(stringValue(normalized.id), normalized.repeatRule);
  }
  return normalized as unknown as WorkItem;
}

function cloneWorkItem(item: WorkItem): WorkItem {
  return normalizeWorkItem(item as unknown as Record<string, unknown>);
}

function normalizeTodo(todo: Record<string, unknown>, envelopeDate: unknown): MigratedTodo {
  const capturedAt = stringValue(todo.capturedAt) || stringValue(envelopeDate) || "1970-01-01T00:00:00.000Z";
  const updatedAt = stringValue(todo.updatedAt) || capturedAt;
  const repeatRule = isRecord(todo.repeatRule)
    ? normalizeRepeatRule(stringValue(todo.id), todo.repeatRule)
    : undefined;
  const checklist = recordArray(todo.checklist, `todo.${stringValue(todo.id)}.checklist`, true).map((item) => ({
    ...item,
    id: stringValue(item.id),
    title: stringValue(item.title),
    completed: item.completed === true
  }));

  const normalized = {
    ...todo,
    id: stringValue(todo.id),
    title: stringValue(todo.title),
    tags: Array.isArray(todo.tags) ? todo.tags.filter((tag): tag is string => typeof tag === "string") : [],
    flagged: todo.flagged === true,
    ...(repeatRule ? { repeatRule } : {}),
    checklist,
    status: todo.status === "completed" ? "completed" : "open",
    capturedAt,
    updatedAt,
    inbox: todo.inbox !== false
  } as MigratedTodo;
  const repeatCompletedCount = finitePositiveInteger(todo.repeatCompletedCount);
  if (repeatRule && repeatCompletedCount !== undefined) normalized.repeatCompletedCount = repeatCompletedCount;
  else delete normalized.repeatCompletedCount;
  if (repeatRule && stringValue(todo.lastRepeatCompletedAt)) {
    normalized.lastRepeatCompletedAt = stringValue(todo.lastRepeatCompletedAt);
  } else {
    delete normalized.lastRepeatCompletedAt;
  }
  return normalized;
}

function normalizeConversionHistoryEntry(entry: Record<string, unknown>): MigratedConversionHistoryEntry {
  return {
    ...entry,
    id: stringValue(entry.id),
    type: entry.type as MigratedConversionHistoryEntry["type"],
    itemId: stringValue(entry.itemId),
    occurredAt: stringValue(entry.occurredAt),
    discardedFields: Array.isArray(entry.discardedFields)
      ? entry.discardedFields.filter((field): field is string => typeof field === "string")
      : []
  } as MigratedConversionHistoryEntry;
}

function normalizeRepeatRule(ownerId: string, rule: Record<string, unknown>): RepeatRule {
  const executionMode = rule.executionMode === "automatic" ? "automatic" : "manual";
  const count = typeof rule.count === "number" && Number.isFinite(rule.count) ? rule.count : 1;
  const automaticDurationSeconds = typeof rule.automaticDurationSeconds === "number" && Number.isFinite(rule.automaticDurationSeconds)
    ? rule.automaticDurationSeconds
    : 0;
  return {
    ...rule,
    id: stringValue(rule.id) || `repeat-${ownerId}`,
    executionMode,
    endMode: rule.endMode === "until" || rule.endMode === "never" ? rule.endMode : "count",
    startMode: executionMode === "automatic"
      ? "fixed-time"
      : rule.startMode === "after-previous-finish" ? "after-previous-finish" : "fixed-time",
    count: Math.max(1, Math.round(count || 1)),
    automaticDurationSeconds: Math.max(0, Math.round(automaticDurationSeconds))
  } as RepeatRule;
}

function inferProjectStage(project: Record<string, unknown>, planningMethod: PlanningMethod): ProjectStage {
  if (project.status === "done" || project.status === "archived" || project.archived === true) return "close";
  if (planningMethod === "shape-up") {
    const pitch = isRecord(project.shapeUpPitch) ? project.shapeUpPitch : undefined;
    return pitch && isRecord(pitch.bet) ? "build" : "shape";
  }
  if (project.mode === "explore") return "plan";
  if (project.mode === "ship") return "review";
  return "execute";
}

function validStageForMethod(stage: unknown, method: PlanningMethod): stage is ProjectStage {
  if (method === "shape-up") return ["shape", "bet", "build", "cool-down", "close"].includes(String(stage));
  return ["plan", "execute", "review", "close"].includes(String(stage));
}

function todoToRollbackTask(
  todo: MigratedTodo,
  projectId: string,
  workItemId: string,
  index: number
): WorkItem {
  const estimatedSeconds = finiteNonNegative(todo.estimatedSeconds) ?? 0;
  const constraint = {
    ...(todo.deferUntil ? { noEarlierThan: todo.deferUntil } : {}),
    ...(todo.dueAt ? { noLaterThan: todo.dueAt } : {})
  };
  return {
    id: workItemId,
    projectId,
    kind: "task",
    title: todo.title,
    description: todo.note,
    outline: `rollback-todo-${String(index + 1).padStart(6, "0")}`,
    durationSeconds: estimatedSeconds,
    estimate: { mostLikelySeconds: estimatedSeconds },
    ...(Object.keys(constraint).length > 0 ? { constraint } : {}),
    assignmentIds: [],
    percentComplete: todo.status === "completed" ? 100 : 0,
    ...(todo.repeatRule ? { repeatRule: { ...todo.repeatRule } } : {}),
    repeatCompletedCount: todo.repeatCompletedCount,
    lastRepeatCompletedAt: todo.lastRepeatCompletedAt,
    tags: [...todo.tags],
    flagged: todo.flagged,
    estimatedSeconds: todo.estimatedSeconds,
    deferUntil: todo.deferUntil,
    dueAt: todo.dueAt,
    checklist: todo.checklist.map((item) => ({ ...item })),
    plannedForDate: todo.plannedForDate,
    completedAt: todo.completedAt,
    capturedAt: todo.capturedAt,
    updatedAt: todo.updatedAt,
    inbox: todo.inbox,
    sourceTodoId: todo.id
  } as unknown as WorkItem;
}

function createTodoRollbackProject(
  source: WorkspaceSchema3Snapshot,
  projectId: string
): Omit<Project, "planningMethod" | "stage"> {
  const dates = [
    ...source.projects.flatMap((project) => [project.start, project.horizon]),
    ...source.todos.flatMap((todo) => [todo.capturedAt, todo.updatedAt, todo.deferUntil, todo.dueAt, todo.completedAt])
  ].filter((value): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value))).sort();
  const start = dates[0] ?? "1970-01-01T00:00:00.000Z";
  const horizon = dates[dates.length - 1] ?? start;
  const hasOpenTodos = source.todos.some((todo) => todo.status === "open");
  return {
    id: projectId,
    name: "Recovered Todos (schema 3 rollback)",
    status: hasOpenTodos ? "active" : "done",
    mode: "maintain",
    priority: source.projects.reduce((maximum, project) => Math.max(maximum, project.priority), 0) + 1,
    northStar: "Keep schema 3 Todos visible while this workspace is open in a schema 2 build.",
    currentOutcome: "Review the recovered tasks and migrate back to schema 3 when possible.",
    horizon,
    start,
    reviewCadenceDays: 7
  };
}

function stripSchema3ProjectFields(project: MigratedProject): Omit<Project, "planningMethod" | "stage"> {
  const record = { ...project } as Record<string, unknown>;
  delete record.planningMethod;
  delete record.stage;
  return record as unknown as Omit<Project, "planningMethod" | "stage">;
}

function assertOpenTodosMapped(todos: MigratedTodo[], mappings: TodoRollbackMapping[]): void {
  const mappedIds = new Set(mappings.map((mapping) => mapping.todoId));
  const missingOpenTodos = todos.filter((todo) => todo.status === "open" && !mappedIds.has(todo.id));
  if (missingOpenTodos.length > 0) {
    throw new TodoDowngradeBlockedError(missingOpenTodos.map((todo) => todo.id));
  }
}

function describeUpgradeChanges(
  source: Record<string, unknown>,
  snapshot: WorkspaceSchema3Snapshot,
  fromVersion: WorkspaceSchemaVersion
): string[] {
  const changes: string[] = [];
  if (fromVersion < 3) changes.push(`Changed the workspace file schema from ${fromVersion} to 3.`);
  if (!validTimeZone(source.timeZone)) changes.push("Defaulted an absent or invalid workspace time zone to UTC.");
  const sourceProjects = Array.isArray(source.projects) ? source.projects.filter(isRecord) : [];
  const inferredPlanningMethods = sourceProjects.filter((project) => project.planningMethod !== "omniplan" && project.planningMethod !== "shape-up").length;
  if (inferredPlanningMethods > 0) changes.push(`Inferred planning method and stage for ${inferredPlanningMethods} projects.`);
  const normalizedRules = snapshot.workItems.filter((item, index) => {
    const sourceItem = Array.isArray(source.workItems) && isRecord(source.workItems[index]) ? source.workItems[index] : undefined;
    return Boolean(item.repeatRule) && !jsonEqual(sourceItem?.repeatRule, item.repeatRule);
  }).length;
  if (normalizedRules > 0) changes.push(`Normalized ${normalizedRules} recurring work-item rules.`);
  if (!Array.isArray(source.todos)) changes.push("Initialized the Todo collection.");
  if (!Array.isArray(source.conversionHistory)) changes.push("Initialized Todo conversion history.");
  if (changes.length === 0 && !jsonEqual(source, snapshot)) changes.push("Normalized schema 3 workspace defaults.");
  return changes;
}

function parseWorkspaceEnvelope(input: unknown): Record<string, unknown> {
  let parsed = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new InvalidWorkspaceEnvelopeError("Workspace migration input is not valid JSON.");
    }
  }
  const envelope = requireRecord(parsed, "workspace envelope");
  if (!("schemaVersion" in envelope)) {
    throw new InvalidWorkspaceEnvelopeError("Workspace envelope is missing schemaVersion.");
  }
  if (!("snapshot" in envelope)) {
    throw new InvalidWorkspaceEnvelopeError("Workspace envelope is missing snapshot.");
  }
  return envelope;
}

function readSupportedSchemaVersion(value: unknown): WorkspaceSchemaVersion {
  if (typeof value !== "number" || !Number.isInteger(value) || ![1, 2, 3].includes(value)) {
    throw new UnsupportedWorkspaceSchemaError(typeof value === "number" ? value : Number.NaN);
  }
  return value as WorkspaceSchemaVersion;
}

function rejectIntegrityErrors(issues: WorkspaceIntegrityIssue[]): void {
  if (issues.some((issue) => issue.severity === "error")) throw new WorkspaceIntegrityError(issues);
}

function countEntities(snapshot: Record<string, unknown>): WorkspaceEntityCounts {
  return {
    projects: arrayLength(snapshot.projects),
    todos: arrayLength(snapshot.todos),
    workItems: arrayLength(snapshot.workItems),
    recurringOccurrences: arrayLength(snapshot.recurringOccurrences),
    dependencies: arrayLength(snapshot.dependencies),
    conversionHistory: arrayLength(snapshot.conversionHistory)
  };
}

function recordArray(value: unknown, path: string, optional = false): Record<string, unknown>[] {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new InvalidWorkspaceEnvelopeError(`${path} must be an array.`);
  return value.map((item, index) => requireRecord(item, `${path}[${index}]`));
}

function deduplicateById(records: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  const withoutIds: Record<string, unknown>[] = [];
  records.forEach((record) => {
    const id = stringValue(record.id);
    if (id) byId.set(id, { ...record });
    else withoutIds.push({ ...record });
  });
  return [...byId.values(), ...withoutIds].sort((left, right) => stringValue(left.id).localeCompare(stringValue(right.id)));
}

function readRecordArrayForValidation(
  snapshot: Record<string, unknown>,
  key: string,
  issues: WorkspaceIntegrityIssue[]
): Record<string, unknown>[] {
  const value = snapshot[key];
  if (value === undefined && (key === "todos" || key === "conversionHistory")) return [];
  if (!Array.isArray(value)) {
    issues.push({
      severity: "error",
      code: "invalid-collection",
      path: key,
      message: `Workspace ${key} must be an array.`
    });
    return [];
  }
  return value.flatMap((item, index) => {
    if (isRecord(item)) return [item];
    issues.push({
      severity: "error",
      code: "invalid-entity",
      path: `${key}[${index}]`,
      message: `Workspace ${key}[${index}] must be an object.`
    });
    return [];
  });
}

function collectUniqueIds(
  records: Record<string, unknown>[],
  collection: string,
  issues: WorkspaceIntegrityIssue[]
): Set<string> {
  const ids = new Set<string>();
  records.forEach((record, index) => {
    const id = stringValue(record.id);
    if (!id) {
      issues.push({
        severity: "error",
        code: "missing-id",
        path: `${collection}[${index}].id`,
        message: `${collection}[${index}] is missing an id.`
      });
    } else if (ids.has(id)) {
      issues.push({
        severity: "error",
        code: "duplicate-id",
        path: `${collection}[${index}].id`,
        entityId: id,
        message: `${collection} contains duplicate id ${id}.`
      });
    } else {
      ids.add(id);
    }
  });
  return ids;
}

function requireReference(
  id: string,
  ids: Set<string>,
  issues: WorkspaceIntegrityIssue[],
  context: { code: string; path: string; entityId?: string; label: string }
): void {
  if (id && ids.has(id)) return;
  issues.push({
    severity: "error",
    code: context.code,
    path: context.path,
    entityId: context.entityId,
    message: `${context.path} references missing ${context.label} ${id || "(empty)"}.`
  });
}

function historicalWorkItemReference(
  record: Record<string, unknown>,
  key: string,
  path: string,
  workItemIds: Set<string>,
  issues: WorkspaceIntegrityIssue[]
): void {
  const workItemId = stringValue(record[key]);
  if (workItemId && !workItemIds.has(workItemId)) {
    issues.push({
      severity: "warning",
      code: "historical-work-item-reference",
      path,
      entityId: stringValue(record.id),
      message: `${path} retains historical work item ${workItemId}.`
    });
  }
}

function liveProjectReference(
  record: Record<string, unknown>,
  index: number,
  collection: string,
  projectIds: Set<string>,
  issues: WorkspaceIntegrityIssue[]
): void {
  requireReference(stringValue(record.projectId), projectIds, issues, {
    code: `missing-${collection}-project`,
    path: `${collection}[${index}].projectId`,
    entityId: stringValue(record.id),
    label: "project"
  });
}

function reserveId(preferred: string, occupied: Set<string>): string {
  let candidate = preferred;
  let suffix = 2;
  while (occupied.has(candidate)) {
    candidate = `${preferred}-${suffix}`;
    suffix += 1;
  }
  occupied.add(candidate);
  return candidate;
}

function safeIdPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return safe || "untitled";
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function finitePositiveInteger(value: unknown): number | undefined {
  const normalized = finiteNonNegative(value);
  return normalized !== undefined && normalized > 0 ? normalized : undefined;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidWorkspaceEnvelopeError(`${path} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
