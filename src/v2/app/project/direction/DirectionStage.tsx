import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useNavigate } from "react-router-dom";

import type {
  CommandResult,
  DirectionBriefDraft,
  V2Command,
} from "../../../domain/commands";
import {
  directionCompleteness,
  isDirectionComplete,
  isMaterialDirectionChange,
} from "../../../domain/direction";
import { selectProjectLifecycle } from "../../../domain/selectors";
import type {
  BetScope,
  DirectionBrief,
  ProjectV2,
  WorkspaceV2,
} from "../../../domain/types";
import { CommandRejectionCard } from "../../components/CommandRejectionCard";
import { ModalSurface } from "../../components/ModalSurface";
import { useV2Workspace } from "../../state/V2WorkspaceProvider";
import {
  DIRECTION_DECISIONS,
  DirectionDecisionStepper,
  firstIncompleteDecision,
  type DirectionDecisionKey,
} from "./DirectionDecisionStepper";
import "./direction.css";

const ACTIVE_BET_EDIT_STAGES = new Set([
  "planning",
  "executing",
  "validating",
] as const);

const materialFields = [
  { key: "audienceAndProblem", label: "Audience and problem" },
  { key: "successEvidence", label: "Success evidence" },
  { key: "appetiteSeconds", label: "Appetite" },
  { key: "validationMethod", label: "Validation method" },
  { key: "firstScope", label: "First scope" },
  { key: "noGoOrKill", label: "No-go or kill criteria" },
] as const satisfies readonly {
  key: keyof DirectionBrief;
  label: string;
}[];

let fallbackScopeSequence = 0;

