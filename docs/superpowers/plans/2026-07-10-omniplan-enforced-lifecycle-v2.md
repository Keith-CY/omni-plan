# OmniPlan Enforced Lifecycle V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OmniPlan's advisory, bypassable workflow with a complete V2 in which fast capture remains easy, every real project follows Direction -> human Bet -> Plan -> Execute -> Evidence -> human Close, and every write origin is governed by one enforceable command policy.

**Architecture:** Build V2 in parallel under `src/v2/` and leave the V1 workspace and production entry untouched until the final cutover. All V2 mutations pass through a pure command engine, then an atomic IndexedDB repository and queued encrypted sync. Existing scheduling, dependency, recurring, Monte Carlo, EVM, encryption, and transport modules remain shared calculation infrastructure behind V2 projection adapters. The UI reads selectors and dispatches commands; it never mutates workspace objects directly.

**Tech Stack:** React 18, TypeScript 5.7, React Router 7, Vite 6, Bun, Vitest 2, Testing Library, fast-check, IndexedDB/fake-indexeddb, Playwright, axe-core, Radix UI, Tailwind CSS 4, existing OmniPlan calculation and encrypted-sync modules.

---

## Delivery contract

This is one user-visible release implemented through internal, green workstreams. Do not expose a permanent V1/V2 toggle, do not migrate the live V1 record in place, and do not switch the production default before every release gate in Task 28 is green.

Every implementation task uses this loop:

1. Add the focused failing test.
2. Run the focused command and confirm the stated failure.
3. Add the minimum production code that satisfies the test.
4. Run the focused test and the relevant regression suite.
5. Run `bun run build` whenever TypeScript or application code changed.
6. Inspect `git diff --check` and the task-scoped diff.
7. Commit only the files named by that task.

Commands in this plan assume the repository root is:

```text
/Users/ChenYu/Documents/Github/omni-plan
```

Use Bun for every JavaScript package operation. Keep `bun.lockb` tracked. If Git signing fails, commit with `git -c commit.gpgsign=false commit`.

## Non-negotiable invariants

- Capture never creates an active project.
- An Action remains an Action only while it is one session, at most two hours, dependency-free, evidence-free, single-outcome, and solution-certain.
- A project cannot execute, enter Today, or mutate plan scope without a current human Bet.
- All operational origins (`ui`, `agent`, `import`, `sync`) call the same command engine. Migration is the only initial-construction path and must run the same invariant validator, preserve approvals honestly, and commit atomically.
- No command sets a lifecycle stage directly.
- Material Direction edits invalidate the Bet, add `rebet_required`, and pause execution.
- Appetite expiry stops new scheduling and requires a human Close, Re-bet, or Abandon decision.
- Today cannot exceed configured time or attention capacity.
- A committed Today plan never moves silently; an accepted Replan creates a new version.
- Only evidence gates can receive expiring, human-approved exceptions.
- Review overdue preserves already committed execution while blocking new commitments.
- Human-only decisions remain human-only regardless of origin.
- Sync conflicts on commitments and lifecycle records never use last-write-wins.
- Closed projects are immutable; archive changes visibility only.
- Failed or repeated migration never partially writes or duplicates data.

## Target source layout

```text
src/v2/
  app/
    AppV2.tsx
    entry.tsx
    routes.tsx
    v2.css
    agent/
    migration/
    state/V2WorkspaceProvider.tsx
    shell/
    setup/
    inbox/
    actions/
    projects/
    project/
    today/
    review/
    settings/
    components/
    test/
  domain/
    types.ts
    workspace.ts
    stableHash.ts
    errors.ts
    lifecycle.ts
    invariants.ts
    policy.ts
    commands.ts
    commandHandlers.ts
    actionPolicy.ts
    direction.ts
    planning.ts
    localTime.ts
    today.ts
    review.ts
    evidence.ts
    close.ts
    conflicts.ts
    agentAuthority.ts
    selectors.ts
  migration/
    backup.ts
    migrateV1.ts
    validateMigration.ts
    recovery.ts
  projections/
    schedulerAdapter.ts
    recurringAdapter.ts
    reportingAdapter.ts
  repositories/
    indexedDb.ts
    browserWorkspaceRepository.ts
    bootstrapService.ts
    commandService.ts
    systemEventCoordinator.ts
    syncProtocol.ts
    syncAdapter.ts
    originAdapters.ts
    agentAdapter.ts
    workspaceTransfer.ts
  tests/
    fixtures/
    builders.ts
    commandSequence.property.test.ts
    originParity.integration.test.ts
tests/e2e/
scripts/
```

## Dependency order

Tasks 1-15 establish and property-test the enforceable domain. Tasks 16-19 make persistence, migration, sync, import, and Agent use it. Tasks 20-26 build the guided interface on those contracts. Tasks 27-29 prove the complete release and perform the single cutover. Do not begin the UI command surfaces before Task 16's `CommandService` exists.

### Task 1: Install the reproducible V2 verification harness

**Files:**

- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `bun.lockb`
- Modify: `vite.config.ts`
- Create: `playwright.config.ts`
- Create: `src/v2/app/test/setup.ts`
- Create: `src/v2/app/test/harness.test.tsx`

- [ ] Record the starting baseline before dependency or configuration changes:

```bash
bun run test
bun run build
git status --short --branch
```

Expected for the approved-plan baseline: 41 existing tests pass, the production build succeeds, and only intentional plan/spec work is present. If the repository has advanced, record the new green baseline instead of forcing this historical count.

- [ ] Add a jsdom harness test before installing the new packages:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("V2 UI test harness", () => {
  it("renders semantic UI in jsdom", () => {
    render(<button type="button">Commit today</button>);
    expect(screen.getByRole("button", { name: "Commit today" })).toBeVisible();
  });
});
```

- [ ] Run `bunx vitest run src/v2/app/test/harness.test.tsx`.

Expected: FAIL because Testing Library and jest-dom are not installed.

- [ ] Install the exact development dependencies:

```bash
bun add -d fast-check @playwright/test @axe-core/playwright @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom fake-indexeddb
```

- [ ] Add these scripts to `package.json` while retaining the existing scripts:

```json
{
  "test:v2": "vitest run src/v2",
  "test:property": "vitest run src/v2/tests/commandSequence.property.test.ts",
  "test:ui": "vitest run src/v2/app",
  "test:e2e": "playwright test",
  "test:a11y": "playwright test tests/e2e/accessibility.spec.ts",
  "test:visual": "playwright test tests/e2e/visual.spec.ts",
  "test:scale": "playwright test tests/e2e/scale.spec.ts",
  "typecheck": "tsc --noEmit",
  "build:v1": "tsc --noEmit && vite build --mode v1",
  "build:v2": "tsc --noEmit && vite build --mode v2",
  "verify:v2": "bun scripts/verify-v2.ts"
}
```

- [ ] Change the Vitest include to `["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"]` and add `setupFiles: ["src/v2/app/test/setup.ts"]`. In `setup.ts`, import `@testing-library/jest-dom/vitest` and call Testing Library `cleanup` from an `afterEach` hook only when `typeof document !== "undefined"`, so Node-domain tests remain isolated.

- [ ] Create `playwright.config.ts` with `tests/e2e` as the test directory, a production preview web server (`bun run build:v2 && bun run preview -- --port 4173`), trace-on-first-retry, screenshot-on-failure, and three projects: desktop Chromium, desktop WebKit, and mobile WebKit at 390 by 844. Keep screenshot comparisons in desktop Chromium only inside the visual spec.

- [ ] Add `playwright-report/` and `test-results/` to `.gitignore`; canonical review artifacts belong only under `docs/ui-review-v2/`.

- [ ] Run `bunx vitest run src/v2/app/test/harness.test.tsx`.

Expected: PASS, 1 test.

- [ ] Run `bun run test`.

Expected: the existing 41 domain tests and the new harness test pass.

- [ ] Commit:

```bash
git add .gitignore package.json bun.lockb vite.config.ts playwright.config.ts src/v2/app/test
git -c commit.gpgsign=false commit -m "test: add V2 verification harness"
```

### Task 2: Define the V2 workspace schema and deterministic builders

**Files:**

- Create: `src/v2/domain/types.ts`
- Create: `src/v2/domain/workspace.ts`
- Create: `src/v2/domain/stableHash.ts`
- Create: `src/v2/tests/builders.ts`
- Create: `src/v2/domain/workspace.test.ts`

- [ ] Write tests that assert an empty V2 workspace has `schemaVersion: 2`, revision `0`, all entity collections, no capacity profile, and no active migration marker. Add a second test proving `stableHash` returns the same result for objects whose keys were inserted in different orders.

```ts
import { describe, expect, it } from "vitest";
import { stableHash } from "./stableHash";
import { createEmptyWorkspaceV2 } from "./workspace";

describe("createEmptyWorkspaceV2", () => {
  it("creates the complete schema without an implied commitment", () => {
    expect(createEmptyWorkspaceV2("workspace-1")).toEqual({
      schemaVersion: 2,
      workspaceId: "workspace-1",
      revision: 0,
      capacityProfile: undefined,
      inboxItems: [],
      actions: [],
      projects: [],
      directionBriefs: [],
      bets: [],
      planVersions: [],
      dailyCommitments: [],
      reviews: [],
      exceptions: [],
      closeDecisions: [],
      replanProposals: [],
      commandProposals: [],
      syncConflicts: [],
      commandReceipts: [],
      workItems: [],
      dependencies: [],
      resources: [],
      capacities: [],
      baselines: [],
      evidence: [],
      actuals: [],
      legacyAuditRecords: [],
      visibility: { archivedProjectIds: [] },
      migration: undefined
    });
  });
});

describe("stableHash", () => {
  it("ignores object insertion order", async () => {
    expect(await stableHash({ b: 2, a: 1 })).toBe(await stableHash({ a: 1, b: 2 }));
  });
});
```

- [ ] Run `bunx vitest run src/v2/domain/workspace.test.ts`.

Expected: FAIL because the V2 modules do not exist.

- [ ] Define these exact core discriminants in `types.ts`:

```ts
export type LifecycleStage =
  | "direction"
  | "awaiting_bet"
  | "planning"
  | "executing"
  | "validating"
  | "closing"
  | "closed";

export type ProjectHold =
  | "migration_review"
  | "rebet_required"
  | "review_overdue"
  | "sync_conflict";

export type CommandOrigin = "ui" | "agent" | "import" | "sync" | "migration";
export type ActorKind = "human" | "agent" | "system";
export type SourceCapability = "human_decision" | "capture_inbox" | "record_actual" | "attach_evidence" | "submit_proposal" | "import_portable" | "replay_receipt" | "system_time" | "open_conflict";
export type AttentionKind = "deep" | "medium" | "shallow";
export type CloseOutcome = "achieved" | "partial" | "invalidated" | "abandoned";
export type WorkDisposition = "discard" | "return_to_inbox" | "follow_up_project" | "historical_incomplete";
```

- [ ] Define concrete interfaces for `CommandSource`, `InboxItem`, `Action`, `ProjectV2`, `ProjectHoldState`, `LegacyClosureProvenance`, `DirectionBrief`, `BetScope`, `BetVersion`, `ProjectWorkItem`, `ProjectDependency`, `ActualV2`, `PlanVersion`, `CapacityProfile`, `DailyCommitment`, `ReplanProposal`, `ReviewRecord`, `ExceptionRecord`, `CloseDecision`, `CommandProposal`, `SyncConflictRecord`, `CommandReceipt`, `LegacyAuditRecord`, `MigrationRecord`, `VisibilityPreferences`, and `WorkspaceV2`. `CommandSource` contains `sourceId`, `verified`, and explicit `SourceCapability[]`. Reuse `Resource`, `AttentionCapacity`, `Baseline`, and `Evidence` from `src/domain/types.ts`. Define `ProjectWorkItem` as `Omit<WorkItem, "shapeUpScopeId" | "isShapeUpCycleMarker">` plus `revision`, `betScopeId`, `resultStatus`, and `outcomeNote`; define `ProjectDependency` as the shared dependency shape plus `revision`; define `ActualV2` with `id`, `revision`, a typed Action-or-Work-Item target, actual/remaining seconds, cost, and recorded timestamp. `ProjectV2.holds` stores structured `ProjectHoldState` values with a hold type, source record, affected record IDs, and creation timestamp. `legacyClosure` is optional and valid only for a closed project migrated from an explicit V1 done/archived status with a matching immutable legacy record.

The core schema must use this concrete shape; fields may be split into adjacent files, but names and meanings remain stable:

```ts
import type {
  AttentionCapacity,
  Baseline,
  Dependency,
  Evidence,
  Id,
  ISODate,
  Resource,
  Seconds,
  WorkItem
} from "@/domain/types";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type TriageKind = "action" | "project";
export type ActionStatus = "open" | "completed" | "promoted";
export type ResultStatus = "completed" | "learned" | "blocked";
export type ReviewKind = "weekly" | "event";
export type ReviewStatus = "open" | "completed";

export interface CommandSource {
  sourceId: Id;
  verified: boolean;
  capabilities: SourceCapability[];
}

export interface TriageRecommendation {
  kind: TriageKind;
  ruleCodes: string[];
  explanation: string;
}

export interface InboxItem {
  id: Id;
  originalText: string;
  sourceId: Id;
  actorId: Id;
  capturedAt: ISODate;
  desiredDate?: ISODate;
  recommendation?: TriageRecommendation;
  triageStatus: "untriaged" | TriageKind;
  actionId?: Id;
  projectId?: Id;
}

export interface ActionEligibilityFacts {
  singleSession: boolean;
  estimateSeconds: Seconds;
  dependencyIds: Id[];
  requiresMilestoneEvidence: boolean;
  outcomeCount: number;
  solutionKnown: boolean;
}

