import type { Id, ISODate, RepeatRule, Seconds, WorkItem, WorkspaceSnapshot } from "./types";
import { zonedDateTimeToIso } from "./time";

export type WorkItemStartConstraintMode = "none" | "noEarlierThan" | "fixedStart";

export interface WorkItemStartConstraintValues {
  constraintMode: WorkItemStartConstraintMode;
  constraintDate: string;
}

export interface WorkItemDetailsPatch {
  title: string;
  description?: string;
}

export interface WorkItemDayPlanPatch {
  plannedStart: ISODate;
  effortSeconds: Seconds;
}

export function updateWorkItemDetails(item: WorkItem, patch: WorkItemDetailsPatch): WorkItem {
  const title = patch.title.trim();
  if (!title) throw new Error("Work item title is required.");
  const description = patch.description?.trim() || undefined;
  const next = { ...item, title };
  if (description === undefined) delete next.description;
  else next.description = description;
  return next;
}

/** Keep a manually repeated task's project date aligned with its recurring start. */
export function alignManualRecurringStart(item: WorkItem, rule: RepeatRule | undefined): WorkItem {
  if (
    !rule?.startAt ||
    rule.executionMode === "automatic" ||
    rule.startMode === "after-previous-finish" ||
    !item.constraint?.fixedStart ||
    item.constraint.fixedFinish ||
    item.constraint.fixedStart === rule.startAt
  ) return item;

  return {
    ...item,
    constraint: { ...item.constraint, fixedStart: rule.startAt }
  };
}

export function planWorkItemForDay(item: WorkItem, patch: WorkItemDayPlanPatch): WorkItem {
  if (!Number.isFinite(new Date(patch.plannedStart).getTime())) throw new Error("A valid planned start is required.");
  const effortSeconds = item.kind === "milestone" ? 0 : Math.max(0, Math.round(patch.effortSeconds));
  const previousEffort = item.assignmentIds.reduce((total, assignment) => total + assignment.effortSeconds, 0);
  const assignmentIds = item.assignmentIds.map((assignment, index, assignments) => {
    if (effortSeconds === 0) return { ...assignment, effortSeconds: 0 };
    if (previousEffort > 0) {
      const share = assignment.effortSeconds / previousEffort;
      const allocated = index === assignments.length - 1
        ? effortSeconds - assignments.slice(0, index).reduce((total, candidate) => total + Math.round(effortSeconds * candidate.effortSeconds / previousEffort), 0)
        : Math.round(effortSeconds * share);
      return { ...assignment, effortSeconds: Math.max(0, allocated) };
    }
    return { ...assignment, effortSeconds: index === 0 ? effortSeconds : 0 };
  });
  return {
    ...item,
    durationSeconds: effortSeconds,
    estimate: { ...item.estimate, mostLikelySeconds: effortSeconds },
    assignmentIds,
    constraint: {
      ...(item.constraint?.noLaterThan ? { noLaterThan: item.constraint.noLaterThan } : {}),
      fixedStart: patch.plannedStart
    }
  };
}

export function calendarWorkItemStartValues(selectedDay: string): WorkItemStartConstraintValues {
  return {
    constraintMode: "fixedStart",
    constraintDate: selectedDay
  };
}

export function workItemStartConstraintValues(
  item: WorkItem,
  fallbackDate: string
): WorkItemStartConstraintValues {
  if (item.constraint?.fixedStart) {
    return {
      constraintMode: "fixedStart",
      constraintDate: item.constraint.fixedStart.slice(0, 10)
    };
  }
  if (item.constraint?.noEarlierThan) {
    return {
      constraintMode: "noEarlierThan",
      constraintDate: item.constraint.noEarlierThan.slice(0, 10)
    };
  }
  return {
    constraintMode: "none",
    constraintDate: fallbackDate
  };
}

export function updateWorkItemStartConstraint(
  item: WorkItem,
  values: WorkItemStartConstraintValues
): WorkItem {
  const constraint = {
    ...(item.constraint?.noLaterThan ? { noLaterThan: item.constraint.noLaterThan } : {}),
    ...(values.constraintMode === "none" && item.constraint?.fixedFinish ? { fixedFinish: item.constraint.fixedFinish } : {}),
    ...(values.constraintMode === "fixedStart"
      ? { fixedStart: zonedDateTimeToIso(values.constraintDate, "00:00", "UTC") }
      : values.constraintMode === "noEarlierThan"
        ? { noEarlierThan: zonedDateTimeToIso(values.constraintDate, "00:00", "UTC") }
        : {})
  };

  if (Object.keys(constraint).length > 0) {
    return { ...item, constraint };
  }
  const { constraint: _constraint, ...withoutConstraint } = item;
  return withoutConstraint;
}

export interface MoveWorkItemInput {
  workItemId: Id;
  targetProjectId: Id;
  parentId?: Id;
}

export interface MoveWorkItemResult {
  workspace: WorkspaceSnapshot;
  sourceProjectId: Id;
  targetProjectId: Id;
  movedIds: Id[];
  movedDependencyIds: Id[];
  removedDependencyIds: Id[];
}

export function nextWorkItemOutline(workItems: WorkItem[], projectId: Id, parentId?: Id, excludeIds: ReadonlySet<Id> = new Set()) {
  const siblings = workItems.filter((item) => item.projectId === projectId && item.parentId === parentId && !excludeIds.has(item.id));
  if (!parentId) return String(siblings.length + 1);
  const parent = workItems.find((item) => item.id === parentId);
  return `${parent?.outline ?? "1"}.${siblings.length + 1}`;
}

