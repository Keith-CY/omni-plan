import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { betIntegrityIssue } from "../../../domain/betIntegrity";
import { resolveExecutionPlanProvenance } from "../../../domain/planning";
import {
  selectActiveHolds,
  selectProjectLifecycle,
} from "../../../domain/selectors";
import type {
  BetVersion,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "../../../domain/types";
import { CommandRejectionCard } from "../../components/CommandRejectionCard";
import { ModalSurface } from "../../components/ModalSurface";
import { useCommandForm } from "../../state/useCommandForm";
import { useV2Workspace } from "../../state/V2WorkspaceProvider";
import { selectUiCommandPolicyAvailability } from "../uiCommandPolicy";

type ExecuteStageSelection =
  | {
      ok: true;
      project: ProjectV2;
      bet: BetVersion;
      workItems: ProjectWorkItem[];
      unfinished: ProjectWorkItem[];
      evidenceRequirementCount: number;
      transitionBlock?: { reason: string; permittedNextCommand: string };
    }
  | { ok: false; reason: string };

function fail(reason: string): ExecuteStageSelection {
  return { ok: false, reason };
}

export function selectExecuteStage(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): ExecuteStageSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return fail(projects.length === 0
      ? "The Project record is missing."
      : "The Project identity is ambiguous.");
  }
  const project = projects[0];
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return fail(lifecycle.reason);
  if (project.stage !== "executing") {
    return fail("Execute is available only after a human-approved Today commitment.");
  }
  if (project.activeBetId === undefined) return fail("Execute requires one active Bet.");
  const bets = workspace.bets.filter(({ id }) => id === project.activeBetId);
  if (
    bets.length !== 1 ||
    bets[0].projectId !== project.id ||
    bets[0].invalidatedAt !== undefined
  ) {
    return fail("The active Bet has missing, conflicting, or cross-Project ownership.");
  }
  const integrityIssue = betIntegrityIssue(bets[0], now);
  if (integrityIssue !== undefined) return fail(integrityIssue);
  if (Date.parse(now) >= Date.parse(bets[0].appetiteEnd)) {
    return fail("The active Bet appetite has ended. Complete the boundary Review and place a new Bet before requesting validation.");
  }
  if (project.activePlanVersionId === undefined) {
    return fail("Execute requires the exact Plan created by the accepted Today commitment.");
  }
  const plans = workspace.planVersions.filter(
    ({ id }) => id === project.activePlanVersionId,
  );
  if (
    plans.length !== 1 ||
    plans[0].projectId !== project.id ||
    plans[0].betId !== bets[0].id
  ) {
    return fail("The active Plan has missing, conflicting, or cross-Bet ownership.");
  }
  const provenance = resolveExecutionPlanProvenance(
    workspace,
    project.id,
    now,
  );
  if (!provenance.ok) return fail(provenance.reason);
  const holds = selectActiveHolds(workspace, project.id, now);
  if (!holds.ok) return fail(holds.reason);
  const availability = selectUiCommandPolicyAvailability(
    workspace,
    { type: "request_validation", projectId: project.id },
    now,
  );
  const scopeIds = new Set(bets[0].committedScope.map(({ id }) => id));
  const workItems = workspace.workItems
    .filter((item) => item.projectId === project.id && scopeIds.has(item.betScopeId))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(workItems.map(({ id }) => id)).size !== workItems.length) {
    return fail("Execute cannot resolve one exact record for every Work Item.");
  }
  return {
    ok: true,
    project,
    bet: bets[0],
    workItems,
    unfinished: workItems.filter(({ resultStatus }) => resultStatus === undefined),
    evidenceRequirementCount: workItems.filter(
      ({ kind, evidenceRequired }) => kind === "milestone" && evidenceRequired === true,
    ).length,
    ...(availability.available ? {} : {
      transitionBlock: {
        reason: availability.reason,
        permittedNextCommand: availability.permittedNextCommand,
      },
    }),
  };
}

function resultLabel(item: ProjectWorkItem): string {
  switch (item.resultStatus) {
    case "completed": return "Completed";
    case "learned": return "Learning captured";
    case "blocked": return "Blocked with outcome";
    case undefined: return "Unfinished";
  }
}

