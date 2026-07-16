// @vitest-environment jsdom
import {
  cleanup,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../../../domain/commands";
import { isDirectionComplete } from "../../../domain/direction";
import { stableHashSync } from "../../../domain/stableHash";
import type {
  BetVersion,
  DirectionBrief,
  JsonValue,
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
import { DirectionStage } from "./DirectionStage";

const NOW = "2026-07-16T03:00:00.000Z";
const PROJECT_ID = "project:direction-ui";
const BRIEF_ID = "direction:direction-ui";
const BET_ID = "bet:direction-ui";

function emptyBrief(overrides: Partial<DirectionBrief> = {}): DirectionBrief {
  return buildDirectionBrief({
    id: BRIEF_ID,
    projectId: PROJECT_ID,
    audienceAndProblem: "",
    successEvidence: "",
    appetiteSeconds: 0,
    validationMethod: "",
    firstScope: [],
    noGoOrKill: "",
    advancedNotes: "",
    createdAt: "2026-07-14T03:00:00.000Z",
    updatedAt: "2026-07-14T03:00:00.000Z",
    ...overrides,
  });
}

function directionWorkspace(brief = emptyBrief()): WorkspaceV2 {
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-ui" }),
    projects: [
      buildProjectV2({
        id: PROJECT_ID,
        name: "Make planning humane",
        activeDirectionBriefId: brief.id,
        stage: isDirectionComplete(brief) ? "awaiting_bet" : "direction",
        createdAt: brief.createdAt,
        updatedAt: brief.updatedAt,
      }),
    ],
    directionBriefs: [brief],
  });
}

function completeBrief(): DirectionBrief {
  return emptyBrief({
    audienceAndProblem: "Busy founders cannot see the next bounded decision.",
    successEvidence: "Five founders finish a weekly plan without help.",
    appetiteSeconds: 14_400,
    validationMethod: "Observe five guided planning sessions.",
    firstScope: [
      {
        id: "scope:guided-plan",
        title: "Guided plan",
        description: "Lead one outcome through the lifecycle.",
      },
    ],
    noGoOrKill: "Stop if the workflow adds more status choices.",
  });
}

function executingWorkspace(): WorkspaceV2 {
  const brief = completeBrief();
  const project = buildProjectV2({
    id: PROJECT_ID,
    name: "Make planning humane",
    activeDirectionBriefId: brief.id,
    activeBetId: BET_ID,
    stage: "executing",
    createdAt: brief.createdAt,
    updatedAt: brief.updatedAt,
  });
  const bet = buildBetVersion({
    id: BET_ID,
    projectId: PROJECT_ID,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-16T00:00:00.000Z",
    appetiteEnd: "2026-07-16T04:00:00.000Z",
    actorId: "human-ui",
    approvedAt: "2026-07-16T00:00:00.000Z",
  });
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-ui" }),
    projects: [project],
    directionBriefs: [brief],
    bets: [bet],
  });
}

interface RuntimeOptions {
  delay?: Promise<void>;
  forceRevisionConflict?: boolean;
}

interface DirectionHarness {
  runtime: V2WorkspaceRuntime;
  commands: V2Command[];
  results: CommandResult[];
  current(): WorkspaceV2;
}

