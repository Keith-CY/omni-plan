import type {
  AttentionCapacity,
  Baseline,
  Dependency,
  Evidence,
  Id,
  ISODate,
  Resource,
  Seconds,
  WorkItem,
} from "@/domain/types";
import type { ProtectedEffectBundle } from "../repositories/syncConflictBundles";

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
export type SourceCapability =
  | "human_decision"
  | "capture_inbox"
  | "record_actual"
  | "attach_evidence"
  | "submit_proposal"
  | "import_portable"
  | "replay_receipt"
  | "system_time"
  | "open_conflict";
export type AttentionKind = "deep" | "medium" | "shallow";
export type CloseOutcome = "achieved" | "partial" | "invalidated" | "abandoned";
export type WorkDisposition =
  | "discard"
  | "return_to_inbox"
  | "follow_up_project"
  | "historical_incomplete";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
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
  resultStatus?: ResultStatus;
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

export type ProjectWorkItem = Omit<
  WorkItem,
  "shapeUpScopeId" | "isShapeUpCycleMarker"
> & {
  revision: number;
  betScopeId: Id;
  resultStatus?: ResultStatus;
  outcomeNote?: string;
};

export type ProjectDependency = Dependency & { revision: number };

export interface ActualV2 {
  id: Id;
  revision: number;
  target:
    | { kind: "action"; actionId: Id }
    | { kind: "work_item"; workItemId: Id };
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
  weeklyWindows: Array<{
    weekday: Weekday;
    startMinute: number;
    finishMinute: number;
  }>;
  dailyBudgets: Array<{
    weekday: Weekday;
    deepSeconds: Seconds;
    mediumSeconds: Seconds;
    shallowSeconds: Seconds;
  }>;
  unavailableBlocks: Array<{ id: Id; start: ISODate; finish: ISODate }>;
  updatedAt: ISODate;
  updatedBy: Id;
}

export interface CommitmentSlot {
  id: Id;
  target:
    | { kind: "action"; actionId: Id }
    | { kind: "work_item"; workItemId: Id; projectId: Id };
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
  triggerType:
    | "weekly"
    | "bet_midpoint"
    | "bet_expired"
    | "evidence_stale"
    | "exception_expired"
    | "capacity_variance"
    | "hard_gate"
    | "sync_conflict";
  status: ReviewStatus;
  affectedProjectIds: Id[];
  affectedRecordIds: Id[];
  dueAt: ISODate;
  cadenceTimeZone?: string;
  createdAt: ISODate;
  overdueMarkedAt?: ISODate;
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
  commandType:
    | "update_direction"
    | "create_work_item"
    | "update_work_item"
    | "propose_replan"
    | "upsert_dependency"
    | "remove_dependency";
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
  remoteRecordId?: Id;
  projectId?: Id;
  logicalKey?: string;
  affectedProjectIds?: Id[];
  affectedRecordIds?: Id[];
  commonAncestorHash: string;
  localValue: JsonValue;
  remoteValue: JsonValue;
  localBundle?: ProtectedEffectBundle;
  remoteBundle?: ProtectedEffectBundle;
  openedAt: ISODate;
  resolvedAt?: ISODate;
  retainedVersion?: "local" | "remote";
  retainedBundleHash?: string;
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
  recordType:
    | "decision"
    | "audit_decision"
    | "audit_gate"
    | "change_set"
    | "shape_up_pitch"
    | "legacy_closure";
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
