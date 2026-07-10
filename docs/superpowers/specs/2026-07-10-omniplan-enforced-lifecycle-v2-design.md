# OmniPlan Enforced Lifecycle V2 Design

**Status:** Approved design

**Date:** 2026-07-10

**Release model:** Parallel V2 development, one complete cutover
**Audience:** A solo operator managing AI-assisted personal projects

## 1. Executive summary

OmniPlan V2 will make good project practice the normal path and invalid project states impossible to create through supported interfaces.

The product will separate fast capture from project commitment:

- small, dependency-free work becomes a lightweight Action;
- real projects move through Direction, human Bet, Plan, Execute, Evidence, and Close;
- future capabilities remain visible but locked until their prerequisites are satisfied;
- UI, Agent, import, migration, and sync all use one command and policy layer;
- users can record honest exceptions for missing evidence, but cannot waive lifecycle integrity.

V2 will be developed in parallel inside this repository and released in one cutover only after the complete workflow, migration path, and existing planning capabilities pass acceptance.

## 2. Why this redesign is required

The current product contains a strong scheduler, Shape Up gates, evidence, audit, Monte Carlo, EVM, encrypted sync, recurring work, and Agent safeguards. Its user journey does not apply those strengths consistently.

The current audit identified four structural contradictions:

1. Quick project creation asks for one title and immediately creates an active Build project, while the audit engine immediately opens a hard gate because the Direction Card is incomplete.
2. Hard gates are enforced on some surfaces but bypassable on others, including raw lifecycle status changes and direct project operations.
3. Shape Up is the strongest implemented commitment model, but it is optional and separated from the default creation path.
4. Eight equal global destinations expose implementation machinery instead of guiding the user toward the single valid next action.

V2 resolves these contradictions at the domain boundary rather than adding more warnings to the existing UI.

## 3. Product principles

### 3.1 Capture instantly; commit deliberately

Capturing an idea must remain fast. Capture never creates an active project. The user must explicitly classify the capture and explicitly place a Bet before project execution can begin.

### 3.2 A hard gate is a domain invariant

The same transition rules apply to human UI, Agent commands, imported data, migration, and synced state. No surface may implement its own weaker interpretation.

### 3.3 Show one valid next action

Every primary screen leads with the most important permitted action. Diagnostics and advanced machinery remain available through progressive disclosure.

### 3.4 Prefer a truthful blocked state

OmniPlan must display why work is blocked and what resolves it. It must never report progress or readiness by silently bypassing a missing commitment, review, or evidence requirement.

### 3.5 Automation proposes commitments; humans make them

Automation may perform low-risk factual updates. Bets, daily commitments, exceptions, review conclusions, and project closure remain human decisions.

## 4. Scope and non-goals

### 4.1 In scope

- Inbox capture and deterministic Action-versus-Project triage
- lightweight Actions
- unified Direction brief
- versioned human Bet and Re-bet
- lifecycle-driven project navigation
- capacity-aware Today planning and daily commitment
- Review workflow and event triggers
- tiered evidence requirements and controlled evidence exceptions
- structured Close decisions
- bounded Agent write authority
- V1-to-V2 migration and recovery
- consistent policy enforcement for UI, Agent, import, and sync
- desktop and mobile navigation redesign

### 4.2 Non-goals

- multi-user teams, roles, approvals, or shared ownership
- external-calendar-only capacity calculation
- a new scheduling, Monte Carlo, EVM, recurring, encryption, or sync algorithm
- full Agent autonomy
- a permanent user-facing V1/V2 toggle
- a second repository or a native application rewrite
- compatibility that preserves invalid V1 mutation behavior

## 5. Information architecture

### 5.1 Global navigation

The four primary destinations are:

1. **Inbox** — capture and triage.
2. **Today** — generated daily work plan, agenda, and calendar.
3. **Projects** — project portfolio and lifecycle workspaces.
4. **Review** — weekly review, event-triggered review, exceptions, and conflicts.

Settings remains a utility entry at the bottom of the desktop sidebar and in the mobile utility menu.

### 5.2 Existing destination mapping

- Portfolio becomes the Projects landing page.
- Calendar becomes a Today view toggle.
- Reports appear inside a project's Evidence and Close stages and in Review summaries.
- Agent configuration and command history move to Settings > Automation.
- Existing machine-readable `/agent/*` endpoints remain available for integrations, but Agent is no longer a primary human navigation destination.

### 5.3 Default route

After first-time setup, the application always opens Today. It does not redirect the user unpredictably.

