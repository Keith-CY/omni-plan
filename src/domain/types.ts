export type Id = string;
export type ISODate = string;
export type Seconds = number;

export type ProjectStatus = "active" | "waiting" | "paused" | "done" | "archived";
export type ProjectMode = "explore" | "build" | "ship" | "maintain";
export type PlanningMethod = "omniplan" | "shape-up";
export type OmniPlanStage = "plan" | "execute" | "review" | "close";
export type ShapeUpStage = "shape" | "bet" | "build" | "cool-down" | "close";
export type ProjectStage = OmniPlanStage | ShapeUpStage;
export type WorkItemKind = "phase" | "task" | "milestone" | "hammock";
export type DependencyType = "FS" | "SS" | "FF" | "SF";
export type AttentionKind = "deep" | "medium" | "shallow";
export type AuditAction = "Accelerate" | "Continue" | "Narrow" | "Pivot" | "Stop";
export type EvidenceKind = "note" | "commit" | "pr" | "ci" | "doc" | "screenshot" | "release" | "feedback" | "metric" | "email" | "calendar" | "minutes" | "booking";
export type ChangeSetStatus = "draft" | "queued-audit" | "approved" | "blocked";
export type ShapeUpAppetiteKind = "small-batch" | "big-batch";
export type RepeatExecutionMode = "manual" | "automatic";
export type RepeatEndMode = "count" | "until" | "never";
export type RecurringOccurrenceStatus = "scheduled" | "occurred" | "exception" | "skipped";
export type RecurringSettlementSource = "on-time" | "system-catch-up" | "manual";
export type TodoStatus = "open" | "completed";
export type ConversionType = "todo_to_task" | "task_to_todo" | "todo_to_project";

export interface TodoChecklistItem {
  id: Id;
  title: string;
  completed: boolean;
}

export interface Todo {
  id: Id;
  title: string;
  note?: string;
  tags: string[];
  flagged: boolean;
  estimatedSeconds?: Seconds;
  deferUntil?: ISODate;
  dueAt?: ISODate;
  repeatRule?: RepeatRule;
  /** Number of occurrences already acknowledged for this repeating Todo. */
  repeatCompletedCount?: number;
  /** Completion boundary used by after-previous-finish recurrence. */
  lastRepeatCompletedAt?: ISODate;
  checklist: TodoChecklistItem[];
  plannedForDate?: string;
  status: TodoStatus;
  completedAt?: ISODate;
  capturedAt: ISODate;
  updatedAt: ISODate;
  inbox: boolean;
}

export interface ConversionHistoryEntry {
  id: Id;
  type: ConversionType;
  itemId: Id;
  projectId?: Id;
  occurredAt: ISODate;
  /** Audit-only names of project-specific data discarded by the conversion. */
  discardedFields: string[];
}

export interface DirectionCard {
  targetUser: string;
  userProblem: string;
  businessGoal: string;
  coreHypothesis: string;
  successMetric: string;
  failureCondition: string;
  validationMethod: string;
  timeboxDays: number;
  opportunityCost: string;
}

export interface Project {
  id: Id;
  name: string;
  status: ProjectStatus;
  archived?: boolean;
  archivedAt?: ISODate;
  mode: ProjectMode;
  priority: number;
  northStar: string;
  currentOutcome: string;
  horizon: ISODate;
  start: ISODate;
  /** Optional only so legacy schema-1/2 records can be normalized into schema 3. */
  planningMethod?: PlanningMethod;
  /** Optional only so legacy schema-1/2 records can be normalized into schema 3. */
  stage?: ProjectStage;
  directionCard?: DirectionCard;
  shapeUpPitch?: ShapeUpPitch;
  reviewCadenceDays: number;
}

export interface ShapeUpScope {
  id: Id;
  title: string;
  description: string;
  confirmed: boolean;
  hillPosition: number;
  niceToHave?: boolean;
}

export interface ShapeUpBet {
  approvedAt: ISODate;
  auditDecisionId: Id;
  cycleStart: ISODate;
  cycleEnd: ISODate;
  circuitBreakerAt: ISODate;
  summary: string;
}

