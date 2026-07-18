# Automatic Recurring Occurrences Implementation Plan

**Design:** `docs/superpowers/specs/2026-07-18-automatic-recurring-occurrences-design.md`
**Date:** 2026-07-18
**Status:** Implemented and verified

## Architecture

The seam remains `src/domain/recurring.ts`. Calendar, Today, storage reconciliation, and action handlers must consume the same projected occurrence model instead of reimplementing recurrence and status decisions.

The module interface will expose three kinds of operation:

1. **Project** occurrences for a bounded time window, merging the current rule with stored occurrence records.
2. **Reconcile** a workspace at a supplied clock time, idempotently persisting every due automatic occurrence.
3. **Apply** a typed single-occurrence action: reschedule, skip, or report exception.

Everything else stays behind that interface: deterministic identities, infinite-rule iteration, end conditions, workspace-time-zone arithmetic, stored-record precedence, catch-up provenance, snapshot retention, and linked exception-task creation.

## Phase 1: Persisted model and migration

**Files:**

- `src/domain/types.ts`
- `src/domain/workspace.ts`
- `src/domain/projectLifecycle.ts`
- `src/domain/storage.ts`
- `src/domain/sampleData.ts`
- `src/domain/integration.test.ts`

**Changes:**

- Add optional work-item descriptions.
- Extend repeat rules with rule identity, execution mode, end mode/date, reminder lead, automatic display duration, automatic effective date, and stopped date.
- Add a workspace time zone and persisted automatic occurrence records.
- Normalize legacy snapshots so missing execution mode means Manual, legacy count rules retain count semantics, and missing collections/time zone receive safe defaults.
- Export schema version 2 while continuing to import schema version 1.
- Verify local and encrypted-sync round trips preserve the new model.

## Phase 2: Deep recurring domain module

**Files:**

- `src/domain/recurring.ts`
- `src/domain/time.ts`
- `src/domain/recurring.test.ts`

**Changes:**

- Preserve the current manual recurrence helper as a compatibility wrapper.
- Add bounded window projection for finite and infinite rules.
- Calculate fixed wall-clock recurrence in the workspace time zone, including monthly final-day clamping and DST-safe daily/weekly cadence.
- Merge stored records over projected occurrences.
- Reconcile due automatic instances at finish time and mark offline results as system catch-up.
- Implement future single-instance reschedule and skip.
- Implement exception reporting with required explanation and one linked ordinary follow-up task.
- Add reminder-window selectors and chronological/history selectors.
- Make all identities deterministic and all mutations idempotent.

**Test first at the module interface:**

- legacy manual behavior;
- all end modes and window projection;
- month-end and DST boundaries;
- zero/display duration settlement;
- offline catch-up and repeated reconciliation;
- immutable snapshots;
- isolated reschedule, skip, stop, and exception actions;
- future-only Manual-to-Automatic conversion;
- reminder boundaries.

## Phase 3: Remove automatic items from planning

**Files:**

- `src/domain/scheduler.ts`
- `src/domain/scheduler.test.ts`
- `src/domain/audit.ts`
- `src/domain/agent.ts`
- `src/App.tsx`

**Changes:**

- Exclude automatic recurring work centrally from scheduling input. This removes it from Gantt, Today task rows, capacity, leveling, health, EVM, Monte Carlo, and project-completion surfaces driven by schedules.
- Also filter raw-work-item consumers: audit gates, Agent open-work summaries/commands, and bulk Finish open work.
- Preserve existing behavior for Manual recurring work.

## Phase 4: Application orchestration and actions

**Files:**

- `src/App.tsx`

**Changes:**

- Replace the frozen module-load clock for recurrence/reminder behavior with a small reactive clock.
- Reconcile after local load, remote pull, and while the app remains open.
- Record ChangeSets for rule edits, stop, single-instance edits/skips, and exceptions. Routine automatic settlement remains silent and does not create audit noise.
- Add root handlers for reschedule, skip, stop, and exception reporting.
- Save and sync the resulting workspace through the existing persistence path.
- Extend work-item creation and recurring editing so a description can be stored and snapshotted.

## Phase 5: Recurring, Calendar, and Today UI

**Files:**

- `src/App.tsx`
- `src/styles.css`

**Recurring tab:**

- Add Manual/Automatic execution selection.
- Force and explain fixed-time cadence in Automatic mode.
- Add Never/On date/After count, display duration, reminder, and workspace-time-zone fields.
- Change Clear to Stop for Automatic rules.
- Show recurrence plus lightning icons and newest-first occurrence/rule-change history with pagination.

**Calendar:**

- Build events from bounded domain projections instead of the first 90 occurrences.
- Add a pressed-state lightning filter, default on.
- Render planned/occurred/exception/skipped visual states without relying on color alone.
- Use a shared automatic-occurrence Sheet for details and actions; never render Complete.

**Today:**

- Merge reminder occurrences into the existing Upcoming Watchlist.
- Render them as passive recurring/lightning rows with no actuals or completion form.

**Accessibility:**

- Provide accessible names for icon-only automation markers and the filter.
- Include text status in occurrence details and hidden labels.
- Use `aria-pressed` for filtering and required validation for exception notes.
- Announce successful occurrence actions through a polite live region.

## Phase 6: Verification

**Automated:**

1. Run focused recurring, scheduler, storage, sync, and work-item tests.
2. Run the complete `bun test` suite.
3. Run `bun run build`.
4. Run `git diff --check`.

**Browser acceptance:**

1. Configure a rule as Automatic and confirm fixed cadence, Never end, reminder defaults, time zone, and description.
2. Confirm the Calendar lightning filter, icon-only automatic marker, and status styling.
3. Open future and past occurrence details; verify there is no Complete action.
4. Skip and reschedule separate future instances.
5. Report an exception and verify the linked manual task appears while history remains exceptional.
6. Enable a reminder and verify a passive Today watchlist row.
7. Check desktop and narrow layouts and confirm a clean browser console.

## Delivery rule

The implementation is complete only when all acceptance criteria in the design document are represented in code and the full verification gate passes. No external execution, bank integration, push notification, or holiday-calendar behavior is introduced.

## Verification result

Completed on 2026-07-18:

- `bun test`: 64 tests passed across 10 files.
- `bun run build`: production build passed; the existing large-chunk advisory remains non-blocking.
- `git diff --check`: passed.
- Browser acceptance passed for Automatic defaults, icon-only Calendar markers, the pressed-state filter, direct occurrence details, exact Edit rule routing, passive Today reminders, workspace-time-zone editing, local-time preview, 390 px layout, and a clean browser console.
- Domain tests cover due/offline settlement, future-only edits and time-zone changes, DST gaps and repeats, immutable history, stop, skip, reschedule, stale actions, exception idempotence, planning exclusion, migration, and cross-project movement.