function ValidationRequestDialog({
  selection,
  open,
  returnFocusRef,
  fallbackFocusRef,
  onClose,
}: {
  selection: Extract<ExecuteStageSelection, { ok: true }>;
  open: boolean;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  fallbackFocusRef: React.RefObject<HTMLHeadingElement>;
  onClose(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const [acknowledged, setAcknowledged] = useState(false);
  const buildCommand = useCallback(() => ({
    type: "request_validation" as const,
    projectId: selection.project.id,
  }), [selection.project.id]);
  const form = useCommandForm(buildCommand);
  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    setTimeout(() => {
      const trigger = returnFocusRef.current;
      if (trigger !== null && !trigger.disabled) trigger.focus();
      else fallbackFocusRef.current?.focus();
    }, 0);
  }, [fallbackFocusRef, onClose, returnFocusRef]);
  useEffect(() => {
    if (open && selection.transitionBlock !== undefined) closeAndRestoreFocus();
  }, [closeAndRestoreFocus, open, selection.transitionBlock]);
  if (!open) return null;

  const cancel = closeAndRestoreFocus;
  const submit = async () => {
    if (selection.transitionBlock !== undefined) return;
    const result = await form.submit(undefined);
    if (!result.ok) return;
    onClose();
    navigate(`/projects/${selection.project.id}/evidence`);
  };
  const requiresAcknowledgement = selection.unfinished.length > 0;
  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-stage-transition-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
      <p className="v2-eyebrow">Human checkpoint</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Confirm validation request</h2>
      <p id={descriptionId}>
        Execute history stays intact. Evidence review is a separate stage and is
        never completed automatically.
      </p>
      <dl className="v2-stage-review-facts">
        <div><dt>Work Items</dt><dd>{selection.workItems.length}</dd></div>
        <div><dt>Unfinished</dt><dd>{selection.unfinished.length}</dd></div>
        <div><dt>Evidence requirements</dt><dd>{selection.evidenceRequirementCount}</dd></div>
      </dl>
      {requiresAcknowledgement ? (
        <label className="v2-stage-acknowledgement">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          I understand unfinished work still needs an explicit Close disposition.
        </label>
      ) : null}
      <CommandRejectionCard
        result={form.result}
        resolveLabel="Open Review"
        onResolve={() => {
          onClose();
          navigate("/review");
        }}
      />
      {form.pending ? <p role="status" className="v2-sr-only">Requesting validation…</p> : null}
      <div className="v2-dialog-actions">
        <button type="button" disabled={form.pending} onClick={cancel}>Cancel</button>
        <button
          type="button"
          className="v2-button--primary"
          disabled={
            form.pending ||
            selection.transitionBlock !== undefined ||
            (requiresAcknowledgement && !acknowledged)
          }
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending ? "Requesting…" : "Request validation"}
        </button>
      </div>
    </ModalSurface>
  );
}

function ExecuteStageReady({
  selection,
}: {
  selection: Extract<ExecuteStageSelection, { ok: true }>;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  return (
    <section className="v2-guided-stage" aria-label="Execute workspace">
      <header>
        <p className="v2-eyebrow">Work the accepted commitment</p>
        <h2 ref={stageHeadingRef} tabIndex={-1}>Execute workspace</h2>
        <p>
          Record work through Today. This Project view preserves the accepted Plan
          and exposes only the explicit handoff into Evidence.
        </p>
      </header>
      <section className="v2-stage-summary" aria-label="Execute status summary">
        <div className="v2-stage-summary__headline">
          <div>
            <span>Current Bet scope</span>
            <strong>{selection.workItems.length} Work Items</strong>
          </div>
          <div>
            <span>Open boundary</span>
            <strong>{selection.unfinished.length} unfinished work item{selection.unfinished.length === 1 ? "" : "s"}</strong>
          </div>
        </div>
        <ul className="v2-stage-record-list">
          {selection.workItems.map((item) => (
            <li key={item.id} data-status={item.resultStatus ?? "unfinished"}>
              <div>
                <strong>{item.title}</strong>
                <span>{resultLabel(item)}</span>
              </div>
              <p>{item.outcomeNote ?? item.outline}</p>
              {item.kind === "milestone" && item.evidenceRequired === true
                ? <small>Evidence required before Close</small>
                : null}
            </li>
          ))}
        </ul>
      </section>
      <aside className="v2-stage-next-action" aria-label="Execute next action">
        <div>
          <p className="v2-eyebrow">One next decision</p>
          <h3>
            {selection.transitionBlock !== undefined
              ? selection.transitionBlock.reason
              : selection.unfinished.length > 0
                ? "Continue in Today or enter validation consciously"
                : "Review the validation boundary"}
          </h3>
          <p>
            Validation does not erase unfinished work. Close will require one
            explicit disposition for anything without a result.
          </p>
        </div>
        <div>
          <Link to="/today">Open Today</Link>
          <button
            ref={reviewTriggerRef}
            type="button"
            className="v2-button--primary"
            disabled={selection.transitionBlock !== undefined}
            onClick={() => setReviewOpen(true)}
          >
            Review validation request
          </button>
        </div>
      </aside>
      <ValidationRequestDialog
        selection={selection}
        open={reviewOpen}
        returnFocusRef={reviewTriggerRef}
        fallbackFocusRef={stageHeadingRef}
        onClose={() => setReviewOpen(false)}
      />
    </section>
  );
}

export function ExecuteStage({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const selection = selectExecuteStage(
    state.workspace,
    projectId,
    state.readCurrentTime(),
  );
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <p className="v2-eyebrow">Fail closed</p>
        <h2>Execute unavailable</h2>
        <p>{selection.reason}</p>
        <p>No Work Item or lifecycle mutation is inferred from ambiguous records.</p>
      </section>
    );
  }
  return <ExecuteStageReady selection={selection} />;
}
