import { useState, type RefObject } from "react";

import type { CapacityProfile, Weekday } from "../../domain/types";
import {
  instantAtLocalMinute,
  validateCapacityProfile,
  type CapacityProfileValidation,
} from "../../domain/localTime";
import { V2_UI_ACTOR_ID } from "../state/V2WorkspaceProvider";
import { TopActionCard } from "../components/TopActionCard";
import {
  UnavailableBlocksField,
  type UnavailableBlockDraft,
} from "./UnavailableBlocksField";

interface DayDraft {
  weekday: Weekday;
  label: string;
  enabled: boolean;
  start: string;
  finish: string;
  deepHours: string;
  mediumHours: string;
  shallowHours: string;
}

const WEEKDAYS: Array<{ weekday: Weekday; label: string }> = [
  { weekday: 0, label: "Sunday" },
  { weekday: 1, label: "Monday" },
  { weekday: 2, label: "Tuesday" },
  { weekday: 3, label: "Wednesday" },
  { weekday: 4, label: "Thursday" },
  { weekday: 5, label: "Friday" },
  { weekday: 6, label: "Saturday" },
];

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function defaultDays(): DayDraft[] {
  return WEEKDAYS.map(({ weekday, label }) => ({
    weekday,
    label,
    enabled: weekday >= 1 && weekday <= 5,
    start: "09:00",
    finish: "17:00",
    deepHours: "4",
    mediumHours: "2",
    shallowHours: "1",
  }));
}

