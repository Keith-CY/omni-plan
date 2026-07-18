// @vitest-environment jsdom
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { renderV2 } from "../../test/renderV2";
import { buildProjectWorkItem } from "../../../tests/builders";
import {
  addUnrelatedSyncHold,
  applyFixtureCommand,
  expiredValidatingWorkspace,
  GUIDED_NOW,
  GUIDED_PROJECT_ID,
  GUIDED_REQUIREMENT_ID,
  planlessValidatingWorkspace,
  projectRuntime,
  validatingWorkspace,
} from "../test/guidedStageFixture";
import { EvidenceStage } from "./EvidenceStage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

describe("EvidenceStage", () => {
  it("keeps the receipt-backed Plan-less planning closure path usable", async () => {
    const harness = projectRuntime(await planlessValidatingWorkspace());
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getByText(
      "Five teams complete the guided lifecycle without raw status edits.",
    )).toBeVisible();
    expect(within(stage).getByRole("button", {
      name: "Attach evidence",
    })).toBeDisabled();
    expect(within(stage).getByRole("combobox", {
      name: "Evidence requirement",
    })).toBeEnabled();
  });

  it("forces an explicit evidence target, kind, summary, and confidence before validation", async () => {
    const user = userEvent.setup();
    const harness = projectRuntime(await validatingWorkspace());
    renderV2(<><EvidenceStage projectId={GUIDED_PROJECT_ID} /><LocationProbe /></>, {
      runtime: harness.runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getByText("Missing evidence")).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeDisabled();
    expect(within(stage).getByRole("combobox", { name: "Evidence requirement" })).toHaveValue("");
    expect(within(stage).getByRole("combobox", { name: "Evidence kind" })).toHaveValue("");
    expect(within(stage).getByRole("spinbutton", { name: "Confidence from 0 to 1" })).toHaveValue(null);

    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Evidence requirement" }),
      GUIDED_REQUIREMENT_ID,
    );
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Evidence kind" }),
      "metric",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Evidence summary" }),
      "Five guided runs completed without help.",
    );
    await user.type(
      within(stage).getByRole("spinbutton", { name: "Confidence from 0 to 1" }),
      "0.91",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Source URL (optional)" }),
      "https://example.test/validation",
    );
    await user.click(within(stage).getByRole("button", { name: "Attach evidence" }));

    expect(harness.commands[0]).toEqual({
      type: "attach_evidence",
      evidence: {
        id: expect.stringMatching(/^evidence:/),
        kind: "metric",
        summary: "Five guided runs completed without help.",
        url: "https://example.test/validation",
        projectId: GUIDED_PROJECT_ID,
        workItemId: GUIDED_REQUIREMENT_ID,
        createdAt: "2026-07-16T03:00:00.000Z",
        confidence: 0.91,
        tags: [],
      },
    });
    expect(await within(stage).findByText("Satisfied by evidence")).toBeVisible();

    const review = within(stage).getByRole("button", { name: "Review validation completion" });
    expect(review).toBeEnabled();
    await user.click(review);
    const dialog = screen.getByRole("dialog", { name: "Confirm validation completion" });
    await user.click(within(dialog).getByRole("button", { name: "Complete validation" }));

    expect(harness.commands[1]).toEqual({
      type: "satisfy_validation",
      projectId: GUIDED_PROJECT_ID,
    });
    expect(await screen.findByTestId("location")).toHaveTextContent(
      `/projects/${GUIDED_PROJECT_ID}/close`,
    );
  });

  it("fails closed when a closing snapshot has lost required Evidence", async () => {
    const source = await validatingWorkspace(true);
    source.evidence = [];
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getByText("Missing evidence")).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeDisabled();
  });

  it("keeps a same-Project requirement outside the current Bet in the authoritative gate", async () => {
    const source = await validatingWorkspace(true);
    source.workItems.push(buildProjectWorkItem({
      id: "work:historical-requirement",
      projectId: GUIDED_PROJECT_ID,
      betScopeId: "scope:historical",
      kind: "milestone",
      title: "Historical evidence requirement",
      evidenceRequired: true,
    }));
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getAllByText("Historical evidence requirement")[0]).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeDisabled();
  });

  it("fails closed when validation loses its committed Plan lineage", async () => {
    const source = await validatingWorkspace(true);
    source.planVersions = [];
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const unavailable = await screen.findByRole("alert");
    expect(within(unavailable).getByRole("heading", { name: "Evidence unavailable" })).toBeVisible();
    expect(within(unavailable).queryByRole("button", { name: "Review validation completion" })).toBeNull();
  });

  it("freezes Evidence inputs and suppresses a duplicate submit while attachment is pending", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const harness = projectRuntime(await validatingWorkspace(), {
      beforeExecute: () => gate,
    });
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });
    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    const requirement = within(stage).getByRole("combobox", { name: "Evidence requirement" });
    const kind = within(stage).getByRole("combobox", { name: "Evidence kind" });
    const summary = within(stage).getByRole("textbox", { name: "Evidence summary" });
    const confidence = within(stage).getByRole("spinbutton", { name: "Confidence from 0 to 1" });
    await user.selectOptions(requirement, GUIDED_REQUIREMENT_ID);
    await user.selectOptions(kind, "metric");
    await user.type(summary, "Five exact guided runs completed.");
    await user.type(confidence, "0.9");

    const attach = within(stage).getByRole("button", { name: "Attach evidence" });
    await user.dblClick(attach);

    expect(harness.commands).toHaveLength(1);
    expect(requirement).toBeDisabled();
    expect(kind).toBeDisabled();
    expect(summary).toBeDisabled();
    expect(confidence).toBeDisabled();
    expect(attach).toBeDisabled();

    await act(async () => { release(); });
    await waitFor(() => {
      expect(within(stage).getByText("Satisfied by evidence")).toBeVisible();
    });
  });

  it("binds Evidence creation to the authoritative submit-time clock", async () => {
    const user = userEvent.setup();
    let clockTick = 0;
    const harness = projectRuntime(await validatingWorkspace(), {
      now: () => new Date(
        Date.parse(GUIDED_NOW) + clockTick++,
      ).toISOString(),
    });
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });
    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Evidence requirement" }),
      GUIDED_REQUIREMENT_ID,
    );
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Evidence kind" }),
      "metric",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Evidence summary" }),
      "Observed at the exact submission boundary.",
    );
    await user.type(
      within(stage).getByRole("spinbutton", { name: "Confidence from 0 to 1" }),
      "0.88",
    );

    await user.click(within(stage).getByRole("button", { name: "Attach evidence" }));

    const submitted = harness.commands[0];
    expect(submitted).toMatchObject({ type: "attach_evidence" });
    if (submitted.type !== "attach_evidence") {
      throw new Error("Expected an Evidence attachment");
    }
    expect(submitted.evidence.createdAt).toBe(harness.contexts[0].now);
  });

  it("makes a controlled exception explicit and requires a separate human approval", async () => {
    const user = userEvent.setup();
    const harness = projectRuntime(await validatingWorkspace());
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });
    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    await user.click(within(stage).getByRole("button", { name: "Start controlled exception" }));
    await user.selectOptions(
      within(stage).getByRole("combobox", { name: "Missing requirement" }),
      GUIDED_REQUIREMENT_ID,
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Exception rationale" }),
      "The independent observer report is delayed by one bounded review window.",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Known consequence" }),
      "Validation temporarily relies on an unverified observer count.",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Review at (canonical ISO)" }),
      "2026-07-16T04:00:00.000Z",
    );
    await user.type(
      within(stage).getByRole("textbox", { name: "Expires at (canonical ISO)" }),
      "2026-07-17T03:00:00.000Z",
    );
    await user.click(within(stage).getByRole("button", { name: "Review controlled exception" }));

    const dialog = screen.getByRole("dialog", { name: "Approve temporary evidence exception" });
    const approve = within(dialog).getByRole("button", { name: "Approve controlled exception" });
    expect(approve).toBeDisabled();
    expect(within(dialog).getByText(GUIDED_REQUIREMENT_ID)).toBeVisible();
    await user.click(within(dialog).getByRole("checkbox", {
      name: /temporary exception is not proof/i,
    }));
    await user.click(approve);

    expect(harness.commands[0]).toEqual({
      type: "approve_evidence_exception",
      exception: {
        id: expect.stringMatching(/^exception:/),
        projectId: GUIDED_PROJECT_ID,
        requirementId: GUIDED_REQUIREMENT_ID,
        rationale: "The independent observer report is delayed by one bounded review window.",
        knownConsequence: "Validation temporarily relies on an unverified observer count.",
        reviewAt: "2026-07-16T04:00:00.000Z",
        expiresAt: "2026-07-17T03:00:00.000Z",
      },
    });
    expect(await within(stage).findByText("Covered by controlled exception")).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeEnabled();
  });

  it("closes an open validation dialog when its exception expires", async () => {
    const source = await applyFixtureCommand(
      await validatingWorkspace(),
      {
        type: "approve_evidence_exception",
        exception: {
          id: "exception:expiring-guided-review",
          projectId: GUIDED_PROJECT_ID,
          requirementId: GUIDED_REQUIREMENT_ID,
          rationale: "A bounded observer delay.",
          knownConsequence: "The count is temporarily unverified.",
          reviewAt: GUIDED_NOW,
          expiresAt: "2026-07-16T03:10:00.000Z",
        },
      },
      "fixture:approve-expiring-exception",
    );
    let now = "2026-07-16T03:05:00.000Z";
    const harness = projectRuntime(source, { now: () => now });
    const rendered = renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: harness.runtime,
    });
    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    const trigger = within(stage).getByRole("button", {
      name: "Review validation completion",
    });
    await userEvent.setup().click(trigger);
    expect(screen.getByRole("dialog", { name: "Confirm validation completion" })).toBeVisible();

    now = "2026-07-16T03:10:00.000Z";
    rendered.rerender(<EvidenceStage projectId={GUIDED_PROJECT_ID} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Confirm validation completion" })).toBeNull();
    });
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeDisabled();
    expect(within(stage).getByText(/exception:expiring-guided-review expired/i)).toBeVisible();
    await waitFor(() => {
      expect(within(stage).getByRole("heading", { name: "Evidence workspace" })).toHaveFocus();
    });
  });

  it("does not present validation completion while an overdue Review blocks it", async () => {
    const source = await validatingWorkspace(true);
    source.reviews.push({
      id: "review:guided-overdue",
      kind: "event",
      triggerKey: "guided-overdue",
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [GUIDED_PROJECT_ID],
      affectedRecordIds: [GUIDED_PROJECT_ID],
      dueAt: "2026-07-16T02:00:00.000Z",
      createdAt: "2026-07-16T02:00:00.000Z",
      overdueMarkedAt: "2026-07-16T02:30:00.000Z",
    });
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getByText("Blocked by Review")).toBeVisible();
    expect(within(stage).getByRole("button", { name: "Review validation completion" })).toBeDisabled();
    expect(within(stage).getByText("complete_review")).toBeVisible();
  });

  it("does not block validation for a sync hold on an unrelated record", async () => {
    const source = addUnrelatedSyncHold(await validatingWorkspace(true));
    renderV2(<EvidenceStage projectId={GUIDED_PROJECT_ID} />, {
      runtime: projectRuntime(source).runtime,
    });

    const stage = await screen.findByRole("region", { name: "Evidence workspace" });
    expect(within(stage).getByRole("button", {
      name: "Review validation completion",
    })).toBeEnabled();
    expect(within(stage).queryByText(/Resolve the affected sync conflict/i)).toBeNull();
  });

  it("exposes appetite-boundary abandonment only through an irreversible human review", async () => {
    const user = userEvent.setup();
    const source = await expiredValidatingWorkspace();
    const appetiteEnd = source.bets.find(
      ({ id }) => id === source.projects[0].activeBetId,
    )!.appetiteEnd;
    const harness = projectRuntime(source, {
      beforeExecute: () => new Promise((resolve) => setTimeout(resolve, 25)),
      now: () => appetiteEnd,
    });
    renderV2(<><EvidenceStage projectId={GUIDED_PROJECT_ID} /><LocationProbe /></>, {
      runtime: harness.runtime,
    });
    const boundary = await screen.findByRole("region", { name: "Appetite boundary decision" });
    await user.click(within(boundary).getByRole("button", { name: "Start abandonment review" }));
    await user.type(
      within(boundary).getByRole("textbox", { name: "Success comparison" }),
      "The target proof arrived, but the bounded result did not justify another Bet.",
    );
    await user.type(
      within(boundary).getByRole("textbox", { name: "Key learning" }),
      "The premise was weaker than the observed workflow cost.",
    );
    await user.selectOptions(
      within(boundary).getByRole("combobox", { name: "Unfinished work disposition" }),
      "historical_incomplete",
    );
    await user.click(within(boundary).getByRole("button", { name: "Review abandonment decision" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm Project abandonment" });
    expect(within(dialog).getByText("Abandoned")).toBeVisible();
    expect(within(dialog).getByText(GUIDED_REQUIREMENT_ID)).toBeVisible();
    const abandon = within(dialog).getByRole("button", { name: "Abandon and close Project" });
    expect(abandon).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", {
      name: /closes the Project permanently as abandoned/i,
    }));
    await user.click(abandon);

    expect(harness.commands).toEqual([{
      type: "abandon_project",
      projectId: GUIDED_PROJECT_ID,
      decision: {
        id: expect.stringMatching(/^abandon:/),
        projectId: GUIDED_PROJECT_ID,
        successComparison: "The target proof arrived, but the bounded result did not justify another Bet.",
        outcome: "abandoned",
        keyLearning: "The premise was weaker than the observed workflow cost.",
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
});
