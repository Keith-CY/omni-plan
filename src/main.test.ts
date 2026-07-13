// @vitest-environment jsdom
import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const entryMocks = vi.hoisted(() => ({
  loadGeneration: vi.fn(),
  renderApp: vi.fn(),
}));

vi.mock("./appEntry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./appEntry")>();
  return { ...actual, loadGeneration: entryMocks.loadGeneration };
});

beforeEach(() => {
  vi.resetModules();
  entryMocks.loadGeneration.mockReset();
  entryMocks.renderApp.mockReset();
  entryMocks.loadGeneration.mockResolvedValue({
    renderApp: entryMocks.renderApp,
  });
  document.body.innerHTML = '<div id="root"></div>';
});

describe("application bootstrap wiring", () => {
  it("renders the compiled generation into the real document root", async () => {
    const root = document.getElementById("root");
    if (root === null) throw new Error("Expected test root");

    await import("./main");

    await waitFor(() => expect(entryMocks.renderApp).toHaveBeenCalledOnce());
    expect(entryMocks.loadGeneration).toHaveBeenCalledWith("v1");
    expect(entryMocks.renderApp).toHaveBeenCalledWith(root);
  });
});
