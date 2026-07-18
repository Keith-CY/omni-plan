import { evaluateAuditGates } from "./audit";
import { calculateProjectHealth } from "./portfolio";
import { isProjectArchived, projectLifecycleLabel, projectLifecycleStatus } from "./projectLifecycle";
import { isAutomaticRecurringWorkItem, isExecutionWorkItem } from "./recurring";
import { createShapeUpPitch, isShapeUpBet, isShapeUpPitchComplete, scheduleShapeUpAwarePortfolio, scheduleShapeUpAwareProject, shapeUpAppetiteDays, shapeUpMissingBetRequirements, shapeUpScopeStatus } from "./shapeUp";
import type {
  Actual,
  AuditGate,
  ChangeSet,
  Dependency,
  DirectionCard,
  Evidence,
  EvidenceKind,
  Project,
  ScheduleResult,
  ShapeUpAppetiteKind,
  ShapeUpPitch,
  ShapeUpScope,
  WorkItem,
  WorkItemKind,
  WorkspaceSnapshot
} from "./types";

export const AGENT_PROTOCOL_VERSION = "2026-07-04.v1";

const daySeconds = 24 * 60 * 60;
const hourSeconds = 60 * 60;

export type AgentCommandType =
  | "create_task"
  | "update_task_progress"
  | "record_actual"
  | "add_evidence"
  | "add_note"
  | "update_shape_up_pitch"
  | "add_shape_up_scope"
  | "update_shape_up_scope"
  | "request_complete_project"
  | "request_archive_project"
  | "request_dependency_change"
  | "request_baseline_change"
  | "request_scope_expansion";

export type AgentCommandRisk = "low-risk" | "guarded" | "invalid";
export type AgentCommandStatus = "preview" | "applied" | "queued" | "rejected";
export type AgentCommandInputFormat = "json" | "text";

export interface AgentCommand {
  command_type: AgentCommandType;
  project_id?: string;
  project?: string;
  work_item_id?: string;
  work_item?: string;
  title?: string;
  kind?: WorkItemKind;
  duration_days?: number;
  effort_hours?: number;
  attention?: "deep" | "medium" | "shallow";
  percent_complete?: number;
  actual_work_hours?: number;
  remaining_work_hours?: number;
  actual_cost?: number;
  evidence_kind?: EvidenceKind;
  summary?: string;
  url?: string;
  tags?: string[] | string;
  rationale?: string;
  problem?: string;
  appetite_kind?: ShapeUpAppetiteKind;
  solution_sketch?: string;
  rabbit_holes?: string;
  no_gos?: string;
  success_baseline?: string;
  scope_id?: string;
  description?: string;
  confirmed?: boolean;
  hill_position?: number;
  dependency_from?: string;
  dependency_to?: string;
  dependency_type?: "FS" | "SS" | "FF" | "SF";
  is_key_task?: boolean;
  evidence_required?: boolean;
  is_scope_expansion?: boolean;
  is_fast_delivery?: boolean;
}

export interface AgentCommandParseResult {
  input_format: AgentCommandInputFormat;
  command?: AgentCommand;
  errors: string[];
}

export interface AgentCommandReceipt {
  id: string;
  agent_protocol_version: string;
  received_at: string;
  workspace_revision: string;
  dry_run: boolean;
  status: AgentCommandStatus;
  risk: AgentCommandRisk;
  input_format: AgentCommandInputFormat;
  command?: AgentCommand;
  project_id?: string;
  work_item_id?: string;
  summary: string;
  messages: string[];
  diffs: ChangeSet["diffs"];
  change_set_id?: string;
  audit_gate_id?: string;
}

export interface AgentCommandExecution {
  workspace: WorkspaceSnapshot;
  receipt: AgentCommandReceipt;
}

export function workspaceRevision(snapshot: WorkspaceSnapshot) {
  return `rev-${hashText(JSON.stringify({
    projects: snapshot.projects.map((project) => [project.id, projectLifecycleStatus(project), isProjectArchived(project), project.mode, project.priority, project.horizon]),
    workItems: snapshot.workItems.map((item) => [item.id, item.projectId, item.percentComplete, item.title, item.outline]),
    recurringOccurrences: snapshot.recurringOccurrences.map((item) => [item.id, item.status, item.updatedAt, item.followUpWorkItemId]),
    dependencies: snapshot.dependencies.map((dependency) => [dependency.id, dependency.fromId, dependency.toId, dependency.type, dependency.lagSeconds]),
    baselines: snapshot.baselines.map((baseline) => [baseline.id, baseline.projectId, baseline.capturedAt, baseline.approvedByDecisionId]),
    evidence: snapshot.evidence.map((item) => [item.id, item.projectId, item.workItemId, item.createdAt, item.summary]),
    changeSets: snapshot.changeSets.map((changeSet) => [changeSet.id, changeSet.projectId, changeSet.status, changeSet.createdAt]),
    auditGates: snapshot.auditGates.map((gate) => [gate.id, gate.projectId, gate.status, gate.severity])
  }))}`;
}

