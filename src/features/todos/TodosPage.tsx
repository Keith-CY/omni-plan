import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Flag,
  FolderKanban,
  Inbox,
  ListTodo,
  Plus,
  Repeat2,
  Search,
  Tags,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import type {
  Id,
  PlanningMethod,
  Project,
  RepeatCadenceKind,
  RepeatEndMode,
  RepeatRule,
  ShapeUpScope,
  Todo,
  TodoChecklistItem,
  WorkspaceSnapshot
} from "../../domain/types";
import { zonedDateTimeToIso } from "../../domain/time";
import { QuickTaskCapture } from "../task-capture/QuickTaskCapture";
import "./todos.css";

export type TodosFilter = "inbox" | "all" | "flagged" | "tags" | "completed";
export type ProjectPlanningMethod = PlanningMethod;
export type TodosPageCallbackResult = void | Promise<void>;

export interface TodoUpdatePatch {
  title?: string;
  note?: string;
  tags?: string[];
  flagged?: boolean;
  estimatedSeconds?: number;
  deferUntil?: string;
  dueAt?: string;
  plannedForDate?: string;
  plannedStart?: string;
  plannedFinish?: string;
  repeatRule?: RepeatRule;
  checklist?: TodoChecklistItem[];
}

export interface ConvertTodoToTaskInput {
  todoId: Id;
  projectId: Id;
  shapeUpScopeId?: Id;
}

export interface ConvertTodoToProjectInput {
  todoId: Id;
  planningMethod: ProjectPlanningMethod;
}

export interface TodosPageProps {
  snapshot: WorkspaceSnapshot;
  initialFilter?: TodosFilter;
  selectedTodoId?: Id;
  onSelectionChange?: (todoId: Id | undefined) => void;
  onCapture: (title: string) => string | undefined;
  onUndoCapture: (todoId: Id) => TodosPageCallbackResult;
  onUpdateTodo: (todoId: Id, patch: TodoUpdatePatch) => TodosPageCallbackResult;
  onCompleteTodo: (todoId: Id) => TodosPageCallbackResult;
  onRestoreTodo: (todoId: Id) => TodosPageCallbackResult;
  onKeepAsTodo: (todoId: Id) => TodosPageCallbackResult;
  onConvertToTask: (input: ConvertTodoToTaskInput) => TodosPageCallbackResult;
  onConvertToProject: (input: ConvertTodoToProjectInput) => TodosPageCallbackResult;
  onRequestCreateProject?: () => void;
}

type ConfirmationState =
  | { kind: "keep"; todo: Todo }
  | { kind: "task"; todo: Todo }
  | { kind: "project"; todo: Todo };

interface TodoDraft {
  title: string;
  note: string;
  tags: string;
  flagged: boolean;
  estimatedMinutes: string;
  deferUntil: string;
  dueAt: string;
  plannedForDate: string;
  repeatCadence: "none" | RepeatCadenceKind;
  repeatEveryDays: string;
  repeatStartDate: string;
  repeatStartTime: string;
  repeatCount: string;
  repeatEndMode: RepeatEndMode;
  repeatUntil: string;
  repeatUseExistingAdvanced: boolean;
  checklist: TodoChecklistItem[];
}

interface FilterDefinition {
  id: TodosFilter;
  label: string;
  ariaLabel: string;
  icon: typeof Inbox;
}

const FILTERS: FilterDefinition[] = [
  { id: "inbox", label: "收件箱", ariaLabel: "Inbox", icon: Inbox },
  { id: "all", label: "全部", ariaLabel: "All", icon: ListTodo },
  { id: "flagged", label: "重点", ariaLabel: "Flagged", icon: Flag },
  { id: "tags", label: "标签", ariaLabel: "Tags", icon: Tags },
  { id: "completed", label: "已完成", ariaLabel: "Completed", icon: CheckCircle2 }
];

function dateInputValue(value?: string): string {
  return value ? value.slice(0, 10) : "";
}

