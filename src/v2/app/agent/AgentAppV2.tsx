import { useEffect, useMemo, useRef, useState } from "react";

import type { Evidence, ISODate } from "@/domain/types";

import {
  isStructurallyValidCommand,
  isStructurallyValidCommandContext,
  type CommandResult,
  type V2Command,
} from "../../domain/commands";
import type {
  ActualV2,
  ExceptionRecord,
  ProjectDependency,
  ProjectWorkItem,
  ProjectV2,
  ReviewRecord,
  WorkspaceV2,
} from "../../domain/types";
import type { BootstrapState } from "../../repositories/bootstrapService";
import type { AgentDispatchInput } from "../../repositories/agentAdapter";

export const AGENT_PROTOCOL_VERSION = "2026-07-10.v2" as const;
export const AGENT_PROTOCOL_VERSION_V2 = AGENT_PROTOCOL_VERSION;

export interface AgentBootstrapServicePort {
  inspect(): Promise<BootstrapState>;
}

export interface AgentAdapterPort {
  dispatch(input: AgentDispatchInput): Promise<CommandResult>;
}

export interface AgentAppV2Props {
  pathname: string;
  bootstrapService: AgentBootstrapServicePort;
  agentAdapter: AgentAdapterPort;
  now?: () => ISODate;
}

type AgentRoute =
  | { kind: "manual-text" }
  | { kind: "projects-text" }
  | { kind: "projects-json" }
  | { kind: "project-text"; projectId: string }
  | { kind: "project-json"; projectId: string }
  | { kind: "commands" }
  | { kind: "not-found" };

type ResolvedBootstrapState =
  | { status: "booting" }
  | BootstrapState;

type PublicCommandEnvelope = {
  command: V2Command;
  commandId: string;
  expectedRevision: number;
  actorId: string;
  sourceId: string;
  now: ISODate;
};

const publicEnvelopeKeys = [
  "actorId",
  "command",
  "commandId",
  "expectedRevision",
  "now",
  "sourceId",
] as const;

function defaultNow(): ISODate {
  return new Date().toISOString();
}

function parseAgentRoute(pathname: string): AgentRoute {
  if (pathname === "/agent" || pathname === "/agent/manual.txt") {
    return { kind: "manual-text" };
  }
  if (pathname === "/agent/projects.txt") return { kind: "projects-text" };
  if (pathname === "/agent/projects.json") return { kind: "projects-json" };
  if (pathname === "/agent/commands") return { kind: "commands" };
  const match = pathname.match(/^\/agent\/projects\/([^/]+)\.(txt|json)$/);
  if (match === null) return { kind: "not-found" };
  try {
    const projectId = decodeURIComponent(match[1]);
    if (projectId.length === 0) return { kind: "not-found" };
    return match[2] === "txt"
      ? { kind: "project-text", projectId }
      : { kind: "project-json", projectId };
  } catch {
    return { kind: "not-found" };
  }
}

function requiredHumanAction(
  status: ResolvedBootstrapState["status"],
): string {
  switch (status) {
    case "booting":
      return "Wait for the human-controlled V2 bootstrap check to finish.";
    case "migration_required":
      return "Open OmniPlan and complete the human-reviewed V1 migration.";
    case "setup_required":
      return "Open OmniPlan and configure capacity before Agent access.";
    case "recovery_error":
      return "Open OmniPlan and resolve the migration recovery state.";
    case "ready":
      return "No bootstrap action is required.";
  }
}

function bootstrapDocument(
  state: Exclude<ResolvedBootstrapState, { status: "ready" }>,
  generatedAt: ISODate,
) {
  return {
    agent_protocol_version: AGENT_PROTOCOL_VERSION_V2,
    generated_at: generatedAt,
    scope: "bootstrap",
    status: "bootstrap_required",
    bootstrap_state: state.status,
    writes_allowed: false,
    required_human_action: requiredHumanAction(state.status),
  } as const;
}

function scopeDto(scope: { id: string; title: string; description: string }) {
  return {
    id: scope.id,
    title: scope.title,
    description: scope.description,
  };
}

