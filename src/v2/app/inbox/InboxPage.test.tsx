// @vitest-environment jsdom
import { IDBFactory } from "fake-indexeddb";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandContext, V2Command } from "../../domain/commands";
import type { InboxItem, WorkspaceV2 } from "../../domain/types";
import {
  BrowserWorkspaceRepository,
} from "../../repositories/browserWorkspaceRepository";
import { CommandService } from "../../repositories/commandService";
import { deleteV2Database } from "../../repositories/indexedDb";
import {
  buildCapacityProfile,
  buildInboxItem,
  buildWorkspaceV2,
} from "../../tests/builders";
import { V2Routes } from "../routes";
import type { V2WorkspaceRuntime } from "../state/V2WorkspaceProvider";
import { renderV2 } from "../test/renderV2";

const NOW = "2026-07-14T03:00:00.000Z";
const WORKSPACE_ID = "personal";

function readyWorkspace(inboxItems: InboxItem[] = []): WorkspaceV2 {
  return buildWorkspaceV2(WORKSPACE_ID, {
    capacityProfile: buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 2, startMinute: 540, finishMinute: 1_020 },
      ],
      dailyBudgets: [
        {
          weekday: 2,
          deepSeconds: 14_400,
          mediumSeconds: 7_200,
          shallowSeconds: 3_600,
        },
      ],
      updatedAt: NOW,
      updatedBy: "human-ui",
    }),
    inboxItems,
  });
}

function capturedItem(id = "inbox-triage", text = "Prepare launch notes") {
  return buildInboxItem({
    id,
    originalText: text,
    sourceId: "omni-plan-v2-ui",
    actorId: "human-ui",
    capturedAt: NOW,
  });
}

