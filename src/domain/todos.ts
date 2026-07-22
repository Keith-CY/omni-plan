import { normalizeProjectLifecycle, normalizeRepeatRule, projectPlanningMethod } from "./projectLifecycle";
import { createShapeUpPitch } from "./shapeUp";
import { addZonedCalendarDays, addZonedCalendarMonths, zonedDateKey, zonedDateTimeToIso } from "./time";
import type {
  ConversionHistoryEntry,
  Id,
  ISODate,
  PlanningMethod,
  Project,
  RepeatRule,
  Todo,
  TodoChecklistItem,
  WorkItem,
  WorkspaceSnapshot
} from "./types";

export type TodoPatch = Partial<Omit<Todo, "id" | "capturedAt" | "inbox">>;

export type CreateTodoInput = Pick<Todo, "id" | "title"> & Partial<
  Omit<Todo, "id" | "title" | "capturedAt" | "updatedAt" | "inbox">
> & {
  capturedAt?: ISODate;
  updatedAt?: ISODate;
};

export type TodoConversionErrorCode =
  | "todo_not_found"
  | "task_not_found"
  | "not_a_task"
  | "project_not_found"
  | "id_conflict"
  | "scope_required"
  | "scope_not_found"
  | "shape_up_repeat_not_supported"
  | "shape_up_scope_unconfirmed"
  | "impact_confirmation_required";

export type TaskToTodoDiscardedField =
  | "parent"
  | "children"
  | "dependencies"
  | "schedule"
  | "assignments"
  | "baselines"
  | "evidence"
  | "actuals"
  | "shape_up_scope"
  | "project_flags"
  | "recurring_occurrences"
  | "audit_links"
  | "change_sets"
  | "progress"
  | "estimate_range";

export interface TaskToTodoImpact {
  requiresConfirmation: boolean;
  discardedFields: TaskToTodoDiscardedField[];
}

export interface TodoConversionFailure {
  ok: false;
  code: TodoConversionErrorCode;
  message: string;
  impact?: TaskToTodoImpact;
}

export interface TodoToTaskSuccess {
  ok: true;
  workspace: WorkspaceSnapshot;
  task: WorkItem;
}

export interface TaskToTodoSuccess {
  ok: true;
  workspace: WorkspaceSnapshot;
  todo: Todo;
  impact: TaskToTodoImpact;
}

export interface TodoToProjectSuccess {
  ok: true;
  workspace: WorkspaceSnapshot;
  project: Project;
  task: WorkItem;
}

export interface ConvertTodoToTaskInput {
  todoId: Id;
  projectId: Id;
  shapeUpScopeId?: Id;
  now?: ISODate;
}

export interface ConvertTaskToTodoInput {
  taskId: Id;
  confirmedImpact?: boolean;
  now?: ISODate;
}

export interface ConvertTodoToProjectInput {
  todoId: Id;
  planningMethod: PlanningMethod;
  projectId?: Id;
  name?: string;
  problem?: string;
  now?: ISODate;
}

export function createTodo(input: CreateTodoInput, now = input.capturedAt ?? new Date().toISOString()): Todo {
  const id = requiredText(input.id, "Todo id");
  const title = requiredText(input.title, "Todo title");
  const status = input.status === "completed" ? "completed" : "open";
  const repeatCompletedCount = input.repeatRule ? positiveInteger(input.repeatCompletedCount) : undefined;
  const todo: Todo = {
    id,
    title,
    ...(input.note === undefined ? {} : { note: input.note }),
    tags: normalizeTags(input.tags ?? []),
    flagged: Boolean(input.flagged),
    ...(input.estimatedSeconds === undefined
      ? {}
      : { estimatedSeconds: nonNegativeSeconds(input.estimatedSeconds) }),
    ...(input.deferUntil === undefined ? {} : { deferUntil: input.deferUntil }),
    ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
    ...(input.repeatRule === undefined
      ? {}
      : { repeatRule: normalizeRepeatRule(id, input.repeatRule) }),
    ...(repeatCompletedCount === undefined ? {} : { repeatCompletedCount }),
    ...(input.repeatRule === undefined || input.lastRepeatCompletedAt === undefined
      ? {}
      : { lastRepeatCompletedAt: input.lastRepeatCompletedAt }),
    checklist: cloneChecklist(input.checklist ?? []),
    ...(input.plannedForDate === undefined ? {} : { plannedForDate: input.plannedForDate }),
    status,
    ...(status === "completed" ? { completedAt: input.completedAt ?? now } : {}),
    capturedAt: input.capturedAt ?? now,
    updatedAt: input.updatedAt ?? now,
    inbox: false
  };
  todo.inbox = status === "open" && !todoHasInboxExitMetadata(todo);
  return todo;
}