export interface ShapeUpPitch {
  problem: string;
  appetiteKind: ShapeUpAppetiteKind;
  appetiteDays: number;
  solutionSketch: string;
  rabbitHoles: string;
  noGos: string;
  successBaseline: string;
  scopes: ShapeUpScope[];
  bet?: ShapeUpBet;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Constraint {
  noEarlierThan?: ISODate;
  noLaterThan?: ISODate;
  fixedStart?: ISODate;
  fixedFinish?: ISODate;
}

export interface Estimate {
  optimisticSeconds?: Seconds;
  mostLikelySeconds: Seconds;
  pessimisticSeconds?: Seconds;
}

export interface Assignment {
  resourceId: Id;
  attention: AttentionKind;
  effortSeconds: Seconds;
}

export interface SplitSegment {
  offsetSeconds: Seconds;
  durationSeconds: Seconds;
}

export interface RepeatRule {
  id?: Id;
  cadence?: RepeatCadenceKind;
  everyDays?: number;
  count: number;
  startMode?: RepeatStartMode;
  startAt?: ISODate;
  executionMode?: RepeatExecutionMode;
  endMode?: RepeatEndMode;
  until?: ISODate;
  reminderLeadSeconds?: Seconds;
  automaticDurationSeconds?: Seconds;
  automaticFrom?: ISODate;
  stoppedAt?: ISODate;
}

export type RepeatCadenceKind = "every-n-days" | "weekly" | "monthly";
export type RepeatStartMode = "fixed-time" | "after-previous-finish";

export interface WorkItem {
  id: Id;
  projectId: Id;
  parentId?: Id;
  kind: WorkItemKind;
  title: string;
  description?: string;
  tags?: string[];
  flagged?: boolean;
  checklist?: TodoChecklistItem[];
  plannedForDate?: string;
  capturedAt?: ISODate;
  updatedAt?: ISODate;
  completedAt?: ISODate;
  outline: string;
  durationSeconds: Seconds;
  estimate: Estimate;
  constraint?: Constraint;
  assignmentIds: Assignment[];
  percentComplete: number;
  isKeyTask?: boolean;
  isScopeExpansion?: boolean;
  isFastDelivery?: boolean;
  splitSegments?: SplitSegment[];
  repeatRule?: RepeatRule;
  hammockStartId?: Id;
  hammockFinishId?: Id;
  evidenceRequired?: boolean;
  shapeUpScopeId?: Id;
  /** A pre-Bet Shape Up task is recorded but cannot enter execution. */
  shapeUpLocked?: boolean;
  isShapeUpCycleMarker?: boolean;
}

export interface RecurringOccurrenceRecord {
  id: Id;
  ruleId: Id;
  workItemId: Id;
  projectId: Id;
  occurrenceIndex: number;
  scheduledStart: ISODate;
  scheduledFinish: ISODate;
  start: ISODate;
  finish: ISODate;
  status: RecurringOccurrenceStatus;
  title: string;
  description: string;
  createdAt: ISODate;
  updatedAt: ISODate;
  settledAt?: ISODate;
  settlementSource?: RecurringSettlementSource;
  exceptionNote?: string;
  followUpWorkItemId?: Id;
}

export interface Dependency {
  id: Id;
  projectId: Id;
  fromId: Id;
  toId: Id;
  type: DependencyType;
  lagSeconds: Seconds;
}

export interface Resource {
  id: Id;
  name: string;
  role: string;
  capacityByAttention: Record<AttentionKind, Seconds>;
  hourlyRate: number;
}

export interface AttentionCapacity {
  date: ISODate;
  deepSeconds: Seconds;
  mediumSeconds: Seconds;
  shallowSeconds: Seconds;
  unavailableBlocks: Array<{ start: ISODate; finish: ISODate }>;
}

export interface Actual {
  workItemId: Id;
  actualStart?: ISODate;
  actualFinish?: ISODate;
  actualWorkSeconds: Seconds;
  remainingWorkSeconds: Seconds;
  actualCost: number;
  recordedAt: ISODate;
}

export interface Baseline {
  id: Id;
  projectId: Id;
  name: string;
  capturedAt: ISODate;
  plannedStartByItem: Record<Id, ISODate>;
  plannedFinishByItem: Record<Id, ISODate>;
  plannedWorkSecondsByItem: Record<Id, Seconds>;
  approvedByDecisionId?: Id;
}

export interface Evidence {
  id: Id;
  kind: EvidenceKind;
  summary: string;
  url?: string;
  localFileRef?: string;
  projectId: Id;
  workItemId?: Id;
  createdAt: ISODate;
  confidence: number;
  tags: string[];
}

export interface Decision {
  id: Id;
  projectId: Id;
  statement: string;
  context: string;
  options: string[];
  rationale: string;
  consequences: string;
  revisitAt?: ISODate;
  linkedEvidenceIds: Id[];
  createdAt: ISODate;
}

export interface ChangeSet {
  id: Id;
  projectId: Id;
  title: string;
  status: ChangeSetStatus;
  createdAt: ISODate;
  reason: string;
  diffs: Array<{ entity: string; entityId: Id; field: string; before: unknown; after: unknown }>;
  rollbackToken: string;
  auditGateIds: Id[];
}

export interface AuditGate {
  id: Id;
  projectId: Id;
  targetType: "project" | "milestone" | "baseline" | "scope" | "delivery";
  targetId: Id;
  severity: "info" | "warning" | "hard";
  reason: string;
  requiredAction: string;
  status: "open" | "queued" | "cleared" | "blocked";
}

export interface AuditDecision {
  id: Id;
  projectId: Id;
  action: AuditAction;
  strongestContinueEvidence: string;
  strongestStopReason: string;
  rationale: string;
  createdAt: ISODate;
  sourceGateIds: Id[];
}

export interface ProviderSecret {
  id: Id;
  provider: "openai" | "anthropic" | "google" | "github" | "openrouter" | "custom";
  label: string;
  encryptedValue: string;
  iv: string;
  salt: string;
  createdAt: ISODate;
}

export interface ScheduledItem {
  workItem: WorkItem;
  start: ISODate;
  finish: ISODate;
  earlyStart: ISODate;
  earlyFinish: ISODate;
  lateStart: ISODate;
  lateFinish: ISODate;
  totalFloatSeconds: Seconds;
  freeFloatSeconds: Seconds;
  isCritical: boolean;
  warnings: string[];
}

export interface ScheduleResult {
  projectId: Id;
  items: ScheduledItem[];
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; itemId?: Id }>;
  unsupported: string[];
}