export function buildAgentManualText(generatedAt = new Date().toISOString()) {
  return [
    "OmniPlan Personal Agent Operating Manual",
    "",
    `agent_protocol_version: ${AGENT_PROTOCOL_VERSION}`,
    `generated_at: ${generatedAt}`,
    "",
    "Purpose",
    "- This app is a portfolio-first personal project OS with hard audit gates.",
    "- An AI Agent may help a human update project progress, but it must not bypass evidence, baseline, milestone, or scope controls.",
    "- Speed is not success. The agent should prefer a truthful blocked state over silent wrong progress.",
    "",
    "Core Method",
    "1. Read /agent/projects.txt or /agent/projects.json before proposing changes.",
    "2. For a selected project, read /agent/projects/:id.txt or /agent/projects/:id.json before writing.",
    "3. Submit changes only through the Command Inbox at /agent/commands.",
    "4. Dry-run every command first. Inspect the receipt, risk level, and diff.",
    "5. Low-risk commands may be auto-applied by the app.",
    "6. Guarded commands must become ChangeSets and/or Audit Gates.",
    "7. Never mark evidence-required milestones complete without linked evidence or an explicit waiver gate.",
    "",
    "Read Endpoints",
    "- /agent/manual.txt: this operating manual and command contract.",
    "- /agent/projects.txt: portfolio summary for quick LLM reading.",
    "- /agent/projects.json: portfolio summary for Shortcuts and scripts.",
    "- /agent/projects/:id.txt: single-project status for update planning.",
    "- /agent/projects/:id.json: single-project status for stable parsing.",
    "",
    "Write Entry",
    "- /agent/commands is the only first-version write surface.",
    "- The page accepts plain text or JSON.",
    "- Apple Shortcut MVP: send text through Share Sheet or paste clipboard into /agent/commands.",
    "- The app returns a Command Receipt with parsed command, dry-run diff, risk, result, and any ChangeSet/Gate id.",
    "",
    "Risk Model",
    "- low-risk: create ordinary task, update ordinary task percent, record actual work, add evidence, add note, update Shape Up pitch, add or adjust Shape Up scope.",
    "- guarded: dependency changes, baseline changes, scope expansion, milestone completion without evidence, project completion, archive.",
    "- forbidden: AI Agent cannot approve a Shape Up bet. Betting Gate approval must be human-confirmed in the UI.",
    "- invalid: missing project, missing task, unsupported command, ambiguous natural language.",
    "",
    "JSON Command Schema",
    "{",
    "  \"command_type\": \"create_task | update_task_progress | record_actual | add_evidence | add_note | update_shape_up_pitch | add_shape_up_scope | update_shape_up_scope | request_complete_project | request_archive_project | request_dependency_change | request_baseline_change | request_scope_expansion\",",
    "  \"project_id\": \"p-omni\",",
    "  \"work_item_id\": \"w-domain\",",
    "  \"title\": \"Task title for create_task\",",
    "  \"percent_complete\": 50,",
    "  \"actual_work_hours\": 1.5,",
    "  \"remaining_work_hours\": 2,",
    "  \"summary\": \"Evidence or note summary\",",
    "  \"url\": \"optional reference URL\",",
    "  \"tags\": [\"manual\", \"shortcut\"]",
    "}",
    "",
    "Plain Text Examples",
    "- Give OmniPlan Personal project add task Review Shortcut import, 1 hour",
    "- Set task Define project domain schema and change sets in project OmniPlan Personal to 90%",
    "- Record 2h actual for task Define project domain schema and change sets in project OmniPlan Personal",
    "- Add evidence Direction gate reviewed to project OmniPlan Personal",
    "- Request archive project OmniPlan Personal",
    "",
    "Forbidden Behavior",
    "- Do not infer secrets, provider keys, GitHub PATs, or passphrases from agent pages.",
    "- Do not claim a baseline is approved unless the project status page says it is approved.",
    "- Do not complete or archive a project when open hard gates remain.",
    "- Do not treat UIless status as a full database dump; it is a minimal operating view.",
    ""
  ].join("\n");
}

export function buildAgentWorkspaceJson(snapshot: WorkspaceSnapshot, generatedAt = new Date().toISOString()) {
  const schedules = scheduleShapeUpAwarePortfolio(snapshot.projects, snapshot.workItems, snapshot.dependencies);
  const gates = buildWorkspaceGates(snapshot, generatedAt);
  return {
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    generated_at: generatedAt,
    workspace_revision: workspaceRevision(snapshot),
    scope: "portfolio",
    source: "browser-local workspace",
    write_entry: "/agent/commands",
    projects: snapshot.projects.map((project) => projectJson(snapshot, project, schedules.find((schedule) => schedule.projectId === project.id), gates, generatedAt, "summary")),
    totals: {
      projects: snapshot.projects.length,
      work_items: snapshot.workItems.length,
      dependencies: snapshot.dependencies.length,
      evidence: snapshot.evidence.length,
      open_hard_gates: gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared").length,
      pending_change_sets: snapshot.changeSets.filter((changeSet) => changeSet.status !== "approved").length
    },
    allowed_command_entry: {
      dry_run_required: true,
      low_risk_auto_apply: ["create_task", "update_task_progress", "record_actual", "add_evidence", "add_note"],
      shaping_auto_apply: ["update_shape_up_pitch", "add_shape_up_scope", "update_shape_up_scope"],
      guarded_requests: ["request_complete_project", "request_archive_project", "request_dependency_change", "request_baseline_change", "request_scope_expansion"]
    }
  };
}

export function buildAgentProjectJson(snapshot: WorkspaceSnapshot, projectId: string, generatedAt = new Date().toISOString()) {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return {
      agent_protocol_version: AGENT_PROTOCOL_VERSION,
      generated_at: generatedAt,
      workspace_revision: workspaceRevision(snapshot),
      scope: "project",
      error: `Project ${projectId} was not found.`
    };
  }
  const schedule = scheduleShapeUpAwareProject(project, snapshot.workItems, snapshot.dependencies);
  const gates = buildWorkspaceGates(snapshot, generatedAt);
  return {
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    generated_at: generatedAt,
    workspace_revision: workspaceRevision(snapshot),
    scope: "project",
    project: projectJson(snapshot, project, schedule, gates, generatedAt, "detail")
  };
}

export function buildAgentWorkspaceText(snapshot: WorkspaceSnapshot, generatedAt = new Date().toISOString()) {
  const model = buildAgentWorkspaceJson(snapshot, generatedAt);
  return [
    "OmniPlan Personal UIless Projects",
    "",
    `agent_protocol_version: ${model.agent_protocol_version}`,
    `generated_at: ${model.generated_at}`,
    `workspace_revision: ${model.workspace_revision}`,
    "scope: portfolio",
    "write_entry: /agent/commands",
    "",
    `Totals: ${model.totals.projects} projects, ${model.totals.work_items} work items, ${model.totals.dependencies} dependencies, ${model.totals.evidence} evidence items, ${model.totals.open_hard_gates} open hard gates.`,
    "",
    ...model.projects.flatMap((project) => [
      `Project ${project.id}: ${project.name}`,
      `  status: ${project.status} / ${project.mode}`,
      `  north_star: ${project.north_star}`,
      `  current_outcome: ${project.current_outcome}`,
      `  shape_up: ${project.shape_up.enabled ? `${project.shape_up.stage} / ${project.shape_up.bet_status}` : "off"}`,
      `  open_work: ${project.summary.open_work}`,
      `  next_action: ${project.summary.next_action ?? "none"}`,
      `  hard_gates: ${project.summary.open_hard_gates}`,
      `  warnings: ${project.summary.open_warnings}`,
      `  baseline: ${project.summary.baseline.status}`,
      `  latest_evidence: ${project.summary.latest_evidence?.summary ?? "none"}`,
      `  detail_text: /agent/projects/${project.id}.txt`,
      `  detail_json: /agent/projects/${project.id}.json`,
      ""
    ]),
    "Allowed next step: choose one project, read its detail endpoint, dry-run a command in /agent/commands."
  ].join("\n");
}

