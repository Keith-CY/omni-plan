// @vitest-environment jsdom
import userEvent from "@testing-library/user-event";
import { act, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { executeCommand, type CommandResult } from "../../../domain/commands";
import type {
  BetVersion,
  DirectionBrief,
  ProjectV2,
  WorkspaceV2,
} from "../../../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../../../tests/builders";
import type { V2WorkspaceRuntime } from "../../state/V2WorkspaceProvider";
import { renderV2 } from "../../test/renderV2";
import { BetHistory } from "./BetHistory";
import { BetStage, formatExactDuration } from "./BetStage";

const NOW = "2026-07-16T03:00:00.000Z";
const PROJECT_ID = "project:bet-ui";
const BRIEF_ID = "direction:bet-ui";

function completeBrief(
  overrides: Partial<DirectionBrief> = {},
): DirectionBrief {
  return buildDirectionBrief({
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    audienceAndProblem: "Independent makers lose the thread between decisions.",
    successEvidence: "Three makers finish a weekly plan without status editing.",
    appetiteSeconds: 3_661,
    validationMethod: "Observe three guided planning sessions.",
    firstScope: [
      {
        id: "scope:decision",
        title: "Decision path",
        description: "Guide one explicit decision at a time.",
      },
      {
        id: "scope:history",
        title: "Immutable history",
        description: "Preserve every approved Bet.",
      },
    ],
    noGoOrKill: "Stop if guidance adds more than five minutes.",
    advancedNotes: "Keep the surface compact.",
    createdAt: "2026-07-15T01:00:00.000Z",
    updatedAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  });
}

function awaitingBetWorkspace(): WorkspaceV2 {
  const brief = completeBrief();
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({
      updatedAt: NOW,
      updatedBy: "human-ui",
    }),
    projects: [
      buildProjectV2({
        id: PROJECT_ID,
        name: "Make planning humane",
        stage: "awaiting_bet",
        activeDirectionBriefId: brief.id,
        createdAt: brief.createdAt,
        updatedAt: brief.updatedAt,
      }),
    ],
    directionBriefs: [brief],
  });
}

function migratedAwaitingBetWorkspace(): WorkspaceV2 {
  const source = awaitingBetWorkspace();
  source.projects[0].holds = [{
    type: "migration_review",
    sourceId: "backup:migrated-v1",
    affectedRecordIds: [PROJECT_ID, BRIEF_ID],
    createdAt: NOW,
  }];
  source.migration = {
    sourceSchemaVersion: 1,
    sourceChecksum: "source-checksum",
    backupId: "backup:migrated-v1",
    backupChecksum: "backup-checksum",
    migratedAt: NOW,
    entityCounts: {},
    deterministicIdMap: {},
  };
  return source;
}

