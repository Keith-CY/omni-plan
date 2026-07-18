import { useCallback, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { CloseDecisionDraft } from "../../../domain/commands";
import { validateCloseDecisionDraft } from "../../../domain/close";
import type {
  DirectionBrief,
  ProjectV2,
  ProjectWorkItem,
  WorkspaceV2,
} from "../../../domain/types";
import { CommandRejectionCard } from "../../components/CommandRejectionCard";
import { ModalSurface } from "../../components/ModalSurface";
import { useCommandForm } from "../../state/useCommandForm";
import { V2_UI_ACTOR_ID } from "../../state/V2WorkspaceProvider";
import { CloseConsequences } from "../close/CloseConsequences";

type Disposition = CloseDecisionDraft["unfinishedDisposition"] | "";

const DISPOSITIONS: Record<CloseDecisionDraft["unfinishedDisposition"], string> = {
  discard: "Discard unfinished work",
  return_to_inbox: "Return unfinished work to Inbox",
  follow_up_project: "Create an explicit follow-up Project",
  historical_incomplete: "Keep as historical incomplete",
};

interface AbandonDraft {
  successComparison: string;
  keyLearning: string;
  unfinishedDisposition: Disposition;
  followUpProjectId: string;
}

const EMPTY_DRAFT: AbandonDraft = {
  successComparison: "",
  keyLearning: "",
  unfinishedDisposition: "",
  followUpProjectId: "",
};

let abandonmentIdSequence = 0;
function createAbandonmentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `abandon:${uuid}`;
  abandonmentIdSequence += 1;
  return `abandon:${Date.now()}:${abandonmentIdSequence}`;
}

function decisionFromDraft(
  projectId: string,
  draft: AbandonDraft,
): (CloseDecisionDraft & { outcome: "abandoned" }) | undefined {
  const followUpId = draft.followUpProjectId.trim();
  if (
    draft.successComparison.trim().length === 0 ||
    draft.keyLearning.trim().length === 0 ||
    draft.unfinishedDisposition === "" ||
    (draft.unfinishedDisposition === "follow_up_project"
      ? followUpId.length === 0 || draft.followUpProjectId !== followUpId
      : draft.followUpProjectId.length > 0)
  ) {
    return undefined;
  }
  return {
    id: createAbandonmentId(),
    projectId,
    successComparison: draft.successComparison.trim(),
    outcome: "abandoned",
    keyLearning: draft.keyLearning.trim(),
    unfinishedDisposition: draft.unfinishedDisposition,
    ...(draft.unfinishedDisposition === "follow_up_project"
      ? { followUpProjectId: draft.followUpProjectId }
      : {}),
  };
}

function AbandonConfirmationDialog({
  project,
  brief,
  unfinished,
  decision,
  returnFocusRef,
  onClose,
}: {
  project: ProjectV2;
  brief: DirectionBrief;
  unfinished: ProjectWorkItem[];
  decision: CloseDecisionDraft & { outcome: "abandoned" };
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  onClose(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const navigate = useNavigate();
  const buildCommand = useCallback((value: typeof decision) => ({
    type: "abandon_project" as const,
    projectId: project.id,
    decision: value,
  }), [project.id]);
  const form = useCommandForm(buildCommand);
  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };
  const submit = async () => {
    if (!acknowledged) return;
    const result = await form.submit(decision);
    if (!result.ok) return;
    onClose();
    navigate(`/projects/${project.id}/close`);
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
      <p className="v2-eyebrow">Appetite boundary · irreversible decision</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Confirm Project abandonment</h2>
      <p id={descriptionId}>
        This closes the Project as abandoned at its recorded appetite boundary.
        The comparison, learning, and disposition cannot be edited afterward.
      </p>
      <section className="v2-close-review" aria-label="Abandonment decision review">
        <div><span>Direction criterion</span><p>{brief.successEvidence}</p></div>
        <div><span>Observed comparison</span><p>{decision.successComparison}</p></div>
        <div><span>Outcome</span><strong>Abandoned</strong></div>
        <div><span>Key learning</span><p>{decision.keyLearning}</p></div>
        <div><span>Disposition</span><strong>{DISPOSITIONS[decision.unfinishedDisposition]}</strong></div>
      </section>
      <CloseConsequences decision={decision} unfinished={unfinished} />
      <label className="v2-stage-acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I understand this closes the Project permanently as abandoned.
      </label>
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
          disabled={form.pending || !acknowledged}
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending ? "Abandoning…" : "Abandon and close Project"}
        </button>
      </div>
    </ModalSurface>
  );
}

