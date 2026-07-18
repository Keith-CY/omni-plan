import { describe, expect, it } from "vitest";
import {
  applyAutomaticOccurrenceAction,
  applyAutomaticRuleEditBoundary,
  changeRecurringWorkspaceTimeZone,
  generateRecurringOccurrences,
  isAutomaticRecurringWorkItem,
  projectRecurringOccurrences,
  reconcileAutomaticOccurrences,
  selectAutomaticReminderOccurrences,
  repeatCadenceLabel,
  repeatStartModeLabel
} from "./recurring";
import type { WorkItem, WorkspaceSnapshot } from "./types";

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

  it("starts the next rolling occurrence from the previous finish plus cadence", () => {
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
      ["2026-07-15T08:00:00.000Z", "2026-07-17T08:00:00.000Z"],
      ["2026-07-24T08:00:00.000Z", "2026-07-26T08:00:00.000Z"]
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

  it("projects an infinite automatic rule only inside the requested window", () => {
    const item = workItem({
      repeatRule: automaticRule({ cadence: "monthly", startAt: "2026-01-31T10:00:00.000Z", endMode: "never" })
    });

    const occurrences = projectRecurringOccurrences(item, "2026-01-01T00:00:00.000Z", {
      timeZone: "UTC",
      now: "2026-03-01T00:00:00.000Z",
      windowStart: "2026-02-01T00:00:00.000Z",
      windowEnd: "2026-04-01T00:00:00.000Z"
    });

    expect(occurrences.map((occurrence) => occurrence.start)).toEqual([
      "2026-02-28T10:00:00.000Z",
      "2026-03-31T10:00:00.000Z"
    ]);
    expect(occurrences.every((occurrence) => occurrence.executionMode === "automatic")).toBe(true);
  });

  it("preserves automatic wall-clock time across daylight-saving changes", () => {
    const item = workItem({
      repeatRule: automaticRule({ cadence: "weekly", startAt: "2026-03-01T14:00:00.000Z", endMode: "count", count: 3 })
    });

    const occurrences = projectRecurringOccurrences(item, "2026-03-01T00:00:00.000Z", {
      timeZone: "America/New_York",
      now: "2026-03-01T00:00:00.000Z",
      limit: 3
    });

    expect(occurrences.map((occurrence) => occurrence.start)).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-15T13:00:00.000Z"
    ]);
  });

  it("settles zero-duration automatic occurrences once and keeps their snapshots", () => {
    const item = workItem({
      title: "Automatic transfer",
      description: "Transfer the monthly reserve.",
      repeatRule: automaticRule({ cadence: "weekly", startAt: "2026-07-01T09:00:00.000Z", endMode: "count", count: 2 })
    });
    const workspace = recurringWorkspace(item);

    const first = reconcileAutomaticOccurrences(workspace, "2026-07-08T09:00:00.000Z");
    const second = reconcileAutomaticOccurrences(first.workspace, "2026-07-08T09:00:00.000Z");

    expect(first.settledIds).toHaveLength(2);
    expect(second.settledIds).toEqual([]);
    expect(second.workspace.recurringOccurrences).toHaveLength(2);
    expect(second.workspace.recurringOccurrences[0].title).toBe("Automatic transfer");
    expect(second.workspace.recurringOccurrences[0].description).toBe("Transfer the monthly reserve.");
    expect(second.workspace.recurringOccurrences.some((record) => record.settlementSource === "system-catch-up")).toBe(true);
  });

  it("waits for the display duration to finish before settling", () => {
    const item = workItem({
      repeatRule: automaticRule({
        startAt: "2026-07-18T09:00:00.000Z",
        endMode: "count",
        count: 1,
        automaticDurationSeconds: 2 * 3600
      })
    });
    const workspace = recurringWorkspace(item);

    expect(reconcileAutomaticOccurrences(workspace, "2026-07-18T10:59:59.000Z").settledIds).toEqual([]);
    expect(reconcileAutomaticOccurrences(workspace, "2026-07-18T11:00:00.000Z").settledIds).toHaveLength(1);
  });

  it("makes schedule edits future-only without backfilling duplicate history", () => {
    const item = workItem({
      repeatRule: automaticRule({
        cadence: "every-n-days",
        everyDays: 1,
        startAt: "2026-07-01T09:00:00.000Z",
        endMode: "never"
      })
    });
    const settled = reconcileAutomaticOccurrences(recurringWorkspace(item), "2026-07-02T09:00:00.000Z").workspace;
    const changedAt = "2026-07-02T09:30:00.000Z";
    const editedRule = applyAutomaticRuleEditBoundary(item.repeatRule, {
      ...item.repeatRule!,
      startAt: "2026-07-01T10:00:00.000Z"
    }, changedAt);
    const edited = {
      ...settled,
      workItems: settled.workItems.map((candidate) => candidate.id === item.id ? { ...candidate, repeatRule: editedRule } : candidate)
    };
    const reconciled = reconcileAutomaticOccurrences(edited, "2026-07-02T09:59:59.000Z").workspace;

    expect(editedRule.automaticFrom).toBe(changedAt);
    expect(reconciled.recurringOccurrences.map((record) => record.id)).toEqual(settled.recurringOccurrences.map((record) => record.id));
    expect(reconciled.recurringOccurrences).toHaveLength(2);
  });

  it("counts automatic occurrences from the future-only effective boundary", () => {
    const item = workItem({
      repeatRule: automaticRule({
        cadence: "every-n-days",
        everyDays: 1,
        startAt: "2026-01-01T09:00:00.000Z",
        automaticFrom: "2026-07-01T00:00:00.000Z",
        endMode: "count",
        count: 5
      })
    });

    const projected = projectRecurringOccurrences(item, "2026-01-01T00:00:00.000Z", {
      timeZone: "UTC",
      now: "2026-07-01T00:00:00.000Z",
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: "2026-07-10T00:00:00.000Z"
    });

    expect(projected.map((occurrence) => occurrence.start)).toEqual([
      "2026-07-01T09:00:00.000Z",
      "2026-07-02T09:00:00.000Z",
      "2026-07-03T09:00:00.000Z",
      "2026-07-04T09:00:00.000Z",
      "2026-07-05T09:00:00.000Z"
    ]);
  });

  it("changes workspace time zone at a future-only wall-clock boundary", () => {
    const item = workItem({
      repeatRule: automaticRule({
        cadence: "weekly",
        startAt: "2026-03-01T14:00:00.000Z",
        endMode: "never"
      })
    });
    const workspace = { ...recurringWorkspace(item), timeZone: "America/New_York" };
    const settled = reconcileAutomaticOccurrences(workspace, "2026-03-08T13:00:00.000Z").workspace;
    const changed = changeRecurringWorkspaceTimeZone(settled, "UTC", "2026-03-08T13:30:00.000Z");
    const reconciled = reconcileAutomaticOccurrences(changed, "2026-03-08T14:00:00.000Z").workspace;

    expect(changed.workItems[0].repeatRule?.startAt).toBe("2026-03-01T09:00:00.000Z");
    expect(changed.workItems[0].repeatRule?.automaticFrom).toBe("2026-03-08T13:30:00.000Z");
    expect(reconciled.recurringOccurrences.map((record) => record.id)).toEqual(settled.recurringOccurrences.map((record) => record.id));
  });

  it("changes or skips one future occurrence without shifting the series", () => {
    const item = workItem({
      repeatRule: automaticRule({ cadence: "weekly", startAt: "2026-07-20T09:00:00.000Z", endMode: "count", count: 3 })
    });
    const workspace = recurringWorkspace(item);
    const projected = projectRecurringOccurrences(item, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      limit: 3
    });

    const skipped = applyAutomaticOccurrenceAction(workspace, {
      type: "skip",
      occurrence: projected[0],
      actedAt: "2026-07-18T00:00:00.000Z"
    }).workspace;
    const rescheduled = applyAutomaticOccurrenceAction(skipped, {
      type: "reschedule",
      occurrence: projected[1],
      start: "2026-07-28T10:00:00.000Z",
      finish: "2026-07-28T10:00:00.000Z",
      actedAt: "2026-07-18T00:00:00.000Z"
    }).workspace;
    const merged = projectRecurringOccurrences(item, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      limit: 3,
      records: rescheduled.recurringOccurrences
    });

    expect(merged.map((occurrence) => occurrence.status)).toEqual(["skipped", "scheduled", "scheduled"]);
    expect(merged.map((occurrence) => occurrence.start)).toEqual([
      "2026-07-20T09:00:00.000Z",
      "2026-07-28T10:00:00.000Z",
      "2026-08-03T09:00:00.000Z"
    ]);
  });

  it("rejects a stale skip after another edit has already settled the occurrence", () => {
    const item = workItem({
      repeatRule: automaticRule({ startAt: "2026-07-20T09:00:00.000Z", endMode: "count", count: 1 })
    });
    const workspace = recurringWorkspace(item);
    const staleOccurrence = projectRecurringOccurrences(item, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-17T00:00:00.000Z",
      limit: 1
    })[0];
    const rescheduled = applyAutomaticOccurrenceAction(workspace, {
      type: "reschedule",
      occurrence: staleOccurrence,
      start: "2026-07-18T09:00:00.000Z",
      finish: "2026-07-18T09:00:00.000Z",
      actedAt: "2026-07-17T00:00:00.000Z"
    }).workspace;

    expect(() => applyAutomaticOccurrenceAction(rescheduled, {
      type: "skip",
      occurrence: staleOccurrence,
      actedAt: "2026-07-19T00:00:00.000Z"
    })).toThrow("currently scheduled future occurrence");
    expect(reconcileAutomaticOccurrences(rescheduled, "2026-07-19T00:00:00.000Z").workspace.recurringOccurrences[0].status).toBe("occurred");
  });

  it("does not overlay stored automatic future records after switching back to manual", () => {
    const automaticItem = workItem({
      repeatRule: automaticRule({ startAt: "2026-07-20T09:00:00.000Z", endMode: "count", count: 2 })
    });
    const workspace = recurringWorkspace(automaticItem);
    const occurrence = projectRecurringOccurrences(automaticItem, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      limit: 1
    })[0];
    const rescheduled = applyAutomaticOccurrenceAction(workspace, {
      type: "reschedule",
      occurrence,
      start: "2026-07-21T09:00:00.000Z",
      finish: "2026-07-21T09:00:00.000Z",
      actedAt: "2026-07-18T00:00:00.000Z"
    }).workspace;
    const manualItem = {
      ...automaticItem,
      repeatRule: { ...automaticItem.repeatRule!, executionMode: "manual" as const, automaticFrom: undefined }
    };
    const projected = projectRecurringOccurrences(manualItem, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      records: rescheduled.recurringOccurrences,
      limit: 4
    });

    expect(projected.every((candidate) => candidate.executionMode === "manual")).toBe(true);
    expect(projected.some((candidate) => candidate.start === "2026-07-21T09:00:00.000Z")).toBe(false);
  });

  it("reports one exception and creates one linked ordinary task", () => {
    const item = workItem({
      title: "Automatic transfer",
      description: "Transfer reserve",
      repeatRule: automaticRule({ startAt: "2026-07-17T09:00:00.000Z", endMode: "count", count: 1 })
    });
    const settled = reconcileAutomaticOccurrences(recurringWorkspace(item), "2026-07-18T00:00:00.000Z").workspace;
    const occurrence = projectRecurringOccurrences(item, settled.projects[0].start, {
      timeZone: settled.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      records: settled.recurringOccurrences,
      limit: 1
    })[0];

    expect(() => applyAutomaticOccurrenceAction(settled, {
      type: "report-exception",
      occurrence,
      note: "  ",
      actedAt: "2026-07-18T00:00:00.000Z"
    })).toThrow("required");

    const first = applyAutomaticOccurrenceAction(settled, {
      type: "report-exception",
      occurrence,
      note: "Bank rejected the transfer.",
      actedAt: "2026-07-18T00:00:00.000Z"
    });
    const second = applyAutomaticOccurrenceAction(first.workspace, {
      type: "report-exception",
      occurrence,
      note: "Bank rejected the transfer.",
      actedAt: "2026-07-18T00:00:00.000Z"
    });

    expect(second.workspace.recurringOccurrences.find((record) => record.id === occurrence.id)?.status).toBe("exception");
    expect(second.workspace.workItems.filter((candidate) => candidate.title === "Handle exception: Automatic transfer")).toHaveLength(1);
    expect(second.followUpWorkItemId).toBe(first.followUpWorkItemId);
    expect(second.workspace.recurringOccurrences.find((record) => record.id === occurrence.id)?.description).toBe("Transfer reserve");
  });

  it("does not turn a skipped occurrence into an exception", () => {
    const item = workItem({
      repeatRule: automaticRule({ startAt: "2026-07-20T09:00:00.000Z", endMode: "count", count: 1 })
    });
    const workspace = recurringWorkspace(item);
    const occurrence = projectRecurringOccurrences(item, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      limit: 1
    })[0];
    const skipped = applyAutomaticOccurrenceAction(workspace, {
      type: "skip",
      occurrence,
      actedAt: "2026-07-18T00:00:00.000Z"
    }).workspace;

    expect(() => applyAutomaticOccurrenceAction(skipped, {
      type: "report-exception",
      occurrence,
      note: "Should stay skipped.",
      actedAt: "2026-07-21T00:00:00.000Z"
    })).toThrow("Only an occurred instance");
    expect(skipped.workItems.some((candidate) => candidate.title.startsWith("Handle exception:"))).toBe(false);
  });

  it("stops projected future overrides while retaining their stored audit record", () => {
    const item = workItem({
      repeatRule: automaticRule({ startAt: "2026-07-20T09:00:00.000Z", endMode: "never" })
    });
    const workspace = recurringWorkspace(item);
    const occurrence = projectRecurringOccurrences(item, workspace.projects[0].start, {
      timeZone: workspace.timeZone,
      now: "2026-07-18T00:00:00.000Z",
      limit: 1
    })[0];
    const rescheduled = applyAutomaticOccurrenceAction(workspace, {
      type: "reschedule",
      occurrence,
      start: "2026-07-21T09:00:00.000Z",
      finish: "2026-07-21T09:00:00.000Z",
      actedAt: "2026-07-18T00:00:00.000Z"
    }).workspace;
    const stopped = applyAutomaticOccurrenceAction(rescheduled, {
      type: "stop-rule",
      workItemId: item.id,
      actedAt: "2026-07-19T00:00:00.000Z"
    }).workspace;
    const projected = projectRecurringOccurrences(stopped.workItems[0], stopped.projects[0].start, {
      timeZone: stopped.timeZone,
      now: "2026-07-19T00:00:00.000Z",
      windowStart: "2026-07-20T00:00:00.000Z",
      windowEnd: "2026-07-22T00:00:00.000Z",
      records: stopped.recurringOccurrences
    });

    expect(projected).toEqual([]);
    expect(stopped.recurringOccurrences).toHaveLength(1);
  });

  it("selects reminders only inside the configured lead window", () => {
    const item = workItem({
      repeatRule: automaticRule({
        startAt: "2026-07-20T09:00:00.000Z",
        endMode: "count",
        count: 1,
        reminderLeadSeconds: 24 * 3600
      })
    });
    const workspace = recurringWorkspace(item);

    expect(selectAutomaticReminderOccurrences(workspace, "2026-07-19T08:59:59.000Z")).toEqual([]);
    expect(selectAutomaticReminderOccurrences(workspace, "2026-07-19T09:00:00.000Z")).toHaveLength(1);
    expect(selectAutomaticReminderOccurrences(workspace, "2026-07-20T09:00:00.000Z")).toEqual([]);
  });

  it("recognizes only explicit automatic recurring work", () => {
    expect(isAutomaticRecurringWorkItem(workItem({ repeatRule: { count: 2 } }))).toBe(false);
    expect(isAutomaticRecurringWorkItem(workItem({ repeatRule: automaticRule() }))).toBe(true);
  });
});

