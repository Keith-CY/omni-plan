import type { Id, WorkItem, WorkspaceSnapshot } from "./types";

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
