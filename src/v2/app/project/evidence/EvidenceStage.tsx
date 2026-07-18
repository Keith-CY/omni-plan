import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { EvidenceKind } from "@/domain/types";

import { betIntegrityIssue } from "../../../domain/betIntegrity";
import type {
  CloseDecisionDraft,
  ExceptionDraft,
} from "../../../domain/commands";
import {
  exactCanonicalAppetiteBoundaryHold,
  unfinishedProjectWorkItems,
  validateCloseDecisionDraft,
} from "../../../domain/close";
import {
  isConcreteEvidenceRequirement,
  isExceptionActive,
  isUsableEvidenceAt,
  requirementStatus,
} from "../../../domain/evidence";
import { resolveValidationProvenance } from "../../../domain/lifecycleProvenance";
import {
  selectActiveHolds,
  selectProjectLifecycle,
} from "../../../domain/selectors";
import type {
  BetVersion,
  DirectionBrief,
  ExceptionRecord,
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
import { BoundaryAbandonment } from "./BoundaryAbandonment";
import { selectUiCommandPolicyAvailability } from "../uiCommandPolicy";

interface EvidenceRequirementModel {
  workItem: ProjectWorkItem;
  status:
    | { satisfied: true; via: "evidence"; evidenceCount: number }
    | { satisfied: true; via: "exception"; exception: ExceptionRecord }
    | {
        satisfied: false;
        code: "EVIDENCE_REQUIRED" | "EXCEPTION_EXPIRED";
        exceptionId?: string;
      };
}

interface TransitionBlock {
  reason: string;
  permittedNextCommand: string;
}

type EvidenceStageSelection =
  | {
      ok: true;
      project: ProjectV2;
      brief: DirectionBrief;
      bet: BetVersion;
      requirements: EvidenceRequirementModel[];
      canSatisfy: boolean;
      transitionBlock?: TransitionBlock;
      canAbandon: boolean;
      unfinished: ProjectWorkItem[];
    }
  | { ok: false; reason: string };

function fail(reason: string): EvidenceStageSelection {
  return { ok: false, reason };
}

export function selectEvidenceStage(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): EvidenceStageSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return fail(projects.length === 0
      ? "The Project record is missing."
      : "The Project identity is ambiguous.");
  }
  const project = projects[0];
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return fail(lifecycle.reason);
  if (project.stage !== "validating") {
    return fail("Evidence review is available only after an explicit validation request.");
  }
  const briefs = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (
    briefs.length !== 1 ||
    briefs[0].projectId !== project.id ||
    briefs[0].successEvidence.trim().length === 0
  ) {
    return fail("Evidence review requires one exact same-Project Direction success criterion.");
  }
  if (project.activeBetId === undefined) return fail("Evidence review requires one active Bet.");
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
  const provenance = resolveValidationProvenance(
    workspace,
    project.id,
    now,
  );
  if (!provenance.ok) return fail(provenance.reason);
  const holds = selectActiveHolds(workspace, project.id, now);
  if (!holds.ok) return fail(holds.reason);
  const boundaryHold = exactCanonicalAppetiteBoundaryHold(
    project,
    bets[0],
    now,
  );
  const satisfyAvailability = selectUiCommandPolicyAvailability(
    workspace,
    { type: "satisfy_validation", projectId: project.id },
    now,
  );
  const abandonAvailability = selectUiCommandPolicyAvailability(
    workspace,
    {
      type: "abandon_project",
      projectId: project.id,
      decision: {
        id: `availability:abandon:${project.id}`,
        projectId: project.id,
        successComparison: "Availability check only.",
        outcome: "abandoned",
        keyLearning: "Availability check only.",
        unfinishedDisposition: "historical_incomplete",
      },
    },
    now,
  );
  const appetiteReached = Date.parse(now) >= Date.parse(bets[0].appetiteEnd);
  const transitionBlock: TransitionBlock | undefined = satisfyAvailability.available
    ? appetiteReached && boundaryHold === undefined
      ? {
          reason: "Record the exact Bet appetite boundary before completing validation.",
          permittedNextCommand: "record_bet_boundary",
        }
      : undefined
    : {
        reason: satisfyAvailability.reason,
        permittedNextCommand: satisfyAvailability.permittedNextCommand,
      };
  const requirementItems = workspace.workItems
    .filter((item) =>
      item.projectId === project.id &&
      isConcreteEvidenceRequirement(item)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(requirementItems.map(({ id }) => id)).size !== requirementItems.length) {
    return fail("Evidence review cannot resolve one exact record for every requirement.");
  }
  const requirements = requirementItems.map((workItem): EvidenceRequirementModel => {
    const status = requirementStatus(workspace, project.id, workItem.id, now);
    if (status.satisfied && status.via === "evidence") {
      const evidenceCount = workspace.evidence.filter((evidence) =>
        evidence.projectId === project.id &&
        evidence.workItemId === workItem.id &&
        isUsableEvidenceAt(evidence, now)
      ).length;
      return { workItem, status: { satisfied: true, via: "evidence", evidenceCount } };
    }
    if (status.satisfied && status.via === "exception") {
      const exceptions = workspace.exceptions.filter((record) =>
        record.id === status.exceptionId &&
        record.projectId === project.id &&
        record.requirementId === workItem.id &&
        isExceptionActive(record, now)
      );
      if (exceptions.length === 1) {
        return {
          workItem,
          status: { satisfied: true, via: "exception", exception: exceptions[0] },
        };
      }
    }
    return {
      workItem,
      status: {
        satisfied: false,
        code: status.satisfied ? "EVIDENCE_REQUIRED" : status.code,
        ...(!status.satisfied && status.code === "EXCEPTION_EXPIRED"
          ? { exceptionId: status.exceptionId }
          : {}),
      },
    };
  });
  return {
    ok: true,
    project,
    brief: briefs[0],
    bet: bets[0],
    requirements,
    canSatisfy:
      transitionBlock === undefined &&
      requirements.every(({ status }) => status.satisfied),
    ...(transitionBlock === undefined ? {} : { transitionBlock }),
    canAbandon: boundaryHold !== undefined && abandonAvailability.available,
    unfinished: unfinishedProjectWorkItems(workspace, project.id),
  };
}

