import type { Dependency, Project, ScheduleResult, WorkItem } from "@/domain/types";

export type HorizonMode = "simple" | "managed";
export type LifeArea = "work" | "home" | "growth";

export interface HorizonSignals {
  mode: HorizonMode;
  hasDeadline: boolean;
  dependencyCount: number;
  hasDelayRisk: boolean;
  delayRiskLevel: "none" | "watch" | "high";
  riskReason?: string;
}

export function projectHorizonSignals({
  project,
  schedule,
  dependencies,
  now
}: {
  project: Project;
  schedule?: ScheduleResult;
  dependencies: Dependency[];
  now: string;
}): HorizonSignals {
  const items = schedule?.items ?? [];
  const hasDeadline = items.some(({ workItem }) => (
    workItem.kind === "milestone" ||
    Boolean(workItem.constraint?.fixedFinish) ||
    Boolean(workItem.constraint?.noLaterThan)
  ));
  const dependencyCount = dependencies.filter((dependency) => dependency.projectId === project.id).length;
  const incompleteItems = items.filter(({ workItem }) => workItem.percentComplete < 100);
  const overdueItem = incompleteItems.find(({ finish }) => finish < now);
  const forecast = incompleteItems.reduce((latest, item) => item.finish > latest ? item.finish : latest, incompleteItems[0]?.finish ?? project.horizon);
  const forecastPastHorizon = incompleteItems.length > 0 && forecast > project.horizon;
  const projectHorizonPassed = incompleteItems.length > 0 && project.horizon < now;
  const scheduleError = schedule?.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  const scheduleWarning = schedule?.diagnostics.find((diagnostic) => diagnostic.severity === "warning")?.message ?? items.find((item) => item.warnings.length > 0)?.warnings[0];
  const highDelayRisk = Boolean(overdueItem || forecastPastHorizon || projectHorizonPassed || scheduleError);
  const watchDelayRisk = Boolean(scheduleWarning);
  const hasDelayRisk = highDelayRisk || watchDelayRisk;
  const riskReason = overdueItem
    ? `${overdueItem.workItem.title} is behind plan`
    : forecastPastHorizon
      ? "Forecast extends beyond the project horizon"
      : projectHorizonPassed
        ? "Project horizon has passed with unfinished work"
        : scheduleError?.message ?? scheduleWarning;

  return {
    mode: hasDeadline || dependencyCount > 0 || hasDelayRisk ? "managed" : "simple",
    hasDeadline,
    dependencyCount,
    hasDelayRisk,
    delayRiskLevel: highDelayRisk ? "high" : watchDelayRisk ? "watch" : "none",
    riskReason
  };
}

export function inferProjectArea(project: Project, workItems: WorkItem[]): LifeArea {
  const searchable = [
    project.name,
    project.northStar,
    project.currentOutcome,
    ...workItems.flatMap((item) => [item.title, item.description ?? "", ...(item.tags ?? [])])
  ].join(" ").toLocaleLowerCase();

  if (matchesAny(searchable, ["home", "house", "apartment", "garden", "repair", "renovation", "move", "家", "住宅", "搬家", "装修"])) {
    return "home";
  }
  if (matchesAny(searchable, ["learn", "study", "course", "read", "fitness", "health", "language", "training", "学习", "读书", "健康", "健身", "日语"])) {
    return "growth";
  }
  return "work";
}

function matchesAny(value: string, candidates: string[]) {
  return candidates.some((candidate) => value.includes(candidate));
}
