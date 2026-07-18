import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import { encryptSyncPayload } from "../../domain/sync";
import { executeCommand, type V2Command } from "../domain/commands";
import { generateTodayProposal } from "../domain/today";
import type { CommandReceipt, WorkspaceV2 } from "../domain/types";
import {
  buildCommandContext,
  buildCapacityProfile,
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "./builders";
import {
  authorizeConflictOpenFromBranchesV2,
} from "../repositories/syncConflictOpenAuthorization";
import {
  assertAcyclicSyncProvenanceEdgeV2,
  authorizeSyncBranchV2,
  createSyncOperationV2,
  createSyncManifestV2,
  decryptAndVerifySyncOperationV2,
  findLatestCommonAncestorV2,
  isAuthorizedSyncBranchV2,
  isAuthorizedSyncReplay,
  advanceSyncManifestV2,
  classifyProtectedRecordChanges,
  parseSyncEnvelopeV2,
  parseSyncManifestV2,
  SyncProtocolError,
  type CreatedSyncOperationV2,
  type SyncEnvelopeV2,
  syncManifestPathV2,
  syncOperationPathV2,
  verifySyncHistoryV2,
  withAcyclicSyncProvenanceEdgeV2,
} from "../repositories/syncProtocol";

const PASSPHRASE = "correct horse battery staple";
const NOW = "2026-07-12T03:00:00.000Z";

async function appliedCapture(commandId = "capture-1"): Promise<{
  command: V2Command;
  receipt: CommandReceipt;
}> {
  const command = {
    type: "capture_inbox",
    id: `inbox-${commandId}`,
    text: `Captured by ${commandId}`,
  } as const satisfies V2Command;
  const result = await executeCommand(
    buildWorkspaceV2("workspace-sync"),
    command,
    buildCommandContext({
      commandId,
      expectedRevision: 0,
      actorId: "human-sync",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "verified-ui-session",
        verified: true,
        capabilities: ["human_decision"],
      },
      now: NOW,
    }),
  );
  if (!result.ok) throw new Error("Expected capture command to apply");
  return { command, receipt: result.receipt };
}

async function applyCapture(
  workspace: WorkspaceV2,
  commandId: string,
  now: string,
): Promise<{
  workspace: WorkspaceV2;
  command: V2Command;
  receipt: CommandReceipt;
}> {
  const command = {
    type: "capture_inbox",
    id: `inbox-${commandId}`,
    text: `Captured by ${commandId}`,
  } as const satisfies V2Command;
  const result = await executeCommand(
    workspace,
    command,
    buildCommandContext({
      commandId,
      expectedRevision: workspace.revision,
      actorId: "human-sync",
      actorKind: "human",
      origin: "ui",
      source: {
        sourceId: "verified-ui-session",
        verified: true,
        capabilities: ["human_decision"],
      },
      now,
    }),
  );
  if (!result.ok) throw new Error(`Expected ${commandId} to apply`);
  return { workspace: result.workspace, command, receipt: result.receipt };
}

async function verified(created: CreatedSyncOperationV2) {
  return decryptAndVerifySyncOperationV2({
    envelope: created.envelope,
    path: created.path,
    passphrase: PASSPHRASE,
    expectedWorkspaceId: created.envelope.workspaceId,
    expectedDeviceId: created.envelope.deviceId,
    expectedSequence: created.envelope.sequence,
    expectedOperationHash: created.operationHash,
    expectedPreviousOperationHash:
      created.envelope.previousOperationHash ?? null,
  });
}

async function authorizedCaptureBranch(
  workspaceId: string,
  commandId: string,
) {
  const ancestor = buildWorkspaceV2(workspaceId);
  const applied = await applyCapture(
    ancestor,
    commandId,
    "2026-07-12T03:14:00.000Z",
  );
  const created = await createSyncOperationV2({
    workspaceId,
    deviceId: `device-${commandId}`,
    sequence: 1,
    operationId: `operation-${commandId}`,
    command: applied.command,
    receipt: applied.receipt,
    passphrase: PASSPHRASE,
  });
  const operation = await verified(created);
  const history = verifySyncHistoryV2(
    createSyncManifestV2({
      workspaceId,
      heads: {
        [created.envelope.deviceId]: {
          sequence: 1,
          operationHash: operation.operationHash,
          revision: operation.receipt.revision,
          updatedAt: operation.receipt.createdAt,
        },
      },
      updatedAt: operation.receipt.createdAt,
    }),
    [operation],
  );
  const branch = await authorizeSyncBranchV2({
    history,
    trustedAncestorWorkspace: ancestor,
    headOperationHash: operation.operationHash,
  });
  return { ancestor, branch };
}

function encryptedHeaderBinding(envelope: Readonly<SyncEnvelopeV2>) {
  return {
    schemaVersion: envelope.schemaVersion,
    protocol: envelope.protocol,
    workspaceId: envelope.workspaceId,
    deviceId: envelope.deviceId,
    sequence: envelope.sequence,
    operationId: envelope.operationId,
    commandId: envelope.commandId,
    baseRevision: envelope.baseRevision,
    revision: envelope.revision,
    previousOperationHash: envelope.previousOperationHash ?? null,
    payloadHash: envelope.payloadHash,
    createdAt: envelope.createdAt,
  };
}

async function forgedOperation(
  created: CreatedSyncOperationV2,
  plaintext: unknown,
  envelopePatch: Partial<SyncEnvelopeV2> = {},
  authenticateHeaders = true,
): Promise<{ envelope: SyncEnvelopeV2; operationHash: string; path: string }> {
  const header = {
    ...structuredClone(created.envelope),
    ...envelopePatch,
  } as SyncEnvelopeV2;
  const binding = encryptedHeaderBinding(header);
  const boundPlaintext =
    authenticateHeaders &&
    plaintext !== null &&
    typeof plaintext === "object" &&
    !Array.isArray(plaintext) &&
    "command" in plaintext &&
    "receipt" in plaintext &&
    !("binding" in plaintext)
      ? { binding, ...structuredClone(plaintext) }
      : plaintext;
  const envelope = {
    ...header,
    payload: await encryptSyncPayload(boundPlaintext, PASSPHRASE),
  } as SyncEnvelopeV2;
  const operationHash = await sha256Hex(canonicalJson(envelope));
  return {
    envelope,
    operationHash,
    path: syncOperationPathV2(
      envelope.workspaceId,
      envelope.deviceId,
      envelope.sequence,
      operationHash,
    ),
  };
}

