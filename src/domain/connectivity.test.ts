import { describe, expect, it } from "vitest";
import { applicationServerKey, reminderEnvelopes } from "./connectivity";
import { createEmptyWorkspace } from "./workspace";

describe("Web Push application server key", () => {
  it("decodes URL-safe base64 without requiring padding", () => {
    expect([...new Uint8Array(applicationServerKey("AQID-v8"))]).toEqual([1, 2, 3, 250, 255]);
  });
});

describe("reminder routes", () => {
  it("deep-links to the task and its date in the workspace time zone", () => {
    const workspace = createEmptyWorkspace();
    workspace.timeZone = "Asia/Tokyo";
    workspace.projects = [{
      id: "project-personal",
      name: "Personal",
      status: "active",
      mode: "build",
      priority: 1,
      northStar: "Remember",
      currentOutcome: "Do next",
      horizon: "2026-10-01T00:00:00.000Z",
      start: "2026-09-01T00:00:00.000Z",
      reviewCadenceDays: 7
    }];
    workspace.todos = [{
      id: "todo-remind",
      title: "Call back",
      tags: [],
      flagged: false,
      checklist: [],
      status: "open",
      inbox: false,
      capturedAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      plannedStart: "2026-09-16T15:30:00.000Z"
    }];

    expect(reminderEnvelopes(workspace, false)[0].route).toBe(
      "/#/today/project-personal/day%3A2026-09-17%3Atodo-remind"
    );
  });
});
