// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickTaskCapture } from "./QuickTaskCapture";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

async function render(onCapture = vi.fn(() => "task-1"), onUndo = vi.fn()) {
  await act(async () => {
    root.render(createElement(QuickTaskCapture, { onCapture, onUndo }));
  });
  return { onCapture, onUndo };
}

async function setValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("QuickTaskCapture", () => {
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

  it("does not submit while a Chinese IME composition is active", async () => {
    const { onCapture } = await render();
    const input = container.querySelector("input");
    const form = container.querySelector("form");
    if (!input || !form) throw new Error("Capture form missing.");

    await setValue(input, "整理产品方案");
    await act(async () => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await submit(form);
    expect(onCapture).not.toHaveBeenCalled();

    await act(async () => input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await submit(form);
    expect(onCapture).toHaveBeenCalledWith("整理产品方案");
  });

  it("clears after every successful capture and supports undo", async () => {
    const onCapture = vi.fn()
      .mockReturnValueOnce("task-1")
      .mockReturnValueOnce("task-2");
    const onUndo = vi.fn();
    await render(onCapture, onUndo);
    const input = container.querySelector("input");
    const form = container.querySelector("form");
    if (!input || !form) throw new Error("Capture form missing.");

    await setValue(input, "第一件事");
    await submit(form);
    expect(input.value).toBe("");
    await setValue(input, "第二件事");
    await submit(form);
    expect(onCapture.mock.calls).toEqual([["第一件事"], ["第二件事"]]);

    const undo = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("撤销"));
    if (!undo) throw new Error("Undo action missing.");
    await act(async () => undo.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onUndo).toHaveBeenCalledWith("task-2");
  });
});
