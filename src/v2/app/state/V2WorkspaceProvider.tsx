import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ISODate } from "@/domain/types";

import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../../domain/commands";
import type { WorkspaceV2 } from "../../domain/types";
import type { MigrationRecoveryState } from "../../migration/recovery";
import {
  BootstrapService,
  canDispatchBootstrapCommand,
  type BootstrapState,
} from "../../repositories/bootstrapService";
import { BrowserWorkspaceRepository } from "../../repositories/browserWorkspaceRepository";
import { CommandService } from "../../repositories/commandService";
import {
  SystemEventCoordinator,
  type SystemEventRunReason,
} from "../../repositories/systemEventCoordinator";

export const V2_BROWSER_WORKSPACE_ID = "personal";
export const V2_UI_ACTOR_ID = "human-ui";
export const V2_UI_SOURCE_ID = "omni-plan-v2-ui";
export const V2_MAX_TIMER_DELAY_MS = 2_147_000_000;
export const V2_SYSTEM_EVENT_RETRY_DELAY_MS = 1_000;
export const V2_SYSTEM_EVENT_MAX_RETRY_DELAY_MS = 30_000;
export const V2_SYSTEM_EVENT_MAX_FAILURES = 4;

interface BootingState {
  status: "booting";
}

interface MigrationRequiredState {
  status: "migration_required";
  rawV1Payload: string;
}

interface RecoveryErrorState {
  status: "recovery_error";
  recovery: MigrationRecoveryState;
}

export interface OperationalV2WorkspaceState {
  status: "setup_required" | "ready";
  workspace: WorkspaceV2;
  lastCommandResult?: CommandResult;
  dispatch(command: V2Command): Promise<CommandResult>;
}

export type V2WorkspaceContextValue =
  | BootingState
  | MigrationRequiredState
  | RecoveryErrorState
  | OperationalV2WorkspaceState;

export interface V2WorkspaceRuntime {
  bootstrap: Pick<BootstrapService, "resolve">;
  commands: Pick<CommandService, "dispatch">;
  systemEvents: Pick<
    SystemEventCoordinator,
    "run" | "nextScheduledWakeAt"
  >;
  now(): ISODate;
  createCommandId(): string;
}

export class V2WorkspaceDispatchError extends Error {
  constructor(
    readonly code: "SETUP_COMMAND_REQUIRED" | "WORKSPACE_NOT_OPERATIONAL",
    message: string,
  ) {
    super(message);
    this.name = "V2WorkspaceDispatchError";
  }
}

export function isOperationalV2WorkspaceState(
  value: V2WorkspaceContextValue,
): value is OperationalV2WorkspaceState {
  return value.status === "setup_required" || value.status === "ready";
}

let fallbackCommandSequence = 0;

function browserCommandId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `ui:${uuid}`;
  fallbackCommandSequence += 1;
  return `ui:${Date.now()}:${fallbackCommandSequence}`;
}

function browserNow(): ISODate {
  return new Date().toISOString();
}

export function createBrowserV2WorkspaceRuntime(): V2WorkspaceRuntime {
  const repository = new BrowserWorkspaceRepository();
  const commands = new CommandService(repository, V2_BROWSER_WORKSPACE_ID);
  return {
    bootstrap: new BootstrapService({
      repository,
      workspaceId: V2_BROWSER_WORKSPACE_ID,
    }),
    commands,
    systemEvents: new SystemEventCoordinator(repository, commands),
    now: browserNow,
    createCommandId: browserCommandId,
  };
}

function operationalStatus(workspace: WorkspaceV2): "setup_required" | "ready" {
  return workspace.capacityProfile === undefined ? "setup_required" : "ready";
}

function publicBootstrapState(state: BootstrapState): V2WorkspaceContextValue {
  switch (state.status) {
    case "migration_required":
      return { status: state.status, rawV1Payload: state.rawV1Payload };
    case "recovery_error":
      return { status: state.status, recovery: state.recovery };
    case "setup_required":
    case "ready":
      throw new Error("Operational bootstrap state requires a dispatcher.");
  }
}

function bootstrapFailure(
  now: ISODate,
  message =
    "Workspace bootstrap failed. Reload after checking browser storage access.",
): RecoveryErrorState {
  return {
    status: "recovery_error",
    recovery: {
      sourceChecksum: null,
      backupId: "unavailable",
      backupChecksum: "unavailable",
      code: "MIGRATION_PERSISTENCE_FAILED",
      message,
      occurredAt: now,
    },
  };
}

function timerDelay(wakeAt: ISODate, now: ISODate): number | undefined {
  const wakeTimestamp = Date.parse(wakeAt);
  const nowTimestamp = Date.parse(now);
  if (!Number.isFinite(wakeTimestamp) || !Number.isFinite(nowTimestamp)) {
    return undefined;
  }
  return Math.max(0, wakeTimestamp - nowTimestamp);
}

function operationalCompletion(
  latest: V2WorkspaceContextValue,
  candidate: WorkspaceV2 | undefined,
  lastCommandResult?: CommandResult,
): OperationalV2WorkspaceState | undefined {
  if (!isOperationalV2WorkspaceState(latest)) return undefined;
  const workspace =
    candidate !== undefined && candidate.revision > latest.workspace.revision
      ? candidate
      : latest.workspace;
  return {
    status: operationalStatus(workspace),
    workspace,
    lastCommandResult: lastCommandResult ?? latest.lastCommandResult,
    dispatch: latest.dispatch,
  };
}

const V2WorkspaceContext = createContext<V2WorkspaceContextValue | undefined>(
  undefined,
);

