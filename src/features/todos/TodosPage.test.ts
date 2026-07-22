// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEmptyWorkspace } from "../../domain/workspace";
import type { Project, Todo, WorkspaceSnapshot } from "../../domain/types";
import { TodosPage, type TodosPageProps } from "./TodosPage";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// React's legacy input polyfill and Radix FocusScope probe these browser APIs.
// JSDOM supplies MutationObserver but not the old IE event hooks.
if (!("attachEvent" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "attachEvent", { configurable: true, value: () => undefined });
}
if (!("detachEvent" in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, "detachEvent", { configurable: true, value: () => undefined });
}
if (!("MutationObserver" in globalThis) && window.MutationObserver) {
  Object.assign(globalThis, { MutationObserver: window.MutationObserver });
}

const now = "2026-07-22T00:00:00.000Z";

function todo(overrides: Partial<Todo> & Pick<Todo, "id" | "title">): Todo {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    tags: [],
    flagged: false,
    checklist: [],
    status: "open",
    capturedAt: now,
    updatedAt: now,
    inbox: true,
    ...rest
  };
}

function project(overrides: Partial<Project> & Pick<Project, "id" | "name">): Project {
  const { id, name, ...rest } = overrides;
  return {
    id,
    name,
    status: "active",
    mode: "build",
    priority: 1,
    northStar: "Ship useful work",
    currentOutcome: "A working flow",
    horizon: now,
    start: now,
    planningMethod: "omniplan",
    reviewCadenceDays: 7,
    ...rest
  };
}

function snapshot(): WorkspaceSnapshot {
  return {
    ...createEmptyWorkspace(),
    timeZone: "UTC",
    todos: [
      todo({ id: "todo-inbox", title: "Inbox thought" }),
      todo({ id: "todo-flagged", title: "Flagged call", inbox: false, flagged: true, tags: ["calls"] }),
      todo({ id: "todo-done", title: "Finished errand", inbox: false, status: "completed", completedAt: now })
    ],
    projects: [
      project({ id: "project-plan", name: "Launch plan" }),
      project({
        id: "project-shape",
        name: "Shape a bet",
        planningMethod: "shape-up",
        shapeUpPitch: {
          problem: "A problem",
          appetiteKind: "small-batch",
          appetiteDays: 7,
          solutionSketch: "A sketch",
          rabbitHoles: "None",
          noGos: "None",
          successBaseline: "One result",
          scopes: [
            { id: "scope-core", title: "Core flow", description: "The core", confirmed: true, hillPosition: 0 }
          ],
          createdAt: now,
          updatedAt: now
        }
      })
    ]
  };
}