export function buildAgentProjectText(snapshot: WorkspaceSnapshot, projectId: string, generatedAt = new Date().toISOString()) {
  const sourceProject = snapshot.projects.find((candidate) => candidate.id === projectId);
  const revision = workspaceRevision(snapshot);
  if (!sourceProject) {
    return [
      "OmniPlan Personal UIless Project",
      "",
      `agent_protocol_version: ${AGENT_PROTOCOL_VERSION}`,
      `generated_at: ${generatedAt}`,
      `workspace_revision: ${revision}`,
      `error: Project ${projectId} was not found.`
    ].join("\n");
  }
  const project = projectJson(
    snapshot,
    sourceProject,
    scheduleShapeUpAwareProject(sourceProject, snapshot.workItems, snapshot.dependencies),
    buildWorkspaceGates(snapshot, generatedAt),
    generatedAt,
    "detail"
  ) as {
    id: string;
    name: string;
    status: string;
    mode: string;
    north_star: string;
    current_outcome: string;
    direction_card?: DirectionCard;
    shape_up: {
      enabled: boolean;
      stage: string;
      bet_status: string;
      appetite_days?: number;
      missing_bet_requirements: string[];
      circuit_breaker_at?: string;
      scopes: Array<{ id: string; title: string; confirmed: boolean; hill_position: number; hill_status: string; can_enter_gantt: boolean }>;
    };
    summary: {
      open_work: number;
      next_action?: string;
      open_hard_gates: number;
      open_warnings: number;
      baseline: { status: string };
      latest_evidence?: { summary: string };
    };
    work_items: Array<{ id: string; outline: string; kind: string; percent_complete: number; title: string; evidence_count: number }>;
    dependencies: Array<{ id: string; from_id: string; to_id: string; type: string; lag_days: number }>;
    open_gates: Array<{ severity: string; target_type: string; reason: string; required_action: string }>;
  };
  return [
    "OmniPlan Personal UIless Project",
    "",
    `agent_protocol_version: ${AGENT_PROTOCOL_VERSION}`,
    `generated_at: ${generatedAt}`,
    `workspace_revision: ${revision}`,
    `project_id: ${project.id}`,
    `name: ${project.name}`,
    `status: ${project.status}`,
    `mode: ${project.mode}`,
    `north_star: ${project.north_star}`,
    `current_outcome: ${project.current_outcome}`,
    "",
    "Shape Up",
    `enabled: ${project.shape_up.enabled}`,
    `stage: ${project.shape_up.stage}`,
    `bet_status: ${project.shape_up.bet_status}`,
    `appetite_days: ${project.shape_up.appetite_days ?? "n/a"}`,
    `circuit_breaker_at: ${project.shape_up.circuit_breaker_at ?? "n/a"}`,
    `missing_bet_requirements: ${project.shape_up.missing_bet_requirements.join(", ") || "none"}`,
    ...(project.shape_up.scopes.length
      ? project.shape_up.scopes.map((scope) => `- scope ${scope.id}: ${scope.title} | ${scope.hill_status} ${scope.hill_position}% | confirmed=${scope.confirmed} | can_enter_gantt=${scope.can_enter_gantt}`)
      : ["- scopes: none"]),
    "",
    "Direction Card",
    ...directionCardLines(project.direction_card),
    "",
    "Summary",
    `open_work: ${project.summary.open_work}`,
    `next_action: ${project.summary.next_action ?? "none"}`,
    `open_hard_gates: ${project.summary.open_hard_gates}`,
    `open_warnings: ${project.summary.open_warnings}`,
    `baseline: ${project.summary.baseline.status}`,
    `latest_evidence: ${project.summary.latest_evidence?.summary ?? "none"}`,
    "",
    "Work Items",
    ...project.work_items.map((item) => `- ${item.id} | ${item.outline} | ${item.kind} | ${item.percent_complete}% | ${item.title} | evidence=${item.evidence_count}`),
    "",
    "Dependencies",
    ...(project.dependencies.length ? project.dependencies.map((dependency) => `- ${dependency.id}: ${dependency.from_id} ${dependency.type} ${dependency.to_id} lag=${dependency.lag_days}d`) : ["- none"]),
    "",
    "Open Gates",
    ...(project.open_gates.length ? project.open_gates.map((gate) => `- ${gate.severity} ${gate.target_type}: ${gate.reason} Required: ${gate.required_action}`) : ["- none"]),
    "",
    "Allowed Commands",
    "- create_task",
    "- update_task_progress",
    "- record_actual",
    "- add_evidence",
    "- add_note",
    "- update_shape_up_pitch",
    "- add_shape_up_scope",
    "- update_shape_up_scope",
    "- guarded request: request_complete_project, request_archive_project, request_dependency_change, request_baseline_change, request_scope_expansion",
    "",
    "Command Inbox: /agent/commands"
  ].join("\n");
}

export function previewAgentCommandInput(snapshot: WorkspaceSnapshot, input: string, generatedAt = new Date().toISOString()): AgentCommandExecution {
  const parsed = parseAgentCommand(input);
  if (!parsed.command) {
    return {
      workspace: snapshot,
      receipt: invalidReceipt(snapshot, generatedAt, parsed.input_format, parsed.errors, true)
    };
  }
  return {
    workspace: snapshot,
    receipt: previewAgentCommand(snapshot, parsed.command, parsed.input_format, generatedAt)
  };
}

export function applyAgentCommandInput(snapshot: WorkspaceSnapshot, input: string, generatedAt = new Date().toISOString()): AgentCommandExecution {
  const parsed = parseAgentCommand(input);
  if (!parsed.command) {
    return {
      workspace: snapshot,
      receipt: invalidReceipt(snapshot, generatedAt, parsed.input_format, parsed.errors, false)
    };
  }
  return applyAgentCommand(snapshot, parsed.command, parsed.input_format, generatedAt);
}

