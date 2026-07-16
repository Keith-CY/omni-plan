import { selectActiveHolds, selectProjectLifecycle } from "../../../domain/selectors";
import { betIntegrityIssue } from "../../../domain/betIntegrity";
import type {
  BetVersion,
  ProjectV2,
  WorkspaceV2,
} from "../../../domain/types";
import {
  scheduleV2Project,
  workItemsInActiveBet,
} from "../../../projections/schedulerAdapter";
import { useV2Workspace } from "../../state/V2WorkspaceProvider";

type PlanSummarySelection =
  | {
      ok: true;
      project: ProjectV2;
      bet: BetVersion;
      workItemCount: number;
      reviewOverdue: boolean;
      schedule: NonNullable<ReturnType<typeof scheduleV2Project>>;
    }
  | { ok: false; reason: string };

export function selectPlanSummary(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): PlanSummarySelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return {
      ok: false,
      reason: projects.length === 0
        ? "The Project record is missing."
        : "The Project identity is ambiguous, so its schedule is unavailable.",
    };
  }
  const project = projects[0];
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return { ok: false, reason: lifecycle.reason };
  if (project.stage !== "planning") {
    return {
      ok: false,
      reason: "The read-only Plan summary is available only after Bet confirmation and before Execute.",
    };
  }
  const holds = selectActiveHolds(workspace, projectId, now);
  if (!holds.ok) return { ok: false, reason: holds.reason };
  if (holds.holds.some(({ type }) => type === "rebet_required" || type === "migration_review")) {
    return {
      ok: false,
      reason: "The Plan projection is unavailable until the blocking hold is resolved.",
    };
  }
  if (project.activeBetId === undefined) {
    return { ok: false, reason: "The Project has no active Bet." };
  }
  const betMatches = workspace.bets.filter(({ id }) => id === project.activeBetId);
  const currentProjectBets = workspace.bets.filter(
    ({ projectId: ownerId, invalidatedAt }) =>
      ownerId === projectId && invalidatedAt === undefined,
  );
  if (
    betMatches.length !== 1 ||
    betMatches[0].projectId !== projectId ||
    betMatches[0].invalidatedAt !== undefined ||
    currentProjectBets.length !== 1 ||
    currentProjectBets[0].id !== project.activeBetId ||
    betMatches[0].briefSnapshot.projectId !== projectId ||
    betMatches[0].briefId !== betMatches[0].briefSnapshot.id
  ) {
    return {
      ok: false,
      reason: "The active Bet has ambiguous Project or Direction ownership, so the schedule is unavailable.",
    };
  }
  const bet = betMatches[0];
  const integrityIssue = betIntegrityIssue(bet, now);
  if (integrityIssue !== undefined) {
    return { ok: false, reason: integrityIssue };
  }
  const schedule = scheduleV2Project(workspace, projectId, now);
  if (schedule === undefined) {
    return {
      ok: false,
      reason: "The deterministic scheduler projection is unavailable for the active Bet.",
    };
  }
  return {
    ok: true,
    project,
    bet,
    workItemCount: workItemsInActiveBet(workspace, projectId).length,
    reviewOverdue: holds.holds.some(({ type }) => type === "review_overdue"),
    schedule,
  };
}

export function PlanStageSummary({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const now = state.readCurrentTime();
  const selection = selectPlanSummary(state.workspace, projectId, now);
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <p className="v2-eyebrow">Fail closed</p>
        <h2>Plan unavailable</h2>
        <p>{selection.reason}</p>
        <p>No schedule or work-item action is inferred from incomplete references.</p>
      </section>
    );
  }
  const { bet, schedule, workItemCount, reviewOverdue } = selection;
  const validEmpty =
    workItemCount === 0 &&
    schedule.items.length === 0 &&
    !schedule.diagnostics.some(({ severity }) => severity === "error") &&
    schedule.unsupported.length === 0;
  return (
    <section className="v2-plan-stage-summary" aria-label="Plan summary" data-readonly="true">
      <header>
        <p className="v2-eyebrow">Read-only after Bet</p>
        <h2>Plan summary</h2>
        <p>This projection is derived from the immutable active Bet; it has no raw Plan or stage setter.</p>
      </header>

      <section aria-label="Active Bet committed scope">
        <h3>Committed scope</h3>
        <ul>
          {bet.committedScope.map((scope) => (
            <li key={scope.id}>
              <strong>{scope.title}</strong>
              <span>{scope.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <p><strong>{workItemCount} work items in the active Bet</strong></p>
      {validEmpty ? (
        <section aria-label="Valid empty schedule">
          <h3>Valid empty schedule</h3>
          <p>Create first work item inside one committed scope to make scheduling concrete.</p>
        </section>
      ) : reviewOverdue && schedule.items.length < workItemCount ? (
        <section aria-label="Policy-filtered schedule">
          <h3>{schedule.items.length} items are currently schedulable</h3>
          <p>
            An overdue Review allows only today&apos;s already committed work.
            Complete the Review before scheduling the remaining items.
          </p>
        </section>
      ) : (
        <p>{schedule.items.length} items in the deterministic schedule.</p>
      )}

      <details className="v2-plan-stage-summary__details">
        <summary>Diagnostics ({schedule.diagnostics.length})</summary>
        {schedule.diagnostics.length === 0 ? (
          <p>No scheduler diagnostics.</p>
        ) : (
          <ul>
            {schedule.diagnostics.map((diagnostic, index) => (
              <li key={`${diagnostic.severity}:${diagnostic.itemId ?? "project"}:${index}`}>
                <strong>{diagnostic.severity}</strong> — {diagnostic.message}
                {diagnostic.itemId === undefined ? null : ` (${diagnostic.itemId})`}
              </li>
            ))}
          </ul>
        )}
      </details>

      <details className="v2-plan-stage-summary__details">
        <summary>Unsupported ({schedule.unsupported.length})</summary>
        {schedule.unsupported.length === 0 ? (
          <p>No unsupported scheduler boundaries.</p>
        ) : (
          <ul>{schedule.unsupported.map((message) => <li key={message}>{message}</li>)}</ul>
        )}
      </details>
    </section>
  );
}
