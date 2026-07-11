import { normalizeWorkspaceSnapshot } from "@/domain/projectLifecycle";
import { V1_WORKSPACE_STORAGE_KEY } from "@/domain/storage";
import type { ISODate, Id, WorkspaceSnapshot } from "@/domain/types";

import { stableHash } from "../domain/stableHash";
import type {
  JsonValue,
  MigrationRecord,
  WorkspaceV2,
} from "../domain/types";
import type {
  MigrationWorkspaceRepository,
  VerifiedBackupRecord,
} from "../repositories/browserWorkspaceRepository";
import {
  createRawV1Backup,
  createVerifiedBackupDownload,
  parseV1Export,
  type RawV1Backup,
  type VerifiedBackupDownload,
  verifyRawV1Backup,
} from "./backup";
import { migrateV1Workspace } from "./migrateV1";
import {
  validateMigratedWorkspace,
  type MigrationValidationExpectations,
} from "./validateMigration";

export type MigrationRecoveryCode =
  | "BACKUP_VERIFICATION_FAILED"
  | "V1_PARSE_FAILED"
  | "MIGRATION_VALIDATION_FAILED"
  | "MIGRATION_PERSISTENCE_FAILED"
  | "MIGRATION_CONFLICT";

export interface MigrationRecoveryViolation {
  code: string;
  message: string;
  entityId?: string;
  path?: string;
}

export interface MigrationRecoveryState {
  sourceChecksum: string | null;
  backupId: string;
  backupChecksum: string;
  code: MigrationRecoveryCode;
  message: string;
  occurredAt: ISODate;
  violations?: readonly MigrationRecoveryViolation[];
}

export interface V1MigrationOptions {
  workspaceId: Id;
  sourceChecksum: string;
  backupId: Id;
  backupChecksum: string;
  actorId: Id;
  now: ISODate;
}

export interface V1MigrationCandidate {
  workspace: WorkspaceV2;
  migration: MigrationRecord;
  report: unknown;
}

export interface V1MigrationViolation {
  code: string;
  path: string;
  message: string;
}

export type V1WorkspaceMapper = (
  source: WorkspaceSnapshot,
  options: V1MigrationOptions,
) => V1MigrationCandidate | Promise<V1MigrationCandidate>;

export interface MigrateBrowserWorkspaceInput {
  rawV1Payload: string;
  workspaceId: Id;
  actorId: Id;
  now: ISODate;
  repository: MigrationWorkspaceRepository;
}

export type BrowserMigrationSuccess = {
  status: "committed" | "already_migrated";
  migration: MigrationRecord;
  backupId: Id;
  backupChecksum: string;
  sourceChecksum: string;
};

export type BrowserMigrationConflict = {
  status: "revision_conflict";
  migration: MigrationRecord;
  recovery: MigrationRecoveryState;
  backupId: Id;
  backupChecksum: string;
  sourceChecksum: string;
};

export type BrowserMigrationRejected = {
  status: "rejected";
  violations: readonly V1MigrationViolation[];
  recovery: MigrationRecoveryState;
  backupId: Id;
  backupChecksum: string;
  sourceChecksum: string;
};

export type BrowserMigrationFailed = {
  status: "failed";
  recovery: MigrationRecoveryState;
  backup: RawV1Backup;
  recoveryPersisted: boolean;
  backupId: Id;
  backupChecksum: string;
  sourceChecksum: string | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Migration failed with an unknown error.";
}

