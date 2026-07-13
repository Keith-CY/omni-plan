import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

export function RouteFocusManager() {
  const location = useLocation();
  const announcementRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const heading = document.querySelector<HTMLElement>("#v2-main h1");
      if (heading === null) return;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus();
      if (announcementRef.current !== null) {
        announcementRef.current.textContent =
          heading.textContent?.trim() ?? "Page changed";
      }
    });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  return (
    <div
      ref={announcementRef}
      className="v2-sr-only"
      role="status"
      aria-live="polite"
    />
  );
}