function callbacks(overrides: Partial<TodosPageProps> = {}): TodosPageProps {
  return {
    snapshot: snapshot(),
    onUpdateTodo: vi.fn(),
    onCompleteTodo: vi.fn(),
    onRestoreTodo: vi.fn(),
    onKeepAsTodo: vi.fn(),
    onConvertToTask: vi.fn(),
    onConvertToProject: vi.fn(),
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

async function render(props: TodosPageProps) {
  await act(async () => {
    root.render(createElement(TodosPage, props));
  });
}

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label ||
      candidate.textContent?.trim().startsWith(label)
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

async function click(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function change(target: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value");
    descriptor?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("TodosPage", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it("keeps Inbox, open Todos, and Completed as distinct views", async () => {
    await render(callbacks());

    expect(container.textContent).toContain("Inbox thought");
    expect(container.textContent).not.toContain("Flagged call");
    expect(container.textContent).not.toContain("Finished errand");

    await click(button("All"));
    expect(container.textContent).toContain("Inbox thought");
    expect(container.textContent).toContain("Flagged call");
    expect(container.textContent).not.toContain("Finished errand");

    await click(button("Completed"));
    expect(container.textContent).toContain("Finished errand");
    expect(container.textContent).not.toContain("Inbox thought");
  });

  it("completes and restores through controlled callbacks", async () => {
    const onCompleteTodo = vi.fn();
    const onRestoreTodo = vi.fn();
    await render(callbacks({ onCompleteTodo, onRestoreTodo }));

    await click(button("Complete Inbox thought"));
    expect(onCompleteTodo).toHaveBeenCalledWith("todo-inbox");

    await click(button("Completed"));
    await click(button("Restore Finished errand"));
    expect(onRestoreTodo).toHaveBeenCalledWith("todo-done");
  });

  it("edits the Plan date and creates a fixed-time manual weekly repeat with useful defaults", async () => {
    const onUpdateTodo = vi.fn();
    await render(callbacks({ onUpdateTodo }));

    await click(button("Edit Inbox thought"));
    const planDate = container.querySelector<HTMLInputElement>('input[aria-label="Plan date"]');
    if (!planDate) throw new Error("Plan date input was not rendered.");
    await click(button("Set plan date to Today"));
    expect(planDate.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const repeatCadence = container.querySelector<HTMLSelectElement>('select[aria-label="Repeat cadence"]');
    if (!repeatCadence) throw new Error("Repeat cadence selector was not rendered.");
    await change(repeatCadence, "weekly");
    const startDate = container.querySelector<HTMLInputElement>('input[aria-label="Repeat start date"]');
    const startTime = container.querySelector<HTMLInputElement>('input[aria-label="Repeat start time"]');
    if (!startDate || !startTime) throw new Error("Repeat start controls were not rendered.");
    await change(startDate, "2026-07-25");
    await change(startTime, "10:30");
    await click(button("Save"));

    const patch = onUpdateTodo.mock.calls[0]?.[1];
    expect(patch).toMatchObject({
      plannedForDate: planDate.value,
      repeatRule: {
        cadence: "weekly",
        count: 4,
        startMode: "fixed-time",
        startAt: "2026-07-25T10:30:00.000Z",
        executionMode: "manual",
        endMode: "count"
      }
    });
  });

  it("preserves advanced repeat fields when changing cadence and clears the rule with None", async () => {
    const workspace = snapshot();
    workspace.todos[0] = todo({
      id: "todo-inbox",
      title: "Inbox thought",
      inbox: false,
      repeatRule: {
        id: "repeat-existing",
        cadence: "monthly",
        count: 8,
        startMode: "after-previous-finish",
        startAt: "2026-07-22T09:00:00.000Z",
        executionMode: "automatic",
        endMode: "until",
        until: "2026-12-31T23:59:00.000Z",
        reminderLeadSeconds: 3_600,
        automaticDurationSeconds: 1_800
      }
    });
    const onUpdateTodo = vi.fn();
    await render(callbacks({ snapshot: workspace, initialFilter: "all", onUpdateTodo }));

    await click(button("Edit Inbox thought"));
    const repeatCadence = container.querySelector<HTMLSelectElement>('select[aria-label="Repeat cadence"]');
    if (!repeatCadence) throw new Error("Repeat cadence selector was not rendered.");
    await change(repeatCadence, "weekly");
    await click(button("Save"));

    expect(onUpdateTodo.mock.calls[0]?.[1]?.repeatRule).toMatchObject({
      id: "repeat-existing",
      cadence: "weekly",
      count: 8,
      startMode: "after-previous-finish",
      executionMode: "automatic",
      endMode: "until",
      reminderLeadSeconds: 3_600,
      automaticDurationSeconds: 1_800
    });

    onUpdateTodo.mockClear();
    await click(button("Inbox thought"));
    const repeatCadenceAfterReopen = container.querySelector<HTMLSelectElement>('select[aria-label="Repeat cadence"]');
    if (!repeatCadenceAfterReopen) throw new Error("Repeat cadence selector was not rendered after reopening.");
    await change(repeatCadenceAfterReopen, "none");
    await click(button("Save"));
    expect(onUpdateTodo.mock.calls[0]?.[1]?.repeatRule).toBeUndefined();
  });

  it("confirms Task and Project conversion choices without mutating the snapshot", async () => {
    const workspace = snapshot();
    const original = structuredClone(workspace);
    const onConvertToTask = vi.fn();
    const onConvertToProject = vi.fn();
    await render(callbacks({ snapshot: workspace, onConvertToTask, onConvertToProject }));

    await click(button("Edit Inbox thought"));
    await click(button("Convert to Task"));
    const projectSelect = document.querySelector<HTMLSelectElement>(".todoDialog__fields select");
    if (!projectSelect) throw new Error("Project selector was not rendered.");
    await change(projectSelect, "project-shape");
    const scopeSelect = document.querySelectorAll<HTMLSelectElement>(".todoDialog__fields select")[1];
    if (!scopeSelect) throw new Error("Shape Up scope selector was not rendered.");
    await change(scopeSelect, "scope-core");
    const taskConfirm = document.querySelector<HTMLButtonElement>(".todoDialog__confirm");
    if (!taskConfirm) throw new Error("Task confirmation button was not rendered.");
    await click(taskConfirm);
    expect(onConvertToTask).toHaveBeenCalledWith({
      todoId: "todo-inbox",
      projectId: "project-shape",
      shapeUpScopeId: "scope-core"
    });

    await click(button("Inbox thought"));
    await click(button("Convert to Project"));
    await click(button("Create Project"));
    expect(onConvertToProject).toHaveBeenCalledWith({ todoId: "todo-inbox", planningMethod: "omniplan" });
    expect(workspace).toEqual(original);
  });
});
