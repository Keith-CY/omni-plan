import type {
  ISODate,
  RecurringOccurrenceRecord,
  RecurringOccurrenceStatus,
  RepeatCadenceKind,
  RepeatEndMode,
  RepeatExecutionMode,
  RepeatRule,
  RepeatStartMode,
  Seconds,
  WorkItem,
  WorkspaceSnapshot
} from "./types";
import { addSeconds, addZonedCalendarDays, addZonedCalendarMonths, zonedDateKey, zonedDateTimeToIso, zonedTimeKey } from "./time";

const daySeconds = 24 * 60 * 60;
const projectionSafetyLimit = 50_000;

export interface RecurringOccurrence {
  id: string;
  index: number;
  ruleId: string;
  workItemId: string;
  projectId: string;
  scheduledStart: ISODate;
  scheduledFinish: ISODate;
  start: ISODate;
  finish: ISODate;
  startMode: RepeatStartMode;
  executionMode: RepeatExecutionMode;
  status: RecurringOccurrenceStatus;
  title: string;
  description: string;
  record?: RecurringOccurrenceRecord;
}

export interface RecurringProjectionOptions {
  timeZone?: string;
  now?: ISODate;
  windowStart?: ISODate;
  windowEnd?: ISODate;
  limit?: number;
  records?: RecurringOccurrenceRecord[];
}

export type AutomaticOccurrenceAction =
  | { type: "reschedule"; occurrence: RecurringOccurrence; start: ISODate; finish: ISODate; actedAt: ISODate }
  | { type: "skip"; occurrence: RecurringOccurrence; actedAt: ISODate }
  | { type: "report-exception"; occurrence: RecurringOccurrence; note: string; actedAt: ISODate; dueAt?: ISODate; resourceId?: string }
  | { type: "stop-rule"; workItemId: string; actedAt: ISODate };

export interface AutomaticOccurrenceActionResult {
  workspace: WorkspaceSnapshot;
  occurrence?: RecurringOccurrenceRecord;
  followUpWorkItemId?: string;
}

export function repeatCadence(rule?: RepeatRule): RepeatCadenceKind {
  return rule?.cadence ?? "every-n-days";
}

export function repeatStartMode(rule?: RepeatRule): RepeatStartMode {
  return repeatExecutionMode(rule) === "automatic" ? "fixed-time" : rule?.startMode ?? "fixed-time";
}

export function repeatExecutionMode(rule?: RepeatRule): RepeatExecutionMode {
  return rule?.executionMode ?? "manual";
}

export function repeatEndMode(rule?: RepeatRule): RepeatEndMode {
  return rule?.endMode ?? "count";
}

export function isAutomaticRecurringWorkItem(item: WorkItem): boolean {
  return Boolean(item.repeatRule && repeatExecutionMode(item.repeatRule) === "automatic");
}

export function isExecutionWorkItem(item: WorkItem): boolean {
  return !isAutomaticRecurringWorkItem(item);
}

export function repeatCadenceLabel(rule?: RepeatRule): string {
  const cadence = repeatCadence(rule);
  if (cadence === "weekly") return "weekly";
  if (cadence === "monthly") return "monthly";
  return `every ${Math.max(1, Math.round(rule?.everyDays ?? 1))}d`;
}

export function repeatStartModeLabel(rule?: RepeatRule): string {
  return repeatStartMode(rule) === "after-previous-finish" ? "after previous finish" : "fixed time";
}

export function recurringRuleId(item: WorkItem): string {
  return item.repeatRule?.id ?? `repeat-${item.id}`;
}

export function recurringOccurrenceId(ruleId: string, scheduledStart: ISODate): string {
  return `occ-${ruleId}-${scheduledStart.replace(/\D/g, "")}`;
}

/**
 * Keeps reminder/description-only edits on the existing effective boundary while
 * making schedule edits future-only. Historical records remain overlaid by ID.
 */