async function recordMigrationFailure(input: {
  repository: MigrationWorkspaceRepository;
  backup: RawV1Backup;
  sourceChecksum: string | null;
  code: MigrationRecoveryCode;
  message: string;
  occurredAt: ISODate;
  violations?: readonly MigrationRecoveryViolation[];
}): Promise<BrowserMigrationFailed> {
  const original = migrationFailureResult({
    backup: input.backup,
    sourceChecksum: input.sourceChecksum,
    code: input.code,
    message: input.message,
    occurredAt: input.occurredAt,
    violations: input.violations,
    recoveryPersisted: false,
  });
  try {
    const verifiedBackup = await input.repository.loadVerifiedBackup(
      input.backup.id,
    );
    const backupMatches =
      verifiedBackup !== undefined &&
      verifiedBackup.rawPayload === input.backup.rawPayload &&
      verifiedBackup.checksum === input.backup.checksum;
    if (!backupMatches) {
      if (input.code === "BACKUP_VERIFICATION_FAILED") return original;
      return migrationFailureResult({
        backup: input.backup,
        sourceChecksum: input.sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: "The verified recovery backup became unavailable.",
        occurredAt: input.occurredAt,
        violations: input.violations,
        recoveryPersisted: false,
      });
    }
    await input.repository.saveMigrationRecovery(original.recovery);
    return {
      ...original,
      recoveryPersisted: true,
    };
  } catch (error) {
    if (input.code === "BACKUP_VERIFICATION_FAILED") return original;
    return migrationFailureResult({
      backup: input.backup,
      sourceChecksum: input.sourceChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: errorMessage(error),
      occurredAt: input.occurredAt,
      violations: input.violations,
      recoveryPersisted: false,
    });
  }
}

function migrationFailureResult(input: {
  backup: RawV1Backup;
  sourceChecksum: string | null;
  code: MigrationRecoveryCode;
  message: string;
  occurredAt: ISODate;
  violations?: readonly MigrationRecoveryViolation[];
  recoveryPersisted: boolean;
}): BrowserMigrationFailed {
  const recovery: MigrationRecoveryState = {
    sourceChecksum: input.sourceChecksum,
    backupId: input.backup.id,
    backupChecksum: input.backup.checksum,
    code: input.code,
    message: input.message,
    occurredAt: input.occurredAt,
    ...(input.violations === undefined
      ? {}
      : { violations: structuredClone(input.violations) }),
  };
  return {
    status: "failed",
    recovery,
    backup: structuredClone(input.backup),
    recoveryPersisted: input.recoveryPersisted,
    backupId: input.backup.id,
    backupChecksum: input.backup.checksum,
    sourceChecksum: input.sourceChecksum,
  };
}

export async function loadRecoveryBackupDownload(
  repository: Pick<MigrationWorkspaceRepository, "loadVerifiedBackup">,
  recovery: MigrationRecoveryState,
): Promise<VerifiedBackupDownload> {
  const backup = await loadRecoveryBackup(repository, recovery);
  return createVerifiedBackupDownload(backup);
}

async function loadRecoveryBackup(
  repository: Pick<MigrationWorkspaceRepository, "loadVerifiedBackup">,
  recovery: MigrationRecoveryState,
): Promise<VerifiedBackupRecord> {
  const backup = await repository.loadVerifiedBackup(recovery.backupId);
  if (
    backup === undefined ||
    backup.checksum !== recovery.backupChecksum
  ) {
    throw new Error(
      `Recovery backup ${recovery.backupId} is missing or does not match its checksum.`,
    );
  }
  await createVerifiedBackupDownload(backup);
  return backup;
}

export interface RecoveryRestoreStorage {
  setItem(key: string, value: string): void;
}

export async function restoreRecoveryBackup(
  repository: Pick<MigrationWorkspaceRepository, "loadVerifiedBackup">,
  recovery: MigrationRecoveryState,
  v1Storage: RecoveryRestoreStorage,
): Promise<{
  backupId: Id;
  backupChecksum: string;
  rawPayload: string;
}> {
  const backup = await loadRecoveryBackup(repository, recovery);
  const rawPayload = backup.rawPayload;
  v1Storage.setItem(V1_WORKSPACE_STORAGE_KEY, rawPayload);
  return {
    backupId: recovery.backupId,
    backupChecksum: recovery.backupChecksum,
    rawPayload,
  };
}

export type BrowserMigrationResult =
  | BrowserMigrationSuccess
  | BrowserMigrationConflict
  | BrowserMigrationRejected
  | BrowserMigrationFailed;

export async function migrateBrowserWorkspace(
  input: MigrateBrowserWorkspaceInput,
): Promise<BrowserMigrationResult> {
  return migrateBrowserWorkspaceWithMapperInternal(input, migrateV1Workspace);
}

