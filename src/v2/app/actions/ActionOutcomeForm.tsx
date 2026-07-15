import { useCallback, useId, useRef, useState, type RefObject } from "react";

import type { Action, ResultStatus } from "../../domain/types";
import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { ModalSurface } from "../components/ModalSurface";
import { useCommandForm } from "../state/useCommandForm";

interface OutcomeSubmission {
  actualSeconds: number;
  resultStatus: ResultStatus;
  outcomeNote: string;
}

export function ActionOutcomeForm({
  action,
  returnFocusRef,
  onClose,
  onCompleted,
}: {
  action: Action;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onCompleted(actionId: string): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const validationId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const actualInputRef = useRef<HTMLInputElement>(null);
  const outcomeNoteRef = useRef<HTMLTextAreaElement>(null);
  const [actualMinutes, setActualMinutes] = useState("");
  const [resultStatus, setResultStatus] =
    useState<ResultStatus>("completed");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [invalidField, setInvalidField] = useState<"actual" | "note">();
  const buildCommand = useCallback(
    (submission: OutcomeSubmission) =>
      ({
        type: "complete_action",
        actionId: action.id,
        ...submission,
      }) as const,
    [action.id],
  );
  const form = useCommandForm(buildCommand);

  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };

  const submit = async () => {
    const actualSeconds = Number(actualMinutes) * 60;
    if (!Number.isSafeInteger(actualSeconds) || actualSeconds <= 0) {
      setLocalError(
        "Actual effort must resolve to a positive whole number of seconds.",
      );
      setInvalidField("actual");
      queueMicrotask(() => actualInputRef.current?.focus());
      return;
    }
    const note = outcomeNote.trim();
    if (note === "") {
      setLocalError("A concise outcome note is required.");
      setInvalidField("note");
      queueMicrotask(() => outcomeNoteRef.current?.focus());
      return;
    }
    setLocalError(undefined);
    setInvalidField(undefined);
    const result = await form.submit({
      actualSeconds,
      resultStatus,
      outcomeNote: note,
    });
    if (result.ok) {
      onClose();
      onCompleted(action.id);
    }
  };

  return (
    <ModalSurface
      className="v2-action-sheet v2-action-sheet--compact"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
        <p className="v2-eyebrow">Close the loop</p>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          Complete Action
        </h2>
        <p id={descriptionId}>
          Record one honest Actual and the outcome in the same atomic decision.
        </p>
        <form
          className="v2-action-form"
          aria-busy={form.pending}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="v2-modal-fields" disabled={form.pending}>
          <label className="v2-field">
            <span>Actual minutes</span>
            <input
              ref={actualInputRef}
              type="number"
              min="0"
              step="0.01"
              required
              aria-invalid={invalidField === "actual"}
              aria-describedby={invalidField === "actual" ? validationId : undefined}
              value={actualMinutes}
              onChange={(event) => {
                setActualMinutes(event.target.value);
                setLocalError(undefined);
                setInvalidField(undefined);
              }}
            />
          </label>
          <label className="v2-field">
            <span>Result</span>
            <select
              value={resultStatus}
              onChange={(event) =>
                setResultStatus(event.target.value as ResultStatus)
              }
            >
              <option value="completed">Completed</option>
              <option value="learned">Learned</option>
              <option value="blocked">Blocked</option>
            </select>
          </label>
          <label className="v2-field">
            <span>Outcome note</span>
            <textarea
              ref={outcomeNoteRef}
              rows={4}
              required
              aria-invalid={invalidField === "note"}
              aria-describedby={invalidField === "note" ? validationId : undefined}
              value={outcomeNote}
              onChange={(event) => {
                setOutcomeNote(event.target.value);
                setLocalError(undefined);
                setInvalidField(undefined);
              }}
            />
          </label>
          </fieldset>

          {localError === undefined ? null : (
            <div id={validationId} className="v2-inline-validation" role="alert">
              <strong>Review this outcome</strong>
              <p>{localError}</p>
            </div>
          )}
          <CommandRejectionCard
            result={form.result}
            onResolve={() => headingRef.current?.focus()}
          />

          <div className="v2-dialog-actions">
            <button type="button" onClick={cancel} disabled={form.pending}>
              Cancel
            </button>
            <button
              className="v2-button--primary"
              type="submit"
              disabled={form.pending}
            >
              {form.pending ? "Recording…" : "Record outcome"}
            </button>
          </div>
        </form>
    </ModalSurface>
  );
}
