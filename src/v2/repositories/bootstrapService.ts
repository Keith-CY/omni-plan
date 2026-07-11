import { V1_WORKSPACE_STORAGE_KEY } from "@/domain/storage";

import type { V2Command } from "../domain/commands";
import type { WorkspaceV2 } from "../domain/types";
import { createEmptyWorkspaceV2 } from "../domain/workspace";
import type { MigrationRecoveryState } from "../migration/recovery";

export interface BootstrapWorkspaceRepository {
  loadMigrationRecovery(): Promise<MigrationRecoveryState | undefined>;
  clearMigrationRecoveryIfMatching(expected: {
    sourceChecksum: string;
    backupId: string;
    backupChecksum: string;
  }): Promise<"cleared" | "not_found" | "not_matching">;
  load(): Promise<WorkspaceV2 | undefined>;
  initialize(
    workspace: WorkspaceV2,
  ): Promise<"initialized" | "already_exists">;
}

export interface RawV1Storage {
  getItem(key: string): string | null;
}

export type BootstrapState =
  | { status: "recovery_error"; recovery: MigrationRecoveryState }
  | { status: "migration_required"; rawV1Payload: string }
  | { status: "setup_required"; workspace: WorkspaceV2 }
  | { status: "ready"; workspace: WorkspaceV2 };

export function bootstrapAllowsCommandService(
  state: BootstrapState,
): state is Extract<
  BootstrapState,
  { status: "setup_required" | "ready" }
> {
  return state.status === "setup_required" || state.status === "ready";
}

export function canDispatchBootstrapCommand(
  state: BootstrapState,
  commandType: V2Command["type"],
): boolean {
  if (state.status === "ready") return true;
  return (
    state.status === "setup_required" && commandType === "configure_capacity"
  );
}

export interface BootstrapServiceOptions {
  repository: BootstrapWorkspaceRepository;
  workspaceId: string;
  v1Storage?: RawV1Storage;
}

function browserV1Storage(): RawV1Storage {
  if (typeof globalThis.localStorage === "undefined") {
    throw new Error("Browser localStorage is unavailable during bootstrap.");
  }
  return globalThis.localStorage;
}

function operationalState(workspace: WorkspaceV2): BootstrapState {
  return workspace.capacityProfile === undefined
    ? { status: "setup_required", workspace }
    : { status: "ready", workspace };
}

function recoveryMatchesCommittedMigration(
  recovery: MigrationRecoveryState,
  workspace: WorkspaceV2 | undefined,
): workspace is WorkspaceV2 {
  return (
    recovery.sourceChecksum !== null &&
    workspace?.migration?.sourceChecksum === recovery.sourceChecksum &&
    workspace.migration.backupId === recovery.backupId &&
    workspace.migration.backupChecksum === recovery.backupChecksum
  );
}

function assertWorkspaceIdentity(
  workspace: WorkspaceV2 | undefined,
  expectedWorkspaceId: string,
): void {
  if (
    workspace !== undefined &&
    workspace.workspaceId !== expectedWorkspaceId
  ) {
    throw new Error(
      `Stored V2 Workspace identity ${workspace.workspaceId} does not match expected workspaceId ${expectedWorkspaceId}.`,
    );
  }
}

export class BootstrapService {
  private readonly repository: BootstrapWorkspaceRepository;
  private readonly workspaceId: string;
  private readonly v1Storage: RawV1Storage | undefined;

  constructor(options: BootstrapServiceOptions) {
    this.repository = options.repository;
    this.workspaceId = options.workspaceId;
    this.v1Storage = options.v1Storage;
  }

  async resolve(): Promise<BootstrapState> {
    const recovery = await this.repository.loadMigrationRecovery();
    const existing = await this.repository.load();
    assertWorkspaceIdentity(existing, this.workspaceId);
    if (recovery !== undefined) {
      const recoverySourceChecksum = recovery.sourceChecksum;
      if (
        recoverySourceChecksum !== null &&
        recoveryMatchesCommittedMigration(recovery, existing)
      ) {
        const cleared = await this.repository.clearMigrationRecoveryIfMatching({
          sourceChecksum: recoverySourceChecksum,
          backupId: recovery.backupId,
          backupChecksum: recovery.backupChecksum,
        });
        if (cleared === "cleared") return operationalState(existing);
        const latestRecovery = await this.repository.loadMigrationRecovery();
        return latestRecovery === undefined
          ? operationalState(existing)
          : { status: "recovery_error", recovery: latestRecovery };
      }
      return { status: "recovery_error", recovery };
    }
    if (existing !== undefined) return operationalState(existing);
    const rawV1Payload = (this.v1Storage ?? browserV1Storage()).getItem(
      V1_WORKSPACE_STORAGE_KEY,
    );
    if (rawV1Payload !== null) {
      return { status: "migration_required", rawV1Payload };
    }
    await this.repository.initialize(createEmptyWorkspaceV2(this.workspaceId));
    const initialized = await this.repository.load();
    if (initialized === undefined) {
      throw new Error("V2 Workspace initialization did not persist a Workspace.");
    }
    assertWorkspaceIdentity(initialized, this.workspaceId);
    return operationalState(initialized);
  }
}