export function parseAgentCommand(input: string): AgentCommandParseResult {
  const raw = input.trim();
  if (!raw) {
    return { input_format: "text", errors: ["Command input is empty."] };
  }

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Partial<AgentCommand> & { type?: string; command?: string };
      const commandType = parsed.command_type ?? parsed.type ?? parsed.command;
      if (!isAgentCommandType(commandType)) {
        return { input_format: "json", errors: [`Unsupported command_type ${String(commandType || "")}.`] };
      }
      return {
        input_format: "json",
        command: { ...parsed, command_type: commandType },
        errors: []
      };
    } catch (error) {
      return { input_format: "json", errors: [`JSON command could not be parsed: ${error instanceof Error ? error.message : "unknown error"}`] };
    }
  }

  const plain = raw.replace(/\s+/g, " ");
  const createChinese = plain.match(/^给(.+?)项目(?:新增|添加|创建)任务(.+?)(?:[，,。]|$)/i);
  if (createChinese) {
    return {
      input_format: "text",
      command: {
        command_type: "create_task",
        project: cleanText(createChinese[1]),
        title: cleanText(createChinese[2]),
        effort_hours: numberBeforeUnit(plain, ["小时", "h", "hour", "hours"]) ?? 1,
        duration_days: numberBeforeUnit(plain, ["天", "day", "days"]) ?? 1
      },
      errors: []
    };
  }

  const createEnglish = plain.match(/^(?:add|create)\s+task\s+["“]?(.+?)["”]?\s+(?:to|in)\s+project\s+["“]?(.+?)["”]?(?:[,.]|$)/i);
  if (createEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "create_task",
        title: cleanText(createEnglish[1]),
        project: cleanText(createEnglish[2]),
        effort_hours: numberBeforeUnit(plain, ["h", "hour", "hours"]) ?? 1,
        duration_days: numberBeforeUnit(plain, ["d", "day", "days"]) ?? 1
      },
      errors: []
    };
  }

  const progressChinese = plain.match(/^更新(.+?)项目(.+?)任务.*?(\d{1,3})%/i) ?? plain.match(/^将(.+?)项目(.+?)任务.*?(?:到|为)\s*(\d{1,3})%/i);
  if (progressChinese) {
    return {
      input_format: "text",
      command: {
        command_type: "update_task_progress",
        project: cleanText(progressChinese[1]),
        work_item: cleanText(progressChinese[2]),
        percent_complete: Number(progressChinese[3])
      },
      errors: []
    };
  }

  const progressEnglish = plain.match(/^set\s+task\s+["“]?(.+?)["”]?\s+(?:in|for)\s+project\s+["“]?(.+?)["”]?\s+to\s+(\d{1,3})%/i);
  if (progressEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "update_task_progress",
        work_item: cleanText(progressEnglish[1]),
        project: cleanText(progressEnglish[2]),
        percent_complete: Number(progressEnglish[3])
      },
      errors: []
    };
  }

  const actualChinese = plain.match(/^记录(.+?)项目(.+?)任务.*?实际\s*(\d+(?:\.\d+)?)\s*(?:小时|h)/i);
  if (actualChinese) {
    return {
      input_format: "text",
      command: {
        command_type: "record_actual",
        project: cleanText(actualChinese[1]),
        work_item: cleanText(actualChinese[2]),
        actual_work_hours: Number(actualChinese[3])
      },
      errors: []
    };
  }

  const actualEnglish = plain.match(/^record\s+(\d+(?:\.\d+)?)h?\s+actual\s+for\s+task\s+["“]?(.+?)["”]?\s+(?:in|for)\s+project\s+["“]?(.+?)["”]?/i);
  if (actualEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "record_actual",
        actual_work_hours: Number(actualEnglish[1]),
        work_item: cleanText(actualEnglish[2]),
        project: cleanText(actualEnglish[3])
      },
      errors: []
    };
  }

  const evidenceChinese = plain.match(/^给(.+?)项目(?:添加|记录)证据(.+)/i);
  if (evidenceChinese) {
    return {
      input_format: "text",
      command: {
        command_type: "add_evidence",
        project: cleanText(evidenceChinese[1]),
        summary: cleanText(evidenceChinese[2]),
        evidence_kind: "note",
        tags: ["shortcut", "manual"]
      },
      errors: []
    };
  }

  const evidenceEnglish = plain.match(/^add\s+evidence\s+["“]?(.+?)["”]?\s+to\s+project\s+["“]?(.+?)["”]?/i);
  if (evidenceEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "add_evidence",
        summary: cleanText(evidenceEnglish[1]),
        project: cleanText(evidenceEnglish[2]),
        evidence_kind: "note",
        tags: ["shortcut", "manual"]
      },
      errors: []
    };
  }

  const archiveChinese = plain.match(/^请求归档(.+?)项目$/i);
  const archiveEnglish = plain.match(/^request\s+archive\s+project\s+["“]?(.+?)["”]?$/i);
  if (archiveChinese || archiveEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "request_archive_project",
        project: cleanText((archiveChinese ?? archiveEnglish)![1])
      },
      errors: []
    };
  }

  const completeChinese = plain.match(/^请求完成(.+?)项目$/i);
  const completeEnglish = plain.match(/^request\s+complete\s+project\s+["“]?(.+?)["”]?$/i);
  if (completeChinese || completeEnglish) {
    return {
      input_format: "text",
      command: {
        command_type: "request_complete_project",
        project: cleanText((completeChinese ?? completeEnglish)![1])
      },
      errors: []
    };
  }

  return { input_format: "text", errors: ["Natural language command was not recognized. Use JSON or one of the manual examples."] };
}

function previewAgentCommand(snapshot: WorkspaceSnapshot, command: AgentCommand, inputFormat: AgentCommandInputFormat, generatedAt: string): AgentCommandReceipt {
  const project = resolveProject(snapshot, command);
  const revision = workspaceRevision(snapshot);
  const messages: string[] = [];
  if (!project) {
    return receipt({
      snapshot,
      generatedAt,
      dryRun: true,
      inputFormat,
      command,
      risk: "invalid",
      status: "rejected",
      summary: "Project could not be resolved.",
      messages: ["Set project_id or an exact project name before submitting this command."],
      diffs: []
    });
  }

  const workItem = command.work_item_id || command.work_item ? resolveWorkItem(snapshot, project.id, command) : undefined;
  const validation = validateCommand(snapshot, project, workItem, command);
  if (validation.errors.length) {
    return receipt({
      snapshot,
      generatedAt,
      dryRun: true,
      inputFormat,
      command,
      projectId: project.id,
      workItemId: workItem?.id,
      risk: "invalid",
      status: "rejected",
      summary: validation.errors[0],
      messages: validation.errors,
      diffs: []
    });
  }

  const risk = classifyRisk(snapshot, project, workItem, command);
  const diffs = previewDiffs(snapshot, project, workItem, command, generatedAt);
  messages.push(risk === "guarded"
    ? "This command will queue a ChangeSet and Audit Gate instead of directly mutating project state."
    : "This command may be auto-applied after dry-run review.");

  return {
    id: `receipt-${hashText(`${revision}-${generatedAt}-${JSON.stringify(command)}`)}`,
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    received_at: generatedAt,
    workspace_revision: revision,
    dry_run: true,
    status: "preview",
    risk,
    input_format: inputFormat,
    command,
    project_id: project.id,
    work_item_id: workItem?.id,
    summary: commandSummary(command, project, workItem),
    messages,
    diffs
  };
}

function applyAgentCommand(snapshot: WorkspaceSnapshot, command: AgentCommand, inputFormat: AgentCommandInputFormat, generatedAt: string): AgentCommandExecution {
  const preview = previewAgentCommand(snapshot, command, inputFormat, generatedAt);
  if (preview.risk === "invalid" || !preview.project_id) {
    return { workspace: snapshot, receipt: { ...preview, dry_run: false, status: "rejected" } };
  }

  if (preview.risk === "guarded") {
    const queued = queueGuardedCommand(snapshot, preview, generatedAt);
    return {
      workspace: queued.workspace,
      receipt: {
        ...preview,
        dry_run: false,
        status: "queued",
        change_set_id: queued.changeSet.id,
        audit_gate_id: queued.gate.id,
        messages: [...preview.messages, "Guarded command queued for operator review."]
      }
    };
  }

  const applied = applyLowRiskCommand(snapshot, preview, generatedAt);
  return {
    workspace: applied.workspace,
    receipt: {
      ...preview,
      dry_run: false,
      status: "applied",
      change_set_id: applied.changeSet.id,
      messages: [...preview.messages, "Low-risk command applied and recorded as an approved ChangeSet."]
    }
  };
}

