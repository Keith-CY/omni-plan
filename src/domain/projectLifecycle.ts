import type {
  ConversionHistoryEntry,
  OmniPlanStage,
  PlanningMethod,
  Project,
  ProjectStage,
  ProjectStatus,
  RepeatRule,
  ShapeUpStage,
  Todo,
  WorkItem,
  WorkspaceSnapshot
} from "./types";

export const selectableProjectStatuses: ProjectStatus[] = ["active", "waiting", "paused", "done"];
export const omniPlanStages: OmniPlanStage[] = ["plan", "execute", "review", "close"];
export const shapeUpStages: ShapeUpStage[] = ["shape", "bet", "build", "cool-down", "close"];

export function isProjectArchived(project: Project): boolean {
  return Boolean(project.archived || project.status === "archived");
}

export function projectLifecycleStatus(project: Project): ProjectStatus {
  return project.status === "archived" ? "done" : project.status;
}

export function projectLifecycleLabel(project: Project): string {
  const status = projectLifecycleStatus(project);
  return isProjectArchived(project) ? `${status} / archived` : status;
}

export function normalizeProjectLifecycle(project: Project): Project {
  const planned = normalizeProjectPlanning(project);
  if (planned.status !== "archived" && planned.archived !== false) return planned;
  if (planned.status === "archived") {
    return { ...planned, status: "done", archived: true };
  }
  const next: Project = { ...planned };
  delete next.archived;
  delete next.archivedAt;
  return next;
}

export function projectPlanningMethod(project: Project): PlanningMethod {
  if (project.shapeUpPitch || project.planningMethod === "shape-up") return "shape-up";
  return "omniplan";
}

export function projectStage(project: Project): ProjectStage {
  const method = projectPlanningMethod(project);
  if (method === "shape-up") {
    if (shapeUpStages.includes(project.stage as ShapeUpStage)) return project.stage as ShapeUpStage;
    return project.shapeUpPitch?.bet ? "build" : "shape";
  }
  if (omniPlanStages.includes(project.stage as OmniPlanStage)) return project.stage as OmniPlanStage;
  return "plan";
}

export function normalizeProjectPlanning(project: Project): Project {
  return {
    ...project,
    planningMethod: projectPlanningMethod(project),
    stage: projectStage(project)
  };
}

/** Planning method is an identity decision: callers may fill legacy metadata, never switch it. */
export function withProjectPlanningMethod(project: Project, method: PlanningMethod): Project | undefined {
  if (projectPlanningMethod(project) !== method) return undefined;
  return normalizeProjectPlanning(project);
}

export function normalizeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const legacy = snapshot as WorkspaceSnapshot & {
    schemaVersion?: number;
    timeZone?: string;
    todos?: Todo[];
    conversionHistory?: ConversionHistoryEntry[];
    recurringOccurrences?: WorkspaceSnapshot["recurringOccurrences"];
  };
  return {
    ...snapshot,
    schemaVersion: 3,
    timeZone: validTimeZone(legacy.timeZone) ? legacy.timeZone : "UTC",
    todos: deduplicateTodos(legacy.todos ?? []),
    conversionHistory: deduplicateConversionHistory(legacy.conversionHistory ?? []),
    projects: (snapshot.projects ?? []).map(normalizeProjectLifecycle),
    workItems: (snapshot.workItems ?? []).map(normalizeRecurringWorkItem),
    recurringOccurrences: deduplicateOccurrences(legacy.recurringOccurrences ?? [])
  };
}

function deduplicateTodos(records: Todo[]): Todo[] {
  const byId = new Map(records.map((todo) => [todo.id, normalizeTodoRecord(todo)]));
  return [...byId.values()];
}