function createScopeId(projectId: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${projectId}:scope:${uuid}`;
  fallbackScopeSequence += 1;
  return `${projectId}:scope:${Date.now()}:${fallbackScopeSequence}`;
}

function toDraft(brief: DirectionBrief): DirectionBriefDraft {
  return {
    id: brief.id,
    projectId: brief.projectId,
    audienceAndProblem: brief.audienceAndProblem,
    successEvidence: brief.successEvidence,
    appetiteSeconds: brief.appetiteSeconds,
    validationMethod: brief.validationMethod,
    firstScope: structuredClone(brief.firstScope),
    noGoOrKill: brief.noGoOrKill,
    advancedNotes: brief.advancedNotes,
  };
}

function normalizeDraft(draft: DirectionBriefDraft): DirectionBriefDraft {
  return {
    ...draft,
    audienceAndProblem: draft.audienceAndProblem.trim(),
    successEvidence: draft.successEvidence.trim(),
    validationMethod: draft.validationMethod.trim(),
    firstScope: draft.firstScope.map((scope) => ({
      id: scope.id,
      title: scope.title.trim(),
      description: scope.description.trim(),
    })),
    noGoOrKill: draft.noGoOrKill.trim(),
    advancedNotes: draft.advancedNotes.trim(),
  };
}

function appetiteMinutes(seconds: number): string {
  return seconds > 0 ? String(seconds / 60) : "";
}

function parseAppetiteSeconds(raw: string): number | undefined {
  if (raw.trim().length === 0) return undefined;
  const minutes = Number(raw);
  const seconds = minutes * 60;
  return Number.isFinite(minutes) &&
      minutes > 0 &&
      Number.isSafeInteger(seconds) &&
      seconds > 0
    ? seconds
    : undefined;
}

function sameDraft(left: DirectionBriefDraft, right: DirectionBriefDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function presentationValue(
  key: (typeof materialFields)[number]["key"],
  brief: DirectionBrief | DirectionBriefDraft,
): string {
  if (key === "appetiteSeconds") {
    const seconds = brief.appetiteSeconds;
    return `${seconds} seconds (${seconds / 60} minutes)`;
  }
  if (key === "firstScope") {
    return brief.firstScope.length === 0
      ? "No scope"
      : brief.firstScope
          .map((scope) => `${scope.title}: ${scope.description}`)
          .join(" · ");
  }
  return String(brief[key]);
}

interface MaterialChange {
  key: string;
  label: string;
  before: string;
  after: string;
}

function materialChanges(
  before: DirectionBrief,
  after: DirectionBriefDraft,
): MaterialChange[] {
  return materialFields.flatMap(({ key, label }) => {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) return [];
    return [{
      key,
      label,
      before: presentationValue(key, before),
      after: presentationValue(key, after),
    }];
  });
}

function unavailableReason(workspace: WorkspaceV2, projectId: string): string | undefined {
  const projects = workspace.projects.filter(({ id }) => id === projectId);
  if (projects.length === 0) return `Project ${projectId} does not exist.`;
  if (projects.length > 1) {
    return `Project ${projectId} has duplicate records for one identity.`;
  }
  const lifecycle = selectProjectLifecycle(workspace, projectId);
  if (!lifecycle.ok) return lifecycle.reason;
  const project = projects[0];
  const briefs = workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  );
  if (briefs.length !== 1 || briefs[0].projectId !== project.id) {
    return `Project ${project.id} does not resolve to exactly one same-project active Direction brief.`;
  }
  const brief = briefs[0];
  const beforeBet = project.stage === "direction" || project.stage === "awaiting_bet";
  const projectBetHistory = workspace.bets.filter(
    ({ projectId: ownerId }) => ownerId === project.id,
  );
  if (
    beforeBet &&
    (project.activeBetId !== undefined || projectBetHistory.length > 0)
  ) {
    return "A Project before Bet cannot retain active Bet state or Bet history.";
  }
  const directionComplete = isDirectionComplete(brief);
  if (project.stage === "direction" && directionComplete) {
    return "A complete Direction must advance to awaiting Bet before it can be revised.";
  }
  if (project.stage === "awaiting_bet" && !directionComplete) {
    return "A Project awaiting Bet must retain all six complete Direction decisions.";
  }
  return undefined;
}

function DirectionUnavailable({ reason }: { reason: string }) {
  return (
    <section className="v2-direction-unavailable" role="alert">
      <p className="v2-eyebrow">Direction unavailable</p>
      <h2>Direction unavailable</h2>
      <p>{reason}</p>
      <p>No Direction editor is shown until this record identity is repaired.</p>
    </section>
  );
}

function ReadOnlyDirection({ brief }: { brief: DirectionBrief }) {
  return (
    <section className="v2-direction-readonly" aria-label="Direction immutable history">
      <p className="v2-eyebrow">Immutable lifecycle history</p>
      <h2>Direction history</h2>
      <dl>
        <div><dt>Audience and problem</dt><dd>{brief.audienceAndProblem}</dd></div>
        <div><dt>Success evidence</dt><dd>{brief.successEvidence}</dd></div>
        <div>
          <dt>Appetite</dt>
          <dd>
            {brief.appetiteSeconds.toLocaleString("en-US")} seconds ({brief.appetiteSeconds / 60} minutes)
          </dd>
        </div>
        <div><dt>Validation method</dt><dd>{brief.validationMethod}</dd></div>
        <div>
          <dt>First scope</dt>
          <dd>
            {brief.firstScope.length === 0 ? "None" : (
              <ol>
                {brief.firstScope.map((scope) => (
                  <li key={scope.id}>
                    <strong>{scope.title}</strong>
                    <p>{scope.description}</p>
                  </li>
                ))}
              </ol>
            )}
          </dd>
        </div>
        <div><dt>No-go or kill criteria</dt><dd>{brief.noGoOrKill}</dd></div>
        <div><dt>Advanced notes</dt><dd>{brief.advancedNotes || "None"}</dd></div>
      </dl>
    </section>
  );
}

interface PendingMaterialConfirmation {
  draft: DirectionBriefDraft;
  changes: MaterialChange[];
  returnFocus: HTMLElement | null;
}

interface DirectionEditorProps {
  workspace: WorkspaceV2;
  project: ProjectV2;
  brief: DirectionBrief;
  dispatch(command: V2Command): Promise<CommandResult>;
}

function DirectionEditor({ workspace, project, brief, dispatch }: DirectionEditorProps) {
  const navigate = useNavigate();
  const initialDraft = useMemo(() => toDraft(brief), []);
  const [draft, setDraft] = useState<DirectionBriefDraft>(initialDraft);
  const [appetiteRaw, setAppetiteRaw] = useState(appetiteMinutes(initialDraft.appetiteSeconds));
  const [appetiteTouched, setAppetiteTouched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(firstIncompleteDecision(initialDraft));
  const [projectName, setProjectName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [checkingMaterial, setCheckingMaterial] = useState(false);
  const [lastResult, setLastResult] = useState<CommandResult>();
  const [confirmation, setConfirmation] = useState<PendingMaterialConfirmation>();
  const inFlightRef = useRef<Promise<CommandResult> | null>(null);
  const preparingRef = useRef(false);
  const resetCountRef = useRef(0);
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const directionSaveRef = useRef<HTMLButtonElement>(null);
  const advancedSaveRef = useRef<HTMLButtonElement>(null);
  const projectNameInputRef = useRef<HTMLInputElement>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const next = toDraft(brief);
    setDraft(next);
    setAppetiteRaw(appetiteMinutes(next.appetiteSeconds));
    setAppetiteTouched(false);
    setActiveIndex(firstIncompleteDecision(next));
    if (resetCountRef.current > 0) queueMicrotask(() => stepHeadingRef.current?.focus());
    resetCountRef.current += 1;
  }, [brief.id, brief.version]);

  useEffect(() => setProjectName(project.name), [project.name]);

  const parsedAppetite = parseAppetiteSeconds(appetiteRaw);
  const candidate = useMemo(
    () => normalizeDraft({ ...draft, appetiteSeconds: parsedAppetite ?? 0 }),
    [draft, parsedAppetite],
  );
  const persisted = useMemo(() => normalizeDraft(toDraft(brief)), [brief.id, brief.version]);
  const completeness = directionCompleteness(candidate);
  const completedCount = Object.values(completeness).filter(Boolean).length;
  const activeDecision = DIRECTION_DECISIONS[activeIndex];
  const currentComplete = completeness[activeDecision.key];
  const noOp = sameDraft(candidate, persisted);
  const busy = pending || checkingMaterial;
  const validActiveBet = project.activeBetId !== undefined && workspace.bets.filter(
    (bet) => bet.id === project.activeBetId && bet.projectId === project.id && bet.invalidatedAt === undefined,
  ).length === 1;
  const activeBetEditStage = ACTIVE_BET_EDIT_STAGES.has(
    project.stage as "planning" | "executing" | "validating",
  );

  async function runCommand(command: V2Command): Promise<CommandResult> {
    if (inFlightRef.current !== null) return inFlightRef.current;
    setPending(true);
    setLastResult(undefined);
    const operation = dispatch(structuredClone(command))
      .then((result) => {
        setLastResult(result);
        return result;
      })
      .finally(() => {
        inFlightRef.current = null;
        setPending(false);
      });
    inFlightRef.current = operation;
    return operation;
  }

  function saveDirectionDraft(submitted: DirectionBriefDraft): Promise<CommandResult> {
    return runCommand({
      type: "update_direction",
      projectId: project.id,
      brief: structuredClone(submitted),
    });
  }

  async function prepareDirectionSave(
    submitted: DirectionBriefDraft,
    returnFocus: HTMLElement | null,
  ): Promise<void> {
    if (preparingRef.current || inFlightRef.current !== null) return;
    const frozen = structuredClone(submitted);
    if (validActiveBet && activeBetEditStage) {
      preparingRef.current = true;
      setCheckingMaterial(true);
      const comparison: DirectionBrief = {
        ...structuredClone(frozen),
        version: brief.version + 1,
        createdAt: brief.createdAt,
        updatedAt: brief.updatedAt,
      };
      let material = false;
      try {
        material = await isMaterialDirectionChange(brief, comparison);
      } finally {
        preparingRef.current = false;
        setCheckingMaterial(false);
      }
      if (material) {
        setConfirmation({ draft: frozen, changes: materialChanges(brief, frozen), returnFocus });
        return;
      }
    }
    await saveDirectionDraft(frozen);
  }

  function setTextField(
    field: "audienceAndProblem" | "successEvidence" | "validationMethod" | "noGoOrKill" | "advancedNotes",
    value: string,
  ): void {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  function setScope(index: number, patch: Partial<BetScope>): void {
    setDraft((current) => ({
      ...current,
      firstScope: current.firstScope.map((scope, scopeIndex) =>
        scopeIndex === index ? { ...scope, ...patch } : scope),
    }));
  }

  function selectStep(index: number): void {
    setActiveIndex(index);
    queueMicrotask(() => stepHeadingRef.current?.focus());
  }

  function submitCurrentDecision(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!currentComplete || noOp || busy) return;
    void prepareDirectionSave(candidate, directionSaveRef.current);
  }

  const otherDecisionDirty = !sameDraft(
    { ...candidate, advancedNotes: persisted.advancedNotes },
    persisted,
  );
  const advancedDirty = candidate.advancedNotes !== persisted.advancedNotes;

  function submitAdvancedNotes(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!advancedDirty || otherDecisionDirty || busy) return;
    void prepareDirectionSave(
      { ...toDraft(brief), advancedNotes: candidate.advancedNotes },
      advancedSaveRef.current,
    );
  }

  function submitProjectName(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const name = projectName.trim();
    if (name.length === 0 || name === project.name || busy) return;
    void runCommand({ type: "update_project_metadata", projectId: project.id, name })
      .then((result) => {
        if (result.ok) queueMicrotask(() => projectNameInputRef.current?.focus());
      });
  }

  function closeConfirmation(): void {
    if (pending) return;
    const returnFocus = confirmation?.returnFocus;
    setConfirmation(undefined);
    queueMicrotask(() => returnFocus?.focus());
  }

  async function confirmMaterialChange(): Promise<void> {
    if (confirmation === undefined) return;
    const result = await saveDirectionDraft(confirmation.draft);
    if (result.ok) {
      setConfirmation(undefined);
      navigate(`/projects/${project.id}/bet`);
    }
  }

  const renderDecision = (key: DirectionDecisionKey) => {
    switch (key) {
      case "audienceAndProblem":
        return (
          <label className="v2-direction-field">
            Audience and problem
            <textarea aria-label="Audience and problem" value={draft.audienceAndProblem}
              onChange={(event) => setTextField("audienceAndProblem", event.target.value)} rows={6} />
            <small>Who is struggling, and what bounded problem matters now?</small>
          </label>
        );
      case "successEvidence":
        return (
          <label className="v2-direction-field">
            Success evidence
            <textarea aria-label="Success evidence" value={draft.successEvidence}
              onChange={(event) => setTextField("successEvidence", event.target.value)} rows={6} />
            <small>State the observable evidence that would make this worth closing.</small>
          </label>
        );
      case "appetite":
        return (
          <label className="v2-direction-field v2-direction-field--short">
            Appetite minutes
            <input aria-label="Appetite minutes" type="number" min="0.016666666666666666"
              step="any" inputMode="decimal" value={appetiteRaw}
              onChange={(event) => {
                setAppetiteTouched(true);
                setAppetiteRaw(event.target.value);
              }} />
            <small>Minutes are stored exactly as a positive whole number of seconds.</small>
            {appetiteTouched && parsedAppetite === undefined ? (
              <span className="v2-direction-validation" role="alert">
                Appetite must convert to a positive whole number of seconds.
              </span>
            ) : null}
          </label>
        );
      case "validationMethod":
        return (
          <label className="v2-direction-field">
            Validation method
            <textarea aria-label="Validation method" value={draft.validationMethod}
              onChange={(event) => setTextField("validationMethod", event.target.value)} rows={6} />
            <small>How will the success evidence be collected and judged?</small>
          </label>
        );
      case "firstScope":
        return (
          <div className="v2-direction-scope-editor">
            {draft.firstScope.length === 0 ? (
              <p>No scope has been defined. Add the first bounded result.</p>
            ) : (
              <ol>
                {draft.firstScope.map((scope, index) => (
                  <li key={scope.id}>
                    <label className="v2-direction-field">
                      Scope title {index + 1}
                      <input aria-label={`Scope title ${index + 1}`} value={scope.title}
                        onChange={(event) => setScope(index, { title: event.target.value })} />
                    </label>
                    <label className="v2-direction-field">
                      Scope description {index + 1}
                      <textarea aria-label={`Scope description ${index + 1}`} value={scope.description}
                        onChange={(event) => setScope(index, { description: event.target.value })} rows={3} />
                    </label>
                    <button type="button" onClick={() => setDraft((current) => ({
                      ...current,
                      firstScope: current.firstScope.filter((_, scopeIndex) => scopeIndex !== index),
                    }))}>
                      Remove scope {index + 1}
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <button type="button" onClick={() => setDraft((current) => ({
              ...current,
              firstScope: [...current.firstScope, {
                id: createScopeId(project.id),
                title: "",
                description: "",
              }],
            }))}>
              Add scope
            </button>
          </div>
        );
      case "noGoOrKill":
        return (
          <label className="v2-direction-field">
            No-go or kill criteria
            <textarea aria-label="No-go or kill criteria" value={draft.noGoOrKill}
              onChange={(event) => setTextField("noGoOrKill", event.target.value)} rows={6} />
            <small>Name the signal that should stop this Project instead of extending it.</small>
          </label>
        );
    }
  };

  return (
    <section className="v2-direction-stage" aria-labelledby="v2-direction-title">
      <header>
        <div>
          <p className="v2-eyebrow">Six bounded decisions</p>
          <h2 id="v2-direction-title">Direction</h2>
        </div>
        <p className="v2-direction-completeness" aria-live="polite">
          <strong>{completedCount} of 6 decisions complete</strong>
        </p>
      </header>

      <DirectionDecisionStepper draft={candidate} activeIndex={activeIndex}
        disabled={busy} lockOtherSteps={otherDecisionDirty} onSelect={selectStep} />

      <form className="v2-direction-decision" aria-busy={busy ? "true" : "false"}
        onSubmit={submitCurrentDecision}>
        <fieldset disabled={busy}>
          <legend className="v2-sr-only">Current Direction decision</legend>
          <p className="v2-direction-decision__index">Decision {activeIndex + 1} of 6</p>
          <h3 ref={stepHeadingRef} tabIndex={-1}>{activeDecision.label}</h3>
          {renderDecision(activeDecision.key)}
          <div className="v2-direction-decision__actions">
            <p>{currentComplete
              ? "This decision is ready to save with the full Direction draft."
              : "Complete this required decision before continuing."}</p>
            <button ref={directionSaveRef} type="submit"
              disabled={busy || !currentComplete || noOp}>
              {activeIndex === DIRECTION_DECISIONS.length - 1
                ? "Save Direction"
                : "Save draft and continue"}
            </button>
          </div>
        </fieldset>
      </form>

      <details className="v2-direction-advanced">
        <summary>Advanced notes (optional)</summary>
        <form aria-busy={busy ? "true" : "false"} onSubmit={submitAdvancedNotes}>
          <fieldset disabled={busy}>
            <label className="v2-direction-field">
              Advanced notes
              <textarea aria-label="Advanced notes" value={draft.advancedNotes}
                onChange={(event) => setTextField("advancedNotes", event.target.value)} rows={5} />
              <small>Optional context never changes the six-decision completeness score.</small>
            </label>
            <button ref={advancedSaveRef} type="submit"
              disabled={busy || !advancedDirty || otherDecisionDirty}>
              Save advanced notes
            </button>
          </fieldset>
        </form>
      </details>

      <details className="v2-direction-metadata">
        <summary>Project name</summary>
        <form aria-busy={pending ? "true" : "false"} onSubmit={submitProjectName}>
          <fieldset disabled={busy}>
            <label className="v2-direction-field v2-direction-field--short">
              Project name
              <input ref={projectNameInputRef} aria-label="Project name" value={projectName}
                onChange={(event) => setProjectName(event.target.value)} />
            </label>
            <p>Renaming is metadata only. It never invalidates the current Bet.</p>
            <button type="submit" disabled={
              busy || projectName.trim().length === 0 || projectName.trim() === project.name
            }>
              Save project name
            </button>
          </fieldset>
        </form>
      </details>

      {confirmation === undefined ? (
        <CommandRejectionCard result={lastResult} onResolve={(command) => {
          if (command === "place_bet") navigate(`/projects/${project.id}/bet`);
          else stepHeadingRef.current?.focus();
        }} />
      ) : null}

      {confirmation === undefined ? null : (
        <ModalSurface className="v2-direction-confirmation"
          titleId="v2-direction-confirmation-title"
          descriptionId="v2-direction-confirmation-description"
          initialFocusRef={confirmationHeadingRef} pending={pending}
          onRequestClose={closeConfirmation}>
          <p className="v2-eyebrow">Human lifecycle decision</p>
          <h2 id="v2-direction-confirmation-title" ref={confirmationHeadingRef} tabIndex={-1}>
            Confirm Direction change
          </h2>
          <p id="v2-direction-confirmation-description">
            Execution will pause until a human Re-bet.
          </p>
          <p>
            The current Bet will be invalidated. Existing Bet, Plan, and execution history remain immutable.
          </p>
          <dl className="v2-direction-change-list">
            {confirmation.changes.map((change) => (
              <div key={change.key}>
                <dt>{change.label}</dt>
                <dd><span>Before</span>{change.before}</dd>
                <dd><span>After</span>{change.after}</dd>
              </div>
            ))}
          </dl>
          <CommandRejectionCard result={lastResult}
            onResolve={() => confirmationHeadingRef.current?.focus()} />
          <div className="v2-dialog-actions">
            <button type="button" disabled={pending} onClick={closeConfirmation}>Cancel</button>
            <button type="button" className="v2-button--primary" disabled={pending}
              onClick={() => void confirmMaterialChange()}>
              Save change and require Re-bet
            </button>
          </div>
        </ModalSurface>
      )}
    </section>
  );
}

export function DirectionStage({ projectId }: { projectId: string }) {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const reason = unavailableReason(state.workspace, projectId);
  if (reason !== undefined) return <DirectionUnavailable reason={reason} />;
  const project = state.workspace.projects.filter(({ id }) => id === projectId)[0];
  const brief = state.workspace.directionBriefs.filter(
    ({ id }) => id === project.activeDirectionBriefId,
  )[0];
  if (project.stage === "closing" || project.stage === "closed") {
    return <ReadOnlyDirection brief={brief} />;
  }
  return <DirectionEditor workspace={state.workspace} project={project}
    brief={brief} dispatch={state.dispatch} />;
}
