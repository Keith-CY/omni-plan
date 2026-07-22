import { scheduleProject } from "./scheduler";
import { addSeconds } from "./time";
import type {
  Dependency,
  Id,
  Project,
  ScheduleResult,
  ShapeUpAppetiteKind,
  ShapeUpPitch,
  ShapeUpScope,
  WorkItem
} from "./types";

export const shapeUpAppetiteDays: Record<ShapeUpAppetiteKind, number> = {
  "small-batch": 14,
  "big-batch": 42
};

export function createShapeUpPitch({
  problem,
  appetiteKind = "small-batch",
  solutionSketch = "",
  rabbitHoles = "",
  noGos = "",
  successBaseline = "",
  scopes = [],
  now
}: {
  problem: string;
  appetiteKind?: ShapeUpAppetiteKind;
  solutionSketch?: string;
  rabbitHoles?: string;
  noGos?: string;
  successBaseline?: string;
  scopes?: ShapeUpScope[];
  now: string;
}): ShapeUpPitch {
  return {
    problem: problem.trim(),
    appetiteKind,
    appetiteDays: shapeUpAppetiteDays[appetiteKind],
    solutionSketch: solutionSketch.trim(),
    rabbitHoles: rabbitHoles.trim(),
    noGos: noGos.trim(),
    successBaseline: successBaseline.trim(),
    scopes,
    createdAt: now,
    updatedAt: now
  };
}

export function shapeUpFieldCompleteness(pitch?: ShapeUpPitch): Record<"problem" | "appetite" | "solution" | "rabbitHoles" | "noGos" | "successBaseline" | "scope", boolean> {
  return {
    problem: Boolean(pitch?.problem.trim()),
    appetite: Boolean(pitch && pitch.appetiteDays > 0),
    solution: Boolean(pitch?.solutionSketch.trim()),
    rabbitHoles: Boolean(pitch?.rabbitHoles.trim()),
    noGos: Boolean(pitch?.noGos.trim()),
    successBaseline: Boolean(pitch?.successBaseline.trim()),
    scope: Boolean(pitch?.scopes.some((scope) => scope.confirmed && scope.title.trim()))
  };
}

export function isShapeUpPitchComplete(pitch?: ShapeUpPitch): boolean {
  return Object.values(shapeUpFieldCompleteness(pitch)).every(Boolean);
}

export function isShapeUpProject(project: Project): boolean {
  return Boolean(project.shapeUpPitch);
}

export function isShapeUpBet(project: Project): boolean {
  return Boolean(project.shapeUpPitch?.bet && project.status === "active");
}

export function confirmedShapeUpScopes(project: Project): ShapeUpScope[] {
  return project.shapeUpPitch?.scopes.filter((scope) => scope.confirmed && scope.title.trim()) ?? [];
}

/**
 * A confirmed Bet releases only existing tasks assigned to confirmed scopes.
 * Proposed scopes, other projects, and non-task planning records remain locked.
 */
export function unlockShapeUpTasksForBet(project: Project, workItems: WorkItem[]): WorkItem[] {
  if (!isShapeUpBet(project)) return workItems;
  const confirmedScopeIds = new Set(confirmedShapeUpScopes(project).map(({ id }) => id));
  if (!confirmedScopeIds.size) return workItems;

  return workItems.map((item) => {
    if (
      item.projectId !== project.id ||
      item.kind !== "task" ||
      !item.shapeUpScopeId ||
      !confirmedScopeIds.has(item.shapeUpScopeId) ||
      item.shapeUpLocked === undefined
    ) {
      return item;
    }
    const unlocked = { ...item };
    delete unlocked.shapeUpLocked;
    return unlocked;
  });
}

export function canBetShapeUpProject(project: Project): boolean {
  return Boolean(project.shapeUpPitch && project.status === "waiting" && isShapeUpPitchComplete(project.shapeUpPitch));
}

