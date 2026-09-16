// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultExternalServiceSettings } from "../../domain/settings";
import { ConnectivitySettingsPanel } from "./ConnectivitySettingsPanel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

describe("ConnectivitySettingsPanel", () => {
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

  it("keeps optional service credentials out of the default settings path", async () => {
    await act(async () => {
      root.render(createElement(ConnectivitySettingsPanel, {
        settings: defaultExternalServiceSettings,
        sessionPassphrase: "",
        onSave: vi.fn(),
        onPullCaptures: vi.fn(async () => 0)
      }));
    });

    expect(container.querySelector('input[placeholder="op_owner_…"]')).toBeNull();
    const reveal = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("连接私人服务（可选）"));
    expect(reveal).toBeDefined();

    await act(async () => {
      reveal?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('input[placeholder="op_owner_…"]')).not.toBeNull();
  });
});
