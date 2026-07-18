import { useCallback, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { CloseDecisionDraft } from "../../../domain/commands";
import { betIntegrityIssue } from "../../../domain/betIntegrity";
import {
  selectExactCurrentCloseBet,
  unfinishedProjectWorkItems,
  validateCloseDecisionDraft,
} from "../../../domain/close";
import {
  isConcreteEvidenceRequirement,
  requirementStatus,
} from "../../../domain/evidence";
import { resolveClosureProvenance } from "../../../domain/lifecycleProvenance";
import { selectProjectLifecycle } from "../../../domain/selectors";
import type {
  BetVersion,
  DirectionBrief,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "../../../domain/types";
import { CommandRejectionCard } from "../../components/CommandRejectionCard";
import { ModalSurface } from "../../components/ModalSurface";
import { useCommandForm } from "../../state/useCommandForm";
import {
  V2_UI_ACTOR_ID,
  useV2Workspace,
} from "../../state/V2WorkspaceProvider";
import { CloseConsequences } from "./CloseConsequences";
import { selectUiCommandPolicyAvailability } from "../uiCommandPolicy";

type CloseStageSelection =
  | {
      ok: true;
      project: ProjectV2;
      brief: DirectionBrief;
      bet: BetVersion;
      unfinished: ProjectWorkItem[];
      evidenceRequirementCount: number;
    }
  | { ok: false; reason: string };

function fail(reason: string): CloseStageSelection {
  return { ok: false, reason };
}

export function selectCloseStage(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): CloseStageSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return fail(projects.length === 0
      ? "The Project record is missing."
      : "The Project identity is ambiguous.");
  }
  const project = projects[0];
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return fail(lifecycle.reason);
  if (project.stage !== "closing") {
    return fail("Close is available only after validation is explicitly satisfied.");
  }
  const existingDecisions = workspace.closeDecisions.filter(
    ({ projectId: ownerId }) => ownerId === project.id,
  );
  if (existingDecisions.length > 0) {
    return fail("A Close decision already exists; resolve closure history before another decision.");
  }
  const briefs = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (
    briefs.length !== 1 ||
    briefs[0].projectId !== project.id ||
    briefs[0].successEvidence.trim().length === 0
  ) {
    return fail("Close requires one exact same-Project Direction success criterion.");
  }
  const currentBet = selectExactCurrentCloseBet(workspace, project);
  if (!currentBet.ok) return fail(currentBet.issue.reason);
  const integrityIssue = betIntegrityIssue(currentBet.bet, now);
  if (integrityIssue !== undefined) return fail(integrityIssue);
  const provenance = resolveClosureProvenance(
    workspace,
    project.id,
    now,
  );
  if (!provenance.ok) return fail(provenance.reason);
  const requirements = workspace.workItems
    .filter((item) => item.projectId === project.id && isConcreteEvidenceRequirement(item))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(requirements.map(({ id }) => id)).size !== requirements.length) {
    return fail("Close cannot resolve one exact record for every evidence requirement.");
  }
  for (const requirement of requirements) {
    const status = requirementStatus(workspace, project.id, requirement.id, now);
    if (!status.satisfied) {
      return fail(`Required Evidence for ${requirement.title} is missing or expired.`);
    }
  }
  const availability = selectUiCommandPolicyAvailability(
    workspace,
    {
      type: "close_project",
      projectId: project.id,
      decision: {
        id: `availability:close:${project.id}`,
        projectId: project.id,
        successComparison: "Availability check only.",
        outcome: "achieved",
        keyLearning: "Availability check only.",
        unfinishedDisposition: "historical_incomplete",
      },
    },
    now,
  );
  if (!availability.available) return fail(availability.reason);
  return {
    ok: true,
    project,
    brief: briefs[0],
    bet: currentBet.bet,
    unfinished: unfinishedProjectWorkItems(workspace, project.id),
    evidenceRequirementCount: requirements.length,
  };
}

type OutcomeChoice = CloseDecisionDraft["outcome"] | "";
type DispositionChoice = CloseDecisionDraft["unfinishedDisposition"] | "";

interface CloseFormDraft {
  successComparison: string;
  outcome: OutcomeChoice;
  keyLearning: string;
  unfinishedDisposition: DispositionChoice;
  followUpProjectId: string;
}

const EMPTY_CLOSE_DRAFT: CloseFormDraft = {
  successComparison: "",
  outcome: "",
  keyLearning: "",
  unfinishedDisposition: "",
  followUpProjectId: "",
};

const OUTCOME_LABELS: Record<CloseDecisionDraft["outcome"], string> = {
  achieved: "Achieved",
  partial: "Partial",
  invalidated: "Invalidated",
  abandoned: "Abandoned",
};

