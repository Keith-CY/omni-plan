import { createTodo } from "./todos";
import { addZonedCalendarDays, secondsBetween, zonedDateKey, zonedDateTimeToIso } from "./time";
import type {
  CaptureSource,
  DependencyType,
  Id,
  ISODate,
  ScheduleResult,
  Todo,
  WorkItem,
  WorkspaceSnapshot
} from "./types";

export interface CaptureTaskCommand {
  title: string;
  note?: string;
  estimateSeconds?: number;
  plannedForDate?: string;
  plannedStart?: ISODate;
  plannedFinish?: ISODate;
  source?: CaptureSource;
  idempotencyKey?: string;
  now?: ISODate;
}

export interface CaptureTaskReceipt {
  status: "captured" | "duplicate";
  taskId: Id;
  savedAt: ISODate;
  idempotencyKey?: string;
}

export interface CaptureTaskResult {
  workspace: WorkspaceSnapshot;
  task: Todo;
  receipt: CaptureTaskReceipt;
}

/** Stable user-facing reference. Todo/WorkItem conversion deliberately keeps this id. */
export interface TaskRef {
  taskId: Id;
}

export interface TaskDependencyView {
  id: Id;
  taskId: Id;
  title: string;
  type: DependencyType;
  completed: boolean;
}

export interface TaskView {
  id: Id;
  source: "todo" | "work-item";
  title: string;
  note?: string;
  projectId?: Id;
  projectName?: string;
  plannedForDate?: string;
  plannedStart?: ISODate;
  plannedFinish?: ISODate;
  effortSeconds: number;
  status: "open" | "completed";
  completedAt?: ISODate;
  dueAt?: ISODate;
  tags: string[];
  fixedTime: boolean;
  isCritical: boolean;
  blocked: boolean;
  predecessors: TaskDependencyView[];
  successors: TaskDependencyView[];
}

export interface DayPlan {
  date: string;
  tasks: TaskView[];
  scheduled: TaskView[];
  unscheduled: TaskView[];
  issues: Array<{
    severity: "info" | "warning" | "error";
    message: string;
    taskId?: Id;
  }>;
  capacitySeconds: number;
  plannedEffortSeconds: number;
  remainingCapacitySeconds: number;
  overCapacitySeconds: number;
}

const defaultDailyCapacitySeconds = 6 * 60 * 60;

export function captureTask(snapshot: WorkspaceSnapshot, command: CaptureTaskCommand): CaptureTaskResult {
  const title = command.title.trim();
  if (!title) throw new Error("Task title is required.");
  const savedAt = command.now ?? new Date().toISOString();
  const captureKey = command.idempotencyKey?.trim() || undefined;
  const existing = captureKey
    ? [...snapshot.todos, ...snapshot.workItems].find((item) => item.captureKey === captureKey)
    : undefined;

  if (existing) {
    const task = snapshot.todos.find((todo) => todo.id === existing.id) ?? todoProjection(existing as WorkItem, savedAt);
    return {
      workspace: snapshot,
      task,
      receipt: { status: "duplicate", taskId: existing.id, savedAt, idempotencyKey: captureKey }
    };
  }

  const id = nextCaptureId(snapshot, title, savedAt, captureKey);
  const plannedForDate = command.plannedForDate ?? (
    command.plannedStart ? zonedDateKey(command.plannedStart, snapshot.timeZone) : undefined
  );
  const task = createTodo({
    id,
    title,
    ...(command.note?.trim() ? { note: command.note.trim() } : {}),
    ...(command.estimateSeconds === undefined ? {} : { estimatedSeconds: command.estimateSeconds }),
    ...(plannedForDate === undefined ? {} : { plannedForDate }),
    ...(command.plannedStart === undefined ? {} : { plannedStart: command.plannedStart }),
    ...(command.plannedFinish === undefined ? {} : { plannedFinish: command.plannedFinish }),
    captureSource: command.source ?? "web",
    ...(captureKey === undefined ? {} : { captureKey })
  }, savedAt);

  return {
    workspace: { ...snapshot, todos: [task, ...snapshot.todos] },
    task,
    receipt: {
      status: "captured",
      taskId: task.id,
      savedAt,
      ...(captureKey === undefined ? {} : { idempotencyKey: captureKey })
    }
  };
}