describe("InboxPage", () => {
  let indexedDB: IDBFactory;
  let databaseNames: string[];

  beforeEach(() => {
    indexedDB = new IDBFactory();
    databaseNames = [];
  });

  afterEach(async () => {
    await Promise.all(
      databaseNames.map((databaseName) =>
        deleteV2Database({ databaseName, indexedDB }).catch(() => undefined),
      ),
    );
  });

  async function renderInbox(
    initial: WorkspaceV2,
    suffix: string,
  ): Promise<BrowserWorkspaceRepository> {
    const databaseName = `omni-plan-v2-inbox-page-${suffix}`;
    databaseNames.push(databaseName);
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    await repository.initialize(buildWorkspaceV2(initial.workspaceId));
    const commands = new CommandService(repository, initial.workspaceId);
    let seedRevision = 0;
    let seedSequence = 0;
    const dispatchSeed = async (command: V2Command) => {
      seedSequence += 1;
      const context: CommandContext = {
        commandId: `inbox-seed-${suffix}-${seedSequence}`,
        expectedRevision: seedRevision,
        actorId: "human-ui",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "omni-plan-v2-ui",
          verified: true,
          capabilities: ["human_decision"],
        },
        now: NOW,
      };
      const result = await commands.dispatch(command, context);
      if (!result.ok) {
        throw new Error(`Seed command ${command.type} was rejected`);
      }
      seedRevision = result.workspace.revision;
    };
    if (initial.capacityProfile === undefined) {
      throw new Error("Inbox tests require a configured capacity profile.");
    }
    await dispatchSeed({
      type: "configure_capacity",
      profile: initial.capacityProfile,
    });
    for (const item of initial.inboxItems) {
      await dispatchSeed({
        type: "capture_inbox",
        id: item.id,
        text: item.originalText,
        ...(item.desiredDate === undefined
          ? {}
          : { desiredDate: item.desiredDate }),
      });
    }
    const seeded = await repository.load();
    if (seeded === undefined) throw new Error("Seeded Workspace was not stored.");
    let commandSequence = 0;
    const runtime: V2WorkspaceRuntime = {
      bootstrap: {
        resolve: async () => ({ status: "ready", workspace: seeded }),
      },
      commands,
      systemEvents: {
        run: async () => (await repository.load()) ?? seeded,
        nextScheduledWakeAt: () => undefined,
      },
      now: () => NOW,
      createCommandId: () => {
        commandSequence += 1;
        return `inbox-ui-command-${suffix}-${commandSequence}`;
      },
    };

    renderV2(<V2Routes />, {
      initialPath: "/inbox",
      runtime,
    });
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeVisible();
    return repository;
  }

  async function answerEligibleFacts(
    card: HTMLElement,
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "One session" }),
      "yes",
    );
    await user.type(
      within(card).getByRole("spinbutton", { name: "Estimate minutes" }),
      "30",
    );
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "Dependency state" }),
      "none",
    );
    await user.selectOptions(
      within(card).getByRole("combobox", {
        name: "Requires milestone evidence",
      }),
      "no",
    );
    await user.type(
      within(card).getByRole("spinbutton", { name: "Outcome count" }),
      "1",
    );
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "Solution known" }),
      "yes",
    );
  }

  it("captures through one primary input without implicitly creating an Action or Project", async () => {
    const user = userEvent.setup();
    const repository = await renderInbox(readyWorkspace(), "capture");

    const capture = screen.getByRole("textbox", { name: "Capture one thought" });
    expect(screen.getAllByRole("textbox")).toEqual([capture]);
    await user.type(capture, "Prepare launch notes");
    await user.click(screen.getByRole("button", { name: "Capture" }));

    await screen.findByRole("article", { name: "Triage: Prepare launch notes" });
    const stored = await repository.load();
    expect(stored?.inboxItems).toHaveLength(1);
    expect(stored?.inboxItems[0]).toMatchObject({
      originalText: "Prepare launch notes",
      triageStatus: "untriaged",
    });
    expect(stored?.actions).toEqual([]);
    expect(stored?.projects).toEqual([]);
    expect(capture).toHaveValue("");

    await user.type(capture, "Send the final agenda");
    await user.click(screen.getByRole("button", { name: "Capture" }));
    await screen.findByRole("article", { name: "Triage: Send the final agenda" });
    const afterSecondCapture = await repository.load();
    expect(new Set(afterSecondCapture?.inboxItems.map(({ id }) => id)).size).toBe(2);
  });

  it("shows all six deterministic rules and removes the invalid Action bypass", async () => {
    const user = userEvent.setup();
    await renderInbox(readyWorkspace([capturedItem()]), "rules");
    const card = await screen.findByRole("article", {
      name: "Triage: Prepare launch notes",
    });

    for (const code of [
      "ONE_SESSION",
      "TWO_HOUR_LIMIT",
      "NO_DEPENDENCY",
      "NO_MILESTONE_EVIDENCE",
      "ONE_OUTCOME",
      "KNOWN_SOLUTION",
    ]) {
      expect(within(card).getByText(code)).toBeVisible();
    }

    await user.selectOptions(
      within(card).getByRole("combobox", { name: "One session" }),
      "no",
    );
    const estimate = within(card).getByRole("spinbutton", {
      name: "Estimate minutes",
    });
    await user.clear(estimate);
    await user.type(estimate, "121");
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "Dependency state" }),
      "has",
    );
    await user.type(
      within(card).getByRole("textbox", { name: "Dependency IDs" }),
      "dependency-1",
    );
    await user.selectOptions(
      within(card).getByRole("combobox", {
        name: "Requires milestone evidence",
      }),
      "yes",
    );
    const outcomeCount = within(card).getByRole("spinbutton", {
      name: "Outcome count",
    });
    await user.clear(outcomeCount);
    await user.type(outcomeCount, "2");
    await user.selectOptions(
      within(card).getByRole("combobox", { name: "Solution known" }),
      "no",
    );

    for (const reason of [
      "Needs more than one working session.",
      "Estimate exceeds two hours.",
      "Has a dependency.",
      "Requires milestone evidence.",
      "Contains multiple outcomes.",
      "Solution path is uncertain.",
    ]) {
      expect(within(card).getByText(reason)).toBeVisible();
    }
    expect(within(card).getByText("Project recommended")).toBeVisible();
    expect(
      within(card).queryByRole("button", { name: "Review as Action" }),
    ).toBeNull();
    expect(
      within(card).getByRole("button", { name: "Review as Project" }),
    ).toBeVisible();
  });

  it("requires positive safe-integer eligibility facts before classification", async () => {
    const user = userEvent.setup();
    await renderInbox(readyWorkspace([capturedItem()]), "invalid-facts");
    const card = await screen.findByRole("article", {
      name: "Triage: Prepare launch notes",
    });
    await answerEligibleFacts(card, user);
    expect(
      within(card).getByRole("button", { name: "Review as Action" }),
    ).toBeEnabled();
    const estimate = within(card).getByRole("spinbutton", {
      name: "Estimate minutes",
    });
    fireEvent.change(estimate, { target: { value: "0" } });

    expect(within(card).getByText("Complete required facts")).toBeVisible();
    expect(
      within(card).getByText(
        "Estimate and outcome count must resolve to positive whole numbers.",
      ),
    ).toBeVisible();
    expect(
      within(card).getByRole("button", { name: "Review as Action" }),
    ).toBeDisabled();
    expect(
      within(card).getByRole("button", { name: "Review as Project" }),
    ).toBeDisabled();

    fireEvent.change(estimate, { target: { value: "30" } });
    fireEvent.change(
      within(card).getByRole("spinbutton", { name: "Outcome count" }),
      { target: { value: "1.4" } },
    );
    expect(
      within(card).getByRole("button", { name: "Review as Action" }),
    ).toBeDisabled();

    fireEvent.change(
      within(card).getByRole("spinbutton", { name: "Outcome count" }),
      { target: { value: "1" } },
    );
    fireEvent.change(estimate, {
      target: { value: "150119987579017" },
    });
    expect(
      within(card).getByRole("button", { name: "Review as Action" }),
    ).toBeDisabled();
  });

  it("cancels classification without a write and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    const repository = await renderInbox(
      readyWorkspace([capturedItem()]),
      "cancel",
    );
    const card = await screen.findByRole("article", {
      name: "Triage: Prepare launch notes",
    });
    await answerEligibleFacts(card, user);
    const trigger = within(card).getByRole("button", {
      name: "Review as Action",
    });
    const revisionBeforeCancel = (await repository.load())?.revision;

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "Confirm Action classification",
    });
    expect(dialog).toHaveTextContent("irreversible");
    expect(dialog).toHaveTextContent("capture remains in Inbox history");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("heading", {
          name: "Confirm Action classification",
        }),
      ).toHaveFocus(),
    );
    const backdrop = dialog.parentElement;
    expect(backdrop).not.toBeNull();
    expect(
      Array.from(document.body.children)
        .filter((element) => element !== backdrop)
        .every((element) => element.hasAttribute("inert")),
    ).toBe(true);
    await user.tab({ shift: true });
    expect(
      within(dialog).getByRole("button", { name: "Create Action" }),
    ).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(
      screen.queryByRole("dialog", { name: "Confirm Action classification" }),
    ).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    const stored = await repository.load();
    expect(stored?.revision).toBe(revisionBeforeCancel);
    expect(stored?.actions).toEqual([]);
    expect(stored?.projects).toEqual([]);
    expect(stored?.inboxItems[0]?.triageStatus).toBe("untriaged");
  });

  it("confirms an eligible capture as an Action and focuses the new record", async () => {
    const user = userEvent.setup();
    const repository = await renderInbox(
      readyWorkspace([capturedItem()]),
      "action",
    );
    const card = await screen.findByRole("article", {
      name: "Triage: Prepare launch notes",
    });
    await answerEligibleFacts(card, user);
    await user.click(
      within(card).getByRole("button", { name: "Review as Action" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Create Action" }),
    );

    const actionRecord = await screen.findByRole("article", {
      name: "Action: Prepare launch notes",
    });
    await waitFor(() => expect(actionRecord).toHaveFocus());
    expect(
      within(actionRecord).getByRole("link", { name: "Open Action" }),
    ).toHaveAttribute("href", "/inbox/actions");
    const stored = await repository.load();
    expect(stored?.actions).toHaveLength(1);
    expect(stored?.actions[0]).toMatchObject({
      title: "Prepare launch notes",
      status: "open",
    });
    expect(stored?.projects).toEqual([]);
    expect(stored?.inboxItems[0]).toMatchObject({
      triageStatus: "action",
      actionId: stored?.actions[0]?.id,
    });
  });

  it("lets an eligible capture explicitly become a Direction-stage Project", async () => {
    const user = userEvent.setup();
    const repository = await renderInbox(
      readyWorkspace([capturedItem()]),
      "project",
    );
    const card = await screen.findByRole("article", {
      name: "Triage: Prepare launch notes",
    });
    await answerEligibleFacts(card, user);
    await user.click(
      within(card).getByRole("button", { name: "Review as Project" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Create Direction-stage Project" }),
    );

    const projectRecord = await screen.findByRole("article", {
      name: "Project: Prepare launch notes",
    });
    await waitFor(() => expect(projectRecord).toHaveFocus());
    const stored = await repository.load();
    expect(stored?.actions).toEqual([]);
    expect(stored?.projects).toHaveLength(1);
    expect(stored?.projects[0]).toMatchObject({
      name: "Prepare launch notes",
      stage: "direction",
    });
    expect(stored?.directionBriefs).toHaveLength(1);
    expect(stored?.inboxItems[0]).toMatchObject({
      triageStatus: "project",
      projectId: stored?.projects[0]?.id,
    });
    expect(
      within(projectRecord).getByRole("link", { name: "Open Project" }),
    ).toHaveAttribute(
      "href",
      `/projects/${stored?.projects[0]?.id}/direction`,
    );
  });
});
