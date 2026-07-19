// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { JSDOM } from "jsdom";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { BrowserWorkspaceRepository, WORKSPACE_STORAGE_KEY } from "./domain/storage";
import type { Project, WorkItem, WorkspaceSnapshot } from "./domain/types";
import { createEmptyWorkspace } from "./domain/workspace";

const bunDom = typeof window === "undefined" || typeof document === "undefined"
  ? new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" })
  : undefined;

if (bunDom) {
  const domWindow = bunDom.window;
  Object.assign(globalThis, {
    window: domWindow,
    self: domWindow,
    document: domWindow.document,
    navigator: domWindow.navigator,
    localStorage: domWindow.localStorage,
    sessionStorage: domWindow.sessionStorage,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    HTMLAnchorElement: domWindow.HTMLAnchorElement,
    HTMLButtonElement: domWindow.HTMLButtonElement,
    Event: domWindow.Event,
    CustomEvent: domWindow.CustomEvent,
    MouseEvent: domWindow.MouseEvent,
    Node: domWindow.Node,
    Storage: domWindow.Storage,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow)
  });
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, __BUILD_COMMIT__: "test" });

const projectId = "calendar-click-project";

let root: Root | undefined;
let container: HTMLDivElement | undefined;

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function calendarFixture(): { targetDay: string; workspace: WorkspaceSnapshot } {
  const today = new Date().toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const targetDate = Number(today.slice(8, 10)) === 13 ? 14 : 13;
  const targetDay = `${month}-${String(targetDate).padStart(2, "0")}`;
  const project: Project = {
    id: projectId,
    name: "Calendar click test",
    status: "active",
    mode: "maintain",
    priority: 1,
    northStar: "Keep calendar selection explicit.",
    currentOutcome: "Clicking a date selects it.",
    horizon: `${month}-28T00:00:00.000Z`,
    start: `${month}-01T00:00:00.000Z`,
    reviewCadenceDays: 7
  };
  const workItem: WorkItem = {
    id: "calendar-click-event",
    projectId,
    kind: "task",
    title: "Event inside target day",
    outline: "1",
    durationSeconds: 3_600,
    estimate: { mostLikelySeconds: 3_600 },
    constraint: { fixedStart: `${targetDay}T00:00:00.000Z` },
    assignmentIds: [],
    percentComplete: 0
  };

  return {
    targetDay,
    workspace: {
      ...createEmptyWorkspace(),
      timeZone: "UTC",
      projects: [project],
      workItems: [workItem]
    }
  };
}

function selectedDayPanel(): HTMLElement {
  const panel = container?.querySelector<HTMLElement>(".calendarWorkspace > :last-child");
  if (!panel) throw new Error("Selected-day panel was not rendered.");
  return panel;
}

function expectedSelectedDayLabel(day: string): string {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    weekday: "short"
  }).format(new Date(`${day}T00:00:00.000Z`));
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = read();
    if (value) return value;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    });
  }
  throw new Error("Calendar fixture did not render in time.");
}

async function renderCalendar() {
  const { App } = await import("./App");
  const fixture = calendarFixture();
  const repository = new BrowserWorkspaceRepository();
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, repository.exportWorkspace(fixture.workspace));
  window.location.hash = `#/calendar/${projectId}`;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(HashRouter, null, createElement(App)));
  });

  const selector = await eventually(() => container?.querySelector<HTMLButtonElement>(
    `.calendarDaySelector[aria-label^="${fixture.targetDay},"]`
  ) ?? undefined);
  const cell = selector.closest<HTMLElement>(".calendarDay");
  if (!cell) throw new Error("Target calendar cell was not rendered.");
  await eventually(() => cell.querySelector<HTMLElement>(".calendarEventChip") ?? undefined);
  return { ...fixture, cell, selector };
}

describe("calendar day selection", () => {
  beforeEach(() => {
    const storage = new MemoryStorage();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage
    });
    document.body.replaceChildren();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = undefined;
    container = undefined;
    window.localStorage.clear();
  });

  afterAll(() => bunDom?.window.close());

  it("updates the selected-day panel when the blank area of a date cell is clicked", async () => {
    const { targetDay, cell } = await renderCalendar();

    await act(async () => {
      cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(selectedDayPanel().querySelector("h3")?.textContent?.trim()).toBe(expectedSelectedDayLabel(targetDay));
    expect(cell.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the explicit date selector as a working selection control", async () => {
    const { targetDay, cell, selector } = await renderCalendar();
    await act(async () => {
      selector.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(selectedDayPanel().querySelector("h3")?.textContent?.trim()).toBe(expectedSelectedDayLabel(targetDay));
    expect(cell.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps event chip children as independent navigation targets", async () => {
    const { cell } = await renderCalendar();
    const eventChip = cell.querySelector<HTMLAnchorElement>(".calendarEventChip");
    const eventTitle = eventChip?.querySelector<HTMLElement>("span");
    if (!eventChip || !eventTitle) throw new Error("Target calendar event chip was not rendered.");
    const selectedDayBeforeClick = selectedDayPanel().querySelector("h3")?.textContent?.trim();
    eventChip.addEventListener("click", (event) => event.preventDefault());

    await act(async () => {
      eventTitle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(selectedDayPanel().querySelector("h3")?.textContent?.trim()).toBe(selectedDayBeforeClick);
    expect(cell.getAttribute("aria-selected")).toBe("false");
  });
});
