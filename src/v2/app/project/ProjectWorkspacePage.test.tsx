// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../../tests/builders";
import type { WorkspaceV2 } from "../../domain/types";
import type { V2WorkspaceRuntime } from "../state/V2WorkspaceProvider";
import { renderV2 } from "../test/renderV2";
import { ProjectWorkspacePage } from "./ProjectWorkspacePage";
import {
  applyFixtureCommand,
  closingWorkspace as guidedClosingWorkspace,
  expiredValidatingWorkspace as guidedExpiredValidatingWorkspace,
  executingWorkspace as guidedExecutingWorkspace,
  GUIDED_PROJECT_ID,
  validatingWorkspace as guidedValidatingWorkspace,
} from "./test/guidedStageFixture";

const NOW = "2026-07-16T03:00:00.000Z";
const PROJECT_ID = "project:guided-shell";
const BRIEF_ID = "direction:guided-shell";
const BET_ID = "bet:guided-shell";

function workspace(stage: "direction" | "awaiting_bet" = "direction"): WorkspaceV2 {
  const project = buildProjectV2({
    id: PROJECT_ID,
    name: "Make planning humane",
    activeDirectionBriefId: BRIEF_ID,
    stage,
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-15T03:00:00.000Z",
  });
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-ui" }),
    projects: [project],
    directionBriefs: [
      buildDirectionBrief({
        id: BRIEF_ID,
        projectId: PROJECT_ID,
        appetiteSeconds: stage === "awaiting_bet" ? 14_400 : 0,
        firstScope: stage === "awaiting_bet" ? [{
          id: "scope:guided-shell",
          title: "Guided project lifecycle",
          description: "Lead one bounded result through Direction and Bet.",
        }] : [],
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }),
    ],
  });
}

function rebetWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    appetiteSeconds: 3_661,
    firstScope: [{
      id: "scope:guided-shell",
      title: "Guided project lifecycle",
      description: "Lead one bounded result through Direction and Bet.",
    }],
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-15T03:00:00.000Z",
  });
  const project = buildProjectV2({
    id: PROJECT_ID,
    name: "Make planning humane",
    activeDirectionBriefId: BRIEF_ID,
    activeBetId: BET_ID,
    stage: "planning",
    holds: [{
      type: "rebet_required",
      sourceId: BET_ID,
      affectedRecordIds: [PROJECT_ID, BET_ID],
      createdAt: "2026-07-15T03:00:00.000Z",
    }],
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-15T03:00:00.000Z",
  });
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-ui" }),
    projects: [project],
    directionBriefs: [brief],
    bets: [buildBetVersion({
      id: BET_ID,
      projectId: PROJECT_ID,
      briefId: BRIEF_ID,
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: "2026-07-15T03:00:00.000Z",
      appetiteEnd: "2026-07-15T04:01:01.000Z",
      actorId: "human-ui",
      approvedAt: "2026-07-15T03:00:00.000Z",
      invalidatedAt: "2026-07-15T03:00:00.000Z",
      invalidationReason: "Direction changed materially.",
    })],
  });
}

function planningWorkspace(): WorkspaceV2 {
  const source = workspace("awaiting_bet");
  const brief = source.directionBriefs[0];
  source.projects[0] = {
    ...source.projects[0],
    stage: "planning",
    activeBetId: BET_ID,
  };
  source.bets = [buildBetVersion({
    id: BET_ID,
    projectId: PROJECT_ID,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-16T02:00:00.000Z",
    appetiteEnd: "2026-07-16T06:00:00.000Z",
    actorId: "human-ui",
    approvedAt: "2026-07-16T02:00:00.000Z",
  })];
  return source;
}

function crossOwnerBetWorkspace(): WorkspaceV2 {
  const source = workspace();
  const brief = source.directionBriefs[0];
  source.projects[0] = {
    ...source.projects[0],
    activeBetId: BET_ID,
    stage: "planning",
  };
  source.bets = [buildBetVersion({
    id: BET_ID,
    projectId: "project:other-owner",
    briefId: BRIEF_ID,
    briefSnapshot: structuredClone(brief),
    appetiteStart: "2026-07-14T03:00:00.000Z",
    appetiteEnd: "2026-07-20T03:00:00.000Z",
    actorId: "human-ui",
    approvedAt: "2026-07-14T03:00:00.000Z",
  })];
  return source;
}

