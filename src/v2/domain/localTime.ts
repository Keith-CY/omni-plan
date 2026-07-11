import type { AttentionKind, Id, ISODate, Seconds } from "@/domain/types";

import type {
  CapacityProfile,
  CommitmentSlot,
  Weekday,
} from "./types";

export interface CapacityInterval {
  start: ISODate;
  finish: ISODate;
}

export interface LocalDateCapacity {
  localDate: string;
  timeZone: string;
  weekday: Weekday;
  availableIntervals: CapacityInterval[];
  budgets: {
    deepSeconds: Seconds;
    mediumSeconds: Seconds;
    shallowSeconds: Seconds;
  };
}

export type CapacityPlacementReason =
  | "DEEP_CAPACITY_EXHAUSTED"
  | "MEDIUM_CAPACITY_EXHAUSTED"
  | "SHALLOW_CAPACITY_EXHAUSTED"
  | "OUTSIDE_WORK_WINDOW";

export interface CapacityCandidate {
  targetId: Id;
  targetRevision: number;
  target: CommitmentSlot["target"];
  durationSeconds: Seconds;
  attention: AttentionKind;
  fixedStart?: ISODate;
  earliestStart?: ISODate;
  latestFinish?: ISODate;
}

export interface CapacityLedger {
  readonly capacity: LocalDateCapacity;
  readonly remainingIntervals: CapacityInterval[];
  readonly usedSeconds: Record<AttentionKind, Seconds>;
  consume(slot: CommitmentSlot): void;
}

export type CapacityPlacement =
  | { ok: true; slot: CommitmentSlot }
  | { ok: false; reason: CapacityPlacementReason };

export type CapacityProfileValidation =
  | { ok: true; canonicalTimeZone: string }
  | { ok: false; reason: string; gate: string };

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface LocalDateTime extends CalendarDate {
  hour: number;
  minute: number;
}

interface MillisecondInterval {
  start: number;
  finish: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ZERO_BUDGETS = {
  deepSeconds: 0,
  mediumSeconds: 0,
  shallowSeconds: 0,
} as const;
const ATTENTION_KINDS = ["deep", "medium", "shallow"] as const;

type InitialUsedSeconds = Partial<Record<AttentionKind, Seconds>>;

function failure(
  reason: string,
  gate: string,
): Extract<CapacityProfileValidation, { ok: false }> {
  return { ok: false, reason, gate };
}

function canonicalTimeZone(timeZone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone })
      .resolvedOptions()
      .timeZone;
  } catch {
    return undefined;
  }
}

function canonicalInstant(value: string): number | undefined {
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) return undefined;
  return new Date(epochMilliseconds).toISOString() === value
    ? epochMilliseconds
    : undefined;
}

function isWeekday(value: unknown): value is Weekday {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
}