export function updateTodo(todo: Todo, patch: TodoPatch, now = new Date().toISOString()): Todo {
  const wasCompleted = todo.status === "completed";
  const nextStatus = patch.status ?? todo.status;
  const next: Todo = {
    ...todo,
    ...patch,
    ...(patch.title === undefined ? {} : { title: requiredText(patch.title, "Todo title") }),
    ...(patch.tags === undefined ? {} : { tags: normalizeTags(patch.tags) }),
    ...(patch.checklist === undefined ? {} : { checklist: cloneChecklist(patch.checklist) }),
    ...(patch.estimatedSeconds === undefined
      ? {}
      : { estimatedSeconds: nonNegativeSeconds(patch.estimatedSeconds) }),
    ...(patch.repeatRule === undefined
      ? {}
      : { repeatRule: normalizeRepeatRule(todo.id, patch.repeatRule) }),
    status: nextStatus,
    updatedAt: now,
    inbox: todo.inbox
  };

  if (nextStatus === "completed") {
    next.completedAt = patch.completedAt ?? todo.completedAt ?? now;
    next.inbox = false;
  } else {
    delete next.completedAt;
    if (wasCompleted || patchTriggersInboxExit(patch)) next.inbox = false;
  }
  if ("repeatRule" in patch && patch.repeatRule === undefined) {
    delete next.repeatCompletedCount;
    delete next.lastRepeatCompletedAt;
  }
  return next;
}

export function keepTodo(todo: Todo, now = new Date().toISOString()): Todo {
  return { ...todo, inbox: false, updatedAt: now };
}

export function completeTodo(todo: Todo, now = new Date().toISOString(), timeZone = "UTC"): Todo {
  if (!todo.repeatRule) {
    return { ...todo, status: "completed", completedAt: now, inbox: false, updatedAt: now };
  }

  const completedCount = normalizedRepeatCompletedCount(todo);
  const currentOccurrence = todoRepeatOccurrenceDate(todo, timeZone);
  if (!currentOccurrence) {
    return { ...todo, status: "completed", completedAt: now, inbox: false, updatedAt: now };
  }

  const today = dateKey(now, timeZone);
  const latestDueIndex = latestDueRepeatOccurrenceIndex(todo, today, timeZone);
  const nextCompletedCount = Math.max(completedCount, latestDueIndex ?? completedCount) + 1;
  const progressed: Todo = {
    ...todo,
    repeatCompletedCount: nextCompletedCount,
    lastRepeatCompletedAt: now,
    status: "open",
    inbox: false,
    updatedAt: now
  };
  delete progressed.completedAt;

  if (todoRepeatOccurrenceDate(progressed, timeZone)) return progressed;

  // Keep the previous completion boundary so restoring the final occurrence
  // can reproduce after-previous-finish scheduling.
  if (todo.lastRepeatCompletedAt === undefined) delete progressed.lastRepeatCompletedAt;
  else progressed.lastRepeatCompletedAt = todo.lastRepeatCompletedAt;
  progressed.status = "completed";
  progressed.completedAt = now;
  return progressed;
}

export function reopenTodo(todo: Todo, now = new Date().toISOString()): Todo {
  const next: Todo = { ...todo, status: "open", inbox: false, updatedAt: now };
  if (todo.repeatRule && normalizedRepeatCompletedCount(todo) > 0) {
    const restoredCount = normalizedRepeatCompletedCount(todo) - 1;
    if (restoredCount > 0) next.repeatCompletedCount = restoredCount;
    else delete next.repeatCompletedCount;
  }
  delete next.completedAt;
  return next;
}

export function todoHasInboxExitMetadata(todo: Pick<
  Todo,
  "tags" | "flagged" | "deferUntil" | "dueAt" | "plannedForDate" | "repeatRule"
>): boolean {
  return Boolean(
    todo.tags.length || todo.flagged || todo.deferUntil || todo.dueAt || todo.plannedForDate || todo.repeatRule
  );
}

export function selectTodayTodos(
  todos: readonly Todo[],
  todayOrNow: string,
  timeZone = "UTC"
): Todo[] {
  const today = dateKey(todayOrNow, timeZone);
  return todos
    .filter((todo) => todo.status === "open" && todayMembership(todo, today, timeZone))
    .sort((left, right) => compareTodayTodos(left, right, today, timeZone));
}