export function applyAutomaticRuleEditBoundary(
  previousRule: RepeatRule | undefined,
  nextRule: RepeatRule,
  changedAt: ISODate
): RepeatRule {
  if (repeatExecutionMode(nextRule) !== "automatic") {
    const manualRule = { ...nextRule };
    delete manualRule.automaticFrom;
    return manualRule;
  }
  const scheduleChanged = repeatExecutionMode(previousRule) !== "automatic" ||
    automaticScheduleSignature(previousRule) !== automaticScheduleSignature(nextRule);
  return {
    ...nextRule,
    automaticFrom: scheduleChanged ? changedAt : previousRule?.automaticFrom ?? changedAt
  };
}

/**
 * Changes the workspace time zone as a future-only rule edit. Due work settles
 * in the old zone first; wall-clock anchors move to the new zone; history stays absolute.
 */
export function changeRecurringWorkspaceTimeZone(
  workspace: WorkspaceSnapshot,
  timeZone: string,
  changedAt: ISODate
): WorkspaceSnapshot {
  if (workspace.timeZone === timeZone) return workspace;
  const settled = reconcileAutomaticOccurrences(workspace, changedAt).workspace;
  const previousTimeZone = settled.timeZone;
  return {
    ...settled,
    timeZone,
    workItems: settled.workItems.map((item) => {
      if (!isAutomaticRecurringWorkItem(item) || !item.repeatRule) return item;
      return {
        ...item,
        repeatRule: {
          ...item.repeatRule,
          startAt: item.repeatRule.startAt ? preserveWallClock(item.repeatRule.startAt, previousTimeZone, timeZone) : undefined,
          until: item.repeatRule.until ? preserveWallClock(item.repeatRule.until, previousTimeZone, timeZone) : undefined,
          automaticFrom: changedAt
        }
      };
    })
  };
}

/** Compatibility wrapper for the original finite/manual preview interface. */
export function generateRecurringOccurrences(item: WorkItem, fallbackStart: ISODate, limit = 8): RecurringOccurrence[] {
  return projectRecurringOccurrences(item, fallbackStart, { timeZone: "UTC", limit });
}

/**
 * Projects recurrence into a bounded window and overlays persisted records.
 * Future occurrences remain virtual; only explicit actions and settlement create records.
 */
