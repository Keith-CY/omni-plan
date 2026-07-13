// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../../domain/commands";
import type { CapacityProfile, WorkspaceV2 } from "../../domain/types";
import { buildCapacityProfile, buildWorkspaceV2 } from "../../tests/builders";
import {
  isOperationalV2WorkspaceState,
  useV2Workspace,
  type V2WorkspaceRuntime,
} from "../state/V2WorkspaceProvider";
import { renderV2 } from "../test/renderV2";
import { CapacitySetupPage } from "./CapacitySetupPage";

const NOW = "2026-07-14T03:00:00.000Z";

function applied(workspace: WorkspaceV2): CommandResult {
  return { ok: true, workspace, receipt: {} as never };
}

function setupRuntime(
  dispatch: (
    command: V2Command,
    context: CommandContext,
  ) => Promise<CommandResult>,
): V2WorkspaceRuntime {
  const workspace = buildWorkspaceV2("personal");
  return {
    bootstrap: {
      resolve: vi.fn(async () => ({
        status: "setup_required" as const,
        workspace,
      })),
    },
    commands: { dispatch },
    systemEvents: {
      run: vi.fn(async () => workspace),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => "capacity-command-1",
  };
}

function OperationalGate({ children }: { children: ReactNode }) {
  const state = useV2Workspace();
  return isOperationalV2WorkspaceState(state) ? children : null;
}

function renderSetup(
  runtime: V2WorkspaceRuntime,
  calibrationSuggestion?: CapacityProfile,
) {
  return renderV2(
    <Routes>
      <Route
        path="/setup"
        element={
          <OperationalGate>
            <CapacitySetupPage calibrationSuggestion={calibrationSuggestion} />
          </OperationalGate>
        }
      />
      <Route path="/today" element={<h1>Today</h1>} />
    </Routes>,
    { initialPath: "/setup", runtime },
  );
}

describe("CapacitySetupPage", () => {
  it("requires explicit Save and dispatches timezone, weekly windows, attention budgets, and unavailable blocks", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn(
      async (command: V2Command, _context: CommandContext) => {
        if (command.type !== "configure_capacity") {
          throw new Error(`Unexpected ${command.type}`);
        }
        return applied(
          buildWorkspaceV2("personal", {
            revision: 1,
            capacityProfile: command.profile,
          }),
        );
      },
    );
    renderSetup(setupRuntime(dispatch));

    expect(
      await screen.findByRole("heading", { name: "Set your capacity" }),
    ).toBeVisible();
    expect(dispatch).not.toHaveBeenCalled();
    await user.clear(screen.getByRole("textbox", { name: "Time zone" }));
    await user.type(
      screen.getByRole("textbox", { name: "Time zone" }),
      "Asia/Tokyo",
    );

    const monday = screen.getByRole("group", { name: "Monday capacity" });
    expect(within(monday).getByRole("checkbox", { name: "Workday" })).toBeChecked();
    await user.clear(within(monday).getByLabelText("Start"));
    await user.type(within(monday).getByLabelText("Start"), "08:30");
    await user.clear(within(monday).getByLabelText("Finish"));
    await user.type(within(monday).getByLabelText("Finish"), "16:30");
    await user.clear(within(monday).getByLabelText("Deep hours"));
    await user.type(within(monday).getByLabelText("Deep hours"), "3.5");
    await user.clear(within(monday).getByLabelText("Medium hours"));
    await user.type(within(monday).getByLabelText("Medium hours"), "2");
    await user.clear(within(monday).getByLabelText("Shallow hours"));
    await user.type(within(monday).getByLabelText("Shallow hours"), "1");

    await user.click(
      screen.getByRole("button", { name: "Add unavailable block" }),
    );
    await user.type(
      screen.getByLabelText("Unavailable start 1"),
      "2026-07-20T09:00",
    );
    await user.type(
      screen.getByLabelText("Unavailable finish 1"),
      "2026-07-20T10:00",
    );
    expect(dispatch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const command = dispatch.mock.calls[0]?.[0];
    expect(command?.type).toBe("configure_capacity");
    if (command?.type !== "configure_capacity") {
      throw new Error("Expected configure_capacity command");
    }
    expect(command.profile.timeZone).toBe("Asia/Tokyo");
    expect(command.profile.weeklyWindows).toContainEqual({
      weekday: 1,
      startMinute: 510,
      finishMinute: 990,
    });
    expect(command.profile.dailyBudgets).toContainEqual({
      weekday: 1,
      deepSeconds: 12_600,
      mediumSeconds: 7_200,
      shallowSeconds: 3_600,
    });
    expect(command.profile.unavailableBlocks).toHaveLength(1);
    expect(command.profile.unavailableBlocks[0]?.id).not.toBe("");
    expect(
      Date.parse(command.profile.unavailableBlocks[0]?.start ?? ""),
    ).toBeLessThan(
      Date.parse(command.profile.unavailableBlocks[0]?.finish ?? ""),
    );
    expect(await screen.findByRole("heading", { name: "Today" })).toBeVisible();
  });

  it("keeps an actual-history calibration suggestion as a draft until Save", async () => {
    const user = userEvent.setup();
    const suggestion = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 2, startMinute: 600, finishMinute: 900 },
      ],
      dailyBudgets: [
        {
          weekday: 2,
          deepSeconds: 7_200,
          mediumSeconds: 3_600,
          shallowSeconds: 1_800,
        },
      ],
      updatedAt: NOW,
      updatedBy: "history-calibration",
    });
    const dispatch = vi.fn(async () => {
      throw new Error("Suggestion must not auto-dispatch");
    });
    renderSetup(setupRuntime(dispatch), suggestion);

    expect(
      await screen.findByText("Suggested from your recent actuals"),
    ).toBeVisible();
    expect(dispatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use suggestion" }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Time zone" })).toHaveValue(
      "UTC",
    );
  });

  it("preserves a domain-valid end-of-day window when accepting a suggestion", async () => {
    const user = userEvent.setup();
    const suggestion = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 0, startMinute: 0, finishMinute: 1_440 },
      ],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 3_600,
          mediumSeconds: 0,
          shallowSeconds: 0,
        },
      ],
      updatedAt: NOW,
      updatedBy: "history-calibration",
    });
    const dispatch = vi.fn(
      async (command: V2Command, _context: CommandContext) => {
        if (command.type !== "configure_capacity") {
          throw new Error(`Unexpected ${command.type}`);
        }
        return applied(
          buildWorkspaceV2("personal", {
            revision: 1,
            capacityProfile: command.profile,
          }),
        );
      },
    );
    renderSetup(setupRuntime(dispatch), suggestion);

    await user.click(
      await screen.findByRole("button", { name: "Use suggestion" }),
    );
    const sunday = screen.getByRole("group", { name: "Sunday capacity" });
    expect(within(sunday).getByLabelText("Finish")).toHaveValue("24:00");

    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    await waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const command = dispatch.mock.calls[0]?.[0];
    expect(command?.type).toBe("configure_capacity");
    if (command?.type !== "configure_capacity") {
      throw new Error("Expected configure_capacity command");
    }
    expect(command.profile.weeklyWindows).toEqual([
      { weekday: 0, startMinute: 0, finishMinute: 1_440 },
    ]);
  });

  it("rejects a cleared attention budget instead of silently saving zero", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn(async () => {
      throw new Error("Incomplete drafts must not dispatch");
    });
    renderSetup(setupRuntime(dispatch));

    const monday = await screen.findByRole("group", {
      name: "Monday capacity",
    });
    await user.clear(within(monday).getByLabelText("Deep hours"));
    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "finite nonnegative integer seconds",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "capacity_profile:daily_budget:0",
    );
  });

  it("shows stable validation guidance without dispatching an invalid profile", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn(async () => {
      throw new Error("Invalid drafts must not dispatch");
    });
    renderSetup(setupRuntime(dispatch));

    const timeZone = await screen.findByRole("textbox", { name: "Time zone" });
    await user.clear(timeZone);
    await user.type(timeZone, "Not/A_Timezone");
    await user.click(screen.getByRole("button", { name: "Save capacity" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Capacity timezone",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "capacity_profile:time_zone",
    );
  });
});