export function taskToTodoImpact(snapshot: WorkspaceSnapshot, taskId: Id): TaskToTodoImpact {
  const task = snapshot.workItems.find((item) => item.id === taskId);
  if (!task) return { requiresConfirmation: false, discardedFields: [] };
  const discarded = new Set<TaskToTodoDiscardedField>();

  if (task.parentId) discarded.add("parent");
  if (snapshot.workItems.some((item) => item.parentId === taskId)) discarded.add("children");
  if (snapshot.dependencies.some(({ fromId, toId }) => fromId === taskId || toId === taskId)) {
    discarded.add("dependencies");
  }
  if (
    task.constraint?.fixedStart ||
    task.constraint?.fixedFinish ||
    task.splitSegments?.length ||
    task.hammockStartId ||
    task.hammockFinishId
  ) {
    discarded.add("schedule");
  }
  if (snapshot.workItems.some((item) =>
    item.id !== taskId && (item.hammockStartId === taskId || item.hammockFinishId === taskId)
  )) {
    discarded.add("schedule");
  }
  if (task.assignmentIds.length) discarded.add("assignments");
  if (task.percentComplete > 0 && task.percentComplete < 100) discarded.add("progress");
  if (
    task.estimate.optimisticSeconds !== undefined ||
    task.estimate.pessimisticSeconds !== undefined ||
    task.durationSeconds !== task.estimate.mostLikelySeconds
  ) {
    discarded.add("estimate_range");
  }
  if (snapshot.baselines.some((baseline) => baselineReferencesItem(baseline, taskId))) {
    discarded.add("baselines");
  }
  if (snapshot.evidence.some((entry) => entry.workItemId === taskId)) discarded.add("evidence");
  if (snapshot.actuals.some((entry) => entry.workItemId === taskId)) discarded.add("actuals");
  if (task.shapeUpScopeId || task.shapeUpLocked || task.isShapeUpCycleMarker) discarded.add("shape_up_scope");
  if (task.isKeyTask || task.isScopeExpansion || task.isFastDelivery || task.evidenceRequired) {
    discarded.add("project_flags");
  }
  if (snapshot.recurringOccurrences.some((entry) => entry.workItemId === taskId && entry.status === "scheduled")) {
    discarded.add("recurring_occurrences");
  }
  if (snapshot.auditGates.some((gate) => gate.targetId === taskId)) discarded.add("audit_links");
  if (snapshot.changeSets.some((changeSet) => changeSet.diffs.some((diff) => diff.entityId === taskId))) {
    discarded.add("change_sets");
  }

  const discardedFields = [...discarded].sort();
  return { requiresConfirmation: discardedFields.length > 0, discardedFields };
}

export function convertTodoToTask(
  snapshot: WorkspaceSnapshot,
  input: ConvertTodoToTaskInput
): TodoToTaskSuccess | TodoConversionFailure {
  const todo = workspaceTodos(snapshot).find((entry) => entry.id === input.todoId);
  if (!todo) return failure("todo_not_found", `Todo ${input.todoId} was not found.`);
  if (snapshot.workItems.some((entry) => entry.id === todo.id)) {
    return failure("id_conflict", `Work item ${todo.id} already exists.`);
  }
  const sourceProject = snapshot.projects.find((entry) => entry.id === input.projectId);
  if (!sourceProject) return failure("project_not_found", `Project ${input.projectId} was not found.`);

  const project = normalizeProjectLifecycle(sourceProject);
  const scopeResult = shapeUpAssignment(project, todo, input.shapeUpScopeId);
  if (!scopeResult.ok) return scopeResult;
  const now = input.now ?? new Date().toISOString();
  const task = workItemFromTodo(
    todo,
    project,
    now,
    snapshot.timeZone,
    nextRootOutline(snapshot.workItems, project.id),
    scopeResult.shapeUpScopeId,
    scopeResult.shapeUpLocked
  );
  const history = conversionEntry("todo_to_task", todo.id, project.id, now, []);

  return {
    ok: true,
    task,
    workspace: {
      ...snapshot,
      schemaVersion: 3,
      todos: workspaceTodos(snapshot).filter((entry) => entry.id !== todo.id),
      conversionHistory: [...workspaceConversionHistory(snapshot), history],
      projects: snapshot.projects.map((entry) => entry.id === project.id ? project : entry),
      workItems: [...snapshot.workItems, task]
    }
  };
}