export function moveWorkItemToProject(snapshot: WorkspaceSnapshot, input: MoveWorkItemInput): MoveWorkItemResult | undefined {
  const root = snapshot.workItems.find((item) => item.id === input.workItemId);
  const targetProject = snapshot.projects.find((project) => project.id === input.targetProjectId);
  if (!root || !targetProject) return undefined;

  const parent = input.parentId ? snapshot.workItems.find((item) => item.id === input.parentId) : undefined;
  if (input.parentId && (!parent || parent.projectId !== input.targetProjectId || parent.kind !== "phase")) return undefined;

  const movedIds = collectWorkItemSubtree(snapshot.workItems, root.id);
  if (input.parentId && movedIds.has(input.parentId)) return undefined;
  if (root.projectId === input.targetProjectId && (root.parentId ?? undefined) === (input.parentId ?? undefined)) return undefined;

  const sourceProjectId = root.projectId;
  const nextOutlineById = outlineMovedSubtree(snapshot.workItems, root.id, input.targetProjectId, input.parentId, movedIds);
  const movedDependencyIds: Id[] = [];
  const removedDependencyIds: Id[] = [];

  const nextWorkItems = snapshot.workItems.map((item) => {
    if (!movedIds.has(item.id)) return item;
    const nextParentId = item.id === root.id
      ? input.parentId
      : item.parentId && movedIds.has(item.parentId)
        ? item.parentId
        : undefined;
    const nextItem: WorkItem = {
      ...item,
      projectId: input.targetProjectId,
      parentId: nextParentId,
      outline: nextOutlineById.get(item.id) ?? item.outline
    };
    if (sourceProjectId !== input.targetProjectId) {
      delete nextItem.shapeUpScopeId;
      delete nextItem.isShapeUpCycleMarker;
    }
    return nextItem;
  });

  return {
    workspace: {
      ...snapshot,
      workItems: nextWorkItems,
      dependencies: snapshot.dependencies.flatMap((dependency) => {
        const fromMoved = movedIds.has(dependency.fromId);
        const toMoved = movedIds.has(dependency.toId);
        if (fromMoved && toMoved) {
          movedDependencyIds.push(dependency.id);
          return [{ ...dependency, projectId: input.targetProjectId }];
        }
        if (fromMoved || toMoved) {
          removedDependencyIds.push(dependency.id);
          return [];
        }
        return [dependency];
      }),
      evidence: snapshot.evidence.map((item) => (
        item.workItemId && movedIds.has(item.workItemId) ? { ...item, projectId: input.targetProjectId } : item
      )),
      recurringOccurrences: snapshot.recurringOccurrences.map((occurrence) => (
        movedIds.has(occurrence.workItemId) && occurrence.status === "scheduled"
          ? { ...occurrence, projectId: input.targetProjectId }
          : occurrence
      )),
      auditGates: snapshot.auditGates.map((gate) => (
        movedIds.has(gate.targetId) ? { ...gate, projectId: input.targetProjectId } : gate
      )),
      baselines: snapshot.baselines.map((baseline) => ({
        ...baseline,
        plannedStartByItem: omitMovedIds(baseline.plannedStartByItem, movedIds),
        plannedFinishByItem: omitMovedIds(baseline.plannedFinishByItem, movedIds),
        plannedWorkSecondsByItem: omitMovedIds(baseline.plannedWorkSecondsByItem, movedIds)
      }))
    },
    sourceProjectId,
    targetProjectId: input.targetProjectId,
    movedIds: [...movedIds],
    movedDependencyIds,
    removedDependencyIds
  };
}

function collectWorkItemSubtree(items: WorkItem[], rootId: Id) {
  const movedIds = new Set<Id>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId && movedIds.has(item.parentId) && !movedIds.has(item.id)) {
        movedIds.add(item.id);
        changed = true;
      }
    }
  }
  return movedIds;
}

function outlineMovedSubtree(items: WorkItem[], rootId: Id, targetProjectId: Id, parentId: Id | undefined, movedIds: ReadonlySet<Id>) {
  const rootOutline = nextWorkItemOutline(items, targetProjectId, parentId, movedIds);
  const outlines = new Map<Id, string>([[rootId, rootOutline]]);
  const childrenByParent = new Map<Id, WorkItem[]>();
  for (const item of items) {
    if (!movedIds.has(item.id) || item.id === rootId || !item.parentId || !movedIds.has(item.parentId)) continue;
    const children = childrenByParent.get(item.parentId) ?? [];
    children.push(item);
    childrenByParent.set(item.parentId, children);
  }

  const assignChildren = (currentId: Id) => {
    const parentOutline = outlines.get(currentId);
    if (!parentOutline) return;
    const children = [...(childrenByParent.get(currentId) ?? [])].sort(compareWorkItemOutline);
    children.forEach((child, index) => {
      outlines.set(child.id, `${parentOutline}.${index + 1}`);
      assignChildren(child.id);
    });
  };
  assignChildren(rootId);

  return outlines;
}

function compareWorkItemOutline(a: WorkItem, b: WorkItem) {
  return a.outline.localeCompare(b.outline, undefined, { numeric: true }) || a.title.localeCompare(b.title);
}

function omitMovedIds<T>(record: Record<Id, T>, movedIds: ReadonlySet<Id>) {
  return Object.fromEntries(Object.entries(record).filter(([id]) => !movedIds.has(id)));
}