const DISPOSITION_LABELS: Record<CloseDecisionDraft["unfinishedDisposition"], string> = {
  discard: "Discard unfinished work",
  return_to_inbox: "Return unfinished work to Inbox",
  follow_up_project: "Create an explicit follow-up Project",
  historical_incomplete: "Keep as historical incomplete",
};

let closeIdSequence = 0;
function createCloseId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `close:${uuid}`;
  closeIdSequence += 1;
  return `close:${Date.now()}:${closeIdSequence}`;
}

function formIsComplete(draft: CloseFormDraft): boolean {
  const followUpId = draft.followUpProjectId.trim();
  return (
    draft.successComparison.trim().length > 0 &&
    draft.outcome !== "" &&
    draft.keyLearning.trim().length > 0 &&
    draft.unfinishedDisposition !== "" &&
    (draft.unfinishedDisposition === "follow_up_project"
      ? followUpId.length > 0 && draft.followUpProjectId === followUpId
      : draft.followUpProjectId.length === 0)
  );
}

function closeDecisionFromForm(
  projectId: string,
  draft: CloseFormDraft,
): CloseDecisionDraft | undefined {
  if (!formIsComplete(draft) || draft.outcome === "" || draft.unfinishedDisposition === "") {
    return undefined;
  }
  return {
    id: createCloseId(),
    projectId,
    successComparison: draft.successComparison.trim(),
    outcome: draft.outcome,
    keyLearning: draft.keyLearning.trim(),
    unfinishedDisposition: draft.unfinishedDisposition,
    ...(draft.unfinishedDisposition === "follow_up_project"
      ? { followUpProjectId: draft.followUpProjectId }
      : {}),
  };
}

function CloseConfirmationDialog({
  selection,
  decision,
  returnFocusRef,
  onClose,
}: {
  selection: Extract<CloseStageSelection, { ok: true }>;
  decision: CloseDecisionDraft;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  onClose(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const buildCommand = useCallback((value: CloseDecisionDraft) => ({
    type: "close_project" as const,
    projectId: selection.project.id,
    decision: value,
  }), [selection.project.id]);
  const form = useCommandForm(buildCommand);
  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };
  const submit = async () => {
    const result = await form.submit(decision);
    if (!result.ok) return;
    onClose();
    navigate(`/projects/${selection.project.id}/close`);
  };
  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-close-confirmation-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
      <p className="v2-eyebrow">Irreversible human decision</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Confirm Project Close</h2>
      <p id={descriptionId}>
        This exact comparison, outcome, learning, and work disposition cannot be
        edited after Close. The full Project history remains immutable.
      </p>
      <section className="v2-close-review" aria-label="Close decision review">
        <div><span>Direction criterion</span><p>{selection.brief.successEvidence}</p></div>
        <div><span>Your comparison</span><p>{decision.successComparison}</p></div>
        <div><span>Outcome</span><strong>{OUTCOME_LABELS[decision.outcome]}</strong></div>
        <div><span>Key learning</span><p>{decision.keyLearning}</p></div>
        <div>
          <span>Unfinished work</span>
          <strong>{selection.unfinished.length} Work Item{selection.unfinished.length === 1 ? "" : "s"}</strong>
          <p>{DISPOSITION_LABELS[decision.unfinishedDisposition]}</p>
          {decision.followUpProjectId === undefined ? null : <code>{decision.followUpProjectId}</code>}
        </div>
      </section>
      <CloseConsequences decision={decision} unfinished={selection.unfinished} />
      <CommandRejectionCard
        result={form.result}
        resolveLabel="Open Review"
        onResolve={() => {
          onClose();
          navigate("/review");
        }}
      />
      <div className="v2-dialog-actions">
        <button type="button" disabled={form.pending} onClick={cancel}>Cancel</button>
        <button
          type="button"
          className="v2-button--primary"
          disabled={form.pending}
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending ? "Closing…" : "Close Project"}
        </button>
      </div>
    </ModalSurface>
  );
}

