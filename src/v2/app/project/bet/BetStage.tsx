import { useCallback, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { isDirectionComplete } from "../../../domain/direction";
import {
  betIntegrityIssue,
  directionSnapshotIntegrityIssue,
  selectCompletedExpiryRebetReview,
} from "../../../domain/betIntegrity";
import {
  selectActiveHolds,
  selectProjectLifecycle,
} from "../../../domain/selectors";
import type {
  BetVersion,
  DirectionBrief,
  ProjectV2,
  WorkspaceV2,
} from "../../../domain/types";
import { CommandRejectionCard } from "../../components/CommandRejectionCard";
import { ModalSurface } from "../../components/ModalSurface";
import { useCommandForm } from "../../state/useCommandForm";
import { useV2Workspace } from "../../state/V2WorkspaceProvider";
import { BetHistory, selectBetHistory } from "./BetHistory";

type BetStageSelection =
  | {
      ok: true;
      mode: "first" | "replacement";
      project: ProjectV2;
      brief: DirectionBrief;
      migrationReview: boolean;
      replacedBet?: BetVersion;
    }
  | { ok: false; reason: string };

function fail(reason: string): BetStageSelection {
  return { ok: false, reason };
}

export function selectBetStage(
  workspace: WorkspaceV2,
  projectId: string,
  now: string,
): BetStageSelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return fail(projects.length === 0
      ? "The Project record is missing."
      : "The Project identity has conflicting records.");
  }
  const project = projects[0];
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return fail(lifecycle.reason);
  const holds = selectActiveHolds(workspace, projectId, now);
  if (!holds.ok) return fail(holds.reason);

  const briefs = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (briefs.length !== 1 || briefs[0].projectId !== projectId) {
    return fail("The active Direction has missing, conflicting, or cross-Project records.");
  }
  const brief = briefs[0];
  if (!isDirectionComplete(brief)) {
    return fail("All six Direction decisions must be complete before a human Bet.");
  }
  const directionIssue = directionSnapshotIntegrityIssue(brief, now);
  if (directionIssue !== undefined) return fail(directionIssue);

  const rebetHolds = holds.holds.filter(({ type }) => type === "rebet_required");
  if (project.stage === "awaiting_bet") {
    const migrationReviews = holds.holds.filter(
      ({ type }) => type === "migration_review",
    );
    const holdsPermitFirstBet =
      holds.holds.length === 0 ||
      (holds.holds.length === 1 && migrationReviews.length === 1);
    if (
      migrationReviews.length === 1 &&
      (!migrationReviews[0].affectedRecordIds.includes(project.id) ||
        !migrationReviews[0].affectedRecordIds.includes(
          project.activeDirectionBriefId,
        ))
    ) {
      return fail("The migration review hold omits mandatory affected records for this Project and Direction.");
    }
    if (
      project.activeBetId !== undefined ||
      workspace.bets.some(({ projectId: ownerId }) => ownerId === projectId) ||
      !holdsPermitFirstBet
    ) {
      return fail("A first Bet cannot be placed while Bet history or a Project hold is ambiguous.");
    }
    return {
      ok: true,
      mode: "first",
      project,
      brief,
      migrationReview: migrationReviews.length === 1,
    };
  }

  if (
    project.stage !== "planning" &&
    project.stage !== "executing" &&
    project.stage !== "validating"
  ) {
    return fail(`A Bet cannot be replaced from the ${project.stage} stage.`);
  }
  if (
    holds.holds.length !== 1 ||
    rebetHolds.length !== 1 ||
    project.activeBetId === undefined ||
    rebetHolds[0].sourceId !== project.activeBetId
  ) {
    return fail("A unique active Re-bet hold is required before replacing a Bet.");
  }
  if (
    !rebetHolds[0].affectedRecordIds.includes(project.id) ||
    !rebetHolds[0].affectedRecordIds.includes(project.activeBetId)
  ) {
    return fail("The Re-bet hold omits mandatory affected records for this Project and active Bet.");
  }
  const activeBets = workspace.bets.filter(({ id }) => id === project.activeBetId);
  if (activeBets.length !== 1 || activeBets[0].projectId !== projectId) {
    return fail("The active Bet has missing, conflicting, or cross-Project ownership.");
  }
  const integrityIssue = betIntegrityIssue(activeBets[0], now);
  if (integrityIssue !== undefined) return fail(integrityIssue);
  if (activeBets[0].invalidatedAt === undefined) {
    const reviewSelection = selectCompletedExpiryRebetReview(
      workspace,
      project,
      activeBets[0],
      now,
    );
    if (!reviewSelection.ok) return fail(reviewSelection.reason);
  }
  const history = selectBetHistory(workspace, projectId);
  if (!history.ok) return fail(history.reason);
  return {
    ok: true,
    mode: "replacement",
    project,
    brief,
    migrationReview: false,
    replacedBet: activeBets[0],
  };
}

let betIdSequence = 0;

function createBetId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `bet:${uuid}`;
  betIdSequence += 1;
  return `bet:${Date.now()}:${betIdSequence}`;
}