export function undoCapturedTask(snapshot: WorkspaceSnapshot, taskId: Id): WorkspaceSnapshot {
  if (!snapshot.todos.some((todo) => todo.id === taskId)) return snapshot;
  return { ...snapshot, todos: snapshot.todos.filter((todo) => todo.id !== taskId) };
}

export function taskViewById(
  snapshot: WorkspaceSnapshot,
  schedules: readonly ScheduleResult[],
  taskId: Id
): TaskView | undefined {
  const scheduleById = scheduledItemsById(schedules);
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const workItemById = new Map(snapshot.workItems.map((item) => [item.id, item]));
  const todo = snapshot.todos.find((item) => item.id === taskId);
  if (todo) return viewFromTodo(todo);
  const item = workItemById.get(taskId);
  if (!item || item.kind === "phase") return undefined;
  return viewFromWorkItem(snapshot, item, scheduleById.get(item.id), projectById, workItemById);
}

export function taskRef(task: Pick<TaskView, "id"> | Pick<Todo, "id"> | Pick<WorkItem, "id">): TaskRef {
  return { taskId: task.id };
}

export function resolveTaskRef(
  snapshot: WorkspaceSnapshot,
  schedules: readonly ScheduleResult[],
  ref: TaskRef
): TaskView | undefined {
  return taskViewById(snapshot, schedules, ref.taskId);
}

export function selectDayPlan(
  snapshot: WorkspaceSnapshot,
  schedules: readonly ScheduleResult[],
  date: string,
  capacityFallbackSeconds = defaultDailyCapacitySeconds
): DayPlan {
  const scheduleById = scheduledItemsById(schedules);
  const projectById = new Map(snapshot.projects.map((project) => [project.id, project]));
  const workItemById = new Map(snapshot.workItems.map((item) => [item.id, item]));
  const views: TaskView[] = [
    ...snapshot.todos.filter((todo) => todoBelongsToDay(todo, date, snapshot.timeZone)).map(viewFromTodo),
    ...snapshot.workItems
      .filter((item) => item.kind !== "phase")
      .map((item) => viewFromWorkItem(snapshot, item, scheduleById.get(item.id), projectById, workItemById))
      .filter((task) => workItemBelongsToDay(task, date, snapshot.timeZone))
  ].sort(compareTaskViews);

  const capacity = snapshot.capacities.find((candidate) => dateKey(candidate.date, snapshot.timeZone) === date);
  const capacitySeconds = capacity
    ? capacity.deepSeconds + capacity.mediumSeconds + capacity.shallowSeconds
    : capacityFallbackSeconds;
  const plannedEffortSeconds = views
    .filter((task) => task.status === "open")
    .reduce((total, task) => total + task.effortSeconds, 0);
  const visibleTaskIds = new Set(views.map((task) => task.id));
  const visibleProjectIds = new Set(views.flatMap((task) => task.projectId ? [task.projectId] : []));
  const issues = collectDayPlanIssues(snapshot, schedules, visibleTaskIds, visibleProjectIds);

  return {
    date,
    tasks: views,
    scheduled: views.filter((task) => Boolean(task.plannedStart)),
    unscheduled: views.filter((task) => !task.plannedStart),
    issues,
    capacitySeconds,
    plannedEffortSeconds,
    remainingCapacitySeconds: Math.max(0, capacitySeconds - plannedEffortSeconds),
    overCapacitySeconds: Math.max(0, plannedEffortSeconds - capacitySeconds)
  };
}

export function dayBounds(date: string, timeZone: string): { start: ISODate; finish: ISODate } {
  const start = zonedDateTimeToIso(date, "00:00", timeZone);
  return { start, finish: addZonedCalendarDays(start, 1, timeZone) };
}