function CloseStageReady({
  selection,
  workspace,
  now,
}: {
  selection: Extract<CloseStageSelection, { ok: true }>;
  workspace: WorkspaceV2;
  now: string;
}) {
  const [draft, setDraft] = useState<CloseFormDraft>(EMPTY_CLOSE_DRAFT);
  const [reviewDecision, setReviewDecision] = useState<CloseDecisionDraft>();
  const [localIssue, setLocalIssue] = useState<string>();
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const complete = formIsComplete(draft);
  const openReview = () => {
    const decision = closeDecisionFromForm(selection.project.id, draft);
    if (decision === undefined) {
      setLocalIssue("Complete every explicit Close decision before review.");
      return;
    }
    const issue = validateCloseDecisionDraft(
      workspace,
      selection.project,
      decision,
      V2_UI_ACTOR_ID,
      now,
      "close_project",
    );
    if (issue !== undefined) {
      setLocalIssue(issue.reason);
      return;
    }
    setLocalIssue(undefined);
    setReviewDecision(decision);
  };
  const setField = <K extends keyof CloseFormDraft>(
    key: K,
    value: CloseFormDraft[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  return (
    <section className="v2-guided-stage" aria-label="Close decision">
      <header>
        <p className="v2-eyebrow">Compare · Learn · Dispose</p>
        <h2>Close decision</h2>
        <p>Close is a durable decision record, not a status toggle. No answer is preselected.</p>
      </header>
      <section className="v2-stage-criterion" aria-label="Close success boundary">
        <span>Direction success evidence</span>
        <strong>{selection.brief.successEvidence}</strong>
        <p>{selection.evidenceRequirementCount} concrete evidence requirement{selection.evidenceRequirementCount === 1 ? "" : "s"} satisfied.</p>
      </section>
      <section className="v2-close-form" aria-label="Close decision form">
        <div className="v2-stage-form-grid">
          <label className="v2-stage-form-grid__wide">
            Success comparison
            <textarea
              aria-label="Success comparison"
              rows={5}
              value={draft.successComparison}
              onChange={(event) => setField("successComparison", event.target.value)}
            />
            <small>Compare the observed result directly with the Direction criterion above.</small>
          </label>
          <label>
            Outcome
            <select
              value={draft.outcome}
              onChange={(event) => setField("outcome", event.target.value as OutcomeChoice)}
            >
              <option value="">Choose an outcome</option>
              {Object.entries(OUTCOME_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Unfinished work disposition
            <select
              value={draft.unfinishedDisposition}
              onChange={(event) => {
                const value = event.target.value as DispositionChoice;
                setDraft((current) => ({
                  ...current,
                  unfinishedDisposition: value,
                  ...(value === "follow_up_project" ? {} : { followUpProjectId: "" }),
                }));
              }}
            >
              <option value="">Choose a disposition</option>
              {Object.entries(DISPOSITION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="v2-stage-form-grid__wide">
            Key learning
            <textarea
              rows={4}
              value={draft.keyLearning}
              onChange={(event) => setField("keyLearning", event.target.value)}
            />
          </label>
          {draft.unfinishedDisposition === "follow_up_project" ? (
            <label className="v2-stage-form-grid__wide">
              Follow-up Project ID
              <input
                aria-label="Follow-up Project ID"
                type="text"
                value={draft.followUpProjectId}
                onChange={(event) => setField("followUpProjectId", event.target.value)}
              />
              <small>Enter a unique, trimmed identity. It is recorded in the Close decision.</small>
            </label>
          ) : null}
        </div>
        <section className="v2-close-unfinished" aria-label="Unfinished Work Items">
          <div>
            <span>Explicit disposition required</span>
            <strong>{selection.unfinished.length} unfinished Work Item{selection.unfinished.length === 1 ? "" : "s"}</strong>
          </div>
          {selection.unfinished.length === 0 ? (
            <p>No unfinished Work Items.</p>
          ) : (
            <ul>{selection.unfinished.map((item) => <li key={item.id}>{item.title}</li>)}</ul>
          )}
        </section>
        {localIssue === undefined ? null : <p className="v2-form-error" role="alert">{localIssue}</p>}
        <div className="v2-stage-form-actions">
          <p>Review opens a read-only confirmation before the irreversible command.</p>
          <button
            ref={reviewTriggerRef}
            type="button"
            className="v2-button--primary"
            disabled={!complete}
            onClick={openReview}
          >
            Review Close decision
          </button>
        </div>
      </section>
      {reviewDecision === undefined ? null : (
        <CloseConfirmationDialog
          selection={selection}
          decision={reviewDecision}
          returnFocusRef={reviewTriggerRef}
          onClose={() => setReviewDecision(undefined)}
        />
      )}
    </section>
  );
}

export function CloseStage({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const now = state.readCurrentTime();
  const selection = selectCloseStage(state.workspace, projectId, now);
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <p className="v2-eyebrow">Fail closed</p>
        <h2>Close unavailable</h2>
        <p>{selection.reason}</p>
        <p>No Close decision is inferred from incomplete or ambiguous records.</p>
      </section>
    );
  }
  return (
    <CloseStageReady
      selection={selection}
      workspace={state.workspace}
      now={now}
    />
  );
}