function applyLowRiskCommand(snapshot: WorkspaceSnapshot, preview: AgentCommandReceipt, generatedAt: string) {
  const command = preview.command!;
  const project = snapshot.projects.find((candidate) => candidate.id === preview.project_id)!;
  const workItem = preview.work_item_id ? snapshot.workItems.find((candidate) => candidate.id === preview.work_item_id) : undefined;
  let next = snapshot;
  let title = commandSummary(command, project, workItem);
  let diffs = preview.diffs;

  if (command.command_type === "create_task") {
    const created = buildWorkItem(snapshot, project.id, command);
    next = { ...next, workItems: [...next.workItems, created] };
    title = `Agent create task ${created.title}`;
    diffs = [{ entity: "WorkItem", entityId: created.id, field: "created", before: null, after: created }];
  }

  if (command.command_type === "update_task_progress" && workItem) {
    const nextPercent = clamp(command.percent_complete ?? workItem.percentComplete, 0, 100);
    next = {
      ...next,
      workItems: next.workItems.map((item) => item.id === workItem.id ? { ...item, percentComplete: nextPercent } : item)
    };
    title = `Agent update progress ${workItem.title}`;
    diffs = [{ entity: "WorkItem", entityId: workItem.id, field: "percentComplete", before: workItem.percentComplete, after: nextPercent }];
  }

  if (command.command_type === "record_actual" && workItem) {
    const previousActual = next.actuals.find((actual) => actual.workItemId === workItem.id);
    const nextPercent = command.percent_complete === undefined ? workItem.percentComplete : clamp(command.percent_complete, 0, 100);
    const actual: Actual = {
      workItemId: workItem.id,
      actualStart: previousActual?.actualStart ?? generatedAt,
      actualFinish: nextPercent >= 100 ? generatedAt : undefined,
      actualWorkSeconds: Math.max(0, Math.round((command.actual_work_hours ?? 1) * hourSeconds)),
      remainingWorkSeconds: Math.max(0, Math.round((command.remaining_work_hours ?? 0) * hourSeconds)),
      actualCost: Math.max(0, command.actual_cost ?? command.actual_work_hours ?? 1),
      recordedAt: generatedAt
    };
    next = {
      ...next,
      workItems: next.workItems.map((item) => item.id === workItem.id ? { ...item, percentComplete: nextPercent } : item),
      actuals: [actual, ...next.actuals.filter((candidate) => candidate.workItemId !== workItem.id)]
    };
    title = `Agent record actual ${workItem.title}`;
    diffs = [
      { entity: "WorkItem", entityId: workItem.id, field: "percentComplete", before: workItem.percentComplete, after: nextPercent },
      { entity: "Actual", entityId: workItem.id, field: "recorded", before: previousActual ?? null, after: actual }
    ];
  }

  if (command.command_type === "add_evidence" || command.command_type === "add_note") {
    const evidence = buildEvidence(snapshot, project.id, command, generatedAt);
    next = { ...next, evidence: [evidence, ...next.evidence] };
    title = `Agent add evidence ${evidence.summary.slice(0, 32)}`;
    diffs = [{ entity: "Evidence", entityId: evidence.id, field: "created", before: null, after: evidence }];
  }

  if (
    command.command_type === "update_shape_up_pitch" ||
    command.command_type === "add_shape_up_scope" ||
    command.command_type === "update_shape_up_scope"
  ) {
    const nextPitch = nextShapeUpPitch(project, command, generatedAt);
    next = {
      ...next,
      projects: next.projects.map((item) => item.id === project.id ? { ...item, shapeUpPitch: nextPitch, status: item.shapeUpPitch ? item.status : "waiting" } : item)
    };
    title = `Agent shape ${project.name}`;
    diffs = [{ entity: "Project", entityId: project.id, field: "shapeUpPitch", before: project.shapeUpPitch ?? null, after: nextPitch }];
  }

  const changeSet = createAgentChangeSet(next, project.id, title, "Applied from Agent Command Inbox after dry-run review.", diffs, "approved", generatedAt);
  return {
    workspace: {
      ...next,
      changeSets: [changeSet, ...next.changeSets]
    },
    changeSet
  };
}

function queueGuardedCommand(snapshot: WorkspaceSnapshot, preview: AgentCommandReceipt, generatedAt: string) {
  const command = preview.command!;
  const projectId = preview.project_id!;
  const targetType = command.command_type === "request_baseline_change"
    ? "baseline"
    : command.command_type === "request_scope_expansion"
      ? "scope"
      : "project";
  const gateId = uniqueId("gate", `agent-${command.command_type}`, snapshot.auditGates.map((gate) => gate.id));
  const changeSet = createAgentChangeSet(
    snapshot,
    projectId,
    `Agent request ${command.command_type}`,
    command.rationale || "Guarded command submitted through Agent Command Inbox.",
    preview.diffs.length ? preview.diffs : [{ entity: "AgentCommand", entityId: gateId, field: "request", before: null, after: command }],
    "queued-audit",
    generatedAt,
    [gateId]
  );
  const gate: AuditGate = {
    id: gateId,
    projectId,
    targetType,
    targetId: preview.work_item_id ?? projectId,
    severity: "hard",
    reason: `Agent command requires operator review: ${command.command_type}.`,
    requiredAction: "Review the Command Receipt and approve, narrow, or block the queued ChangeSet.",
    status: "queued"
  };
  return {
    workspace: {
      ...snapshot,
      auditGates: [gate, ...snapshot.auditGates],
      changeSets: [changeSet, ...snapshot.changeSets]
    },
    changeSet,
    gate
  };
}

function validateCommand(snapshot: WorkspaceSnapshot, project: Project, workItem: WorkItem | undefined, command: AgentCommand) {
  const errors: string[] = [];
  if ((command.command_type === "update_task_progress" || command.command_type === "record_actual") && !workItem) {
    errors.push("Work item could not be resolved. Set work_item_id or an exact task title.");
  }
  if ((command.command_type === "update_task_progress" || command.command_type === "record_actual") && workItem && isAutomaticRecurringWorkItem(workItem)) {
    errors.push("Automatic recurring items do not accept progress or actuals. Report an occurrence exception instead.");
  }
  if (command.command_type === "create_task" && !command.title?.trim()) {
    errors.push("create_task requires title.");
  }
  if ((command.command_type === "add_evidence" || command.command_type === "add_note") && !command.summary?.trim()) {
    errors.push(`${command.command_type} requires summary.`);
  }
  if (command.command_type === "update_shape_up_pitch" && ![
    command.problem,
    command.solution_sketch,
    command.rabbit_holes,
    command.no_gos,
    command.success_baseline,
    command.appetite_kind
  ].some((value) => typeof value === "string" ? value.trim() : Boolean(value))) {
    errors.push("update_shape_up_pitch requires at least one Shape Up pitch field.");
  }
  if (command.appetite_kind && !["small-batch", "big-batch"].includes(command.appetite_kind)) {
    errors.push("appetite_kind must be small-batch or big-batch.");
  }
  if (command.command_type === "add_shape_up_scope" && !command.title?.trim()) {
    errors.push("add_shape_up_scope requires title.");
  }
  if (command.command_type === "update_shape_up_scope" && !command.scope_id?.trim()) {
    errors.push("update_shape_up_scope requires scope_id.");
  }
  if (command.command_type === "update_shape_up_scope" && command.scope_id && !project.shapeUpPitch?.scopes.some((scope) => scope.id === command.scope_id)) {
    errors.push(`Shape Up scope ${command.scope_id} was not found.`);
  }
  if (command.command_type === "update_task_progress" && command.percent_complete === undefined) {
    errors.push("update_task_progress requires percent_complete.");
  }
  if (command.command_type === "record_actual" && command.actual_work_hours === undefined && command.percent_complete === undefined) {
    errors.push("record_actual requires actual_work_hours or percent_complete.");
  }
  if (!snapshot.projects.some((candidate) => candidate.id === project.id)) {
    errors.push("Project is not part of the current workspace.");
  }
  return { errors };
}