export function convertTaskToTodo(
  snapshot: WorkspaceSnapshot,
  input: ConvertTaskToTodoInput
): TaskToTodoSuccess | TodoConversionFailure {
  const task = snapshot.workItems.find((entry) => entry.id === input.taskId);
  if (!task) return failure("task_not_found", `Task ${input.taskId} was not found.`);
  if (task.kind !== "task") return failure("not_a_task", `Work item ${input.taskId} is not a task.`);
  if (workspaceTodos(snapshot).some((entry) => entry.id === task.id)) {
    return failure("id_conflict", `Todo ${task.id} already exists.`);
  }

  const impact = taskToTodoImpact(snapshot, task.id);
  if (impact.requiresConfirmation && input.confirmedImpact !== true) {
    return {
      ...failure(
        "impact_confirmation_required",
        `Converting ${task.id} permanently clears project-specific data.`
      ),
      impact
    };
  }

  const now = input.now ?? new Date().toISOString();
  const todo = todoFromWorkItem(snapshot, task, now);
  const removedGateIds = new Set(
    snapshot.auditGates.filter((gate) => gate.targetId === task.id).map((gate) => gate.id)
  );
  const history = conversionEntry(
    "task_to_todo",
    task.id,
    task.projectId,
    now,
    impact.discardedFields
  );

  return {
    ok: true,
    todo,
    impact,
    workspace: {
      ...snapshot,
      schemaVersion: 3,
      todos: [...workspaceTodos(snapshot), todo],
      conversionHistory: [...workspaceConversionHistory(snapshot), history],
      workItems: snapshot.workItems
        .filter((entry) => entry.id !== task.id)
        .map((entry) => withoutTaskReferences(entry, task.id)),
      dependencies: snapshot.dependencies.filter(
        ({ fromId, toId }) => fromId !== task.id && toId !== task.id
      ),
      recurringOccurrences: snapshot.recurringOccurrences.filter(
        (entry) => entry.workItemId !== task.id || entry.status !== "scheduled"
      ),
      baselines: snapshot.baselines.map((baseline) => omitBaselineItem(baseline, task.id)),
      actuals: snapshot.actuals.filter((entry) => entry.workItemId !== task.id),
      evidence: snapshot.evidence.filter((entry) => entry.workItemId !== task.id),
      decisions: snapshot.decisions.map((decision) => ({
        ...decision,
        linkedEvidenceIds: decision.linkedEvidenceIds.filter((evidenceId) =>
          snapshot.evidence.some((entry) => entry.id === evidenceId && entry.workItemId !== task.id)
        )
      })),
      auditGates: snapshot.auditGates.filter((gate) => gate.targetId !== task.id),
      auditDecisions: snapshot.auditDecisions.map((decision) => ({
        ...decision,
        sourceGateIds: decision.sourceGateIds.filter((gateId) => !removedGateIds.has(gateId))
      })),
      changeSets: snapshot.changeSets.map((changeSet) => ({
        ...changeSet,
        diffs: changeSet.diffs.filter((diff) => diff.entityId !== task.id),
        auditGateIds: changeSet.auditGateIds.filter((gateId) => !removedGateIds.has(gateId))
      }))
    }
  };
}

export function convertTodoToProject(
  snapshot: WorkspaceSnapshot,
  input: ConvertTodoToProjectInput
): TodoToProjectSuccess | TodoConversionFailure {
  const todo = workspaceTodos(snapshot).find((entry) => entry.id === input.todoId);
  if (!todo) return failure("todo_not_found", `Todo ${input.todoId} was not found.`);
  if (snapshot.workItems.some((entry) => entry.id === todo.id)) {
    return failure("id_conflict", `Work item ${todo.id} already exists.`);
  }
  if (input.planningMethod === "shape-up" && todo.repeatRule) {
    return failure(
      "shape_up_repeat_not_supported",
      "A repeating Todo cannot convert directly to a Shape Up project."
    );
  }

  const now = input.now ?? new Date().toISOString();
  const projectId = input.projectId ?? projectIdForTodo(todo.id);
  if (projectId === todo.id || snapshot.projects.some((entry) => entry.id === projectId)) {
    return failure("id_conflict", `Project ${projectId} already exists or conflicts with the Todo id.`);
  }

  const project = projectFromTodo(todo, input, projectId, now);
  const scopeId = input.planningMethod === "shape-up" ? shapeUpScopeIdForTodo(todo.id) : undefined;
  const task = workItemFromTodo(
    todo,
    project,
    now,
    snapshot.timeZone,
    "1",
    scopeId,
    input.planningMethod === "shape-up"
  );
  const history = conversionEntry("todo_to_project", todo.id, project.id, now, []);
  return {
    ok: true,
    project,
    task,
    workspace: {
      ...snapshot,
      schemaVersion: 3,
      todos: workspaceTodos(snapshot).filter((entry) => entry.id !== todo.id),
      conversionHistory: [...workspaceConversionHistory(snapshot), history],
      projects: [...snapshot.projects, project],
      workItems: [...snapshot.workItems, task]
    }
  };
}

