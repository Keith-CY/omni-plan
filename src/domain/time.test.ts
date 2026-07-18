import { describe, expect, it } from "vitest";
import { zonedDateTimeToIso, zonedTimeKey } from "./time";

describe("workspace time zone conversion", () => {
  it("moves a nonexistent spring-forward wall time ahead by the DST gap", () => {
    const value = zonedDateTimeToIso("2026-03-08", "02:30", "America/New_York");

    expect(value).toBe("2026-03-08T07:30:00.000Z");
    expect(zonedTimeKey(value, "America/New_York")).toBe("03:30");
  });

  it("chooses the earlier instant for a repeated fall-back wall time", () => {
    expect(zonedDateTimeToIso("2026-11-01", "01:30", "America/New_York")).toBe("2026-11-01T05:30:00.000Z");
  });

  it("rejects impossible calendar dates and clock values", () => {
    expect(() => zonedDateTimeToIso("2026-02-30", "09:00", "UTC")).toThrow("Invalid local date or time");
    expect(() => zonedDateTimeToIso("2026-02-28", "25:00", "UTC")).toThrow("Invalid local date or time");
  });
});
