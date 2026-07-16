import { Link } from "react-router-dom";

import { selectActiveHolds, selectProjectLifecycle } from "../../domain/selectors";
import type { ProjectV2, WorkspaceV2 } from "../../domain/types";
import { HoldBanner } from "../components/HoldBanner";
import {
  BetReadout,
  ProjectNextAction,
} from "../project/ProjectHeader";
import {
  lifecycleStageLabel,
  projectStageSegment,
} from "../project/LifecycleNav";

export interface ProjectCardProps {
  workspace: WorkspaceV2;
  project: ProjectV2;
}

export function ProjectRecoveryCard({
  projectId,
  reason,
  permittedNextCommand,
}: {
  projectId: string;
  reason: string;
  permittedNextCommand: string;
}) {
  return (
    <article
      className="v2-project-card v2-project-card--recovery"
      aria-label={`Project ${projectId} recovery`}
    >
      <header>
        <p className="v2-eyebrow">Recovery required</p>
        <h2>Project unavailable</h2>
      </header>
      <p>{reason}</p>
      <p>Permitted next command: <code>{permittedNextCommand}</code></p>
    </article>
  );
}

export function ProjectCard({ workspace, project }: ProjectCardProps) {
  const lifecycle = selectProjectLifecycle(workspace, project.id);
  if (!lifecycle.ok) {
    return (
      <ProjectRecoveryCard
        projectId={project.id}
        reason={lifecycle.reason}
        permittedNextCommand={lifecycle.permittedNextCommand}
      />
    );
  }
  const stage = projectStageSegment(project.stage);
  const holds = selectActiveHolds(workspace, project.id);
  return (
    <article className="v2-project-card" aria-label={project.name}>
      <header>
        <p className="v2-project-card__stage">
          <span>Current stage</span>
          <strong>{lifecycleStageLabel(project.stage)}</strong>
        </p>
        <h2>
          <Link to={`/projects/${project.id}/${stage}`}>{project.name}</Link>
        </h2>
      </header>
      <BetReadout workspace={workspace} project={project} />
      {holds.ok ? <HoldBanner holds={holds.holds} compact /> : (
        <aside className="v2-hold-banner v2-hold-banner--compact" aria-label="Active project holds">
          <p>{holds.reason}</p>
          <p>Permitted next command: <code>{holds.permittedNextCommand}</code></p>
        </aside>
      )}
      <ProjectNextAction workspace={workspace} project={project} />
      <details className="v2-project-diagnostics">
        <summary>Record details</summary>
        <p>Project <code>{project.id}</code></p>
        <p>
          Updated <time
            dateTime={project.updatedAt}
            aria-label={`Project last updated: ${project.updatedAt}`}
          >
            {project.updatedAt}
          </time>
        </p>
      </details>
    </article>
  );
}
