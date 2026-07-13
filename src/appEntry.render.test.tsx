// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: () => ({ render: vi.fn() }),
  },
}));

import { V1_APP_MARKER, renderApp as renderV1 } from "./V1Entry";
import {
  V2_APP_MARKER,
  renderApp as renderV2,
} from "./v2/app/entry";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  document.body.replaceChildren();
});

describe("generation entry render markers", () => {
  it.each([
    ["v1", V1_APP_MARKER, renderV1],
    ["v2", V2_APP_MARKER, renderV2],
  ] as const)(
    "renders the selected %s marker onto the root",
    (generation, marker, renderApp) => {
      const root = document.createElement("div");
      document.body.append(root);

      renderApp(root);

      expect(root.dataset.appGeneration).toBe(generation);
      expect(root.dataset.appMarker).toBe(marker);
    },
  );
});
