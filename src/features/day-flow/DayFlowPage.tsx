import {
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  CornerDownRight,
  FolderKanban,
  Sparkles
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { dayBounds, selectDayPlan, type TaskView } from "../../domain/tasks";
import { zonedDateKey, zonedDateTimeToIso, zonedTimeKey } from "../../domain/time";
import type { ScheduleResult, WorkspaceSnapshot } from "../../domain/types";
import { QuickTaskCapture } from "../task-capture/QuickTaskCapture";
import "./day-flow.css";

export interface DayTaskPlanPatch {
  date: string;
  startTime: string;
  effortSeconds: number;
}

export interface DayFlowPageProps {
  snapshot: WorkspaceSnapshot;
  schedules: ScheduleResult[];
  currentTime: string;
  initialDate?: string;
  initialTaskId?: string;
  onCapture: (title: string, plannedForDate: string) => string | undefined;
  onUndoCapture: (taskId: string) => void;
  onCompleteTask: (task: TaskView) => void;
  onPlanTask: (task: TaskView, patch: DayTaskPlanPatch) => void;
  onOpenTask: (task: TaskView) => void;
  calendarHref: string;
}

const timelineStartMinutes = 8 * 60;
const timelineEndMinutes = 20 * 60;
const timelineSpanMinutes = timelineEndMinutes - timelineStartMinutes;
const effortChoices = [15 * 60, 30 * 60, 60 * 60, 2 * 60 * 60];

export function DayFlowPage({
  snapshot,
  schedules,
  currentTime,
  initialDate,
  initialTaskId,
  onCapture,
  onUndoCapture,
  onCompleteTask,
  onPlanTask,
  onOpenTask,
  calendarHref
}: DayFlowPageProps) {
  const todayDate = zonedDateKey(currentTime, snapshot.timeZone);
  const [selectedDate, setSelectedDate] = useState(initialDate ?? todayDate);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(initialTaskId);
  const plan = useMemo(
    () => selectDayPlan(snapshot, schedules, selectedDate),
    [snapshot, schedules, selectedDate]
  );
  const selectedTask = plan.tasks.find((task) => task.id === selectedTaskId);
  const openTasks = plan.tasks.filter((task) => task.status === "open");
  const completedCount = plan.tasks.length - openTasks.length;

  useEffect(() => {
    if (selectedTaskId && !plan.tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(undefined);
  }, [plan.tasks, selectedTaskId]);

  useEffect(() => {
    if (initialDate) setSelectedDate(initialDate);
    if (initialTaskId) setSelectedTaskId(initialTaskId);
  }, [initialDate, initialTaskId]);

  return (
    <section className="dayFlow" aria-label="今日安排">
      <header className="dayFlowHero">
        <div>
          <p className="dayFlowEyebrow"><Sparkles aria-hidden="true" /> TODAY FLOW</p>
          <h2>{formatDayHeading(selectedDate, snapshot.timeZone, selectedDate === todayDate)}</h2>
          <p>{openTasks.length} 项待完成 · {completedCount} 项已完成</p>
        </div>
        <div className="dayFlowDateControls" aria-label="切换日期">
          <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} aria-label="前一天"><ChevronLeft /></button>
          <button type="button" className="dayFlowDateButton" onClick={() => setSelectedDate(todayDate)}>
            <CalendarDays aria-hidden="true" />{selectedDate === todayDate ? "今天" : "回到今天"}
          </button>
          <button type="button" onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} aria-label="后一天"><ChevronRight /></button>
          <a href={calendarHref} aria-label="打开月历"><CalendarDays aria-hidden="true" /><span>月历</span></a>
        </div>
      </header>

      <QuickTaskCapture
        inputId="day-flow-capture"
        onCapture={(title) => onCapture(title, selectedDate)}
        onUndo={onUndoCapture}
      />

      <section className="dayFlowPlanSurface" aria-labelledby="day-flow-plan-title">
        <div className="dayFlowPlanHeader">
          <div>
            <p className="dayFlowSectionLabel">DAY PLAN</p>
            <h3 id="day-flow-plan-title">一天，一条清晰的时间线</h3>
          </div>
          <CapacityMeter
            planned={plan.plannedEffortSeconds}
            capacity={plan.capacitySeconds}
            over={plan.overCapacitySeconds}
          />
        </div>

        {plan.issues.length > 0 && (
          <div className="dayFlowIssues" role="status">
            <strong>{plan.issues.some((issue) => issue.severity === "error") ? "这天的计划需要处理" : "这天的计划有提醒"}</strong>
            <span>{plan.issues[0].message}</span>
            {plan.issues.length > 1 && <small>另有 {plan.issues.length - 1} 条，请在项目完整计划中查看。</small>}
          </div>
        )}

        <div className="dayFlowTimelineHead" aria-hidden="true">
          <span>任务</span>
          <div>{[8, 10, 12, 14, 16, 18, 20].map((hour) => <i key={hour}>{String(hour).padStart(2, "0")}:00</i>)}</div>
        </div>

        <div className="dayFlowRows">
          {plan.scheduled.length === 0 && (
            <div className="dayFlowEmpty">
              <CircleDot aria-hidden="true" />
              <strong>今天还没有排定时间</strong>
              <span>先记录任务，再在任务下方补时间和工作量。</span>
            </div>
          )}
          {plan.scheduled.map((task) => (
            <DayTaskRow
              key={task.id}
              task={task}
              date={selectedDate}
              timeZone={snapshot.timeZone}
              selected={selectedTaskId === task.id}
              onSelect={() => setSelectedTaskId((current) => current === task.id ? undefined : task.id)}
              onComplete={() => onCompleteTask(task)}
              onOpen={() => onOpenTask(task)}
            />
          ))}
        </div>

        {selectedTask && (
          <TaskInspector
            key={selectedTask.id}
            task={selectedTask}
            date={selectedDate}
            timeZone={snapshot.timeZone}
            onPlan={(patch) => onPlanTask(selectedTask, patch)}
            onOpenTask={onOpenTask}
          />
        )}

        <details className="dayFlowUnscheduled" open={plan.scheduled.length === 0 && plan.unscheduled.length > 0}>
          <summary>
            <span><ChevronDown aria-hidden="true" />未排时间</span>
            <b>{plan.unscheduled.length}</b>
          </summary>
          <div>
            {plan.unscheduled.length === 0 ? (
              <p>今天的事项都已经排好时间。</p>
            ) : plan.unscheduled.map((task) => (
              <DayTaskRow
                key={task.id}
                task={task}
                date={selectedDate}
                timeZone={snapshot.timeZone}
                selected={selectedTaskId === task.id}
                compact
                onSelect={() => setSelectedTaskId((current) => current === task.id ? undefined : task.id)}
                onComplete={() => onCompleteTask(task)}
                onOpen={() => onOpenTask(task)}
              />
            ))}
          </div>
        </details>
      </section>
    </section>
  );
}

