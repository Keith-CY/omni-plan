import { Outlet } from "react-router-dom";

import { DesktopSidebar } from "./DesktopSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileUtilityMenu } from "./MobileUtilityMenu";
import { RouteFocusManager } from "./RouteFocusManager";

export interface PrimaryDestination {
  label: "Inbox" | "Today" | "Projects" | "Review";
  to: string;
  index: string;
}

export const PRIMARY_DESTINATIONS = [
  { label: "Inbox", to: "/inbox", index: "01" },
  { label: "Today", to: "/today", index: "02" },
  { label: "Projects", to: "/projects", index: "03" },
  { label: "Review", to: "/review", index: "04" },
] as const satisfies readonly PrimaryDestination[];

export function AppShell() {
  return (
    <div className="v2-app-shell">
      <a className="v2-skip-link" href="#v2-main">Skip to current page</a>
      <DesktopSidebar destinations={PRIMARY_DESTINATIONS} />
      <header className="v2-mobile-header">
        <div className="v2-mobile-wordmark">OmniPlan</div>
        <MobileUtilityMenu />
      </header>
      <main id="v2-main" className="v2-page-surface" tabIndex={-1}>
        <RouteFocusManager />
        <Outlet />
      </main>
      <MobileBottomNav destinations={PRIMARY_DESTINATIONS} />
    </div>
  );
}