Untriaged Inbox work, overdue Review, migration holds, conflicts, and hard gates appear as a single top action card. The card links to the required resolution without moving the user automatically.

### 5.4 Project workspace

Every project displays the lifecycle sequence:

`Direction -> Bet -> Plan -> Execute -> Evidence -> Close`

The current stage is prominent. Future stages are visible but inaccessible and display their exact unlock condition. Completed stages link to their immutable historical record.

The workspace header contains:

- project name;
- current lifecycle stage;
- current Bet appetite and expiry;
- active holds;
- one recommended next action.

Raw status editing is removed.

## 6. Capture and Action model

### 6.1 Inbox capture

Inbox uses one primary text input. Captures may originate from the UI, share sheet, Shortcut, or Agent.

An Inbox item stores:

- original text;
- source and actor;
- captured timestamp;
- optional desired date;
- triage recommendation;
- triage status.

Capture does not require project fields and never creates an active project.

### 6.2 Deterministic Action eligibility

A capture may remain an Action only when all conditions are true:

- it can be completed in one working session;
- estimated effort is at most two hours;
- it has no dependency;
- it does not require milestone evidence;
- it does not represent multiple outcomes or an uncertain solution path.

The system recommends Action or Project and explains the rule. The user confirms the classification.

If an Action later gains a dependency, exceeds two hours, splits into multiple outcomes, or requires validation evidence, the policy layer rejects the change and requires `promote_action_to_project`. Promotion preserves the capture and Action history.

### 6.3 Action capabilities

An Action may have:

- title;
- estimate;
- attention class: Deep, Medium, or Shallow;
- desired date or fixed time constraint;
- completion actual and outcome note.

An Action may appear in Today and Calendar. It cannot have a Gantt row, dependency network, baseline, project evidence milestone, Bet, or Close decision.

## 7. Project lifecycle

### 7.1 Domain stages

The V2 project state machine uses these explicit stages:

```text
direction
awaiting_bet
planning
executing
validating
closing
closed
```

The user-facing lifecycle labels map as follows:

- Direction -> `direction`
- Bet -> `awaiting_bet`
- Plan -> `planning`
- Execute -> `executing`
- Evidence -> `validating`
- Close -> `closing` and `closed`

### 7.2 Holds

Holds are orthogonal to the lifecycle stage:

```text
migration_review
rebet_required
review_overdue
sync_conflict
```

A project may have more than one hold. Each hold defines a narrow policy effect instead of forcing a misleading lifecycle status.

- `migration_review` makes operational views read-only; only the guided migration review can update the brief and place the new Bet.
- `rebet_required` stops execution and planning changes until a new Bet is placed.
- `review_overdue` allows already committed Today work but blocks new commitments.
- `sync_conflict` blocks mutations to affected records until Review resolves the conflict.

### 7.3 Stage transitions

1. Project triage creates `direction`.
2. A complete valid brief derives `awaiting_bet`.
3. Human `place_bet` creates a Bet version and transitions to `planning`.
4. The first committed Today slot containing project work transitions to `executing`.
5. Completing the planned scope, reaching the appetite boundary, or requesting closure transitions to `validating`.
6. Satisfying validation requirements transitions to `closing`.
7. Human `close_project` creates a Close decision and transitions to `closed`.

No generic command may set a stage directly.

At the appetite boundary, OmniPlan immediately stops scheduling new project work and creates an event Review. The human must choose Close, Re-bet with a new appetite and scope, or Abandon. Silent appetite extension is not a valid transition.

## 8. Unified Direction brief

The current Direction Card and Shape Up Pitch become one user-facing brief with six required decisions:

1. **Audience and problem** — target user or beneficiary and the problem to solve.
2. **Success evidence** — observable evidence that would demonstrate the intended outcome.
3. **Appetite** — fixed time budget for the Bet.
4. **Validation method** — how success evidence will be gathered.
5. **First scope** — the first bounded scope the Bet commits to.
6. **No-go or kill condition** — excluded work and the condition that should stop the Bet.

The brief is progressive: one decision at a time, short examples, saved drafts, and a persistent completeness indicator. Advanced notes remain optional and never substitute for a required decision.

All six decisions are material fields. Editing any of them after a Bet invalidates the current Bet, preserves its history, adds `rebet_required`, and stops new or continuing execution. Project-name, formatting, and non-decision notes are editorial and do not require Re-bet.

## 9. Bet and plan

### 9.1 Bet version

A Bet stores:

- immutable brief hash and brief snapshot;
- committed first scope;
- appetite start and end;
- human actor;
- approval timestamp;
- invalidation timestamp and reason when superseded;
- source Review or decision, when applicable.

