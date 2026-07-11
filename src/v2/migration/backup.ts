import { V1_WORKSPACE_STORAGE_KEY } from "@/domain/storage";
import type { WorkspaceSnapshot } from "@/domain/types";

import { sha256Text } from "../domain/stableHash";

export { V1_WORKSPACE_STORAGE_KEY };

export interface RawV1Backup {
  id: string;
  rawPayload: string;
  checksum: string;
}

export interface VerifiedBackupDownload {
  fileName: string;
  mediaType: "application/json";
  bytes: Uint8Array;
  checksum: string;
}

export interface ParsedV1Export {
  schemaVersion: 1;
  exportedAt?: string;
  snapshot: WorkspaceSnapshot;
}

export { sha256Text };

export async function createRawV1Backup(
  rawPayload: string,
): Promise<RawV1Backup> {
  const checksum = await sha256Text(rawPayload);
  return {
    id: `v1-backup-${checksum}`,
    rawPayload,
    checksum,
  };
}

export async function verifyRawV1Backup(
  backup: RawV1Backup,
): Promise<boolean> {
  return (
    backup.id === `v1-backup-${backup.checksum}` &&
    (await sha256Text(backup.rawPayload)) === backup.checksum
  );
}

export async function createVerifiedBackupDownload(
  backup: RawV1Backup,
): Promise<VerifiedBackupDownload> {
  if (!(await verifyRawV1Backup(backup))) {
    throw new Error(`Backup ${backup.id} failed checksum verification.`);
  }
  return {
    fileName: `${backup.id}.json`,
    mediaType: "application/json",
    bytes: new TextEncoder().encode(backup.rawPayload),
    checksum: backup.checksum,
  };
}

export function parseV1Export(rawPayload: string): ParsedV1Export {
  const parsed: unknown = JSON.parse(rawPayload);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== 1 ||
    !("snapshot" in parsed) ||
    typeof parsed.snapshot !== "object" ||
    parsed.snapshot === null
  ) {
    throw new Error("Expected a schema-1 V1 Workspace export.");
  }
  const exportedAt =
    "exportedAt" in parsed && typeof parsed.exportedAt === "string"
      ? parsed.exportedAt
      : undefined;
  return {
    schemaVersion: 1,
    ...(exportedAt === undefined ? {} : { exportedAt }),
    snapshot: parsed.snapshot as WorkspaceSnapshot,
  };
}
