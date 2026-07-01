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