function workItemDto(item: ProjectWorkItem) {
  return {
    id: item.id,
    projectId: item.projectId,
    parentId: item.parentId,
    kind: item.kind,
    title: item.title,
    outline: item.outline,
    durationSeconds: item.durationSeconds,
    estimate: {
      optimisticSeconds: item.estimate.optimisticSeconds,
      mostLikelySeconds: item.estimate.mostLikelySeconds,
      pessimisticSeconds: item.estimate.pessimisticSeconds,
    },
    constraint: item.constraint === undefined
      ? undefined
      : {
          noEarlierThan: item.constraint.noEarlierThan,
          noLaterThan: item.constraint.noLaterThan,
          fixedStart: item.constraint.fixedStart,
          fixedFinish: item.constraint.fixedFinish,
        },
    assignmentIds: item.assignmentIds.map((assignment) => ({
      resourceId: assignment.resourceId,
      attention: assignment.attention,
      effortSeconds: assignment.effortSeconds,
    })),
    percentComplete: item.percentComplete,
    isKeyTask: item.isKeyTask,
    isScopeExpansion: item.isScopeExpansion,
    isFastDelivery: item.isFastDelivery,
    splitSegments: item.splitSegments?.map((segment) => ({
      offsetSeconds: segment.offsetSeconds,
      durationSeconds: segment.durationSeconds,
    })),
    repeatRule: item.repeatRule === undefined
      ? undefined
      : {
          cadence: item.repeatRule.cadence,
          everyDays: item.repeatRule.everyDays,
          count: item.repeatRule.count,
          startMode: item.repeatRule.startMode,
          startAt: item.repeatRule.startAt,
        },
    hammockStartId: item.hammockStartId,
    hammockFinishId: item.hammockFinishId,
    evidenceRequired: item.evidenceRequired,
    revision: item.revision,
    betScopeId: item.betScopeId,
    resultStatus: item.resultStatus,
    outcomeNote: item.outcomeNote,
  };
}

function dependencyDto(dependency: ProjectDependency) {
  return {
    id: dependency.id,
    projectId: dependency.projectId,
    fromId: dependency.fromId,
    toId: dependency.toId,
    type: dependency.type,
    lagSeconds: dependency.lagSeconds,
    revision: dependency.revision,
  };
}

function evidenceDto(evidence: Evidence) {
  return {
    id: evidence.id,
    kind: evidence.kind,
    summary: evidence.summary,
    url: evidence.url,
    projectId: evidence.projectId,
    workItemId: evidence.workItemId,
    createdAt: evidence.createdAt,
    confidence: evidence.confidence,
    tags: [...evidence.tags],
  };
}

function actualDto(actual: ActualV2) {
  return {
    id: actual.id,
    revision: actual.revision,
    target: actual.target.kind === "action"
      ? { kind: "action" as const, actionId: actual.target.actionId }
      : {
          kind: "work_item" as const,
          workItemId: actual.target.workItemId,
        },
    actualStart: actual.actualStart,
    actualFinish: actual.actualFinish,
    actualWorkSeconds: actual.actualWorkSeconds,
    remainingWorkSeconds: actual.remainingWorkSeconds,
    actualCost: actual.actualCost,
    recordedAt: actual.recordedAt,
  };
}

function reviewDto(review: ReviewRecord) {
  return {
    id: review.id,
    kind: review.kind,
    triggerKey: review.triggerKey,
    triggerType: review.triggerType,
    status: review.status,
    affectedProjectIds: [...review.affectedProjectIds],
    affectedRecordIds: [...review.affectedRecordIds],
    dueAt: review.dueAt,
    cadenceTimeZone: review.cadenceTimeZone,
    createdAt: review.createdAt,
    overdueMarkedAt: review.overdueMarkedAt,
    conclusion: review.conclusion === undefined
      ? undefined
      : {
          summary: review.conclusion.summary,
          decisionCodes: [...review.conclusion.decisionCodes],
          followUpCommandIds: [...review.conclusion.followUpCommandIds],
          actorId: review.conclusion.actorId,
          completedAt: review.conclusion.completedAt,
        },
  };
}

function exceptionDto(exception: ExceptionRecord) {
  return {
    id: exception.id,
    projectId: exception.projectId,
    requirementId: exception.requirementId,
    rationale: exception.rationale,
    knownConsequence: exception.knownConsequence,
    reviewAt: exception.reviewAt,
    expiresAt: exception.expiresAt,
    approvedBy: exception.approvedBy,
    createdAt: exception.createdAt,
    resolvedAt: exception.resolvedAt,
    history: exception.history.map((entry) => ({
      action: entry.action,
      actorId: entry.actorId,
      at: entry.at,
      note: entry.note,
    })),
  };
}

