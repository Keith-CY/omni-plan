// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { renderV2 } from "../../test/renderV2";
import {
  addUnrelatedSyncHold,
  applyFixtureCommand,
  executingWorkspace,
  GUIDED_PROJECT_ID,
  GUIDED_UNFINISHED_ID,
  projectRuntime,
} from "../test/guidedStageFixture";
import { ExecuteStage, selectExecuteStage } from "./ExecuteStage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("ExecuteStage", () => {
  it("shows exact work state and requires explicit acknowledgement before validation", async () => {
    const user = userEvent.setup();
    const harness = projectRuntime(await executingWorkspace(), {
      beforeExecute: () => new Promise((resolve) => setTimeout(resolve, 25)),
    });
    renderV2(<><ExecuteStage projectId={GUIDED_PROJECT_ID} /><LocationProbe /></>, {
      runtime: harness.runtime,
    });

    const stage = await screen.findByRole("region", { name: "Execute workspace" });
    expect(within(stage).getByText("Current Bet scope")).toBeVisible();
    expect(within(stage).queryByText("Current Plan")).toBeNull();
    expect(within(stage).getByText("Validate the guided lifecycle")).toBeVisible();
    expect(within(stage).getByText("Document the optional follow-up")).toBeVisible();
    expect(within(stage).getByText("2 unfinished work items")).toBeVisible();

    await user.click(within(stage).getByRole("button", { name: "Review validation request" }));
    const dialog = screen.getByRole("dialog", { name: "Confirm validation request" });
    const confirm = within(dialog).getByRole("button", { name: "Request validation" });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", {
      name: /unfinished work still needs an explicit Close disposition/i,
    }));
    await user.click(confirm);

    expect(harness.commands).toEqual([{
      type: "request_validation",
      projectId: GUIDED_PROJECT_ID,
    }]);
    expect(harness.contexts[0]).toMatchObject({
      actorId: "human-ui",
      actorKind: "human",
      now: "2026-07-16T03:00:00.000Z",
    });
    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/projects/${GUIDED_PROJECT_ID}/evidence`,
      );
    });
  });

  it("fails closed without mutation controls for an ambiguous Project identity", async () => {
    const source = await executingWorkspace();
    source.projects.push(structuredClone(source.projects[0]));
    renderV2(<ExecuteStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Execute unavailable" })).toBeVisible();
    expect(within(unavailable).queryByRole("button")).toBeNull();
  });

  it("does not expose a validation request at the exact appetite boundary", async () => {
    const selection = selectExecuteStage(
      await executingWorkspace(),
      GUIDED_PROJECT_ID,
      "2026-07-19T00:00:00.000Z",
    );

    expect(selection).toEqual({
      ok: false,
      reason: "The active Bet appetite has ended. Complete the boundary Review and place a new Bet before requesting validation.",
    });
  });

  it("keeps Execute available after a legitimately committed Work Item is completed", async () => {
    const executing = await executingWorkspace();
    const withActual = await applyFixtureCommand(
      executing,
      {
        type: "record_actual",
        actual: {
          id: "actual:guided-follow-up",
          revision: 1,
          target: { kind: "work_item", workItemId: GUIDED_UNFINISHED_ID },
          actualWorkSeconds: 1_800,
          remainingWorkSeconds: 0,
          actualCost: 0,
          recordedAt: "2026-07-16T03:00:00.000Z",
        },
      },
      "fixture:record-guided-actual",
    );
    const completed = await applyFixtureCommand(
      withActual,
      {
        type: "complete_work_item",
        projectId: GUIDED_PROJECT_ID,
        workItemId: GUIDED_UNFINISHED_ID,
        resultStatus: "completed",
        outcomeNote: "The follow-up boundary was documented.",
      },
      "fixture:complete-guided-follow-up",
    );

    const selection = selectExecuteStage(
      completed,
      GUIDED_PROJECT_ID,
      "2026-07-16T03:00:00.000Z",
    );

    expect(selection).toMatchObject({
      ok: true,
      unfinished: [{ id: "work:validation-milestone" }],
    });
  });

  it("fails closed when an executing Plan loses its Daily Commitment provenance", async () => {
    const forged = await executingWorkspace();
    forged.dailyCommitments = [];

    expect(selectExecuteStage(
      forged,
      GUIDED_PROJECT_ID,
      "2026-07-16T03:00:00.000Z",
    )).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Daily Commitment/i),
    });
  });

  it("keeps the validation transition unavailable during an overdue Review", async () => {
    const source = await executingWorkspace();
    source.reviews.push({
      id: "review:guided-execute-overdue",
      kind: "event",
      triggerKey: "guided-execute-overdue",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [GUIDED_PROJECT_ID],
      affectedRecordIds: [GUIDED_PROJECT_ID],
      dueAt: "2026-07-16T02:00:00.000Z",
      createdAt: "2026-07-16T02:00:00.000Z",
      overdueMarkedAt: "2026-07-16T02:30:00.000Z",
    });
    renderV2(<ExecuteStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Execute workspace" });
    expect(within(stage).getByRole("button", { name: "Review validation request" })).toBeDisabled();
    expect(within(stage).getByText(/Complete the overdue Review/i)).toBeVisible();
  });

  it("does not block validation for a sync hold on an unrelated record", async () => {
    const source = addUnrelatedSyncHold(await executingWorkspace());
    renderV2(<ExecuteStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Execute workspace" });
    expect(within(stage).getByRole("button", {
      name: "Review validation request",
    })).toBeEnabled();
    expect(within(stage).queryByText(/Resolve the affected sync conflict/i)).toBeNull();
  });

  it("restores focus when a refreshed hold dismisses the open validation dialog", async () => {
    const user = userEvent.setup();
    const source = await executingWorkspace();
    const blocked = structuredClone(source);
    blocked.revision += 1;
    blocked.reviews.push({
      id: "review:guided-execute-refreshed",
      kind: "event",
      triggerKey: "guided-execute-refreshed",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [GUIDED_PROJECT_ID],
      affectedRecordIds: [GUIDED_PROJECT_ID],
      dueAt: "2026-07-16T02:00:00.000Z",
      createdAt: "2026-07-16T02:00:00.000Z",
      overdueMarkedAt: "2026-07-16T02:30:00.000Z",
    });
    blocked.projects[0].holds.push({
      type: "review_overdue",
      sourceId: "review:guided-execute-refreshed",
      affectedRecordIds: [GUIDED_PROJECT_ID],
      createdAt: "2026-07-16T02:30:00.000Z",
    });
    const harness = projectRuntime(source);
    const runtime = {
      ...harness.runtime,
      systemEvents: {
        run: vi.fn(async (
          _now: string,
          options?: { reason: "boot" | "timer" | "visibility" },
        ) => options?.reason === "visibility" ? blocked : source),
        nextScheduledWakeAt: vi.fn(() => undefined),
      },
    };
    renderV2(<ExecuteStage projectId={GUIDED_PROJECT_ID} />, { runtime });

    const stage = await screen.findByRole("region", { name: "Execute workspace" });
    const trigger = within(stage).getByRole("button", {
      name: "Review validation request",
    });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Confirm validation request" })).toBeVisible();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Confirm validation request" })).toBeNull();
    });
    await waitFor(() => {
      expect(within(stage).getByRole("heading", { name: "Execute workspace" })).toHaveFocus();
    });
  });
});
