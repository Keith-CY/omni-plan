import {
  type Dependency,
  type Id,
  type LevelingProposal,
  type Project,
  type Resource,
  type ScheduleResult,
  type ScheduledItem,
  type Seconds,
  type WorkItem
} from "./types";
import { addSeconds, maxIso, minIso, secondsBetween } from "./time";

function isValidIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function projectScheduleStart(project: Project): string {
  if (isValidIso(project.start)) return project.start;
  if (isValidIso(project.horizon)) return project.horizon;
  return new Date().toISOString();
}

function durationOf(item: WorkItem): Seconds {
  if (item.kind === "milestone") return 0;
  if (item.splitSegments?.length) {
    const last = item.splitSegments.reduce(
      (finish, segment) => Math.max(finish, segment.offsetSeconds + segment.durationSeconds),
      0
    );
    return last;
  }
  return item.durationSeconds;
}

function overlapsDay(item: ScheduledItem, day: string): boolean {
  const dayStart = `${day}T00:00:00.000Z`;
  const dayFinish = addSeconds(dayStart, 24 * 60 * 60);
  return item.start < dayFinish && item.finish > dayStart;
}

function applySummaryRollups(
  scheduled: Map<Id, ScheduledItem>,
  items: WorkItem[]
): Map<Id, ScheduledItem> {
  const childrenByParent = new Map<Id, WorkItem[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    childrenByParent.set(item.parentId, [...(childrenByParent.get(item.parentId) ?? []), item]);
  }

  const byOutlineDepth = [...items].sort((a, b) => b.outline.split(".").length - a.outline.split(".").length);
  for (const item of byOutlineDepth) {
    const children = childrenByParent
      .get(item.id)
      ?.map((child) => scheduled.get(child.id))
      .filter(Boolean) as ScheduledItem[] | undefined;
    const current = scheduled.get(item.id);
    if (!current || !children?.length) continue;
    const starts = children.map((child) => child.start).filter(isValidIso);
    const finishes = children.map((child) => child.finish).filter(isValidIso);
    const earlyStarts = children.map((child) => child.earlyStart).filter(isValidIso);
    const earlyFinishes = children.map((child) => child.earlyFinish).filter(isValidIso);
    const lateStarts = children.map((child) => child.lateStart).filter(isValidIso);
    const lateFinishes = children.map((child) => child.lateFinish).filter(isValidIso);
    if (!starts.length || !finishes.length || !earlyStarts.length || !earlyFinishes.length || !lateStarts.length || !lateFinishes.length) continue;

    scheduled.set(item.id, {
      ...current,
      start: minIso(...starts),
      finish: maxIso(...finishes),
      earlyStart: minIso(...earlyStarts),
      earlyFinish: maxIso(...earlyFinishes),
      lateStart: minIso(...lateStarts),
      lateFinish: maxIso(...lateFinishes),
      totalFloatSeconds: Math.min(...children.map((child) => child.totalFloatSeconds)),
      freeFloatSeconds: Math.min(...children.map((child) => child.freeFloatSeconds)),
      isCritical: children.some((child) => child.isCritical)
    });
  }

  return scheduled;
}

function itemMap(items: WorkItem[]): Map<Id, WorkItem> {
  return new Map(items.map((item) => [item.id, item]));
}

function topologicalSort(items: WorkItem[], dependencies: Dependency[]): { order: Id[]; cycle?: Id[] } {
  const ids = new Set(items.map((item) => item.id));
  const incoming = new Map<Id, number>();
  const outgoing = new Map<Id, Id[]>();

  for (const item of items) {
    incoming.set(item.id, 0);
    outgoing.set(item.id, []);
  }

  for (const dependency of dependencies) {
    if (!ids.has(dependency.fromId) || !ids.has(dependency.toId)) continue;
    incoming.set(dependency.toId, (incoming.get(dependency.toId) ?? 0) + 1);
    outgoing.get(dependency.fromId)?.push(dependency.toId);
  }

  const queue = [...incoming.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const order: Id[] = [];

  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const nextCount = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextCount);
      if (nextCount === 0) queue.push(next);
      queue.sort();
    }
  }

  if (order.length !== items.length) {
    return { order, cycle: [...incoming.entries()].filter(([, count]) => count > 0).map(([id]) => id) };
  }

  return { order };
}

