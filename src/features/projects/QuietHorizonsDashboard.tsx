import {
  AlertTriangle,
  BookOpen,
  Briefcase,
  CalendarDays,
  ChartGantt,
  ChevronDown,
  ChevronRight,
  Folder,
  Home,
  List,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  Sprout,
  Target
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ProjectHealth } from "@/domain/portfolio";
import type { AuditGate, Baseline, Dependency, Project, ScheduleResult, ScheduledItem, WorkItem } from "@/domain/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { inferProjectArea, projectHorizonSignals, type LifeArea } from "./horizonModel";
import "./quiet-horizons.css";

type ProjectFilter = "active" | "waiting" | "paused" | "all";
type HorizonLayout = "horizon" | "list";

interface HorizonRow {
  project: Project;
  schedule?: ScheduleResult;
  health?: ProjectHealth;
  baseline?: Baseline;
  dependencies: Dependency[];
  gates: AuditGate[];
  workItems: WorkItem[];
  area: LifeArea;
  signals: ReturnType<typeof projectHorizonSignals>;
}

interface HorizonWindow {
  rangeStart: Date;
  rangeEnd: Date;
  weekStart: Date;
  weeks: Date[];
}

export function QuietHorizonsDashboard({
  projects,
  schedules,
  health,
  gates,
  dependencies,
  baselines,
  workItems,
  now,
  headerActions,
  projectHref,
  reviewHref,
  renderGantt
}: {
  projects: Project[];
  schedules: ScheduleResult[];
  health: ProjectHealth[];
  gates: AuditGate[];
  dependencies: Dependency[];
  baselines: Baseline[];
  workItems: WorkItem[];
  now: string;
  headerActions: ReactNode;
  projectHref: (projectId: string, target?: string) => string;
  reviewHref: string;
  renderGantt: (input: { items: ScheduledItem[]; dependencies: Dependency[]; baseline?: Baseline; gates: AuditGate[] }) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("active");
  const [areaFilter, setAreaFilter] = useState<"all" | LifeArea>("all");
  const [layout, setLayout] = useState<HorizonLayout>("horizon");
  const horizonWindow = useMemo(() => buildHorizonWindow(now), [now]);

  const rows = useMemo<HorizonRow[]>(() => projects
    .filter((project) => !project.archived && project.status !== "archived")
    .map((project) => {
      const schedule = schedules.find((candidate) => candidate.projectId === project.id);
      const projectHealth = health.find((candidate) => candidate.projectId === project.id);
      const projectDependencies = dependencies.filter((dependency) => dependency.projectId === project.id);
      const projectGates = gates.filter((gate) => gate.projectId === project.id);
      const projectWorkItems = workItems.filter((item) => item.projectId === project.id);
      return {
        project,
        schedule,
        health: projectHealth,
        baseline: baselines.find((baseline) => baseline.projectId === project.id),
        dependencies: projectDependencies,
        gates: projectGates,
        workItems: projectWorkItems,
        area: inferProjectArea(project, projectWorkItems),
        signals: projectHorizonSignals({ project, schedule, dependencies: projectDependencies, now })
      };
    }), [baselines, dependencies, gates, health, now, projects, schedules, workItems]);

  const [expandedProjectId, setExpandedProjectId] = useState<string | undefined>(() => rows.find((row) => row.signals.mode === "managed")?.project.id);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter((row) => {
    const matchesStatus = projectFilter === "all" || row.project.status === projectFilter;
    const matchesArea = areaFilter === "all" || row.area === areaFilter;
    const matchesQuery = !normalizedQuery || [row.project.name, row.project.currentOutcome, row.project.northStar]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    return matchesStatus && matchesArea && matchesQuery;
  });
  const expandedRow = visibleRows.find((row) => row.project.id === expandedProjectId);

  return (
    <section className="quietHorizons" aria-labelledby="quiet-horizons-heading">
      <h2 id="quiet-horizons-heading" className="srOnly">Quiet Horizons</h2>

      <div className="qhToolbar" aria-label="Project horizon controls">
        <label className="qhSelectControl">
          <span className="srOnly">Project status</span>
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value as ProjectFilter)}>
            <option value="active">Active</option>
            <option value="waiting">Waiting</option>
            <option value="paused">Paused</option>
            <option value="all">All</option>
          </select>
        </label>

        <div className="qhDateRange" aria-label={`Horizon from ${formatLongDate(horizonWindow.rangeStart)} to ${formatLongDate(horizonWindow.rangeEnd)}`}>
          <CalendarDays aria-hidden="true" />
          <span>{formatLongDate(horizonWindow.rangeStart)} – {formatLongDate(horizonWindow.rangeEnd)} (6w)</span>
        </div>

        <label className="qhSearch">
          <Search aria-hidden="true" />
          <span className="srOnly">Search projects</span>
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects..." />
        </label>

        <details className="qhFilterMenu">
          <summary aria-label="Filter projects" title="Filter projects"><SlidersHorizontal aria-hidden="true" /></summary>
          <div className="qhFilterPopover">
            <span>Life area</span>
            <div className="qhAreaControl" role="group" aria-label="Life area">
              {([
                ["all", "All", <Target key="all" />],
                ["work", "Work", <Briefcase key="work" />],
                ["home", "Home", <Home key="home" />],
                ["growth", "Growth", <Sprout key="growth" />]
              ] as Array<["all" | LifeArea, string, ReactNode]>).map(([value, label, icon]) => (
                <button key={value} type="button" className={areaFilter === value ? "active" : undefined} onClick={() => setAreaFilter(value)} aria-pressed={areaFilter === value}>
                  {icon}<span>{label}</span>
                </button>
              ))}
            </div>
            <span>Project actions</span>
            <div className="qhFilterActions">{headerActions}</div>
          </div>
        </details>

        <div className="qhLayoutControl" role="group" aria-label="Project layout">
          <button type="button" className={layout === "list" ? "active" : undefined} onClick={() => setLayout("list")} aria-label="List view" title="List view" aria-pressed={layout === "list"}><List aria-hidden="true" /></button>
          <button type="button" className={layout === "horizon" ? "active" : undefined} onClick={() => setLayout("horizon")} aria-label="Horizon view" title="Horizon view" aria-pressed={layout === "horizon"}><ChartGantt aria-hidden="true" /></button>
        </div>
      </div>

      {layout === "horizon" && <HorizonTimeRuler window={horizonWindow} now={now} />}

      {visibleRows.length ? (
        <div className={cn("qhProjectList", layout === "list" && "isList")}>
          {visibleRows.map((row) => (
            <HorizonProjectRow
              key={row.project.id}
              row={row}
              layout={layout}
              expanded={expandedProjectId === row.project.id}
              onToggle={() => setExpandedProjectId((current) => current === row.project.id ? undefined : row.project.id)}
              projectHref={projectHref}
              renderGantt={renderGantt}
            />
          ))}
        </div>
      ) : (
        <div className="qhEmpty">
          <Search aria-hidden="true" />
          <strong>No projects match this view.</strong>
          <p>Clear the search or choose another filter.</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { setQuery(""); setAreaFilter("all"); setProjectFilter("active"); }}>Reset view</Button>
        </div>
      )}

      {layout === "horizon" && <HorizonOverview rows={visibleRows} expandedProjectId={expandedProjectId} />}
      <PortfolioInspector row={expandedRow} projectHref={projectHref} reviewHref={reviewHref} />
    </section>
  );
}

