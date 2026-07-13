// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { APP_ROUTE_PATHS } from "../routes";
import { AppShell, PRIMARY_DESTINATIONS } from "./AppShell";

function TestRoutes({ initialPath = "/today" }: { initialPath?: string }) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/inbox" element={<h1>Inbox</h1>} />
          <Route path="/today" element={<h1>Today</h1>} />
          <Route path="/projects" element={<h1>Projects</h1>} />
          <Route path="/review" element={<h1>Review</h1>} />
          <Route path="/settings" element={<h1>Settings</h1>} />
          <Route
            path="/settings/automation"
            element={<h1>Automation</h1>}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function linkNames(navigation: HTMLElement): string[] {
  return within(navigation)
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label") ?? "");
}

describe("V2 AppShell", () => {
  it("keeps exactly four primary destinations in the approved order", () => {
    expect(PRIMARY_DESTINATIONS.map(({ label }) => label)).toEqual([
      "Inbox",
      "Today",
      "Projects",
      "Review",
    ]);
    render(<TestRoutes />);

    const desktop = screen.getByRole("navigation", {
      name: "Primary navigation",
    });
    const mobile = screen.getByRole("navigation", {
      name: "Mobile primary navigation",
    });
    expect(linkNames(desktop)).toEqual(["Inbox", "Today", "Projects", "Review"]);
    expect(linkNames(mobile)).toEqual(["Inbox", "Today", "Projects", "Review"]);
    expect(within(desktop).queryByRole("link", { name: "Settings" })).toBeNull();
    expect(within(mobile).queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("marks the active destination in desktop and mobile navigation", () => {
    render(<TestRoutes initialPath="/projects" />);
    const current = screen.getAllByRole("link", { name: "Projects" });
    expect(current).toHaveLength(2);
    for (const link of current) expect(link).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(2);
  });

  it("keeps Settings in a utility menu and restores trigger focus on close", async () => {
    render(<TestRoutes />);
    const trigger = screen.getByRole("button", { name: "Open utility menu" });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const utilities = screen.getByRole("navigation", {
      name: "Workspace utilities",
    });
    expect(utilities).toBeVisible();
    expect(within(utilities).getByRole("link", { name: "Settings" })).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("navigation", { name: "Workspace utilities" }),
      ).toBeNull(),
    );
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Workspace utilities" }),
      ).getByRole("link", { name: "Settings" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible(),
    );
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("focuses and announces the page heading after navigation", async () => {
    render(<TestRoutes initialPath="/today" />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Today" })).toHaveFocus(),
    );

    fireEvent.click(
      within(
        screen.getByRole("navigation", { name: "Primary navigation" }),
      ).getByRole("link", { name: "Projects" }),
    );
    const heading = await screen.findByRole("heading", { name: "Projects" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Projects");
  });

  it("publishes the complete shell route contract", () => {
    expect(APP_ROUTE_PATHS).toEqual([
      "/setup",
      "/migration",
      "/inbox",
      "/inbox/actions",
      "/today",
      "/today/calendar",
      "/projects",
      "/projects/:projectId/:stage",
      "/review",
      "/settings",
      "/settings/automation",
    ]);
  });
});
