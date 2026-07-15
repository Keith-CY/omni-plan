import { useEffect, useId, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

export interface HumanConfirmationDialogProps {
  kind: "Action" | "Project";
  itemTitle: string;
  open: boolean;
  pending: boolean;
  returnFocusRef: RefObject<HTMLButtonElement>;
  onCancel(): void;
  onConfirm(): void;
}

export function HumanConfirmationDialog({
  kind,
  itemTitle,
  open,
  pending,
  returnFocusRef,
  onCancel,
  onConfirm,
}: HumanConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!open) return;
    headingRef.current?.focus();
    const backdrop = backdropRef.current;
    if (backdrop === null) return;
    const background = Array.from(document.body.children).filter(
      (element) => element !== backdrop,
    );
    const previous = background.map((element) => ({
      element,
      inert: element.hasAttribute("inert"),
    }));
    for (const { element } of previous) element.setAttribute("inert", "");
    return () => {
      for (const { element, inert } of previous) {
        if (!inert) element.removeAttribute("inert");
      }
    };
  }, [open]);

  if (!open) return null;

  const cancel = () => {
    onCancel();
    queueMicrotask(() => returnFocusRef.current?.focus());
  };
  const confirmLabel =
    kind === "Action" ? "Create Action" : "Create Direction-stage Project";

  const dialog = (
    <div className="v2-dialog-backdrop" ref={backdropRef}>
      <section
        ref={dialogRef}
        className="v2-confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            cancel();
            return;
          }
          if (event.key !== "Tab") return;
          const container = dialogRef.current;
          if (container === null) return;
          const focusable = Array.from(
            container.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
            ),
          );
          if (focusable.length === 0) {
            event.preventDefault();
            headingRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (
            event.shiftKey &&
            (active === first ||
              active === headingRef.current ||
              !container.contains(active))
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <p className="v2-eyebrow">Human decision required</p>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          Confirm {kind} classification
        </h2>
        <p className="v2-confirmation-dialog__item">“{itemTitle}”</p>
        <p id={descriptionId}>
          This classification is irreversible. The capture remains in Inbox
          history, and the new {kind} becomes the authoritative work record.
        </p>
        <div className="v2-confirmation-dialog__actions">
          <button type="button" onClick={cancel} disabled={pending}>
            Cancel
          </button>
          <button
            className="v2-button--primary"
            type="button"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Classifying…" : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
  return createPortal(dialog, document.body);
}