function replacementWorkspace({
  expired = false,
}: { expired?: boolean } = {}): WorkspaceV2 {
  const oldBrief = completeBrief({
    id: "direction:bet-ui:v1",
    audienceAndProblem: "ORIGINAL audience snapshot",
    version: 1,
  });
  const newBrief = completeBrief({
    id: "direction:bet-ui:v2",
    audienceAndProblem: "CURRENT revised audience",
    version: 2,
    createdAt: "2026-07-16T01:00:00.000Z",
    updatedAt: "2026-07-16T01:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: "bet:bet-ui:v1",
    projectId: PROJECT_ID,
    version: 1,
    briefId: oldBrief.id,
    briefSnapshot: structuredClone(oldBrief),
    committedScope: structuredClone(oldBrief.firstScope),
    appetiteStart: "2026-07-16T00:00:00.000Z",
    appetiteEnd: "2026-07-16T01:01:01.000Z",
    actorId: "human-reviewer",
    approvedAt: "2026-07-16T00:00:00.000Z",
    ...(expired
      ? {}
      : {
          invalidatedAt: "2026-07-16T01:00:00.000Z",
          invalidationReason: "Material Direction change requires Re-bet.",
        }),
  });
  const project = buildProjectV2({
    id: PROJECT_ID,
    name: "Make planning humane",
    stage: "validating",
    activeDirectionBriefId: newBrief.id,
    activeBetId: bet.id,
    holds: [
      {
        type: "rebet_required",
        sourceId: bet.id,
        affectedRecordIds: [PROJECT_ID, bet.id],
        createdAt: "2026-07-16T01:00:00.000Z",
      },
    ],
    createdAt: oldBrief.createdAt,
    updatedAt: newBrief.updatedAt,
  });
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({
      updatedAt: NOW,
      updatedBy: "human-ui",
    }),
    projects: [project],
    directionBriefs: [oldBrief, newBrief],
    bets: [bet],
    reviews: expired
      ? [{
          id: `review:${bet.id}:expired`,
          kind: "event",
          triggerKey: `${bet.id}:expired`,
          triggerType: "bet_expired",
          status: "completed",
          affectedProjectIds: [PROJECT_ID],
          affectedRecordIds: [bet.id],
          dueAt: bet.appetiteEnd,
          createdAt: bet.appetiteEnd,
          conclusion: {
            summary: "The appetite ended; commit a newly shaped Bet.",
            decisionCodes: ["rebet"],
            followUpCommandIds: [],
            actorId: "human-reviewer",
            completedAt: "2026-07-16T02:00:00.000Z",
          },
        }]
      : [],
  });
}

function commandResult(
  source: WorkspaceV2,
  ok: boolean,
): CommandResult {
  if (ok) {
    return {
      ok: true,
      workspace: { ...source, revision: source.revision + 1 },
      receipt: {} as CommandResult["receipt"],
    };
  }
  return {
    ok: false,
    workspace: source,
    receipt: {} as CommandResult["receipt"],
    rejection: {
      code: "SYNC_CONFLICT",
      reason: "The active Bet changed before approval.",
      gate: `project:${PROJECT_ID}:bet`,
      permittedNextCommand: "resolve_sync_conflict",
      actorKind: "human",
      origin: "ui",
      workspaceRevision: source.revision,
    },
  };
}