function minuteFromTime(value: string, allowEndOfDay = false): number {
  if (allowEndOfDay && value === "24:00") return 1_440;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function secondsFromHours(value: string): number {
  if (value.trim() === "") return Number.NaN;
  return Number(value) * 3_600;
}

function localInputToInstant(
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

function instantToLocalInput(value: string, timeZone: string): string {
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

function daysFromProfile(profile: CapacityProfile): DayDraft[] {
  return defaultDays().map((day) => {
    const window = profile.weeklyWindows.find(
      ({ weekday }) => weekday === day.weekday,
    );
    const budget = profile.dailyBudgets.find(
      ({ weekday }) => weekday === day.weekday,
    );
    return {
      ...day,
      enabled: window !== undefined,
      start:
        window === undefined
          ? day.start
          : `${String(Math.floor(window.startMinute / 60)).padStart(2, "0")}:${String(window.startMinute % 60).padStart(2, "0")}`,
      finish:
        window === undefined
          ? day.finish
          : `${String(Math.floor(window.finishMinute / 60)).padStart(2, "0")}:${String(window.finishMinute % 60).padStart(2, "0")}`,
      deepHours: String((budget?.deepSeconds ?? 0) / 3_600),
      mediumHours: String((budget?.mediumSeconds ?? 0) / 3_600),
      shallowHours: String((budget?.shallowSeconds ?? 0) / 3_600),
    };
  });
}

export interface CapacityEditorProps {
  calibrationSuggestion?: CapacityProfile;
  pending: boolean;
  saveButtonRef?: RefObject<HTMLButtonElement>;
  onSave(profile: CapacityProfile): Promise<void> | void;
}

export function CapacityEditor({
  calibrationSuggestion,
  pending,
  saveButtonRef,
  onSave,
}: CapacityEditorProps) {
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [days, setDays] = useState(defaultDays);
  const [unavailableBlocks, setUnavailableBlocks] = useState<
    UnavailableBlockDraft[]
  >([]);
  const [validation, setValidation] = useState<
    Extract<CapacityProfileValidation, { ok: false }> | undefined
  >();

  const updateDay = (
    weekday: Weekday,
    patch: Partial<Omit<DayDraft, "weekday" | "label">>,
  ) => {
    setDays((current) =>
      current.map((day) =>
        day.weekday === weekday ? { ...day, ...patch } : day,
      ),
    );
  };

  const applySuggestion = () => {
    if (calibrationSuggestion === undefined) return;
    setTimeZone(calibrationSuggestion.timeZone);
    setDays(daysFromProfile(calibrationSuggestion));
    setUnavailableBlocks(
      calibrationSuggestion.unavailableBlocks.map((block) => ({
        id: block.id,
        start: instantToLocalInput(block.start, calibrationSuggestion.timeZone),
        finish: instantToLocalInput(
          block.finish,
          calibrationSuggestion.timeZone,
        ),
      })),
    );
    setValidation(undefined);
  };

  const submit = async () => {
    const enabledDays = days.filter(({ enabled }) => enabled);
    const profile: CapacityProfile = {
      timeZone,
      weeklyWindows: enabledDays.map((day) => ({
        weekday: day.weekday,
        startMinute: minuteFromTime(day.start),
        finishMinute: minuteFromTime(day.finish, true),
      })),
      dailyBudgets: enabledDays.map((day) => ({
        weekday: day.weekday,
        deepSeconds: secondsFromHours(day.deepHours),
        mediumSeconds: secondsFromHours(day.mediumHours),
        shallowSeconds: secondsFromHours(day.shallowHours),
      })),
      unavailableBlocks: unavailableBlocks.map((block) => ({
        id: block.id,
        start: localInputToInstant(block.start, timeZone) ?? "",
        finish: localInputToInstant(block.finish, timeZone) ?? "",
      })),
      updatedAt: new Date().toISOString(),
      updatedBy: V2_UI_ACTOR_ID,
    };
    const nextValidation = validateCapacityProfile(profile);
    if (!nextValidation.ok) {
      setValidation(nextValidation);
      return;
    }
    setValidation(undefined);
    await onSave(profile);
  };

  return (
    <form
      className="v2-capacity-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {calibrationSuggestion === undefined ? null : (
        <TopActionCard
          eyebrow="Optional calibration"
          title="Suggested from your recent actuals"
          description="Use this as an editable draft. Nothing is saved until you review it and choose Save capacity."
          action={
            <button type="button" onClick={applySuggestion}>
              Use suggestion
            </button>
          }
        />
      )}

      <fieldset className="v2-capacity-section">
        <legend>Planning time zone</legend>
        <p>Dates, weekly windows, and review boundaries use this time zone.</p>
        <label className="v2-field v2-field--wide">
          <span>Time zone</span>
          <input
            type="text"
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
            placeholder="Asia/Tokyo"
            autoComplete="off"
          />
        </label>
      </fieldset>

      <fieldset className="v2-capacity-section">
        <legend>Weekly capacity</legend>
        <p>
          Set one realistic work envelope per day. Use unavailable time below
          for fixed breaks and appointments.
        </p>
        <div className="v2-capacity-days">
          {days.map((day) => (
            <fieldset
              className="v2-capacity-day"
              key={day.weekday}
              aria-label={`${day.label} capacity`}
            >
              <legend>{day.label}</legend>
              <label className="v2-check-field">
                <input
                  type="checkbox"
                  checked={day.enabled}
                  onChange={(event) =>
                    updateDay(day.weekday, { enabled: event.target.checked })
                  }
                />
                <span>Workday</span>
              </label>
              <div className="v2-capacity-day__fields">
                <label className="v2-field">
                  <span>Start</span>
                  <input
                    type="time"
                    value={day.start}
                    disabled={!day.enabled}
                    onChange={(event) =>
                      updateDay(day.weekday, { start: event.target.value })
                    }
                  />
                </label>
                <label className="v2-field">
                  <span>Finish</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00"
                    placeholder="17:00 or 24:00"
                    aria-label="Finish"
                    aria-describedby={`finish-help-${day.weekday}`}
                    value={day.finish}
                    disabled={!day.enabled}
                    onChange={(event) =>
                      updateDay(day.weekday, { finish: event.target.value })
                    }
                  />
                  <small id={`finish-help-${day.weekday}`}>
                    Use 24:00 for the end of day.
                  </small>
                </label>
                {([
                  ["Deep hours", "deepHours"],
                  ["Medium hours", "mediumHours"],
                  ["Shallow hours", "shallowHours"],
                ] as const).map(([label, field]) => (
                  <label className="v2-field" key={field}>
                    <span>{label}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.25"
                      required
                      value={day[field]}
                      disabled={!day.enabled}
                      onChange={(event) =>
                        updateDay(day.weekday, { [field]: event.target.value })
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      </fieldset>

      <UnavailableBlocksField
        blocks={unavailableBlocks}
        onChange={setUnavailableBlocks}
      />

      {validation === undefined ? null : (
        <div className="v2-inline-validation" role="alert">
          <strong>Review this capacity draft</strong>
          <p>{validation.reason}</p>
          <code>{validation.gate}</code>
        </div>
      )}

      <div className="v2-form-actions">
        <p>
          Saving is an explicit planning decision. OmniPlan will use these
          limits for future commitments.
        </p>
        <button ref={saveButtonRef} type="submit" disabled={pending}>
          {pending ? "Saving capacity…" : "Save capacity"}
        </button>
      </div>
    </form>
  );
}