export const todoToTask = convertTodoToTask;
export const taskToTodo = convertTaskToTodo;
export const todoToProject = convertTodoToProject;

export function projectIdForTodo(todoId: Id): Id {
  return `project-${stableHash(todoId)}`;
}

export function shapeUpScopeIdForTodo(todoId: Id): Id {
  return `scope-${stableHash(todoId)}`;
}

function patchTriggersInboxExit(patch: TodoPatch): boolean {
  return Boolean(
    (patch.tags && patch.tags.length) ||
    patch.flagged === true ||
    patch.deferUntil ||
    patch.dueAt ||
    patch.plannedForDate ||
    patch.repeatRule
  );
}

function todayMembership(todo: Todo, today: string, timeZone: string): boolean {
  if (todo.repeatRule) {
    const occurrenceDate = todoRepeatOccurrenceDate(todo, timeZone);
    return Boolean(occurrenceDate && occurrenceDate <= today);
  }
  const due = optionalDateKey(todo.dueAt, timeZone);
  const deferred = optionalDateKey(todo.deferUntil, timeZone);
  const planned = optionalDateKey(todo.plannedForDate, timeZone);
  return Boolean(
    (due && due <= today) ||
    (deferred && deferred <= today) ||
    planned === today
  );
}

function compareTodayTodos(left: Todo, right: Todo, today: string, timeZone: string): number {
  const leftRank = todayRank(left, today, timeZone);
  const rightRank = todayRank(right, today, timeZone);
  return leftRank.group - rightRank.group ||
    leftRank.key.localeCompare(rightRank.key) ||
    left.capturedAt.localeCompare(right.capturedAt) ||
    left.id.localeCompare(right.id);
}

function todayRank(todo: Todo, today: string, timeZone: string): { group: number; key: string } {
  if (todo.repeatRule) {
    const occurrenceDate = todoRepeatOccurrenceDate(todo, timeZone);
    if (occurrenceDate && occurrenceDate < today) return { group: 0, key: occurrenceDate };
    return { group: 2, key: occurrenceDate ?? todo.updatedAt };
  }
  const due = optionalDateKey(todo.dueAt, timeZone);
  if (due && due < today) return { group: 0, key: todo.dueAt ?? due };
  if (due === today) return { group: 1, key: todo.dueAt ?? due };
  const starts = [
    optionalDateKey(todo.plannedForDate, timeZone) === today ? todo.plannedForDate : undefined,
    optionalDateKey(todo.deferUntil, timeZone) && optionalDateKey(todo.deferUntil, timeZone)! <= today
      ? todo.deferUntil
      : undefined
  ].filter(Boolean) as string[];
  return { group: starts.length ? 2 : 3, key: starts.sort()[0] ?? todo.updatedAt };
}

function todoRepeatOccurrenceDate(todo: Todo, timeZone: string): string | undefined {
  const rule = todo.repeatRule;
  if (!rule) return undefined;
  const occurrenceIndex = normalizedRepeatCompletedCount(todo);
  const occurrenceDate = repeatOccurrenceDate(todo, occurrenceIndex, timeZone);
  return occurrenceDate && repeatOccurrenceAllowed(rule, occurrenceIndex, occurrenceDate, timeZone)
    ? occurrenceDate
    : undefined;
}