export interface Action {
  id: Id;
  inboxItemId: Id;
  title: string;
  revision: number;
  status: ActionStatus;
  eligibility: ActionEligibilityFacts;
  attention: AttentionKind;
  desiredDate?: ISODate;
  fixedStart?: ISODate;
  outcomeNote?: string;
  promotedProjectId?: Id;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface ProjectHoldState {
  type: ProjectHold;
  sourceId: Id;
  affectedRecordIds: Id[];
  createdAt: ISODate;
}

export interface LegacyClosureProvenance {
  sourceStatus: "done" | "archived";
  legacyRecordId: Id;
  sourceChecksum: string;
}

export interface ProjectV2 {
  id: Id;
  name: string;
  priority: number;
  notes: string;
  stage: LifecycleStage;
  holds: ProjectHoldState[];
  activeDirectionBriefId: Id;
  activeBetId?: Id;
  activePlanVersionId?: Id;
  legacyClosure?: LegacyClosureProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface BetScope {
  id: Id;
  title: string;
  description: string;
}

export interface DirectionBrief {
  id: Id;
  projectId: Id;
  version: number;
  audienceAndProblem: string;
  successEvidence: string;
  appetiteSeconds: Seconds;
  validationMethod: string;
  firstScope: BetScope[];
  noGoOrKill: string;
  advancedNotes: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface BetVersion {
  id: Id;
  projectId: Id;
  version: number;
  briefId: Id;
  briefHash: string;
  briefSnapshot: DirectionBrief;
  committedScope: BetScope[];
  appetiteStart: ISODate;
  appetiteEnd: ISODate;
  actorId: Id;
  approvedAt: ISODate;
  supersedesId?: Id;
  sourceReviewId?: Id;
  invalidatedAt?: ISODate;
  invalidationReason?: string;
}

export type ProjectWorkItem = Omit<WorkItem, "shapeUpScopeId" | "isShapeUpCycleMarker"> & {
  revision: number;
  betScopeId: Id;
  resultStatus?: ResultStatus;
  outcomeNote?: string;
};

export type ProjectDependency = Dependency & { revision: number };

export interface ActualV2 {
  id: Id;
  revision: number;
  target: { kind: "action"; actionId: Id } | { kind: "work_item"; workItemId: Id };
  actualStart?: ISODate;
  actualFinish?: ISODate;
  actualWorkSeconds: Seconds;
  remainingWorkSeconds: Seconds;
  actualCost: number;
  recordedAt: ISODate;
}

export interface PlanVersion {
  id: Id;
  projectId: Id;
  version: number;
  betId: Id;
  workItemRevisions: Record<Id, number>;
  dependencyRevisions: Record<Id, number>;
  scopeMapping: Record<Id, Id>;
  scheduleHash: string;
  capacityIndependentDates: Record<Id, { start: ISODate; finish: ISODate }>;
  actorId: Id;
  createdAt: ISODate;
  supersedesId?: Id;
}

export interface CapacityProfile {
  timeZone: string;
  weeklyWindows: Array<{ weekday: Weekday; startMinute: number; finishMinute: number }>;
  dailyBudgets: Array<{ weekday: Weekday; deepSeconds: Seconds; mediumSeconds: Seconds; shallowSeconds: Seconds }>;
  unavailableBlocks: Array<{ id: Id; start: ISODate; finish: ISODate }>;
  updatedAt: ISODate;
  updatedBy: Id;
}

export interface CommitmentSlot {
  id: Id;
  target: { kind: "action"; actionId: Id } | { kind: "work_item"; workItemId: Id; projectId: Id };
  targetRevision: number;
  start: ISODate;
  finish: ISODate;
  attention: AttentionKind;
}

export interface DailyCommitment {
  id: Id;
  localDate: string;
  version: number;
  proposalHash: string;
  capacitySnapshot: CapacityProfile;
  slots: CommitmentSlot[];
  actorId: Id;
  committedAt: ISODate;
  supersedesId?: Id;
}

export interface ReplanProposal {
  id: Id;
  localDate: string;
  baseCommitmentId: Id;
  baseRevision: number;
  reasonCodes: string[];
  proposedSlots: CommitmentSlot[];
  proposalHash: string;
  createdAt: ISODate;
  createdBy: Id;
  status: "open" | "accepted" | "dismissed";
}

export interface ReviewConclusion {
  summary: string;
  decisionCodes: string[];
  followUpCommandIds: Id[];
}

export interface ReviewRecord {
  id: Id;
  kind: ReviewKind;
  triggerKey: string;
  triggerType: "weekly" | "bet_midpoint" | "bet_expired" | "evidence_stale" | "exception_expired" | "capacity_variance" | "hard_gate" | "sync_conflict";
  status: ReviewStatus;
  affectedProjectIds: Id[];
  affectedRecordIds: Id[];
  dueAt: ISODate;
  createdAt: ISODate;
  conclusion?: ReviewConclusion & { actorId: Id; completedAt: ISODate };
}

export interface ExceptionHistoryEntry {
  action: "created" | "resolved" | "expired";
  actorId: Id;
  at: ISODate;
  note: string;
}

export interface ExceptionRecord {
  id: Id;
  projectId: Id;
  requirementId: Id;
  rationale: string;
  knownConsequence: string;
  reviewAt: ISODate;
  expiresAt: ISODate;
  approvedBy: Id;
  createdAt: ISODate;
  resolvedAt?: ISODate;
  history: ExceptionHistoryEntry[];
}

export interface CloseDecision {
  id: Id;
  projectId: Id;
  successComparison: string;
  outcome: CloseOutcome;
  keyLearning: string;
  unfinishedDisposition: WorkDisposition;
  followUpProjectId?: Id;
  actorId: Id;
  closedAt: ISODate;
}

export interface CommandProposal {
  id: Id;
  commandType: "update_direction" | "create_work_item" | "update_work_item" | "propose_replan" | "upsert_dependency" | "remove_dependency";
  payload: JsonValue;
  baseRevision: number;
  rationale: string;
  agentActorId: Id;
  createdAt: ISODate;
  status: "open" | "accepted" | "dismissed" | "stale";
}

export interface SyncConflictRecord {
  id: Id;
  recordType: "bet" | "daily_commitment" | "review" | "exception" | "close";
  recordId: Id;
  projectId?: Id;
  commonAncestorHash: string;
  localValue: JsonValue;
  remoteValue: JsonValue;
  openedAt: ISODate;
  resolvedAt?: ISODate;
  retainedVersion?: "local" | "remote";
}

export interface AuditDiff {
  entity: string;
  entityId: Id;
  field: string;
  before: JsonValue;
  after: JsonValue;
}

export interface CommandReceipt {
  id: Id;
  commandId: Id;
  commandType: string;
  baseRevision: number;
  revision: number;
  payloadHash: string;
  receiptHash: string;
  actorId: Id;
  actorKind: ActorKind;
  origin: CommandOrigin;
  source: CommandSource;
  status: "applied" | "rejected";
  createdAt: ISODate;
  diff: AuditDiff[];
  rejectionCode?: string;
}

export interface LegacyAuditRecord {
  id: Id;
  projectId: Id;
  recordType: "decision" | "audit_decision" | "audit_gate" | "change_set" | "shape_up_pitch" | "legacy_closure";
  sourcePayload: JsonValue;
  sourceChecksum: string;
}

export interface MigrationRecord {
  sourceSchemaVersion: 1;
  sourceChecksum: string;
  backupId: Id;
  backupChecksum: string;
  migratedAt: ISODate;
  entityCounts: Record<string, number>;
  deterministicIdMap: Record<string, Id>;
}

export interface VisibilityPreferences {
  archivedProjectIds: Id[];
}

export interface WorkspaceV2 {
  schemaVersion: 2;
  workspaceId: Id;
  revision: number;
  capacityProfile?: CapacityProfile;
  inboxItems: InboxItem[];
  actions: Action[];
  projects: ProjectV2[];
  directionBriefs: DirectionBrief[];
  bets: BetVersion[];
  planVersions: PlanVersion[];
  dailyCommitments: DailyCommitment[];
  replanProposals: ReplanProposal[];
  reviews: ReviewRecord[];
  exceptions: ExceptionRecord[];
  closeDecisions: CloseDecision[];
  commandProposals: CommandProposal[];
  syncConflicts: SyncConflictRecord[];
  commandReceipts: CommandReceipt[];
  workItems: ProjectWorkItem[];
  dependencies: ProjectDependency[];
  resources: Resource[];
  capacities: AttentionCapacity[];
  baselines: Baseline[];
  evidence: Evidence[];
  actuals: ActualV2[];
  legacyAuditRecords: LegacyAuditRecord[];
  visibility: VisibilityPreferences;
  migration?: MigrationRecord;
}
```

- [ ] Implement `stableHash` as canonical stable JSON plus Web Crypto SHA-256. Keep the monotonic numeric Workspace revision for compare-and-swap, and use SHA-256 for brief, plan, proposal, payload, receipt, and immutable-record hashes. The function returns `Promise<string>`; never substitute a 32-bit non-cryptographic hash for an invariant-critical comparison.

```ts
function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export async function stableHash(value: JsonValue): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

- [ ] Add builder functions that require explicit IDs and timestamps. Tests must never depend on `Date.now()`, random UUIDs, or the local timezone.

- [ ] Run `bunx vitest run src/v2/domain/workspace.test.ts` and `bun run build`.

Expected: PASS; TypeScript reports no missing collection or incompatible shared calculation type.

- [ ] Commit:

```bash
git add src/v2/domain/types.ts src/v2/domain/workspace.ts src/v2/domain/stableHash.ts src/v2/domain/workspace.test.ts src/v2/tests/builders.ts
git -c commit.gpgsign=false commit -m "feat: define V2 workspace schema"
```

### Task 3: Implement the lifecycle state machine without raw status setters

**Files:**

- Create: `src/v2/domain/lifecycle.ts`
- Create: `src/v2/domain/lifecycle.test.ts`

- [ ] Add a table-driven test for every legal transition and representative illegal transition. The legal events are:

```ts
const legalTransitions = [
  ["direction", "brief_completed", "awaiting_bet"],
  ["awaiting_bet", "brief_became_incomplete", "direction"],
  ["awaiting_bet", "bet_placed", "planning"],
  ["planning", "bet_replaced", "planning"],
  ["executing", "bet_replaced", "planning"],
  ["validating", "bet_replaced", "planning"],
  ["planning", "first_project_work_committed", "executing"],
  ["planning", "closure_requested", "validating"],
  ["planning", "appetite_expired", "validating"],
  ["executing", "validation_requested", "validating"],
  ["executing", "appetite_expired", "validating"],
  ["validating", "validation_satisfied", "closing"],
  ["validating", "abandon_confirmed", "closing"],
  ["closing", "project_closed", "closed"]
] as const;
```

- [ ] Add tests that `direction -> executing`, `awaiting_bet -> planning` without `bet_placed`, every transition out of `closed`, and any `set_stage`-style event return `ILLEGAL_LIFECYCLE_TRANSITION` without mutating the project.

- [ ] Run `bunx vitest run src/v2/domain/lifecycle.test.ts`.

Expected: FAIL because `transitionLifecycle` does not exist.

- [ ] Implement a pure `transitionLifecycle(project, event)` that returns either `{ ok: true, project }` or a typed transition rejection. Export no generic stage setter. Keep holds orthogonal; the transition function may remove only the hold explicitly resolved by its event.

```ts
export type LifecycleEvent =
  | "brief_completed"
  | "brief_became_incomplete"
  | "bet_placed"
  | "bet_replaced"
  | "first_project_work_committed"
  | "closure_requested"
  | "validation_requested"
  | "appetite_expired"
  | "validation_satisfied"
  | "abandon_confirmed"
  | "project_closed";

const transitions: Record<LifecycleStage, Partial<Record<LifecycleEvent, LifecycleStage>>> = {
  direction: { brief_completed: "awaiting_bet" },
  awaiting_bet: { brief_became_incomplete: "direction", bet_placed: "planning" },
  planning: {
    bet_replaced: "planning",
    first_project_work_committed: "executing",
    closure_requested: "validating",
    appetite_expired: "validating"
  },
  executing: {
    bet_replaced: "planning",
    validation_requested: "validating",
    appetite_expired: "validating"
  },
  validating: { bet_replaced: "planning", validation_satisfied: "closing", abandon_confirmed: "closing" },
  closing: { project_closed: "closed" },
  closed: {}
};

export function transitionLifecycle(project: ProjectV2, event: LifecycleEvent) {
  const stage = transitions[project.stage][event];
  if (!stage) {
    return { ok: false as const, code: "ILLEGAL_LIFECYCLE_TRANSITION" as const, project };
  }
  return { ok: true as const, project: { ...project, stage } };
}
```

- [ ] Add appetite-boundary behavior: `appetite_expired` advances an executing project to `validating` and does not extend or replace the Bet.

- [ ] Run the focused test and `bun run build`.

Expected: all lifecycle matrix rows pass, and searching `src/v2` for `stage =` or `{ ...project, stage:` only finds `lifecycle.ts` and test builders.

- [ ] Commit:

```bash
git add src/v2/domain/lifecycle.ts src/v2/domain/lifecycle.test.ts
git -c commit.gpgsign=false commit -m "feat: enforce V2 lifecycle transitions"
```

### Task 4: Add typed rejections, authorization policy, and workspace invariants

**Files:**

- Create: `src/v2/domain/errors.ts`
- Create: `src/v2/domain/policy.ts`
- Create: `src/v2/domain/invariants.ts`
- Create: `src/v2/domain/policy.test.ts`
- Create: `src/v2/domain/invariants.test.ts`

- [ ] Write policy tests for the complete authority matrix:

| Capability | Human actor | Agent actor | System actor |
| --- | --- | --- | --- |
| capture Inbox | apply | apply | reject; import uses current human or verified Agent source |
| record actual | apply | apply | reject; sync replay retains the original human/Agent actor |
| attach supplied evidence | apply | apply | reject; sync replay retains the original human/Agent actor |
| draft Direction/plan/replan/dependency/scope | apply | proposal only | reject |
| record due Bet/Review time event | reject | reject | apply with deterministic trigger key |
| confirm triage | apply | reject | reject |
| place Bet/Re-bet | apply | reject | reject |
| Commit Today/accept Replan | apply | reject | reject |
| approve exception | apply | reject | reject |
| conclude Review | apply | reject | reject |
| Close | apply | reject | reject |

Origin is recorded independently from actor kind. `origin: "sync"` or `origin: "import"` never upgrades a system or Agent actor. Migration is the sole direct-construction path and is constrained by Task 17's migration validator rather than normal mutation commands.

- [ ] Assert stable rejection fields, including this human-only example:

```ts
expect(rejection).toMatchObject({
  code: "HUMAN_CONFIRMATION_REQUIRED",
  reason: "Only a human can place or replace a Bet.",
  permittedNextCommand: "place_bet",
  actorKind: "agent",
  origin: "agent"
});
```

- [ ] Add source-capability tests before actor tests. An unverified Agent source or a verified source missing `record_actual`, `attach_evidence`, or `submit_proposal` receives `SOURCE_NOT_AUTHORIZED` even when the payload and actor kind would otherwise be allowed. UI, sync replay, and system-time adapters must supply a verified source with the narrow capability they use.

- [ ] Add invariant tests that reject work execution without a current Bet, over-capacity commitments, missing Bet scope mappings, multiple active Bets for one project, expired exceptions treated as active, mutation after Close, and dangling entity references.

- [ ] Run both focused tests.

Expected: FAIL because policy and invariant modules do not exist.

- [ ] Implement `CommandRejection` as a serializable object with `code`, `reason`, optional `gate`, optional `hold`, `permittedNextCommand`, `actorKind`, `origin`, and unchanged `workspaceRevision`.

```ts
export type RejectionCode =
  | "REVISION_CONFLICT"
  | "DUPLICATE_COMMAND"
  | "SOURCE_NOT_AUTHORIZED"
  | "ACTOR_NOT_AUTHORIZED"
  | "HUMAN_CONFIRMATION_REQUIRED"
  | "ILLEGAL_LIFECYCLE_TRANSITION"
  | "HOLD_BLOCKS_COMMAND"
  | "BRIEF_INCOMPLETE"
  | "BET_REQUIRED"
  | "BET_EXPIRED"
  | "SCOPE_OUTSIDE_BET"
  | "ACTION_INELIGIBLE"
  | "ACTION_PROMOTION_REQUIRED"
  | "CAPACITY_EXCEEDED"
  | "EVIDENCE_REQUIRED"
  | "EXCEPTION_EXPIRED"
  | "REVIEW_OVERDUE"
  | "SYNC_CONFLICT"
  | "PROJECT_CLOSED"
  | "ENTITY_NOT_FOUND"
  | "COMMAND_NOT_IMPLEMENTED";

export interface CommandRejection {
  code: RejectionCode;
  reason: string;
  gate?: string;
  hold?: ProjectHold;
  permittedNextCommand: string;
  actorKind: ActorKind;
  origin: CommandOrigin;
  workspaceRevision: number;
}
```

- [ ] Implement `authorizeCommand` and `validateWorkspaceInvariants` as pure functions. Authorization order is verified source -> source capability -> actor authority -> command preconditions. Do not encode policy in UI labels or disabled-button expressions.

```ts
const humanOnly = new Set([
  "confirm_action_triage",
  "confirm_project_triage",
  "place_bet",
  "commit_today",
  "accept_replan",
  "approve_evidence_exception",
  "complete_review",
  "resolve_sync_conflict",
  "accept_command_proposal",
  "dismiss_command_proposal",
  "close_project",
  "abandon_project"
]);
const agentAutomatic = new Set(["capture_inbox", "record_actual", "attach_evidence"]);
const agentProposal = new Set(["submit_command_proposal"]);
const systemOnly = new Set(["record_bet_boundary", "mark_review_overdue", "create_review", "open_sync_conflict"]);

export function authorizeCommand(commandType: string, context: CommandContext): CommandRejection | undefined {
  if (!context.source.verified) return rejection("SOURCE_NOT_AUTHORIZED", context, "Use a verified command source.");
  if (context.origin === "sync" && !context.source.capabilities.includes("replay_receipt")) {
    return rejection("SOURCE_NOT_AUTHORIZED", context, "Replay an intact applied receipt.");
  }
  if (context.origin === "import" && !context.source.capabilities.includes("import_portable")) {
    return rejection("SOURCE_NOT_AUTHORIZED", context, "Use the validated portable-command importer.");
  }
  if (context.origin === "import" && humanOnly.has(commandType)) {
    return rejection("HUMAN_CONFIRMATION_REQUIRED", context, "Confirm this decision in OmniPlan.");
  }
  if (systemOnly.has(commandType)) {
    const allowedCapabilities: SourceCapability[] = commandType === "open_sync_conflict"
      ? ["open_conflict"]
      : commandType === "create_review"
        ? ["system_time", "open_conflict"]
        : ["system_time"];
    return context.actorKind === "system" && allowedCapabilities.some((capability) => context.source.capabilities.includes(capability))
      ? undefined
      : rejection("ACTOR_NOT_AUTHORIZED", context, "Use the verified system event or conflict source.");
  }
  if (context.actorKind === "agent") {
    const required = commandType === "capture_inbox"
      ? "capture_inbox"
      : commandType === "record_actual"
        ? "record_actual"
        : commandType === "attach_evidence"
          ? "attach_evidence"
          : "submit_proposal";
    if (!context.source.capabilities.includes(required)) {
      return rejection("SOURCE_NOT_AUTHORIZED", context, `Grant the ${required} source capability.`);
    }
    const allowed = agentAutomatic.has(commandType) || agentProposal.has(commandType);
    return allowed ? undefined : rejection("HUMAN_CONFIRMATION_REQUIRED", context, "Ask a human to confirm this command.");
  }
  if (context.actorKind === "human" && context.origin !== "sync" && !context.source.capabilities.includes("human_decision")) {
    return rejection("SOURCE_NOT_AUTHORIZED", context, "Use the verified human UI session.");
  }
  if (humanOnly.has(commandType) && context.actorKind !== "human") {
    return rejection("HUMAN_CONFIRMATION_REQUIRED", context, "Ask a human to confirm this command.");
  }
  if (context.actorKind === "system") {
    return rejection("ACTOR_NOT_AUTHORIZED", context, "Use an explicit system-only command.");
  }
  return undefined;
}
```

The `rejection` helper maps each stable code to the task-specific `permittedNextCommand`; tests assert the exact mapping rather than accepting generic text.

- [ ] Encode hold effects centrally:

