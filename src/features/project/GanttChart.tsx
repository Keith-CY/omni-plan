import { AlertTriangle, Archive, CheckCircle2, Network } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Badge } from "@/components/ui/badge";
import type { Baseline, Dependency, DependencyType, ScheduledItem } from "@/domain/types";
import { addSeconds, addZonedCalendarDays, zonedDateKey, zonedDateTimeToIso, zonedTimeKey } from "@/domain/time";

export type DependencyPatch = Partial<Pick<Dependency, "type" | "lagSeconds">>;
type GanttZoom = "compact" | "day" | "wide";

interface ViewportState {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

const daySeconds = 86_400;
const dependencyTypes: DependencyType[] = ["FS", "SS", "FF", "SF"];
const emptyViewport: ViewportState = { scrollLeft: 0, scrollTop: 0, clientWidth: 1, clientHeight: 1, scrollWidth: 1, scrollHeight: 1 };

export function GanttChart({
  items,
  dependencies,
  baseline,
  timeZone,
  onDependencyUpdate,
  onDependencyRemove
}: {
  items: ScheduledItem[];
  dependencies: Dependency[];
  baseline?: Baseline;
  timeZone: string;
  onDependencyUpdate: (dependencyId: string, patch: DependencyPatch) => void;
  onDependencyRemove: (dependencyId: string) => void;
}) {
  const referenceTime = useMemo(() => new Date().toISOString(), []);
  const [zoom, setZoom] = useState<GanttZoom>("day");
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [selectedDependencyId, setSelectedDependencyId] = useState<string>();
  const [miniDragging, setMiniDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<ViewportState>(emptyViewport);
  const sortedItems = useMemo(() => [...items].sort((a, b) => a.workItem.outline.localeCompare(b.workItem.outline, undefined, { numeric: true })), [items]);
  const itemById = useMemo(() => new Map(sortedItems.map((item) => [item.workItem.id, item])), [sortedItems]);
  const visibleItemIds = new Set(sortedItems.map((item) => item.workItem.id));
  const visibleDependencies = dependencies.filter((dependency) => visibleItemIds.has(dependency.fromId) && visibleItemIds.has(dependency.toId));
  const selectedItem = sortedItems.find((item) => item.workItem.id === selectedItemId) ?? sortedItems[0];
  const selectedDependency = visibleDependencies.find((dependency) => dependency.id === selectedDependencyId);
  const relatedDependencies = selectedItem ? visibleDependencies.filter((dependency) => dependency.fromId === selectedItem.workItem.id || dependency.toId === selectedItem.workItem.id) : [];
  const inspectedDependencies = selectedDependency
    ? [selectedDependency, ...relatedDependencies.filter((dependency) => dependency.id !== selectedDependency.id)]
    : relatedDependencies.length ? relatedDependencies : visibleDependencies.slice(0, 5);
  const pixelsPerDay = zoom === "compact" ? 44 : zoom === "wide" ? 128 : 84;
  const rowHeight = 46;
  const labelWidth = 320;
  const starts = [...sortedItems.map((item) => item.start), ...Object.values(baseline?.plannedStartByItem ?? {})];
  const finishes = [...sortedItems.map((item) => item.finish), ...Object.values(baseline?.plannedFinishByItem ?? {}), referenceTime];
  const first = starts[0] ?? referenceTime;
  const earliest = starts.reduce((value, item) => item < value ? item : value, first);
  const minDate = zonedDateKey(earliest, timeZone);
  const min = zonedDateTimeToIso(minDate, "00:00", timeZone);
  const last = finishes.reduce((value, item) => item > value ? item : value, finishes[0] ?? referenceTime);
  const max = addZonedCalendarDays(zonedDateTimeToIso(zonedDateKey(last, timeZone), "00:00", timeZone), 2, timeZone);
  const totalDays = Math.max(1, calendarDayDistance(minDate, zonedDateKey(max, timeZone)));
  const width = totalDays * pixelsPerDay;
  const height = sortedItems.length * rowHeight;
  const ticks = Array.from({ length: totalDays + 1 }, (_, index) => addZonedCalendarDays(min, index, timeZone));
  const x = (iso: string) => Math.max(0, calendarDayOffset(minDate, iso, timeZone) * pixelsPerDay);
  const indexById = new Map(sortedItems.map((item, index) => [item.workItem.id, index]));

  const updateViewport = () => {
    const element = viewportRef.current;
    if (!element) return;
    const next = {
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      clientWidth: Math.max(1, element.clientWidth),
      clientHeight: Math.max(1, element.clientHeight),
      scrollWidth: Math.max(1, element.scrollWidth),
      scrollHeight: Math.max(1, element.scrollHeight)
    };
    setViewport((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
  };

  useEffect(() => {
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [height, width, zoom, sortedItems.length]);

  const scrollFromMinimap = (event: PointerEvent<HTMLDivElement>) => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const xRatio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const yRatio = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    element.scrollTo({
      left: clamp(xRatio * element.scrollWidth - element.clientWidth / 2, 0, Math.max(0, element.scrollWidth - element.clientWidth)),
      top: clamp(yRatio * element.scrollHeight - element.clientHeight / 2, 0, Math.max(0, element.scrollHeight - element.clientHeight))
    });
    updateViewport();
  };

  if (!selectedItem) return <div className="emptyState">No scheduled items.</div>;
  const miniViewportStyle = {
    left: `${viewport.scrollLeft / viewport.scrollWidth * 100}%`,
    top: `${viewport.scrollTop / viewport.scrollHeight * 100}%`,
    width: `${Math.max(8, viewport.clientWidth / viewport.scrollWidth * 100)}%`,
    height: `${Math.max(18, viewport.clientHeight / viewport.scrollHeight * 100)}%`
  };
  const incomingCount = visibleDependencies.filter((dependency) => dependency.toId === selectedItem.workItem.id).length;
  const outgoingCount = visibleDependencies.filter((dependency) => dependency.fromId === selectedItem.workItem.id).length;

  return (
    <div className="ganttWorkSurface" aria-label={`Interactive Gantt chart with ${items.length} items from ${shortDateTime(min, timeZone)} to ${shortDateTime(max, timeZone)}; ${items.filter((item) => item.isCritical).length} critical items.`}>
      <div className="ganttToolbar">
        <div className="ganttToolbarBadges">
          <Badge variant={baseline ? "success" : "outline"} className="iconBadge" title={baseline?.name ?? "No baseline"}>{baseline ? <CheckCircle2 /> : <Archive />}{baseline ? "B" : "-"}</Badge>
          <Badge variant="outline" className="iconBadge" title="Dependencies"><Network />{visibleDependencies.length}</Badge>
          <Badge variant={items.some((item) => item.isCritical) ? "warning" : "outline"} className="iconBadge" title="Critical path"><AlertTriangle />{items.filter((item) => item.isCritical).length}</Badge>
        </div>
        <div className="segmentedControl" aria-label="Gantt zoom">
          {(["compact", "day", "wide"] as const).map((value) => <button type="button" key={value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>{value === "day" ? "Day" : value[0].toUpperCase() + value.slice(1)}</button>)}
        </div>
      </div>
      <div className="ganttViewport" ref={viewportRef} onScroll={updateViewport}>
        <div className="ganttBoard" style={{ width: labelWidth + width, gridTemplateColumns: `${labelWidth}px ${width}px` }}>
          <div className="ganttTreeHeader">WBS / Task</div>
          <div className="ganttTimeHeader" style={{ width }}>{ticks.map((tick, index) => <div key={tick} className={`ganttTick ${index % 7 === 5 || index % 7 === 6 ? "weekend" : ""}`} style={{ left: index * pixelsPerDay, width: pixelsPerDay }}>{tickLabel(tick, timeZone)}</div>)}</div>
          <div className="ganttTreeRows">{sortedItems.map((item) => <button type="button" key={item.workItem.id} className={`ganttTreeRow ${selectedItem.workItem.id === item.workItem.id ? "selected" : ""} ${item.workItem.kind}`} onClick={() => setSelectedItemId(item.workItem.id)} aria-pressed={selectedItem.workItem.id === item.workItem.id}><span className="ganttOutline">{item.workItem.outline}</span><span className="ganttTaskTitle">{item.workItem.title}</span>{item.isCritical && <span className="miniBadge danger">Critical</span>}</button>)}</div>
          <div className="ganttTimelinePane" style={{ width, height }}>
            {ticks.map((tick, index) => <div key={tick} className={`ganttGridLine ${index % 7 === 5 || index % 7 === 6 ? "weekend" : ""}`} style={{ left: index * pixelsPerDay, width: pixelsPerDay }} />)}
            <div className="ganttToday" style={{ left: x(referenceTime) }}><span>Today</span></div>
            <svg className="ganttDependencyLayer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              <defs><marker id="gantt-arrow-lazy" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" className="ganttArrowHead" /></marker></defs>
              {visibleDependencies.map((dependency) => {
                const from = itemById.get(dependency.fromId);
                const to = itemById.get(dependency.toId);
                if (!from || !to) return null;
                const x1 = endpointX(from, dependency.type, "from", x);
                const x2 = endpointX(to, dependency.type, "to", x);
                const y1 = (indexById.get(from.workItem.id) ?? 0) * rowHeight + rowHeight / 2;
                const y2 = (indexById.get(to.workItem.id) ?? 0) * rowHeight + rowHeight / 2;
                const bend = Math.max(x1 + 18, (x1 + x2) / 2);
                const active = selectedDependencyId === dependency.id || dependency.fromId === selectedItem.workItem.id || dependency.toId === selectedItem.workItem.id;
                return <g key={dependency.id} className={active ? "activeDependency" : undefined}><path className={`ganttDependency ${selectedDependencyId === dependency.id ? "selected" : ""}`} markerEnd="url(#gantt-arrow-lazy)" d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`} /><circle className="ganttDepPort from" cx={x1} cy={y1} r="3" /><circle className="ganttDepPort to" cx={x2} cy={y2} r="3" /></g>;
              })}
            </svg>
            {sortedItems.map((item, index) => <ItemBar key={item.workItem.id} item={item} index={index} rowHeight={rowHeight} x={x} baseline={baseline} timeZone={timeZone} selected={selectedItem.workItem.id === item.workItem.id} onSelect={() => setSelectedItemId(item.workItem.id)} />)}
          </div>
        </div>
      </div>
      <div className="ganttMinimapRow">
        <div className={`ganttMinimap ${miniDragging ? "dragging" : ""}`} role="button" tabIndex={0} aria-label="Gantt minimap. Click or drag to move the visible timeline and task rows." onPointerDown={(event) => { setMiniDragging(true); event.currentTarget.setPointerCapture(event.pointerId); scrollFromMinimap(event); }} onPointerMove={(event) => { if (miniDragging) scrollFromMinimap(event); }} onPointerUp={(event) => { setMiniDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => setMiniDragging(false)} onKeyDown={(event) => {
          const element = viewportRef.current;
          if (!element || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          element.scrollBy({ left: event.key === "ArrowLeft" ? -pixelsPerDay : event.key === "ArrowRight" ? pixelsPerDay : 0, top: event.key === "ArrowUp" ? -rowHeight : event.key === "ArrowDown" ? rowHeight : 0 });
        }}>
          {sortedItems.map((item, index) => <span key={item.workItem.id} className={`miniTaskBar ${item.isCritical ? "critical" : ""} ${item.workItem.kind}`} style={{ left: `${(labelWidth + x(item.start)) / Math.max(1, labelWidth + width) * 100}%`, top: `${index / Math.max(1, sortedItems.length) * 100}%`, width: `${Math.max(1.2, (x(item.finish) - x(item.start)) / Math.max(1, labelWidth + width) * 100)}%`, height: `${Math.max(4, 100 / Math.max(1, sortedItems.length) - 1)}%` }} />)}
          <span className="miniViewport" style={miniViewportStyle} />
        </div>
        <div className="ganttMiniStats"><span>{sortedItems.length} rows</span><span>{visibleDependencies.length} deps</span><span>{shortDateTime(min, timeZone)} - {shortDateTime(max, timeZone)}</span></div>
      </div>
      <div className="ganttInspector">
        <div className="ganttSelectedSummary"><span>Selected</span><strong>{selectedItem.workItem.title}</strong><p>{scheduleRange(selectedItem, timeZone)} / {selectedItem.workItem.percentComplete}% complete / {selectedItem.isCritical ? "critical path" : `${Math.round(selectedItem.totalFloatSeconds / 3600)}h float`}</p><p>{incomingCount} predecessors / {outgoingCount} successors</p></div>
        <DependencyEditor dependencies={inspectedDependencies} selectedDependencyId={selectedDependencyId} selectedItemId={selectedItem.workItem.id} itemById={itemById} onSelect={(dependency, nextItemId) => { setSelectedDependencyId(dependency.id); setSelectedItemId(nextItemId); }} onUpdate={(id, patch) => { setSelectedDependencyId(id); onDependencyUpdate(id, patch); }} onRemove={(id) => { if (selectedDependencyId === id) setSelectedDependencyId(undefined); onDependencyRemove(id); }} />
        <div className="ganttLegend" aria-hidden="true"><span><i className="legendSwatch normalSwatch" />Scheduled</span><span><i className="legendSwatch criticalSwatch" />Critical</span><span><i className="legendSwatch baselineSwatch" />Baseline</span><span><i className="legendSwatch progressSwatch" />Progress</span><span><i className="milestoneLegend" />Milestone</span></div>
      </div>
      <div className="srOnly">Gantt data: {sortedItems.map((item) => `${item.workItem.title}, ${scheduleRange(item, timeZone)}, ${item.isCritical ? "critical" : "not critical"}`).join("; ")}</div>
    </div>
  );
}

function ItemBar({ item, index, rowHeight, x, baseline, timeZone, selected, onSelect }: { item: ScheduledItem; index: number; rowHeight: number; x: (iso: string) => number; baseline?: Baseline; timeZone: string; selected: boolean; onSelect: () => void }) {
  const top = index * rowHeight;
  const start = x(item.start);
  const finish = Math.max(start + 10, x(item.finish));
  const baselineStart = baseline?.plannedStartByItem[item.workItem.id];
  const baselineFinish = baseline?.plannedFinishByItem[item.workItem.id];
  const baselineLeft = baselineStart ? x(baselineStart) : undefined;
  const baselineWidth = baselineStart && baselineFinish ? Math.max(6, x(baselineFinish) - baselineLeft!) : undefined;
  const segments = item.workItem.splitSegments?.length ? item.workItem.splitSegments.map((segment) => ({ left: x(addSeconds(item.start, segment.offsetSeconds)), width: Math.max(8, x(addSeconds(item.start, segment.offsetSeconds + segment.durationSeconds)) - x(addSeconds(item.start, segment.offsetSeconds))) })) : [{ left: start, width: Math.max(8, finish - start) }];
  return <div className={`ganttLane ${selected ? "selected" : ""}`} style={{ top, height: rowHeight }}>{baselineLeft !== undefined && baselineWidth !== undefined && <span className="ganttBaseline" style={{ left: baselineLeft, width: baselineWidth }} />}{item.workItem.kind === "milestone" ? <button type="button" className={`ganttMilestone ${item.isCritical ? "critical" : ""}`} style={{ left: start }} onClick={onSelect} aria-label={`${item.workItem.title}, milestone, ${shortDateTime(item.start, timeZone)}`} /> : segments.map((segment, segmentIndex) => <button type="button" key={`${item.workItem.id}-${segmentIndex}`} className={`ganttBarButton ${item.isCritical ? "critical" : ""} ${item.workItem.kind} ${selected ? "selected" : ""}`} style={{ left: segment.left, width: segment.width }} onClick={onSelect} aria-label={`${item.workItem.title}, ${scheduleRange(item, timeZone)}, ${item.workItem.percentComplete}% complete`}><span className="ganttProgressFill" style={{ width: `${clamp(item.workItem.percentComplete, 0, 100)}%` }} /></button>)}</div>;
}

function DependencyEditor({ dependencies, selectedDependencyId, selectedItemId, itemById, onSelect, onUpdate, onRemove }: { dependencies: Dependency[]; selectedDependencyId?: string; selectedItemId: string; itemById: Map<string, ScheduledItem>; onSelect: (dependency: Dependency, nextItemId: string) => void; onUpdate: (dependencyId: string, patch: DependencyPatch) => void; onRemove: (dependencyId: string) => void }) {
  if (!dependencies.length) return <div className="ganttDependencyInspector empty"><span>Dependencies</span><strong>No linked tasks</strong><p>Select another row or use the Add dependency controls above the Gantt.</p></div>;
  return <div className="ganttDependencyInspector"><span>Dependencies</span><div className="dependencyStack">{dependencies.map((dependency) => {
    const from = itemById.get(dependency.fromId);
    const to = itemById.get(dependency.toId);
    if (!from || !to) return null;
    const other = dependency.fromId === selectedItemId ? to : from;
    const relation = dependency.fromId === selectedItemId ? "Blocks" : "Blocked by";
    return <article className={`dependencyRow ${selectedDependencyId === dependency.id ? "selected" : ""}`} key={dependency.id}><button type="button" className="dependencySummaryButton" onClick={() => onSelect(dependency, other.workItem.id)} aria-pressed={selectedDependencyId === dependency.id}><span className="dependencyDirection">{relation}</span><strong>{from.workItem.outline} {dependencyLabel(dependency.type)} {to.workItem.outline}{dependency.lagSeconds ? ` ${formatLag(dependency.lagSeconds)}` : ""}</strong><span>{from.workItem.title} -&gt; {to.workItem.title}</span></button><div className="dependencyControls"><label>Type<select value={dependency.type} aria-label={`Dependency type for ${from.workItem.outline} to ${to.workItem.outline}`} onChange={(event) => onUpdate(dependency.id, { type: event.target.value as DependencyType })}>{dependencyTypes.map((type) => <option key={type} value={type}>{dependencyLabel(type)}</option>)}</select></label><div className="lagStepper" aria-label={`Lag for ${from.workItem.outline} to ${to.workItem.outline}`}><button type="button" onClick={() => onUpdate(dependency.id, { lagSeconds: clamp(dependency.lagSeconds - daySeconds, -10 * daySeconds, 30 * daySeconds) })}>-</button><span>{formatLag(dependency.lagSeconds)}</span><button type="button" onClick={() => onUpdate(dependency.id, { lagSeconds: clamp(dependency.lagSeconds + daySeconds, -10 * daySeconds, 30 * daySeconds) })}>+</button></div><button type="button" className="removeDependency" onClick={() => onRemove(dependency.id)}>Remove</button></div><p className="dependencyEquation">{dependencyEquation(dependency, from, to)}</p></article>;
  })}</div></div>;
}

function endpointX(item: ScheduledItem, type: DependencyType, side: "from" | "to", x: (iso: string) => number) { return x((side === "from" ? type[0] : type[1]) === "S" ? item.start : item.finish); }
function dependencyEquation(dependency: Dependency, from: ScheduledItem, to: ScheduledItem) { const source = dependency.type[0] === "S" ? "start" : "finish"; const target = dependency.type[1] === "S" ? "start" : "finish"; return `${to.workItem.outline} ${target} cannot be earlier than ${from.workItem.outline} ${source}${dependency.lagSeconds ? ` ${formatLag(dependency.lagSeconds)}` : ""}.`; }
function dependencyLabel(type: DependencyType) { return type === "FS" ? "Finish → Start" : type === "SS" ? "Start → Start" : type === "FF" ? "Finish → Finish" : "Start → Finish"; }
function formatLag(seconds: number) { const days = Math.round(seconds / daySeconds); return days === 0 ? "0d" : `${days > 0 ? "+" : ""}${days}d`; }
export function shortDateTime(iso: string, timeZone: string) { return `${zonedDateKey(iso, timeZone).slice(5)} ${zonedTimeKey(iso, timeZone)}`; }
function scheduleRange(item: ScheduledItem, timeZone: string) { return `${shortDateTime(item.start, timeZone)} -> ${shortDateTime(item.finish, timeZone)}`; }
function tickLabel(iso: string, timeZone: string) { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone }); }
export function calendarDayDistance(from: string, to: string) { return Math.round((Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`)) / daySeconds / 1_000); }
export function calendarDayOffset(from: string, iso: string, timeZone: string) {
  const date = zonedDateKey(iso, timeZone);
  const [hour, minute] = zonedTimeKey(iso, timeZone).split(":").map(Number);
  return calendarDayDistance(from, date) + (hour * 60 + minute) / (24 * 60);
}
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