export function validateCapacityProfile(
  profile: CapacityProfile,
): CapacityProfileValidation {
  const resolvedTimeZone = canonicalTimeZone(profile.timeZone);
  if (resolvedTimeZone === undefined) {
    return failure(
      `Capacity timezone ${JSON.stringify(profile.timeZone)} is not valid.`,
      "capacity_profile:time_zone",
    );
  }

  for (const [index, window] of profile.weeklyWindows.entries()) {
    if (!isWeekday(window.weekday)) {
      return failure(
        `Weekly window ${index} must use a weekday from 0 through 6.`,
        `capacity_profile:weekly_window:${index}:weekday`,
      );
    }
    if (
      !Number.isInteger(window.startMinute) ||
      !Number.isInteger(window.finishMinute) ||
      window.startMinute < 0 ||
      window.startMinute >= window.finishMinute ||
      window.finishMinute > 1_440
    ) {
      return failure(
        `Weekly window ${index} must use integer minutes with 0 <= start < finish <= 1440.`,
        `capacity_profile:weekly_window:${index}`,
      );
    }
  }

  const windowsByWeekday = new Map<
    Weekday,
    Array<{ index: number; start: number; finish: number }>
  >();
  for (const [index, window] of profile.weeklyWindows.entries()) {
    const windows = windowsByWeekday.get(window.weekday) ?? [];
    windows.push({
      index,
      start: window.startMinute,
      finish: window.finishMinute,
    });
    windowsByWeekday.set(window.weekday, windows);
  }
  for (const windows of windowsByWeekday.values()) {
    windows.sort(
      (left, right) =>
        left.start - right.start ||
        left.finish - right.finish ||
        left.index - right.index,
    );
    for (let index = 1; index < windows.length; index += 1) {
      const previous = windows[index - 1];
      const current = windows[index];
      if (current.start < previous.finish) {
        return failure(
          `Weekly window ${current.index} overlaps another window on the same weekday.`,
          `capacity_profile:weekly_window:${current.index}`,
        );
      }
    }
  }

  const budgetByWeekday = new Map<Weekday, CapacityProfile["dailyBudgets"][number]>();
  for (const [index, budget] of profile.dailyBudgets.entries()) {
    if (!isWeekday(budget.weekday)) {
      return failure(
        `Daily budget ${index} must use a weekday from 0 through 6.`,
        `capacity_profile:daily_budget:${index}:weekday`,
      );
    }
    if (budgetByWeekday.has(budget.weekday)) {
      return failure(
        `Daily budget ${index} duplicates weekday ${budget.weekday}.`,
        `capacity_profile:daily_budget:${index}`,
      );
    }
    if (
      ![budget.deepSeconds, budget.mediumSeconds, budget.shallowSeconds].every(
        (seconds) =>
          Number.isFinite(seconds) &&
          Number.isInteger(seconds) &&
          seconds >= 0,
      )
    ) {
      return failure(
        `Daily budget ${index} must contain finite nonnegative integer seconds.`,
        `capacity_profile:daily_budget:${index}`,
      );
    }
    budgetByWeekday.set(budget.weekday, budget);
  }

  for (const [index, window] of profile.weeklyWindows.entries()) {
    if (!budgetByWeekday.has(window.weekday)) {
      return failure(
        `Weekly window ${index} has no daily budget for weekday ${window.weekday}.`,
        `capacity_profile:weekly_window:${index}:budget`,
      );
    }
  }

  const unavailableIds = new Set<Id>();
  for (const [index, block] of profile.unavailableBlocks.entries()) {
    const start = canonicalInstant(block.start);
    const finish = canonicalInstant(block.finish);
    if (
      block.id.trim() === "" ||
      unavailableIds.has(block.id) ||
      start === undefined ||
      finish === undefined ||
      start >= finish
    ) {
      return failure(
        `Unavailable block ${index} must have a unique ID and a canonical start before finish.`,
        `capacity_profile:unavailable_block:${index}`,
      );
    }
    unavailableIds.add(block.id);
  }

  const hasUsableCapacity = profile.weeklyWindows.some((window) => {
    const budget = budgetByWeekday.get(window.weekday);
    return (
      budget !== undefined &&
      budget.deepSeconds + budget.mediumSeconds + budget.shallowSeconds > 0
    );
  });
  if (!hasUsableCapacity) {
    return failure(
      "Capacity must include at least one working window with a positive attention budget.",
      "capacity_profile:usable_capacity",
    );
  }

  for (const [index, budget] of profile.dailyBudgets.entries()) {
    if (
      windowsByWeekday.has(budget.weekday) &&
      budget.deepSeconds + budget.mediumSeconds + budget.shallowSeconds === 0
    ) {
      return failure(
        `Daily budget ${index} for weekday ${budget.weekday} has no usable attention capacity for its configured working window.`,
        `capacity_profile:daily_budget:${index}:usable_capacity`,
      );
    }
  }

  return { ok: true, canonicalTimeZone: resolvedTimeZone };
}

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function zonedPartsAt(
  epochMilliseconds: number,
  timeZone: string,
): LocalDateTime {
  const parts = zonedFormatter(timeZone).formatToParts(
    new Date(epochMilliseconds),
  );
  const numberPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new RangeError(`Timezone formatter omitted ${type}.`);
    }
    return Number(value);
  };
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
  };
}

function sameLocalDateTime(
  left: LocalDateTime,
  right: LocalDateTime,
): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function localEpochMilliseconds(value: LocalDateTime): number {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
  );
}

