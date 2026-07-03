import { describe, expect, it } from "vitest";
import {
  AGENT_PROTOCOL_VERSION,
  applyAgentCommandInput,
  buildAgentProjectText,
  buildAgentWorkspaceJson,
  parseAgentCommand,
  previewAgentCommandInput
} from "./agent";
import { sampleWorkspace } from "./sampleData";
import type { WorkspaceSnapshot } from "./types";

const fixedNow = "2026-07-02T00:00:00.000Z";

function cloneWorkspace(): WorkspaceSnapshot {
  return JSON.parse(JSON.stringify(sampleWorkspace)) as WorkspaceSnapshot;
}

describe("agent protocol", () => {
  it("renders UIless portfolio state with stable protocol metadata", () => {
    const snapshot = cloneWorkspace();
    const model = buildAgentWorkspaceJson(snapshot, fixedNow);
    const projectText = buildAgentProjectText(snapshot, "p-omni", fixedNow);

    expect(model.agent_protocol_version).toBe(AGENT_PROTOCOL_VERSION);
    expect(model.workspace_revision).toMatch(/^rev-/);
    expect(model.projects[0].summary).toHaveProperty("open_work");
    expect(model.projects[0]).toHaveProperty("shape_up");
    expect(buildAgentWorkspaceJson(snapshot, fixedNow).projects[0].shape_up.enabled).toBe(false);
    expect(buildAgentProjectText(snapshot, "p-omni", fixedNow)).toContain("Shape Up");
    expect(projectText).toContain("Command Inbox: /agent/commands");
    expect(projectText).not.toContain("github_pat");
  });

  it("parses simple natural language commands into structured commands", () => {
    const parsed = parseAgentCommand("Add task Review Shortcut import to project OmniPlan Personal, 1 hour");

    expect(parsed.errors).toEqual([]);
    expect(parsed.command?.command_type).toBe("create_task");
    expect(parsed.command?.project).toBe("OmniPlan Personal");
    expect(parsed.command?.title).toBe("Review Shortcut import");
  });

  it("dry-runs and applies low-risk task creation with an approved ChangeSet", () => {
    const snapshot = cloneWorkspace();
    const input = JSON.stringify({
      command_type: "create_task",
      project_id: "p-omni",
      title: "Review agent manual",
      effort_hours: 1,
      duration_days: 1
    });
    const dryRun = previewAgentCommandInput(snapshot, input, fixedNow);
    const applied = applyAgentCommandInput(snapshot, input, fixedNow);

    expect(dryRun.receipt.status).toBe("preview");
    expect(dryRun.receipt.risk).toBe("low-risk");
    expect(applied.receipt.status).toBe("applied");
    expect(applied.workspace.workItems.some((item) => item.title === "Review agent manual")).toBe(true);
    expect(applied.workspace.changeSets[0].status).toBe("approved");
  });

  it("queues guarded milestone completion instead of mutating task progress", () => {
    const snapshot = cloneWorkspace();
    snapshot.workItems = snapshot.workItems.map((item) => item.id === "w-milestone" ? { ...item, percentComplete: 80 } : item);
    const input = JSON.stringify({
      command_type: "update_task_progress",
      project_id: "p-omni",
      work_item_id: "w-milestone",
      percent_complete: 100
    });
    const applied = applyAgentCommandInput(snapshot, input, fixedNow);
    const milestone = applied.workspace.workItems.find((item) => item.id === "w-milestone");

    expect(applied.receipt.status).toBe("queued");
    expect(applied.receipt.risk).toBe("guarded");
    expect(milestone?.percentComplete).toBe(80);
    expect(applied.workspace.changeSets[0].status).toBe("queued-audit");
    expect(applied.workspace.auditGates[0].status).toBe("queued");
  });

  it("lets agents shape a project without approving the bet", () => {
    const snapshot = cloneWorkspace();
    const input = JSON.stringify({
      command_type: "add_shape_up_scope",
      project_id: "p-research",
      title: "Collect comparable stall cases",
      description: "Gather examples before committing automation.",
      hill_position: 25,
      confirmed: true
    });
    const applied = applyAgentCommandInput(snapshot, input, fixedNow);
    const project = applied.workspace.projects.find((item) => item.id === "p-research");

    expect(applied.receipt.status).toBe("applied");
    expect(applied.receipt.risk).toBe("low-risk");
    expect(project?.status).toBe("waiting");
    expect(project?.shapeUpPitch?.bet).toBeUndefined();
    expect(project?.shapeUpPitch?.scopes[0].title).toBe("Collect comparable stall cases");
  });
});
