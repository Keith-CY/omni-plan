// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceV2 } from "../../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../../tests/builders";
import type { V2WorkspaceRuntime } from "../state/V2WorkspaceProvider";
import { renderV2 } from "../test/renderV2";
import {
  activeProjectBet,
  projectActionDestination,
} from "../project/ProjectHeader";
import { ProjectsPage } from "./ProjectsPage";

const NOW = "2026-07-16T03:00:00.000Z";
const PROJECT_ID = "project:lifecycle-shell";
const BRIEF_ID = "direction:lifecycle-shell";
const BET_ID = "bet:lifecycle-shell";
const LEGACY_ID = "legacy:migration-review";

function portfolioWorkspace(): WorkspaceV2 {
  const brief = buildDirectionBrief({
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    appetiteSeconds: 14_400,
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-14T03:00:00.000Z",
  });
  const project = buildProjectV2({
    id: PROJECT_ID,
    name: "Launch the field guide",
    activeDirectionBriefId: BRIEF_ID,
    activeBetId: BET_ID,
    stage: "planning",
    holds: [
      {
        type: "migration_review",
        sourceId: LEGACY_ID,
        affectedRecordIds: [PROJECT_ID],
        createdAt: "2026-07-15T03:00:00.000Z",
      },
    ],
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-15T03:00:00.000Z",
  });
  const archived = buildProjectV2({
    id: "project:archived",
    name: "Archived distraction",
    activeDirectionBriefId: "direction:archived",
    createdAt: "2026-07-12T03:00:00.000Z",
    updatedAt: "2026-07-12T03:00:00.000Z",
  });
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-ui" }),
    projects: [project, archived],
    directionBriefs: [
      brief,
      buildDirectionBrief({
        id: "direction:archived",
        projectId: archived.id,
        createdAt: archived.createdAt,
        updatedAt: archived.updatedAt,
      }),
    ],
    bets: [
      buildBetVersion({
        id: BET_ID,
        projectId: PROJECT_ID,
        briefId: BRIEF_ID,
        briefSnapshot: structuredClone(brief),
        committedScope: [
          { id: "scope:guide", title: "Guide", description: "Ship the guide." },
        ],
        appetiteStart: "2026-07-15T04:00:00.000Z",
        appetiteEnd: "2026-07-20T04:00:00.000Z",
        actorId: "human-ui",
        approvedAt: "2026-07-15T04:00:00.000Z",
      }),
    ],
    legacyAuditRecords: [
      {
        id: LEGACY_ID,
        projectId: PROJECT_ID,
        recordType: "audit_gate",
        sourcePayload: { source: "v1" },
        sourceChecksum: "legacy-checksum",
      },
    ],
    visibility: { archivedProjectIds: [archived.id] },
  });
}

function syncConflictWorkspace(): WorkspaceV2 {
  const workspace = portfolioWorkspace();
  const conflictId = "sync-conflict:lifecycle-shell";
  workspace.projects[0].holds = [{
    type: "sync_conflict",
    sourceId: conflictId,
    affectedRecordIds: [BET_ID],
    createdAt: "2026-07-15T05:00:00.000Z",
  }];
  workspace.legacyAuditRecords = [];
  workspace.syncConflicts = [{
    id: conflictId,
    recordType: "bet",
    recordId: BET_ID,
    projectId: PROJECT_ID,
    commonAncestorHash: "ancestor",
    localValue: { version: "local" },
    remoteValue: { version: "remote" },
    openedAt: "2026-07-15T04:00:00.000Z",
  }];
  return workspace;
}

