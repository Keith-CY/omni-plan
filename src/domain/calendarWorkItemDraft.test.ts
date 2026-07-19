import { describe, expect, it } from "vitest";
import { calendarWorkItemStartValues } from "./workItems";

describe("calendar work item creation", () => {
  it("carries the newly selected day into the work item start constraint", () => {
    const initialDay = "2026-07-19";
    const selectedDay = "2026-07-20";

    expect(calendarWorkItemStartValues(initialDay)).toEqual({
      constraintMode: "fixedStart",
      constraintDate: initialDay
    });
    expect(calendarWorkItemStartValues(selectedDay)).toEqual({
      constraintMode: "fixedStart",
      constraintDate: selectedDay
    });
  });
});
