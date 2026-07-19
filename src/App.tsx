import {
  AlertTriangle,
  ArrowRightLeft,
  Archive,
  ArchiveRestore,
  BarChart3,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  CircleSlash2,
  ClipboardCheck,
  FileDown,
  FileJson,
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  Home,
  Inbox,
  KeyRound,
  Layers3,
  Lock,
  Network,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldAlert,
  Target,
  Timer,
  Trash2,
  Save,
  Upload,
  Workflow,
  Zap
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { evaluateAuditGates, recommendAuditDecision } from "./domain/audit";
import { calculateEvm } from "./domain/evm";
import { exportProjectMarkdown, exportScheduleCsv } from "./domain/exports";
import { fetchPullRequestEvidence, githubPrToEvidence } from "./domain/github";
import { runMonteCarlo } from "./domain/monteCarlo";
import { calculateProjectHealth } from "./domain/portfolio";
import {
  applyAutomaticOccurrenceAction,
  applyAutomaticRuleEditBoundary,
  changeRecurringWorkspaceTimeZone,
  generateRecurringOccurrences,
  isAutomaticRecurringWorkItem,
  nextRecurringOccurrence,
  projectRecurringOccurrences,
  reconcileAutomaticOccurrences,
  repeatCadenceLabel,
  repeatEndMode,
  repeatExecutionMode,
  repeatStartModeLabel,
  selectAutomaticOccurrenceHistory,
  selectAutomaticReminderOccurrences,
  type AutomaticOccurrenceAction,
  type RecurringOccurrence
} from "./domain/recurring";
import {
  isProjectArchived,
  projectLifecycleLabel,
  projectLifecycleStatus,
  removeEmptyProjectFromWorkspace,
  selectableProjectStatuses,
  withProjectArchived,
  withProjectLifecycleStatus,
  withProjectRestored
} from "./domain/projectLifecycle";
import {
  detectCrossProjectOverload,
  generateLevelingProposals
} from "./domain/scheduler";
import { BrowserEncryptedSecretVault, BrowserRememberedPassphraseVault, browserSecretVaultStatus, encryptProviderSecret } from "./domain/secrets";
import {
  buildShapeUpBet,
  canBetShapeUpProject,
  confirmedShapeUpScopes,
  createShapeUpPitch,
  executableDependenciesForItems,
  isShapeUpBet,
  isShapeUpCycleExpired,
  isShapeUpPitchComplete,
  isShapeUpProject,
  scheduleShapeUpAwareProject,
  scheduleShapeUpAwarePortfolio,
  shapeUpAppetiteDays,
  shapeUpMissingBetRequirements,
  shapeUpScopeStatus
} from "./domain/shapeUp";
import {
  APP_SETTINGS_STORAGE_KEY,
  BrowserAppSettingsRepository,
  defaultCustomAiProviderSettings,
  providerSecretSummary,
  type AppSettings,
  type AiProviderSettings,
  type FirebaseSyncSettings,
  type GitHubSyncSettings
} from "./domain/settings";
import { BrowserWorkspaceRepository, browserWorkspaceStorageStatus, workspaceFingerprint } from "./domain/storage";
import {
  calendarWorkItemStartValues,
  moveWorkItemToProject,
  updateWorkItemStartConstraint,
  workItemStartConstraintValues,
  type WorkItemStartConstraintValues
} from "./domain/workItems";
import {
  buildChangeEnvelopePath,
  buildGitHubSyncPaths,
  createSyncChangeEnvelope,
  createSyncManifest,
  FirebaseE2eeSyncClient,
  firebaseE2eeSyncStatus,
  githubPrivateRepoSyncStatus,
  githubSyncCommitMessage,
  GitHubPrivateRepoSyncClient,
  workspacePlaintextChecksum,
  type FirebaseAnonymousSession,
  type FirebaseE2eeSyncConfig,
  type GitHubSyncConfig,
  type SyncManifest
} from "./domain/sync";
import type {
  Actual,
  AuditAction,
  AuditDecision,
  AuditGate,
  Baseline,
  ChangeSet,
  Decision,
  Dependency,
  DependencyType,
  DirectionCard,
  Evidence,
  EvidenceKind,
  Project,
  ProjectMode,
  ProjectStatus,
  RepeatCadenceKind,
  RepeatEndMode,
  RepeatExecutionMode,
  RepeatRule,
  RepeatStartMode,
  RecurringOccurrenceRecord,
  Resource,
  ScheduleResult,
  ScheduledItem,
  ShapeUpAppetiteKind,
  ShapeUpPitch,
  ShapeUpScope,
  WorkItem,
  WorkItemKind,
  WorkspaceSnapshot
} from "./domain/types";
import { createEmptyWorkspace } from "./domain/workspace";
import { addSeconds, secondsBetween, startOfDay, zonedDateKey, zonedDateTimeToIso, zonedTimeKey } from "./domain/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type View = "portfolio" | "project" | "calendar" | "today" | "audit" | "reports" | "agent" | "settings";
type ScheduleTiming = "Overdue" | "Due now" | "Upcoming";
type MatrixDecision = "narrow" | "audit" | "watch" | "push";
type CalendarEventKind = "scheduled" | "recurring";

const now = new Date().toISOString();
const asOfLabel = `As of ${now.slice(0, 10)}`;
const buildCommit = __BUILD_COMMIT__.trim() || "unknown";
const buildCommitShort = buildCommit === "unknown" ? buildCommit : buildCommit.slice(0, 7);
const defaultProjectId = "workspace";
const views = new Set<View>(["portfolio", "project", "calendar", "today", "audit", "reports", "agent", "settings"]);
const daySeconds = 24 * 60 * 60;
const dependencyTypes: DependencyType[] = ["FS", "SS", "FF", "SF"];
const workItemKinds: WorkItemKind[] = ["phase", "task", "milestone", "hammock"];
const projectModes: ProjectMode[] = ["explore", "build", "ship", "maintain"];
const projectStatuses = selectableProjectStatuses;
const auditActions: AuditAction[] = ["Accelerate", "Continue", "Narrow", "Pivot", "Stop"];
const evidenceKinds: EvidenceKind[] = ["note", "commit", "pr", "ci", "doc", "screenshot", "release", "feedback", "metric", "email", "calendar", "minutes", "booking"];
const sidebarCollapsedStorageKey = "omni-plan-sidebar-collapsed";

function canonicalTimeZone(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function readSidebarCollapsedPreference() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(sidebarCollapsedStorageKey) === "true";
  } catch {
    return false;
  }
}

function writeSidebarCollapsedPreference(collapsed: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(sidebarCollapsedStorageKey, String(collapsed));
  } catch {
    // Sidebar state is only a UI preference; storage failures should not affect planning.
  }
}

type AutoSyncState = "disabled" | "locked" | "ready" | "pending" | "syncing" | "conflict" | "error";

interface AutoSyncStatus {
  state: AutoSyncState;
  message: string;
  lastRunAt?: string;
  lastPulledAt?: string;
  lastPushedAt?: string;
}

type DependencyPatch = Partial<Pick<Dependency, "type" | "lagSeconds">>;

interface ProjectCreateValues {
  title: string;
}

interface ProjectDetailsPatch {
  name?: string;
  mode?: ProjectMode;
  northStar?: string;
  currentOutcome?: string;
  startDate?: string;
  horizonDate?: string;
  reviewCadenceDays?: number;
}

interface WorkItemCreateValues extends WorkItemStartConstraintValues {
  title: string;
  description: string;
  kind: WorkItemKind;
  parentId?: string;
  durationDays: number;
  effortHours: number;
  attention: "deep" | "medium" | "shallow";
  percentComplete: number;
  evidenceRequired: boolean;
  isKeyTask: boolean;
  isScopeExpansion: boolean;
  isFastDelivery: boolean;
}

interface WorkItemMoveValues {
  targetProjectId: string;
  parentId?: string;
}

interface RepeatRuleDraft {
  enabled: boolean;
  executionMode: RepeatExecutionMode;
  cadence: RepeatCadenceKind;
  everyDays: number;
  count: number;
  endMode: RepeatEndMode;
  endDate: string;
  startMode: RepeatStartMode;
  startDate: string;
  startTime: string;
  reminderEnabled: boolean;
  reminderLeadValue: number;
  reminderLeadUnit: "minutes" | "hours" | "days";
  displayDurationMinutes: number;
  description: string;
}

interface EvidenceCreateValues {
  kind: EvidenceKind;
  summary: string;
  url: string;
  workItemId?: string;
  confidence: number;
  tags: string;
}

interface ActualRecordValues {
  percentComplete: number;
  actualWorkHours: number;
  remainingWorkHours: number;
  actualCost: number;
  markFinished: boolean;
}

interface DependencyCreateValues {
  fromId: string;
  toId: string;
  type: DependencyType;
  lagDays: number;
}

interface CalendarEvent {
  id: string;
  workItemId?: string;
  kind: CalendarEventKind;
  projectId: string;
  projectName: string;
  title: string;
  start: string;
  finish: string;
  href: string;
  critical?: boolean;
  repeatLabel?: string;
  automatic?: boolean;
  status?: RecurringOccurrence["status"];
  occurrence?: RecurringOccurrence;
}

interface CalendarRecurringRule {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  outline: string;
  cadenceLabel: string;
  startModeLabel: string;
  nextStart: string;
  nextFinish: string;
  href: string;
  automatic: boolean;
  stopped: boolean;
}

interface AutomaticOccurrenceHandlers {
  onOccurrenceSkip: (occurrence: RecurringOccurrence) => void;
  onOccurrenceReschedule: (occurrence: RecurringOccurrence, start: string, finish: string) => void;
  onOccurrenceException: (occurrence: RecurringOccurrence, note: string, dueAt?: string, resourceId?: string) => void;
}

interface RouteState {
  view: View;
  selectedProjectId: string;
  target?: string;
}

function hashForRoute(route: RouteState): string {
  return `#${pathForRoute(route)}`;
}

function recurringRouteTarget(workItemId?: string): string {
  return workItemId ? `recurring:${workItemId}` : "recurring";
}

function recurringTargetWorkItemId(target?: string): string | undefined {
  return target?.startsWith("recurring:") ? target.slice("recurring:".length) || undefined : undefined;
}

function pathForRoute(route: RouteState): string {
  const base = `/${route.view}/${encodeURIComponent(route.selectedProjectId)}`;
  return route.target ? `${base}/${encodeURIComponent(route.target)}` : base;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function readRoute(): RouteState {
  if (typeof window === "undefined") {
    return { view: "portfolio", selectedProjectId: defaultProjectId };
  }

  const [viewRaw, projectRaw, targetRaw] = window.location.hash.replace(/^#\/?/, "").split("/");
  const view = views.has(viewRaw as View) ? (viewRaw as View) : "portfolio";
  const decodedProject = projectRaw ? safeDecode(projectRaw) : undefined;
  const selectedProjectId = decodedProject || defaultProjectId;
  const target = targetRaw ? safeDecode(targetRaw) : undefined;
  return {
    view,
    selectedProjectId,
    target
  };
}

function routeFromParams(params: Record<string, string | undefined>): RouteState {
  const view = views.has(params.view as View) ? (params.view as View) : "portfolio";
  const selectedProjectId = params.projectId ? safeDecode(params.projectId) ?? defaultProjectId : defaultProjectId;
  return { view, selectedProjectId, target: params.target };
}

function dependencyLabel(type: DependencyType) {
  return `${type[0]}->${type[1]}`;
}

function dependencySummary(dependency: Dependency) {
  const lag = dependency.lagSeconds ? ` ${formatLag(dependency.lagSeconds)}` : "";
  return `${dependency.fromId} ${dependencyLabel(dependency.type)} ${dependency.toId}${lag}`;
}

function dependencyDiffs(before: Dependency, after: Dependency): ChangeSet["diffs"] {
  const diffs: ChangeSet["diffs"] = [];
  if (before.type !== after.type) {
    diffs.push({ entity: "Dependency", entityId: before.id, field: "type", before: before.type, after: after.type });
  }
  if (before.lagSeconds !== after.lagSeconds) {
    diffs.push({ entity: "Dependency", entityId: before.id, field: "lagSeconds", before: before.lagSeconds, after: after.lagSeconds });
  }
  return diffs;
}

function timestamp() {
  return new Date().toISOString();
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "item";
}

function uniqueId(prefix: string, seed: string, existingIds: Iterable<string>) {
  const existing = new Set(existingIds);
  const base = `${prefix}-${slugify(seed)}`;
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function firebaseSettingsReady(settings: FirebaseSyncSettings) {
  return Boolean(settings.projectId.trim() && settings.apiKey.trim() && settings.workspaceId.trim());
}

function firebaseSyncConfigurationMatches(left: FirebaseSyncSettings, right: FirebaseSyncSettings) {
  return left.projectId.trim() === right.projectId.trim()
    && left.apiKey.trim() === right.apiKey.trim()
    && (left.databaseId.trim() || "(default)") === (right.databaseId.trim() || "(default)")
    && (left.collectionPath.trim() || "omniPlanSync") === (right.collectionPath.trim() || "omniPlanSync")
    && (left.workspaceId.trim() || "personal") === (right.workspaceId.trim() || "personal")
    && (left.deviceId.trim() || "current-device") === (right.deviceId.trim() || "current-device")
    && left.autoSyncEnabled === right.autoSyncEnabled
    && left.autoSyncIntervalSeconds === right.autoSyncIntervalSeconds
    && left.autoPushDebounceSeconds === right.autoPushDebounceSeconds;
}

function firebaseConfigFromSettings(settings: FirebaseSyncSettings): FirebaseE2eeSyncConfig {
  return {
    projectId: settings.projectId.trim(),
    apiKey: settings.apiKey.trim(),
    databaseId: settings.databaseId.trim() || "(default)",
    collectionPath: settings.collectionPath.trim() || "omniPlanSync",
    workspaceId: settings.workspaceId.trim() || "personal",
    deviceId: settings.deviceId.trim() || "current-device"
  };
}

function toUtcStart(date: string) {
  return `${date || timestamp().slice(0, 10)}T00:00:00.000Z`;
}

function toUtcDateTime(date: string, time: string) {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : timestamp().slice(0, 10);
  const safeTime = /^\d{2}:\d{2}$/.test(time) ? time : "09:00";
  return `${safeDate}T${safeTime}:00.000Z`;
}

function datePart(iso?: string) {
  return iso?.slice(0, 10) || now.slice(0, 10);
}

function timePart(iso?: string) {
  return iso?.slice(11, 16) || "09:00";
}

function monthStartKey(iso: string, timeZone: string) {
  return `${zonedDateKey(iso, timeZone).slice(0, 7)}-01`;
}

function addCalendarMonths(dateKey: string, months: number) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)).toISOString().slice(0, 10);
}

function monthLabel(dateKey: string) {
  return new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC", year: "numeric" }).format(new Date(`${dateKey}T00:00:00.000Z`));
}

function buildCalendarDays(monthStart: string) {
  const start = new Date(`${monthStart}T00:00:00.000Z`);
  const gridStart = addSeconds(start.toISOString(), -start.getUTCDay() * daySeconds);
  return Array.from({ length: 42 }, (_, index) => addSeconds(gridStart, index * daySeconds).slice(0, 10));
}

function isSameCalendarMonth(day: string, monthStart: string) {
  return day.slice(0, 7) === monthStart.slice(0, 7);
}

function hoursToSeconds(hours: number) {
  return Math.max(0, Math.round(hours * 3600));
}

function daysToSeconds(days: number) {
  return Math.max(0, Math.round(days * daySeconds));
}

function nextOutline(workItems: WorkItem[], projectId: string, parentId?: string) {
  const siblings = workItems.filter((item) => item.projectId === projectId && item.parentId === parentId);
  if (!parentId) return String(siblings.length + 1);
  const parent = workItems.find((item) => item.id === parentId);
  return `${parent?.outline ?? "1"}.${siblings.length + 1}`;
}

function repeatRuleFromDraft(
  draft: RepeatRuleDraft,
  item: WorkItem | undefined,
  timeZone: string,
  currentTime: string
): RepeatRule | undefined {
  if (!draft.enabled) return undefined;
  const executionMode = draft.executionMode;
  const previousRule = item?.repeatRule;
  let startAt: string;
  let until: string | undefined;
  try {
    startAt = zonedDateTimeToIso(draft.startDate, draft.startTime, timeZone);
    until = draft.endMode === "until" ? zonedDateTimeToIso(draft.endDate, "23:59", timeZone) : undefined;
  } catch {
    return undefined;
  }
  const reminderMultiplier = draft.reminderLeadUnit === "days" ? daySeconds : draft.reminderLeadUnit === "hours" ? 3600 : 60;
  const nextRule: RepeatRule = {
    id: previousRule?.id ?? `repeat-${item?.id ?? "work-item"}`,
    cadence: draft.cadence,
    everyDays: draft.cadence === "every-n-days" ? Math.max(1, Math.round(draft.everyDays || 1)) : undefined,
    count: Math.max(1, Math.round(draft.count || 1)),
    startMode: executionMode === "automatic" ? "fixed-time" : draft.startMode,
    startAt,
    executionMode,
    endMode: draft.endMode,
    until,
    reminderLeadSeconds: executionMode === "automatic" && draft.reminderEnabled
      ? Math.max(60, Math.round(draft.reminderLeadValue || 1) * reminderMultiplier)
      : undefined,
    automaticDurationSeconds: executionMode === "automatic" ? Math.max(0, Math.round(draft.displayDurationMinutes || 0) * 60) : undefined,
    stoppedAt: executionMode === "automatic" ? previousRule?.stoppedAt : undefined
  };
  return applyAutomaticRuleEditBoundary(previousRule, nextRule, currentTime);
}

function draftFromRepeatRule(item: WorkItem | undefined, fallbackStart = now, timeZone = "UTC"): RepeatRuleDraft {
  const rule = item?.repeatRule;
  const startAt = rule?.startAt ?? item?.constraint?.fixedStart ?? item?.constraint?.noEarlierThan ?? fallbackStart;
  const executionMode = repeatExecutionMode(rule);
  const reminderSeconds = rule?.reminderLeadSeconds ?? daySeconds;
  const reminderLeadUnit = reminderSeconds % daySeconds === 0 ? "days" : reminderSeconds % 3600 === 0 ? "hours" : "minutes";
  const reminderDivisor = reminderLeadUnit === "days" ? daySeconds : reminderLeadUnit === "hours" ? 3600 : 60;
  return {
    enabled: Boolean(rule),
    executionMode,
    cadence: rule?.cadence ?? "every-n-days",
    everyDays: Math.max(1, Math.round(rule?.everyDays ?? 7)),
    count: Math.max(1, Math.round(rule?.count ?? 6)),
    endMode: repeatEndMode(rule),
    endDate: rule?.until ? zonedDateKey(rule.until, timeZone) : zonedDateKey(startAt, timeZone),
    startMode: executionMode === "automatic" ? "fixed-time" : rule?.startMode ?? "fixed-time",
    startDate: zonedDateKey(startAt, timeZone),
    startTime: zonedTimeKey(startAt, timeZone),
    reminderEnabled: Boolean(rule?.reminderLeadSeconds),
    reminderLeadValue: Math.max(1, Math.round(reminderSeconds / reminderDivisor)),
    reminderLeadUnit,
    displayDurationMinutes: Math.max(0, Math.round((rule?.automaticDurationSeconds ?? 0) / 60)),
    description: item?.description ?? ""
  };
}

function repeatRuleDraftFingerprint(draft: RepeatRuleDraft) {
  const base = {
    enabled: draft.enabled,
    description: draft.description.trim()
  };
  if (!draft.enabled) return JSON.stringify(base);
  return JSON.stringify({
    ...base,
    executionMode: draft.executionMode,
    cadence: draft.cadence,
    everyDays: draft.cadence === "every-n-days" ? Math.max(1, Math.round(draft.everyDays || 1)) : undefined,
    startMode: draft.executionMode === "automatic" ? "fixed-time" : draft.startMode,
    startDate: draft.startDate,
    startTime: draft.startTime,
    endMode: draft.endMode,
    count: draft.endMode === "count" ? Math.max(1, Math.round(draft.count || 1)) : undefined,
    endDate: draft.endMode === "until" ? draft.endDate : undefined,
    reminderEnabled: draft.executionMode === "automatic" ? draft.reminderEnabled : false,
    reminderLeadValue: draft.executionMode === "automatic" && draft.reminderEnabled ? Math.max(1, Math.round(draft.reminderLeadValue || 1)) : undefined,
    reminderLeadUnit: draft.executionMode === "automatic" && draft.reminderEnabled ? draft.reminderLeadUnit : undefined,
    displayDurationMinutes: draft.executionMode === "automatic" ? Math.max(0, Math.round(draft.displayDurationMinutes || 0)) : undefined
  });
}

function repeatRuleDraftsEqual(left: RepeatRuleDraft, right: RepeatRuleDraft) {
  return repeatRuleDraftFingerprint(left) === repeatRuleDraftFingerprint(right);
}

function isValidZonedDraftDateTime(date: string, time: string, timeZone: string) {
  try {
    zonedDateTimeToIso(date, time, timeZone);
    return true;
  } catch {
    return false;
  }
}

function createChangeSet(
  projectId: string,
  title: string,
  reason: string,
  diffs: ChangeSet["diffs"],
  sequence: number,
  status: ChangeSet["status"] = "draft"
): ChangeSet {
  const createdAt = timestamp();
  const id = `cs-${slugify(title)}-${sequence + 1}`;
  return {
    id,
    projectId,
    title,
    status,
    createdAt,
    reason,
    diffs,
    rollbackToken: `rollback-${id}`,
    auditGateIds: []
  };
}

function createDependencyChangeSet(projectId: string, title: string, diffs: ChangeSet["diffs"], sequence: number): ChangeSet {
  return {
    id: `cs-dependency-${Date.now()}-${sequence + 1}`,
    projectId,
    title,
    status: "draft",
    createdAt: timestamp(),
    reason: "Edited from the Gantt dependency inspector.",
    diffs,
    rollbackToken: `rollback-cs-dependency-${Date.now()}-${sequence + 1}`,
    auditGateIds: []
  };
}

function applyGateOverrides(gates: AuditGate[], overrides: AuditGate[]) {
  const overrideById = new Map(overrides.map((gate) => [gate.id, gate]));
  return gates.map((gate) => ({ ...gate, status: overrideById.get(gate.id)?.status ?? gate.status }));
}

function usePagedItems<T>(items: T[], pageSize: number) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);
  const pageItems = useMemo(() => {
    const start = page * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);
  return {
    items: pageItems,
    page,
    pageCount,
    pageSize,
    setPage,
    total: items.length
  };
}

function latestDecisionForProject(projectId: string, decisions: AuditDecision[]) {
  return decisions
    .filter((decision) => decision.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function isBaselineApproved(baseline: Baseline | undefined, changeSets: ChangeSet[]) {
  if (!baseline) return false;
  if (baseline.approvedByDecisionId) return true;
  const creationChangeSet = changeSets.find((changeSet) =>
    changeSet.diffs.some((diff) => diff.entity === "Baseline" && diff.entityId === baseline.id && diff.field === "created")
  );
  return !creationChangeSet || creationChangeSet.status === "approved";
}

function openAiCompatibleUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

async function runContrarianAiAudit({
  provider,
  apiKey,
  project,
  gates,
  evidence,
  schedule
}: {
  provider: AiProviderSettings;
  apiKey: string;
  project: Project;
  gates: AuditGate[];
  evidence: Evidence[];
  schedule: ScheduleResult;
}): Promise<AuditDecision> {
  const context = {
    project: {
      id: project.id,
      name: project.name,
      northStar: project.northStar,
      currentOutcome: project.currentOutcome,
      status: projectLifecycleLabel(project),
      mode: project.mode,
      directionCard: project.directionCard
    },
    openGates: gates.filter((gate) => gate.status !== "cleared").map((gate) => ({
      id: gate.id,
      severity: gate.severity,
      targetType: gate.targetType,
      reason: gate.reason,
      requiredAction: gate.requiredAction
    })),
    evidence: evidence.slice(0, 12).map((item) => ({
      kind: item.kind,
      summary: item.summary,
      confidence: item.confidence,
      tags: item.tags,
      hasUrl: Boolean(item.url)
    })),
    schedule: schedule.items.slice(0, 12).map((item) => ({
      id: item.workItem.id,
      title: item.workItem.title,
      kind: item.workItem.kind,
      percentComplete: item.workItem.percentComplete,
      isCritical: item.isCritical,
      start: item.start,
      finish: item.finish
    }))
  };

  const response = await fetch(openAiCompatibleUrl(provider.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "You are a contrarian project audit operator. Return strict JSON only with action, strongestContinueEvidence, strongestStopReason, rationale. action must be one of Accelerate, Continue, Narrow, Pivot, Stop."
        },
        {
          role: "user",
          content: JSON.stringify(context)
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`AI audit failed: ${response.status}`);
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = payload.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim()) as Partial<AuditDecision>;
  const action = auditActions.includes(parsed.action as AuditAction) ? parsed.action as AuditAction : "Narrow";
  return {
    id: `audit-ai-${slugify(project.name)}-${slugify(action)}-${Date.now()}`,
    projectId: project.id,
    action,
    strongestContinueEvidence: parsed.strongestContinueEvidence || "No strong continue evidence was returned.",
    strongestStopReason: parsed.strongestStopReason || "AI audit did not return a stop reason.",
    rationale: parsed.rationale || "AI audit returned an incomplete rationale.",
    createdAt: timestamp(),
    sourceGateIds: gates.map((gate) => gate.id)
  };
}

export function App() {
  return (
    <Routes>
      <Route index element={<Navigate to={pathForRoute({ view: "portfolio", selectedProjectId: defaultProjectId })} replace />} />
      <Route path="/:view/:projectId/:target?" element={<RoutedApp />} />
      <Route path="*" element={<Navigate to={pathForRoute({ view: "portfolio", selectedProjectId: defaultProjectId })} replace />} />
    </Routes>
  );
}

function RoutedApp() {
  const params = useParams();
  const routerNavigate = useNavigate();
  const route = routeFromParams(params);
  const workspaceRepository = useMemo(() => new BrowserWorkspaceRepository(), []);
  const settingsRepository = useMemo(() => new BrowserAppSettingsRepository(), []);
  const rememberedPassphraseVault = useMemo(() => new BrowserRememberedPassphraseVault(), []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsedPreference);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => createEmptyWorkspace());
  const [clockNow, setClockNow] = useState(timestamp);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => settingsRepository.load());
  const [sessionPassphrase, setSessionPassphrase] = useState("");
  const [rememberedPassphraseSavedAt, setRememberedPassphraseSavedAt] = useState<string | undefined>();
  const [rememberedPassphraseLoaded, setRememberedPassphraseLoaded] = useState(false);
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>({
    state: appSettings.firebaseSync.autoSyncEnabled ? "locked" : "disabled",
    message: appSettings.firebaseSync.autoSyncEnabled ? "Auto sync is enabled. Enter the workspace passphrase to unlock this browser session." : "Auto sync is off."
  });
  const [workspacePersistence, setWorkspacePersistence] = useState({
    loaded: false,
    status: "Loading local workspace...",
    lastSavedAt: ""
  });
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const workspaceRef = useRef(workspace);
  const appSettingsRef = useRef(appSettings);
  const sessionPassphraseRef = useRef(sessionPassphrase);
  const autoSyncBusyRef = useRef(false);
  const autoPushTimerRef = useRef<number | undefined>();
  const firebaseSessionRef = useRef<FirebaseAnonymousSession | undefined>();
  const suppressNextLocalSaveFingerprintRef = useRef<string>();
  const suppressNextAutoPushFingerprintRef = useRef<string>();
  const localWorkspaceConflictRef = useRef(false);
  const localWorkspaceConflictGenerationRef = useRef(0);
  const firebaseSettingsConflictRef = useRef(false);
  const firebaseSettingsConflictGenerationRef = useRef(0);
  const pendingFirebaseSyncIntentRef = useRef<"poll" | "push">();

  useEffect(() => {
    writeSidebarCollapsedPreference(sidebarCollapsed);
  }, [sidebarCollapsed]);
  const suppressNextAutoPushRef = useRef(false);
  const view = route.view;
  const selectedProject = workspace.projects.find((project) => project.id === route.selectedProjectId) ??
    workspace.projects.find((project) => !isProjectArchived(project)) ??
    workspace.projects[0];
  const selectedProjectId = selectedProject?.id ?? defaultProjectId;
  const selectedProjectName = selectedProject?.name ?? "No project";

  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  useEffect(() => {
    const refreshClock = () => setClockNow(timestamp());
    const intervalId = window.setInterval(refreshClock, 60_000);
    window.addEventListener("focus", refreshClock);
    document.addEventListener("visibilitychange", refreshClock);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshClock);
      document.removeEventListener("visibilitychange", refreshClock);
    };
  }, []);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  useEffect(() => {
    sessionPassphraseRef.current = sessionPassphrase;
  }, [sessionPassphrase]);

  useEffect(() => {
    let active = true;
    void rememberedPassphraseVault.read().then((record) => {
      if (!active) return;
      if (record?.passphrase) {
        setSessionPassphrase(record.passphrase);
        setRememberedPassphraseSavedAt(record.savedAt);
      }
      setRememberedPassphraseLoaded(true);
    }).catch(() => {
      if (!active) return;
      setRememberedPassphraseLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [rememberedPassphraseVault]);

  const saveAppSettings = useCallback((nextSettings: AppSettings) => {
    const currentSettings = appSettingsRef.current;
    let safeSettings = nextSettings;
    if (firebaseSettingsConflictRef.current) {
      const durableSettings = settingsRepository.load();
      if (firebaseSyncConfigurationMatches(nextSettings.firebaseSync, currentSettings.firebaseSync)) {
        safeSettings = { ...nextSettings, firebaseSync: durableSettings.firebaseSync };
      }
      firebaseSettingsConflictRef.current = false;
    }
    if (!firebaseSyncConfigurationMatches(currentSettings.firebaseSync, safeSettings.firebaseSync)) {
      firebaseSettingsConflictGenerationRef.current += 1;
      firebaseSessionRef.current = undefined;
      if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
    }
    settingsRepository.save(safeSettings);
    appSettingsRef.current = safeSettings;
    setAppSettings(safeSettings);
  }, [settingsRepository]);

  const rememberSessionPassphrase = useCallback(async () => {
    const passphrase = sessionPassphraseRef.current.trim();
    if (!passphrase) throw new Error("Enter the workspace passphrase before remembering it.");
    const record = await rememberedPassphraseVault.save(passphrase, timestamp());
    setRememberedPassphraseSavedAt(record.savedAt);
    setSessionPassphrase(record.passphrase);
    return record;
  }, [rememberedPassphraseVault]);

  const forgetRememberedPassphrase = useCallback(async () => {
    await rememberedPassphraseVault.clear();
    setRememberedPassphraseSavedAt(undefined);
  }, [rememberedPassphraseVault]);

  const updateFirebaseSyncSettings = useCallback((patch: Partial<FirebaseSyncSettings>) => {
    const current = appSettingsRef.current;
    const nextSettings = {
      ...current,
      firebaseSync: {
        ...current.firebaseSync,
        ...patch,
        updatedAt: timestamp()
      }
    };
    saveAppSettings(nextSettings);
  }, [saveAppSettings]);

  const runFirebaseAutoSync = useCallback(async (intent: "poll" | "push") => {
    if (localWorkspaceConflictRef.current) {
      setAutoSyncStatus({ state: "conflict", message: "Cross-tab workspace conflict. Reload this tab to use the latest stored version before syncing." });
      return;
    }
    if (firebaseSettingsConflictRef.current) {
      setAutoSyncStatus({ state: "conflict", message: "Sync settings changed in another tab. Reload before editing Settings or syncing this tab." });
      return;
    }
    const settings = appSettingsRef.current.firebaseSync;
    if (!settings.autoSyncEnabled) {
      setAutoSyncStatus({ state: "disabled", message: "Auto sync is off." });
      return;
    }
    if (!firebaseSettingsReady(settings)) {
      setAutoSyncStatus({ state: "disabled", message: "Auto sync needs Firebase Project ID, Web API key, and Workspace ID." });
      return;
    }
    const passphrase = sessionPassphraseRef.current.trim();
    if (!passphrase) {
      setAutoSyncStatus({ state: "locked", message: "Auto sync is enabled but locked. Enter the workspace passphrase in Settings." });
      return;
    }
    if (autoSyncBusyRef.current) {
      if (intent === "push" || !pendingFirebaseSyncIntentRef.current) pendingFirebaseSyncIntentRef.current = intent;
      return;
    }

    autoSyncBusyRef.current = true;
    const startedAt = timestamp();
    const workspaceFingerprintAtStart = workspaceFingerprint(workspaceRef.current);
    const workspaceConflictGenerationAtStart = localWorkspaceConflictGenerationRef.current;
    const settingsConflictGenerationAtStart = firebaseSettingsConflictGenerationRef.current;
    const hardSyncInvalidationMessage = () => {
      if (localWorkspaceConflictRef.current || localWorkspaceConflictGenerationRef.current !== workspaceConflictGenerationAtStart) {
        return "Cross-tab workspace conflict. The in-flight sync was cancelled; reload this tab before syncing.";
      }
      if (
        firebaseSettingsConflictRef.current
        || firebaseSettingsConflictGenerationRef.current !== settingsConflictGenerationAtStart
        || !firebaseSyncConfigurationMatches(settings, appSettingsRef.current.firebaseSync)
      ) {
        return "Sync settings changed while this run was in progress. The stale sync was cancelled; reload before editing Settings.";
      }
      return undefined;
    };
    const stopForHardInvalidation = () => {
      const message = hardSyncInvalidationMessage();
      if (!message) return false;
      setAutoSyncStatus({ state: "conflict", message, lastRunAt: startedAt });
      return true;
    };
    const workspaceChangedDuringSync = () => workspaceFingerprint(workspaceRef.current) !== workspaceFingerprintAtStart;
    const stopForWorkspaceChange = () => {
      if (!workspaceChangedDuringSync()) return false;
      pendingFirebaseSyncIntentRef.current = "push";
      setAutoSyncStatus({
        state: "pending",
        message: "The workspace changed during sync. The stale run was cancelled and the latest workspace is queued.",
        lastRunAt: startedAt
      });
      return true;
    };
    setAutoSyncStatus({ state: "syncing", message: intent === "push" ? "Auto sync is preparing encrypted push." : "Auto sync is checking Firebase.", lastRunAt: startedAt });

    try {
      const client = new FirebaseE2eeSyncClient(firebaseConfigFromSettings(settings));
      const session = firebaseSessionRef.current ?? await client.signInAnonymously();
      if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
      firebaseSessionRef.current = session;
      const manifest = await client.readManifest(session);
      if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
      const syncWorkspace = workspaceRef.current;
      const localChecksum = await workspacePlaintextChecksum(syncWorkspace);
      if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
      const latestSettings = appSettingsRef.current.firebaseSync;
      const localDirty = latestSettings.lastSyncedChecksum
        ? localChecksum !== latestSettings.lastSyncedChecksum
        : intent === "push";
      const remoteRevision = manifest?.latestRevision;
      const remoteAdvanced = Boolean(remoteRevision && remoteRevision !== latestSettings.lastSyncedRevision);

      if (remoteAdvanced && localDirty) {
        setAutoSyncStatus({
          state: "conflict",
          message: `Remote revision ${remoteRevision!.slice(0, 12)} and local workspace both changed. Pull or push manually after review.`,
          lastRunAt: startedAt
        });
        return;
      }

      if (remoteAdvanced) {
        if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
        const result = await client.pullWorkspaceSnapshot(passphrase, session);
        if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
        const pulledChecksum = await workspacePlaintextChecksum(result.workspace);
        if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
        suppressNextAutoPushRef.current = true;
        workspaceRef.current = result.workspace;
        setWorkspace(result.workspace);
        updateFirebaseSyncSettings({
          lastSyncedRevision: result.manifest.latestRevision,
          lastSyncedChecksum: pulledChecksum,
          lastPulledAt: timestamp()
        });
        setAutoSyncStatus({
          state: "ready",
          message: `Auto-pulled Firebase revision ${result.manifest.latestRevision.slice(0, 12)}.`,
          lastRunAt: startedAt,
          lastPulledAt: timestamp()
        });
        return;
      }

      if (!manifest || localDirty || (intent === "push" && !latestSettings.lastSyncedRevision)) {
        if (stopForHardInvalidation() || stopForWorkspaceChange()) return;
        const result = await client.pushWorkspaceSnapshot(syncWorkspace, passphrase, session, manifest);
        if (stopForHardInvalidation()) return;
        updateFirebaseSyncSettings({
          lastSyncedRevision: result.manifest.latestRevision,
          lastSyncedChecksum: localChecksum,
          lastPushedAt: result.manifest.updatedAt
        });
        if (workspaceChangedDuringSync()) {
          pendingFirebaseSyncIntentRef.current = "push";
          setAutoSyncStatus({
            state: "pending",
            message: "A newer local change arrived during push; the latest workspace is queued for sync.",
            lastRunAt: startedAt,
            lastPushedAt: result.manifest.updatedAt
          });
          return;
        }
        setAutoSyncStatus({
          state: "ready",
          message: `Auto-pushed Firebase revision ${result.manifest.latestRevision.slice(0, 12)}.`,
          lastRunAt: startedAt,
          lastPushedAt: result.manifest.updatedAt
        });
        return;
      }

      setAutoSyncStatus({
        state: "ready",
        message: remoteRevision ? `Auto sync is up to date at ${remoteRevision.slice(0, 12)}.` : "Auto sync is ready; no remote workspace exists yet.",
        lastRunAt: startedAt
      });
    } catch (error) {
      if (stopForHardInvalidation()) return;
      setAutoSyncStatus({
        state: "error",
        message: `Auto sync failed: ${error instanceof Error ? error.message : "unknown error"}`,
        lastRunAt: startedAt
      });
    } finally {
      autoSyncBusyRef.current = false;
      const pendingIntent = pendingFirebaseSyncIntentRef.current;
      pendingFirebaseSyncIntentRef.current = undefined;
      if (pendingIntent && !localWorkspaceConflictRef.current && !firebaseSettingsConflictRef.current) {
        window.setTimeout(() => void runFirebaseAutoSync(pendingIntent), 0);
      }
    }
  }, [updateFirebaseSyncSettings]);

  const saveWorkspaceImmediately = useCallback((nextWorkspace: WorkspaceSnapshot) => {
    workspaceRef.current = nextWorkspace;
    if (localWorkspaceConflictRef.current) {
      setWorkspacePersistence((current) => ({
        ...current,
        status: "Cross-tab conflict: local edits are held in this tab but are not being saved. Reload to use the latest stored version."
      }));
      return;
    }
    const savedAt = new Date().toISOString();
    void workspaceRepository.save(nextWorkspace).then(() => {
      setWorkspacePersistence((current) => ({ ...current, status: "Saved to browser local workspace", lastSavedAt: savedAt }));
    }).catch((error: unknown) => {
      setWorkspacePersistence((current) => ({ ...current, status: `Workspace save failed: ${error instanceof Error ? error.message : "unknown error"}` }));
    });
  }, [workspaceRepository]);

  const pushWorkspaceSoon = useCallback((reason: string) => {
    if (localWorkspaceConflictRef.current || firebaseSettingsConflictRef.current) return;
    const settings = appSettingsRef.current.firebaseSync;
    if (!settings.autoSyncEnabled || !firebaseSettingsReady(settings) || !sessionPassphraseRef.current.trim()) return;
    if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
    setAutoSyncStatus((current) => ({
      ...current,
      state: current.state === "conflict" || current.state === "error" ? current.state : "pending",
      message: current.state === "conflict" || current.state === "error" ? current.message : reason
    }));
    autoPushTimerRef.current = window.setTimeout(() => {
      void runFirebaseAutoSync("push");
    }, 250);
  }, [runFirebaseAutoSync]);

  const updateWorkspaceTimeZone = useCallback((value: string) => {
    const timeZone = canonicalTimeZone(value);
    if (!timeZone) return;
    const previous = workspaceRef.current;
    if (previous.timeZone === timeZone) return;
    const nextWorkspace = changeRecurringWorkspaceTimeZone(previous, timeZone, timestamp());
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Workspace time zone changed; syncing workspace now.");
  }, [pushWorkspaceSoon, saveWorkspaceImmediately]);

  useEffect(() => {
    let active = true;
    void workspaceRepository.load().then((storedWorkspace) => {
      if (!active) return;
      if (storedWorkspace) {
        workspaceRef.current = storedWorkspace;
        setWorkspace(storedWorkspace);
        setWorkspacePersistence({ loaded: true, status: "Loaded from browser local workspace", lastSavedAt: "" });
      } else {
        const emptyWorkspace = createEmptyWorkspace();
        workspaceRef.current = emptyWorkspace;
        setWorkspace(emptyWorkspace);
        setWorkspacePersistence({ loaded: true, status: "No local workspace saved yet", lastSavedAt: "" });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setWorkspacePersistence({ loaded: true, status: `Workspace load failed: ${error instanceof Error ? error.message : "unknown error"}`, lastSavedAt: "" });
    });
    return () => {
      active = false;
    };
  }, [workspaceRepository]);

  useEffect(() => workspaceRepository.subscribe(
    () => workspaceRef.current,
    (change) => {
      if (change.decision === "apply") {
        suppressNextLocalSaveFingerprintRef.current = change.fingerprint;
        suppressNextAutoPushFingerprintRef.current = change.fingerprint;
        workspaceRef.current = change.snapshot;
        setWorkspace(change.snapshot);
        setWorkspacePersistence((current) => ({
          ...current,
          status: "Updated from another browser tab",
          lastSavedAt: new Date().toISOString()
        }));
        return;
      }
      if (change.decision === "conflict") {
        localWorkspaceConflictRef.current = true;
        localWorkspaceConflictGenerationRef.current += 1;
        if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
        setWorkspacePersistence((current) => ({
          ...current,
          status: "Cross-tab conflict: this tab kept its local edits and paused saving. Reload to use the latest stored version."
        }));
        setAutoSyncStatus({
          state: "conflict",
          message: "Cross-tab workspace conflict. Local save and Firebase auto-sync are paused until this tab reloads."
        });
      }
    }
  ), [workspaceRepository]);

  useEffect(() => {
    const receiveSharedSettings = (event: StorageEvent) => {
      if (event.key !== APP_SETTINGS_STORAGE_KEY || !event.newValue || localWorkspaceConflictRef.current) return;
      try {
        const storedSettings = settingsRepository.load();
        const currentSettings = appSettingsRef.current;
        const currentFirebase = currentSettings.firebaseSync;
        const storedFirebase = storedSettings.firebaseSync;
        if (!firebaseSyncConfigurationMatches(currentFirebase, storedFirebase)) {
          firebaseSettingsConflictRef.current = true;
          firebaseSettingsConflictGenerationRef.current += 1;
          if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
          setAutoSyncStatus({
            state: "conflict",
            message: "Sync settings changed in another tab. Reload before editing Settings or syncing this tab."
          });
          return;
        }
        if (!storedFirebase.lastSyncedChecksum) return;
        const observedWorkspace = workspaceRef.current;
        const observedFingerprint = workspaceFingerprint(observedWorkspace);
        void workspacePlaintextChecksum(observedWorkspace).then((currentChecksum) => {
          if (localWorkspaceConflictRef.current || workspaceFingerprint(workspaceRef.current) !== observedFingerprint) return;
          if (storedFirebase.lastSyncedChecksum !== currentChecksum) return;
          const latestSettings = appSettingsRef.current;
          const latestFirebase = latestSettings.firebaseSync;
          if (!firebaseSyncConfigurationMatches(latestFirebase, storedFirebase)) return;
          const nextSettings: AppSettings = {
            ...latestSettings,
            firebaseSync: {
              ...latestFirebase,
              lastSyncedRevision: storedFirebase.lastSyncedRevision,
              lastSyncedChecksum: storedFirebase.lastSyncedChecksum,
              lastPulledAt: storedFirebase.lastPulledAt,
              lastPushedAt: storedFirebase.lastPushedAt,
              updatedAt: storedFirebase.updatedAt
            }
          };
          appSettingsRef.current = nextSettings;
          setAppSettings(nextSettings);
        }).catch(() => undefined);
      } catch {
        // Keep the current valid settings if another tab writes an unreadable payload.
      }
    };
    window.addEventListener("storage", receiveSharedSettings);
    return () => window.removeEventListener("storage", receiveSharedSettings);
  }, [settingsRepository]);

  useEffect(() => {
    if (!workspacePersistence.loaded) return;
    if (localWorkspaceConflictRef.current) return;
    const fingerprint = workspaceFingerprint(workspace);
    if (suppressNextLocalSaveFingerprintRef.current) {
      if (suppressNextLocalSaveFingerprintRef.current === fingerprint) {
        suppressNextLocalSaveFingerprintRef.current = undefined;
        return;
      }
      suppressNextLocalSaveFingerprintRef.current = undefined;
    }
    const savedAt = new Date().toISOString();
    void workspaceRepository.save(workspace).then(() => {
      setWorkspacePersistence((current) => ({ ...current, status: "Saved to browser local workspace", lastSavedAt: savedAt }));
    }).catch((error: unknown) => {
      setWorkspacePersistence((current) => ({ ...current, status: `Workspace save failed: ${error instanceof Error ? error.message : "unknown error"}` }));
    });
  }, [workspace, workspacePersistence.loaded, workspaceRepository]);

  useEffect(() => {
    if (!workspacePersistence.loaded) return;
    setWorkspace((previous) => {
      const checkedAt = timestamp();
      const expired = previous.projects.filter((project) => !isProjectArchived(project) && isShapeUpCycleExpired(project, checkedAt));
      if (!expired.length) return previous;
      return {
        ...previous,
        projects: previous.projects.map((project) => expired.some((candidate) => candidate.id === project.id) ? { ...project, status: "paused" } : project),
        changeSets: [
          ...expired.map((project, index) => createChangeSet(
            project.id,
            `Pause ${project.name} at Shape Up circuit breaker`,
            "Circuit breaker expired. Choose Ship as-is, Cut scope, Kill, or Re-bet before continuing.",
            [{ entity: "Project", entityId: project.id, field: "status", before: projectLifecycleStatus(project), after: "paused" }],
            previous.changeSets.length + index
          )),
          ...previous.changeSets
        ]
      };
    });
  }, [workspace.projects, workspacePersistence.loaded]);

  useEffect(() => {
    if (!workspacePersistence.loaded) return;
    setWorkspace((previous) => reconcileAutomaticOccurrences(previous, clockNow).workspace);
  }, [clockNow, workspace.workItems, workspace.recurringOccurrences, workspacePersistence.loaded]);

  useEffect(() => {
    const settings = appSettings.firebaseSync;
    if (localWorkspaceConflictRef.current) {
      setAutoSyncStatus({ state: "conflict", message: "Cross-tab workspace conflict. Reload this tab to use the latest stored version before syncing." });
      return;
    }
    if (firebaseSettingsConflictRef.current) {
      setAutoSyncStatus({ state: "conflict", message: "Sync settings changed in another tab. Reload before editing Settings or syncing this tab." });
      return;
    }
    if (!settings.autoSyncEnabled) {
      setAutoSyncStatus({ state: "disabled", message: "Auto sync is off." });
      return;
    }
    if (!firebaseSettingsReady(settings)) {
      setAutoSyncStatus({ state: "disabled", message: "Auto sync needs Firebase Project ID, Web API key, and Workspace ID." });
      return;
    }
    if (!sessionPassphrase.trim()) {
      setAutoSyncStatus({ state: "locked", message: "Auto sync is enabled but locked. Enter the workspace passphrase in Settings." });
      return;
    }

    void runFirebaseAutoSync("poll");
    const intervalMs = Math.max(15, settings.autoSyncIntervalSeconds || 45) * 1000;
    const intervalId = window.setInterval(() => {
      void runFirebaseAutoSync("poll");
    }, intervalMs);
    return () => window.clearInterval(intervalId);
  }, [
    appSettings.firebaseSync.projectId,
    appSettings.firebaseSync.apiKey,
    appSettings.firebaseSync.databaseId,
    appSettings.firebaseSync.collectionPath,
    appSettings.firebaseSync.workspaceId,
    appSettings.firebaseSync.deviceId,
    appSettings.firebaseSync.autoSyncEnabled,
    appSettings.firebaseSync.autoSyncIntervalSeconds,
    sessionPassphrase,
    runFirebaseAutoSync
  ]);

  useEffect(() => {
    if (!workspacePersistence.loaded) return;
    if (localWorkspaceConflictRef.current || firebaseSettingsConflictRef.current) return;
    const settings = appSettings.firebaseSync;
    if (!settings.autoSyncEnabled || !firebaseSettingsReady(settings) || !sessionPassphrase.trim()) return;
    const fingerprint = workspaceFingerprint(workspace);
    if (suppressNextAutoPushFingerprintRef.current) {
      if (suppressNextAutoPushFingerprintRef.current === fingerprint) {
        suppressNextAutoPushFingerprintRef.current = undefined;
        return;
      }
      suppressNextAutoPushFingerprintRef.current = undefined;
    }
    if (suppressNextAutoPushRef.current) {
      suppressNextAutoPushRef.current = false;
      return;
    }

    if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
    const debounceMs = Math.max(3, settings.autoPushDebounceSeconds || 8) * 1000;
    setAutoSyncStatus((current) => ({
      ...current,
      state: current.state === "conflict" || current.state === "error" ? current.state : "pending",
      message: current.state === "conflict" || current.state === "error" ? current.message : `Local changes will auto-push in ${Math.round(debounceMs / 1000)}s.`
    }));
    autoPushTimerRef.current = window.setTimeout(() => {
      void runFirebaseAutoSync("push");
    }, debounceMs);
    return () => {
      if (autoPushTimerRef.current) window.clearTimeout(autoPushTimerRef.current);
    };
  }, [workspace, workspacePersistence.loaded, appSettings.firebaseSync.autoSyncEnabled, appSettings.firebaseSync.autoPushDebounceSeconds, sessionPassphrase, runFirebaseAutoSync, appSettings.firebaseSync.projectId, appSettings.firebaseSync.apiKey, appSettings.firebaseSync.workspaceId]);

  useEffect(() => {
    pageTitleRef.current?.focus({ preventScroll: true });
  }, [view, selectedProjectId]);

  useEffect(() => {
    if (!workspacePersistence.loaded || !workspace.projects.length || route.selectedProjectId === selectedProjectId) return;
    routerNavigate(pathForRoute({ view, selectedProjectId, target: route.target }), { replace: true });
  }, [route.selectedProjectId, route.target, routerNavigate, selectedProjectId, view, workspace.projects.length, workspacePersistence.loaded]);

  useEffect(() => {
    if (!route.target) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(route.target!);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.classList.add("focusFlash");
      window.setTimeout(() => target?.classList.remove("focusFlash"), 1600);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, selectedProjectId, route.target]);

  const navigate = (nextView: View, nextProjectId = selectedProjectId) => {
    const nextRoute = { view: nextView, selectedProjectId: nextProjectId };
    routerNavigate(pathForRoute(nextRoute));
  };

  const updateDependency = (dependencyId: string, patch: DependencyPatch) => {
    setWorkspace((previous) => {
      const current = previous.dependencies.find((dependency) => dependency.id === dependencyId);
      if (!current) return previous;
      const nextDependency = { ...current, ...patch };
      const diffs = dependencyDiffs(current, nextDependency);
      if (!diffs.length) return previous;

      return {
        ...previous,
        dependencies: previous.dependencies.map((dependency) => (dependency.id === dependencyId ? nextDependency : dependency)),
        changeSets: [
          createDependencyChangeSet(current.projectId, `Update dependency ${dependencyLabel(current.type)}`, diffs, previous.changeSets.length),
          ...previous.changeSets
        ]
      };
    });
  };

  const removeDependency = (dependencyId: string) => {
    setWorkspace((previous) => {
      const current = previous.dependencies.find((dependency) => dependency.id === dependencyId);
      if (!current) return previous;

      return {
        ...previous,
        dependencies: previous.dependencies.filter((dependency) => dependency.id !== dependencyId),
        changeSets: [
          createDependencyChangeSet(
            current.projectId,
            `Remove dependency ${dependencyLabel(current.type)}`,
            [{ entity: "Dependency", entityId: current.id, field: "deleted", before: dependencySummary(current), after: null }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const createProject = (values: ProjectCreateValues) => {
    const title = values.title.trim();
    if (!title) return;
    const name = title.split(/\s+/).slice(0, 8).join(" ").slice(0, 80) || title.slice(0, 80);
    const projectId = uniqueId("p", name, workspace.projects.map((project) => project.id));
    const createdAt = timestamp();
    const start = toUtcStart(createdAt.slice(0, 10));
    const directionCard: DirectionCard = {
      targetUser: "Personal project operator",
      userProblem: title,
      businessGoal: title,
      coreHypothesis: "",
      successMetric: "",
      failureCondition: "",
      validationMethod: "",
      timeboxDays: 14,
      opportunityCost: ""
    };
    const project: Project = {
      id: projectId,
      name,
      status: "active",
      mode: "build",
      priority: 3,
      northStar: title,
      currentOutcome: title,
      horizon: addSeconds(start, 14 * daySeconds),
      start,
      directionCard,
      reviewCadenceDays: 7
    };
    setWorkspace((previous) => ({
      ...previous,
      projects: [project, ...previous.projects],
      changeSets: [
        createChangeSet(
          projectId,
          `Create project ${name}`,
          "Created as an active project from the quick project composer.",
          [{ entity: "Project", entityId: projectId, field: "created", before: null, after: { name, createdAt, status: "active", mode: "build" } }],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    }));
    window.setTimeout(() => {
      routerNavigate(pathForRoute({ view: "project", selectedProjectId: projectId }));
    }, 0);
  };

  const updateProjectDetails = (projectId: string, patch: ProjectDetailsPatch) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project) return previous;

      const nextProject: Project = { ...project };
      const diffs: ChangeSet["diffs"] = [];
      const setField = <K extends keyof Project>(field: K, value: Project[K]) => {
        if (nextProject[field] === value) return;
        diffs.push({ entity: "Project", entityId: projectId, field: String(field), before: nextProject[field], after: value });
        nextProject[field] = value;
      };

      if (patch.name !== undefined) {
        const name = patch.name.trim();
        if (name) setField("name", name);
      }
      if (patch.mode) setField("mode", patch.mode);
      if (patch.northStar !== undefined) setField("northStar", patch.northStar.trim());
      if (patch.currentOutcome !== undefined) setField("currentOutcome", patch.currentOutcome.trim());
      if (patch.startDate !== undefined) setField("start", toUtcStart(patch.startDate));
      if (patch.horizonDate !== undefined) setField("horizon", toUtcStart(patch.horizonDate));
      if (patch.reviewCadenceDays !== undefined) {
        setField("reviewCadenceDays", Math.max(1, Math.min(365, Math.round(patch.reviewCadenceDays || 7))));
      }

      if (!diffs.length) return previous;
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
        changeSets: [
          createChangeSet(
            projectId,
            `Update project settings for ${nextProject.name}`,
            "Edited project identity, outcome, mode, or scheduling defaults.",
            diffs,
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const updateDirectionCard = (projectId: string, directionCard: DirectionCard) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project) return previous;
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? { ...candidate, directionCard } : candidate),
        changeSets: [
          createChangeSet(
            projectId,
            `Update direction card for ${project.name}`,
            "Edited project-level Direction Card.",
            [{ entity: "Project", entityId: projectId, field: "directionCard", before: project.directionCard ?? null, after: directionCard }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const updateShapeUpPitch = (projectId: string, pitch: ShapeUpPitch) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project) return previous;
      const nextPitch = { ...pitch, updatedAt: timestamp() };
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? { ...candidate, shapeUpPitch: nextPitch } : candidate),
        changeSets: [
          createChangeSet(
            projectId,
            `Update Shape Up pitch for ${project.name}`,
            "Edited Shape Up pitch fields, scopes, or hill positions.",
            [{ entity: "Project", entityId: projectId, field: "shapeUpPitch", before: project.shapeUpPitch ?? null, after: nextPitch }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const convertProjectToShapeUp = (projectId: string) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.shapeUpPitch) return previous;
      const createdAt = timestamp();
      const shapeUpPitch = createShapeUpPitch({
        problem: project.directionCard?.userProblem || project.currentOutcome,
        appetiteKind: "small-batch",
        solutionSketch: "",
        rabbitHoles: "",
        noGos: "",
        successBaseline: project.directionCard?.successMetric || "",
        now: createdAt
      });
      const nextProject = {
        ...project,
        status: "waiting" as ProjectStatus,
        currentOutcome: "Complete the Shape Up pitch and decide whether to bet.",
        shapeUpPitch
      };
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
        changeSets: [
          createChangeSet(
            projectId,
            `Convert ${project.name} to Shape Up`,
            "Converted existing project into a waiting Shape Up pitch. Existing work remains stored but is not executable until bet rules allow it.",
            [{ entity: "Project", entityId: projectId, field: "shapeUpPitch", before: null, after: shapeUpPitch }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const approveShapeUpBet = (projectId: string) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project || !canBetShapeUpProject(project)) return previous;
      const approvedAt = timestamp();
      const auditDecisionId = `decision-shapeup-bet-${projectId}-${approvedAt}`;
      const bet = buildShapeUpBet(project, auditDecisionId, approvedAt);
      const nextPitch: ShapeUpPitch = { ...project.shapeUpPitch!, bet, updatedAt: approvedAt };
      const nextProject: Project = {
        ...project,
        status: "active",
        currentOutcome: `Build the approved Shape Up bet by ${bet.cycleEnd.slice(0, 10)}.`,
        horizon: bet.cycleEnd,
        shapeUpPitch: nextPitch
      };
      const existingScopeIds = new Set(previous.workItems.filter((item) => item.projectId === projectId && item.shapeUpScopeId).map((item) => item.shapeUpScopeId));
      const existingIds = previous.workItems.map((item) => item.id);
      const confirmedScopes = confirmedShapeUpScopes(nextProject);
      const scopeWorkItems: WorkItem[] = confirmedScopes
        .filter((scope) => !existingScopeIds.has(scope.id))
        .map((scope, index) => ({
          id: uniqueId("w", `${project.name} ${scope.id}`, existingIds),
          projectId,
          kind: "phase",
          title: `Scope: ${scope.title}`,
          outline: String(index + 1),
          durationSeconds: 0,
          estimate: { mostLikelySeconds: 0 },
          assignmentIds: [],
          percentComplete: 0,
          shapeUpScopeId: scope.id
        }));
      const cycleMarkerId = uniqueId("w", `${project.name} circuit breaker`, [...previous.workItems.map((item) => item.id), ...scopeWorkItems.map((item) => item.id)]);
      const cycleMarker: WorkItem = {
        id: cycleMarkerId,
        projectId,
        kind: "milestone",
        title: "Circuit breaker / ship decision",
        outline: String(scopeWorkItems.length + 1),
        durationSeconds: 0,
        estimate: { mostLikelySeconds: 0 },
        constraint: { fixedFinish: bet.circuitBreakerAt },
        assignmentIds: [],
        percentComplete: 0,
        evidenceRequired: true,
        isKeyTask: true,
        isShapeUpCycleMarker: true
      };
      const auditDecision: AuditDecision = {
        id: auditDecisionId,
        projectId,
        action: "Continue",
        strongestContinueEvidence: nextPitch.successBaseline,
        strongestStopReason: nextPitch.noGos,
        rationale: `Human-approved Shape Up bet. Appetite is ${nextPitch.appetiteDays} days; scope is variable inside fixed time.`,
        createdAt: approvedAt,
        sourceGateIds: [`gate-shapeup-bet-${projectId}`]
      };

      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
        workItems: [cycleMarker, ...scopeWorkItems, ...previous.workItems],
        auditDecisions: [auditDecision, ...previous.auditDecisions],
        changeSets: [
          createChangeSet(
            projectId,
            `Approve Shape Up bet for ${project.name}`,
            "Human-approved Betting Gate changed the project from waiting to active and generated Shape Up execution scaffolding.",
            [
              { entity: "Project", entityId: projectId, field: "status", before: projectLifecycleStatus(project), after: "active" },
              { entity: "Project", entityId: projectId, field: "shapeUpPitch.bet", before: null, after: bet }
            ],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const updateProjectStatus = (projectId: string, status: ProjectStatus) => {
    const previous = workspaceRef.current;
    const project = previous.projects.find((candidate) => candidate.id === projectId);
    if (!project || (projectLifecycleStatus(project) === status && !isProjectArchived(project))) return;
    const nextProject = withProjectLifecycleStatus(project, status);
    const nextWorkspace = {
      ...previous,
      projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
      changeSets: [
        createChangeSet(
          projectId,
          `Set ${project.name} status ${status}`,
          "Updated project lifecycle state.",
          [
            { entity: "Project", entityId: projectId, field: "status", before: projectLifecycleStatus(project), after: status },
            ...(isProjectArchived(project) ? [{ entity: "Project", entityId: projectId, field: "archived", before: true, after: false }] : [])
          ],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon(`Project status changed to ${status}; syncing workspace now.`);
  };

  const completeProject = (projectId: string) => {
    const previous = workspaceRef.current;
    const project = previous.projects.find((candidate) => candidate.id === projectId);
    if (!project || projectLifecycleStatus(project) === "done") return;
    const nextProject = { ...project, status: "done" as const };
    const nextWorkspace = {
      ...previous,
      projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
      changeSets: [
        createChangeSet(
          projectId,
          `Set ${project.name} done`,
          "Marked project as verified complete.",
          [{ entity: "Project", entityId: projectId, field: "status", before: projectLifecycleStatus(project), after: "done" }],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Project marked done; syncing workspace now.");
  };

  const archiveProject = (projectId: string) => {
    const previous = workspaceRef.current;
    const project = previous.projects.find((candidate) => candidate.id === projectId);
    if (!project || isProjectArchived(project)) return;
    const archivedAt = timestamp();
    const nextProject = withProjectArchived(project, archivedAt);
    const nextWorkspace = {
      ...previous,
      projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
      changeSets: [
        createChangeSet(
          projectId,
          `Archive ${project.name}`,
          "Removed project from active planning without changing its lifecycle status.",
          [
            { entity: "Project", entityId: projectId, field: "archived", before: false, after: true },
            { entity: "Project", entityId: projectId, field: "archivedAt", before: null, after: archivedAt }
          ],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Project archived; syncing workspace now.");
  };

  const restoreProject = (projectId: string) => {
    const previous = workspaceRef.current;
    const project = previous.projects.find((candidate) => candidate.id === projectId);
    if (!project || !isProjectArchived(project)) return;
    const previousArchivedAt = project.archivedAt;
    const nextProject = withProjectRestored(project);
    const nextWorkspace = {
      ...previous,
      projects: previous.projects.map((candidate) => candidate.id === projectId ? nextProject : candidate),
      changeSets: [
        createChangeSet(
          projectId,
          `Restore ${project.name}`,
          "Returned the archived project to the active portfolio without changing its lifecycle status.",
          [
            { entity: "Project", entityId: projectId, field: "archived", before: true, after: false },
            { entity: "Project", entityId: projectId, field: "archivedAt", before: previousArchivedAt ?? null, after: null }
          ],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Project restored; syncing workspace now.");
  };

  const deleteEmptyProject = (projectId: string) => {
    const previous = workspaceRef.current;
    const project = previous.projects.find((candidate) => candidate.id === projectId);
    if (!project) return;

    const withoutProject = removeEmptyProjectFromWorkspace(previous, projectId);
    if (!withoutProject) return;

    const confirmed = window.confirm(`Delete empty project "${project.name}"? This removes the project and its project-level notes, gates, baselines, and decisions.`);
    if (!confirmed) return;

    const nextProjectId = previous.projects.find((candidate) => candidate.id !== projectId)?.id;
    const deletedAt = timestamp();
    const nextWorkspace = {
      ...withoutProject,
      changeSets: [
        createChangeSet(
          projectId,
          `Delete empty project ${project.name}`,
          "Removed an empty project with no work items from the workspace.",
          [
            { entity: "Project", entityId: projectId, field: "deleted", before: project.name, after: null },
            { entity: "Project", entityId: projectId, field: "deletedAt", before: null, after: deletedAt }
          ],
          previous.changeSets.length,
          "approved"
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Empty project deleted; syncing workspace now.");
    navigate("portfolio", nextProjectId);
  };

  const createWorkItem = (projectId: string, values: WorkItemCreateValues) => {
    const title = values.title.trim();
    if (!title) return;
    setWorkspace((previous) => {
      const id = uniqueId("w", title, previous.workItems.map((item) => item.id));
      const durationSeconds = values.kind === "milestone" ? 0 : daysToSeconds(values.durationDays);
      const resourceId = previous.resources[0]?.id;
      const parent = values.parentId ? previous.workItems.find((item) => item.id === values.parentId) : undefined;
      const workItem = updateWorkItemStartConstraint({
        id,
        projectId,
        parentId: values.parentId || undefined,
        kind: values.kind,
        title,
        description: values.description.trim() || undefined,
        outline: nextOutline(previous.workItems, projectId, values.parentId),
        durationSeconds,
        estimate: { mostLikelySeconds: durationSeconds },
        assignmentIds: resourceId && values.kind !== "milestone" ? [{ resourceId, attention: values.attention, effortSeconds: hoursToSeconds(values.effortHours) }] : [],
        percentComplete: clamp(values.percentComplete, 0, 100),
        evidenceRequired: values.evidenceRequired,
        isKeyTask: values.isKeyTask,
        isScopeExpansion: values.isScopeExpansion,
        isFastDelivery: values.isFastDelivery,
        shapeUpScopeId: parent?.shapeUpScopeId
      } satisfies WorkItem, values);
      return {
        ...previous,
        workItems: [...previous.workItems, workItem],
        changeSets: [
          createChangeSet(
            projectId,
            `Create work item ${title}`,
            "Added from the project outline composer.",
            [{ entity: "WorkItem", entityId: id, field: "created", before: null, after: workItem }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const updateWorkItemSchedule = (projectId: string, workItemId: string, values: WorkItemStartConstraintValues) => {
    const previous = workspaceRef.current;
    const current = previous.workItems.find((item) => item.id === workItemId && item.projectId === projectId);
    if (!current || current.repeatRule) return;

    const nextItem = updateWorkItemStartConstraint(current, values);
    if (JSON.stringify(current.constraint ?? null) === JSON.stringify(nextItem.constraint ?? null)) return;

    const nextWorkspace: WorkspaceSnapshot = {
      ...previous,
      workItems: previous.workItems.map((item) => item.id === workItemId ? nextItem : item),
      changeSets: [
        createChangeSet(
          projectId,
          `Update schedule for ${current.title}`,
          "Changed the work item's start-date constraint.",
          [{ entity: "WorkItem", entityId: workItemId, field: "constraint", before: current.constraint ?? null, after: nextItem.constraint ?? null }],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Work item schedule changed; syncing workspace now.");
  };

  const moveWorkItem = (sourceProjectId: string, workItemId: string, values: WorkItemMoveValues) => {
    const previous = reconcileAutomaticOccurrences(workspaceRef.current, timestamp()).workspace;
    const workItem = previous.workItems.find((item) => item.id === workItemId && item.projectId === sourceProjectId);
    const sourceProject = previous.projects.find((project) => project.id === sourceProjectId);
    const targetProject = previous.projects.find((project) => project.id === values.targetProjectId);
    if (!workItem || !sourceProject || !targetProject || sourceProjectId === values.targetProjectId) return;

    const result = moveWorkItemToProject(previous, {
      workItemId,
      targetProjectId: values.targetProjectId,
      parentId: values.parentId
    });
    if (!result) return;

    const movedIds = new Set(result.movedIds);
    const diffs: ChangeSet["diffs"] = [];
    for (const before of previous.workItems.filter((item) => movedIds.has(item.id))) {
      const after = result.workspace.workItems.find((item) => item.id === before.id);
      if (!after) continue;
      diffs.push({ entity: "WorkItem", entityId: before.id, field: "projectId", before: before.projectId, after: after.projectId });
      if ((before.parentId ?? null) !== (after.parentId ?? null)) {
        diffs.push({ entity: "WorkItem", entityId: before.id, field: "parentId", before: before.parentId ?? null, after: after.parentId ?? null });
      }
      if (before.outline !== after.outline) {
        diffs.push({ entity: "WorkItem", entityId: before.id, field: "outline", before: before.outline, after: after.outline });
      }
    }
    for (const dependencyId of result.movedDependencyIds) {
      diffs.push({ entity: "Dependency", entityId: dependencyId, field: "projectId", before: sourceProjectId, after: values.targetProjectId });
    }
    for (const dependencyId of result.removedDependencyIds) {
      const dependency = previous.dependencies.find((item) => item.id === dependencyId);
      diffs.push({ entity: "Dependency", entityId: dependencyId, field: "removed", before: dependency ?? dependencyId, after: null });
    }

    const movedLabel = result.movedIds.length === 1 ? "1 item" : `${result.movedIds.length} items`;
    const nextWorkspace = {
      ...result.workspace,
      changeSets: [
        createChangeSet(
          values.targetProjectId,
          `Move ${workItem.title}`,
          `Moved ${movedLabel} from ${sourceProject.name} to ${targetProject.name}.`,
          diffs,
          previous.changeSets.length
        ),
        ...result.workspace.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Work item moved; syncing workspace now.");
    navigate("project", values.targetProjectId);
  };

  const updateWorkItemRepeatRule = (projectId: string, workItemId: string, repeatRule?: RepeatRule, description?: string) => {
    const changedAt = timestamp();
    const previous = reconcileAutomaticOccurrences(workspaceRef.current, changedAt).workspace;
    const workItem = previous.workItems.find((item) => item.id === workItemId && item.projectId === projectId);
    if (!workItem) return;

    const effectiveRepeatRule = repeatRule
      ? applyAutomaticRuleEditBoundary(workItem.repeatRule, repeatRule, changedAt)
      : undefined;
    const before = workItem.repeatRule ?? null;
    const after = effectiveRepeatRule ?? null;
    const nextDescription = description?.trim() || undefined;
    if (JSON.stringify(before) === JSON.stringify(after) && workItem.description === nextDescription) return;

    const nextWorkspace = {
      ...previous,
      workItems: previous.workItems.map((item) => {
        if (item.id !== workItemId) return item;
        if (effectiveRepeatRule) return { ...item, repeatRule: effectiveRepeatRule, description: nextDescription };
        const nextItem = { ...item };
        delete nextItem.repeatRule;
        nextItem.description = nextDescription;
        return nextItem;
      }),
      changeSets: [
        createChangeSet(
          projectId,
          effectiveRepeatRule ? `Set recurrence for ${workItem.title}` : `Clear recurrence for ${workItem.title}`,
          effectiveRepeatRule ? "Updated the work item's recurring schedule rule." : "Removed the work item's recurring schedule rule.",
          [
            { entity: "WorkItem", entityId: workItemId, field: "repeatRule", before, after },
            ...(workItem.description !== nextDescription ? [{ entity: "WorkItem", entityId: workItemId, field: "description", before: workItem.description ?? null, after: nextDescription ?? null }] : [])
          ],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Recurring work changed; syncing workspace now.");
  };

  const commitAutomaticOccurrenceAction = (action: AutomaticOccurrenceAction, title: string, reason: string) => {
    const previous = workspaceRef.current;
    const result = applyAutomaticOccurrenceAction(previous, action);
    if (result.workspace === previous) return;
    const projectId = action.type === "stop-rule"
      ? previous.workItems.find((item) => item.id === action.workItemId)?.projectId
      : action.occurrence.projectId;
    if (!projectId) return;
    const diffs: ChangeSet["diffs"] = action.type === "stop-rule"
      ? [{ entity: "WorkItem", entityId: action.workItemId, field: "repeatRule.stoppedAt", before: null, after: action.actedAt }]
      : [{ entity: "RecurringOccurrence", entityId: action.occurrence.id, field: "status", before: action.occurrence.status, after: result.occurrence?.status ?? action.type }];
    if (result.followUpWorkItemId) {
      diffs.push({ entity: "WorkItem", entityId: result.followUpWorkItemId, field: "created", before: null, after: result.workspace.workItems.find((item) => item.id === result.followUpWorkItemId) });
    }
    const nextWorkspace = {
      ...result.workspace,
      changeSets: [createChangeSet(projectId, title, reason, diffs, result.workspace.changeSets.length), ...result.workspace.changeSets]
    };
    workspaceRef.current = nextWorkspace;
    setWorkspace(nextWorkspace);
    saveWorkspaceImmediately(nextWorkspace);
    pushWorkspaceSoon("Automatic recurring history changed; syncing workspace now.");
  };

  const skipAutomaticOccurrence = (occurrence: RecurringOccurrence) => {
    commitAutomaticOccurrenceAction(
      { type: "skip", occurrence, actedAt: timestamp() },
      `Skip ${occurrence.title} occurrence`,
      "Skipped one automatic occurrence without changing the recurring rule."
    );
  };

  const rescheduleAutomaticOccurrence = (occurrence: RecurringOccurrence, start: string, finish: string) => {
    commitAutomaticOccurrenceAction(
      { type: "reschedule", occurrence, start, finish, actedAt: timestamp() },
      `Reschedule ${occurrence.title} occurrence`,
      "Changed one future automatic occurrence without shifting the series."
    );
  };

  const reportAutomaticOccurrenceException = (occurrence: RecurringOccurrence, note: string, dueAt?: string, resourceId?: string) => {
    commitAutomaticOccurrenceAction(
      { type: "report-exception", occurrence, note, dueAt, resourceId, actedAt: timestamp() },
      `Report exception for ${occurrence.title}`,
      "Recorded an automatic occurrence exception and created a linked manual follow-up task."
    );
  };

  const stopAutomaticRule = (workItemId: string) => {
    const item = workspaceRef.current.workItems.find((candidate) => candidate.id === workItemId);
    if (!item) return;
    commitAutomaticOccurrenceAction(
      { type: "stop-rule", workItemId, actedAt: timestamp() },
      `Stop recurrence for ${item.title}`,
      "Stopped future automatic occurrences while retaining the rule and history."
    );
  };

  const createDependency = (projectId: string, values: DependencyCreateValues) => {
    if (!values.fromId || !values.toId || values.fromId === values.toId) return;
    setWorkspace((previous) => {
      const duplicate = previous.dependencies.some((dependency) => dependency.projectId === projectId && dependency.fromId === values.fromId && dependency.toId === values.toId);
      if (duplicate) return previous;
      const id = uniqueId("d", `${values.fromId}-${values.toId}`, previous.dependencies.map((dependency) => dependency.id));
      const dependency: Dependency = {
        id,
        projectId,
        fromId: values.fromId,
        toId: values.toId,
        type: values.type,
        lagSeconds: values.lagDays * daySeconds
      };
      return {
        ...previous,
        dependencies: [...previous.dependencies, dependency],
        changeSets: [
          createChangeSet(
            projectId,
            `Create dependency ${dependencyLabel(values.type)}`,
            "Added from the project dependency composer.",
            [{ entity: "Dependency", entityId: id, field: "created", before: null, after: dependency }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const createEvidence = (projectId: string, values: EvidenceCreateValues) => {
    const summary = values.summary.trim();
    if (!summary) return;
    setWorkspace((previous) => {
      const id = uniqueId("e", summary, previous.evidence.map((item) => item.id));
      const evidenceItem: Evidence = {
        id,
        projectId,
        workItemId: values.workItemId || undefined,
        kind: values.kind,
        summary,
        url: values.url.trim() || undefined,
        createdAt: timestamp(),
        confidence: clamp(values.confidence, 0, 1),
        tags: values.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
      };
      return {
        ...previous,
        evidence: [evidenceItem, ...previous.evidence],
        changeSets: [
          createChangeSet(
            projectId,
            `Add evidence ${summary.slice(0, 32)}`,
            "Added from the evidence capture form.",
            [{ entity: "Evidence", entityId: id, field: "created", before: null, after: evidenceItem }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const recordActual = (projectId: string, workItemId: string, values: ActualRecordValues) => {
    setWorkspace((previous) => {
      const workItem = previous.workItems.find((item) => item.id === workItemId);
      if (!workItem || isAutomaticRecurringWorkItem(workItem)) return previous;
      const nextPercent = values.markFinished ? 100 : clamp(values.percentComplete, 0, 100);
      const recordedAt = timestamp();
      const actual: Actual = {
        workItemId,
        actualStart: previous.actuals.find((item) => item.workItemId === workItemId)?.actualStart ?? recordedAt,
        actualFinish: values.markFinished || nextPercent >= 100 ? recordedAt : undefined,
        actualWorkSeconds: hoursToSeconds(values.actualWorkHours),
        remainingWorkSeconds: values.markFinished ? 0 : hoursToSeconds(values.remainingWorkHours),
        actualCost: Math.max(0, values.actualCost),
        recordedAt
      };
      return {
        ...previous,
        workItems: previous.workItems.map((item) => item.id === workItemId ? { ...item, percentComplete: nextPercent } : item),
        actuals: [actual, ...previous.actuals.filter((item) => item.workItemId !== workItemId)],
        changeSets: [
          createChangeSet(
            projectId,
            `Record actual for ${workItem.title}`,
            "Updated from Today execution.",
            [
              { entity: "WorkItem", entityId: workItemId, field: "percentComplete", before: workItem.percentComplete, after: nextPercent },
              { entity: "Actual", entityId: workItemId, field: "recorded", before: previous.actuals.find((item) => item.workItemId === workItemId) ?? null, after: actual }
            ],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const finishProjectWork = (projectId: string) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project) return previous;
      const targets = previous.workItems.filter((item) => item.projectId === projectId && item.kind !== "phase" && !isAutomaticRecurringWorkItem(item) && item.percentComplete < 100);
      if (!targets.length) return previous;

      const recordedAt = timestamp();
      const existingActualByItem = new Map(previous.actuals.map((actual) => [actual.workItemId, actual]));
      const nextActuals = targets.map((item) => {
        const existing = existingActualByItem.get(item.id);
        const plannedWorkSeconds = item.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0) || item.durationSeconds;
        return {
          workItemId: item.id,
          actualStart: existing?.actualStart ?? recordedAt,
          actualFinish: existing?.actualFinish ?? recordedAt,
          actualWorkSeconds: existing?.actualWorkSeconds || plannedWorkSeconds,
          remainingWorkSeconds: 0,
          actualCost: existing?.actualCost ?? Math.max(1, Math.round(plannedWorkSeconds / 3600)),
          recordedAt
        } satisfies Actual;
      });
      const targetIds = new Set(targets.map((item) => item.id));

      return {
        ...previous,
        workItems: previous.workItems.map((item) => targetIds.has(item.id) ? { ...item, percentComplete: 100 } : item),
        actuals: [...nextActuals, ...previous.actuals.filter((actual) => !targetIds.has(actual.workItemId))],
        changeSets: [
          createChangeSet(
            projectId,
            `Finish open work for ${project.name}`,
            "Operator explicitly marked all unfinished project work complete and recorded actuals.",
            targets.flatMap((item) => [
              { entity: "WorkItem", entityId: item.id, field: "percentComplete", before: item.percentComplete, after: 100 },
              { entity: "Actual", entityId: item.id, field: "recorded", before: existingActualByItem.get(item.id) ?? null, after: nextActuals.find((actual) => actual.workItemId === item.id) }
            ]),
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const captureBaseline = (projectId: string, schedule: ScheduleResult) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project || !schedule.items.length) return previous;
      const baseline: Baseline = {
        id: uniqueId("b", `${project.name} baseline`, previous.baselines.map((item) => item.id)),
        projectId,
        name: `${project.name} baseline ${timestamp().slice(0, 10)}`,
        capturedAt: timestamp(),
        plannedStartByItem: Object.fromEntries(schedule.items.map((item) => [item.workItem.id, item.start])),
        plannedFinishByItem: Object.fromEntries(schedule.items.map((item) => [item.workItem.id, item.finish])),
        plannedWorkSecondsByItem: Object.fromEntries(schedule.items.map((item) => [
          item.workItem.id,
          item.workItem.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0)
        ]))
      };
      return {
        ...previous,
        baselines: [baseline, ...previous.baselines.filter((item) => item.projectId !== projectId)],
        changeSets: [
          createChangeSet(
            projectId,
            `Capture baseline for ${project.name}`,
            "Captured from the current scheduled plan.",
            [{ entity: "Baseline", entityId: baseline.id, field: "created", before: null, after: baseline }],
            previous.changeSets.length,
            "queued-audit"
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const setChangeSetStatus = (changeSetId: string, status: ChangeSet["status"]) => {
    setWorkspace((previous) => {
      const current = previous.changeSets.find((changeSet) => changeSet.id === changeSetId);
      if (!current || current.status === status) return previous;
      const createdAt = timestamp();
      const decision = status === "approved" || status === "blocked" ? {
        id: uniqueId("decision", `${status}-${current.title}`, previous.decisions.map((item) => item.id)),
        projectId: current.projectId,
        statement: `${status === "approved" ? "Approve" : "Block"} ${current.title}`,
        context: current.reason,
        options: ["Approve", "Block", "Defer"],
        rationale: status === "approved"
          ? "Reviewed in Audit Queue and approved for the current plan."
          : "Reviewed in Audit Queue and blocked from the current plan.",
        consequences: status === "approved"
          ? "This ChangeSet is allowed to sync and no longer blocks baseline reporting."
          : "This ChangeSet remains locally visible but is excluded from outgoing sync.",
        linkedEvidenceIds: [],
        createdAt
      } : undefined;
      const statusChangeSet = createChangeSet(
        current.projectId,
        `Set ChangeSet ${current.title} ${status}`,
        "Recorded ChangeSet review status from Audit Queue.",
        [{ entity: "ChangeSet", entityId: current.id, field: "status", before: current.status, after: status }],
        previous.changeSets.length,
        "approved"
      );
      const baselineIds = current.diffs.filter((diff) => diff.entity === "Baseline").map((diff) => diff.entityId);
      return {
        ...previous,
        baselines: decision && status === "approved"
          ? previous.baselines.map((baseline) => baselineIds.includes(baseline.id) ? { ...baseline, approvedByDecisionId: decision.id } : baseline)
          : previous.baselines,
        decisions: decision ? [decision, ...previous.decisions] : previous.decisions,
        changeSets: [
          statusChangeSet,
          ...previous.changeSets.map((changeSet) => changeSet.id === changeSetId ? { ...changeSet, status } : changeSet)
        ]
      };
    });
  };

  const recordAuditDecision = (projectId: string, action: AuditAction, gates: AuditGate[], rationale: string) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      const evidence = previous.evidence.filter((item) => item.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const decision: AuditDecision = {
        id: uniqueId("audit", `${project?.name ?? projectId}-${action}`, previous.auditDecisions.map((item) => item.id)),
        projectId,
        action,
        strongestContinueEvidence: evidence[0]?.summary ?? "No recent evidence has been attached.",
        strongestStopReason: gates.find((gate) => gate.severity === "hard" && gate.status !== "cleared")?.reason ?? "No hard stop reason remains open.",
        rationale: rationale.trim() || `Operator recorded ${action} after reviewing gates and evidence.`,
        createdAt: timestamp(),
        sourceGateIds: gates.map((gate) => gate.id)
      };
      return {
        ...previous,
        auditDecisions: [decision, ...previous.auditDecisions],
        changeSets: [
          createChangeSet(
            projectId,
            `Record audit decision ${action}`,
            "Saved from Audit Queue.",
            [{ entity: "AuditDecision", entityId: decision.id, field: "created", before: null, after: decision }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const saveAuditDecision = (decision: AuditDecision, reason: string) => {
    setWorkspace((previous) => ({
      ...previous,
      auditDecisions: [decision, ...previous.auditDecisions.filter((item) => item.id !== decision.id)],
      changeSets: [
        createChangeSet(
          decision.projectId,
          `Record audit decision ${decision.action}`,
          reason,
          [{ entity: "AuditDecision", entityId: decision.id, field: "created", before: null, after: decision }],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    }));
  };

  const importEvidenceItems = (projectId: string, evidenceItems: Evidence[], reason: string) => {
    if (!evidenceItems.length) return;
    setWorkspace((previous) => {
      const existingIds = new Set(previous.evidence.map((item) => item.id));
      const deduped = evidenceItems.filter((item) => !existingIds.has(item.id));
      if (!deduped.length) return previous;
      return {
        ...previous,
        evidence: [...deduped, ...previous.evidence],
        changeSets: [
          createChangeSet(
            projectId,
            `Import ${deduped.length} evidence item${deduped.length === 1 ? "" : "s"}`,
            reason,
            deduped.map((item) => ({ entity: "Evidence", entityId: item.id, field: "created", before: null, after: item })),
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const clearGate = (gate: AuditGate, rationale: string) => {
    setWorkspace((previous) => {
      const createdAt = timestamp();
      const clearedGate: AuditGate = { ...gate, status: "cleared" };
      const baselineChangeSet = gate.targetType === "baseline"
        ? previous.changeSets.find((changeSet) => changeSet.id === gate.targetId && changeSet.status !== "approved")
        : undefined;
      const baselineIds = baselineChangeSet?.diffs.filter((diff) => diff.entity === "Baseline").map((diff) => diff.entityId) ?? [];
      const baselineApprovalDecision = baselineChangeSet ? {
        id: uniqueId("decision", `approve-${baselineChangeSet.title}`, previous.decisions.map((decision) => decision.id)),
        projectId: baselineChangeSet.projectId,
        statement: `Approve ${baselineChangeSet.title}`,
        context: gate.reason,
        options: ["Approve", "Block", "Defer"],
        rationale: rationale.trim() || "Baseline gate was cleared after operator review, so the underlying ChangeSet is approved.",
        consequences: "The baseline ChangeSet no longer regenerates a hard gate and the baseline can be used for final reporting.",
        linkedEvidenceIds: [],
        createdAt
      } satisfies Decision : undefined;
      const baselineStatusChangeSet = baselineChangeSet ? createChangeSet(
        baselineChangeSet.projectId,
        `Set ChangeSet ${baselineChangeSet.title} approved`,
        "Approved from the baseline gate clear action.",
        [{ entity: "ChangeSet", entityId: baselineChangeSet.id, field: "status", before: baselineChangeSet.status, after: "approved" }],
        previous.changeSets.length,
        "approved"
      ) : undefined;
      const clearChangeSet = createChangeSet(
        gate.projectId,
        `Clear gate ${gate.targetType}`,
        baselineChangeSet ? "Cleared from Audit Queue and approved the linked baseline ChangeSet." : "Cleared from Audit Queue after operator review.",
        [{ entity: "AuditGate", entityId: gate.id, field: "status", before: gate.status, after: "cleared" }],
        previous.changeSets.length + (baselineStatusChangeSet ? 1 : 0)
      );
      return {
        ...previous,
        baselines: baselineApprovalDecision
          ? previous.baselines.map((baseline) => baselineIds.includes(baseline.id) ? { ...baseline, approvedByDecisionId: baselineApprovalDecision.id } : baseline)
          : previous.baselines,
        auditGates: [clearedGate, ...previous.auditGates.filter((candidate) => candidate.id !== gate.id)],
        decisions: [
          {
            id: uniqueId("decision", `clear-${gate.id}`, previous.decisions.map((decision) => decision.id)),
            projectId: gate.projectId,
            statement: `Clear ${gate.targetType} gate`,
            context: gate.reason,
            options: ["Clear", "Block", "Defer"],
            rationale: rationale.trim() || gate.requiredAction,
            consequences: baselineChangeSet
              ? "The linked baseline ChangeSet was approved, so this gate will not regenerate from the same baseline edit."
              : "The gate remains documented and no longer blocks the current plan.",
            linkedEvidenceIds: previous.evidence.filter((item) => item.projectId === gate.projectId && (item.workItemId === gate.targetId || gate.targetType === "project")).map((item) => item.id),
            createdAt
          },
          ...(baselineApprovalDecision ? [baselineApprovalDecision] : []),
          ...previous.decisions
        ],
        changeSets: [
          ...(baselineStatusChangeSet ? [baselineStatusChangeSet] : []),
          clearChangeSet,
          ...previous.changeSets.map((changeSet) => baselineChangeSet && changeSet.id === baselineChangeSet.id ? { ...changeSet, status: "approved" as const } : changeSet)
        ]
      };
    });
  };

  const applyLevelingProposal = (proposal: ReturnType<typeof generateLevelingProposals>[number]) => {
    setWorkspace((previous) => {
      const workItem = previous.workItems.find((item) => item.id === proposal.workItemId);
      if (!workItem) return previous;
      const next: WorkItem = {
        ...workItem,
        constraint: {
          ...workItem.constraint,
          noEarlierThan: proposal.afterStart
        }
      };
      return {
        ...previous,
        workItems: previous.workItems.map((item) => item.id === proposal.workItemId ? next : item),
        changeSets: [
          createChangeSet(
            proposal.projectId,
            `Apply leveling to ${workItem.title}`,
            proposal.reason,
            [{ entity: "WorkItem", entityId: workItem.id, field: "constraint.noEarlierThan", before: workItem.constraint?.noEarlierThan ?? null, after: proposal.afterStart }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const model = useMemo(() => {
    const schedules = scheduleShapeUpAwarePortfolio(workspace.projects, workspace.workItems, workspace.dependencies);
    const calculatedGates = workspace.projects.flatMap((project) => {
      const schedule = schedules.find((candidate) => candidate.projectId === project.id);
      return evaluateAuditGates(
        project,
        workspace.workItems,
        schedule?.items ?? [],
        workspace.evidence,
        workspace.changeSets,
        now
      );
    });
    const gates = applyGateOverrides(calculatedGates, workspace.auditGates);
    const decisions = workspace.projects.map((project) =>
      latestDecisionForProject(project.id, workspace.auditDecisions) ??
      recommendAuditDecision(project, gates.filter((gate) => gate.projectId === project.id), workspace.evidence, now)
    );
    const health = workspace.projects.map((project) =>
      calculateProjectHealth(
        project,
        schedules.find((candidate) => candidate.projectId === project.id) ?? { projectId: project.id, items: [], diagnostics: [], unsupported: [] },
        workspace.evidence,
        gates,
        now
      )
    );
    const activeProjectIds = new Set(workspace.projects.filter((project) => !isProjectArchived(project)).map((project) => project.id));
    const activeSchedules = schedules.filter((schedule) => activeProjectIds.has(schedule.projectId));
    const overloads = detectCrossProjectOverload(activeSchedules, workspace.resources);
    const leveling = generateLevelingProposals(activeSchedules, workspace.resources);
    return { schedules, gates, decisions, health, overloads, leveling };
  }, [workspace]);

  const selectedSchedule = selectedProject
    ? model.schedules.find((schedule) => schedule.projectId === selectedProject.id) ?? scheduleShapeUpAwarePortfolio([selectedProject], workspace.workItems, workspace.dependencies)[0]
    : undefined;
  const selectedDependencies = selectedProject && selectedSchedule
    ? isShapeUpProject(selectedProject)
      ? executableDependenciesForItems(
        workspace.dependencies.filter((dependency) => dependency.projectId === selectedProject.id),
        selectedSchedule.items.map((item) => item.workItem)
      )
      : workspace.dependencies.filter((dependency) => dependency.projectId === selectedProject.id)
    : [];
  const selectedBaseline = selectedProject ? workspace.baselines.find((baseline) => baseline.projectId === selectedProject.id) : undefined;
  const selectedApprovedBaseline = isBaselineApproved(selectedBaseline, workspace.changeSets) ? selectedBaseline : undefined;
  const selectedGates = selectedProject ? model.gates.filter((gate) => gate.projectId === selectedProject.id) : [];
  const selectedDecision = selectedProject ? model.decisions.find((decision) => decision.projectId === selectedProject.id) ?? model.decisions[0] : undefined;
  const selectedEvm = selectedProject && selectedSchedule && selectedApprovedBaseline
    ? calculateEvm(
        selectedProject,
        selectedSchedule.items,
        selectedApprovedBaseline,
        workspace.actuals,
        workspace.resources,
        now
      )
    : undefined;
  const selectedMonteCarlo = selectedProject ? runMonteCarlo(
      selectedProject,
      workspace.workItems.filter((item) => item.projectId === selectedProject.id),
      workspace.dependencies.filter((dependency) => dependency.projectId === selectedProject.id),
      300,
      7
    ) : undefined;
  const activePlanningProjectIds = new Set(workspace.projects.filter((project) => !isProjectArchived(project)).map((project) => project.id));
  const openHardGateCount = model.gates.filter((gate) => activePlanningProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared").length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside
        data-collapsed={sidebarCollapsed ? "true" : "false"}
        className={cn(
          "desktopSidebar fixed inset-y-0 left-0 z-30 hidden flex-col border-r bg-card/95 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] shadow-sm backdrop-blur lg:flex",
          sidebarCollapsed ? "w-20 px-2" : "w-64 px-3"
        )}
      >
        <div className={cn("desktopSidebarBrand", sidebarCollapsed && "collapsed")}>
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">OP</div>
          {!sidebarCollapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold">OmniPlan Personal</div>
            <div className="text-xs text-muted-foreground">AI-era project OS</div>
          </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="sidebarCollapseButton"
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setSidebarCollapsed((current) => !current)}
          >
            {sidebarCollapsed ? <ChevronRight /> : <ChevronLeft />}
          </Button>
        </div>
        <nav className="space-y-1" aria-label="Primary">
          <NavButton collapsed={sidebarCollapsed} active={view === "portfolio"} icon={<Home />} label="Portfolio" href={hashForRoute({ view: "portfolio", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "project"} icon={<Workflow />} label="Project" href={hashForRoute({ view: "project", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "calendar"} icon={<CalendarClock />} label="Calendar" href={hashForRoute({ view: "calendar", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "today"} icon={<Timer />} label="Today" href={hashForRoute({ view: "today", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "audit"} icon={<ShieldAlert />} label="Audit" href={hashForRoute({ view: "audit", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "reports"} icon={<FileDown />} label="Reports" href={hashForRoute({ view: "reports", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "agent"} icon={<ClipboardCheck />} label="Agent" href={hashForRoute({ view: "agent", selectedProjectId })} />
          <NavButton collapsed={sidebarCollapsed} active={view === "settings"} icon={<KeyRound />} label="Settings" href={hashForRoute({ view: "settings", selectedProjectId })} />
        </nav>
        <Separator className="my-4" />
        {sidebarCollapsed ? (
        <div className="flex justify-center">
          <IconStatusBadge
            variant={openHardGateCount ? "destructive" : "success"}
            status={openHardGateCount ? `${openHardGateCount} hard gates require review` : "Audit clear"}
            icon={openHardGateCount ? <ShieldAlert /> : <CheckCircle2 />}
          />
        </div>
        ) : (
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{asOfLabel}</div>
          <div>{openHardGateCount ? `${openHardGateCount} hard gates require review` : "Audit clear"}</div>
        </div>
        )}
        <Separator className="mb-3 mt-auto" />
        <div
          className={cn(
            "flex min-h-9 items-center rounded-md border bg-muted/20 text-xs text-muted-foreground",
            sidebarCollapsed ? "justify-center px-2" : "justify-between gap-2 px-3"
          )}
          aria-label={buildCommit === "unknown" ? "Build commit unavailable" : `Build commit ${buildCommit}`}
          title={buildCommit === "unknown" ? "Build commit unavailable" : `Build commit ${buildCommit}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            <GitCommitHorizontal className="size-4 shrink-0" aria-hidden="true" />
            {!sidebarCollapsed && <span>commit</span>}
          </span>
          {!sidebarCollapsed && <code className="truncate font-mono tabular-nums text-foreground">{buildCommitShort}</code>}
        </div>
      </aside>

      <div className={cn("desktopContent", sidebarCollapsed ? "lg:pl-20" : "lg:pl-64")}>
        <nav className="fixed inset-x-3 bottom-3 z-30 grid grid-cols-8 rounded-xl border bg-card/95 p-1 shadow-lg backdrop-blur lg:hidden" aria-label="Mobile primary">
          <NavButton active={view === "portfolio"} icon={<Home />} label="Portfolio" href={hashForRoute({ view: "portfolio", selectedProjectId })} />
          <NavButton active={view === "project"} icon={<Workflow />} label="Project" href={hashForRoute({ view: "project", selectedProjectId })} />
          <NavButton active={view === "calendar"} icon={<CalendarClock />} label="Calendar" href={hashForRoute({ view: "calendar", selectedProjectId })} />
          <NavButton active={view === "today"} icon={<Timer />} label="Today" href={hashForRoute({ view: "today", selectedProjectId })} />
          <NavButton active={view === "audit"} icon={<ShieldAlert />} label="Audit" href={hashForRoute({ view: "audit", selectedProjectId })} />
          <NavButton active={view === "reports"} icon={<FileDown />} label="Reports" href={hashForRoute({ view: "reports", selectedProjectId })} />
          <NavButton active={view === "agent"} icon={<ClipboardCheck />} label="Agent" href={hashForRoute({ view: "agent", selectedProjectId })} />
          <NavButton active={view === "settings"} icon={<KeyRound />} label="Settings" href={hashForRoute({ view: "settings", selectedProjectId })} />
        </nav>
        <main className="px-4 py-4 pb-24 lg:px-6 lg:pb-8" aria-labelledby="page-title">
        <h1 id="page-title" ref={pageTitleRef} tabIndex={-1} className="srOnly">{viewTitle(view, selectedProjectName)}</h1>
        <div className="routeAnnouncer" aria-live="polite">{breadcrumbFor(view, selectedProjectName)}</div>

        {view === "portfolio" && (
          <PortfolioDashboard
            projects={workspace.projects}
            schedules={model.schedules}
            health={model.health}
            gates={model.gates}
            overloads={model.overloads}
            onProjectCreate={createProject}
            onProjectRestore={restoreProject}
          />
        )}
        {view === "project" && selectedProject && selectedSchedule && (
          <ProjectWorkspace
            project={selectedProject}
            target={route.target}
            workItems={workspace.workItems.filter((item) => item.projectId === selectedProject.id)}
            allWorkItems={workspace.workItems}
            baseline={selectedBaseline}
            baselineChangeSet={selectedBaseline ? workspace.changeSets.find((changeSet) =>
              changeSet.projectId === selectedProject.id &&
              changeSet.status !== "approved" &&
              changeSet.diffs.some((diff) => diff.entity === "Baseline" && diff.entityId === selectedBaseline.id)
            ) : undefined}
            baselineApproved={isBaselineApproved(selectedBaseline, workspace.changeSets)}
            dependencies={selectedDependencies}
            schedule={selectedSchedule}
            gates={selectedGates}
            health={model.health.find((item) => item.projectId === selectedProject.id)}
            evidence={workspace.evidence.filter((item) => item.projectId === selectedProject.id)}
            onProjectChange={(projectId) => navigate("project", projectId)}
            onProjectStatusUpdate={updateProjectStatus}
            onProjectDetailsUpdate={updateProjectDetails}
            onDirectionCardUpdate={updateDirectionCard}
            onShapeUpPitchUpdate={updateShapeUpPitch}
            onShapeUpBetApprove={approveShapeUpBet}
            onShapeUpConvert={convertProjectToShapeUp}
            onWorkItemCreate={createWorkItem}
            onWorkItemScheduleUpdate={updateWorkItemSchedule}
            onWorkItemMove={moveWorkItem}
            onWorkItemRepeatRuleUpdate={updateWorkItemRepeatRule}
            onAutomaticRuleStop={stopAutomaticRule}
            onDependencyCreate={createDependency}
            onEvidenceCreate={createEvidence}
            onActualRecord={recordActual}
            onProjectWorkFinish={finishProjectWork}
            onProjectComplete={completeProject}
            onProjectArchive={archiveProject}
            onProjectRestore={restoreProject}
            onProjectDelete={deleteEmptyProject}
            onBaselineCapture={() => captureBaseline(selectedProject.id, selectedSchedule)}
            onChangeSetStatus={setChangeSetStatus}
            onGateClear={clearGate}
            onDependencyUpdate={updateDependency}
            onDependencyRemove={removeDependency}
            projects={workspace.projects}
            recurringOccurrences={workspace.recurringOccurrences}
            changeSets={workspace.changeSets.filter((changeSet) => changeSet.projectId === selectedProject.id)}
            timeZone={workspace.timeZone}
            currentTime={clockNow}
          />
        )}
        {view === "project" && (!selectedProject || !selectedSchedule) && (
          <EmptyWorkspacePanel onProjectCreate={createProject} />
        )}
        {view === "today" && (
          <TodayExecution
            workspace={workspace}
            schedules={model.schedules}
            projects={workspace.projects}
            gates={model.gates}
            onActualRecord={recordActual}
            currentTime={clockNow}
            onOccurrenceSkip={skipAutomaticOccurrence}
            onOccurrenceReschedule={rescheduleAutomaticOccurrence}
            onOccurrenceException={reportAutomaticOccurrenceException}
          />
        )}
        {view === "calendar" && (
          <CalendarView
            workspace={workspace}
            schedules={model.schedules}
            currentTime={clockNow}
            selectedProjectId={selectedProjectId}
            onWorkItemCreate={createWorkItem}
            onWorkItemScheduleUpdate={updateWorkItemSchedule}
            onOccurrenceSkip={skipAutomaticOccurrence}
            onOccurrenceReschedule={rescheduleAutomaticOccurrence}
            onOccurrenceException={reportAutomaticOccurrenceException}
          />
        )}
        {view === "audit" && (
          <AuditQueue
            projects={workspace.projects}
            schedules={model.schedules}
            gates={model.gates}
            decisions={model.decisions}
            leveling={model.leveling}
            changeSets={workspace.changeSets}
            onGateClear={clearGate}
            onAuditDecisionRecord={recordAuditDecision}
            onChangeSetStatus={setChangeSetStatus}
            onLevelingApply={applyLevelingProposal}
          />
        )}
        {view === "reports" && selectedProject && selectedSchedule && selectedDecision && selectedMonteCarlo && (
          <Reports
            project={selectedProject}
            schedule={selectedSchedule}
            markdown={exportProjectMarkdown(
              selectedProject,
              selectedSchedule,
              workspace.evidence,
              selectedDecision,
              selectedEvm,
              selectedMonteCarlo,
              selectedGates,
              selectedApprovedBaseline
            )}
            csv={exportScheduleCsv(selectedSchedule)}
            evm={selectedEvm}
            p50={selectedMonteCarlo.p50Finish}
            p90={selectedMonteCarlo.p90Finish}
            gates={selectedGates}
            baseline={selectedApprovedBaseline}
          />
        )}
        {view === "reports" && (!selectedProject || !selectedSchedule || !selectedDecision || !selectedMonteCarlo) && (
          <EmptyWorkspacePanel onProjectCreate={createProject} />
        )}
        {view === "agent" && (
          <AgentCenter
            workspace={workspace}
            schedules={model.schedules}
            gates={model.gates}
            settings={appSettings}
            sessionPassphrase={sessionPassphrase}
            onAuditDecisionSave={saveAuditDecision}
          />
        )}
        {view === "settings" && (
          <Settings
            workspace={workspace}
            settings={appSettings}
            onSettingsSave={saveAppSettings}
            sessionPassphrase={sessionPassphrase}
            onSessionPassphraseChange={setSessionPassphrase}
            rememberedPassphraseLoaded={rememberedPassphraseLoaded}
            rememberedPassphraseSavedAt={rememberedPassphraseSavedAt}
            onRememberPassphrase={rememberSessionPassphrase}
            onForgetRememberedPassphrase={forgetRememberedPassphrase}
            autoSyncStatus={autoSyncStatus}
            syncBlockedByExternalChange={localWorkspaceConflictRef.current || firebaseSettingsConflictRef.current}
            workspacePersistence={workspacePersistence}
            onWorkspaceTimeZoneChange={updateWorkspaceTimeZone}
            onWorkspaceImport={(nextWorkspace) => setWorkspace(nextWorkspace)}
            onWorkspaceReset={() => setWorkspace(createEmptyWorkspace())}
            onEvidenceImport={importEvidenceItems}
          />
        )}
        </main>
      </div>
    </div>
  );
}

function viewTitle(view: View, projectName: string) {
  switch (view) {
    case "portfolio":
      return "Portfolio Control";
    case "project":
      return projectName;
    case "calendar":
      return "Calendar";
    case "today":
      return "Today Execution";
    case "audit":
      return "Audit Queue";
    case "reports":
      return "Reports";
    case "agent":
      return "Agent";
    case "settings":
      return "Secrets & Storage";
  }
}

function breadcrumbFor(view: View, projectName: string) {
  if (view === "portfolio") return "Portfolio";
  if (view === "project") return `Portfolio / ${projectName}`;
  return `Portfolio / ${viewTitle(view, projectName)}`;
}

function NavButton({
  active,
  href,
  icon,
  label,
  collapsed = false
}: {
  active: boolean;
  href: string;
  icon: ReactNode;
  label: string;
  collapsed?: boolean;
}) {
  return (
    <a
      data-active={active ? "true" : "false"}
      className={cn(
        "appNavButton flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground lg:justify-start lg:px-3 lg:text-sm",
        collapsed && "lg:justify-center lg:px-0",
        active && "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground"
      )}
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span className={collapsed ? "hidden" : "hidden lg:inline"}>{label}</span>
    </a>
  );
}

function EmptyWorkspacePanel({ onProjectCreate }: { onProjectCreate: (values: ProjectCreateValues) => void }) {
  return (
    <Card className="border-dashed">
      <CardHeader className="compactCardHeader">
        <div className="cardHeaderLine">
          <CardTitle className="flex items-center gap-2"><Layers3 className="h-4 w-4" /> No local projects</CardTitle>
          <Badge variant="outline" className="iconBadge" title="Empty workspace"><CheckCircle2 />clean</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">
          This browser has no local workspace data. Create a project, import a backup, or pull from Firebase after configuring sync.
        </p>
        <CreateProjectSheet onCreate={onProjectCreate} />
      </CardContent>
    </Card>
  );
}

function ArchivedProjectsSheet({
  projects,
  onRestore
}: {
  projects: Project[];
  onRestore: (projectId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const archivedProjects = [...projects]
    .filter(isProjectArchived)
    .sort((left, right) => (
      (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "") ||
      left.name.localeCompare(right.name)
    ));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredProjects = normalizedQuery
    ? archivedProjects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery))
    : archivedProjects;
  const resultAnnouncement = announcement || `${filteredProjects.length} archived project${filteredProjects.length === 1 ? "" : "s"} found.`;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Browse archived projects (${archivedProjects.length})`}
          title={`${archivedProjects.length} archived project${archivedProjects.length === 1 ? "" : "s"}`}
        >
          <Archive />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-[94vw] flex-col overflow-hidden pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))] sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="text-balance">Archived projects</SheetTitle>
          <SheetDescription className="text-pretty">Open a project without restoring it, or return it to the active portfolio.</SheetDescription>
        </SheetHeader>
        <div className="mt-4 grid min-h-0 flex-1 gap-3">
          <label>
            <span className="text-sm font-medium">Search</span>
            <Input
              ref={searchInputRef}
              className="mt-2"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setAnnouncement("");
              }}
              placeholder="Search archived projects"
              aria-label="Search archived projects"
            />
          </label>
          <p className="sr-only" role="status">{resultAnnouncement}</p>
          {!archivedProjects.length ? (
            <div className="grid place-items-center gap-3 rounded-lg border border-dashed p-6 text-center">
              <Archive className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
              <p className="text-pretty text-sm text-muted-foreground">Archive is empty.</p>
              <SheetClose asChild>
                <Button type="button" variant="outline">Close</Button>
              </SheetClose>
            </div>
          ) : filteredProjects.length ? (
            <ul className="grid min-h-0 content-start gap-2 overflow-y-auto pr-1" aria-label="Archived projects">
              {filteredProjects.map((project) => (
                <li key={project.id} className="flex items-center justify-between gap-3 rounded-lg border bg-background p-3">
                  <div className="min-w-0">
                    <strong className="block break-words text-sm">{project.name}</strong>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Badge variant="outline" className="iconBadge" title={`Lifecycle status: ${projectLifecycleStatus(project)}`}><Workflow />{projectLifecycleStatus(project)}</Badge>
                      <span className="tabular-nums">{project.archivedAt ? project.archivedAt.slice(0, 10) : "Date unknown"}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button asChild type="button" size="icon" variant="outline" title="Open archived project">
                      <a href={hashForRoute({ view: "project", selectedProjectId: project.id })} aria-label={`Open archived project ${project.name}`}>
                        <PanelRight />
                      </a>
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      onClick={() => {
                        searchInputRef.current?.focus();
                        setAnnouncement(`${project.name} restored to the active portfolio.`);
                        onRestore(project.id);
                      }}
                      aria-label={`Restore project ${project.name}`}
                      title="Restore project"
                    >
                      <ArchiveRestore />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid place-items-center gap-3 rounded-lg border border-dashed p-6 text-center">
              <p className="text-pretty text-sm text-muted-foreground">No archived project matches this search.</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setAnnouncement("");
                  searchInputRef.current?.focus();
                }}
              >
                <CircleSlash2 />Clear search
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function PortfolioDashboard({
  projects,
  schedules,
  health,
  gates,
  overloads,
  onProjectCreate,
  onProjectRestore
}: {
  projects: Project[];
  schedules: ScheduleResult[];
  health: ReturnType<typeof calculateProjectHealth>[];
  gates: AuditGate[];
  overloads: ReturnType<typeof detectCrossProjectOverload>;
  onProjectCreate: (values: ProjectCreateValues) => void;
  onProjectRestore: (projectId: string) => void;
}) {
  const [shapeUpOpen, setShapeUpOpen] = useState(false);
  const sorted = [...projects].sort((a, b) => {
    const left = health.find((item) => item.projectId === a.id)?.recommendedFocus ?? 0;
    const right = health.find((item) => item.projectId === b.id)?.recommendedFocus ?? 0;
    return right - left;
  });
  const planningProjects = sorted.filter((project) => !isProjectArchived(project));
  const visibleProjects = planningProjects;
  const focusStackPage = usePagedItems(visibleProjects, 8);
  const planningProjectIds = new Set(planningProjects.map((project) => project.id));
  const planningSchedules = schedules.filter((schedule) => planningProjectIds.has(schedule.projectId));
  const openHardGates = gates.filter((gate) => planningProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared").length;
  const criticalCount = planningSchedules.reduce((sum, schedule) => sum + schedule.items.filter((item) => item.isCritical).length, 0);
  const activeDeliveryProjects = planningProjects.filter((project) => project.status === "active" && (!isShapeUpProject(project) || isShapeUpBet(project)));
  const shapeUpProjects = planningProjects.filter(isShapeUpProject);
  const shapeUpStreams = [
    {
      label: "Shaping",
      projects: shapeUpProjects.filter((project) => project.status === "waiting" && !isShapeUpPitchComplete(project.shapeUpPitch))
    },
    {
      label: "Betting",
      projects: shapeUpProjects.filter((project) => project.status === "waiting" && isShapeUpPitchComplete(project.shapeUpPitch))
    },
    {
      label: "Building",
      projects: shapeUpProjects.filter((project) => project.status === "active")
    },
    {
      label: "Circuit Breaker",
      projects: shapeUpProjects.filter((project) => project.status === "paused")
    }
  ];
  if (!visibleProjects.length) {
    return (
      <section className="grid gap-3">
        <div className="portfolioHeader">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">Portfolio workspace</h2>
            <div className="compactBadgeRow">
              <Badge variant="outline" className="iconBadge" title="No local projects"><Layers3 />0 active</Badge>
              <Badge variant="success" className="iconBadge" title="No hard gates"><AlertTriangle />0</Badge>
              <Badge variant="outline" className="iconBadge" title="No critical path items"><Network />0 CP</Badge>
              <Badge variant="success" className="iconBadge" title="No overloads"><CalendarClock />0</Badge>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ArchivedProjectsSheet projects={projects} onRestore={onProjectRestore} />
            <CreateProjectSheet onCreate={onProjectCreate} />
          </div>
        </div>
        {projects.length ? (
          <Card className="border-dashed">
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle className="flex items-center gap-2 text-balance"><Archive className="h-4 w-4" /> No active projects</CardTitle>
                <Badge variant="outline" className="iconBadge" title={`${projects.length} archived projects`}><Archive />{projects.length}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="max-w-xl text-pretty text-sm text-muted-foreground">Restore a project from the archive or create a new project to resume active planning.</p>
            </CardContent>
          </Card>
        ) : (
          <EmptyWorkspacePanel onProjectCreate={onProjectCreate} />
        )}
      </section>
    );
  }
  const focusProject = visibleProjects[0];
  const focusHealth = health.find((item) => item.projectId === focusProject.id);
  const focusSchedule = schedules.find((schedule) => schedule.projectId === focusProject.id);
  const focusNext = focusSchedule ? nextScheduledItem(focusSchedule.items) : undefined;
  const focusGate = gates.find((gate) => gate.projectId === focusProject.id && gate.severity === "hard" && gate.status !== "cleared");
  const overdueRows = schedules
    .flatMap((schedule) => schedule.items.map((item) => ({ item, projectId: schedule.projectId })))
    .filter(({ item, projectId }) => planningProjectIds.has(projectId) && item.workItem.kind !== "phase" && item.workItem.percentComplete < 100 && scheduleTiming(item) === "Overdue");
  const staleEvidenceProjects = health.filter((item) => planningProjectIds.has(item.projectId) && (item.evidenceFreshnessDays === undefined || item.evidenceFreshnessDays >= 5));
  const criticalFocus = focusSchedule?.items.filter((item) => item.isCritical && item.workItem.kind !== "phase").length ?? 0;
  const planningHealth = health.filter((item) => planningProjectIds.has(item.projectId));
  const portfolioRisk = Math.round(planningHealth.reduce((sum, item) => sum + item.riskScore, 0) / Math.max(1, planningHealth.length));
  const matrixBaseItems = visibleProjects.map((project, index) => ({
    index,
    project,
    health: health.find((item) => item.projectId === project.id)!,
    status: projectLifecycleStatus(project)
  }));
  const matrixRiskValues = matrixBaseItems.map((item) => item.health.riskScore);
  const matrixMomentumValues = matrixBaseItems.map((item) => item.health.momentumScore);
  const matrixClusterCounts = new Map<string, number>();
  const matrixItems = matrixBaseItems.map((item) => {
    const clusterKey = `${item.health.riskScore}:${item.health.momentumScore}`;
    const clusterIndex = matrixClusterCounts.get(clusterKey) ?? 0;
    matrixClusterCounts.set(clusterKey, clusterIndex + 1);
    const offset = matrixNodeOffset(clusterIndex);
    const x = clampMatrixPosition(matrixRelativePosition(item.health.momentumScore, matrixMomentumValues) + offset.x);
    const y = clampMatrixPosition(matrixRelativePosition(item.health.riskScore, matrixRiskValues) + offset.y);
    const decision = matrixDecisionForPoint(x, y, item.health.openHardGates);

    return {
      ...item,
      x,
      y,
      decision
    };
  });
  const pressureMatrixItems = matrixItems.filter((item) => item.decision === "narrow" || item.decision === "audit");
  const pushMatrixItems = matrixItems.filter((item) => item.decision === "push");
  const watchMatrixItems = matrixItems.filter((item) => item.decision === "watch");
  const matrixLeadItems = pressureMatrixItems.length ? pressureMatrixItems : matrixItems.slice(0, Math.min(2, matrixItems.length));
  const matrixHeadline = pressureMatrixItems.length
    ? `${pressureMatrixItems.length} project${pressureMatrixItems.length === 1 ? "" : "s"} need attention before more scope`
    : `${pushMatrixItems.length} project${pushMatrixItems.length === 1 ? "" : "s"} can keep moving`;
  const matrixDetail = pressureMatrixItems.length
    ? `${formatCompactProjectList(matrixLeadItems.map((item) => item.project))} carries the most visible pressure in this portfolio.`
    : "No high-pressure cluster is visible; keep paused backlog work parked until you choose to promote it.";

  return (
    <section className="grid gap-3">
      <div className="portfolioHeader">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Portfolio workspace</h2>
          <div className="compactBadgeRow">
            <Badge variant="secondary" className="iconBadge" title="Active delivery projects"><Layers3 />{activeDeliveryProjects.length} active</Badge>
            <Badge variant={openHardGates ? "destructive" : "success"} className="iconBadge" title="Open hard gates"><AlertTriangle />{openHardGates}</Badge>
            <Badge variant="outline" className="iconBadge" title="Critical path items"><Network />{criticalCount} CP</Badge>
            <Badge variant={overloads.length ? "warning" : "success"} className="iconBadge" title="Attention overloads"><CalendarClock />{overloads.length}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ArchivedProjectsSheet projects={projects} onRestore={onProjectRestore} />
          <CreateProjectSheet onCreate={onProjectCreate} />
        </div>
      </div>

      <Card id="shape-up-streams">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <button
              type="button"
              className="collapseHeaderButton"
              aria-expanded={shapeUpOpen}
              aria-controls="shape-up-streams-body"
              onClick={() => setShapeUpOpen((current) => !current)}
            >
              <Target className="h-4 w-4" />
              <span>Shape Up Flow</span>
              {shapeUpOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            <div className="cardHeaderBadges">
              <Badge variant="outline" className="iconBadge" title="Waiting for shaping or betting"><Target />{shapeUpStreams[0].projects.length + shapeUpStreams[1].projects.length}</Badge>
              <Badge variant="secondary" className="iconBadge" title="Active Shape Up builds"><Play />{shapeUpStreams[2].projects.length}</Badge>
              <Badge variant="warning" className="iconBadge" title="Circuit breaker queue"><ShieldAlert />{shapeUpStreams[3].projects.length}</Badge>
            </div>
          </div>
        </CardHeader>
        {shapeUpOpen && (
          <CardContent id="shape-up-streams-body" className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {shapeUpStreams.map((stream) => (
              <div key={stream.label} className="compactStream">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{stream.label}</h3>
                  <Badge variant={stream.projects.length ? "secondary" : "outline"}>{stream.projects.length}</Badge>
                </div>
                <div className="grid gap-1.5">
                  {stream.projects.slice(0, 3).map((project) => (
                    <a key={project.id} className="compactStreamProject" href={hashForRoute({ view: "project", selectedProjectId: project.id, target: "shape-up" })}>
                      <strong className="block truncate">{project.name}</strong>
                      <span>
                        {project.shapeUpPitch?.bet ? `ends ${project.shapeUpPitch.bet.cycleEnd.slice(0, 10)}` : `${shapeUpMissingBetRequirements(project).length} pitch gaps`}
                      </span>
                    </a>
                  ))}
                  {!stream.projects.length && <span className="compactEmpty"><CheckCircle2 />0</span>}
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4" /> Command Brief</CardTitle>
            <Badge variant={openHardGates ? "destructive" : "success"}>{openHardGates ? "Action required" : "Clear"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <ActionCard
            icon={<Lock />}
            tone={focusGate ? "danger" : "neutral"}
            label="Gate"
            title={focusGate ? `${focusProject.name}: ${focusGate.targetType}` : "No hard blocker"}
            detail={focusGate?.reason}
            meta={`${openHardGates} hard gates`}
            href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "hard-gates" })}
          />
          <ActionCard
            icon={<Timer />}
            label={overdueRows.length ? "Overdue work" : focusNext ? `${scheduleTiming(focusNext)} action` : "Next action"}
            title={overdueRows[0]?.item.workItem.title ?? focusNext?.workItem.title ?? "No open scheduled work"}
            detail={overdueRows[0] ? formatScheduleRange(overdueRows[0].item) : focusNext ? formatScheduleRange(focusNext) : undefined}
            meta={`${overdueRows.length} overdue`}
            href={hashForRoute({ view: "today", selectedProjectId: focusProject.id, target: "critical-items" })}
          />
          <ActionCard
            icon={<Network />}
            label="Critical path"
            title={`${criticalFocus} critical items in focus project`}
            detail={focusNext?.workItem.title}
            meta={`Risk ${focusHealth?.riskScore ?? portfolioRisk}`}
            href={hashForRoute({ view: "project", selectedProjectId: focusProject.id, target: "project-gantt" })}
          />
          <ActionCard
            icon={<FileText />}
            tone={staleEvidenceProjects.length ? "warning" : "neutral"}
            label="Evidence debt"
            title={formatFreshness(focusHealth?.evidenceFreshnessDays)}
            detail={staleEvidenceProjects.length ? `${staleEvidenceProjects.length} stale project${staleEvidenceProjects.length === 1 ? "" : "s"}` : undefined}
            meta={`${staleEvidenceProjects.length} stale`}
            href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "audit-warnings" })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]">
        <Card id="portfolio-focus-list">
          <CardHeader className="compactCardHeader">
            <div className="cardHeaderLine">
              <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> Focus Stack</CardTitle>
              <div className="cardHeaderBadges">
                <Badge variant="outline" className="iconBadge" title="Risk"><AlertTriangle />R</Badge>
                <Badge variant="outline" className="iconBadge" title="Momentum"><Zap />M</Badge>
                <Badge variant="outline" className="iconBadge" title="Evidence debt"><FileText />E</Badge>
                <Badge variant="outline" className="iconBadge" title="Hard gates"><Lock />G</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="focusStackList">
          {focusStackPage.items.map((project, index) => {
            const projectHealth = health.find((item) => item.projectId === project.id)!;
            const projectSchedule = schedules.find((schedule) => schedule.projectId === project.id);
            const finish = projectSchedule?.items.reduce((max, item) => (item.finish > max ? item.finish : max), project.start);
            const next = projectSchedule ? nextScheduledItem(projectSchedule.items) : undefined;
            const projectCritical = projectSchedule?.items.filter((item) => item.isCritical && item.workItem.kind !== "phase").length ?? 0;
            const lifecycleStatus = projectLifecycleStatus(project);
            const action = focusAction(projectHealth, lifecycleStatus);
            const evidenceDebt = evidenceFreshnessScore(projectHealth.evidenceFreshnessDays);
            const riskTone = projectHealth.riskScore >= 70 ? "danger" : projectHealth.riskScore >= 45 ? "warn" : "ok";
            const evidenceTone = projectHealth.evidenceFreshnessDays === undefined || projectHealth.evidenceFreshnessDays >= 5 ? "danger" : "ok";
            return (
              <a
                key={project.id}
                className={cn(
                  "focusStackItem",
                  projectHealth.openHardGates && "hasGate"
                )}
                href={hashForRoute({ view: "project", selectedProjectId: project.id })}
                aria-label={`${project.name}, ${action}, ${projectLifecycleLabel(project)}, risk ${projectHealth.riskScore}, momentum ${projectHealth.momentumScore}, evidence debt ${evidenceDebt}`}
              >
                <span className={cn("focusStackRank", action.toLowerCase())} title={action}>#{focusStackPage.page * focusStackPage.pageSize + index + 1}</span>
                <div className="focusStackBody">
                  <div className="focusStackTop">
                    <div className="focusStackTitleLine">
                      <strong title={project.name}>{project.name}</strong>
                      <Badge variant={project.status === "active" && !isProjectArchived(project) ? "success" : "warning"} className="focusPill" title={projectLifecycleLabel(project)}>
                        <CheckCircle2 />{projectLifecycleLabel(project)}
                      </Badge>
                      <Badge variant="secondary" className="focusPill" title={`Mode: ${project.mode}`}>
                        <Workflow />{project.mode}
                      </Badge>
                      {action !== "Continue" && (
                        <Badge variant={action === "Narrow" ? "destructive" : "outline"} className="focusPill" title={`Recommended action: ${action}`}>
                          <Target />{action}
                        </Badge>
                      )}
                    </div>
                    <span className="focusOpenIcon" title="Open project" aria-hidden="true"><PanelRight /></span>
                  </div>
                  <div className="focusStackSignals" aria-label={`${project.name} focus signals`}>
                    <span className={`focusSignalChip ${riskTone}`} title={`Risk ${projectHealth.riskScore}`}><AlertTriangle />R {projectHealth.riskScore}</span>
                    <span className="focusSignalChip ok" title={`Momentum ${projectHealth.momentumScore}`}><Zap />M {projectHealth.momentumScore}</span>
                    <span className={`focusSignalChip ${evidenceTone}`} title={`Evidence debt ${evidenceDebt}`}><FileText />E {evidenceDebt}</span>
                    <span className={cn("focusSignalChip", projectHealth.openHardGates ? "danger" : "neutral")} title={`${projectHealth.openHardGates} hard gates`}><Lock />{projectHealth.openHardGates}</span>
                    <span className="focusSignalChip neutral" title={finish ? `Finish ${formatShortDateTime(finish)}, ${projectCritical} critical` : "No finish date"}>
                      <CalendarClock />{finish ? formatShortDateTime(finish) : "-"} · {projectCritical} CP
                    </span>
                  </div>
                  <div className="focusNextLine" title={next?.workItem.title ?? "No next action"}>
                    <Timer />
                    <span>{next ? scheduleTiming(next) : "Next"}</span>
                    <strong>{next?.workItem.title ?? "none"}</strong>
                  </div>
                </div>
              </a>
            );
          })}
          <PaginationControls label="focus stack" {...focusStackPage} onPageChange={focusStackPage.setPage} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="compactCardHeader">
            <div className="cardHeaderLine">
              <CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Momentum x Risk</CardTitle>
              <div className="cardHeaderBadges">
                <Badge variant="outline" className="iconBadge" title="Higher risk is up"><AlertTriangle />R up</Badge>
                <Badge variant="outline" className="iconBadge" title="More momentum is right"><Zap />M right</Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="matrixDecisionSummary">
              <div>
                <span className="matrixEyebrow">Current read</span>
                <strong>{matrixHeadline}</strong>
                <p>{matrixDetail}</p>
              </div>
              <div className="matrixStats" aria-label="Momentum risk project counts">
                <span><b>{pressureMatrixItems.length}</b> pressure</span>
                <span><b>{pushMatrixItems.length}</b> push</span>
                <span><b>{watchMatrixItems.length}</b> watch</span>
              </div>
            </div>
            <div
              className="matrix decisionMatrix compactMatrix"
              aria-label="Relative project decision matrix. Higher risk is up. More momentum is right."
            >
              <div className="matrixQuadrant zoneNarrow">
                <strong>Narrow / stop</strong>
                <span>Reduce scope before adding work</span>
              </div>
              <div className="matrixQuadrant zoneAudit">
                <strong>Audit gate</strong>
                <span>Check blockers before pushing</span>
              </div>
              <div className="matrixQuadrant zoneWatch">
                <strong>Watch evidence</strong>
                <span>Keep proof fresh</span>
              </div>
              <div className="matrixQuadrant zoneShip">
                <strong>Push</strong>
                <span>Execute low-pressure work</span>
              </div>
              {matrixItems.map((item) => (
                <a
                  key={item.project.id}
                  className={cn(
                    "matrixNode",
                    `matrixNode-${item.decision}`,
                    `is-${item.status}`,
                    item.health.openHardGates && "hasGate"
                  )}
                  style={{ left: `${item.x}%`, bottom: `${item.y}%` }}
                  href={hashForRoute({ view: "project", selectedProjectId: item.project.id })}
                  title={`${item.project.name}: ${matrixDecisionLabel(item.decision)}, risk ${item.health.riskScore}, momentum ${item.health.momentumScore}, evidence ${formatFreshness(item.health.evidenceFreshnessDays)}`}
                  aria-label={`${item.project.name}, ${matrixDecisionLabel(item.decision)}, momentum ${item.health.momentumScore}, risk ${item.health.riskScore}, status ${projectLifecycleLabel(item.project)}`}
                >
                  <span className="matrixNodeIndex">#{item.index + 1}</span>
                  <span className="matrixNodeText">
                    <span className="matrixNodeName">{compactProjectLabel(item.project.name)}</span>
                    <span className="matrixNodeMeta">R{item.health.riskScore} · M{item.health.momentumScore}</span>
                  </span>
                  <span className="matrixNodeFlag">{matrixDecisionLabel(item.decision)}</span>
                </a>
              ))}
              <span className="axis x">Momentum</span>
              <span className="axis y">Risk</span>
            </div>
            <div className="matrixLegend">
              <span><i className="legendLine legendRelative" /> Relative position inside this portfolio</span>
              <span><i className="legendDot active" /> Active</span>
              <span><i className="legendDot paused" /> Paused</span>
              <span><i className="legendGate" /> Hard gate</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> Audit Signals</CardTitle>
            <Badge variant={openHardGates ? "destructive" : "success"} className="iconBadge"><ShieldAlert />{openHardGates}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SignalList gates={gates.filter((gate) => planningProjectIds.has(gate.projectId)).slice(0, 7)} compact />
        </CardContent>
      </Card>
    </section>
  );
}

function CreateProjectSheet({ onCreate }: { onCreate: (values: ProjectCreateValues) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectCreateValues>({
    title: ""
  });
  const update = (patch: Partial<ProjectCreateValues>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    onCreate(draft);
    setOpen(false);
    setDraft({ title: "" });
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus />
          New Project
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[94vw] overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>New project</SheetTitle>
          <SheetDescription>Capture the work first. Advanced strategy and scheduling can be filled in later.</SheetDescription>
        </SheetHeader>
        <form className="quickProjectForm" onSubmit={submit}>
          <FormTextarea label="Title / problem" value={draft.title} onChange={(value) => update({ title: value })} placeholder="What needs to be made visible and actionable?" />
          <div className="quickProjectDefaults" aria-label="Project defaults">
            <Badge variant="success" className="iconBadge" title="Lifecycle status"><CheckCircle2 />active</Badge>
            <Badge variant="secondary" className="iconBadge" title="Mode"><Workflow />build</Badge>
            <Badge variant="outline" className="iconBadge" title="Start date"><CalendarClock />today</Badge>
          </div>
          <Button type="submit" disabled={!draft.title.trim()}><Plus />Create project</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ProjectWorkspace({
  project,
  target,
  workItems,
  allWorkItems,
  projects,
  recurringOccurrences,
  changeSets,
  timeZone,
  currentTime,
  baseline,
  baselineChangeSet,
  baselineApproved,
  dependencies,
  schedule,
  gates,
  health,
  evidence,
  onProjectChange,
  onProjectStatusUpdate,
  onProjectDetailsUpdate,
  onDirectionCardUpdate,
  onShapeUpPitchUpdate,
  onShapeUpBetApprove,
  onShapeUpConvert,
  onWorkItemCreate,
  onWorkItemScheduleUpdate,
  onWorkItemMove,
  onWorkItemRepeatRuleUpdate,
  onAutomaticRuleStop,
  onDependencyCreate,
  onEvidenceCreate,
  onActualRecord,
  onProjectWorkFinish,
  onProjectComplete,
  onProjectArchive,
  onProjectRestore,
  onProjectDelete,
  onBaselineCapture,
  onChangeSetStatus,
  onGateClear,
  onDependencyUpdate,
  onDependencyRemove
}: {
  project: Project;
  target?: string;
  workItems: WorkItem[];
  allWorkItems: WorkItem[];
  projects: Project[];
  recurringOccurrences: RecurringOccurrenceRecord[];
  changeSets: ChangeSet[];
  timeZone: string;
  currentTime: string;
  baseline?: Baseline;
  baselineChangeSet?: ChangeSet;
  baselineApproved: boolean;
  dependencies: Dependency[];
  schedule: ScheduleResult;
  gates: AuditGate[];
  health?: ReturnType<typeof calculateProjectHealth>;
  evidence: Evidence[];
  onProjectChange: (projectId: string) => void;
  onProjectStatusUpdate: (projectId: string, status: ProjectStatus) => void;
  onProjectDetailsUpdate: (projectId: string, patch: ProjectDetailsPatch) => void;
  onDirectionCardUpdate: (projectId: string, directionCard: DirectionCard) => void;
  onShapeUpPitchUpdate: (projectId: string, pitch: ShapeUpPitch) => void;
  onShapeUpBetApprove: (projectId: string) => void;
  onShapeUpConvert: (projectId: string) => void;
  onWorkItemCreate: (projectId: string, values: WorkItemCreateValues) => void;
  onWorkItemScheduleUpdate: (projectId: string, workItemId: string, values: WorkItemStartConstraintValues) => void;
  onWorkItemMove: (sourceProjectId: string, workItemId: string, values: WorkItemMoveValues) => void;
  onWorkItemRepeatRuleUpdate: (projectId: string, workItemId: string, repeatRule?: RepeatRule, description?: string) => void;
  onAutomaticRuleStop: (workItemId: string) => void;
  onDependencyCreate: (projectId: string, values: DependencyCreateValues) => void;
  onEvidenceCreate: (projectId: string, values: EvidenceCreateValues) => void;
  onActualRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
  onProjectWorkFinish: (projectId: string) => void;
  onProjectComplete: (projectId: string) => void;
  onProjectArchive: (projectId: string) => void;
  onProjectRestore: (projectId: string) => void;
  onProjectDelete: (projectId: string) => void;
  onBaselineCapture: () => void;
  onChangeSetStatus: (changeSetId: string, status: ChangeSet["status"]) => void;
  onGateClear: (gate: AuditGate, rationale: string) => void;
  onDependencyUpdate: (dependencyId: string, patch: DependencyPatch) => void;
  onDependencyRemove: (dependencyId: string) => void;
}) {
  const recurringSelectionId = recurringTargetWorkItemId(target);
  const tabTarget = target === "recurring" || Boolean(recurringSelectionId) ? "recurring" : target === "evidence" || target === "audit" || target === "baselines" || target === "reports" ? target : "plan";
  const next = nextScheduledItem(schedule.items);
  const blockingGate = gates.find((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const latestEvidence = [...evidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const shapeUpLocked = isShapeUpProject(project) && !isShapeUpBet(project);
  const shapeUpGanttEmpty = isShapeUpBet(project) && schedule.items.length === 0;
  const scheduledWorkItemIds = new Set(schedule.items.map((item) => item.workItem.id));
  const generatedShapeUpScopeTitles = new Set(project.shapeUpPitch?.scopes.map((scope) => `Scope: ${scope.title}`) ?? []);
  const projectArchived = isProjectArchived(project);
  const projectSelectorProjects = projects.filter((candidate) => !isProjectArchived(candidate) || candidate.id === project.id);
  const parkedWorkItems = isShapeUpProject(project) ? workItems
    .filter((item) => (
      !scheduledWorkItemIds.has(item.id) &&
      !isAutomaticRecurringWorkItem(item) &&
      !item.isShapeUpCycleMarker &&
      !(item.kind === "phase" && item.shapeUpScopeId && generatedShapeUpScopeTitles.has(item.title)) &&
      item.percentComplete < 100
    ))
    .sort((left, right) => left.outline.localeCompare(right.outline, undefined, { numeric: true })) : [];
  const canDeleteProject = workItems.length === 0 && !recurringOccurrences.some((occurrence) => occurrence.projectId === project.id);
  const [dailyDraft, setDailyDraft] = useState({
    northStar: project.northStar,
    currentOutcome: project.currentOutcome
  });
  useEffect(() => {
    setDailyDraft({
      northStar: project.northStar,
      currentOutcome: project.currentOutcome
    });
  }, [project.id, project.northStar, project.currentOutcome]);
  const dailyDirty = dailyDraft.northStar !== project.northStar || dailyDraft.currentOutcome !== project.currentOutcome;

  return (
    <section className="grid gap-3">
      <Card>
        <CardContent className="projectDailySurface">
          <div className="projectDailyControls">
            <div className="projectPickerGrid">
              <NativeSelectField
                label="Project"
                value={project.id}
                onChange={onProjectChange}
                options={projectSelectorProjects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
                testId="project-selector"
              />
              <NativeSelectField
                label="Status"
                value={projectLifecycleStatus(project)}
                onChange={(value) => onProjectStatusUpdate(project.id, value as ProjectStatus)}
                options={projectStatuses.map((status) => ({ value: status, label: status }))}
                testId="project-status-selector"
                disabled={projectArchived}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="iconBadge" title="Project mode"><Workflow />{project.mode}</Badge>
              {projectArchived && <Badge variant="outline" className="iconBadge" title="Archived project is read-only"><Lock />read only</Badge>}
              <Badge variant="outline" className="iconBadge" title="Horizon"><CalendarClock />{project.horizon.slice(5, 10)}</Badge>
              <Badge variant={blockingGate ? "destructive" : "success"} className="iconBadge" title={blockingGate?.reason ?? "No blocker"}>{blockingGate ? <Lock /> : <CheckCircle2 />}{blockingGate ? "gate" : "clear"}</Badge>
            </div>
            <div className="projectDailyActions">
              {projectArchived && (
                <Button type="button" variant="outline" size="icon" onClick={() => onProjectRestore(project.id)} aria-label={`Restore project ${project.name}`} title="Restore project">
                  <ArchiveRestore />
                </Button>
              )}
              {!projectArchived && (
                <ProjectAdvancedSheet
                  project={project}
                  onProjectDetailsUpdate={onProjectDetailsUpdate}
                  onDirectionCardUpdate={onDirectionCardUpdate}
                  onShapeUpPitchUpdate={onShapeUpPitchUpdate}
                  onShapeUpBetApprove={onShapeUpBetApprove}
                  onShapeUpConvert={onShapeUpConvert}
                />
              )}
              {canDeleteProject && !projectArchived && (
                <Button type="button" variant="destructive" size="icon" onClick={() => onProjectDelete(project.id)} aria-label="Delete empty project" title="Delete empty project" data-testid="project-delete-empty">
                  <Trash2 />
                </Button>
              )}
            </div>
          </div>

          <form
            className="projectOutcomeForm"
            onSubmit={(event) => {
              event.preventDefault();
              if (projectArchived) return;
              onProjectDetailsUpdate(project.id, dailyDraft);
            }}
          >
            <label>
              <span><Target size={13} />Outcome</span>
              <Input
                name={`project-outcome-${project.id}`}
                value={dailyDraft.currentOutcome}
                onChange={(event) => setDailyDraft((current) => ({ ...current, currentOutcome: event.target.value }))}
                placeholder="Current visible result"
                autoComplete="off"
                disabled={projectArchived}
              />
            </label>
            <label>
              <span><FileText size={13} />North star</span>
              <Input
                name={`project-northstar-${project.id}`}
                value={dailyDraft.northStar}
                onChange={(event) => setDailyDraft((current) => ({ ...current, northStar: event.target.value }))}
                placeholder="Why this project matters"
                autoComplete="off"
                disabled={projectArchived}
              />
            </label>
            <Button type="submit" size="icon" disabled={projectArchived || !dailyDirty} title={projectArchived ? "Restore this project before editing." : "Save project summary"} aria-label="Save project summary">
              <Save />
            </Button>
          </form>

          <div className="projectSignalTiles">
            <SummaryTile label={next ? `${scheduleTiming(next)} action` : "Next action"} value={next?.workItem.title ?? "No open scheduled work"} detail={next ? `${formatScheduleRange(next)} / ${next.isCritical ? "critical path" : "non-critical"}` : "Review baselines before adding more work."} />
            <SummaryTile label="Audit state" value={blockingGate ? "Blocked by hard gate" : "No hard blocker"} detail={blockingGate?.reason ?? "Warnings still need review before milestone closure."} tone={blockingGate ? "danger" : "default"} />
            <SummaryTile label="Evidence" value={formatFreshness(health?.evidenceFreshnessDays)} detail={latestEvidence?.summary ?? "Attach evidence before marking the next milestone complete."} />
          </div>
        </CardContent>
      </Card>

      <Tabs key={`${project.id}-${tabTarget}`} defaultValue={tabTarget} className="w-full">
        <TabsList className="projectTabs grid h-auto min-h-9 w-full grid-cols-3 gap-1 sm:grid-cols-6 lg:w-auto">
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="recurring">Recurring</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="baselines">Baselines</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="plan" className="grid gap-4 xl:grid-cols-[minmax(320px,0.78fr)_minmax(0,1.22fr)]">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> Outline</CardTitle>
                <div className="cardHeaderBadges">
                  <Badge variant="outline" className="iconBadge" title="Scheduled work items"><Layers3 />{schedule.items.length}</Badge>
                  <Badge variant={gates.length ? "warning" : "success"} className="iconBadge" title="Open gates"><Lock />{gates.length}</Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <WorkItemComposer
                projectId={project.id}
                items={schedule.items.map((item) => item.workItem)}
                onCreate={onWorkItemCreate}
              />
              {schedule.items.length > 0 && (
                <OutlineTable
                  projectId={project.id}
                  items={schedule.items}
                  gates={gates}
                  evidence={evidence}
                  projects={projects}
                  allWorkItems={allWorkItems}
                  timeZone={timeZone}
                  currentTime={currentTime}
                  onScheduleItem={(workItemId, values) => onWorkItemScheduleUpdate(project.id, workItemId, values)}
                  onMoveItem={(workItemId, values) => onWorkItemMove(project.id, workItemId, values)}
                  onFinishItem={(item) => {
                    const plannedHours = Math.max(1, formatAssignmentHours(item) || Math.round(item.workItem.durationSeconds / 3600));
                    onActualRecord(project.id, item.workItem.id, {
                      percentComplete: 100,
                      actualWorkHours: plannedHours,
                      remainingWorkHours: 0,
                      actualCost: plannedHours,
                      markFinished: true
                    });
                  }}
                />
              )}
              <ParkedWorkSection
                projectId={project.id}
                items={parkedWorkItems}
                projects={projects}
                allWorkItems={allWorkItems}
                timeZone={timeZone}
                currentTime={currentTime}
                onScheduleItem={(workItemId, values) => onWorkItemScheduleUpdate(project.id, workItemId, values)}
                onMoveItem={(workItemId, values) => onWorkItemMove(project.id, workItemId, values)}
                onFinishItem={(item) => {
                  const plannedWorkSeconds = item.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0) || item.durationSeconds;
                  const plannedHours = Math.max(1, Math.round(plannedWorkSeconds / 3600));
                  onActualRecord(project.id, item.id, {
                    percentComplete: 100,
                    actualWorkHours: plannedHours,
                    remainingWorkHours: 0,
                    actualCost: plannedHours,
                    markFinished: true
                  });
                }}
              />
            </CardContent>
          </Card>
          <div className="grid gap-4">
            <Card id="project-gantt">
              <CardHeader className="flex-row items-start justify-between gap-3 pb-2 compactCardHeader">
                <div>
                  <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Gantt</CardTitle>
                  <div className="compactBadgeRow">
                    <Badge variant="outline" className="iconBadge" title="Dependencies"><Network />{dependencies.length}</Badge>
                    <Badge variant={baseline ? baselineApproved ? "success" : "warning" : "outline"} className="iconBadge" title={baseline ? `Baseline: ${baselineApproved ? "approved" : "pending"}` : "No baseline"}>{baseline ? <CheckCircle2 /> : <Archive />}{baseline ? baselineApproved ? "B" : "!" : "-"}</Badge>
                    <Badge variant="outline" className="iconBadge" title="Critical path"><AlertTriangle />{schedule.items.filter((item) => item.isCritical).length}</Badge>
                  </div>
                </div>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon" title="Network graph" aria-label="Network graph"><Network /></Button>
                  </SheetTrigger>
                  <SheetContent className="w-[92vw] sm:max-w-3xl">
                    <SheetHeader>
                      <SheetTitle>Network Graph</SheetTitle>
                      <SheetDescription>{project.name}</SheetDescription>
                    </SheetHeader>
                    <div className="mt-4">
                      <NetworkGraph items={schedule.items} dependencies={dependencies} />
                    </div>
                  </SheetContent>
                </Sheet>
              </CardHeader>
              <CardContent className="border-b pb-4">
                <DependencyComposer
                  projectId={project.id}
                  items={schedule.items.map((item) => item.workItem)}
                  dependencies={dependencies}
                  onCreate={onDependencyCreate}
                />
              </CardContent>
              <CardContent className="p-0">
                {shapeUpLocked ? (
                  <div className="grid gap-2 p-6 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2 font-medium text-foreground"><Lock size={16} /> Gantt locked until Betting Gate approval</div>
                    <p>Shape Up projects stay out of Today and Gantt until a human approves the bet.</p>
                  </div>
                ) : shapeUpGanttEmpty ? (
                  <div className="grid gap-2 p-6 text-sm text-muted-foreground">
                    <div className="flex items-center gap-2 font-medium text-foreground"><AlertTriangle size={16} /> No downhill scope is ready</div>
                    <p>Move at least one confirmed scope past the hill crest before adding discovered tasks to the execution network.</p>
                  </div>
                ) : (
                  <GanttChart
                    items={schedule.items}
                    dependencies={dependencies}
                    baseline={baseline}
                    onDependencyUpdate={onDependencyUpdate}
                    onDependencyRemove={onDependencyRemove}
                  />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="compactCardHeader">
                <CardTitle className="flex items-center gap-2"><PanelRight className="h-4 w-4" /> Inspector</CardTitle>
              </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-3">
                <SummaryTile label="CP" value={String(schedule.items.filter((item) => item.isCritical).length)} detail="" />
                <SummaryTile label="Diag" value={String(schedule.diagnostics.length)} detail="" />
                <SummaryTile label="Gates" value={String(gates.length)} detail="" tone={gates.length ? "danger" : "default"} />
                <TaskProgressPanel projectId={project.id} items={schedule.items.map((item) => item.workItem)} onRecord={onActualRecord} />
            </CardContent>
          </Card>
          <ProjectCompletionPanel
            project={project}
            items={workItems}
            gates={gates}
            evidence={evidence}
            onFinishWork={() => onProjectWorkFinish(project.id)}
            onComplete={() => onProjectComplete(project.id)}
            onArchive={() => onProjectArchive(project.id)}
          />
        </div>
          </fieldset>
      </TabsContent>
        <TabsContent id="recurring" value="recurring">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle className="flex items-center gap-2"><RefreshCw className="h-4 w-4" /> Recurring rules</CardTitle>
                <Badge variant="outline" className="iconBadge" title="Configured recurring rules"><RefreshCw />{workItems.filter((item) => item.repeatRule).length} configured</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <RecurringTasksPanel
                project={project}
                items={workItems}
                recurringOccurrences={recurringOccurrences}
                changeSets={changeSets}
                initialSelectedId={recurringSelectionId}
                timeZone={timeZone}
                currentTime={currentTime}
                onRepeatRuleUpdate={(workItemId, repeatRule, description) => onWorkItemRepeatRuleUpdate(project.id, workItemId, repeatRule, description)}
                onAutomaticRuleStop={onAutomaticRuleStop}
              />
            </CardContent>
          </Card>
          </fieldset>
        </TabsContent>
        <TabsContent value="evidence">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" /> Evidence</CardTitle>
                <Badge variant="outline" className="iconBadge" title="Linked evidence"><FileText />{evidence.length}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <EvidenceComposer projectId={project.id} items={workItems.filter((item) => !isAutomaticRecurringWorkItem(item))} onCreate={onEvidenceCreate} />
              <EvidenceList evidence={evidence} />
            </CardContent>
          </Card>
          </fieldset>
        </TabsContent>
        <TabsContent value="audit">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Audit Gates</CardTitle>
                <Badge variant={gates.some((gate) => gate.severity === "hard" && gate.status !== "cleared") ? "destructive" : "success"} className="iconBadge" title="Hard gates"><Lock />{gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared").length}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <SignalList gates={gates} onClear={onGateClear} compact />
            </CardContent>
          </Card>
          </fieldset>
        </TabsContent>
        <TabsContent value="baselines">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Baseline</CardTitle>
                  <div className="compactBadgeRow">
                    <Badge variant={baseline ? baselineApproved ? "success" : "warning" : "outline"} className="iconBadge" title={baseline?.name ?? "No baseline"}>{baseline ? <CheckCircle2 /> : <Archive />}{baseline ? baselineApproved ? "approved" : "pending" : "none"}</Badge>
                    {baseline && <Badge variant="outline" className="iconBadge" title="Captured"><CalendarClock />{baseline.capturedAt.slice(5, 10)}</Badge>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {baseline && <Badge variant={baselineApproved ? "success" : "warning"}>{baselineApproved ? "approved" : "pending"}</Badge>}
                  <Button type="button" variant="outline" onClick={onBaselineCapture}>Capture baseline</Button>
                  {baseline && !baselineApproved && baselineChangeSet && (
                    <Button type="button" onClick={() => onChangeSetStatus(baselineChangeSet.id, "approved")}>
                      <CheckCircle2 />
                      Approve baseline
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <BaselineTable baseline={baseline} items={schedule.items} />
            </CardContent>
          </Card>
          </fieldset>
        </TabsContent>
        <TabsContent value="reports">
          <fieldset disabled={projectArchived} aria-disabled={projectArchived || undefined} className="contents">
          <Card>
            <CardHeader className="compactCardHeader">
              <div className="cardHeaderLine">
                <CardTitle>Project Report Snapshot</CardTitle>
                <Badge variant="outline" className="iconBadge" title="Project report"><FileDown />local</Badge>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <SummaryTile label="Finish p50" value={runMonteCarlo(project, schedule.items.map((item) => item.workItem), dependencies, 120, 3).p50Finish.slice(0, 10)} detail="Seeded local simulation" />
              <SummaryTile label="Baseline" value={baseline ? baseline.name : "Missing"} detail={baseline ? `${baselineApproved ? "approved" : "pending"} / ${baseline.capturedAt.slice(0, 10)}` : "EVM blocked"} tone={baseline && !baselineApproved ? "warning" : "default"} />
              <SummaryTile label="Evidence freshness" value={formatFreshness(health?.evidenceFreshnessDays)} detail="Latest linked evidence" />
            </CardContent>
          </Card>
          </fieldset>
        </TabsContent>
      </Tabs>
    </section>
  );
}

function ProjectAdvancedSheet({
  project,
  onProjectDetailsUpdate,
  onDirectionCardUpdate,
  onShapeUpPitchUpdate,
  onShapeUpBetApprove,
  onShapeUpConvert
}: {
  project: Project;
  onProjectDetailsUpdate: (projectId: string, patch: ProjectDetailsPatch) => void;
  onDirectionCardUpdate: (projectId: string, directionCard: DirectionCard) => void;
  onShapeUpPitchUpdate: (projectId: string, pitch: ShapeUpPitch) => void;
  onShapeUpBetApprove: (projectId: string) => void;
  onShapeUpConvert: (projectId: string) => void;
}) {
  const [detailsDraft, setDetailsDraft] = useState({
    name: project.name,
    mode: project.mode,
    startDate: datePart(project.start),
    horizonDate: datePart(project.horizon),
    reviewCadenceDays: String(project.reviewCadenceDays || 7)
  });
  useEffect(() => {
    setDetailsDraft({
      name: project.name,
      mode: project.mode,
      startDate: datePart(project.start),
      horizonDate: datePart(project.horizon),
      reviewCadenceDays: String(project.reviewCadenceDays || 7)
    });
  }, [project.id, project.name, project.mode, project.start, project.horizon, project.reviewCadenceDays]);
  const detailsDirty =
    detailsDraft.name !== project.name ||
    detailsDraft.mode !== project.mode ||
    detailsDraft.startDate !== datePart(project.start) ||
    detailsDraft.horizonDate !== datePart(project.horizon) ||
    Number(detailsDraft.reviewCadenceDays || 7) !== project.reviewCadenceDays;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="projectAdvancedTrigger" title="Advanced project settings">
          <SettingsIcon />
          Advanced
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[94vw] overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>Advanced project settings</SheetTitle>
          <SheetDescription>{project.name}</SheetDescription>
        </SheetHeader>
        <div className="projectAdvancedBody">
          <form
            className="projectAdvancedForm"
            onSubmit={(event) => {
              event.preventDefault();
              if (!detailsDraft.name.trim()) return;
              onProjectDetailsUpdate(project.id, {
                name: detailsDraft.name,
                mode: detailsDraft.mode,
                startDate: detailsDraft.startDate,
                horizonDate: detailsDraft.horizonDate,
                reviewCadenceDays: Number(detailsDraft.reviewCadenceDays) || 7
              });
            }}
          >
            <section className="advancedSection">
              <div className="advancedSectionHeader">
                <h3><FileText />Identity</h3>
                <Badge variant="secondary" className="iconBadge" title="Project mode"><Workflow />{detailsDraft.mode}</Badge>
              </div>
              <div className="advancedFieldGrid">
                <SettingsInput label="Name" name={`advanced-project-name-${project.id}`} value={detailsDraft.name} onChange={(value) => setDetailsDraft((current) => ({ ...current, name: value }))} placeholder="Project name" autoComplete="off" />
                <NativeSelectField
                  label="Mode"
                  value={detailsDraft.mode}
                  onChange={(value) => setDetailsDraft((current) => ({ ...current, mode: value as ProjectMode }))}
                  options={projectModes.map((mode) => ({ value: mode, label: mode }))}
                />
              </div>
            </section>
            <section className="advancedSection">
              <div className="advancedSectionHeader">
                <h3><CalendarClock />Scheduling</h3>
                <Badge variant="outline" className="iconBadge" title="Review cadence"><RefreshCw />{detailsDraft.reviewCadenceDays || 7}d</Badge>
              </div>
              <div className="advancedFieldGrid">
                <SettingsInput label="Start date" name={`advanced-project-start-${project.id}`} value={detailsDraft.startDate} onChange={(value) => setDetailsDraft((current) => ({ ...current, startDate: value }))} placeholder="2026-07-01" autoComplete="off" />
                <SettingsInput label="Horizon date" name={`advanced-project-horizon-${project.id}`} value={detailsDraft.horizonDate} onChange={(value) => setDetailsDraft((current) => ({ ...current, horizonDate: value }))} placeholder="2026-07-15" autoComplete="off" />
                <SettingsInput label="Review cadence days" name={`advanced-project-review-${project.id}`} value={detailsDraft.reviewCadenceDays} onChange={(value) => setDetailsDraft((current) => ({ ...current, reviewCadenceDays: value }))} placeholder="7" autoComplete="off" />
              </div>
              <div className="advancedSectionActions">
                <Button type="submit" size="sm" disabled={!detailsDirty || !detailsDraft.name.trim()}><Save />Save settings</Button>
              </div>
            </section>
          </form>

          <section className="advancedSection">
            <div className="advancedSectionHeader">
              <h3><Target />Direction</h3>
              <Badge variant={project.directionCard?.successMetric ? "success" : "warning"} className="iconBadge" title="Direction metric"><CheckCircle2 />metric</Badge>
            </div>
            <DirectionCardPanel project={project} onSave={(directionCard) => onDirectionCardUpdate(project.id, directionCard)} />
          </section>

          <section className="advancedSection">
            <div className="advancedSectionHeader">
              <h3><Target />Shape Up</h3>
              <Badge variant={isShapeUpProject(project) ? "secondary" : "outline"} className="iconBadge" title="Shape Up mode"><Workflow />{isShapeUpProject(project) ? "on" : "off"}</Badge>
            </div>
            <ShapeUpProjectPanel
              project={project}
              onSave={(pitch) => onShapeUpPitchUpdate(project.id, pitch)}
              onBet={() => onShapeUpBetApprove(project.id)}
              onConvert={() => onShapeUpConvert(project.id)}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DirectionCardPanel({ project, onSave }: { project: Project; onSave: (directionCard: DirectionCard) => void }) {
  const initial = project.directionCard ?? {
    targetUser: "",
    userProblem: "",
    businessGoal: project.currentOutcome,
    coreHypothesis: "",
    successMetric: "",
    failureCondition: "",
    validationMethod: "",
    timeboxDays: 14,
    opportunityCost: ""
  };
  const [draft, setDraft] = useState<DirectionCard>(initial);
  useEffect(() => setDraft(initial), [project.id]);
  const update = (patch: Partial<DirectionCard>) => setDraft((current) => ({ ...current, ...patch }));
  return (
    <form
      className="directionCompactForm"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <div className="directionToolbar">
        <div className="min-w-0">
          <h3><FileText size={15} />Direction Card</h3>
          <div className="directionBadges">
            <Badge variant="outline" className="iconBadge" title="Target user"><Target />{draft.targetUser || "user"}</Badge>
            <Badge variant="outline" className="iconBadge" title="Timebox"><Timer />{draft.timeboxDays}d</Badge>
            <Badge variant={draft.successMetric ? "success" : "warning"} className="iconBadge" title="Success metric"><CheckCircle2 />metric</Badge>
          </div>
        </div>
        <Button type="submit" size="icon" title="Save direction" aria-label="Save direction"><Save /></Button>
      </div>
      <div className="directionGrid">
        <label className="directionField">
          <span><Target size={13} />User</span>
          <Input name={`target-user-${project.id}`} value={draft.targetUser} onChange={(event) => update({ targetUser: event.target.value })} placeholder="Who" autoComplete="off" aria-label="Target user" />
        </label>
        <label className="directionField">
          <span><Workflow size={13} />Goal</span>
          <Input name={`business-goal-${project.id}`} value={draft.businessGoal} onChange={(event) => update({ businessGoal: event.target.value })} placeholder="Why" autoComplete="off" aria-label="Business goal" />
        </label>
        <label className="directionField">
          <span><Zap size={13} />Hypothesis</span>
          <Input name={`hypothesis-${project.id}`} value={draft.coreHypothesis} onChange={(event) => update({ coreHypothesis: event.target.value })} placeholder="Must be true" autoComplete="off" aria-label="Core hypothesis" />
        </label>
        <label className="directionField">
          <span><CheckCircle2 size={13} />Metric</span>
          <Input name={`success-${project.id}`} value={draft.successMetric} onChange={(event) => update({ successMetric: event.target.value })} placeholder="Continue signal" autoComplete="off" aria-label="Success metric" />
        </label>
        <label className="directionField">
          <span><AlertTriangle size={13} />Failure</span>
          <Input name={`failure-${project.id}`} value={draft.failureCondition} onChange={(event) => update({ failureCondition: event.target.value })} placeholder="Stop signal" autoComplete="off" aria-label="Failure condition" />
        </label>
        <label className="directionField">
          <span><ClipboardCheck size={13} />Validate</span>
          <Input name={`validation-${project.id}`} value={draft.validationMethod} onChange={(event) => update({ validationMethod: event.target.value })} placeholder="How checked" autoComplete="off" aria-label="Validation method" />
        </label>
        <label className="directionField">
          <span><Timer size={13} />Timebox</span>
          <Input type="number" min={1} max={365} value={draft.timeboxDays} onChange={(event) => update({ timeboxDays: Number(event.target.value) || 1 })} aria-label="Timebox days" />
        </label>
        <label className="directionField">
          <span><Archive size={13} />Cost</span>
          <Input name={`opportunity-${project.id}`} value={draft.opportunityCost} onChange={(event) => update({ opportunityCost: event.target.value })} placeholder="Tradeoff" autoComplete="off" aria-label="Opportunity cost" />
        </label>
        <label className="directionField directionFieldWide">
          <span><FileText size={13} />Problem</span>
          <textarea value={draft.userProblem} onChange={(event) => update({ userProblem: event.target.value })} placeholder="User problem" aria-label="User problem" />
        </label>
      </div>
    </form>
  );
}

function ShapeUpProjectPanel({
  project,
  onSave,
  onBet,
  onConvert
}: {
  project: Project;
  onSave: (pitch: ShapeUpPitch) => void;
  onBet: () => void;
  onConvert: () => void;
}) {
  const savedPitch = project.shapeUpPitch;
  const fallbackPitch = savedPitch ?? createShapeUpPitch({
    problem: project.directionCard?.userProblem || project.currentOutcome,
    appetiteKind: "small-batch",
    successBaseline: project.directionCard?.successMetric || "",
    now: timestamp()
  });
  const [draft, setDraft] = useState<ShapeUpPitch>(fallbackPitch);
  const [scopeTitle, setScopeTitle] = useState("");
  const [scopeDescription, setScopeDescription] = useState("");
  useEffect(() => setDraft(fallbackPitch), [project.id, savedPitch?.updatedAt]);
  const draftProject = { ...project, shapeUpPitch: draft };
  const missing = shapeUpMissingBetRequirements(draftProject);
  const savedCanBet = canBetShapeUpProject(project);
  const bet = project.shapeUpPitch?.bet;

  const update = (patch: Partial<ShapeUpPitch>) => setDraft((current) => ({ ...current, ...patch }));
  const updateScope = (scopeId: string, patch: Partial<ShapeUpScope>) => {
    setDraft((current) => ({
      ...current,
      scopes: current.scopes.map((scope) => scope.id === scopeId ? { ...scope, ...patch, hillPosition: Math.max(0, Math.min(100, patch.hillPosition ?? scope.hillPosition)) } : scope)
    }));
  };
  const addScope = () => {
    const title = scopeTitle.trim();
    if (!title) return;
    setDraft((current) => ({
      ...current,
      scopes: [
        ...current.scopes,
        {
          id: uniqueId("scope", title, current.scopes.map((scope) => scope.id)),
          title,
          description: scopeDescription.trim(),
          confirmed: true,
          hillPosition: 20
        }
      ]
    }));
    setScopeTitle("");
    setScopeDescription("");
  };
  const removeScope = (scopeId: string) => {
    setDraft((current) => ({ ...current, scopes: current.scopes.filter((scope) => scope.id !== scopeId) }));
  };

  if (!savedPitch) {
    return (
      <Card id="shape-up">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4" /> Shape Up</CardTitle>
              <CardDescription>This existing project is not using Shape Up yet.</CardDescription>
            </div>
            <Button type="button" variant="outline" onClick={onConvert}>Convert to Shape Up</Button>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card id="shape-up">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4" /> Shape Up Pitch</CardTitle>
            <CardDescription>Fixed appetite, variable scope, human-approved bet before execution.</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={isShapeUpBet(project) ? "success" : projectLifecycleStatus(project) === "paused" ? "warning" : "outline"}>
              {isShapeUpBet(project) ? "bet accepted" : projectLifecycleStatus(project) === "paused" ? "circuit review" : "waiting"}
            </Badge>
            {bet && <Badge variant="outline">Ends {bet.cycleEnd.slice(0, 10)}</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 md:grid-cols-2">
          <NativeSelectField
            label="Appetite"
            value={draft.appetiteKind}
            onChange={(value) => update({ appetiteKind: value as ShapeUpAppetiteKind, appetiteDays: shapeUpAppetiteDays[value as ShapeUpAppetiteKind] })}
            options={[
              { value: "small-batch", label: "Small Batch - 2 weeks" },
              { value: "big-batch", label: "Big Batch - 6 weeks" }
            ]}
          />
          <SettingsRow label="Betting status" value={savedCanBet ? "ready for human approval" : missing.length ? `missing ${missing.length}` : "not ready"} />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <FormTextarea label="Problem" value={draft.problem} onChange={(value) => update({ problem: value })} placeholder="What problem matters enough to spend this appetite?" />
          <FormTextarea label="Solution sketch" value={draft.solutionSketch} onChange={(value) => update({ solutionSketch: value })} placeholder="Breadboard or fat-marker solution, not a detailed spec." />
          <FormTextarea label="Rabbit holes" value={draft.rabbitHoles} onChange={(value) => update({ rabbitHoles: value })} placeholder="Known traps, unknowns, or technical holes to patch before betting." />
          <FormTextarea label="No-gos" value={draft.noGos} onChange={(value) => update({ noGos: value })} placeholder="Explicitly out-of-bounds scope." />
          <FormTextarea label="Success baseline" value={draft.successBaseline} onChange={(value) => update({ successBaseline: value })} placeholder="What evidence makes this bet worth continuing?" />
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">Betting Gate</h3>
                <p className="text-xs text-muted-foreground">AI may suggest; human approval is required.</p>
              </div>
              <Badge variant={isShapeUpPitchComplete(draft) ? "success" : "warning"}>{isShapeUpPitchComplete(draft) ? "complete" : "incomplete"}</Badge>
            </div>
            {missing.length ? (
              <div className="flex flex-wrap gap-2">
                {missing.map((item) => <Badge key={item} variant="outline">{item}</Badge>)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Pitch is complete. Save it, then approve the bet when you are ready to commit fixed time.</p>
            )}
          </div>
        </div>

        <div className="grid gap-3 rounded-lg border bg-background p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Scopes / Hill Chart</h3>
              <p className="text-xs text-muted-foreground">Confirmed scopes become hill-chart scopes after bet. Downhill scopes can enter Gantt.</p>
            </div>
            <Badge variant="outline">{draft.scopes.filter((scope) => scope.confirmed).length} confirmed</Badge>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
            <SettingsInput label="Scope title" name={`shape-scope-title-${project.id}`} value={scopeTitle} onChange={setScopeTitle} placeholder="Authentication slice / Invitation flow / Day 1 itinerary" autoComplete="off" />
            <SettingsInput label="Scope description" name={`shape-scope-desc-${project.id}`} value={scopeDescription} onChange={setScopeDescription} placeholder="What belongs inside this scope?" autoComplete="off" />
            <Button type="button" className="self-end" variant="outline" onClick={addScope} disabled={!scopeTitle.trim()}><Plus />Add scope</Button>
          </div>
          <div className="grid gap-2">
            {draft.scopes.length ? draft.scopes.map((scope) => (
              <article key={scope.id} className="grid gap-3 rounded-lg border bg-muted/20 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm">{scope.title}</strong>
                      <Badge variant={shapeUpScopeStatus(scope) === "downhill" || shapeUpScopeStatus(scope) === "done" ? "success" : shapeUpScopeStatus(scope) === "crest" ? "warning" : "secondary"}>{shapeUpScopeStatus(scope)}</Badge>
                      {!scope.confirmed && <Badge variant="outline">candidate</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{scope.description || "No description."}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="inline-flex h-8 items-center gap-2 rounded-md border px-2 text-xs font-medium">
                      <input type="checkbox" checked={scope.confirmed} onChange={(event) => updateScope(scope.id, { confirmed: event.target.checked })} />
                      Confirm
                    </label>
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeScope(scope.id)}>Remove</Button>
                  </div>
                </div>
                <div className="grid gap-2 md:grid-cols-[1fr_72px]">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={scope.hillPosition}
                    onChange={(event) => updateScope(scope.id, { hillPosition: Number(event.target.value) })}
                    aria-label={`${scope.title} hill position`}
                  />
                  <Input type="number" min={0} max={100} value={scope.hillPosition} onChange={(event) => updateScope(scope.id, { hillPosition: Number(event.target.value) || 0 })} />
                </div>
              </article>
            )) : (
              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Add at least one confirmed scope before betting.</div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onSave(draft)}>Save Shape Up pitch</Button>
          <Button type="button" variant="outline" onClick={onBet} disabled={!savedCanBet || Boolean(bet)}>Approve Betting Gate</Button>
          {bet && <Badge variant="success">Approved {bet.approvedAt.slice(0, 10)}</Badge>}
          {projectLifecycleStatus(project) === "paused" && <Badge variant="warning">Circuit breaker review required</Badge>}
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectCompletionPanel({
  project,
  items,
  gates,
  evidence,
  onFinishWork,
  onComplete,
  onArchive
}: {
  project: Project;
  items: WorkItem[];
  gates: AuditGate[];
  evidence: Evidence[];
  onFinishWork: () => void;
  onComplete: () => void;
  onArchive: () => void;
}) {
  const completableItems = items.filter((item) => item.kind !== "phase" && !isAutomaticRecurringWorkItem(item));
  const incompleteItems = completableItems.filter((item) => item.percentComplete < 100);
  const openHardGates = gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const keyItemsMissingEvidence = completableItems.filter((item) => (
    (item.evidenceRequired || item.isKeyTask) &&
    !evidence.some((candidate) => candidate.workItemId === item.id)
  ));
  const readyToComplete = incompleteItems.length === 0 && openHardGates.length === 0 && keyItemsMissingEvidence.length === 0;
  const completionBlockers = [
    incompleteItems.length ? `${incompleteItems.length} open / first: ${incompleteItems[0]?.title}` : undefined,
    keyItemsMissingEvidence.length ? `${keyItemsMissingEvidence.length} evidence / first: ${keyItemsMissingEvidence[0]?.title}` : undefined,
    openHardGates.length ? `${openHardGates.length} gates / first: ${openHardGates[0]?.reason}` : undefined
  ].filter(Boolean);
  const archived = isProjectArchived(project);
  const lifecycleStatus = projectLifecycleStatus(project);
  const setDoneDisabled = !readyToComplete || lifecycleStatus === "done";
  const doneDisabledReason = lifecycleStatus === "done"
    ? "Project is already done."
    : completionBlockers.join(" ");
  const badgeLabel = archived ? projectLifecycleLabel(project) : lifecycleStatus === "done" ? "done" : readyToComplete ? "ready for done" : "not ready";
  const badgeVariant = archived || lifecycleStatus === "done" || readyToComplete ? "success" : "warning";

  return (
    <Card id="project-completion">
      <CardHeader className="compactCardHeader">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Completion Gate</CardTitle>
          </div>
          <Badge variant={badgeVariant}>{badgeLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2 md:grid-cols-3">
          <SummaryTile label="Open" value={String(incompleteItems.length)} detail={incompleteItems[0]?.title ?? ""} tone={incompleteItems.length ? "warning" : "default"} />
          <SummaryTile label="Evidence" value={String(keyItemsMissingEvidence.length)} detail={keyItemsMissingEvidence[0]?.title ?? ""} tone={keyItemsMissingEvidence.length ? "danger" : "default"} />
          <SummaryTile label="Gates" value={String(openHardGates.length)} detail={openHardGates[0]?.reason ?? ""} tone={openHardGates.length ? "danger" : "default"} />
        </div>
        {completionBlockers.length > 0 && (
          <div className="completionBlockers">
            <Badge variant="warning" className="iconBadge"><Lock />Blocked</Badge>
            <ul>
              {completionBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onFinishWork} disabled={!incompleteItems.length} title={incompleteItems.length ? `Mark ${incompleteItems.length} open work item${incompleteItems.length === 1 ? "" : "s"} complete.` : "No open work remains."} data-testid="lifecycle-finish-open-work">
            <CheckCircle2 />
            Finish open
          </Button>
          <Button type="button" onClick={onComplete} disabled={setDoneDisabled} title={setDoneDisabled ? doneDisabledReason : "Mark this project as verified done."} data-testid="lifecycle-set-done">
            Done
          </Button>
          <Button type="button" variant="outline" onClick={onArchive} disabled={archived} title={archived ? "Project is already archived." : "Close this project and remove it from active planning."} data-testid="lifecycle-archive-project">
            <Archive />
            Archive
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RecurringTasksPanel({
  project,
  items,
  recurringOccurrences,
  changeSets,
  initialSelectedId,
  timeZone,
  currentTime,
  onRepeatRuleUpdate,
  onAutomaticRuleStop
}: {
  project: Project;
  items: WorkItem[];
  recurringOccurrences: RecurringOccurrenceRecord[];
  changeSets: ChangeSet[];
  initialSelectedId?: string;
  timeZone: string;
  currentTime: string;
  onRepeatRuleUpdate: (workItemId: string, repeatRule: RepeatRule | undefined, description: string) => void;
  onAutomaticRuleStop: (workItemId: string) => void;
}) {
  const eligibleItems = items.filter((item) => item.kind !== "phase");
  const recurringItems = eligibleItems.filter((item) => item.repeatRule);
  const eligibleItemIds = eligibleItems.map((item) => item.id).join("|");
  const recurringItemIds = recurringItems.map((item) => item.id).join("|");
  const [selectedId, setSelectedId] = useState(() => initialSelectedId && eligibleItems.some((item) => item.id === initialSelectedId)
    ? initialSelectedId
    : recurringItems[0]?.id ?? eligibleItems[0]?.id ?? "");
  const selected = eligibleItems.find((item) => item.id === selectedId) ?? eligibleItems[0];
  const [draft, setDraft] = useState<RepeatRuleDraft>(() => draftFromRepeatRule(selected, project.start, timeZone));
  const [baselineDraft, setBaselineDraft] = useState<RepeatRuleDraft>(() => draftFromRepeatRule(selected, project.start, timeZone));
  const [draftError, setDraftError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [pendingDestructiveAction, setPendingDestructiveAction] = useState<"remove" | "stop" | null>(null);
  const [historyPage, setHistoryPage] = useState(0);
  const draftDirty = !repeatRuleDraftsEqual(draft, baselineDraft);

  useEffect(() => {
    if (!eligibleItems.length) {
      setSelectedId("");
      return;
    }
    if (initialSelectedId && eligibleItems.some((item) => item.id === initialSelectedId)) {
      setSelectedId(initialSelectedId);
      return;
    }
    setSelectedId((current) => eligibleItems.some((item) => item.id === current) ? current : recurringItems[0]?.id ?? eligibleItems[0].id);
  }, [project.id, eligibleItemIds, recurringItemIds, initialSelectedId]);

  useEffect(() => {
    const nextDraft = draftFromRepeatRule(selected, project.start, timeZone);
    setDraft(nextDraft);
    setBaselineDraft(nextDraft);
    setDraftError("");
    setPendingDestructiveAction(null);
    setHistoryPage(0);
  }, [project.id, selected?.id, timeZone]);

  const update = (patch: Partial<RepeatRuleDraft>) => {
    setDraftError("");
    setSaveNotice("");
    setPendingDestructiveAction(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const requestSelection = (workItemId: string) => {
    if (workItemId === selectedId) return;
    if (draftDirty) {
      setDraftError("Save or reset your changes before selecting another work item.");
      return;
    }
    setDraftError("");
    setSaveNotice("");
    setPendingDestructiveAction(null);
    setSelectedId(workItemId);
  };
  const previewRule = repeatRuleFromDraft(draft, selected, timeZone, currentTime);
  const previewItem = selected && previewRule ? { ...selected, description: draft.description.trim() || undefined, repeatRule: previewRule } : undefined;
  const preview = previewItem ? projectRecurringOccurrences(previewItem, project.start, {
    timeZone,
    now: currentTime,
    windowStart: repeatExecutionMode(previewItem.repeatRule) === "automatic" ? currentTime : undefined,
    limit: 8,
    records: recurringOccurrences
  }) : [];
  const occurrenceHistory = selected ? selectAutomaticOccurrenceHistory({
    timeZone,
    projects: [project],
    workItems: items,
    recurringOccurrences,
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
  }, selected.id) : [];
  const historyEntries = [
    ...occurrenceHistory.map((record) => ({ kind: "occurrence" as const, at: record.updatedAt, record })),
    ...changeSets
      .filter((changeSet) => selected && changeSet.diffs.some((diff) => diff.entity === "WorkItem" && diff.entityId === selected.id && diff.field.startsWith("repeatRule")))
      .map((changeSet) => ({ kind: "rule" as const, at: changeSet.createdAt, changeSet }))
  ].sort((left, right) => right.at.localeCompare(left.at));
  const historyPageSize = 8;
  const historyPageCount = Math.max(1, Math.ceil(historyEntries.length / historyPageSize));
  const safeHistoryPage = Math.min(historyPage, historyPageCount - 1);
  const visibleHistory = historyEntries.slice(safeHistoryPage * historyPageSize, (safeHistoryPage + 1) * historyPageSize);
  const selectedAutomatic = repeatExecutionMode(selected?.repeatRule) === "automatic";
  const selectedStopped = Boolean(selected?.repeatRule?.stoppedAt);
  const ruleMode: "off" | RepeatExecutionMode = draft.enabled ? draft.executionMode : "off";
  const ruleModeOptions: Array<{ value: "off" | RepeatExecutionMode; label: string }> = selected?.repeatRule
    ? [
        { value: "manual", label: "Manual" },
        { value: "automatic", label: "Automatic" }
      ]
    : [
        { value: "off", label: "Choose a mode…" },
        { value: "manual", label: "Manual" },
        { value: "automatic", label: "Automatic" }
      ];
  const startDateTimeValid = !draft.enabled || isValidZonedDraftDateTime(draft.startDate, draft.startTime, timeZone);
  const endDateValid = !draft.enabled || draft.endMode !== "until" || isValidZonedDraftDateTime(draft.endDate, "23:59", timeZone);
  const draftValid = startDateTimeValid && endDateValid && Boolean(previewRule);
  const canSave = Boolean(selected && !selectedStopped && draft.enabled && draftDirty && draftValid);
  const saveHelp = selectedStopped
    ? "Stopped rules are read-only; their history remains available below."
    : !draft.enabled
    ? "Choose Manual or Automatic to configure a recurring rule."
    : !draftDirty
      ? "No unsaved changes."
      : !draftValid
        ? "Enter a valid start date, start time, and optional end date."
        : selected?.repeatRule ? "Ready to save your changes." : "Ready to create this recurring rule.";
  const selectedRuleState = !selected?.repeatRule
    ? "Not configured"
    : selectedStopped
      ? "Stopped"
      : selectedAutomatic ? "Automatic" : "Manual";

  if (!eligibleItems.length) {
    return (
      <div className="emptyState">
        <RefreshCw />
        <span>No work items yet.</span>
      </div>
    );
  }

  return (
    <div className="recurringGrid">
      <aside className="recurringSidebar" aria-labelledby="recurring-work-items-heading">
        <div className="recurringPanelHeader">
          <div className="recurringPanelTitle">
            <h3 id="recurring-work-items-heading">Work items</h3>
            <span>{eligibleItems.length} eligible · {recurringItems.length} configured</span>
          </div>
        </div>
        <ul className="recurringTaskList">
          {eligibleItems.map((item) => {
            const automatic = repeatExecutionMode(item.repeatRule) === "automatic";
            const stopped = Boolean(item.repeatRule?.stoppedAt);
            const itemMeta = !item.repeatRule
              ? `${item.outline} · Not configured`
              : stopped
                ? `${item.outline} · Stopped`
                : automatic
                  ? item.outline
                  : `${item.outline} · Manual`;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={cn("recurringTaskButton", selected?.id === item.id && "active")}
                  aria-current={selected?.id === item.id ? "true" : undefined}
                  data-testid={`recurring-work-item-${item.id}`}
                  onClick={() => requestSelection(item.id)}
                >
                  <span>
                    <strong>{item.title}</strong>
                    <em>{itemMeta}</em>
                  </span>
                  <span className="recurringTaskBadges">
                    {automatic && <RecurrenceModeIcon />}
                    {item.repeatRule ? <Badge variant="secondary">{repeatCadenceLabel(item.repeatRule)}</Badge> : <Badge variant="outline">new</Badge>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <form
        className="recurringEditor"
        aria-labelledby="recurring-rule-heading"
        onSubmit={(event) => {
          event.preventDefault();
          if (!selected) return;
          const repeatRule = repeatRuleFromDraft(draft, selected, timeZone, currentTime);
          if (!draft.enabled || !draftDirty) return;
          if (!repeatRule) {
            setDraftError("Enter a valid start date, start time, and optional end date before saving.");
            return;
          }
          onRepeatRuleUpdate(selected.id, repeatRule, draft.description);
          setBaselineDraft(draft);
          setDraftError("");
          setSaveNotice(selected.repeatRule ? "Recurring rule updated." : "Recurring rule created.");
        }}
      >
        <div className="recurringEditorHeader">
          <div className="recurringPanelTitle">
            <h3 id="recurring-rule-heading">{selected?.title}</h3>
            <span>Edit the recurring behavior for this work item.</span>
          </div>
          {selectedAutomatic && !selectedStopped ? (
            <Badge variant="success" className="iconBadge" title="Automatic recurring rule" aria-label="Automatic recurring rule"><RecurrenceModeIcon /></Badge>
          ) : (
            <Badge variant={selectedStopped ? "outline" : selected?.repeatRule ? "success" : "secondary"}>{selectedRuleState}</Badge>
          )}
        </div>
        <div className="recurringModeRow">
          <NativeSelectField
            label="Rule mode"
            value={ruleMode}
            onChange={(value) => update({
              enabled: value !== "off",
              executionMode: value === "off" ? draft.executionMode : value as RepeatExecutionMode,
              startMode: value === "automatic" ? "fixed-time" : draft.startMode,
              endMode: value === "automatic" && repeatExecutionMode(selected?.repeatRule) !== "automatic" ? "never" : draft.endMode
            })}
            options={ruleModeOptions}
            disabled={selectedStopped}
            testId="recurring-execution-mode"
          />
          <p className="recurringModeHelp">
            {selectedStopped
              ? "This rule is stopped. Its schedule and history remain available for reference."
              : ruleMode === "automatic"
                ? "Automatic rules record expected external events without requiring completion."
                : ruleMode === "manual"
                  ? "Manual rules create cycles that you update yourself."
                  : "Choose how this work item should recur."}
          </p>
        </div>

        <fieldset className="recurringFieldset" disabled={!draft.enabled || selectedStopped}>
          <legend>Schedule</legend>
          <div className="recurringFieldGrid">
            <NativeSelectField
              label="Cadence"
              value={draft.cadence}
              onChange={(value) => update({ cadence: value as RepeatCadenceKind })}
              options={[
                { value: "every-n-days", label: "Every n days" },
                { value: "weekly", label: "Weekly" },
                { value: "monthly", label: "Monthly" }
              ]}
              testId="recurring-cadence"
            />
            {draft.cadence === "every-n-days" && (
              <label className="block">
                <span className="text-sm font-medium">Repeat every</span>
                <div className="recurringNumberField">
                  <Input type="number" min={1} step={1} value={draft.everyDays} aria-label="Repeat interval in days" onChange={(event) => update({ everyDays: Math.max(1, Math.round(Number(event.target.value) || 1)) })} />
                  <span>days</span>
                </div>
              </label>
            )}
            {draft.executionMode === "manual" ? (
              <NativeSelectField
                label="Start mode"
                value={draft.startMode}
                onChange={(value) => update({ startMode: value as RepeatStartMode })}
                options={[
                  { value: "fixed-time", label: "Fixed time" },
                  { value: "after-previous-finish", label: "After previous finish" }
                ]}
                testId="recurring-start-mode"
              />
            ) : (
              <div className="recurringReadOnlyField"><span>Start mode</span><strong>Fixed time</strong></div>
            )}
            <SettingsInput
              label={draft.startMode === "after-previous-finish" ? "First start date" : "Start date"}
              name={`recurring-start-date-${project.id}`}
              value={draft.startDate}
              onChange={(value) => update({ startDate: value })}
              placeholder="2026-07-06"
              autoComplete="off"
              type="date"
              required
              invalid={!startDateTimeValid}
              describedBy={!startDateTimeValid ? "recurring-start-error" : undefined}
              testId="recurring-start-date"
            />
            <SettingsInput
              label="Start time"
              name={`recurring-start-time-${project.id}`}
              value={draft.startTime}
              onChange={(value) => update({ startTime: value })}
              placeholder="09:00"
              autoComplete="off"
              type="time"
              required
              invalid={!startDateTimeValid}
              describedBy={!startDateTimeValid ? "recurring-start-error" : undefined}
              testId="recurring-start-time"
            />
          </div>
          {!startDateTimeValid && <p id="recurring-start-error" className="recurringFieldError">Enter a valid start date and time.</p>}
        </fieldset>

        <fieldset className="recurringFieldset" disabled={!draft.enabled || selectedStopped}>
          <legend>End condition</legend>
          <div className="recurringFieldGrid">
            <NativeSelectField
              label="Ends"
              value={draft.endMode}
              onChange={(value) => update({ endMode: value as RepeatEndMode })}
              options={[
                { value: "never", label: "Never" },
                { value: "until", label: "On date" },
                { value: "count", label: "After count" }
              ]}
              testId="recurring-end-mode"
            />
            {draft.endMode === "count" && (
              <label className="block">
                <span className="text-sm font-medium">Number of cycles</span>
                <Input className="mt-2" type="number" min={1} step={1} value={draft.count} onChange={(event) => update({ count: Math.max(1, Math.round(Number(event.target.value) || 1)) })} />
              </label>
            )}
            {draft.endMode === "until" && (
              <SettingsInput
                label="End date"
                name={`recurring-end-date-${project.id}`}
                value={draft.endDate}
                onChange={(value) => update({ endDate: value })}
                placeholder="2026-12-31"
                autoComplete="off"
                type="date"
                required
                invalid={!endDateValid}
                describedBy={!endDateValid ? "recurring-end-error" : undefined}
              />
            )}
          </div>
          {!endDateValid && <p id="recurring-end-error" className="recurringFieldError">Enter a valid end date.</p>}
        </fieldset>

        {draft.executionMode === "automatic" && (
          <fieldset className="recurringFieldset" disabled={!draft.enabled || selectedStopped}>
            <legend>Reminder</legend>
            <div className="recurringReminderLayout">
              <ToggleField label="Remind me before this event" checked={draft.reminderEnabled} onChange={(reminderEnabled) => update({ reminderEnabled })} />
              {draft.reminderEnabled && (
                <div className="recurringReminderFields">
                  <label className="block">
                    <span className="text-sm font-medium">Lead time</span>
                    <Input className="mt-2" type="number" min={1} step={1} value={draft.reminderLeadValue} onChange={(event) => update({ reminderLeadValue: Math.max(1, Number(event.target.value) || 1) })} />
                  </label>
                  <NativeSelectField
                    label="Unit"
                    value={draft.reminderLeadUnit}
                    onChange={(value) => update({ reminderLeadUnit: value as RepeatRuleDraft["reminderLeadUnit"] })}
                    options={[
                      { value: "minutes", label: "Minutes" },
                      { value: "hours", label: "Hours" },
                      { value: "days", label: "Days" }
                    ]}
                  />
                </div>
              )}
            </div>
          </fieldset>
        )}

        <fieldset className="recurringFieldset" disabled={!draft.enabled || selectedStopped}>
          <legend>Details</legend>
          <div className="recurringFieldGrid">
            <div className="recurringFieldFull">
              <FormTextarea label="Description" value={draft.description} onChange={(description) => update({ description })} placeholder="Describe what the external system performs." />
            </div>
            {draft.executionMode === "automatic" && (
              <>
                <label className="block">
                  <span className="text-sm font-medium">Calendar duration</span>
                  <div className="recurringNumberField">
                    <Input type="number" min={0} step={5} value={draft.displayDurationMinutes} aria-label="Calendar duration in minutes" onChange={(event) => update({ displayDurationMinutes: Math.max(0, Number(event.target.value) || 0) })} />
                    <span>minutes</span>
                  </div>
                </label>
                <div className="recurringReadOnlyField"><span>Workspace time zone</span><strong>{timeZone}</strong></div>
              </>
            )}
          </div>
        </fieldset>

        {draftError && <p className="recurringFormError" role="alert">{draftError}</p>}

        <section className="recurringPreview" aria-labelledby="recurring-preview-heading">
          <div className="recurringPreviewHeader">
            <h4 id="recurring-preview-heading">Preview</h4>
            {previewRule && <span>{repeatCadenceLabel(previewRule)} · {repeatStartModeLabel(previewRule)}</span>}
          </div>
          {preview.length ? (
            <div className="recurringOccurrenceList">
              {preview.map((occurrence) => (
                <div key={occurrence.index} className="recurringOccurrence">
                  <Badge variant="secondary">#{occurrence.index}</Badge>
                  <span>{formatShortDateTimeInZone(occurrence.start, timeZone)}</span>
                  <span>{formatShortDateTimeInZone(occurrence.finish, timeZone)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="recurringEmpty">
              {!draft.enabled ? "Choose a rule mode to preview future cycles." : !previewRule ? "Fix the highlighted date or time fields to continue." : "No future cycles fall inside the preview window."}
            </div>
          )}
        </section>

        <div className="recurringActions">
          <Button type="submit" disabled={!canSave} aria-describedby="recurring-save-help">
            <Save />
            {selected?.repeatRule ? "Save changes" : "Create rule"}
          </Button>
          {draftDirty && (
            <Button type="button" variant="outline" onClick={() => {
              setDraft(baselineDraft);
              setDraftError("");
              setSaveNotice("");
              setPendingDestructiveAction(null);
            }}>Reset changes</Button>
          )}
          <span className="recurringActionSpacer" />
          {selectedAutomatic && !selectedStopped ? (
            <Button type="button" variant="outline" disabled={draftDirty} title={draftDirty ? "Reset or save current changes first" : "Stop future occurrences"} onClick={() => setPendingDestructiveAction("stop")}>
              <CircleSlash2 />Stop future occurrences
            </Button>
          ) : selected?.repeatRule && !selectedAutomatic ? (
            <Button type="button" variant="outline" disabled={draftDirty} title={draftDirty ? "Reset or save current changes first" : "Remove recurrence"} onClick={() => setPendingDestructiveAction("remove")}>
              Remove recurrence
            </Button>
          ) : null}
        </div>
        <p id="recurring-save-help" className="recurringActionHint">{saveHelp}</p>

        {pendingDestructiveAction && (
          <div className="recurringDangerConfirm" role="group" aria-labelledby="recurring-danger-title">
            <div>
              <strong id="recurring-danger-title">{pendingDestructiveAction === "stop" ? "Stop future occurrences?" : "Remove this recurring rule?"}</strong>
              <span>{pendingDestructiveAction === "stop" ? "Future occurrences will stop; recorded history stays available." : "The recurring configuration will be removed from this work item."}</span>
            </div>
            <div className="recurringDangerActions">
              <Button type="button" variant="outline" onClick={() => setPendingDestructiveAction(null)}>Cancel</Button>
              <Button type="button" variant="destructive" onClick={() => {
                if (!selected) return;
                if (pendingDestructiveAction === "stop") {
                  onAutomaticRuleStop(selected.id);
                  setSaveNotice("Future occurrences stopped. Recorded history is preserved.");
                } else {
                  onRepeatRuleUpdate(selected.id, undefined, selected.description ?? "");
                  const nextDraft = draftFromRepeatRule({ ...selected, repeatRule: undefined }, project.start, timeZone);
                  setDraft(nextDraft);
                  setBaselineDraft(nextDraft);
                  setSaveNotice("Recurring rule removed.");
                }
                setPendingDestructiveAction(null);
              }}>{pendingDestructiveAction === "stop" ? "Stop future occurrences" : "Remove recurrence"}</Button>
            </div>
          </div>
        )}

        {saveNotice && <p className="recurringStatusMessage" role="status" aria-live="polite">{saveNotice}</p>}
        {selectedAutomatic && (
          <div className="recurringPreview">
            <div className="recurringPreviewHeader">
              <strong>History</strong>
              <span>{occurrenceHistory.length} occurrences / {historyEntries.length - occurrenceHistory.length} rule changes</span>
            </div>
            {historyEntries.length ? (
              <div className="recurringHistoryList">
                {visibleHistory.map((entry) => entry.kind === "occurrence" ? (
                  <div key={entry.record.id} className={cn("recurringHistoryItem", entry.record.status)}>
                    <Badge variant={entry.record.status === "exception" ? "destructive" : entry.record.status === "occurred" ? "success" : "outline"}>{entry.record.status}</Badge>
                    <span>{formatShortDateTimeInZone(entry.record.start, timeZone)}</span>
                    <strong>{entry.record.title}</strong>
                  </div>
                ) : (
                  <div key={entry.changeSet.id} className="recurringHistoryItem ruleChange">
                    <Badge variant="secondary"><RefreshCw />rule</Badge>
                    <span>{formatShortDateTimeInZone(entry.changeSet.createdAt, timeZone)}</span>
                    <strong>{entry.changeSet.title}</strong>
                  </div>
                ))}
                <PaginationControls
                  page={safeHistoryPage}
                  pageCount={historyPageCount}
                  pageSize={historyPageSize}
                  total={historyEntries.length}
                  onPageChange={setHistoryPage}
                  label="recurring history"
                />
              </div>
            ) : <div className="recurringEmpty">No automatic occurrence history yet.</div>}
          </div>
        )}
      </form>
    </div>
  );
}

function RecurrenceModeIcon() {
  return (
    <span className="recurrenceIconStack" role="img" aria-label="Recurring automatic occurrence" title="Recurring automatic occurrence">
      <RefreshCw aria-hidden="true" />
      <Zap aria-hidden="true" />
    </span>
  );
}

function WorkItemComposer({
  projectId,
  items,
  onCreate,
  initialStartValues,
  triggerLabel = "Add",
  triggerAriaLabel,
  contextDescription
}: {
  projectId: string;
  items: WorkItem[];
  onCreate: (projectId: string, values: WorkItemCreateValues) => void;
  initialStartValues?: WorkItemStartConstraintValues;
  triggerLabel?: string;
  triggerAriaLabel?: string;
  contextDescription?: string;
}) {
  const [open, setOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<WorkItemCreateValues>({
    title: "",
    description: "",
    kind: "task",
    parentId: undefined,
    durationDays: 1,
    effortHours: 2,
    attention: "deep",
    constraintMode: initialStartValues?.constraintMode ?? "none",
    constraintDate: initialStartValues?.constraintDate ?? now.slice(0, 10),
    percentComplete: 0,
    evidenceRequired: false,
    isKeyTask: false,
    isScopeExpansion: false,
    isFastDelivery: false
  });
  const update = (patch: Partial<WorkItemCreateValues>) => setDraft((current) => ({ ...current, ...patch }));
  const parentOptions = items.filter((item) => item.kind === "phase");
  useEffect(() => {
    if (!open || !initialStartValues) return;
    setDraft((current) => ({ ...current, ...initialStartValues }));
  }, [open, initialStartValues?.constraintMode, initialStartValues?.constraintDate]);
  const submitWorkItem = () => {
    if (!draft.title.trim()) return;
    onCreate(projectId, draft);
    setDraft((current) => ({
      ...current,
      title: "",
      description: "",
      kind: "task",
      durationDays: 1,
      effortHours: 2,
      percentComplete: 0,
      evidenceRequired: false,
      isKeyTask: false,
      isScopeExpansion: false,
      isFastDelivery: false
    }));
    setAdvancedOpen(false);
    setOpen(false);
  };
  return (
    <Sheet open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setAdvancedOpen(false);
    }}>
      <SheetTrigger asChild>
        <Button type="button" size="sm" className="outlineAddButton" aria-label={triggerAriaLabel}><Plus />{triggerLabel}</Button>
      </SheetTrigger>
      <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Add work item</SheetTitle>
          <SheetDescription>{contextDescription ?? `${items.length} items in this project`}</SheetDescription>
        </SheetHeader>
        <form
          className="workItemSheetForm"
          onSubmit={(event) => {
            event.preventDefault();
            submitWorkItem();
          }}
        >
          <div className="workItemQuickCreate">
            <SettingsInput label="Title" name={`work-title-${projectId}`} value={draft.title} onChange={(value) => update({ title: value })} placeholder="Task or milestone title" autoComplete="off" />
            <SettingsInput label="Description" name={`work-description-${projectId}`} value={draft.description} onChange={(value) => update({ description: value })} placeholder="What happens or what needs to be done?" autoComplete="off" />
            <div className="quickProjectDefaults" aria-label="Work item defaults">
              <Badge variant="secondary" className="iconBadge" title="Kind"><Workflow />{draft.kind}</Badge>
              <Badge variant="outline" className="iconBadge" title="Duration"><CalendarClock />{draft.durationDays}d</Badge>
              <Badge variant="outline" className="iconBadge" title="Effort"><Timer />{draft.effortHours}h</Badge>
              {draft.constraintMode !== "none" && <Badge variant="outline" className="iconBadge" title="Start date"><CalendarClock />{draft.constraintDate}</Badge>}
              <Button type="button" variant="outline" size="sm" onClick={() => setAdvancedOpen((current) => !current)} aria-expanded={advancedOpen}>
                <SettingsIcon />
                Advanced
              </Button>
            </div>
          </div>
          {advancedOpen && (
            <div className="workItemAdvancedPanel">
              <div className="advancedFieldGrid">
                <NativeSelectField
                  label="Kind"
                  value={draft.kind}
                  onChange={(value) => update({ kind: value as WorkItemKind })}
                  options={workItemKinds.map((kind) => ({ value: kind, label: kind }))}
                  testId="work-item-kind"
                />
                <NativeSelectField
                  label="Parent phase"
                  value={draft.parentId ?? "none"}
                  onChange={(value) => update({ parentId: value === "none" ? undefined : value })}
                  options={[{ value: "none", label: "No parent" }, ...parentOptions.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
                  testId="work-item-parent"
                />
                <label className="block">
                  <span className="text-sm font-medium">Duration days</span>
                  <Input className="mt-2" type="number" min={0} step={0.25} value={draft.durationDays} onChange={(event) => update({ durationDays: Number(event.target.value) || 0 })} disabled={draft.kind === "milestone"} />
                </label>
                <label className="block">
                  <span className="text-sm font-medium">Effort hours</span>
                  <Input className="mt-2" type="number" min={0} step={0.25} value={draft.effortHours} onChange={(event) => update({ effortHours: Number(event.target.value) || 0 })} />
                </label>
                <NativeSelectField
                  label="Attention"
                  value={draft.attention}
                  onChange={(value) => update({ attention: value as WorkItemCreateValues["attention"] })}
                  options={[
                    { value: "deep", label: "deep" },
                    { value: "medium", label: "medium" },
                    { value: "shallow", label: "shallow" }
                  ]}
                  testId="work-item-attention"
                />
                <NativeSelectField
                  label="Date constraint"
                  value={draft.constraintMode}
                  onChange={(value) => update({ constraintMode: value as WorkItemCreateValues["constraintMode"] })}
                  options={[
                    { value: "none", label: "None" },
                    { value: "noEarlierThan", label: "No earlier than" },
                    { value: "fixedStart", label: "Fixed start" }
                  ]}
                  testId="work-item-constraint-mode"
                />
                {draft.constraintMode !== "none" && (
                  <SettingsInput label="Constraint date" name={`constraint-date-${projectId}`} value={draft.constraintDate} onChange={(value) => update({ constraintDate: value })} placeholder="2026-07-01" autoComplete="off" type="date" required />
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                <ToggleField label="Evidence required" checked={draft.evidenceRequired} onChange={(checked) => update({ evidenceRequired: checked })} />
                <ToggleField label="Key task" checked={draft.isKeyTask} onChange={(checked) => update({ isKeyTask: checked })} />
                <ToggleField label="Scope expansion" checked={draft.isScopeExpansion} onChange={(checked) => update({ isScopeExpansion: checked })} />
                <ToggleField label="Fast delivery" checked={draft.isFastDelivery} onChange={(checked) => update({ isFastDelivery: checked })} />
              </div>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Button type="submit" disabled={!draft.title.trim()}><Plus />Add</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function DependencyComposer({
  projectId,
  items,
  dependencies,
  onCreate
}: {
  projectId: string;
  items: WorkItem[];
  dependencies: Dependency[];
  onCreate: (projectId: string, values: DependencyCreateValues) => void;
}) {
  const taskItems = items.filter((item) => item.kind !== "phase");
  const [draft, setDraft] = useState<DependencyCreateValues>({
    fromId: taskItems[0]?.id ?? "",
    toId: taskItems[1]?.id ?? taskItems[0]?.id ?? "",
    type: "FS",
    lagDays: 0
  });
  useEffect(() => {
    setDraft((current) => ({
      ...current,
      fromId: taskItems.some((item) => item.id === current.fromId) ? current.fromId : taskItems[0]?.id ?? "",
      toId: taskItems.some((item) => item.id === current.toId) ? current.toId : taskItems[1]?.id ?? taskItems[0]?.id ?? ""
    }));
  }, [projectId, taskItems.length]);
  const update = (patch: Partial<DependencyCreateValues>) => setDraft((current) => ({ ...current, ...patch }));
  const duplicate = dependencies.some((dependency) => dependency.fromId === draft.fromId && dependency.toId === draft.toId);
  return (
    <form
      className="grid gap-3 lg:grid-cols-[1fr_1fr_120px_120px_auto]"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.fromId || !draft.toId || draft.fromId === draft.toId || duplicate) return;
        onCreate(projectId, draft);
      }}
    >
      <NativeSelectField
        label="Predecessor"
        value={draft.fromId || "none"}
        onChange={(value) => update({ fromId: value === "none" ? "" : value })}
        options={[{ value: "none", label: "Select task" }, ...taskItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
        testId="dependency-predecessor"
      />
      <NativeSelectField
        label="Successor"
        value={draft.toId || "none"}
        onChange={(value) => update({ toId: value === "none" ? "" : value })}
        options={[{ value: "none", label: "Select task" }, ...taskItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
        testId="dependency-successor"
      />
      <NativeSelectField
        label="Type"
        value={draft.type}
        onChange={(value) => update({ type: value as DependencyType })}
        options={dependencyTypes.map((type) => ({ value: type, label: dependencyLabel(type) }))}
        testId="dependency-type"
      />
      <label className="block">
        <span className="text-sm font-medium">Lag days</span>
        <Input className="mt-2" type="number" step={1} value={draft.lagDays} onChange={(event) => update({ lagDays: Number(event.target.value) || 0 })} />
      </label>
      <div className="flex items-end">
        <Button type="submit" variant="outline" disabled={!draft.fromId || !draft.toId || draft.fromId === draft.toId || duplicate}>Add dependency</Button>
      </div>
    </form>
  );
}

function EvidenceComposer({
  projectId,
  items,
  onCreate
}: {
  projectId: string;
  items: WorkItem[];
  onCreate: (projectId: string, values: EvidenceCreateValues) => void;
}) {
  const [draft, setDraft] = useState<EvidenceCreateValues>({
    kind: "note",
    summary: "",
    url: "",
    workItemId: undefined,
    confidence: 0.75,
    tags: "manual"
  });
  const update = (patch: Partial<EvidenceCreateValues>) => setDraft((current) => ({ ...current, ...patch }));
  const eligibleItems = items.filter((item) => item.kind !== "phase");
  return (
    <form
      className="rounded-lg border bg-muted/25 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.summary.trim()) return;
        onCreate(projectId, draft);
        setDraft((current) => ({ ...current, summary: "", url: "" }));
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong className="text-sm">Add evidence</strong>
          <p className="text-xs text-muted-foreground">Manual evidence is valid even without GitHub or AI.</p>
        </div>
        <Button type="submit" size="sm" disabled={!draft.summary.trim()}><Plus />Attach</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <NativeSelectField
          label="Kind"
          value={draft.kind}
          onChange={(value) => update({ kind: value as EvidenceKind })}
          options={evidenceKinds.map((kind) => ({ value: kind, label: kind }))}
          testId="evidence-kind"
        />
        <NativeSelectField
          label="Linked item"
          value={draft.workItemId ?? "project"}
          onChange={(value) => update({ workItemId: value === "project" ? undefined : value })}
          options={[{ value: "project", label: "Project-level" }, ...eligibleItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
          testId="evidence-linked-item"
        />
        <label className="block">
          <span className="text-sm font-medium">Confidence</span>
          <Input className="mt-2" type="number" min={0} max={1} step={0.05} value={draft.confidence} onChange={(event) => update({ confidence: Number(event.target.value) || 0 })} />
        </label>
        <SettingsInput label="Summary" name={`evidence-summary-${projectId}`} value={draft.summary} onChange={(value) => update({ summary: value })} placeholder="What does this prove?" autoComplete="off" />
        <SettingsInput label="URL or reference" name={`evidence-url-${projectId}`} value={draft.url} onChange={(value) => update({ url: value })} placeholder="https://..." autoComplete="url" />
        <SettingsInput label="Tags" name={`evidence-tags-${projectId}`} value={draft.tags} onChange={(value) => update({ tags: value })} placeholder="manual,booking,pr" autoComplete="off" />
      </div>
    </form>
  );
}

function TaskProgressPanel({
  projectId,
  items,
  onRecord
}: {
  projectId: string;
  items: WorkItem[];
  onRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
}) {
  const editableItems = items.filter((item) => item.kind !== "phase");
  const [workItemId, setWorkItemId] = useState(editableItems[0]?.id ?? "");
  const selected = editableItems.find((item) => item.id === workItemId) ?? editableItems[0];
  const [draft, setDraft] = useState<ActualRecordValues>({
    percentComplete: selected?.percentComplete ?? 0,
    actualWorkHours: 1,
    remainingWorkHours: 0,
    actualCost: 1,
    markFinished: false
  });
  useEffect(() => {
    if (!selected) return;
    setDraft((current) => ({ ...current, percentComplete: selected.percentComplete }));
  }, [selected?.id, selected?.percentComplete]);
  if (!selected) return null;
  return (
    <form
      className="rounded-lg border bg-background p-3 md:col-span-3"
      onSubmit={(event) => {
        event.preventDefault();
        onRecord(projectId, selected.id, draft);
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong className="text-sm">Record progress / actuals</strong>
          <p className="text-xs text-muted-foreground">Updates task percent and EVM actuals without changing the baseline.</p>
        </div>
        <Button type="submit" size="sm">Save actual</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-5">
        <div className="md:col-span-2">
          <NativeSelectField
            label="Work item"
            value={selected.id}
            onChange={setWorkItemId}
            options={editableItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))}
            testId="actual-work-item"
          />
        </div>
        <label className="block">
          <span className="text-sm font-medium">Percent</span>
          <Input className="mt-2" type="number" min={0} max={100} value={draft.percentComplete} onChange={(event) => setDraft((current) => ({ ...current, percentComplete: Number(event.target.value) || 0 }))} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Actual h</span>
          <Input className="mt-2" type="number" min={0} step={0.25} value={draft.actualWorkHours} onChange={(event) => setDraft((current) => ({ ...current, actualWorkHours: Number(event.target.value) || 0 }))} />
        </label>
        <label className="block">
          <span className="text-sm font-medium">Remaining h</span>
          <Input className="mt-2" type="number" min={0} step={0.25} value={draft.remainingWorkHours} onChange={(event) => setDraft((current) => ({ ...current, remainingWorkHours: Number(event.target.value) || 0 }))} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <ToggleField label="Mark finished" checked={draft.markFinished} onChange={(checked) => setDraft((current) => ({ ...current, markFinished: checked }))} />
      </div>
    </form>
  );
}

function CalendarView({
  workspace,
  schedules,
  currentTime,
  selectedProjectId,
  onWorkItemCreate,
  onWorkItemScheduleUpdate,
  onOccurrenceSkip,
  onOccurrenceReschedule,
  onOccurrenceException
}: {
  workspace: WorkspaceSnapshot;
  schedules: ScheduleResult[];
  currentTime: string;
  selectedProjectId: string;
  onWorkItemCreate: (projectId: string, values: WorkItemCreateValues) => void;
  onWorkItemScheduleUpdate: (projectId: string, workItemId: string, values: WorkItemStartConstraintValues) => void;
} & AutomaticOccurrenceHandlers) {
  const { projects, workItems, timeZone } = workspace;
  const [monthStart, setMonthStart] = useState(() => monthStartKey(currentTime, timeZone));
  const [selectedDay, setSelectedDay] = useState(() => zonedDateKey(currentTime, timeZone));
  const [monthEventsOpen, setMonthEventsOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [showAutomatic, setShowAutomatic] = useState(true);
  const [selectedOccurrence, setSelectedOccurrence] = useState<RecurringOccurrence>();
  const days = buildCalendarDays(monthStart);
  const gridStart = zonedDateTimeToIso(days[0], "00:00", timeZone);
  const gridEnd = zonedDateTimeToIso(addSeconds(`${days[days.length - 1]}T00:00:00.000Z`, daySeconds).slice(0, 10), "00:00", timeZone);
  const allEvents = buildCalendarEvents(workspace, schedules, gridStart, gridEnd, currentTime);
  const events = showAutomatic ? allEvents : allEvents.filter((event) => !event.automatic);
  const recurringRules = buildRecurringRules(workspace, currentTime);
  const eventsByDay = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const day = calendarEventDateKey(event, timeZone);
    eventsByDay.set(day, [...(eventsByDay.get(day) ?? []), event]);
  }
  const monthEvents = events.filter((event) => isSameCalendarMonth(calendarEventDateKey(event, timeZone), monthStart));
  const selectedEvents = eventsByDay.get(selectedDay) ?? [];
  const monthEventPage = usePagedItems(monthEvents, 10);
  const recurringRulePage = usePagedItems(recurringRules, 12);
  const activeProjectCount = projects.filter((project) => !isProjectArchived(project)).length;
  const calendarProject = projects.find((project) => project.id === selectedProjectId && !isProjectArchived(project))
    ?? projects.find((project) => !isProjectArchived(project));
  const calendarProjectItems = calendarProject ? workItems.filter((item) => item.projectId === calendarProject.id) : [];
  const selectedLabel = new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC", weekday: "short" }).format(new Date(`${selectedDay}T00:00:00.000Z`));
  const selectedLongLabel = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${selectedDay}T00:00:00.000Z`));

  const changeMonth = (offset: number) => {
    const nextMonth = addCalendarMonths(monthStart, offset);
    setMonthStart(nextMonth);
    setSelectedDay(nextMonth);
  };

  const jumpToday = () => {
    setMonthStart(monthStartKey(currentTime, timeZone));
    setSelectedDay(zonedDateKey(currentTime, timeZone));
  };

  const openOccurrence = (occurrence: RecurringOccurrence) => {
    setMonthEventsOpen(false);
    setSelectedOccurrence(occurrence);
  };

  return (
    <section className="grid gap-4">
      <div className="calendarPageHeader">
        <div>
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> {monthLabel(monthStart)}</CardTitle>
          <CardDescription>Scheduled work and recurring cycles across active projects.</CardDescription>
        </div>
        <div className="calendarControls">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="calendarAutoFilter"
            aria-label={showAutomatic ? "Hide automatic recurring occurrences" : "Show automatic recurring occurrences"}
            title={showAutomatic ? "Hide automatic occurrences" : "Show automatic occurrences"}
            aria-pressed={showAutomatic}
            onClick={() => setShowAutomatic((visible) => !visible)}
          ><Zap /></Button>
          <Button type="button" variant="outline" size="icon" aria-label="Previous month" title="Previous month" onClick={() => changeMonth(-1)}><ChevronLeft /></Button>
          <Button type="button" variant="outline" onClick={jumpToday}>Today</Button>
          <Button type="button" variant="outline" size="icon" aria-label="Next month" title="Next month" onClick={() => changeMonth(1)}><ChevronRight /></Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <SummaryTile
          label="Month events"
          value={String(monthEvents.length)}
          detail={`${activeProjectCount} active projects visible`}
          onClick={() => setMonthEventsOpen(true)}
          ariaLabel={`Open ${monthEvents.length} month events`}
        />
        <SummaryTile
          label="Recurring"
          value={String(recurringRules.length)}
          detail={`${monthEvents.filter((event) => event.kind === "recurring").length} this month`}
          onClick={() => setRecurringOpen(true)}
          ariaLabel={`Open ${recurringRules.length} recurring rules`}
        />
        <SummaryTile label="Critical" value={String(monthEvents.filter((event) => event.critical).length)} detail="Scheduled critical path starts" tone={monthEvents.some((event) => event.critical) ? "warning" : "default"} />
        <SummaryTile label="Selected day" value={String(selectedEvents.length)} detail={selectedLabel} />
      </div>
      <Sheet open={monthEventsOpen} onOpenChange={setMonthEventsOpen}>
        <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{monthLabel(monthStart)} events</SheetTitle>
            <SheetDescription>{monthEvents.length} items across {activeProjectCount} active projects</SheetDescription>
          </SheetHeader>
          <div className="calendarAgenda monthEventSheetList">
            {monthEvents.length ? monthEventPage.items.map((event) => (
              <CalendarAgendaEvent key={event.id} event={event} timeZone={timeZone} onOccurrenceOpen={openOccurrence} />
            )) : (
              <div className="emptyState">
                <CalendarClock />
                <span>No calendar events this month.</span>
              </div>
            )}
            <PaginationControls label="month events" {...monthEventPage} onPageChange={monthEventPage.setPage} />
          </div>
        </SheetContent>
      </Sheet>
      <Sheet open={recurringOpen} onOpenChange={setRecurringOpen}>
        <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>Recurring rules</SheetTitle>
            <SheetDescription>{recurringRules.length} rules across active projects</SheetDescription>
          </SheetHeader>
          <div className="calendarRecurringList">
            {recurringRules.length ? recurringRulePage.items.map((rule) => (
              <a key={rule.id} className="calendarRecurringRule" href={rule.href}>
                <div className="calendarAgendaIcon">
                  {rule.automatic ? <RecurrenceModeIcon /> : <RefreshCw />}
                </div>
                <div className="calendarRecurringRuleBody">
                  <div className="calendarRecurringRuleTitle">
                    <Badge variant="secondary">{rule.outline}</Badge>
                    <strong title={rule.title}>{rule.title}</strong>
                  </div>
                  <div className="calendarRecurringRuleMeta">
                    <Badge variant="outline"><RefreshCw />{rule.cadenceLabel}</Badge>
                    <Badge variant="outline"><Timer />{rule.startModeLabel}</Badge>
                    <Badge variant="outline"><CalendarClock />{formatShortDateTimeInZone(rule.nextStart, timeZone)}</Badge>
                    {rule.stopped && <Badge variant="outline">stopped</Badge>}
                  </div>
                  <span>{rule.projectName}</span>
                </div>
              </a>
            )) : (
              <div className="emptyState">
                <RefreshCw />
                <span>No recurring rules configured.</span>
              </div>
            )}
            <PaginationControls label="recurring rules" {...recurringRulePage} onPageChange={recurringRulePage.setPage} />
          </div>
        </SheetContent>
      </Sheet>

      <div className="calendarWorkspace">
        <Card>
          <CardContent className="calendarMonthShell">
            <div className="calendarWeekdays" aria-hidden="true">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="calendarGrid" role="grid" aria-label={`${monthLabel(monthStart)} calendar`}>
              {days.map((day) => {
                const dayEvents = eventsByDay.get(day) ?? [];
                const inMonth = isSameCalendarMonth(day, monthStart);
                const isSelected = day === selectedDay;
                const isToday = day === zonedDateKey(currentTime, timeZone);
                return (
                  <div
                    key={day}
                    className={cn("calendarDay", !inMonth && "outsideMonth", isSelected && "selected", isToday && "today")}
                    role="gridcell"
                    aria-selected={isSelected}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest?.("a, button")) return;
                      setSelectedDay(day);
                    }}
                  >
                    <button
                      type="button"
                      className="calendarDaySelector"
                      onClick={() => setSelectedDay(day)}
                      aria-label={`${day}, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
                      aria-pressed={isSelected}
                    >
                      <span className="calendarDayTop">
                      <strong>{Number(day.slice(8, 10))}</strong>
                      {dayEvents.length > 0 && <Badge variant={dayEvents.some((event) => event.critical) ? "warning" : "secondary"}>{dayEvents.length}</Badge>}
                      </span>
                    </button>
                    <div className="calendarDayEvents">
                      {dayEvents.slice(0, 3).map((event) => {
                        const eventClassName = cn("calendarEventChip", event.kind, event.automatic && "automatic", event.status, event.critical && "critical");
                        const eventContent = (
                          <>
                          {event.automatic ? <RecurrenceModeIcon /> : event.kind === "recurring" ? <RefreshCw /> : <CalendarClock />}
                          {event.status === "exception" && <AlertTriangle aria-hidden="true" />}
                          {event.status === "skipped" && <CircleSlash2 aria-hidden="true" />}
                          <span>{event.title}</span>
                          </>
                        );
                        return event.automatic && event.occurrence ? (
                          <button
                            key={event.id}
                            type="button"
                            className={eventClassName}
                            title={`${event.projectName}: ${event.title}, ${event.status}`}
                            aria-label={`Open ${event.title}, automatic recurring occurrence, ${event.status}`}
                            onClick={() => {
                              setSelectedDay(day);
                              openOccurrence(event.occurrence!);
                            }}
                          >
                            {eventContent}
                          </button>
                        ) : (
                          <a key={event.id} className={eventClassName} href={event.href} title={`${event.projectName}: ${event.title}`}>
                            {eventContent}
                          </a>
                        );
                      })}
                      {dayEvents.length > 3 && <span className="calendarMore">+{dayEvents.length - 3}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-start justify-between gap-3 pb-3">
            <div>
              <CardTitle className="flex items-center gap-2"><PanelRight className="h-4 w-4" /> {selectedLabel}</CardTitle>
              <CardDescription>{selectedEvents.length ? `${selectedEvents.length} scheduled item${selectedEvents.length === 1 ? "" : "s"}` : "No work starts on this day."}</CardDescription>
            </div>
            {calendarProject && (
              <WorkItemComposer
                projectId={calendarProject.id}
                items={calendarProjectItems}
                onCreate={onWorkItemCreate}
                initialStartValues={calendarWorkItemStartValues(selectedDay)}
                triggerLabel="Add work item"
                triggerAriaLabel={`Add work item on ${selectedLongLabel} to ${calendarProject.name}`}
                contextDescription={`${calendarProject.name} · fixed start ${selectedLongLabel}`}
              />
            )}
          </CardHeader>
          <CardContent className="calendarAgenda">
            {selectedEvents.length ? selectedEvents.map((event) => {
              const scheduledWorkItem = event.workItemId ? workItems.find((item) => item.id === event.workItemId) : undefined;
              return (
                <div key={event.id} className="calendarAgendaRow">
                  <CalendarAgendaEvent event={event} timeZone={timeZone} onOccurrenceOpen={openOccurrence} />
                  {event.kind === "scheduled" && scheduledWorkItem && (
                    <WorkItemScheduleSheet
                      item={scheduledWorkItem}
                      timeZone={timeZone}
                      fallbackDate={selectedDay}
                      scheduledStart={event.start}
                      onSave={(values) => onWorkItemScheduleUpdate(event.projectId, scheduledWorkItem.id, values)}
                    />
                  )}
                </div>
              );
            }) : (
              <div className="emptyState">
                <CalendarClock />
                <span>No calendar event starts here.</span>
              </div>
            )}
            {selectedEvents.length === 0 && activeProjectCount > 0 && (
              <div className="calendarQuietHint">
                Pick another day or add scheduled / recurring work from a project.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <AutomaticOccurrenceSheet
        occurrence={selectedOccurrence}
        open={Boolean(selectedOccurrence)}
        onOpenChange={(open) => !open && setSelectedOccurrence(undefined)}
        timeZone={timeZone}
        currentTime={currentTime}
        resources={workspace.resources}
        historyRecords={workspace.recurringOccurrences}
        ruleChangeSets={workspace.changeSets}
        onOccurrenceSkip={onOccurrenceSkip}
        onOccurrenceReschedule={onOccurrenceReschedule}
        onOccurrenceException={onOccurrenceException}
      />
    </section>
  );
}

function buildCalendarEvents(
  workspace: WorkspaceSnapshot,
  schedules: ScheduleResult[],
  windowStart: string,
  windowEnd: string,
  currentTime: string
): CalendarEvent[] {
  const { projects, workItems } = workspace;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const events: CalendarEvent[] = [];

  for (const schedule of schedules) {
    const project = projectById.get(schedule.projectId);
    if (!project || isProjectArchived(project)) continue;
    for (const item of schedule.items) {
      if (item.workItem.kind === "phase" || item.workItem.repeatRule) continue;
      if (item.start < windowStart || item.start >= windowEnd) continue;
      events.push({
        id: `scheduled-${item.workItem.id}`,
        workItemId: item.workItem.id,
        kind: "scheduled",
        projectId: project.id,
        projectName: project.name,
        title: item.workItem.title,
        start: item.start,
        finish: item.finish,
        href: hashForRoute({ view: "project", selectedProjectId: project.id, target: "project-gantt" }),
        critical: item.isCritical
      });
    }
  }

  for (const item of workItems) {
    if (!item.repeatRule || item.kind === "phase") continue;
    const project = projectById.get(item.projectId);
    if (!project || isProjectArchived(project)) continue;
    for (const occurrence of projectRecurringOccurrences(item, project.start, {
      timeZone: workspace.timeZone,
      now: currentTime,
      windowStart,
      windowEnd,
      records: workspace.recurringOccurrences,
      limit: 400
    })) {
      events.push({
        id: `recurring-${occurrence.id}`,
        kind: "recurring",
        projectId: project.id,
        projectName: project.name,
        title: occurrence.title,
        start: occurrence.start,
        finish: occurrence.finish,
        href: hashForRoute({ view: "project", selectedProjectId: project.id, target: recurringRouteTarget(item.id) }),
        repeatLabel: repeatCadenceLabel(item.repeatRule),
        automatic: occurrence.executionMode === "automatic",
        status: occurrence.executionMode === "automatic" ? occurrence.status : undefined,
        occurrence: occurrence.executionMode === "automatic" ? occurrence : undefined
      });
    }
  }

  return events.sort((a, b) => a.start.localeCompare(b.start) || a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
}

function calendarEventDateKey(event: CalendarEvent, timeZone: string) {
  return event.kind === "scheduled" ? event.start.slice(0, 10) : zonedDateKey(event.start, timeZone);
}

function buildRecurringRules(workspace: WorkspaceSnapshot, currentTime: string): CalendarRecurringRule[] {
  const { projects, workItems } = workspace;
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const rules: CalendarRecurringRule[] = [];
  for (const item of workItems) {
    if (!item.repeatRule || item.kind === "phase") continue;
    const project = projectById.get(item.projectId);
    if (!project || isProjectArchived(project)) continue;
    const nextOccurrence = item.repeatRule.stoppedAt
      ? projectRecurringOccurrences(item, project.start, { timeZone: workspace.timeZone, now: currentTime, records: workspace.recurringOccurrences, limit: 1 })[0]
      : nextRecurringOccurrence(item, project.start, currentTime, workspace.timeZone);
    if (!nextOccurrence) continue;
    rules.push({
      id: item.id,
      projectId: project.id,
      projectName: project.name,
      title: item.title,
      outline: item.outline,
      cadenceLabel: repeatCadenceLabel(item.repeatRule),
      startModeLabel: repeatStartModeLabel(item.repeatRule),
      nextStart: nextOccurrence.start,
      nextFinish: nextOccurrence.finish,
      href: hashForRoute({ view: "project", selectedProjectId: project.id, target: recurringRouteTarget(item.id) }),
      automatic: repeatExecutionMode(item.repeatRule) === "automatic",
      stopped: Boolean(item.repeatRule.stoppedAt)
    });
  }
  return rules.sort((a, b) => a.nextStart.localeCompare(b.nextStart) || a.projectName.localeCompare(b.projectName) || a.title.localeCompare(b.title));
}

function CalendarAgendaEvent({ event, timeZone, onOccurrenceOpen }: { event: CalendarEvent; timeZone: string; onOccurrenceOpen: (occurrence: RecurringOccurrence) => void }) {
  const formatEventDateTime = event.kind === "scheduled"
    ? formatShortDateTime
    : (value: string) => formatShortDateTimeInZone(value, timeZone);
  const content = (
    <>
      <div className="calendarAgendaIcon">
        {event.automatic ? <RecurrenceModeIcon /> : event.kind === "recurring" ? <RefreshCw /> : <CalendarClock />}
      </div>
      <div className="calendarAgendaBody">
        <div className="calendarAgendaTitle">
          <strong>{event.title}</strong>
          <Badge variant={event.kind === "recurring" ? "outline" : event.critical ? "warning" : "secondary"}>
            {event.status ?? (event.kind === "recurring" ? event.repeatLabel ?? "repeat" : event.critical ? "critical" : "scheduled")}
          </Badge>
          {event.status === "exception" && <AlertTriangle aria-label="Exception" />}
          {event.status === "skipped" && <CircleSlash2 aria-label="Skipped" />}
        </div>
        <span>{event.projectName}</span>
        <em>{formatEventDateTime(event.start)} / {formatEventDateTime(event.finish)}</em>
      </div>
    </>
  );
  const className = cn("calendarAgendaItem", event.kind, event.automatic && "automatic", event.status, event.critical && "critical");
  if (event.automatic && event.occurrence) {
    return <button type="button" className={className} onClick={() => onOccurrenceOpen(event.occurrence!)} aria-label={`Open ${event.title}, automatic recurring occurrence, ${event.status}`}>{content}</button>;
  }
  return <a className={className} href={event.href}>{content}</a>;
}

function AutomaticOccurrenceSheet({
  occurrence,
  open,
  onOpenChange,
  timeZone,
  currentTime,
  resources,
  historyRecords,
  ruleChangeSets,
  onOccurrenceSkip,
  onOccurrenceReschedule,
  onOccurrenceException
}: {
  occurrence?: RecurringOccurrence;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
  currentTime: string;
  resources: Resource[];
  historyRecords: RecurringOccurrenceRecord[];
  ruleChangeSets: ChangeSet[];
} & AutomaticOccurrenceHandlers) {
  const [editOnce, setEditOnce] = useState(false);
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [durationMinutes, setDurationMinutes] = useState(0);
  const [exceptionNote, setExceptionNote] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [resourceId, setResourceId] = useState("none");
  const [announcement, setAnnouncement] = useState("");
  const [actionError, setActionError] = useState("");
  const closeTimerRef = useRef<number | undefined>();

  useEffect(() => {
    if (!occurrence) return;
    setEditOnce(false);
    setStartDate(zonedDateKey(occurrence.start, timeZone));
    setStartTime(zonedTimeKey(occurrence.start, timeZone));
    setDurationMinutes(Math.max(0, Math.round(secondsBetween(occurrence.start, occurrence.finish) / 60)));
    setExceptionNote("");
    setDueDate(zonedDateKey(currentTime, timeZone));
    setResourceId("none");
    setAnnouncement("");
    setActionError("");
  }, [occurrence?.id, occurrence?.start, occurrence?.finish, timeZone]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  if (!occurrence) return null;
  const future = occurrence.status === "scheduled" && occurrence.start > currentTime;
  const canReportException = occurrence.status === "occurred" && occurrence.finish <= currentTime;
  const rescheduled = occurrence.start !== occurrence.scheduledStart || occurrence.finish !== occurrence.scheduledFinish;
  const editRuleHref = hashForRoute({ view: "project", selectedProjectId: occurrence.projectId, target: recurringRouteTarget(occurrence.workItemId) });
  const recentHistory = [
    ...historyRecords
      .filter((record) => record.workItemId === occurrence.workItemId)
      .map((record) => ({ kind: "occurrence" as const, at: record.updatedAt, id: record.id, label: record.status, title: record.title })),
    ...ruleChangeSets
      .filter((changeSet) => changeSet.diffs.some((diff) => diff.entity === "WorkItem" && diff.entityId === occurrence.workItemId && diff.field.startsWith("repeatRule")))
      .map((changeSet) => ({ kind: "rule" as const, at: changeSet.createdAt, id: changeSet.id, label: "rule", title: changeSet.title }))
  ].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 3);
  const announceAndClose = (message: string) => {
    setAnnouncement(message);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => onOpenChange(false), 500);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{occurrence.title}</SheetTitle>
          <SheetDescription className="srOnly">Automatic recurring occurrence</SheetDescription>
        </SheetHeader>
        <div className="automaticOccurrenceDetails">
          <div className="automaticOccurrenceBadges">
            <RecurrenceModeIcon />
            <Badge variant={occurrence.status === "exception" ? "destructive" : occurrence.status === "occurred" ? "success" : "outline"}>{occurrence.status}</Badge>
            <Badge variant="outline"><CalendarClock />{formatShortDateTimeInZone(occurrence.start, timeZone)}</Badge>
          </div>
          <p>{occurrence.description || "No description."}</p>
          <SettingsRow label="Time zone" value={timeZone} />
          <SettingsRow label="Scheduled range" value={`${formatShortDateTimeInZone(occurrence.scheduledStart, timeZone)} – ${formatShortDateTimeInZone(occurrence.scheduledFinish, timeZone)}`} />
          {rescheduled && <SettingsRow label="Current range" value={`${formatShortDateTimeInZone(occurrence.start, timeZone)} – ${formatShortDateTimeInZone(occurrence.finish, timeZone)}`} />}
          {occurrence.record?.settlementSource && <SettingsRow label="Recorded by" value={occurrence.record.settlementSource === "system-catch-up" ? "System catch-up" : "On time"} />}
          {occurrence.record?.exceptionNote && <div className="automaticOccurrenceException"><AlertTriangle />{occurrence.record.exceptionNote}</div>}
          {recentHistory.length > 0 && (
            <div className="automaticOccurrenceHistory">
              <div className="recurringPreviewHeader"><strong>History</strong><span>latest {recentHistory.length}</span></div>
              <div className="recurringHistoryList">
                {recentHistory.map((entry) => (
                  <div key={entry.id} className={cn("recurringHistoryItem", entry.kind === "rule" && "ruleChange")}>
                    <Badge variant={entry.kind === "rule" ? "secondary" : entry.label === "exception" ? "destructive" : entry.label === "occurred" ? "success" : "outline"}>{entry.label}</Badge>
                    <span>{formatShortDateTimeInZone(entry.at, timeZone)}</span>
                    <strong>{entry.title}</strong>
                  </div>
                ))}
              </div>
              <Button asChild variant="outline"><a href={editRuleHref}><RefreshCw />Open full history</a></Button>
            </div>
          )}

          {future && !editOnce && (
            <div className="automaticOccurrenceActions">
              <Button type="button" variant="outline" onClick={() => setEditOnce(true)}><CalendarClock />Edit this occurrence</Button>
              <Button type="button" variant="outline" onClick={() => {
                try {
                  onOccurrenceSkip(occurrence);
                  announceAndClose("Occurrence skipped.");
                } catch (error) {
                  setActionError(error instanceof Error ? error.message : "This occurrence can no longer be skipped.");
                }
              }}><CircleSlash2 />Skip this occurrence</Button>
              <Button asChild type="button" variant="outline"><a href={editRuleHref}><RefreshCw />Edit rule</a></Button>
            </div>
          )}

          {future && editOnce && (
            <form className="automaticOccurrenceEditForm" onSubmit={(event) => {
              event.preventDefault();
              try {
                const start = zonedDateTimeToIso(startDate, startTime, timeZone);
                onOccurrenceReschedule(occurrence, start, addSeconds(start, durationMinutes * 60));
                announceAndClose("Occurrence rescheduled.");
              } catch (error) {
                setActionError(error instanceof Error ? error.message : "Enter a valid future date and time.");
              }
            }}>
              <SettingsInput label="Date" name={`occurrence-date-${occurrence.id}`} value={startDate} onChange={setStartDate} placeholder="2026-07-31" autoComplete="off" />
              <SettingsInput label="Time" name={`occurrence-time-${occurrence.id}`} value={startTime} onChange={setStartTime} placeholder="09:00" autoComplete="off" />
              <label className="block"><span className="text-sm font-medium">Duration min</span><Input className="mt-2" type="number" min={0} value={durationMinutes} onChange={(event) => setDurationMinutes(Math.max(0, Number(event.target.value) || 0))} /></label>
              <div className="automaticOccurrenceActions"><Button type="submit"><Save />Save this occurrence</Button><Button type="button" variant="outline" onClick={() => setEditOnce(false)}>Cancel</Button></div>
            </form>
          )}

          {canReportException && (
            <form className="exceptionReportForm" onSubmit={(event) => {
              event.preventDefault();
              if (!exceptionNote.trim()) return;
              try {
                onOccurrenceException(
                  occurrence,
                  exceptionNote,
                  zonedDateTimeToIso(dueDate, "23:59", timeZone),
                  resourceId === "none" ? undefined : resourceId
                );
                announceAndClose("Exception reported and follow-up task created.");
              } catch (error) {
                setActionError(error instanceof Error ? error.message : "Enter a valid follow-up date.");
              }
            }}>
              <FormTextarea label="Exception explanation" value={exceptionNote} onChange={setExceptionNote} placeholder="What failed or needs attention?" />
              <div className="automaticOccurrenceEditForm">
                <SettingsInput label="Follow-up due" name={`exception-due-${occurrence.id}`} value={dueDate} onChange={setDueDate} placeholder="2026-07-18" autoComplete="off" />
                <NativeSelectField label="Assignee" value={resourceId} onChange={setResourceId} options={[{ value: "none", label: "Unassigned" }, ...resources.map((resource) => ({ value: resource.id, label: resource.name }))]} />
              </div>
              <Button type="submit" disabled={!exceptionNote.trim()}><AlertTriangle />Report exception</Button>
            </form>
          )}
          {actionError && <p className="recurringFormError" role="alert">{actionError}</p>}
          <div className="srOnly" aria-live="polite">{announcement}</div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TodayExecution({
  workspace,
  projects,
  schedules,
  gates,
  onActualRecord,
  currentTime,
  onOccurrenceSkip,
  onOccurrenceReschedule,
  onOccurrenceException
}: {
  workspace: WorkspaceSnapshot;
  projects: Project[];
  schedules: ScheduleResult[];
  gates: AuditGate[];
  onActualRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
  currentTime: string;
} & AutomaticOccurrenceHandlers) {
  const [selectedOccurrence, setSelectedOccurrence] = useState<RecurringOccurrence>();
  const activeProjectIds = new Set(projects.filter((project) => !isProjectArchived(project)).map((project) => project.id));
  const rows = schedules
    .filter((schedule) => activeProjectIds.has(schedule.projectId))
    .flatMap((schedule) => schedule.items.map((item) => ({ item, project: projects.find((project) => project.id === schedule.projectId)! })))
    .filter(({ item }) => item.workItem.kind !== "phase" && item.workItem.percentComplete < 100)
    .map(({ item, project }) => {
      const gate = gates.find(
        (candidate) =>
          candidate.status !== "cleared" &&
          candidate.severity === "hard" &&
          (candidate.targetId === item.workItem.id ||
            (candidate.projectId === project.id && candidate.targetType === "project"))
      );
      const warningGate = gates.find(
        (candidate) =>
          candidate.status !== "cleared" &&
          candidate.severity === "warning" &&
          candidate.targetId === item.workItem.id
      );
      const timing = scheduleTiming(item, currentTime);
      return { item, project, gate, warningGate, timing };
    })
    .sort((a, b) => {
      const timingRank: Record<ScheduleTiming, number> = { Overdue: 0, "Due now": 1, Upcoming: 2 };
      return (
        timingRank[a.timing] - timingRank[b.timing] ||
        Number(b.item.isCritical) - Number(a.item.isCritical) ||
        a.item.start.localeCompare(b.item.start)
      );
    });
  const activeRows = rows.filter((row) => row.timing !== "Upcoming");
  const upcomingRows = rows.filter((row) => row.timing === "Upcoming");
  const automaticReminderRows = selectAutomaticReminderOccurrences(workspace, currentTime)
    .map((occurrence) => ({ occurrence, project: projects.find((project) => project.id === occurrence.projectId) }))
    .filter((row): row is { occurrence: RecurringOccurrence; project: Project } => Boolean(row.project && activeProjectIds.has(row.project.id)));
  const upcomingEntries = [
    ...upcomingRows.map((row) => ({ kind: "scheduled" as const, row, start: row.item.start })),
    ...automaticReminderRows.map((row) => ({ kind: "automatic-reminder" as const, row, start: row.occurrence.start }))
  ].sort((a, b) => a.start.localeCompare(b.start));
  const activeRowsPage = usePagedItems(activeRows, 8);
  const upcomingRowsPage = usePagedItems(upcomingEntries, 4);

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <Card id="critical-items">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><Timer className="h-4 w-4" /> Due or Overdue</CardTitle>
            <div className="cardHeaderBadges">
              <Badge variant={activeRows.length ? "warning" : "success"} className="iconBadge" title="Due or overdue work"><Timer />{activeRows.length}</Badge>
              <Badge variant={activeRows.some((row) => row.gate) ? "destructive" : "outline"} className="iconBadge" title="Locked by hard gate"><Lock />{activeRows.filter((row) => row.gate).length}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {activeRows.length ? activeRowsPage.items.map(({ item, project, gate, warningGate, timing }) => (
            <article className={cn("todayItem", gate && "isLocked")} key={item.workItem.id}>
              <div className="todayItemMain">
                <div className="min-w-0">
                  <strong className="todayItemTitle">{item.workItem.title}</strong>
                  <div className="todayItemMeta">
                    <Badge variant="secondary" className="todayIconBadge todayProjectBadge" title={project.name}><Layers3 />{compactProjectCode(project.name)}</Badge>
                    <Badge variant={timing === "Overdue" ? "destructive" : "outline"} className="todayIconBadge" title={timing}><Timer />{timing}</Badge>
                    {item.isCritical && <Badge variant="destructive" className="todayIconBadge" title="Critical path"><AlertTriangle />CP</Badge>}
                    <Badge variant="outline" className="todayIconBadge" title={formatScheduleRange(item)}><CalendarClock />{formatCompactScheduleRange(item)}</Badge>
                    <Badge variant="secondary" className="todayIconBadge" title="Assigned work"><Timer />{formatAssignmentHours(item)}h</Badge>
                  </div>
                  {gate && <span className="todayInlineAlert dangerText"><Lock size={13} />{gate.reason}</span>}
                  {!gate && warningGate && <span className="todayInlineAlert warnReason"><AlertTriangle size={13} />{warningGate.reason}</span>}
                </div>
                {!gate && <InlineActualForm projectId={project.id} item={item.workItem} onRecord={onActualRecord} />}
              </div>
            </article>
          )) : <div className="compactEmptyState"><CheckCircle2 />Clear</div>}
          <PaginationControls label="due work" {...activeRowsPage} onPageChange={activeRowsPage.setPage} />
        </CardContent>
      </Card>
      <Card id="today-upcoming">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Upcoming Watchlist</CardTitle>
            <div className="cardHeaderBadges">
              <Badge variant="secondary" className="iconBadge" title="Upcoming watchlist"><CalendarClock />{upcomingEntries.length}</Badge>
              <Badge variant={upcomingRows.some((row) => row.item.isCritical) ? "destructive" : "outline"} className="iconBadge" title="Critical path"><AlertTriangle />{upcomingRows.filter((row) => row.item.isCritical).length} CP</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {upcomingEntries.length ? upcomingRowsPage.items.map((entry) => {
            if (entry.kind === "automatic-reminder") {
              const { occurrence, project } = entry.row;
              return (
                <button type="button" className="todayItem mutedRow automaticReminder" key={occurrence.id} onClick={() => setSelectedOccurrence(occurrence)} aria-label={`Open reminder for ${occurrence.title}, automatic recurring occurrence`}>
                  <div className="todayItemMain">
                    <div className="min-w-0">
                      <strong className="todayItemTitle">{occurrence.title}</strong>
                      <div className="todayItemMeta">
                        <Badge variant="secondary" className="todayIconBadge todayProjectBadge" title={project.name}><Layers3 />{compactProjectCode(project.name)}</Badge>
                        <Badge variant="outline" className="todayIconBadge" title="Automatic recurring reminder"><RecurrenceModeIcon /></Badge>
                        <Badge variant="outline" className="todayIconBadge" title={formatShortDateTimeInZone(occurrence.start, workspace.timeZone)}><CalendarClock />{formatShortDateTimeInZone(occurrence.start, workspace.timeZone)}</Badge>
                      </div>
                    </div>
                  </div>
                </button>
              );
            }
            const { item, project, gate, warningGate } = entry.row;
            return (
              <article className={cn("todayItem mutedRow", gate && "isLocked")} key={item.workItem.id}>
                <div className="todayItemMain">
                  <div className="min-w-0">
                    <strong className="todayItemTitle">{item.workItem.title}</strong>
                    <div className="todayItemMeta">
                      <Badge variant="secondary" className="todayIconBadge todayProjectBadge" title={project.name}><Layers3 />{compactProjectCode(project.name)}</Badge>
                      {item.isCritical && <Badge variant="destructive" className="todayIconBadge" title="Critical path"><AlertTriangle />CP</Badge>}
                      <Badge variant="outline" className="todayIconBadge" title={formatScheduleRange(item)}><CalendarClock />{formatCompactScheduleRange(item)}</Badge>
                    </div>
                    {gate && <span className="todayInlineAlert dangerText"><Lock size={13} />{gate.reason}</span>}
                    {!gate && warningGate && <span className="todayInlineAlert warnReason"><AlertTriangle size={13} />{warningGate.reason}</span>}
                  </div>
                  {!gate && <InlineActualForm projectId={project.id} item={item.workItem} onRecord={onActualRecord} compact />}
                </div>
              </article>
            );
          }) : <div className="compactEmptyState"><CheckCircle2 />Clear</div>}
          <PaginationControls label="upcoming work" {...upcomingRowsPage} onPageChange={upcomingRowsPage.setPage} />
        </CardContent>
      </Card>
      <Card id="today-blocking-gates" className="lg:col-span-2">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Blocking Gates</CardTitle>
            <Badge variant={gates.some((gate) => activeProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared") ? "destructive" : "success"} className="iconBadge">
              <Lock />{gates.filter((gate) => activeProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared").length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SignalList gates={sortGates(gates.filter((gate) => activeProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared")).slice(0, 8)} />
        </CardContent>
      </Card>
      <AutomaticOccurrenceSheet
        occurrence={selectedOccurrence}
        open={Boolean(selectedOccurrence)}
        onOpenChange={(open) => !open && setSelectedOccurrence(undefined)}
        timeZone={workspace.timeZone}
        currentTime={currentTime}
        resources={workspace.resources}
        historyRecords={workspace.recurringOccurrences}
        ruleChangeSets={workspace.changeSets}
        onOccurrenceSkip={onOccurrenceSkip}
        onOccurrenceReschedule={onOccurrenceReschedule}
        onOccurrenceException={onOccurrenceException}
      />
    </section>
  );
}

function InlineActualForm({
  projectId,
  item,
  onRecord,
  compact = false
}: {
  projectId: string;
  item: WorkItem;
  onRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
  compact?: boolean;
}) {
  const [percentComplete, setPercentComplete] = useState(item.percentComplete);
  const [actualWorkHours, setActualWorkHours] = useState(1);
  useEffect(() => setPercentComplete(item.percentComplete), [item.id, item.percentComplete]);
  return (
    <form
      className={cn("actualQuickForm", compact && "compact")}
      onSubmit={(event) => {
        event.preventDefault();
        onRecord(projectId, item.id, {
          percentComplete,
          actualWorkHours,
          remainingWorkHours: Math.max(0, formatAssignmentHours({ workItem: item } as ScheduledItem) - actualWorkHours),
          actualCost: actualWorkHours,
          markFinished: false
        });
      }}
    >
      <label className="actualMiniField" title="Percent complete">
        <span aria-hidden="true">%</span>
        <Input aria-label="Percent complete" type="number" min={0} max={100} value={percentComplete} onChange={(event) => setPercentComplete(Number(event.target.value) || 0)} />
      </label>
      <label className="actualMiniField" title="Actual hours">
        <Timer aria-hidden="true" />
        <Input aria-label="Actual hours" type="number" min={0} step={0.25} value={actualWorkHours} onChange={(event) => setActualWorkHours(Number(event.target.value) || 0)} />
      </label>
      <Button type="submit" size="icon" variant="outline" aria-label="Save actual" title="Save actual" className="actualIconButton">
        <Save />
      </Button>
      <Button
        type="button"
        size="icon"
        aria-label="Mark done"
        title="Mark done"
        className="actualIconButton"
        onClick={() => onRecord(projectId, item.id, {
          percentComplete: 100,
          actualWorkHours,
          remainingWorkHours: 0,
          actualCost: actualWorkHours,
          markFinished: true
        })}
      >
        <CheckCircle2 />
      </Button>
    </form>
  );
}

function AuditQueue({
  projects,
  schedules,
  gates,
  decisions,
  leveling,
  changeSets,
  onGateClear,
  onAuditDecisionRecord,
  onChangeSetStatus,
  onLevelingApply
}: {
  projects: Project[];
  schedules: ScheduleResult[];
  gates: AuditGate[];
  decisions: ReturnType<typeof recommendAuditDecision>[];
  leveling: ReturnType<typeof generateLevelingProposals>;
  changeSets: ChangeSet[];
  onGateClear: (gate: AuditGate, rationale: string) => void;
  onAuditDecisionRecord: (projectId: string, action: AuditAction, gates: AuditGate[], rationale: string) => void;
  onChangeSetStatus: (changeSetId: string, status: ChangeSet["status"]) => void;
  onLevelingApply: (proposal: ReturnType<typeof generateLevelingProposals>[number]) => void;
}) {
  const activeProjectIds = new Set(projects.filter((project) => !isProjectArchived(project)).map((project) => project.id));
  const hardGates = sortGates(gates.filter((gate) => activeProjectIds.has(gate.projectId) && gate.severity === "hard" && gate.status !== "cleared"));
  const warningGates = sortGates(gates.filter((gate) => activeProjectIds.has(gate.projectId) && gate.severity !== "hard" && gate.status !== "cleared"));
  const activeDecisions = decisions.filter((decision) => activeProjectIds.has(decision.projectId));
  const activeLeveling = leveling.filter((proposal) => activeProjectIds.has(proposal.projectId));
  const workById = new Map(schedules.filter((schedule) => activeProjectIds.has(schedule.projectId)).flatMap((schedule) => schedule.items.map((item) => [item.workItem.id, { item, projectId: schedule.projectId }])));
  const hardGatePage = usePagedItems(hardGates, 6);
  const warningGatePage = usePagedItems(warningGates, 6);
  const decisionPage = usePagedItems(activeDecisions, 6);
  const changeSetPage = usePagedItems(changeSets, 8);
  const levelingPage = usePagedItems(activeLeveling, 8);
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <Card id="hard-gates">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Hard Gates</CardTitle>
            <Badge variant={hardGates.length ? "destructive" : "success"} className="iconBadge" title="Open hard gates"><Lock />{hardGates.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SignalList gates={hardGatePage.items} onClear={onGateClear} compact />
          <PaginationControls label="hard gates" {...hardGatePage} onPageChange={hardGatePage.setPage} />
        </CardContent>
      </Card>
      <Card id="audit-decisions">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> Contrarian Decisions</CardTitle>
            <Badge variant="outline" className="iconBadge" title="Decisions"><Target />{activeDecisions.length}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {decisionPage.items.map((decision) => (
            <article className="decisionCompactRow" key={decision.id}>
              <Badge variant={decision.action === "Stop" || decision.action === "Pivot" || decision.action === "Narrow" ? "destructive" : "secondary"}>{decision.action}</Badge>
              <div className="min-w-0">
                <div className="decisionCompactTitle">
                  <strong className="text-sm">{projects.find((project) => project.id === decision.projectId)?.name}</strong>
                  <span className="decisionReasonIcon" title={decision.strongestStopReason} aria-label={decision.strongestStopReason}>
                    <AlertTriangle size={13} />
                  </span>
                </div>
              </div>
              <AuditDecisionRecorder
                projectId={decision.projectId}
                gates={gates.filter((gate) => gate.projectId === decision.projectId && gate.status !== "cleared")}
                defaultAction={decision.action}
                onRecord={onAuditDecisionRecord}
              />
            </article>
          ))}
          <PaginationControls label="decisions" {...decisionPage} onPageChange={decisionPage.setPage} />
        </CardContent>
      </Card>
      <Card id="audit-warnings">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Warnings</CardTitle>
            <Badge variant={warningGates.length ? "warning" : "success"} className="iconBadge" title="Warnings"><AlertTriangle />{warningGates.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <SignalList gates={warningGatePage.items} onClear={onGateClear} compact />
          <PaginationControls label="warnings" {...warningGatePage} onPageChange={warningGatePage.setPage} />
        </CardContent>
      </Card>
      <Card id="baseline-change-sets">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><Archive className="h-4 w-4" /> Change Sets</CardTitle>
            <div className="cardHeaderBadges">
              <Badge variant="outline" className="iconBadge" title="Total changes"><GitPullRequest />{changeSets.length}</Badge>
              <Badge variant={changeSets.some((item) => item.status === "blocked") ? "destructive" : "success"} className="iconBadge" title="Blocked changes"><Lock />{changeSets.filter((item) => item.status === "blocked").length}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {changeSets.length ? changeSetPage.items.map((changeSet) => (
            <article className="compactSignalRow" key={changeSet.id}>
              <GitPullRequest size={14} className="text-muted-foreground" />
              <div className="compactSignalBody">
                <strong className="text-sm">{changeSet.title}</strong>
                <span className="compactSignalText">{changeSet.reason}</span>
                <Badge variant={changeSet.status === "blocked" ? "destructive" : changeSet.status === "approved" ? "success" : "warning"}>{changeSet.status}</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="icon" variant="outline" aria-label="Approve change set" title="Approve" onClick={() => onChangeSetStatus(changeSet.id, "approved")} disabled={changeSet.status === "approved"}><CheckCircle2 /></Button>
                <Button type="button" size="icon" variant="outline" aria-label="Block change set" title="Block" onClick={() => onChangeSetStatus(changeSet.id, "blocked")} disabled={changeSet.status === "blocked"}><Lock /></Button>
              </div>
            </article>
          )) : <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><CheckCircle2 size={16} />No baseline changes</div>}
          <PaginationControls label="change sets" {...changeSetPage} onPageChange={changeSetPage.setPage} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2" id="leveling-proposals">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Leveling Proposals</CardTitle>
            <Badge variant={activeLeveling.length ? "warning" : "success"} className="iconBadge" title="Leveling proposals"><CalendarClock />{activeLeveling.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <caption className="srOnly">Resource leveling proposals by task, move, reason, and critical path impact</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Move</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Critical impact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {levelingPage.items.map((proposal) => {
                const row = workById.get(proposal.workItemId);
                const project = projects.find((candidate) => candidate.id === proposal.projectId);
                return (
                  <TableRow key={proposal.id}>
                    <TableCell>
                      <strong>{row?.item.workItem.title ?? proposal.workItemId}</strong>
                      <span className="block text-xs text-muted-foreground">{project?.name ?? proposal.projectId}</span>
                    </TableCell>
                    <TableCell>{`${formatShortDateTime(proposal.beforeStart)} -> ${formatShortDateTime(proposal.afterStart)}`}</TableCell>
                    <TableCell>{proposal.reason}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{Math.round(proposal.criticalPathImpactSeconds / 3600)}h</span>
                        <Button type="button" size="sm" variant="outline" onClick={() => onLevelingApply(proposal)}>Apply</Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <PaginationControls label="leveling proposals" {...levelingPage} onPageChange={levelingPage.setPage} />
        </CardContent>
      </Card>
    </section>
  );
}

function AuditDecisionRecorder({
  projectId,
  gates,
  defaultAction,
  onRecord
}: {
  projectId: string;
  gates: AuditGate[];
  defaultAction: AuditAction;
  onRecord: (projectId: string, action: AuditAction, gates: AuditGate[], rationale: string) => void;
}) {
  const [action, setAction] = useState<AuditAction>(defaultAction);
  const [rationale, setRationale] = useState("");
  return (
    <form
      className="auditDecisionForm"
      onSubmit={(event) => {
        event.preventDefault();
        onRecord(projectId, action, gates, rationale);
        setRationale("");
      }}
    >
      <select
        aria-label="Audit action"
        data-testid="audit-action"
        name="audit-action"
        value={action}
        onChange={(event) => setAction(event.target.value as AuditAction)}
      >
        {auditActions.map((item) => (
          <option key={item} value={item}>{item}</option>
        ))}
      </select>
      <Input value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Why" aria-label="Decision rationale" />
      <Button type="submit" size="icon" title="Record decision" aria-label="Record decision">
        <Save />
      </Button>
    </form>
  );
}

function Reports({
  project,
  schedule,
  markdown,
  csv,
  evm,
  p50,
  p90,
  gates,
  baseline
}: {
  project: Project;
  schedule: ScheduleResult;
  markdown: string;
  csv: string;
  evm?: ReturnType<typeof calculateEvm>;
  p50: string;
  p90: string;
  gates: AuditGate[];
  baseline?: Baseline;
}) {
  const openHardGates = gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const reportRowsPage = usePagedItems(schedule.items, 10);
  return (
    <section className="grid gap-3">
      <div className="portfolioHeader">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Reports</h2>
          <div className="compactBadgeRow">
            <Badge variant={evm ? "secondary" : "warning"} className="iconBadge" title="Schedule performance index"><BarChart3 />SPI {evm ? evm.schedulePerformanceIndex.toFixed(2) : "-"}</Badge>
            <Badge variant={evm ? "secondary" : "warning"} className="iconBadge" title="Cost performance index"><BarChart3 />CPI {evm ? evm.costPerformanceIndex.toFixed(2) : "-"}</Badge>
            <Badge variant="outline" className="iconBadge" title="Monte Carlo p50"><Timer />P50 {p50.slice(5, 10)}</Badge>
            <Badge variant={openHardGates.length ? "destructive" : "success"} className="iconBadge" title="Open hard gates"><Lock />{openHardGates.length}</Badge>
          </div>
        </div>
      </div>
      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Report Gate Status</CardTitle>
            <Badge variant={openHardGates.length ? "destructive" : "success"} className="iconBadge" title={openHardGates[0]?.reason ?? "No hard gates"}>{openHardGates.length ? <Lock /> : <CheckCircle2 />}{openHardGates.length ? "blocked" : "clear"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <SummaryTile label="Baseline" value={baseline ? baseline.name : "No baseline"} detail={baseline ? `Captured ${baseline.capturedAt.slice(0, 10)}` : "EVM is blocked."} />
          <SummaryTile label="Monte Carlo p90" value={p90.slice(0, 10)} detail="Seeded local simulation" />
        </CardContent>
      </Card>
      <Card id="scheduler-diagnostics">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Scheduler Diagnostics</CardTitle>
            <Badge variant={schedule.diagnostics.length ? "warning" : "success"} className="iconBadge" title="Scheduler diagnostics"><AlertTriangle />{schedule.diagnostics.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {schedule.diagnostics.length ? (
            <div className="grid gap-1.5">
              {schedule.diagnostics.map((diagnostic, index) => (
                <article className={cn("diagnosticCompactRow", diagnostic.severity === "error" && "danger", diagnostic.severity === "warning" && "warning")} key={`${diagnostic.itemId ?? "portfolio"}-${diagnostic.message}-${index}`}>
                  <div className="diagnosticMeta">
                    <Badge variant={diagnostic.severity === "error" ? "destructive" : diagnostic.severity === "warning" ? "warning" : "secondary"}>{diagnostic.severity}</Badge>
                    {diagnostic.itemId && <Badge variant="outline" title={diagnostic.itemId}>item</Badge>}
                  </div>
                  <p>{diagnostic.message}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <CheckCircle2 size={16} />
              No scheduler diagnostics.
            </div>
          )}
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2"><FileDown className="h-4 w-4" /> {project.name} Markdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(markdown)}>
            <ClipboardCheck size={15} />
            Copy
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadText(`${project.name}-plan.md`, markdown, "text/markdown")}>
            <FileDown size={15} />
            Download
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-50">{markdown}</pre>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2"><Archive className="h-4 w-4" /> Schedule CSV</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(csv)}>
            <ClipboardCheck size={15} />
            Copy
              </Button>
              <Button variant="outline" size="sm" onClick={() => downloadText(`${project.name}-schedule.csv`, csv, "text/csv")}>
            <FileDown size={15} />
            Download
              </Button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-50">{csv}</pre>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Report Rows</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <caption className="srOnly">Scheduled report rows for {project.name}</caption>
            <TableHeader>
              <TableRow>
                <TableHead>Outline</TableHead>
                <TableHead>Task</TableHead>
                <TableHead>Start</TableHead>
                <TableHead>Finish</TableHead>
                <TableHead>Float</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reportRowsPage.items.map((item) => (
                <TableRow key={item.workItem.id}>
                  <TableCell>{item.workItem.outline}</TableCell>
                  <TableCell className="font-medium">{item.workItem.title}</TableCell>
                  <TableCell>{formatShortDateTime(item.start)}</TableCell>
                  <TableCell>{formatShortDateTime(item.finish)}</TableCell>
                  <TableCell>{Math.round(item.totalFloatSeconds / 3600)}h</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PaginationControls label="report rows" {...reportRowsPage} onPageChange={reportRowsPage.setPage} />
        </CardContent>
      </Card>
    </section>
  );
}

type SettingsPanelId = "sync" | "secrets" | "ai-provider" | "workspace";

function AgentCenter({
  workspace,
  schedules,
  gates,
  settings,
  sessionPassphrase,
  onAuditDecisionSave
}: {
  workspace: WorkspaceSnapshot;
  schedules: ScheduleResult[];
  gates: AuditGate[];
  settings: AppSettings;
  sessionPassphrase: string;
  onAuditDecisionSave: (decision: AuditDecision, reason: string) => void;
}) {
  const secretVault = useMemo(() => new BrowserEncryptedSecretVault(), []);
  const auditProjects = workspace.projects.filter((project) => !isProjectArchived(project));
  const [auditProjectId, setAuditProjectId] = useState(() => auditProjects[0]?.id ?? defaultProjectId);
  const [aiBusy, setAiBusy] = useState(false);
  const idleAgentNotice = "No agent action has run yet.";
  const [notice, setNotice] = useState(idleAgentNotice);
  const aiProvider = settings.aiProviders[0] ?? defaultCustomAiProviderSettings;
  const auditProject = auditProjects.find((project) => project.id === auditProjectId) ?? auditProjects[0];
  const auditSchedule = schedules.find((schedule) => schedule.projectId === auditProject?.id) ?? (auditProject ? scheduleShapeUpAwareProject(auditProject, workspace.workItems, workspace.dependencies) : undefined);
  const aiProviderReady = Boolean(aiProvider.baseUrl.trim() && aiProvider.model.trim() && aiProvider.apiKeySecretId);
  const agentProjectId = auditProject?.id ?? defaultProjectId;

  useEffect(() => {
    if (!workspace.projects.some((project) => project.id === auditProjectId && !isProjectArchived(project))) {
      setAuditProjectId(workspace.projects.find((project) => !isProjectArchived(project))?.id ?? defaultProjectId);
    }
  }, [workspace.projects, auditProjectId]);

  const unlockAiProviderKey = async (): Promise<string | undefined> => {
    if (!aiProvider.apiKeySecretId) {
      setNotice("Save an AI provider key in Settings before running AI audit.");
      return undefined;
    }
    if (!sessionPassphrase.trim()) {
      setNotice("Enter the workspace passphrase in Settings > Secrets to unlock the saved AI provider key.");
      return undefined;
    }
    const key = await secretVault.unlock(aiProvider.apiKeySecretId, sessionPassphrase);
    if (!key) setNotice("Could not unlock AI provider key.");
    return key;
  };

  const runAiAudit = async () => {
    if (!auditProject || !auditSchedule) {
      setNotice("Create or select a project before running AI audit.");
      return;
    }
    if (!aiProvider.baseUrl.trim() || !aiProvider.model.trim()) {
      setNotice("Set AI provider Base URL and model in Settings before running audit.");
      return;
    }
    const key = await unlockAiProviderKey();
    if (!key) return;
    setAiBusy(true);
    try {
      const decision = await runContrarianAiAudit({
        provider: aiProvider,
        apiKey: key,
        project: auditProject,
        gates: gates.filter((gate) => gate.projectId === auditProject.id),
        evidence: workspace.evidence.filter((item) => item.projectId === auditProject.id),
        schedule: auditSchedule
      });
      onAuditDecisionSave(decision, `AI audit generated by ${aiProvider.label} / ${aiProvider.model}.`);
      setNotice(`AI audit recorded ${decision.action} for ${auditProject.name}.`);
    } catch (error) {
      setNotice(`AI audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      {notice !== idleAgentNotice && (
        <div className="rounded-lg border bg-background p-3 text-sm font-medium lg:col-span-2">{notice}</div>
      )}

      <Card className="lg:col-span-2">
        <CardHeader className="compactCardHeader">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> Agent</CardTitle>
              <div className="compactBadgeRow">
                <Badge variant="outline" className="iconBadge" title="Read endpoints"><FileText />read</Badge>
                <Badge variant="outline" className="iconBadge" title="Command inbox"><Inbox />write</Badge>
                <Badge variant={aiProviderReady ? "success" : "warning"} className="iconBadge" title="AI provider"><Zap />{aiProviderReady ? "AI" : "AI off"}</Badge>
              </div>
            </div>
            <IconStatusBadge variant="outline" status="No secrets exposed" icon={<Lock />} />
          </div>
        </CardHeader>
        <CardContent className="grid gap-2 md:grid-cols-3">
          <SettingsRow label="Protocol" value="/agent/manual.txt" />
          <SettingsRow label="Portfolio state" value="/agent/projects.txt | .json" />
          <SettingsRow label="Write entry" value="/agent/commands" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><FileDown className="h-4 w-4" /> Read Endpoints</CardTitle>
            <Badge variant="outline" className="iconBadge" title="No secrets exposed"><Lock />safe</Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <IconLinkButton label="Manual" href="/agent/manual.txt"><FileText /></IconLinkButton>
          <IconLinkButton label="Projects text" href="/agent/projects.txt"><FileText /></IconLinkButton>
          <IconLinkButton label="Projects JSON" href="/agent/projects.json"><FileJson /></IconLinkButton>
          <IconLinkButton label="Selected project" href={`/agent/projects/${encodeURIComponent(agentProjectId)}.txt`}><Target /></IconLinkButton>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> Command Inbox</CardTitle>
            <Badge variant="warning" className="iconBadge" title="Guarded writes queue"><ShieldAlert />guard</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <SettingsRow label="Low-risk commands" value="auto-apply" />
            <SettingsRow label="Guarded commands" value="queue gate" />
          </div>
          <IconLinkButton label="Command inbox" href="/agent/commands"><Inbox /></IconLinkButton>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2" id="agent-ai-audit">
        <CardHeader className="compactCardHeader">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> AI Contrarian Audit</CardTitle>
              <div className="compactBadgeRow">
                <Badge variant={aiProviderReady ? "success" : "warning"} className="iconBadge" title="Provider"><Zap />{aiProviderReady ? "provider" : "missing"}</Badge>
                <Badge variant={sessionPassphrase.trim() ? "success" : "warning"} className="iconBadge" title="Passphrase"><KeyRound />{sessionPassphrase.trim() ? "unlocked" : "locked"}</Badge>
              </div>
            </div>
            <IconStatusBadge
              variant={aiProviderReady ? sessionPassphrase.trim() ? "success" : "warning" : "warning"}
              status={aiProviderReady ? sessionPassphrase.trim() ? "Ready" : "Locked" : "Needs provider"}
              icon={aiProviderReady ? sessionPassphrase.trim() ? <CheckCircle2 /> : <Lock /> : <AlertTriangle />}
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_auto]">
          <NativeSelectField
            label="Audit project"
            value={auditProject?.id ?? ""}
            onChange={setAuditProjectId}
            options={auditProjects.map((project) => ({ value: project.id, label: project.name }))}
            testId="ai-audit-project"
            disabled={!auditProjects.length}
          />
          <div className="flex items-end gap-2">
            <IconActionButton label={aiBusy ? "Running AI audit" : "Run AI audit"} type="button" onClick={() => void runAiAudit()} disabled={aiBusy || !aiProviderReady || !auditProject || !auditSchedule}>
              <Play className={aiBusy ? "animate-pulse" : undefined} />
            </IconActionButton>
            <IconLinkButton label="Open settings" href={hashForRoute({ view: "settings", selectedProjectId: agentProjectId })}><SettingsIcon /></IconLinkButton>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground md:col-span-2">
            Sends project direction, open gates, recent evidence summaries, and first schedule rows only.
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function Settings({
  workspace,
  settings,
  onSettingsSave,
  sessionPassphrase,
  onSessionPassphraseChange,
  rememberedPassphraseLoaded,
  rememberedPassphraseSavedAt,
  onRememberPassphrase,
  onForgetRememberedPassphrase,
  autoSyncStatus,
  syncBlockedByExternalChange,
  workspacePersistence,
  onWorkspaceTimeZoneChange,
  onWorkspaceImport,
  onWorkspaceReset,
  onEvidenceImport
}: {
  workspace: WorkspaceSnapshot;
  settings: AppSettings;
  onSettingsSave: (settings: AppSettings) => void;
  sessionPassphrase: string;
  onSessionPassphraseChange: (passphrase: string) => void;
  rememberedPassphraseLoaded: boolean;
  rememberedPassphraseSavedAt?: string;
  onRememberPassphrase: () => Promise<{ savedAt: string }>;
  onForgetRememberedPassphrase: () => Promise<void>;
  autoSyncStatus: AutoSyncStatus;
  syncBlockedByExternalChange: boolean;
  workspacePersistence: { loaded: boolean; status: string; lastSavedAt: string };
  onWorkspaceTimeZoneChange: (timeZone: string) => void;
  onWorkspaceImport: (workspace: WorkspaceSnapshot) => void;
  onWorkspaceReset: () => void;
  onEvidenceImport: (projectId: string, evidenceItems: Evidence[], reason: string) => void;
}) {
  const secretVault = useMemo(() => new BrowserEncryptedSecretVault(), []);
  const workspaceRepository = useMemo(() => new BrowserWorkspaceRepository(), []);
  const workspaceImportRef = useRef<HTMLInputElement>(null);
  const [githubDraft, setGithubDraft] = useState<GitHubSyncSettings>(() => settings.githubSync);
  const [firebaseDraft, setFirebaseDraft] = useState<FirebaseSyncSettings>(() => settings.firebaseSync);
  const [aiDraft, setAiDraft] = useState<AiProviderSettings>(() => settings.aiProviders[0] ?? defaultCustomAiProviderSettings);
  const [githubToken, setGithubToken] = useState("");
  const [aiProviderKey, setAiProviderKey] = useState("");
  const idleSettingsNotice = "No settings action has run yet.";
  const [notice, setNotice] = useState(idleSettingsNotice);
  const [savedSecretCount, setSavedSecretCount] = useState(() => secretVault.listEncrypted().length);
  const [syncBusy, setSyncBusy] = useState(false);
  const evidenceProjects = workspace.projects.filter((project) => !isProjectArchived(project));
  const [evidenceProjectId, setEvidenceProjectId] = useState(() => evidenceProjects[0]?.id ?? defaultProjectId);
  const [evidenceWorkItemId, setEvidenceWorkItemId] = useState<string>("project");
  const [expandedPanels, setExpandedPanels] = useState<Set<SettingsPanelId>>(() => new Set());
  const [workspaceTimeZoneDraft, setWorkspaceTimeZoneDraft] = useState(workspace.timeZone);
  const githubSecret = githubDraft.tokenSecretId ? secretVault.readEncrypted(githubDraft.tokenSecretId) : undefined;
  const aiSecret = aiDraft.apiKeySecretId ? secretVault.readEncrypted(aiDraft.apiKeySecretId) : undefined;
  const gitHubReady = Boolean(githubDraft.owner.trim() && githubDraft.repo.trim() && githubDraft.tokenSecretId);
  const firebaseReady = firebaseSettingsReady(firebaseDraft);
  const evidenceProject = evidenceProjects.find((project) => project.id === evidenceProjectId) ?? evidenceProjects[0];
  const evidenceWorkItems = workspace.workItems.filter((item) => item.projectId === evidenceProject?.id && item.kind !== "phase");
  const rememberedPassphraseStatus = rememberedPassphraseSavedAt
    ? `saved ${rememberedPassphraseSavedAt.slice(0, 19).replace("T", " ")}`
    : rememberedPassphraseLoaded
      ? "not stored"
      : "checking IndexedDB";

  const updateGithubDraft = (patch: Partial<GitHubSyncSettings>) => {
    setGithubDraft((current) => ({ ...current, ...patch }));
  };

  const updateFirebaseDraft = (patch: Partial<FirebaseSyncSettings>) => {
    setFirebaseDraft((current) => ({ ...current, ...patch }));
  };

  const updateAiDraft = (patch: Partial<AiProviderSettings>) => {
    setAiDraft((current) => ({ ...current, ...patch }));
  };

  const rememberPassphrase = async () => {
    try {
      const record = await onRememberPassphrase();
      setNotice(`Workspace passphrase remembered in this browser IndexedDB on ${record.savedAt.slice(0, 19).replace("T", " ")}.`);
    } catch (error) {
      setNotice(`Remember passphrase failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  const forgetPassphrase = async () => {
    try {
      await onForgetRememberedPassphrase();
      setNotice("Remembered workspace passphrase deleted from this browser IndexedDB.");
    } catch (error) {
      setNotice(`Forget passphrase failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  };

  useEffect(() => {
    setFirebaseDraft(settings.firebaseSync);
  }, [
    settings.firebaseSync.projectId,
    settings.firebaseSync.apiKey,
    settings.firebaseSync.databaseId,
    settings.firebaseSync.collectionPath,
    settings.firebaseSync.workspaceId,
    settings.firebaseSync.deviceId
  ]);

  useEffect(() => {
    setFirebaseDraft((current) => ({
      ...current,
      autoSyncEnabled: settings.firebaseSync.autoSyncEnabled,
      autoSyncIntervalSeconds: settings.firebaseSync.autoSyncIntervalSeconds,
      autoPushDebounceSeconds: settings.firebaseSync.autoPushDebounceSeconds,
      lastSyncedRevision: settings.firebaseSync.lastSyncedRevision,
      lastSyncedChecksum: settings.firebaseSync.lastSyncedChecksum,
      lastPulledAt: settings.firebaseSync.lastPulledAt,
      lastPushedAt: settings.firebaseSync.lastPushedAt
    }));
  }, [
    settings.firebaseSync.autoSyncEnabled,
    settings.firebaseSync.autoSyncIntervalSeconds,
    settings.firebaseSync.autoPushDebounceSeconds,
    settings.firebaseSync.lastSyncedRevision,
    settings.firebaseSync.lastSyncedChecksum,
    settings.firebaseSync.lastPulledAt,
    settings.firebaseSync.lastPushedAt
  ]);

  useEffect(() => {
    if (!workspace.projects.some((project) => project.id === evidenceProjectId && !isProjectArchived(project))) {
      setEvidenceProjectId(workspace.projects.find((project) => !isProjectArchived(project))?.id ?? defaultProjectId);
    }
  }, [workspace.projects, evidenceProjectId]);

  useEffect(() => {
    if (
      evidenceWorkItemId !== "project" &&
      !workspace.workItems.some((item) => item.id === evidenceWorkItemId && item.projectId === evidenceProject?.id)
    ) {
      setEvidenceWorkItemId("project");
    }
  }, [workspace.workItems, evidenceProject?.id, evidenceWorkItemId]);

  useEffect(() => {
    setWorkspaceTimeZoneDraft(workspace.timeZone);
  }, [workspace.timeZone]);

  const saveWorkspaceTimeZone = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timeZone = canonicalTimeZone(workspaceTimeZoneDraft);
    if (!timeZone) {
      setNotice("Enter a valid IANA time zone such as Asia/Tokyo or America/New_York.");
      return;
    }
    onWorkspaceTimeZoneChange(timeZone);
    setWorkspaceTimeZoneDraft(timeZone);
    setNotice(`Workspace time zone saved as ${timeZone}. Future automatic occurrences use this time zone; recorded history keeps its original timestamps.`);
  };

  const saveGitHubSync = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timestamp = new Date().toISOString();
    let tokenSecretId = githubDraft.tokenSecretId;

    if (!githubDraft.owner.trim() || !githubDraft.repo.trim()) {
      setNotice("Set GitHub owner and private repo before saving sync.");
      return;
    }

    if (githubToken.trim()) {
      if (!sessionPassphrase.trim()) {
        setNotice("Enter the workspace passphrase before saving a GitHub PAT.");
        return;
      }
      const secret = await encryptProviderSecret("github", "Private Repo Sync PAT", githubToken.trim(), sessionPassphrase, timestamp);
      secretVault.saveEncrypted(secret);
      tokenSecretId = secret.id;
      setGithubToken("");
    }

    const nextGithub = { ...githubDraft, tokenSecretId, updatedAt: timestamp };
    const nextSettings = { ...settings, githubSync: nextGithub };
    onSettingsSave(nextSettings);
    setGithubDraft(nextGithub);
    setSavedSecretCount(secretVault.listEncrypted().length);
    setNotice(tokenSecretId ? "GitHub sync settings saved. PAT is encrypted locally." : "GitHub repo settings saved. Add a PAT before first sync.");
  };

  const saveFirebaseSync = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!firebaseDraft.projectId.trim() || !firebaseDraft.apiKey.trim()) {
      setNotice("Set Firebase Project ID and Web API key before saving sync.");
      return;
    }
    const timestamp = new Date().toISOString();
    const nextFirebase = {
      ...firebaseDraft,
      databaseId: firebaseDraft.databaseId.trim() || "(default)",
      collectionPath: firebaseDraft.collectionPath.trim() || "omniPlanSync",
      workspaceId: firebaseDraft.workspaceId.trim() || "personal",
      deviceId: firebaseDraft.deviceId.trim() || "current-device",
      updatedAt: timestamp
    };
    const nextSettings = { ...settings, firebaseSync: nextFirebase };
    onSettingsSave(nextSettings);
    setFirebaseDraft(nextFirebase);
    setNotice("Firebase E2EE sync settings saved. The API key is transport config; workspace content still requires the passphrase.");
  };

  const saveAiProvider = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timestamp = new Date().toISOString();
    let apiKeySecretId = aiDraft.apiKeySecretId;

    if (!aiDraft.baseUrl.trim() || !aiDraft.model.trim()) {
      setNotice("Set both Base URL and model before saving the AI provider.");
      return;
    }

    if (aiProviderKey.trim()) {
      if (!sessionPassphrase.trim()) {
        setNotice("Enter the workspace passphrase before saving an AI provider key.");
        return;
      }
      const secret = await encryptProviderSecret("custom", `${aiDraft.label} API key`, aiProviderKey.trim(), sessionPassphrase, timestamp);
      secretVault.saveEncrypted(secret);
      apiKeySecretId = secret.id;
      setAiProviderKey("");
    }

    if (!apiKeySecretId) {
      setNotice("Add an AI provider key before saving this provider.");
      return;
    }

    const nextProvider = { ...aiDraft, apiKeySecretId, updatedAt: timestamp };
    const nextSettings = {
      ...settings,
      aiProviders: [nextProvider, ...settings.aiProviders.filter((provider) => provider.id !== nextProvider.id)]
    };
    onSettingsSave(nextSettings);
    setAiDraft(nextProvider);
    setSavedSecretCount(secretVault.listEncrypted().length);
    setNotice("AI provider saved. API key is encrypted locally.");
  };

  const githubConfig = (): GitHubSyncConfig => ({
    owner: githubDraft.owner.trim(),
    repo: githubDraft.repo.trim(),
    branch: githubDraft.branch.trim() || "main",
    rootPath: githubDraft.rootPath.trim() || ".omni-plan",
    workspaceId: githubDraft.workspaceId.trim() || "personal",
    deviceId: githubDraft.deviceId.trim() || "current-device"
  });

  const firebaseConfig = (): FirebaseE2eeSyncConfig => firebaseConfigFromSettings(firebaseDraft);

  const persistFirebaseSyncState = (patch: Partial<FirebaseSyncSettings>) => {
    const nextFirebase = { ...firebaseDraft, ...patch, updatedAt: new Date().toISOString() };
    const nextSettings = { ...settings, firebaseSync: nextFirebase };
    onSettingsSave(nextSettings);
    setFirebaseDraft(nextFirebase);
  };

  const unlockGitHubToken = async (): Promise<string | undefined> => {
    if (!githubDraft.tokenSecretId) {
      setNotice("Save a GitHub PAT before using GitHub sync.");
      return undefined;
    }
    if (!sessionPassphrase.trim()) {
      setNotice("Enter the workspace passphrase to unlock the saved GitHub PAT.");
      return undefined;
    }
    const token = await secretVault.unlock(githubDraft.tokenSecretId, sessionPassphrase);
    if (!token) setNotice("Could not unlock GitHub PAT.");
    return token;
  };

  const testGitHubSync = async () => {
    if (!githubDraft.owner.trim() || !githubDraft.repo.trim()) {
      setNotice("Set GitHub owner and private repo before testing.");
      return;
    }
    const token = await unlockGitHubToken();
    if (!token) return;
    setSyncBusy(true);
    try {
      const config = githubConfig();
      const client = new GitHubPrivateRepoSyncClient(config, token);
      const manifest = await client.readText(buildGitHubSyncPaths(config).manifest);
      setNotice(manifest ? `GitHub connected. Remote manifest found at ${manifest.path}.` : "GitHub connected. Remote manifest does not exist yet.");
    } catch (error) {
      setNotice(`GitHub test failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const testFirebaseSync = async () => {
    if (syncBlockedByExternalChange) {
      setNotice("Another tab changed the workspace or sync settings. Reload this tab before using Firebase controls.");
      return;
    }
    if (!firebaseReady) {
      setNotice("Set Firebase Project ID, Web API key, and Workspace ID before testing.");
      return;
    }
    setNotice("Testing Firebase connection...");
    setSyncBusy(true);
    try {
      const client = new FirebaseE2eeSyncClient(firebaseConfig());
      const session = await client.signInAnonymously();
      const manifest = await client.readManifest(session);
      setNotice(manifest
        ? `Firebase connected. Remote revision ${manifest.latestRevision.slice(0, 12)} updated ${manifest.updatedAt.slice(0, 19).replace("T", " ")}.`
        : "Firebase connected. No remote encrypted workspace exists yet.");
    } catch (error) {
      setNotice(`Firebase test failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const pushFirebaseWorkspace = async () => {
    if (syncBlockedByExternalChange) {
      setNotice("Another tab changed the workspace or sync settings. Reload this tab before pushing to Firebase.");
      return;
    }
    if (!firebaseReady) {
      setNotice("Save Firebase sync settings before pushing.");
      return;
    }
    if (!sessionPassphrase.trim()) {
      setNotice("Enter the workspace passphrase before encrypting the Firebase workspace snapshot.");
      return;
    }
    setNotice("Pushing encrypted workspace to Firebase...");
    setSyncBusy(true);
    try {
      const client = new FirebaseE2eeSyncClient(firebaseConfig());
      const session = await client.signInAnonymously();
      const manifest = await client.readManifest(session);
      if (manifest?.latestRevision && firebaseDraft.lastSyncedRevision && manifest.latestRevision !== firebaseDraft.lastSyncedRevision) {
        setNotice(`Remote Firebase workspace is newer (${manifest.latestRevision.slice(0, 12)}). Pull before pushing from this device.`);
        return;
      }
      if (manifest?.latestRevision && !firebaseDraft.lastSyncedRevision) {
        setNotice("Remote Firebase workspace already exists. Pull it before this device's first push to avoid overwriting another device.");
        return;
      }
      const result = await client.pushWorkspaceSnapshot(workspace, sessionPassphrase, session, manifest);
      const pushedChecksum = await workspacePlaintextChecksum(workspace);
      persistFirebaseSyncState({
        lastSyncedRevision: result.manifest.latestRevision,
        lastSyncedChecksum: pushedChecksum,
        lastPushedAt: result.manifest.updatedAt
      });
      setNotice(`Pushed encrypted workspace to Firebase revision ${result.manifest.latestRevision.slice(0, 12)}.`);
    } catch (error) {
      setNotice(`Firebase push failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const pullFirebaseWorkspace = async () => {
    if (syncBlockedByExternalChange) {
      setNotice("Another tab changed the workspace or sync settings. Reload this tab before pulling from Firebase.");
      return;
    }
    if (!firebaseReady) {
      setNotice("Save Firebase sync settings before pulling.");
      return;
    }
    if (!sessionPassphrase.trim()) {
      setNotice("Enter the workspace passphrase before decrypting the Firebase workspace snapshot.");
      return;
    }
    setNotice("Pulling latest encrypted workspace from Firebase...");
    setSyncBusy(true);
    try {
      const client = new FirebaseE2eeSyncClient(firebaseConfig());
      const session = await client.signInAnonymously();
      const result = await client.pullWorkspaceSnapshot(sessionPassphrase, session);
      onWorkspaceImport(result.workspace);
      const pulledChecksum = await workspacePlaintextChecksum(result.workspace);
      persistFirebaseSyncState({
        lastSyncedRevision: result.manifest.latestRevision,
        lastSyncedChecksum: pulledChecksum,
        lastPulledAt: new Date().toISOString()
      });
      setNotice(`Pulled Firebase workspace revision ${result.manifest.latestRevision.slice(0, 12)} and saved it locally.`);
    } catch (error) {
      setNotice(`Firebase pull failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const importGitHubEvidence = async () => {
    if (!evidenceProject) {
      setNotice("Create or select a project before importing GitHub evidence.");
      return;
    }
    if (!githubDraft.owner.trim() || !githubDraft.repo.trim()) {
      setNotice("Set GitHub owner and private repo before importing PR evidence.");
      return;
    }
    const token = await unlockGitHubToken();
    if (!token) return;
    setSyncBusy(true);
    try {
      const prs = await fetchPullRequestEvidence(githubDraft.owner.trim(), githubDraft.repo.trim(), token);
      const workItemId = evidenceWorkItemId === "project" ? undefined : evidenceWorkItemId;
      const evidenceItems = prs.map((pr) => ({
        ...githubPrToEvidence(evidenceProject.id, workItemId, pr, timestamp()),
        id: `evidence-github-pr-${slugify(evidenceProject.id)}-${pr.number}`
      }));
      onEvidenceImport(evidenceProject.id, evidenceItems, `Imported ${evidenceItems.length} GitHub PR evidence items from ${githubDraft.owner}/${githubDraft.repo}.`);
      setNotice(`Imported ${evidenceItems.length} GitHub PR evidence item${evidenceItems.length === 1 ? "" : "s"} into ${evidenceProject.name}.`);
    } catch (error) {
      setNotice(`GitHub evidence import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const pushLocalChangeSets = async () => {
    if (!workspace.changeSets.length) {
      setNotice("No local ChangeSets to push.");
      return;
    }
    const token = await unlockGitHubToken();
    if (!token) return;
    setSyncBusy(true);
    try {
      const config = githubConfig();
      const client = new GitHubPrivateRepoSyncClient(config, token);
      const paths = buildGitHubSyncPaths(config);
      const manifestFile = await client.readText(paths.manifest);
      const previousManifest = manifestFile ? JSON.parse(manifestFile.content) as SyncManifest : undefined;
      const remoteDeviceHead = previousManifest?.heads[config.deviceId];
      const remoteSequence = remoteDeviceHead?.sequence ?? 0;
      const pendingChangeSets = [...workspace.changeSets]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map((changeSet, index) => ({ changeSet, sequence: index + 1 }))
        .filter(({ changeSet, sequence }) => sequence > remoteSequence && changeSet.status !== "blocked");

      if (!pendingChangeSets.length) {
        setNotice("No new local ChangeSets for this device.");
        return;
      }

      let baseRevision = remoteDeviceHead?.revision ?? previousManifest?.latestRevision ?? "root";
      let latestEnvelope: Awaited<ReturnType<typeof createSyncChangeEnvelope>> | undefined;

      for (const { changeSet, sequence } of pendingChangeSets) {
        const envelope = await createSyncChangeEnvelope(
          changeSet,
          { workspaceId: config.workspaceId, deviceId: config.deviceId },
          sequence,
          baseRevision,
          sessionPassphrase,
          new Date().toISOString()
        );
        const path = buildChangeEnvelopePath(config, envelope);
        const existing = await client.readText(path);
        await client.writeText(path, JSON.stringify(envelope, null, 2), githubSyncCommitMessage(envelope), existing?.sha);
        baseRevision = envelope.revision;
        latestEnvelope = envelope;
      }

      if (latestEnvelope) {
        const manifest = createSyncManifest(config, latestEnvelope, previousManifest);
        const existingManifest = await client.readText(paths.manifest);
        await client.writeText(paths.manifest, JSON.stringify(manifest, null, 2), githubSyncCommitMessage(latestEnvelope), existingManifest?.sha);
      }

      setNotice(`Pushed ${pendingChangeSets.length} local ChangeSet${pendingChangeSets.length === 1 ? "" : "s"} to GitHub.`);
    } catch (error) {
      setNotice(`GitHub push failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setSyncBusy(false);
    }
  };

  const exportWorkspace = () => {
    const payload = workspaceRepository.exportWorkspace(workspace);
    downloadText(`omni-plan-workspace-${new Date().toISOString().slice(0, 10)}.json`, payload, "application/json");
    setNotice("Workspace backup exported.");
  };

  const importWorkspace = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      const imported = workspaceRepository.importWorkspace(await file.text());
      onWorkspaceImport(imported);
      setNotice(`Imported workspace backup from ${file.name}.`);
    } catch (error) {
      setNotice(`Workspace import failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      event.currentTarget.value = "";
    }
  };

  const resetWorkspace = () => {
    if (!window.confirm("Clear the local workspace in this browser? Firebase settings and saved secrets are not removed.")) return;
    onWorkspaceReset();
    setNotice("Local workspace cleared. Firebase settings and saved secrets were kept.");
  };

  const openPanel = (panel: SettingsPanelId) => {
    setExpandedPanels((current) => {
      const next = new Set(current);
      next.add(panel);
      return next;
    });
  };

  const togglePanel = (panel: SettingsPanelId) => {
    setExpandedPanels((current) => {
      const next = new Set(current);
      if (next.has(panel)) {
        next.delete(panel);
      } else {
        next.add(panel);
      }
      return next;
    });
  };

  const syncLocked = firebaseReady && !sessionPassphrase.trim();
  const syncStatus = !firebaseReady
    ? "Needs configuration"
    : syncLocked
      ? "Locked"
      : autoSyncStatus.state === "error" || autoSyncStatus.state === "conflict"
        ? "Needs review"
        : "Ready";
  const syncPrimaryLabel = syncBlockedByExternalChange
    ? "Reload"
    : !firebaseReady
      ? "Configure sync"
      : syncLocked
        ? "Unlock"
        : syncBusy
          ? "Syncing"
          : "Sync now";
  const syncBadgeVariant = syncStatus === "Ready" ? "success" : syncStatus === "Needs review" ? "destructive" : "warning";
  const syncStatusIcon = syncStatus === "Ready" ? <CheckCircle2 /> : syncStatus === "Locked" ? <Lock /> : <AlertTriangle />;
  const syncPrimaryIcon = syncBlockedByExternalChange
    ? <RefreshCw />
    : !firebaseReady
      ? <SettingsIcon />
      : syncLocked
        ? <KeyRound />
        : <RefreshCw className={syncBusy ? "animate-spin" : undefined} />;

  const hasSecretDependency = savedSecretCount > 0 || firebaseReady || Boolean(aiDraft.apiKeySecretId || githubDraft.tokenSecretId);
  const secretsStatus = sessionPassphrase.trim() ? "Unlocked" : hasSecretDependency ? "Locked" : "No saved secrets";
  const secretsPrimaryLabel = sessionPassphrase.trim()
    ? rememberedPassphraseSavedAt ? "Manage" : "Remember"
    : secretsStatus === "No saved secrets" ? "Manage" : "Unlock";
  const secretsBadgeVariant = secretsStatus === "Unlocked" ? "success" : secretsStatus === "Locked" ? "warning" : "secondary";
  const secretsStatusIcon = secretsStatus === "Unlocked" ? <CheckCircle2 /> : secretsStatus === "Locked" ? <Lock /> : <KeyRound />;
  const secretsPrimaryIcon = secretsPrimaryLabel === "Remember" ? <Save /> : secretsPrimaryLabel === "Unlock" ? <KeyRound /> : <SettingsIcon />;

  const aiProviderConfigured = Boolean(aiDraft.baseUrl.trim() && aiDraft.model.trim() && aiDraft.apiKeySecretId);
  const aiProviderLocked = aiProviderConfigured && !sessionPassphrase.trim();
  const aiProviderStatus = !aiProviderConfigured ? "Needs provider" : aiProviderLocked ? "Locked" : "Ready";
  const aiProviderBadgeVariant = aiProviderStatus === "Ready" ? "success" : "warning";
  const aiProviderPrimaryLabel = aiProviderLocked ? "Unlock" : "Configure provider";
  const aiProviderStatusIcon = aiProviderStatus === "Ready" ? <CheckCircle2 /> : aiProviderStatus === "Locked" ? <Lock /> : <AlertTriangle />;
  const aiProviderPrimaryIcon = aiProviderLocked ? <KeyRound /> : <SettingsIcon />;

  const workspaceStatus = workspacePersistence.status.toLowerCase().includes("failed")
    ? "Storage issue"
    : workspacePersistence.loaded
      ? "Saved locally"
      : "Loading";
  const workspaceBadgeVariant = workspaceStatus === "Storage issue" ? "destructive" : workspaceStatus === "Saved locally" ? "success" : "warning";
  const workspaceStatusIcon = workspaceStatus === "Saved locally" ? <CheckCircle2 /> : workspaceStatus === "Loading" ? <RefreshCw className="animate-spin" /> : <AlertTriangle />;

  const hasSettingsNotice = notice !== idleSettingsNotice;
  const settingsNoticeTone = noticeTone(notice);

  return (
    <>
      {hasSettingsNotice && <SettingsToast message={notice} tone={settingsNoticeTone} />}
      <section className="grid gap-4 lg:grid-cols-2">
        {hasSettingsNotice && (
          <div className={cn("rounded-lg border p-3 text-sm font-medium lg:col-span-2", noticeBannerClassName(settingsNoticeTone))}>{notice}</div>
        )}

      <SettingsOverviewCard
        icon={<Lock className="h-4 w-4" />}
        title="Sync"
        status={syncStatus}
        statusIcon={syncStatusIcon}
        description={autoSyncStatus.message}
        badgeVariant={syncBadgeVariant}
        primaryActionLabel={syncPrimaryLabel}
        primaryActionIcon={syncPrimaryIcon}
        primaryDisabled={syncBusy}
        onPrimaryAction={() => {
          if (syncBlockedByExternalChange) {
            window.location.reload();
          } else if (!firebaseReady) {
            openPanel("sync");
          } else if (syncLocked) {
            openPanel("secrets");
          } else {
            void pushFirebaseWorkspace();
          }
        }}
        expanded={expandedPanels.has("sync")}
        onToggle={() => togglePanel("sync")}
      >
        <div className="grid gap-4">
          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Firebase Workspace Sync</h3>
              <Badge variant={firebaseReady ? "success" : "warning"}>{firebaseReady ? "Ready" : "Needs Firebase config"}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <SettingsRow label="Workspace" value={firebaseDraft.workspaceId || "personal"} />
              <SettingsRow label="Device" value={firebaseDraft.deviceId || "current-device"} />
              <SettingsRow label="Auto sync" value={firebaseDraft.autoSyncEnabled ? (sessionPassphrase ? "enabled and unlocked" : "enabled, locked") : "off"} />
              <SettingsRow label="Last push / pull" value={`${firebaseDraft.lastPushedAt ? firebaseDraft.lastPushedAt.slice(0, 19).replace("T", " ") : "never"} / ${firebaseDraft.lastPulledAt ? firebaseDraft.lastPulledAt.slice(0, 19).replace("T", " ") : "never"}`} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void testFirebaseSync()} disabled={syncBusy || !firebaseReady || syncBlockedByExternalChange}>Test Firebase</Button>
              <Button type="button" variant="outline" onClick={() => void pullFirebaseWorkspace()} disabled={syncBusy || !firebaseReady || syncBlockedByExternalChange}>Pull latest workspace</Button>
              <Button type="button" onClick={() => void pushFirebaseWorkspace()} disabled={syncBusy || !firebaseReady || syncBlockedByExternalChange}>Push encrypted workspace</Button>
              <Badge variant="outline">{firebaseE2eeSyncStatus.conflictPolicy}</Badge>
            </div>
            <form className="mt-4 space-y-4 rounded-lg border bg-background p-3" onSubmit={saveFirebaseSync}>
              <div className="grid gap-3 md:grid-cols-3">
                <SettingsInput label="Firebase Project ID" name="firebase-project-id" value={firebaseDraft.projectId} onChange={(value) => updateFirebaseDraft({ projectId: value })} placeholder="my-firebase-project" autoComplete="off" />
                <SettingsInput label="Web API key" name="firebase-api-key" value={firebaseDraft.apiKey} onChange={(value) => updateFirebaseDraft({ apiKey: value })} placeholder="AIza..." autoComplete="off" />
                <SettingsInput label="Database ID" name="firebase-database-id" value={firebaseDraft.databaseId} onChange={(value) => updateFirebaseDraft({ databaseId: value })} placeholder="(default)" autoComplete="off" />
                <SettingsInput label="Collection path" name="firebase-collection-path" value={firebaseDraft.collectionPath} onChange={(value) => updateFirebaseDraft({ collectionPath: value })} placeholder="omniPlanSync" autoComplete="off" />
                <SettingsInput label="Workspace ID" name="firebase-workspace-id" value={firebaseDraft.workspaceId} onChange={(value) => updateFirebaseDraft({ workspaceId: value })} placeholder="personal" autoComplete="off" />
                <SettingsInput label="Device ID" name="firebase-device-id" value={firebaseDraft.deviceId} onChange={(value) => updateFirebaseDraft({ deviceId: value })} placeholder="macbook-pro" autoComplete="off" />
                <SettingsInput label="Poll interval seconds" name="firebase-auto-interval" value={String(firebaseDraft.autoSyncIntervalSeconds || 45)} onChange={(value) => updateFirebaseDraft({ autoSyncIntervalSeconds: Math.max(15, Math.round(Number(value) || 45)) })} placeholder="45" autoComplete="off" />
                <SettingsInput label="Push debounce seconds" name="firebase-auto-debounce" value={String(firebaseDraft.autoPushDebounceSeconds || 8)} onChange={(value) => updateFirebaseDraft({ autoPushDebounceSeconds: Math.max(3, Math.round(Number(value) || 8)) })} placeholder="8" autoComplete="off" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex min-h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={firebaseDraft.autoSyncEnabled}
                    onChange={(event) => updateFirebaseDraft({ autoSyncEnabled: event.target.checked })}
                    aria-label="Enable Firebase auto sync"
                  />
                  Auto sync
                </label>
                <Button type="submit">Save Firebase sync</Button>
                <Badge variant="outline">Passphrase stays local</Badge>
              </div>
            </form>
          </div>

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">GitHub ChangeSets and Evidence</h3>
              <Badge variant={gitHubReady ? "success" : "warning"}>{gitHubReady ? "Ready" : "Needs repo and PAT"}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <SettingsRow label="Remote repo" value={githubDraft.owner && githubDraft.repo ? `${githubDraft.owner}/${githubDraft.repo}` : "not configured"} />
              <SettingsRow label="Repo root" value={githubDraft.rootPath || ".omni-plan"} />
              <SettingsRow label="PAT" value={providerSecretSummary(githubSecret)} />
              <SettingsRow label="Local ChangeSets" value={String(workspace.changeSets.length)} />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void testGitHubSync()} disabled={syncBusy}>Test GitHub access</Button>
              <Button type="button" onClick={() => void pushLocalChangeSets()} disabled={syncBusy || !workspace.changeSets.length}>Push local ChangeSets</Button>
              <Badge variant="outline">{githubPrivateRepoSyncStatus.conflictPolicy}</Badge>
            </div>
            <form className="mt-4 space-y-4 rounded-lg border bg-background p-3" onSubmit={saveGitHubSync}>
              <div className="grid gap-3 md:grid-cols-3">
                <SettingsInput label="Owner" name="github-owner" value={githubDraft.owner} onChange={(value) => updateGithubDraft({ owner: value })} placeholder="your-github-org" autoComplete="organization" />
                <SettingsInput label="Private repo" name="github-repo" value={githubDraft.repo} onChange={(value) => updateGithubDraft({ repo: value })} placeholder="omni-plan-sync" autoComplete="off" />
                <SettingsInput label="Branch" name="github-branch" value={githubDraft.branch} onChange={(value) => updateGithubDraft({ branch: value })} placeholder="main" autoComplete="off" />
                <SettingsInput label="Repo root" name="github-root-path" value={githubDraft.rootPath} onChange={(value) => updateGithubDraft({ rootPath: value })} placeholder=".omni-plan" autoComplete="off" />
                <SettingsInput label="Workspace ID" name="github-workspace-id" value={githubDraft.workspaceId} onChange={(value) => updateGithubDraft({ workspaceId: value })} placeholder="personal" autoComplete="off" />
                <SettingsInput label="Device ID" name="github-device-id" value={githubDraft.deviceId} onChange={(value) => updateGithubDraft({ deviceId: value })} placeholder="macbook-pro" autoComplete="off" />
              </div>
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="block">
                  <span className="text-sm font-medium">GitHub fine-grained PAT</span>
                  <Input
                    className="mt-2"
                    type="password"
                    name="github-sync-token"
                    autoComplete="current-password"
                    value={githubToken}
                    onChange={(event) => setGithubToken(event.target.value)}
                    placeholder="github_pat_..."
                    aria-label="GitHub fine-grained PAT"
                  />
                </label>
                <div className="rounded-lg border bg-background p-3 text-sm">
                  <div className="font-semibold">PAT</div>
                  <div className="text-muted-foreground">{providerSecretSummary(githubSecret)}</div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit">Save GitHub sync</Button>
                <Badge variant="outline">Contents read/write</Badge>
                <Badge variant="outline">Private repo only</Badge>
              </div>
            </form>
            <div className="mt-4 grid gap-3 rounded-lg border bg-background p-3 md:grid-cols-[1fr_1fr_auto]">
              <NativeSelectField
                label="Evidence project"
                value={evidenceProject?.id ?? ""}
                onChange={setEvidenceProjectId}
                options={evidenceProjects.map((project) => ({ value: project.id, label: project.name }))}
                testId="github-evidence-project"
                disabled={!evidenceProjects.length}
              />
              <NativeSelectField
                label="Link to work item"
                value={evidenceWorkItemId}
                onChange={setEvidenceWorkItemId}
                options={[{ value: "project", label: "Project-level" }, ...evidenceWorkItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
                testId="github-evidence-work-item"
              />
              <div className="flex items-end">
                <Button type="button" onClick={() => void importGitHubEvidence()} disabled={syncBusy || !gitHubReady || !evidenceProject}>Import PR evidence</Button>
              </div>
            </div>
          </div>
        </div>
      </SettingsOverviewCard>

      <SettingsOverviewCard
        icon={<KeyRound className="h-4 w-4" />}
        title="Secrets"
        status={secretsStatus}
        statusIcon={secretsStatusIcon}
        description={sessionPassphrase.trim() ? "Workspace passphrase entered for this browser session" : "Enter the workspace passphrase here before syncing"}
        badgeVariant={secretsBadgeVariant}
        primaryActionLabel={secretsPrimaryLabel}
        primaryActionIcon={secretsPrimaryIcon}
        onPrimaryAction={() => {
          if (secretsPrimaryLabel === "Remember") {
            void rememberPassphrase();
          } else {
            openPanel("secrets");
          }
        }}
        expanded={expandedPanels.has("secrets")}
        onToggle={() => togglePanel("secrets")}
      >
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <SettingsRow label="Input source" value={browserSecretVaultStatus.inputSource} />
            <SettingsRow label="Local protection" value={browserSecretVaultStatus.localProtection} />
            <SettingsRow label="Passphrase" value={browserSecretVaultStatus.passphrasePolicy} />
            <SettingsRow label="Remembered passphrase" value={rememberedPassphraseStatus} />
            <SettingsRow label="Secret sync" value={browserSecretVaultStatus.syncPolicy} />
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="text-sm font-medium">Workspace passphrase</span>
              <Input
                className="mt-2"
                type="password"
                name="workspace-passphrase"
                autoComplete="current-password"
                value={sessionPassphrase}
                onChange={(event) => onSessionPassphraseChange(event.target.value)}
                placeholder="Set or enter workspace passphrase"
                aria-label="Workspace passphrase"
              />
            </label>
            <div className="rounded-lg border bg-background p-3 text-sm">
              <div className="font-semibold">{savedSecretCount} encrypted secrets</div>
              <div className="text-muted-foreground">stored only in this browser</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void rememberPassphrase()} disabled={!sessionPassphrase.trim()}>
              <KeyRound size={15} />
              Remember in IndexedDB
            </Button>
            <Button type="button" variant="outline" onClick={() => void forgetPassphrase()} disabled={!rememberedPassphraseSavedAt}>
              <Lock size={15} />
              Forget remembered passphrase
            </Button>
            <Badge variant="outline">This browser only</Badge>
          </div>
        </div>
      </SettingsOverviewCard>

      <SettingsOverviewCard
        icon={<Zap className="h-4 w-4" />}
        title="AI Provider"
        status={aiProviderStatus}
        statusIcon={aiProviderStatusIcon}
        description={aiProviderConfigured ? `${aiDraft.label} / ${aiDraft.model}` : "OpenAI-compatible provider not ready"}
        badgeVariant={aiProviderBadgeVariant}
        primaryActionLabel={aiProviderPrimaryLabel}
        primaryActionIcon={aiProviderPrimaryIcon}
        onPrimaryAction={() => {
          if (aiProviderLocked) {
            openPanel("secrets");
          } else {
            openPanel("ai-provider");
          }
        }}
        expanded={expandedPanels.has("ai-provider")}
        onToggle={() => togglePanel("ai-provider")}
      >
        <form className="space-y-4" onSubmit={saveAiProvider}>
          <div className="grid gap-3 md:grid-cols-3">
            <SettingsInput label="Provider label" name="ai-provider-label" value={aiDraft.label} onChange={(value) => updateAiDraft({ label: value })} placeholder="My OpenAI-compatible provider" autoComplete="organization-title" />
            <SettingsInput label="Base URL" name="ai-provider-base-url" value={aiDraft.baseUrl} onChange={(value) => updateAiDraft({ baseUrl: value })} placeholder="https://api.example.com/v1" autoComplete="url" />
            <SettingsInput label="Model" name="ai-provider-model" value={aiDraft.model} onChange={(value) => updateAiDraft({ model: value })} placeholder="gpt-4.1-compatible" autoComplete="off" />
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="text-sm font-medium">API key</span>
              <Input
                className="mt-2"
                type="password"
                name="ai-provider-key"
                autoComplete="current-password"
                value={aiProviderKey}
                onChange={(event) => setAiProviderKey(event.target.value)}
                placeholder="sk-... / provider key"
                aria-label="AI provider API key"
              />
            </label>
            <div className="rounded-lg border bg-background p-3 text-sm">
              <div className="font-semibold">API key</div>
              <div className="text-muted-foreground">{providerSecretSummary(aiSecret)}</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">Save AI provider</Button>
            <IconLinkButton label="Open Agent" href={hashForRoute({ view: "agent", selectedProjectId: workspace.projects[0]?.id ?? defaultProjectId })}><ClipboardCheck /></IconLinkButton>
            <Badge variant="outline">OpenAI-compatible</Badge>
          </div>
        </form>
      </SettingsOverviewCard>

      <SettingsOverviewCard
        icon={<Archive className="h-4 w-4" />}
        title="Workspace"
        status={workspaceStatus}
        statusIcon={workspaceStatusIcon}
        description={workspacePersistence.lastSavedAt ? `Last saved ${workspacePersistence.lastSavedAt.slice(0, 19).replace("T", " ")}` : workspacePersistence.status}
        badgeVariant={workspaceBadgeVariant}
        primaryActionLabel="Export backup"
        primaryActionIcon={<FileDown />}
        onPrimaryAction={exportWorkspace}
        expanded={expandedPanels.has("workspace")}
        onToggle={() => togglePanel("workspace")}
      >
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <SettingsRow label="Engine" value={browserWorkspaceStorageStatus.engine} />
            <SettingsRow label="Source of truth" value={browserWorkspaceStorageStatus.sourceOfTruth} />
            <SettingsRow label="Persistence" value={workspacePersistence.status} />
            <SettingsRow label="Last saved" value={workspacePersistence.lastSavedAt ? workspacePersistence.lastSavedAt.slice(0, 19).replace("T", " ") : "pending"} />
          </div>
          <form className="grid gap-3 rounded-lg border bg-background p-3 md:grid-cols-[1fr_auto]" onSubmit={saveWorkspaceTimeZone}>
            <SettingsInput
              label="Workspace time zone"
              name="workspace-time-zone"
              value={workspaceTimeZoneDraft}
              onChange={setWorkspaceTimeZoneDraft}
              placeholder="Asia/Tokyo"
              autoComplete="off"
            />
            <div className="flex items-end">
              <Button type="submit">Save time zone</Button>
            </div>
            <p className="text-sm text-muted-foreground md:col-span-2">Automatic schedules follow this time zone. Existing occurrence history remains fixed to its recorded timestamps.</p>
          </form>
          <div className="flex flex-wrap gap-2">
            <IconActionButton label="Import backup" type="button" variant="outline" onClick={() => workspaceImportRef.current?.click()}>
              <Upload />
            </IconActionButton>
            <IconActionButton label="Reset local workspace" type="button" variant="destructive" onClick={resetWorkspace}>
              <AlertTriangle />
            </IconActionButton>
            <input
              ref={workspaceImportRef}
              className="srOnly"
              type="file"
              accept="application/json,.json,.omni-plan"
              onChange={(event) => void importWorkspace(event)}
              aria-label="Import workspace backup"
            />
          </div>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">{browserWorkspaceStorageStatus.backupPolicy}</p>
        </div>
      </SettingsOverviewCard>
      </section>
    </>
  );
}

type NoticeTone = "success" | "warning" | "danger" | "loading" | "neutral";

function noticeTone(message: string): NoticeTone {
  const normalized = message.toLowerCase();
  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("newer") || normalized.includes("conflict")) return "danger";
  if (normalized.includes("testing") || normalized.includes("pushing") || normalized.includes("pulling") || normalized.includes("importing")) return "loading";
  if (normalized.startsWith("enter ") || normalized.startsWith("set ") || normalized.startsWith("save ") || normalized.includes("before ")) return "warning";
  if (normalized.includes("connected") || normalized.includes("saved") || normalized.includes("pushed") || normalized.includes("pulled") || normalized.includes("remembered")) return "success";
  return "neutral";
}

function noticeBannerClassName(tone: NoticeTone) {
  switch (tone) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-950";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-950";
    case "danger":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "loading":
      return "border-primary/20 bg-primary/10 text-foreground";
    case "neutral":
      return "bg-background";
  }
}

function SettingsToast({ message, tone }: { message: string; tone: NoticeTone }) {
  const icon = tone === "success"
    ? <CheckCircle2 />
    : tone === "danger"
      ? <AlertTriangle />
      : tone === "loading"
        ? <RefreshCw className="animate-spin" />
        : tone === "warning"
          ? <AlertTriangle />
          : <SettingsIcon />;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-x-4 bottom-20 z-50 flex items-start gap-3 rounded-lg border bg-background p-3 text-sm font-medium shadow-lg lg:inset-x-auto lg:bottom-6 lg:right-6 lg:w-[min(420px,calc(100vw-3rem))]",
        noticeBannerClassName(tone)
      )}
      role={tone === "danger" ? "alert" : "status"}
      aria-live={tone === "danger" ? "assertive" : "polite"}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
      <span className="min-w-0">{message}</span>
    </div>
  );
}

function SettingsOverviewCard({
  icon,
  title,
  status,
  statusIcon,
  description,
  badgeVariant,
  primaryActionLabel,
  primaryActionIcon,
  primaryDisabled,
  onPrimaryAction,
  expanded,
  onToggle,
  children
}: {
  icon: ReactNode;
  title: string;
  status: string;
  statusIcon: ReactNode;
  description: string;
  badgeVariant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success";
  primaryActionLabel: string;
  primaryActionIcon: ReactNode;
  primaryDisabled?: boolean;
  onPrimaryAction: () => void;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="compactCardHeader">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <CardTitle className="flex items-center gap-2" title={description}>{icon}{title}</CardTitle>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <IconStatusBadge variant={badgeVariant} status={status} icon={statusIcon} />
            <IconActionButton label={primaryActionLabel} type="button" onClick={onPrimaryAction} disabled={primaryDisabled}>
              {primaryActionIcon}
            </IconActionButton>
            <IconActionButton
              label={expanded ? "Hide configure" : "Configure"}
              type="button"
              variant="outline"
              onClick={onToggle}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronUp /> : <ChevronDown />}
            </IconActionButton>
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="border-t pt-4">
          {children}
        </CardContent>
      )}
    </Card>
  );
}

function IconStatusBadge({
  variant,
  status,
  icon,
  className
}: {
  variant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success";
  status: string;
  icon: ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant={variant}
      role="status"
      aria-label={status}
      title={status}
      className={cn("h-8 w-8 justify-center rounded-md p-0 [&_svg]:h-4 [&_svg]:w-4", className)}
    >
      {icon}
    </Badge>
  );
}

function IconActionButton({
  label,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Button> & {
  label: string;
}) {
  return (
    <Button {...props} size="icon" aria-label={label} title={label} className={cn("shrink-0", className)}>
      {children}
    </Button>
  );
}

function IconLinkButton({
  label,
  href,
  children,
  variant = "outline"
}: {
  label: string;
  href: string;
  children: ReactNode;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  return (
    <Button asChild variant={variant} size="icon" title={label}>
      <a href={href} aria-label={label}>
        {children}
      </a>
    </Button>
  );
}

function ActionCard({
  icon,
  label,
  title,
  detail,
  meta,
  href,
  tone = "neutral"
}: {
  icon: ReactNode;
  label: string;
  title: string;
  detail?: string;
  meta: string;
  href: string;
  tone?: "neutral" | "danger" | "warning";
}) {
  return (
    <a
      className={cn(
        "actionCard",
        tone === "danger" && "border-destructive/40 bg-destructive/5",
        tone === "warning" && "border-amber-300 bg-amber-50/60"
      )}
      href={href}
    >
      <div>
        <div className="actionCardLabel">{icon}{label}</div>
        <div className="actionCardTitle">{title}</div>
        {detail && <p className="actionCardDetail">{detail}</p>}
      </div>
      <div className="actionCardFooter">
        <Badge variant={tone === "danger" ? "destructive" : tone === "warning" ? "warning" : "secondary"}>{meta}</Badge>
        <span className="actionCardOpen" aria-hidden="true"><PanelRight /></span>
      </div>
    </a>
  );
}

function SummaryTile({
  label,
  value,
  detail,
  tone = "default",
  onClick,
  ariaLabel
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "danger" | "warning";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const longValue = value.length > 24;
  const content = (
    <>
      <div className="summaryTileHead">
        <span>{label}</span>
        {!longValue && <Badge variant={tone === "danger" ? "destructive" : tone === "warning" ? "warning" : "secondary"}>{value}</Badge>}
      </div>
      {longValue && <strong className="summaryTileValue" title={value}>{value}</strong>}
      {detail && <p>{detail}</p>}
    </>
  );
  const className = cn("summaryTile", tone === "danger" && "danger", tone === "warning" && "warning", onClick && "summaryTileButton");
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick} aria-label={ariaLabel ?? `${label}: ${value}`}>
        {content}
      </button>
    );
  }
  return (
    <div className={className}>
      {content}
    </div>
  );
}

function PaginationControls({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  label
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  label: string;
}) {
  if (total <= pageSize) return null;
  const start = page * pageSize + 1;
  const end = Math.min(total, start + pageSize - 1);
  return (
    <div className="paginationControls" aria-label={`${label} pagination`}>
      <span>{start}-{end} / {total}</span>
      <div>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Previous ${label} page`}
          title="Previous page"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page <= 0}
        >
          <ChevronLeft />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label={`Next ${label} page`}
          title="Next page"
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          disabled={page >= pageCount - 1}
        >
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <strong className="max-w-full break-words text-right text-sm font-semibold">{value}</strong>
    </div>
  );
}

function SettingsInput({
  label,
  name,
  value,
  onChange,
  placeholder,
  autoComplete,
  testId,
  type = "text",
  required = false,
  invalid = false,
  describedBy
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: string;
  testId?: string;
  type?: React.HTMLInputTypeAttribute;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <Input
        className="mt-2"
        type={type}
        name={name}
        value={value}
        onInput={handleInput}
        onChange={handleInput}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        required={required}
        data-testid={testId}
      />
    </label>
  );
}

function NativeSelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  testId,
  disabled = false
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <select
        className="mt-2 flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        name={testId ?? label.toLowerCase().replace(/\s+/g, "-")}
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function FormTextarea({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <textarea
        className="mt-2 min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function ToggleField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  const evidencePage = usePagedItems(evidence, 6);
  if (!evidence.length) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No evidence linked yet.</div>;
  }
  return (
    <div className="space-y-2">
      {evidencePage.items.map((item) => (
        <div key={item.id} className="rounded-lg border bg-background p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{item.kind}</Badge>
            <span className="text-xs text-muted-foreground">{item.createdAt.slice(0, 10)}</span>
            <span className="text-xs text-muted-foreground">confidence {Math.round(item.confidence * 100)}%</span>
          </div>
          <p className="mt-2 text-sm font-medium">{item.summary}</p>
          {item.url && (
            <a className="mt-2 block break-all text-xs font-medium text-primary underline-offset-4 hover:underline" href={item.url} target="_blank" rel="noreferrer">
              {item.url}
            </a>
          )}
          <div className="mt-2 flex flex-wrap gap-1">
            {item.tags.map((tag) => <Badge key={tag} variant="secondary">{tag}</Badge>)}
          </div>
        </div>
      ))}
      <PaginationControls label="evidence" {...evidencePage} onPageChange={evidencePage.setPage} />
    </div>
  );
}

function BaselineTable({ baseline, items }: { baseline?: Baseline; items: ScheduledItem[] }) {
  const itemPage = usePagedItems(items, 10);
  if (!baseline) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No plan snapshot captured. This is optional and does not block marking the project done.</div>;
  }
  return (
    <div className="grid gap-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>WBS</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Baseline start</TableHead>
            <TableHead>Baseline finish</TableHead>
            <TableHead>Work</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {itemPage.items.map((item) => (
            <TableRow key={item.workItem.id}>
              <TableCell>{item.workItem.outline}</TableCell>
              <TableCell className="font-medium">{item.workItem.title}</TableCell>
              <TableCell>{baseline.plannedStartByItem[item.workItem.id]?.slice(0, 10) ?? "-"}</TableCell>
              <TableCell>{baseline.plannedFinishByItem[item.workItem.id]?.slice(0, 10) ?? "-"}</TableCell>
              <TableCell>{Math.round((baseline.plannedWorkSecondsByItem[item.workItem.id] ?? 0) / 3600)}h</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <PaginationControls label="baseline rows" {...itemPage} onPageChange={itemPage.setPage} />
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone,
  detail,
  href,
  onClick
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  tone?: "ok" | "warn" | "danger";
  detail?: string;
  href?: string;
  onClick?: () => void;
}) {
  const toneClass = tone === "danger" ? "border-destructive/35 bg-destructive/5" : tone === "warn" ? "border-amber-300 bg-amber-50/60" : tone === "ok" ? "border-emerald-200 bg-emerald-50/60" : "";
  const content = (
    <>
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</div>
      <div className="min-w-0">
        <span className="block text-xs font-medium text-muted-foreground">{label}</span>
        <strong className="block text-2xl font-semibold leading-tight">{value}</strong>
        {detail && <em className="block truncate text-xs not-italic text-muted-foreground">{detail}</em>}
      </div>
    </>
  );

  if (href) {
    return (
      <a className={cn("flex min-h-20 items-center gap-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm transition hover:bg-accent/45 hover:shadow-md", toneClass)} href={href} aria-label={`${label}: ${value}. ${detail ?? "Open detail"}`}>
        {content}
      </a>
    );
  }

  if (onClick) {
    return (
      <button className={cn("flex min-h-20 w-full items-center gap-3 rounded-lg border bg-card p-4 text-left text-card-foreground shadow-sm transition hover:bg-accent/45 hover:shadow-md", toneClass)} onClick={onClick} aria-label={`${label}: ${value}. ${detail ?? "Open detail"}`}>
        {content}
      </button>
    );
  }

  return (
    <div className={cn("flex min-h-20 items-center gap-3 rounded-lg border bg-card p-4 shadow-sm", toneClass)}>
      {content}
    </div>
  );
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="sectionTitle">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function nextScheduledItem(items: ScheduledItem[]) {
  return items
    .filter((item) => item.workItem.kind !== "phase" && item.workItem.percentComplete < 100)
    .sort((a, b) => Number(b.isCritical) - Number(a.isCritical) || a.start.localeCompare(b.start))[0];
}

function formatFreshness(days?: number) {
  if (days === undefined || days >= 900) return "No evidence";
  if (days < 1) return "Today";
  const rounded = Math.round(days);
  return `${rounded}d old`;
}

function evidenceFreshnessScore(days?: number) {
  if (days === undefined || days >= 900) return 100;
  return Math.max(0, Math.min(100, Math.round((days / 10) * 100)));
}

function focusAction(health: ReturnType<typeof calculateProjectHealth>, status: Project["status"]) {
  if (health.openHardGates > 0 || health.riskScore >= 70) return "Narrow";
  if (health.momentumScore >= 70 && health.riskScore < 55) return "Accelerate";
  if (status === "waiting") return "Park";
  return "Continue";
}

function formatShortDateTime(iso: string) {
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

function formatShortDateTimeInZone(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone
  }).format(new Date(iso));
}

function formatTick(iso: string) {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatScheduleRange(item: ScheduledItem) {
  return `${formatShortDateTime(item.start)} -> ${formatShortDateTime(item.finish)}`;
}

function formatCompactScheduleRange(item: ScheduledItem) {
  const startDate = item.start.slice(5, 10);
  const finishDate = item.finish.slice(5, 10);
  const startTime = item.start.slice(11, 16);
  const finishTime = item.finish.slice(11, 16);
  return startDate === finishDate
    ? `${startDate} ${startTime}-${finishTime}`
    : `${startDate} ${startTime}->${finishDate} ${finishTime}`;
}

function scheduleTiming(item: ScheduledItem, referenceTime = now): ScheduleTiming {
  const dayStart = `${referenceTime.slice(0, 10)}T00:00:00.000Z`;
  const dayEnd = addSeconds(dayStart, 24 * 60 * 60);
  if (item.finish < dayStart) return "Overdue";
  if (item.start < dayEnd && item.finish >= dayStart) return "Due now";
  return "Upcoming";
}

function formatAssignmentHours(item: ScheduledItem) {
  return Math.round(item.workItem.assignmentIds.reduce((sum, assignment) => sum + assignment.effortSeconds, 0) / 3600);
}

function sortGates(gates: AuditGate[]) {
  const severityRank = { hard: 0, warning: 1, info: 2 };
  const statusRank = { blocked: 0, open: 1, queued: 2, cleared: 3 };
  return [...gates].sort((a, b) => (
    severityRank[a.severity] - severityRank[b.severity] ||
    statusRank[a.status] - statusRank[b.status] ||
    a.reason.localeCompare(b.reason)
  ));
}

function downloadText(filename: string, content: string, type: string) {
  const safeFilename = filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function compactProjectLabel(name: string) {
  const words = name.split(" ").filter(Boolean);
  if (words.length <= 2) return name;
  return words.slice(0, 2).join(" ");
}

function compactProjectCode(name: string) {
  const asciiWords = name.match(/[A-Za-z0-9]+/g);
  if (asciiWords?.length) {
    const initials = asciiWords.map((word) => word[0]).join("").slice(0, 3).toUpperCase();
    return initials.length >= 2 ? initials : asciiWords[0].slice(0, 3).toUpperCase();
  }
  return name.trim().slice(0, 2) || "P";
}

function formatCompactProjectList(projects: Project[]) {
  if (!projects.length) return "No project";
  const labels = projects.slice(0, 2).map((project) => compactProjectLabel(project.name));
  const remaining = projects.length - labels.length;
  return remaining > 0 ? `${labels.join(", ")} +${remaining}` : labels.join(", ");
}

function matrixRelativePosition(value: number, values: number[]) {
  const finiteValues = values.filter((candidate) => Number.isFinite(candidate));
  if (finiteValues.length < 2) return 50;
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  if (max - min < 2) return 50;
  return 16 + ((value - min) / (max - min)) * 68;
}

function clampMatrixPosition(value: number) {
  return Math.max(18, Math.min(82, Math.round(value)));
}

function matrixNodeOffset(index: number) {
  const offsets = [
    { x: 0, y: 0 },
    { x: -5, y: 5 },
    { x: 5, y: -5 },
    { x: -5, y: -5 },
    { x: 5, y: 5 },
    { x: 0, y: 8 },
    { x: 0, y: -8 }
  ];
  return offsets[index % offsets.length];
}

function matrixDecisionForPoint(x: number, y: number, openHardGates: number): MatrixDecision {
  if (openHardGates > 0) return "audit";
  if (y >= 50 && x >= 50) return "audit";
  if (y >= 50) return "narrow";
  if (x >= 50) return "push";
  return "watch";
}

function matrixDecisionLabel(decision: MatrixDecision) {
  if (decision === "narrow") return "Narrow";
  if (decision === "audit") return "Audit";
  if (decision === "push") return "Push";
  return "Watch";
}

function ParkedWorkSection({
  projectId,
  items,
  projects,
  allWorkItems,
  timeZone,
  currentTime,
  onScheduleItem,
  onMoveItem,
  onFinishItem
}: {
  projectId: string;
  items: WorkItem[];
  projects: Project[];
  allWorkItems: WorkItem[];
  timeZone: string;
  currentTime: string;
  onScheduleItem: (workItemId: string, values: WorkItemStartConstraintValues) => void;
  onMoveItem: (workItemId: string, values: WorkItemMoveValues) => void;
  onFinishItem: (item: WorkItem) => void;
}) {
  if (!items.length) return null;

  return (
    <section className="grid gap-2 rounded-lg border bg-muted/20 p-3" aria-labelledby={`parked-work-${projectId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 id={`parked-work-${projectId}`} className="text-sm font-semibold">Parked work</h4>
          <p className="text-xs text-muted-foreground">Stored in this project but outside the current execution plan.</p>
        </div>
        <Badge variant="outline" className="iconBadge" title={`${items.length} parked work items`}><Archive />{items.length}</Badge>
      </div>
      <ul
        className="grid max-h-80 gap-1.5 overflow-y-auto pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Parked work items"
        tabIndex={0}
      >
        {items.map((item) => {
          const canFinish = item.kind !== "phase";
          return (
            <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-2">
              <div className="min-w-0">
                <strong className="block break-words text-sm">{item.title}</strong>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{item.outline}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.kind}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.kind !== "phase" && !item.repeatRule && (
                  <WorkItemScheduleSheet
                    item={item}
                    timeZone={timeZone}
                    fallbackDate={zonedDateKey(currentTime, timeZone)}
                    onSave={(values) => onScheduleItem(item.id, values)}
                  />
                )}
                <MoveWorkItemSheet
                  projectId={projectId}
                  item={item}
                  projects={projects}
                  allWorkItems={allWorkItems}
                  onMove={onMoveItem}
                />
                {canFinish ? (
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => onFinishItem(item)}
                    aria-label={`Mark ${item.title} done`}
                    title="Mark done"
                  >
                    <CheckCircle2 />
                  </Button>
                ) : (
                  <span className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground" role="img" aria-label="Phase progress follows child work" title="Phase progress follows child work">
                    <CheckCircle2 size={16} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function WorkItemScheduleSheet({
  item,
  timeZone,
  fallbackDate,
  scheduledStart,
  onSave
}: {
  item: WorkItem;
  timeZone: string;
  fallbackDate: string;
  scheduledStart?: string;
  onSave: (values: WorkItemStartConstraintValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WorkItemStartConstraintValues>(() => workItemStartConstraintValues(item, fallbackDate));
  const dateError = draft.constraintMode !== "none" && !/^\d{4}-\d{2}-\d{2}$/.test(draft.constraintDate);

  useEffect(() => {
    if (!open) return;
    setDraft(workItemStartConstraintValues(item, fallbackDate));
  }, [open, item, timeZone, fallbackDate]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" size="icon" variant="outline" aria-label={`Edit schedule for ${item.title}`} title="Edit schedule">
          <CalendarClock />
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Edit start date</SheetTitle>
          <SheetDescription>{item.outline} {item.title}</SheetDescription>
        </SheetHeader>
        <form
          className="workItemScheduleForm"
          onSubmit={(event) => {
            event.preventDefault();
            if (dateError) return;
            onSave(draft);
            setOpen(false);
          }}
        >
          {scheduledStart && (
            <div className="moveWorkItemNote">
              <CalendarClock size={14} />
              <span>Currently scheduled for {formatShortDateTime(scheduledStart)}.</span>
            </div>
          )}
          <NativeSelectField
            label="Start constraint"
            value={draft.constraintMode}
            onChange={(value) => setDraft((current) => ({ ...current, constraintMode: value as WorkItemStartConstraintValues["constraintMode"] }))}
            options={[
              { value: "none", label: "None" },
              { value: "noEarlierThan", label: "No earlier than" },
              { value: "fixedStart", label: "Fixed start" }
            ]}
          />
          {draft.constraintMode !== "none" && (
            <>
              <SettingsInput
                label="Start date"
                name={`schedule-date-${item.id}`}
                value={draft.constraintDate}
                onChange={(constraintDate) => setDraft((current) => ({ ...current, constraintDate }))}
                placeholder="2026-07-20"
                autoComplete="off"
                type="date"
                required
                invalid={dateError}
                describedBy={dateError ? `schedule-date-error-${item.id}` : undefined}
              />
              {dateError && <p id={`schedule-date-error-${item.id}`} className="text-sm text-destructive" role="alert">Choose a valid date.</p>}
            </>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={dateError}><Save />Save date</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function MoveWorkItemSheet({
  projectId,
  item,
  projects,
  allWorkItems,
  onMove
}: {
  projectId: string;
  item: WorkItem;
  projects: Project[];
  allWorkItems: WorkItem[];
  onMove: (workItemId: string, values: WorkItemMoveValues) => void;
}) {
  const targetProjects = projects.filter((project) => project.id !== projectId && !isProjectArchived(project));
  const targetProjectKey = targetProjects.map((project) => project.id).join("|");
  const [open, setOpen] = useState(false);
  const [targetProjectId, setTargetProjectId] = useState(targetProjects[0]?.id ?? "");
  const [parentId, setParentId] = useState("none");

  useEffect(() => {
    setTargetProjectId((current) => targetProjects.some((project) => project.id === current) ? current : targetProjects[0]?.id ?? "");
    setParentId("none");
  }, [projectId, targetProjectKey]);

  const parentOptions = allWorkItems
    .filter((candidate) => candidate.projectId === targetProjectId && candidate.kind === "phase")
    .sort((a, b) => a.outline.localeCompare(b.outline, undefined, { numeric: true }));
  const targetProject = targetProjects.find((project) => project.id === targetProjectId);
  const canMove = Boolean(targetProjectId);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="outline"
          disabled={!targetProjects.length}
          aria-label={`Move ${item.title} to another project`}
          title={targetProjects.length ? "Move to project" : "No other active project"}
        >
          <ArrowRightLeft />
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[92vw] overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Move work item</SheetTitle>
          <SheetDescription>{item.outline} {item.title}</SheetDescription>
        </SheetHeader>
        <form
          className="moveWorkItemForm"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canMove) return;
            onMove(item.id, {
              targetProjectId,
              parentId: parentId === "none" ? undefined : parentId
            });
            setOpen(false);
          }}
        >
          <div className="moveWorkItemSummary">
            <Badge variant="secondary" className="iconBadge" title="Kind"><Workflow />{item.kind}</Badge>
            {item.kind === "phase" && <Badge variant="warning" className="iconBadge" title="Child items move with this phase"><Layers3 />subtree</Badge>}
            {item.repeatRule && <Badge variant="outline" className="iconBadge" title="Recurring rule preserved"><RefreshCw />repeat</Badge>}
          </div>
          <NativeSelectField
            label="Target project"
            value={targetProjectId}
            onChange={(value) => {
              setTargetProjectId(value);
              setParentId("none");
            }}
            options={targetProjects.map((project) => ({ value: project.id, label: project.name }))}
          />
          <NativeSelectField
            label="Parent phase"
            value={parentId}
            onChange={setParentId}
            options={[{ value: "none", label: "No parent" }, ...parentOptions.map((phase) => ({ value: phase.id, label: `${phase.outline} ${phase.title}` }))]}
          />
          <div className="moveWorkItemNote">
            <CheckCircle2 size={14} />
            <span>Evidence, progress, and recurrence follow the item. Dependencies that still point back to the old project are removed.</span>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={!canMove}>
              <ArrowRightLeft />
              Move{targetProject ? ` to ${compactProjectLabel(targetProject.name)}` : ""}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function OutlineTable({
  projectId,
  items,
  gates,
  evidence,
  projects,
  allWorkItems,
  timeZone,
  currentTime,
  onScheduleItem,
  onMoveItem,
  onFinishItem
}: {
  projectId: string;
  items: ScheduledItem[];
  gates: AuditGate[];
  evidence: Evidence[];
  projects: Project[];
  allWorkItems: WorkItem[];
  timeZone: string;
  currentTime: string;
  onScheduleItem: (workItemId: string, values: WorkItemStartConstraintValues) => void;
  onMoveItem: (workItemId: string, values: WorkItemMoveValues) => void;
  onFinishItem: (item: ScheduledItem) => void;
}) {
  const itemPage = usePagedItems(items, 10);
  return (
    <div className="grid gap-2">
      <Table>
        <caption className="srOnly">Project outline with schedule, evidence, gate, and float status</caption>
        <TableHeader>
          <TableRow>
            <TableHead>WBS</TableHead>
            <TableHead>Work item</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>%</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
            {itemPage.items.map((item) => {
              const gate = gates.find((candidate) => candidate.status !== "cleared" && candidate.targetId === item.workItem.id);
              const hasEvidence = evidence.some((candidate) => candidate.workItemId === item.workItem.id);
              const status = gate
                ? `${gate.severity} gate`
                : item.workItem.evidenceRequired && !hasEvidence
                  ? "Needs evidence"
                  : item.isCritical
                    ? "Critical"
                    : "Clear";
              return (
                <TableRow key={item.workItem.id} data-work-item-id={item.workItem.id} className={item.isCritical ? "border-l-4 border-l-destructive" : ""}>
                  <TableCell className="font-medium">{item.workItem.outline}</TableCell>
                  <TableCell className="outlineItemCell">
                    <strong title={item.workItem.title}>{item.workItem.title}</strong>
                    <span>
                      {item.workItem.kind}
                      {item.workItem.evidenceRequired && " / evidence"}
                      {item.workItem.isKeyTask && " / key"}
                    </span>
                  </TableCell>
                  <TableCell className="outlinePlanCell">
                    <span>{formatShortDateTime(item.start)}</span>
                    <span>{formatShortDateTime(item.finish)}</span>
                  </TableCell>
                  <TableCell>{item.workItem.percentComplete}</TableCell>
                  <TableCell>
                    <Badge
                      variant={gate ? "destructive" : item.isCritical ? "warning" : "secondary"}
                      title={`${status}; float ${Math.round(item.totalFloatSeconds / 3600)}h`}
                    >
                      {gate ? "Gate" : item.isCritical ? "CP" : item.workItem.evidenceRequired && !hasEvidence ? "Evidence" : "Clear"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="outlineActionCell">
                      {item.workItem.kind !== "phase" && !item.workItem.repeatRule && (
                        <WorkItemScheduleSheet
                          item={item.workItem}
                          timeZone={timeZone}
                          fallbackDate={zonedDateKey(currentTime, timeZone)}
                          scheduledStart={item.start}
                          onSave={(values) => onScheduleItem(item.workItem.id, values)}
                        />
                      )}
                      <MoveWorkItemSheet
                        projectId={projectId}
                        item={item.workItem}
                        projects={projects}
                        allWorkItems={allWorkItems}
                        onMove={onMoveItem}
                      />
                      {item.workItem.kind === "phase" ? (
                        <span className="text-xs text-muted-foreground">-</span>
                      ) : item.workItem.percentComplete >= 100 ? (
                        <Badge variant="success">Done</Badge>
                      ) : (
                        <Button type="button" size="icon" variant="outline" onClick={() => onFinishItem(item)} aria-label={`Mark ${item.workItem.title} done`} title="Mark done">
                          <CheckCircle2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
      <PaginationControls label="outline" {...itemPage} onPageChange={itemPage.setPage} />
    </div>
  );
}

type GanttZoom = "compact" | "day" | "wide";

interface GanttViewportState {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

const emptyGanttViewport: GanttViewportState = {
  scrollLeft: 0,
  scrollTop: 0,
  clientWidth: 1,
  clientHeight: 1,
  scrollWidth: 1,
  scrollHeight: 1
};

function GanttChart({
  items,
  dependencies,
  baseline,
  onDependencyUpdate,
  onDependencyRemove
}: {
  items: ScheduledItem[];
  dependencies: Dependency[];
  baseline?: Baseline;
  onDependencyUpdate: (dependencyId: string, patch: DependencyPatch) => void;
  onDependencyRemove: (dependencyId: string) => void;
}) {
  const [zoom, setZoom] = useState<GanttZoom>("day");
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>();
  const [selectedDependencyId, setSelectedDependencyId] = useState<string | undefined>();
  const [miniDragging, setMiniDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<GanttViewportState>(emptyGanttViewport);
  const sortedItems = useMemo(() => [...items].sort((a, b) => a.workItem.outline.localeCompare(b.workItem.outline)), [items]);
  const itemById = useMemo(() => new Map(sortedItems.map((item) => [item.workItem.id, item])), [sortedItems]);
  const firstStart = sortedItems[0]?.start ?? now;
  const visibleItemIds = new Set(sortedItems.map((item) => item.workItem.id));
  const selectedItem = sortedItems.find((item) => item.workItem.id === selectedItemId) ?? sortedItems[0];
  const pixelsPerDay = zoom === "compact" ? 44 : zoom === "wide" ? 128 : 84;
  const rowHeight = 46;
  const labelWidth = 320;
  const baselineStarts = baseline ? Object.values(baseline.plannedStartByItem) : [];
  const baselineFinishes = baseline ? Object.values(baseline.plannedFinishByItem) : [];
  const min = startOfDay(
    [...sortedItems.map((item) => item.start), ...baselineStarts].reduce(
      (value, item) => (item < value ? item : value),
      firstStart
    )
  );
  const maxRaw = [...sortedItems.map((item) => item.finish), ...baselineFinishes, now].reduce(
    (value, item) => (item > value ? item : value),
    sortedItems[0]?.finish ?? now
  );
  const max = addSeconds(startOfDay(maxRaw), 2 * daySeconds);
  const totalDays = Math.max(1, Math.ceil(secondsBetween(min, max) / daySeconds));
  const width = totalDays * pixelsPerDay;
  const height = sortedItems.length * rowHeight;
  const ticks = Array.from({ length: totalDays + 1 }, (_, index) => addSeconds(min, index * daySeconds));
  const x = (iso: string) => Math.max(0, (secondsBetween(min, iso) / daySeconds) * pixelsPerDay);
  const criticalCount = items.filter((item) => item.isCritical).length;
  const visibleDependencies = dependencies.filter((dependency) => visibleItemIds.has(dependency.fromId) && visibleItemIds.has(dependency.toId));
  const indexById = new Map(sortedItems.map((item, index) => [item.workItem.id, index]));
  const criticalPathWidth = sortedItems.filter((item) => item.isCritical).length;
  const selectedDependency = visibleDependencies.find((dependency) => dependency.id === selectedDependencyId);
  const relatedDependencies = selectedItem
    ? visibleDependencies.filter((dependency) => dependency.fromId === selectedItem.workItem.id || dependency.toId === selectedItem.workItem.id)
    : [];
  const dependencyRows = selectedDependency
    ? [selectedDependency, ...relatedDependencies.filter((dependency) => dependency.id !== selectedDependency.id)]
    : relatedDependencies.length
      ? relatedDependencies
      : visibleDependencies.slice(0, 5);
  const incomingCount = selectedItem ? visibleDependencies.filter((dependency) => dependency.toId === selectedItem.workItem.id).length : 0;
  const outgoingCount = selectedItem ? visibleDependencies.filter((dependency) => dependency.fromId === selectedItem.workItem.id).length : 0;

  const updateViewport = () => {
    const element = viewportRef.current;
    if (!element) return;
    const next = {
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      clientWidth: Math.max(1, element.clientWidth),
      clientHeight: Math.max(1, element.clientHeight),
      scrollWidth: Math.max(1, element.scrollWidth),
      scrollHeight: Math.max(1, element.scrollHeight)
    };
    setViewport((current) => (
      current.scrollLeft === next.scrollLeft &&
      current.scrollTop === next.scrollTop &&
      current.clientWidth === next.clientWidth &&
      current.clientHeight === next.clientHeight &&
      current.scrollWidth === next.scrollWidth &&
      current.scrollHeight === next.scrollHeight
        ? current
        : next
    ));
  };

  useEffect(() => {
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [height, width, zoom, sortedItems.length]);

  const scrollFromMinimap = (event: PointerEvent<HTMLDivElement>) => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const xRatio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const yRatio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    const left = clamp(xRatio * element.scrollWidth - element.clientWidth / 2, 0, Math.max(0, element.scrollWidth - element.clientWidth));
    const top = clamp(yRatio * element.scrollHeight - element.clientHeight / 2, 0, Math.max(0, element.scrollHeight - element.clientHeight));
    element.scrollTo({ left, top });
    updateViewport();
  };

  const miniViewportStyle = {
    left: `${(viewport.scrollLeft / viewport.scrollWidth) * 100}%`,
    top: `${(viewport.scrollTop / viewport.scrollHeight) * 100}%`,
    width: `${Math.max(8, (viewport.clientWidth / viewport.scrollWidth) * 100)}%`,
    height: `${Math.max(18, (viewport.clientHeight / viewport.scrollHeight) * 100)}%`
  };

  if (!selectedItem) return <div className="emptyState">No scheduled items.</div>;

  return (
    <div className="ganttWorkSurface" aria-label={`Interactive Gantt chart with ${items.length} items from ${formatShortDateTime(min)} to ${formatShortDateTime(max)}; ${criticalCount} critical items.`}>
      <div className="ganttToolbar">
        <div className="ganttToolbarBadges">
          <Badge variant={baseline ? "success" : "outline"} className="iconBadge" title={baseline?.name ?? "No baseline"}>{baseline ? <CheckCircle2 /> : <Archive />}{baseline ? "B" : "-"}</Badge>
          <Badge variant="outline" className="iconBadge" title="Dependencies"><Network />{visibleDependencies.length}</Badge>
          <Badge variant={criticalPathWidth ? "warning" : "outline"} className="iconBadge" title="Critical path"><AlertTriangle />{criticalPathWidth}</Badge>
        </div>
        <div className="segmentedControl" aria-label="Gantt zoom">
          {([
            ["compact", "Compact"],
            ["day", "Day"],
            ["wide", "Wide"]
          ] as Array<[GanttZoom, string]>).map(([value, label]) => (
            <button key={value} className={zoom === value ? "active" : ""} onClick={() => setZoom(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="ganttViewport" ref={viewportRef} onScroll={updateViewport}>
        <div className="ganttBoard" style={{ width: labelWidth + width, gridTemplateColumns: `${labelWidth}px ${width}px` }}>
          <div className="ganttTreeHeader">WBS / Task</div>
          <div className="ganttTimeHeader" style={{ width }}>
            {ticks.map((tick, index) => (
              <div key={tick} className={`ganttTick ${index % 7 === 5 || index % 7 === 6 ? "weekend" : ""}`} style={{ left: index * pixelsPerDay, width: pixelsPerDay }}>
                {formatTick(tick)}
              </div>
            ))}
          </div>
          <div className="ganttTreeRows">
            {sortedItems.map((item) => (
              <button
                key={item.workItem.id}
                className={`ganttTreeRow ${selectedItem.workItem.id === item.workItem.id ? "selected" : ""} ${item.workItem.kind}`}
                onClick={() => setSelectedItemId(item.workItem.id)}
                aria-pressed={selectedItem.workItem.id === item.workItem.id}
              >
                <span className="ganttOutline">{item.workItem.outline}</span>
                <span className="ganttTaskTitle">{item.workItem.title}</span>
                {item.isCritical && <span className="miniBadge danger">Critical</span>}
              </button>
            ))}
          </div>
          <div className="ganttTimelinePane" style={{ width, height }}>
            {ticks.map((tick, index) => (
              <div
                key={tick}
                className={`ganttGridLine ${index % 7 === 5 || index % 7 === 6 ? "weekend" : ""}`}
                style={{ left: index * pixelsPerDay, width: pixelsPerDay }}
              />
            ))}
            <div className="ganttToday" style={{ left: x(now) }}>
              <span>Today</span>
            </div>
            <svg className="ganttDependencyLayer" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
              <defs>
                <marker id="gantt-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="ganttArrowHead" />
                </marker>
              </defs>
              {visibleDependencies.map((dependency) => {
                const from = itemById.get(dependency.fromId);
                const to = itemById.get(dependency.toId);
                if (!from || !to) return null;
                const fromIndex = indexById.get(from.workItem.id) ?? 0;
                const toIndex = indexById.get(to.workItem.id) ?? 0;
                const x1 = dependencyEndpointX(from, dependency.type, "from", x);
                const x2 = dependencyEndpointX(to, dependency.type, "to", x);
                const y1 = fromIndex * rowHeight + rowHeight / 2;
                const y2 = toIndex * rowHeight + rowHeight / 2;
                const bend = Math.max(x1 + 18, (x1 + x2) / 2);
                const active = selectedDependencyId === dependency.id || dependency.fromId === selectedItem.workItem.id || dependency.toId === selectedItem.workItem.id;
                return (
                  <g key={dependency.id} className={active ? "activeDependency" : undefined}>
                    <path
                      className={`ganttDependency ${selectedDependencyId === dependency.id ? "selected" : ""}`}
                      markerEnd="url(#gantt-arrow)"
                      d={`M ${x1} ${y1} H ${bend} V ${y2} H ${x2}`}
                    />
                    <circle className="ganttDepPort from" cx={x1} cy={y1} r="3" />
                    <circle className="ganttDepPort to" cx={x2} cy={y2} r="3" />
                  </g>
                );
              })}
            </svg>
            {sortedItems.map((item, index) => (
              <GanttItemBar
                key={item.workItem.id}
                item={item}
                index={index}
                rowHeight={rowHeight}
                x={x}
                baseline={baseline}
                selected={selectedItem.workItem.id === item.workItem.id}
                onSelect={() => setSelectedItemId(item.workItem.id)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="ganttMinimapRow">
        <div
          className={`ganttMinimap ${miniDragging ? "dragging" : ""}`}
          role="button"
          tabIndex={0}
          aria-label="Gantt minimap. Click or drag to move the visible timeline and task rows."
          onPointerDown={(event) => {
            setMiniDragging(true);
            event.currentTarget.setPointerCapture(event.pointerId);
            scrollFromMinimap(event);
          }}
          onPointerMove={(event) => {
            if (miniDragging) scrollFromMinimap(event);
          }}
          onPointerUp={(event) => {
            setMiniDragging(false);
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => setMiniDragging(false)}
          onKeyDown={(event) => {
            const element = viewportRef.current;
            if (!element) return;
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            element.scrollBy({
              left: event.key === "ArrowLeft" ? -pixelsPerDay : event.key === "ArrowRight" ? pixelsPerDay : 0,
              top: event.key === "ArrowUp" ? -rowHeight : event.key === "ArrowDown" ? rowHeight : 0
            });
          }}
        >
          {sortedItems.map((item, index) => {
            const left = ((labelWidth + x(item.start)) / Math.max(1, labelWidth + width)) * 100;
            const taskWidth = Math.max(1.2, ((x(item.finish) - x(item.start)) / Math.max(1, labelWidth + width)) * 100);
            const top = (index / Math.max(1, sortedItems.length)) * 100;
            const miniHeight = Math.max(4, 100 / Math.max(1, sortedItems.length) - 1);
            return (
              <span
                key={item.workItem.id}
                className={`miniTaskBar ${item.isCritical ? "critical" : ""} ${item.workItem.kind}`}
                style={{ left: `${left}%`, top: `${top}%`, width: `${taskWidth}%`, height: `${miniHeight}%` }}
              />
            );
          })}
          <span className="miniViewport" style={miniViewportStyle} />
        </div>
        <div className="ganttMiniStats">
          <span>{sortedItems.length} rows</span>
          <span>{visibleDependencies.length} deps</span>
          <span>{formatShortDateTime(min)} - {formatShortDateTime(max)}</span>
        </div>
      </div>
      <div className="ganttInspector">
        <div className="ganttSelectedSummary">
          <span>Selected</span>
          <strong>{selectedItem.workItem.title}</strong>
          <p>{formatScheduleRange(selectedItem)} / {selectedItem.workItem.percentComplete}% complete / {selectedItem.isCritical ? "critical path" : `${Math.round(selectedItem.totalFloatSeconds / 3600)}h float`}</p>
          <p>{incomingCount} predecessors / {outgoingCount} successors</p>
        </div>
        <GanttDependencyEditor
          dependencies={dependencyRows}
          selectedDependencyId={selectedDependencyId}
          selectedItemId={selectedItem.workItem.id}
          itemById={itemById}
          onSelect={(dependency, nextItemId) => {
            setSelectedDependencyId(dependency.id);
            setSelectedItemId(nextItemId);
          }}
          onUpdate={(dependencyId, patch) => {
            setSelectedDependencyId(dependencyId);
            onDependencyUpdate(dependencyId, patch);
          }}
          onRemove={(dependencyId) => {
            if (selectedDependencyId === dependencyId) setSelectedDependencyId(undefined);
            onDependencyRemove(dependencyId);
          }}
        />
        <div className="ganttLegend" aria-hidden="true">
          <span><i className="legendSwatch normalSwatch" />Scheduled</span>
          <span><i className="legendSwatch criticalSwatch" />Critical</span>
          <span><i className="legendSwatch baselineSwatch" />Baseline</span>
          <span><i className="legendSwatch progressSwatch" />Progress</span>
          <span><i className="milestoneLegend" />Milestone</span>
        </div>
      </div>
      <div className="srOnly">
        Gantt data: {sortedItems.map((item) => `${item.workItem.title}, ${formatScheduleRange(item)}, ${item.isCritical ? "critical" : "not critical"}`).join("; ")}
      </div>
    </div>
  );
}

function GanttItemBar({
  item,
  index,
  rowHeight,
  x,
  baseline,
  selected,
  onSelect
}: {
  item: ScheduledItem;
  index: number;
  rowHeight: number;
  x: (iso: string) => number;
  baseline?: Baseline;
  selected: boolean;
  onSelect: () => void;
}) {
  const top = index * rowHeight;
  const scheduledStart = x(item.start);
  const scheduledFinish = Math.max(scheduledStart + 10, x(item.finish));
  const baselineStart = baseline?.plannedStartByItem[item.workItem.id];
  const baselineFinish = baseline?.plannedFinishByItem[item.workItem.id];
  const baselineLeft = baselineStart ? x(baselineStart) : undefined;
  const baselineWidth = baselineStart && baselineFinish ? Math.max(6, x(baselineFinish) - baselineLeft!) : undefined;
  const segmentBase = item.workItem.splitSegments?.length ? item.workItem.splitSegments : undefined;
  const segments = segmentBase
    ? segmentBase.map((segment) => ({
        left: x(addSeconds(item.start, segment.offsetSeconds)),
        width: Math.max(8, x(addSeconds(item.start, segment.offsetSeconds + segment.durationSeconds)) - x(addSeconds(item.start, segment.offsetSeconds)))
      }))
    : [{ left: scheduledStart, width: Math.max(8, scheduledFinish - scheduledStart) }];

  return (
    <div className={`ganttLane ${selected ? "selected" : ""}`} style={{ top, height: rowHeight }}>
      {baselineLeft !== undefined && baselineWidth !== undefined && <span className="ganttBaseline" style={{ left: baselineLeft, width: baselineWidth }} />}
      {item.workItem.kind === "milestone" ? (
        <button
          className={`ganttMilestone ${item.isCritical ? "critical" : ""}`}
          style={{ left: scheduledStart }}
          onClick={onSelect}
          aria-label={`${item.workItem.title}, milestone, ${formatShortDateTime(item.start)}`}
        />
      ) : (
        segments.map((segment, segmentIndex) => (
          <button
            key={`${item.workItem.id}-${segmentIndex}`}
            className={`ganttBarButton ${item.isCritical ? "critical" : ""} ${item.workItem.kind} ${selected ? "selected" : ""}`}
            style={{ left: segment.left, width: segment.width }}
            onClick={onSelect}
            aria-label={`${item.workItem.title}, ${formatScheduleRange(item)}, ${item.workItem.percentComplete}% complete`}
          >
            <span className="ganttProgressFill" style={{ width: `${Math.max(0, Math.min(100, item.workItem.percentComplete))}%` }} />
          </button>
        ))
      )}
    </div>
  );
}

function GanttDependencyEditor({
  dependencies,
  selectedDependencyId,
  selectedItemId,
  itemById,
  onSelect,
  onUpdate,
  onRemove
}: {
  dependencies: Dependency[];
  selectedDependencyId?: string;
  selectedItemId: string;
  itemById: Map<string, ScheduledItem>;
  onSelect: (dependency: Dependency, nextItemId: string) => void;
  onUpdate: (dependencyId: string, patch: DependencyPatch) => void;
  onRemove: (dependencyId: string) => void;
}) {
  if (!dependencies.length) {
    return (
      <div className="ganttDependencyInspector empty">
        <span>Dependencies</span>
        <strong>No linked tasks</strong>
        <p>Select another row or use the Add dependency controls above the Gantt.</p>
      </div>
    );
  }

  return (
    <div className="ganttDependencyInspector">
      <span>Dependencies</span>
      <div className="dependencyStack">
        {dependencies.map((dependency) => {
          const from = itemById.get(dependency.fromId);
          const to = itemById.get(dependency.toId);
          if (!from || !to) return null;
          const isOutgoing = dependency.fromId === selectedItemId;
          const other = isOutgoing ? to : from;
          const relation = isOutgoing ? "Blocks" : "Blocked by";
          const active = selectedDependencyId === dependency.id;
          const dependencyTypeId = `dependency-type-${dependency.id}`;
          return (
            <article className={`dependencyRow ${active ? "selected" : ""}`} key={dependency.id}>
              <button
                className="dependencySummaryButton"
                onClick={() => onSelect(dependency, other.workItem.id)}
                aria-pressed={active}
              >
                <span className="dependencyDirection">{relation}</span>
                <strong>{from.workItem.outline} {dependencyLabel(dependency.type)} {to.workItem.outline}{dependency.lagSeconds ? ` ${formatLag(dependency.lagSeconds)}` : ""}</strong>
                <span>{`${from.workItem.title} -> ${to.workItem.title}`}</span>
              </button>
              <div className="dependencyControls">
                <label htmlFor={dependencyTypeId}>
                  Type
                  <select
                    id={dependencyTypeId}
                    name={dependencyTypeId}
                    value={dependency.type}
                    aria-label={`Dependency type for ${from.workItem.outline} to ${to.workItem.outline}`}
                    onChange={(event) => onUpdate(dependency.id, { type: event.target.value as DependencyType })}
                  >
                    {dependencyTypes.map((type) => (
                      <option key={type} value={type}>{dependencyLabel(type)}</option>
                    ))}
                  </select>
                </label>
                <div className="lagStepper" aria-label={`Lag for ${from.workItem.outline} to ${to.workItem.outline}`}>
                  <button onClick={() => onUpdate(dependency.id, { lagSeconds: clamp(dependency.lagSeconds - daySeconds, -10 * daySeconds, 30 * daySeconds) })}>-</button>
                  <span>{formatLag(dependency.lagSeconds)}</span>
                  <button onClick={() => onUpdate(dependency.id, { lagSeconds: clamp(dependency.lagSeconds + daySeconds, -10 * daySeconds, 30 * daySeconds) })}>+</button>
                </div>
                <button className="removeDependency" onClick={() => onRemove(dependency.id)}>Remove</button>
              </div>
              <p className="dependencyEquation">{dependencyEquation(dependency, from, to)}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function dependencyEndpointX(item: ScheduledItem, type: DependencyType, side: "from" | "to", x: (iso: string) => number) {
  const endpoint = side === "from" ? type[0] : type[1];
  return x(endpoint === "S" ? item.start : item.finish);
}

function dependencyEquation(dependency: Dependency, from: ScheduledItem, to: ScheduledItem) {
  const source = dependency.type[0] === "S" ? "start" : "finish";
  const target = dependency.type[1] === "S" ? "start" : "finish";
  const lag = dependency.lagSeconds ? ` ${formatLag(dependency.lagSeconds)}` : "";
  return `${to.workItem.outline} ${target} cannot be earlier than ${from.workItem.outline} ${source}${lag}.`;
}

function formatLag(seconds: number) {
  const days = Math.round(seconds / daySeconds);
  if (days === 0) return "0d";
  return `${days > 0 ? "+" : ""}${days}d`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function NetworkGraph({ items, dependencies }: { items: ScheduledItem[]; dependencies: Dependency[] }) {
  const width = 720;
  const height = Math.max(240, items.length * 48);
  const positions = new Map(items.map((item, index) => [
    item.workItem.id,
    {
      x: 48 + (index % 3) * 220,
      y: 30 + Math.floor(index / 3) * 92
    }
  ]));
  const visibleDependencies = dependencies.filter((dependency) => positions.has(dependency.fromId) && positions.has(dependency.toId));
  return (
    <div className="chartScroll" role="img" aria-label={`Network graph with ${items.length} items and ${visibleDependencies.length} dependencies.`}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {visibleDependencies.map((dependency) => {
          const from = positions.get(dependency.fromId)!;
          const to = positions.get(dependency.toId)!;
          return (
            <g key={dependency.id}>
              <line x1={from.x + 172} y1={from.y + 30} x2={to.x} y2={to.y + 30} className="networkLine" />
              <text x={(from.x + to.x + 172) / 2} y={(from.y + to.y + 60) / 2 - 4} className="edgeLabel">
                {dependency.type}{dependency.lagSeconds ? ` ${Math.round(dependency.lagSeconds / 3600)}h` : ""}
              </text>
            </g>
          );
        })}
        {items.map((item, index) => {
          const x = 48 + (index % 3) * 220;
          const y = 30 + Math.floor(index / 3) * 92;
          return (
            <g key={item.workItem.id}>
              <title>{`${item.workItem.outline} ${item.workItem.title}`}</title>
              <rect x={x} y={y} width="172" height="66" rx="6" className={item.isCritical ? "networkNode critical" : "networkNode"} />
              <text x={x + 10} y={y + 20} className="nodeTitle">
                {item.workItem.outline}
              </text>
              <foreignObject x={x + 10} y={y + 27} width="152" height="34">
                <div className="nodeHtmlLabel">{item.workItem.title}</div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
      <div className="srOnly">
        Network dependencies: {visibleDependencies.map((dependency) => {
          const from = items.find((item) => item.workItem.id === dependency.fromId)?.workItem.title;
          const to = items.find((item) => item.workItem.id === dependency.toId)?.workItem.title;
          return `${from} ${dependency.type} ${to}`;
        }).join("; ")}
      </div>
    </div>
  );
}

function SignalList({
  gates,
  compact = false,
  onClear
}: {
  gates: AuditGate[];
  compact?: boolean;
  onClear?: (gate: AuditGate, rationale: string) => void;
}) {
  const [rationales, setRationales] = useState<Record<string, string>>({});
  if (!gates.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
        <CheckCircle2 size={16} />
        Clear
      </div>
    );
  }

  return (
    <div className={cn("grid gap-2", compact && "gap-1.5")}>
      {gates.map((gate) => (
        <article
          className={cn(
            compact
              ? "compactSignalRow"
              : "grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[18px_minmax(0,1fr)_auto]",
            gate.severity === "hard" && "border-destructive/35 bg-destructive/5",
            gate.severity === "warning" && "border-amber-300 bg-amber-50/60"
          )}
          key={gate.id}
        >
          <GitPullRequest size={compact ? 14 : 15} className={cn("text-muted-foreground", !compact && "mt-0.5")} />
          <div className={cn(compact && "compactSignalBody")}>
            <strong className="text-sm">{gate.targetType}</strong>
            <span className={cn(compact ? "compactSignalText" : "mt-1 block text-xs text-muted-foreground")}>{gate.reason}</span>
            <span className={cn(compact ? "compactSignalRequired" : "mt-1 block text-xs text-muted-foreground")}>Req: {gate.requiredAction}</span>
            {onClear && gate.status !== "cleared" && (
              <form
                className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
                onSubmit={(event) => {
                  event.preventDefault();
                  onClear(gate, rationales[gate.id] ?? "");
                  setRationales((current) => ({ ...current, [gate.id]: "" }));
                }}
              >
                <Input
                  value={rationales[gate.id] ?? ""}
                  onChange={(event) => setRationales((current) => ({ ...current, [gate.id]: event.target.value }))}
                  placeholder="Evidence, waiver, or decision rationale"
                  aria-label={`Rationale for ${gate.reason}`}
                />
                <Button type="submit" size="sm" variant={gate.severity === "hard" ? "destructive" : "outline"}>Clear gate</Button>
              </form>
            )}
          </div>
          <Badge variant={gate.severity === "hard" ? "destructive" : gate.severity === "warning" ? "warning" : "secondary"}>{gate.status}</Badge>
        </article>
      ))}
    </div>
  );
}
