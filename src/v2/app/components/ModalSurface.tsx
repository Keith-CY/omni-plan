import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR =
  "button, input, select, textarea, a[href], [tabindex]";

export function ModalSurface({
  className,
  titleId,
  descriptionId,
  initialFocusRef,
  pending,
  onRequestClose,
  children,
}: {
  className: string;
  titleId: string;
  descriptionId?: string;
  initialFocusRef: RefObject<HTMLElement>;
  pending: boolean;
  onRequestClose(): void;
  children: ReactNode;
}) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    initialFocusRef.current?.focus();
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
  }, [initialFocusRef]);

  return createPortal(
    <div className="v2-dialog-backdrop" ref={backdropRef}>
      <section
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            onRequestClose();
            return;
          }
          if (event.key !== "Tab") return;
          const dialog = dialogRef.current;
          if (dialog === null) return;
          const focusable = Array.from(
            dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
          ).filter(
            (element) =>
              !element.matches(":disabled") && element.tabIndex >= 0,
          );
          if (focusable.length === 0) {
            event.preventDefault();
            initialFocusRef.current?.focus();
            return;
          }
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          const active = document.activeElement;
          if (
            event.shiftKey &&
            (active === first ||
              active === initialFocusRef.current ||
              !dialog.contains(active))
          ) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        {children}
      </section>
    </div>,
    document.body,
  );
}