/** @internal Test harness seam. Production callers use migrateBrowserWorkspace. */
export async function migrateBrowserWorkspaceWithMapperInternal(
  input: MigrateBrowserWorkspaceInput,
  mapper: V1WorkspaceMapper,
): Promise<BrowserMigrationResult> {
  // Snapshot every caller-controlled value before the first await. Migration
  // forms may be reused while IndexedDB is opening; later edits must not mix
  // one raw backup with a different source, identity, or timestamp.
  const rawV1Payload = input.rawV1Payload;
  const workspaceId = input.workspaceId;
  const actorId = input.actorId;
  const now = input.now;
  const repository = input.repository;
  const backup = await createRawV1Backup(rawV1Payload);
  try {
    if (!(await verifyRawV1Backup(backup))) {
      throw new Error("The raw V1 backup failed checksum verification.");
    }
    await repository.writeAndVerifyBackup(backup);
    const verifiedBackup = await repository.loadVerifiedBackup(backup.id);
    if (
      verifiedBackup === undefined ||
      verifiedBackup.rawPayload !== backup.rawPayload ||
      verifiedBackup.checksum !== backup.checksum
    ) {
      throw new Error(
        "The raw V1 backup failed repository read-back verification.",
      );
    }
  } catch (error) {
    return recordMigrationFailure({
      repository,
      backup,
      sourceChecksum: null,
      code: "BACKUP_VERIFICATION_FAILED",
      message: errorMessage(error),
      occurredAt: now,
    });
  }

  let source: WorkspaceSnapshot;
  let sourceChecksum: string;
  try {
    const parsed = parseV1Export(rawV1Payload);
    source = normalizeWorkspaceSnapshot(parsed.snapshot);
    sourceChecksum = await stableHash(source as unknown as JsonValue);
  } catch (error) {
    return recordMigrationFailure({
      repository,
      backup,
      sourceChecksum: null,
      code: "V1_PARSE_FAILED",
      message: errorMessage(error),
      occurredAt: now,
    });
  }
  let existing: MigrationRecord | undefined;
  try {
    existing = await repository.loadMigration(sourceChecksum);
  } catch (error) {
    return recordMigrationFailure({
      repository,
      backup,
      sourceChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: errorMessage(error),
      occurredAt: now,
    });
  }
  if (existing !== undefined) {
    let current: WorkspaceV2 | undefined;
    try {
      current = await repository.load();
    } catch (error) {
      return recordMigrationFailure({
        repository,
        backup,
        sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: errorMessage(error),
        occurredAt: now,
      });
    }
    const matchesWorkspace =
      current?.workspaceId === workspaceId &&
      current.migration !== undefined &&
      (await stableHash(current.migration as unknown as JsonValue)) ===
        (await stableHash(existing as unknown as JsonValue));
    if (!matchesWorkspace) {
      const recovery: MigrationRecoveryState = {
        sourceChecksum,
        backupId: backup.id,
        backupChecksum: backup.checksum,
        code: "MIGRATION_CONFLICT",
        message:
          "The migration checksum record does not belong to the expected V2 Workspace.",
        occurredAt: now,
      };
      try {
        await repository.saveMigrationRecovery(recovery);
      } catch (error) {
        return migrationFailureResult({
          backup,
          sourceChecksum,
          code: "MIGRATION_PERSISTENCE_FAILED",
          message: errorMessage(error),
          occurredAt: now,
          recoveryPersisted: false,
        });
      }
      return {
        status: "revision_conflict",
        migration: existing,
        recovery,
        backupId: backup.id,
        backupChecksum: backup.checksum,
        sourceChecksum,
      };
    }
    try {
      await repository.clearMigrationRecoveryIfMatching({
        sourceChecksum: existing.sourceChecksum,
        backupId: existing.backupId,
        backupChecksum: existing.backupChecksum,
      });
    } catch (error) {
      return migrationFailureResult({
        backup,
        sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: errorMessage(error),
        occurredAt: now,
        recoveryPersisted: false,
      });
    }
    return {
      status: "already_migrated",
      migration: existing,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      sourceChecksum,
    };
  }

  let candidate: V1MigrationCandidate;
  let violations: readonly V1MigrationViolation[];
  try {
    candidate = await mapper(structuredClone(source), {
      workspaceId,
      sourceChecksum,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      actorId,
      now,
    });
    violations = validateMigratedWorkspace(
      source,
      candidate.workspace,
      candidate.migration,
      {
        sourceChecksum,
        workspaceId,
        backupId: backup.id,
        backupChecksum: backup.checksum,
        migratedAt: now,
        now,
      },
    );
  } catch (error) {
    return recordMigrationFailure({
      repository,
      backup,
      sourceChecksum,
      code: "MIGRATION_VALIDATION_FAILED",
      message: errorMessage(error),
      occurredAt: now,
    });
  }
  if (violations.length > 0) {
    const recovery: MigrationRecoveryState = {
      sourceChecksum,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      code: "MIGRATION_VALIDATION_FAILED",
      message: "The migrated Workspace failed validation.",
      occurredAt: now,
      violations: structuredClone(violations),
    };
    try {
      await repository.saveMigrationRecovery(recovery);
    } catch (error) {
      return migrationFailureResult({
        backup,
        sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: errorMessage(error),
        occurredAt: now,
        violations,
        recoveryPersisted: false,
      });
    }
    return {
      status: "rejected",
      violations: structuredClone(violations),
      recovery,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      sourceChecksum,
    };
  }
  let status: "committed" | "already_migrated" | "revision_conflict";
  try {
    status = await repository.commitMigration({
      sourceChecksum,
      workspace: candidate.workspace,
      migrationRecord: candidate.migration,
    });
  } catch (error) {
    return recordMigrationFailure({
      repository,
      backup,
      sourceChecksum,
      code: "MIGRATION_PERSISTENCE_FAILED",
      message: errorMessage(error),
      occurredAt: now,
    });
  }
  if (status !== "committed") {
    let storedMigration: MigrationRecord | undefined;
    let current: WorkspaceV2 | undefined;
    try {
      [storedMigration, current] = await Promise.all([
        repository.loadMigration(sourceChecksum),
        repository.load(),
      ]);
    } catch (error) {
      return recordMigrationFailure({
        repository,
        backup,
        sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: errorMessage(error),
        occurredAt: now,
      });
    }
    const alreadyCommitted =
      storedMigration !== undefined &&
      current?.workspaceId === workspaceId &&
      current.migration !== undefined &&
      (await stableHash(current.migration as unknown as JsonValue)) ===
        (await stableHash(storedMigration as unknown as JsonValue));
    if (alreadyCommitted && storedMigration !== undefined) {
      try {
        await repository.clearMigrationRecoveryIfMatching({
          sourceChecksum: storedMigration.sourceChecksum,
          backupId: storedMigration.backupId,
          backupChecksum: storedMigration.backupChecksum,
        });
      } catch (error) {
        return migrationFailureResult({
          backup,
          sourceChecksum,
          code: "MIGRATION_PERSISTENCE_FAILED",
          message: errorMessage(error),
          occurredAt: now,
          recoveryPersisted: false,
        });
      }
      return {
        status: "already_migrated",
        migration: storedMigration,
        backupId: backup.id,
        backupChecksum: backup.checksum,
        sourceChecksum,
      };
    }
    const recovery: MigrationRecoveryState = {
      sourceChecksum,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      code: "MIGRATION_CONFLICT",
      message:
        "Another V2 Workspace initialization or migration won the atomic commit.",
      occurredAt: now,
    };
    try {
      await repository.saveMigrationRecovery(recovery);
    } catch (error) {
      return migrationFailureResult({
        backup,
        sourceChecksum,
        code: "MIGRATION_PERSISTENCE_FAILED",
        message: errorMessage(error),
        occurredAt: now,
        recoveryPersisted: false,
      });
    }
    return {
      status: "revision_conflict",
      migration: storedMigration ?? candidate.migration,
      recovery,
      backupId: backup.id,
      backupChecksum: backup.checksum,
      sourceChecksum,
    };
  }
  return {
    status,
    migration: candidate.migration,
    backupId: backup.id,
    backupChecksum: backup.checksum,
    sourceChecksum,
  };
}
