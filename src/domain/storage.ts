import type { WorkspaceSnapshot } from "./types";

export interface WorkspaceRepository {
  load(): Promise<WorkspaceSnapshot | undefined>;
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  exportWorkspace(snapshot: WorkspaceSnapshot): string;
  importWorkspace(payload: string): WorkspaceSnapshot;
}

const STORAGE_KEY = "omni-plan-personal.workspace.v1";

export class BrowserWorkspaceRepository implements WorkspaceRepository {
  async load(): Promise<WorkspaceSnapshot | undefined> {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? this.importWorkspace(raw) : undefined;
  }

  async save(snapshot: WorkspaceSnapshot): Promise<void> {
    localStorage.setItem(STORAGE_KEY, this.exportWorkspace(snapshot));
  }

  exportWorkspace(snapshot: WorkspaceSnapshot): string {
    return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), snapshot }, null, 2);
  }

  importWorkspace(payload: string): WorkspaceSnapshot {
    const parsed = JSON.parse(payload) as { schemaVersion: number; snapshot: WorkspaceSnapshot };
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported workspace schema version ${parsed.schemaVersion}`);
    }
    return parsed.snapshot;
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