function classifyRisk(snapshot: WorkspaceSnapshot, project: Project, workItem: WorkItem | undefined, command: AgentCommand): AgentCommandRisk {
  if (
    command.command_type === "request_complete_project" ||
    command.command_type === "request_archive_project" ||
    command.command_type === "request_dependency_change" ||
    command.command_type === "request_baseline_change" ||
    command.command_type === "request_scope_expansion"
  ) {
    return "guarded";
  }
  if (command.command_type === "create_task" && command.is_scope_expansion) return "guarded";
  if (command.command_type === "update_task_progress" && workItem && (command.percent_complete ?? 0) >= 100) {
    const hasEvidence = snapshot.evidence.some((item) => item.workItemId === workItem.id);
    if ((workItem.kind === "milestone" || workItem.evidenceRequired || workItem.isKeyTask) && !hasEvidence) return "guarded";
  }
  return "low-risk";
}

function previewDiffs(snapshot: WorkspaceSnapshot, project: Project, workItem: WorkItem | undefined, command: AgentCommand, generatedAt: string): ChangeSet["diffs"] {
  if (command.command_type === "create_task") {
    const created = buildWorkItem(snapshot, project.id, command);
    return [{ entity: "WorkItem", entityId: created.id, field: "created", before: null, after: created }];
  }
  if (command.command_type === "update_task_progress" && workItem) {
    return [{ entity: "WorkItem", entityId: workItem.id, field: "percentComplete", before: workItem.percentComplete, after: clamp(command.percent_complete ?? workItem.percentComplete, 0, 100) }];
  }
  if (command.command_type === "record_actual" && workItem) {
    const previousActual = snapshot.actuals.find((actual) => actual.workItemId === workItem.id);
    return [{ entity: "Actual", entityId: workItem.id, field: "recorded", before: previousActual ?? null, after: { actualWorkHours: command.actual_work_hours ?? 0, remainingWorkHours: command.remaining_work_hours ?? 0, recordedAt: generatedAt } }];
  }
  if (command.command_type === "add_evidence" || command.command_type === "add_note") {
    const evidence = buildEvidence(snapshot, project.id, command, generatedAt);
    return [{ entity: "Evidence", entityId: evidence.id, field: "created", before: null, after: evidence }];
  }
  if (
    command.command_type === "update_shape_up_pitch" ||
    command.command_type === "add_shape_up_scope" ||
    command.command_type === "update_shape_up_scope"
  ) {
    return [{ entity: "Project", entityId: project.id, field: "shapeUpPitch", before: project.shapeUpPitch ?? null, after: nextShapeUpPitch(project, command, generatedAt) }];
  }
  if (command.command_type === "request_complete_project") {
    return [{ entity: "Project", entityId: project.id, field: "status", before: projectLifecycleStatus(project), after: "done" }];
  }
  if (command.command_type === "request_archive_project") {
    return [{ entity: "Project", entityId: project.id, field: "archived", before: isProjectArchived(project), after: true }];
  }
  return [{ entity: "AgentCommand", entityId: project.id, field: command.command_type, before: null, after: command }];
}

function buildWorkItem(snapshot: WorkspaceSnapshot, projectId: string, command: AgentCommand): WorkItem {
  const title = command.title!.trim();
  const kind = command.kind ?? "task";
  const durationSeconds = kind === "milestone" ? 0 : Math.max(0, Math.round((command.duration_days ?? 1) * daySeconds));
  const resourceId = snapshot.resources[0]?.id;
  return {
    id: uniqueId("w", title, snapshot.workItems.map((item) => item.id)),
    projectId,
    kind,
    title,
    outline: nextOutline(snapshot.workItems, projectId),
    durationSeconds,
    estimate: { mostLikelySeconds: durationSeconds },
    assignmentIds: resourceId && kind !== "milestone" ? [{
      resourceId,
      attention: command.attention ?? "deep",
      effortSeconds: Math.max(0, Math.round((command.effort_hours ?? 1) * hourSeconds))
    }] : [],
    percentComplete: clamp(command.percent_complete ?? 0, 0, 100),
    evidenceRequired: Boolean(command.evidence_required),
    isKeyTask: Boolean(command.is_key_task),
    isScopeExpansion: Boolean(command.is_scope_expansion),
    isFastDelivery: Boolean(command.is_fast_delivery)
  };
}

function buildEvidence(snapshot: WorkspaceSnapshot, projectId: string, command: AgentCommand, generatedAt: string): Evidence {
  const summary = (command.summary ?? "Agent note").trim();
  return {
    id: uniqueId("e", summary, snapshot.evidence.map((item) => item.id)),
    kind: command.command_type === "add_note" ? "note" : command.evidence_kind ?? "note",
    summary,
    url: command.url?.trim() || undefined,
    projectId,
    workItemId: command.work_item_id,
    createdAt: generatedAt,
    confidence: 0.7,
    tags: normalizeTags(command.tags)
  };
}

