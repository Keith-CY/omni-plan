import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { ActionPatch } from "../../domain/commands";
import type {
  Action,
  ActionEligibilityFacts,
  AttentionKind,
} from "../../domain/types";
import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { ModalSurface } from "../components/ModalSurface";
import {
  instantToLocalDateTimeInput,
  localDateTimeInputToInstant,
} from "../localDateTimeInput";
import { useCommandForm } from "../state/useCommandForm";

interface ActionEditorDraft {
  title: string;
  attention: AttentionKind;
  desiredDate: string;
  fixedStart: string;
  singleSession: boolean;
  estimateMinutes: string;
  dependencies: string;
  requiresMilestoneEvidence: boolean;
  outcomeCount: string;
  solutionKnown: boolean;
}

interface PatchCandidate {
  patch: ActionPatch;
  eligibility: ActionEligibilityFacts;
  error?: string;
  errorField?:
    | "title"
    | "estimateMinutes"
    | "outcomeCount"
    | "desiredDate"
    | "fixedStart";
}

function initialDraft(
  action: Action,
  timeZone: string,
): ActionEditorDraft {
  return {
    title: action.title,
    attention: action.attention,
    desiredDate: instantToLocalDateTimeInput(action.desiredDate, timeZone),
    fixedStart: instantToLocalDateTimeInput(action.fixedStart, timeZone),
    singleSession: action.eligibility.singleSession,
    estimateMinutes: String(action.eligibility.estimateSeconds / 60),
    dependencies: action.eligibility.dependencyIds.join(", "),
    requiresMilestoneEvidence:
      action.eligibility.requiresMilestoneEvidence,
    outcomeCount: String(action.eligibility.outcomeCount),
    solutionKnown: action.eligibility.solutionKnown,
  };
}