function overdueReviewWorkspace(): WorkspaceV2 {
  const workspace = portfolioWorkspace();
  const reviewId = "review:lifecycle-shell";
  workspace.projects[0].holds = [{
    type: "review_overdue",
    sourceId: reviewId,
    affectedRecordIds: [reviewId],
    createdAt: "2026-07-15T05:00:00.000Z",
  }];
  workspace.legacyAuditRecords = [];
  workspace.reviews = [{
    id: reviewId,
    kind: "event",
    triggerKey: "hard_gate:lifecycle-shell",
    triggerType: "hard_gate",
    status: "open",
    affectedProjectIds: [],
    affectedRecordIds: [],
    createdAt: "2026-07-15T02:00:00.000Z",
    dueAt: "2026-07-15T03:00:00.000Z",
    overdueMarkedAt: "2026-07-15T04:00:00.000Z",
  }];
  return workspace;
}

function runtime(workspace: WorkspaceV2): V2WorkspaceRuntime {
  return {
    bootstrap: { resolve: vi.fn(async () => ({ status: "ready" as const, workspace })) },
    commands: {
      dispatch: vi.fn(async () => {
        throw new Error("The project lifecycle shell must not dispatch mutations");
      }),
    },
    systemEvents: {
      run: vi.fn(async () => workspace),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => "projects-shell-command",
  };
}

describe("ProjectsPage", () => {
  it("does not resolve an active Bet owned by another Project", () => {
    const workspace = portfolioWorkspace();
    workspace.bets[0] = {
      ...workspace.bets[0],
      projectId: "project:other-owner",
    };

    expect(activeProjectBet(workspace, workspace.projects[0])).toBeUndefined();
  });

  it.each([
    ["commit_today", "/today", "Open Today"],
    ["accept_replan", "/today", "Open Today"],
    ["record_actual", "/today", "Open Today"],
    ["resolve_sync_conflict", "/review", "Open Review"],
    ["complete_review", "/review", "Open Review"],
    ["create_review", "/review", "Open Review"],
    ["read_review_history", "/review", "Open Review"],
    ["update_direction", `/projects/${PROJECT_ID}/direction`, "Open Direction"],
    ["place_bet", `/projects/${PROJECT_ID}/bet`, "Open Bet"],
    ["record_bet_boundary", `/projects/${PROJECT_ID}/bet`, "Open Bet"],
    ["create_work_item", `/projects/${PROJECT_ID}/plan`, "Open Plan"],
    ["request_validation", `/projects/${PROJECT_ID}/evidence`, "Open Evidence"],
    ["attach_evidence", `/projects/${PROJECT_ID}/evidence`, "Open Evidence"],
    ["approve_evidence_exception", `/projects/${PROJECT_ID}/evidence`, "Open Evidence"],
    ["satisfy_validation", `/projects/${PROJECT_ID}/evidence`, "Open Evidence"],
    ["close_project", `/projects/${PROJECT_ID}/close`, "Open Close"],
  ])(
    "routes the %s command to its owning surface",
    (command, href, label) => {
      const workspace = portfolioWorkspace();
      expect(projectActionDestination(workspace.projects[0], command)).toEqual({
        href,
        label,
      });
    },
  );

  it("shows the guided lifecycle facts and exactly one recommended next action", async () => {
    const workspace = portfolioWorkspace();
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(workspace) },
    );

    const heading = await screen.findByRole("heading", { name: "Projects", level: 1 });
    expect(heading).toBeVisible();
    expect(screen.queryByText("Archived distraction")).toBeNull();

    const card = screen.getByRole("article", { name: "Launch the field guide" });
    const hold = within(card).getByRole("complementary", { name: "Active project holds" });
    expect(within(card).getByText("Plan", { selector: "strong" })).toBeVisible();
    expect(within(card).getByText("4 hours")).toBeVisible();
    expect(within(hold).getByText("Migration review")).toBeVisible();
    expect(within(hold).getByText("Active policy holds")).toBeVisible();
    expect(within(hold).queryByText("Operations paused")).toBeNull();
    expect(
      within(hold).getByText("Complete the guided migration review before changing project operations."),
    ).toBeVisible();
    expect(within(hold).getByText("Permitted next command:")).toBeVisible();
    expect(within(hold).getByText("place_bet")).toBeVisible();
    expect(within(card).getByRole("time", {
      name: "Bet expiry: Jul 20, 2026, 04:00 UTC",
    })).toHaveAttribute(
      "datetime",
      "2026-07-20T04:00:00.000Z",
    );
    expect(within(card).getByRole("time", {
      name: "Project last updated: 2026-07-15T03:00:00.000Z",
    })).toHaveAttribute("datetime", "2026-07-15T03:00:00.000Z");

    const recommendation = within(card).getByRole("region", {
      name: "Recommended next action",
    });
    expect(
      within(recommendation).getByText("Complete migration review for Project project:lifecycle-shell."),
    ).toBeVisible();
    expect(within(recommendation).getAllByRole("link")).toHaveLength(1);
    expect(within(recommendation).getByRole("link")).toHaveAttribute(
      "href",
      "/projects/project:lifecycle-shell/bet",
    );
  });

  it("never exposes raw status or lifecycle editing", async () => {
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(portfolioWorkspace()) },
    );

    const card = await screen.findByRole("article", { name: "Launch the field guide" });
    expect(within(card).queryByRole("combobox")).toBeNull();
    expect(within(card).queryByRole("textbox")).toBeNull();
    expect(within(card).queryByRole("spinbutton")).toBeNull();
    expect(within(card).queryByRole("button", { name: /status|stage/i })).toBeNull();
  });

  it("routes a sync-conflict recommendation to the Review resolution surface", async () => {
    const workspace = syncConflictWorkspace();
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(workspace) },
    );

    const recommendation = within(
      await screen.findByRole("article", { name: "Launch the field guide" }),
    ).getByRole("region", { name: "Recommended next action" });
    expect(within(recommendation).getByRole("link", { name: "Open Review" })).toHaveAttribute(
      "href",
      "/review",
    );
  });

  it("routes an overdue-review recommendation to the Review resolution surface", async () => {
    const workspace = overdueReviewWorkspace();
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(workspace) },
    );

    const recommendation = within(
      await screen.findByRole("article", { name: "Launch the field guide" }),
    ).getByRole("region", { name: "Recommended next action" });
    expect(within(recommendation).getByRole("link", { name: "Open Review" })).toHaveAttribute(
      "href",
      "/review",
    );
  });

  it("fails closed to one recovery card when a Project ID is duplicated", async () => {
    const workspace = portfolioWorkspace();
    workspace.projects = [
      workspace.projects[0],
      { ...structuredClone(workspace.projects[0]), name: "Conflicting field guide" },
    ];
    workspace.visibility = { archivedProjectIds: [] };
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(workspace) },
    );

    const recovery = await screen.findByRole("article", {
      name: `Project ${PROJECT_ID} recovery`,
    });
    expect(screen.getAllByRole("article", { name: `Project ${PROJECT_ID} recovery` })).toHaveLength(1);
    expect(within(recovery).getByText(`Project ${PROJECT_ID} has duplicate records for one identity.`)).toBeVisible();
    expect(within(recovery).getByText("resolve_sync_conflict")).toBeVisible();
    expect(screen.queryByRole("article", { name: "Launch the field guide" })).toBeNull();
    expect(screen.queryByRole("article", { name: "Conflicting field guide" })).toBeNull();
  });

  it("shows the permitted recovery command when a hold record is malformed", async () => {
    const workspace = portfolioWorkspace();
    workspace.legacyAuditRecords = [];
    renderV2(
      <Routes>
        <Route path="/projects" element={<ProjectsPage />} />
      </Routes>,
      { initialPath: "/projects", runtime: runtime(workspace) },
    );

    const card = await screen.findByRole("article", { name: "Launch the field guide" });
    const hold = within(card).getByRole("complementary", { name: "Active project holds" });
    expect(within(hold).getByText(
      `Migration hold ${LEGACY_ID} has no unique migration source.`,
    )).toBeVisible();
    expect(within(hold).getByText("resolve_sync_conflict")).toBeVisible();
  });
});