function zonedDateTimeParts(value: string | undefined, timeZone: string): { date: string; time: string } | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value, time: "09:00" };
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return { date: value.slice(0, 10), time: value.slice(11, 16) || "09:00" };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`
  };
}

function todayInTimeZone(timeZone: string): string {
  return zonedDateTimeParts(new Date().toISOString(), timeZone)?.date ?? new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T12:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function defaultRepeatCount(cadence: RepeatCadenceKind): number {
  if (cadence === "monthly") return 3;
  if (cadence === "weekly") return 4;
  return 7;
}

function defaultRepeatUntil(startDate: string, cadence: RepeatCadenceKind): string {
  if (cadence === "monthly") return addDays(startDate, 90);
  if (cadence === "weekly") return addDays(startDate, 28);
  return addDays(startDate, 7);
}

function draftFromTodo(todo: Todo, timeZone: string): TodoDraft {
  const repeatStart = zonedDateTimeParts(todo.repeatRule?.startAt, timeZone);
  const repeatUntil = zonedDateTimeParts(todo.repeatRule?.until, timeZone);
  const defaultStartDate =
    dateInputValue(todo.plannedForDate) ||
    zonedDateTimeParts(todo.deferUntil, timeZone)?.date ||
    zonedDateTimeParts(todo.dueAt, timeZone)?.date ||
    todayInTimeZone(timeZone);
  return {
    title: todo.title,
    note: todo.note ?? "",
    tags: todo.tags.join(", "),
    flagged: todo.flagged,
    estimatedMinutes: todo.estimatedSeconds ? String(Math.round(todo.estimatedSeconds / 60)) : "",
    deferUntil: dateInputValue(todo.deferUntil),
    dueAt: dateInputValue(todo.dueAt),
    plannedForDate: dateInputValue(todo.plannedForDate),
    repeatCadence: todo.repeatRule?.cadence ?? (todo.repeatRule ? "every-n-days" : "none"),
    repeatEveryDays: String(Math.max(1, Math.round(todo.repeatRule?.everyDays ?? 1))),
    repeatStartDate: repeatStart?.date ?? defaultStartDate,
    repeatStartTime: repeatStart?.time ?? "09:00",
    repeatCount: String(Math.max(1, Math.round(todo.repeatRule?.count ?? 7))),
    repeatEndMode: todo.repeatRule?.endMode ?? "count",
    repeatUntil: repeatUntil?.date ?? defaultRepeatUntil(defaultStartDate, todo.repeatRule?.cadence ?? "every-n-days"),
    repeatUseExistingAdvanced: Boolean(todo.repeatRule),
    checklist: todo.checklist.map((item) => ({ ...item }))
  };
}

function withRepeatCadence(
  draft: TodoDraft,
  cadence: TodoDraft["repeatCadence"],
  timeZone: string
): TodoDraft {
  if (cadence === "none") return { ...draft, repeatCadence: "none", repeatUseExistingAdvanced: false };
  if (draft.repeatCadence !== "none") {
    const startDate = draft.repeatStartDate || draft.plannedForDate || todayInTimeZone(timeZone);
    return {
      ...draft,
      repeatCadence: cadence,
      repeatEveryDays: cadence === "every-n-days" ? draft.repeatEveryDays || "1" : draft.repeatEveryDays,
      repeatCount: draft.repeatUseExistingAdvanced ? draft.repeatCount : String(defaultRepeatCount(cadence)),
      repeatUntil: draft.repeatUseExistingAdvanced ? draft.repeatUntil : defaultRepeatUntil(startDate, cadence)
    };
  }
  const startDate = draft.plannedForDate || draft.repeatStartDate || todayInTimeZone(timeZone);
  return {
    ...draft,
    repeatCadence: cadence,
    repeatEveryDays: "1",
    repeatStartDate: startDate,
    repeatStartTime: draft.repeatStartTime || "09:00",
    repeatCount: String(defaultRepeatCount(cadence)),
    repeatEndMode: "count",
    repeatUntil: defaultRepeatUntil(startDate, cadence),
    repeatUseExistingAdvanced: false
  };
}

function repeatRuleFromDraft(todo: Todo, draft: TodoDraft, timeZone: string): RepeatRule | undefined {
  if (draft.repeatCadence === "none") return undefined;
  if (!draft.repeatStartDate || !draft.repeatStartTime) throw new Error("Choose when this repeating Todo starts.");
  if (draft.repeatEndMode === "until" && !draft.repeatUntil) throw new Error("Choose an end date for this repeat rule.");

  const existing = draft.repeatUseExistingAdvanced ? todo.repeatRule : undefined;
  const next: RepeatRule = {
    ...existing,
    cadence: draft.repeatCadence,
    count: Math.max(1, Math.round(Number(draft.repeatCount) || 1)),
    startMode: existing?.startMode ?? "fixed-time",
    startAt: zonedDateTimeToIso(draft.repeatStartDate, draft.repeatStartTime, timeZone),
    executionMode: existing?.executionMode ?? "manual",
    endMode: draft.repeatEndMode,
    ...(draft.repeatCadence === "every-n-days"
      ? { everyDays: Math.max(1, Math.round(Number(draft.repeatEveryDays) || 1)) }
      : {}),
    ...(draft.repeatUntil && (draft.repeatEndMode === "until" || existing?.until)
      ? { until: zonedDateTimeToIso(draft.repeatUntil, "23:59", timeZone) }
      : {})
  };
  return next;
}

function normalizeTags(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,#]/)
        .map((tag) => tag.trim())
        .filter(Boolean)
    )
  );
}

function makeChecklistItem(title: string): TodoChecklistItem {
  const id = globalThis.crypto?.randomUUID?.() ?? `check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, title, completed: false };
}

