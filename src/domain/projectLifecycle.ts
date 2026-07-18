import type { Project, ProjectStatus, RepeatRule, WorkItem, WorkspaceSnapshot } from "./types";

export const selectableProjectStatuses: ProjectStatus[] = ["active", "waiting", "paused", "done"];

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
  if (project.status !== "archived" && project.archived !== false) return project;
  if (project.status === "archived") {
    return { ...project, status: "done", archived: true };
  }
  const next: Project = { ...project };
  delete next.archived;
  delete next.archivedAt;
  return next;
}

export function normalizeWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const legacy = snapshot as WorkspaceSnapshot & {
    timeZone?: string;
    recurringOccurrences?: WorkspaceSnapshot["recurringOccurrences"];
  };
  return {
    ...snapshot,
    timeZone: validTimeZone(legacy.timeZone) ? legacy.timeZone : "UTC",
    projects: (snapshot.projects ?? []).map(normalizeProjectLifecycle),
    workItems: (snapshot.workItems ?? []).map(normalizeRecurringWorkItem),
    recurringOccurrences: deduplicateOccurrences(legacy.recurringOccurrences ?? [])
  };
}

function deduplicateOccurrences(records: WorkspaceSnapshot["recurringOccurrences"]): WorkspaceSnapshot["recurringOccurrences"] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeRecurringWorkItem(item: WorkItem): WorkItem {
  if (!item.repeatRule) return item;
  return { ...item, repeatRule: normalizeRepeatRule(item.id, item.repeatRule) };
}

function normalizeRepeatRule(workItemId: string, rule: RepeatRule): RepeatRule {
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
