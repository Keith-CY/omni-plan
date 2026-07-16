// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceV2 } from "../../../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../../../tests/builders";
import type { V2WorkspaceRuntime } from "../../state/V2WorkspaceProvider";
import { renderV2 } from "../../test/renderV2";
import { PlanStageSummary } from "./PlanStageSummary";

const PROJECT_ID = "project:plan-summary";
const BRIEF_ID = "direction:plan-summary";
const BET_ID = "bet:plan-summary";
const START = "2026-07-16T03:00:00.000Z";

function planningWorkspace({
  withItems = false,
}: { withItems?: boolean } = {}): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    appetiteSeconds: 14_400,
    firstScope: [
      { id: "scope:one", title: "First boundary", description: "One outcome." },
      { id: "scope:two", title: "Second boundary", description: "Second outcome." },
    ],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: BET_ID,
    projectId: PROJECT_ID,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: START,
    appetiteEnd: "2026-07-16T07:00:00.000Z",
    actorId: "human-ui",
    approvedAt: START,
  });
  const workItems = withItems
    ? [
        buildProjectWorkItem({
          id: "work:one",
          projectId: PROJECT_ID,
          betScopeId: "scope:one",
          title: "One",
        }),
        buildProjectWorkItem({
          id: "work:two",
          projectId: PROJECT_ID,
          betScopeId: "scope:two",
          title: "Two",
        }),
        buildProjectWorkItem({
          id: "work:outside",
          projectId: "project:other",
          betScopeId: "scope:other",
          title: "Outside",
        }),
      ]
    : [];
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: START, updatedBy: "human-ui" }),
    projects: [
      buildProjectV2({
        id: PROJECT_ID,
        name: "Plan deterministically",
        stage: "planning",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        createdAt: brief.createdAt,
        updatedAt: START,
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
    workItems,
    dependencies: withItems
      ? [
          {
            id: "dependency:one-two",
            projectId: PROJECT_ID,
            fromId: "work:one",
            toId: "work:two",
            type: "FS",
            lagSeconds: 0,
            revision: 1,
          },
          {
            id: "dependency:two-one",
            projectId: PROJECT_ID,
            fromId: "work:two",
            toId: "work:one",
            type: "FS",
            lagSeconds: 0,
            revision: 1,
          },
          {
            id: "dependency:cross-project",
            projectId: PROJECT_ID,
            fromId: "work:one",
            toId: "work:outside",
            type: "FS",
            lagSeconds: 0,
            revision: 1,
          },
        ]
      : [],
  });
}

