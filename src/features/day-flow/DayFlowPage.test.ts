import { describe, expect, it } from "vitest";
import type { TaskView } from "../../domain/tasks";
import { formatTaskTime, formatTimelineLabel, timelineBarStyle } from "./DayFlowPage";

const baseTask: TaskView = {
  id: "task-1",
  source: "todo",
  title: "Plan the day",
  effortSeconds: 0,
  status: "open",
  tags: [],
  fixedTime: true,
  isCritical: false,
  blocked: false,
  predecessors: [],
  successors: []
};

describe("Today timeline presentation", () => {
  it("renders a zero-duration item as a point instead of an all-day bar", () => {
    const task = {
      ...baseTask,
      plannedStart: "2026-09-15T20:27:00.000Z",
      plannedFinish: "2026-09-15T20:27:00.000Z"
    };

    expect(formatTaskTime(task, "Asia/Tokyo", "2026-09-16")).toBe("05:27");
    expect(timelineBarStyle(task, "2026-09-16", "Asia/Tokyo")).toEqual({
      left: "0%",
      width: "1.8%"
    });
  });

  it("labels a task that continues into the next day", () => {
    const task = {
      ...baseTask,
      plannedStart: "2026-09-15T20:27:00.000Z",
      plannedFinish: "2026-09-16T20:27:00.000Z"
    };

    expect(formatTaskTime(task, "Asia/Tokyo", "2026-09-16")).toBe("05:27–次日 05:27");
    expect(timelineBarStyle(task, "2026-09-16", "Asia/Tokyo")).toEqual({
      left: "0%",
      width: "100%"
    });
  });

  it("describes the visible end of a task carried over from yesterday", () => {
    const task = {
      ...baseTask,
      plannedStart: "2026-09-14T23:00:00.000Z",
      plannedFinish: "2026-09-15T21:00:00.000Z"
    };

    expect(formatTaskTime(task, "Asia/Tokyo", "2026-09-16")).toBe("延续至 06:00");
  });

  it("uses a compact start-time label when a short timeline bar cannot fit the full range", () => {
    const task = {
      ...baseTask,
      plannedStart: "2026-09-18T05:00:00.000Z",
      plannedFinish: "2026-09-18T06:00:00.000Z"
    };

    expect(formatTaskTime(task, "Asia/Tokyo", "2026-09-18")).toBe("14:00–15:00");
    expect(formatTimelineLabel(task, "Asia/Tokyo", "2026-09-18")).toBe("14:00");
  });
});
