// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CommandResult, V2Command } from "../../domain/commands";
import type { WorkspaceV2 } from "../../domain/types";
import { buildCapacityProfile, buildWorkspaceV2 } from "../../tests/builders";
import {
  V2WorkspaceProvider,
  isOperationalV2WorkspaceState,
  useV2Workspace,
  type V2WorkspaceRuntime,
} from "./V2WorkspaceProvider";
import { useCommandForm } from "./useCommandForm";

const NOW = "2026-07-14T03:00:00.000Z";

function result(ok: boolean, workspace: WorkspaceV2): CommandResult {
  return ok
    ? { ok: true, workspace, receipt: {} as never }
    : {
        ok: false,
        workspace,
        receipt: {} as never,
        rejection: { code: "SOURCE_NOT_AUTHORIZED" } as never,
      };
}

function runtime(
  workspace: WorkspaceV2,
  dispatch: V2WorkspaceRuntime["commands"]["dispatch"],
): V2WorkspaceRuntime {
  return {
    bootstrap: {
      resolve: vi.fn(async () => ({ status: "ready" as const, workspace })),
    },
    commands: { dispatch },
    systemEvents: {
      run: vi.fn(async () => workspace),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: () => "form-command-1",
  };
}

function OperationalGate({ children }: { children: ReactNode }) {
  const state = useV2Workspace();
  return isOperationalV2WorkspaceState(state) ? children : null;
}

function FormHarness({
  onPair,
}: {
  onPair?: (
    first: Promise<CommandResult>,
    second: Promise<CommandResult>,
  ) => void;
}) {
  const rejectionFocusRef = useRef<HTMLButtonElement>(null);
  const successFocusRef = useRef<HTMLButtonElement>(null);
  const form = useCommandForm(
    (values: { text: string }): V2Command => ({
      type: "capture_inbox",
      id: `inbox-${values.text}`,
      text: values.text,
    }),
    { rejectionFocusRef, successFocusRef },
  );

  return (
    <section>
      <button
        type="button"
        onClick={() => {
          const first = form.submit({ text: "first" });
          const second = form.submit({ text: "second" });
          onPair?.(first, second);
        }}
      >
        Submit twice
      </button>
      <output data-testid="pending">{form.pending ? "pending" : "idle"}</output>
      <output data-testid="result">
        {form.result === undefined
          ? "none"
          : form.result.ok
            ? "accepted"
            : `rejected:${form.result.rejection.code}`}
      </output>
      {form.result?.ok === false ? (
        <button ref={rejectionFocusRef} type="button">
          Rejection details
        </button>
      ) : null}
      {form.result?.ok === true ? (
        <button ref={successFocusRef} type="button">
          Created record
        </button>
      ) : null}
    </section>
  );
}

describe("useCommandForm", () => {
  it("suppresses duplicate submit, returns one promise, and exposes pending/result", async () => {
    const workspace = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    let resolve!: (value: CommandResult) => void;
    const pendingResult = new Promise<CommandResult>((next) => {
      resolve = next;
    });
    const dispatch = vi.fn(() => pendingResult);
    let pair: readonly [Promise<CommandResult>, Promise<CommandResult>] | undefined;
    render(
      <V2WorkspaceProvider runtime={runtime(workspace, dispatch)}>
        <OperationalGate>
          <FormHarness onPair={(first, second) => { pair = [first, second]; }} />
        </OperationalGate>
      </V2WorkspaceProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit twice" })).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit twice" }));
    expect(pair?.[0]).toBe(pair?.[1]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("pending")).toHaveTextContent("pending");

    resolve(result(true, workspace));
    await waitFor(() =>
      expect(screen.getByTestId("result")).toHaveTextContent("accepted"),
    );
    expect(screen.getByTestId("pending")).toHaveTextContent("idle");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Created record" })).toHaveFocus(),
    );
  });

  it("keeps typed rejection details and hands focus to the rejection target", async () => {
    const workspace = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const dispatch = vi.fn(async () => result(false, workspace));
    render(
      <V2WorkspaceProvider runtime={runtime(workspace, dispatch)}>
        <OperationalGate>
          <FormHarness />
        </OperationalGate>
      </V2WorkspaceProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit twice" })).toBeVisible(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit twice" }));
    await waitFor(() =>
      expect(screen.getByTestId("result")).toHaveTextContent(
        "rejected:SOURCE_NOT_AUTHORIZED",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Rejection details" }),
      ).toHaveFocus(),
    );
  });
});