function runtime(
  source: WorkspaceV2,
  now = "2026-07-16T04:00:00.000Z",
): V2WorkspaceRuntime {
  return {
    bootstrap: {
      resolve: vi.fn(async () => ({ status: "ready" as const, workspace: source })),
    },
    commands: {
      dispatch: vi.fn(async () => { throw new Error("Plan summary is read-only"); }),
    },
    systemEvents: {
      run: vi.fn(async () => source),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => now,
    createCommandId: () => "plan-summary-command",
  };
}

describe("PlanStageSummary", () => {
  it("distinguishes a valid empty schedule and only describes the next work-item step", async () => {
    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(planningWorkspace()),
    });

    const summary = await screen.findByRole("region", { name: "Plan summary" });
    expect(within(summary).getByText("First boundary")).toBeVisible();
    expect(within(summary).getByText("Second boundary")).toBeVisible();
    expect(within(summary).getByText("0 work items in the active Bet")).toBeVisible();
    expect(within(summary).getByText("Valid empty schedule")).toBeVisible();
    expect(within(summary).getByText(/Create first work item/i)).toBeVisible();
    expect(within(summary).queryByRole("textbox")).toBeNull();
    expect(within(summary).queryByRole("button")).toBeNull();
    expect(within(summary).queryByRole("combobox")).toBeNull();
    expect(within(summary).queryByRole("spinbutton")).toBeNull();
  });

  it("shows scheduler diagnostics and unsupported boundaries without hiding either", async () => {
    const user = userEvent.setup();
    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(planningWorkspace({ withItems: true })),
    });

    const summary = await screen.findByRole("region", { name: "Plan summary" });
    expect(within(summary).getByText("2 work items in the active Bet")).toBeVisible();
    const diagnosticDetails = within(summary).getByText("Diagnostics (2)").closest("details");
    const unsupportedDetails = within(summary).getByText("Unsupported (1)").closest("details");
    expect(diagnosticDetails).not.toHaveAttribute("open");
    expect(unsupportedDetails).not.toHaveAttribute("open");
    await user.click(within(summary).getByText("Diagnostics (2)"));
    expect(diagnosticDetails).toHaveAttribute("open");
    expect(within(summary).getAllByText(/Circular dependency prevents a safe schedule/i)[0]).toBeVisible();
    await user.click(within(summary).getByText("Unsupported (1)"));
    expect(unsupportedDetails).toHaveAttribute("open");
    expect(within(summary).getByText(/Cross-project dependency dependency:cross-project is unsupported in V2/i)).toBeVisible();
  });

  it.each(["duplicate project identity", "wrong lifecycle stage", "ambiguous active Bet"])(
    "fails closed for %s",
    async (failure) => {
      const source = planningWorkspace();
      if (failure === "duplicate project identity") {
        source.projects.push({ ...source.projects[0] });
      } else if (failure === "wrong lifecycle stage") {
        source.projects[0].stage = "awaiting_bet";
      } else {
        source.bets.push({ ...source.bets[0] });
      }
      renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
        runtime: runtime(source),
      });

      const unavailable = await screen.findByRole("alert");
      expect(within(unavailable).getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
      expect(within(unavailable).queryByRole("button")).toBeNull();
      expect(within(unavailable).queryByRole("textbox")).toBeNull();
      expect(within(unavailable).queryByRole("combobox")).toBeNull();
      expect(within(unavailable).queryByRole("spinbutton")).toBeNull();
    },
  );

  it("treats a Re-bet hold as unavailable rather than a valid empty schedule", async () => {
    const source = planningWorkspace();
    source.projects[0].holds = [{
      type: "rebet_required",
      sourceId: BET_ID,
      affectedRecordIds: [PROJECT_ID, BET_ID],
      createdAt: START,
    }];
    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    expect(within(unavailable).queryByText(/Create first work item/i)).toBeNull();
  });

  it("fails closed when the injected current time reaches the Bet expiry", async () => {
    const source = planningWorkspace();
    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(source, source.bets[0].appetiteEnd),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/scheduler projection is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Plan summary" })).toBeNull();
  });

  it("fails closed before a future-dated Bet approval becomes effective", async () => {
    const source = planningWorkspace();
    source.bets[0].approvedAt = "2026-07-16T05:00:00.000Z";
    source.bets[0].appetiteStart = "2026-07-16T05:00:00.000Z";
    source.bets[0].appetiteEnd = "2026-07-16T09:00:00.000Z";

    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(source, "2026-07-16T04:00:00.000Z"),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByText(/future/i)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Plan summary" })).toBeNull();
  });

  it.each([
    ["extended appetite", (source: WorkspaceV2) => {
      source.bets[0].appetiteEnd = "2026-07-16T08:00:00.000Z";
    }],
    ["approval/start mismatch", (source: WorkspaceV2) => {
      source.bets[0].appetiteStart = "2026-07-16T02:00:00.000Z";
    }],
    ["scope outside the stored snapshot", (source: WorkspaceV2) => {
      source.bets[0].committedScope = [{
        id: "scope:forged",
        title: "Forged expansion",
        description: "Not approved in the Direction snapshot.",
      }];
    }],
    ["snapshot hash mismatch", (source: WorkspaceV2) => {
      const forgedScope = [{
        id: "scope:forged",
        title: "Forged expansion",
        description: "Changed in both duplicated fields after approval.",
      }];
      source.bets[0].briefSnapshot.firstScope = structuredClone(forgedScope);
      source.bets[0].committedScope = structuredClone(forgedScope);
    }],
  ])("fails closed for Bet integrity drift: %s", async (_failure, mutate) => {
    const source = planningWorkspace({ withItems: true });
    mutate(source);

    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Plan unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/Bet integrity/i)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Plan summary" })).toBeNull();
  });

  it("does not call policy-filtered existing work a valid empty schedule", async () => {
    const source = planningWorkspace({ withItems: true });
    const reviewId = "review:plan-overdue";
    source.reviews = [{
      id: reviewId,
      kind: "event",
      triggerKey: "hard_gate:plan-overdue",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [PROJECT_ID],
      affectedRecordIds: [PROJECT_ID],
      dueAt: START,
      createdAt: START,
      overdueMarkedAt: START,
    }];
    source.projects[0].holds = [{
      type: "review_overdue",
      sourceId: reviewId,
      affectedRecordIds: [PROJECT_ID],
      createdAt: START,
    }];

    renderV2(<PlanStageSummary projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const summary = await screen.findByRole("region", { name: "Plan summary" });
    expect(within(summary).getByText("2 work items in the active Bet")).toBeVisible();
    expect(within(summary).getByText(/0 items are currently schedulable/i)).toBeVisible();
    expect(within(summary).getByText(/overdue Review/i)).toBeVisible();
    expect(within(summary).queryByText("Valid empty schedule")).toBeNull();
    expect(within(summary).queryByText(/Create first work item/i)).toBeNull();
  });
});
