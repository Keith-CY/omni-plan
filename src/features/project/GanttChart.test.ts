import { describe, expect, it } from "vitest";
import { calendarDayOffset, shortDateTime } from "./GanttChart";

describe("Gantt workspace-time-zone labels", () => {
  it("places an instant on the local calendar day instead of its UTC date", () => {
    const instant = "2026-09-15T20:27:00.000Z";

    expect(shortDateTime(instant, "Asia/Tokyo")).toBe("09-16 05:27");
    expect(calendarDayOffset("2026-09-16", instant, "Asia/Tokyo")).toBeCloseTo(327 / 1_440);
  });
});
