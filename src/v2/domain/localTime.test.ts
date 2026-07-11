import { describe, expect, it } from "vitest";

import type { CapacityCandidate } from "./localTime";
import type { CapacityProfile } from "./types";
import {
  capacityForLocalDate,
  createCapacityLedger,
  localDateAt,
  placeCandidate,
  validateCapacityProfile,
} from "./localTime";

const TOKYO_PROFILE: CapacityProfile = {
  timeZone: "Asia/Tokyo",
  weeklyWindows: [{ weekday: 1, startMinute: 540, finishMinute: 1_020 }],
  dailyBudgets: [
    {
      weekday: 1,
      deepSeconds: 7_200,
      mediumSeconds: 3_600,
      shallowSeconds: 1_800,
    },
  ],
  unavailableBlocks: [
    {
      id: "lunch",
      start: "2026-07-13T03:00:00.000Z",
      finish: "2026-07-13T03:30:00.000Z",
    },
  ],
  updatedAt: "2026-07-11T09:00:00.000Z",
  updatedBy: "human-1",
};

describe("localDateAt", () => {
  it("derives the calendar date in the explicit timezone", () => {
    expect(localDateAt("2026-07-12T15:30:00.000Z", "Asia/Tokyo")).toBe(
      "2026-07-13",
    );
    expect(
      localDateAt("2026-07-12T15:30:00.000Z", "America/New_York"),
    ).toBe("2026-07-12");
  });

  it("returns undefined for an invalid instant or timezone", () => {
    expect(localDateAt("not-an-instant", "Asia/Tokyo")).toBeUndefined();
    expect(
      localDateAt("2026-07-12T15:30:00.000Z", "Mars/Olympus_Mons"),
    ).toBeUndefined();
  });
});

describe("capacityForLocalDate", () => {
  it.each([
    {
      name: "weekly window",
      profile: {
        ...structuredClone(TOKYO_PROFILE),
        weeklyWindows: [
          { weekday: 7, startMinute: 540, finishMinute: 1_020 },
        ],
      } as unknown as CapacityProfile,
      gate: "capacity_profile:weekly_window:0:weekday",
    },
    {
      name: "daily budget",
      profile: {
        ...structuredClone(TOKYO_PROFILE),
        dailyBudgets: [
          {
            weekday: 7,
            deepSeconds: 7_200,
            mediumSeconds: 3_600,
            shallowSeconds: 1_800,
          },
        ],
      } as unknown as CapacityProfile,
      gate: "capacity_profile:daily_budget:0:weekday",
    },
  ])("rejects an out-of-range weekday in a $name", ({ profile, gate }) => {
    expect(validateCapacityProfile(profile)).toMatchObject({
      ok: false,
      gate,
    });
  });

  it("expands Tokyo wall-clock windows and subtracts unavailable intervals", () => {
    const capacity = capacityForLocalDate(TOKYO_PROFILE, "2026-07-13");

    expect(capacity).toEqual({
      localDate: "2026-07-13",
      timeZone: "Asia/Tokyo",
      weekday: 1,
      availableIntervals: [
        {
          start: "2026-07-13T00:00:00.000Z",
          finish: "2026-07-13T03:00:00.000Z",
        },
        {
          start: "2026-07-13T03:30:00.000Z",
          finish: "2026-07-13T08:00:00.000Z",
        },
      ],
      budgets: {
        deepSeconds: 7_200,
        mediumSeconds: 3_600,
        shallowSeconds: 1_800,
      },
    });
  });

  it("uses 23 absolute hours across the New York spring-forward day", () => {
    const profile: CapacityProfile = {
      ...TOKYO_PROFILE,
      timeZone: "America/New_York",
      weeklyWindows: [
        { weekday: 0, startMinute: 0, finishMinute: 1_440 },
      ],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 100_000,
          mediumSeconds: 100_000,
          shallowSeconds: 100_000,
        },
      ],
      unavailableBlocks: [],
    };

    expect(capacityForLocalDate(profile, "2026-03-08").availableIntervals).toEqual(
      [
        {
          start: "2026-03-08T05:00:00.000Z",
          finish: "2026-03-09T04:00:00.000Z",
        },
      ],
    );
  });

  it("uses 25 absolute hours across the New York fall-back day", () => {
    const profile: CapacityProfile = {
      ...TOKYO_PROFILE,
      timeZone: "America/New_York",
      weeklyWindows: [
        { weekday: 0, startMinute: 0, finishMinute: 1_440 },
      ],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 100_000,
          mediumSeconds: 100_000,
          shallowSeconds: 100_000,
        },
      ],
      unavailableBlocks: [],
    };

    expect(capacityForLocalDate(profile, "2026-11-01").availableIntervals).toEqual(
      [
        {
          start: "2026-11-01T04:00:00.000Z",
          finish: "2026-11-02T05:00:00.000Z",
        },
      ],
    );
  });

  it("fails closed when a persisted profile violates semantic validation", () => {
    const invalidProfile: CapacityProfile = {
      ...structuredClone(TOKYO_PROFILE),
      unavailableBlocks: [
        {
          id: "invalid-block",
          start: "not-an-instant",
          finish: "2026-07-13T03:30:00.000Z",
        },
      ],
    };

    expect(() =>
      capacityForLocalDate(invalidProfile, "2026-07-13"),
    ).toThrowError(RangeError);
  });

  it("uses the validated canonical timezone in derived capacity", () => {
    const aliasProfile: CapacityProfile = {
      ...structuredClone(TOKYO_PROFILE),
      timeZone: "Japan",
    };

    expect(capacityForLocalDate(aliasProfile, "2026-07-13").timeZone).toBe(
      "Asia/Tokyo",
    );
  });
});

