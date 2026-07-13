import { NavLink } from "react-router-dom";

import type { PrimaryDestination } from "./AppShell";

export function DesktopSidebar({
  destinations,
}: {
  destinations: readonly PrimaryDestination[];
}) {
  return (
    <aside className="v2-desktop-sidebar" aria-label="Workspace navigation">
      <div className="v2-brand-lockup" aria-label="OmniPlan">
        <span className="v2-brand-mark" aria-hidden="true">O</span>
        <span>
          <strong>OmniPlan</strong>
          <small>Guided work</small>
        </span>
      </div>
      <nav aria-label="Primary navigation" className="v2-primary-navigation">
        {destinations.map(({ label, to, index }) => (
          <NavLink key={to} to={to} aria-label={label}>
            <span className="v2-nav-index" aria-hidden="true">{index}</span>
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="v2-sidebar-utility">
        <p>Workspace</p>
        <NavLink to="/settings">Settings</NavLink>
      </div>
    </aside>
  );
}
