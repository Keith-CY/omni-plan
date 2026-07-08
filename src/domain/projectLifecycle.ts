import type { Project, ProjectStatus, WorkspaceSnapshot } from "./types";

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
  return {
    ...snapshot,
    projects: snapshot.projects.map(normalizeProjectLifecycle)
  };
}

export function canDeleteEmptyProject(snapshot: WorkspaceSnapshot, projectId: string): boolean {
  return snapshot.projects.some((project) => project.id === projectId) && !snapshot.workItems.some((item) => item.projectId === projectId);
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
