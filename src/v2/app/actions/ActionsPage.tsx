import {
  createRef,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useNavigate } from "react-router-dom";

import type { Action, ActionEligibilityFacts } from "../../domain/types";
import { EmptyState } from "../components/EmptyState";
import { useOperationalV2Workspace } from "../state/V2WorkspaceProvider";
import { ActionEditorSheet } from "./ActionEditorSheet";
import { ActionOutcomeForm } from "./ActionOutcomeForm";
import { PromoteActionDialog } from "./PromoteActionDialog";

interface ActionControlRefs {
  edit: RefObject<HTMLButtonElement>;
  complete: RefObject<HTMLButtonElement>;
}

interface PromotionState {
  action: Action;
  failedEligibility: ActionEligibilityFacts;
}

export function ActionsPage() {
  const state = useOperationalV2Workspace();
  const navigate = useNavigate();
  const [editorActionId, setEditorActionId] = useState<string>();
  const [outcomeActionId, setOutcomeActionId] = useState<string>();
  const [promotion, setPromotion] = useState<PromotionState>();
  const [pendingFocusActionId, setPendingFocusActionId] = useState<string>();
  const headingRefs = useRef(new Map<string, HTMLElement>());
  const controlRefs = useRef(new Map<string, ActionControlRefs>());

  const refsFor = (actionId: string): ActionControlRefs => {
    const current = controlRefs.current.get(actionId);
    if (current !== undefined) return current;
    const created = {
      edit: createRef<HTMLButtonElement>(),
      complete: createRef<HTMLButtonElement>(),
    };
    controlRefs.current.set(actionId, created);
    return created;
  };

  useEffect(() => {
    if (pendingFocusActionId === undefined) return;
    const target = headingRefs.current.get(pendingFocusActionId);
    if (target === undefined) return;
    target.focus();
    setPendingFocusActionId(undefined);
  }, [pendingFocusActionId, state.workspace.revision]);

  const openActions = state.workspace.actions.filter(
    ({ status }) => status === "open",
  );
  const historicalActions = state.workspace.actions.filter(
    ({ status }) => status !== "open",
  );
  const editorAction = state.workspace.actions.find(
    ({ id }) => id === editorActionId,
  );
  const outcomeAction = state.workspace.actions.find(
    ({ id }) => id === outcomeActionId,
  );
  const timeZone = state.workspace.capacityProfile?.timeZone ?? "UTC";

  const renderAction = (action: Action) => {
    const refs = refsFor(action.id);
    const actualSeconds = state.workspace.actuals
      .filter(
        ({ target }) =>
          target.kind === "action" && target.actionId === action.id,
      )
      .reduce((total, actual) => total + actual.actualWorkSeconds, 0);
    return (
      <article
        className="v2-action-card"
        aria-label={`Action: ${action.title}`}
        data-status={action.status}
        key={action.id}
      >
        <header className="v2-action-card__header">
          <div>
            <p className="v2-eyebrow">
              {action.status === "open"
                ? `${action.attention} attention`
                : action.status}
            </p>
            <h3
              ref={(node) => {
                if (node === null) headingRefs.current.delete(action.id);
                else headingRefs.current.set(action.id, node);
              }}
              tabIndex={-1}
            >
              {action.title}
            </h3>
          </div>
          <span className="v2-action-card__status">{action.status}</span>
        </header>

        <dl className="v2-action-facts">
          <div>
            <dt>Estimate</dt>
            <dd>{action.eligibility.estimateSeconds / 60} min</dd>
          </div>
          <div>
            <dt>Actual</dt>
            <dd>{actualSeconds / 60} min</dd>
          </div>
          <div>
            <dt>Desired</dt>
            <dd>{action.desiredDate ?? "Not set"}</dd>
          </div>
        </dl>

        {action.outcomeNote === undefined ? null : (
          <p className="v2-action-outcome">
            <strong>{action.resultStatus}</strong> · {action.outcomeNote}
          </p>
        )}
        {action.promotedProjectId === undefined ? null : (
          <p className="v2-action-outcome">
            Promoted to Project <code>{action.promotedProjectId}</code>
          </p>
        )}

        {action.status !== "open" ? null : (
          <div className="v2-action-card__controls">
            <button
              ref={refs.edit}
              type="button"
              aria-label={`Edit ${action.title}`}
              onClick={() => setEditorActionId(action.id)}
            >
              Edit
            </button>
            <button
              ref={refs.complete}
              className="v2-button--primary"
              type="button"
              aria-label={`Complete ${action.title}`}
              onClick={() => setOutcomeActionId(action.id)}
            >
              Complete
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <article
      className="v2-route-page v2-actions-page"
      aria-labelledby="v2-actions-title"
    >
      <header className="v2-page-heading">
        <p className="v2-eyebrow">Inbox utility · not a fifth destination</p>
        <h1 id="v2-actions-title">Actions</h1>
        <p className="v2-page-summary">
          Keep only small, certain, single-session work here. When a boundary
          fails, OmniPlan requires an explicit Project promotion.
        </p>
      </header>

      <section className="v2-actions-section" aria-labelledby="open-actions-title">
        <header className="v2-actions-section__header">
          <h2 id="open-actions-title">Open Actions</h2>
          <p>{openActions.length} ready for an explicit next decision</p>
        </header>
        {openActions.length === 0 ? (
          <EmptyState
            title="No open Actions"
            description="Classify a lightweight item from Inbox, or keep Project-shaped work in Projects."
          />
        ) : (
          <div className="v2-action-list">{openActions.map(renderAction)}</div>
        )}
      </section>

      {historicalActions.length === 0 ? null : (
        <section
          className="v2-actions-section"
          aria-labelledby="action-history-title"
        >
          <header className="v2-actions-section__header">
            <h2 id="action-history-title">Action history</h2>
            <p>Completed and promoted records remain auditable.</p>
          </header>
          <div className="v2-action-list">
            {historicalActions.map(renderAction)}
          </div>
        </section>
      )}

      {editorAction === undefined ? null : (
        <ActionEditorSheet
          action={editorAction}
          timeZone={timeZone}
          returnFocusRef={refsFor(editorAction.id).edit}
          onClose={() => setEditorActionId(undefined)}
          onSaved={(actionId) => setPendingFocusActionId(actionId)}
          onPromotionRequired={(action, failedEligibility) => {
            setEditorActionId(undefined);
            setPromotion({ action, failedEligibility });
          }}
        />
      )}

      {outcomeAction === undefined ? null : (
        <ActionOutcomeForm
          action={outcomeAction}
          returnFocusRef={refsFor(outcomeAction.id).complete}
          onClose={() => setOutcomeActionId(undefined)}
          onCompleted={(actionId) => setPendingFocusActionId(actionId)}
        />
      )}

      {promotion === undefined ? null : (
        <PromoteActionDialog
          action={promotion.action}
          failedEligibility={promotion.failedEligibility}
          returnFocusRef={refsFor(promotion.action.id).edit}
          onClose={() => setPromotion(undefined)}
          onPromoted={(projectId) =>
            navigate(`/projects/${projectId}/direction`)
          }
        />
      )}
    </article>
  );
}