function normalizedDependencies(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildPatchCandidate(
  action: Action,
  draft: ActionEditorDraft,
  timeZone: string,
): PatchCandidate {
  const estimateSeconds = Number(draft.estimateMinutes) * 60;
  if (!Number.isSafeInteger(estimateSeconds) || estimateSeconds <= 0) {
    return {
      patch: {},
      eligibility: action.eligibility,
      error: "Estimate must resolve to a positive whole number of seconds.",
      errorField: "estimateMinutes",
    };
  }
  const outcomeCount = Number(draft.outcomeCount);
  if (!Number.isSafeInteger(outcomeCount) || outcomeCount <= 0) {
    return {
      patch: {},
      eligibility: action.eligibility,
      error: "Outcome count must be a positive whole number.",
      errorField: "outcomeCount",
    };
  }
  const title = draft.title.trim();
  if (title === "") {
    return {
      patch: {},
      eligibility: action.eligibility,
      error: "Action title is required.",
      errorField: "title",
    };
  }

  const eligibility: ActionEligibilityFacts = {
    singleSession: draft.singleSession,
    estimateSeconds,
    dependencyIds: normalizedDependencies(draft.dependencies),
    requiresMilestoneEvidence: draft.requiresMilestoneEvidence,
    outcomeCount,
    solutionKnown: draft.solutionKnown,
  };
  const patch: ActionPatch = {};
  if (title !== action.title) patch.title = title;
  if (draft.attention !== action.attention) patch.attention = draft.attention;
  if (!sameJson(eligibility, action.eligibility)) patch.eligibility = eligibility;

  for (const field of ["desiredDate", "fixedStart"] as const) {
    const draftValue = draft[field];
    const currentValue = action[field];
    if (draftValue === "") {
      if (currentValue !== undefined) {
        return {
          patch: {},
          eligibility,
          error:
            "Existing desired and fixed dates can be replaced but cannot be cleared in this version.",
          errorField: field,
        };
      }
      continue;
    }
    const instant = localDateTimeInputToInstant(draftValue, timeZone);
    if (instant === undefined) {
      return {
        patch: {},
        eligibility,
        error: `Enter a valid ${field === "desiredDate" ? "desired date" : "fixed start"} in ${timeZone}.`,
        errorField: field,
      };
    }
    if (instant !== currentValue) patch[field] = instant;
  }

  return { patch, eligibility };
}

export interface ActionEditorSheetProps {
  action: Action;
  timeZone: string;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onSaved(actionId: string): void;
  onPromotionRequired(
    action: Action,
    failedEligibility: ActionEligibilityFacts,
  ): void;
}

export function ActionEditorSheet({
  action,
  timeZone,
  returnFocusRef,
  onClose,
  onSaved,
  onPromotionRequired,
}: ActionEditorSheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const validationId = useId();
  const saveHintId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const estimateInputRef = useRef<HTMLInputElement>(null);
  const outcomeCountInputRef = useRef<HTMLInputElement>(null);
  const desiredDateInputRef = useRef<HTMLInputElement>(null);
  const fixedStartInputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => initialDraft(action, timeZone));
  const [localError, setLocalError] = useState<string>();
  const [showResult, setShowResult] = useState(false);
  const [failedEligibility, setFailedEligibility] =
    useState<ActionEligibilityFacts>();
  const buildCommand = useCallback(
    (patch: ActionPatch) =>
      ({ type: "update_action", actionId: action.id, patch }) as const,
    [action.id],
  );
  const form = useCommandForm(buildCommand);
  const candidate = useMemo(
    () => buildPatchCandidate(action, draft, timeZone),
    [action, draft, timeZone],
  );
  const dirty = useMemo(
    () => !sameJson(draft, initialDraft(action, timeZone)),
    [action, draft, timeZone],
  );
  const hasPatch = Object.keys(candidate.patch).length > 0;
  const canSubmit =
    dirty && (candidate.error !== undefined || hasPatch) && !form.pending;

  const changeDraft = (patch: Partial<ActionEditorDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setLocalError(undefined);
    setShowResult(false);
    setFailedEligibility(undefined);
  };

  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };

  const save = async () => {
    if (candidate.error !== undefined) {
      setLocalError(candidate.error);
      const invalidField = {
        title: titleInputRef,
        estimateMinutes: estimateInputRef,
        outcomeCount: outcomeCountInputRef,
        desiredDate: desiredDateInputRef,
        fixedStart: fixedStartInputRef,
      }[candidate.errorField ?? "title"];
      queueMicrotask(() => invalidField.current?.focus());
      return;
    }
    if (Object.keys(candidate.patch).length === 0) return;
    setLocalError(undefined);
    const result = await form.submit(candidate.patch);
    setShowResult(true);
    if (result.ok) {
      onClose();
      onSaved(action.id);
      return;
    }
    if (
      result.rejection.code === "ACTION_PROMOTION_REQUIRED" &&
      result.rejection.permittedNextCommand === "promote_action_to_project"
    ) {
      setFailedEligibility(structuredClone(candidate.eligibility));
    }
  };

  return (
    <ModalSurface
      className="v2-action-sheet"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
        <p className="v2-eyebrow">Lightweight boundary</p>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          Edit Action
        </h2>
        <p id={descriptionId}>
          Keep this record small, certain, and completable in one working
          session. A failed boundary requires Project promotion.
        </p>

        <form
          className="v2-action-form"
          aria-busy={form.pending}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="v2-modal-fields" disabled={form.pending}>
          <label className="v2-field">
            <span>Title</span>
            <input
              ref={titleInputRef}
              type="text"
              required
              aria-invalid={candidate.errorField === "title" && localError !== undefined}
              aria-describedby={candidate.errorField === "title" && localError !== undefined ? validationId : undefined}
              value={draft.title}
              onChange={(event) => changeDraft({ title: event.target.value })}
            />
          </label>
          <label className="v2-field">
            <span>Attention</span>
            <select
              value={draft.attention}
              onChange={(event) =>
                changeDraft({ attention: event.target.value as AttentionKind })
              }
            >
              <option value="deep">Deep</option>
              <option value="medium">Medium</option>
              <option value="shallow">Shallow</option>
            </select>
          </label>
          <label className="v2-field">
            <span>Desired date</span>
            <input
              ref={desiredDateInputRef}
              type="datetime-local"
              aria-invalid={candidate.errorField === "desiredDate" && localError !== undefined}
              aria-describedby={candidate.errorField === "desiredDate" && localError !== undefined ? validationId : undefined}
              value={draft.desiredDate}
              onChange={(event) =>
                changeDraft({ desiredDate: event.target.value })
              }
            />
          </label>
          <label className="v2-field">
            <span>Fixed start</span>
            <input
              ref={fixedStartInputRef}
              type="datetime-local"
              aria-invalid={candidate.errorField === "fixedStart" && localError !== undefined}
              aria-describedby={candidate.errorField === "fixedStart" && localError !== undefined ? validationId : undefined}
              value={draft.fixedStart}
              onChange={(event) =>
                changeDraft({ fixedStart: event.target.value })
              }
            />
          </label>

          <fieldset className="v2-action-boundary-fields">
            <legend>Action eligibility</legend>
            <label className="v2-check-field">
              <input
                type="checkbox"
                checked={draft.singleSession}
                onChange={(event) =>
                  changeDraft({ singleSession: event.target.checked })
                }
              />
              <span>Single working session</span>
            </label>
            <label className="v2-field">
              <span>Estimate minutes</span>
              <input
                ref={estimateInputRef}
                type="number"
                min="0"
                step="0.01"
                required
                aria-invalid={candidate.errorField === "estimateMinutes" && localError !== undefined}
                aria-describedby={candidate.errorField === "estimateMinutes" && localError !== undefined ? validationId : undefined}
                value={draft.estimateMinutes}
                onChange={(event) =>
                  changeDraft({ estimateMinutes: event.target.value })
                }
              />
            </label>
            <label className="v2-field">
              <span>Dependencies</span>
              <input
                type="text"
                value={draft.dependencies}
                onChange={(event) =>
                  changeDraft({ dependencies: event.target.value })
                }
                placeholder="Comma-separated IDs"
              />
            </label>
            <label className="v2-check-field">
              <input
                type="checkbox"
                checked={draft.requiresMilestoneEvidence}
                onChange={(event) =>
                  changeDraft({
                    requiresMilestoneEvidence: event.target.checked,
                  })
                }
              />
              <span>Requires milestone evidence</span>
            </label>
            <label className="v2-field">
              <span>Outcome count</span>
              <input
                ref={outcomeCountInputRef}
                type="number"
                min="1"
                step="1"
                required
                aria-invalid={candidate.errorField === "outcomeCount" && localError !== undefined}
                aria-describedby={candidate.errorField === "outcomeCount" && localError !== undefined ? validationId : undefined}
                value={draft.outcomeCount}
                onChange={(event) =>
                  changeDraft({ outcomeCount: event.target.value })
                }
              />
            </label>
            <label className="v2-check-field">
              <input
                type="checkbox"
                checked={draft.solutionKnown}
                onChange={(event) =>
                  changeDraft({ solutionKnown: event.target.checked })
                }
              />
              <span>Solution known</span>
            </label>
          </fieldset>
          </fieldset>

          {localError === undefined ? null : (
            <div id={validationId} className="v2-inline-validation" role="alert">
              <strong>Review this Action draft</strong>
              <p>{localError}</p>
            </div>
          )}
          <CommandRejectionCard
            result={showResult ? form.result : undefined}
            resolveLabel={
              failedEligibility === undefined
                ? undefined
                : "Promote to project"
            }
            onResolve={() => {
              if (failedEligibility !== undefined) {
                onPromotionRequired(action, failedEligibility);
              }
            }}
          />

          <p id={saveHintId} className="v2-form-hint" aria-live="polite">
            {!dirty
              ? "Make a change to enable Save."
              : candidate.error !== undefined
                ? "Save will identify the invalid field."
                : hasPatch
                  ? "Only changed fields will be saved."
                  : "These edits normalize to the current values."}
          </p>
          <div className="v2-dialog-actions">
            <button type="button" onClick={cancel} disabled={form.pending}>
              Cancel
            </button>
            <button
              className="v2-button--primary"
              type="submit"
              aria-describedby={saveHintId}
              disabled={!canSubmit}
            >
              {form.pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
    </ModalSurface>
  );
}