  - `migration_review`: only migration-review brief edits and human `place_bet` may change the affected project.
  - `rebet_required`: Direction drafting and human `place_bet` are allowed; plan/execution writes are blocked.
  - `review_overdue`: existing committed work may record actuals/evidence; new Bet, new project work commitment, scope expansion, and Replan acceptance are blocked.
  - `sync_conflict`: affected records are immutable until a human conflict-resolution command succeeds.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/errors.ts src/v2/domain/policy.ts src/v2/domain/invariants.ts src/v2/domain/policy.test.ts src/v2/domain/invariants.test.ts
git -c commit.gpgsign=false commit -m "feat: centralize V2 policy and invariants"
```

### Task 5: Build the pure command engine and immutable receipts

**Files:**

- Create: `src/v2/domain/commands.ts`
- Create: `src/v2/domain/commandHandlers.ts`
- Create: `src/v2/domain/commands.test.ts`

- [ ] Define the full command union in the test before implementing the dispatcher:

```ts
export type ActionDraft = Pick<Action, "id" | "title" | "eligibility" | "attention" | "desiredDate" | "fixedStart">;
export type ActionPatch = Partial<Pick<Action, "title" | "eligibility" | "attention" | "desiredDate" | "fixedStart">>;
export interface ProjectDraft { id: Id; name: string; priority: number; notes: string }
export type DirectionBriefDraft = Omit<DirectionBrief, "id" | "version" | "createdAt" | "updatedAt"> & { id: Id };
export type WorkItemPatch = Partial<Omit<ProjectWorkItem, "id" | "projectId" | "revision" | "betScopeId">> & { betScopeId?: Id };
export interface DailyCommitmentDraft {
  id: Id;
  localDate: string;
  proposalHash: string;
  slots: CommitmentSlot[];
}
export type ExceptionDraft = Omit<ExceptionRecord, "approvedBy" | "createdAt" | "resolvedAt" | "history">;
export type ReviewDraft = Omit<ReviewRecord, "status" | "createdAt" | "conclusion">;
export interface ConflictResolution {
  conflictId: Id;
  retainedVersion: "local" | "remote";
  reappliedCommandId?: Id;
  rationale: string;
}
export type CloseDecisionDraft = Omit<CloseDecision, "actorId" | "closedAt">;

export type V2Command =
  | { type: "configure_capacity"; profile: CapacityProfile }
  | { type: "capture_inbox"; id: Id; text: string; desiredDate?: ISODate }
  | { type: "confirm_action_triage"; inboxItemId: Id; action: ActionDraft }
  | { type: "confirm_project_triage"; inboxItemId: Id; project: ProjectDraft }
  | { type: "update_project_metadata"; projectId: Id; name?: string; priority?: number; notes?: string }
  | { type: "update_action"; actionId: Id; patch: ActionPatch }
  | { type: "complete_action"; actionId: Id; actualSeconds: number; outcomeNote: string }
  | { type: "promote_action_to_project"; actionId: Id; project: ProjectDraft }
  | { type: "update_direction"; projectId: Id; brief: DirectionBriefDraft }
  | { type: "place_bet"; projectId: Id; betId: Id; start: ISODate }
  | { type: "create_work_item"; projectId: Id; workItem: ProjectWorkItem }
  | { type: "update_work_item"; projectId: Id; workItemId: Id; patch: WorkItemPatch }
  | { type: "propose_replan"; proposal: ReplanProposal }
  | { type: "commit_today"; commitment: DailyCommitmentDraft }
  | { type: "accept_replan"; proposalId: Id; commitmentId: Id }
  | { type: "record_actual"; actual: ActualV2 }
  | { type: "attach_evidence"; evidence: Evidence }
  | { type: "approve_evidence_exception"; exception: ExceptionDraft }
  | { type: "resolve_evidence_exception"; exceptionId: Id; resolution: string }
  | { type: "request_validation"; projectId: Id }
  | { type: "satisfy_validation"; projectId: Id }
  | { type: "record_bet_boundary"; projectId: Id; boundary: "midpoint" | "expired"; triggerKey: string }
  | { type: "mark_review_overdue"; reviewId: Id; triggerKey: string }
  | { type: "create_review"; review: ReviewDraft }
  | { type: "complete_review"; reviewId: Id; conclusion: ReviewConclusion }
  | { type: "resolve_sync_conflict"; reviewId: Id; resolution: ConflictResolution }
  | { type: "close_project"; projectId: Id; decision: CloseDecisionDraft }
  | { type: "abandon_project"; projectId: Id; decision: CloseDecisionDraft & { outcome: "abandoned" } }
  | { type: "archive_project"; projectId: Id; archived: boolean };
```

- [ ] Test one accepted no-op-sized command and one rejected command. Assert the accepted path increments revision once and appends exactly one receipt; the rejected path preserves object equality and revision and returns a rejection receipt without persisting partial entity changes.

- [ ] Assert every receipt contains `commandId`, `commandType`, `baseRevision`, resulting `revision`, canonical `payloadHash`, `receiptHash`, actor ID/kind, origin, verified source ID/capabilities, timestamp, status, and audit diff. These replay fields are immutable and are the only human-authority input Task 18 may accept from sync.

- [ ] Run `bunx vitest run src/v2/domain/commands.test.ts`.

Expected: FAIL because `executeCommand` does not exist.

- [ ] Implement this public contract:

```ts
export interface CommandContext {
  commandId: string;
  expectedRevision: number;
  actorId: string;
  actorKind: ActorKind;
  origin: CommandOrigin;
  source: CommandSource;
  now: ISODate;
}

export type CommandResult =
  | { ok: true; workspace: WorkspaceV2; receipt: CommandReceipt }
  | { ok: false; workspace: WorkspaceV2; receipt: CommandReceipt; rejection: CommandRejection };

export async function executeCommand(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext
): Promise<CommandResult>;
```

- [ ] Make the execution order exactly: reject stale/duplicate command -> authorize -> execute handler against a cloned value -> validate invariants -> compute audit diff -> increment revision -> append receipt. Rejections use the original workspace reference and original revision. Receipt IDs and timestamps come from `CommandContext.commandId` and `CommandContext.now`, never ambient time.

```ts
export async function executeCommand(
  workspace: WorkspaceV2,
  command: V2Command,
  context: CommandContext
): Promise<CommandResult> {
  if (context.expectedRevision !== workspace.revision) {
    return rejectedResult(workspace, command, context, "REVISION_CONFLICT");
  }
  if (workspace.commandReceipts.some((receipt) => receipt.commandId === context.commandId)) {
    return rejectedResult(workspace, command, context, "DUPLICATE_COMMAND");
  }
  const authorization = authorizeCommand(command.type, context);
  if (authorization) return rejectedResult(workspace, command, context, authorization.code, authorization);

  const candidate = await applyCommandHandler(structuredClone(workspace), command, context);
  if (!candidate.ok) return rejectedResult(workspace, command, context, candidate.rejection.code, candidate.rejection);

  const violations = validateWorkspaceInvariants(candidate.workspace, context.now);
  if (violations.length > 0) {
    return rejectedResult(workspace, command, context, violations[0].code, violations[0]);
  }

  const nextRevision = workspace.revision + 1;
  const diff = diffWorkspace(workspace, candidate.workspace);
  const payloadHash = await stableHash(command as unknown as JsonValue);
  const receiptBase = {
    id: context.commandId,
    commandId: context.commandId,
    commandType: command.type,
    baseRevision: workspace.revision,
    revision: nextRevision,
    payloadHash,
    actorId: context.actorId,
    actorKind: context.actorKind,
    origin: context.origin,
    source: context.source,
    status: "applied" as const,
    createdAt: context.now,
    diff
  };
  const receipt: CommandReceipt = {
    ...receiptBase,
    receiptHash: await stableHash(receiptBase as unknown as JsonValue)
  };
  const next = { ...candidate.workspace, revision: nextRevision, commandReceipts: [...candidate.workspace.commandReceipts, receipt] };
  return { ok: true, workspace: next, receipt };
}
```

`rejectedResult` always returns the original Workspace reference and creates an external rejection receipt at the unchanged revision; it never appends to `workspace.commandReceipts`.

- [ ] Implement `applyCommandHandler` as an async exhaustive switch because Bet, Plan, proposal, and receipt construction use SHA-256. Implement only `configure_capacity` and `capture_inbox` handlers in this task; every other recognized command returns `COMMAND_NOT_IMPLEMENTED`, which makes later behavior additions explicit and test-first.

- [ ] Run focused tests and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/commands.ts src/v2/domain/commandHandlers.ts src/v2/domain/commands.test.ts
git -c commit.gpgsign=false commit -m "feat: add atomic V2 command engine"
```

### Task 6: Enforce Inbox capture, Action eligibility, and promotion

**Files:**

- Create: `src/v2/domain/actionPolicy.ts`
- Create: `src/v2/domain/actionPolicy.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`
- Modify: `src/v2/domain/commands.test.ts`

- [ ] Write tests for all eligibility boundaries: one session, `estimateSeconds <= 7200`, no dependency, no milestone evidence, one outcome, and known solution path. Assert each failed condition returns a human-readable reason and recommends Project.

- [ ] Add command tests proving:

