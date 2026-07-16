import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";

import {
  selectLockedStages,
  selectProjectLifecycle,
  selectRecommendedNextAction,
  type ProjectLifecycleStep,
  type UserLifecycleStage,
} from "../../domain/selectors";
import { useV2Workspace } from "../state/V2WorkspaceProvider";
import { LifecycleNav, USER_LIFECYCLE_STAGES, USER_STAGE_LABELS } from "./LifecycleNav";
import { LockedStagePanel } from "./LockedStagePanel";
import { ProjectHeader } from "./ProjectHeader";

function isLifecycleStage(value: string | undefined): value is UserLifecycleStage {
  return value !== undefined && USER_LIFECYCLE_STAGES.some((stage) => stage === value);
}

function CurrentStageShell({ stage }: { stage: UserLifecycleStage }) {
  return (
    <section className="v2-current-stage-shell" aria-label={`${stage} current stage`}>
      <p className="v2-eyebrow">Current decision space</p>
      <h2>{USER_STAGE_LABELS[stage]} workspace</h2>
      <p>
        Continue with the guided {USER_STAGE_LABELS[stage]} decisions. This shell exposes
        no raw lifecycle setter.
      </p>
    </section>
  );
}

function StageHistory({ step }: { step: ProjectLifecycleStep }) {
  return (
    <section
      className="v2-stage-history"
      aria-label={`${step.label} immutable history`}
      data-readonly="true"
    >
      <p className="v2-eyebrow">Immutable history</p>
      <h2>{step.label} history</h2>
      {step.historyRecordIds === undefined || step.historyRecordIds.length === 0 ? (
        <p>No stored record was required for this completed stage.</p>
      ) : (
        <ul>
          {step.historyRecordIds.map((recordId) => <li key={recordId}><code>{recordId}</code></li>)}
        </ul>
      )}
    </section>
  );
}

function ProjectRecoveryPage({
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
      className="v2-project-workspace v2-route-page"
      aria-label={`Project ${projectId} recovery`}
    >
      <header className="v2-page-heading">
        <p className="v2-eyebrow">Project lifecycle recovery</p>
        <h1>Project unavailable</h1>
        <p>{reason}</p>
      </header>
      <p>Permitted next command: <code>{permittedNextCommand}</code></p>
      <Link className="v2-project-header__back" to="/projects">Back to Projects</Link>
    </article>
  );
}

export function ProjectWorkspacePage() {
  const { projectId = "", stage } = useParams();
  const [searchParams] = useSearchParams();
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  if (!isLifecycleStage(stage)) {
    return <Navigate to={`/projects/${projectId}/direction`} replace />;
  }

  const projects = state.workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return (
      <ProjectRecoveryPage
        projectId={projectId}
        reason={projects.length === 0
          ? `Project ${projectId} does not exist.`
          : `Project ${projectId} has duplicate records for one identity.`}
        permittedNextCommand={projects.length === 0
          ? "confirm_project_triage"
          : "resolve_sync_conflict"}
      />
    );
  }

  const project = projects[0];
  const lifecycle = selectProjectLifecycle(state.workspace, projectId);
  if (!lifecycle.ok) {
    return (
      <ProjectRecoveryPage
        projectId={projectId}
        reason={lifecycle.reason}
        permittedNextCommand={lifecycle.permittedNextCommand}
      />
    );
  }
  const steps = lifecycle.steps;
  const step = steps.find((item) => item.stage === stage)!;
  const lock = selectLockedStages(state.workspace, projectId).find(
    (item) => item.stage === stage,
  );
  const recommended = selectRecommendedNextAction(state.workspace, projectId);
  const betDecisionRequired =
    stage === "bet" &&
    searchParams.get("view") !== "history" &&
    recommended?.projectId === projectId &&
    recommended.permittedNextCommand === "place_bet";

  return (
    <article className="v2-project-workspace v2-route-page">
      <ProjectHeader workspace={state.workspace} project={project} />
      <LifecycleNav projectId={projectId} steps={steps} />
      <div className="v2-project-stage-surface">
        {lock !== undefined ? (
          <LockedStagePanel
            stage={stage}
            reason={lock.reason}
            nextCommand={lock.permittedNextCommand}
          />
        ) : betDecisionRequired ? (
          <CurrentStageShell stage="bet" />
        ) : step.status === "completed" ? (
          <StageHistory step={step} />
        ) : (
          <CurrentStageShell stage={stage} />
        )}
      </div>
    </article>
  );
}