Only a human may place or replace a Bet. There is no import, migration, or Agent path that synthesizes approval.

### 9.2 Planning

After a valid Bet, the user may create and edit:

- outline and work items;
- scope mapping;
- dependencies;
- estimates and attention classes;
- recurrence;
- Gantt constraints;
- baseline versions.

The existing scheduler, Gantt, recurring, Monte Carlo, EVM, and dependency engines remain the calculation layer. V2 supplies validated project and work projections through adapters.

Unbet projects never enter the executable scheduler projection.

Every project Work Item must map to scope contained in the active Bet. Work may be decomposed or refined inside that scope. Work outside it is rejected as scope expansion and must return through Direction and Re-bet.

A Plan Version is created when project work first enters a committed Today plan and whenever the user accepts a Replan. It records the Work Item revisions, dependency revisions, scope mapping, schedule hash, and capacity-independent dates used for that commitment. Existing Baselines remain explicit reporting snapshots and are not silently replaced by Plan Versions.

## 10. Capacity and Today

### 10.1 Capacity setup

First-time setup requires:

- weekly working windows;
- Deep, Medium, and Shallow attention budgets per day;
- optional fixed unavailable blocks.

Actual work history may generate a calibration suggestion. It never changes capacity silently.

### 10.2 Daily generation

Today includes eligible Actions and work from valid, unblocked Bets. It excludes:

- unmet dependencies;
- invalid or expired Bets awaiting a decision;
- projects held for migration, Re-bet, or sync conflict;
- work exceeding remaining capacity.

Overflow remains in Later and displays the capacity reason.

The deterministic ordering is:

1. fixed time constraints and hard deadlines;
2. appetite expiry and critical-path urgency;
3. dependency-unlock value;
4. project priority;
5. age of the eligible work.

### 10.3 Daily commitment

OmniPlan generates a proposed Today plan. The user must select `Commit today` before it becomes the daily commitment.

A Daily Commitment stores:

- date;
- capacity snapshot;
- ordered time slots;
- included item revisions;
- human actor and timestamp.

After commitment, actuals, dependency changes, or calendar changes may create a Replan proposal. OmniPlan never silently moves committed slots. Accepting a Replan is a new human commitment and preserves the previous version.

Review overdue does not remove already committed work. It prevents accepting a Replan that creates a new commitment.

## 11. Evidence, exceptions, and Close

### 11.1 Tiered evidence

- Ordinary Action or Task completion records actual effort and a concise result: completed, learned, or blocked.
- A validation milestone requires linked evidence or an active controlled evidence exception.
- Project Close requires comparison against the Direction success evidence.

### 11.2 Controlled exceptions

Only evidence gates support exceptions. An Exception record requires:

- target evidence requirement;
- rationale;
- known consequence;
- review date;
- expiry date;
- human approver;
- creation and resolution history.

At expiry, the gate automatically becomes blocking again. Generic `Clear gate` is removed.

These lifecycle rules are never waivable:

- human Bet or Re-bet;
- appetite expiry resolution;
- valid stage transition;
- capacity-safe Today commitment;
- closed-project immutability.

### 11.3 Close decision

Close requires:

- success evidence comparison;
- outcome: `Achieved`, `Partial`, `Invalidated`, or `Abandoned`;
- key learning;
- disposition of unfinished work: discard, return to Inbox, create follow-up project, or retain as historical incomplete scope;
- human actor and timestamp.

Closed projects are immutable. Archive is only a visibility preference and does not change lifecycle history.

## 12. Review model

### 12.1 Weekly portfolio review

OmniPlan requires one portfolio-level Review each week. The Review queue covers:

- Inbox aging;
- Bet health and appetite;
- capacity variance;
- stale validation evidence;
- open holds, exceptions, and sync conflicts;
- projects ready for Re-bet, validation, or Close.

### 12.2 Event-triggered review

Additional Review items are created when:

- a Bet reaches its midpoint;
- a Bet reaches its appetite boundary;
- evidence becomes stale;
- actual capacity repeatedly diverges from configured capacity;
- a hard gate opens;
- a sync conflict affects a commitment or lifecycle record.

### 12.3 Overdue effect

An overdue Review adds `review_overdue` to affected projects or the portfolio.

The user may continue already committed Today work. The following commands are rejected until Review completes:

- place a new Bet;
- accept a Re-bet;
- expand scope;
- commit project work that was not already in the current Daily Commitment;
- accept a Replan;
- create another project commitment.

Capturing Inbox items and drafting Direction remain available.

## 13. Agent authority

### 13.1 Automatic low-risk commands