function dependencyBound(
  dependency: Dependency,
  predecessor: ScheduledItem,
  successorDuration: Seconds
): { startBound?: string; finishBound?: string } {
  const laggedFinish = addSeconds(predecessor.finish, dependency.lagSeconds);
  const laggedStart = addSeconds(predecessor.start, dependency.lagSeconds);

  switch (dependency.type) {
    case "FS":
      return { startBound: laggedFinish };
    case "SS":
      return { startBound: laggedStart };
    case "FF":
      return { finishBound: laggedFinish, startBound: addSeconds(laggedFinish, -successorDuration) };
    case "SF":
      return { finishBound: laggedStart, startBound: addSeconds(laggedStart, -successorDuration) };
  }
}

export function scheduleProject(project: Project, allItems: WorkItem[], allDependencies: Dependency[]): ScheduleResult {
  const items = allItems.filter((item) => item.projectId === project.id);
  const dependencies = allDependencies.filter((dependency) => dependency.projectId === project.id);
  const byId = itemMap(items);
  const diagnostics: ScheduleResult["diagnostics"] = [];
  const unsupported: string[] = [];
  const projectStart = projectScheduleStart(project);

  if (!items.length) {
    return {
      projectId: project.id,
      items: [],
      diagnostics,
      unsupported
    };
  }

  const sorted = topologicalSort(items, dependencies);

  if (sorted.cycle) {
    return {
      projectId: project.id,
      items: [],
      diagnostics: sorted.cycle.map((itemId) => ({
        severity: "error",
        itemId,
        message: "Circular dependency prevents a safe schedule."
      })),
      unsupported
    };
  }

  const scheduled = new Map<Id, ScheduledItem>();

  for (const id of sorted.order) {
    const workItem = byId.get(id)!;
    const predecessors = dependencies.filter((dependency) => dependency.toId === id);
    const duration = durationOf(workItem);
    const warnings: string[] = [];
    let start = projectStart;
    let finish = addSeconds(start, duration);

    for (const predecessorDependency of predecessors) {
      const predecessor = scheduled.get(predecessorDependency.fromId);
      if (!predecessor) continue;
      const bound = dependencyBound(predecessorDependency, predecessor, duration);
      if (bound?.startBound) start = maxIso(start, bound.startBound);
      if (bound?.finishBound) finish = maxIso(finish, bound.finishBound);
    }

    if (isValidIso(workItem.constraint?.noEarlierThan)) {
      start = maxIso(start, workItem.constraint.noEarlierThan);
    }

    if (isValidIso(workItem.constraint?.fixedStart)) {
      if (secondsBetween(start, workItem.constraint.fixedStart) < 0) {
        warnings.push("Fixed start violates dependency or no-earlier-than constraints.");
        diagnostics.push({
          severity: "warning",
          itemId: workItem.id,
          message: `${workItem.title} fixed start is earlier than its dependency or no-earlier-than bound.`
        });
      }
      start = workItem.constraint.fixedStart;
    }

    finish = addSeconds(start, duration);

    if (isValidIso(workItem.constraint?.fixedFinish)) {
      finish = workItem.constraint.fixedFinish;
      start = addSeconds(finish, -duration);
    }

    if (isValidIso(workItem.constraint?.noLaterThan) && secondsBetween(finish, workItem.constraint.noLaterThan) < 0) {
      warnings.push("Finish violates no-later-than constraint.");
      diagnostics.push({
        severity: "warning",
        itemId: workItem.id,
        message: `${workItem.title} finishes after its no-later-than constraint.`
      });
    }

    scheduled.set(id, {
      workItem,
      start,
      finish,
      earlyStart: start,
      earlyFinish: finish,
      lateStart: start,
      lateFinish: finish,
      totalFloatSeconds: 0,
      freeFloatSeconds: 0,
      isCritical: false,
      warnings
    });
  }

  for (const item of items.filter((candidate) => candidate.kind === "hammock")) {
    const scheduledItem = scheduled.get(item.id);
    const startAnchor = item.hammockStartId ? scheduled.get(item.hammockStartId) : undefined;
    const finishAnchor = item.hammockFinishId ? scheduled.get(item.hammockFinishId) : undefined;
    if (!scheduledItem || !startAnchor || !finishAnchor) {
      unsupported.push(`Hammock task ${item.title} is missing one or both anchor tasks.`);
      continue;
    }
    scheduled.set(item.id, {
      ...scheduledItem,
      start: startAnchor.start,
      finish: finishAnchor.finish,
      earlyStart: startAnchor.start,
      earlyFinish: finishAnchor.finish
    });
  }

  const scheduledFinishes = [...scheduled.values()].map((item) => item.finish).filter(isValidIso);
  const projectFinish = scheduledFinishes.length ? maxIso(...scheduledFinishes) : projectStart;
  const reverse = [...sorted.order].reverse();

  for (const id of reverse) {
    const current = scheduled.get(id)!;
    const successors = dependencies.filter((dependency) => dependency.fromId === id);
    const successorStarts = successors
      .map((dependency) => scheduled.get(dependency.toId)?.start)
      .filter(isValidIso);
    const lateFinish = successorStarts.length ? minIso(...successorStarts) : projectFinish;
    const lateStart = addSeconds(lateFinish, -durationOf(current.workItem));
    const totalFloatSeconds = Math.max(0, secondsBetween(current.finish, lateFinish));
    const freeFloatSeconds = successorStarts.length ? Math.max(0, secondsBetween(current.finish, minIso(...successorStarts))) : totalFloatSeconds;

    scheduled.set(id, {
      ...current,
      lateStart,
      lateFinish,
      totalFloatSeconds,
      freeFloatSeconds,
      isCritical: totalFloatSeconds === 0
    });
  }

  applySummaryRollups(scheduled, items);

  return {
    projectId: project.id,
    items: [...scheduled.values()].sort((a, b) => a.workItem.outline.localeCompare(b.workItem.outline)),
    diagnostics,
    unsupported
  };
}