function latestDueRepeatOccurrenceIndex(todo: Todo, today: string, timeZone: string): number | undefined {
  const rule = todo.repeatRule;
  if (!rule) return undefined;
  const firstOutstanding = normalizedRepeatCompletedCount(todo);
  if ((rule.startMode ?? "fixed-time") === "after-previous-finish") {
    const occurrenceDate = repeatOccurrenceDate(todo, firstOutstanding, timeZone);
    return occurrenceDate && occurrenceDate <= today && repeatOccurrenceAllowed(rule, firstOutstanding, occurrenceDate, timeZone)
      ? firstOutstanding
      : undefined;
  }

  let latest: number | undefined;
  const hardLimit = firstOutstanding + 50_000;
  for (let index = firstOutstanding; index < hardLimit; index += 1) {
    const occurrenceDate = repeatOccurrenceDate(todo, index, timeZone);
    if (!occurrenceDate || occurrenceDate > today || !repeatOccurrenceAllowed(rule, index, occurrenceDate, timeZone)) break;
    latest = index;
  }
  return latest;
}

function repeatOccurrenceDate(todo: Todo, occurrenceIndex: number, timeZone: string): string | undefined {
  const occurrence = repeatOccurrenceIso(todo, occurrenceIndex, timeZone);
  return occurrence ? optionalDateKey(occurrence, timeZone) : undefined;
}

function repeatOccurrenceIso(todo: Todo, occurrenceIndex: number, timeZone: string): ISODate | undefined {
  const rule = todo.repeatRule;
  if (!rule) return undefined;
  const completedCount = normalizedRepeatCompletedCount(todo);
  if (
    (rule.startMode ?? "fixed-time") === "after-previous-finish" &&
    occurrenceIndex === completedCount &&
    completedCount > 0 &&
    todo.lastRepeatCompletedAt
  ) {
    return addRepeatCadence(todo.lastRepeatCompletedAt, rule, 1, timeZone);
  }
  const anchor = repeatAnchorIso(todo, timeZone);
  return anchor ? addRepeatCadence(anchor, rule, occurrenceIndex, timeZone) : undefined;
}

function repeatAnchorIso(todo: Todo, timeZone: string): ISODate | undefined {
  const value = todo.repeatRule?.startAt ?? todo.plannedForDate ?? todo.deferUntil ?? todo.dueAt ?? todo.capturedAt;
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      return zonedDateTimeToIso(value, "00:00", timeZone);
    } catch {
      return undefined;
    }
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function addRepeatCadence(anchor: ISODate, rule: RepeatRule, index: number, timeZone: string): ISODate {
  const cadence = rule.cadence ?? "every-n-days";
  if (cadence === "monthly") return addZonedCalendarMonths(anchor, index, timeZone);
  const cadenceDays = cadence === "weekly" ? 7 : Math.max(1, Math.round(rule.everyDays ?? 1));
  return addZonedCalendarDays(anchor, index * cadenceDays, timeZone);
}

function repeatOccurrenceAllowed(
  rule: RepeatRule,
  occurrenceIndex: number,
  occurrenceDate: string,
  timeZone: string
): boolean {
  if ((rule.endMode ?? "count") === "count" && occurrenceIndex >= Math.max(1, Math.round(rule.count || 1))) {
    return false;
  }
  const until = optionalDateKey(rule.until, timeZone);
  if ((rule.endMode ?? "count") === "until" && until && occurrenceDate > until) return false;
  const stoppedAt = optionalDateKey(rule.stoppedAt, timeZone);
  return !stoppedAt || occurrenceDate < stoppedAt;
}

function shapeUpAssignment(
  project: Project,
  todo: Todo,
  scopeId?: Id
): { ok: true; shapeUpScopeId?: Id; shapeUpLocked?: boolean } | TodoConversionFailure {
  if (projectPlanningMethod(project) !== "shape-up") return { ok: true };
  if (todo.repeatRule) {
    return failure(
      "shape_up_repeat_not_supported",
      "A repeating Todo cannot convert directly to a Shape Up task."
    );
  }
  if (!scopeId) return failure("scope_required", "A Shape Up scope is required for this task.");
  const scope = project.shapeUpPitch?.scopes.find((entry) => entry.id === scopeId);
  if (!scope) return failure("scope_not_found", `Shape Up scope ${scopeId} was not found.`);
  const betPlaced = Boolean(project.shapeUpPitch?.bet);
  if (betPlaced && !scope.confirmed) {
    return failure(
      "shape_up_scope_unconfirmed",
      `Shape Up scope ${scopeId} must be confirmed after the Bet.`
    );
  }
  return { ok: true, shapeUpScopeId: scope.id, shapeUpLocked: !betPlaced };
}

