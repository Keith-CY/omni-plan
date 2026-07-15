// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../../domain/commands";
import type {
  Action,
  ActionEligibilityFacts,
  WorkspaceV2,
} from "../../domain/types";
import {
  buildCapacityProfile,
  buildInboxItem,
  buildWorkspaceV2,
} from "../../tests/builders";
import {
  isOperationalV2WorkspaceState,
  useV2Workspace,
  type V2WorkspaceRuntime,
} from "../state/V2WorkspaceProvider";
import { renderV2 } from "../test/renderV2";
import { ActionsPage } from "./ActionsPage";

const NOW = "2026-07-14T03:00:00.000Z";
const ACTION_ID = "action:release-notes";
const INBOX_ID = "inbox:release-notes";

const ELIGIBLE: ActionEligibilityFacts = {
  singleSession: true,
  estimateSeconds: 1_800,
  dependencyIds: [],
  requiresMilestoneEvidence: false,
  outcomeCount: 1,
  solutionKnown: true,
};

const ACTION: Action = {
  id: ACTION_ID,
  inboxItemId: INBOX_ID,
  title: "Draft release notes",
  revision: 1,
  status: "open",
  eligibility: ELIGIBLE,
  attention: "medium",
  createdAt: "2026-07-13T03:00:00.000Z",
  updatedAt: "2026-07-13T03:00:00.000Z",
};

const EARLIER_ACTUAL = {
  id: "actual:earlier",
  revision: 1,
  target: { kind: "action" as const, actionId: ACTION_ID },
  actualWorkSeconds: 300,
  remainingWorkSeconds: 1_500,
  actualCost: 0,
  recordedAt: "2026-07-13T04:00:00.000Z",
};

function workspace(): WorkspaceV2 {
  return buildWorkspaceV2("personal", {
    capacityProfile: buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 2, startMinute: 540, finishMinute: 1_020 },
      ],
      dailyBudgets: [
        {
          weekday: 2,
          deepSeconds: 7_200,
          mediumSeconds: 7_200,
          shallowSeconds: 3_600,
        },
      ],
      updatedAt: NOW,
      updatedBy: "human-ui",
    }),
    inboxItems: [
      buildInboxItem({
        id: INBOX_ID,
        sourceId: "omni-plan-v2-ui",
        actorId: "human-ui",
        capturedAt: "2026-07-13T03:00:00.000Z",
        originalText: ACTION.title,
        triageStatus: "action",
        actionId: ACTION.id,
      }),
    ],
    actions: [structuredClone(ACTION)],
    actuals: [structuredClone(EARLIER_ACTUAL)],
  });
}

interface ActionRuntimeHarness {
  runtime: V2WorkspaceRuntime;
  commands: V2Command[];
  results: CommandResult[];
  current(): WorkspaceV2;
}

function actionRuntime(
  initial = workspace(),
  beforeDispatch?: () => Promise<void>,
): ActionRuntimeHarness {
  let current = structuredClone(initial);
  let commandSequence = 0;
  const commands: V2Command[] = [];
  const results: CommandResult[] = [];
  const runtime: V2WorkspaceRuntime = {
    bootstrap: {
      resolve: vi.fn(async () => ({
        status: "ready" as const,
        workspace: current,
      })),
    },
    commands: {
      dispatch: vi.fn(
        async (command: V2Command, context: CommandContext) => {
          commands.push(structuredClone(command));
          await beforeDispatch?.();
          const result = await executeCommand(current, command, context);
          results.push(result);
          if (result.ok) current = result.workspace;
          return result;
        },
      ),
    },
    systemEvents: {
      run: vi.fn(async () => current),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => {
      commandSequence += 1;
      return `actions-command:${commandSequence}`;
    },
  };
  return { runtime, commands, results, current: () => current };
}

function OperationalGate({ children }: { children: ReactNode }) {
  const state = useV2Workspace();
  return isOperationalV2WorkspaceState(state) ? children : null;
}

function renderActions(harness = actionRuntime()) {
  renderV2(
    <Routes>
      <Route
        path="/inbox/actions"
        element={
          <OperationalGate>
            <ActionsPage />
          </OperationalGate>
        }
      />
      <Route
        path="/projects/:projectId/direction"
        element={<h1>Project direction</h1>}
      />
    </Routes>,
    { initialPath: "/inbox/actions", runtime: harness.runtime },
  );
  return harness;
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole("button", { name: "Edit Draft release notes" }),
  );
  return screen.getByRole("dialog", { name: "Edit Action" });
}