function formatDate(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function formatRepeat(rule?: RepeatRule): string | undefined {
  if (!rule) return undefined;
  if (rule.cadence === "monthly") return "每月";
  if (rule.cadence === "weekly") return "每周";
  const everyDays = Math.max(1, Math.round(rule.everyDays ?? 1));
  return everyDays === 1 ? "每天" : `每 ${everyDays} 天`;
}

function todoMatchesSearch(todo: Todo, query: string): boolean {
  if (!query) return true;
  const haystack = [todo.title, todo.note ?? "", ...todo.tags, ...todo.checklist.map((item) => item.title)]
    .join(" ")
    .toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

function compareTodos(left: Todo, right: Todo): number {
  if (left.flagged !== right.flagged) return left.flagged ? -1 : 1;
  if (left.dueAt && right.dueAt) return left.dueAt.localeCompare(right.dueAt);
  if (left.dueAt) return -1;
  if (right.dueAt) return 1;
  return right.updatedAt.localeCompare(left.updatedAt);
}

function callbackError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "That change could not be saved. Please try again.";
}

export function TodosPage({
  snapshot,
  initialFilter = "inbox",
  selectedTodoId,
  onSelectionChange,
  onCapture,
  onUndoCapture,
  onUpdateTodo,
  onCompleteTodo,
  onRestoreTodo,
  onKeepAsTodo,
  onConvertToTask,
  onConvertToProject,
  onRequestCreateProject
}: TodosPageProps) {
  const [filter, setFilter] = useState<TodosFilter>(initialFilter);
  const [selectedTag, setSelectedTag] = useState<string>();
  const [query, setQuery] = useState("");
  const [expandedTodoId, setExpandedTodoId] = useState<Id | undefined>(selectedTodoId);
  const [confirmation, setConfirmation] = useState<ConfirmationState>();
  const [selectedProjectId, setSelectedProjectId] = useState<Id>("");
  const [selectedScopeId, setSelectedScopeId] = useState<Id>("");
  const [planningMethod, setPlanningMethod] = useState<ProjectPlanningMethod>("omniplan");
  const [pendingDialog, setPendingDialog] = useState(false);
  const [dialogError, setDialogError] = useState("");

  const openTodos = useMemo(() => snapshot.todos.filter((todo) => todo.status === "open"), [snapshot.todos]);
  const completedTodos = useMemo(
    () => snapshot.todos.filter((todo) => todo.status === "completed"),
    [snapshot.todos]
  );
  const availableProjects = useMemo(
    () => snapshot.projects.filter((project) => !project.archived && project.status !== "archived" && project.status !== "done"),
    [snapshot.projects]
  );
  const tagsInUse = useMemo(
    () => Array.from(new Set(openTodos.flatMap((todo) => todo.tags))).sort((left, right) => left.localeCompare(right)),
    [openTodos]
  );

  const counts: Record<TodosFilter, number> = {
    inbox: openTodos.filter((todo) => todo.inbox).length,
    all: openTodos.length,
    flagged: openTodos.filter((todo) => todo.flagged).length,
    tags: openTodos.filter((todo) => todo.tags.length > 0).length,
    completed: completedTodos.length
  };

  const filteredTodos = useMemo(() => {
    const candidates = filter === "completed" ? completedTodos : openTodos;
    return candidates
      .filter((todo) => {
        if (filter === "inbox" && !todo.inbox) return false;
        if (filter === "flagged" && !todo.flagged) return false;
        if (filter === "tags" && (todo.tags.length === 0 || (selectedTag && !todo.tags.includes(selectedTag)))) return false;
        return todoMatchesSearch(todo, query.trim());
      })
      .sort(compareTodos);
  }, [completedTodos, filter, openTodos, query, selectedTag]);

  const selectedProject = availableProjects.find((project) => project.id === selectedProjectId);
  const selectedProjectScopes = selectedProject?.shapeUpPitch?.scopes ?? [];

  useEffect(() => {
    if (selectedTodoId !== undefined) setExpandedTodoId(selectedTodoId);
  }, [selectedTodoId]);

  useEffect(() => {
    if (filter !== "tags") setSelectedTag(undefined);
  }, [filter]);

  function selectFilter(nextFilter: TodosFilter) {
    setFilter(nextFilter);
    setExpandedTodoId(undefined);
    onSelectionChange?.(undefined);
  }

  function toggleExpanded(todoId: Id) {
    const nextId = expandedTodoId === todoId ? undefined : todoId;
    setExpandedTodoId(nextId);
    onSelectionChange?.(nextId);
  }

  function openConfirmation(nextConfirmation: ConfirmationState) {
    setDialogError("");
    setPendingDialog(false);
    setConfirmation(nextConfirmation);
    if (nextConfirmation.kind === "task") {
      setSelectedProjectId(availableProjects[0]?.id ?? "");
      setSelectedScopeId("");
    }
    if (nextConfirmation.kind === "project") setPlanningMethod("omniplan");
  }

  function closeConfirmation() {
    if (pendingDialog) return;
    setConfirmation(undefined);
    setDialogError("");
  }

  async function confirmDialog() {
    if (!confirmation) return;
    setPendingDialog(true);
    setDialogError("");
    try {
      if (confirmation.kind === "keep") {
        await onKeepAsTodo(confirmation.todo.id);
      } else if (confirmation.kind === "task") {
        if (!selectedProjectId) throw new Error("Choose a project before converting this Todo.");
        await onConvertToTask({
          todoId: confirmation.todo.id,
          projectId: selectedProjectId,
          shapeUpScopeId: selectedScopeId || undefined
        });
      } else {
        await onConvertToProject({ todoId: confirmation.todo.id, planningMethod });
      }
      setConfirmation(undefined);
      setExpandedTodoId(undefined);
      onSelectionChange?.(undefined);
    } catch (error) {
      setDialogError(callbackError(error));
    } finally {
      setPendingDialog(false);
    }
  }

  const filterLabel = FILTERS.find((item) => item.id === filter)?.label ?? "任务";

  return (
    <section className="todosPage" aria-labelledby="todos-page-title">
      <header className="todosPage__header">
        <div>
          <p className="todosPage__eyebrow">随手记录</p>
          <div className="todosPage__titleRow">
            <h2 id="todos-page-title">收件箱</h2>
            <span className="todosPage__total" aria-label={`${openTodos.length} 个待办`}>
              {openTodos.length}
            </span>
          </div>
          <p className="todosPage__subtitle">先把事情记下来；时间、工作量和项目归属都可以稍后再补。</p>
        </div>
        <label className="todosPage__search">
          <Search aria-hidden="true" />
          <span className="todosPage__srOnly">搜索任务</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
      </header>

      <QuickTaskCapture
        inputId="inbox-quick-capture"
        className="todosPage__quickCapture"
        placeholder="记下一件事，稍后再整理…"
        onCapture={onCapture}
        onUndo={onUndoCapture}
      />

      <nav className="todosPage__filters" aria-label="任务视图">
        {FILTERS.map(({ id, label, ariaLabel, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="todosPage__filter"
            data-active={filter === id}
            aria-pressed={filter === id}
            aria-label={ariaLabel}
            onClick={() => selectFilter(id)}
          >
            <Icon aria-hidden="true" />
            <span>{label}</span>
            <span className="todosPage__filterCount" aria-hidden="true">
              {counts[id]}
            </span>
          </button>
        ))}
      </nav>

      {filter === "tags" ? (
        <div className="todosPage__tagFilters" aria-label="Filter Todos by tag">
          <button
            type="button"
            className="todosPage__tagFilter"
            data-active={!selectedTag}
            aria-pressed={!selectedTag}
            onClick={() => setSelectedTag(undefined)}
          >
            All tags
          </button>
          {tagsInUse.map((tag) => (
            <button
              key={tag}
              type="button"
              className="todosPage__tagFilter"
              data-active={selectedTag === tag}
              aria-pressed={selectedTag === tag}
              onClick={() => setSelectedTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      <div className="todosPage__listHeader">
        <div>
          <strong>{selectedTag ? `#${selectedTag}` : filterLabel}</strong>
          <span>{filteredTodos.length} 项</span>
        </div>
        <span className="todosPage__listHint">点开任务后再补充安排或拆成项目</span>
      </div>

      {filteredTodos.length > 0 ? (
        <ul className="todosPage__list" aria-label={`${filterLabel} Todos`}>
          {filteredTodos.map((todo) => (
            <TodoRow
              key={todo.id}
              todo={todo}
              timeZone={snapshot.timeZone}
              expanded={expandedTodoId === todo.id}
              onToggleExpanded={() => toggleExpanded(todo.id)}
              onUpdate={onUpdateTodo}
              onComplete={onCompleteTodo}
              onRestore={onRestoreTodo}
              onKeep={() => openConfirmation({ kind: "keep", todo })}
              onConvertToTask={() => openConfirmation({ kind: "task", todo })}
              onConvertToProject={() => openConfirmation({ kind: "project", todo })}
            />
          ))}
        </ul>
      ) : (
        <EmptyTodos filter={filter} hasQuery={Boolean(query.trim())} selectedTag={selectedTag} />
      )}

      <TodoConfirmationDialog
        state={confirmation}
        projects={availableProjects}
        selectedProjectId={selectedProjectId}
        selectedScopeId={selectedScopeId}
        selectedProjectScopes={selectedProjectScopes}
        planningMethod={planningMethod}
        pending={pendingDialog}
        error={dialogError}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
        onProjectChange={(projectId) => {
          setSelectedProjectId(projectId);
          setSelectedScopeId("");
        }}
        onScopeChange={setSelectedScopeId}
        onPlanningMethodChange={setPlanningMethod}
        onConfirm={confirmDialog}
        onCancel={closeConfirmation}
        onRequestCreateProject={onRequestCreateProject}
      />
    </section>
  );
}

interface TodoRowProps {
  todo: Todo;
  timeZone: string;
  expanded: boolean;
  onToggleExpanded: () => void;
  onUpdate: TodosPageProps["onUpdateTodo"];
  onComplete: TodosPageProps["onCompleteTodo"];
  onRestore: TodosPageProps["onRestoreTodo"];
  onKeep: () => void;
  onConvertToTask: () => void;
  onConvertToProject: () => void;
}

function TodoRow({
  todo,
  timeZone,
  expanded,
  onToggleExpanded,
  onUpdate,
  onComplete,
  onRestore,
  onKeep,
  onConvertToTask,
  onConvertToProject
}: TodoRowProps) {
  const completed = todo.status === "completed";
  const checklistDone = todo.checklist.filter((item) => item.completed).length;
  const dueLabel = formatDate(todo.dueAt);
  const deferLabel = formatDate(todo.deferUntil);
  const planLabel = formatDate(todo.plannedForDate);
  const repeatLabel = formatRepeat(todo.repeatRule);
  const [rowError, setRowError] = useState("");
  const [toggling, setToggling] = useState(false);

  async function runRowAction(action: () => TodosPageCallbackResult) {
    setToggling(true);
    setRowError("");
    try {
      await action();
    } catch (error) {
      setRowError(callbackError(error));
    } finally {
      setToggling(false);
    }
  }

  return (
    <li className="todoRow" data-expanded={expanded} data-completed={completed}>
      <div className="todoRow__summary">
        <button
          type="button"
          className="todoRow__complete"
          data-completed={completed}
          disabled={toggling}
          aria-label={completed ? `Restore ${todo.title}` : `Complete ${todo.title}`}
          onClick={() => runRowAction(() => (completed ? onRestore(todo.id) : onComplete(todo.id)))}
        >
          {completed ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
        </button>

        <button
          type="button"
          className="todoRow__content"
          aria-expanded={expanded}
          aria-controls={`todo-editor-${todo.id}`}
          onClick={onToggleExpanded}
        >
          <span className="todoRow__titleLine">
            <span className="todoRow__title">{todo.title}</span>
            {todo.inbox && !completed ? <span className="todoRow__inboxBadge">收件箱</span> : null}
          </span>
          <span className="todoRow__meta">
            {dueLabel ? (
              <span className="todoRow__due">
                <CalendarDays aria-hidden="true" /> 截止 {dueLabel}
              </span>
            ) : null}
            {deferLabel ? (
              <span>
                <Clock3 aria-hidden="true" /> 可开始 {deferLabel}
              </span>
            ) : null}
            {planLabel ? (
              <span>
                <CalendarDays aria-hidden="true" /> 安排 {planLabel}
              </span>
            ) : null}
            {repeatLabel ? (
              <span>
                <Repeat2 aria-hidden="true" /> {repeatLabel}
              </span>
            ) : null}
            {todo.estimatedSeconds ? <span>{Math.max(1, Math.round(todo.estimatedSeconds / 60))} 分钟</span> : null}
            {todo.checklist.length > 0 ? (
              <span>
                <CheckCircle2 aria-hidden="true" /> {checklistDone}/{todo.checklist.length}
              </span>
            ) : null}
            {todo.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="todoRow__tag">
                {tag}
              </span>
            ))}
          </span>
        </button>

        <button
          type="button"
          className="todoRow__flag"
          data-active={todo.flagged}
          disabled={toggling || completed}
          aria-pressed={todo.flagged}
          aria-label={todo.flagged ? `Unflag ${todo.title}` : `Flag ${todo.title}`}
          onClick={() => runRowAction(() => onUpdate(todo.id, { flagged: !todo.flagged }))}
        >
          <Flag aria-hidden="true" />
        </button>
        <button
          type="button"
          className="todoRow__expand"
          aria-expanded={expanded}
          aria-controls={`todo-editor-${todo.id}`}
          aria-label={expanded ? `Close details for ${todo.title}` : `Edit ${todo.title}`}
          onClick={onToggleExpanded}
        >
          {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        </button>
      </div>

      {rowError ? (
        <p className="todoRow__error" role="alert">
          {rowError}
        </p>
      ) : null}

      {expanded ? (
        <TodoEditor
          id={`todo-editor-${todo.id}`}
          todo={todo}
          timeZone={timeZone}
          onSave={onUpdate}
          onCancel={onToggleExpanded}
          onKeep={onKeep}
          onConvertToTask={onConvertToTask}
          onConvertToProject={onConvertToProject}
        />
      ) : null}
    </li>
  );
}

interface TodoEditorProps {
  id: string;
  todo: Todo;
  timeZone: string;
  onSave: TodosPageProps["onUpdateTodo"];
  onCancel: () => void;
  onKeep: () => void;
  onConvertToTask: () => void;
  onConvertToProject: () => void;
}

function TodoEditor({ id, todo, timeZone, onSave, onCancel, onKeep, onConvertToTask, onConvertToProject }: TodoEditorProps) {
  const [draft, setDraft] = useState<TodoDraft>(() => draftFromTodo(todo, timeZone));
  const [newChecklistTitle, setNewChecklistTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const todayDate = todayInTimeZone(timeZone);

  useEffect(() => {
    setDraft(draftFromTodo(todo, timeZone));
  }, [timeZone, todo]);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = draft.title.trim();
    if (!title) {
      setSaveError("保存前请先填写标题。");
      titleInputRef.current?.focus();
      return;
    }
    setSaving(true);
    setSaveError("");
    try {
      const parsedMinutes = draft.estimatedMinutes ? Number(draft.estimatedMinutes) : undefined;
      await onSave(todo.id, {
        title,
        note: draft.note.trim() || undefined,
        tags: normalizeTags(draft.tags),
        flagged: draft.flagged,
        estimatedSeconds:
          parsedMinutes !== undefined && Number.isFinite(parsedMinutes) ? Math.max(0, Math.round(parsedMinutes * 60)) : undefined,
        deferUntil: draft.deferUntil || undefined,
        dueAt: draft.dueAt || undefined,
        plannedForDate: draft.plannedForDate || undefined,
        repeatRule: repeatRuleFromDraft(todo, draft, timeZone),
        checklist: draft.checklist.map((item) => ({ ...item, title: item.title.trim() })).filter((item) => item.title)
      });
      onCancel();
    } catch (error) {
      setSaveError(callbackError(error));
    } finally {
      setSaving(false);
    }
  }

  function addChecklistItem() {
    const title = newChecklistTitle.trim();
    if (!title) return;
    setDraft((current) => ({ ...current, checklist: [...current.checklist, makeChecklistItem(title)] }));
    setNewChecklistTitle("");
  }

  return (
    <form id={id} className="todoEditor" onSubmit={submit}>
      <div className="todoEditor__grid">
        <label className="todoEditor__field todoEditor__field--wide">
          <span>标题</span>
          <input
            ref={titleInputRef}
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            required
          />
        </label>
        <label className="todoEditor__field todoEditor__field--wide">
          <span>备注</span>
          <textarea
            value={draft.note}
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
            rows={2}
            placeholder="背景、链接或下一步"
          />
        </label>
        <label className="todoEditor__field">
          <span>可开始日期</span>
          <input
            type="date"
            value={draft.deferUntil}
            onChange={(event) => setDraft((current) => ({ ...current, deferUntil: event.target.value }))}
          />
        </label>
        <label className="todoEditor__field">
          <span>截止日期</span>
          <input
            type="date"
            value={draft.dueAt}
            onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))}
          />
        </label>
        <label className="todoEditor__field todoEditor__planField">
          <span>计划日期</span>
          <span className="todoEditor__dateWithAction">
            <input
              type="date"
              value={draft.plannedForDate}
              onChange={(event) => setDraft((current) => ({ ...current, plannedForDate: event.target.value }))}
              aria-label="Plan date"
            />
            <button
              type="button"
              data-active={draft.plannedForDate === todayDate}
              aria-label="Set plan date to Today"
              onClick={() => setDraft((current) => ({ ...current, plannedForDate: todayDate }))}
            >
              今天
            </button>
          </span>
        </label>
        <label className="todoEditor__field">
          <span>预估工作量</span>
          <span className="todoEditor__numberInput">
            <input
              type="number"
              inputMode="numeric"
              min="0"
              step="5"
              value={draft.estimatedMinutes}
              onChange={(event) => setDraft((current) => ({ ...current, estimatedMinutes: event.target.value }))}
              aria-label="Estimated minutes"
            />
            <span>分钟</span>
          </span>
        </label>
        <label className="todoEditor__field">
          <span>标签</span>
          <input
            value={draft.tags}
            onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
            placeholder="家庭，电话"
          />
        </label>
        <label className="todoEditor__flagToggle">
          <input
            type="checkbox"
            checked={draft.flagged}
            onChange={(event) => setDraft((current) => ({ ...current, flagged: event.target.checked }))}
          />
          <Flag aria-hidden="true" />
          <span>标记为重点</span>
        </label>
      </div>

      <fieldset className="todoEditor__repeat">
        <legend className="todosPage__srOnly">Repeat</legend>
        <div className="todoEditor__repeatHeader">
          <span className="todoEditor__repeatLabel">重复</span>
          <label>
            <span className="todosPage__srOnly">Repeat cadence</span>
            <select
              value={draft.repeatCadence}
              aria-label="Repeat cadence"
              onChange={(event) =>
                setDraft((current) => withRepeatCadence(
                  current,
                  event.target.value as TodoDraft["repeatCadence"],
                  timeZone
                ))
              }
            >
              <option value="none">不重复</option>
              <option value="every-n-days">每天</option>
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
          </label>
        </div>
        {draft.repeatCadence !== "none" ? (
          <div className="todoEditor__repeatBody">
            <div className="todoEditor__repeatGrid">
              {draft.repeatCadence === "every-n-days" ? (
                <label className="todoEditor__field">
                  <span>间隔</span>
                  <span className="todoEditor__numberInput">
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      step="1"
                      value={draft.repeatEveryDays}
                      onChange={(event) => setDraft((current) => ({ ...current, repeatEveryDays: event.target.value }))}
                      aria-label="Repeat every number of days"
                    />
                    <span>天</span>
                  </span>
                </label>
              ) : null}
              <label className="todoEditor__field">
                <span>开始日期</span>
                <input
                  type="date"
                  required
                  value={draft.repeatStartDate}
                  onChange={(event) => setDraft((current) => ({ ...current, repeatStartDate: event.target.value }))}
                  aria-label="Repeat start date"
                />
              </label>
              <label className="todoEditor__field">
                <span>开始时间</span>
                <input
                  type="time"
                  required
                  value={draft.repeatStartTime}
                  onChange={(event) => setDraft((current) => ({ ...current, repeatStartTime: event.target.value }))}
                  aria-label="Repeat start time"
                />
              </label>
              <label className="todoEditor__field">
                <span>结束方式</span>
                <select
                  value={draft.repeatEndMode}
                  aria-label="Repeat end mode"
                  onChange={(event) => {
                    const repeatEndMode = event.target.value as RepeatEndMode;
                    setDraft((current) => ({
                      ...current,
                      repeatEndMode,
                      repeatUntil:
                        repeatEndMode === "until" && !current.repeatUntil
                          ? defaultRepeatUntil(current.repeatStartDate || todayDate, current.repeatCadence === "none" ? "every-n-days" : current.repeatCadence)
                          : current.repeatUntil
                    }));
                  }}
                >
                  <option value="count">按次数</option>
                  <option value="until">到指定日期</option>
                  <option value="never">不结束</option>
                </select>
              </label>
              {draft.repeatEndMode === "count" ? (
                <label className="todoEditor__field">
                  <span>重复次数</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    required
                    value={draft.repeatCount}
                    onChange={(event) => setDraft((current) => ({ ...current, repeatCount: event.target.value }))}
                    aria-label="Repeat occurrence count"
                  />
                </label>
              ) : null}
              {draft.repeatEndMode === "until" ? (
                <label className="todoEditor__field">
                  <span>结束日期</span>
                  <input
                    type="date"
                    required
                    min={draft.repeatStartDate || undefined}
                    value={draft.repeatUntil}
                    onChange={(event) => setDraft((current) => ({ ...current, repeatUntil: event.target.value }))}
                    aria-label="Repeat end date"
                  />
                </label>
              ) : null}
            </div>
            <p className="todoEditor__repeatHint">
              <Repeat2 aria-hidden="true" />
              {draft.repeatUseExistingAdvanced && todo.repeatRule
                ? `保留现有 ${todo.repeatRule.executionMode ?? "manual"} / ${todo.repeatRule.startMode ?? "fixed-time"} 高级设置。`
                : "新规则默认在固定时间手动执行。"}
            </p>
          </div>
        ) : (
          <p className="todoEditor__repeatEmpty">不重复。</p>
        )}
      </fieldset>

      <fieldset className="todoEditor__checklist">
        <legend>检查清单</legend>
        {draft.checklist.length > 0 ? (
          <ul>
            {draft.checklist.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.completed}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        checklist: current.checklist.map((candidate) =>
                          candidate.id === item.id ? { ...candidate, completed: event.target.checked } : candidate
                        )
                      }))
                    }
                  />
                  <input
                    value={item.title}
                    aria-label="Checklist item"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        checklist: current.checklist.map((candidate) =>
                          candidate.id === item.id ? { ...candidate, title: event.target.value } : candidate
                        )
                      }))
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      checklist: current.checklist.filter((candidate) => candidate.id !== item.id)
                    }))
                  }
                  aria-label={`Remove checklist item ${item.title}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p>还没有检查项。</p>
        )}
        <div className="todoEditor__addChecklist">
          <input
            value={newChecklistTitle}
            onChange={(event) => setNewChecklistTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addChecklistItem();
              }
            }}
            placeholder="添加检查项"
            aria-label="New checklist item"
          />
          <button type="button" onClick={addChecklistItem} disabled={!newChecklistTitle.trim()}>
            <Plus aria-hidden="true" /> 添加
          </button>
        </div>
      </fieldset>

      {saveError ? (
        <p className="todoEditor__error" role="alert">
          {saveError}
        </p>
      ) : null}

      <div className="todoEditor__footer">
        {todo.status === "open" ? (
          <div className="todoEditor__conversionActions" aria-label="Todo conversion actions">
            <button type="button" className="todoEditor__quietAction" onClick={onKeep}>
              <Check aria-hidden="true" /> 保持为待办
            </button>
            <button type="button" className="todoEditor__quietAction" onClick={onConvertToTask}>
              <ArrowRight aria-hidden="true" /> 转为项目任务
            </button>
            <button type="button" className="todoEditor__quietAction" onClick={onConvertToProject}>
              <FolderKanban aria-hidden="true" /> 拆成项目
            </button>
          </div>
        ) : (
          <span className="todoEditor__completedNote">先恢复这个待办，再更改它的去向。</span>
        )}
        <div className="todoEditor__saveActions">
          <button type="button" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button type="submit" className="todoEditor__primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </form>
  );
}

interface EmptyTodosProps {
  filter: TodosFilter;
  hasQuery: boolean;
  selectedTag?: string;
}

function EmptyTodos({ filter, hasQuery, selectedTag }: EmptyTodosProps) {
  let title = "这里还没有任务";
  let detail = "记录的新任务会出现在这里。";
  if (hasQuery) {
    title = "没有找到匹配的任务";
    detail = "可以缩短关键词，或清空当前筛选。";
  } else if (filter === "inbox") {
    title = "收件箱已清空";
    detail = "想到什么就先记下来，是否安排时间或拆成项目以后再决定。";
  } else if (filter === "flagged") {
    title = "没有重点任务";
    detail = "只标记少数真正需要额外关注的事项。";
  } else if (filter === "tags") {
    title = selectedTag ? `没有 #${selectedTag} 任务` : "没有带标签的任务";
    detail = "编辑任务时可以补标签，用来整理相近的场景。";
  } else if (filter === "completed") {
    title = "还没有已完成任务";
    detail = "完成后的任务会保留在这里，也可以随时恢复。";
  }

  return (
    <div className="todosPage__empty">
      <CheckCircle2 aria-hidden="true" />
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

interface TodoConfirmationDialogProps {
  state?: ConfirmationState;
  projects: Project[];
  selectedProjectId: Id;
  selectedScopeId: Id;
  selectedProjectScopes: ShapeUpScope[];
  planningMethod: ProjectPlanningMethod;
  pending: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onProjectChange: (projectId: Id) => void;
  onScopeChange: (scopeId: Id) => void;
  onPlanningMethodChange: (method: ProjectPlanningMethod) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onRequestCreateProject?: () => void;
}

function TodoConfirmationDialog({
  state,
  projects,
  selectedProjectId,
  selectedScopeId,
  selectedProjectScopes,
  planningMethod,
  pending,
  error,
  onOpenChange,
  onProjectChange,
  onScopeChange,
  onPlanningMethodChange,
  onConfirm,
  onCancel,
  onRequestCreateProject
}: TodoConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const isTask = state?.kind === "task";
  const isProject = state?.kind === "project";
  const confirmDisabled = pending || (isTask && !selectedProjectId);

  let title = "保持为待办？";
  let description = "这件事会继续作为独立待办，保留在任务视图中。";
  let confirmLabel = "保持为待办";
  if (isTask) {
    title = "转为项目任务？";
    description = "选择一个所属项目，待办详情和检查清单都会保留。";
    confirmLabel = "转为任务";
  } else if (isProject) {
    title = "拆成项目？";
    description = "只在确实需要结构时才建立项目；OmniPlan 适合直接规划任务、日期和依赖。";
    confirmLabel = "建立项目";
  }

  return (
    <Dialog.Root open={Boolean(state)} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="todoDialog__overlay" />
        <Dialog.Content
          className="todoDialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onEscapeKeyDown={(event) => {
            if (pending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (pending) event.preventDefault();
          }}
        >
          <div className="todoDialog__header">
            <div className="todoDialog__icon" data-kind={state?.kind} aria-hidden="true">
              {isTask ? <ArrowRight /> : isProject ? <FolderKanban /> : <Check />}
            </div>
            <div>
              <Dialog.Title id={titleId}>{title}</Dialog.Title>
              <Dialog.Description id={descriptionId}>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="todoDialog__close" disabled={pending} aria-label="关闭对话框">
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          {state ? (
            <div className="todoDialog__itemPreview">
              <span>来自待办</span>
              <strong>{state.todo.title}</strong>
            </div>
          ) : null}

          {isTask ? (
            <div className="todoDialog__fields">
              {projects.length > 0 ? (
                <>
                  <label>
                    <span>所属项目</span>
                    <select value={selectedProjectId} onChange={(event) => onProjectChange(event.target.value)} autoFocus>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}{project.planningMethod === "shape-up" ? " · Shape Up" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selectedProjectScopes.length > 0 ? (
                    <label>
                      <span>Shape Up 范围 <em>可选</em></span>
                      <select value={selectedScopeId} onChange={(event) => onScopeChange(event.target.value)}>
                        <option value="">不指定范围</option>
                        {selectedProjectScopes.map((scope) => (
                          <option key={scope.id} value={scope.id}>
                            {scope.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </>
              ) : (
                <div className="todoDialog__noProjects">
                  <strong>请先创建项目</strong>
                  <p>项目任务需要一个所属项目，用来承载排期和依赖。</p>
                  {onRequestCreateProject ? (
                    <button type="button" onClick={onRequestCreateProject}>
                      创建项目
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {isProject ? (
            <fieldset className="todoDialog__methodPicker">
              <legend>规划方式</legend>
              <label data-selected={planningMethod === "omniplan"}>
                <input
                  type="radio"
                  name="todo-project-method"
                  value="omniplan"
                  checked={planningMethod === "omniplan"}
                  onChange={() => onPlanningMethodChange("omniplan")}
                />
                <span>
                  <strong>OmniPlan</strong>
                  <small>直接管理任务、日期、依赖和进度。</small>
                </span>
                <span className="todoDialog__recommended">默认</span>
              </label>
              <label data-selected={planningMethod === "shape-up"}>
                <input
                  type="radio"
                  name="todo-project-method"
                  value="shape-up"
                  checked={planningMethod === "shape-up"}
                  onChange={() => onPlanningMethodChange("shape-up")}
                />
                <span>
                  <strong>Shape Up</strong>
                  <small>先定义问题并设定投入边界，再开始执行。</small>
                </span>
              </label>
            </fieldset>
          ) : null}

          {error ? (
            <p className="todoDialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="todoDialog__footer">
            <button type="button" onClick={onCancel} disabled={pending}>
              取消
            </button>
            <button type="button" className="todoDialog__confirm" onClick={onConfirm} disabled={confirmDisabled}>
              {pending ? "处理中…" : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
