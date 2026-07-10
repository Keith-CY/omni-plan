// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("V2 UI test harness", () => {
  it("renders semantic UI in jsdom", () => {
    render(<button type="button">Commit today</button>);
    expect(screen.getByRole("button", { name: "Commit today" })).toBeVisible();
  });
});