function zonedLocalToEpochMilliseconds(
  value: LocalDateTime,
  timeZone: string,
): number {
  const localEpoch = localEpochMilliseconds(value);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sampledInstant = localEpoch + hours * HOUR_MS;
    const sampledLocal = zonedPartsAt(sampledInstant, timeZone);
    offsets.add(localEpochMilliseconds(sampledLocal) - sampledInstant);
  }

  const candidates = [...offsets]
    .map((offset) => localEpoch - offset)
    .filter((candidate) =>
      sameLocalDateTime(zonedPartsAt(candidate, timeZone), value),
    )
    .sort((left, right) => left - right);
  if (candidates.length > 0) return candidates[0];

  // Compatible DST-gap disambiguation: preserve wall-clock minutes by applying
  // the pre-transition offset, which moves a nonexistent time forward by the gap.
  const preTransitionOffset = Math.min(...offsets);
  return localEpoch - preTransitionOffset;
}

function parseLocalDate(localDate: string): CalendarDate | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) return undefined;
  const value = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day));
  return date.getUTCFullYear() === value.year &&
    date.getUTCMonth() === value.month - 1 &&
    date.getUTCDate() === value.day
    ? value
    : undefined;
}

function addCalendarDays(value: CalendarDate, days: number): CalendarDate {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function localDateTimeAtMinute(
  date: CalendarDate,
  minute: number,
): LocalDateTime {
  const adjustedDate = minute === 1_440 ? addCalendarDays(date, 1) : date;
  const adjustedMinute = minute === 1_440 ? 0 : minute;
  return {
    ...adjustedDate,
    hour: Math.floor(adjustedMinute / 60),
    minute: adjustedMinute % 60,
  };
}

function intervalToMilliseconds(interval: CapacityInterval): MillisecondInterval {
  return {
    start: Date.parse(interval.start),
    finish: Date.parse(interval.finish),
  };
}

function intervalFromMilliseconds(
  interval: MillisecondInterval,
): CapacityInterval {
  return {
    start: new Date(interval.start).toISOString(),
    finish: new Date(interval.finish).toISOString(),
  };
}

function mergeIntervals(intervals: MillisecondInterval[]): MillisecondInterval[] {
  const sorted = intervals
    .filter(({ start, finish }) => start < finish)
    .sort(
      (left, right) => left.start - right.start || left.finish - right.finish,
    );
  const merged: MillisecondInterval[] = [];
  for (const interval of sorted) {
    const previous = merged[merged.length - 1];
    if (previous === undefined || interval.start > previous.finish) {
      merged.push({ ...interval });
    } else {
      previous.finish = Math.max(previous.finish, interval.finish);
    }
  }
  return merged;
}

function subtractIntervals(
  sources: MillisecondInterval[],
  exclusions: MillisecondInterval[],
): MillisecondInterval[] {
  const mergedExclusions = mergeIntervals(exclusions);
  return sources.flatMap((source) => {
    const available: MillisecondInterval[] = [];
    let cursor = source.start;
    for (const exclusion of mergedExclusions) {
      if (exclusion.finish <= cursor) continue;
      if (exclusion.start >= source.finish) break;
      if (exclusion.start > cursor) {
        available.push({
          start: cursor,
          finish: Math.min(exclusion.start, source.finish),
        });
      }
      cursor = Math.max(cursor, exclusion.finish);
      if (cursor >= source.finish) break;
    }
    if (cursor < source.finish) {
      available.push({ start: cursor, finish: source.finish });
    }
    return available;
  });
}

export function localDateAt(
  value: ISODate,
  timeZone: string,
): string | undefined {
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) return undefined;
  try {
    const parts = zonedPartsAt(epochMilliseconds, timeZone);
    return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}

export function instantAtLocalMinute(
  localDate: string,
  minute: number,
  timeZone: string,
): ISODate | undefined {
  const date = parseLocalDate(localDate);
  if (
    date === undefined ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute >= 1_440
  ) {
    return undefined;
  }
  try {
    return new Date(
      zonedLocalToEpochMilliseconds(
        localDateTimeAtMinute(date, minute),
        timeZone,
      ),
    ).toISOString();
  } catch {
    return undefined;
  }
}

export function capacityForLocalDate(
  profile: CapacityProfile,
  localDate: string,
): LocalDateCapacity {
  const validation = validateCapacityProfile(profile);
  if (!validation.ok) {
    throw new RangeError(`Invalid capacity profile: ${validation.reason}`);
  }
  const date = parseLocalDate(localDate);
  if (date === undefined) {
    throw new RangeError(`Invalid local date: ${localDate}.`);
  }
  const timeZone = validation.canonicalTimeZone;

  const weekday = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay() as Weekday;
  const windows = profile.weeklyWindows
    .filter((window) => window.weekday === weekday)
    .map((window) => ({
      start: zonedLocalToEpochMilliseconds(
        localDateTimeAtMinute(date, window.startMinute),
        timeZone,
      ),
      finish: zonedLocalToEpochMilliseconds(
        localDateTimeAtMinute(date, window.finishMinute),
        timeZone,
      ),
    }));
  const unavailable = profile.unavailableBlocks.map((block) => ({
    start: Date.parse(block.start),
    finish: Date.parse(block.finish),
  }));
  const availableIntervals = subtractIntervals(
    mergeIntervals(windows),
    unavailable,
  ).map(intervalFromMilliseconds);
  const budget = profile.dailyBudgets.find(
    (candidate) => candidate.weekday === weekday,
  );

  return {
    localDate,
    timeZone,
    weekday,
    availableIntervals,
    budgets:
      budget === undefined
        ? { ...ZERO_BUDGETS }
        : {
            deepSeconds: budget.deepSeconds,
            mediumSeconds: budget.mediumSeconds,
            shallowSeconds: budget.shallowSeconds,
          },
  };
}

function attentionBudgetKey(
  attention: AttentionKind,
): keyof LocalDateCapacity["budgets"] {
  return `${attention}Seconds` as keyof LocalDateCapacity["budgets"];
}

function capacityReason(attention: AttentionKind): CapacityPlacementReason {
  return `${attention.toUpperCase()}_CAPACITY_EXHAUSTED` as CapacityPlacementReason;
}

function defaultSlotId(
  capacity: LocalDateCapacity,
  candidate: CapacityCandidate,
): Id {
  const targetId =
    candidate.target.kind === "action"
      ? candidate.target.actionId
      : candidate.target.workItemId;
  return `today-slot:${capacity.localDate}:${candidate.target.kind}:${targetId}:${candidate.targetRevision}`;
}

class CapacityLedgerImpl implements CapacityLedger {
  readonly #capacity: LocalDateCapacity;
  #remainingIntervals: MillisecondInterval[];
  #usedSeconds: Record<AttentionKind, Seconds>;

  constructor(
    capacity: LocalDateCapacity,
    notBefore?: ISODate,
    initialUsedSeconds: InitialUsedSeconds = {},
  ) {
    this.#capacity = structuredClone(capacity);
    const cutoff = notBefore === undefined ? undefined : Date.parse(notBefore);
    if (cutoff !== undefined && !Number.isFinite(cutoff)) {
      throw new RangeError(`Invalid capacity cutoff: ${notBefore}.`);
    }
    const used = Object.fromEntries(
      ATTENTION_KINDS.map((attention) => {
        const seconds = initialUsedSeconds[attention] ?? 0;
        if (
          !Number.isFinite(seconds) ||
          !Number.isInteger(seconds) ||
          seconds < 0
        ) {
          throw new RangeError(
            `Initial used ${attention} attention must be finite nonnegative integer seconds.`,
          );
        }
        return [attention, seconds];
      }),
    ) as Record<AttentionKind, Seconds>;
    this.#usedSeconds = used;
    this.#remainingIntervals = this.#capacity.availableIntervals
      .map(intervalToMilliseconds)
      .map((interval) => ({
        start: cutoff === undefined ? interval.start : Math.max(interval.start, cutoff),
        finish: interval.finish,
      }))
      .filter(({ start, finish }) => start < finish);
  }

  get capacity(): LocalDateCapacity {
    return structuredClone(this.#capacity);
  }

  get remainingIntervals(): CapacityInterval[] {
    return this.#remainingIntervals.map(intervalFromMilliseconds);
  }

  get usedSeconds(): Record<AttentionKind, Seconds> {
    return { ...this.#usedSeconds };
  }

  consume(slot: CommitmentSlot): void {
    if (!ATTENTION_KINDS.includes(slot.attention)) {
      throw new RangeError(`Cannot consume slot ${slot.id} with invalid attention.`);
    }
    const start = Date.parse(slot.start);
    const finish = Date.parse(slot.finish);
    const durationSeconds = (finish - start) / 1_000;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(finish) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      throw new RangeError(`Cannot consume invalid slot ${slot.id}.`);
    }
    if (
      !this.#remainingIntervals.some(
        (interval) => interval.start <= start && interval.finish >= finish,
      )
    ) {
      throw new RangeError(
        `Cannot consume slot ${slot.id} outside remaining capacity.`,
      );
    }
    const nextUsedSeconds = this.#usedSeconds[slot.attention] + durationSeconds;
    const budgetKey = attentionBudgetKey(slot.attention);
    if (nextUsedSeconds > this.#capacity.budgets[budgetKey]) {
      throw new RangeError(
        `Cannot consume slot ${slot.id} beyond ${slot.attention} capacity.`,
      );
    }

    const nextIntervals = subtractIntervals(this.#remainingIntervals, [
      { start, finish },
    ]);
    this.#remainingIntervals = nextIntervals;
    this.#usedSeconds[slot.attention] = nextUsedSeconds;
  }
}

