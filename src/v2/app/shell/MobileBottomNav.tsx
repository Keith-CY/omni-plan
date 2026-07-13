import { NavLink } from "react-router-dom";

import type { PrimaryDestination } from "./AppShell";

export function MobileBottomNav({
  destinations,
}: {
  destinations: readonly PrimaryDestination[];
}) {
  return (
    <nav aria-label="Mobile primary navigation" className="v2-mobile-nav">
      {destinations.map(({ label, to, index }) => (
        <NavLink key={to} to={to} aria-label={label}>
          <span className="v2-mobile-nav-mark" aria-hidden="true">{index}</span>
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
