import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";

export function MobileUtilityMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeAndRestoreFocus = () => {
    setOpen(false);
    queueMicrotask(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAndRestoreFocus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className="v2-mobile-utility">
      <button
        ref={triggerRef}
        type="button"
        className="v2-icon-button"
        aria-label="Open utility menu"
        aria-expanded={open}
        aria-controls="v2-mobile-utility-menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open ? (
        <nav
          id="v2-mobile-utility-menu"
          className="v2-utility-popover"
          aria-label="Workspace utilities"
        >
          <NavLink to="/settings" onClick={() => setOpen(false)}>
            Settings
          </NavLink>
          <NavLink
            to="/settings/automation"
            onClick={() => setOpen(false)}
          >
            Automation
          </NavLink>
        </nav>
      ) : null}
    </div>
  );
}