function automaticRule(patch: Partial<NonNullable<WorkItem["repeatRule"]>> = {}): NonNullable<WorkItem["repeatRule"]> {
  return {
    id: "repeat-w-repeat",
    cadence: "every-n-days",
    everyDays: 7,
    count: 6,
    startMode: "fixed-time",
    startAt: "2026-07-20T09:00:00.000Z",
    executionMode: "automatic",
    endMode: "never",
    automaticDurationSeconds: 0,
    automaticFrom: "2026-01-01T00:00:00.000Z",
    ...patch
  };
}

function recurringWorkspace(item: WorkItem): WorkspaceSnapshot {
  return {
    timeZone: "UTC",
    projects: [{
      id: item.projectId,
      name: "Recurring project",
      status: "active",
      mode: "maintain",
      priority: 3,
      northStar: "Keep automation visible",
      currentOutcome: "Automatic work is traceable",
      horizon: "2026-12-31T00:00:00.000Z",
      start: "2026-01-01T00:00:00.000Z",
      reviewCadenceDays: 7
    }],
    workItems: [item],
    recurringOccurrences: [],
    dependencies: [],
    resources: [],
    capacities: [],
    baselines: [],
    actuals: [],
    evidence: [],
    decisions: [],
    changeSets: [],
    auditGates: [],
    auditDecisions: []
  };
}

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