describe("ActionsPage", () => {
  it("isolates the editor as a modal and restores focus on Escape", async () => {
    const user = userEvent.setup();
    renderActions();
    const editButton = await screen.findByRole("button", {
      name: "Edit Draft release notes",
    });

    await user.click(editButton);

    const dialog = screen.getByRole("dialog", { name: "Edit Action" });
    const backdrop = dialog.parentElement;
    expect(backdrop?.parentElement).toBe(document.body);
    expect(
      Array.from(document.body.children)
        .filter((element) => element !== backdrop)
        .every((element) => element.hasAttribute("inert")),
    ).toBe(true);
    const heading = within(dialog).getByRole("heading", { name: "Edit Action" });
    const cancelButton = within(dialog).getByRole("button", { name: "Cancel" });
    const titleInput = within(dialog).getByRole("textbox", { name: "Title" });
    expect(heading).toHaveFocus();

    fireEvent.keyDown(heading, { key: "Tab", shiftKey: true });
    expect(cancelButton).toHaveFocus();
    fireEvent.keyDown(cancelButton, { key: "Tab" });
    expect(titleInput).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Edit Action" })).toBeNull();
    expect(editButton).toHaveFocus();
    expect(
      Array.from(document.body.children).every(
        (element) => !element.hasAttribute("inert"),
      ),
    ).toBe(true);
  });

  it("freezes the submitted editor draft until a delayed rejection resolves", async () => {
    let releaseDispatch: () => void = () => {};
    const delayed = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const harness = actionRuntime(workspace(), () => delayed);
    const user = userEvent.setup();
    renderActions(harness);
    const editor = await openEditor(user);
    const estimate = within(editor).getByRole("spinbutton", {
      name: "Estimate minutes",
    });
    await user.clear(estimate);
    await user.type(estimate, "121");

    await user.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(editor.querySelector("form")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(estimate).toBeDisabled();
    releaseDispatch();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Estimate exceeds two hours.",
    );
    expect(estimate).toHaveValue(121);
  });

  it("prevents a no-op update and dispatches only a minimal eligible patch", async () => {
    const user = userEvent.setup();
    const harness = renderActions();
    const editor = await openEditor(user);
    expect(
      within(editor).getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();

    const title = within(editor).getByRole("textbox", { name: "Title" });
    await user.type(title, " ");
    expect(
      within(editor).getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await user.clear(title);
    await user.type(title, "Publish release notes");
    await user.selectOptions(
      within(editor).getByRole("combobox", { name: "Attention" }),
      "deep",
    );
    await user.clear(
      within(editor).getByRole("spinbutton", { name: "Estimate minutes" }),
    );
    await user.type(
      within(editor).getByRole("spinbutton", { name: "Estimate minutes" }),
      "60",
    );
    await user.type(
      within(editor).getByLabelText("Desired date"),
      "2026-07-16T09:00",
    );
    await user.type(
      within(editor).getByLabelText("Fixed start"),
      "2026-07-16T10:00",
    );
    await user.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(harness.commands).toHaveLength(1));
    expect(harness.commands[0]).toEqual({
      type: "update_action",
      actionId: ACTION_ID,
      patch: {
        title: "Publish release notes",
        attention: "deep",
        desiredDate: "2026-07-16T09:00:00.000Z",
        fixedStart: "2026-07-16T10:00:00.000Z",
        eligibility: { ...ELIGIBLE, estimateSeconds: 3_600 },
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Publish release notes" }),
    ).toHaveFocus();
  });

  const rejectionCases = [
    {
      name: "multi-session work",
      field: "singleSession",
      reason: "Needs more than one working session.",
    },
    {
      name: "more than two hours",
      field: "estimateSeconds",
      reason: "Estimate exceeds two hours.",
    },
    {
      name: "a dependency",
      field: "dependencyIds",
      reason: "Has a dependency.",
    },
    {
      name: "milestone evidence",
      field: "requiresMilestoneEvidence",
      reason: "Requires milestone evidence.",
    },
    {
      name: "multiple outcomes",
      field: "outcomeCount",
      reason: "Contains multiple outcomes.",
    },
    {
      name: "an unknown solution",
      field: "solutionKnown",
      reason: "Solution path is uncertain.",
    },
  ] as const;

  it.each(rejectionCases)(
    "renders typed promotion guidance and one resolution for $name",
    async ({ field, reason }) => {
      const user = userEvent.setup();
      const harness = renderActions();
      const before = structuredClone(harness.current().actions[0]);
      const editor = await openEditor(user);

      switch (field) {
        case "singleSession":
          await user.click(
            within(editor).getByRole("checkbox", {
              name: "Single working session",
            }),
          );
          break;
        case "estimateSeconds": {
          const input = within(editor).getByRole("spinbutton", {
            name: "Estimate minutes",
          });
          await user.clear(input);
          await user.type(input, "121");
          break;
        }
        case "dependencyIds":
          await user.type(
            within(editor).getByRole("textbox", { name: "Dependencies" }),
            "action:dependency",
          );
          break;
        case "requiresMilestoneEvidence":
          await user.click(
            within(editor).getByRole("checkbox", {
              name: "Requires milestone evidence",
            }),
          );
          break;
        case "outcomeCount": {
          const input = within(editor).getByRole("spinbutton", {
            name: "Outcome count",
          });
          await user.clear(input);
          await user.type(input, "2");
          break;
        }
        case "solutionKnown":
          await user.click(
            within(editor).getByRole("checkbox", { name: "Solution known" }),
          );
          break;
      }

      await user.click(
        within(editor).getByRole("button", { name: "Save changes" }),
      );

      const rejection = await screen.findByRole("alert");
      expect(rejection).toHaveTextContent(reason);
      expect(rejection).toHaveTextContent(
        `action_eligibility:${ACTION_ID}`,
      );
      expect(rejection).toHaveTextContent("promote_action_to_project");
      expect(
        screen.getAllByRole("button", { name: "Promote to project" }),
      ).toHaveLength(1);
      expect(harness.current().actions[0]).toEqual(before);
      expect(harness.results[harness.results.length - 1]).toMatchObject({
        ok: false,
        rejection: {
          code: "ACTION_PROMOTION_REQUIRED",
          permittedNextCommand: "promote_action_to_project",
        },
      });
    },
  );

  it.each(["0", "-1", "0.001", "150119987579017"])(
    "rejects invalid estimate minutes %s before dispatch",
    async (value) => {
      const user = userEvent.setup();
      const harness = renderActions();
      const editor = await openEditor(user);
      const input = within(editor).getByRole("spinbutton", {
        name: "Estimate minutes",
      });
      await user.clear(input);
      await user.type(input, value);
      await user.click(
        within(editor).getByRole("button", { name: "Save changes" }),
      );

      expect(harness.commands).toHaveLength(0);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "positive whole number of seconds",
      );
    },
  );

  it("completes an Action with one atomic Actual and outcome", async () => {
    const user = userEvent.setup();
    const harness = renderActions();
    await user.click(
      await screen.findByRole("button", {
        name: "Complete Draft release notes",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Complete Action" });
    await user.type(
      within(dialog).getByRole("spinbutton", { name: "Actual minutes" }),
      "25",
    );
    await user.selectOptions(
      within(dialog).getByRole("combobox", { name: "Result" }),
      "learned",
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Outcome note" }),
      "Learned which release details readers need.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Record outcome" }),
    );

    await waitFor(() =>
      expect(harness.current().actions[0]?.status).toBe("completed"),
    );
    expect(harness.current().actions[0]).toMatchObject({
      resultStatus: "learned",
      outcomeNote: "Learned which release details readers need.",
    });
    expect(harness.current().actuals).toHaveLength(2);
    expect(harness.current().actuals[0]).toEqual(EARLIER_ACTUAL);
    expect(harness.current().actuals[1]).toMatchObject({
      target: { kind: "action", actionId: ACTION_ID },
      actualWorkSeconds: 1_500,
      remainingWorkSeconds: 0,
    });
    expect(
      await screen.findByRole("heading", { name: ACTION.title }),
    ).toHaveFocus();
  });

  it("promotes from the rejected draft while preserving Capture, Action, and Actual history", async () => {
    const user = userEvent.setup();
    const harness = renderActions();
    const beforeAction = structuredClone(harness.current().actions[0]);
    const beforeActuals = structuredClone(harness.current().actuals);
    const editor = await openEditor(user);
    const estimate = within(editor).getByRole("spinbutton", {
      name: "Estimate minutes",
    });
    await user.clear(estimate);
    await user.type(estimate, "121");
    await user.click(
      within(editor).getByRole("button", { name: "Save changes" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Promote to project" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Promote Action to Project",
    });
    expect(dialog).toHaveTextContent(
      "The Capture, Action, Actuals, and outcome history remain auditable",
    );
    const projectName = within(dialog).getByRole("textbox", {
      name: "Project name",
    });
    await user.clear(projectName);
    await user.type(projectName, "Publish release notes");
    await user.click(
      within(dialog).getByRole("button", {
        name: "Create Direction project",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Project direction" }),
    ).toBeVisible();
    const promoted = harness.current().actions[0];
    expect(promoted).toMatchObject({
      id: beforeAction.id,
      title: beforeAction.title,
      createdAt: beforeAction.createdAt,
      status: "promoted",
      eligibility: { ...ELIGIBLE, estimateSeconds: 7_260 },
    });
    expect(promoted?.promotedProjectId).toBeDefined();
    expect(harness.current().actuals).toEqual(beforeActuals);
    expect(harness.current().inboxItems[0]).toMatchObject({
      id: INBOX_ID,
      actionId: ACTION_ID,
      projectId: promoted?.promotedProjectId,
      triageStatus: "project",
    });
    expect(harness.current().projects).toContainEqual(
      expect.objectContaining({
        id: promoted?.promotedProjectId,
        name: "Publish release notes",
        stage: "direction",
      }),
    );
    expect(harness.current().directionBriefs).toContainEqual(
      expect.objectContaining({ projectId: promoted?.promotedProjectId }),
    );
  });
});