function runtime(source: WorkspaceV2, now = NOW): V2WorkspaceRuntime {
  return {
    bootstrap: { resolve: vi.fn(async () => ({ status: "ready" as const, workspace: source })) },
    commands: {
      dispatch: vi.fn(async () => {
        throw new Error("The project lifecycle shell must not dispatch mutations");
      }),
    },
    systemEvents: {
      run: vi.fn(async () => source),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => now,
    createCommandId: () => "project-shell-command",
  };
}

function renderWorkspace(initialPath: string, source = workspace(), now = NOW) {
  renderV2(
    <Routes>
      <Route path="/projects/:projectId/:stage" element={<ProjectWorkspacePage />} />
    </Routes>,
    { initialPath, runtime: runtime(source, now) },
  );
}

describe("ProjectWorkspacePage", () => {
  it("shows the full textual lifecycle with one prominent current stage and exact future gates", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/direction`);

    expect(
      await screen.findByRole("heading", { name: "Make planning humane", level: 1 }),
    ).toBeVisible();
    const lifecycle = screen.getByRole("navigation", { name: "Project lifecycle" });
    expect(
      within(lifecycle).getByText(
        "Direction -> Bet -> Plan -> Execute -> Evidence -> Close",
      ),
    ).toBeVisible();
    expect(within(lifecycle).getByRole("link", { name: "Direction" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(within(lifecycle).getByText("Complete the Direction brief before placing a Bet.")).toBeVisible();
    expect(within(lifecycle).getByText("Place a human Bet before planning project work.")).toBeVisible();
    expect(within(lifecycle).getByText("Commit project work to Today before execution.")).toBeVisible();
    expect(within(lifecycle).getByText("Request validation before reviewing project evidence.")).toBeVisible();
    expect(within(lifecycle).getByText("Satisfy every validation requirement before Close.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Direction", level: 2 })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: "Appetite minutes" })).toBeVisible();
  });

  it.each([
    ["bet", "Complete the Direction brief before placing a Bet.", "update_direction"],
    ["plan", "Place a human Bet before planning project work.", "place_bet"],
    ["execute", "Commit project work to Today before execution.", "commit_today"],
    ["evidence", "Request validation before reviewing project evidence.", "request_validation"],
    ["close", "Satisfy every validation requirement before Close.", "satisfy_validation"],
  ])(
    "renders the %s deep link as a locked stage instead of mutation UI",
    async (stage, reason, nextCommand) => {
      renderWorkspace(`/projects/${PROJECT_ID}/${stage}`);

      const panel = await screen.findByRole("region", { name: `${stage} stage locked` });
      expect(within(panel).getByText(reason)).toBeVisible();
      expect(within(panel).getByText(nextCommand)).toBeVisible();
      expect(within(panel).queryByRole("textbox")).toBeNull();
      expect(within(panel).queryByRole("button")).toBeNull();
    },
  );

  it("links completed stages to immutable history while keeping Bet current", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/bet`, workspace("awaiting_bet"));

    const lifecycle = await screen.findByRole("navigation", { name: "Project lifecycle" });
    expect(within(lifecycle).getByRole("link", { name: "View Direction history" })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/direction?view=history`,
    );
    expect(within(lifecycle).getByRole("link", { name: "Bet" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(await screen.findByRole("region", { name: "Bet decision" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review Bet" })).toBeVisible();
  });

  it("renders completed-stage history links as immutable history with an explicit revision path", async () => {
    renderWorkspace(
      `/projects/${PROJECT_ID}/direction?view=history`,
      workspace("awaiting_bet"),
    );

    const history = await screen.findByRole("region", { name: "Direction immutable history" });
    expect(within(history).getByText(BRIEF_ID)).toBeVisible();
    expect(within(history).queryByRole("textbox")).toBeNull();
    expect(within(history).getByRole("link", { name: "Revise Direction" })).toHaveAttribute(
      "href",
      `/projects/${PROJECT_ID}/direction`,
    );
  });

  it("opens the guarded Direction editor when revising a completed Direction", async () => {
    const user = userEvent.setup();
    renderWorkspace(`/projects/${PROJECT_ID}/direction`, workspace("awaiting_bet"));

    expect(await screen.findByRole("heading", { name: "Direction", level: 2 })).toBeVisible();
    expect(screen.getByText("6 of 6 decisions complete")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Audience and problem" }));
    expect(screen.getByRole("textbox", { name: "Audience and problem" })).toBeVisible();
  });

  it("opens the Bet decision surface for a required Re-bet instead of swallowing it as history", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/bet`, rebetWorkspace());

    const rebet = await screen.findByRole("region", { name: "Re-bet decision" });
    expect(rebet).toBeVisible();
    expect(screen.getByRole("region", { name: "Bet immutable history" })).toBeVisible();
    expect(within(rebet).getByText("1 hour 1 minute 1 second")).toBeVisible();
    expect(within(rebet).queryByText("62 minutes")).toBeNull();
    expect(screen.getByRole("button", { name: "Review Re-bet" })).toBeVisible();
  });

  it("shows detailed Bet history for completed Bet routes and explicit history requests", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/bet`, planningWorkspace());

    expect(await screen.findByRole("region", { name: "Bet immutable history" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Bet v1" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /review re-bet/i })).toBeNull();

    cleanup();
    renderWorkspace(`/projects/${PROJECT_ID}/bet?view=history`, rebetWorkspace());
    expect(await screen.findByRole("region", { name: "Bet immutable history" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Re-bet decision" })).toBeNull();
  });

  it("renders the unlocked Plan route as a read-only deterministic summary", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/plan`, planningWorkspace());

    const summary = await screen.findByRole("region", { name: "Plan summary" });
    expect(within(summary).getByText("Guided project lifecycle")).toBeVisible();
    expect(within(summary).getByText("0 work items in the active Bet")).toBeVisible();
    expect(within(summary).queryByRole("button")).toBeNull();
    expect(within(summary).queryByRole("textbox")).toBeNull();
  });

  it("routes Execute, Evidence, and Close to real guided surfaces instead of the generic shell", async () => {
    const cases = [
      ["execute", await guidedExecutingWorkspace(), "Execute workspace"],
      ["evidence", await guidedValidatingWorkspace(), "Evidence workspace"],
      ["close", await guidedClosingWorkspace(), "Close decision"],
    ] as const;

    for (const [route, source, regionName] of cases) {
      renderWorkspace(`/projects/${GUIDED_PROJECT_ID}/${route}`, source);
      expect(await screen.findByRole("region", { name: regionName })).toBeVisible();
      expect(screen.queryByText(/Continue with the guided/i)).toBeNull();
      cleanup();
    }
  });

  it("keeps the validating Evidence route open for the exact appetite-boundary abandonment decision", async () => {
    const source = await guidedExpiredValidatingWorkspace();
    const appetiteEnd = source.bets.find(
      ({ id }) => id === source.projects[0].activeBetId,
    )!.appetiteEnd;

    renderWorkspace(
      `/projects/${GUIDED_PROJECT_ID}/evidence`,
      source,
      appetiteEnd,
    );

    expect(await screen.findByRole("region", {
      name: "Appetite boundary decision",
    })).toBeVisible();
    expect(screen.queryByRole("region", { name: "evidence stage locked" })).toBeNull();
  });

  it("returns a successfully closed Project to immutable Close history", async () => {
    const closing = await guidedClosingWorkspace();
    const closed = await applyFixtureCommand(
      closing,
      {
        type: "close_project",
        projectId: GUIDED_PROJECT_ID,
        decision: {
          id: "close:guided-history",
          projectId: GUIDED_PROJECT_ID,
          successComparison: "Observed result matched the Direction success evidence.",
          outcome: "achieved",
          keyLearning: "Explicit decisions kept the lifecycle auditable.",
          unfinishedDisposition: "historical_incomplete",
        },
      },
      "fixture:close-guided-history",
    );

    renderWorkspace(`/projects/${GUIDED_PROJECT_ID}/close`, closed);

    const history = await screen.findByRole("region", { name: "Close immutable history" });
    expect(within(history).getByText("close:guided-history")).toBeVisible();
    expect(within(history).queryByRole("textbox")).toBeNull();
    expect(within(history).queryByRole("button")).toBeNull();
  });

  it("fails closed before rendering project facts when the active Bet belongs to another Project", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/plan`, crossOwnerBetWorkspace());

    const recovery = await screen.findByRole("article", {
      name: `Project ${PROJECT_ID} recovery`,
    });
    expect(within(recovery).getByText(
      `Project ${PROJECT_ID} does not resolve to exactly one same-project active Bet ${BET_ID}.`,
    )).toBeVisible();
    expect(within(recovery).getByText("resolve_sync_conflict")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Make planning humane" })).toBeNull();
    expect(screen.queryByText("Bet expiry")).toBeNull();
  });

  it("fails closed before rendering Direction when the active brief is missing", async () => {
    const source = workspace();
    source.directionBriefs = [];
    renderWorkspace(`/projects/${PROJECT_ID}/direction`, source);

    const recovery = await screen.findByRole("article", {
      name: `Project ${PROJECT_ID} recovery`,
    });
    expect(within(recovery).getByText(
      `Project ${PROJECT_ID} does not resolve to exactly one same-project active Direction brief.`,
    )).toBeVisible();
    expect(within(recovery).getByText("resolve_sync_conflict")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Direction workspace" })).toBeNull();
  });

  it("redirects an unknown lifecycle segment to Direction", async () => {
    renderWorkspace(`/projects/${PROJECT_ID}/raw-status`);

    expect(await screen.findByRole("heading", { name: "Direction", level: 2 })).toBeVisible();
  });
});