function directionRuntime(
  initial = directionWorkspace(),
  options: RuntimeOptions = {},
): DirectionHarness {
  let current = structuredClone(initial);
  let commandSequence = 0;
  const commands: V2Command[] = [];
  const results: CommandResult[] = [];
  const runtime: V2WorkspaceRuntime = {
    bootstrap: {
      resolve: vi.fn(async () => ({ status: "ready" as const, workspace: current })),
    },
    commands: {
      dispatch: vi.fn(async (command: V2Command, context: CommandContext) => {
        commands.push(structuredClone(command));
        await options.delay;
        if (options.forceRevisionConflict) {
          current = { ...current, revision: current.revision + 1 };
        }
        const result = await executeCommand(current, command, context);
        results.push(result);
        if (result.ok) current = result.workspace;
        return result;
      }),
    },
    systemEvents: {
      run: vi.fn(async () => current),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => {
      commandSequence += 1;
      return `direction-command:${commandSequence}`;
    },
  };
  return { runtime, commands, results, current: () => current };
}

function renderDirection(harness = directionRuntime()) {
  renderV2(
    <Routes>
      <Route
        path="/projects/:projectId/direction"
        element={<DirectionStage projectId={PROJECT_ID} />}
      />
      <Route
        path="/projects/:projectId/bet"
        element={<h1>Bet destination</h1>}
      />
    </Routes>,
    {
      initialPath: `/projects/${PROJECT_ID}/direction`,
      runtime: harness.runtime,
    },
  );
  return harness;
}

describe("DirectionStage", () => {
  it.each([
    {
      name: "missing Project",
      mutate: (source: WorkspaceV2) => ({ ...source, projects: [] }),
    },
    {
      name: "duplicate Project identity",
      mutate: (source: WorkspaceV2) => ({
        ...source,
        projects: [...source.projects, structuredClone(source.projects[0])],
      }),
    },
    {
      name: "duplicate active brief identity",
      mutate: (source: WorkspaceV2) => ({
        ...source,
        directionBriefs: [
          ...source.directionBriefs,
          structuredClone(source.directionBriefs[0]),
        ],
      }),
    },
    {
      name: "cross-Project active brief owner",
      mutate: (source: WorkspaceV2) => ({
        ...source,
        directionBriefs: source.directionBriefs.map((brief) => ({
          ...brief,
          projectId: "project:other",
        })),
      }),
    },
  ])("fails closed for $name", async ({ mutate }) => {
    const source = mutate(directionWorkspace());
    renderDirection(directionRuntime(source));

    expect(
      await screen.findByRole("heading", { name: "Direction unavailable" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("fails closed when a pre-Bet stage still references an active Bet", async () => {
    const source = executingWorkspace();
    source.projects[0].stage = "awaiting_bet";
    renderDirection(directionRuntime(source));

    expect(
      await screen.findByRole("heading", { name: "Direction unavailable" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A Project before Bet cannot retain active Bet state or Bet history.",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows the complete Direction record as immutable history in closing", async () => {
    const source = executingWorkspace();
    source.projects[0].stage = "closing";
    source.directionBriefs[0].advancedNotes = "Historical context for reviewers.";
    renderDirection(directionRuntime(source));

    const history = await screen.findByRole("region", {
      name: "Direction immutable history",
    });
    expect(
      await screen.findByRole("region", { name: "Direction immutable history" }),
    ).toBeVisible();
    expect(within(history).getByText("Audience and problem")).toBeVisible();
    expect(
      within(history).getByText("Busy founders cannot see the next bounded decision."),
    ).toBeVisible();
    expect(within(history).getByText("Success evidence")).toBeVisible();
    expect(
      within(history).getByText("Five founders finish a weekly plan without help."),
    ).toBeVisible();
    expect(within(history).getByText("Appetite")).toBeVisible();
    expect(within(history).getByText("14,400 seconds (240 minutes)")).toBeVisible();
    expect(within(history).getByText("Validation method")).toBeVisible();
    expect(
      within(history).getByText("Observe five guided planning sessions."),
    ).toBeVisible();
    expect(within(history).getByText("First scope")).toBeVisible();
    expect(within(history).getByText("Guided plan")).toBeVisible();
    expect(
      within(history).getByText("Lead one outcome through the lifecycle."),
    ).toBeVisible();
    expect(within(history).getByText("No-go or kill criteria")).toBeVisible();
    expect(
      within(history).getByText("Stop if the workflow adds more status choices."),
    ).toBeVisible();
    expect(within(history).getByText("Advanced notes")).toBeVisible();
    expect(
      within(history).getByText("Historical context for reviewers."),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("saves a full incomplete draft one decision at a time and resumes after refresh", async () => {
    const user = userEvent.setup();
    const harness = renderDirection();

    expect(await screen.findByText("0 of 6 decisions complete")).toBeVisible();
    expect(screen.getByRole("button", { name: "Audience and problem" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByRole("button", { name: "Success evidence" })).toBeDisabled();

    const audience = screen.getByRole("textbox", { name: "Audience and problem" });
    await user.type(audience, "Busy founders cannot see the next decision.");
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(harness.commands[0]).toEqual({
      type: "update_direction",
      projectId: PROJECT_ID,
      brief: {
        id: BRIEF_ID,
        projectId: PROJECT_ID,
        audienceAndProblem: "Busy founders cannot see the next decision.",
        successEvidence: "",
        appetiteSeconds: 0,
        validationMethod: "",
        firstScope: [],
        noGoOrKill: "",
        advancedNotes: "",
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Success evidence" }),
    ).toHaveFocus();
    expect(screen.getByText("1 of 6 decisions complete")).toBeVisible();
    expect(harness.current().projects[0].stage).toBe("direction");

    const saved = structuredClone(harness.current());
    cleanup();
    renderDirection(directionRuntime(saved));

    expect(
      await screen.findByRole("heading", { name: "Success evidence" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Audience and problem" }));
    expect(screen.getByRole("textbox", { name: "Audience and problem" })).toHaveValue(
      "Busy founders cannot see the next decision.",
    );
  });

  it("counts only the six material decisions and completes without creating a Bet", async () => {
    const user = userEvent.setup();
    const brief = completeBrief();
    brief.noGoOrKill = "";
    const harness = renderDirection(directionRuntime(directionWorkspace(brief)));

    expect(await screen.findByText("5 of 6 decisions complete")).toBeVisible();
    const advanced = screen.getByText("Advanced notes (optional)").closest("details");
    expect(advanced).not.toHaveAttribute("open");
    await user.click(screen.getByText("Advanced notes (optional)"));
    await user.type(screen.getByRole("textbox", { name: "Advanced notes" }), "Useful context only.");
    expect(screen.getByText("5 of 6 decisions complete")).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "No-go or kill criteria" }),
      "Stop if planning needs raw stage editing.",
    );
    await user.click(screen.getByRole("button", { name: "Save Direction" }));

    await waitFor(() => expect(harness.current().projects[0].stage).toBe("awaiting_bet"));
    expect(harness.current().bets).toEqual([]);
    expect(harness.current().directionBriefs[0].advancedNotes).toBe("Useful context only.");
    expect(screen.getByText("6 of 6 decisions complete")).toBeVisible();
  });

  it("locks every other decision while the current decision has unsaved changes", async () => {
    const user = userEvent.setup();
    renderDirection(directionRuntime(directionWorkspace(completeBrief())));

    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByRole("button", { name: "Success evidence" }));
    const success = screen.getByRole("textbox", { name: "Success evidence" });
    await user.type(success, " More evidence.");

    expect(screen.getByRole("button", { name: "Success evidence" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Audience and problem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Appetite" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "No-go or kill criteria" })).toBeDisabled();
  });

  it("round-trips appetite minutes without losing integer seconds", async () => {
    const user = userEvent.setup();
    const brief = emptyBrief({
      audienceAndProblem: "Audience",
      successEvidence: "Success",
      appetiteSeconds: 90,
    });
    const harness = renderDirection(directionRuntime(directionWorkspace(brief)));
    await screen.findByText("3 of 6 decisions complete");
    await user.click(screen.getByRole("button", { name: "Appetite" }));

    const appetite = screen.getByRole("spinbutton", { name: "Appetite minutes" });
    expect(appetite).toHaveValue(1.5);
    await user.clear(appetite);
    await user.type(appetite, "1.51");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Appetite must convert to a positive whole number of seconds.",
    );
    expect(screen.getByRole("button", { name: "Save draft and continue" })).toBeDisabled();

    await user.clear(appetite);
    await user.type(appetite, "1.75");
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));
    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(harness.commands[0]).toMatchObject({
      type: "update_direction",
      brief: { appetiteSeconds: 105 },
    });
  });

  it("keeps generated first-scope identities stable across saves", async () => {
    const user = userEvent.setup();
    const brief = emptyBrief({
      audienceAndProblem: "Audience",
      successEvidence: "Success",
      appetiteSeconds: 3_600,
      validationMethod: "Interview users",
    });
    const harness = renderDirection(directionRuntime(directionWorkspace(brief)));

    await screen.findByRole("heading", { name: "First scope" });
    await user.click(screen.getByRole("button", { name: "Add scope" }));
    await user.type(screen.getByRole("textbox", { name: "Scope title 1" }), "Guided slice");
    await user.type(
      screen.getByRole("textbox", { name: "Scope description 1" }),
      "One bounded outcome.",
    );
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));
    await waitFor(() => expect(harness.commands).toHaveLength(1));
    const firstCommand = harness.commands[0];
    if (firstCommand.type !== "update_direction") throw new Error("Expected Direction command");
    const scopeId = firstCommand.brief.firstScope[0].id;
    expect(scopeId).not.toBe("");

    await screen.findByRole("heading", { name: "No-go or kill criteria" });
    await user.click(screen.getByRole("button", { name: "First scope" }));
    const description = screen.getByRole("textbox", { name: "Scope description 1" });
    await user.clear(description);
    await user.type(description, "One revised bounded outcome.");
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));
    await waitFor(() => expect(harness.commands).toHaveLength(2));
    const secondCommand = harness.commands[1];
    if (secondCommand.type !== "update_direction") throw new Error("Expected Direction command");
    expect(secondCommand.brief.firstScope[0].id).toBe(scopeId);
  });

  it("requires explicit confirmation before a material execution edit and then routes to Re-bet", async () => {
    const user = userEvent.setup();
    const harness = renderDirection(directionRuntime(executingWorkspace()));
    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByRole("button", { name: "Success evidence" }));
    const success = screen.getByRole("textbox", { name: "Success evidence" });
    await user.clear(success);
    await user.type(success, "Eight founders finish a weekly plan without help.");
    const save = screen.getByRole("button", { name: "Save draft and continue" });
    await user.click(save);

    const dialog = await screen.findByRole("dialog", { name: "Confirm Direction change" });
    expect(harness.commands).toHaveLength(0);
    expect(within(dialog).getByText("Execution will pause until a human Re-bet.")).toBeVisible();
    expect(within(dialog).getByText("Five founders finish a weekly plan without help.")).toBeVisible();
    expect(within(dialog).getByText("Eight founders finish a weekly plan without help.")).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(save).toHaveFocus();
    expect(harness.commands).toHaveLength(0);
    await user.click(save);
    const confirmed = await screen.findByRole("dialog", { name: "Confirm Direction change" });
    await user.click(
      within(confirmed).getByRole("button", { name: "Save change and require Re-bet" }),
    );

    expect(await screen.findByRole("heading", { name: "Bet destination" })).toBeVisible();
    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]).toMatchObject({
      type: "update_direction",
      projectId: PROJECT_ID,
      brief: { successEvidence: "Eight founders finish a weekly plan without help." },
    });
    const current = harness.current();
    expect(current.projects[0].stage).toBe("executing");
    expect(current.projects[0].holds).toHaveLength(1);
    expect(current.projects[0].holds[0].type).toBe("rebet_required");
    expect(current.bets[0].invalidatedAt).toBe(NOW);
    expect(current.directionBriefs).toHaveLength(2);
  });

  it("keeps a rejected material change and its actionable error inside the confirmation dialog", async () => {
    const user = userEvent.setup();
    const harness = renderDirection(directionRuntime(executingWorkspace(), {
      forceRevisionConflict: true,
    }));
    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByRole("button", { name: "Success evidence" }));
    const success = screen.getByRole("textbox", { name: "Success evidence" });
    await user.clear(success);
    await user.type(success, "Eight founders finish a weekly plan without help.");
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm Direction change" });
    await user.click(
      within(dialog).getByRole("button", { name: "Save change and require Re-bet" }),
    );

    const retainedDialog = await screen.findByRole("dialog", {
      name: "Confirm Direction change",
    });
    const rejection = await within(retainedDialog).findByRole("alert");
    expect(
      within(rejection).getByRole("heading", { name: "This change is blocked" }),
    ).toHaveFocus();
    expect(
      within(retainedDialog).getByText("Five founders finish a weekly plan without help."),
    ).toBeVisible();
    expect(
      within(retainedDialog).getByText("Eight founders finish a weekly plan without help."),
    ).toBeVisible();
    expect(harness.commands).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Bet destination" })).toBeNull();
  });

  it("retargets a consecutive material save to the active brief created by an editorial save", async () => {
    const user = userEvent.setup();
    const harness = renderDirection(directionRuntime(executingWorkspace()));
    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByText("Advanced notes (optional)"));
    await user.type(
      screen.getByRole("textbox", { name: "Advanced notes" }),
      "Editorial context.",
    );
    await user.click(screen.getByRole("button", { name: "Save advanced notes" }));

    await waitFor(() => {
      expect(harness.commands).toHaveLength(1);
      expect(harness.current().projects[0].activeDirectionBriefId).not.toBe(
        BRIEF_ID,
      );
    });
    const nextBriefId = harness.current().projects[0].activeDirectionBriefId;
    expect(harness.current().bets[0].invalidatedAt).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Success evidence" }));
    const success = screen.getByRole("textbox", { name: "Success evidence" });
    await user.clear(success);
    await user.type(success, "Nine founders finish a weekly plan without help.");
    await user.click(screen.getByRole("button", { name: "Save draft and continue" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm Direction change" });
    expect(harness.commands).toHaveLength(1);
    await user.click(
      within(dialog).getByRole("button", { name: "Save change and require Re-bet" }),
    );

    await waitFor(() => expect(harness.commands).toHaveLength(2));
    const command = harness.commands[1];
    if (command.type !== "update_direction") throw new Error("Expected Direction command");
    expect(command.brief.id).toBe(nextBriefId);
  });

  it("preserves stored material whitespace when saving only advanced notes", async () => {
    const user = userEvent.setup();
    const source = executingWorkspace();
    const audience = "  Busy founders cannot see the next bounded decision.  ";
    source.directionBriefs[0].audienceAndProblem = audience;
    source.bets[0].briefSnapshot.audienceAndProblem = audience;
    source.bets[0].briefHash = stableHashSync(
      source.bets[0].briefSnapshot as unknown as JsonValue,
    );
    const harness = renderDirection(directionRuntime(source));

    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByText("Advanced notes (optional)"));
    await user.type(
      screen.getByRole("textbox", { name: "Advanced notes" }),
      "Editorial context only.",
    );
    await user.click(screen.getByRole("button", { name: "Save advanced notes" }));

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    const command = harness.commands[0];
    if (command.type !== "update_direction") throw new Error("Expected Direction command");
    expect(command.brief.audienceAndProblem).toBe(audience);
    expect(screen.queryByRole("dialog", { name: "Confirm Direction change" })).toBeNull();
    expect(harness.current().bets[0].invalidatedAt).toBeUndefined();
    expect(harness.current().projects[0].holds).toEqual([]);
  });

  it("renames the Project through metadata without warning or changing the Bet", async () => {
    const user = userEvent.setup();
    const harness = renderDirection(directionRuntime(executingWorkspace()));
    const originalBets: BetVersion[] = structuredClone(harness.current().bets);
    const originalDirections = structuredClone(harness.current().directionBriefs);

    await screen.findByText("6 of 6 decisions complete");
    await user.click(screen.getByText("Project name", { selector: "summary" }));
    const name = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(name);
    await user.type(name, "Make planning humane everywhere");
    await user.click(screen.getByRole("button", { name: "Save project name" }));

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(harness.commands[0]).toEqual({
      type: "update_project_metadata",
      projectId: PROJECT_ID,
      name: "Make planning humane everywhere",
    });
    expect(screen.queryByRole("dialog", { name: "Confirm Direction change" })).toBeNull();
    expect(harness.current().bets).toEqual(originalBets);
    expect(harness.current().directionBriefs).toEqual(originalDirections);
    expect(harness.current().projects[0].holds).toEqual([]);
  });

  it("freezes a pending snapshot and focuses an actionable rejection without losing the draft", async () => {
    let releaseDispatch: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const harness = renderDirection(directionRuntime(directionWorkspace(), {
      delay: delayed,
      forceRevisionConflict: true,
    }));
    const user = userEvent.setup();
    const audience = await screen.findByRole("textbox", { name: "Audience and problem" });
    await user.type(audience, "Preserve this unsaved-looking draft.");
    const save = screen.getByRole("button", { name: "Save draft and continue" });
    await user.click(save);

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(audience).toBeDisabled();
    expect(audience.closest("form")).toHaveAttribute("aria-busy", "true");
    await user.click(save);
    expect(harness.commands).toHaveLength(1);
    releaseDispatch();

    const rejection = await screen.findByRole("alert");
    expect(within(rejection).getByRole("heading", { name: "This change is blocked" })).toHaveFocus();
    expect(audience).toBeEnabled();
    expect(audience).toHaveValue("Preserve this unsaved-looking draft.");
  });
});