function viewFromTodo(todo: Todo): TaskView {
  const effortSeconds = Math.max(0, todo.estimatedSeconds ?? plannedSpan(todo.plannedStart, todo.plannedFinish));
  return {
    id: todo.id,
    source: "todo",
    title: todo.title,
    ...(todo.note === undefined ? {} : { note: todo.note }),
    ...(todo.plannedForDate === undefined ? {} : { plannedForDate: todo.plannedForDate }),
    ...(todo.plannedStart === undefined ? {} : { plannedStart: todo.plannedStart }),
    ...(todo.plannedFinish === undefined ? {} : { plannedFinish: todo.plannedFinish }),
    effortSeconds,
    status: todo.status,
    ...(todo.completedAt === undefined ? {} : { completedAt: todo.completedAt }),
    ...(todo.dueAt === undefined ? {} : { dueAt: todo.dueAt }),
    tags: [...todo.tags],
    fixedTime: Boolean(todo.plannedStart),
    isCritical: false,
    blocked: false,
    predecessors: [],
    successors: []
  };
}

function viewFromWorkItem(
  snapshot: WorkspaceSnapshot,
  item: WorkItem,
  scheduled: ScheduleResult["items"][number] | undefined,
  projectById: Map<Id, WorkspaceSnapshot["projects"][number]>,
  workItemById: Map<Id, WorkItem>
): TaskView {
  const dependencyView = (dependency: WorkspaceSnapshot["dependencies"][number], direction: "from" | "to") => {
    const otherId = direction === "from" ? dependency.fromId : dependency.toId;
    const other = workItemById.get(otherId);
    return {
      id: dependency.id,
      taskId: otherId,
      title: other?.title ?? "已删除事项",
      type: dependency.type,
      completed: Boolean(other && other.percentComplete >= 100)
    } satisfies TaskDependencyView;
  };
  const predecessors = snapshot.dependencies
    .filter((dependency) => dependency.toId === item.id)
    .map((dependency) => dependencyView(dependency, "from"));
  const successors = snapshot.dependencies
    .filter((dependency) => dependency.fromId === item.id)
    .map((dependency) => dependencyView(dependency, "to"));
  const effortSeconds = item.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0)
    || item.estimate.mostLikelySeconds
    || item.durationSeconds;
  return {
    id: item.id,
    source: "work-item",
    title: item.title,
    ...(item.description === undefined ? {} : { note: item.description }),
    projectId: item.projectId,
    projectName: projectById.get(item.projectId)?.name ?? "项目",
    ...(item.plannedForDate === undefined ? {} : { plannedForDate: item.plannedForDate }),
    ...(scheduled?.start === undefined ? {} : { plannedStart: scheduled.start }),
    ...(scheduled?.finish === undefined ? {} : { plannedFinish: scheduled.finish }),
    effortSeconds,
    status: item.percentComplete >= 100 ? "completed" : "open",
    ...(item.completedAt === undefined ? {} : { completedAt: item.completedAt }),
    ...(item.constraint?.noLaterThan === undefined ? {} : { dueAt: item.constraint.noLaterThan }),
    tags: [...(item.tags ?? [])],
    fixedTime: Boolean(item.constraint?.fixedStart),
    isCritical: Boolean(scheduled?.isCritical),
    blocked: predecessors.some((dependency) => !dependency.completed),
    predecessors,
    successors
  };
}

function todoBelongsToDay(todo: Todo, date: string, timeZone: string): boolean {
  if (todo.plannedStart) {
    const { start, finish } = dayBounds(date, timeZone);
    const taskFinish = todo.plannedFinish ?? todo.plannedStart;
    if (taskFinish === todo.plannedStart) {
      if (zonedDateKey(todo.plannedStart, timeZone) === date) return true;
    } else if (todo.plannedStart < finish && taskFinish > start) {
      return true;
    }
  } else if (todo.plannedForDate === date) {
    return true;
  }
  if (todo.status === "completed") return Boolean(todo.completedAt && zonedDateKey(todo.completedAt, timeZone) === date);
  if (todo.dueAt && zonedDateKey(todo.dueAt, timeZone) <= date) return true;
  if (todo.deferUntil && zonedDateKey(todo.deferUntil, timeZone) <= date) return true;
  return false;
}