function normalizeTodoRecord(todo: Todo): Todo {
  const legacy = todo as Todo & {
    tags?: string[];
    flagged?: boolean;
    checklist?: Todo["checklist"];
    status?: Todo["status"];
    inbox?: boolean;
    repeatCompletedCount?: number;
    lastRepeatCompletedAt?: string;
  };
  const status = legacy.status === "completed" ? "completed" : "open";
  const tags = [...new Set((legacy.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  const repeatRule = todo.repeatRule ? normalizeRepeatRule(todo.id, todo.repeatRule) : undefined;
  const organized = Boolean(
    tags.length || legacy.flagged || todo.deferUntil || todo.dueAt || todo.plannedForDate || repeatRule
  );
  const normalized: Todo = {
    ...todo,
    tags,
    flagged: Boolean(legacy.flagged),
    checklist: (legacy.checklist ?? []).map((item) => ({ ...item })),
    status,
    inbox: status === "completed" ? false : legacy.inbox ?? !organized,
    ...(repeatRule ? { repeatRule } : {})
  };
  const repeatCompletedCount = finitePositiveInteger(legacy.repeatCompletedCount);
  if (repeatRule && repeatCompletedCount !== undefined) normalized.repeatCompletedCount = repeatCompletedCount;
  else delete normalized.repeatCompletedCount;
  if (repeatRule && typeof legacy.lastRepeatCompletedAt === "string" && legacy.lastRepeatCompletedAt) {
    normalized.lastRepeatCompletedAt = legacy.lastRepeatCompletedAt;
  } else {
    delete normalized.lastRepeatCompletedAt;
  }
  return normalized;
}

function deduplicateConversionHistory(records: ConversionHistoryEntry[]): ConversionHistoryEntry[] {
  const byId = new Map(records.map((entry) => [entry.id, {
    ...entry,
    discardedFields: [...new Set(entry.discardedFields ?? [])].sort()
  }]));
  return [...byId.values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)
  );
}

function deduplicateOccurrences(records: WorkspaceSnapshot["recurringOccurrences"]): WorkspaceSnapshot["recurringOccurrences"] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeRecurringWorkItem(item: WorkItem): WorkItem {
  if (!item.repeatRule) return item;
  return { ...item, repeatRule: normalizeRepeatRule(item.id, item.repeatRule) };
}

export function normalizeRepeatRule(workItemId: string, rule: RepeatRule): RepeatRule {
  const executionMode = rule.executionMode ?? "manual";
  return {
    ...rule,
    id: rule.id ?? `repeat-${workItemId}`,
    executionMode,
    endMode: rule.endMode ?? "count",
    startMode: executionMode === "automatic" ? "fixed-time" : rule.startMode ?? "fixed-time",
    count: Math.max(1, Math.round(rule.count || 1)),
    automaticDurationSeconds: Math.max(0, Math.round(rule.automaticDurationSeconds ?? 0))
  };
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

function finitePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : undefined;
}

export function canDeleteEmptyProject(snapshot: WorkspaceSnapshot, projectId: string): boolean {
  return snapshot.projects.some((project) => project.id === projectId) &&
    !snapshot.workItems.some((item) => item.projectId === projectId) &&
    !snapshot.recurringOccurrences.some((occurrence) => occurrence.projectId === projectId);
}

export function removeEmptyProjectFromWorkspace(snapshot: WorkspaceSnapshot, projectId: string): WorkspaceSnapshot | undefined {
  if (!canDeleteEmptyProject(snapshot, projectId)) return undefined;

  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => project.id !== projectId),
    dependencies: snapshot.dependencies.filter((dependency) => dependency.projectId !== projectId),
    baselines: snapshot.baselines.filter((baseline) => baseline.projectId !== projectId),
    evidence: snapshot.evidence.filter((item) => item.projectId !== projectId),
    decisions: snapshot.decisions.filter((decision) => decision.projectId !== projectId),
    changeSets: snapshot.changeSets.filter((changeSet) =>
      changeSet.projectId !== projectId || (changeSet.status !== "draft" && changeSet.status !== "queued-audit")
    ),
    auditGates: snapshot.auditGates.filter((gate) => gate.projectId !== projectId),
    auditDecisions: snapshot.auditDecisions.filter((decision) => decision.projectId !== projectId)
  };
}

export function withProjectLifecycleStatus(project: Project, status: ProjectStatus): Project {
  const normalized = normalizeProjectLifecycle(project);
  if (status === "archived") {
    return { ...normalized, status: "done", archived: true };
  }
  const next: Project = { ...normalized, status };
  delete next.archived;
  delete next.archivedAt;
  return next;
}

export function withProjectArchived(project: Project, archivedAt: string): Project {
  const normalized = normalizeProjectLifecycle(project);
  return {
    ...normalized,
    archived: true,
    archivedAt
  };
}

export function withProjectRestored(project: Project): Project {
  return withProjectLifecycleStatus(project, projectLifecycleStatus(project));
}
