# Automatic Recurring Occurrences

**Date:** 2026-07-18
**Status:** Accepted product design

## Problem

Some recurring work is performed by an external system, such as an automatic bank transfer, backup, renewal, or synchronization. The operator needs to know that it is expected and to retain a trustworthy history, but normally has no work to perform and no completion state to maintain.

Modeling these events as ordinary recurring tasks creates false work:

- they appear in Today and overdue queues;
- they consume planned capacity and affect project progress;
- every occurrence asks for a manual completion update;
- a stable automation produces notification noise.

## Product decision

A recurring work item gains an **execution mode**:

- **Manual** preserves the current task behavior.
- **Automatic** represents work performed outside OmniPlan. OmniPlan records the schedule, history, reminders, and exceptions, but never performs the external action.

Existing and imported recurring rules default to Manual. Changing an existing rule to Automatic starts with the next occurrence and never rewrites or backfills prior history.

## User experience

### Rule configuration

The Recurring tab adds an `Execution` selector with Manual and Automatic options. Automatic mode:

- always uses a fixed-time cadence;
- defaults to no end, with optional end date or occurrence count;
- defaults to a zero-duration calendar point, with optional display duration;
- inherits the workspace time zone;
- has reminders off by default;
- when reminders are enabled, defaults to one day before and accepts a single lead value in minutes, hours, or days.

The rule remains generic. Domain-specific facts such as amount, recipient, backup target, or renewal plan belong in the work-item description.

Monthly rules anchored to a day that does not exist use the final calendar day of that month. OmniPlan does not infer weekend or holiday adjustments. The operator can edit a future occurrence when an external system uses a different date.

### Calendar

Automatic occurrences are shown by default and remain visually quieter than ordinary work:

- the recurring arrow identifies recurrence;
- a lightning icon identifies Automatic mode without a visible `Automatic` label;
- a tooltip and accessible label explain both icons;
- future occurrences use the normal muted treatment;
- occurred instances are further faded;
- exceptions add a warning icon;
- skipped instances use a strike-through treatment.

A lightning-icon filter hides or shows automatic occurrences without changing rules or history.

Opening an automatic occurrence shows its immutable title and description snapshot, scheduled range, time zone, status, and history. It never shows a Complete action.

For a future occurrence the available actions are:

- edit this occurrence;
- skip this occurrence;
- edit the recurring rule.

For a past occurrence the primary action is Report exception.

### Today

Automatic occurrences do not normally appear in Today. When a rule has a reminder, an upcoming occurrence enters the existing Upcoming Watchlist during its reminder window. It remains a passive link with recurring and lightning icons and has no completion control.

The first version provides in-app reminders only. It does not promise operating-system notifications, email, or delivery while OmniPlan is closed.

### Exceptions

Reporting an exception:

1. requires a short explanation;
2. marks only that occurrence as Exception;
3. immediately creates a linked ordinary task titled `Handle exception: <occurrence title>`;
4. defaults the follow-up due date to the current day and allows the operator to choose its assignee and date;
5. leaves later occurrences unchanged.

Completing the follow-up task does not erase the historical fact that the automatic occurrence was exceptional.

### Stop and history behavior

Stopping an automatic rule cancels future occurrences but retains the rule as Stopped and retains all occurrence history. Past occurrence snapshots and rule-change history are never rewritten. History is shown newest first with pagination.

## State model

An automatic rule is Active or Stopped. A projected occurrence begins as Scheduled and can transition as follows:

```text
Scheduled --planned finish reached--> Occurred
Scheduled --skip this occurrence----> Skipped
Occurred  --report exception--------> Exception + linked manual task
```

For a zero-duration occurrence, scheduled start is also scheduled finish.

The status is separate from the immutable occurrence snapshot. Title, description, original scheduled range, rule identity, and occurrence identity are retained even if the work item or future rule changes.

## Planning semantics

Automatic recurring work is informational. It:

- has no percent-complete workflow;
- consumes no assignment or attention capacity;
- is excluded from dependency scheduling, Gantt, EVM, project progress, completion checks, overdue counts, and ordinary Today lists;
- remains visible in Calendar and recurring history;
- becomes actionable only through an enabled reminder or an exception follow-up task.

Manual recurring work retains its existing planning semantics.

## Offline and synchronization semantics

The browser application has no always-running background process. Whenever a workspace is loaded, pulled, or otherwise reconciled, OmniPlan settles every due automatic occurrence that has not yet been recorded.

Catch-up records use the original planned finish as the occurrence time and identify the record as system catch-up. They do not use the time at which the application was reopened.

Occurrence identities are deterministic and settlement is idempotent, so two devices settling the same occurrence cannot create two logical history entries. Stored records win over projections for per-occurrence edits, skips, and exceptions.

## Time and recurrence boundaries

- Rules inherit one workspace time zone; rules do not have independent time zones.
- Automatic mode supports fixed Every N days, Weekly, and Monthly cadences.
- A nonexistent DST spring-forward time moves forward by the clock gap; a repeated fall-back time uses the earlier instant.
- Rules end Never, On date, or After count.
- Infinite rules are projected only for the requested calendar or reminder window; the application never materializes an infinite future.
- Occurrences are persisted only when settled or explicitly edited, skipped, or marked exceptional.

## Backward compatibility

- A missing execution mode means Manual.
- A legacy numeric `count` means the rule ends after that count.
- Legacy workspaces gain an empty occurrence-history collection and retain their existing dates and behavior.
- Work-item descriptions and the workspace time zone are optional during import and receive safe defaults.

## Out of scope

- Executing bank transfers or any other external automation.
- Verifying success through bank or third-party integrations.
- Background push, email, or operating-system notifications.
- Automatic business-day or holiday adjustment.
- Financial fields such as amount or recipient.
- Multiple reminders for one rule.

## Acceptance criteria

1. A user can configure a recurring item as Automatic and see lightning-marked occurrences in Calendar.
2. Automatic items never appear as ordinary actionable work and never consume schedule capacity.
3. Due occurrences settle exactly once, including after an offline interval.
4. Past snapshots remain unchanged after editing or stopping a rule.
5. A future occurrence can be edited or skipped without changing later occurrences.
6. Reporting an exception produces one linked manual follow-up task and retains the exception in history.
7. Enabled reminders surface only in the Today watchlist during the configured window.
8. Existing recurring rules behave exactly as Manual rules after migration.
