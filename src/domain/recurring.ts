import type { ISODate, RepeatCadenceKind, RepeatRule, RepeatStartMode, Seconds, WorkItem } from "./types";
import { addSeconds } from "./time";

const daySeconds = 24 * 60 * 60;

export interface RecurringOccurrence {
  index: number;
  start: ISODate;
  finish: ISODate;
  startMode: RepeatStartMode;
}

export function repeatCadence(rule?: RepeatRule): RepeatCadenceKind {
  return rule?.cadence ?? "every-n-days";
}

export function repeatStartMode(rule?: RepeatRule): RepeatStartMode {
  return rule?.startMode ?? "fixed-time";
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

export function generateRecurringOccurrences(item: WorkItem, fallbackStart: ISODate, limit = 8): RecurringOccurrence[] {
  if (!item.repeatRule) return [];

  const rule = item.repeatRule;
  const count = Math.min(Math.max(1, Math.round(rule.count || 1)), Math.max(1, limit));
  const startMode = repeatStartMode(rule);
  const anchorStart = rule.startAt ?? item.constraint?.fixedStart ?? item.constraint?.noEarlierThan ?? fallbackStart;
  const duration = durationOf(item);
  const occurrences: RecurringOccurrence[] = [];
  let rollingStart = anchorStart;

  for (let index = 0; index < count; index += 1) {
    const start = startMode === "after-previous-finish"
      ? index === 0 ? rollingStart : addFixedCadence(rollingStart, rule, 1)
      : addFixedCadence(anchorStart, rule, index);
    const finish = addSeconds(start, duration);
    occurrences.push({ index: index + 1, start, finish, startMode });
    rollingStart = finish;
  }

  return occurrences;
}

function durationOf(item: WorkItem): Seconds {
  return item.kind === "milestone" ? 0 : item.durationSeconds;
}

function addFixedCadence(anchorStart: ISODate, rule: RepeatRule, index: number): ISODate {
  const cadence = repeatCadence(rule);
  if (cadence === "monthly") return addUtcMonths(anchorStart, index);
  if (cadence === "weekly") return addSeconds(anchorStart, index * 7 * daySeconds);
  return addSeconds(anchorStart, index * Math.max(1, Math.round(rule.everyDays ?? 1)) * daySeconds);
}

function addUtcMonths(value: ISODate, months: number): ISODate {
  const source = new Date(value);
  const targetMonth = source.getUTCMonth() + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(source.getUTCDate(), maxDay),
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds()
  ));
  return target.toISOString();
}
