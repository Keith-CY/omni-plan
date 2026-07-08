import { describe, expect, it } from "vitest";
import { generateRecurringOccurrences, repeatCadenceLabel, repeatStartModeLabel } from "./recurring";
import type { WorkItem } from "./types";

describe("recurring work items", () => {
  it("projects fixed weekly occurrences from the anchored start time", () => {
    const item = workItem({
      repeatRule: {
        cadence: "weekly",
        count: 3,
        startMode: "fixed-time",
        startAt: "2026-07-06T09:30:00.000Z"
      }
    });

    const occurrences = generateRecurringOccurrences(item, "2026-07-01T00:00:00.000Z", 8);

    expect(occurrences.map((occurrence) => occurrence.start)).toEqual([
      "2026-07-06T09:30:00.000Z",
      "2026-07-13T09:30:00.000Z",
      "2026-07-20T09:30:00.000Z"
    ]);
    expect(repeatCadenceLabel(item.repeatRule)).toBe("weekly");
    expect(repeatStartModeLabel(item.repeatRule)).toBe("fixed time");
  });

  it("starts the next rolling occurrence when the previous one finishes", () => {
    const item = workItem({
      durationSeconds: 2 * 24 * 60 * 60,
      repeatRule: {
        cadence: "every-n-days",
        everyDays: 7,
        count: 3,
        startMode: "after-previous-finish",
        startAt: "2026-07-06T08:00:00.000Z"
      }
    });

    const occurrences = generateRecurringOccurrences(item, "2026-07-01T00:00:00.000Z", 8);

    expect(occurrences.map((occurrence) => [occurrence.start, occurrence.finish])).toEqual([
      ["2026-07-06T08:00:00.000Z", "2026-07-08T08:00:00.000Z"],
      ["2026-07-08T08:00:00.000Z", "2026-07-10T08:00:00.000Z"],
      ["2026-07-10T08:00:00.000Z", "2026-07-12T08:00:00.000Z"]
    ]);
    expect(repeatCadenceLabel(item.repeatRule)).toBe("every 7d");
    expect(repeatStartModeLabel(item.repeatRule)).toBe("after previous finish");
  });

  it("keeps monthly fixed occurrences on the closest valid day", () => {
    const item = workItem({
      repeatRule: {
        cadence: "monthly",
        count: 2,
        startMode: "fixed-time",
        startAt: "2026-01-31T10:00:00.000Z"
      }
    });

    const occurrences = generateRecurringOccurrences(item, "2026-01-01T00:00:00.000Z", 8);

    expect(occurrences.map((occurrence) => occurrence.start)).toEqual([
      "2026-01-31T10:00:00.000Z",
      "2026-02-28T10:00:00.000Z"
    ]);
  });
});

function workItem(patch: Partial<WorkItem>): WorkItem {
  return {
    id: "w-repeat",
    projectId: "p-repeat",
    kind: "task",
    title: "Recurring task",
    outline: "1",
    durationSeconds: 24 * 60 * 60,
    estimate: { mostLikelySeconds: 24 * 60 * 60 },
    assignmentIds: [],
    percentComplete: 0,
    ...patch
  };
}