async function transplantedOperation(
  created: CreatedSyncOperationV2,
  envelopePatch: Partial<SyncEnvelopeV2>,
): Promise<{ envelope: SyncEnvelopeV2; operationHash: string; path: string }> {
  const envelope = {
    ...structuredClone(created.envelope),
    ...envelopePatch,
    payload: structuredClone(created.envelope.payload),
  } as SyncEnvelopeV2;
  const operationHash = await sha256Hex(canonicalJson(envelope));
  return {
    envelope,
    operationHash,
    path: syncOperationPathV2(
      envelope.workspaceId,
      envelope.deviceId,
      envelope.sequence,
      operationHash,
    ),
  };
}

describe("V2 encrypted command-log sync protocol", () => {
  it("uses the isolated V2 paths and returns only a verified replay after decrypting an immutable operation", async () => {
    const { command, receipt } = await appliedCapture();

    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-macbook-1",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });

    expect(syncManifestPathV2("workspace-sync")).toBe(
      "v2/workspaces/workspace-sync/manifest.json",
    );
    expect(created.operationHash).toBe(
      await sha256Hex(canonicalJson(created.envelope)),
    );
    expect(created.path).toBe(
      `v2/workspaces/workspace-sync/operations/macbook/1-${created.operationHash}.json.enc`,
    );
    expect(
      syncOperationPathV2(
        "workspace-sync",
        "macbook",
        1,
        created.operationHash,
      ),
    ).toBe(created.path);
    expect(Object.isFrozen(created.envelope)).toBe(true);
    expect(Object.isFrozen(created.envelope.payload)).toBe(true);

    const replay = await decryptAndVerifySyncOperationV2({
      envelope: created.envelope,
      path: created.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: "workspace-sync",
    });

    expect(replay.operationHash).toBe(created.operationHash);
    expect(replay.path).toBe(created.path);
    expect(replay.workspaceId).toBe("workspace-sync");
    expect(replay.deviceId).toBe("macbook");
    expect(replay.sequence).toBe(1);
    expect(replay.command).toEqual(command);
    expect(replay.receipt).toEqual(receipt);
  });

  it("rejects V1 paths, schema-1 envelopes, snapshots, and manifests at the protocol boundary", async () => {
    const { command, receipt } = await appliedCapture("v1-isolation");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-v1-isolation",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });

    await expect(
      decryptAndVerifySyncOperationV2({
        envelope: created.envelope,
        path: ".omni-plan/workspaces/workspace-sync/changes/macbook/00000001-v1.json.enc",
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({
      name: "SyncProtocolError",
      code: "V2_PATH_REQUIRED",
    });

    for (const schemaOneInput of [
      { ...created.envelope, schemaVersion: 1 },
      {
        schemaVersion: 1,
        workspaceId: "workspace-sync",
        deviceId: "macbook",
        revision: "v1-snapshot",
        createdAt: NOW,
        plaintextChecksum: "checksum",
        payload: created.envelope.payload,
      },
    ]) {
      expect(() => parseSyncEnvelopeV2(schemaOneInput)).toThrowError(
        expect.objectContaining({
          name: "SyncProtocolError",
          code: "V2_SCHEMA_REQUIRED",
        }),
      );
    }

    expect(() =>
      parseSyncManifestV2({
        schemaVersion: 1,
        workspaceId: "workspace-sync",
        provider: "github-private-repo",
        heads: {},
        updatedAt: NOW,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "SyncProtocolError",
        code: "V2_SCHEMA_REQUIRED",
      }),
    );

    expect(SyncProtocolError).toBeDefined();
  });

  it("binds verification to the expected workspace, device, sequence, operation hash, and parent hash", async () => {
    const { command, receipt } = await applyCapture(
      buildWorkspaceV2("workspace-sync", { revision: 1 }),
      "locator",
      NOW,
    );
    const parentHash = "a".repeat(64);
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 2,
      operationId: "operation-locator",
      command,
      receipt,
      previousOperationHash: parentHash,
      passphrase: PASSPHRASE,
    });
    const base = {
      envelope: created.envelope,
      path: created.path,
      passphrase: PASSPHRASE,
      expectedWorkspaceId: "workspace-sync",
      expectedDeviceId: "macbook",
      expectedSequence: 2,
      expectedOperationHash: created.operationHash,
      expectedPreviousOperationHash: parentHash,
    } as const;

    await expect(decryptAndVerifySyncOperationV2(base)).resolves.toMatchObject({
      operationHash: created.operationHash,
    });

    for (const expected of [
      { expectedWorkspaceId: "other-workspace" },
      { expectedDeviceId: "iphone" },
      { expectedSequence: 3 },
      { expectedOperationHash: "b".repeat(64) },
      { expectedPreviousOperationHash: "c".repeat(64) },
    ]) {
      await expect(
        decryptAndVerifySyncOperationV2({ ...base, ...expected }),
      ).rejects.toBeInstanceOf(SyncProtocolError);
    }

    await expect(
      decryptAndVerifySyncOperationV2({
        ...base,
        expectedPreviousOperationHash: null,
      }),
    ).rejects.toMatchObject({ code: "BROKEN_HASH_CHAIN" });
  });

  it("authenticates every immutable envelope locator inside the encrypted payload", async () => {
    const parentHash = "a".repeat(64);
    const applied = await applyCapture(
      buildWorkspaceV2("workspace-sync", { revision: 1 }),
      "authenticated-header",
      NOW,
    );
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 2,
      operationId: "operation-authenticated-header",
      command: applied.command,
      receipt: applied.receipt,
      previousOperationHash: parentHash,
      passphrase: PASSPHRASE,
    });

    const patches: Partial<SyncEnvelopeV2>[] = [
      { workspaceId: "workspace-transplanted" },
      { deviceId: "iphone" },
      { sequence: 3 },
      { operationId: "operation-transplanted" },
      { previousOperationHash: "b".repeat(64) },
    ];
    for (const patch of patches) {
      const transplanted = await transplantedOperation(created, patch);
      await expect(
        decryptAndVerifySyncOperationV2({
          ...transplanted,
          passphrase: PASSPHRASE,
          expectedWorkspaceId: transplanted.envelope.workspaceId,
          expectedDeviceId: transplanted.envelope.deviceId,
          expectedSequence: transplanted.envelope.sequence,
          expectedOperationHash: transplanted.operationHash,
          expectedPreviousOperationHash:
            transplanted.envelope.previousOperationHash ?? null,
        }),
      ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    }
  });

  it("rejects missing, extra, and unsafe encrypted binding fields", async () => {
    const { command, receipt } = await appliedCapture("strict-binding");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-strict-binding",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });
    const binding = encryptedHeaderBinding(created.envelope);
    const { deviceId: _missingDeviceId, ...missingDeviceId } = binding;
    const malformedPayloads = [
      { command, receipt },
      { binding: missingDeviceId, command, receipt },
      { binding: { ...binding, unexpected: true }, command, receipt },
      {
        binding: { ...binding, sequence: Number.MAX_SAFE_INTEGER + 1 },
        command,
        receipt,
      },
    ];

    for (const plaintext of malformedPayloads) {
      const malformed = await forgedOperation(
        created,
        plaintext,
        {},
        false,
      );
      await expect(
        decryptAndVerifySyncOperationV2({
          ...malformed,
          passphrase: PASSPHRASE,
          expectedOperationHash: malformed.operationHash,
        }),
      ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    }
  });

  it("rejects valid-looking reparenting and cross-device resequencing", async () => {
    const ancestor = buildWorkspaceV2("workspace-sync");
    const parentA = await applyCapture(
      ancestor,
      "binding-parent-a",
      "2026-07-12T03:00:00.000Z",
    );
    const parentB = await applyCapture(
      ancestor,
      "binding-parent-b",
      "2026-07-12T03:00:30.000Z",
    );
    const [parentACreated, parentBCreated] = await Promise.all([
      createSyncOperationV2({
        workspaceId: "workspace-sync",
        deviceId: "macbook",
        sequence: 1,
        operationId: "operation-binding-parent-a",
        command: parentA.command,
        receipt: parentA.receipt,
        passphrase: PASSPHRASE,
      }),
      createSyncOperationV2({
        workspaceId: "workspace-sync",
        deviceId: "tablet",
        sequence: 1,
        operationId: "operation-binding-parent-b",
        command: parentB.command,
        receipt: parentB.receipt,
        passphrase: PASSPHRASE,
      }),
    ]);
    const child = await applyCapture(
      parentA.workspace,
      "binding-child",
      "2026-07-12T03:01:00.000Z",
    );
    const childCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 2,
      operationId: "operation-binding-child",
      command: child.command,
      receipt: child.receipt,
      previousOperationHash: parentACreated.operationHash,
      passphrase: PASSPHRASE,
    });

    const validLookingTransplants = [
      await transplantedOperation(childCreated, {
        previousOperationHash: parentBCreated.operationHash,
      }),
      await transplantedOperation(childCreated, {
        deviceId: "iphone",
        sequence: 1,
      }),
    ];
    for (const transplanted of validLookingTransplants) {
      await expect(
        decryptAndVerifySyncOperationV2({
          ...transplanted,
          passphrase: PASSPHRASE,
          expectedWorkspaceId: transplanted.envelope.workspaceId,
          expectedDeviceId: transplanted.envelope.deviceId,
          expectedSequence: transplanted.envelope.sequence,
          expectedOperationHash: transplanted.operationHash,
          expectedPreviousOperationHash:
            transplanted.envelope.previousOperationHash ?? null,
        }),
      ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    }
  });

  it("rejects every mismatch in the encrypted command, envelope, and applied receipt tuple", async () => {
    const { command, receipt } = await appliedCapture("tamper-tuple");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-tamper-tuple",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });

    const headerTampering: Partial<SyncEnvelopeV2>[] = [
      { commandId: "different-command" },
      {
        baseRevision: 7,
        revision: 8,
        previousOperationHash: "a".repeat(64),
      },
      { payloadHash: "f".repeat(64) },
      { createdAt: "2026-07-12T03:01:00.000Z" },
    ];
    for (const patch of headerTampering) {
      const forged = await forgedOperation(created, { command, receipt }, patch);
      await expect(
        decryptAndVerifySyncOperationV2({
          ...forged,
          passphrase: PASSPHRASE,
          expectedWorkspaceId: "workspace-sync",
        }),
      ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
    }

    const commandTamper = await forgedOperation(created, {
      command: { ...command, text: "tampered plaintext command" },
      receipt,
    });
    await expect(
      decryptAndVerifySyncOperationV2({
        ...commandTamper,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  it("rejects receipt hash, actor, source, time, status, and raw sync capability tampering", async () => {
    const { command, receipt } = await appliedCapture("tamper-receipt");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-tamper-receipt",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });

    const receiptTampering: Array<{
      receipt: unknown;
      code: string;
    }> = [
      {
        receipt: { ...receipt, receiptHash: "0".repeat(64) },
        code: "RECEIPT_HASH_MISMATCH",
      },
      {
        receipt: { ...receipt, actorId: "forged-human" },
        code: "RECEIPT_HASH_MISMATCH",
      },
      {
        receipt: {
          ...receipt,
          source: {
            sourceId: "raw-sync-context",
            verified: true,
            capabilities: ["replay_receipt"],
          },
        },
        code: "RECEIPT_HASH_MISMATCH",
      },
      {
        receipt: { ...receipt, createdAt: "2026-07-12T03:02:00.000Z" },
        code: "RECEIPT_MISMATCH",
      },
      {
        receipt: { ...receipt, status: "rejected", rejectionCode: "FORGED" },
        code: "RECEIPT_REQUIRED",
      },
    ];

    for (const tamper of receiptTampering) {
      const forged = await forgedOperation(created, {
        command,
        receipt: tamper.receipt,
      });
      await expect(
        decryptAndVerifySyncOperationV2({
          ...forged,
          passphrase: PASSPHRASE,
        }),
      ).rejects.toMatchObject({ code: tamper.code });
    }

    for (const rawPayload of [
      { command },
      {
        command,
        context: {
          actorId: "human-sync",
          actorKind: "human",
          origin: "sync",
          source: {
            sourceId: "raw-sync-context",
            verified: true,
            capabilities: ["replay_receipt"],
          },
          now: NOW,
        },
      },
    ]) {
      const forged = await forgedOperation(created, rawPayload);
      await expect(
        decryptAndVerifySyncOperationV2({
          ...forged,
          passphrase: PASSPHRASE,
        }),
      ).rejects.toMatchObject({ code: "RECEIPT_REQUIRED" });
    }
  }, 15_000);

  it("creates and advances an immutable manifest while preserving exact per-device heads", async () => {
    const otherHash = "d".repeat(64);
    const initial = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        iphone: {
          sequence: 3,
          operationHash: otherHash,
          revision: 3,
          updatedAt: "2026-07-12T02:00:00.000Z",
        },
      },
      updatedAt: "2026-07-12T03:05:00.000Z",
    });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.heads)).toBe(true);
    expect(Object.isFrozen(initial.heads.iphone)).toBe(true);

    const { command, receipt } = await applyCapture(
      buildWorkspaceV2("workspace-sync", { revision: 3 }),
      "manifest-head",
      NOW,
    );
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-manifest-head",
      command,
      receipt,
      previousOperationHash: otherHash,
      passphrase: PASSPHRASE,
    });
    const advanced = await advanceSyncManifestV2(initial, created);

    expect(advanced).toEqual({
      schemaVersion: 2,
      protocol: "omniplan-v2-command-log",
      workspaceId: "workspace-sync",
      heads: {
        iphone: initial.heads.iphone,
        macbook: {
          sequence: 1,
          operationHash: created.operationHash,
          revision: 4,
          updatedAt: NOW,
        },
      },
      updatedAt: "2026-07-12T03:05:00.000Z",
    });
    expect(initial.heads).not.toHaveProperty("macbook");

    await expect(advanceSyncManifestV2(advanced, created)).rejects.toMatchObject({
      code: "BROKEN_HASH_CHAIN",
    });
    const staleParent = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "ipad",
      sequence: 1,
      operationId: "operation-stale-parent",
      command,
      receipt,
      previousOperationHash: "e".repeat(64),
      passphrase: PASSPHRASE,
    });
    await expect(
      advanceSyncManifestV2(initial, staleParent),
    ).rejects.toMatchObject({ code: "MISSING_ANCESTOR" });
    expect(() =>
      parseSyncManifestV2({ ...advanced, unexpectedMutableField: true }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_MANIFEST" }));
  });

  it("accepts only a reachable historical parent proven by the exact current manifest", async () => {
    const rootApplied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "historical-proof-root",
      "2026-07-12T03:20:00.000Z",
    );
    const childApplied = await applyCapture(
      rootApplied.workspace,
      "historical-proof-child",
      "2026-07-12T03:21:00.000Z",
    );
    const forkApplied = await applyCapture(
      rootApplied.workspace,
      "historical-proof-fork",
      "2026-07-12T03:22:00.000Z",
    );
    const rootCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "remote-chain",
      sequence: 1,
      operationId: "operation-historical-proof-root",
      command: rootApplied.command,
      receipt: rootApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const childCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "remote-chain",
      sequence: 2,
      operationId: "operation-historical-proof-child",
      command: childApplied.command,
      receipt: childApplied.receipt,
      previousOperationHash: rootCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const [root, child] = await Promise.all([
      verified(rootCreated),
      verified(childCreated),
    ]);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        "remote-chain": {
          sequence: 2,
          operationHash: child.operationHash,
          revision: child.receipt.revision,
          updatedAt: child.receipt.createdAt,
        },
      },
      updatedAt: child.receipt.createdAt,
    });
    const history = verifySyncHistoryV2(manifest, [root, child]);
    const validFork = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "local~fork-valid",
      sequence: 1,
      operationId: "operation-historical-proof-valid-fork",
      command: forkApplied.command,
      receipt: forkApplied.receipt,
      previousOperationHash: root.operationHash,
      passphrase: PASSPHRASE,
    });
    await expect(
      advanceSyncManifestV2(manifest, validFork, {
        verifiedHistory: history,
      }),
    ).resolves.toMatchObject({
      heads: {
        "remote-chain": manifest.heads["remote-chain"],
        "local~fork-valid": {
          sequence: 1,
          operationHash: validFork.operationHash,
          revision: 2,
        },
      },
    });

    const arbitraryFork = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "local~fork-arbitrary",
      sequence: 1,
      operationId: "operation-historical-proof-arbitrary-fork",
      command: forkApplied.command,
      receipt: forkApplied.receipt,
      previousOperationHash: "f".repeat(64),
      passphrase: PASSPHRASE,
    });
    await expect(
      advanceSyncManifestV2(manifest, arbitraryFork, {
        verifiedHistory: history,
      }),
    ).rejects.toMatchObject({ code: "MISSING_ANCESTOR" });
  });

  it("rejects a persisted semantic child that hides a changed Today read-set behind unchanged empty slots", async () => {
    const workspace = buildWorkspaceV2("workspace-sync");
    const originalProfile = buildCapacityProfile({
      timeZone: "UTC",
      weeklyWindows: [{ weekday: 0, startMinute: 360, finishMinute: 480 }],
      dailyBudgets: [
        {
          weekday: 0,
          deepSeconds: 3_600,
          mediumSeconds: 3_600,
          shallowSeconds: 3_600,
        },
      ],
      unavailableBlocks: [],
      updatedAt: "2026-07-12T02:00:00.000Z",
      updatedBy: "human-seed",
    });
    const capacityCommand = {
      type: "configure_capacity",
      profile: originalProfile,
    } as const satisfies V2Command;
    const capacityApplied = await executeCommand(
      workspace,
      capacityCommand,
      buildCommandContext({
        commandId: "semantic-forgery-capacity",
        expectedRevision: 0,
        actorId: "human-seed",
        now: originalProfile.updatedAt,
      }),
    );
    if (!capacityApplied.ok) throw new Error("Expected capacity root");
    const capacityCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "seed",
      sequence: 1,
      operationId: "operation-semantic-forgery-capacity",
      command: capacityCommand,
      receipt: capacityApplied.receipt,
      passphrase: PASSPHRASE,
    });

    const generatedAt = "2026-07-12T02:02:00.000Z";
    const today = await generateTodayProposal(
      capacityApplied.workspace,
      "2026-07-12",
      generatedAt,
    );
    expect(today.slots).toEqual([]);
    const rootCommand = {
      type: "commit_today",
      commitment: {
        id: "semantic-forgery-commitment",
        localDate: today.localDate,
        workspaceRevision: today.workspaceRevision,
        generatedAt: today.generatedAt,
        proposalHash: today.proposalHash,
        slots: structuredClone(today.slots),
      },
    } as const satisfies V2Command;
    const rootApplied = await executeCommand(
      capacityApplied.workspace,
      rootCommand,
      buildCommandContext({
        commandId: "semantic-forgery-root",
        expectedRevision: capacityApplied.workspace.revision,
        actorId: "human-authority",
        now: generatedAt,
      }),
    );
    if (!rootApplied.ok) throw new Error("Expected Today authority root");
    const rootCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "phone",
      sequence: 1,
      operationId: "operation-semantic-forgery-root",
      command: rootCommand,
      receipt: rootApplied.receipt,
      previousOperationHash: capacityCreated.operationHash,
      passphrase: PASSPHRASE,
    });

    const changedProfile = structuredClone(originalProfile);
    changedProfile.dailyBudgets[0].deepSeconds = 7_200;
    changedProfile.updatedAt = "2026-07-12T02:01:00.000Z";
    changedProfile.updatedBy = "human-local";
    const changedCommand = {
      type: "configure_capacity",
      profile: changedProfile,
    } as const satisfies V2Command;
    const changedApplied = await executeCommand(
      capacityApplied.workspace,
      changedCommand,
      buildCommandContext({
        commandId: "semantic-forgery-capacity-change",
        expectedRevision: capacityApplied.workspace.revision,
        actorId: "human-local",
        now: changedProfile.updatedAt,
      }),
    );
    if (!changedApplied.ok) throw new Error("Expected capacity change");
    const changedCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "desktop",
      sequence: 1,
      operationId: "operation-semantic-forgery-capacity-change",
      command: changedCommand,
      receipt: changedApplied.receipt,
      previousOperationHash: capacityCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const changedToday = await generateTodayProposal(
      changedApplied.workspace,
      today.localDate,
      today.generatedAt,
    );
    expect(changedToday.slots).toEqual(today.slots);
    expect(changedToday.proposalHash).not.toBe(today.proposalHash);

    const forgedCommand = {
      type: "commit_today",
      commitment: {
        ...structuredClone(rootCommand.commitment),
        workspaceRevision: changedApplied.workspace.revision,
      },
    } as const satisfies V2Command;
    const forgedApplied = await executeCommand(
      changedApplied.workspace,
      forgedCommand,
      {
        commandId: rootApplied.receipt.commandId,
        expectedRevision: changedApplied.workspace.revision,
        actorId: rootApplied.receipt.actorId,
        actorKind: rootApplied.receipt.actorKind,
        origin: "sync",
        source: {
          sourceId: `sync-semantic:${rootCreated.operationHash}:commit_today:${rootApplied.receipt.source.sourceId}`,
          verified: true,
          capabilities: [
            ...rootApplied.receipt.source.capabilities,
            "replay_receipt",
          ],
        },
        now: rootApplied.receipt.createdAt,
      },
    );
    if (!forgedApplied.ok) {
      throw new Error("Expected the pre-authorization handler bypass fixture");
    }
    expect(
      forgedApplied.workspace.dailyCommitments[0].capacitySnapshot,
    ).toEqual(changedProfile);
    const forgedCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "desktop",
      sequence: 2,
      operationId: "operation-semantic-forgery-child",
      command: forgedCommand,
      receipt: forgedApplied.receipt,
      previousOperationHash: changedCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const [capacity, root, changed, forged] = await Promise.all([
      verified(capacityCreated),
      verified(rootCreated),
      verified(changedCreated),
      verified(forgedCreated),
    ]);
    const history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId: "workspace-sync",
        heads: {
          seed: {
            sequence: 1,
            operationHash: capacity.operationHash,
            revision: capacity.receipt.revision,
            updatedAt: capacity.receipt.createdAt,
          },
          phone: {
            sequence: 1,
            operationHash: root.operationHash,
            revision: root.receipt.revision,
            updatedAt: root.receipt.createdAt,
          },
          desktop: {
            sequence: 2,
            operationHash: forged.operationHash,
            revision: forged.receipt.revision,
            updatedAt: forged.receipt.createdAt,
          },
        },
        updatedAt: forged.receipt.createdAt,
      }),
      [capacity, root, changed, forged],
    );

    await expect(
      authorizeSyncBranchV2({
        history,
        trustedAncestorWorkspace: workspace,
        headOperationHash: forged.operationHash,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  it("verifies two divergent device branches and finds their latest common ancestor", async () => {
    const rootApplied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "history-root",
      "2026-07-12T03:00:00.000Z",
    );
    const rootCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "desktop",
      sequence: 1,
      operationId: "operation-history-root",
      command: rootApplied.command,
      receipt: rootApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const leftApplied = await applyCapture(
      rootApplied.workspace,
      "history-left",
      "2026-07-12T03:01:00.000Z",
    );
    const rightApplied = await applyCapture(
      rootApplied.workspace,
      "history-right",
      "2026-07-12T03:02:00.000Z",
    );
    const leftCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-history-left",
      command: leftApplied.command,
      receipt: leftApplied.receipt,
      previousOperationHash: rootCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const rightCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "iphone",
      sequence: 1,
      operationId: "operation-history-right",
      command: rightApplied.command,
      receipt: rightApplied.receipt,
      previousOperationHash: rootCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const [root, left, right] = await Promise.all([
      verified(rootCreated),
      verified(leftCreated),
      verified(rightCreated),
    ]);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        desktop: {
          sequence: 1,
          operationHash: root.operationHash,
          revision: root.receipt.revision,
          updatedAt: root.receipt.createdAt,
        },
        macbook: {
          sequence: 1,
          operationHash: left.operationHash,
          revision: left.receipt.revision,
          updatedAt: left.receipt.createdAt,
        },
        iphone: {
          sequence: 1,
          operationHash: right.operationHash,
          revision: right.receipt.revision,
          updatedAt: right.receipt.createdAt,
        },
      },
      updatedAt: right.receipt.createdAt,
    });

    const history = verifySyncHistoryV2(manifest, [right, root, left]);
    expect(history.operations.map(({ operationHash }) => operationHash)).toEqual([
      root.operationHash,
      left.operationHash,
      right.operationHash,
    ]);
    expect(Object.isFrozen(history.operations)).toBe(true);
    expect(
      findLatestCommonAncestorV2(
        history,
        left.operationHash,
        right.operationHash,
      ).operationHash,
    ).toBe(root.operationHash);
  });

  it("treats concurrent revision-zero device roots as sharing the verified Workspace genesis", async () => {
    const leftApplied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "genesis-left",
      "2026-07-12T03:10:00.000Z",
    );
    const rightApplied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "genesis-right",
      "2026-07-12T03:11:00.000Z",
    );
    const leftCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-genesis-left",
      command: leftApplied.command,
      receipt: leftApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const rightCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "iphone",
      sequence: 1,
      operationId: "operation-genesis-right",
      command: rightApplied.command,
      receipt: rightApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const [left, right] = await Promise.all([
      verified(leftCreated),
      verified(rightCreated),
    ]);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        macbook: {
          sequence: 1,
          operationHash: left.operationHash,
          revision: 1,
          updatedAt: left.receipt.createdAt,
        },
        iphone: {
          sequence: 1,
          operationHash: right.operationHash,
          revision: 1,
          updatedAt: right.receipt.createdAt,
        },
      },
      updatedAt: right.receipt.createdAt,
    });

    const history = verifySyncHistoryV2(manifest, [left, right]);
    expect(
      findLatestCommonAncestorV2(
        history,
        left.operationHash,
        right.operationHash,
      ),
    ).toEqual({
      kind: "genesis",
      workspaceId: "workspace-sync",
      revision: 0,
    });
  });

  it("upgrades authority only after exact domain replay from a trusted ancestor", async () => {
    const ancestor = buildWorkspaceV2("workspace-sync");
    const applied = await applyCapture(
      ancestor,
      "authority-genuine",
      "2026-07-12T03:15:00.000Z",
    );
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "authority-device",
      sequence: 1,
      operationId: "operation-authority-genuine",
      command: applied.command,
      receipt: applied.receipt,
      passphrase: PASSPHRASE,
    });
    const operation = await verified(created);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        "authority-device": {
          sequence: 1,
          operationHash: operation.operationHash,
          revision: operation.receipt.revision,
          updatedAt: operation.receipt.createdAt,
        },
      },
      updatedAt: operation.receipt.createdAt,
    });
    const history = verifySyncHistoryV2(manifest, [operation]);

    const authorized = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: ancestor,
      headOperationHash: operation.operationHash,
    });

    expect(authorized.replays).toHaveLength(1);
    expect(isAuthorizedSyncReplay(authorized.replays[0])).toBe(true);
    expect(authorized.workspace.inboxItems).toEqual([
      expect.objectContaining({ id: "inbox-authority-genuine" }),
    ]);

    const { receiptHash: _ignored, ...receiptBase } = applied.receipt;
    const forgedReceiptBase = { ...receiptBase, diff: [] };
    const forgedReceipt: CommandReceipt = {
      ...forgedReceiptBase,
      receiptHash: await sha256Hex(canonicalJson(forgedReceiptBase)),
    };
    const forgedCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "forged-device",
      sequence: 1,
      operationId: "operation-authority-forged",
      command: applied.command,
      receipt: forgedReceipt,
      passphrase: PASSPHRASE,
    });
    const forged = await verified(forgedCreated);
    const forgedHistory = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId: "workspace-sync",
        heads: {
          "forged-device": {
            sequence: 1,
            operationHash: forged.operationHash,
            revision: forged.receipt.revision,
            updatedAt: forged.receipt.createdAt,
          },
        },
        updatedAt: forged.receipt.createdAt,
      }),
      [forged],
    );
    await expect(
      authorizeSyncBranchV2({
        history: forgedHistory,
        trustedAncestorWorkspace: ancestor,
        headOperationHash: forged.operationHash,
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_MISMATCH" });
  });

  it("rejects a branded Workspace Y branch injected into a Workspace X conflict projection", async () => {
    const [{ branch: localBranch }, { branch: remoteBranch }] =
      await Promise.all([
        authorizedCaptureBranch("workspace-branch-x", "branch-x"),
        authorizedCaptureBranch("workspace-branch-y", "branch-y"),
      ]);
    const command = {
      type: "open_sync_conflict",
      conflict: {},
    } as unknown as Extract<V2Command, { type: "open_sync_conflict" }>;
    const context = buildCommandContext({
      commandId: "open-cross-workspace-conflict",
      expectedRevision: localBranch.workspace.revision,
      actorId: "sync-conflict-detector",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "sync-merge:cross-workspace",
        verified: true,
        capabilities: ["open_conflict"],
      },
      now: "2026-07-12T03:15:00.000Z",
    });

    await expect(
      authorizeConflictOpenFromBranchesV2({
        localBranch,
        remoteBranch,
        currentWorkspace: localBranch.workspace,
        command,
        context,
      } as never),
    ).rejects.toMatchObject({
      code: "BRANCH_PROVENANCE_MISMATCH",
    });
  });

  it("rejects same-workspace replay fragments spliced outside the opaque branch authority", async () => {
    const { branch } = await authorizedCaptureBranch(
      "workspace-spliced-branch",
      "branch-fragment",
    );
    const splicedBranch = {
      ...branch,
      replays: [...branch.replays],
    } as typeof branch;
    expect(isAuthorizedSyncBranchV2(branch)).toBe(true);
    expect(isAuthorizedSyncBranchV2(splicedBranch)).toBe(false);
    const command = {
      type: "open_sync_conflict",
      conflict: {},
    } as unknown as Extract<V2Command, { type: "open_sync_conflict" }>;
    const context = buildCommandContext({
      commandId: "open-spliced-conflict",
      expectedRevision: branch.workspace.revision,
      actorId: "sync-conflict-detector",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: "sync-merge:spliced-fragments",
        verified: true,
        capabilities: ["open_conflict"],
      },
      now: "2026-07-12T03:16:00.000Z",
    });

    await expect(
      authorizeConflictOpenFromBranchesV2({
        localBranch: branch,
        remoteBranch: splicedBranch,
        currentWorkspace: branch.workspace,
        command,
        context,
      } as never),
    ).rejects.toMatchObject({
      code: "AUTHORIZED_BRANCH_REQUIRED",
    });
  });

  it("rejects a cycle in the active persisted-conflict provenance graph", () => {
    const activeEdges = new Set([
      { sourceKey: "branch-a", targetKey: "branch-b" },
      { sourceKey: "branch-b", targetKey: "branch-c" },
    ]);

    expect(() =>
      assertAcyclicSyncProvenanceEdgeV2(
        activeEdges,
        "branch-c",
        "branch-a",
      ),
    ).toThrow(SyncProtocolError);
    try {
      assertAcyclicSyncProvenanceEdgeV2(
        activeEdges,
        "branch-c",
        "branch-a",
      );
    } catch (error) {
      expect(error).toMatchObject({ code: "BROKEN_HASH_CHAIN" });
    }
  });

  it("shares one in-flight target authorization across async diamond fan-in", async () => {
    const activeEdges = new Set<{
      sourceKey: string;
      targetKey: string;
    }>();
    const memo = new Map<string, Promise<string>>();
    let evaluationCount = 0;
    let releaseTarget!: () => void;
    const targetBarrier = new Promise<void>((resolve) => {
      releaseTarget = resolve;
    });
    const authorizeSharedTarget = (): Promise<string> => {
      const existing = memo.get("shared-target");
      if (existing !== undefined) return existing;
      const pending = (async () => {
        evaluationCount += 1;
        await targetBarrier;
        return "authorized-shared-target";
      })();
      memo.set("shared-target", pending);
      return pending;
    };

    const fanIn = Promise.all([
      withAcyclicSyncProvenanceEdgeV2(
        activeEdges,
        "left-source",
        "shared-target",
        authorizeSharedTarget,
      ),
      withAcyclicSyncProvenanceEdgeV2(
        activeEdges,
        "right-source",
        "shared-target",
        authorizeSharedTarget,
      ),
    ]);
    await Promise.resolve();
    expect(evaluationCount).toBe(1);
    expect(activeEdges).toHaveLength(2);

    releaseTarget();
    await expect(fanIn).resolves.toEqual([
      "authorized-shared-target",
      "authorized-shared-target",
    ]);
    expect(activeEdges).toHaveLength(0);
  });

  it("rejects a fresh sync-origin human Bet with no prior non-sync authority receipt", async () => {
    const brief = buildDirectionBrief({
      id: "brief-fresh-sync-bet",
      projectId: "project-fresh-sync-bet",
      appetiteSeconds: 7_200,
      firstScope: [
        {
          id: "scope-fresh-sync-bet",
          title: "Bounded scope",
          description: "One approved outcome",
        },
      ],
      createdAt: "2026-07-11T01:00:00.000Z",
      updatedAt: "2026-07-11T01:00:00.000Z",
    });
    const ancestor = buildWorkspaceV2("workspace-sync", {
      projects: [
        buildProjectV2({
          id: "project-fresh-sync-bet",
          stage: "awaiting_bet",
          activeDirectionBriefId: brief.id,
          createdAt: "2026-07-11T01:00:00.000Z",
          updatedAt: "2026-07-11T01:00:00.000Z",
        }),
      ],
      directionBriefs: [brief],
    });
    const command = {
      type: "place_bet",
      projectId: "project-fresh-sync-bet",
      betId: "bet-fresh-sync-bet",
      start: NOW,
    } as const satisfies V2Command;
    const applied = await executeCommand(
      ancestor,
      command,
      buildCommandContext({
        commandId: "fresh-sync-bet",
        expectedRevision: 0,
        actorId: "claimed-remote-human",
        actorKind: "human",
        origin: "sync",
        source: {
          sourceId: `sync-replay:${"a".repeat(64)}:claimed-human-session`,
          verified: true,
          capabilities: ["replay_receipt"],
        },
        now: NOW,
      }),
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("Expected raw domain fixture to apply");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "fresh-sync-device",
      sequence: 1,
      operationId: "operation-fresh-sync-bet",
      command,
      receipt: applied.receipt,
      passphrase: PASSPHRASE,
    });
    const replay = await verified(created);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        "fresh-sync-device": {
          sequence: 1,
          operationHash: replay.operationHash,
          revision: replay.receipt.revision,
          updatedAt: replay.receipt.createdAt,
        },
      },
      updatedAt: replay.receipt.createdAt,
    });

    expect(() => verifySyncHistoryV2(manifest, [replay])).toThrowError(
      expect.objectContaining({ code: "BROKEN_HASH_CHAIN" }),
    );
  });

  it("accepts a repeated command identity only as an exact causal replay link", async () => {
    const ancestor = buildWorkspaceV2("workspace-sync");
    const localApplied = await applyCapture(
      ancestor,
      "causal-local-seed",
      "2026-07-12T03:30:00.000Z",
    );
    const remoteApplied = await applyCapture(
      ancestor,
      "causal-remote",
      "2026-07-12T03:31:00.000Z",
    );
    const localCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "local-device",
      sequence: 1,
      operationId: "operation-causal-local",
      command: localApplied.command,
      receipt: localApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const remoteCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "remote-device",
      sequence: 1,
      operationId: "operation-causal-remote",
      command: remoteApplied.command,
      receipt: remoteApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const replayed = await executeCommand(
      localApplied.workspace,
      remoteApplied.command,
      {
        commandId: remoteApplied.receipt.commandId,
        expectedRevision: 1,
        actorId: remoteApplied.receipt.actorId,
        actorKind: remoteApplied.receipt.actorKind,
        origin: "sync",
        source: {
          sourceId: `sync-replay:${remoteCreated.operationHash}:${remoteApplied.receipt.source.sourceId}`,
          verified: remoteApplied.receipt.source.verified,
          capabilities: ["human_decision", "replay_receipt"],
        },
        now: remoteApplied.receipt.createdAt,
      },
    );
    if (!replayed.ok) throw new Error("Expected causal replay fixture");
    const replayCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "local-device",
      sequence: 2,
      operationId: "operation-causal-replay",
      command: remoteApplied.command,
      receipt: replayed.receipt,
      previousOperationHash: localCreated.operationHash,
      passphrase: PASSPHRASE,
    });
    const [local, remote, replay] = await Promise.all([
      verified(localCreated),
      verified(remoteCreated),
      verified(replayCreated),
    ]);
    const history = verifySyncHistoryV2(
      createSyncManifestV2({
        workspaceId: "workspace-sync",
        heads: {
          "local-device": {
            sequence: 2,
            operationHash: replay.operationHash,
            revision: 2,
            updatedAt: replay.receipt.createdAt,
          },
          "remote-device": {
            sequence: 1,
            operationHash: remote.operationHash,
            revision: 1,
            updatedAt: remote.receipt.createdAt,
          },
        },
        updatedAt: remote.receipt.createdAt,
      }),
      [replay, remote, local],
    );

    const authorized = await authorizeSyncBranchV2({
      history,
      trustedAncestorWorkspace: ancestor,
      headOperationHash: replay.operationHash,
    });
    expect(authorized.replays.map(({ operationHash }) => operationHash)).toEqual([
      local.operationHash,
      replay.operationHash,
    ]);
    expect(authorized.workspace.inboxItems.map(({ id }) => id).sort()).toEqual([
      "inbox-causal-local-seed",
      "inbox-causal-remote",
    ]);
  });

  it("rejects a later device sequence that abandons its own earlier branch", async () => {
    const a1Applied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "orphan-a1",
      "2026-07-12T03:20:00.000Z",
    );
    const c1Applied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "orphan-c1",
      "2026-07-12T03:21:00.000Z",
    );
    const a1Created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "device-a",
      sequence: 1,
      operationId: "operation-orphan-a1",
      command: a1Applied.command,
      receipt: a1Applied.receipt,
      passphrase: PASSPHRASE,
    });
    const c1Created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "device-c",
      sequence: 1,
      operationId: "operation-orphan-c1",
      command: c1Applied.command,
      receipt: c1Applied.receipt,
      passphrase: PASSPHRASE,
    });
    const a2Applied = await applyCapture(
      c1Applied.workspace,
      "orphan-a2",
      "2026-07-12T03:22:00.000Z",
    );
    const a2Created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "device-a",
      sequence: 2,
      operationId: "operation-orphan-a2",
      command: a2Applied.command,
      receipt: a2Applied.receipt,
      previousOperationHash: c1Created.operationHash,
      passphrase: PASSPHRASE,
    });
    const [a1, c1, a2] = await Promise.all([
      verified(a1Created),
      verified(c1Created),
      verified(a2Created),
    ]);
    const manifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        "device-a": {
          sequence: 2,
          operationHash: a2.operationHash,
          revision: 2,
          updatedAt: a2.receipt.createdAt,
        },
        "device-c": {
          sequence: 1,
          operationHash: c1.operationHash,
          revision: 1,
          updatedAt: c1.receipt.createdAt,
        },
      },
      updatedAt: a2.receipt.createdAt,
    });

    expect(() => verifySyncHistoryV2(manifest, [a1, c1, a2])).toThrowError(
      expect.objectContaining({ code: "BROKEN_HASH_CHAIN" }),
    );
  });

  it("rejects a missing ancestor and a revision-broken hash-chain edge", async () => {
    const rootApplied = await applyCapture(
      buildWorkspaceV2("workspace-sync"),
      "broken-root",
      "2026-07-12T04:00:00.000Z",
    );
    const rootCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "desktop",
      sequence: 1,
      operationId: "operation-broken-root",
      command: rootApplied.command,
      receipt: rootApplied.receipt,
      passphrase: PASSPHRASE,
    });
    const childApplied = await applyCapture(
      rootApplied.workspace,
      "broken-child",
      "2026-07-12T04:01:00.000Z",
    );
    const missingCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "ipad",
      sequence: 1,
      operationId: "operation-missing-parent",
      command: childApplied.command,
      receipt: childApplied.receipt,
      previousOperationHash: "e".repeat(64),
      passphrase: PASSPHRASE,
    });
    const [root, missing] = await Promise.all([
      verified(rootCreated),
      verified(missingCreated),
    ]);
    const missingManifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        desktop: {
          sequence: 1,
          operationHash: root.operationHash,
          revision: root.receipt.revision,
          updatedAt: root.receipt.createdAt,
        },
        ipad: {
          sequence: 1,
          operationHash: missing.operationHash,
          revision: missing.receipt.revision,
          updatedAt: missing.receipt.createdAt,
        },
      },
      updatedAt: missing.receipt.createdAt,
    });
    expect(() => verifySyncHistoryV2(missingManifest, [root, missing])).toThrowError(
      expect.objectContaining({ code: "MISSING_ANCESTOR" }),
    );

    const validChildCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-valid-child",
      command: childApplied.command,
      receipt: childApplied.receipt,
      previousOperationHash: root.operationHash,
      passphrase: PASSPHRASE,
    });
    const validChild = await verified(validChildCreated);
    const wrongParentCreated = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "iphone",
      sequence: 1,
      operationId: "operation-wrong-parent",
      command: childApplied.command,
      receipt: childApplied.receipt,
      previousOperationHash: validChild.operationHash,
      passphrase: PASSPHRASE,
    });
    const wrongParent = await verified(wrongParentCreated);
    const brokenManifest = createSyncManifestV2({
      workspaceId: "workspace-sync",
      heads: {
        desktop: {
          sequence: 1,
          operationHash: root.operationHash,
          revision: root.receipt.revision,
          updatedAt: root.receipt.createdAt,
        },
        macbook: {
          sequence: 1,
          operationHash: validChild.operationHash,
          revision: validChild.receipt.revision,
          updatedAt: validChild.receipt.createdAt,
        },
        iphone: {
          sequence: 1,
          operationHash: wrongParent.operationHash,
          revision: wrongParent.receipt.revision,
          updatedAt: wrongParent.receipt.createdAt,
        },
      },
      updatedAt: wrongParent.receipt.createdAt,
    });
    expect(() =>
      verifySyncHistoryV2(brokenManifest, [root, validChild, wrongParent]),
    ).toThrowError(expect.objectContaining({ code: "BROKEN_HASH_CHAIN" }));
  });

  it("classifies exactly the five lifecycle records protected from last-writer merge", () => {
    const changes = classifyProtectedRecordChanges([
      {
        entity: "BetVersion",
        entityId: "bet-1",
        field: "appetiteEnd",
        before: { id: "bet-1", projectId: "project-1" },
        after: { id: "bet-1", projectId: "project-1" },
      },
      {
        entity: "DailyCommitment",
        entityId: "commitment-1",
        field: "slots",
        before: { id: "commitment-1" },
        after: { id: "commitment-1" },
      },
      {
        entity: "ReviewRecord",
        entityId: "review-1",
        field: "conclusion",
        before: { id: "review-1", projectId: "project-1" },
        after: { id: "review-1", projectId: "project-1" },
      },
      {
        entity: "ExceptionRecord",
        entityId: "exception-1",
        field: "resolvedAt",
        before: { id: "exception-1", projectId: "project-1" },
        after: { id: "exception-1", projectId: "project-1" },
      },
      {
        entity: "CloseDecision",
        entityId: "close-1",
        field: "created",
        before: null,
        after: { id: "close-1", projectId: "project-1" },
      },
      {
        entity: "inbox",
        entityId: "inbox-unrelated",
        field: "created",
        before: null,
        after: { id: "inbox-unrelated" },
      },
    ]);

    expect(changes).toEqual([
      {
        recordType: "bet",
        recordId: "bet-1",
        projectId: "project-1",
        changedFields: ["appetiteEnd"],
      },
      {
        recordType: "close",
        recordId: "close-1",
        projectId: "project-1",
        changedFields: ["created"],
      },
      {
        recordType: "daily_commitment",
        recordId: "commitment-1",
        changedFields: ["slots"],
      },
      {
        recordType: "exception",
        recordId: "exception-1",
        projectId: "project-1",
        changedFields: ["resolvedAt"],
      },
      {
        recordType: "review",
        recordId: "review-1",
        projectId: "project-1",
        changedFields: ["conclusion"],
      },
    ]);
    expect(Object.isFrozen(changes)).toBe(true);
    expect(changes.every(Object.isFrozen)).toBe(true);
  });

  it("fails closed with typed errors for primitive, non-canonical, downgrade, and extra-field inputs", async () => {
    const { command, receipt } = await appliedCapture("strict-shape");
    const created = await createSyncOperationV2({
      workspaceId: "workspace-sync",
      deviceId: "macbook",
      sequence: 1,
      operationId: "operation-strict-shape",
      command,
      receipt,
      passphrase: PASSPHRASE,
    });
    const malformedEnvelopes: unknown[] = [
      null,
      42,
      [],
      {},
      { ...created.envelope, workspaceId: " workspace-sync" },
      { ...created.envelope, createdAt: "2026-07-12T03:00:00Z" },
      { ...created.envelope, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...created.envelope, unexpected: true },
      {
        ...created.envelope,
        payload: { ...created.envelope.payload, iterations: 1 },
      },
    ];
    for (const malformed of malformedEnvelopes) {
      expect(() => parseSyncEnvelopeV2(malformed)).toThrowError(
        expect.objectContaining({ name: "SyncProtocolError" }),
      );
    }

    for (const malformed of [
      null,
      42,
      [],
      {},
      {
        schemaVersion: 2,
        protocol: "omniplan-v2-command-log",
        workspaceId: "workspace-sync",
        heads: {
          macbook: {
            sequence: Number.MAX_SAFE_INTEGER + 1,
            operationHash: created.operationHash,
            revision: 1,
            updatedAt: NOW,
          },
        },
        updatedAt: NOW,
      },
      {
        schemaVersion: 2,
        protocol: "omniplan-v2-command-log",
        workspaceId: "workspace-sync",
        heads: {
          macbook: {
            sequence: 1,
            operationHash: created.operationHash,
            revision: 1,
            updatedAt: "2026-07-12T03:01:00.000Z",
          },
        },
        updatedAt: NOW,
      },
    ]) {
      expect(() => parseSyncManifestV2(malformed)).toThrowError(
        expect.objectContaining({ name: "SyncProtocolError" }),
      );
    }

    await expect(
      decryptAndVerifySyncOperationV2({
        envelope: created.envelope,
        path: created.path,
        passphrase: "wrong passphrase",
      }),
    ).rejects.toMatchObject({ code: "DECRYPTION_FAILED" });
  });
});