export function createCapacityLedger(
  capacity: LocalDateCapacity,
  notBefore?: ISODate,
  initialUsedSeconds?: InitialUsedSeconds,
): CapacityLedger {
  return new CapacityLedgerImpl(capacity, notBefore, initialUsedSeconds);
}

export function placeCandidate(
  candidate: CapacityCandidate,
  ledger: CapacityLedger,
): CapacityPlacement {
  if (
    !Number.isFinite(candidate.durationSeconds) ||
    !Number.isInteger(candidate.durationSeconds) ||
    candidate.durationSeconds <= 0
  ) {
    return { ok: false, reason: "OUTSIDE_WORK_WINDOW" };
  }

  const earliestStart =
    candidate.earliestStart === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(candidate.earliestStart);
  const latestFinish =
    candidate.latestFinish === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(candidate.latestFinish);
  if (
    Number.isNaN(earliestStart) ||
    Number.isNaN(latestFinish) ||
    earliestStart > latestFinish
  ) {
    return { ok: false, reason: "OUTSIDE_WORK_WINDOW" };
  }

  const capacity = ledger.capacity;
  const usedSeconds = ledger.usedSeconds;
  const budgetKey = attentionBudgetKey(candidate.attention);
  if (
    usedSeconds[candidate.attention] + candidate.durationSeconds >
    capacity.budgets[budgetKey]
  ) {
    return { ok: false, reason: capacityReason(candidate.attention) };
  }

  const durationMilliseconds = candidate.durationSeconds * 1_000;
  let start: number | undefined;
  if (candidate.fixedStart !== undefined) {
    const fixedStart = Date.parse(candidate.fixedStart);
    if (Number.isFinite(fixedStart)) {
      const fixedFinish = fixedStart + durationMilliseconds;
      if (
        fixedStart >= earliestStart &&
        fixedFinish <= latestFinish &&
        ledger.remainingIntervals.some(
          (interval) =>
            Date.parse(interval.start) <= fixedStart &&
            Date.parse(interval.finish) >= fixedFinish,
        )
      ) {
        start = fixedStart;
      }
    }
  } else {
    for (const interval of ledger.remainingIntervals) {
      const boundedStart = Math.max(Date.parse(interval.start), earliestStart);
      const boundedFinish = Math.min(Date.parse(interval.finish), latestFinish);
      if (boundedFinish - boundedStart >= durationMilliseconds) {
        start = boundedStart;
        break;
      }
    }
  }

  if (start === undefined) {
    return { ok: false, reason: "OUTSIDE_WORK_WINDOW" };
  }

  const canonicalStart = new Date(start).toISOString();
  return {
    ok: true,
    slot: {
      id: defaultSlotId(capacity, candidate),
      target: structuredClone(candidate.target),
      targetRevision: candidate.targetRevision,
      start: canonicalStart,
      finish: new Date(start + durationMilliseconds).toISOString(),
      attention: candidate.attention,
    },
  };
}
