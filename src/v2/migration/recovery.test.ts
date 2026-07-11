import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserWorkspaceRepository } from "../repositories/browserWorkspaceRepository";
import { deleteV2Database } from "../repositories/indexedDb";
import {
  createRawV1Backup,
  createVerifiedBackupDownload,
  sha256Text,
} from "./backup";
import { restoreRecoveryBackup } from "./recovery";

const NOW = "2026-07-12T00:00:00.000Z";

describe("V1 migration backup and recovery", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => item()));
  });

  it("hashes and downloads the exact raw V1 bytes without parsing or normalization", async () => {
    const rawPayload =
      '{\n  "schemaVersion": 1,\n  "exportedAt": "2026-07-12T00:00:00.000Z",\n  "snapshot": {}\n}\n';
    const compactPayload =
      '{"schemaVersion":1,"exportedAt":"2026-07-12T00:00:00.000Z","snapshot":{}}';

    const backup = await createRawV1Backup(rawPayload);
    const download = await createVerifiedBackupDownload(backup);

    expect(backup).toEqual({
      id: `v1-backup-${await sha256Text(rawPayload)}`,
      rawPayload,
      checksum: await sha256Text(rawPayload),
    });
    expect(backup.checksum).not.toBe(await sha256Text(compactPayload));
    expect(download.fileName).toBe(`${backup.id}.json`);
    expect(download.mediaType).toBe("application/json");
    expect(new TextDecoder().decode(download.bytes)).toBe(rawPayload);
    expect(download.checksum).toBe(backup.checksum);
  });

  it("restores verified recovery bytes to the V1 key only on an explicit call", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-recovery-restore";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const rawPayload = '{\n  "schemaVersion": 1,\n  "snapshot": {}\n}\n';
    const backup = await createRawV1Backup(rawPayload);
    await repository.writeAndVerifyBackup(backup);
    const recovery = {
      sourceChecksum: "normalized-source-checksum",
      backupId: backup.id,
      backupChecksum: backup.checksum,
      code: "MIGRATION_VALIDATION_FAILED" as const,
      message: "Migration validation failed.",
      occurredAt: NOW,
    };
    const setItem = vi.fn();

    const restored = await restoreRecoveryBackup(repository, recovery, {
      setItem,
    });

    expect(restored).toEqual({
      backupId: backup.id,
      backupChecksum: backup.checksum,
      rawPayload,
    });
    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith(
      "omni-plan-personal.workspace.v1",
      rawPayload,
    );
  });

  it("never writes V1 storage when the requested recovery backup is missing or mismatched", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-v2-recovery-invalid-restore";
    cleanup.push(() => deleteV2Database({ databaseName, indexedDB }));
    const repository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const backup = await createRawV1Backup(
      '{"schemaVersion":1,"snapshot":{}}',
    );
    await repository.writeAndVerifyBackup(backup);
    const setItem = vi.fn();
    const base = {
      sourceChecksum: "source-checksum",
      code: "MIGRATION_VALIDATION_FAILED" as const,
      message: "Migration validation failed.",
      occurredAt: NOW,
    };

    await expect(
      restoreRecoveryBackup(
        repository,
        {
          ...base,
          backupId: backup.id,
          backupChecksum: "mismatched-checksum",
        },
        { setItem },
      ),
    ).rejects.toThrow(/checksum|match/i);
    await expect(
      restoreRecoveryBackup(
        repository,
        {
          ...base,
          backupId: "missing-backup",
          backupChecksum: backup.checksum,
        },
        { setItem },
      ),
    ).rejects.toThrow(/missing|match/i);
    expect(setItem).not.toHaveBeenCalled();
  });
});