export function schedulePortfolio(projects: Project[], items: WorkItem[], dependencies: Dependency[]): ScheduleResult[] {
  return projects.map((project) => scheduleProject(project, items, dependencies));
}

export function detectCrossProjectOverload(
  schedules: ScheduleResult[],
  resources: Resource[]
): Array<{ resourceId: Id; attention: string; day: string; plannedSeconds: Seconds; capacitySeconds: Seconds }> {
  const capacity = new Map(resources.map((resource) => [resource.id, resource.capacityByAttention]));
  const usage = new Map<string, Seconds>();

  for (const schedule of schedules) {
    for (const item of schedule.items) {
      const day = item.start.slice(0, 10);
      for (const assignment of item.workItem.assignmentIds) {
        const key = `${assignment.resourceId}:${assignment.attention}:${day}`;
        usage.set(key, (usage.get(key) ?? 0) + assignment.effortSeconds);
      }
    }
  }

  return [...usage.entries()]
    .map(([key, plannedSeconds]) => {
      const [resourceId, attention, day] = key.split(":");
      const capacitySeconds = capacity.get(resourceId)?.[attention as keyof Resource["capacityByAttention"]] ?? 0;
      return { resourceId, attention, day, plannedSeconds, capacitySeconds };
    })
    .filter((row) => row.plannedSeconds > row.capacitySeconds);
}

export function generateLevelingProposals(
  schedules: ScheduleResult[],
  resources: Resource[]
): LevelingProposal[] {
  const overloads = detectCrossProjectOverload(schedules, resources);
  const proposals: LevelingProposal[] = [];

  for (const overload of overloads) {
    const candidates = schedules
      .flatMap((schedule) => schedule.items.map((item) => ({ schedule, item })))
      .filter(({ item }) =>
        item.workItem.percentComplete < 100 &&
        item.workItem.kind !== "phase" &&
        overlapsDay(item, overload.day) &&
        item.workItem.assignmentIds.some(
          (assignment) => assignment.resourceId === overload.resourceId && assignment.attention === overload.attention
        )
      )
      .sort(
        (a, b) =>
          Number(a.item.isCritical) - Number(b.item.isCritical) ||
          a.item.workItem.percentComplete - b.item.workItem.percentComplete ||
          a.item.start.localeCompare(b.item.start)
      );

    const candidate = candidates[0];
    if (!candidate) continue;

    const moveBySeconds = 24 * 60 * 60;
    proposals.push({
      id: `level-${overload.resourceId}-${candidate.item.workItem.id}-${overload.day}`,
      projectId: candidate.schedule.projectId,
      resourceId: overload.resourceId,
      attention: overload.attention as LevelingProposal["attention"],
      workItemId: candidate.item.workItem.id,
      moveBySeconds,
      beforeStart: candidate.item.start,
      afterStart: addSeconds(candidate.item.start, moveBySeconds),
      reason: `${overload.attention} attention is over capacity on ${overload.day}. Move the lowest-impact candidate by one day.`,
      criticalPathImpactSeconds: candidate.item.isCritical ? moveBySeconds : 0
    });
  }

  return proposals;
}