export function BoundaryAbandonment({
  workspace,
  project,
  brief,
  unfinished,
  readCurrentTime,
}: {
  workspace: WorkspaceV2;
  project: ProjectV2;
  brief: DirectionBrief;
  unfinished: ProjectWorkItem[];
  readCurrentTime(): string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<AbandonDraft>(EMPTY_DRAFT);
  const [decision, setDecision] = useState<CloseDecisionDraft & { outcome: "abandoned" }>();
  const [issue, setIssue] = useState<string>();
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const openReview = () => {
    const candidate = decisionFromDraft(project.id, draft);
    if (candidate === undefined) {
      setIssue("Complete the comparison, learning, and explicit unfinished-work disposition.");
      return;
    }
    const validationIssue = validateCloseDecisionDraft(
      workspace,
      project,
      candidate,
      V2_UI_ACTOR_ID,
      readCurrentTime(),
      "abandon_project",
    );
    if (validationIssue !== undefined) {
      setIssue(validationIssue.reason);
      return;
    }
    setIssue(undefined);
    setDecision(candidate);
  };
  return (
    <section className="v2-boundary-abandonment" aria-label="Appetite boundary decision">
      <header>
        <p className="v2-eyebrow">Recorded appetite boundary</p>
        <h3>Stop without hiding the result</h3>
        <p>
          Validation may continue, or a human may close the Project as abandoned
          with the same durable learning and work-disposition requirements as Close.
        </p>
      </header>
      {!expanded ? (
        <button type="button" onClick={() => setExpanded(true)}>
          Start abandonment review
        </button>
      ) : (
        <div className="v2-stage-form-grid">
          <label className="v2-stage-form-grid__wide">
            Success comparison
            <textarea
              rows={4}
              value={draft.successComparison}
              onChange={(event) => setDraft((current) => ({ ...current, successComparison: event.target.value }))}
            />
          </label>
          <label className="v2-stage-form-grid__wide">
            Key learning
            <textarea
              rows={4}
              value={draft.keyLearning}
              onChange={(event) => setDraft((current) => ({ ...current, keyLearning: event.target.value }))}
            />
          </label>
          <label>
            Unfinished work disposition
            <select
              value={draft.unfinishedDisposition}
              onChange={(event) => {
                const value = event.target.value as Disposition;
                setDraft((current) => ({
                  ...current,
                  unfinishedDisposition: value,
                  ...(value === "follow_up_project" ? {} : { followUpProjectId: "" }),
                }));
              }}
            >
              <option value="">Choose a disposition</option>
              {Object.entries(DISPOSITIONS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          {draft.unfinishedDisposition === "follow_up_project" ? (
            <label>
              Follow-up Project ID
              <input
                type="text"
                value={draft.followUpProjectId}
                onChange={(event) => setDraft((current) => ({ ...current, followUpProjectId: event.target.value }))}
              />
            </label>
          ) : null}
          {issue === undefined ? null : <p className="v2-form-error" role="alert">{issue}</p>}
          <div className="v2-stage-form-actions v2-stage-form-grid__wide">
            <button type="button" onClick={() => setExpanded(false)}>Cancel</button>
            <button
              ref={reviewTriggerRef}
              type="button"
              className="v2-button--primary"
              onClick={openReview}
            >
              Review abandonment decision
            </button>
          </div>
        </div>
      )}
      {decision === undefined ? null : (
        <AbandonConfirmationDialog
          project={project}
          brief={brief}
          unfinished={unfinished}
          decision={decision}
          returnFocusRef={reviewTriggerRef}
          onClose={() => setDecision(undefined)}
        />
      )}
    </section>
  );
}
