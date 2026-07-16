// @vitest-environment jsdom
import { readFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { PRIMARY_DESTINATIONS } from "./AppShell";
import { DesktopSidebar } from "./DesktopSidebar";
import { MobileBottomNav } from "./MobileBottomNav";
import { MobileUtilityMenu } from "./MobileUtilityMenu";

const V2_CSS = readFileSync("src/v2/app/v2.css", "utf8");
const MOBILE_TEST_OVERRIDE = `
  .v2-mobile-nav { display: grid; }
  .v2-mobile-utility { display: block; }
`;

function minimumTargetSize(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const pixels = (value: string | undefined): number => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return Math.max(
    pixels(style.minBlockSize),
    pixels(style.minHeight),
  );
}

describe("V2 target sizing", () => {
  it("keeps every visible shell, mobile, bootstrap, and Agent target at least 44 CSS pixels high", () => {
    render(
      <MemoryRouter initialEntries={["/today"]}>
        <>
          <style>{V2_CSS + MOBILE_TEST_OVERRIDE}</style>
          <div className="v2-app-shell">
            <DesktopSidebar destinations={PRIMARY_DESTINATIONS} />
          </div>
          <MobileBottomNav destinations={PRIMARY_DESTINATIONS} />
          <MobileUtilityMenu />
          <section aria-label="Agent and bootstrap control contract">
            <button type="button">Dispatch command</button>
            <input aria-label="Input contract" />
            <select aria-label="Select contract"><option>One</option></select>
            <textarea aria-label="Textarea contract" />
          </section>
        </>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open utility menu" }));

    const targets = [
      ...screen.getAllByRole("link"),
      screen.getByRole("button", { name: "Open utility menu" }),
      screen.getByRole("button", { name: "Dispatch command" }),
      screen.getByRole("textbox", { name: "Input contract" }),
      screen.getByRole("combobox", { name: "Select contract" }),
      screen.getByRole("textbox", { name: "Textarea contract" }),
    ];
    for (const target of targets) {
      expect(minimumTargetSize(target), target.outerHTML).toBeGreaterThanOrEqual(44);
    }
  });

  it("keeps small editorial text tokens above WCAG AA contrast", () => {
    const token = (name: string): string => {
      const match = V2_CSS.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      if (match?.[1] === undefined) throw new Error(`Missing ${name} color token`);
      return match[1];
    };
    const luminance = (hex: string): number => {
      const channels = hex
        .slice(1)
        .match(/.{2}/g)
        ?.map((value) => Number.parseInt(value, 16) / 255)
        .map((value) =>
          value <= 0.04045
            ? value / 12.92
            : ((value + 0.055) / 1.055) ** 2.4,
        );
      if (channels === undefined) throw new Error(`Invalid color ${hex}`);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (foreground: string, background: string): number => {
      const light = Math.max(luminance(foreground), luminance(background));
      const dark = Math.min(luminance(foreground), luminance(background));
      return (light + 0.05) / (dark + 0.05);
    };

    const paper = token("--v2-paper");
    expect(contrast(token("--v2-muted"), paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("--v2-signal-text"), paper)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps Project links and disclosure summaries at least 44 CSS pixels high", () => {
    const { container } = render(
      <MemoryRouter>
        <>
          <style>{V2_CSS}</style>
          <a className="v2-project-header__back" href="/projects">Back to Projects</a>
          <article className="v2-project-card">
            <h2><a href="/projects/project-1/direction">Project name</a></h2>
            <details className="v2-project-diagnostics"><summary>Project record</summary></details>
            <div className="v2-hold-list"><details><summary>Hold record</summary></details></div>
            <div className="v2-project-next-action"><details><summary>Gate detail</summary></details></div>
            <div className="v2-lifecycle-step"><details><summary>Unlock command</summary></details></div>
            <section className="v2-bet-stage">
              <button className="v2-button--primary" type="button">Review Bet</button>
            </section>
            <article className="v2-bet-history-entry">
              <details><summary>Immutable Bet snapshot</summary></details>
            </article>
            <details className="v2-plan-stage-summary__details">
              <summary>Plan diagnostics</summary>
            </details>
          </article>
        </>
      </MemoryRouter>,
    );

    const targets = [...container.querySelectorAll<HTMLElement>("a, button, summary")];
    expect(targets).toHaveLength(9);
    for (const target of targets) {
      expect(minimumTargetSize(target), target.outerHTML).toBeGreaterThanOrEqual(44);
    }
  });
});