function runtime(
  source: WorkspaceV2,
  dispatch = vi.fn(async () => commandResult(source, true)),
): V2WorkspaceRuntime {
  return {
    bootstrap: {
      resolve: vi.fn(async () => ({ status: "ready" as const, workspace: source })),
    },
    commands: { dispatch },
    systemEvents: {
      run: vi.fn(async () => source),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => "bet-ui-command",
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("BetStage", () => {
  it("does not round a fractional imported appetite at the review boundary", () => {
    expect(formatExactDuration(1.23456)).toBe("1.23456 seconds");
  });

  it("shows the complete Direction boundary and opens an explicit human review", async () => {
    const user = userEvent.setup();
    renderV2(<BetStage projectId={PROJECT_ID} />, {
      runtime: runtime(awaitingBetWorkspace()),
    });

    const stage = await screen.findByRole("region", { name: "Bet decision" });
    expect(within(stage).getByText("Independent makers lose the thread between decisions.")).toBeVisible();
    expect(within(stage).getByText("Three makers finish a weekly plan without status editing.")).toBeVisible();
    expect(within(stage).getByText("1 hour 1 minute 1 second")).toBeVisible();
    expect(within(stage).getByText("Observe three guided planning sessions.")).toBeVisible();
    expect(within(stage).getByText("Stop if guidance adds more than five minutes.")).toBeVisible();
    expect(within(stage).getByText("Decision path")).toBeVisible();
    expect(within(stage).getByText("Immutable history")).toBeVisible();
    expect(within(stage).queryByRole("textbox")).toBeNull();
    expect(within(stage).queryByRole("combobox")).toBeNull();
    expect(within(stage).queryByRole("spinbutton")).toBeNull();

    await user.click(within(stage).getByRole("button", { name: "Review Bet" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm human Bet" });
    expect(within(dialog).getByText("1 hour 1 minute 1 second")).toBeVisible();
    expect(within(dialog).getByText(/cannot be extended/i)).toBeVisible();
    expect(within(dialog).queryByRole("textbox")).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole("heading", { name: "Confirm human Bet" }));
  });

  it("dispatches one opaque-ID Bet with the provider-bound approval time", async () => {
    const user = userEvent.setup();
    const source = awaitingBetWorkspace();
    let resolveDispatch!: (result: CommandResult) => void;
    const dispatch = vi.fn(
      () => new Promise<CommandResult>((resolve) => { resolveDispatch = resolve; }),
    );
    renderV2(<><BetStage projectId={PROJECT_ID} /><LocationProbe /></>, {
      runtime: runtime(source, dispatch),
    });

    await user.click(await screen.findByRole("button", { name: "Review Bet" }));
    const confirm = screen.getByRole("button", { name: "Place human Bet" });
    await user.dblClick(confirm);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      {
        type: "place_bet",
        projectId: PROJECT_ID,
        betId: expect.stringMatching(/^bet:/),
        start: NOW,
      },
      expect.objectContaining({
        actorId: "human-ui",
        actorKind: "human",
        now: NOW,
      }),
    );
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("dialog", { name: "Confirm human Bet" })).not.toHaveAttribute(
      "aria-busy",
    );
    expect(within(
      screen.getByRole("dialog", { name: "Confirm human Bet" }),
    ).getByRole("status")).toHaveTextContent("Placing Bet");
    await act(async () => {
      resolveDispatch(commandResult(source, true));
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/projects/${PROJECT_ID}/plan`,
      );
    });
  });

  it("allows one valid migration review hold through the first human Bet review", async () => {
    renderV2(<BetStage projectId={PROJECT_ID} />, {
      runtime: runtime(migratedAwaitingBetWorkspace()),
    });

    const stage = await screen.findByRole("region", { name: "Bet decision" });
    expect(within(stage).getByText(/migrated Direction/i)).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review Bet" })).toBeEnabled();
  });

  it.each([
    ["migration review", migratedAwaitingBetWorkspace],
    ["Re-bet", replacementWorkspace],
  ])("fails closed before showing a decision for a future-dated %s hold", async (
    _holdType,
    buildWorkspace,
  ) => {
    const source = buildWorkspace();
    source.projects[0].holds[0].createdAt = "2026-07-16T04:00:00.000Z";

    renderV2(<BetStage projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Bet unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/invalid creation time/i)).toBeVisible();
    expect(within(unavailable).queryByRole("button")).toBeNull();
  });

  it.each([
    ["migration review", migratedAwaitingBetWorkspace, [PROJECT_ID]],
    ["Re-bet", replacementWorkspace, [PROJECT_ID]],
  ])("fails closed when a %s hold omits its mandatory affected record", async (
    _holdType,
    buildWorkspace,
    affectedRecordIds,
  ) => {
    const source = buildWorkspace();
    source.projects[0].holds[0].affectedRecordIds = affectedRecordIds;

    renderV2(<BetStage projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Bet unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/mandatory affected records/i)).toBeVisible();
    expect(within(unavailable).queryByRole("button")).toBeNull();
  });

  it("keeps a rejected decision open and moves focus to the policy rejection", async () => {
    const user = userEvent.setup();
    const source = awaitingBetWorkspace();
    const dispatch = vi.fn(async () => commandResult(source, false));
    renderV2(<><BetStage projectId={PROJECT_ID} /><LocationProbe /></>, {
      runtime: runtime(source, dispatch),
    });

    await user.click(await screen.findByRole("button", { name: "Review Bet" }));
    await user.click(screen.getByRole("button", { name: "Place human Bet" }));

    const rejection = await screen.findByRole("heading", { name: "This change is blocked" });
    expect(screen.getByRole("dialog", { name: "Confirm human Bet" })).toBeVisible();
    expect(rejection).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Return to Projects" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/projects");
    expect(screen.queryByRole("dialog", { name: "Confirm human Bet" })).toBeNull();
  });

  it.each([
    [false, "Invalidated — replacement required"],
    [true, "Expired — replacement required"],
  ])(
    "preserves immutable history and exposes only Re-bet for replacement state %s",
    async (expired, status) => {
      renderV2(<BetStage projectId={PROJECT_ID} />, {
        runtime: runtime(replacementWorkspace({ expired })),
      });

      const stage = await screen.findByRole("region", { name: "Re-bet decision" });
      expect(within(stage).getByText("CURRENT revised audience")).toBeVisible();
      expect(within(stage).getByText("Appetite cannot be extended. A replacement creates a new immutable Bet version.")).toBeVisible();
      expect(within(stage).getByText(status)).toBeVisible();
      expect(within(stage).getAllByText("ORIGINAL audience snapshot")[0]).toBeVisible();
      expect(within(stage).getByText("human-reviewer")).toBeVisible();
      if (!expired) {
        expect(
          within(stage).getByText(/Material Direction change requires Re-bet/),
        ).toBeVisible();
      }
      expect(within(stage).getAllByRole("button")).toHaveLength(1);
      expect(within(stage).getByRole("button", { name: "Review Re-bet" })).toBeVisible();
    },
  );

  it.each([
    ["missing expiry Review", (source: WorkspaceV2) => { source.reviews = []; }],
    ["open expiry Review", (source: WorkspaceV2) => {
      source.reviews[0].status = "open";
      delete source.reviews[0].conclusion;
    }],
    ["expiry Review without Re-bet decision", (source: WorkspaceV2) => {
      source.reviews[0].conclusion!.decisionCodes = ["continue"];
    }],
  ])("does not expose expired Re-bet for %s", async (_failure, mutate) => {
    const source = replacementWorkspace({ expired: true });
    mutate(source);

    renderV2(<BetStage projectId={PROJECT_ID} />, {
      runtime: runtime(source),
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Bet unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/completed expiry Review/i)).toBeVisible();
    expect(within(unavailable).queryByRole("button")).toBeNull();
  });

  it("applies a real human Re-bet while preserving the old Bet and clearing the hold", async () => {
    const user = userEvent.setup();
    const source = replacementWorkspace();
    source.projects[0].stage = "planning";
    const oldBet = structuredClone(source.bets[0]);
    let applied: CommandResult | undefined;
    const dispatch = vi.fn(async (command, context) => {
      applied = await executeCommand(source, command, context);
      return applied;
    });
    renderV2(<><BetStage projectId={PROJECT_ID} /><LocationProbe /></>, {
      runtime: runtime(source, dispatch),
    });

    await user.click(await screen.findByRole("button", { name: "Review Re-bet" }));
    await user.click(screen.getByRole("button", { name: "Place human Re-bet" }));
    await waitFor(() => expect(applied?.ok).toBe(true));

    if (applied === undefined || !applied.ok) throw new Error("Expected applied Re-bet");
    expect(applied.workspace.projects[0]).toMatchObject({
      stage: "planning",
      holds: [],
    });
    expect(applied.workspace.bets[0]).toEqual(oldBet);
    expect(applied.workspace.bets[1]).toMatchObject({
      actorId: "human-ui",
      supersedesId: oldBet.id,
      briefId: source.projects[0].activeDirectionBriefId,
    });
    expect(applied.workspace.projects[0].activeBetId).toBe(applied.workspace.bets[1].id);
    expect(screen.getByTestId("location")).toHaveTextContent(
      `/projects/${PROJECT_ID}/plan`,
    );
  });

  it.each([
    ["missing Project", (source: WorkspaceV2) => { source.projects = []; }],
    ["duplicate Project", (source: WorkspaceV2) => { source.projects.push({ ...source.projects[0] }); }],
    ["missing Direction", (source: WorkspaceV2) => { source.directionBriefs = source.directionBriefs.slice(0, 1); }],
    ["duplicate Direction", (source: WorkspaceV2) => { source.directionBriefs.push({ ...source.directionBriefs[1] }); }],
    ["cross-owner Direction", (source: WorkspaceV2) => { source.directionBriefs[1].projectId = "project:other"; }],
    ["missing active Bet", (source: WorkspaceV2) => { source.bets = []; }],
    ["duplicate active Bet", (source: WorkspaceV2) => { source.bets.push({ ...source.bets[0] }); }],
    ["cross-owner active Bet", (source: WorkspaceV2) => { source.bets[0].projectId = "project:other"; }],
  ])("fails closed for %s", async (_failure, mutate) => {
    const source = replacementWorkspace();
    mutate(source);
    renderV2(<BetStage projectId={PROJECT_ID} />, { runtime: runtime(source) });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Bet unavailable" })).toBeVisible();
    expect(within(unavailable).getByText(/cannot be changed safely/i)).toBeVisible();
    expect(within(unavailable).queryByRole("button")).toBeNull();
    expect(within(unavailable).queryByRole("textbox")).toBeNull();
    expect(within(unavailable).queryByRole("combobox")).toBeNull();
    expect(within(unavailable).queryByRole("spinbutton")).toBeNull();
  });
});

describe("BetHistory", () => {
  it("sorts versions deterministically and reads each immutable Direction snapshot", async () => {
    const user = userEvent.setup();
    const source = replacementWorkspace();
    const first = source.bets[0];
    const secondBrief = completeBrief({
      id: "direction:bet-ui:v0",
      audienceAndProblem: "Earlier stored snapshot",
    });
    source.bets = [
      { ...first, version: 2, approvedAt: "2026-07-16T02:00:00.000Z" },
      buildBetVersion({
        id: "bet:bet-ui:v0",
        projectId: PROJECT_ID,
        version: 1,
        briefId: secondBrief.id,
        briefSnapshot: secondBrief,
        committedScope: secondBrief.firstScope,
        appetiteStart: "2026-07-14T00:00:00.000Z",
        appetiteEnd: "2026-07-14T01:01:01.000Z",
        actorId: "human-founder",
        approvedAt: "2026-07-14T00:00:00.000Z",
        invalidatedAt: "2026-07-14T01:00:00.000Z",
        invalidationReason: "Superseded by Re-bet bet:bet-ui:v1.",
      }),
    ];
    source.projects[0].activeBetId = first.id;
    renderV2(<BetHistory projectId={PROJECT_ID} />, { runtime: runtime(source) });

    const history = await screen.findByRole("region", { name: "Bet immutable history" });
    const entries = within(history).getAllByRole("article");
    expect(within(entries[0]).getByRole("heading", { name: "Bet v1" })).toBeVisible();
    expect(within(entries[0]).getAllByText("Earlier stored snapshot")[0]).toBeVisible();
    expect(within(entries[1]).getByRole("heading", { name: "Bet v2" })).toBeVisible();
    expect(within(entries[1]).getAllByText("ORIGINAL audience snapshot")[0]).toBeVisible();
    const detail = within(entries[0]).getByText(
      "Inspect full immutable Direction snapshot",
    ).closest("details");
    expect(detail).not.toHaveAttribute("open");
    await user.click(
      within(entries[0]).getByText("Inspect full immutable Direction snapshot"),
    );
    expect(detail).toHaveAttribute("open");
    expect(within(entries[0]).getByText(/^[a-f0-9]{64}$/)).toBeVisible();
    expect(within(history).queryByRole("textbox")).toBeNull();
    expect(within(history).queryByRole("button")).toBeNull();
  });
});