function workItemFromTodo(
  todo: Todo,
  project: Project,
  now: ISODate,
  timeZone: string,
  outline: string,
  shapeUpScopeId?: Id,
  shapeUpLocked?: boolean
): WorkItem {
  const estimate = nonNegativeSeconds(todo.estimatedSeconds ?? 0);
  const constraint = {
    ...(todo.deferUntil ? { noEarlierThan: todo.deferUntil } : {}),
    ...(todo.dueAt ? { noLaterThan: todo.dueAt } : {})
  };
  return {
    id: todo.id,
    projectId: project.id,
    kind: "task",
    title: todo.title,
    ...(todo.note === undefined ? {} : { description: todo.note }),
    tags: [...todo.tags],
    flagged: todo.flagged,
    checklist: cloneChecklist(todo.checklist),
    ...(todo.plannedForDate === undefined ? {} : { plannedForDate: todo.plannedForDate }),
    capturedAt: todo.capturedAt,
    updatedAt: now,
    ...(todo.completedAt === undefined ? {} : { completedAt: todo.completedAt }),
    outline,
    durationSeconds: estimate,
    estimate: { mostLikelySeconds: estimate },
    ...(Object.keys(constraint).length ? { constraint } : {}),
    assignmentIds: [],
    percentComplete: todo.status === "completed" ? 100 : 0,
    ...(todo.repeatRule === undefined ? {} : { repeatRule: remainingRepeatRule(todo, timeZone) }),
    ...(shapeUpScopeId === undefined ? {} : { shapeUpScopeId }),
    ...(shapeUpLocked === undefined ? {} : { shapeUpLocked })
  };
}

function todoFromWorkItem(snapshot: WorkspaceSnapshot, task: WorkItem, now: ISODate): Todo {
  const completed = task.percentComplete >= 100;
  const latestActual = snapshot.actuals
    .filter((entry) => entry.workItemId === task.id)
    .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
  const plannedForDate = task.plannedForDate ?? task.constraint?.fixedStart?.slice(0, 10);
  return {
    id: task.id,
    title: task.title,
    ...(task.description === undefined ? {} : { note: task.description }),
    tags: normalizeTags(task.tags ?? []),
    flagged: Boolean(task.flagged),
    estimatedSeconds: nonNegativeSeconds(task.estimate.mostLikelySeconds ?? task.durationSeconds),
    ...(task.constraint?.noEarlierThan === undefined
      ? {}
      : { deferUntil: task.constraint.noEarlierThan }),
    ...((task.constraint?.noLaterThan ?? task.constraint?.fixedFinish) === undefined
      ? {}
      : { dueAt: task.constraint?.noLaterThan ?? task.constraint?.fixedFinish }),
    ...(task.repeatRule === undefined ? {} : { repeatRule: cloneRepeatRule(task.repeatRule) }),
    checklist: cloneChecklist(task.checklist ?? []),
    ...(plannedForDate === undefined ? {} : { plannedForDate }),
    status: completed ? "completed" : "open",
    ...(completed ? { completedAt: task.completedAt ?? latestActual?.actualFinish ?? latestActual?.recordedAt ?? now } : {}),
    capturedAt: task.capturedAt ?? now,
    updatedAt: now,
    inbox: false
  };
}

function projectFromTodo(
  todo: Todo,
  input: ConvertTodoToProjectInput,
  projectId: Id,
  now: ISODate
): Project {
  const start = projectTimestamp(todo.deferUntil ?? todo.plannedForDate, todo.capturedAt || now);
  const horizon = projectTimestamp(todo.dueAt ?? todo.plannedForDate, start);
  const common: Project = {
    id: projectId,
    name: requiredText(input.name ?? todo.title, "Project name"),
    status: input.planningMethod === "shape-up" ? "waiting" : "active",
    mode: "build",
    priority: todo.flagged ? 5 : 3,
    northStar: todo.note?.trim() || todo.title,
    currentOutcome: todo.title,
    horizon,
    start,
    planningMethod: input.planningMethod,
    stage: input.planningMethod === "shape-up" ? "shape" : "plan",
    reviewCadenceDays: 7
  };
  if (input.planningMethod === "omniplan") return common;

  const scopeId = shapeUpScopeIdForTodo(todo.id);
  return {
    ...common,
    shapeUpPitch: createShapeUpPitch({
      problem: input.problem?.trim() || todo.note?.trim() || todo.title,
      scopes: [{
        id: scopeId,
        title: todo.title,
        description: todo.note?.trim() ?? "",
        confirmed: false,
        hillPosition: 0
      }],
      now
    })
  };
}