const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "metric",
  "feedback",
  "note",
  "doc",
  "screenshot",
  "commit",
  "pr",
  "ci",
  "release",
  "email",
  "calendar",
  "minutes",
  "booking",
];

let evidenceIdSequence = 0;
function createEvidenceId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `evidence:${uuid}`;
  evidenceIdSequence += 1;
  return `evidence:${Date.now()}:${evidenceIdSequence}`;
}

interface EvidenceDraft {
  requirementId: string;
  kind: EvidenceKind | "";
  summary: string;
  confidence: string;
  url: string;
}

const EMPTY_EVIDENCE_DRAFT: EvidenceDraft = {
  requirementId: "",
  kind: "",
  summary: "",
  confidence: "",
  url: "",
};

function parsedConfidence(value: string): number | undefined {
  if (value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : undefined;
}

function EvidenceAttachmentForm({
  selection,
  readCurrentTime,
}: {
  selection: Extract<EvidenceStageSelection, { ok: true }>;
  readCurrentTime(): string;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<EvidenceDraft>(EMPTY_EVIDENCE_DRAFT);
  const buildCommand = useCallback((values: EvidenceDraft) => {
    const confidence = parsedConfidence(values.confidence);
    if (values.kind === "" || confidence === undefined) {
      throw new Error("Evidence form submitted without explicit required values.");
    }
    const url = values.url.trim();
    return {
      type: "attach_evidence" as const,
      evidence: {
        id: createEvidenceId(),
        kind: values.kind,
        summary: values.summary.trim(),
        ...(url.length === 0 ? {} : { url }),
        projectId: selection.project.id,
        workItemId: values.requirementId,
        createdAt: readCurrentTime(),
        confidence,
        tags: [],
      },
    };
  }, [readCurrentTime, selection.project.id]);
  const form = useCommandForm(buildCommand);
  const missing = selection.requirements.filter(({ status }) => !status.satisfied);
  if (missing.length === 0) return null;
  const complete =
    missing.some(({ workItem }) => workItem.id === draft.requirementId) &&
    draft.kind !== "" &&
    draft.summary.trim().length > 0 &&
    parsedConfidence(draft.confidence) !== undefined;
  const submit = async () => {
    if (!complete) return;
    const result = await form.submit(draft);
    if (result.ok) setDraft(EMPTY_EVIDENCE_DRAFT);
  };
  return (
    <section className="v2-evidence-form" aria-labelledby="evidence-form-title">
      <header>
        <p className="v2-eyebrow">Attach, then assess</p>
        <h3 id="evidence-form-title">Add concrete evidence</h3>
        <p>Every attachment is bound to one exact milestone. Nothing advances automatically.</p>
      </header>
      <fieldset className="v2-stage-form-grid" disabled={form.pending}>
        <label>
          Evidence requirement
          <select
            value={draft.requirementId}
            onChange={(event) => setDraft((current) => ({ ...current, requirementId: event.target.value }))}
          >
            <option value="">Choose a required milestone</option>
            {missing.map(({ workItem }) => (
              <option key={workItem.id} value={workItem.id}>{workItem.title}</option>
            ))}
          </select>
        </label>
        <label>
          Evidence kind
          <select
            value={draft.kind}
            onChange={(event) => setDraft((current) => ({
              ...current,
              kind: event.target.value as EvidenceKind | "",
            }))}
          >
            <option value="">Choose the source type</option>
            {EVIDENCE_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <label className="v2-stage-form-grid__wide">
          Evidence summary
          <textarea
            rows={4}
            value={draft.summary}
            onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
          />
        </label>
        <label>
          Confidence from 0 to 1
          <input
            type="number"
            min="0"
            max="1"
            step="any"
            inputMode="decimal"
            value={draft.confidence}
            onChange={(event) => setDraft((current) => ({ ...current, confidence: event.target.value }))}
          />
        </label>
        <label>
          Source URL (optional)
          <input
            type="url"
            value={draft.url}
            onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
          />
        </label>
      </fieldset>
      <p className="v2-form-hint">
        Confidence is stored exactly as entered; OmniPlan does not infer or round it.
      </p>
      <CommandRejectionCard
        result={form.result}
        resolveLabel="Open Review"
        onResolve={() => navigate("/review")}
      />
      <div className="v2-stage-form-actions">
        <button
          type="button"
          className="v2-button--primary"
          disabled={!complete || form.pending}
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending ? "Attaching…" : "Attach evidence"}
        </button>
      </div>
    </section>
  );
}

interface ExceptionFormDraft {
  requirementId: string;
  rationale: string;
  knownConsequence: string;
  reviewAt: string;
  expiresAt: string;
}

const EMPTY_EXCEPTION_DRAFT: ExceptionFormDraft = {
  requirementId: "",
  rationale: "",
  knownConsequence: "",
  reviewAt: "",
  expiresAt: "",
};

let exceptionIdSequence = 0;
function createExceptionId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `exception:${uuid}`;
  exceptionIdSequence += 1;
  return `exception:${Date.now()}:${exceptionIdSequence}`;
}

function canonicalTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function exceptionFromForm(
  selection: Extract<EvidenceStageSelection, { ok: true }>,
  draft: ExceptionFormDraft,
  now: string,
): ExceptionDraft | undefined {
  const requirement = selection.requirements.find(
    ({ workItem, status }) =>
      workItem.id === draft.requirementId && !status.satisfied,
  );
  const evaluatedAt = canonicalTimestamp(now);
  const reviewAt = canonicalTimestamp(draft.reviewAt);
  const expiresAt = canonicalTimestamp(draft.expiresAt);
  if (
    requirement === undefined ||
    draft.rationale.trim().length === 0 ||
    draft.knownConsequence.trim().length === 0 ||
    evaluatedAt === undefined ||
    reviewAt === undefined ||
    expiresAt === undefined ||
    evaluatedAt > reviewAt ||
    reviewAt >= expiresAt
  ) {
    return undefined;
  }
  return {
    id: createExceptionId(),
    projectId: selection.project.id,
    requirementId: requirement.workItem.id,
    rationale: draft.rationale.trim(),
    knownConsequence: draft.knownConsequence.trim(),
    reviewAt: draft.reviewAt,
    expiresAt: draft.expiresAt,
  };
}

function ExceptionApprovalDialog({
  exception,
  requirement,
  returnFocusRef,
  onClose,
  onApproved,
}: {
  exception: ExceptionDraft;
  requirement: ProjectWorkItem;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  onClose(): void;
  onApproved(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const navigate = useNavigate();
  const buildCommand = useCallback((value: ExceptionDraft) => ({
    type: "approve_evidence_exception" as const,
    exception: value,
  }), []);
  const form = useCommandForm(buildCommand);
  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };
  const submit = async () => {
    if (!acknowledged) return;
    const result = await form.submit(exception);
    if (!result.ok) return;
    onApproved();
  };
  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-stage-transition-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
      <p className="v2-eyebrow">Controlled exception · human approval</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Approve temporary evidence exception</h2>
      <p id={descriptionId}>
        This does not create Evidence. It temporarily lets this exact requirement
        pass until the recorded expiry, with the known consequence preserved.
      </p>
      <section className="v2-close-review" aria-label="Exception approval review">
        <div><span>Requirement</span><strong>{requirement.title}</strong><code>{requirement.id}</code></div>
        <div><span>Rationale</span><p>{exception.rationale}</p></div>
        <div><span>Known consequence</span><p>{exception.knownConsequence}</p></div>
        <div><span>Review at</span><code>{exception.reviewAt}</code></div>
        <div><span>Expires at</span><code>{exception.expiresAt}</code></div>
      </section>
      <label className="v2-stage-acknowledgement">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        I accept that this temporary exception is not proof and becomes invalid at expiry.
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
          {form.pending ? "Approving…" : "Approve controlled exception"}
        </button>
      </div>
    </ModalSurface>
  );
}

function ControlledExceptionForm({
  selection,
  readCurrentTime,
}: {
  selection: Extract<EvidenceStageSelection, { ok: true }>;
  readCurrentTime(): string;
}) {
  const missing = selection.requirements.filter(({ status }) => !status.satisfied);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<ExceptionFormDraft>(EMPTY_EXCEPTION_DRAFT);
  const [review, setReview] = useState<ExceptionDraft>();
  const [issue, setIssue] = useState<string>();
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  if (missing.length === 0) return null;
  const openReview = () => {
    const candidate = exceptionFromForm(selection, draft, readCurrentTime());
    if (candidate === undefined) {
      setIssue("Choose one missing requirement and enter a canonical review window with now ≤ review < expiry.");
      return;
    }
    setIssue(undefined);
    setReview(candidate);
  };
  const requirement = review === undefined
    ? undefined
    : missing.find(({ workItem }) => workItem.id === review.requirementId)?.workItem;
  return (
    <section className="v2-evidence-form" aria-labelledby="exception-form-title">
      <header>
        <p className="v2-eyebrow">Controlled exception</p>
        <h3 id="exception-form-title">Escalate a temporary evidence gap</h3>
        <p>Use only when the missing proof has an explicit consequence, review time, and hard expiry.</p>
      </header>
      {!expanded ? (
        <button
          type="button"
          className="v2-secondary-disclosure-button"
          onClick={() => setExpanded(true)}
        >
          Start controlled exception
        </button>
      ) : <>
        <div className="v2-stage-form-grid">
        <label>
          Missing requirement
          <select
            value={draft.requirementId}
            onChange={(event) => setDraft((current) => ({ ...current, requirementId: event.target.value }))}
          >
            <option value="">Choose a requirement</option>
            {missing.map(({ workItem }) => (
              <option key={workItem.id} value={workItem.id}>{workItem.title}</option>
            ))}
          </select>
        </label>
        <label>
          Review at (canonical ISO)
          <input
            type="text"
            value={draft.reviewAt}
            onChange={(event) => setDraft((current) => ({ ...current, reviewAt: event.target.value }))}
            placeholder="2026-07-16T04:00:00.000Z"
          />
        </label>
        <label className="v2-stage-form-grid__wide">
          Exception rationale
          <textarea
            rows={3}
            value={draft.rationale}
            onChange={(event) => setDraft((current) => ({ ...current, rationale: event.target.value }))}
          />
        </label>
        <label className="v2-stage-form-grid__wide">
          Known consequence
          <textarea
            rows={3}
            value={draft.knownConsequence}
            onChange={(event) => setDraft((current) => ({ ...current, knownConsequence: event.target.value }))}
          />
        </label>
        <label>
          Expires at (canonical ISO)
          <input
            type="text"
            value={draft.expiresAt}
            onChange={(event) => setDraft((current) => ({ ...current, expiresAt: event.target.value }))}
            placeholder="2026-07-17T03:00:00.000Z"
          />
        </label>
        </div>
        {issue === undefined ? null : <p className="v2-form-error" role="alert">{issue}</p>}
        <div className="v2-stage-form-actions">
          <button type="button" onClick={() => setExpanded(false)}>Cancel</button>
          <p>Approval opens a separate read-only confirmation. No exception is preselected.</p>
          <button
            ref={reviewTriggerRef}
            type="button"
            className="v2-button--primary"
            onClick={openReview}
          >
            Review controlled exception
          </button>
        </div>
      </>}
      {review === undefined || requirement === undefined ? null : (
        <ExceptionApprovalDialog
          exception={review}
          requirement={requirement}
          returnFocusRef={reviewTriggerRef}
          onClose={() => setReview(undefined)}
          onApproved={() => {
            setReview(undefined);
            setDraft(EMPTY_EXCEPTION_DRAFT);
          }}
        />
      )}
    </section>
  );
}

function ValidationCompletionDialog({
  selection,
  open,
  returnFocusRef,
  fallbackFocusRef,
  onClose,
}: {
  selection: Extract<EvidenceStageSelection, { ok: true }>;
  open: boolean;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  fallbackFocusRef: React.RefObject<HTMLHeadingElement>;
  onClose(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const buildCommand = useCallback(() => ({
    type: "satisfy_validation" as const,
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
    if (open && !selection.canSatisfy) closeAndRestoreFocus();
  }, [closeAndRestoreFocus, open, selection.canSatisfy]);
  if (!open) return null;
  const cancel = closeAndRestoreFocus;
  const submit = async () => {
    if (!selection.canSatisfy) return;
    const result = await form.submit(undefined);
    if (!result.ok) return;
    onClose();
    navigate(`/projects/${selection.project.id}/close`);
  };
  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-stage-transition-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
      <p className="v2-eyebrow">Independent human decision</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Confirm validation completion</h2>
      <p id={descriptionId}>
        All concrete requirements are currently satisfied. This confirmation opens
        Close; attaching the last Evidence did not perform this transition.
      </p>
      <div className="v2-confirmation-dialog__item">“{selection.brief.successEvidence}”</div>
      <p>{selection.requirements.length} requirement{selection.requirements.length === 1 ? "" : "s"} reviewed.</p>
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
          disabled={form.pending || !selection.canSatisfy}
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending ? "Completing…" : "Complete validation"}
        </button>
      </div>
    </ModalSurface>
  );
}

function EvidenceStageReady({
  selection,
  workspace,
  readCurrentTime,
}: {
  selection: Extract<EvidenceStageSelection, { ok: true }>;
  workspace: WorkspaceV2;
  readCurrentTime(): string;
}) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const satisfiedCount = selection.requirements.filter(({ status }) => status.satisfied).length;
  return (
    <section className="v2-guided-stage" aria-label="Evidence workspace">
      <header>
        <p className="v2-eyebrow">Prove the result</p>
        <h2 ref={stageHeadingRef} tabIndex={-1}>Evidence workspace</h2>
        <p>Evaluate each concrete milestone against the immutable Direction success criterion.</p>
      </header>
      <section className="v2-stage-criterion" aria-label="Direction success evidence">
        <span>Direction success evidence</span>
        <strong>{selection.brief.successEvidence}</strong>
        <p>{selection.brief.validationMethod}</p>
      </section>
      <section className="v2-stage-summary" aria-label="Evidence requirement status">
        <div className="v2-stage-summary__headline">
          <div><span>Satisfied</span><strong>{satisfiedCount} / {selection.requirements.length}</strong></div>
          <div>
            <span>Transition</span>
            <strong>
              {selection.canSatisfy
                ? "Ready for review"
                : selection.transitionBlock === undefined
                  ? "Blocked by evidence"
                  : "Blocked by Review"}
            </strong>
          </div>
        </div>
        {selection.requirements.length === 0 ? (
          <p>No Work Item declared a concrete evidence requirement. Close still requires an explicit comparison to Direction.</p>
        ) : (
          <ul className="v2-stage-record-list">
            {selection.requirements.map(({ workItem, status }) => (
              <li key={workItem.id} data-status={status.satisfied ? "satisfied" : "missing"}>
                <div>
                  <strong>{workItem.title}</strong>
                  <span>
                    {!status.satisfied
                      ? "Missing evidence"
                      : status.via === "evidence"
                        ? "Satisfied by evidence"
                        : "Covered by controlled exception"}
                  </span>
                </div>
                <p>{workItem.outline}</p>
                {status.satisfied && status.via === "evidence"
                  ? <small>{status.evidenceCount} usable attachment{status.evidenceCount === 1 ? "" : "s"}</small>
                  : status.satisfied && status.via === "exception"
                    ? <small>Exception {status.exception.id} expires {status.exception.expiresAt}</small>
                    : <small>
                        {status.code === "EXCEPTION_EXPIRED"
                          ? `Exception ${status.exceptionId ?? "unknown"} expired. Attach Evidence or approve a new controlled exception.`
                          : "Attach exact same-milestone Evidence or approve a controlled exception before validation can complete."}
                      </small>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <EvidenceAttachmentForm selection={selection} readCurrentTime={readCurrentTime} />
      <ControlledExceptionForm selection={selection} readCurrentTime={readCurrentTime} />
      {selection.canAbandon ? (
        <BoundaryAbandonment
          workspace={workspace}
          project={selection.project}
          brief={selection.brief}
          unfinished={selection.unfinished}
          readCurrentTime={readCurrentTime}
        />
      ) : null}
      <aside className="v2-stage-next-action" aria-label="Evidence next action">
        <div>
          <p className="v2-eyebrow">Explicit stage boundary</p>
          <h3>
            {selection.canSatisfy
              ? "Review validation completion"
              : selection.transitionBlock === undefined
                ? "Resolve every missing requirement"
                : selection.transitionBlock.reason}
          </h3>
          <p>
            {selection.transitionBlock === undefined
              ? "Evidence attachment never moves the Project by itself."
              : <>Required next command: <code>{selection.transitionBlock.permittedNextCommand}</code>.</>}
          </p>
        </div>
        <button
          ref={reviewTriggerRef}
          type="button"
          className="v2-button--primary"
          disabled={!selection.canSatisfy}
          onClick={() => setReviewOpen(true)}
        >
          Review validation completion
        </button>
      </aside>
      <ValidationCompletionDialog
        selection={selection}
        open={reviewOpen}
        returnFocusRef={reviewTriggerRef}
        fallbackFocusRef={stageHeadingRef}
        onClose={() => setReviewOpen(false)}
      />
    </section>
  );
}

export function EvidenceStage({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const now = state.readCurrentTime();
  const selection = selectEvidenceStage(state.workspace, projectId, now);
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <p className="v2-eyebrow">Fail closed</p>
        <h2>Evidence unavailable</h2>
        <p>{selection.reason}</p>
        <p>No validation transition is inferred from incomplete or ambiguous evidence.</p>
      </section>
    );
  }
  return (
    <EvidenceStageReady
      selection={selection}
      workspace={state.workspace}
      readCurrentTime={state.readCurrentTime}
    />
  );
}
