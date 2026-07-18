import { Link } from "react-router-dom";

import {
  selectActiveHolds,
  selectRecommendedNextAction,
} from "../../domain/selectors";
import type {
  BetVersion,
  LifecycleStage,
  ProjectV2,
  WorkspaceV2,
} from "../../domain/types";
import { HoldBanner } from "../components/HoldBanner";
import {
  lifecycleStageLabel,
  projectStageSegment,
  USER_STAGE_LABELS,
} from "./LifecycleNav";

const fallbackActions: Record<
  LifecycleStage,
  { reason: string; command: string }
> = {
  direction: {
    reason: "Finish the six Direction decisions.",
    command: "update_direction",
  },
  awaiting_bet: {
    reason: "Review the Direction and place the human Bet.",
    command: "place_bet",
  },
  planning: {
    reason: "Create the first Work Item inside the committed Bet scope.",
    command: "create_work_item",
  },
  executing: {
    reason: "Commit the next bounded Work Item to Today.",
    command: "commit_today",
  },
  validating: {
    reason: "Review required Evidence against the success criteria.",
    command: "satisfy_validation",
  },
  closing: {
    reason: "Make the explicit Close decision.",
    command: "close_project",
  },
  closed: {
    reason: "Read the immutable lifecycle history.",
    command: "read_project_history",
  },
};

export interface ProjectNextActionPresentation {
  reason: string;
  command: string;
  href: string;
  label: string;
}

const projectStageByCommand = {
  update_direction: "direction",
  place_bet: "bet",
  record_bet_boundary: "bet",
  create_work_item: "plan",
  request_validation: "evidence",
  attach_evidence: "evidence",
  approve_evidence_exception: "evidence",
  satisfy_validation: "evidence",
  close_project: "close",
  abandon_project: "evidence",
  read_project_history: "close",
  create_follow_up_project: "close",
  archive_project: "close",
} as const satisfies Record<string, ReturnType<typeof projectStageSegment>>;

const todayCommands = new Set([
  "commit_today",
  "accept_replan",
  "record_actual",
]);

const reviewCommands = new Set([
  "resolve_sync_conflict",
  "complete_review",
  "create_review",
  "read_review_history",
]);

function projectActionStage(
  project: ProjectV2,
  command: string,
): ReturnType<typeof projectStageSegment> {
  return projectStageByCommand[command as keyof typeof projectStageByCommand]
    ?? projectStageSegment(project.stage);
}

export function projectActionDestination(
  project: ProjectV2,
  command: string,
): Pick<ProjectNextActionPresentation, "href" | "label"> {
  if (todayCommands.has(command)) {
    return { href: "/today", label: "Open Today" };
  }
  if (reviewCommands.has(command)) {
    return { href: "/review", label: "Open Review" };
  }
  const stage = projectActionStage(project, command);
  return {
    href: `/projects/${project.id}/${stage}`,
    label: project.stage === "closed"
      ? "View lifecycle history"
      : `Open ${USER_STAGE_LABELS[stage]}`,
  };
}

export function projectNextAction(
  workspace: WorkspaceV2,
  project: ProjectV2,
): ProjectNextActionPresentation {
  const selected = selectRecommendedNextAction(workspace, project.id);
  const fallback = fallbackActions[project.stage];
  const command = selected?.permittedNextCommand ?? fallback.command;
  const destination = projectActionDestination(project, command);
  return {
    reason: selected?.reason ?? fallback.reason,
    command,
    ...destination,
  };
}

export function activeProjectBet(
  workspace: WorkspaceV2,
  project: ProjectV2,
): BetVersion | undefined {
  if (project.activeBetId === undefined) return undefined;
  const matches = workspace.bets.filter(({ id }) => id === project.activeBetId);
  return matches.length === 1 && matches[0].projectId === project.id
    ? matches[0]
    : undefined;
}

export function formatAppetite(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return "Not placed";
  }
  const parts: string[] = [];
  let remaining = seconds;
  for (const [unit, unitSeconds] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    const count = Math.floor(remaining / unitSeconds);
    if (count === 0) continue;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining -= count * unitSeconds;
  }
  if (remaining > 0) {
    parts.push(`${remaining} second${remaining === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

function formatExpiry(value: string, timeZone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

export function ProjectNextAction({
  workspace,
  project,
}: {
  workspace: WorkspaceV2;
  project: ProjectV2;
}) {
  const action = projectNextAction(workspace, project);
  return (
    <section className="v2-project-next-action" aria-label="Recommended next action">
      <p className="v2-eyebrow">Recommended next action</p>
      <p>{action.reason}</p>
      <Link to={action.href}>{action.label}</Link>
      <details>
        <summary>Gate detail</summary>
        <p>Permitted command: <code>{action.command}</code></p>
      </details>
    </section>
  );
}

export function BetReadout({
  workspace,
  project,
}: {
  workspace: WorkspaceV2;
  project: ProjectV2;
}) {
  const bet = activeProjectBet(workspace, project);
  const timeZone = workspace.capacityProfile?.timeZone ?? "UTC";
  const expiry = bet === undefined
    ? undefined
    : formatExpiry(bet.appetiteEnd, timeZone);
  return (
    <dl className="v2-project-bet-readout">
      <div>
        <dt>Bet appetite</dt>
        <dd>{formatAppetite(bet?.briefSnapshot.appetiteSeconds)}</dd>
      </div>
      <div>
        <dt>Bet expiry</dt>
        <dd>
          {bet === undefined ? "No active Bet" : (
            <time
              dateTime={bet.appetiteEnd}
              aria-label={`Bet expiry: ${expiry}`}
            >
              {expiry}
            </time>
          )}
        </dd>
      </div>
    </dl>
  );
}

export interface ProjectHeaderProps {
  workspace: WorkspaceV2;
  project: ProjectV2;
}

export function ProjectHeader({ workspace, project }: ProjectHeaderProps) {
  const holds = selectActiveHolds(workspace, project.id);
  return (
    <header className="v2-project-header">
      <Link className="v2-project-header__back" to="/projects">Back to Projects</Link>
      <div className="v2-project-header__identity">
        <div>
          <p className="v2-eyebrow">Project workspace</p>
          <h1>{project.name}</h1>
        </div>
        <div className="v2-current-stage" aria-label="Current lifecycle stage">
          <span>Current stage</span>
          <strong>{lifecycleStageLabel(project.stage)}</strong>
        </div>
      </div>
      <BetReadout workspace={workspace} project={project} />
      {holds.ok ? <HoldBanner holds={holds.holds} /> : (
        <aside className="v2-hold-banner" aria-label="Active project holds">
          <p>{holds.reason}</p>
          <p>Permitted next command: <code>{holds.permittedNextCommand}</code></p>
        </aside>
      )}
      <ProjectNextAction workspace={workspace} project={project} />
      <details className="v2-project-diagnostics">
        <summary>Project record</summary>
        <dl>
          <div><dt>Project ID</dt><dd><code>{project.id}</code></dd></div>
          <div><dt>Direction record</dt><dd><code>{project.activeDirectionBriefId}</code></dd></div>
          <div><dt>Priority</dt><dd>{project.priority}</dd></div>
          <div>
            <dt>Last updated</dt>
            <dd>
              <time
                dateTime={project.updatedAt}
                aria-label={`Project last updated: ${project.updatedAt}`}
              >
                {project.updatedAt}
              </time>
            </dd>
          </div>
        </dl>
      </details>
    </header>
  );
}