function workItemBelongsToDay(task: TaskView, date: string, timeZone: string): boolean {
  if (task.plannedStart) {
    if (!task.plannedFinish || task.plannedFinish === task.plannedStart) {
      return zonedDateKey(task.plannedStart, timeZone) === date;
    }
    const { start, finish } = dayBounds(date, timeZone);
    return task.plannedStart < finish && task.plannedFinish > start;
  }
  if (task.plannedForDate === date) return true;
  return Boolean(task.status === "completed" && task.completedAt && zonedDateKey(task.completedAt, timeZone) === date);
}

function collectDayPlanIssues(
  snapshot: WorkspaceSnapshot,
  schedules: readonly ScheduleResult[],
  visibleTaskIds: ReadonlySet<Id>,
  visibleProjectIds: ReadonlySet<Id>
): DayPlan["issues"] {
  const knownWorkItemIds = new Set(snapshot.workItems.map((item) => item.id));
  const issues: DayPlan["issues"] = [];

  for (const schedule of schedules) {
    if (!visibleProjectIds.has(schedule.projectId)) continue;
    for (const diagnostic of schedule.diagnostics) {
      if (diagnostic.itemId && !visibleTaskIds.has(diagnostic.itemId)) continue;
      issues.push({
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.itemId ? { taskId: diagnostic.itemId } : {})
      });
    }
    for (const item of schedule.items) {
      if (!visibleTaskIds.has(item.workItem.id)) continue;
      for (const warning of item.warnings) {
        issues.push({ severity: "warning", message: warning, taskId: item.workItem.id });
      }
    }
  }

  for (const dependency of snapshot.dependencies) {
    const missingFrom = !knownWorkItemIds.has(dependency.fromId);
    const missingTo = !knownWorkItemIds.has(dependency.toId);
    if (!missingFrom && !missingTo) continue;
    const visibleId = visibleTaskIds.has(dependency.fromId)
      ? dependency.fromId
      : visibleTaskIds.has(dependency.toId)
        ? dependency.toId
        : undefined;
    if (!visibleId) continue;
    issues.push({
      severity: "error",
      message: "任务依赖指向了已删除的事项，请在项目计划中修复。",
      taskId: visibleId
    });
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.severity}|${issue.taskId ?? ""}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scheduledItemsById(schedules: readonly ScheduleResult[]) {
  return new Map(schedules.flatMap((schedule) => schedule.items.map((item) => [item.workItem.id, item] as const)));
}

function compareTaskViews(left: TaskView, right: TaskView): number {
  if (left.plannedStart && right.plannedStart) return left.plannedStart.localeCompare(right.plannedStart) || left.title.localeCompare(right.title);
  if (left.plannedStart) return -1;
  if (right.plannedStart) return 1;
  if (left.status !== right.status) return left.status === "open" ? -1 : 1;
  return left.title.localeCompare(right.title);
}

function plannedSpan(start?: ISODate, finish?: ISODate): number {
  if (!start || !finish) return 0;
  return Math.max(0, secondsBetween(start, finish));
}

function dateKey(value: string, timeZone: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : zonedDateKey(value, timeZone);
}

function nextCaptureId(snapshot: WorkspaceSnapshot, title: string, savedAt: ISODate, captureKey?: string): Id {
  const existing = new Set([...snapshot.todos, ...snapshot.workItems].map((item) => item.id));
  const seed = captureKey ?? `${savedAt}|${title}`;
  const base = `task-${stableHash(seed)}`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function todoProjection(item: WorkItem, now: ISODate): Todo {
  return createTodo({
    id: item.id,
    title: item.title,
    note: item.description,
    tags: item.tags ?? [],
    estimatedSeconds: item.estimate.mostLikelySeconds,
    status: item.percentComplete >= 100 ? "completed" : "open",
    capturedAt: item.capturedAt ?? now,
    captureSource: item.captureSource,
    captureKey: item.captureKey
  }, now);
}
