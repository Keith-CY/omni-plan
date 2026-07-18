import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";

import {
  selectLockedStages,
  selectProjectLifecycle,
  selectRecommendedNextAction,
  type ProjectLifecycleStep,
  type UserLifecycleStage,
} from "../../domain/selectors";
import { useV2Workspace } from "../state/V2WorkspaceProvider";
import { BetHistory } from "./bet/BetHistory";
import { BetStage } from "./bet/BetStage";
import { CloseStage } from "./close/CloseStage";
import { DirectionStage } from "./direction/DirectionStage";
import { EvidenceStage } from "./evidence/EvidenceStage";
import { ExecuteStage } from "./execute/ExecuteStage";
import { LifecycleNav, USER_LIFECYCLE_STAGES, USER_STAGE_LABELS } from "./LifecycleNav";
import { LockedStagePanel } from "./LockedStagePanel";
import { PlanStageSummary } from "./plan/PlanStageSummary";
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

function StageHistory({
  step,
  projectId,
  allowDirectionRevision,
}: {
  step: ProjectLifecycleStep;
  projectId: string;
  allowDirectionRevision: boolean;
}) {
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
      {step.stage === "direction" && allowDirectionRevision ? (
        <Link
          className="v2-stage-history__action"
          to={`/projects/${projectId}/direction`}
        >
          Revise Direction
        </Link>
      ) : null}
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
    (step.status === "current" || (
      recommended?.projectId === projectId &&
      recommended.permittedNextCommand === "place_bet"
    ));
  const directionHistoryRequested =
    stage === "direction" &&
    step.status === "completed" &&
    searchParams.get("view") === "history";
  const showDirectionEditor = stage === "direction" && !directionHistoryRequested;
  const betHistoryRequested =
    stage === "bet" && searchParams.get("view") === "history";
  const showBetDecision = betDecisionRequired && !betHistoryRequested;
  const showBetHistory =
    stage === "bet" &&
    (betHistoryRequested || (!betDecisionRequired && step.status === "completed"));
  const showPlanSummary = stage === "plan" && step.status === "current";
  const showExecuteStage = stage === "execute" && step.status === "current";
  const showEvidenceStage = stage === "evidence" && step.status === "current";
  const showCloseStage = stage === "close" && step.status === "current";

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
        ) : showDirectionEditor ? (
          <DirectionStage projectId={projectId} />
        ) : showBetDecision ? (
          <BetStage projectId={projectId} />
        ) : showBetHistory ? (
          <BetHistory projectId={projectId} />
        ) : showPlanSummary ? (
          <PlanStageSummary projectId={projectId} />
        ) : showExecuteStage ? (
          <ExecuteStage projectId={projectId} />
        ) : showEvidenceStage ? (
          <EvidenceStage projectId={projectId} />
        ) : showCloseStage ? (
          <CloseStage projectId={projectId} />
        ) : step.status === "completed" ? (
          <StageHistory
            step={step}
            projectId={projectId}
            allowDirectionRevision={
              project.stage !== "closing" && project.stage !== "closed"
            }
          />
        ) : (
          <CurrentStageShell stage={stage} />
        )}
      </div>
    </article>
  );
}
