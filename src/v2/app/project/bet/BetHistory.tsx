import { useId } from "react";

import { selectProjectLifecycle } from "../../../domain/selectors";
import type {
  BetVersion,
  ProjectV2,
  WorkspaceV2,
} from "../../../domain/types";
import { useV2Workspace } from "../../state/V2WorkspaceProvider";

type BetHistorySelection =
  | { ok: true; project: ProjectV2; bets: BetVersion[] }
  | { ok: false; reason: string };

function compareBetHistory(left: BetVersion, right: BetVersion): number {
  return (
    left.version - right.version ||
    left.approvedAt.localeCompare(right.approvedAt) ||
    left.id.localeCompare(right.id)
  );
}

export function selectBetHistory(
  workspace: WorkspaceV2,
  projectId: string,
): BetHistorySelection {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length !== 1) {
    return {
      ok: false,
      reason: projects.length === 0
        ? "The Project record is missing."
        : "The Project identity has conflicting records.",
    };
  }
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return { ok: false, reason: lifecycle.reason };

  const bets = workspace.bets.filter(({ projectId: ownerId }) => ownerId === projectId);
  const malformed = bets.find(
    (bet) =>
      bet.briefSnapshot.projectId !== projectId ||
      bet.briefId !== bet.briefSnapshot.id ||
      !Number.isSafeInteger(bet.version) ||
      bet.version <= 0,
  );
  if (malformed !== undefined) {
    return {
      ok: false,
      reason: `Bet ${malformed.id} has conflicting Project or Direction ownership.`,
    };
  }
  return {
    ok: true,
    project: projects[0],
    bets: [...bets].sort(compareBetHistory),
  };
}

function replacementRequired(project: ProjectV2, bet: BetVersion): boolean {
  return (
    project.activeBetId === bet.id &&
    project.holds.some(
      ({ type, sourceId }) => type === "rebet_required" && sourceId === bet.id,
    )
  );
}

function betStatus(project: ProjectV2, bet: BetVersion): string {
  if (replacementRequired(project, bet)) {
    return bet.invalidatedAt === undefined
      ? "Expired — replacement required"
      : "Invalidated — replacement required";
  }
  if (project.activeBetId === bet.id && bet.invalidatedAt === undefined) {
    return "Current";
  }
  if (bet.invalidatedAt !== undefined) return "Invalidated";
  return "Historical";
}

function BetHistoryEntry({
  project,
  bet,
}: {
  project: ProjectV2;
  bet: BetVersion;
}) {
  const titleId = useId();
  return (
    <article className="v2-bet-history-entry" aria-labelledby={titleId}>
      <header>
        <div>
          <p className="v2-eyebrow">{betStatus(project, bet)}</p>
          <h3 id={titleId}>Bet v{bet.version}</h3>
        </div>
        <code>{bet.id}</code>
      </header>

      <dl className="v2-bet-history-facts">
        <div>
          <dt>Human actor</dt>
          <dd>{bet.actorId}</dd>
        </div>
        <div>
          <dt>Approved</dt>
          <dd><time dateTime={bet.approvedAt}>{bet.approvedAt}</time></dd>
        </div>
        <div>
          <dt>Appetite start</dt>
          <dd><time dateTime={bet.appetiteStart}>{bet.appetiteStart}</time></dd>
        </div>
        <div>
          <dt>Appetite end</dt>
          <dd><time dateTime={bet.appetiteEnd}>{bet.appetiteEnd}</time></dd>
        </div>
        <div>
          <dt>Supersedes</dt>
          <dd>{bet.supersedesId ?? "First Bet"}</dd>
        </div>
        <div>
          <dt>Source Review</dt>
          <dd>{bet.sourceReviewId ?? (bet.supersedesId === undefined ? "First Bet" : "Direction change")}</dd>
        </div>
      </dl>

      <section aria-label={`Bet v${bet.version} committed scope`}>
        <h4>Committed scope</h4>
        <ul>
          {bet.committedScope.map((scope) => (
            <li key={scope.id}>
              <strong>{scope.title}</strong>
              <span>{scope.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <p>
        <strong>Stored Direction snapshot:</strong>{" "}
        {bet.briefSnapshot.audienceAndProblem}
      </p>
      {bet.invalidatedAt === undefined ? null : (
        <p>
          <strong>Invalidated:</strong>{" "}
          <time dateTime={bet.invalidatedAt}>{bet.invalidatedAt}</time>
          {bet.invalidationReason === undefined ? null : ` — ${bet.invalidationReason}`}
        </p>
      )}

      <details>
        <summary>Inspect full immutable Direction snapshot</summary>
        <dl>
          <div><dt>Direction hash</dt><dd><code>{bet.briefHash}</code></dd></div>
          <div><dt>Audience and problem</dt><dd>{bet.briefSnapshot.audienceAndProblem}</dd></div>
          <div><dt>Success evidence</dt><dd>{bet.briefSnapshot.successEvidence}</dd></div>
          <div><dt>Appetite seconds</dt><dd>{bet.briefSnapshot.appetiteSeconds}</dd></div>
          <div><dt>Validation method</dt><dd>{bet.briefSnapshot.validationMethod}</dd></div>
          <div><dt>No-go or kill</dt><dd>{bet.briefSnapshot.noGoOrKill}</dd></div>
          <div><dt>Advanced notes</dt><dd>{bet.briefSnapshot.advancedNotes || "None"}</dd></div>
        </dl>
      </details>
    </article>
  );
}

export function BetHistory({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const selection = selectBetHistory(state.workspace, projectId);
  if (!selection.ok) {
    return (
      <section className="v2-inline-validation" role="alert">
        <h2>Bet history unavailable</h2>
        <p>{selection.reason}</p>
        <p>Resolve the conflicting ownership before trusting this history.</p>
      </section>
    );
  }
  return (
    <section
      className="v2-bet-history"
      aria-label="Bet immutable history"
      data-readonly="true"
    >
      <header>
        <p className="v2-eyebrow">Immutable human decisions</p>
        <h2>Bet history</h2>
        <p>Every entry reads its stored Direction snapshot; later edits never rewrite it.</p>
      </header>
      {selection.bets.length === 0 ? (
        <p>No Bet has been placed.</p>
      ) : (
        <div className="v2-bet-history-list">
          {selection.bets.map((bet) => (
            <BetHistoryEntry key={bet.id} project={selection.project} bet={bet} />
          ))}
        </div>
      )}
    </section>
  );
}
