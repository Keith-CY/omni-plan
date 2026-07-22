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
  icon: typeof Inbox;
}

const FILTERS: FilterDefinition[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "all", label: "All", icon: ListTodo },
  { id: "flagged", label: "Flagged", icon: Flag },
  { id: "tags", label: "Tags", icon: Tags },
  { id: "completed", label: "Completed", icon: CheckCircle2 }
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
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatRepeat(rule?: RepeatRule): string | undefined {
  if (!rule) return undefined;
  if (rule.cadence === "monthly") return "Monthly";
  if (rule.cadence === "weekly") return "Weekly";
  const everyDays = Math.max(1, Math.round(rule.everyDays ?? 1));
  return everyDays === 1 ? "Daily" : `Every ${everyDays}d`;
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

  const filterLabel = FILTERS.find((item) => item.id === filter)?.label ?? "Todos";

  return (
    <section className="todosPage" aria-labelledby="todos-page-title">
      <header className="todosPage__header">
        <div>
          <p className="todosPage__eyebrow">Personal execution</p>
          <div className="todosPage__titleRow">
            <h2 id="todos-page-title">Todos</h2>
            <span className="todosPage__total" aria-label={`${openTodos.length} open todos`}>
              {openTodos.length}
            </span>
          </div>
          <p className="todosPage__subtitle">Capture lightly. Add project structure only when the work earns it.</p>
        </div>
        <label className="todosPage__search">
          <Search aria-hidden="true" />
          <span className="todosPage__srOnly">Search Todos</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search todos"
          />
          {query ? (
            <button type="button" onClick={() => setQuery("")} aria-label="Clear Todo search">
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>
      </header>

      <nav className="todosPage__filters" aria-label="Todo views">
        {FILTERS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="todosPage__filter"
            data-active={filter === id}
            aria-pressed={filter === id}
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
          <span>{filteredTodos.length} shown</span>
        </div>
        <span className="todosPage__listHint">Select a row for details and conversion options</span>
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
            {todo.inbox && !completed ? <span className="todoRow__inboxBadge">Inbox</span> : null}
          </span>
          <span className="todoRow__meta">
            {dueLabel ? (
              <span className="todoRow__due">
                <CalendarDays aria-hidden="true" /> Due {dueLabel}
              </span>
            ) : null}
            {deferLabel ? (
              <span>
                <Clock3 aria-hidden="true" /> Available {deferLabel}
              </span>
            ) : null}
            {planLabel ? (
              <span>
                <CalendarDays aria-hidden="true" /> Plan {planLabel}
              </span>
            ) : null}
            {repeatLabel ? (
              <span>
                <Repeat2 aria-hidden="true" /> {repeatLabel}
              </span>
            ) : null}
            {todo.estimatedSeconds ? <span>{Math.max(1, Math.round(todo.estimatedSeconds / 60))} min</span> : null}
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
      setSaveError("Give this Todo a title before saving.");
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
          <span>Title</span>
          <input
            ref={titleInputRef}
            value={draft.title}
            onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
            required
          />
        </label>
        <label className="todoEditor__field todoEditor__field--wide">
          <span>Note</span>
          <textarea
            value={draft.note}
            onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
            rows={2}
            placeholder="Context, link, or next step"
          />
        </label>
        <label className="todoEditor__field">
          <span>Available</span>
          <input
            type="date"
            value={draft.deferUntil}
            onChange={(event) => setDraft((current) => ({ ...current, deferUntil: event.target.value }))}
          />
        </label>
        <label className="todoEditor__field">
          <span>Due</span>
          <input
            type="date"
            value={draft.dueAt}
            onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))}
          />
        </label>
        <label className="todoEditor__field todoEditor__planField">
          <span>Plan date</span>
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
              Today
            </button>
          </span>
        </label>
        <label className="todoEditor__field">
          <span>Estimate</span>
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
            <span>min</span>
          </span>
        </label>
        <label className="todoEditor__field">
          <span>Tags</span>
          <input
            value={draft.tags}
            onChange={(event) => setDraft((current) => ({ ...current, tags: event.target.value }))}
            placeholder="home, calls"
          />
        </label>
        <label className="todoEditor__flagToggle">
          <input
            type="checkbox"
            checked={draft.flagged}
            onChange={(event) => setDraft((current) => ({ ...current, flagged: event.target.checked }))}
          />
          <Flag aria-hidden="true" />
          <span>Flag for attention</span>
        </label>
      </div>

      <fieldset className="todoEditor__repeat">
        <legend className="todosPage__srOnly">Repeat</legend>
        <div className="todoEditor__repeatHeader">
          <span className="todoEditor__repeatLabel">Repeat</span>
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
              <option value="none">None</option>
              <option value="every-n-days">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>
        {draft.repeatCadence !== "none" ? (
          <div className="todoEditor__repeatBody">
            <div className="todoEditor__repeatGrid">
              {draft.repeatCadence === "every-n-days" ? (
                <label className="todoEditor__field">
                  <span>Every</span>
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
                    <span>days</span>
                  </span>
                </label>
              ) : null}
              <label className="todoEditor__field">
                <span>Starts</span>
                <input
                  type="date"
                  required
                  value={draft.repeatStartDate}
                  onChange={(event) => setDraft((current) => ({ ...current, repeatStartDate: event.target.value }))}
                  aria-label="Repeat start date"
                />
              </label>
              <label className="todoEditor__field">
                <span>At</span>
                <input
                  type="time"
                  required
                  value={draft.repeatStartTime}
                  onChange={(event) => setDraft((current) => ({ ...current, repeatStartTime: event.target.value }))}
                  aria-label="Repeat start time"
                />
              </label>
              <label className="todoEditor__field">
                <span>Ends</span>
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
                  <option value="count">After count</option>
                  <option value="until">On date</option>
                  <option value="never">Never</option>
                </select>
              </label>
              {draft.repeatEndMode === "count" ? (
                <label className="todoEditor__field">
                  <span>Occurrences</span>
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
                  <span>End date</span>
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
                ? `Existing ${todo.repeatRule.executionMode ?? "manual"} / ${todo.repeatRule.startMode ?? "fixed-time"} advanced settings stay intact.`
                : "New rules use manual execution at a fixed time."}
            </p>
          </div>
        ) : (
          <p className="todoEditor__repeatEmpty">No repeat rule.</p>
        )}
      </fieldset>

      <fieldset className="todoEditor__checklist">
        <legend>Checklist</legend>
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
          <p>No checklist items.</p>
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
            placeholder="Add a checklist item"
            aria-label="New checklist item"
          />
          <button type="button" onClick={addChecklistItem} disabled={!newChecklistTitle.trim()}>
            <Plus aria-hidden="true" /> Add
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
              <Check aria-hidden="true" /> Keep as Todo
            </button>
            <button type="button" className="todoEditor__quietAction" onClick={onConvertToTask}>
              <ArrowRight aria-hidden="true" /> Convert to Task
            </button>
            <button type="button" className="todoEditor__quietAction" onClick={onConvertToProject}>
              <FolderKanban aria-hidden="true" /> Convert to Project
            </button>
          </div>
        ) : (
          <span className="todoEditor__completedNote">Restore this Todo before changing its destination.</span>
        )}
        <div className="todoEditor__saveActions">
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="todoEditor__primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
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
  let title = "Nothing here";
  let detail = "This view will update as your Todos change.";
  if (hasQuery) {
    title = "No matching Todos";
    detail = "Try a shorter search or clear the current filters.";
  } else if (filter === "inbox") {
    title = "Inbox clear";
    detail = "New captures land here until you decide what deserves more structure.";
  } else if (filter === "flagged") {
    title = "No flagged Todos";
    detail = "Flag only the few items that need extra attention.";
  } else if (filter === "tags") {
    title = selectedTag ? `No Todos tagged ${selectedTag}` : "No tagged Todos";
    detail = "Add a tag while editing a Todo to group related errands or contexts.";
  } else if (filter === "completed") {
    title = "No completed Todos";
    detail = "Completed items stay available here for quick restoration.";
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

  let title = "Keep as Todo?";
  let description = "This item will stay independent and remain available in your Todo views.";
  let confirmLabel = "Keep as Todo";
  if (isTask) {
    title = "Convert to Task?";
    description = "Choose the project that should own this work. Its Todo details and checklist will be preserved.";
    confirmLabel = "Convert to Task";
  } else if (isProject) {
    title = "Convert to Project?";
    description = "Choose how much planning structure this work needs. OmniPlan is the default for direct planning.";
    confirmLabel = "Create Project";
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
              <button type="button" className="todoDialog__close" disabled={pending} aria-label="Close dialog">
                <X aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          {state ? (
            <div className="todoDialog__itemPreview">
              <span>From Todo</span>
              <strong>{state.todo.title}</strong>
            </div>
          ) : null}

          {isTask ? (
            <div className="todoDialog__fields">
              {projects.length > 0 ? (
                <>
                  <label>
                    <span>Project</span>
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
                      <span>Shape Up scope <em>optional</em></span>
                      <select value={selectedScopeId} onChange={(event) => onScopeChange(event.target.value)}>
                        <option value="">No scope</option>
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
                  <strong>Create a project first</strong>
                  <p>A Task needs a project so its schedule and dependencies have a home.</p>
                  {onRequestCreateProject ? (
                    <button type="button" onClick={onRequestCreateProject}>
                      Create Project
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {isProject ? (
            <fieldset className="todoDialog__methodPicker">
              <legend>Planning method</legend>
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
                  <small>Outline tasks, dates, dependencies, and progress directly.</small>
                </span>
                <span className="todoDialog__recommended">Default</span>
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
                  <small>Shape the problem, place a bet, then build within an appetite.</small>
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
              Cancel
            </button>
            <button type="button" className="todoDialog__confirm" onClick={onConfirm} disabled={confirmDisabled}>
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