function conversionEntry(
  type: ConversionHistoryEntry["type"],
  itemId: Id,
  projectId: Id | undefined,
  occurredAt: ISODate,
  discardedFields: readonly string[]
): ConversionHistoryEntry {
  return {
    id: `conversion-${stableHash(`${type}|${itemId}|${projectId ?? ""}|${occurredAt}`)}`,
    type,
    itemId,
    ...(projectId === undefined ? {} : { projectId }),
    occurredAt,
    discardedFields: [...discardedFields].sort()
  };
}

function workspaceTodos(snapshot: WorkspaceSnapshot): Todo[] {
  return (snapshot as WorkspaceSnapshot & { todos?: Todo[] }).todos ?? [];
}

function workspaceConversionHistory(snapshot: WorkspaceSnapshot): ConversionHistoryEntry[] {
  return (snapshot as WorkspaceSnapshot & { conversionHistory?: ConversionHistoryEntry[] }).conversionHistory ?? [];
}

function withoutTaskReferences(item: WorkItem, taskId: Id): WorkItem {
  if (
    item.parentId !== taskId &&
    item.hammockStartId !== taskId &&
    item.hammockFinishId !== taskId
  ) {
    return item;
  }
  const next = { ...item };
  if (next.parentId === taskId) delete next.parentId;
  if (next.hammockStartId === taskId) delete next.hammockStartId;
  if (next.hammockFinishId === taskId) delete next.hammockFinishId;
  return next;
}

function omitBaselineItem(baseline: WorkspaceSnapshot["baselines"][number], itemId: Id) {
  return {
    ...baseline,
    plannedStartByItem: omitRecordKey(baseline.plannedStartByItem, itemId),
    plannedFinishByItem: omitRecordKey(baseline.plannedFinishByItem, itemId),
    plannedWorkSecondsByItem: omitRecordKey(baseline.plannedWorkSecondsByItem, itemId)
  };
}

function baselineReferencesItem(
  baseline: WorkspaceSnapshot["baselines"][number],
  itemId: Id
): boolean {
  return itemId in baseline.plannedStartByItem ||
    itemId in baseline.plannedFinishByItem ||
    itemId in baseline.plannedWorkSecondsByItem;
}

function omitRecordKey<T>(record: Record<Id, T>, itemId: Id): Record<Id, T> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== itemId));
}

function failure(code: TodoConversionErrorCode, message: string): TodoConversionFailure {
  return { ok: false, code, message };
}

function cloneRepeatRule(rule: RepeatRule): RepeatRule {
  return { ...rule };
}

function remainingRepeatRule(todo: Todo, timeZone: string): RepeatRule {
  const rule = cloneRepeatRule(todo.repeatRule!);
  const completedCount = normalizedRepeatCompletedCount(todo);
  if (completedCount <= 0) return rule;
  const nextOccurrence = repeatOccurrenceIso(todo, completedCount, timeZone);
  if (nextOccurrence) rule.startAt = nextOccurrence;
  if ((rule.endMode ?? "count") === "count") {
    rule.count = Math.max(1, Math.round(rule.count || 1) - completedCount);
  }
  return rule;
}

function cloneChecklist(checklist: readonly TodoChecklistItem[]): TodoChecklistItem[] {
  return checklist.map((item) => ({
    id: requiredText(item.id, "Checklist item id"),
    title: requiredText(item.title, "Checklist item title"),
    completed: Boolean(item.completed)
  }));
}

function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function nonNegativeSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.max(0, Math.round(value));
  return normalized > 0 ? normalized : undefined;
}

function normalizedRepeatCompletedCount(todo: Pick<Todo, "repeatCompletedCount">): number {
  return positiveInteger(todo.repeatCompletedCount) ?? 0;
}

function requiredText(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function optionalDateKey(value: string | undefined, timeZone: string): string | undefined {
  return value ? dateKey(value, timeZone) : undefined;
}

function dateKey(value: string, timeZone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  try {
    return zonedDateKey(value, timeZone);
  } catch {
    return value.slice(0, 10);
  }
}

function projectTimestamp(value: string | undefined, fallback: ISODate): ISODate {
  if (!value) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
}

function nextRootOutline(workItems: readonly WorkItem[], projectId: Id): string {
  const largest = workItems
    .filter((item) => item.projectId === projectId && !item.parentId)
    .reduce((maximum, item) => {
      const firstSegment = Number(item.outline.split(".")[0]);
      return Number.isFinite(firstSegment) ? Math.max(maximum, firstSegment) : maximum;
    }, 0);
  return String(largest + 1);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}
