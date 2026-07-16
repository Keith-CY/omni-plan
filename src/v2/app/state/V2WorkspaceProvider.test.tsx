// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ISODate } from "@/domain/types";

import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../../domain/commands";
import type { WorkspaceV2 } from "../../domain/types";
import type { BootstrapState } from "../../repositories/bootstrapService";
import {
  buildCapacityProfile,
  buildWorkspaceV2,
} from "../../tests/builders";
import {
  V2_MAX_TIMER_DELAY_MS,
  V2_SYSTEM_EVENT_RETRY_DELAY_MS,
  V2WorkspaceProvider,
  isOperationalV2WorkspaceState,
  useV2Workspace,
  type V2WorkspaceContextValue,
  type V2WorkspaceRuntime,
} from "./V2WorkspaceProvider";

const NOW = "2026-07-14T03:00:00.000Z" as ISODate;

function applied(workspace: WorkspaceV2): CommandResult {
  return { ok: true, workspace, receipt: {} as never };
}

function rejected(workspace: WorkspaceV2): CommandResult {
  return {
    ok: false,
    workspace,
    receipt: {} as never,
    rejection: { code: "SOURCE_NOT_AUTHORIZED" } as never,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function runtimeFor(
  state: BootstrapState | Promise<BootstrapState>,
  overrides: Partial<V2WorkspaceRuntime> = {},
): V2WorkspaceRuntime {
  return {
    bootstrap: {
      resolve: vi.fn(async () => state),
    },
    commands: {
      dispatch: vi.fn(async (_command, _context) => {
        throw new Error("Unexpected command dispatch");
      }),
    },
    systemEvents: {
      run: vi.fn(async () => undefined),
      nextScheduledWakeAt: vi.fn(() => undefined),
    },
    now: () => NOW,
    createCommandId: (() => {
      let sequence = 0;
      return () => `ui-command-${++sequence}`;
    })(),
    ...overrides,
  };
}

function StateProbe({
  onValue,
}: {
  onValue?: (value: V2WorkspaceContextValue) => void;
}) {
  const value = useV2Workspace();
  useEffect(() => onValue?.(value), [onValue, value]);
  return (
    <section>
      <output data-testid="status">{value.status}</output>
      {isOperationalV2WorkspaceState(value) ? (
        <>
          <output data-testid="revision">{value.workspace.revision}</output>
          <output data-testid="public-keys">
            {Object.keys(value).sort().join(",")}
          </output>
          <output data-testid="last-result">
            {value.lastCommandResult?.ok === false ? "rejected" : "none"}
          </output>
        </>
      ) : null}
    </section>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("V2WorkspaceProvider", () => {
  it("renders booting until bootstrap resolves", async () => {
    const bootstrap = deferred<BootstrapState>();
    const workspace = buildWorkspaceV2("personal");
    render(
      <V2WorkspaceProvider runtime={runtimeFor(bootstrap.promise)}>
        <StateProbe />
      </V2WorkspaceProvider>,
    );

    expect(screen.getByTestId("status")).toHaveTextContent("booting");
    bootstrap.resolve({ status: "setup_required", workspace });
    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("setup_required"),
    );
  });

  it("fails closed when bootstrap resolution or the boot event rejects", async () => {
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const runtimes = [
      runtimeFor(
        { status: "ready", workspace: ready },
        {
          bootstrap: {
            resolve: vi.fn(async () => {
              throw new Error("IndexedDB unavailable");
            }),
          },
        },
      ),
      runtimeFor(
        { status: "ready", workspace: ready },
        {
          systemEvents: {
            run: vi.fn(async () => {
              throw new Error("Boot event failed");
            }),
            nextScheduledWakeAt: vi.fn(() => undefined),
          },
        },
      ),
    ];

    for (const runtime of runtimes) {
      const view = render(
        <V2WorkspaceProvider runtime={runtime}>
          <StateProbe />
        </V2WorkspaceProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent("recovery_error"),
      );
      view.unmount();
    }
  });

  it.each([
    [
      "migration_required",
      { status: "migration_required", rawV1Payload: "{}" },
    ],
    [
      "recovery_error",
      {
        status: "recovery_error",
        recovery: {
          sourceChecksum: null,
          backupId: "backup-1",
          backupChecksum: "checksum-1",
          code: "V1_PARSE_FAILED",
          message: "Recovery required",
          occurredAt: NOW,
        },
      },
    ],
  ] as const)("exposes %s without a command dispatcher", async (status, state) => {
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider runtime={runtimeFor(state as BootstrapState)}>
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent(status),
    );
    expect(latest).not.toHaveProperty("dispatch");
    expect(latest).not.toHaveProperty("workspace");
  });

  it("exposes setup and ready workspaces without exposing setWorkspace", async () => {
    const setup = buildWorkspaceV2("personal");
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });

    for (const state of [
      { status: "setup_required", workspace: setup },
      { status: "ready", workspace: ready },
    ] satisfies BootstrapState[]) {
      const view = render(
        <V2WorkspaceProvider runtime={runtimeFor(state)}>
          <StateProbe />
        </V2WorkspaceProvider>,
      );
      await waitFor(() =>
        expect(screen.getByTestId("status")).toHaveTextContent(state.status),
      );
      expect(screen.getByTestId("public-keys")).not.toHaveTextContent(
        "setWorkspace",
      );
      view.unmount();
    }
  });

  it("allows only capacity setup before ready", async () => {
    const workspace = buildWorkspaceV2("personal");
    const dispatch = vi.fn(async (_command: V2Command, _context: CommandContext) =>
      applied(workspace),
    );
    const runtime = runtimeFor(
      { status: "setup_required", workspace },
      { commands: { dispatch } },
    );
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider runtime={runtime}>
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("setup_required"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected setup state");
    }
    const operational = latest;

    await expect(
      operational.dispatch({ type: "capture_inbox", id: "inbox-1", text: "No" }),
    ).rejects.toMatchObject({ code: "SETUP_COMMAND_REQUIRED" });
    expect(dispatch).not.toHaveBeenCalled();

    await act(async () => {
      await operational.dispatch({
        type: "configure_capacity",
        profile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
      });
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("builds authoritative human UI contexts with current revision and unique IDs", async () => {
    const workspace = buildWorkspaceV2("personal", {
      revision: 7,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const dispatch = vi.fn(async (_command: V2Command, _context: CommandContext) =>
      rejected(workspace),
    );
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider
        runtime={runtimeFor(
          { status: "ready", workspace },
          { commands: { dispatch } },
        )}
      >
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }
    const first: V2Command = {
      type: "capture_inbox",
      id: "inbox-1",
      text: "First",
    };
    const second: V2Command = {
      type: "capture_inbox",
      id: "inbox-2",
      text: "Second",
    };

    const operational = latest;
    await act(async () => {
      await operational.dispatch(first);
      await operational.dispatch(second);
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[0]?.[0]).toBe(first);
    expect(dispatch.mock.calls[1]?.[0]).toBe(second);
    const contexts = dispatch.mock.calls.map(([, context]) => context);
    const firstContext = contexts[0];
    const secondContext = contexts[1];
    expect(firstContext).toMatchObject({
      expectedRevision: 7,
      actorKind: "human",
      origin: "ui",
      source: {
        verified: true,
        capabilities: ["human_decision"],
      },
      now: NOW,
    });
    if (firstContext === undefined || secondContext === undefined) {
      throw new Error("Expected two command contexts");
    }
    expect(firstContext.commandId).not.toBe(secondContext.commandId);
  });

  it("binds a Bet start and its command context to one authoritative time", async () => {
    const workspace = buildWorkspaceV2("personal", {
      revision: 7,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const pending = deferred<CommandResult>();
    const dispatch = vi.fn(
      (_command: V2Command, _context: CommandContext) => pending.promise,
    );
    const now = vi.fn(() => NOW);
    const runtime = runtimeFor(
      { status: "ready", workspace },
      { commands: { dispatch }, now },
    );
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider runtime={runtime}>
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    await waitFor(() =>
      expect(runtime.systemEvents.nextScheduledWakeAt).toHaveBeenCalled(),
    );
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }

    const authoritativeNow = "2026-07-14T04:00:00.000Z" as ISODate;
    const laterNow = "2026-07-14T05:00:00.000Z" as ISODate;
    now.mockClear();
    now.mockReturnValueOnce(authoritativeNow).mockReturnValue(laterNow);
    const input: V2Command = {
      type: "place_bet",
      projectId: "project-1",
      betId: "bet-1",
      start: "2026-07-01T00:00:00.000Z" as ISODate,
    };

    const operation = latest.dispatch(input);

    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0];
    if (call === undefined) throw new Error("Expected Bet command dispatch");
    const [command, context] = call;
    expect(now).toHaveBeenCalledTimes(1);
    expect(command).toEqual({ ...input, start: authoritativeNow });
    expect(command).not.toBe(input);
    expect(input.start).toBe("2026-07-01T00:00:00.000Z");
    expect(command.type).toBe("place_bet");
    if (command.type !== "place_bet") throw new Error("Expected Bet command");
    expect(command.start).toBe(context.now);

    await act(async () => {
      pending.resolve(rejected(workspace));
      await operation;
    });
  });

  it("exposes the injected read clock and preserves it across Workspace replacement", async () => {
    const initial = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const accepted = buildWorkspaceV2("personal", {
      revision: 1,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const now = vi.fn(() => NOW);
    const dispatch = vi.fn(async () => applied(accepted));
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider runtime={runtimeFor(
        { status: "ready", workspace: initial },
        { now, commands: { dispatch } },
      )}>
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }
    const operational = latest;
    expect(operational.readCurrentTime()).toBe(NOW);

    const later = "2026-07-14T04:00:00.000Z" as ISODate;
    now.mockReturnValue(later);
    await act(async () => {
      await operational.dispatch({ type: "capture_inbox", id: "inbox-clock", text: "Clock" });
    });
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected updated ready state");
    }
    expect(latest.workspace.revision).toBe(1);
    expect(latest.readCurrentTime()).toBe(later);
  });

  it("advances the authoritative revision before a sequential dispatch resolves", async () => {
    const initial = buildWorkspaceV2("personal", {
      revision: 7,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const dispatch = vi.fn(
      async (_command: V2Command, context: CommandContext) =>
        applied(
          buildWorkspaceV2("personal", {
            revision: context.expectedRevision + 1,
            capacityProfile: buildCapacityProfile({
              updatedAt: NOW,
              updatedBy: "human-1",
            }),
          }),
        ),
    );
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider
        runtime={runtimeFor(
          { status: "ready", workspace: initial },
          { commands: { dispatch } },
        )}
      >
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }
    const operational = latest;

    await act(async () => {
      await operational.dispatch({
        type: "capture_inbox",
        id: "inbox-sequential-1",
        text: "First",
      });
      await operational.dispatch({
        type: "capture_inbox",
        id: "inbox-sequential-2",
        text: "Second",
      });
    });

    expect(
      dispatch.mock.calls.map(([, context]) => context.expectedRevision),
    ).toEqual([7, 8]);
    expect(screen.getByTestId("revision")).toHaveTextContent("9");
  });

  it("updates accepted Workspace state but keeps rejected state atomic", async () => {
    const initial = buildWorkspaceV2("personal", {
      revision: 3,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const accepted = buildWorkspaceV2("personal", {
      revision: 4,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const dispatch = vi
      .fn<(command: V2Command, context: CommandContext) => Promise<CommandResult>>()
      .mockResolvedValueOnce(applied(accepted))
      .mockResolvedValueOnce(rejected(accepted));
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider
        runtime={runtimeFor(
          { status: "ready", workspace: initial },
          { commands: { dispatch } },
        )}
      >
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }

    let operational = latest;
    await act(async () => {
      await operational.dispatch({
        type: "capture_inbox",
        id: "inbox-accepted",
        text: "Accepted",
      });
    });
    expect(screen.getByTestId("revision")).toHaveTextContent("4");

    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected updated ready state");
    }
    operational = latest;
    await act(async () => {
      await operational.dispatch({
        type: "capture_inbox",
        id: "inbox-rejected",
        text: "Rejected",
      });
    });
    expect(screen.getByTestId("revision")).toHaveTextContent("4");
    expect(screen.getByTestId("last-result")).toHaveTextContent("rejected");
  });

  it("never lets a delayed UI result replace a newer system-event revision", async () => {
    const initial = buildWorkspaceV2("personal", {
      revision: 3,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const uiWorkspace = buildWorkspaceV2("personal", {
      revision: 4,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const systemWorkspace = buildWorkspaceV2("personal", {
      revision: 5,
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const pendingUi = deferred<CommandResult>();
    const run = vi.fn(
      async (
        _now: ISODate,
        options?: { reason: "boot" | "timer" | "visibility" },
      ) => options?.reason === "visibility" ? systemWorkspace : initial,
    );
    let latest: V2WorkspaceContextValue | undefined;
    render(
      <V2WorkspaceProvider
        runtime={runtimeFor(
          { status: "ready", workspace: initial },
          {
            commands: { dispatch: vi.fn(() => pendingUi.promise) },
            systemEvents: {
              run,
              nextScheduledWakeAt: vi.fn(() => undefined),
            },
          },
        )}
      >
        <StateProbe onValue={(value) => { latest = value; }} />
      </V2WorkspaceProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ready"));
    if (!latest || !isOperationalV2WorkspaceState(latest)) {
      throw new Error("Expected ready state");
    }
    const operation = latest.dispatch({
      type: "capture_inbox",
      id: "inbox-delayed",
      text: "Delayed",
    });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("revision")).toHaveTextContent("5");

    await act(async () => {
      pendingUi.resolve(applied(uiWorkspace));
      await operation;
    });
    expect(screen.getByTestId("revision")).toHaveTextContent("5");
  });

  it("runs and schedules system events only while ready, including visibility recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const nextWake = "2026-07-14T03:00:01.000Z" as ISODate;
    const run = vi.fn(async () => ready);
    const nextScheduledWakeAt = vi.fn(() => nextWake);
    const runtime = runtimeFor(
      { status: "ready", workspace: ready },
      { systemEvents: { run, nextScheduledWakeAt } },
    );
    const view = render(
      <V2WorkspaceProvider runtime={runtime}>
        <StateProbe />
      </V2WorkspaceProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledWith(NOW, { reason: "boot" });
    expect(nextScheduledWakeAt).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(run).toHaveBeenCalledWith(NOW, { reason: "timer" });

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledWith(NOW, { reason: "visibility" });

    const callsBeforeUnmount = run.mock.calls.length;
    view.unmount();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.runOnlyPendingTimersAsync();
    });
    expect(run).toHaveBeenCalledTimes(callsBeforeUnmount);
  });

  it("retries a failed scheduled system event without an unhandled rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new Error("Transient repository failure"))
      .mockResolvedValueOnce(ready);
    const firstWake = new Date(Date.parse(NOW) + 1).toISOString();
    const runtime = runtimeFor(
      { status: "ready", workspace: ready },
      {
        systemEvents: {
          run,
          nextScheduledWakeAt: vi.fn(() => firstWake),
        },
      },
    );
    render(
      <V2WorkspaceProvider runtime={runtime}>
        <StateProbe />
      </V2WorkspaceProvider>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(V2_SYSTEM_EVENT_RETRY_DELAY_MS);
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails closed after bounded exponential retries for a persistent system-event failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValue(new Error("Persistent repository failure"));
    const firstWake = new Date(Date.parse(NOW) + 1).toISOString();
    render(
      <V2WorkspaceProvider
        runtime={runtimeFor(
          { status: "ready", workspace: ready },
          {
            systemEvents: {
              run,
              nextScheduledWakeAt: vi.fn(() => firstWake),
            },
            now: () => new Date(Date.now()).toISOString(),
          },
        )}
      >
        <StateProbe />
      </V2WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    for (const delay of [1, 1_000, 2_000, 4_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }

    expect(screen.getByTestId("status")).toHaveTextContent("recovery_error");
    expect(run).toHaveBeenCalledTimes(5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(run).toHaveBeenCalledTimes(5);
  });

  it("segments far-future wakes instead of overflowing the browser timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const ready = buildWorkspaceV2("personal", {
      capacityProfile: buildCapacityProfile({ updatedAt: NOW, updatedBy: "human-1" }),
    });
    const wakeTimestamp = Date.parse(NOW) + V2_MAX_TIMER_DELAY_MS + 1_000;
    const wakeAt = new Date(wakeTimestamp).toISOString();
    const run = vi.fn(async () => ready);
    const runtime = runtimeFor(
      { status: "ready", workspace: ready },
      {
        systemEvents: {
          run,
          nextScheduledWakeAt: vi.fn(() => wakeAt),
        },
        now: () => new Date(Date.now()).toISOString(),
      },
    );
    render(
      <V2WorkspaceProvider runtime={runtime}>
        <StateProbe />
      </V2WorkspaceProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(
      timeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .filter((delay): delay is number => typeof delay === "number")
        .every((delay) => delay <= V2_MAX_TIMER_DELAY_MS),
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(V2_MAX_TIMER_DELAY_MS);
    });
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