export interface V2WorkspaceProviderProps {
  children: ReactNode;
  runtime?: V2WorkspaceRuntime;
}

export function V2WorkspaceProvider({
  children,
  runtime: runtimeInput,
}: V2WorkspaceProviderProps) {
  const runtime = useMemo(
    () => runtimeInput ?? createBrowserV2WorkspaceRuntime(),
    [runtimeInput],
  );
  const [state, setState] = useState<V2WorkspaceContextValue>({
    status: "booting",
  });
  const stateRef = useRef<V2WorkspaceContextValue>({ status: "booting" });
  const publishState = useCallback((next: V2WorkspaceContextValue) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const dispatch = useCallback(
    async (command: V2Command): Promise<CommandResult> => {
      const current = stateRef.current;
      if (!isOperationalV2WorkspaceState(current)) {
        throw new V2WorkspaceDispatchError(
          "WORKSPACE_NOT_OPERATIONAL",
          "Commands are unavailable until V2 bootstrap is operational.",
        );
      }
      const bootstrapState: BootstrapState = {
        status: current.status,
        workspace: current.workspace,
      };
      if (!canDispatchBootstrapCommand(bootstrapState, command.type)) {
        throw new V2WorkspaceDispatchError(
          "SETUP_COMMAND_REQUIRED",
          "Capacity setup must be completed before other commands.",
        );
      }
      const context: CommandContext = {
        commandId: runtime.createCommandId(),
        expectedRevision: current.workspace.revision,
        actorId: V2_UI_ACTOR_ID,
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: V2_UI_SOURCE_ID,
          verified: true,
          capabilities: ["human_decision"],
        },
        now: runtime.now(),
      };
      const result = await runtime.commands.dispatch(command, context);
      const next = operationalCompletion(
        stateRef.current,
        result.ok ? result.workspace : undefined,
        result,
      );
      if (next !== undefined) publishState(next);
      return result;
    },
    [publishState, runtime],
  );

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const bootstrapState = await runtime.bootstrap.resolve();
        if (!active) return;
        if (
          bootstrapState.status === "migration_required" ||
          bootstrapState.status === "recovery_error"
        ) {
          publishState(publicBootstrapState(bootstrapState));
          return;
        }
        let workspace = bootstrapState.workspace;
        if (bootstrapState.status === "ready") {
          workspace =
            (await runtime.systemEvents.run(runtime.now(), { reason: "boot" })) ??
            workspace;
        }
        if (!active) return;
        publishState({
          status: operationalStatus(workspace),
          workspace,
          dispatch,
        });
      } catch {
        if (active) publishState(bootstrapFailure(runtime.now()));
      }
    })();
    return () => {
      active = false;
    };
  }, [dispatch, publishState, runtime]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const scheduledWorkspace = state.workspace;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveFailures = 0;

    function clearScheduledTimer() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }

    function scheduleRetry() {
      if (!active) return;
      clearScheduledTimer();
      consecutiveFailures += 1;
      if (consecutiveFailures >= V2_SYSTEM_EVENT_MAX_FAILURES) {
        publishState(
          bootstrapFailure(
            runtime.now(),
            "Background workspace maintenance failed repeatedly. Reload after checking browser storage access.",
          ),
        );
        return;
      }
      const retryDelay = Math.min(
        V2_SYSTEM_EVENT_RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
        V2_SYSTEM_EVENT_MAX_RETRY_DELAY_MS,
      );
      timer = setTimeout(() => {
        timer = undefined;
        void run("timer");
      }, retryDelay);
    }

    async function run(reason: SystemEventRunReason) {
      try {
        const workspace = await runtime.systemEvents.run(runtime.now(), {
          reason,
        });
        if (!active) return;
        if (workspace === undefined) {
          scheduleRetry();
          return;
        }
        consecutiveFailures = 0;
        const next = operationalCompletion(stateRef.current, workspace);
        if (next !== undefined) publishState(next);
      } catch {
        scheduleRetry();
      }
    }

    function scheduleNextWake() {
      if (!active) return;
      clearScheduledTimer();
      const now = runtime.now();
      const wakeAt = runtime.systemEvents.nextScheduledWakeAt(
        scheduledWorkspace,
        now,
      );
      const delay = wakeAt === undefined ? undefined : timerDelay(wakeAt, now);
      if (delay === undefined) return;
      const boundedDelay = Math.min(delay, V2_MAX_TIMER_DELAY_MS);
      timer = setTimeout(() => {
        timer = undefined;
        if (delay > V2_MAX_TIMER_DELAY_MS) {
          scheduleNextWake();
          return;
        }
        void run("timer");
      }, boundedDelay);
    }

    scheduleNextWake();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void run("visibility");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      clearScheduledTimer();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [publishState, runtime, state]);

  return (
    <V2WorkspaceContext.Provider value={state}>
      {children}
    </V2WorkspaceContext.Provider>
  );
}

export function useV2Workspace(): V2WorkspaceContextValue {
  const value = useContext(V2WorkspaceContext);
  if (value === undefined) {
    throw new Error("useV2Workspace must be used inside V2WorkspaceProvider.");
  }
  return value;
}

export function useOperationalV2Workspace(): OperationalV2WorkspaceState {
  const value = useV2Workspace();
  if (!isOperationalV2WorkspaceState(value)) {
    throw new V2WorkspaceDispatchError(
      "WORKSPACE_NOT_OPERATIONAL",
      "The current bootstrap state does not expose command dispatch.",
    );
  }
  return value;
}