The Agent may automatically:

- capture Inbox items;
- record actual effort;
- attach evidence supplied by an authorized source.

### 13.2 Proposal-only commands

The Agent may draft, but not apply:

- Direction decisions;
- plans and work breakdowns;
- Replan proposals;
- scope changes;
- dependency changes.

### 13.3 Human-only commands

Only a human may:

- confirm Action-versus-Project classification;
- place or replace a Bet;
- commit Today or accept a Replan;
- approve an evidence exception;
- complete a Review conclusion;
- close a project.

Agent attempts outside its authority return a rejected Command receipt with the required human action. They never partially mutate the Workspace.

## 14. V2 architecture

### 14.1 Repository layout

V2 is developed in parallel inside the same repository:

```text
src/v2/
  app/           routes, shell, lifecycle screens
  domain/        V2 types, commands, policies, transitions
  migration/     V1 adapters, backup, migration, recovery
  repositories/  atomic persistence and sync adapters
  projections/   scheduler and reporting adapters
  tests/         V2 fixtures and integration tests
```

Existing calculation modules under `src/domain/` remain shared. V2 does not copy scheduler, Monte Carlo, EVM, recurring, encryption, or sync algorithms.

During development, an internal-only entry switch opens V2. The production release changes the default entry only after all acceptance criteria pass. Users never receive a permanent V1/V2 choice.

### 14.2 Workspace model

The new Workspace uses `schemaVersion: 2` and includes:

```text
InboxItem[]
Action[]
ProjectV2[]
DirectionBrief[]
BetVersion[]
PlanVersion[]
DailyCommitment[]
ReviewRecord[]
ExceptionRecord[]
CloseDecision[]
CommandReceipt[]
WorkItem[]
Dependency[]
Baseline[]
Evidence[]
Actual[]
LegacyAuditRecord[]
```

V1 Decisions, Audit Gates, and ChangeSets are preserved as immutable `LegacyAuditRecord` entries with their original IDs and payloads. They remain visible in history but do not act as V2 policy overrides.

### 14.3 Command flow

Every mutation follows one data path:

```text
UI / Agent / Import / Sync
  -> Command
  -> Policy authorization and invariant checks
  -> pure state transition
  -> Command receipt and audit diff
  -> atomic local persistence
  -> queued encrypted sync
```

The pure core returns either a complete next Workspace plus receipt or a typed rejection. It never returns a partially changed Workspace.

Direct object setters and raw lifecycle status mutation are prohibited outside migration code.

### 14.4 Typed rejection

A rejected Command includes:

- stable error code;
- human-readable reason;
- blocking gate or hold;
- permitted next command;
- actor and origin;
- unchanged Workspace revision.

The UI renders this as a concise action card rather than a generic error toast.

## 15. Migration and recovery

### 15.1 Backup

Before migration, OmniPlan serializes the complete V1 Workspace, computes a checksum, stores a local recovery copy, and offers the same backup as a downloadable file.

### 15.2 Idempotent migration

Migration records the V1 source checksum and is idempotent. Re-running it against the same source cannot duplicate projects, work items, evidence, or history.

It preserves all existing entity IDs for projects, work items, dependencies, evidence, actuals, baselines, decisions, gates, and ChangeSets.

Current Direction Card and Shape Up fields prefill the unified brief. Missing fields remain visibly incomplete.

All existing active projects receive `migration_review`. Operational views are read-only, while the guided migration review may complete the brief and place a new human Bet.

No existing project is automatically Bet.

### 15.3 Failure recovery

Migration runs against a copy and commits atomically. If validation or persistence fails:

- no V2 state is written;
- the original V1 Workspace remains intact;
- the recovery screen displays the error and backup checksum;
- the user may download or restore the backup and retry.

## 16. Sync conflict behavior

Lifecycle records and commitments are not last-write-wins data.

When remote and local state both change a Bet, Daily Commitment, Review, Exception, or Close record, sync creates `sync_conflict` and a Review item. The user must choose the retained version or reapply a valid Command on top of the retained revision.

Until resolved, only unrelated records may change. The conflict does not silently overwrite a human commitment.

## 17. Accessibility and responsive behavior

- Desktop navigation uses labeled sidebar entries.
- Mobile uses four labeled bottom destinations; Settings is available through the utility menu.
- Lifecycle stages remain textual and do not rely on color alone.
- Locked controls expose their reason and required action to assistive technology.
- Route changes move focus to the page title and announce the new context.
- Dialogs and sheets trap and restore focus.
- Primary touch targets are at least 44 by 44 CSS pixels.
- The core flow reflows without horizontal loss at 200% zoom.
- Tables and Gantt retain accessible text alternatives.