function HorizonTimeRuler({ window, now }: { window: HorizonWindow; now: string }) {
  const nowTime = Date.parse(now);
  return (
    <div className="qhTimeRuler" aria-hidden="true">
      <span className="qhWeekLabel">Week</span>
      <div className="qhWeekGrid">
        {window.weeks.map((week, index) => {
          const weekEnd = addDays(week, index === window.weeks.length - 1 ? 5 : 6);
          const markerOffset = nowTime >= week.getTime() && nowTime <= addDays(week, 7).getTime()
            ? Math.max(0, Math.min(100, ((nowTime - week.getTime()) / (7 * 86_400_000)) * 100))
            : undefined;
          return (
            <div className="qhWeek" key={week.toISOString()}>
              <strong>{formatWeekRange(week, weekEnd)}</strong>
              <span className="qhWeekDays">M T W T F S S</span>
              {markerOffset !== undefined && <i className="qhTodayMarker" style={{ left: `${markerOffset}%` }}><b>{formatDay(now)}</b></i>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HorizonProjectRow({
  row,
  layout,
  expanded,
  onToggle,
  projectHref,
  renderGantt
}: {
  row: HorizonRow;
  layout: HorizonLayout;
  expanded: boolean;
  onToggle: () => void;
  projectHref: (projectId: string, target?: string) => string;
  renderGantt: (input: { items: ScheduledItem[]; dependencies: Dependency[]; baseline?: Baseline; gates: AuditGate[] }) => ReactNode;
}) {
  const { project, schedule, baseline, dependencies, signals } = row;
  const items = schedule?.items ?? [];
  const nextItem = nextScheduledAction(items);
  const progress = projectProgress(items);
  const forecast = projectForecast(items, project.horizon);
  const variance = forecastVarianceDays(forecast, baseline);
  const risk = projectRisk(signals.delayRiskLevel);
  const expandedId = `project-horizon-${project.id}`;
  const simple = signals.mode === "simple";

  return (
    <article className={cn("qhProject", expanded && "isExpanded", simple ? "isSimple" : "isManaged")}>
      <div className="qhProjectRow">
        <button
          type="button"
          className="qhExpandButton"
          aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
          aria-expanded={expanded}
          aria-controls={expandedId}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown /> : <ChevronRight />}
        </button>

        <div className="qhProjectIdentity">
          {!simple && <Folder className="qhProjectFolder" aria-hidden="true" />}
          <div className="qhProjectCopy">
            <a href={projectHref(project.id)}>{project.name}</a>
            {!simple && (
              <div className="qhProjectMeta">
                <span>{project.mode}</span>
                <i className={risk.tone} aria-hidden="true" />
                <em>{signals.hasDelayRisk ? "Delay risk" : "On track"}</em>
              </div>
            )}
          </div>
        </div>

        {simple ? (
          <>
            <div className="qhNextAction">{nextItem?.workItem.title ?? project.currentOutcome ?? "Choose a next action"}</div>
            <div className="qhProjectProgress"><progress max={100} value={progress} /><span>{progress ? `${progress}%` : "—"}</span></div>
            <div className="qhSimpleSchedule">No schedule</div>
          </>
        ) : expanded ? (
          <>
            <div className="qhComplexReason">{planningReason(signals)}</div>
            <dl className="qhRowMetrics">
              <div><dt>Forecast</dt><dd>{formatShortDate(forecast)}</dd></div>
              <div><dt>Variance</dt><dd className={variance > 0 ? "warning" : undefined}>{formatVariance(variance, baseline)}</dd></div>
              <div><dt>Risk</dt><dd className={risk.tone}>{risk.label}</dd></div>
            </dl>
            <div className="qhDeadline"><span>{formatShortDate(project.horizon)}</span>{signals.hasDelayRisk && <strong>Forecast {formatShortDate(forecast)}</strong>}</div>
          </>
        ) : (
          <>
            <div className="qhManagedTrack">{layout === "horizon" ? <PhaseHorizon items={items} /> : <span>{nextItem?.workItem.title ?? project.currentOutcome}</span>}</div>
            <div className="qhManagedDate">{formatShortDate(forecast)}</div>
          </>
        )}

        <a className="qhMoreButton" href={projectHref(project.id)} aria-label={`Open ${project.name}`} title="Open project"><MoreHorizontal /></a>
      </div>

      {expanded && (
        <div id={expandedId} className="qhExpandedPanel">
          {simple ? (
            <div className="qhSimpleDetails">
              <div>
                <span>Current outcome</span>
                <strong>{project.currentOutcome || "No outcome set"}</strong>
                <p>This project stays lightweight until it gains a real deadline, dependency, or schedule-specific delay risk.</p>
              </div>
              <Button asChild variant="outline" size="sm"><a href={projectHref(project.id)}>Open project <ChevronRight /></a></Button>
            </div>
          ) : (
            <div className="qhGanttFrame">
              {items.length ? renderGantt({ items, dependencies, baseline, gates: row.gates }) : <div className="qhInlineEmpty">Add a task to begin the planning view.</div>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function PhaseHorizon({ items }: { items: ScheduledItem[] }) {
  const phases = items.filter((item) => item.workItem.kind === "phase");
  const segments = (phases.length ? phases : items.filter((item) => item.workItem.kind !== "milestone")).slice(0, 4);
  if (!segments.length) return <span className="qhNoTrack">No scheduled work</span>;
  const total = segments.reduce((sum, item) => sum + Math.max(1, Date.parse(item.finish) - Date.parse(item.start)), 0);
  return (
    <div className="qhPhaseHorizon" aria-hidden="true">
      {segments.map((item, index) => (
        <span key={item.workItem.id} className={cn(index % 2 ? "blue" : "slate", item.isCritical && "critical")} style={{ flexGrow: Math.max(1, (Date.parse(item.finish) - Date.parse(item.start)) / total) }}>
          {item.workItem.title}
        </span>
      ))}
      <i />
    </div>
  );
}

function HorizonOverview({ rows, expandedProjectId }: { rows: HorizonRow[]; expandedProjectId?: string }) {
  const managedRows = rows.filter((row) => row.signals.mode === "managed");
  if (!managedRows.length) return null;
  return (
    <div className="qhOverview" aria-label={`Portfolio overview with ${managedRows.length} scheduled projects`}>
      <div className="qhOverviewCanvas" aria-hidden="true">
        {managedRows.flatMap((row, rowIndex) => (row.schedule?.items ?? []).slice(0, 5).map((item, itemIndex) => (
          <span
            key={`${row.project.id}-${item.workItem.id}`}
            className={cn(item.isCritical && "critical", item.workItem.kind === "milestone" && "milestone")}
            style={{ left: `${8 + ((rowIndex * 17 + itemIndex * 8) % 76)}%`, top: `${18 + ((rowIndex * 22 + itemIndex * 13) % 58)}%`, width: `${item.workItem.kind === "milestone" ? 5 : 8 + (itemIndex % 4) * 4}%` }}
          />
        )))}
        <i className="qhOverviewViewport" style={{ left: `${expandedProjectId ? 18 : 8}%` }} />
      </div>
    </div>
  );
}

function PortfolioInspector({
  row,
  projectHref,
  reviewHref
}: {
  row?: HorizonRow;
  projectHref: (projectId: string, target?: string) => string;
  reviewHref: string;
}) {
  return (
    <details className="qhPortfolioInspector">
      <summary><ChevronRight /><span>Inspector</span><i>·</i><span>Evidence</span><i>·</i><span>Dependencies</span><i>·</i><span>Audit history</span></summary>
      {row ? (
        <div className="qhInspectorLinks">
          <a href={projectHref(row.project.id)}>Inspector <strong>{row.project.name}</strong></a>
          <a href={projectHref(row.project.id, "evidence")}><BookOpen />Evidence <strong>{row.health?.evidenceFreshnessDays === 999 ? "—" : Math.round(row.health?.evidenceFreshnessDays ?? 0)}d</strong></a>
          <a href={projectHref(row.project.id, "project-gantt")}>Dependencies <strong>{row.dependencies.length}</strong></a>
          <a href={reviewHref}><AlertTriangle />Audit history <strong>{row.gates.filter((gate) => gate.status !== "cleared").length}</strong></a>
        </div>
      ) : <p>Select a managed project to inspect its supporting information.</p>}
    </details>
  );
}

function nextScheduledAction(items: ScheduledItem[]) {
  return [...items]
    .filter((item) => item.workItem.percentComplete < 100 && item.workItem.kind !== "phase")
    .sort((left, right) => left.start.localeCompare(right.start))[0];
}

function projectProgress(items: ScheduledItem[]) {
  const progressItems = items.filter((item) => item.workItem.kind !== "phase");
  if (!progressItems.length) return 0;
  return Math.round(progressItems.reduce((sum, item) => sum + item.workItem.percentComplete, 0) / progressItems.length);
}

function projectForecast(items: ScheduledItem[], fallback: string) {
  return items.reduce((latest, item) => item.finish > latest ? item.finish : latest, items[0]?.finish ?? fallback);
}

function forecastVarianceDays(forecast: string, baseline?: Baseline) {
  if (!baseline) return 0;
  const plannedFinishes = Object.values(baseline.plannedFinishByItem);
  const planned = plannedFinishes.reduce((latest, finish) => finish > latest ? finish : latest, plannedFinishes[0] ?? forecast);
  return Math.round((Date.parse(forecast) - Date.parse(planned)) / 86_400_000);
}

function formatVariance(days: number, baseline?: Baseline) {
  if (!baseline) return "—";
  if (days === 0) return "On plan";
  return `${days > 0 ? "+" : ""}${days}d`;
}

function projectRisk(level: HorizonRow["signals"]["delayRiskLevel"]): { label: string; tone: "calm" | "watch" | "high" } {
  if (level === "high") return { label: "High", tone: "high" };
  if (level === "watch") return { label: "Watch", tone: "watch" };
  return { label: "Low", tone: "calm" };
}

function planningReason(signals: HorizonRow["signals"]) {
  const reasons = [signals.hasDeadline ? "Deadline" : undefined, signals.dependencyCount ? "dependencies" : undefined, signals.hasDelayRisk ? "delay risk" : undefined].filter(Boolean);
  return reasons.join(" + ");
}

function buildHorizonWindow(now: string): HorizonWindow {
  const rangeStart = new Date(now);
  rangeStart.setHours(0, 0, 0, 0);
  const rangeEnd = addDays(rangeStart, 42);
  const weekStart = new Date(rangeStart);
  const weekday = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - weekday);
  const weeks = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index * 7));
  return { rangeStart, rangeEnd, weekStart, weeks };
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatWeekRange(start: Date, end: Date) {
  const month = new Intl.DateTimeFormat("en", { month: "short" });
  return `${month.format(start)} ${start.getDate()} – ${start.getMonth() === end.getMonth() ? "" : `${month.format(end)} `}${end.getDate()}`;
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: date.getMonth() !== new Date().getMonth() ? "numeric" : undefined }).format(date);
}

function formatDay(iso: string) {
  return new Intl.DateTimeFormat("en", { weekday: "short", day: "numeric" }).format(new Date(iso));
}

function formatShortDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}