export function formatExactDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "Invalid appetite";
  if (!Number.isInteger(totalSeconds)) return `${String(totalSeconds)} seconds`;
  let remaining = totalSeconds;
  const parts: string[] = [];
  for (const [label, unit] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const) {
    const amount = Math.floor(remaining / unit);
    if (amount > 0) {
      parts.push(`${amount} ${label}${amount === 1 ? "" : "s"}`);
      remaining -= amount * unit;
    }
  }
  if (remaining > 0) {
    parts.push(`${remaining} second${remaining === 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

function DirectionBoundary({ brief }: { brief: DirectionBrief }) {
  return (
    <div className="v2-bet-direction-boundary">
      <dl>
        <div><dt>Audience and problem</dt><dd>{brief.audienceAndProblem}</dd></div>
        <div><dt>Success evidence</dt><dd>{brief.successEvidence}</dd></div>
        <div><dt>Exact appetite</dt><dd>{formatExactDuration(brief.appetiteSeconds)}</dd></div>
        <div><dt>Validation method</dt><dd>{brief.validationMethod}</dd></div>
        <div><dt>No-go or kill</dt><dd>{brief.noGoOrKill}</dd></div>
      </dl>
      <section aria-label="Committed scope review">
        <h3>Committed scope</h3>
        <ul>
          {brief.firstScope.map((scope) => (
            <li key={scope.id}>
              <strong>{scope.title}</strong>
              <span>{scope.description}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function BetConfirmationDialog({
  selection,
  open,
  returnFocusRef,
  onClose,
}: {
  selection: Extract<BetStageSelection, { ok: true }>;
  open: boolean;
  returnFocusRef: React.RefObject<HTMLButtonElement>;
  onClose(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const buildCommand = useCallback(
    (betId: string) => ({
      type: "place_bet" as const,
      projectId: selection.project.id,
      betId,
      // V2WorkspaceProvider replaces this transport placeholder with one
      // authoritative timestamp used by both command and context.
      start: "1970-01-01T00:00:00.000Z",
    }),
    [selection.project.id],
  );
  const form = useCommandForm(buildCommand);

  if (!open) return null;
  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };
  const submit = async () => {
    const result = await form.submit(createBetId());
    if (result.ok) {
      onClose();
      navigate(`/projects/${selection.project.id}/plan`);
    }
  };
  const replacement = selection.mode === "replacement";
  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-bet-confirmation-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
      <p className="v2-eyebrow">Human decision required</p>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>Confirm human {replacement ? "Re-bet" : "Bet"}</h2>
      <p id={descriptionId}>
        You are committing this Direction snapshot, scope, and exact appetite.
        Appetite cannot be extended; changing it requires another immutable Re-bet.
      </p>
      <DirectionBoundary brief={selection.brief} />
      {form.pending ? (
        <p className="v2-sr-only" role="status" aria-live="polite">
          Placing {replacement ? "Re-bet" : "Bet"}…
        </p>
      ) : null}
      <CommandRejectionCard
        result={form.result}
        resolveLabel="Return to Projects"
        onResolve={() => {
          onClose();
          navigate("/projects");
        }}
      />
      <div className="v2-dialog-actions">
        <button type="button" onClick={cancel} disabled={form.pending}>Cancel</button>
        <button
          className="v2-button--primary"
          type="button"
          disabled={form.pending}
          aria-busy={form.pending ? "true" : undefined}
          onClick={() => { void submit(); }}
        >
          {form.pending
            ? `Placing ${replacement ? "Re-bet" : "Bet"}…`
            : `Place human ${replacement ? "Re-bet" : "Bet"}`}
        </button>
      </div>
    </ModalSurface>
  );
}

export function BetStage({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  const [reviewOpen, setReviewOpen] = useState(false);
  const reviewTriggerRef = useRef<HTMLButtonElement>(null);
  if (state.status !== "ready") return null;
  const selection = selectBetStage(
    state.workspace,
    projectId,
    state.readCurrentTime(),
  );
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <p className="v2-eyebrow">Fail closed</p>
        <h2>Bet unavailable</h2>
        <p>{selection.reason}</p>
        <p>This Bet cannot be changed safely until record ownership is unambiguous.</p>
      </section>
    );
  }
  const replacement = selection.mode === "replacement";
  return (
    <section
      className="v2-bet-stage"
      aria-label={replacement ? "Re-bet decision" : "Bet decision"}
    >
      <header>
        <p className="v2-eyebrow">{replacement ? "Replacement boundary" : "Commit the boundary"}</p>
        <h2>{replacement ? "Re-bet the revised Direction" : "Place the human Bet"}</h2>
        <p>
          {replacement
            ? "Appetite cannot be extended. A replacement creates a new immutable Bet version."
            : "Review the six Direction decisions. Only a human confirmation can move this Project into Plan."}
        </p>
        {selection.migrationReview ? (
          <p>
            This explicit Bet is also the required human review of the migrated Direction;
            no legacy Bet is treated as current.
          </p>
        ) : null}
      </header>
      {replacement ? <BetHistory projectId={projectId} /> : null}
      <section aria-label="Direction proposed for Bet">
        <h3>Direction snapshot proposed for commitment</h3>
        <DirectionBoundary brief={selection.brief} />
      </section>
      <button
        ref={reviewTriggerRef}
        className="v2-button--primary"
        type="button"
        onClick={() => setReviewOpen(true)}
      >
        Review {replacement ? "Re-bet" : "Bet"}
      </button>
      <BetConfirmationDialog
        selection={selection}
        open={reviewOpen}
        returnFocusRef={reviewTriggerRef}
        onClose={() => setReviewOpen(false)}
      />
    </section>
  );
}
