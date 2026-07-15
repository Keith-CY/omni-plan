// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BootstrapState } from "../repositories/bootstrapService";
import { buildCapacityProfile, buildWorkspaceV2 } from "../tests/builders";
import { V2Routes } from "./routes";
import type { V2WorkspaceRuntime } from "./state/V2WorkspaceProvider";
import { renderV2 } from "./test/renderV2";

const NOW = "2026-07-14T03:00:00.000Z";

function runtime(state: BootstrapState): V2WorkspaceRuntime {
  const workspace =
    state.status === "ready" || state.status === "setup_required"
      ? state.workspace
      : undefined;
  return {
    bootstrap: { resolve: vi.fn(async () => state) },
    commands: {
      dispatch: vi.fn(async () => {
        throw new Error("No shell placeholder may dispatch a command");
      }),
    },
    systemEvents: {
      run: vi.fn(async () => workspace),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => "route-command-1",
  };
}

describe("V2 route bootstrap contract", () => {
  it("redirects a ready root deterministically to Today", async () => {
    const workspace = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });
    renderV2(<V2Routes />, {
      initialPath: "/",
      runtime: runtime({ status: "ready", workspace }),
    });

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Today" })).toHaveFocus(),
    );
    expect(screen.getByLabelText("Today workspace summary")).toHaveAttribute(
      "data-readonly",
      "true",
    );
  });

  it("serves the interactive Actions utility at /inbox/actions", async () => {
    const workspace = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({
        updatedAt: NOW,
        updatedBy: "human-1",
      }),
    });
    renderV2(<V2Routes />, {
      initialPath: "/inbox/actions",
      runtime: runtime({ status: "ready", workspace }),
    });

    expect(
      await screen.findByRole("heading", { name: "Actions", level: 1 }),
    ).toBeVisible();
    expect(
      screen.getByText("Inbox utility · not a fifth destination"),
    ).toBeVisible();
    expect(screen.getByText("No open Actions")).toBeVisible();
    expect(screen.queryByText(/Read-only shell view/)).toBeNull();
  });

  it("routes an unconfigured Workspace only to setup", async () => {
    const workspace = buildWorkspaceV2("personal");
    renderV2(<V2Routes />, {
      initialPath: "/projects",
      runtime: runtime({ status: "setup_required", workspace }),
    });
    expect(
      await screen.findByRole("heading", { name: "Set your capacity" }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
  });

  it("routes V1 data only to migration", async () => {
    renderV2(<V2Routes />, {
      initialPath: "/today",
      runtime: runtime({ status: "migration_required", rawV1Payload: "{}" }),
    });
    expect(
      await screen.findByRole("heading", { name: "Migration required" }),
    ).toBeVisible();
  });

  it("routes recovery state to an explicit write-paused page", async () => {
    renderV2(<V2Routes />, {
      initialPath: "/today",
      runtime: runtime({
        status: "recovery_error",
        recovery: {
          sourceChecksum: null,
          backupId: "backup-1",
          backupChecksum: "checksum-1",
          code: "V1_PARSE_FAILED",
          message: "Review recovery",
          occurredAt: NOW,
        },
      }),
    });
    expect(
      await screen.findByRole("heading", { name: "Migration recovery" }),
    ).toBeVisible();
    expect(screen.getByText("Review recovery")).toBeVisible();
  });
});