export interface LevelingProposal {
  id: Id;
  projectId: Id;
  resourceId: Id;
  attention: AttentionKind;
  workItemId: Id;
  moveBySeconds: Seconds;
  beforeStart: ISODate;
  afterStart: ISODate;
  reason: string;
  criticalPathImpactSeconds: Seconds;
}

export interface EvmResult {
  projectId: Id;
  asOf: ISODate;
  plannedValue: number;
  earnedValue: number;
  actualCost: number;
  schedulePerformanceIndex: number;
  costPerformanceIndex: number;
  estimateAtCompletion: number;
}

export interface MonteCarloResult {
  projectId: Id;
  simulations: number;
  p50Finish: ISODate;
  p75Finish: ISODate;
  p90Finish: ISODate;
  finishDistribution: Array<{ finish: ISODate; count: number }>;
}

export interface WorkspaceSnapshot {
  schemaVersion: 3;
  timeZone: string;
  todos: Todo[];
  conversionHistory: ConversionHistoryEntry[];
  projects: Project[];
  workItems: WorkItem[];
  recurringOccurrences: RecurringOccurrenceRecord[];
  dependencies: Dependency[];
  resources: Resource[];
  capacities: AttentionCapacity[];
  baselines: Baseline[];
  actuals: Actual[];
  evidence: Evidence[];
  decisions: Decision[];
  changeSets: ChangeSet[];
  auditGates: AuditGate[];
  auditDecisions: AuditDecision[];
}