function nextShapeUpPitch(project: Project, command: AgentCommand, generatedAt: string): ShapeUpPitch {
  const current = project.shapeUpPitch ?? createShapeUpPitch({
    problem: project.directionCard?.userProblem || project.currentOutcome,
    appetiteKind: "small-batch",
    now: generatedAt
  });
  let next: ShapeUpPitch = {
    ...current,
    problem: command.problem?.trim() ?? current.problem,
    appetiteKind: command.appetite_kind ?? current.appetiteKind,
    appetiteDays: command.appetite_kind ? shapeUpAppetiteDays[command.appetite_kind] : current.appetiteDays,
    solutionSketch: command.solution_sketch?.trim() ?? current.solutionSketch,
    rabbitHoles: command.rabbit_holes?.trim() ?? current.rabbitHoles,
    noGos: command.no_gos?.trim() ?? current.noGos,
    successBaseline: command.success_baseline?.trim() ?? current.successBaseline,
    updatedAt: generatedAt
  };

  if (command.command_type === "add_shape_up_scope") {
    const title = command.title?.trim() ?? "Untitled scope";
    const scope: ShapeUpScope = {
      id: uniqueId("scope", title, current.scopes.map((item) => item.id)),
      title,
      description: command.description?.trim() ?? "",
      confirmed: command.confirmed ?? true,
      hillPosition: clamp(command.hill_position ?? 20, 0, 100)
    };
    next = { ...next, scopes: [...next.scopes, scope] };
  }

  if (command.command_type === "update_shape_up_scope" && command.scope_id) {
    next = {
      ...next,
      scopes: next.scopes.map((scope) => scope.id === command.scope_id ? {
        ...scope,
        title: command.title?.trim() ?? scope.title,
        description: command.description?.trim() ?? scope.description,
        confirmed: command.confirmed ?? scope.confirmed,
        hillPosition: clamp(command.hill_position ?? scope.hillPosition, 0, 100)
      } : scope)
    };
  }

  return next;
}

function projectJson(
  snapshot: WorkspaceSnapshot,
  project: Project,
  schedule: ScheduleResult | undefined,
  gates: AuditGate[],
  generatedAt: string,
  depth: "summary" | "detail"
) {
  const scheduled = schedule ?? scheduleShapeUpAwareProject(project, snapshot.workItems, snapshot.dependencies);
  const projectItems = snapshot.workItems.filter((item) => item.projectId === project.id && isExecutionWorkItem(item));
  const projectEvidence = snapshot.evidence.filter((item) => item.projectId === project.id);
  const projectGates = gates.filter((gate) => gate.projectId === project.id);
  const baseline = snapshot.baselines.find((item) => item.projectId === project.id);
  const baselineApproved = isBaselineApproved(baseline, snapshot.changeSets);
  const latestEvidence = [...projectEvidence].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const health = calculateProjectHealth(project, scheduled, snapshot.evidence, gates, generatedAt);
  const nextAction = scheduled.items
    .filter((item) => item.workItem.kind !== "phase" && item.workItem.percentComplete < 100)
    .sort((a, b) => Number(b.isCritical) - Number(a.isCritical) || a.start.localeCompare(b.start))[0];
  const shapeUpPitch = project.shapeUpPitch;
  const shapeUpStage = !shapeUpPitch
    ? "off"
    : projectLifecycleStatus(project) === "waiting" && !isShapeUpPitchComplete(shapeUpPitch)
      ? "shaping"
      : projectLifecycleStatus(project) === "waiting"
        ? "betting"
        : projectLifecycleStatus(project) === "active"
          ? "building"
          : projectLifecycleStatus(project) === "paused"
            ? "circuit_breaker"
            : projectLifecycleStatus(project) === "done"
              ? "shipped"
              : "killed";
  const base = {
    id: project.id,
    name: project.name,
    status: projectLifecycleLabel(project),
    mode: project.mode,
    priority: project.priority,
    north_star: project.northStar,
    current_outcome: project.currentOutcome,
    start: project.start,
    horizon: project.horizon,
    direction_card: project.directionCard,
    shape_up: {
      enabled: Boolean(shapeUpPitch),
      stage: shapeUpStage,
      bet_status: shapeUpPitch ? isShapeUpBet(project) ? "accepted" : "not_accepted" : "off",
      appetite_days: shapeUpPitch?.appetiteDays,
      missing_bet_requirements: shapeUpPitch ? shapeUpMissingBetRequirements(project) : [],
      circuit_breaker_at: shapeUpPitch?.bet?.circuitBreakerAt,
      scopes: shapeUpPitch?.scopes.map((scope) => ({
        id: scope.id,
        title: scope.title,
        confirmed: scope.confirmed,
        hill_position: scope.hillPosition,
        hill_status: shapeUpScopeStatus(scope),
        can_enter_gantt: scope.confirmed && scope.hillPosition > 50
      })) ?? []
    },
    summary: {
      open_work: projectItems.filter((item) => item.kind !== "phase" && item.percentComplete < 100).length,
      next_action: nextAction ? `${nextAction.workItem.outline} ${nextAction.workItem.title}` : undefined,
      open_hard_gates: projectGates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared").length,
      open_warnings: projectGates.filter((gate) => gate.severity === "warning" && gate.status !== "cleared").length,
      risk_score: health.riskScore,
      momentum_score: health.momentumScore,
      baseline: {
        status: baseline ? baselineApproved ? "approved" : "pending" : "missing",
        name: baseline?.name,
        captured_at: baseline?.capturedAt
      },
      latest_evidence: latestEvidence ? {
        id: latestEvidence.id,
        kind: latestEvidence.kind,
        summary: latestEvidence.summary,
        created_at: latestEvidence.createdAt,
        work_item_id: latestEvidence.workItemId,
        has_url: Boolean(latestEvidence.url)
      } : undefined
    }
  };
  if (depth === "summary") return base;
  return {
    ...base,
    work_items: scheduled.items.map((item) => ({
      id: item.workItem.id,
      outline: item.workItem.outline,
      title: item.workItem.title,
      kind: item.workItem.kind,
      percent_complete: item.workItem.percentComplete,
      start: item.start,
      finish: item.finish,
      is_critical: item.isCritical,
      total_float_hours: Math.round(item.totalFloatSeconds / hourSeconds),
      evidence_required: Boolean(item.workItem.evidenceRequired),
      is_key_task: Boolean(item.workItem.isKeyTask),
      evidence_count: projectEvidence.filter((evidence) => evidence.workItemId === item.workItem.id).length
    })),
    dependencies: snapshot.dependencies.filter((dependency) => dependency.projectId === project.id).map((dependency) => ({
      id: dependency.id,
      from_id: dependency.fromId,
      to_id: dependency.toId,
      type: dependency.type,
      lag_days: dependency.lagSeconds / daySeconds
    })),
    open_gates: projectGates.filter((gate) => gate.status !== "cleared").map((gate) => ({
      id: gate.id,
      severity: gate.severity,
      status: gate.status,
      target_type: gate.targetType,
      target_id: gate.targetId,
      reason: gate.reason,
      required_action: gate.requiredAction
    })),
    evidence: projectEvidence.slice(0, 25).map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      created_at: item.createdAt,
      work_item_id: item.workItemId,
      confidence: item.confidence,
      tags: item.tags,
      has_url: Boolean(item.url)
    }))
  };
}

function buildWorkspaceGates(snapshot: WorkspaceSnapshot, generatedAt: string) {
  const schedules = scheduleShapeUpAwarePortfolio(snapshot.projects, snapshot.workItems, snapshot.dependencies);
  const calculated = snapshot.projects.flatMap((project) => {
    const schedule = schedules.find((candidate) => candidate.projectId === project.id);
    return evaluateAuditGates(project, snapshot.workItems, schedule?.items ?? [], snapshot.evidence, snapshot.changeSets, generatedAt);
  });
  const overrides = new Map(snapshot.auditGates.map((gate) => [gate.id, gate]));
  return calculated.map((gate) => ({ ...gate, status: overrides.get(gate.id)?.status ?? gate.status })).concat(
    snapshot.auditGates.filter((gate) => !calculated.some((candidate) => candidate.id === gate.id))
  );
}