## 18. Verification strategy

### 18.1 Domain tests

- every legal and illegal stage transition;
- actor permissions for every command;
- Action eligibility and mandatory promotion;
- Re-bet invalidation;
- Review restrictions;
- Exception expiry;
- Close immutability;
- Today capacity invariants.

Property tests generate arbitrary Command sequences and assert that no sequence can produce:

- unbet execution;
- an over-capacity Daily Commitment;
- mutation after Close;
- a lifecycle transition without the required human actor;
- a bypassed hard gate.

### 18.2 Migration tests

- current sample Workspace;
- historical V1 fixtures;
- empty Workspace;
- archived and completed projects;
- incomplete Direction and Shape Up data;
- malformed optional fields;
- repeated migration of the same checksum;
- simulated persistence failure.

### 18.3 Integration tests

The same operation is attempted through UI, Agent, import, and sync. All origins must receive the same policy outcome and equivalent receipt.

### 18.4 End-to-end flows

1. capacity setup -> Inbox -> Action -> Today -> completion;
2. Inbox -> Project -> Direction -> Bet -> Plan -> Today Commit;
3. actual and evidence -> validation -> Close;
4. material brief edit -> execution pause -> Re-bet;
5. overdue Review -> existing execution allowed -> new commitment rejected;
6. evidence exception -> expiry -> gate reopens;
7. V1 migration -> Needs review -> new human Bet;
8. sync conflict -> Review -> resolution;
9. Agent low-risk apply and guarded proposal;
10. attempted bypass through every origin.

### 18.5 Regression, scale, and visual checks

- existing scheduler, dependency, Gantt, recurring, Monte Carlo, EVM, encrypted sync, and backup tests remain green;
- at least 50 projects and 300 Work Items are exercised;
- desktop and mobile screenshots cover every lifecycle stage, empty state, blocked state, migration state, and conflict state;
- keyboard navigation, focus order, labels, contrast, 44-pixel targets, and 200% zoom reflow are checked;
- `bun test`, `bun run build`, and diff checks must pass.

## 19. One-cutover release policy

Development proceeds in internal workstreams, but users receive one complete V2 release:

1. Workspace V2, commands, policies, migration, and recovery.
2. Inbox, Actions, Direction, Bet, and lifecycle navigation.
3. Plan adapters, capacity setup, Today, Calendar, and daily commitment.
4. Evidence, exceptions, Review, Agent authority, sync conflicts, and Close.
5. regression, scale, accessibility, visual, migration, and recovery verification.
6. default-entry cutover and release.

There is no UI-first release and no partial enforcement release.

Release is blocked if any of these are true:

- any origin bypasses policy;
- migration can partially write or lose IDs;
- Today can commit over capacity;
- a commitment can be overwritten silently;
- a closed project can mutate;
- a core V1 calculation capability is missing;
- desktop or mobile core flows fail accessibility or visual acceptance.

## 20. Acceptance criteria

The design is complete when all statements are true:

1. Quick capture never creates an active project.
2. An Action cannot exceed its deterministic eligibility boundary.
3. No project work enters Today without a valid human Bet.
4. All origins use the same Command and Policy layer.
5. Future lifecycle stages remain visible but cannot be entered illegally.
6. Material Direction changes invalidate the active Bet and require Re-bet.
7. Today never exceeds configured time or attention capacity.
8. Committed Today slots never move without human Replan acceptance.
9. Validation milestones cannot complete without evidence or an active evidence exception.
10. Generic gate clearing does not exist.
11. Review overdue blocks new commitments but preserves committed execution.
12. Agent authority matches the approved low-risk, proposal, and human-only boundaries.
13. Existing active projects migrate to Needs review without losing IDs or history.
14. Close records outcome, learning, success comparison, and unfinished-work disposition.
15. Closed projects are immutable; Archive affects visibility only.
16. The primary navigation contains Inbox, Today, Projects, and Review.
17. The application opens Today after setup.
18. Migration and sync failures preserve recoverable user data.
19. Existing calculation engines remain correct.
20. V2 ships only as a complete one-cutover release.

## 21. Explicit exclusions from compatibility

V2 intentionally does not preserve:

- quick creation of an immediately active project;
- raw lifecycle status selection;
- per-page gate enforcement;
- generic gate clearing;
- Agent-driven commitments;
- silent automatic Replan after daily commitment;
- simultaneous user-facing V1 and V2 operation.

These exclusions are necessary to make the approved best practices enforceable rather than advisory.
