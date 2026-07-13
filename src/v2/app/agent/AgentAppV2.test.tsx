// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../../tests/builders";
import type { BootstrapState } from "../../repositories/bootstrapService";
import { AgentAppV2 } from "./AgentAppV2";

const NOW = "2026-07-14T06:00:00.000Z";
const PROTOCOL = "2026-07-10.v2";

const readyWorkspace = buildWorkspaceV2("workspace-agent", {
  revision: 7,
  capacityProfile: buildCapacityProfile({
    updatedAt: NOW,
    updatedBy: "human-1",
  }),
  projects: [
    buildProjectV2({
      id: "project/alpha",
      name: "Agent bridge",
      stage: "direction",
      activeDirectionBriefId: "brief-1",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ],
  directionBriefs: [
    buildDirectionBrief({
      id: "brief-1",
      projectId: "project/alpha",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ],
});

function bootstrap(state: BootstrapState | Promise<BootstrapState>) {
  return {
    inspect: vi.fn(() => Promise.resolve(state)),
    resolve: vi.fn(() => {
      throw new Error("AgentAppV2 must never invoke mutating bootstrap resolution.");
    }),
  };
}

function adapter() {
  return { dispatch: vi.fn() };
}

function documentText(): string {
  return screen.getByTestId("agent-document").textContent ?? "";
}

function documentJson(): Record<string, unknown> {
  return JSON.parse(documentText()) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AgentAppV2 read protocol", () => {
  it("preserves every documented machine-readable route at protocol 2026-07-10.v2", async () => {
    const routes = [
      "/agent/manual.txt",
      "/agent/projects.txt",
      "/agent/projects.json",
      "/agent/projects/project%2Falpha.txt",
      "/agent/projects/project%2Falpha.json",
    ] as const;

    for (const pathname of routes) {
      const bootstrapService = bootstrap({
        status: "ready",
        workspace: readyWorkspace,
      });
      const view = render(
        <AgentAppV2
          pathname={pathname}
          bootstrapService={bootstrapService}
          agentAdapter={adapter()}
          now={() => NOW}
        />,
      );

      await waitFor(() => {
        expect(documentText()).toContain(PROTOCOL);
      });
      expect(bootstrapService.inspect).toHaveBeenCalledTimes(1);
      expect(bootstrapService.resolve).not.toHaveBeenCalled();

      if (pathname === "/agent/manual.txt") {
        for (const route of [...routes, "/agent/commands"]) {
          expect(documentText()).toContain(route);
        }
      } else {
        expect(documentText()).toContain("project/alpha");
        expect(documentText()).toContain("Agent bridge");
      }
      if (pathname.endsWith(".json")) {
        expect(documentJson()).toMatchObject({
          agent_protocol_version: PROTOCOL,
          generated_at: NOW,
          workspace_revision: 7,
        });
      }
      view.unmount();
    }
  });

  it("keeps the ready portfolio JSON projection schema-closed", async () => {
    render(
      <AgentAppV2
        pathname="/agent/projects.json"
        bootstrapService={bootstrap({
          status: "ready",
          workspace: readyWorkspace,
        })}
        agentAdapter={adapter()}
        now={() => NOW}
      />,
    );

    await waitFor(() =>
      expect(documentJson()).toMatchObject({ scope: "portfolio" }),
    );
    const model = documentJson() as {
      projects: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
    };
    expect(Object.keys(model).sort()).toEqual(
      [
        "agent_protocol_version",
        "generated_at",
        "projects",
        "scope",
        "totals",
        "workspace_revision",
        "write_entry",
      ].sort(),
    );
    expect(Object.keys(model.projects[0]).sort()).toEqual(
      [
        "active_bet",
        "active_direction",
        "active_plan",
        "counts",
        "created_at",
        "holds",
        "id",
        "name",
        "notes",
        "priority",
        "stage",
        "updated_at",
      ].sort(),
    );
    expect(Object.keys(model.totals).sort()).toEqual(
      [
        "dependencies",
        "evidence",
        "open_command_proposals",
        "projects",
        "work_items",
      ].sort(),
    );
  });

  it.each([
    ["migration_required", { status: "migration_required", rawV1Payload: "TOP-SECRET-V1" }],
    ["setup_required", { status: "setup_required", workspace: buildWorkspaceV2("workspace-agent") }],
    [
      "recovery_error",
      {
        status: "recovery_error",
        recovery: {
          sourceChecksum: "secret-source-checksum",
          backupId: "secret-backup-id",
          backupChecksum: "secret-backup-checksum",
          code: "MIGRATION_PERSISTENCE_FAILED",
          message: "private recovery detail",
          occurredAt: NOW,
        },
      },
    ],
  ] as const)(
    "returns a strict, non-sensitive bootstrap document for %s",
    async (bootstrapState, state) => {
      const bootstrapService = bootstrap(state as BootstrapState);
      render(
        <AgentAppV2
          pathname="/agent/projects.json"
          bootstrapService={bootstrapService}
          agentAdapter={adapter()}
          now={() => NOW}
        />,
      );

      await waitFor(() => {
        expect(documentJson()).toMatchObject({
          agent_protocol_version: PROTOCOL,
          generated_at: NOW,
          scope: "bootstrap",
          status: "bootstrap_required",
          bootstrap_state: bootstrapState,
          writes_allowed: false,
          required_human_action: expect.any(String),
        });
      });
      expect(Object.keys(documentJson()).sort()).toEqual(
        [
          "agent_protocol_version",
          "bootstrap_state",
          "generated_at",
          "required_human_action",
          "scope",
          "status",
          "writes_allowed",
        ].sort(),
      );
      expect(documentText()).not.toMatch(
        /TOP-SECRET-V1|secret-source-checksum|secret-backup-id|secret-backup-checksum|private recovery detail/,
      );
      expect(bootstrapService.inspect).toHaveBeenCalledTimes(1);
      expect(bootstrapService.resolve).not.toHaveBeenCalled();
    },
  );

  it("reports booting before BootstrapService resolves instead of projecting an empty Workspace", () => {
    const bootstrapService = bootstrap(
      new Promise<BootstrapState>(() => {
        // Intentionally unresolved.
      }),
    );
    render(
      <AgentAppV2
        pathname="/agent/projects.json"
        bootstrapService={bootstrapService}
        agentAdapter={adapter()}
        now={() => NOW}
      />,
    );

    expect(documentJson()).toMatchObject({
      agent_protocol_version: PROTOCOL,
      scope: "bootstrap",
      status: "bootstrap_required",
      bootstrap_state: "booting",
      writes_allowed: false,
    });
    expect(documentText()).not.toContain("workspace-agent");
    expect(bootstrapService.inspect).toHaveBeenCalledTimes(1);
    expect(bootstrapService.resolve).not.toHaveBeenCalled();
  });

  it("maps ready project records to closed DTOs and never exposes local Evidence references", async () => {
    const workspace = buildWorkspaceV2("workspace-agent", {
      ...readyWorkspace,
      workItems: [
        buildProjectWorkItem({
          id: "work-1",
          projectId: "project/alpha",
          betScopeId: "scope-1",
          title: "Bounded work",
        }),
      ],
      dependencies: [
        {
          id: "dependency-1",
          projectId: "project/alpha",
          fromId: "work-1",
          toId: "work-1",
          type: "FS",
          lagSeconds: 0,
          revision: 1,
        },
      ],
      evidence: [
        {
          id: "evidence-1",
          kind: "doc",
          summary: "Public summary",
          url: "https://example.test/evidence",
          localFileRef: "/Users/private/secret.md",
          projectId: "project/alpha",
          workItemId: "work-1",
          createdAt: NOW,
          confidence: 0.9,
          tags: ["verified"],
        },
      ],
      actuals: [
        {
          id: "actual-1",
          revision: 1,
          target: { kind: "work_item", workItemId: "work-1" },
          actualWorkSeconds: 60,
          remainingWorkSeconds: 120,
          actualCost: 10,
          recordedAt: NOW,
        },
      ],
      reviews: [
        {
          id: "review-1",
          kind: "event",
          triggerKey: "event:one",
          triggerType: "hard_gate",
          status: "open",
          affectedProjectIds: ["project/alpha"],
          affectedRecordIds: ["work-1"],
          dueAt: NOW,
          createdAt: NOW,
        },
      ],
      exceptions: [
        {
          id: "exception-1",
          projectId: "project/alpha",
          requirementId: "requirement-1",
          rationale: "Controlled exception",
          knownConsequence: "Known consequence",
          reviewAt: NOW,
          expiresAt: NOW,
          approvedBy: "human-1",
          createdAt: NOW,
          history: [
            {
              action: "created",
              actorId: "human-1",
              at: NOW,
              note: "Created",
            },
          ],
        },
      ],
    });
    render(
      <AgentAppV2
        pathname="/agent/projects/project%2Falpha.json"
        bootstrapService={bootstrap({ status: "ready", workspace })}
        agentAdapter={adapter()}
        now={() => NOW}
      />,
    );

    await waitFor(() => expect(documentJson()).toMatchObject({ status: "ok" }));
    const model = documentJson() as {
      project: Record<string, unknown>;
      work_items: Array<Record<string, unknown>>;
      dependencies: Array<Record<string, unknown>>;
      evidence: Array<Record<string, unknown>>;
      actuals: Array<Record<string, unknown>>;
      open_reviews: Array<Record<string, unknown>>;
      open_exceptions: Array<Record<string, unknown>>;
    };
    expect(Object.keys(model).sort()).toEqual(
      [
        "actuals",
        "agent_protocol_version",
        "dependencies",
        "evidence",
        "generated_at",
        "open_exceptions",
        "open_reviews",
        "project",
        "scope",
        "status",
        "work_items",
        "workspace_revision",
      ].sort(),
    );
    expect(Object.keys(model.project).sort()).toEqual(
      [
        "active_bet",
        "active_direction",
        "active_plan",
        "counts",
        "created_at",
        "holds",
        "id",
        "name",
        "notes",
        "priority",
        "stage",
        "updated_at",
      ].sort(),
    );
    expect(Object.keys(model.work_items[0]).sort()).toEqual(
      [
        "assignmentIds",
        "betScopeId",
        "durationSeconds",
        "estimate",
        "id",
        "kind",
        "outline",
        "percentComplete",
        "projectId",
        "revision",
        "title",
      ].sort(),
    );
    expect(Object.keys(model.dependencies[0]).sort()).toEqual(
      ["fromId", "id", "lagSeconds", "projectId", "revision", "toId", "type"].sort(),
    );
    expect(Object.keys(model.evidence[0]).sort()).toEqual(
      [
        "confidence",
        "createdAt",
        "id",
        "kind",
        "projectId",
        "summary",
        "tags",
        "url",
        "workItemId",
      ].sort(),
    );
    expect(model.evidence[0]).not.toHaveProperty("localFileRef");
    expect(documentText()).not.toContain("/Users/private/secret.md");
    expect(Object.keys(model.actuals[0]).sort()).toEqual(
      [
        "actualCost",
        "actualWorkSeconds",
        "id",
        "recordedAt",
        "remainingWorkSeconds",
        "revision",
        "target",
      ].sort(),
    );
    expect(Object.keys(model.open_reviews[0]).sort()).toEqual(
      [
        "affectedProjectIds",
        "affectedRecordIds",
        "createdAt",
        "dueAt",
        "id",
        "kind",
        "status",
        "triggerKey",
        "triggerType",
      ].sort(),
    );
    expect(Object.keys(model.open_exceptions[0]).sort()).toEqual(
      [
        "approvedBy",
        "createdAt",
        "expiresAt",
        "history",
        "id",
        "knownConsequence",
        "projectId",
        "rationale",
        "requirementId",
        "reviewAt",
      ].sort(),
    );
  });

  it("escapes CR, LF, and backslash in every line-oriented project field", async () => {
    const workspace = buildWorkspaceV2("workspace-agent", {
      ...readyWorkspace,
      projects: [
        buildProjectV2({
          id: "project/alpha",
          name: "Agent\nbridge\\name\rnext",
          stage: "direction",
          activeDirectionBriefId: "brief-1",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ],
      workItems: [
        buildProjectWorkItem({
          id: "work-1",
          projectId: "project/alpha",
          betScopeId: "scope-1",
          title: "First\nSecond\\Third\rFourth",
        }),
      ],
    });
    render(
      <AgentAppV2
        pathname="/agent/projects/project%2Falpha.txt"
        bootstrapService={bootstrap({ status: "ready", workspace })}
        agentAdapter={adapter()}
        now={() => NOW}
      />,
    );

    await waitFor(() => expect(documentText()).toContain("workspace_revision: 7"));
    expect(documentText()).not.toContain("\r");
    expect(documentText()).not.toContain("Agent\nbridge");
    expect(documentText()).not.toContain("First\nSecond");
    expect(documentText()).toContain("Agent\\nbridge\\\\name\\rnext");
    expect(documentText()).toContain("First\\nSecond\\\\Third\\rFourth");
  });
});

describe("AgentAppV2 command boundary", () => {
  it.each([
    { status: "migration_required", rawV1Payload: "TOP-SECRET-V1" },
    { status: "setup_required", workspace: buildWorkspaceV2("workspace-agent") },
    {
      status: "recovery_error",
      recovery: {
        sourceChecksum: null,
        backupId: "backup-1",
        backupChecksum: "checksum-1",
        code: "V1_PARSE_FAILED",
        message: "parse failed",
        occurredAt: NOW,
      },
    },
  ] as const)(
    "rejects writes in $status without adapter, V1, or IndexedDB access",
    async (state) => {
      const agentAdapter = adapter();
      const v1Read = vi.spyOn(Storage.prototype, "getItem");
      const indexedDbOpen = vi.fn();
      vi.stubGlobal("indexedDB", { open: indexedDbOpen });
      render(
        <AgentAppV2
          pathname="/agent/commands"
          bootstrapService={bootstrap(state as BootstrapState)}
          agentAdapter={agentAdapter}
          now={() => NOW}
        />,
      );

      await waitFor(() => {
        expect(documentText()).toContain("bootstrap_required");
      });
      expect(screen.queryByRole("textbox", { name: /agent command json/i })).not.toBeInTheDocument();
      expect(agentAdapter.dispatch).not.toHaveBeenCalled();
      expect(v1Read).not.toHaveBeenCalled();
      expect(indexedDbOpen).not.toHaveBeenCalled();
    },
  );

  it("dispatches an exact public envelope through agentAdapter without caller authority fields", async () => {
    const agentAdapter = adapter();
    const v1Read = vi.spyOn(Storage.prototype, "getItem");
    const indexedDbOpen = vi.fn();
    vi.stubGlobal("indexedDB", { open: indexedDbOpen });
    agentAdapter.dispatch.mockResolvedValue({
      ok: true,
      workspace: { ...readyWorkspace, revision: 8 },
      receipt: {
        id: "receipt-agent-command-1",
        commandId: "agent-command-1",
        commandType: "capture_inbox",
        baseRevision: 7,
        revision: 8,
        payloadHash: "payload-hash",
        receiptHash: "receipt-hash",
        actorId: "agent-1",
        actorKind: "agent",
        origin: "agent",
        source: {
          sourceId: "shortcut-1",
          verified: true,
          capabilities: ["capture_inbox"],
        },
        status: "applied",
        createdAt: NOW,
        diff: [],
      },
    });
    render(
      <AgentAppV2
        pathname="/agent/commands"
        bootstrapService={bootstrap({
          status: "ready",
          workspace: readyWorkspace,
        })}
        agentAdapter={agentAdapter}
        now={() => NOW}
      />,
    );

    const command = {
      type: "capture_inbox",
      id: "inbox-agent-1",
      text: "Capture only through the V2 command boundary",
    } as const;
    const input = {
      command,
      commandId: "agent-command-1",
      expectedRevision: 7,
      actorId: "agent-1",
      sourceId: "shortcut-1",
      now: NOW,
    };

    fireEvent.change(
      await screen.findByRole("textbox", { name: /agent command json/i }),
      { target: { value: JSON.stringify(input) } },
    );
    fireEvent.click(screen.getByRole("button", { name: /dispatch command/i }));

    await waitFor(() => {
      expect(agentAdapter.dispatch).toHaveBeenCalledWith({
        command,
        commandId: "agent-command-1",
        expectedRevision: 7,
        actorId: "agent-1",
        sourceId: "shortcut-1",
        now: NOW,
      });
    });
    expect(agentAdapter.dispatch).toHaveBeenCalledTimes(1);
    expect(v1Read).not.toHaveBeenCalled();
    expect(indexedDbOpen).not.toHaveBeenCalled();
    expect(await screen.findByText(/receipt-agent-command-1/)).toBeVisible();
  });

  it("rejects stale expectedRevision and caller-selected source authority before dispatch", async () => {
    const agentAdapter = adapter();
    render(
      <AgentAppV2
        pathname="/agent/commands"
        bootstrapService={bootstrap({
          status: "ready",
          workspace: readyWorkspace,
        })}
        agentAdapter={agentAdapter}
        now={() => NOW}
      />,
    );
    const value = {
      command: {
        type: "capture_inbox",
        id: "inbox-agent-1",
        text: "Capture",
      },
      commandId: "agent-command-1",
      expectedRevision: 6,
      actorId: "agent-1",
      sourceId: "shortcut-1",
      now: NOW,
    };
    fireEvent.change(
      await screen.findByRole("textbox", { name: /agent command json/i }),
      { target: { value: JSON.stringify(value) } },
    );
    fireEvent.click(screen.getByRole("button", { name: /dispatch command/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/stale expectedRevision/i);
    expect(agentAdapter.dispatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox", { name: /agent command json/i }), {
      target: {
        value: JSON.stringify({
          ...value,
          expectedRevision: 7,
          source: {
            sourceId: "shortcut-1",
            verified: true,
            capabilities: ["capture_inbox"],
          },
        }),
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /dispatch command/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/exact Agent envelope schema/i);
    expect(agentAdapter.dispatch).not.toHaveBeenCalled();
  });
});
