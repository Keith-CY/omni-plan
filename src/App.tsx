import {
  AlertTriangle,
  Archive,
  BarChart3,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileDown,
  GitPullRequest,
  Home,
  KeyRound,
  Layers3,
  Lock,
  Network,
  PanelRight,
  Plus,
  Search,
  ShieldAlert,
  Target,
  Timer,
  Workflow,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { evaluateAuditGates, recommendAuditDecision } from "./domain/audit";
import { calculateEvm } from "./domain/evm";
import { exportProjectMarkdown, exportScheduleCsv } from "./domain/exports";
import { fetchPullRequestEvidence, githubPrToEvidence } from "./domain/github";
import { runMonteCarlo } from "./domain/monteCarlo";
import { calculateProjectHealth } from "./domain/portfolio";
import {
  detectCrossProjectOverload,
  generateLevelingProposals,
  schedulePortfolio,
  scheduleProject
} from "./domain/scheduler";
import { sampleWorkspace } from "./domain/sampleData";
import { BrowserEncryptedSecretVault, browserSecretVaultStatus, encryptProviderSecret } from "./domain/secrets";
import {
  BrowserAppSettingsRepository,
  defaultCustomAiProviderSettings,
  providerSecretSummary,
  type AiProviderSettings,
  type GitHubSyncSettings
} from "./domain/settings";
import { BrowserWorkspaceRepository, browserWorkspaceStorageStatus } from "./domain/storage";
import {
  buildChangeEnvelopePath,
  buildGitHubSyncPaths,
  createSyncChangeEnvelope,
  createSyncManifest,
  githubPrivateRepoSyncStatus,
  githubSyncCommitMessage,
  GitHubPrivateRepoSyncClient,
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
  Dependency,
  DependencyType,
  DirectionCard,
  Evidence,
  EvidenceKind,
  Project,
  ProjectMode,
  ProjectStatus,
  ScheduleResult,
  ScheduledItem,
  WorkItem,
  WorkItemKind,
  WorkspaceSnapshot
} from "./domain/types";
import { addSeconds, secondsBetween, startOfDay } from "./domain/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type View = "portfolio" | "project" | "today" | "audit" | "reports" | "settings";
type ScheduleTiming = "Overdue" | "Due now" | "Upcoming";

const now = new Date().toISOString();
const asOfLabel = `As of ${now.slice(0, 10)}`;
const defaultProjectId = sampleWorkspace.projects[0]?.id ?? "p-omni";
const views = new Set<View>(["portfolio", "project", "today", "audit", "reports", "settings"]);
const daySeconds = 24 * 60 * 60;
const dependencyTypes: DependencyType[] = ["FS", "SS", "FF", "SF"];
const workItemKinds: WorkItemKind[] = ["phase", "task", "milestone", "hammock"];
const projectModes: ProjectMode[] = ["explore", "build", "ship", "maintain"];
const projectStatuses: ProjectStatus[] = ["active", "waiting", "paused", "done", "archived"];
const auditActions: AuditAction[] = ["Accelerate", "Continue", "Narrow", "Pivot", "Stop"];
const evidenceKinds: EvidenceKind[] = ["note", "commit", "pr", "ci", "doc", "screenshot", "release", "feedback", "metric", "email", "calendar", "minutes", "booking"];

type DependencyPatch = Partial<Pick<Dependency, "type" | "lagSeconds">>;

interface ProjectCreateValues {
  name: string;
  mode: ProjectMode;
  startDate: string;
  horizonDate: string;
  northStar: string;
  currentOutcome: string;
  targetUser: string;
  userProblem: string;
  coreHypothesis: string;
  successMetric: string;
  failureCondition: string;
  validationMethod: string;
  timeboxDays: number;
  opportunityCost: string;
}

interface WorkItemCreateValues {
  title: string;
  kind: WorkItemKind;
  parentId?: string;
  durationDays: number;
  effortHours: number;
  attention: "deep" | "medium" | "shallow";
  constraintMode: "none" | "noEarlierThan" | "fixedStart";
  constraintDate: string;
  percentComplete: number;
  evidenceRequired: boolean;
  isKeyTask: boolean;
  isScopeExpansion: boolean;
  isFastDelivery: boolean;
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

interface RouteState {
  view: View;
  selectedProjectId: string;
  target?: string;
}

function hashForRoute(route: RouteState): string {
  return `#${pathForRoute(route)}`;
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

function toUtcStart(date: string) {
  return `${date || timestamp().slice(0, 10)}T00:00:00.000Z`;
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
      status: project.status,
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [focusedWorkItemId, setFocusedWorkItemId] = useState<string | undefined>();
  const [workspace, setWorkspace] = useState(sampleWorkspace);
  const [workspacePersistence, setWorkspacePersistence] = useState({
    loaded: false,
    status: "Loading local workspace...",
    lastSavedAt: ""
  });
  const pageTitleRef = useRef<HTMLHeadingElement>(null);
  const view = route.view;
  const selectedProject = workspace.projects.find((project) => project.id === route.selectedProjectId) ?? workspace.projects[0] ?? sampleWorkspace.projects[0];
  const selectedProjectId = selectedProject.id;

  useEffect(() => {
    let active = true;
    void workspaceRepository.load().then((storedWorkspace) => {
      if (!active) return;
      if (storedWorkspace) {
        setWorkspace(storedWorkspace);
        setWorkspacePersistence({ loaded: true, status: "Loaded from browser local workspace", lastSavedAt: "" });
      } else {
        setWorkspacePersistence({ loaded: true, status: "Initialized sample workspace in browser storage", lastSavedAt: "" });
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setWorkspacePersistence({ loaded: true, status: `Workspace load failed: ${error instanceof Error ? error.message : "unknown error"}`, lastSavedAt: "" });
    });
    return () => {
      active = false;
    };
  }, [workspaceRepository]);

  useEffect(() => {
    if (!workspacePersistence.loaded) return;
    const savedAt = new Date().toISOString();
    void workspaceRepository.save(workspace).then(() => {
      setWorkspacePersistence((current) => ({ ...current, status: "Saved to browser local workspace", lastSavedAt: savedAt }));
    }).catch((error: unknown) => {
      setWorkspacePersistence((current) => ({ ...current, status: `Workspace save failed: ${error instanceof Error ? error.message : "unknown error"}` }));
    });
  }, [workspace, workspacePersistence.loaded, workspaceRepository]);

  useEffect(() => {
    pageTitleRef.current?.focus({ preventScroll: true });
    setSearchOpen(false);
  }, [view, selectedProjectId]);

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

  useEffect(() => {
    if (view !== "project" || !focusedWorkItemId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector(`[data-work-item-id="${focusedWorkItemId}"]`);
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      target?.classList.add("focusFlash");
      window.setTimeout(() => target?.classList.remove("focusFlash"), 1600);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [view, selectedProjectId, focusedWorkItemId]);

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
    const name = values.name.trim();
    if (!name) return;
    const projectId = uniqueId("p", name, workspace.projects.map((project) => project.id));
    const createdAt = timestamp();
    const directionCard: DirectionCard = {
      targetUser: values.targetUser.trim(),
      userProblem: values.userProblem.trim(),
      businessGoal: values.currentOutcome.trim(),
      coreHypothesis: values.coreHypothesis.trim(),
      successMetric: values.successMetric.trim(),
      failureCondition: values.failureCondition.trim(),
      validationMethod: values.validationMethod.trim(),
      timeboxDays: Math.max(1, Math.round(values.timeboxDays || 14)),
      opportunityCost: values.opportunityCost.trim()
    };
    const project: Project = {
      id: projectId,
      name,
      status: "active",
      mode: values.mode,
      priority: 3,
      northStar: values.northStar.trim() || `Deliver ${name} with evidence-backed direction control.`,
      currentOutcome: values.currentOutcome.trim() || "Create the first trustworthy milestone plan.",
      horizon: toUtcStart(values.horizonDate),
      start: toUtcStart(values.startDate),
      directionCard,
      reviewCadenceDays: 7
    };
    const firstTaskId = uniqueId("w", `${name} first milestone`, workspace.workItems.map((item) => item.id));
    const firstTask: WorkItem = {
      id: firstTaskId,
      projectId,
      kind: "milestone",
      title: "First evidence review",
      outline: "1",
      durationSeconds: 0,
      estimate: { mostLikelySeconds: 0 },
      assignmentIds: [],
      percentComplete: 0,
      evidenceRequired: true,
      isKeyTask: true
    };
    setWorkspace((previous) => ({
      ...previous,
      projects: [project, ...previous.projects],
      workItems: [firstTask, ...previous.workItems],
      changeSets: [
        createChangeSet(
          projectId,
          `Create project ${name}`,
          "Created from the portfolio project wizard.",
          [{ entity: "Project", entityId: projectId, field: "created", before: null, after: { name, createdAt } }],
          previous.changeSets.length
        ),
        ...previous.changeSets
      ]
    }));
    routerNavigate(pathForRoute({ view: "project", selectedProjectId: projectId }));
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

  const updateProjectStatus = (projectId: string, status: ProjectStatus) => {
    setWorkspace((previous) => {
      const project = previous.projects.find((candidate) => candidate.id === projectId);
      if (!project || project.status === status) return previous;
      return {
        ...previous,
        projects: previous.projects.map((candidate) => candidate.id === projectId ? { ...candidate, status } : candidate),
        changeSets: [
          createChangeSet(
            projectId,
            `Set ${project.name} status ${status}`,
            "Updated project lifecycle state.",
            [{ entity: "Project", entityId: projectId, field: "status", before: project.status, after: status }],
            previous.changeSets.length
          ),
          ...previous.changeSets
        ]
      };
    });
  };

  const createWorkItem = (projectId: string, values: WorkItemCreateValues) => {
    const title = values.title.trim();
    if (!title) return;
    setWorkspace((previous) => {
      const id = uniqueId("w", title, previous.workItems.map((item) => item.id));
      const durationSeconds = values.kind === "milestone" ? 0 : daysToSeconds(values.durationDays);
      const resourceId = previous.resources[0]?.id;
      const workItem: WorkItem = {
        id,
        projectId,
        parentId: values.parentId || undefined,
        kind: values.kind,
        title,
        outline: nextOutline(previous.workItems, projectId, values.parentId),
        durationSeconds,
        estimate: { mostLikelySeconds: durationSeconds },
        constraint: values.constraintMode === "fixedStart"
          ? { fixedStart: toUtcStart(values.constraintDate) }
          : values.constraintMode === "noEarlierThan"
            ? { noEarlierThan: toUtcStart(values.constraintDate) }
            : undefined,
        assignmentIds: resourceId && values.kind !== "milestone" ? [{ resourceId, attention: values.attention, effortSeconds: hoursToSeconds(values.effortHours) }] : [],
        percentComplete: clamp(values.percentComplete, 0, 100),
        evidenceRequired: values.evidenceRequired,
        isKeyTask: values.isKeyTask,
        isScopeExpansion: values.isScopeExpansion,
        isFastDelivery: values.isFastDelivery
      };
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
      if (!workItem) return previous;
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
      const targets = previous.workItems.filter((item) => item.projectId === projectId && item.kind !== "phase" && item.percentComplete < 100);
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
      const clearedGate: AuditGate = { ...gate, status: "cleared" };
      return {
        ...previous,
        auditGates: [clearedGate, ...previous.auditGates.filter((candidate) => candidate.id !== gate.id)],
        decisions: [
          {
            id: uniqueId("decision", `clear-${gate.id}`, previous.decisions.map((decision) => decision.id)),
            projectId: gate.projectId,
            statement: `Clear ${gate.targetType} gate`,
            context: gate.reason,
            options: ["Clear", "Block", "Defer"],
            rationale: rationale.trim() || gate.requiredAction,
            consequences: "The gate remains documented and no longer blocks the current plan.",
            linkedEvidenceIds: previous.evidence.filter((item) => item.projectId === gate.projectId && (item.workItemId === gate.targetId || gate.targetType === "project")).map((item) => item.id),
            createdAt: timestamp()
          },
          ...previous.decisions
        ],
        changeSets: [
          createChangeSet(
            gate.projectId,
            `Clear gate ${gate.targetType}`,
            "Cleared from Audit Queue after operator review.",
            [{ entity: "AuditGate", entityId: gate.id, field: "status", before: gate.status, after: "cleared" }],
            previous.changeSets.length
          ),
          ...previous.changeSets
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

  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [];

    const projectResults = workspace.projects
      .filter((project) => `${project.name} ${project.currentOutcome} ${project.northStar}`.toLowerCase().includes(query))
      .map((project) => ({
        id: `project-${project.id}`,
        label: project.name,
        detail: project.currentOutcome,
        href: hashForRoute({ view: "project", selectedProjectId: project.id }),
        workItemId: undefined
      }));

    const workItemResults = workspace.workItems
      .filter((item) => `${item.title} ${item.outline}`.toLowerCase().includes(query))
      .map((item) => {
        const project = workspace.projects.find((candidate) => candidate.id === item.projectId);
        return {
          id: `work-${item.id}`,
          label: item.title,
          detail: `${project?.name ?? "Project"} / ${item.outline}`,
          href: hashForRoute({ view: "project", selectedProjectId: item.projectId }),
          workItemId: item.id
        };
      });

    const evidenceResults = workspace.evidence
      .filter((item) => `${item.summary} ${item.kind} ${item.tags.join(" ")}`.toLowerCase().includes(query))
      .map((item) => ({
        id: `evidence-${item.id}`,
        label: item.summary,
        detail: `${item.kind} evidence`,
        href: hashForRoute({ view: "project", selectedProjectId: item.projectId }),
        workItemId: item.workItemId
      }));

    return [...projectResults, ...workItemResults, ...evidenceResults].slice(0, 8);
  }, [searchQuery, workspace]);

  const model = useMemo(() => {
    const schedules = schedulePortfolio(workspace.projects, workspace.workItems, workspace.dependencies);
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
    const overloads = detectCrossProjectOverload(schedules, workspace.resources);
    const leveling = generateLevelingProposals(schedules, workspace.resources);
    return { schedules, gates, decisions, health, overloads, leveling };
  }, [workspace]);

  const selectedSchedule = model.schedules.find((schedule) => schedule.projectId === selectedProject.id) ?? scheduleProject(selectedProject, workspace.workItems, workspace.dependencies);
  const selectedBaseline = workspace.baselines.find((baseline) => baseline.projectId === selectedProject.id);
  const selectedApprovedBaseline = isBaselineApproved(selectedBaseline, workspace.changeSets) ? selectedBaseline : undefined;
  const selectedGates = model.gates.filter((gate) => gate.projectId === selectedProject.id);
  const selectedDecision = model.decisions.find((decision) => decision.projectId === selectedProject.id) ?? model.decisions[0];
  const selectedEvm = selectedApprovedBaseline
    ? calculateEvm(
        selectedProject,
        selectedSchedule.items,
        selectedApprovedBaseline,
        workspace.actuals,
        workspace.resources,
        now
      )
    : undefined;
  const selectedMonteCarlo = runMonteCarlo(
    selectedProject,
    workspace.workItems.filter((item) => item.projectId === selectedProject.id),
    workspace.dependencies.filter((dependency) => dependency.projectId === selectedProject.id),
    300,
    7
  );
  const openHardGateCount = model.gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared").length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-card/95 px-3 py-4 shadow-sm backdrop-blur lg:block">
        <div className="flex items-center gap-3 px-2 pb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">OP</div>
          <div>
            <div className="text-sm font-semibold">OmniPlan Personal</div>
            <div className="text-xs text-muted-foreground">AI-era project OS</div>
          </div>
        </div>
        <nav className="space-y-1" aria-label="Primary">
          <NavButton active={view === "portfolio"} icon={<Home />} label="Portfolio" href={hashForRoute({ view: "portfolio", selectedProjectId })} />
          <NavButton active={view === "project"} icon={<Workflow />} label="Project" href={hashForRoute({ view: "project", selectedProjectId: selectedProject.id })} />
          <NavButton active={view === "today"} icon={<Timer />} label="Today" href={hashForRoute({ view: "today", selectedProjectId })} />
          <NavButton active={view === "audit"} icon={<ShieldAlert />} label="Audit" href={hashForRoute({ view: "audit", selectedProjectId })} />
          <NavButton active={view === "reports"} icon={<FileDown />} label="Reports" href={hashForRoute({ view: "reports", selectedProjectId })} />
          <NavButton active={view === "settings"} icon={<KeyRound />} label="Settings" href={hashForRoute({ view: "settings", selectedProjectId })} />
        </nav>
        <Separator className="my-4" />
        <div className="space-y-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{asOfLabel}</div>
          <div>{openHardGateCount ? `${openHardGateCount} hard gates require review` : "Audit clear"}</div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 border-b bg-background/92 px-4 py-3 backdrop-blur lg:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Portfolio-first personal planning</p>
              <h1 id="page-title" ref={pageTitleRef} tabIndex={-1} className="truncate text-2xl font-semibold tracking-tight outline-none">
                {viewTitle(view, selectedProject.name)}
              </h1>
              <p className="text-xs text-muted-foreground">{breadcrumbFor(view, selectedProject.name)} / {asOfLabel}</p>
            </div>
            <div className="flex items-center gap-2">
              <Sheet open={searchOpen} onOpenChange={setSearchOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" aria-label="Search projects, tasks, and evidence">
                    <Search />
                    <span className="hidden sm:inline">Command</span>
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[92vw] sm:max-w-xl">
                  <SheetHeader>
                    <SheetTitle>Command Search</SheetTitle>
                    <SheetDescription>Search local project, task, and evidence data.</SheetDescription>
                  </SheetHeader>
                  <div className="mt-4 space-y-3">
                    <Input
                      id="global-search"
                      type="search"
                      autoFocus
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setSearchOpen(false);
                      }}
                      placeholder="Project, task, evidence..."
                    />
                    <div className="space-y-2">
                      {searchResults.length ? (
                        searchResults.map((result) => (
                          <a
                            key={result.id}
                            href={result.href}
                            className="block rounded-lg border bg-card p-3 text-sm shadow-sm transition hover:bg-accent"
                            onClick={() => {
                              setFocusedWorkItemId(result.workItemId);
                              setSearchOpen(false);
                            }}
                          >
                            <strong className="block">{result.label}</strong>
                            <span className="text-muted-foreground">{result.detail}</span>
                          </a>
                        ))
                      ) : (
                        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                          {searchQuery.trim() ? "No matching project data. Use New Project or the project work item composer to add it." : "Type to search local project data."}
                        </p>
                      )}
                    </div>
                  </div>
                </SheetContent>
              </Sheet>
              <Badge variant="outline" className="hidden sm:inline-flex">{asOfLabel}</Badge>
              <Badge variant={openHardGateCount ? "destructive" : "success"}>
                {openHardGateCount ? `${openHardGateCount} hard gates` : "Audit clear"}
              </Badge>
            </div>
          </div>
        </header>
        <nav className="fixed inset-x-3 bottom-3 z-30 grid grid-cols-6 rounded-xl border bg-card/95 p-1 shadow-lg backdrop-blur lg:hidden" aria-label="Mobile primary">
          <NavButton active={view === "portfolio"} icon={<Home />} label="Portfolio" href={hashForRoute({ view: "portfolio", selectedProjectId })} />
          <NavButton active={view === "project"} icon={<Workflow />} label="Project" href={hashForRoute({ view: "project", selectedProjectId: selectedProject.id })} />
          <NavButton active={view === "today"} icon={<Timer />} label="Today" href={hashForRoute({ view: "today", selectedProjectId })} />
          <NavButton active={view === "audit"} icon={<ShieldAlert />} label="Audit" href={hashForRoute({ view: "audit", selectedProjectId })} />
          <NavButton active={view === "reports"} icon={<FileDown />} label="Reports" href={hashForRoute({ view: "reports", selectedProjectId })} />
          <NavButton active={view === "settings"} icon={<KeyRound />} label="Settings" href={hashForRoute({ view: "settings", selectedProjectId })} />
        </nav>
        <main className="px-4 py-4 pb-24 lg:px-6 lg:pb-8" aria-labelledby="page-title">
        <div className="routeAnnouncer" aria-live="polite">{breadcrumbFor(view, selectedProject.name)}</div>

        {view === "portfolio" && (
          <PortfolioDashboard
            projects={workspace.projects}
            schedules={model.schedules}
            health={model.health}
            gates={model.gates}
            overloads={model.overloads}
            onProjectCreate={createProject}
          />
        )}
        {view === "project" && (
          <ProjectWorkspace
            project={selectedProject}
            baseline={selectedBaseline}
            baselineApproved={isBaselineApproved(selectedBaseline, workspace.changeSets)}
            dependencies={workspace.dependencies.filter((dependency) => dependency.projectId === selectedProject.id)}
            schedule={selectedSchedule}
            gates={selectedGates}
            health={model.health.find((item) => item.projectId === selectedProject.id)}
            evidence={workspace.evidence.filter((item) => item.projectId === selectedProject.id)}
            onProjectChange={(projectId) => navigate("project", projectId)}
            onProjectStatusUpdate={updateProjectStatus}
            onDirectionCardUpdate={updateDirectionCard}
            onWorkItemCreate={createWorkItem}
            onDependencyCreate={createDependency}
            onEvidenceCreate={createEvidence}
            onActualRecord={recordActual}
            onProjectWorkFinish={finishProjectWork}
            onProjectComplete={(projectId) => updateProjectStatus(projectId, "done")}
            onProjectArchive={(projectId) => updateProjectStatus(projectId, "archived")}
            onBaselineCapture={() => captureBaseline(selectedProject.id, selectedSchedule)}
            onGateClear={clearGate}
            onDependencyUpdate={updateDependency}
            onDependencyRemove={removeDependency}
            projects={workspace.projects}
          />
        )}
        {view === "today" && (
          <TodayExecution
            schedules={model.schedules}
            projects={workspace.projects}
            gates={model.gates}
            onActualRecord={recordActual}
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
        {view === "reports" && (
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
        {view === "settings" && (
          <Settings
            workspace={workspace}
            schedules={model.schedules}
            gates={model.gates}
            workspacePersistence={workspacePersistence}
            onWorkspaceImport={(nextWorkspace) => setWorkspace(nextWorkspace)}
            onWorkspaceReset={() => setWorkspace(sampleWorkspace)}
            onEvidenceImport={importEvidenceItems}
            onAuditDecisionSave={saveAuditDecision}
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
    case "today":
      return "Today Execution";
    case "audit":
      return "Audit Queue";
    case "reports":
      return "Reports";
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
  label
}: {
  active: boolean;
  href: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <a
      data-active={active ? "true" : "false"}
      className={cn(
        "appNavButton flex min-h-10 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground lg:justify-start lg:px-3 lg:text-sm",
        active && "bg-primary text-primary-foreground shadow-sm hover:bg-primary hover:text-primary-foreground"
      )}
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </a>
  );
}

function PortfolioDashboard({
  projects,
  schedules,
  health,
  gates,
  overloads,
  onProjectCreate
}: {
  projects: Project[];
  schedules: ScheduleResult[];
  health: ReturnType<typeof calculateProjectHealth>[];
  gates: AuditGate[];
  overloads: ReturnType<typeof detectCrossProjectOverload>;
  onProjectCreate: (values: ProjectCreateValues) => void;
}) {
  const sorted = [...projects].sort((a, b) => {
    const left = health.find((item) => item.projectId === a.id)?.recommendedFocus ?? 0;
    const right = health.find((item) => item.projectId === b.id)?.recommendedFocus ?? 0;
    return right - left;
  });
  const openHardGates = gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared").length;
  const criticalCount = schedules.reduce((sum, schedule) => sum + schedule.items.filter((item) => item.isCritical).length, 0);
  const focusProject = sorted[0];
  const focusHealth = health.find((item) => item.projectId === focusProject.id);
  const focusSchedule = schedules.find((schedule) => schedule.projectId === focusProject.id);
  const focusNext = focusSchedule ? nextScheduledItem(focusSchedule.items) : undefined;
  const focusGate = gates.find((gate) => gate.projectId === focusProject.id && gate.severity === "hard" && gate.status !== "cleared");
  const overdueRows = schedules
    .flatMap((schedule) => schedule.items.map((item) => ({ item, projectId: schedule.projectId })))
    .filter(({ item }) => item.workItem.kind !== "phase" && item.workItem.percentComplete < 100 && scheduleTiming(item) === "Overdue");
  const staleEvidenceProjects = health.filter((item) => item.evidenceFreshnessDays === undefined || item.evidenceFreshnessDays >= 5);
  const criticalFocus = focusSchedule?.items.filter((item) => item.isCritical && item.workItem.kind !== "phase").length ?? 0;
  const portfolioRisk = Math.round(health.reduce((sum, item) => sum + item.riskScore, 0) / Math.max(1, health.length));

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Portfolio workspace</h2>
          <p className="text-sm text-muted-foreground">Create real projects, then track task progress, evidence, gates, and reports from the same local workspace.</p>
        </div>
        <CreateProjectSheet onCreate={onProjectCreate} />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Layers3 />}
          label="Active projects"
          value={projects.filter((project) => project.status === "active").length}
          detail="Open focus list"
          href={hashForRoute({ view: "portfolio", selectedProjectId: focusProject.id, target: "portfolio-focus-list" })}
        />
        <Metric
          icon={<AlertTriangle />}
          label="Hard gates"
          value={openHardGates}
          tone={openHardGates ? "danger" : "ok"}
          detail="Open audit queue"
          href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "hard-gates" })}
        />
        <Metric
          icon={<Network />}
          label="Critical items"
          value={criticalCount}
          detail="Open today queue"
          href={hashForRoute({ view: "today", selectedProjectId: focusProject.id, target: "critical-items" })}
        />
        <Metric
          icon={<CalendarClock />}
          label="Overloads"
          value={overloads.length}
          tone={overloads.length ? "warn" : "ok"}
          detail="Review leveling"
          href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "leveling-proposals" })}
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><Target className="h-4 w-4" /> Command Brief</CardTitle>
              <CardDescription>Today’s operating decision, blockers, and evidence debt.</CardDescription>
            </div>
            <Badge variant={openHardGates ? "destructive" : "success"}>{openHardGates ? "Action required" : "Clear"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <ActionCard
            tone={focusGate ? "danger" : "neutral"}
            label="Decision gate"
            title={focusGate ? `${focusProject.name}: ${focusGate.targetType}` : "No hard blocker"}
            detail={focusGate?.reason ?? "Use this window to narrow risk before adding more scope."}
            meta={`${openHardGates} hard gates`}
            cta="Audit"
            href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "hard-gates" })}
          />
          <ActionCard
            label={overdueRows.length ? "Overdue work" : focusNext ? `${scheduleTiming(focusNext)} action` : "Next action"}
            title={overdueRows[0]?.item.workItem.title ?? focusNext?.workItem.title ?? "No open scheduled work"}
            detail={overdueRows[0] ? formatScheduleRange(overdueRows[0].item) : focusNext ? formatScheduleRange(focusNext) : "Review baselines before adding new tasks."}
            meta={`${overdueRows.length} overdue`}
            cta="Today"
            href={hashForRoute({ view: "today", selectedProjectId: focusProject.id, target: "critical-items" })}
          />
          <ActionCard
            label="Critical path exposure"
            title={`${criticalFocus} critical items in focus project`}
            detail={focusNext ? `${focusNext.workItem.title} is the next visible constraint.` : `${focusProject.name} has no incomplete scheduled item.`}
            meta={`Risk ${focusHealth?.riskScore ?? portfolioRisk}`}
            cta="Plan"
            href={hashForRoute({ view: "project", selectedProjectId: focusProject.id, target: "project-gantt" })}
          />
          <ActionCard
            tone={staleEvidenceProjects.length ? "warning" : "neutral"}
            label="Evidence debt"
            title={formatFreshness(focusHealth?.evidenceFreshnessDays)}
            detail={`${staleEvidenceProjects.length} project${staleEvidenceProjects.length === 1 ? "" : "s"} need fresher evidence before milestone closure.`}
            meta={`${staleEvidenceProjects.length} stale`}
            cta="Evidence"
            href={hashForRoute({ view: "audit", selectedProjectId: focusProject.id, target: "audit-warnings" })}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(420px,0.92fr)]">
        <Card id="portfolio-focus-list">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> Focus Stack</CardTitle>
            <CardDescription>Ranked by risk, momentum, evidence debt, and hard gates.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
          {sorted.map((project, index) => {
            const projectHealth = health.find((item) => item.projectId === project.id)!;
            const projectSchedule = schedules.find((schedule) => schedule.projectId === project.id);
            const finish = projectSchedule?.items.reduce((max, item) => (item.finish > max ? item.finish : max), project.start);
            const next = projectSchedule ? nextScheduledItem(projectSchedule.items) : undefined;
            const projectCritical = projectSchedule?.items.filter((item) => item.isCritical && item.workItem.kind !== "phase").length ?? 0;
            const action = focusAction(projectHealth, project.status);
            return (
              <a
                key={project.id}
                className={cn(
                  "grid gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition hover:bg-accent/45 md:grid-cols-[96px_minmax(0,1fr)]",
                  projectHealth.openHardGates && "border-destructive/35 bg-destructive/5"
                )}
                href={hashForRoute({ view: "project", selectedProjectId: project.id })}
              >
                <div className="flex items-center gap-2 md:block">
                  <div className={cn("grid h-16 w-20 place-items-center rounded-lg border text-sm font-semibold", action === "Narrow" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/10 text-primary")}>
                    <span>#{index + 1}</span>
                    <span className="text-[10px] uppercase tracking-wide">{action}</span>
                  </div>
                  <Badge variant={project.status === "active" ? "success" : "warning"} className="md:mt-2">{project.status}</Badge>
                </div>
                <div className="min-w-0 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="truncate text-sm font-semibold">{project.name}</h3>
                        <Badge variant="secondary">{project.mode}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{project.currentOutcome}</p>
                    </div>
                    <Button asChild variant={projectHealth.openHardGates ? "destructive" : "outline"} size="sm">
                      <span>{projectHealth.openHardGates ? "Review gate" : "Open project"}</span>
                    </Button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3" aria-label={`${project.name} focus signals`}>
                  <SignalBar label="Risk" value={projectHealth.riskScore} tone={projectHealth.riskScore >= 70 ? "danger" : projectHealth.riskScore >= 45 ? "warn" : "ok"} />
                  <SignalBar label="Momentum" value={projectHealth.momentumScore} tone="ok" />
                  <SignalBar label="Evidence debt" value={evidenceFreshnessScore(projectHealth.evidenceFreshnessDays)} tone={projectHealth.evidenceFreshnessDays === undefined || projectHealth.evidenceFreshnessDays >= 5 ? "danger" : "ok"} />
                  </div>
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <span><b className="text-foreground">{next ? scheduleTiming(next) : "Next"}</b><br />{next?.workItem.title ?? "none"}</span>
                    <span><b className="text-foreground">Hard gates</b><br />{projectHealth.openHardGates}</span>
                    <span><b className="text-foreground">Finish</b><br />{finish ? formatShortDateTime(finish) : "none"} / {projectCritical} critical</span>
                  </div>
                </div>
              </a>
            );
          })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Momentum x Risk</CardTitle>
            <CardDescription>Position shows project pressure; red outline means hard gate.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="matrix compactMatrix">
          <span className="matrixZone zoneAudit">Audit gate</span>
          <span className="matrixZone zoneNarrow">Narrow / stop</span>
          <span className="matrixZone zoneWatch">Watch evidence</span>
          <span className="matrixZone zoneShip">Push</span>
          {projects.map((project) => {
            const item = health.find((candidate) => candidate.projectId === project.id)!;
            return (
              <a
                key={project.id}
                className={`matrixNode ${item.openHardGates ? "hasGate" : ""}`}
                style={{ left: `${Math.min(78, Math.max(22, item.momentumScore))}%`, bottom: `${Math.min(78, Math.max(14, item.riskScore))}%` }}
                href={hashForRoute({ view: "project", selectedProjectId: project.id })}
                title={`${project.name}: momentum ${item.momentumScore}, risk ${item.riskScore}`}
                aria-label={`${project.name}, momentum ${item.momentumScore}, risk ${item.riskScore}, status ${project.status}`}
              >
                <span className={`statusDot ${project.status}`} />
                <span className="srOnly">Status {project.status}</span>
                <span className="matrixNodeName">{compactProjectLabel(project.name)}</span>
                <span className="matrixNodeMeta">R{item.riskScore} M{item.momentumScore}</span>
              </a>
            );
          })}
          <span className="axis x">Momentum</span>
          <span className="axis y">Risk</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Position = risk / momentum</Badge>
              <Badge variant="outline">Higher risk is up</Badge>
              <Badge variant="outline">More momentum is right</Badge>
              <Badge variant="outline">Red = hard gate</Badge>
              <Badge variant="outline">Open project by clicking node</Badge>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> Audit Signals</CardTitle>
          <CardDescription>Current hard and warning signals across the portfolio.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignalList gates={gates.slice(0, 7)} />
        </CardContent>
      </Card>
    </section>
  );
}

function CreateProjectSheet({ onCreate }: { onCreate: (values: ProjectCreateValues) => void }) {
  const today = now.slice(0, 10);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProjectCreateValues>({
    name: "",
    mode: "build",
    startDate: today,
    horizonDate: addSeconds(`${today}T00:00:00.000Z`, 30 * daySeconds).slice(0, 10),
    northStar: "",
    currentOutcome: "",
    targetUser: "",
    userProblem: "",
    coreHypothesis: "",
    successMetric: "",
    failureCondition: "",
    validationMethod: "",
    timeboxDays: 14,
    opportunityCost: ""
  });
  const update = (patch: Partial<ProjectCreateValues>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    onCreate(draft);
    setOpen(false);
    setDraft((current) => ({ ...current, name: "", northStar: "", currentOutcome: "", targetUser: "", userProblem: "", coreHypothesis: "", successMetric: "", failureCondition: "", validationMethod: "", opportunityCost: "", timeboxDays: 14 }));
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus />
          New Project
        </Button>
      </SheetTrigger>
      <SheetContent className="w-[94vw] overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Create Project</SheetTitle>
          <SheetDescription>Start a real local project with an initial Direction Card and evidence milestone.</SheetDescription>
        </SheetHeader>
        <form className="mt-4 grid gap-4" onSubmit={submit}>
          <div className="grid gap-3 md:grid-cols-2">
            <SettingsInput label="Project name" name="project-name" value={draft.name} onChange={(value) => update({ name: value })} placeholder="SaaS MVP / Meeting plan / Japan trip" autoComplete="off" testId="project-name" />
            <NativeSelectField
              label="Mode"
              value={draft.mode}
              onChange={(value) => update({ mode: value as ProjectMode })}
              options={projectModes.map((mode) => ({ value: mode, label: mode }))}
              testId="project-mode"
            />
            <SettingsInput label="Start date" name="project-start" value={draft.startDate} onChange={(value) => update({ startDate: value })} placeholder="2026-07-01" autoComplete="off" testId="project-start" />
            <SettingsInput label="Horizon date" name="project-horizon" value={draft.horizonDate} onChange={(value) => update({ horizonDate: value })} placeholder="2026-08-01" autoComplete="off" testId="project-horizon" />
          </div>
          <SettingsInput label="North star" name="project-north-star" value={draft.northStar} onChange={(value) => update({ northStar: value })} placeholder="What must this project become true?" autoComplete="off" testId="project-north-star" />
          <SettingsInput label="Current outcome" name="project-outcome" value={draft.currentOutcome} onChange={(value) => update({ currentOutcome: value })} placeholder="The next concrete outcome to manage toward" autoComplete="off" testId="project-current-outcome" />
          <div className="grid gap-3 md:grid-cols-2">
            <SettingsInput label="Target user" name="direction-target-user" value={draft.targetUser} onChange={(value) => update({ targetUser: value })} placeholder="Who is this for?" autoComplete="off" testId="direction-target-user" />
            <SettingsInput label="User problem" name="direction-user-problem" value={draft.userProblem} onChange={(value) => update({ userProblem: value })} placeholder="What problem justifies the work?" autoComplete="off" testId="direction-user-problem" />
            <SettingsInput label="Core hypothesis" name="direction-hypothesis" value={draft.coreHypothesis} onChange={(value) => update({ coreHypothesis: value })} placeholder="What must be proven?" autoComplete="off" testId="direction-core-hypothesis" />
            <SettingsInput label="Success metric" name="direction-success" value={draft.successMetric} onChange={(value) => update({ successMetric: value })} placeholder="How will evidence show success?" autoComplete="off" testId="direction-success-metric" />
            <SettingsInput label="Failure condition" name="direction-failure" value={draft.failureCondition} onChange={(value) => update({ failureCondition: value })} placeholder="When should this narrow, pivot, or stop?" autoComplete="off" testId="direction-failure-condition" />
            <SettingsInput label="Validation method" name="direction-validation" value={draft.validationMethod} onChange={(value) => update({ validationMethod: value })} placeholder="How will this be checked?" autoComplete="off" testId="direction-validation-method" />
            <SettingsInput label="Opportunity cost" name="direction-opportunity-cost" value={draft.opportunityCost} onChange={(value) => update({ opportunityCost: value })} placeholder="What is being displaced?" autoComplete="off" testId="direction-opportunity-cost" />
            <label className="block">
              <span className="text-sm font-medium">Timebox days</span>
              <Input className="mt-2" type="number" min={1} max={365} value={draft.timeboxDays} onChange={(event) => update({ timeboxDays: Number(event.target.value) || 14 })} />
            </label>
          </div>
          <Button type="submit" disabled={!draft.name.trim()}>Create project</Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ProjectWorkspace({
  project,
  projects,
  baseline,
  baselineApproved,
  dependencies,
  schedule,
  gates,
  health,
  evidence,
  onProjectChange,
  onProjectStatusUpdate,
  onDirectionCardUpdate,
  onWorkItemCreate,
  onDependencyCreate,
  onEvidenceCreate,
  onActualRecord,
  onProjectWorkFinish,
  onProjectComplete,
  onProjectArchive,
  onBaselineCapture,
  onGateClear,
  onDependencyUpdate,
  onDependencyRemove
}: {
  project: Project;
  projects: Project[];
  baseline?: Baseline;
  baselineApproved: boolean;
  dependencies: Dependency[];
  schedule: ScheduleResult;
  gates: AuditGate[];
  health?: ReturnType<typeof calculateProjectHealth>;
  evidence: Evidence[];
  onProjectChange: (projectId: string) => void;
  onProjectStatusUpdate: (projectId: string, status: ProjectStatus) => void;
  onDirectionCardUpdate: (projectId: string, directionCard: DirectionCard) => void;
  onWorkItemCreate: (projectId: string, values: WorkItemCreateValues) => void;
  onDependencyCreate: (projectId: string, values: DependencyCreateValues) => void;
  onEvidenceCreate: (projectId: string, values: EvidenceCreateValues) => void;
  onActualRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
  onProjectWorkFinish: (projectId: string) => void;
  onProjectComplete: (projectId: string) => void;
  onProjectArchive: (projectId: string) => void;
  onBaselineCapture: () => void;
  onGateClear: (gate: AuditGate, rationale: string) => void;
  onDependencyUpdate: (dependencyId: string, patch: DependencyPatch) => void;
  onDependencyRemove: (dependencyId: string) => void;
}) {
  const next = nextScheduledItem(schedule.items);
  const blockingGate = gates.find((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const latestEvidence = [...evidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return (
    <section className="grid gap-4">
      <Card>
        <CardContent className="grid gap-4 p-4 lg:grid-cols-[minmax(260px,0.7fr)_minmax(0,1.3fr)]">
          <div className="space-y-3">
            <NativeSelectField
              label="Project"
              value={project.id}
              onChange={onProjectChange}
              options={projects.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              testId="project-selector"
            />
            <NativeSelectField
              label="Lifecycle status"
              value={project.status}
              onChange={(value) => onProjectStatusUpdate(project.id, value as ProjectStatus)}
              options={projectStatuses.map((status) => ({ value: status, label: status }))}
              testId="project-status-selector"
            />
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{project.mode}</Badge>
              <Badge variant="outline">Horizon {project.horizon.slice(0, 10)}</Badge>
              <Badge variant={blockingGate ? "destructive" : "success"}>{blockingGate ? "Hard gate" : "No blocker"}</Badge>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <SummaryTile label={next ? `${scheduleTiming(next)} action` : "Next action"} value={next?.workItem.title ?? "No open scheduled work"} detail={next ? `${formatScheduleRange(next)} / ${next.isCritical ? "critical path" : "non-critical"}` : "Review baselines before adding more work."} />
            <SummaryTile label="Audit state" value={blockingGate ? "Blocked by hard gate" : "No hard blocker"} detail={blockingGate?.reason ?? "Warnings still need review before milestone closure."} tone={blockingGate ? "danger" : "default"} />
            <SummaryTile label="Evidence" value={formatFreshness(health?.evidenceFreshnessDays)} detail={latestEvidence?.summary ?? "Attach evidence before marking the next milestone complete."} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{project.northStar}</CardTitle>
          <CardDescription>{project.currentOutcome}</CardDescription>
        </CardHeader>
        <CardContent>
          <DirectionCardPanel project={project} onSave={(directionCard) => onDirectionCardUpdate(project.id, directionCard)} />
        </CardContent>
      </Card>

      <Tabs defaultValue="plan" className="w-full">
        <TabsList className="grid w-full grid-cols-5 lg:w-auto">
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="baselines">Baselines</TabsTrigger>
          <TabsTrigger value="reports">Reports</TabsTrigger>
        </TabsList>
        <TabsContent value="plan" className="grid gap-4 xl:grid-cols-[minmax(320px,0.78fr)_minmax(0,1.22fr)]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2"><Workflow className="h-4 w-4" /> Outline</CardTitle>
              <CardDescription>WBS, status, evidence, and float.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <WorkItemComposer
                projectId={project.id}
                items={schedule.items.map((item) => item.workItem)}
                onCreate={onWorkItemCreate}
              />
              <OutlineTable items={schedule.items} gates={gates} evidence={evidence} />
            </CardContent>
          </Card>
          <div className="grid gap-4">
            <Card id="project-gantt">
              <CardHeader className="flex-row items-start justify-between gap-3 pb-2">
                <div>
                  <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Gantt</CardTitle>
                  <CardDescription>Dependencies, baseline, critical path, and minimap.</CardDescription>
                </div>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="sm"><Network /> Network</Button>
                  </SheetTrigger>
                  <SheetContent className="w-[92vw] sm:max-w-3xl">
                    <SheetHeader>
                      <SheetTitle>Network Graph</SheetTitle>
                      <SheetDescription>Secondary dependency view for {project.name}.</SheetDescription>
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
                <GanttChart
                  items={schedule.items}
                  dependencies={dependencies}
                  baseline={baseline}
                  onDependencyUpdate={onDependencyUpdate}
                  onDependencyRemove={onDependencyRemove}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2"><PanelRight className="h-4 w-4" /> Inspector</CardTitle>
              </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
                <SummaryTile label="Critical path" value={`${schedule.items.filter((item) => item.isCritical).length} items`} detail="Current scheduled critical chain" />
                <SummaryTile label="Diagnostics" value={String(schedule.diagnostics.length)} detail="Scheduler messages" />
                <SummaryTile label="Open gates" value={String(gates.length)} detail="Audit pressure on this project" tone={gates.length ? "danger" : "default"} />
                <TaskProgressPanel projectId={project.id} items={schedule.items.map((item) => item.workItem)} onRecord={onActualRecord} />
            </CardContent>
          </Card>
          <ProjectCompletionPanel
            project={project}
            items={schedule.items.map((item) => item.workItem)}
            gates={gates}
            evidence={evidence}
            baselineApproved={baselineApproved}
            onFinishWork={() => onProjectWorkFinish(project.id)}
            onComplete={() => onProjectComplete(project.id)}
            onArchive={() => onProjectArchive(project.id)}
          />
        </div>
      </TabsContent>
        <TabsContent value="evidence">
          <Card>
            <CardHeader>
              <CardTitle>Evidence</CardTitle>
              <CardDescription>Manual and imported evidence linked to this project.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <EvidenceComposer projectId={project.id} items={schedule.items.map((item) => item.workItem)} onCreate={onEvidenceCreate} />
              <EvidenceList evidence={evidence} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle>Audit Gates</CardTitle>
              <CardDescription>Hard gates block only key decisions.</CardDescription>
            </CardHeader>
            <CardContent>
              <SignalList gates={gates} onClear={onGateClear} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="baselines">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Baseline</CardTitle>
                  <CardDescription>{baseline ? `${baselineApproved ? "Approved" : "Pending approval"}: ${baseline.name}, captured ${baseline.capturedAt.slice(0, 10)}` : "No baseline captured."}</CardDescription>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {baseline && <Badge variant={baselineApproved ? "success" : "warning"}>{baselineApproved ? "approved" : "pending"}</Badge>}
                  <Button type="button" variant="outline" onClick={onBaselineCapture}>Capture baseline</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <BaselineTable baseline={baseline} items={schedule.items} />
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="reports">
          <Card>
            <CardHeader>
              <CardTitle>Project Report Snapshot</CardTitle>
              <CardDescription>Use Reports for export; this tab keeps key values in project context.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              <SummaryTile label="Finish p50" value={runMonteCarlo(project, schedule.items.map((item) => item.workItem), dependencies, 120, 3).p50Finish.slice(0, 10)} detail="Seeded local simulation" />
              <SummaryTile label="Baseline" value={baseline ? baseline.name : "Missing"} detail={baseline ? `${baselineApproved ? "approved" : "pending"} / ${baseline.capturedAt.slice(0, 10)}` : "EVM blocked"} tone={baseline && !baselineApproved ? "warning" : "default"} />
              <SummaryTile label="Evidence freshness" value={formatFreshness(health?.evidenceFreshnessDays)} detail="Latest linked evidence" />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
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
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Direction Card</h3>
          <p className="text-xs text-muted-foreground">Project-level audit gates depend on these fields.</p>
        </div>
        <Button type="submit" size="sm">Save direction</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <SettingsInput label="Target user" name={`target-user-${project.id}`} value={draft.targetUser} onChange={(value) => update({ targetUser: value })} placeholder="Who is this for?" autoComplete="off" />
        <SettingsInput label="Business goal" name={`business-goal-${project.id}`} value={draft.businessGoal} onChange={(value) => update({ businessGoal: value })} placeholder="Why does it matter?" autoComplete="off" />
        <SettingsInput label="Core hypothesis" name={`hypothesis-${project.id}`} value={draft.coreHypothesis} onChange={(value) => update({ coreHypothesis: value })} placeholder="What must be proven?" autoComplete="off" />
        <SettingsInput label="Success metric" name={`success-${project.id}`} value={draft.successMetric} onChange={(value) => update({ successMetric: value })} placeholder="What evidence means continue?" autoComplete="off" />
        <SettingsInput label="Failure condition" name={`failure-${project.id}`} value={draft.failureCondition} onChange={(value) => update({ failureCondition: value })} placeholder="What means narrow/pivot/stop?" autoComplete="off" />
        <SettingsInput label="Validation method" name={`validation-${project.id}`} value={draft.validationMethod} onChange={(value) => update({ validationMethod: value })} placeholder="How will evidence be checked?" autoComplete="off" />
        <SettingsInput label="Opportunity cost" name={`opportunity-${project.id}`} value={draft.opportunityCost} onChange={(value) => update({ opportunityCost: value })} placeholder="What else is not being done?" autoComplete="off" />
        <label className="block">
          <span className="text-sm font-medium">Timebox days</span>
          <Input className="mt-2" type="number" min={1} max={365} value={draft.timeboxDays} onChange={(event) => update({ timeboxDays: Number(event.target.value) || 1 })} />
        </label>
      </div>
      <FormTextarea label="User problem" value={draft.userProblem} onChange={(value) => update({ userProblem: value })} placeholder="Describe the problem in plain language." />
    </form>
  );
}

function ProjectCompletionPanel({
  project,
  items,
  gates,
  evidence,
  baselineApproved,
  onFinishWork,
  onComplete,
  onArchive
}: {
  project: Project;
  items: WorkItem[];
  gates: AuditGate[];
  evidence: Evidence[];
  baselineApproved: boolean;
  onFinishWork: () => void;
  onComplete: () => void;
  onArchive: () => void;
}) {
  const completableItems = items.filter((item) => item.kind !== "phase");
  const incompleteItems = completableItems.filter((item) => item.percentComplete < 100);
  const openHardGates = gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const keyItemsMissingEvidence = completableItems.filter((item) => (
    (item.evidenceRequired || item.isKeyTask) &&
    !evidence.some((candidate) => candidate.workItemId === item.id)
  ));
  const readyToComplete = incompleteItems.length === 0 && openHardGates.length === 0 && keyItemsMissingEvidence.length === 0 && baselineApproved;
  const canArchive = project.status === "done" || project.status === "archived";
  const badgeLabel = project.status === "archived" ? "archived" : project.status === "done" ? "done" : readyToComplete ? "ready for done" : "not ready";
  const badgeVariant = project.status === "archived" || project.status === "done" || readyToComplete ? "success" : "warning";

  return (
    <Card id="project-completion">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Completion Gate</CardTitle>
            <CardDescription>Finish work, verify evidence and audit state, then move the project to done or archived.</CardDescription>
          </div>
          <Badge variant={badgeVariant}>{badgeLabel}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryTile label="Open work" value={String(incompleteItems.length)} detail={incompleteItems[0]?.title ?? "All non-phase work is complete."} tone={incompleteItems.length ? "warning" : "default"} />
          <SummaryTile label="Missing evidence" value={String(keyItemsMissingEvidence.length)} detail={keyItemsMissingEvidence[0]?.title ?? "Key and evidence-required work is linked."} tone={keyItemsMissingEvidence.length ? "danger" : "default"} />
          <SummaryTile label="Hard gates" value={String(openHardGates.length)} detail={openHardGates[0]?.reason ?? "No hard gate is open."} tone={openHardGates.length ? "danger" : "default"} />
          <SummaryTile label="Baseline" value={baselineApproved ? "Approved" : "Pending"} detail={baselineApproved ? "Baseline can be used for final reporting." : "Capture and approve a baseline first."} tone={baselineApproved ? "default" : "warning"} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={onFinishWork} disabled={!incompleteItems.length} data-testid="lifecycle-finish-open-work">
            <CheckCircle2 />
            Finish all open work
          </Button>
          <Button type="button" onClick={onComplete} disabled={!readyToComplete || project.status === "done" || project.status === "archived"} data-testid="lifecycle-set-done">
            Set project done
          </Button>
          <Button type="button" variant="outline" onClick={onArchive} disabled={!canArchive || project.status === "archived"} data-testid="lifecycle-archive-project">
            <Archive />
            Archive
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function WorkItemComposer({
  projectId,
  items,
  onCreate
}: {
  projectId: string;
  items: WorkItem[];
  onCreate: (projectId: string, values: WorkItemCreateValues) => void;
}) {
  const [draft, setDraft] = useState<WorkItemCreateValues>({
    title: "",
    kind: "task",
    parentId: undefined,
    durationDays: 1,
    effortHours: 2,
    attention: "deep",
    constraintMode: "none",
    constraintDate: now.slice(0, 10),
    percentComplete: 0,
    evidenceRequired: false,
    isKeyTask: false,
    isScopeExpansion: false,
    isFastDelivery: false
  });
  const update = (patch: Partial<WorkItemCreateValues>) => setDraft((current) => ({ ...current, ...patch }));
  const parentOptions = items.filter((item) => item.kind === "phase");
  return (
    <form
      className="rounded-lg border bg-muted/25 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.title.trim()) return;
        onCreate(projectId, draft);
        setDraft((current) => ({
          ...current,
          title: "",
          kind: "task",
          durationDays: 1,
          effortHours: 2,
          percentComplete: 0,
          evidenceRequired: false,
          isKeyTask: false,
          isScopeExpansion: false,
          isFastDelivery: false
        }));
      }}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong className="text-sm">Add work item</strong>
          <p className="text-xs text-muted-foreground">Create phases, tasks, milestones, or evidence-gated work.</p>
        </div>
        <Button type="submit" size="sm" disabled={!draft.title.trim()}><Plus />Add</Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <SettingsInput label="Title" name={`work-title-${projectId}`} value={draft.title} onChange={(value) => update({ title: value })} placeholder="Task or milestone title" autoComplete="off" />
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
        <SettingsInput label="Constraint date" name={`constraint-date-${projectId}`} value={draft.constraintDate} onChange={(value) => update({ constraintDate: value })} placeholder="2026-07-01" autoComplete="off" />
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-sm">
        <ToggleField label="Evidence required" checked={draft.evidenceRequired} onChange={(checked) => update({ evidenceRequired: checked })} />
        <ToggleField label="Key task" checked={draft.isKeyTask} onChange={(checked) => update({ isKeyTask: checked })} />
        <ToggleField label="Scope expansion" checked={draft.isScopeExpansion} onChange={(checked) => update({ isScopeExpansion: checked })} />
        <ToggleField label="Fast delivery" checked={draft.isFastDelivery} onChange={(checked) => update({ isFastDelivery: checked })} />
      </div>
    </form>
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

function TodayExecution({
  projects,
  schedules,
  gates,
  onActualRecord
}: {
  projects: Project[];
  schedules: ScheduleResult[];
  gates: AuditGate[];
  onActualRecord: (projectId: string, workItemId: string, values: ActualRecordValues) => void;
}) {
  const rows = schedules
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
      const timing = scheduleTiming(item);
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
  const activeRows = rows.filter((row) => row.timing !== "Upcoming").slice(0, 8);
  const upcomingRows = rows.filter((row) => row.timing === "Upcoming").slice(0, 4);

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card id="critical-items">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Timer className="h-4 w-4" /> Due or Overdue</CardTitle>
          <CardDescription>Execution queue. Hard gates lock only key decisions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {activeRows.length ? activeRows.map(({ item, project, gate, warningGate, timing }) => (
            <article className={cn("grid gap-3 rounded-lg border bg-background p-3", gate && "border-destructive/35 bg-destructive/5")} key={item.workItem.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <strong className="block text-sm">{item.workItem.title}</strong>
                <span className="text-xs text-muted-foreground">{project.name} / {timing}</span>
                {gate && <span className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><Lock size={13} />Locked: {gate.reason}</span>}
                {!gate && warningGate && <span className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700"><AlertTriangle size={13} />Warning: {warningGate.reason}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {item.isCritical && <Badge variant="destructive">critical</Badge>}
                <Badge variant="outline">{formatScheduleRange(item)}</Badge>
                <Badge variant="secondary">{formatAssignmentHours(item)}h</Badge>
              </div>
              </div>
              {!gate && <InlineActualForm projectId={project.id} item={item.workItem} onRecord={onActualRecord} />}
            </article>
          )) : <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No overdue or due-today work.</div>}
        </CardContent>
      </Card>
      <Card id="today-upcoming">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Upcoming Watchlist</CardTitle>
          <CardDescription>Near-term work to protect from direction drift.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {upcomingRows.length ? upcomingRows.map(({ item, project, gate, warningGate }) => (
            <article className={cn("grid gap-3 rounded-lg border bg-muted/30 p-3", gate && "border-destructive/35 bg-destructive/5")} key={item.workItem.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <strong className="block text-sm">{item.workItem.title}</strong>
                <span className="text-xs text-muted-foreground">{project.name}</span>
                {gate && <span className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><Lock size={13} />Locked: {gate.reason}</span>}
                {!gate && warningGate && <span className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700"><AlertTriangle size={13} />Warning: {warningGate.reason}</span>}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {item.isCritical && <Badge variant="destructive">critical</Badge>}
                <Badge variant="outline">{formatScheduleRange(item)}</Badge>
              </div>
              </div>
              {!gate && <InlineActualForm projectId={project.id} item={item.workItem} onRecord={onActualRecord} compact />}
            </article>
          )) : <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No upcoming work in the reviewed queue.</div>}
        </CardContent>
      </Card>
      <Card id="today-blocking-gates" className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Blocking Gates</CardTitle>
        </CardHeader>
        <CardContent>
          <SignalList gates={sortGates(gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared")).slice(0, 8)} />
        </CardContent>
      </Card>
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
      className="grid gap-2 rounded-md border bg-background/80 p-2 sm:grid-cols-[1fr_1fr_auto_auto]"
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
      <label className="block">
        <span className="text-xs font-medium text-muted-foreground">Percent</span>
        <Input className="mt-1 h-8" type="number" min={0} max={100} value={percentComplete} onChange={(event) => setPercentComplete(Number(event.target.value) || 0)} />
      </label>
      <label className={cn("block", compact && "hidden sm:block")}>
        <span className="text-xs font-medium text-muted-foreground">Actual h</span>
        <Input className="mt-1 h-8" type="number" min={0} step={0.25} value={actualWorkHours} onChange={(event) => setActualWorkHours(Number(event.target.value) || 0)} />
      </label>
      <Button type="submit" size="sm" variant="outline" className="self-end">Save</Button>
      <Button
        type="button"
        size="sm"
        className="self-end"
        onClick={() => onRecord(projectId, item.id, {
          percentComplete: 100,
          actualWorkHours,
          remainingWorkHours: 0,
          actualCost: actualWorkHours,
          markFinished: true
        })}
      >
        Done
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
  const hardGates = sortGates(gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared"));
  const warningGates = sortGates(gates.filter((gate) => gate.severity !== "hard" && gate.status !== "cleared"));
  const workById = new Map(schedules.flatMap((schedule) => schedule.items.map((item) => [item.workItem.id, { item, projectId: schedule.projectId }])));
  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card id="hard-gates">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Hard Gates</CardTitle>
          <CardDescription>Only key decisions are blocked.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignalList gates={hardGates} onClear={onGateClear} />
        </CardContent>
      </Card>
      <Card id="audit-decisions">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> Contrarian Decisions</CardTitle>
          <CardDescription>Default operator stance is skeptical until evidence clears risk.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {decisions.map((decision) => (
            <article className="grid gap-3 rounded-lg border bg-background p-3 sm:grid-cols-[96px_minmax(0,1fr)_auto]" key={decision.id}>
              <Badge variant={decision.action === "Stop" || decision.action === "Pivot" || decision.action === "Narrow" ? "destructive" : "secondary"} className="h-fit justify-center">{decision.action}</Badge>
              <div>
                <strong className="text-sm">{projects.find((project) => project.id === decision.projectId)?.name}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{decision.strongestStopReason}</p>
              </div>
              <AuditDecisionRecorder
                projectId={decision.projectId}
                gates={gates.filter((gate) => gate.projectId === decision.projectId && gate.status !== "cleared")}
                defaultAction={decision.action}
                onRecord={onAuditDecisionRecord}
              />
            </article>
          ))}
        </CardContent>
      </Card>
      <Card id="audit-warnings">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Warnings</CardTitle>
        </CardHeader>
        <CardContent>
          <SignalList gates={warningGates.slice(0, 8)} onClear={onGateClear} />
        </CardContent>
      </Card>
      <Card id="baseline-change-sets">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><Archive className="h-4 w-4" /> Change Sets</CardTitle>
          <CardDescription>Review local structural edits before syncing; blocked changes are excluded from outgoing sync.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {changeSets.length ? changeSets.map((changeSet) => (
            <article className="grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[18px_minmax(0,1fr)_auto]" key={changeSet.id}>
              <GitPullRequest size={15} className="mt-0.5 text-muted-foreground" />
              <div>
                <strong className="text-sm">{changeSet.title}</strong>
                <p className="mt-1 text-xs text-muted-foreground">{changeSet.status} / {changeSet.reason}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => onChangeSetStatus(changeSet.id, "approved")} disabled={changeSet.status === "approved"}>Approve</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => onChangeSetStatus(changeSet.id, "blocked")} disabled={changeSet.status === "blocked"}>Block</Button>
              </div>
            </article>
          )) : <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><CheckCircle2 size={16} />No baseline changes</div>}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2" id="leveling-proposals">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> Leveling Proposals</CardTitle>
          <CardDescription>Local optimizer suggestions for attention overload.</CardDescription>
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
              {leveling.map((proposal) => {
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
      className="grid min-w-56 gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        onRecord(projectId, action, gates, rationale);
        setRationale("");
      }}
    >
      <NativeSelectField
        label="Audit action"
        value={action}
        onChange={(value) => setAction(value as AuditAction)}
        options={auditActions.map((item) => ({ value: item, label: item }))}
        testId="audit-action"
      />
      <Input value={rationale} onChange={(event) => setRationale(event.target.value)} placeholder="Decision rationale" />
      <Button type="submit" size="sm">Record decision</Button>
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
  return (
    <section className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric icon={<BarChart3 />} label="SPI" value={evm ? evm.schedulePerformanceIndex.toFixed(2) : "No baseline"} tone={evm ? undefined : "warn"} />
        <Metric icon={<BarChart3 />} label="CPI" value={evm ? evm.costPerformanceIndex.toFixed(2) : "No baseline"} tone={evm ? undefined : "warn"} />
        <Metric icon={<Timer />} label="P50" value={p50.slice(5, 10)} />
        <Metric icon={<AlertTriangle />} label="Hard gates" value={openHardGates.length} tone={openHardGates.length ? "danger" : "ok"} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Report Gate Status</CardTitle>
          <CardDescription>
            {openHardGates.length
              ? `${openHardGates.length} hard gate${openHardGates.length === 1 ? "" : "s"} must be cleared before this report can be treated as approved.`
              : "No hard gates are open for this project."}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <SummaryTile label="Baseline" value={baseline ? baseline.name : "No baseline"} detail={baseline ? `Captured ${baseline.capturedAt.slice(0, 10)}` : "EVM is blocked."} />
          <SummaryTile label="Monte Carlo p90" value={p90.slice(0, 10)} detail="Seeded local simulation" />
        </CardContent>
      </Card>
      <Card id="scheduler-diagnostics">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Scheduler Diagnostics</CardTitle>
          <CardDescription>Explicit schedule warnings and unsupported cases. The engine must report rather than silently hide unsafe plans.</CardDescription>
        </CardHeader>
        <CardContent>
          {schedule.diagnostics.length ? (
            <div className="grid gap-2">
              {schedule.diagnostics.map((diagnostic, index) => (
                <article className={cn("rounded-lg border bg-background p-3", diagnostic.severity === "error" && "border-destructive/35 bg-destructive/5", diagnostic.severity === "warning" && "border-amber-300 bg-amber-50/60")} key={`${diagnostic.itemId ?? "portfolio"}-${diagnostic.message}-${index}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={diagnostic.severity === "error" ? "destructive" : diagnostic.severity === "warning" ? "warning" : "secondary"}>{diagnostic.severity}</Badge>
                    {diagnostic.itemId && <Badge variant="outline">{diagnostic.itemId}</Badge>}
                  </div>
                  <p className="mt-2 text-sm">{diagnostic.message}</p>
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
            {schedule.items.map((item) => (
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
        </CardContent>
      </Card>
    </section>
  );
}

function Settings({
  workspace,
  schedules,
  gates,
  workspacePersistence,
  onWorkspaceImport,
  onWorkspaceReset,
  onEvidenceImport,
  onAuditDecisionSave
}: {
  workspace: WorkspaceSnapshot;
  schedules: ScheduleResult[];
  gates: AuditGate[];
  workspacePersistence: { loaded: boolean; status: string; lastSavedAt: string };
  onWorkspaceImport: (workspace: WorkspaceSnapshot) => void;
  onWorkspaceReset: () => void;
  onEvidenceImport: (projectId: string, evidenceItems: Evidence[], reason: string) => void;
  onAuditDecisionSave: (decision: AuditDecision, reason: string) => void;
}) {
  const settingsRepository = useMemo(() => new BrowserAppSettingsRepository(), []);
  const secretVault = useMemo(() => new BrowserEncryptedSecretVault(), []);
  const workspaceRepository = useMemo(() => new BrowserWorkspaceRepository(), []);
  const workspaceImportRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState(() => settingsRepository.load());
  const [githubDraft, setGithubDraft] = useState<GitHubSyncSettings>(() => settings.githubSync);
  const [aiDraft, setAiDraft] = useState<AiProviderSettings>(() => settings.aiProviders[0] ?? defaultCustomAiProviderSettings);
  const [passphrase, setPassphrase] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [aiProviderKey, setAiProviderKey] = useState("");
  const [notice, setNotice] = useState("No settings action has run yet.");
  const [savedSecretCount, setSavedSecretCount] = useState(() => secretVault.listEncrypted().length);
  const [syncBusy, setSyncBusy] = useState(false);
  const [evidenceProjectId, setEvidenceProjectId] = useState(() => workspace.projects[0]?.id ?? defaultProjectId);
  const [evidenceWorkItemId, setEvidenceWorkItemId] = useState<string>("project");
  const [auditProjectId, setAuditProjectId] = useState(() => workspace.projects[0]?.id ?? defaultProjectId);
  const [aiBusy, setAiBusy] = useState(false);
  const githubSecret = githubDraft.tokenSecretId ? secretVault.readEncrypted(githubDraft.tokenSecretId) : undefined;
  const aiSecret = aiDraft.apiKeySecretId ? secretVault.readEncrypted(aiDraft.apiKeySecretId) : undefined;
  const gitHubReady = Boolean(githubDraft.owner.trim() && githubDraft.repo.trim() && githubDraft.tokenSecretId);
  const evidenceProject = workspace.projects.find((project) => project.id === evidenceProjectId) ?? workspace.projects[0];
  const evidenceWorkItems = workspace.workItems.filter((item) => item.projectId === evidenceProject?.id && item.kind !== "phase");
  const auditProject = workspace.projects.find((project) => project.id === auditProjectId) ?? workspace.projects[0];
  const auditSchedule = schedules.find((schedule) => schedule.projectId === auditProject?.id) ?? (auditProject ? scheduleProject(auditProject, workspace.workItems, workspace.dependencies) : undefined);

  const updateGithubDraft = (patch: Partial<GitHubSyncSettings>) => {
    setGithubDraft((current) => ({ ...current, ...patch }));
  };

  const updateAiDraft = (patch: Partial<AiProviderSettings>) => {
    setAiDraft((current) => ({ ...current, ...patch }));
  };

  useEffect(() => {
    if (!workspace.projects.some((project) => project.id === evidenceProjectId)) {
      setEvidenceProjectId(workspace.projects[0]?.id ?? defaultProjectId);
    }
    if (!workspace.projects.some((project) => project.id === auditProjectId)) {
      setAuditProjectId(workspace.projects[0]?.id ?? defaultProjectId);
    }
  }, [workspace.projects, evidenceProjectId, auditProjectId]);

  const saveGitHubSync = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const timestamp = new Date().toISOString();
    let tokenSecretId = githubDraft.tokenSecretId;

    if (!githubDraft.owner.trim() || !githubDraft.repo.trim()) {
      setNotice("Set GitHub owner and private repo before saving sync.");
      return;
    }

    if (githubToken.trim()) {
      if (!passphrase.trim()) {
        setNotice("Enter the workspace passphrase before saving a GitHub PAT.");
        return;
      }
      const secret = await encryptProviderSecret("github", "Private Repo Sync PAT", githubToken.trim(), passphrase, timestamp);
      secretVault.saveEncrypted(secret);
      tokenSecretId = secret.id;
      setGithubToken("");
    }

    const nextGithub = { ...githubDraft, tokenSecretId, updatedAt: timestamp };
    const nextSettings = { ...settings, githubSync: nextGithub };
    settingsRepository.save(nextSettings);
    setSettings(nextSettings);
    setGithubDraft(nextGithub);
    setSavedSecretCount(secretVault.listEncrypted().length);
    setNotice(tokenSecretId ? "GitHub sync settings saved. PAT is encrypted locally." : "GitHub repo settings saved. Add a PAT before first sync.");
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
      if (!passphrase.trim()) {
        setNotice("Enter the workspace passphrase before saving an AI provider key.");
        return;
      }
      const secret = await encryptProviderSecret("custom", `${aiDraft.label} API key`, aiProviderKey.trim(), passphrase, timestamp);
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
    settingsRepository.save(nextSettings);
    setSettings(nextSettings);
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

  const unlockGitHubToken = async (): Promise<string | undefined> => {
    if (!githubDraft.tokenSecretId) {
      setNotice("Save a GitHub PAT before using GitHub sync.");
      return undefined;
    }
    if (!passphrase.trim()) {
      setNotice("Enter the workspace passphrase to unlock the saved GitHub PAT.");
      return undefined;
    }
    const token = await secretVault.unlock(githubDraft.tokenSecretId, passphrase);
    if (!token) setNotice("Could not unlock GitHub PAT.");
    return token;
  };

  const unlockAiProviderKey = async (): Promise<string | undefined> => {
    if (!aiDraft.apiKeySecretId) {
      setNotice("Save an AI provider key before running AI audit.");
      return undefined;
    }
    if (!passphrase.trim()) {
      setNotice("Enter the workspace passphrase to unlock the saved AI provider key.");
      return undefined;
    }
    const key = await secretVault.unlock(aiDraft.apiKeySecretId, passphrase);
    if (!key) setNotice("Could not unlock AI provider key.");
    return key;
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

  const runAiAudit = async () => {
    if (!auditProject || !auditSchedule) {
      setNotice("Create or select a project before running AI audit.");
      return;
    }
    if (!aiDraft.baseUrl.trim() || !aiDraft.model.trim()) {
      setNotice("Set AI provider Base URL and model before running audit.");
      return;
    }
    const key = await unlockAiProviderKey();
    if (!key) return;
    setAiBusy(true);
    try {
      const decision = await runContrarianAiAudit({
        provider: aiDraft,
        apiKey: key,
        project: auditProject,
        gates: gates.filter((gate) => gate.projectId === auditProject.id),
        evidence: workspace.evidence.filter((item) => item.projectId === auditProject.id),
        schedule: auditSchedule
      });
      onAuditDecisionSave(decision, `AI audit generated by ${aiDraft.label} / ${aiDraft.model}.`);
      setNotice(`AI audit recorded ${decision.action} for ${auditProject.name}.`);
    } catch (error) {
      setNotice(`AI audit failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setAiBusy(false);
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
          passphrase,
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
    if (!window.confirm("Reset the local workspace to the bundled sample data?")) return;
    onWorkspaceReset();
    setNotice("Local workspace reset to sample data.");
  };

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2"><GitPullRequest className="h-4 w-4" /> GitHub Sync Runtime</CardTitle>
              <CardDescription>Real repo connection and encrypted ChangeSet push controls.</CardDescription>
            </div>
            <Badge variant={gitHubReady ? "success" : "warning"}>{gitHubReady ? "Ready" : "Needs repo and PAT"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <SettingsRow label="Provider" value={githubPrivateRepoSyncStatus.provider} />
          <SettingsRow label="Local source" value={githubPrivateRepoSyncStatus.sourceOfTruth} />
          <SettingsRow label="Remote repo" value={githubDraft.owner && githubDraft.repo ? `${githubDraft.owner}/${githubDraft.repo}` : "not configured"} />
          <SettingsRow label="Repo root" value={githubDraft.rootPath || ".omni-plan"} />
          <SettingsRow label="Secret boundary" value={githubPrivateRepoSyncStatus.secretBoundary} />
          <SettingsRow label="Secret sync" value={githubPrivateRepoSyncStatus.secretSync} />
          <SettingsRow label="PAT scope" value={githubPrivateRepoSyncStatus.tokenPermission} />
          <SettingsRow label="Local ChangeSets" value={String(workspace.changeSets.length)} />
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button type="button" variant="outline" onClick={() => void testGitHubSync()} disabled={syncBusy}>Test GitHub access</Button>
            <Button type="button" onClick={() => void pushLocalChangeSets()} disabled={syncBusy || !workspace.changeSets.length}>Push local ChangeSets</Button>
            <Badge variant="outline">{githubPrivateRepoSyncStatus.conflictPolicy}</Badge>
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Secret Unlock</CardTitle>
          <CardDescription>Apple Passwords can autofill this passphrase; the app does not persist it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <SettingsRow label="Input source" value={browserSecretVaultStatus.inputSource} />
            <SettingsRow label="Local protection" value={browserSecretVaultStatus.localProtection} />
            <SettingsRow label="Passphrase" value={browserSecretVaultStatus.passphrasePolicy} />
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
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Autofill or enter passphrase"
                aria-label="Workspace passphrase"
              />
            </label>
            <div className="rounded-lg border bg-background p-3 text-sm">
              <div className="font-semibold">{savedSecretCount} encrypted secrets</div>
              <div className="text-muted-foreground">stored only in this browser</div>
            </div>
          </div>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            Secret values are not included in workspace export files, GitHub sync objects, evidence reports, or PDF/Markdown/CSV exports.
          </p>
          <p className="rounded-lg border bg-background p-3 text-sm font-medium">{notice}</p>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /> Agent Interfaces</CardTitle>
          <CardDescription>Plaintext operating manual, UIless project state, and Shortcut command inbox.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <SettingsRow label="Protocol" value="/agent/manual.txt" />
            <SettingsRow label="Portfolio state" value="/agent/projects.txt | .json" />
            <SettingsRow label="Write entry" value="/agent/commands" />
          </div>
          <div className="flex flex-wrap gap-2">
            <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/manual.txt">Open manual</a>
            <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/projects.txt">Open UIless projects</a>
            <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href={`/agent/projects/${encodeURIComponent(workspace.projects[0]?.id ?? defaultProjectId)}.txt`}>Open sample project</a>
            <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/commands">Open Command Inbox</a>
          </div>
          <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            Agent status endpoints are read-only and noindex. Commands support dry-run receipts; guarded writes queue ChangeSets and Audit Gates instead of mutating project state directly.
          </p>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GitPullRequest className="h-4 w-4" /> GitHub Evidence Import</CardTitle>
          <CardDescription>Read pull requests from the configured private repo and attach them as project evidence.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
          <NativeSelectField
            label="Project"
            value={evidenceProject?.id ?? ""}
            onChange={setEvidenceProjectId}
            options={workspace.projects.map((project) => ({ value: project.id, label: project.name }))}
            testId="github-evidence-project"
          />
          <NativeSelectField
            label="Link to work item"
            value={evidenceWorkItemId}
            onChange={setEvidenceWorkItemId}
            options={[{ value: "project", label: "Project-level" }, ...evidenceWorkItems.map((item) => ({ value: item.id, label: `${item.outline} ${item.title}` }))]}
            testId="github-evidence-work-item"
          />
          <div className="flex items-end">
            <Button type="button" onClick={() => void importGitHubEvidence()} disabled={syncBusy || !gitHubReady}>
              Import PR evidence
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> AI Contrarian Audit Runtime</CardTitle>
          <CardDescription>Calls the saved OpenAI-compatible provider with minimal project context and records the returned decision.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-[1fr_auto]">
          <NativeSelectField
            label="Audit project"
            value={auditProject?.id ?? ""}
            onChange={setAuditProjectId}
            options={workspace.projects.map((project) => ({ value: project.id, label: project.name }))}
            testId="ai-audit-project"
          />
          <div className="flex items-end">
            <Button type="button" onClick={() => void runAiAudit()} disabled={aiBusy || !aiDraft.apiKeySecretId || !aiDraft.baseUrl || !aiDraft.model}>
              Run AI audit
            </Button>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground md:col-span-2">
            Sends project direction, open gates, recent evidence summaries, and first schedule rows only. Full workspace data and secret values are not sent.
          </div>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GitPullRequest className="h-4 w-4" /> GitHub Sync Configuration</CardTitle>
          <CardDescription>Save the private repo target and encrypt the PAT locally.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={saveGitHubSync}>
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
                <span className="mt-2 block text-xs text-muted-foreground">Apple Passwords may autofill this. It is encrypted locally after save.</span>
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
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Zap className="h-4 w-4" /> AI Provider</CardTitle>
          <CardDescription>Custom OpenAI-compatible endpoint for audit operators.</CardDescription>
        </CardHeader>
        <CardContent>
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
                <span className="mt-2 block text-xs text-muted-foreground">Apple Passwords may autofill this. It is encrypted locally after save.</span>
              </label>
              <div className="rounded-lg border bg-background p-3 text-sm">
                <div className="font-semibold">API key</div>
                <div className="text-muted-foreground">{providerSecretSummary(aiSecret)}</div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit">Save AI provider</Button>
              <Badge variant="outline">OpenAI-compatible</Badge>
              <Badge variant="outline">Base URL required</Badge>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Archive className="h-4 w-4" /> Storage</CardTitle>
          <CardDescription>Real browser-local workspace persistence with file backup controls.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <SettingsRow label="Engine" value={browserWorkspaceStorageStatus.engine} />
          <SettingsRow label="Source of truth" value={browserWorkspaceStorageStatus.sourceOfTruth} />
          <SettingsRow label="Persistence" value={workspacePersistence.status} />
          <SettingsRow label="Last saved" value={workspacePersistence.lastSavedAt ? workspacePersistence.lastSavedAt.slice(0, 19).replace("T", " ") : "pending"} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={exportWorkspace}>
              <FileDown size={15} />
              Export backup
            </Button>
            <Button type="button" variant="outline" onClick={() => workspaceImportRef.current?.click()}>
              <Archive size={15} />
              Import backup
            </Button>
            <Button type="button" variant="destructive" onClick={resetWorkspace}>Reset local workspace</Button>
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
        </CardContent>
      </Card>
    </section>
  );
}

function ActionCard({
  label,
  title,
  detail,
  meta,
  cta,
  href,
  tone = "neutral"
}: {
  label: string;
  title: string;
  detail: string;
  meta: string;
  cta: string;
  href: string;
  tone?: "neutral" | "danger" | "warning";
}) {
  return (
    <a
      className={cn(
        "grid min-h-36 content-between rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition hover:bg-accent/45 hover:shadow-md",
        tone === "danger" && "border-destructive/40 bg-destructive/5",
        tone === "warning" && "border-amber-300 bg-amber-50/60"
      )}
      href={href}
    >
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-2 line-clamp-2 text-sm font-semibold">{title}</div>
        <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <Badge variant={tone === "danger" ? "destructive" : tone === "warning" ? "warning" : "secondary"}>{meta}</Badge>
        <span className="text-xs font-semibold text-primary">{cta}</span>
      </div>
    </a>
  );
}

function SummaryTile({
  label,
  value,
  detail,
  tone = "default"
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "danger" | "warning";
}) {
  return (
    <div className={cn("rounded-lg border bg-background p-3", tone === "danger" && "border-destructive/30 bg-destructive/5", tone === "warning" && "border-amber-300 bg-amber-50/70")}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold">{value}</div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{detail}</p>
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
  testId
}: {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoComplete: string;
  testId?: string;
}) {
  const handleInput = (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value);
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <Input
        className="mt-2"
        name={name}
        value={value}
        onInput={handleInput}
        onChange={handleInput}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-label={label}
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
  testId
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  testId?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <select
        className="mt-2 flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        value={value}
        onChange={(event) => onChange(event.target.value as T)}
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
  if (!evidence.length) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No evidence linked yet.</div>;
  }
  return (
    <div className="space-y-2">
      {evidence.map((item) => (
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
    </div>
  );
}

function BaselineTable({ baseline, items }: { baseline?: Baseline; items: ScheduledItem[] }) {
  if (!baseline) {
    return <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No approved baseline for this project.</div>;
  }
  return (
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
        {items.map((item) => (
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

function SignalBar({
  label,
  value,
  tone
}: {
  label: string;
  value: number;
  tone: "ok" | "warn" | "danger";
}) {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="rounded-md border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <strong className="text-xs">{bounded}</strong>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", tone === "danger" ? "bg-destructive" : tone === "warn" ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${bounded}%` }}
        />
      </div>
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

function formatTick(iso: string) {
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatScheduleRange(item: ScheduledItem) {
  return `${formatShortDateTime(item.start)} -> ${formatShortDateTime(item.finish)}`;
}

function scheduleTiming(item: ScheduledItem): ScheduleTiming {
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
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

function OutlineTable({ items, gates, evidence }: { items: ScheduledItem[]; gates: AuditGate[]; evidence: Evidence[] }) {
  return (
    <Table>
      <caption className="srOnly">Project outline with schedule, evidence, gate, and float status</caption>
      <TableHeader>
        <TableRow>
          <TableHead>WBS</TableHead>
          <TableHead>Item</TableHead>
          <TableHead>Start</TableHead>
          <TableHead>Finish</TableHead>
          <TableHead>%</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Float</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
          {items.map((item) => {
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
                <TableCell>{item.workItem.title}</TableCell>
                <TableCell>{formatShortDateTime(item.start)}</TableCell>
                <TableCell>{formatShortDateTime(item.finish)}</TableCell>
                <TableCell>{item.workItem.percentComplete}</TableCell>
                <TableCell><Badge variant={gate ? "destructive" : item.isCritical ? "warning" : "secondary"}>{status}</Badge></TableCell>
                <TableCell>{Math.round(item.totalFloatSeconds / 3600)}h</TableCell>
              </TableRow>
            );
          })}
      </TableBody>
    </Table>
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
        <div>
          <strong>{baseline ? baseline.name : "No baseline"}</strong>
          <span>{criticalPathWidth} critical items / {visibleDependencies.length} dependencies</span>
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
            "grid gap-2 rounded-lg border bg-background p-3 sm:grid-cols-[18px_minmax(0,1fr)_auto]",
            gate.severity === "hard" && "border-destructive/35 bg-destructive/5",
            gate.severity === "warning" && "border-amber-300 bg-amber-50/60"
          )}
          key={gate.id}
        >
          <GitPullRequest size={15} className="mt-0.5 text-muted-foreground" />
          <div>
            <strong className="text-sm">{gate.targetType}</strong>
            <p className="mt-1 text-xs text-muted-foreground">{gate.reason}</p>
            <p className="mt-1 text-xs text-muted-foreground">Required: {gate.requiredAction}</p>
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