export function shapeUpMissingBetRequirements(project: Project): string[] {
  const completeness = shapeUpFieldCompleteness(project.shapeUpPitch);
  const labels: Array<[keyof typeof completeness, string]> = [
    ["problem", "Problem"],
    ["appetite", "Appetite"],
    ["solution", "Solution sketch"],
    ["rabbitHoles", "Rabbit holes"],
    ["noGos", "No-gos"],
    ["successBaseline", "Success baseline"],
    ["scope", "At least one confirmed scope"]
  ];
  return labels.filter(([field]) => !completeness[field]).map(([, label]) => label);
}

export function shapeUpScopeStatus(scope: ShapeUpScope): "uphill" | "crest" | "downhill" | "done" {
  if (scope.hillPosition >= 100) return "done";
  if (scope.hillPosition > 50) return "downhill";
  if (scope.hillPosition === 50) return "crest";
  return "uphill";
}

export function isShapeUpScopeDownhill(scope?: ShapeUpScope): boolean {
  return Boolean(scope && scope.confirmed && scope.hillPosition > 50);
}

export function isShapeUpCycleExpired(project: Project, now: string): boolean {
  const breaker = project.shapeUpPitch?.bet?.circuitBreakerAt;
  return Boolean(project.status === "active" && breaker && breaker < now);
}

export function shapeUpCycleEnd(project: Project): string | undefined {
  return project.shapeUpPitch?.bet?.cycleEnd;
}

export function isExecutableWorkItem(project: Project, item: WorkItem): boolean {
  if (!project.shapeUpPitch) return true;
  if (!isShapeUpBet(project)) return false;
  if (item.isShapeUpCycleMarker) return true;
  if (item.shapeUpLocked === true) return false;
  if (!item.shapeUpScopeId) return false;
  const scope = project.shapeUpPitch.scopes.find((candidate) => candidate.id === item.shapeUpScopeId);
  return isShapeUpScopeDownhill(scope);
}

export function executableWorkItemsForProject(project: Project, items: WorkItem[]): WorkItem[] {
  return items.filter((item) => item.projectId === project.id && isExecutableWorkItem(project, item));
}

export function executableDependenciesForItems(dependencies: Dependency[], items: WorkItem[]): Dependency[] {
  const ids = new Set<Id>(items.map((item) => item.id));
  return dependencies.filter((dependency) => ids.has(dependency.fromId) && ids.has(dependency.toId));
}

export function scheduleShapeUpAwareProject(project: Project, items: WorkItem[], dependencies: Dependency[]): ScheduleResult {
  if (!project.shapeUpPitch) return scheduleProject(project, items, dependencies);

  const executableItems = executableWorkItemsForProject(project, items);
  if (!isShapeUpBet(project)) {
    return {
      projectId: project.id,
      items: [],
      diagnostics: [{
        severity: "warning",
        message: "Shape Up project is waiting for a human-approved Betting Gate before execution scheduling."
      }],
      unsupported: []
    };
  }

  if (!executableItems.length) {
    return {
      projectId: project.id,
      items: [],
      diagnostics: [{
        severity: "warning",
        message: "No downhill Shape Up scope is ready for the Gantt execution network."
      }],
      unsupported: []
    };
  }

  return scheduleProject(project, executableItems, executableDependenciesForItems(dependencies, executableItems));
}

export function scheduleShapeUpAwarePortfolio(projects: Project[], items: WorkItem[], dependencies: Dependency[]): ScheduleResult[] {
  return projects.map((project) => scheduleShapeUpAwareProject(project, items, dependencies));
}

export function buildShapeUpBet(project: Project, auditDecisionId: Id, approvedAt: string) {
  const cycleStart = approvedAt;
  const cycleEnd = addSeconds(cycleStart, (project.shapeUpPitch?.appetiteDays ?? shapeUpAppetiteDays["small-batch"]) * 24 * 60 * 60);
  return {
    approvedAt,
    auditDecisionId,
    cycleStart,
    cycleEnd,
    circuitBreakerAt: cycleEnd,
    summary: `Bet ${project.name} for ${project.shapeUpPitch?.appetiteDays ?? shapeUpAppetiteDays["small-batch"]} days with fixed time and variable scope.`
  };
}
