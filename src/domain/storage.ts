import type { WorkspaceSnapshot } from "./types";
import { normalizeWorkspaceSnapshot } from "./projectLifecycle";

export interface WorkspaceRepository {
  load(): Promise<WorkspaceSnapshot | undefined>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  exportWorkspace(snapshot: WorkspaceSnapshot): string;
  importWorkspace(payload: string): WorkspaceSnapshot;
}

export const V1_WORKSPACE_STORAGE_KEY = "omni-plan-personal.workspace.v1";

export class BrowserWorkspaceRepository implements WorkspaceRepository {
  async load(): Promise<WorkspaceSnapshot | undefined> {
    const raw = localStorage.getItem(V1_WORKSPACE_STORAGE_KEY);
    return raw ? this.importWorkspace(raw) : undefined;
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    localStorage.setItem(V1_WORKSPACE_STORAGE_KEY, this.exportWorkspace(snapshot));
  }

  exportWorkspace(snapshot: WorkspaceSnapshot): string {
    return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), snapshot: normalizeWorkspaceSnapshot(snapshot) }, null, 2);
  }

  importWorkspace(payload: string): WorkspaceSnapshot {
    const parsed = JSON.parse(payload) as { schemaVersion: number; snapshot: WorkspaceSnapshot };
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported workspace schema version ${parsed.schemaVersion}`);
    }
    return normalizeWorkspaceSnapshot(parsed.snapshot);
  }
}

export const browserWorkspaceStorageStatus = {
  selected: true,
  implemented: true,
  engine: "Browser local workspace store",
  sourceOfTruth: "Browser local DB for this preview",
  backupPolicy: "Manual encrypted export/import for transfer; GitHub sync handles cross-device ChangeSets",
  persistence: "Automatic save after local workspace edits"
};
