// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { renderV2 } from "../../test/renderV2";
import {
  closingWorkspace,
  GUIDED_PROJECT_ID,
  planlessClosingWorkspace,
  projectRuntime,
} from "../test/guidedStageFixture";
import { CloseStage, selectCloseStage } from "./CloseStage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("CloseStage", () => {
  it("keeps receipt-backed Plan-less planning closure available", async () => {
    const harness = projectRuntime(await planlessClosingWorkspace());
    renderV2(<CloseStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });

    expect(await screen.findByRole("region", {
      name: "Close decision",
    })).toBeVisible();
    expect(screen.getByRole("button", {
      name: "Review Close decision",
    })).toBeDisabled();
  });

  it("hides the irreversible Close form while migration review blocks the command", async () => {
    const source = await closingWorkspace();
    const legacyId = "legacy:close-migration-review";
    source.legacyAuditRecords.push({
      id: legacyId,
      projectId: GUIDED_PROJECT_ID,
      recordType: "audit_gate",
      sourcePayload: { reason: "migration review" },
      sourceChecksum: "migration-review-checksum",
    });
    source.projects[0].holds.push({
      type: "migration_review",
      sourceId: legacyId,
      affectedRecordIds: [GUIDED_PROJECT_ID],
      createdAt: "2026-07-16T03:00:00.000Z",
    });
    renderV2(<CloseStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", {
      name: "Close unavailable",
    })).toBeVisible();
    expect(within(unavailable).getByText(/Complete migration review/i)).toBeVisible();
    expect(screen.queryByRole("region", { name: "Close decision" })).toBeNull();
  });

  it("blocks Close for a sync conflict that intersects its lifecycle", async () => {
    const source = await closingWorkspace();
    const betId = source.projects[0].activeBetId;
    if (betId === undefined) throw new Error("Expected current Bet");
    const conflictId = "conflict:close-current-bet";
    source.syncConflicts.push({
      id: conflictId,
      recordType: "bet",
      recordId: betId,
      projectId: GUIDED_PROJECT_ID,
      commonAncestorHash: "close-bet-ancestor",
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: "2026-07-16T03:00:00.000Z",
    });
    source.projects[0].holds.push({
      type: "sync_conflict",
      sourceId: conflictId,
      affectedRecordIds: [betId],
      createdAt: "2026-07-16T03:00:00.000Z",
    });

    expect(selectCloseStage(
      source,
      GUIDED_PROJECT_ID,
      "2026-07-16T03:00:00.000Z",
    )).toEqual({
      ok: false,
      reason: "Resolve the affected sync conflict before continuing.",
    });
  });

  it("requires every Close decision with no default and confirms the exact irreversible record", async () => {
    const user = userEvent.setup();
    const harness = projectRuntime(await closingWorkspace(), {
      beforeExecute: () => new Promise((resolve) => setTimeout(resolve, 25)),
    });
    renderV2(<><CloseStage projectId={GUIDED_PROJECT_ID} /><LocationProbe /></>, {
      runtime: harness.runtime,
    });

    const stage = await screen.findByRole("region", { name: "Close decision" });
    expect(within(stage).getByText(
      "Five teams complete the guided lifecycle without raw status edits.",
    )).toBeVisible();
    expect(within(stage).getByText("Document the optional follow-up")).toBeVisible();
    const review = within(stage).getByRole("button", { name: "Review Close decision" });
    expect(review).toBeDisabled();
    expect(within(stage).getByRole("combobox", { name: "Outcome" })).toHaveValue("");
    expect(within(stage).getByRole("combobox", { name: "Unfinished work disposition" })).toHaveValue("");

    await user.type(
      within(stage).getByRole("textbox", { name: "Success comparison" }),
      "Observed result versus the Direction success evidence.",
    );
    await user.selectOptions(within(stage).getByRole("combobox", { name: "Outcome" }), "achieved");
    await user.type(
      within(stage).getByRole("textbox", { name: "Key learning" }),
      "The bounded, explicit lifecycle kept the decision trail intact.",
    );
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Unfinished work disposition" }),
      "historical_incomplete",
    );
    expect(review).toBeEnabled();
    await user.click(review);

    const dialog = screen.getByRole("dialog", { name: "Confirm Project Close" });
    expect(within(dialog).getByText("Achieved")).toBeVisible();
    expect(within(dialog).getByText("Keep as historical incomplete")).toBeVisible();
    expect(within(dialog).getByText(/cannot be edited after Close/i)).toBeVisible();
    const consequences = within(dialog).getByRole("region", {
      name: "Exact Close consequences",
    });
    expect(within(consequences).getByText("Document the optional follow-up")).toBeVisible();
    expect(within(consequences).getByText("work:unfinished-follow-up")).toBeVisible();
    expect(within(consequences).getByText("Validate the guided lifecycle")).toBeVisible();
    expect(within(consequences).getByText("work:validation-milestone")).toBeVisible();
    expect(within(consequences).getByText(/generates no Inbox item or follow-up Project/i)).toBeVisible();
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const close = within(dialog).getByRole("button", { name: "Close Project" });
    cancel.focus();
    await user.tab({ shift: true });
    expect(close).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.click(close);

    expect(harness.commands).toEqual([{
      type: "close_project",
      projectId: GUIDED_PROJECT_ID,
      decision: {
        id: expect.stringMatching(/^close:/),
        projectId: GUIDED_PROJECT_ID,
        successComparison: "Observed result versus the Direction success evidence.",
        outcome: "achieved",
        keyLearning: "The bounded, explicit lifecycle kept the decision trail intact.",
        unfinishedDisposition: "historical_incomplete",
      },
    }]);
    await waitFor(() => {
      expect(harness.current().projects[0].stage).toBe("closed");
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      `/projects/${GUIDED_PROJECT_ID}/close`,
    );
  });

  it("requires an explicit follow-up identity when unfinished work moves to a new Project", async () => {
    const user = userEvent.setup();
    const harness = projectRuntime(await closingWorkspace());
    renderV2(<CloseStage projectId={GUIDED_PROJECT_ID} />, { runtime: harness.runtime });
    const stage = await screen.findByRole("region", { name: "Close decision" });

    await user.type(within(stage).getByRole("textbox", { name: "Success comparison" }), "Partial result observed.");
    await user.selectOptions(within(stage).getByRole("combobox", { name: "Outcome" }), "partial");
    await user.type(within(stage).getByRole("textbox", { name: "Key learning" }), "One bounded follow-up remains.");
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Unfinished work disposition" }),
      "follow_up_project",
    );

    const review = within(stage).getByRole("button", { name: "Review Close decision" });
    expect(review).toBeDisabled();
    await user.type(
      within(stage).getByRole("textbox", { name: "Follow-up Project ID" }),
      "project:guided-follow-up",
    );
    expect(review).toBeEnabled();
    await user.click(review);
    const dialog = screen.getByRole("dialog", { name: "Confirm Project Close" });
    const consequences = within(dialog).getByRole("region", {
      name: "Exact Close consequences",
    });
    expect(within(consequences).getByText("project:guided-follow-up")).toBeVisible();
    expect(within(consequences).getByText((content) =>
      content.includes("close_follow_up_direction") &&
      content.includes("project:guided-follow-up"),
    )).toBeVisible();
    expect(within(consequences).getByText(/no Inbox item is generated/i)).toBeVisible();
    expect(harness.commands).toEqual([]);
  });

  it("fails closed before exposing Close controls if required Evidence is missing", async () => {
    const source = await closingWorkspace();
    source.evidence = [];
    renderV2(<CloseStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Close unavailable" })).toBeVisible();
    expect(within(unavailable).queryByRole("button", { name: "Review Close decision" })).toBeNull();
  });

  it("fails closed when closure loses its committed Plan lineage", async () => {
    const source = await closingWorkspace();
    source.planVersions = [];
    renderV2(<CloseStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Close unavailable" })).toBeVisible();
    expect(within(unavailable).queryByRole("button", { name: "Review Close decision" })).toBeNull();
  });
});