describe("capacity ledger", () => {
  const profile: CapacityProfile = {
    ...TOKYO_PROFILE,
    weeklyWindows: [{ weekday: 1, startMinute: 540, finishMinute: 660 }],
    dailyBudgets: [
      {
        weekday: 1,
        deepSeconds: 4_500,
        mediumSeconds: 7_200,
        shallowSeconds: 0,
      },
    ],
    unavailableBlocks: [
      {
        id: "break",
        start: "2026-07-13T01:00:00.000Z",
        finish: "2026-07-13T01:30:00.000Z",
      },
    ],
  };

  it("places deterministically, then enforces per-attention budgets", () => {
    const capacity = capacityForLocalDate(profile, "2026-07-13");
    const ledger = createCapacityLedger(capacity);
    const first = placeCandidate(
      {
        targetId: "work-1",
        targetRevision: 2,
        target: {
          kind: "work_item",
          workItemId: "work-1",
          projectId: "project-1",
        },
        durationSeconds: 2_700,
        attention: "deep",
      },
      ledger,
    );

    expect(first).toEqual({
      ok: true,
      slot: {
        id: "today-slot:2026-07-13:work_item:work-1:2",
        target: {
          kind: "work_item",
          workItemId: "work-1",
          projectId: "project-1",
        },
        targetRevision: 2,
        start: "2026-07-13T00:00:00.000Z",
        finish: "2026-07-13T00:45:00.000Z",
        attention: "deep",
      },
    });
    if (!first.ok) throw new Error("Expected placement");
    ledger.consume(first.slot);

    const overflow = placeCandidate(
      {
        targetId: "work-2",
        targetRevision: 1,
        target: { kind: "action", actionId: "work-2" },
        durationSeconds: 1_801,
        attention: "deep",
      },
      ledger,
    );

    expect(overflow).toEqual({
      ok: false,
      reason: "DEEP_CAPACITY_EXHAUSTED",
    });
  });

  it("always derives the slot ID even when a runtime caller injects one", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );
    const maliciousCandidate: CapacityCandidate = {
      targetId: "action-derived-id",
      targetRevision: 4,
      target: { kind: "action", actionId: "action-derived-id" },
      durationSeconds: 900,
      attention: "medium",
      // @ts-expect-error Slot IDs are derived and cannot be supplied by callers.
      slotId: "caller-controlled-slot-id",
    };

    expect(placeCandidate(maliciousCandidate, ledger)).toMatchObject({
      ok: true,
      slot: {
        id: "today-slot:2026-07-13:action:action-derived-id:4",
      },
    });
  });

  it("never places a contiguous slot across an unavailable gap", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );

    expect(
      placeCandidate(
        {
          targetId: "action-1",
          targetRevision: 1,
          target: { kind: "action", actionId: "action-1" },
          durationSeconds: 3_601,
          attention: "medium",
        },
        ledger,
      ),
    ).toEqual({ ok: false, reason: "OUTSIDE_WORK_WINDOW" });

    expect(
      placeCandidate(
        {
          targetId: "action-fixed",
          targetRevision: 1,
          target: { kind: "action", actionId: "action-fixed" },
          durationSeconds: 3_600,
          attention: "medium",
          fixedStart: "2026-07-13T00:30:00.000Z",
        },
        ledger,
      ),
    ).toEqual({ ok: false, reason: "OUTSIDE_WORK_WINDOW" });
  });

  it("keeps source capacity immutable while consuming scratch capacity", () => {
    const capacity = capacityForLocalDate(profile, "2026-07-13");
    const before = structuredClone(capacity);
    const ledger = createCapacityLedger(capacity);
    const placement = placeCandidate(
      {
        targetId: "action-1",
        targetRevision: 1,
        target: { kind: "action", actionId: "action-1" },
        durationSeconds: 900,
        attention: "medium",
      },
      ledger,
    );
    if (!placement.ok) throw new Error("Expected placement");

    ledger.consume(placement.slot);

    expect(capacity).toEqual(before);
  });

  it("clips remaining capacity at an explicit current instant", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
      "2026-07-13T00:30:00.000Z",
    );

    const placement = placeCandidate(
      {
        targetId: "action-now",
        targetRevision: 3,
        target: { kind: "action", actionId: "action-now" },
        durationSeconds: 900,
        attention: "medium",
      },
      ledger,
    );

    expect(placement).toMatchObject({
      ok: true,
      slot: {
        id: "today-slot:2026-07-13:action:action-now:3",
        start: "2026-07-13T00:30:00.000Z",
        finish: "2026-07-13T00:45:00.000Z",
      },
    });
  });

  it("intersects flexible placement with exact earliest and latest bounds", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );

    expect(
      placeCandidate(
        {
          targetId: "bounded-action",
          targetRevision: 1,
          target: { kind: "action", actionId: "bounded-action" },
          durationSeconds: 900,
          attention: "medium",
          earliestStart: "2026-07-13T00:30:00.000Z",
          latestFinish: "2026-07-13T00:45:00.000Z",
        },
        ledger,
      ),
    ).toMatchObject({
      ok: true,
      slot: {
        start: "2026-07-13T00:30:00.000Z",
        finish: "2026-07-13T00:45:00.000Z",
      },
    });

    expect(
      placeCandidate(
        {
          targetId: "impossible-action",
          targetRevision: 1,
          target: { kind: "action", actionId: "impossible-action" },
          durationSeconds: 900,
          attention: "medium",
          earliestStart: "2026-07-13T00:30:00.000Z",
          latestFinish: "2026-07-13T00:40:00.000Z",
        },
        ledger,
      ),
    ).toEqual({ ok: false, reason: "OUTSIDE_WORK_WINDOW" });
  });

  it("applies exact bounds to fixed placements", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );

    expect(
      placeCandidate(
        {
          targetId: "fixed-before-bound",
          targetRevision: 1,
          target: { kind: "action", actionId: "fixed-before-bound" },
          durationSeconds: 900,
          attention: "medium",
          fixedStart: "2026-07-13T00:15:00.000Z",
          earliestStart: "2026-07-13T00:30:00.000Z",
        },
        ledger,
      ),
    ).toEqual({ ok: false, reason: "OUTSIDE_WORK_WINDOW" });
  });

  it("initializes used attention and fails closed after an over-budget carry", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
      undefined,
      { deep: 5_000, medium: 0, shallow: 0 },
    );

    expect(ledger.usedSeconds).toEqual({
      deep: 5_000,
      medium: 0,
      shallow: 0,
    });
    expect(
      placeCandidate(
        {
          targetId: "deep-after-carry",
          targetRevision: 1,
          target: { kind: "action", actionId: "deep-after-carry" },
          durationSeconds: 1,
          attention: "deep",
        },
        ledger,
      ),
    ).toEqual({ ok: false, reason: "DEEP_CAPACITY_EXHAUSTED" });
  });

  it.each([
    { deep: Number.NaN, medium: 0, shallow: 0 },
    { deep: -1, medium: 0, shallow: 0 },
    { deep: 0.5, medium: 0, shallow: 0 },
  ])("rejects invalid initial used attention %#", (initialUsedSeconds) => {
    expect(() =>
      createCapacityLedger(
        capacityForLocalDate(profile, "2026-07-13"),
        undefined,
        initialUsedSeconds,
      ),
    ).toThrowError(RangeError);
  });

  it("does not expose mutable nested capacity state", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );
    const exposed = ledger.capacity;
    exposed.budgets.mediumSeconds = 0;
    exposed.availableIntervals.splice(0);

    expect(
      placeCandidate(
        {
          targetId: "after-external-mutation",
          targetRevision: 1,
          target: {
            kind: "action",
            actionId: "after-external-mutation",
          },
          durationSeconds: 900,
          attention: "medium",
        },
        ledger,
      ),
    ).toMatchObject({ ok: true });
    expect(ledger.capacity.budgets.mediumSeconds).toBe(7_200);
    expect(ledger.capacity.availableIntervals).toHaveLength(2);
  });

  it("rejects an out-of-window consume atomically", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );
    const before = {
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    };

    expect(() =>
      ledger.consume({
        id: "outside-slot",
        target: { kind: "action", actionId: "outside-action" },
        targetRevision: 1,
        start: "2026-07-13T08:00:00.000Z",
        finish: "2026-07-13T08:15:00.000Z",
        attention: "medium",
      }),
    ).toThrowError(RangeError);
    expect({
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    }).toEqual(before);
  });

  it("rejects a duplicate consume atomically", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );
    const placement = placeCandidate(
      {
        targetId: "once-only",
        targetRevision: 1,
        target: { kind: "action", actionId: "once-only" },
        durationSeconds: 900,
        attention: "medium",
      },
      ledger,
    );
    if (!placement.ok) throw new Error("Expected placement");
    ledger.consume(placement.slot);
    const before = {
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    };

    expect(() => ledger.consume(placement.slot)).toThrowError(RangeError);
    expect({
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    }).toEqual(before);
  });

  it("rejects a consume that would exceed its attention budget", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
      undefined,
      { deep: 1_000, medium: 0, shallow: 0 },
    );
    const before = {
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    };

    expect(() =>
      ledger.consume({
        id: "over-budget-slot",
        target: { kind: "action", actionId: "over-budget-action" },
        targetRevision: 1,
        start: "2026-07-13T00:00:00.000Z",
        finish: "2026-07-13T01:00:00.000Z",
        attention: "deep",
      }),
    ).toThrowError(RangeError);
    expect({
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    }).toEqual(before);
  });

  it("rejects an unknown attention class before mutating capacity", () => {
    const ledger = createCapacityLedger(
      capacityForLocalDate(profile, "2026-07-13"),
    );
    const before = {
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    };

    expect(() =>
      ledger.consume({
        id: "invalid-attention-slot",
        target: { kind: "action", actionId: "invalid-attention-action" },
        targetRevision: 1,
        start: "2026-07-13T00:00:00.000Z",
        finish: "2026-07-13T00:15:00.000Z",
        // @ts-expect-error Exercise a persisted runtime value outside the union.
        attention: "focus",
      }),
    ).toThrowError(RangeError);
    expect({
      remainingIntervals: ledger.remainingIntervals,
      usedSeconds: ledger.usedSeconds,
    }).toEqual(before);
  });
});
