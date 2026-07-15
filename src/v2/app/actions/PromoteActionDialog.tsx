import { useCallback, useId, useRef, useState, type RefObject } from "react";

import type { Action, ActionEligibilityFacts } from "../../domain/types";
import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { ModalSurface } from "../components/ModalSurface";
import { useCommandForm } from "../state/useCommandForm";

interface PromotionSubmission {
  projectId: string;
  name: string;
  priority: number;
  notes: string;
}

let promotionIdSequence = 0;

function createProjectId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `project:${uuid}`;
  promotionIdSequence += 1;
  return `project:${Date.now()}:${promotionIdSequence}`;
}

export function PromoteActionDialog({
  action,
  failedEligibility,
  returnFocusRef,
  onClose,
  onPromoted,
}: {
  action: Action;
  failedEligibility: ActionEligibilityFacts;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onClose(): void;
  onPromoted(projectId: string): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const validationId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const priorityInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(action.title);
  const [priority, setPriority] = useState("0");
  const [notes, setNotes] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [invalidField, setInvalidField] = useState<"name" | "priority">();
  const buildCommand = useCallback(
    (submission: PromotionSubmission) =>
      ({
        type: "promote_action_to_project",
        actionId: action.id,
        eligibility: structuredClone(failedEligibility),
        project: {
          id: submission.projectId,
          name: submission.name,
          priority: submission.priority,
          notes: submission.notes,
        },
      }) as const,
    [action.id, failedEligibility],
  );
  const form = useCommandForm(buildCommand);

  const cancel = () => {
    onClose();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };

  const promote = async () => {
    const projectName = name.trim();
    const projectPriority = Number(priority);
    if (projectName === "") {
      setLocalError("Project name is required.");
      setInvalidField("name");
      queueMicrotask(() => nameInputRef.current?.focus());
      return;
    }
    if (!Number.isSafeInteger(projectPriority)) {
      setLocalError("Project priority must be a whole number.");
      setInvalidField("priority");
      queueMicrotask(() => priorityInputRef.current?.focus());
      return;
    }
    const projectId = createProjectId();
    setLocalError(undefined);
    setInvalidField(undefined);
    const result = await form.submit({
      projectId,
      name: projectName,
      priority: projectPriority,
      notes: notes.trim(),
    });
    if (result.ok) {
      onClose();
      onPromoted(projectId);
    }
  };

  return (
    <ModalSurface
      className="v2-confirmation-dialog v2-promotion-dialog"
      titleId={titleId}
      descriptionId={descriptionId}
      initialFocusRef={headingRef}
      pending={form.pending}
      onRequestClose={cancel}
    >
        <p className="v2-eyebrow">Human decision required</p>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          Promote Action to Project
        </h2>
        <p id={descriptionId}>
          This promotion is irreversible. The Capture, Action, Actuals, and
          outcome history remain auditable; the Action becomes promoted and a
          new Direction-stage Project becomes authoritative.
        </p>
        <form
          className="v2-action-form"
          aria-busy={form.pending}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void promote();
          }}
        >
          <fieldset className="v2-modal-fields" disabled={form.pending}>
          <label className="v2-field">
            <span>Project name</span>
            <input
              ref={nameInputRef}
              type="text"
              required
              aria-invalid={invalidField === "name"}
              aria-describedby={invalidField === "name" ? validationId : undefined}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setLocalError(undefined);
                setInvalidField(undefined);
              }}
            />
          </label>
          <label className="v2-field">
            <span>Priority</span>
            <input
              ref={priorityInputRef}
              type="number"
              step="1"
              required
              aria-invalid={invalidField === "priority"}
              aria-describedby={invalidField === "priority" ? validationId : undefined}
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value);
                setLocalError(undefined);
                setInvalidField(undefined);
              }}
            />
          </label>
          <label className="v2-field">
            <span>Notes</span>
            <textarea
              rows={4}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </label>
          </fieldset>

          {localError === undefined ? null : (
            <div id={validationId} className="v2-inline-validation" role="alert">
              <strong>Review this Project</strong>
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
              {form.pending ? "Creating Project…" : "Create Direction project"}
            </button>
          </div>
        </form>
    </ModalSurface>
  );
}
