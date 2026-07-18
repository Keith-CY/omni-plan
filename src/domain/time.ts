import type { ISODate, Seconds } from "./types";

export function toDate(value: ISODate): Date {
  return new Date(value);
}

export function toIso(date: Date): ISODate {
  return date.toISOString();
}

export function addSeconds(value: ISODate, seconds: Seconds): ISODate {
  return toIso(new Date(toDate(value).getTime() + seconds * 1000));
}

export function secondsBetween(start: ISODate, finish: ISODate): Seconds {
  return Math.round((toDate(finish).getTime() - toDate(start).getTime()) / 1000);
}

export function maxIso(...values: Array<ISODate | undefined>): ISODate {
  const defined = values.filter(Boolean) as ISODate[];
  if (defined.length === 0) throw new Error("maxIso requires at least one date");
  return defined.reduce((max, value) => (toDate(value) > toDate(max) ? value : max));
}

export function minIso(...values: Array<ISODate | undefined>): ISODate {
  const defined = values.filter(Boolean) as ISODate[];
  if (defined.length === 0) throw new Error("minIso requires at least one date");
  return defined.reduce((min, value) => (toDate(value) < toDate(min) ? value : min));
}

export function startOfDay(value: ISODate): ISODate {
  const date = toDate(value);
  date.setUTCHours(0, 0, 0, 0);
  return toIso(date);
}

export function formatDay(value: ISODate): string {
  return value.slice(0, 10);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function zonedDateTimeParts(value: ISODate, timeZone: string): ZonedDateTimeParts {
  let formatter = zonedFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    zonedFormatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

export function zonedDateKey(value: ISODate, timeZone: string): string {
  const parts = zonedDateTimeParts(value, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function zonedTimeKey(value: ISODate, timeZone: string): string {
  const parts = zonedDateTimeParts(value, timeZone);
  return `${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function zonedDateTimeToIso(date: string, time: string, timeZone: string): ISODate {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!dateMatch || !timeMatch) throw new Error("Invalid local date or time.");
  const parts = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
    second: Number(timeMatch[3] ?? 0)
  };
  validateZonedParts(parts);
  return zonedPartsToIso(parts, timeZone);
}

export function zonedPartsToIso(parts: ZonedDateTimeParts, timeZone: string): ISODate {
  const desiredWallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = desiredWallTime;
  const evaluated: Array<{ candidate: number; wallDelta: number }> = [];
  const seen = new Set<number>();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const actual = zonedDateTimeParts(new Date(candidate).toISOString(), timeZone);
    const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const wallDelta = actualWallTime - desiredWallTime;
    evaluated.push({ candidate, wallDelta });
    if (wallDelta === 0) return new Date(candidate).toISOString();
    seen.add(candidate);
    const nextCandidate = candidate - wallDelta;
    if (seen.has(nextCandidate)) break;
    candidate = nextCandidate;
  }
  // A DST spring-forward gap has no exact instant. Move forward by the gap,
  // selecting the closest representable wall time after the requested one.
  const forward = evaluated
    .filter((entry) => entry.wallDelta > 0)
    .sort((left, right) => left.wallDelta - right.wallDelta || left.candidate - right.candidate)[0];
  if (forward) return new Date(forward.candidate).toISOString();
  throw new Error("Local date or time cannot be represented in this time zone.");
}

export function addZonedCalendarDays(value: ISODate, days: number, timeZone: string): ISODate {
  const source = zonedDateTimeParts(value, timeZone);
  const target = new Date(Date.UTC(source.year, source.month - 1, source.day + days, source.hour, source.minute, source.second));
  return zonedPartsToIso({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour: target.getUTCHours(),
    minute: target.getUTCMinutes(),
    second: target.getUTCSeconds()
  }, timeZone);
}

export function addZonedCalendarMonths(value: ISODate, months: number, timeZone: string): ISODate {
  const source = zonedDateTimeParts(value, timeZone);
  const targetMonth = source.month - 1 + months;
  const targetYear = source.year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return zonedPartsToIso({
    year: targetYear,
    month: normalizedMonth + 1,
    day: Math.min(source.day, lastDay),
    hour: source.hour,
    minute: source.minute,
    second: source.second
  }, timeZone);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

function validateZonedParts(parts: ZonedDateTimeParts) {
  const daysInMonth = parts.month >= 1 && parts.month <= 12
    ? new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()
    : 0;
  if (
    parts.year < 1 || parts.year > 9999 ||
    parts.month < 1 || parts.month > 12 ||
    parts.day < 1 || parts.day > daysInMonth ||
    parts.hour < 0 || parts.hour > 23 ||
    parts.minute < 0 || parts.minute > 59 ||
    parts.second < 0 || parts.second > 59
  ) {
    throw new Error("Invalid local date or time.");
  }
}