function projectSummary(workspace: WorkspaceV2, project: ProjectV2) {
  const projectWorkItems = workspace.workItems.filter(
    (item) => item.projectId === project.id,
  );
  const workItemIds = new Set(projectWorkItems.map(({ id }) => id));
  const activeBrief = workspace.directionBriefs.find(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  const activeBet = workspace.bets.find(({ id }) => id === project.activeBetId);
  const activePlan = workspace.planVersions.find(
    ({ id }) => id === project.activePlanVersionId,
  );
  return {
    id: project.id,
    name: project.name,
    stage: project.stage,
    priority: project.priority,
    notes: project.notes,
    holds: project.holds.map((hold) => ({
      type: hold.type,
      source_id: hold.sourceId,
      affected_record_ids: [...hold.affectedRecordIds],
      created_at: hold.createdAt,
    })),
    active_direction: activeBrief === undefined
      ? null
      : {
          id: activeBrief.id,
          version: activeBrief.version,
          audience_and_problem: activeBrief.audienceAndProblem,
          success_evidence: activeBrief.successEvidence,
          appetite_seconds: activeBrief.appetiteSeconds,
          validation_method: activeBrief.validationMethod,
          first_scope: activeBrief.firstScope.map(scopeDto),
          no_go_or_kill: activeBrief.noGoOrKill,
          advanced_notes: activeBrief.advancedNotes,
          updated_at: activeBrief.updatedAt,
        },
    active_bet: activeBet === undefined
      ? null
      : {
          id: activeBet.id,
          version: activeBet.version,
          appetite_start: activeBet.appetiteStart,
          appetite_end: activeBet.appetiteEnd,
          committed_scope: activeBet.committedScope.map(scopeDto),
          invalidated_at: activeBet.invalidatedAt ?? null,
        },
    active_plan: activePlan === undefined
      ? null
      : {
          id: activePlan.id,
          version: activePlan.version,
          bet_id: activePlan.betId,
          schedule_hash: activePlan.scheduleHash,
          created_at: activePlan.createdAt,
        },
    counts: {
      work_items: projectWorkItems.length,
      open_work_items: projectWorkItems.filter(
        (item) => item.resultStatus === undefined && item.percentComplete < 100,
      ).length,
      dependencies: workspace.dependencies.filter(
        (dependency) => dependency.projectId === project.id,
      ).length,
      evidence: workspace.evidence.filter(
        (evidence) => evidence.projectId === project.id,
      ).length,
      actuals: workspace.actuals.filter(
        (actual) =>
          actual.target.kind === "work_item" &&
          workItemIds.has(actual.target.workItemId),
      ).length,
      open_reviews: workspace.reviews.filter(
        (review) =>
          review.status === "open" &&
          review.affectedProjectIds.includes(project.id),
      ).length,
      open_exceptions: workspace.exceptions.filter(
        (exception) =>
          exception.projectId === project.id &&
          exception.resolvedAt === undefined,
      ).length,
    },
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function portfolioJson(workspace: WorkspaceV2, generatedAt: ISODate) {
  return {
    agent_protocol_version: AGENT_PROTOCOL_VERSION_V2,
    generated_at: generatedAt,
    workspace_revision: workspace.revision,
    scope: "portfolio",
    write_entry: "/agent/commands",
    projects: workspace.projects.map((project) =>
      projectSummary(workspace, project)
    ),
    totals: {
      projects: workspace.projects.length,
      work_items: workspace.workItems.length,
      dependencies: workspace.dependencies.length,
      evidence: workspace.evidence.length,
      open_command_proposals: workspace.commandProposals.filter(
        ({ status }) => status === "open",
      ).length,
    },
  };
}

function projectJson(
  workspace: WorkspaceV2,
  projectId: string,
  generatedAt: ISODate,
) {
  const project = workspace.projects.find(({ id }) => id === projectId);
  if (project === undefined) {
    return {
      agent_protocol_version: AGENT_PROTOCOL_VERSION_V2,
      generated_at: generatedAt,
      workspace_revision: workspace.revision,
      scope: "project" as const,
      status: "not_found" as const,
      project_id: projectId,
      error: `Project ${projectId} was not found.`,
    };
  }
  const projectWorkItems = workspace.workItems.filter(
    (item) => item.projectId === project.id,
  );
  const workItemIds = new Set(projectWorkItems.map(({ id }) => id));
  return {
    agent_protocol_version: AGENT_PROTOCOL_VERSION_V2,
    generated_at: generatedAt,
    workspace_revision: workspace.revision,
    scope: "project" as const,
    status: "ok" as const,
    project: projectSummary(workspace, project),
    work_items: projectWorkItems.map(workItemDto),
    dependencies: workspace.dependencies
      .filter(
        (dependency) =>
          dependency.projectId === project.id ||
          workItemIds.has(dependency.fromId) ||
          workItemIds.has(dependency.toId),
      )
      .map(dependencyDto),
    evidence: workspace.evidence
      .filter((evidence) => evidence.projectId === project.id)
      .map(evidenceDto),
    actuals: workspace.actuals
      .filter(
        (actual) =>
          actual.target.kind === "work_item" &&
          workItemIds.has(actual.target.workItemId),
      )
      .map(actualDto),
    open_reviews: workspace.reviews
      .filter(
        (review) =>
          review.status === "open" &&
          review.affectedProjectIds.includes(project.id),
      )
      .map(reviewDto),
    open_exceptions: workspace.exceptions
      .filter(
        (exception) =>
          exception.projectId === project.id &&
          exception.resolvedAt === undefined,
      )
      .map(exceptionDto),
  };
}

function escapeLineValue(value: string | number): string {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function portfolioText(workspace: WorkspaceV2, generatedAt: ISODate): string {
  const model = portfolioJson(workspace, generatedAt);
  return [
    "OmniPlan V2 Agent Projects",
    "",
    `agent_protocol_version: ${escapeLineValue(model.agent_protocol_version)}`,
    `generated_at: ${escapeLineValue(model.generated_at)}`,
    `workspace_revision: ${escapeLineValue(model.workspace_revision)}`,
    "scope: portfolio",
    "write_entry: /agent/commands",
    "",
    ...model.projects.flatMap((project) => [
      `Project ${escapeLineValue(project.id)}: ${escapeLineValue(project.name)}`,
      `  stage: ${escapeLineValue(project.stage)}`,
      `  priority: ${escapeLineValue(project.priority)}`,
      `  holds: ${escapeLineValue(project.holds.map(({ type }) => type).join(", ") || "none")}`,
      `  open_work_items: ${escapeLineValue(project.counts.open_work_items)}`,
      `  open_reviews: ${escapeLineValue(project.counts.open_reviews)}`,
      `  detail_text: /agent/projects/${encodeURIComponent(project.id)}.txt`,
      `  detail_json: /agent/projects/${encodeURIComponent(project.id)}.json`,
      "",
    ]),
  ].join("\n");
}

function projectText(
  workspace: WorkspaceV2,
  projectId: string,
  generatedAt: ISODate,
): string {
  const model = projectJson(workspace, projectId, generatedAt);
  if (model.status === "not_found") {
    return [
      "OmniPlan V2 Agent Project",
      "",
      `agent_protocol_version: ${escapeLineValue(model.agent_protocol_version)}`,
      `generated_at: ${escapeLineValue(model.generated_at)}`,
      `workspace_revision: ${escapeLineValue(model.workspace_revision)}`,
      `project_id: ${escapeLineValue(model.project_id)}`,
      `error: ${escapeLineValue(model.error)}`,
    ].join("\n");
  }
  return [
    "OmniPlan V2 Agent Project",
    "",
    `agent_protocol_version: ${escapeLineValue(model.agent_protocol_version)}`,
    `generated_at: ${escapeLineValue(model.generated_at)}`,
    `workspace_revision: ${escapeLineValue(model.workspace_revision)}`,
    `project_id: ${escapeLineValue(model.project.id)}`,
    `name: ${escapeLineValue(model.project.name)}`,
    `stage: ${escapeLineValue(model.project.stage)}`,
    `priority: ${escapeLineValue(model.project.priority)}`,
    `holds: ${escapeLineValue(model.project.holds.map(({ type }) => type).join(", ") || "none")}`,
    `direction: ${escapeLineValue(model.project.active_direction?.audience_and_problem ?? "none")}`,
    `success_evidence: ${escapeLineValue(model.project.active_direction?.success_evidence ?? "none")}`,
    `active_bet: ${escapeLineValue(model.project.active_bet?.id ?? "none")}`,
    `active_plan: ${escapeLineValue(model.project.active_plan?.id ?? "none")}`,
    "",
    "Work Items",
    ...(model.work_items.length === 0
      ? ["- none"]
      : model.work_items.map(
          (item) =>
            `- ${escapeLineValue(item.id)}: ${escapeLineValue(item.title)} | ${escapeLineValue(item.percentComplete)}% | revision=${escapeLineValue(item.revision)}`,
        )),
    "",
    "Dependencies",
    ...(model.dependencies.length === 0
      ? ["- none"]
      : model.dependencies.map(
          (dependency) =>
            `- ${escapeLineValue(dependency.id)}: ${escapeLineValue(dependency.fromId)} ${escapeLineValue(dependency.type)} ${escapeLineValue(dependency.toId)}`,
        )),
    "",
    "Command Inbox: /agent/commands",
  ].join("\n");
}

function manualText(workspace: WorkspaceV2, generatedAt: ISODate): string {
  return [
    "OmniPlan V2 Agent Operating Manual",
    "",
    `agent_protocol_version: ${escapeLineValue(AGENT_PROTOCOL_VERSION_V2)}`,
    `generated_at: ${escapeLineValue(generatedAt)}`,
    "",
    "Read endpoints",
    "- /agent/manual.txt",
    "- /agent/projects.txt",
    "- /agent/projects.json",
    "- /agent/projects/:id.txt",
    "- /agent/projects/:id.json",
    ...workspace.projects.flatMap(({ id }) => [
      `- /agent/projects/${encodeURIComponent(id)}.txt`,
      `- /agent/projects/${encodeURIComponent(id)}.json`,
    ]),
    "",
    "Write boundary",
    "- /agent/commands",
    "- Read the current project projection before dispatching a command.",
    "- Automatic Agent commands: capture_inbox, record_actual, attach_evidence.",
    "- Proposal-only commands must use submit_command_proposal: update_direction, create_work_item, update_work_item, propose_replan, upsert_dependency, remove_dependency.",
    "- Human-only decisions cannot be applied by an Agent.",
    "- Every write is revision-bound and passes through the V2 CommandService.",
  ].join("\n");
}

function notFoundText(generatedAt: ISODate): string {
  return [
    "OmniPlan V2 Agent Endpoint Not Found",
    "",
    `agent_protocol_version: ${escapeLineValue(AGENT_PROTOCOL_VERSION_V2)}`,
    `generated_at: ${escapeLineValue(generatedAt)}`,
    "",
    "Available endpoints:",
    "- /agent/manual.txt",
    "- /agent/projects.txt",
    "- /agent/projects.json",
    "- /agent/projects/:id.txt",
    "- /agent/projects/:id.json",
    "- /agent/commands",
  ].join("\n");
}

function hasExactPublicEnvelopeKeys(
  value: unknown,
): value is Record<(typeof publicEnvelopeKeys)[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === publicEnvelopeKeys.length &&
    keys.every((key, index) => key === publicEnvelopeKeys[index])
  );
}

function parsePublicCommandEnvelope(input: string): PublicCommandEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("Command input must be valid JSON.");
  }
  if (!hasExactPublicEnvelopeKeys(value)) {
    throw new Error("Command input must match the exact Agent envelope schema.");
  }
  if (!isStructurallyValidCommand(value.command)) {
    throw new Error("Command input contains an invalid V2 command envelope.");
  }
  const context = {
    commandId: value.commandId,
    expectedRevision: value.expectedRevision,
    actorId: value.actorId,
    actorKind: "agent",
    origin: "agent",
    source: {
      sourceId: value.sourceId,
      verified: true,
      capabilities: [],
    },
    now: value.now,
  };
  if (!isStructurallyValidCommandContext(context)) {
    throw new Error("Command input contains an invalid V2 command context.");
  }
  return value as PublicCommandEnvelope;
}

function AgentDocument({ content }: { content: string }) {
  return (
    <main>
      <pre data-testid="agent-document">{content}</pre>
    </main>
  );
}

function AgentCommandsPage({
  workspace,
  agentAdapter,
  onWorkspace,
}: {
  workspace: WorkspaceV2;
  agentAdapter: AgentAdapterPort;
  onWorkspace: (workspace: WorkspaceV2) => void;
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<CommandResult>();
  const [error, setError] = useState<string>();
  const [dispatching, setDispatching] = useState(false);

  const dispatch = async () => {
    setError(undefined);
    setResult(undefined);
    let envelope: PublicCommandEnvelope;
    try {
      envelope = parsePublicCommandEnvelope(input);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Invalid command input.");
      return;
    }
    if (envelope.expectedRevision !== workspace.revision) {
      setError(
        `Stale expectedRevision ${envelope.expectedRevision}; current workspace revision is ${workspace.revision}.`,
      );
      return;
    }
    setDispatching(true);
    try {
      const next = await agentAdapter.dispatch({
        command: envelope.command,
        commandId: envelope.commandId,
        expectedRevision: envelope.expectedRevision,
        actorId: envelope.actorId,
        sourceId: envelope.sourceId,
        now: envelope.now,
      });
      setResult(next);
      onWorkspace(next.workspace);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Agent dispatch failed.");
    } finally {
      setDispatching(false);
    }
  };

  return (
    <main>
      <h1>OmniPlan V2 Agent Command Boundary</h1>
      <p>Workspace revision: {workspace.revision}</p>
      <label htmlFor="agent-command-json">Agent command JSON</label>
      <textarea
        id="agent-command-json"
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
      <button
        type="button"
        disabled={dispatching || input.trim().length === 0}
        onClick={() => void dispatch()}
      >
        Dispatch command
      </button>
      {error !== undefined && <p role="alert">{error}</p>}
      {result !== undefined && (
        <pre>{JSON.stringify({ receipt: result.receipt, rejection: result.ok ? undefined : result.rejection }, null, 2)}</pre>
      )}
    </main>
  );
}

export function AgentAppV2({
  pathname,
  bootstrapService,
  agentAdapter,
  now = defaultNow,
}: AgentAppV2Props) {
  const bootstrapServiceRef = useRef(bootstrapService);
  const bootstrapPromiseRef = useRef<Promise<BootstrapState>>();
  const generatedAtRef = useRef<ISODate>();
  if (generatedAtRef.current === undefined) generatedAtRef.current = now();
  const generatedAt = generatedAtRef.current;
  const route = useMemo(() => parseAgentRoute(pathname), [pathname]);
  const [bootstrapState, setBootstrapState] = useState<ResolvedBootstrapState>({
    status: "booting",
  });

  useEffect(() => {
    let active = true;
    const bootstrapPromise =
      bootstrapPromiseRef.current ??
      bootstrapServiceRef.current.inspect();
    bootstrapPromiseRef.current = bootstrapPromise;
    void bootstrapPromise.then(
      (state) => {
        if (active) setBootstrapState(state);
      },
      () => {
        if (active) {
          setBootstrapState({
            status: "recovery_error",
            recovery: {
              sourceChecksum: null,
              backupId: "unavailable",
              backupChecksum: "unavailable",
              code: "MIGRATION_PERSISTENCE_FAILED",
              message: "Bootstrap resolution failed.",
              occurredAt: generatedAt,
            },
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [generatedAt]);

  if (bootstrapState.status !== "ready") {
    return (
      <AgentDocument
        content={JSON.stringify(
          bootstrapDocument(bootstrapState, generatedAt),
          null,
          2,
        )}
      />
    );
  }

  const workspace = bootstrapState.workspace;
  if (route.kind === "commands") {
    return (
      <AgentCommandsPage
        workspace={workspace}
        agentAdapter={agentAdapter}
        onWorkspace={(next) =>
          setBootstrapState({ status: "ready", workspace: next })
        }
      />
    );
  }
  if (route.kind === "manual-text") {
    return <AgentDocument content={manualText(workspace, generatedAt)} />;
  }
  if (route.kind === "projects-text") {
    return <AgentDocument content={portfolioText(workspace, generatedAt)} />;
  }
  if (route.kind === "projects-json") {
    return (
      <AgentDocument
        content={JSON.stringify(portfolioJson(workspace, generatedAt), null, 2)}
      />
    );
  }
  if (route.kind === "project-text") {
    return (
      <AgentDocument
        content={projectText(workspace, route.projectId, generatedAt)}
      />
    );
  }
  if (route.kind === "project-json") {
    return (
      <AgentDocument
        content={JSON.stringify(
          projectJson(workspace, route.projectId, generatedAt),
          null,
          2,
        )}
      />
    );
  }
  return <AgentDocument content={notFoundText(generatedAt)} />;
}