function createAgentChangeSet(
  snapshot: WorkspaceSnapshot,
  projectId: string,
  title: string,
  reason: string,
  diffs: ChangeSet["diffs"],
  status: ChangeSet["status"],
  generatedAt: string,
  auditGateIds: string[] = []
): ChangeSet {
  const id = uniqueId("cs", title, snapshot.changeSets.map((changeSet) => changeSet.id));
  return {
    id,
    projectId,
    title,
    status,
    createdAt: generatedAt,
    reason,
    diffs,
    rollbackToken: `rollback-${id}`,
    auditGateIds
  };
}

function receipt({
  snapshot,
  generatedAt,
  dryRun,
  inputFormat,
  command,
  projectId,
  workItemId,
  risk,
  status,
  summary,
  messages,
  diffs
}: {
  snapshot: WorkspaceSnapshot;
  generatedAt: string;
  dryRun: boolean;
  inputFormat: AgentCommandInputFormat;
  command?: AgentCommand;
  projectId?: string;
  workItemId?: string;
  risk: AgentCommandRisk;
  status: AgentCommandStatus;
  summary: string;
  messages: string[];
  diffs: ChangeSet["diffs"];
}): AgentCommandReceipt {
  const revision = workspaceRevision(snapshot);
  return {
    id: `receipt-${hashText(`${revision}-${generatedAt}-${summary}`)}`,
    agent_protocol_version: AGENT_PROTOCOL_VERSION,
    received_at: generatedAt,
    workspace_revision: revision,
    dry_run: dryRun,
    status,
    risk,
    input_format: inputFormat,
    command,
    project_id: projectId,
    work_item_id: workItemId,
    summary,
    messages,
    diffs
  };
}

function invalidReceipt(snapshot: WorkspaceSnapshot, generatedAt: string, inputFormat: AgentCommandInputFormat, errors: string[], dryRun: boolean): AgentCommandReceipt {
  return receipt({
    snapshot,
    generatedAt,
    dryRun,
    inputFormat,
    risk: "invalid",
    status: "rejected",
    summary: errors[0] ?? "Invalid command.",
    messages: errors,
    diffs: []
  });
}

function commandSummary(command: AgentCommand, project: Project, workItem?: WorkItem) {
  if (command.command_type === "create_task") return `Create task ${command.title} in ${project.name}`;
  if (command.command_type === "update_task_progress") return `Update ${workItem?.title ?? command.work_item} progress in ${project.name}`;
  if (command.command_type === "record_actual") return `Record actuals for ${workItem?.title ?? command.work_item} in ${project.name}`;
  if (command.command_type === "add_evidence") return `Add evidence to ${project.name}`;
  if (command.command_type === "add_note") return `Add note to ${project.name}`;
  if (command.command_type === "update_shape_up_pitch") return `Update Shape Up pitch for ${project.name}`;
  if (command.command_type === "add_shape_up_scope") return `Add Shape Up scope ${command.title ?? ""} to ${project.name}`;
  if (command.command_type === "update_shape_up_scope") return `Update Shape Up scope ${command.scope_id ?? ""} in ${project.name}`;
  return `Request ${command.command_type} for ${project.name}`;
}

function resolveProject(snapshot: WorkspaceSnapshot, command: AgentCommand) {
  if (command.project_id) {
    return snapshot.projects.find((project) => project.id === command.project_id);
  }
  const name = command.project?.trim().toLowerCase();
  if (!name) return undefined;
  return snapshot.projects.find((project) => project.name.toLowerCase() === name || project.id.toLowerCase() === name) ??
    snapshot.projects.find((project) => project.name.toLowerCase().includes(name));
}

function resolveWorkItem(snapshot: WorkspaceSnapshot, projectId: string, command: AgentCommand) {
  const items = snapshot.workItems.filter((item) => item.projectId === projectId);
  if (command.work_item_id) return items.find((item) => item.id === command.work_item_id);
  const title = command.work_item?.trim().toLowerCase();
  if (!title) return undefined;
  return items.find((item) => item.title.toLowerCase() === title || item.outline === title) ??
    items.find((item) => item.title.toLowerCase().includes(title));
}

function nextOutline(workItems: WorkItem[], projectId: string) {
  const topLevel = workItems.filter((item) => item.projectId === projectId && !item.parentId);
  return String(topLevel.length + 1);
}

function isBaselineApproved(baseline: ReturnType<WorkspaceSnapshot["baselines"]["find"]>, changeSets: ChangeSet[]) {
  if (!baseline) return false;
  if (baseline.approvedByDecisionId) return true;
  const creationChangeSet = changeSets.find((changeSet) =>
    changeSet.diffs.some((diff) => diff.entity === "Baseline" && diff.entityId === baseline.id && diff.field === "created")
  );
  return !creationChangeSet || creationChangeSet.status === "approved";
}

function directionCardLines(card: DirectionCard | undefined) {
  if (!card) return ["target_user: missing", "problem: missing", "hypothesis: missing"];
  return [
    `target_user: ${card.targetUser}`,
    `user_problem: ${card.userProblem}`,
    `business_goal: ${card.businessGoal}`,
    `core_hypothesis: ${card.coreHypothesis}`,
    `success_metric: ${card.successMetric}`,
    `failure_condition: ${card.failureCondition}`,
    `validation_method: ${card.validationMethod}`,
    `opportunity_cost: ${card.opportunityCost}`,
    `timebox_days: ${card.timeboxDays}`
  ];
}

function normalizeTags(value: AgentCommand["tags"]) {
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  return ["agent-command"];
}

function cleanText(value: string) {
  return value.trim().replace(/^["“]|["”]$/g, "").trim();
}

function numberBeforeUnit(raw: string, units: string[]) {
  const unitPattern = units.map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = raw.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${unitPattern})`, "i"));
  return match ? Number(match[1]) : undefined;
}

function isAgentCommandType(value: unknown): value is AgentCommandType {
  return typeof value === "string" && [
    "create_task",
    "update_task_progress",
    "record_actual",
    "add_evidence",
    "add_note",
    "update_shape_up_pitch",
    "add_shape_up_scope",
    "update_shape_up_scope",
    "request_complete_project",
    "request_archive_project",
    "request_dependency_change",
    "request_baseline_change",
    "request_scope_expansion"
  ].includes(value);
}

function uniqueId(prefix: string, seed: string, existingIds: Iterable<string>) {
  const existing = new Set(existingIds);
  const base = `${prefix}-${slugify(seed)}`;
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "item";
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hashText(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