function CapacityMeter({ planned, capacity, over }: { planned: number; capacity: number; over: number }) {
  const percentage = capacity > 0 ? Math.round(planned / capacity * 100) : 0;
  const fill = Math.min(100, percentage);
  return (
    <div className="dayFlowCapacity" data-over={over > 0 ? "true" : "false"}>
      <span className="dayFlowCapacityRing" style={{ "--capacity-fill": `${fill * 3.6}deg` } as CSSProperties}>
        <b>{Math.min(999, percentage)}%</b>
      </span>
      <span>
        <b>{formatEffort(planned)} / {formatEffort(capacity)}</b>
        <small>{over > 0 ? `超出 ${formatEffort(over)}` : `还可安排 ${formatEffort(Math.max(0, capacity - planned))}`}</small>
      </span>
    </div>
  );
}

function DayTaskRow({
  task,
  date,
  timeZone,
  selected,
  compact = false,
  onSelect,
  onComplete,
  onOpen
}: {
  task: TaskView;
  date: string;
  timeZone: string;
  selected: boolean;
  compact?: boolean;
  onSelect: () => void;
  onComplete: () => void;
  onOpen: () => void;
}) {
  const barStyle = timelineBarStyle(task, date, timeZone);
  const taskTone = toneForTask(task);
  const timeLabel = formatTaskTime(task, timeZone, date);
  const isPoint = Boolean(task.plannedStart && (!task.plannedFinish || task.plannedFinish <= task.plannedStart));
  const pointAtEnd = Boolean(task.plannedStart && minutesFromTime(zonedTimeKey(task.plannedStart, timeZone)) >= timelineEndMinutes);
  return (
    <article
      className="dayFlowTaskRow"
      data-selected={selected ? "true" : "false"}
      data-completed={task.status === "completed" ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
    >
      <button
        type="button"
        className="dayFlowCheck"
        disabled={task.status !== "completed" && task.source === "work-item" && task.blocked}
        aria-label={task.status === "completed" ? `重新打开 ${task.title}` : task.blocked ? `${task.title} 被依赖阻塞` : `完成 ${task.title}`}
        onClick={onComplete}
      >{task.status === "completed" ? <Check /> : null}</button>
      <button type="button" className="dayFlowTaskIdentity" onClick={onSelect} aria-expanded={selected}>
        <span className="dayFlowTaskTitle">{task.title}</span>
        <span className="dayFlowTaskMeta">
          {task.projectName ? <i><FolderKanban aria-hidden="true" />{task.projectName}</i> : <i>个人任务</i>}
          {task.blocked && <em>等待前置事项</em>}
          {task.isCritical && <em>关键路径</em>}
        </span>
        {task.plannedStart && (
          <span className="dayFlowMobileOverview">
            <i>{timeLabel}</i>
            <span><b className={taskTone} data-fixed={task.fixedTime ? "true" : "false"} /></span>
          </span>
        )}
      </button>
      <span className="dayFlowEffort">{formatEffort(task.effortSeconds)}</span>
      {!compact && (
        <div className="dayFlowTimelineCell">
          <div className="dayFlowGridLines" aria-hidden="true" />
          {task.plannedStart && (
            <button
              type="button"
              className={`dayFlowBar ${taskTone}`}
              data-fixed={task.fixedTime ? "true" : "false"}
              data-point={isPoint ? "true" : "false"}
              data-point-edge={pointAtEnd ? "end" : "start"}
              style={barStyle}
              onClick={onSelect}
              title={`${timeLabel} · ${task.title}`}
            >
              <span>{timeLabel}</span>
            </button>
          )}
        </div>
      )}
      <button type="button" className="dayFlowOpen" onClick={onOpen} aria-label={`打开 ${task.title}`} title="打开完整详情">
        <ArrowRight />
      </button>
    </article>
  );
}

function TaskInspector({
  task,
  date,
  timeZone,
  onPlan,
  onOpenTask
}: {
  task: TaskView;
  date: string;
  timeZone: string;
  onPlan: (patch: DayTaskPlanPatch) => void;
  onOpenTask: (task: TaskView) => void;
}) {
  const [planDate, setPlanDate] = useState(task.plannedStart ? zonedDateKey(task.plannedStart, timeZone) : date);
  const [startTime, setStartTime] = useState(task.plannedStart ? zonedTimeKey(task.plannedStart, timeZone) : "09:00");
  const [effortSeconds, setEffortSeconds] = useState(task.effortSeconds || 30 * 60);
  const dependencies = [...task.predecessors, ...task.successors];

  return (
    <section className="dayFlowInspector" aria-label={`${task.title} 的计划详情`}>
      <div className="dayFlowInspectorLead">
        <CornerDownRight aria-hidden="true" />
        <span>
          <small>正在安排</small>
          <strong>{task.title}</strong>
        </span>
      </div>
      <form
        className="dayFlowPlanForm"
        onSubmit={(event) => {
          event.preventDefault();
          onPlan({ date: planDate, startTime, effortSeconds });
        }}
      >
        <label><span>日期</span><input type="date" value={planDate} onChange={(event) => setPlanDate(event.target.value)} required /></label>
        <label><span>开始</span><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required /></label>
        <fieldset>
          <legend>工作量</legend>
          {effortChoices.map((choice) => (
            <button key={choice} type="button" data-active={effortSeconds === choice ? "true" : "false"} onClick={() => setEffortSeconds(choice)}>
              {formatEffort(choice)}
            </button>
          ))}
        </fieldset>
        <button type="submit" className="dayFlowPlanSave">保存安排</button>
      </form>
      <div className="dayFlowDependencyPath">
        <span>直接依赖</span>
        {dependencies.length === 0 ? (
          <p>没有依赖，任务可以独立推进。</p>
        ) : (
          <div>
            {task.predecessors.map((dependency) => (
              <button key={dependency.id} type="button" onClick={() => onOpenTask({ ...task, id: dependency.taskId, title: dependency.title })}>
                <i data-completed={dependency.completed ? "true" : "false"}>{dependency.completed ? <Check /> : <CircleDot />}</i>
                {dependency.title}<small>{dependency.type}</small>
              </button>
            ))}
            {task.predecessors.length > 0 && <ArrowRight aria-hidden="true" />}
            <b>{task.title}</b>
            {task.successors.length > 0 && <ArrowRight aria-hidden="true" />}
            {task.successors.map((dependency) => (
              <button key={dependency.id} type="button" onClick={() => onOpenTask({ ...task, id: dependency.taskId, title: dependency.title })}>
                {dependency.title}<small>{dependency.type}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function timelineBarStyle(task: TaskView, date: string, timeZone: string): CSSProperties {
  if (!task.plannedStart) return {};
  const bounds = dayBounds(date, timeZone);
  const isPoint = !task.plannedFinish || task.plannedFinish <= task.plannedStart;
  const start = task.plannedStart <= bounds.start
    ? 0
    : minutesFromTime(zonedTimeKey(task.plannedStart, timeZone));
  const finish = isPoint
    ? start + 12
    : task.plannedFinish! >= bounds.finish
      ? 24 * 60
      : minutesFromTime(zonedTimeKey(task.plannedFinish!, timeZone));
  let visibleStart = Math.max(timelineStartMinutes, Math.min(timelineEndMinutes, start));
  let visibleFinish = Math.max(timelineStartMinutes, Math.min(timelineEndMinutes, finish));
  if (visibleFinish <= visibleStart) {
    if (start >= timelineEndMinutes) visibleStart = timelineEndMinutes - 12;
    visibleFinish = Math.min(timelineEndMinutes, visibleStart + 12);
  }
  const left = (visibleStart - timelineStartMinutes) / timelineSpanMinutes * 100;
  const width = Math.max(1.8, (visibleFinish - visibleStart) / timelineSpanMinutes * 100);
  return { left: `${left}%`, width: `${width}%` };
}

export function formatTaskTime(task: TaskView, timeZone: string, date?: string) {
  if (!task.plannedStart) return "未排时间";
  const start = zonedTimeKey(task.plannedStart, timeZone);
  if (!task.plannedFinish || task.plannedFinish <= task.plannedStart) return start;
  const finish = zonedTimeKey(task.plannedFinish, timeZone);
  const startDate = zonedDateKey(task.plannedStart, timeZone);
  const finishDate = zonedDateKey(task.plannedFinish, timeZone);
  if (startDate === finishDate) return `${start}–${finish}`;
  if (date && startDate < date && finishDate > date) return "跨日进行中";
  if (date && startDate < date && finishDate === date) return `延续至 ${finish}`;
  if (finishDate === shiftDate(startDate, 1)) return `${start}–次日 ${finish}`;
  return `${start}–${finishDate.slice(5)} ${finish}`;
}

function formatEffort(seconds: number) {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatDayHeading(date: string, timeZone: string, today: boolean) {
  const instant = zonedDateTimeToIso(date, "12:00", timeZone);
  const label = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(new Date(instant));
  return today ? `今天 · ${label}` : label;
}

function shiftDate(date: string, offset: number) {
  const source = new Date(`${date}T12:00:00.000Z`);
  source.setUTCDate(source.getUTCDate() + offset);
  return source.toISOString().slice(0, 10);
}

function minutesFromTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function toneForTask(task: TaskView) {
  if (task.isCritical) return "is-amber";
  if (!task.projectId) return "is-sage";
  let sum = 0;
  for (const character of task.projectId) sum += character.charCodeAt(0);
  return sum % 2 ? "is-indigo" : "is-sage";
}
