import { instantAtLocalMinute } from "../domain/localTime";

export function localDateTimeInputToInstant(
  value: string,
  timeZone: string,
): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return undefined;
  return instantAtLocalMinute(
    match[1],
    Number(match[2]) * 60 + Number(match[3]),
    timeZone,
  );
}

export function instantToLocalDateTimeInput(
  value: string | undefined,
  timeZone: string,
): string {
  if (value === undefined) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
  } catch {
    return "";
  }
}
