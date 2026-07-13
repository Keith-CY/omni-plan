import { describe, expect, it, vi } from "vitest";

import type { CommandResult } from "../domain/commands";
import {
  AgentAdapter,
  type AgentDispatchInput,
  type AgentCommandServicePort,
  type AgentSourceResolver,
} from "./agentAdapter";

const NOW = "2026-07-14T06:00:00.000Z";

function input(): AgentDispatchInput {
  return {
    command: {
      type: "capture_inbox",
      id: "inbox-agent-1",
      text: "Capture through the V2 boundary",
    },
    commandId: "agent-command-1",
    expectedRevision: 7,
    actorId: "agent-1",
    sourceId: "shortcut-1",
    now: NOW,
  };
}

function service() {
  return {
    dispatch: vi.fn(() => Promise.resolve({} as CommandResult)),
  } satisfies AgentCommandServicePort;
}

function sourceResolver(
  source = {
    sourceId: "shortcut-1",
    verified: true,
    capabilities: ["capture_inbox" as const],
  },
) {
  return {
    resolve: vi.fn(() => source),
  } satisfies AgentSourceResolver;
}

describe("AgentAdapter", () => {
  it("snapshots an exact input and fixes actorKind and origin at its service boundary", async () => {
    const commandService = service();
    const resolver = sourceResolver();
    const value = input();

    await new AgentAdapter(commandService, resolver).dispatch(value);
    if (value.command.type === "capture_inbox") {
      value.command.text = "mutated after dispatch";
    }

    expect(resolver.resolve).toHaveBeenCalledWith({
      sourceId: "shortcut-1",
      actorId: "agent-1",
    });

    expect(commandService.dispatch).toHaveBeenCalledWith(
      {
        type: "capture_inbox",
        id: "inbox-agent-1",
        text: "Capture through the V2 boundary",
      },
      {
        commandId: "agent-command-1",
        expectedRevision: 7,
        actorId: "agent-1",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "shortcut-1",
          verified: true,
          capabilities: ["capture_inbox"],
        },
        now: NOW,
      },
    );
  });

  it("rejects caller-selected identity fields and unknown envelope fields", async () => {
    const commandService = service();
    const value = {
      ...input(),
      actorKind: "human",
      origin: "ui",
    };

    await expect(
      new AgentAdapter(commandService, sourceResolver()).dispatch(
        value as unknown as AgentDispatchInput,
      ),
    ).rejects.toMatchObject({
      name: "AgentAdapterBoundaryError",
      code: "INVALID_AGENT_DISPATCH_INPUT",
    });
    expect(commandService.dispatch).not.toHaveBeenCalled();
  });

  it("rejects accessors and non-JSON runtime graphs before calling the service", async () => {
    const commandService = service();
    const value = input() as AgentDispatchInput & { hidden?: string };
    Object.defineProperty(value, "actorId", {
      enumerable: true,
      get: () => "agent-1",
    });

    await expect(
      new AgentAdapter(commandService, sourceResolver()).dispatch(value),
    ).rejects.toThrow(/enumerable data value/i);
    expect(commandService.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    [
      "unverified",
      {
        sourceId: "shortcut-1",
        verified: false,
        capabilities: ["capture_inbox" as const],
      },
    ],
    [
      "mismatched",
      {
        sourceId: "other-source",
        verified: true,
        capabilities: ["capture_inbox" as const],
      },
    ],
  ] as const)("rejects a %s resolved source", async (_label, resolvedSource) => {
    const commandService = service();
    const resolver: AgentSourceResolver = {
      resolve: vi.fn(() =>
        resolvedSource === undefined
          ? undefined
          : {
              sourceId: resolvedSource.sourceId,
              verified: resolvedSource.verified,
              capabilities: [...resolvedSource.capabilities],
            }
      ),
    };

    await expect(
      new AgentAdapter(commandService, resolver).dispatch(input()),
    ).rejects.toMatchObject({
      name: "AgentAdapterBoundaryError",
      code: "INVALID_AGENT_DISPATCH_INPUT",
    });
    expect(commandService.dispatch).not.toHaveBeenCalled();
  });

  it("awaits an async resolver and snapshots its trusted CommandSource", async () => {
    const commandService = service();
    const trustedSource = {
      sourceId: "shortcut-1",
      verified: true,
      capabilities: ["capture_inbox" as const],
    };
    const resolver: AgentSourceResolver = {
      resolve: vi.fn(async () => trustedSource),
    };

    await new AgentAdapter(commandService, resolver).dispatch(input());
    trustedSource.capabilities.splice(0, 1);

    expect(commandService.dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        source: {
          sourceId: "shortcut-1",
          verified: true,
          capabilities: ["capture_inbox"],
        },
      }),
    );
  });
});