  - `capture_inbox` creates only an Inbox item;
  - human `confirm_action_triage` creates an Action and marks the Inbox item triaged;
  - human `confirm_project_triage` atomically creates a Direction-stage Project plus its empty active DirectionBrief and marks the Inbox item triaged;
  - Agent triage confirmation is rejected;
  - an Action update that adds a dependency, requires evidence, creates multiple outcomes, marks the solution uncertain, or exceeds 7,200 seconds returns `ACTION_PROMOTION_REQUIRED`;
  - an Action ID cannot be used by a dependency, Gantt Work Item, Baseline, project Evidence milestone, Bet, or Close command;
  - `promote_action_to_project` preserves the Inbox ID, Action history, actuals, and outcome notes while creating a Direction-stage project.

- [ ] Run `bunx vitest run src/v2/domain/actionPolicy.test.ts src/v2/domain/commands.test.ts`.

Expected: FAIL on the unimplemented triage and promotion handlers.

- [ ] Implement `evaluateActionEligibility` as a deterministic rule list with stable codes. Store the recommendation and reasons on the Inbox item, but require a human confirmation command to classify it.

```ts
const actionRules = [
  { code: "ONE_SESSION", valid: (facts: ActionEligibilityFacts) => facts.singleSession, reason: "Needs more than one working session." },
  { code: "TWO_HOUR_LIMIT", valid: (facts: ActionEligibilityFacts) => facts.estimateSeconds <= 7_200, reason: "Estimate exceeds two hours." },
  { code: "NO_DEPENDENCY", valid: (facts: ActionEligibilityFacts) => facts.dependencyIds.length === 0, reason: "Has a dependency." },
  { code: "NO_MILESTONE_EVIDENCE", valid: (facts: ActionEligibilityFacts) => !facts.requiresMilestoneEvidence, reason: "Requires milestone evidence." },
  { code: "ONE_OUTCOME", valid: (facts: ActionEligibilityFacts) => facts.outcomeCount === 1, reason: "Contains multiple outcomes." },
  { code: "KNOWN_SOLUTION", valid: (facts: ActionEligibilityFacts) => facts.solutionKnown, reason: "Solution path is uncertain." }
] as const;

export function evaluateActionEligibility(facts: ActionEligibilityFacts): TriageRecommendation {
  const failed = actionRules.filter((rule) => !rule.valid(facts));
  return {
    kind: failed.length === 0 ? "action" : "project",
    ruleCodes: failed.map((rule) => rule.code),
    explanation: failed.length === 0 ? "Fits the lightweight Action boundary." : failed.map((rule) => rule.reason).join(" ")
  };
}
```

- [ ] Implement the Action/triage handlers. A promoted Action becomes `status: "promoted"`, stores `promotedProjectId`, and atomically creates the new Project plus empty active DirectionBrief; do not delete it or rewrite its capture history.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/actionPolicy.ts src/v2/domain/actionPolicy.test.ts src/v2/domain/commandHandlers.ts src/v2/domain/commands.test.ts
git -c commit.gpgsign=false commit -m "feat: enforce Action eligibility and promotion"
```

### Task 7: Implement the six-decision Direction brief and human Bet

**Files:**

- Create: `src/v2/domain/direction.ts`
- Create: `src/v2/domain/direction.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`
- Modify: `src/v2/domain/commands.test.ts`

- [ ] Add tests for the six required material decisions: `audienceAndProblem`, `successEvidence`, `appetiteSeconds`, `validationMethod`, `firstScope`, and `noGoOrKill`. Empty strings, non-positive appetite, and an empty first-scope list keep the project in `direction`.

- [ ] Add tests that a complete brief moves a Direction-stage project to `awaiting_bet`, but does not synthesize a Bet.

- [ ] Add Bet tests that require a human actor and store an immutable brief snapshot, SHA-256 brief hash, committed scope, appetite start/end, actor, and approval timestamp. Verify Agent and system actors receive `HUMAN_CONFIRMATION_REQUIRED` for every origin. A human actor produces the same valid policy result for `ui` and for Task 18's verified sync replay; origin never supplies authority.

- [ ] Run `bunx vitest run src/v2/domain/direction.test.ts src/v2/domain/commands.test.ts`.

Expected: FAIL on `update_direction` and `place_bet`.

- [ ] Implement `directionCompleteness`, `isMaterialDirectionChange`, and `buildBetVersion`. Compute `appetiteEnd` from `appetiteSeconds`; never infer or extend it from task estimates.

```ts
export function directionCompleteness(brief: DirectionBriefDraft) {
  return {
    audienceAndProblem: brief.audienceAndProblem.trim().length > 0,
    successEvidence: brief.successEvidence.trim().length > 0,
    appetite: Number.isFinite(brief.appetiteSeconds) && brief.appetiteSeconds > 0,
    validationMethod: brief.validationMethod.trim().length > 0,
    firstScope: brief.firstScope.length > 0 && brief.firstScope.every((scope) => scope.title.trim().length > 0),
    noGoOrKill: brief.noGoOrKill.trim().length > 0
  };
}

export function isDirectionComplete(brief: DirectionBriefDraft): boolean {
  return Object.values(directionCompleteness(brief)).every(Boolean);
}

export async function buildBetVersion(brief: DirectionBrief, input: { id: Id; version: number; actorId: Id; approvedAt: ISODate; supersedesId?: Id }) {
  return {
    id: input.id,
    projectId: brief.projectId,
    version: input.version,
    briefId: brief.id,
    briefHash: await stableHash(brief as unknown as JsonValue),
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: input.approvedAt,
    appetiteEnd: new Date(new Date(input.approvedAt).getTime() + brief.appetiteSeconds * 1_000).toISOString(),
    actorId: input.actorId,
    approvedAt: input.approvedAt,
    supersedesId: input.supersedesId
  } satisfies BetVersion;
}
```

- [ ] Implement handlers so saved incomplete drafts remain editable, a complete draft derives `awaiting_bet`, and human `place_bet` creates version 1 and advances to `planning`.

- [ ] Run focused tests and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/direction.ts src/v2/domain/direction.test.ts src/v2/domain/commandHandlers.ts src/v2/domain/commands.test.ts
git -c commit.gpgsign=false commit -m "feat: require Direction and human Bet"
```

### Task 8: Enforce Re-bet and appetite-boundary decisions

**Files:**

- Modify: `src/v2/domain/direction.ts`
- Modify: `src/v2/domain/lifecycle.ts`
- Modify: `src/v2/domain/commandHandlers.ts`
- Create: `src/v2/domain/rebet.test.ts`

- [ ] Write tests proving every material brief field invalidates an active Bet, sets its `invalidatedAt` and `invalidationReason`, adds `rebet_required`, and stops new and continuing execution commands. Test all six fields independently.

- [ ] Add negative tests proving the command-only `update_project_metadata` path for project name, priority, formatting, and optional notes is editorial and does not invalidate the Bet.

- [ ] Add tests for human Re-bet from planning, executing, and validating: the previous Bet remains immutable, a new version points to the superseded Bet, the hold is removed, the project returns to `planning`, and the new appetite is calculated from the new approval time.

- [ ] Add tests for appetite midpoint and expiry. Expiry must stop new scheduling immediately, transition planning or executing work to `validating`, create an event Review input, and permit only a human Close, Re-bet, or `abandon_project` path. `abandon_project` still requires the structured comparison, learning, and unfinished-work disposition with outcome `abandoned`. No command may edit `appetiteEnd` on an existing Bet.

- [ ] Run `bunx vitest run src/v2/domain/rebet.test.ts`.

Expected: FAIL because a material update currently overwrites the brief without invalidating the Bet.

- [ ] Implement material-edit invalidation as one atomic command transition. Store the old brief and Bet; never rewrite history.

```ts
const materialDirectionFields = [
  "audienceAndProblem",
  "successEvidence",
  "appetiteSeconds",
  "validationMethod",
  "firstScope",
  "noGoOrKill"
] as const;

export async function isMaterialDirectionChange(before: DirectionBrief, after: DirectionBrief): Promise<boolean> {
  return (await stableHash(Object.fromEntries(materialDirectionFields.map((field) => [field, before[field]])) as JsonValue))
    !== (await stableHash(Object.fromEntries(materialDirectionFields.map((field) => [field, after[field]])) as JsonValue));
}
```

- [ ] Implement `evaluateBetBoundary(workspace, now)` as a pure event producer. It may propose commands or Review triggers but must not silently extend or replace a Bet.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/direction.ts src/v2/domain/lifecycle.ts src/v2/domain/commandHandlers.ts src/v2/domain/rebet.test.ts
git -c commit.gpgsign=false commit -m "feat: require Re-bet for material change"
```

### Task 9: Enforce Bet scope and adapt the existing planning engines

**Files:**

- Create: `src/v2/domain/planning.ts`
- Create: `src/v2/domain/planning.test.ts`
- Create: `src/v2/projections/schedulerAdapter.ts`
- Create: `src/v2/projections/recurringAdapter.ts`
- Create: `src/v2/projections/reportingAdapter.ts`
- Create: `src/v2/projections/projectionAdapters.test.ts`
- Modify: `src/v2/domain/commands.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Extend `V2Command` with concrete planning commands:

```ts
  | { type: "upsert_dependency"; dependency: ProjectDependency }
  | { type: "remove_dependency"; dependencyId: Id }
  | { type: "remove_work_item"; projectId: Id; workItemId: Id }
  | { type: "capture_baseline"; baseline: Baseline }
  | { type: "complete_work_item"; projectId: Id; workItemId: Id; resultStatus: "completed" | "learned" | "blocked"; outcomeNote: string };
```

- [ ] Write tests that reject plan mutations before a valid Bet, during `migration_review`, during `rebet_required`, after appetite expiry, and after Close.

- [ ] Write tests that every project Work Item has a `betScopeId` contained in the active Bet. Refinement inside that scope is allowed; an unknown or superseded scope returns `SCOPE_OUTSIDE_BET` and recommends `update_direction`.

- [ ] Characterize projection parity by building a V1-shaped project, work-item, and dependency set, running `scheduleProject`, then asserting `scheduleV2Project` produces the same scheduled IDs, dates, critical flags, and diagnostics.

- [ ] Add projection-policy tests proving unbet, expired, `migration_review`, and `rebet_required` project work is absent from new executable scheduling. `review_overdue` retains items already in the current Daily Commitment, and `sync_conflict` removes only work whose Project/Bet/Plan/Commitment record ID is listed in the structured hold. Ensure the adapter always supplies a valid `start` so the existing scheduler never falls back to ambient `new Date()`.

- [ ] Add reporting adapter tests for the existing EVM, Monte Carlo, recurring, and baseline functions. The adapters may reshape data but must call the existing modules under `src/domain/`; do not copy their algorithms.

- [ ] Run:

```bash
bunx vitest run src/v2/domain/planning.test.ts src/v2/projections/projectionAdapters.test.ts
```

Expected: FAIL because planning handlers and adapters do not exist.

- [ ] Implement plan preconditions, scope mapping, work-item revisions, dependency revisions, and projection adapters. Keep cross-project dependency edges out of V2 because the shared `Dependency` model is project-scoped; show an explicit unsupported diagnostic instead of silently inventing support.

```ts
export function projectToSchedulerInput(workspace: WorkspaceV2, project: ProjectV2) {
  const bet = workspace.bets.find((candidate) => candidate.id === project.activeBetId && !candidate.invalidatedAt);
  const brief = workspace.directionBriefs.find((candidate) => candidate.id === project.activeDirectionBriefId);
  if (!bet || !brief) return undefined;
  return {
    id: project.id,
    name: project.name,
    status: "active" as const,
    mode: "build" as const,
    priority: project.priority,
    northStar: brief.successEvidence,
    currentOutcome: brief.audienceAndProblem,
    horizon: bet.appetiteEnd,
    start: bet.appetiteStart,
    reviewCadenceDays: 7
  };
}

export function workItemToSchedulerInput(item: ProjectWorkItem): WorkItem {
  const { revision, betScopeId, resultStatus, outcomeNote, ...shared } = item;
  return { ...shared, shapeUpScopeId: betScopeId };
}
```

`scheduleExecutablePortfolio` calls the existing `scheduleProject`/`schedulePortfolio` functions with only these projections and maps results back by preserved IDs. Reporting maps `ActualV2` Work Item targets to the existing `Actual` shape and excludes Action targets.

- [ ] Run focused tests, all existing scheduler/recurring/risk tests, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/planning.ts src/v2/domain/planning.test.ts src/v2/domain/commands.ts src/v2/domain/commandHandlers.ts src/v2/projections
git -c commit.gpgsign=false commit -m "feat: project Bet scope into planning engines"
```

### Task 10: Generate a deterministic capacity-safe Today proposal

**Files:**

- Create: `src/v2/domain/localTime.ts`
- Create: `src/v2/domain/today.ts`
- Create: `src/v2/domain/today.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Write capacity-profile tests for weekly working windows, Deep/Medium/Shallow budgets per weekday, fixed unavailable blocks, invalid overlapping windows, and explicit timezone handling. Cover `Asia/Tokyo` and a daylight-saving boundary in `America/New_York`.

- [ ] Write Today eligibility tests covering Actions and project Work Items. Exclude unmet dependencies, unbet or expired projects, `migration_review`, `rebet_required`, completed items, and work exceeding remaining time or attention capacity. Preserve already committed work under `review_overdue`; for `sync_conflict`, exclude only affected record IDs and allow unrelated records to remain eligible.

- [ ] Assert the exact deterministic ordering:

```text
fixed time or hard deadline
appetite expiry and critical-path urgency
dependency-unlock value
project priority
oldest eligible work
stable entity ID tie-breaker
```

- [ ] Assert overflow remains in `Later` with a stable reason such as `DEEP_CAPACITY_EXHAUSTED`, `OUTSIDE_WORK_WINDOW`, `DEPENDENCY_BLOCKED`, or `BET_EXPIRED`; nothing is silently dropped.

- [ ] Run `bunx vitest run src/v2/domain/today.test.ts`.

Expected: FAIL because `generateTodayProposal` does not exist.

- [ ] Implement `configure_capacity` validation and `generateTodayProposal(workspace, localDate, now)`. Return a pure proposal containing ordered slots, capacity usage by attention class, Later entries, and reasons. Do not create a Daily Commitment or move lifecycle stages during generation.

```ts
export interface TodayCandidate {
  targetId: Id;
  targetRevision: number;
  target: CommitmentSlot["target"];
  durationSeconds: Seconds;
  attention: AttentionKind;
  hasFixedTimeOrHardDeadline: boolean;
  appetiteAndCriticalUrgency: number;
  dependencyUnlockValue: number;
  projectPriority: number;
  eligibleSince: ISODate;
}

export interface LaterEntry { targetId: Id; reason: "DEEP_CAPACITY_EXHAUSTED" | "MEDIUM_CAPACITY_EXHAUSTED" | "SHALLOW_CAPACITY_EXHAUSTED" | "OUTSIDE_WORK_WINDOW" | "DEPENDENCY_BLOCKED" | "BET_EXPIRED" }
export interface TodayProposal { localDate: string; workspaceRevision: number; capacity: CapacityProfile; slots: CommitmentSlot[]; later: LaterEntry[]; proposalHash: string }

function compareTodayCandidate(left: TodayCandidate, right: TodayCandidate): number {
  return Number(right.hasFixedTimeOrHardDeadline) - Number(left.hasFixedTimeOrHardDeadline)
    || right.appetiteAndCriticalUrgency - left.appetiteAndCriticalUrgency
    || right.dependencyUnlockValue - left.dependencyUnlockValue
    || right.projectPriority - left.projectPriority
    || left.eligibleSince.localeCompare(right.eligibleSince)
    || left.targetId.localeCompare(right.targetId);
}

export async function generateTodayProposal(workspace: WorkspaceV2, localDate: string, now: ISODate): Promise<TodayProposal> {
  const capacity = capacityForLocalDate(workspace.capacityProfile, localDate);
  const candidates = collectEligibleCandidates(workspace, localDate, now).sort(compareTodayCandidate);
  const slots: CommitmentSlot[] = [];
  const later: LaterEntry[] = [];
  const ledger = createCapacityLedger(capacity);
  for (const candidate of candidates) {
    const placement = placeCandidate(candidate, ledger);
    if (!placement.ok) {
      later.push({ targetId: candidate.targetId, reason: placement.reason });
      continue;
    }
    slots.push(placement.slot);
    ledger.consume(placement.slot);
  }
  const proposalBase = { localDate, workspaceRevision: workspace.revision, capacity, slots, later };
  return { ...proposalBase, proposalHash: await stableHash(proposalBase as unknown as JsonValue) };
}
```

`capacityForLocalDate`, `createCapacityLedger`, and `placeCandidate` live in `localTime.ts`; they subtract unavailable intervals from weekly windows before checking both wall-clock seconds and the candidate's attention budget.

- [ ] Use the schedule projection from Task 9 for critical-path and dependency information. Do not create a second scheduling algorithm.

- [ ] Run focused tests and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/localTime.ts src/v2/domain/today.ts src/v2/domain/today.test.ts src/v2/domain/commandHandlers.ts
git -c commit.gpgsign=false commit -m "feat: generate capacity-safe Today proposals"
```

### Task 11: Require human Commit Today and version every accepted Replan

**Files:**

- Modify: `src/v2/domain/today.ts`
- Modify: `src/v2/domain/planning.ts`
- Modify: `src/v2/domain/commandHandlers.ts`
- Create: `src/v2/domain/dailyCommitment.test.ts`

- [ ] Write tests that only a human may `commit_today`, and that the draft must match the current workspace revision and a fresh proposal hash.

- [ ] Assert a Daily Commitment stores date, capacity snapshot, ordered time slots, included Action/Work Item revisions, human actor, timestamp, version, and optional `supersedesId`.

- [ ] Assert the first accepted commitment containing project work creates a `PlanVersion` and transitions that project from `planning` to `executing`. The Plan Version records Work Item revisions, dependency revisions, Bet scope mapping, schedule hash, and capacity-independent dates. It does not replace a Baseline.

- [ ] Add tests that actuals, dependency changes, or unavailable-block changes produce a `ReplanProposal` only. Existing committed slots remain byte-for-byte unchanged until a human `accept_replan` command succeeds.

- [ ] Assert an accepted Replan creates a new Daily Commitment and Plan Version linked by `supersedesId`; it never updates either prior record in place.

- [ ] Assert `review_overdue` permits recording actuals against already committed slots but rejects a new project commitment and any Replan that adds or moves commitment.

- [ ] Run `bunx vitest run src/v2/domain/dailyCommitment.test.ts`.

Expected: FAIL on Commit Today and Replan handlers.

- [ ] Implement command handlers and proposal freshness checks. Capacity overflow returns `CAPACITY_EXCEEDED`, the unchanged revision, and `configure_capacity` or `edit_today_draft` as the next action.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/today.ts src/v2/domain/planning.ts src/v2/domain/commandHandlers.ts src/v2/domain/dailyCommitment.test.ts
git -c commit.gpgsign=false commit -m "feat: version human daily commitments"
```

### Task 12: Enforce tiered evidence and expiring exceptions

**Files:**

- Create: `src/v2/domain/evidence.ts`
- Create: `src/v2/domain/evidence.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Write tests proving ordinary Action and Work Item completion requires an actual effort plus a concise outcome of `completed`, `learned`, or `blocked`, but does not require project-grade evidence.

- [ ] Write tests proving an evidence-required milestone cannot complete or satisfy validation without linked Evidence or an active Exception targeting that exact requirement.

- [ ] Test the Exception fields: requirement ID, rationale, known consequence, review date, expiry, human approver, created timestamp, and resolution history. Reject Agent/system approval and expiry before review date.

- [ ] Reject any Exception whose target is not a concrete evidence requirement. Bet/Re-bet, appetite expiry, transition validity, capacity safety, Review conclusion, and closed immutability never accept an exception record.

- [ ] Evaluate expiry against `CommandContext.now`. At expiry, the exception becomes inactive and the evidence gate blocks again without a cleanup command.

- [ ] Add a search assertion that no V2 command, policy, or UI contract contains `clear_gate` or generic `Clear gate`.

- [ ] Run `bunx vitest run src/v2/domain/evidence.test.ts`.

Expected: FAIL because validation and exception handlers are unimplemented.

- [ ] Implement evidence requirement selectors and handlers for `record_actual`, `attach_evidence`, `complete_work_item`, `approve_evidence_exception`, `resolve_evidence_exception`, `request_validation`, and `satisfy_validation`.

```ts
export function isExceptionActive(record: ExceptionRecord, now: ISODate): boolean {
  return !record.resolvedAt && record.createdAt <= now && now < record.expiresAt;
}

export function requirementStatus(workspace: WorkspaceV2, requirementId: Id, now: ISODate) {
  const hasEvidence = workspace.evidence.some((item) => item.workItemId === requirementId);
  const exception = workspace.exceptions.find((item) => item.requirementId === requirementId && isExceptionActive(item, now));
  return hasEvidence ? { satisfied: true as const, via: "evidence" as const }
    : exception ? { satisfied: true as const, via: "exception" as const, exceptionId: exception.id }
      : { satisfied: false as const, code: "EVIDENCE_REQUIRED" as const };
}
```

- [ ] Make `satisfy_validation` transition to `closing` only when every validation requirement is satisfied by evidence or an unexpired exception.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/evidence.ts src/v2/domain/evidence.test.ts src/v2/domain/commandHandlers.ts
git -c commit.gpgsign=false commit -m "feat: enforce evidence and controlled exceptions"
```

### Task 13: Implement weekly and event-triggered Review policy

**Files:**

- Create: `src/v2/domain/review.ts`
- Create: `src/v2/domain/review.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Define and test the non-configurable best-practice Review policy:

```ts
export const reviewPolicy = {
  weeklyDueWeekday: 0,
  weeklyDueMinute: 18 * 60,
  inboxAgingDays: 7,
  evidenceStaleDays: 14,
  capacityVarianceWindowDays: 5,
  capacityVarianceThreshold: 0.25,
  capacityVarianceBreachesRequired: 3
} as const;
```

Interpret weekday and due minute in the CapacityProfile timezone. A Review week begins Monday at 00:00 local and is due Sunday at 18:00 local. Capacity variance opens a trigger only when at least three of the latest five committed days differ from configured total or attention capacity by at least 25 percent.

- [ ] Write tests that derive one weekly portfolio Review and include Inbox aging, Bet health/appetite, capacity variance, stale evidence, open holds, exceptions, and sync conflicts.

- [ ] Write event-trigger tests for Bet midpoint, appetite boundary, stale evidence, repeated capacity variance, a newly opened hard gate, and a sync conflict affecting a commitment or lifecycle record. Re-evaluation must not duplicate an open Review with the same trigger key.

- [ ] Add overdue tests proving the policy adds `review_overdue` to affected projects or the portfolio, allows capture and Direction drafts, preserves existing Today execution, and rejects new Bets, accepted Re-bets, scope expansion, new project commitments, and Replans.

- [ ] Assert only a human may `complete_review`, and that a conclusion records reviewed items, decisions, follow-up commands, actor, and timestamp before removing the corresponding overdue hold.

- [ ] Run `bunx vitest run src/v2/domain/review.test.ts`.

Expected: FAIL because Review derivation and completion do not exist.

- [ ] Implement `deriveReviewQueue(workspace, now)` as a pure projection and use explicit `create_review` commands to persist new Review records. Use stable trigger keys for idempotency.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/review.ts src/v2/domain/review.test.ts src/v2/domain/commandHandlers.ts
git -c commit.gpgsign=false commit -m "feat: enforce portfolio Review cadence"
```

### Task 14: Enforce structured Close and expose domain selectors

**Files:**

- Create: `src/v2/domain/close.ts`
- Create: `src/v2/domain/close.test.ts`
- Create: `src/v2/domain/selectors.ts`
- Create: `src/v2/domain/selectors.test.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Write Close tests requiring success-evidence comparison, one outcome (`achieved`, `partial`, `invalidated`, `abandoned`), key learning, unfinished-work disposition, human actor, and timestamp.

- [ ] Test all dispositions: discard unfinished work, return it to Inbox, create a follow-up Direction-stage project, or retain it as historical incomplete scope. Preserve IDs and links in every case.

- [ ] Assert human `close_project` creates an immutable CloseDecision and advances `closing -> closed`. Every later mutation, including sync replay and import, returns `PROJECT_CLOSED`; only archive visibility may change.

- [ ] Assert human `abandon_project` is the only shortcut from an appetite-boundary Review to closure: it requires a full CloseDecisionDraft with outcome `abandoned`, performs the explicit `abandon_confirmed -> project_closed` transition sequence, and preserves unfinished-work disposition.

- [ ] Store archive as a workspace visibility preference rather than rewriting the closed lifecycle record. Test archive and unarchive leave Project, Bet, Plan, and Close hashes unchanged.

- [ ] Write selector tests for these UI-only read contracts:

```ts
selectProjectLifecycle(workspace, projectId)
selectRecommendedNextAction(workspace, projectId?)
selectLockedStages(workspace, projectId)
selectActiveHolds(workspace, projectId)
selectCommandAvailability(workspace, command, context)
selectTodayStatus(workspace, localDate, now)
selectReviewSummary(workspace, now)
```

- [ ] Assert selectors return exact unlock reasons and permitted commands rather than booleans alone.

- [ ] Define `selectRecommendedNextAction` ordering once in the selector: recovery error, incomplete migration/migration review, sync conflict on a commitment/lifecycle record, expired Bet or `rebet_required`, blocking evidence gate, overdue Review, uncommitted Today proposal/Replan decision, then aging Inbox. Within a class, sort oldest trigger timestamp then stable record ID. UI components render this result and never implement their own priority chain.

- [ ] Run focused tests.

Expected: FAIL because Close and selector modules do not exist.

- [ ] Implement Close handlers and pure selectors. Keep all mutation logic in the command engine.

- [ ] Run `bun run test` and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/close.ts src/v2/domain/close.test.ts src/v2/domain/selectors.ts src/v2/domain/selectors.test.ts src/v2/domain/commandHandlers.ts
git -c commit.gpgsign=false commit -m "feat: enforce structured immutable Close"
```

### Task 15: Prove arbitrary command sequences cannot bypass policy

**Files:**

- Create: `src/v2/tests/commandSequence.property.test.ts`
- Create: `src/v2/tests/commandArbitraries.ts`
- Modify: `src/v2/tests/builders.ts`

- [ ] Build fast-check arbitraries for actors, origins, valid and invalid commands, Direction completeness, Action estimates, capacities, holds, evidence state, appetite dates, and lifecycle stages. Generate IDs and timestamps from the test data so failing seeds replay exactly.

- [ ] Add a stateful property that executes up to 100 commands per generated sequence and validates the Workspace after every accepted command.

```ts
await fc.assert(
  fc.asyncProperty(commandSequenceArbitrary, async ({ initial, envelopes }) => {
    let workspace = initial;
    for (const envelope of envelopes) {
      const before = workspace;
      const result = await executeCommand(workspace, envelope.command, envelope.context);
      if (result.ok) {
        expect(validateWorkspaceInvariants(result.workspace, envelope.context.now)).toEqual([]);
        workspace = result.workspace;
      } else {
        expect(result.workspace).toBe(before);
        expect(result.workspace.revision).toBe(before.revision);
      }
    }
  }),
  { numRuns: 500 }
);
```

- [ ] Add explicit invariant properties for no unbet execution, no over-capacity commitment, no post-Close mutation, no non-human commitment or lifecycle approval, no active expired exception, and no hard-gate bypass.

- [ ] Add a mutation test that deep-freezes the input Workspace before each command. Any handler that mutates the input must throw and fail the suite.

- [ ] Run `bun run test:property`.

Expected: the first run may expose missing handler guards. Fix production policy or transition code, never weaken the property.

- [ ] Rerun with the printed failing seed until it passes, then run `bun run test` and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/tests/commandSequence.property.test.ts src/v2/tests/commandArbitraries.ts src/v2/tests/builders.ts src/v2/domain/commands.ts src/v2/domain/commandHandlers.ts src/v2/domain/invariants.ts src/v2/domain/policy.ts src/v2/domain/lifecycle.ts
git -c commit.gpgsign=false commit -m "test: prove V2 lifecycle invariants"
```

### Task 16: Add atomic IndexedDB persistence and one CommandService

**Files:**

- Create: `src/v2/repositories/indexedDb.ts`
- Create: `src/v2/repositories/browserWorkspaceRepository.ts`
- Create: `src/v2/repositories/commandService.ts`
- Create: `src/v2/repositories/systemEventCoordinator.ts`
- Create: `src/v2/repositories/browserWorkspaceRepository.integration.test.ts`
- Create: `src/v2/repositories/commandService.integration.test.ts`
- Create: `src/v2/repositories/systemEventCoordinator.integration.test.ts`

- [ ] Use the `CommandContext` contract from Task 5 at the persistence boundary:

```ts
export interface CommandContext {
  commandId: string;
  expectedRevision: number;
  actorId: string;
  actorKind: ActorKind;
  origin: CommandOrigin;
  source: CommandSource;
  now: ISODate;
}
```

- [ ] Define the repository boundary:

```ts
export interface SyncOutboxEntry {
  id: string;
  workspaceId: string;
  commandId: string;
  baseRevision: number;
  revision: number;
  command: V2Command;
  actor: Pick<CommandContext, "actorId" | "actorKind" | "origin" | "source">;
  payloadHash: string;
  receiptId: string;
  createdAt: ISODate;
  status: "pending" | "sent";
  sentAt?: ISODate;
  operationHash?: string;
}

export interface AtomicWorkspaceRepository {
  load(): Promise<WorkspaceV2 | undefined>;
  initialize(workspace: WorkspaceV2): Promise<"initialized" | "already_exists">;
  commit(input: {
    expectedRevision: number;
    workspace: WorkspaceV2;
    outboxEntry: SyncOutboxEntry;
  }): Promise<"committed" | "revision_conflict">;
  commitMigration(input: {
    sourceChecksum: string;
    workspace: WorkspaceV2;
    migrationRecord: MigrationRecord;
  }): Promise<"committed" | "already_migrated" | "revision_conflict">;
  writeAndVerifyBackup(input: { id: string; rawPayload: string; checksum: string }): Promise<void>;
  loadMigration(sourceChecksum: string): Promise<MigrationRecord | undefined>;
  listPendingOutbox(): Promise<SyncOutboxEntry[]>;
  markOutboxSent(id: string, operationHash: string, sentAt: ISODate): Promise<void>;
  appendRejectedReceipt(receipt: CommandReceipt): Promise<void>;
  findReceipt(commandId: string): Promise<CommandReceipt | undefined>;
  listReceipts(): Promise<CommandReceipt[]>;
}
```

- [ ] Write fake-indexeddb tests for explicit first initialization, two-tab concurrent initialization, retry after initialization abort, accepted commit, compare-and-swap revision conflict, injected transaction abort, duplicate `commandId`, atomic `commitMigration`, two concurrent migrations with the same checksum, and reload after commit. Repository `load()` never creates a Workspace as a side effect.

- [ ] Assert the V1 localStorage key `omni-plan-personal.workspace.v1` is never written or removed by any V2 repository method.

- [ ] Assert one accepted command writes the Workspace and plaintext local `SyncOutboxEntry` in the same IndexedDB transaction. The outbox is only an atomic replay queue; Task 18 encrypts an entry immediately before remote flush. An aborted transaction writes neither. A rejected command leaves the Workspace and outbox unchanged; its returned rejection receipt may be appended to the separate receipt object store.

- [ ] Test the locked-sync boundary: local dispatch succeeds and leaves a pending outbox entry when no sync key is unlocked. A later encryption failure leaves the entry pending and performs no remote write.

- [ ] Write system-event tests that advance a fake clock across Bet midpoint, Bet expiry, weekly Review deadline, and exception expiry. On boot and time advance, the coordinator must dispatch deterministic `record_bet_boundary`, `create_review`, and `mark_review_overdue` system commands exactly once. Concurrent tabs may retry only these idempotent system commands after CAS conflict; they never retry a human commitment.

- [ ] Run:

```bash
bunx vitest run src/v2/repositories/browserWorkspaceRepository.integration.test.ts src/v2/repositories/commandService.integration.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] Implement database `omni-plan-personal-v2` with versioned object stores `workspace`, `outbox`, `receipts`, `backups`, and `migrationRuns`. Store the complete Workspace as one record, commit Workspace plus outbox in one read/write transaction, and commit Workspace plus checksum-keyed MigrationRecord in one migration transaction.

- [ ] Implement `CommandService.dispatch(command, context)` as: load -> reject stale revision -> execute pure command -> atomically commit accepted result -> return applied receipt. On repository CAS conflict, return `REVISION_CONFLICT` without retrying a human commitment silently.

```ts
export class CommandService {
  constructor(private readonly repository: AtomicWorkspaceRepository, private readonly workspaceId: string) {}

  async dispatch(command: V2Command, context: CommandContext): Promise<CommandResult> {
    const workspace = await this.repository.load();
    if (!workspace || workspace.workspaceId !== this.workspaceId) {
      throw new Error("V2 Workspace must be initialized by BootstrapService before dispatch.");
    }
    const existingReceipt = await this.repository.findReceipt(context.commandId);
    if (existingReceipt || workspace.commandReceipts.some((receipt) => receipt.commandId === context.commandId)) {
      return duplicateCommandResult(workspace, command, context, existingReceipt);
    }
    const result = await executeCommand(workspace, command, context);
    if (!result.ok) {
      await this.repository.appendRejectedReceipt(result.receipt);
      return result;
    }
    const outboxEntry: SyncOutboxEntry = {
      id: `outbox-${context.commandId}`,
      workspaceId: workspace.workspaceId,
      commandId: context.commandId,
      baseRevision: workspace.revision,
      revision: result.workspace.revision,
      command,
      actor: { actorId: context.actorId, actorKind: context.actorKind, origin: context.origin, source: context.source },
      payloadHash: result.receipt.payloadHash,
      receiptId: result.receipt.id,
      createdAt: context.now,
      status: "pending"
    };
    const committed = await this.repository.commit({ expectedRevision: workspace.revision, workspace: result.workspace, outboxEntry });
    if (committed === "committed") return result;
    const conflict = await revisionConflictResult(workspace, command, context);
    await this.repository.appendRejectedReceipt(conflict.receipt);
    return conflict;
  }
}
```

- [ ] Implement `SystemEventCoordinator.run(now)` as: load -> derive due Bet/Review/exception trigger keys -> sort keys -> dispatch idempotent system commands -> reload after each accepted revision. Expose `nextWakeAt(workspace, now)` so the V2 provider can schedule the nearest boundary and rerun on `visibilitychange`.

- [ ] Keep rejected receipts outside the Workspace revision so `result.workspace === inputWorkspace` remains true. Settings may merge applied Workspace receipts with the append-only rejection receipt store for history.

- [ ] Run focused tests, `bun run test`, and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/repositories/indexedDb.ts src/v2/repositories/browserWorkspaceRepository.ts src/v2/repositories/commandService.ts src/v2/repositories/systemEventCoordinator.ts src/v2/repositories/browserWorkspaceRepository.integration.test.ts src/v2/repositories/commandService.integration.test.ts src/v2/repositories/systemEventCoordinator.integration.test.ts src/v2/domain/commands.ts src/v2/domain/commands.test.ts
git -c commit.gpgsign=false commit -m "feat: persist V2 commands atomically"
```

### Task 17: Migrate V1 through verified backup, idempotent mapping, and recovery

**Files:**

- Create: `src/v2/tests/fixtures/v1/empty.json`
- Create: `src/v2/tests/fixtures/v1/current-sample.json`
- Create: `src/v2/tests/fixtures/v1/active-incomplete.json`
- Create: `src/v2/tests/fixtures/v1/shape-up-bet.json`
- Create: `src/v2/tests/fixtures/v1/completed-archived.json`
- Create: `src/v2/tests/fixtures/v1/legacy-archived-status.json`
- Create: `src/v2/tests/fixtures/v1/malformed-optional-fields.json`
- Create: `src/v2/tests/fixtures/v1/expected-manifest.ts`
- Create: `src/v2/migration/backup.ts`
- Create: `src/v2/migration/migrateV1.ts`
- Create: `src/v2/migration/validateMigration.ts`
- Create: `src/v2/migration/recovery.ts`
- Create: `src/v2/repositories/bootstrapService.ts`
- Create: `src/v2/repositories/bootstrapService.integration.test.ts`
- Create: `src/v2/migration/migrateV1.test.ts`
- Create: `src/v2/migration/atomicMigration.integration.test.ts`
- Create: `src/v2/migration/recovery.test.ts`

- [ ] Commit immutable V1 fixtures for empty, current sample, active incomplete, old Shape Up Bet, completed/archived, legacy archived status, and malformed optional values. Produce `current-sample.json` once from the exported `sampleWorkspace` in `src/domain/sampleData.ts`, then review and freeze the JSON rather than regenerating it during tests. `expected-manifest.ts` must list exact ID sets and entity counts for each fixture.

- [ ] Write two distinct SHA-256 tests. `backupChecksum` hashes the exact raw bytes read from `omni-plan-personal.workspace.v1` before parsing or normalization and verifies those same recovery bytes after read-back. `sourceChecksum` hashes only the canonical normalized `snapshot` payload, excluding volatile export metadata such as `exportedAt`; it is the idempotency key. Store both in `MigrationRecord`.

- [ ] Write pure migration tests for these exact rules:

  - preserve every existing Project, Work Item, Dependency, Evidence, Baseline, Decision, AuditDecision, AuditGate, and ChangeSet ID;
  - preserve every Resource and AttentionCapacity value and include their exact counts/keys in the expected manifest;
  - V1 Actual has no ID, so create a deterministic V2 actual ID from `workItemId + recordedAt + sourceIndex` and record that derivation in the migration report;
  - prefill the unified brief from Direction Card and Shape Up fields, leaving absent decisions visibly incomplete;
  - preserve the full embedded Shape Up Pitch, scope, Bet, and cycle payload in immutable legacy history; map scopes to stable Bet-scope definitions for review history only;
  - never turn a V1 Shape Up Bet or audit approval into a valid V2 Bet;
  - add `migration_review` only to active, waiting, and paused projects, deriving `direction` or `awaiting_bet` from brief completeness while creating no Bet;
  - map explicit V1 done and archived projects to immutable `closed` projects with `LegacyClosureProvenance` and a matching `LegacyAuditRecord`, without fabricating a Bet, human actor, or V2 CloseDecision;
  - preserve V1 archive status as a visibility preference;
  - convert Decisions, AuditDecisions, AuditGates, and ChangeSets to immutable `LegacyAuditRecord` values with original IDs and payloads.

- [ ] Add an idempotency test: migrating the same source checksum twice returns the existing MigrationRecord and identical Workspace hash with no duplicate entity.

- [ ] Add a validator test that rejects any `legacyClosure` unless the migration checksum, source status, project ID, and referenced LegacyAuditRecord all match. New V2 projects can reach `closed` only through a valid human CloseDecision.

- [ ] Add failure tests for backup verification failure, malformed required references, invariant failure, quota error, and transaction abort. Assert no V2 workspace record is committed, the V1 localStorage payload remains untouched, and the verified backup remains downloadable.

- [ ] Test `BootstrapService` in this exact order: load recovery state -> load existing V2 -> inspect raw V1 key -> return `migration_required` when V1 exists -> initialize an empty V2 only when neither exists -> return `setup_required` until CapacityProfile is saved -> return `ready` otherwise. Two-tab initialization uses repository CAS. Neither human UI nor `/agent/*` may call `CommandService` before bootstrap reaches `setup_required` or `ready`.

- [ ] Run:

```bash
bunx vitest run src/v2/migration
```

Expected: FAIL because migration modules do not exist.

- [ ] Implement pure `migrateV1Workspace`, `validateMigratedWorkspace`, backup/recovery helpers, and an atomic migration coordinator that writes the migration record and V2 workspace only after all validation succeeds.

```ts
export async function migrateBrowserWorkspace(input: {
  rawV1Payload: string;
  workspaceId: Id;
  actorId: Id;
  now: ISODate;
  repository: BrowserWorkspaceRepository;
}) {
  const backupChecksum = await sha256Text(input.rawV1Payload);
  const backupId = `v1-backup-${backupChecksum}`;
  await input.repository.writeAndVerifyBackup({ id: backupId, rawPayload: input.rawV1Payload, checksum: backupChecksum });

  const parsed = parseV1Export(input.rawV1Payload);
  const normalized = normalizeWorkspaceSnapshot(parsed.snapshot);
  const sourceChecksum = await stableHash(normalized as unknown as JsonValue);
  const existing = await input.repository.loadMigration(sourceChecksum);
  if (existing) return { status: "already_migrated" as const, migration: existing };

  const candidate = await migrateV1Workspace(normalized, {
    workspaceId: input.workspaceId,
    sourceChecksum,
    backupId,
    backupChecksum,
    actorId: input.actorId,
    now: input.now
  });
  const violations = validateMigratedWorkspace(normalized, candidate.workspace, candidate.migration, input.now);
  if (violations.length > 0) return { status: "rejected" as const, violations, backupId, backupChecksum };

  const committed = await input.repository.commitMigration({
    sourceChecksum,
    workspace: candidate.workspace,
    migrationRecord: candidate.migration
  });
  return { status: committed, migration: candidate.migration, backupId, backupChecksum };
}
```

- [ ] Run migration tests twice, then `bun run test` and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/tests/fixtures/v1 src/v2/migration src/v2/domain/types.ts src/v2/domain/workspace.ts src/v2/repositories/indexedDb.ts src/v2/repositories/browserWorkspaceRepository.ts src/v2/repositories/bootstrapService.ts src/v2/repositories/bootstrapService.integration.test.ts
git -c commit.gpgsign=false commit -m "feat: migrate V1 safely into V2"
```

### Task 18: Reuse encrypted transport while preventing sync conflict overwrite

**Files:**

- Create: `src/domain/canonical.ts`
- Modify: `src/domain/sync.ts`
- Modify: `src/domain/integration.test.ts`
- Create: `src/v2/domain/conflicts.ts`
- Create: `src/v2/repositories/syncProtocol.ts`
- Create: `src/v2/repositories/syncAdapter.ts`
- Create: `src/v2/repositories/originAdapters.ts`
- Create: `src/v2/tests/syncConflict.integration.test.ts`
- Create: `src/v2/tests/syncProtocol.integration.test.ts`
- Create: `src/v2/tests/originParity.integration.test.ts`

- [ ] First add V1 characterization tests around stable serialization, plaintext checksum, encrypt/decrypt, GitHub envelopes, Firebase envelopes, and conflict errors. Run `bunx vitest run src/domain/integration.test.ts` and confirm they pass before extraction.

- [ ] Extract canonical serialization and cryptographic hashing to `src/domain/canonical.ts`, then make the existing V1 functions thin wrappers. Run the same V1 test again; expected values and payload round trips must remain unchanged.

- [ ] Commit the V1-only extraction before any V2 protocol work:

```bash
git add src/domain/canonical.ts src/domain/sync.ts src/domain/integration.test.ts
git -c commit.gpgsign=false commit -m "refactor: share canonical sync primitives"
```

- [ ] Define a V2-only remote protocol and namespace; never pass `WorkspaceV2` to a schema-1 V1 envelope:

```ts
export interface SyncEnvelopeV2 {
  schemaVersion: 2;
  protocol: "omniplan-v2-command-log";
  workspaceId: string;
  deviceId: string;
  sequence: number;
  operationId: string;
  commandId: string;
  baseRevision: number;
  revision: number;
  previousOperationHash?: string;
  payloadHash: string;
  createdAt: ISODate;
  payload: EncryptedSyncPayload;
}

export interface SyncManifestV2 {
  schemaVersion: 2;
  protocol: "omniplan-v2-command-log";
  workspaceId: string;
  heads: Record<string, { sequence: number; operationHash: string; revision: number; updatedAt: ISODate }>;
  updatedAt: ISODate;
}
```

Use remote paths `v2/workspaces/{workspaceId}/manifest.json` and `v2/workspaces/{workspaceId}/operations/{deviceId}/{sequence}-{operationHash}.json.enc`. Add tests proving V2 cannot read or overwrite V1 remote paths or schema-1 snapshots; a V1 remote snapshot may enter only as explicit migration input.

- [ ] Implement outbox flush as: read pending entry -> require unlocked sync key -> canonicalize and encrypt the command/receipt payload -> upload immutable operation -> compare-and-swap manifest -> mark the local entry sent. Locked key, encryption failure, upload failure, or manifest conflict leaves the local entry pending and never performs a partial remote overwrite.

- [ ] Implement common-ancestor merge from `previousOperationHash` and per-device heads. Decrypt and verify every operation hash, find the latest common operation, replay non-conflicting commands after that ancestor through `CommandService`, and create conflicts for divergent protected records. Reject a missing ancestor or broken hash chain instead of treating remote state as authoritative.

- [ ] Activate the `SyncConflictRecord[]` and structured hold references modeled in Task 2. Add commands `open_sync_conflict` and `resolve_sync_conflict`; only the system may open one and only a human may resolve one.

- [ ] Write conflict tests for concurrent changes to BetVersion, DailyCommitment, ReviewRecord, ExceptionRecord, and CloseDecision. Each conflict must preserve both versions, add `sync_conflict`, create an event Review, and block mutations only to affected records. It must never pick a last writer.

- [ ] Add a non-sensitive merge test proving unrelated Inbox capture and actual/evidence commands can continue through the central command engine while a conflict is open.

- [ ] Build UI, Agent, import, and sync origin adapters that only construct command/context envelopes and call `CommandService`; they must not expose repository setters.

- [ ] Add an origin-parity matrix that holds actor kind, payload, base Workspace, and expected revision constant while varying only `ui`, `agent`, `import`, and `sync` origin adapters. Compare rejection code, blocking hold/gate, permitted next command, audit diff, and workspace revision. Add a separate actor-authority matrix because different actor kinds are expected to produce different outcomes.

- [ ] Run:

```bash
bunx vitest run src/domain/integration.test.ts src/v2/tests/syncProtocol.integration.test.ts src/v2/tests/syncConflict.integration.test.ts src/v2/tests/originParity.integration.test.ts
```

Expected: FAIL before the V2 sync adapter; PASS after extraction and conflict implementation.

- [ ] Ensure remote human commands are accepted only by replaying an intact, previously applied command receipt whose command ID, base revision, payload hash, and actor are verified inside the encrypted sync envelope. `origin: "sync"` never grants human authority by itself, and a raw imported snapshot cannot synthesize Bet, commitment, exception, Review conclusion, or Close approval.

- [ ] Run `bun run test` and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/conflicts.ts src/v2/repositories/syncProtocol.ts src/v2/repositories/syncAdapter.ts src/v2/repositories/originAdapters.ts src/v2/tests/syncProtocol.integration.test.ts src/v2/tests/syncConflict.integration.test.ts src/v2/tests/originParity.integration.test.ts
git -c commit.gpgsign=false commit -m "feat: sync V2 without overwriting commitments"
```

### Task 18A: Add explicit V2 export, guarded import, and verified restore

**Files:**

- Create: `src/v2/repositories/workspaceTransfer.ts`
- Create: `src/v2/repositories/workspaceTransfer.integration.test.ts`
- Modify: `src/v2/repositories/originAdapters.ts`
- Modify: `src/v2/repositories/browserWorkspaceRepository.ts`

- [ ] Define three separate operations: `exportWorkspaceBackup`, `importPortableCommands`, and `restoreVerifiedBackup`. Do not use one ambiguous Import button for all three.

- [ ] Write the V2 backup envelope contract:

```ts
export interface WorkspaceBackupV2 {
  schemaVersion: 2;
  format: "omniplan-v2-backup";
  exportedAt: ISODate;
  workspace: WorkspaceV2;
  rejectedReceipts: CommandReceipt[];
  workspaceHash: string;
  receiptLedgerHash: string;
  backupChecksum: string;
}
```

`backupChecksum` is SHA-256 over the canonical envelope excluding only the checksum field. Export includes the external rejection receipt ledger so Automation history remains complete.

- [ ] Test portable import as a command list, not a snapshot replacement. Parse and validate each command, use `origin: "import"` with a verified import source, and dispatch sequentially through `CommandService`. Raw imported data cannot create or replace BetVersion, DailyCommitment, Exception approval, Review conclusion, Sync resolution, or CloseDecision.

- [ ] Test verified restore separately: require matching checksum, Workspace schema 2, invariant-valid state, intact receipt hashes for every human commitment, and an atomic backup of the current V2 state before replacement. Tampered actor, payload, receipt, or revision chains fail without changing the current workspace.

- [ ] Test that schema-1 input routes to Task 17 migration and never enters the V2 restore path.

- [ ] Add repository `restoreVerifiedBackup` as a single transaction over `workspace`, `receipts`, and `backups`. Simulated quota/abort leaves the current workspace and prior backup intact.

- [ ] Run:

```bash
bunx vitest run src/v2/repositories/workspaceTransfer.integration.test.ts
```

Expected: FAIL before transfer services exist; PASS with command-only import and atomic verified restore.

- [ ] Run `bun run test` and `bun run build`, then commit:

```bash
git add src/v2/repositories/workspaceTransfer.ts src/v2/repositories/workspaceTransfer.integration.test.ts src/v2/repositories/originAdapters.ts src/v2/repositories/browserWorkspaceRepository.ts
git -c commit.gpgsign=false commit -m "feat: guard V2 import export and restore"
```

### Task 19: Implement bounded Agent proposals and the V2 Agent bridge

**Files:**

- Create: `src/v2/domain/agentAuthority.ts`
- Create: `src/v2/domain/agentAuthority.test.ts`
- Create: `src/v2/repositories/agentAdapter.ts`
- Create: `src/v2/app/agent/AgentAppV2.tsx`
- Create: `src/v2/app/agent/AgentAppV2.test.tsx`
- Modify: `src/v2/domain/types.ts`
- Modify: `src/v2/domain/commands.ts`
- Modify: `src/v2/domain/commandHandlers.ts`

- [ ] Activate the `CommandProposal[]` modeled in Task 2 and add commands `submit_command_proposal`, `dismiss_command_proposal`, and `accept_command_proposal`. A proposal stores its proposed command, base revision, rationale, Agent actor, timestamp, and state; it does not mutate the proposed domain entity.

- [ ] Write the exact Agent authority tests:

  - auto-apply `capture_inbox`, `record_actual`, and `attach_evidence` supplied by an authorized source;
  - reject the same low-risk commands from an unverified Agent source or a source lacking the exact capability;
  - store proposals for Direction decisions, plans, Replans, scope changes, and dependency changes;
  - reject Agent triage confirmation, Bet/Re-bet, Commit Today, Replan acceptance, evidence exception approval, Review conclusion, conflict resolution, and Close;
  - never partially persist a rejected or proposal-only domain change.

- [ ] Test human proposal acceptance by re-authorizing the nested command against the current revision. Stale proposals return `REVISION_CONFLICT` and must be regenerated or consciously reapplied.

- [ ] Create Agent protocol version `2026-07-10.v2` and preserve machine-readable routes `/agent/manual.txt`, `/agent/projects.txt`, `/agent/projects.json`, `/agent/projects/:id.txt`, `/agent/projects/:id.json`, and `/agent/commands` in `AgentAppV2`.

- [ ] Assert V2 Agent writes call `agentAdapter -> CommandService`; mock the service and fail the test if IndexedDB or Workspace setters are used directly.

- [ ] Assert `/agent/*` consults `BootstrapService` first. Before migration/setup is resolved, read endpoints report the required human bootstrap state and write endpoints reject without initializing an empty Workspace or touching V1 storage.

- [ ] Run focused tests.

Expected: FAIL before Agent proposal/bridge implementation.

- [ ] Implement the policy, proposal handlers, V2 read projections, and V2 Agent app. Do not modify the production `src/AgentApp.tsx` entry in this task; the compile-time entry switch in Task 20 and cutover in Task 29 select the appropriate implementation.

- [ ] Run `bun run test` and `bun run build`.

- [ ] Commit:

```bash
git add src/v2/domain/agentAuthority.ts src/v2/domain/agentAuthority.test.ts src/v2/domain/types.ts src/v2/domain/commands.ts src/v2/domain/commandHandlers.ts src/v2/repositories/agentAdapter.ts src/v2/app/agent
git -c commit.gpgsign=false commit -m "feat: bound V2 Agent authority"
```

### Task 20: Add the internal V2 entry, command-backed provider, and four-destination shell

**Files:**

- Create: `.env.v1`
- Create: `.env.v2`
- Modify: `.gitignore`
- Create: `src/appEntry.ts`
- Create: `src/appEntry.test.ts`
- Create: `src/V1Entry.tsx`
- Modify: `src/main.tsx`
- Modify: `src/vite-env.d.ts`
- Create: `src/v2/app/AppV2.tsx`
- Create: `src/v2/app/entry.tsx`
- Create: `src/v2/app/routes.tsx`
- Create: `src/v2/app/v2.css`
- Create: `src/v2/app/state/V2WorkspaceProvider.tsx`
- Create: `src/v2/app/state/V2WorkspaceProvider.test.tsx`
- Create: `src/v2/app/state/useCommandForm.ts`
- Create: `src/v2/app/state/useCommandForm.test.tsx`
- Create: `src/v2/app/shell/AppShell.tsx`
- Create: `src/v2/app/shell/DesktopSidebar.tsx`
- Create: `src/v2/app/shell/MobileBottomNav.tsx`
- Create: `src/v2/app/shell/MobileUtilityMenu.tsx`
- Create: `src/v2/app/shell/RouteFocusManager.tsx`
- Create: `src/v2/app/shell/AppShell.test.tsx`
- Create: `src/v2/app/test/renderV2.tsx`

- [ ] Write `src/appEntry.test.ts` first against a pure `resolveAppGeneration(envValue, sourceDefault)` function. Prove explicit `v1`/`v2`, invalid-value rejection, the ordinary source default remains V1 until Task 29, and no query parameter or localStorage value is an input. Add a separate build smoke that invokes both `.env.v1` and `.env.v2` modes and inspects their rendered app marker.

- [ ] Write provider tests for `booting`, `migration_required`, `setup_required`, `ready`, and `recovery_error`. Assert all UI writes call `CommandService.dispatch` with `actorKind: "human"`, `origin: "ui"`, current revision, and a unique command ID. The context must not expose `setWorkspace`.

- [ ] Write shell tests asserting exactly four primary destinations in this order: Inbox, Today, Projects, Review. Settings appears only as a utility entry. Desktop uses a labeled sidebar; mobile uses four labeled bottom destinations with `aria-current="page"`.

- [ ] Add a focus test: after navigation, `RouteFocusManager` focuses the page `<h1>` and announces the new route in an `aria-live="polite"` region.

- [ ] Run:

```bash
bunx vitest run src/appEntry.test.ts src/v2/app/state/V2WorkspaceProvider.test.tsx src/v2/app/shell/AppShell.test.tsx
```

Expected: FAIL because the entry, provider, and shell do not exist.

- [ ] Add `!.env.v1` and `!.env.v2` to `.gitignore`, set `.env.v1` to `VITE_OMNIPLAN_GENERATION=v1`, set `.env.v2` to `VITE_OMNIPLAN_GENERATION=v2`, and keep secrets out of both files. Implement a compile-time resolver in `src/appEntry.ts`; do not add a user-facing switch.

```ts
export type AppGeneration = "v1" | "v2";

export function resolveAppGeneration(value: string | undefined, sourceDefault: AppGeneration): AppGeneration {
  if (value === undefined || value === "") return sourceDefault;
  if (value === "v1" || value === "v2") return value;
  throw new Error(`Unsupported OmniPlan generation: ${value}`);
}

export async function loadGeneration(generation: AppGeneration) {
  return generation === "v2" ? import("./v2/app/entry") : import("./V1Entry");
}
```

`src/main.tsx` resolves from `import.meta.env.VITE_OMNIPLAN_GENERATION` and the source default, awaits exactly one module, then calls its exported `renderApp(rootElement)`.

- [ ] Implement the provider over `BootstrapService`, `BrowserWorkspaceRepository`, `CommandService`, and `SystemEventCoordinator`. Resolve bootstrap before creating the dispatch context; migration/recovery states expose no command dispatch, while `setup_required` exposes only `configure_capacity` against the explicitly initialized empty V2 Workspace. Run due system events only after setup, at `nextWakeAt`, and when the document becomes visible; cancel timers on unmount. Rejections populate a transient `lastCommandResult` for rendering but do not mutate Workspace state.

```tsx
export interface V2WorkspaceContextValue {
  workspace: WorkspaceV2;
  lastCommandResult?: CommandResult;
  dispatch(command: V2Command): Promise<CommandResult>;
}

const V2WorkspaceContext = createContext<V2WorkspaceContextValue | undefined>(undefined);

const dispatch = useCallback(async (command: V2Command) => {
  const result = await commandService.dispatch(command, createHumanUiContext(workspace.revision));
  setLastCommandResult(result);
  if (result.ok) setWorkspace(result.workspace);
  return result;
}, [commandService, workspace.revision]);
```

The provider owns this internal state update; feature components receive only `workspace`, selectors, and `dispatch`, never the setter.

- [ ] Implement one reusable form boundary; every later V2 form uses it rather than duplicating mutation/error state:

```tsx
export function useCommandForm<T>(buildCommand: (values: T) => V2Command) {
  const { dispatch } = useV2Workspace();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CommandResult>();
  const inFlight = useRef<Promise<CommandResult> | null>(null);
  const submit = useCallback((values: T) => {
    if (inFlight.current) return inFlight.current;
    setPending(true);
    const operation = dispatch(buildCommand(values))
      .then((next) => {
        setResult(next);
        return next;
      })
      .finally(() => {
        inFlight.current = null;
        setPending(false);
      });
    inFlight.current = operation;
    return operation;
  }, [buildCommand, dispatch]);
  return { pending, result, submit };
}
```

Test pending state, accepted result, typed rejection, double-submit suppression, and focus handoff to `CommandRejectionCard` or the created record.

- [ ] Remove the unconditional `./styles.css` import from `src/main.tsx`. `V1Entry.tsx` imports `styles.css`; `src/v2/app/entry.tsx` imports only `v2.css`. Have the bootstrap dynamically import exactly one generation-specific entry after calling the pure resolver, so a V2 build does not bundle the 4,197-line V1 stylesheet. Build tests must assert a known V1-only selector is absent from V2 CSS and a V2-only selector is absent from V1 CSS.

- [ ] Implement the route contract for `/setup`, `/migration`, `/inbox`, `/inbox/actions`, `/today`, `/today/calendar`, `/projects`, `/projects/:projectId/:stage`, `/review`, `/settings`, and `/settings/automation`. In this shell slice, each route renders a semantic page title and its current read-only selector summary; later tasks replace that route body with the command-backed feature screen. After setup, `/` redirects deterministically to `/today`.

- [ ] Give V2 an isolated `v2.css`; do not append another application design system to the existing 4,197-line `src/styles.css`.

- [ ] In `v2.css`, enforce at least 44 CSS pixels of height for V2 Button, Input, Select, textarea, icon-button, mobile navigation, and utility-menu targets without changing the V1 component defaults. Add a shell test that opens/closes the mobile utility menu, restores focus to its trigger, reaches Settings, and measures every visible primary target. Keep stage, hold, and selection meaning textual rather than color-only.

- [ ] Run focused tests, `bun run build`, and `bun run build:v2`.

- [ ] Commit:

```bash
git add .gitignore .env.v1 .env.v2 src/appEntry.ts src/appEntry.test.ts src/V1Entry.tsx src/main.tsx src/vite-env.d.ts src/v2/app
git -c commit.gpgsign=false commit -m "feat: add internal V2 application shell"
```

### Task 21: Build capacity onboarding, Inbox triage, and lightweight Actions

**Files:**

- Create: `src/v2/app/components/CommandRejectionCard.tsx`
- Create: `src/v2/app/components/TopActionCard.tsx`
- Create: `src/v2/app/components/HumanConfirmationDialog.tsx`
- Create: `src/v2/app/components/EmptyState.tsx`
- Create: `src/v2/app/setup/CapacitySetupPage.tsx`
- Create: `src/v2/app/setup/CapacityEditor.tsx`
- Create: `src/v2/app/setup/UnavailableBlocksField.tsx`
- Create: `src/v2/app/setup/CapacitySetupPage.test.tsx`
- Create: `src/v2/app/inbox/InboxPage.tsx`
- Create: `src/v2/app/inbox/CaptureForm.tsx`
- Create: `src/v2/app/inbox/TriageCard.tsx`
- Create: `src/v2/app/inbox/ClassificationExplanation.tsx`
- Create: `src/v2/app/inbox/InboxPage.test.tsx`
- Create: `src/v2/app/actions/ActionsPage.tsx`
- Create: `src/v2/app/actions/ActionEditorSheet.tsx`
- Create: `src/v2/app/actions/ActionOutcomeForm.tsx`
- Create: `src/v2/app/actions/PromoteActionDialog.tsx`
- Create: `src/v2/app/actions/ActionsPage.test.tsx`
- Modify: `src/v2/app/routes.tsx`

- [ ] Test setup validation for weekly windows, daily Deep/Medium/Shallow budgets, fixed unavailable blocks, timezone, explicit Save, and redirect to Today. Actual-history calibration may render as a suggestion but must not dispatch until the user accepts it.

- [ ] Test capture with a single primary text input. After submission, assert the repository contains one Inbox item and zero Actions/Projects.

- [ ] Test triage explanations for every deterministic Action rule. Human confirmation creates the chosen Action or Direction-stage Project; dismissing the dialog creates neither.

- [ ] Test Action editing, desired/fixed date, attention, completion actual, and outcome note. Attempting to exceed two hours or add a dependency/evidence/multiple outcomes/uncertain path must render the typed promotion rejection and a single `Promote to project` action.

- [ ] Assert Actions live at `/inbox/actions` and never become a fifth primary destination.

- [ ] Run focused UI tests.

Expected: FAIL because pages and components do not exist.

- [ ] Implement every form as a `CommandService` dispatch. `CommandRejectionCard` must render the stable reason, active gate/hold, and permitted next command; do not reduce policy failures to toasts. Complete and commit Setup before Inbox, then Inbox before Actions.

```tsx
export function CommandRejectionCard({ result, onResolve }: { result?: CommandResult; onResolve(command: string): void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (result && !result.ok) headingRef.current?.focus();
  }, [result]);
  if (!result || result.ok) return null;
  return (
    <section role="alert" aria-labelledby="command-rejection-title">
      <h2 id="command-rejection-title" ref={headingRef} tabIndex={-1}>This change is blocked</h2>
      <p>{result.rejection.reason}</p>
      {result.rejection.hold && <p>Hold: {result.rejection.hold}</p>}
      {result.rejection.gate && <p>Gate: {result.rejection.gate}</p>}
      <Button type="button" onClick={() => onResolve(result.rejection.permittedNextCommand)}>
        Resolve: {result.rejection.permittedNextCommand}
      </Button>
    </section>
  );
}
```

- [ ] Add accessible confirmation text that states the irreversible meaning of classification or promotion. Preserve focus on cancellation and move focus to the new item on success.

- [ ] Run each focused test, `bun run test:v2`, and `bun run build:v2` before its commit:

```bash
git add src/v2/app/components src/v2/app/setup src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: require explicit capacity setup"

git add src/v2/app/inbox src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: guide Inbox triage"

git add src/v2/app/actions src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: enforce lightweight Action boundaries"
```

### Task 22: Build Projects, lifecycle navigation, Direction, and Bet/Re-bet

**Files:**

- Create: `src/v2/app/components/HoldBanner.tsx`
- Create: `src/v2/app/projects/ProjectsPage.tsx`
- Create: `src/v2/app/projects/ProjectCard.tsx`
- Create: `src/v2/app/projects/ProjectsPage.test.tsx`
- Create: `src/v2/app/project/ProjectWorkspacePage.tsx`
- Create: `src/v2/app/project/ProjectHeader.tsx`
- Create: `src/v2/app/project/LifecycleNav.tsx`
- Create: `src/v2/app/project/LockedStagePanel.tsx`
- Create: `src/v2/app/project/ProjectWorkspacePage.test.tsx`
- Create: `src/v2/app/project/direction/DirectionStage.tsx`
- Create: `src/v2/app/project/direction/DirectionDecisionStepper.tsx`
- Create: `src/v2/app/project/direction/DirectionStage.test.tsx`
- Create: `src/v2/app/project/bet/BetStage.tsx`
- Create: `src/v2/app/project/bet/BetHistory.tsx`
- Create: `src/v2/app/project/bet/BetStage.test.tsx`
- Create: `src/v2/app/project/plan/PlanStageSummary.tsx`
- Create: `src/v2/app/project/plan/PlanStageSummary.test.tsx`
- Modify: `src/v2/app/routes.tsx`

- [ ] Test Project cards for name, lifecycle stage, Bet appetite/expiry, active holds, and one recommended next action. Do not expose raw status editing.

- [ ] Test the textual lifecycle sequence `Direction -> Bet -> Plan -> Execute -> Evidence -> Close`. Current stage is prominent, completed stages link to immutable history, and future stages remain visible but render their exact unlock condition.

- [ ] Deep-link each locked segment (`bet`, `plan`, `execute`, `evidence`, `close`) and assert `LockedStagePanel` renders instead of the mutation UI.

- [ ] Test the one-decision-at-a-time Direction stepper, saved incomplete drafts, completeness indicator, six required decisions, and optional advanced notes.

- [ ] Test explicit Bet confirmation with scope and appetite summary. Agent-authored draft text may be accepted by the human, but the Bet actor and command must be the human.

- [ ] Add a read-only `PlanStageSummary` for the post-Bet state in this slice. It shows committed scope, empty/seeded Work Item counts, schedule diagnostics, and the recommended `Create first work item` command description, but exposes no raw setter. Task 23 replaces it with the complete planning editor after shared-view extraction.

- [ ] Test a material edit during execution: the UI shows the pending change, warns that execution will pause, then after human confirmation renders `rebet_required`, immutable Bet history, and only the Re-bet action. Project-name edits must not show this flow.

- [ ] Run focused tests.

Expected: FAIL because project pages do not exist.

- [ ] Implement pages against selectors and command dispatch only. Keep diagnostics and old audit history behind progressive disclosure.

```tsx
const validStageSegments = ["direction", "bet", "plan", "execute", "evidence", "close"] as const;
const implementedStageComponents = {
  direction: DirectionStage,
  bet: BetStage,
  plan: PlanStageSummary
} as const;

export function ProjectWorkspacePage() {
  const { projectId = "", stage = "direction" } = useParams();
  const { workspace } = useV2Workspace();
  const locked = selectLockedStages(workspace, projectId);
  if (!validStageSegments.includes(stage as (typeof validStageSegments)[number])) {
    return <Navigate to={`/projects/${projectId}/direction`} replace />;
  }
  const lock = locked.find((item) => item.stage === stage);
  if (lock) {
    return <LockedStagePanel stage={stage} reason={lock.reason} nextCommand={lock.permittedNextCommand} />;
  }
  if (!(stage in implementedStageComponents)) {
    throw new Error(`No component registered for unlocked lifecycle stage ${stage}`);
  }
  const Stage = implementedStageComponents[stage as keyof typeof implementedStageComponents];
  return <Stage projectId={projectId} />;
}
```

- [ ] Make Projects/lifecycle shell, Direction, and Bet/Re-bet three independently green commits. Run their focused tests, `bun run test:v2`, and `bun run build:v2` before each commit:

```bash
git add src/v2/app/components/HoldBanner.tsx src/v2/app/projects src/v2/app/project/ProjectWorkspacePage.tsx src/v2/app/project/ProjectHeader.tsx src/v2/app/project/LifecycleNav.tsx src/v2/app/project/LockedStagePanel.tsx src/v2/app/project/ProjectWorkspacePage.test.tsx src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: add guided project lifecycle shell"

git add src/v2/app/project/direction src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: guide six Direction decisions"

git add src/v2/app/project/bet src/v2/app/project/plan/PlanStageSummary.tsx src/v2/app/project/plan/PlanStageSummary.test.tsx src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: require human Bet confirmation"
```

### Task 23: Extract shared planning views and build the V2 Plan/Execute stages

**Files:**

- Create: `src/components/planning/OutlineTable.tsx`
- Create: `src/components/planning/GanttChart.tsx`
- Create: `src/components/planning/GanttTextTable.tsx`
- Create: `src/components/planning/GanttTextTable.test.tsx`
- Create: `src/components/planning/RecurringTasksPanel.tsx`
- Create: `src/components/planning/planningViews.css`
- Create: `src/components/planning/planningViews.test.tsx`
- Create: `src/components/evidence/EvidenceList.tsx`
- Create: `src/components/evidence/evidenceList.css`
- Create: `src/components/evidence/EvidenceList.test.tsx`
- Modify: `src/App.tsx`
- Create: `src/v2/app/project/plan/PlanStage.tsx`
- Create: `src/v2/app/project/plan/PlanVersionCard.tsx`
- Create: `src/v2/app/project/plan/PlanStage.test.tsx`
- Create: `src/v2/app/project/execute/ExecuteStage.tsx`
- Create: `src/v2/app/project/execute/ExecuteStage.test.tsx`
- Modify: `src/v2/app/routes.tsx`
- Create: `docs/ui-review-v2/extraction-v1-plan-before.png`
- Create: `docs/ui-review-v2/extraction-v1-plan-after.png`

- [ ] Before extraction, change only the four existing declarations to named exports, then add characterization tests for `RecurringTasksPanel` (currently around `src/App.tsx:3604`), `EvidenceList` (around `src/App.tsx:6390`), `OutlineTable` (around `src/App.tsx:6757`), and `GanttChart` (around `src/App.tsx:6876`). Cover visible rows, critical-path labels, dependency editing, baseline overlay, recurrence preview, evidence links, and empty states.

- [ ] Run the characterization tests against the exported-in-place components.

Expected: PASS before moving code. Capture snapshots/queries that describe behavior, not implementation markup.

- [ ] Capture the same seeded V1 Plan page at 1440 by 1000 as `docs/ui-review-v2/extraction-v1-plan-before.png`, then commit only the characterization seam:

```bash
git add src/App.tsx src/components/planning/planningViews.test.tsx src/components/evidence/EvidenceList.test.tsx docs/ui-review-v2/extraction-v1-plan-before.png
git -c commit.gpgsign=false commit -m "test: characterize V1 planning views"
```

- [ ] Move each component plus its component-local types/helpers and required styles to the named shared files. Each shared component imports its own focused CSS, so both generations render it correctly without V2 loading `src/styles.css`. Replace V1 inline definitions with imports. Do not change V1 callbacks or direct-write behavior during extraction.

- [ ] Extract and commit one independently green unit at a time, running its focused characterization test plus `bun run build` before each commit:

```bash
git add src/App.tsx src/components/evidence/EvidenceList.tsx src/components/evidence/EvidenceList.test.tsx src/components/evidence/evidenceList.css
git -c commit.gpgsign=false commit -m "refactor: extract shared evidence list"

git add src/App.tsx src/components/planning/RecurringTasksPanel.tsx src/components/planning/planningViews.test.tsx src/components/planning/planningViews.css
git -c commit.gpgsign=false commit -m "refactor: extract recurring task panel"

git add src/App.tsx src/components/planning/OutlineTable.tsx src/components/planning/planningViews.test.tsx src/components/planning/planningViews.css
git -c commit.gpgsign=false commit -m "refactor: extract outline table"

git add src/App.tsx src/components/planning/GanttChart.tsx src/components/planning/GanttTextTable.tsx src/components/planning/GanttTextTable.test.tsx src/components/planning/planningViews.test.tsx src/components/planning/planningViews.css
git -c commit.gpgsign=false commit -m "refactor: extract accessible Gantt views"
```

- [ ] Run `bun run test`, capture the identical seeded page as `docs/ui-review-v2/extraction-v1-plan-after.png`, and compare before/after. Expected: no behavioral or visual difference attributable to extraction. Commit the accepted after image separately from V2 wrappers.

- [ ] Test the V2 Plan stage: unbet/held/expired projects are read-only; each Work Item requires an active Bet scope; out-of-scope work renders the typed Re-bet action; dependencies, recurrence, Gantt, baseline, Monte Carlo, and EVM all use Task 9 adapters.

- [ ] Implement and test `GanttTextTable` as the always-available accessible alternative to the visual Gantt. It lists outline, title, start, finish, duration, critical state, predecessors with dependency type/lag, constraint diagnostics, and baseline variance. Link the visual Gantt with `aria-describedby` and provide a labeled `View schedule as table` control.

- [ ] Test Execute: only committed Today work appears as executable; ordinary completion records actual and outcome; validation milestones route to Evidence; PlanVersion and Baseline history are distinct.

- [ ] Implement V2 wrappers that translate user actions into commands. Never pass V2 a V1 `setWorkspace` callback.

- [ ] Replace the `plan` route registration with `PlanStage` and add `execute: ExecuteStage` in the same route map. Keep `PlanStageSummary` as the read-only header/empty state inside the full Plan stage.

- [ ] Run `bun run test`, `bun run test:ui`, `bun run build`, and `bun run build:v2`.

- [ ] Commit:

```bash
git add docs/ui-review-v2/extraction-v1-plan-after.png src/v2/app/project/plan src/v2/app/project/execute src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: reuse planning views in V2"
```

### Task 24: Build Today, Calendar, Commit Today, and explicit Replan

**Files:**

- Create: `src/v2/app/today/TodayPage.tsx`
- Create: `src/v2/app/today/TodayAgenda.tsx`
- Create: `src/v2/app/today/CalendarView.tsx`
- Create: `src/v2/app/today/CapacityMeter.tsx`
- Create: `src/v2/app/today/CommitTodayBar.tsx`
- Create: `src/v2/app/today/LaterList.tsx`
- Create: `src/v2/app/today/ReplanCard.tsx`
- Create: `src/v2/app/today/TodayPage.test.tsx`
- Create: `src/v2/app/today/CalendarView.test.tsx`
- Modify: `src/v2/app/routes.tsx`

- [ ] Test the proposed state, ordered agenda, capacity meters, Later reasons, and explicit `Commit today` action. The page must not imply commitment before the command succeeds.

- [ ] Test committed state with immutable version/timestamp/actor, and record actual/evidence actions for committed slots.

- [ ] Simulate an actual or unavailable-block change and assert a Replan card appears while the committed agenda remains unchanged. Only human acceptance replaces the displayed commitment, with a version-history link.

- [ ] Test `review_overdue`: already committed slots remain actionable, while Commit Today or Replan acceptance that adds/moves project work renders the Review action.

- [ ] Test Calendar at `/today/calendar` as a Today view toggle with Actions, committed Work Items, fixed constraints, and recurrence. It must not appear in global navigation.

- [ ] Test that the single TopActionCard renders the exact `selectRecommendedNextAction` result from Task 14, links to its permitted resolution, and never re-sorts, duplicates, or auto-redirects.

- [ ] Run focused tests.

Expected: FAIL because Today pages do not exist.

- [ ] Implement pages using `selectTodayStatus`, proposal generation, and commands. Never silently regenerate the visible committed plan after load.

- [ ] Run `bun run test:ui`, `bun run test:v2`, and `bun run build:v2`.

- [ ] Commit:

```bash
git add src/v2/app/today src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: require explicit daily commitment"
```

### Task 25: Build Evidence, Review, conflict resolution, and structured Close

**Files:**

- Create: `src/v2/app/project/evidence/EvidenceStage.tsx`
- Create: `src/v2/app/project/evidence/EvidenceExceptionDialog.tsx`
- Create: `src/v2/app/project/evidence/ProjectReportPanel.tsx`
- Create: `src/v2/app/project/evidence/EvidenceStage.test.tsx`
- Create: `src/v2/app/project/evidence/ProjectReportPanel.test.tsx`
- Create: `src/v2/app/review/ReviewPage.tsx`
- Create: `src/v2/app/review/ReviewQueue.tsx`
- Create: `src/v2/app/review/WeeklyReviewFlow.tsx`
- Create: `src/v2/app/review/EventReviewFlow.tsx`
- Create: `src/v2/app/review/ConflictResolver.tsx`
- Create: `src/v2/app/review/ExceptionReviewCard.tsx`
- Create: `src/v2/app/review/ReviewSummary.tsx`
- Create: `src/v2/app/review/ReviewPage.test.tsx`
- Create: `src/v2/app/review/ReviewSummary.test.tsx`
- Create: `src/v2/app/project/close/CloseStage.tsx`
- Create: `src/v2/app/project/close/SuccessEvidenceComparison.tsx`
- Create: `src/v2/app/project/close/UnfinishedWorkDisposition.tsx`
- Create: `src/v2/app/project/close/ClosedProjectRecord.tsx`
- Create: `src/v2/app/project/close/CloseStage.test.tsx`
- Modify: `src/v2/app/routes.tsx`

- [ ] Test evidence attachment, validation requirement status, active exception details, expiring/expired states, human approval confirmation, and the absence of generic gate clearing.

- [ ] Test weekly and event Review queues, guided conclusion, overdue restrictions, existing committed execution, exception review, and history.

- [ ] Test sync conflicts with both versions visible, affected record IDs, retained-version choice, and optional valid-command reapplication. Resolving one conflict must not discard unrelated changes.

- [ ] Test `ProjectReportPanel` and `ReviewSummary` against `reportingAdapter`: show EVM, Monte Carlo, baseline variance, capacity variance, and evidence freshness only when inputs exist; render a precise unavailable reason otherwise. These contextual panels must not create a Reports global destination.

- [ ] Test Close form requirements: success comparison, outcome, learning, unfinished-work disposition, human confirmation. Submit remains unavailable until the domain selector says the command is permitted.

- [ ] Test the closed record as immutable and accessible. Archive is a separate visibility action and does not change the displayed Close history.

- [ ] Test a migrated legacy-closed project separately: show the original V1 done/archived status and migration checksum provenance, do not claim that a structured V2 CloseDecision exists, and keep the project immutable.

- [ ] Run focused tests.

Expected: FAIL because the lifecycle completion pages do not exist.

- [ ] Implement against selectors and commands. Reports appear contextually inside Evidence/Close and Review summaries; do not restore Reports as global navigation.

- [ ] Register `evidence: EvidenceStage` and `close: CloseStage` in the project route map. At this point every legal lifecycle segment has a concrete stage component; retain the fail-fast branch for any future unregistered unlocked stage.

- [ ] Make Evidence/reports, Review/conflicts, and Close three independently green commits. Run focused tests, `bun run test:v2`, and `bun run build:v2` before each commit:

```bash
git add src/v2/app/project/evidence src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: guide project Evidence"

git add src/v2/app/review src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: guide Review and conflict resolution"

git add src/v2/app/project/close src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: require structured project Close"
```

### Task 26: Build compact Settings, Automation history, migration, and recovery UI

**Files:**

- Create: `src/v2/app/settings/SettingsPage.tsx`
- Create: `src/v2/app/settings/SettingsSectionCard.tsx`
- Create: `src/v2/app/settings/CapacitySection.tsx`
- Create: `src/v2/app/settings/SyncSection.tsx`
- Create: `src/v2/app/settings/SecretsSection.tsx`
- Create: `src/v2/app/settings/AiProviderSection.tsx`
- Create: `src/v2/app/settings/WorkspaceSection.tsx`
- Create: `src/v2/app/settings/AutomationSection.tsx`
- Create: `src/v2/app/settings/SettingsPage.test.tsx`
- Create: `src/v2/app/migration/MigrationPage.tsx`
- Create: `src/v2/app/migration/MigrationReviewPage.tsx`
- Create: `src/v2/app/migration/RecoveryPage.tsx`
- Create: `src/v2/app/migration/MigrationPage.test.tsx`
- Modify: `src/v2/app/routes.tsx`

- [ ] Test compact, collapsed Settings sections for Capacity, Sync, Secrets, AI Provider, Workspace, and Automation. Agent operations live only in Automation; AI Provider remains configuration-only.

- [ ] Test Automation authority explanations, applied/rejected receipt history, pending proposals, human accept/dismiss actions, and stable rejection details.

- [ ] Test Workspace transfer actions with distinct labels and explanations: `Export verified backup`, `Import portable commands`, and `Restore verified backup`. Render checksum/validation errors inline and require human confirmation before restore; never present raw snapshot import as an approval-preserving shortcut.

- [ ] Test first-load migration: show source summary and checksum, require verified backup, offer backup download, run migration explicitly, and never enter operational V2 pages until migration validates.

- [ ] Add and test exact recovery routes: `/migration` for source/backup, `/migration/review/:projectId` for guided active-project review, and `/recovery` for migration or restore failure. Provider bootstrap redirects only to these explicit routes, `/setup`, or `/today`; it never picks a project route opportunistically.

- [ ] Test active project migration review: V2 operational views are read-only, the prefilled six-decision brief identifies missing fields, and only a human Bet removes `migration_review`.

- [ ] Test recovery for backup-verification, validation, quota, and transaction failures. Show exact error and checksum, retain V1 source, and offer Download backup, Restore backup, and Retry. Never show a half-migrated workspace.

- [ ] Run focused tests.

Expected: FAIL because Settings and migration UI do not exist.

- [ ] Implement Settings with progressive disclosure and migration/recovery pages over Task 17 services. Preserve existing encrypted sync, secrets, and provider settings through adapters rather than copying their algorithms.

- [ ] Make Settings/Automation and migration/recovery two independently green commits. Run focused tests, `bun run test:v2`, `bun run build`, and `bun run build:v2` before each commit:

```bash
git add src/v2/app/settings src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: add compact V2 settings and automation"

git add src/v2/app/migration src/v2/app/routes.tsx
git -c commit.gpgsign=false commit -m "feat: guide migration and recovery"
```

### Task 27: Prove the complete product with end-to-end, accessibility, visual, and scale suites

**Files:**

- Create: `scripts/serve-e2e.ts`
- Modify: `playwright.config.ts`
- Create: `tests/e2e/support/seedWorkspace.ts`
- Create: `tests/e2e/support/assertions.ts`
- Create: `tests/e2e/support/reviewArtifacts.ts`
- Create: `tests/e2e/onboarding-and-navigation.spec.ts`
- Create: `tests/e2e/project-lifecycle.spec.ts`
- Create: `tests/e2e/today-capacity.spec.ts`
- Create: `tests/e2e/review-exceptions.spec.ts`
- Create: `tests/e2e/migration-recovery.spec.ts`
- Create: `tests/e2e/agent-authority.spec.ts`
- Create: `tests/e2e/sync-conflict.spec.ts`
- Create: `tests/e2e/policy-bypass.spec.ts`
- Create: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/visual.spec.ts`
- Create: `tests/e2e/scale.spec.ts`
- Create: `docs/ui-review-v2/README.md`
- Create: `docs/ui-review-v2/*.png`
- Create: `docs/ui-review-v2/*.snapshot.txt`
- Create: `docs/ui-review-v2/*.metrics.json`

- [ ] Install pinned Playwright browsers for the current environment:

```bash
bunx playwright install chromium webkit
```

- [ ] Implement `scripts/serve-e2e.ts` to serve the built V2 `dist` plus a test-only same-origin `/__e2e__/blank` response that is never copied into production assets. Point Playwright's web server at `bun run build:v2 && bun scripts/serve-e2e.ts`.

- [ ] Implement race-free test seeding: navigate to `/__e2e__/blank` to establish the origin without booting OmniPlan, open the real IndexedDB through `page.evaluate`, wait for the seed transaction to complete and the database to close, then navigate to the tested app route. The helper may write fixtures directly only as test setup; no seed/debug command may ship in the production UI or command API.

- [ ] Implement these end-to-end flows through visible UI and public Agent routes:

  1. capacity setup -> Inbox -> Action -> Today -> completion;
  2. Inbox -> Project -> six Direction decisions -> human Bet -> Plan -> Today Commit;
  3. actual and evidence -> validation -> structured Close;
  4. material brief edit -> execution pause -> human Re-bet;
  5. overdue Review -> existing execution allowed -> new commitment rejected;
  6. evidence exception -> expiry -> evidence gate reopens;
  7. V1 migration -> Needs review -> human Bet;
  8. sync conflict -> Review -> human resolution;
  9. Agent low-risk apply -> proposal -> human acceptance -> guarded rejection;
  10. attempted direct-stage, import, Agent, sync, stale-revision, and expired-Bet bypass.

- [ ] Run functional flows in desktop Chromium, desktop WebKit, and mobile WebKit at 390 by 844. Use role/name locators; do not depend on internal CSS class names.

- [ ] Add axe WCAG 2.2 A/AA checks for setup, Inbox, Today, Projects, every lifecycle stage, Review, Settings, migration, blocked states, and conflict states.

- [ ] Add explicit interaction checks for keyboard-only core flow, visible focus, route-title focus, dialog/sheet trap and restore, textual lifecycle labels, accessible locked reasons, minimum 44 by 44 CSS pixel touch targets, and 200% zoom reflow without page-level horizontal loss. Gantt may scroll horizontally only while an accessible text table remains available.

- [ ] Create canonical visual artifacts for desktop and mobile versions of:

```text
onboarding-capacity
inbox-empty
inbox-triage-action
inbox-triage-project
today-proposed
today-committed
today-overflow
today-replan
projects-portfolio
project-direction
project-awaiting-bet
project-planning
project-executing
project-validating
project-closing
project-closed
evidence-blocked
migration-review
rebet-required
review-overdue
sync-conflict
exception-expired
```

For each artifact, save a PNG, a semantic `.snapshot.txt`, and a `.metrics.json` with viewport, overflow, target-size, and visible-element counts under `docs/ui-review-v2/`. Pin pixel comparison to desktop Chromium; use semantic/metric assertions for other engines.

- [ ] Add the scale fixture: 50 projects and 300 Work Items with active Bets, holds, Actions, dependencies, recurrence, evidence, commitments, and cross-project capacity contention. Exercise migration, Projects rendering, Today generation, scheduler projection, Gantt text alternative, and Review derivation.

- [ ] Use `bun run test:a11y`, `bun run test:visual`, and `bun run test:scale` as focused filters while developing those specs. Then run the complete browser suite once:

```bash
bun run test:e2e
```

Expected: all suites pass with no unexpected console error, failed request, uncaught page error, accessibility violation, page-level overflow, or policy bypass.

- [ ] Open the generated desktop and mobile PNGs and perform a human visual review. Record accepted exceptions and rationale in `docs/ui-review-v2/README.md`; do not update baselines merely to silence a regression.

- [ ] Commit:

```bash
git add scripts/serve-e2e.ts tests/e2e docs/ui-review-v2 playwright.config.ts
git -c commit.gpgsign=false commit -m "test: verify V2 user journeys"
```

### Task 28: Make all release gates reproducible in one command and CI

**Files:**

- Create: `scripts/verify-v2.ts`
- Create: `scripts/sourceFingerprint.ts`
- Create: `scripts/sourceFingerprint.test.ts`
- Create: `.github/workflows/v2-acceptance.yml`
- Modify: `package.json`
- Create: `docs/release/omniplan-v2-acceptance.md`
- Create: `docs/release/omniplan-v2-acceptance.json`

- [ ] Write a script test or dry-run assertion that verifies this exact ordered gate list:

```ts
const steps = [
  ["Existing and V2 unit/integration tests", ["bun", "run", "test"]],
  ["V2 property tests", ["bun", "run", "test:property"]],
  ["TypeScript", ["bun", "run", "typecheck"]],
  ["Production default build", ["bun", "run", "build"]],
  ["Explicit V1 regression build", ["bun", "run", "build:v1"]],
  ["Production V2 build", ["bun", "run", "build:v2"]],
  ["End-to-end, accessibility, visual, and scale", ["bun", "run", "test:e2e"]],
  ["Working-tree whitespace", ["git", "diff", "--check"]],
  ["Review artifact drift", ["git", "diff", "--exit-code", "--", "docs/ui-review-v2"]]
] as const;
```

- [ ] Implement `scripts/verify-v2.ts` with `Bun.spawn`, inherited stdout/stderr, immediate stop on the first non-zero exit, elapsed-time reporting, and a final `V2 ACCEPTANCE PASSED` only when every child process exits zero. Resolve `git merge-base HEAD origin/main`, run `git diff --check <merge-base>..HEAD`, run the same whitespace check over each untracked non-ignored file, and fail if `git grep --untracked --exclude-standard -n -E '^(<<<<<<<|=======|>>>>>>>)'` finds a conflict marker; treat grep exit 1 as the expected no-match result.

- [ ] Ensure `test:e2e` already includes accessibility, visual, and scale specs once; the narrower scripts remain convenient filters and must not make `verify:v2` execute the same suite four times.

- [ ] Add a GitHub Actions workflow using Bun, cached dependencies, pinned Playwright Chromium/WebKit installation, `bun install --frozen-lockfile`, and `bun run verify:v2`. Upload Playwright reports and changed review artifacts only on failure.

- [ ] Create `docs/release/omniplan-v2-acceptance.md` with a traceable result row for every approved acceptance criterion, the verifying test path, and the latest evidence command. A row may be marked Passed only from a successful current run.

- [ ] After every gate passes, generate `docs/release/omniplan-v2-acceptance.json` with schema version, completed timestamp, exact command results, SHA-256 of all visual-review artifacts, and a `sourceFingerprint`. Compute the fingerprint from sorted bytes of `git ls-files --cached --others --exclude-standard`, excluding only `docs/release/omniplan-v2-acceptance.json`, `dist/`, `playwright-report/`, `test-results/`, and `.DS_Store`. Add a unit test proving modified and untracked source files change the fingerprint while regenerating the manifest or transient output does not.

- [ ] Run `bun run verify:v2`.

Expected: the script ends with `V2 ACCEPTANCE PASSED`; current V1 tests, all V2 tests, both builds, all browser suites, and diff checks are green.

- [ ] Commit:

```bash
git add scripts/verify-v2.ts scripts/sourceFingerprint.ts scripts/sourceFingerprint.test.ts .github/workflows/v2-acceptance.yml package.json docs/release/omniplan-v2-acceptance.md docs/release/omniplan-v2-acceptance.json
git -c commit.gpgsign=false commit -m "ci: gate the complete V2 release"
```

### Task 29: Perform the single production cutover

**Files:**

- Create: `scripts/check-v2-cutover.ts`
- Create: `scripts/check-v2-cutover.test.ts`
- Create: `scripts/build-sw-upgrade-fixtures.ts`
- Create: `scripts/serve-sw-upgrade.ts`
- Create: `playwright.sw.config.ts`
- Create: `tests/e2e/fixtures/sw-v1.js`
- Create: `tests/e2e/service-worker-upgrade.spec.ts`
- Create: `docs/release/omniplan-v2-cutover.md`
- Modify: `scripts/verify-v2.ts`
- Modify: `src/appEntry.ts`
- Modify: `src/appEntry.test.ts`
- Modify: `src/main.tsx`
- Modify: `public/sw.js`
- Modify: `public/manifest.webmanifest`
- Modify: `package.json`

- [ ] Write the cutover guard test before changing the default. It must fail unless all of these are true:

  - production entry resolves to V2;
  - setup completion defaults to `/today`;
  - production `/agent/*` resolves to `AgentAppV2`;
  - V1 storage remains read-only and available for recovery;
  - V2 repository schema is 2;
  - service-worker cache name is not `omni-plan-personal-v1`;
  - manifest share target still reaches `/agent/commands`;
  - no runtime user-facing V1/V2 toggle exists;
  - the latest acceptance JSON is complete, its source fingerprint matches the current working tree, and its visual-artifact hash matches current artifacts.

- [ ] Run `bunx vitest run scripts/check-v2-cutover.test.ts`.

Expected: FAIL because production still defaults to V1.

- [ ] Freeze V1 feature changes for the cutover window and run production-like migration dry runs against every fixture plus a backup of the current browser workspace.

- [ ] Flip the source production default in `src/appEntry.ts` from V1 to V2. Preserve an internal build-time V1 mode only for engineering diagnosis; expose no query, setting, or localStorage switch.

- [ ] Route production Agent paths to `AgentAppV2` through the V2 generation entry, preserving all documented `/agent/*` URLs and the share target. Keep `src/AgentApp.tsx` unchanged as the internal V1 diagnostic entry.

- [ ] Change `CACHE_NAME` in `public/sw.js` to `omni-plan-personal-v2`, keep old-cache deletion in `activate`, call `self.skipWaiting()` after the V2 install completes, and call `clients.claim()` during activation.

- [ ] Build a real same-origin upgrade harness. `build-sw-upgrade-fixtures.ts` builds V1 into `dist/sw-v1` and V2 into `dist/sw-v2`, then replaces only the V1 fixture's `sw.js` with the committed pre-cutover `tests/e2e/fixtures/sw-v1.js`. `serve-sw-upgrade.ts` serves one origin on port 4180 and exposes a test-only control endpoint that atomically switches its document root from V1 to V2. `playwright.sw.config.ts` starts that server for only the upgrade spec.

- [ ] In `service-worker-upgrade.spec.ts`, install and activate the V1 worker, populate V1 storage, switch the same origin to V2, request `registration.update()`, wait for controller change, reload, and assert V2 shell/migration appears, V1 cache is deleted, the V1 raw payload remains, and no stale V1 HTML or assets are served.

- [ ] Add `test:sw-upgrade` to `package.json` and to the acceptance sequence in `scripts/verify-v2.ts`. This gate is introduced here, after the V2 cache implementation exists; Task 28 must not claim it passed earlier.

- [ ] Update manifest description to the guided V2 product while retaining name, icons, standalone display, and share target. Keep `start_url: "/"`; the app bootstrap chooses setup, migration, recovery, or Today deterministically.

- [ ] Write `docs/release/omniplan-v2-cutover.md` with preflight, backup checksum, migration smoke result, release command, post-release smoke paths, monitoring checks, and recovery procedure. Recovery restores the verified V1 backup into migration input; it does not expose V1 as a normal user mode.

- [ ] Run:

```bash
bun run verify:v2
bunx vitest run scripts/check-v2-cutover.test.ts
bun run build
bun run preview -- --port 4173
```

Expected: cutover guard passes, `V2 ACCEPTANCE PASSED` appears, production build succeeds, `/` resolves to setup/migration/Today as appropriate, and `/agent/manual.txt` reports protocol `2026-07-10.v2`.

- [ ] Manually smoke-test installed/offline upgrade, migration backup download, one Action flow, one complete Project flow, one rejected Agent Bet, one conflict Review, and closed immutability.

- [ ] Record the smoke results in the cutover document, then rerun `bun run verify:v2` followed by `bunx vitest run scripts/check-v2-cutover.test.ts`. Make no source, config, release-doc, lockfile, or visual-artifact edit after this final fingerprint/guard pair.

- [ ] Commit the cutover only after all evidence is current:

```bash
git add scripts/check-v2-cutover.ts scripts/check-v2-cutover.test.ts scripts/build-sw-upgrade-fixtures.ts scripts/serve-sw-upgrade.ts scripts/verify-v2.ts playwright.sw.config.ts tests/e2e/fixtures/sw-v1.js tests/e2e/service-worker-upgrade.spec.ts docs/release/omniplan-v2-cutover.md docs/release/omniplan-v2-acceptance.json src/appEntry.ts src/appEntry.test.ts src/main.tsx public/sw.js public/manifest.webmanifest package.json
git -c commit.gpgsign=false commit -m "feat: cut over OmniPlan to enforced lifecycle V2"
```

## Acceptance traceability

| Approved outcome | Primary implementation | Required proof |
| --- | --- | --- |
| Capture never creates an active project | Tasks 5-6, 21 | `actionPolicy.test.ts`, Inbox UI test, Action E2E |
| Action boundary forces promotion | Tasks 6, 21 | all six eligibility rules plus promotion E2E |
| No project work without human Bet | Tasks 3-9 | policy matrix, property sequence, lifecycle E2E |
| All origins share one policy | Tasks 5, 16, 18, 18A, 19 | origin-parity integration and bypass E2E |
| Future stages visible but locked | Tasks 14, 22 | lifecycle selector and deep-link tests |
| Material Direction change requires Re-bet | Tasks 8, 22 | six-field invalidation matrix and E2E |
| Today never exceeds capacity | Tasks 10-11, 24 | Today domain/property/UI/scale tests |
| No silent committed-plan movement | Tasks 11, 24 | Replan version tests and E2E |
| Evidence or active exception gates validation | Tasks 12, 25 | expiry matrix and Review/exception E2E |
| No generic gate clearing | Tasks 12, 25 | source assertion and UI query |
| Review overdue blocks only new commitment | Tasks 11, 13, 24-25 | policy matrix and E2E |
| Agent authority is bounded | Tasks 4, 19, 26 | Agent matrix, protocol UI, Agent E2E |
| Migration preserves data and requires review | Tasks 17, 26 | exact manifests, atomic failure, migration E2E |
| Close is structured and immutable | Tasks 14, 25 | disposition matrix, property test, Close E2E |
| Four primary destinations and Today default | Tasks 20, 24 | shell/focus tests and navigation E2E |
| Failures remain recoverable | Tasks 16-18, 26 | transaction abort, recovery, conflict E2E |
| Existing calculation engines remain correct | Tasks 9, 23, 28 | adapter parity plus full V1 regression suite |
| One complete cutover | Tasks 27-29 | acceptance command and cutover guard |

## Execution checkpoints

After Task 15, stop and review the pure domain with the approved design before connecting storage. After Task 19, run a policy-bypass review across every origin before building mutation UI. After Task 26, the entire product must be reachable in the internal V2 build. Tasks 27-29 are release gates, not optional polish.

At each checkpoint, compare implementation against:

```text
docs/superpowers/specs/2026-07-10-omniplan-enforced-lifecycle-v2-design.md
```

Do not resolve a mismatch by weakening the approved lifecycle. Either fix the implementation or record a new explicit product decision before proceeding.