export function projectRecurringOccurrences(
  item: WorkItem,
  fallbackStart: ISODate,
  options: RecurringProjectionOptions = {}
): RecurringOccurrence[] {
  if (!item.repeatRule) return [];

  const rule = item.repeatRule;
  const timeZone = options.timeZone ?? "UTC";
  const now = options.now ?? new Date().toISOString();
  const ruleId = recurringRuleId(item);
  const executionMode = repeatExecutionMode(rule);
  const records = executionMode === "automatic"
    ? (options.records ?? []).filter((record) => record.workItemId === item.id)
    : [];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const projected: RecurringOccurrence[] = [];
  const includedIds = new Set<string>();
  const limit = Math.max(1, Math.round(options.limit ?? 200));
  const startMode = repeatStartMode(rule);
  const anchorStart = rule.startAt ?? item.constraint?.fixedStart ?? item.constraint?.noEarlierThan ?? fallbackStart;
  const duration = occurrenceDuration(item);
  let rollingStart = anchorStart;
  let automaticEligibleCount = 0;

  for (let zeroIndex = 0; zeroIndex < projectionSafetyLimit; zeroIndex += 1) {
    if (executionMode !== "automatic" && repeatEndMode(rule) === "count" && zeroIndex >= Math.max(1, Math.round(rule.count || 1))) break;

    const scheduledStart = startMode === "after-previous-finish"
      ? zeroIndex === 0 ? rollingStart : addOccurrenceCadence(rollingStart, rule, 1, timeZone, executionMode)
      : addOccurrenceCadence(anchorStart, rule, zeroIndex, timeZone, executionMode);
    const scheduledFinish = addSeconds(scheduledStart, duration);
    rollingStart = scheduledFinish;

    if (repeatEndMode(rule) === "until" && rule.until && scheduledStart > rule.until) break;
    if (rule.stoppedAt && scheduledStart >= rule.stoppedAt) break;

    const index = zeroIndex + 1;
    const id = recurringOccurrenceId(ruleId, scheduledStart);
    const record = recordById.get(id);
    const occurrence = occurrenceFromProjection(item, ruleId, index, scheduledStart, scheduledFinish, now, record);
    const isAutomaticEligible = executionMode !== "automatic" || !rule.automaticFrom || scheduledStart >= rule.automaticFrom;
    if (executionMode === "automatic" && isAutomaticEligible) {
      if (repeatEndMode(rule) === "count" && automaticEligibleCount >= Math.max(1, Math.round(rule.count || 1))) break;
      automaticEligibleCount += 1;
    }
    const inWindow = occurrenceInWindow(occurrence, options.windowStart, options.windowEnd);

    if (isAutomaticEligible && inWindow) {
      projected.push(occurrence);
      includedIds.add(id);
      if (!options.windowEnd && projected.length >= limit) break;
      if (projected.length >= limit) break;
    }

    if (options.windowEnd && scheduledStart >= options.windowEnd && !record) break;
  }

  // A stored override can move an occurrence into the requested window even when
  // its original projected date no longer belongs to the active rule revision.
  for (const record of records) {
    if (includedIds.has(record.id)) continue;
    if (rule.stoppedAt && record.start >= rule.stoppedAt && (record.status === "scheduled" || record.status === "skipped")) continue;
    const occurrence = occurrenceFromRecord(record, item, now);
    if (!occurrenceInWindow(occurrence, options.windowStart, options.windowEnd)) continue;
    projected.push(occurrence);
    includedIds.add(record.id);
  }

  return projected.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function nextRecurringOccurrence(
  item: WorkItem,
  fallbackStart: ISODate,
  from: ISODate,
  timeZone = "UTC"
): RecurringOccurrence | undefined {
  return projectRecurringOccurrences(item, fallbackStart, {
    timeZone,
    now: from,
    windowStart: from,
    limit: 1
  })[0];
}

export function reconcileAutomaticOccurrences(
  workspace: WorkspaceSnapshot,
  now: ISODate
): { workspace: WorkspaceSnapshot; settledIds: string[] } {
  const recordById = new Map(workspace.recurringOccurrences.map((record) => [record.id, record]));
  const settledIds: string[] = [];
  const nextRecords = [...workspace.recurringOccurrences];
  const projectById = new Map(workspace.projects.map((project) => [project.id, project]));

  for (const item of workspace.workItems.filter(isAutomaticRecurringWorkItem)) {
    const project = projectById.get(item.projectId);
    if (!project || !item.repeatRule) continue;
    const from = item.repeatRule.automaticFrom ?? item.repeatRule.startAt ?? project.start;
    const occurrences = projectRecurringOccurrences(item, project.start, {
      timeZone: workspace.timeZone,
      now,
      windowStart: from,
      windowEnd: addSeconds(now, 1),
      limit: projectionSafetyLimit,
      records: workspace.recurringOccurrences
    });

    for (const occurrence of occurrences) {
      if (occurrence.finish > now || occurrence.status === "skipped" || occurrence.status === "exception" || occurrence.status === "occurred" && recordById.has(occurrence.id)) continue;
      const existing = recordById.get(occurrence.id);
      const settled = {
        ...(existing ?? recordFromOccurrence(occurrence, occurrence.finish)),
        status: "occurred" as const,
        settledAt: now,
        settlementSource: now <= addSeconds(occurrence.finish, 90) ? "on-time" as const : "system-catch-up" as const,
        updatedAt: now
      };
      if (existing) {
        const index = nextRecords.findIndex((record) => record.id === existing.id);
        nextRecords[index] = settled;
      } else {
        nextRecords.push(settled);
      }
      recordById.set(settled.id, settled);
      settledIds.push(settled.id);
    }
  }

  if (!settledIds.length) return { workspace, settledIds };
  return {
    workspace: { ...workspace, recurringOccurrences: sortOccurrenceRecords(nextRecords) },
    settledIds
  };
}

export function applyAutomaticOccurrenceAction(
  workspace: WorkspaceSnapshot,
  action: AutomaticOccurrenceAction
): AutomaticOccurrenceActionResult {
  const reconciled = reconcileAutomaticOccurrences(workspace, action.actedAt).workspace;

  if (action.type === "stop-rule") {
    const item = reconciled.workItems.find((candidate) => candidate.id === action.workItemId);
    if (!item?.repeatRule || !isAutomaticRecurringWorkItem(item)) throw new Error("Automatic recurring rule not found.");
    if (item.repeatRule.stoppedAt) return { workspace: reconciled };
    return {
      workspace: {
        ...reconciled,
        workItems: reconciled.workItems.map((candidate) => candidate.id === item.id
          ? { ...candidate, repeatRule: { ...candidate.repeatRule!, stoppedAt: action.actedAt } }
          : candidate)
      }
    };
  }

  const occurrence = action.occurrence;
  const item = reconciled.workItems.find((candidate) => candidate.id === occurrence.workItemId);
  if (!item?.repeatRule || !isAutomaticRecurringWorkItem(item)) throw new Error("Automatic recurring work item not found.");
  const existing = reconciled.recurringOccurrences.find((record) => record.id === occurrence.id);

  if (action.type === "report-exception") {
    const note = action.note.trim();
    if (!note) throw new Error("An exception explanation is required.");
    if (occurrence.finish > action.actedAt) throw new Error("Only an occurred instance can be marked exceptional.");
    if (existing?.status === "exception" && existing.followUpWorkItemId) {
      return { workspace: reconciled, occurrence: existing, followUpWorkItemId: existing.followUpWorkItemId };
    }
    if (existing?.status !== "occurred") throw new Error("Only an occurred instance can be marked exceptional.");
    const baseRecord = existing ?? recordFromOccurrence(occurrence, occurrence.finish);
    const followUpWorkItemId = `w-auto-exception-${occurrence.id}`;
    const dueAt = action.dueAt ?? zonedDateTimeToIso(zonedDateKey(action.actedAt, reconciled.timeZone), "23:59", reconciled.timeZone);
    const followUpExists = reconciled.workItems.some((candidate) => candidate.id === followUpWorkItemId);
    const followUp: WorkItem = {
      id: followUpWorkItemId,
      projectId: item.projectId,
      kind: "task",
      title: `Handle exception: ${baseRecord.title}`,
      description: `${note}\n\nAutomatic occurrence: ${baseRecord.start}`,
      outline: nextTopLevelOutline(reconciled.workItems, item.projectId),
      durationSeconds: 3600,
      estimate: { mostLikelySeconds: 3600 },
      constraint: { noLaterThan: dueAt },
      assignmentIds: action.resourceId ? [{ resourceId: action.resourceId, attention: "shallow", effortSeconds: 3600 }] : [],
      percentComplete: 0
    };
    const exceptional: RecurringOccurrenceRecord = {
      ...baseRecord,
      status: "exception",
      exceptionNote: note,
      followUpWorkItemId,
      updatedAt: action.actedAt
    };
    return {
      workspace: {
        ...reconciled,
        workItems: followUpExists ? reconciled.workItems : [followUp, ...reconciled.workItems],
        recurringOccurrences: upsertOccurrence(reconciled.recurringOccurrences, exceptional)
      },
      occurrence: exceptional,
      followUpWorkItemId
    };
  }

  if (action.type === "skip" && existing?.status === "skipped") return { workspace: reconciled, occurrence: existing };
  if (item.repeatRule.stoppedAt) throw new Error("Stopped automatic rules do not accept occurrence changes.");
  const project = reconciled.projects.find((candidate) => candidate.id === item.projectId);
  const currentOccurrence = existing
    ? occurrenceFromRecord(existing, item, action.actedAt)
    : project ? projectRecurringOccurrences(item, project.start, {
      timeZone: reconciled.timeZone,
      now: action.actedAt,
      windowStart: addSeconds(occurrence.scheduledStart, -1),
      windowEnd: addSeconds(occurrence.scheduledStart, 1),
      records: reconciled.recurringOccurrences,
      limit: 2
    }).find((candidate) => candidate.id === occurrence.id) : undefined;
  if (!currentOccurrence || currentOccurrence.status !== "scheduled" || currentOccurrence.start <= action.actedAt) {
    throw new Error("Only a currently scheduled future occurrence can be changed.");
  }

  if (action.type === "skip") {
    const skipped: RecurringOccurrenceRecord = {
      ...(existing ?? recordFromOccurrence(currentOccurrence, action.actedAt)),
      status: "skipped",
      updatedAt: action.actedAt
    };
    return {
      workspace: { ...reconciled, recurringOccurrences: upsertOccurrence(reconciled.recurringOccurrences, skipped) },
      occurrence: skipped
    };
  }

  if (action.finish < action.start || action.start <= action.actedAt) throw new Error("The new occurrence range must start in the future.");
  const rescheduled: RecurringOccurrenceRecord = {
    ...(existing ?? recordFromOccurrence(currentOccurrence, action.actedAt)),
    start: action.start,
    finish: action.finish,
    status: "scheduled",
    updatedAt: action.actedAt
  };
  return {
    workspace: { ...reconciled, recurringOccurrences: upsertOccurrence(reconciled.recurringOccurrences, rescheduled) },
    occurrence: rescheduled
  };
}

export function selectAutomaticReminderOccurrences(workspace: WorkspaceSnapshot, now: ISODate): RecurringOccurrence[] {
  const projectById = new Map(workspace.projects.map((project) => [project.id, project]));
  const reminders: RecurringOccurrence[] = [];
  for (const item of workspace.workItems.filter(isAutomaticRecurringWorkItem)) {
    const project = projectById.get(item.projectId);
    const lead = item.repeatRule?.reminderLeadSeconds;
    if (!project || !lead || lead <= 0 || item.repeatRule?.stoppedAt) continue;
    const windowEnd = addSeconds(now, lead + 1);
    const occurrences = projectRecurringOccurrences(item, project.start, {
      timeZone: workspace.timeZone,
      now,
      windowStart: now,
      windowEnd,
      records: workspace.recurringOccurrences,
      limit: 20
    });
    reminders.push(...occurrences.filter((occurrence) => (
      occurrence.status === "scheduled" &&
      occurrence.start > now &&
      addSeconds(occurrence.start, -lead) <= now
    )));
  }
  return reminders.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

export function selectAutomaticOccurrenceHistory(workspace: WorkspaceSnapshot, workItemId?: string): RecurringOccurrenceRecord[] {
  return workspace.recurringOccurrences
    .filter((record) => !workItemId || record.workItemId === workItemId)
    .sort((a, b) => b.start.localeCompare(a.start) || b.updatedAt.localeCompare(a.updatedAt));
}

function occurrenceFromProjection(
  item: WorkItem,
  ruleId: string,
  index: number,
  scheduledStart: ISODate,
  scheduledFinish: ISODate,
  now: ISODate,
  record?: RecurringOccurrenceRecord
): RecurringOccurrence {
  if (record) return occurrenceFromRecord(record, item, now);
  const executionMode = repeatExecutionMode(item.repeatRule);
  return {
    id: recurringOccurrenceId(ruleId, scheduledStart),
    index,
    ruleId,
    workItemId: item.id,
    projectId: item.projectId,
    scheduledStart,
    scheduledFinish,
    start: scheduledStart,
    finish: scheduledFinish,
    startMode: repeatStartMode(item.repeatRule),
    executionMode,
    status: executionMode === "automatic" && scheduledFinish <= now ? "occurred" : "scheduled",
    title: item.title,
    description: item.description ?? ""
  };
}

function occurrenceFromRecord(record: RecurringOccurrenceRecord, item: WorkItem, _now: ISODate): RecurringOccurrence {
  return {
    id: record.id,
    index: record.occurrenceIndex,
    ruleId: record.ruleId,
    workItemId: record.workItemId,
    projectId: record.projectId,
    scheduledStart: record.scheduledStart,
    scheduledFinish: record.scheduledFinish,
    start: record.start,
    finish: record.finish,
    startMode: "fixed-time",
    executionMode: "automatic",
    status: record.status,
    title: record.title,
    description: record.description,
    record
  };
}

function recordFromOccurrence(occurrence: RecurringOccurrence, createdAt: ISODate): RecurringOccurrenceRecord {
  return {
    id: occurrence.id,
    ruleId: occurrence.ruleId,
    workItemId: occurrence.workItemId,
    projectId: occurrence.projectId,
    occurrenceIndex: occurrence.index,
    scheduledStart: occurrence.scheduledStart,
    scheduledFinish: occurrence.scheduledFinish,
    start: occurrence.start,
    finish: occurrence.finish,
    status: occurrence.status,
    title: occurrence.title,
    description: occurrence.description,
    createdAt,
    updatedAt: createdAt
  };
}

function occurrenceInWindow(occurrence: RecurringOccurrence, windowStart?: ISODate, windowEnd?: ISODate): boolean {
  if (windowStart && occurrence.start < windowStart) return false;
  if (windowEnd && occurrence.start >= windowEnd) return false;
  return true;
}

function occurrenceDuration(item: WorkItem): Seconds {
  if (repeatExecutionMode(item.repeatRule) === "automatic") return Math.max(0, Math.round(item.repeatRule?.automaticDurationSeconds ?? 0));
  return item.kind === "milestone" ? 0 : item.durationSeconds;
}

function addOccurrenceCadence(
  anchorStart: ISODate,
  rule: RepeatRule,
  index: number,
  timeZone: string,
  executionMode: RepeatExecutionMode
): ISODate {
  const cadence = repeatCadence(rule);
  if (executionMode === "automatic") {
    if (cadence === "monthly") return addZonedCalendarMonths(anchorStart, index, timeZone);
    if (cadence === "weekly") return addZonedCalendarDays(anchorStart, index * 7, timeZone);
    return addZonedCalendarDays(anchorStart, index * Math.max(1, Math.round(rule.everyDays ?? 1)), timeZone);
  }
  if (cadence === "monthly") return addUtcMonths(anchorStart, index);
  if (cadence === "weekly") return addSeconds(anchorStart, index * 7 * daySeconds);
  return addSeconds(anchorStart, index * Math.max(1, Math.round(rule.everyDays ?? 1)) * daySeconds);
}

function automaticScheduleSignature(rule: RepeatRule | undefined): string {
  if (!rule) return "missing";
  const cadence = repeatCadence(rule);
  const endMode = repeatEndMode(rule);
  return JSON.stringify({
    cadence,
    everyDays: cadence === "every-n-days" ? Math.max(1, Math.round(rule.everyDays ?? 1)) : undefined,
    startAt: rule.startAt,
    endMode,
    count: endMode === "count" ? Math.max(1, Math.round(rule.count || 1)) : undefined,
    until: endMode === "until" ? rule.until : undefined,
    automaticDurationSeconds: Math.max(0, Math.round(rule.automaticDurationSeconds ?? 0))
  });
}

function preserveWallClock(value: ISODate, fromTimeZone: string, toTimeZone: string): ISODate {
  return zonedDateTimeToIso(zonedDateKey(value, fromTimeZone), zonedTimeKey(value, fromTimeZone), toTimeZone);
}

function addUtcMonths(value: ISODate, months: number): ISODate {
  const source = new Date(value);
  const targetMonth = source.getUTCMonth() + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(source.getUTCDate(), maxDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds()
  )).toISOString();
}

function upsertOccurrence(records: RecurringOccurrenceRecord[], record: RecurringOccurrenceRecord): RecurringOccurrenceRecord[] {
  return sortOccurrenceRecords([record, ...records.filter((candidate) => candidate.id !== record.id)]);
}

function sortOccurrenceRecords(records: RecurringOccurrenceRecord[]): RecurringOccurrenceRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

function nextTopLevelOutline(items: WorkItem[], projectId: string): string {
  return String(items.filter((item) => item.projectId === projectId && !item.parentId).length + 1);
}
