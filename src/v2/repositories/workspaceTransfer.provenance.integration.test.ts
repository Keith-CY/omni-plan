import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "../../domain/canonical";
import type {
  AuditDiff,
  CapacityProfile,
  CloseDecision,
  CommandReceipt,
  DailyCommitment,
  ExceptionRecord,
  JsonValue,
  ProjectWorkItem,
  ReviewRecord,
  SyncConflictRecord,
  WorkspaceV2,
} from "../domain/types";
import {
  buildDirectionBrief,
  buildProjectV2,
  buildWorkspaceV2,
} from "../tests/builders";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import {
  deleteV2Database,
  openV2Database,
  requestResult,
  transactionComplete,
  V2_OBJECT_STORES,
} from "./indexedDb";
import {
  buildWorkspaceBackupV2,
  restoreVerifiedBackup,
  type WorkspaceBackupV2,
} from "./workspaceTransfer";

const WORKSPACE_ID = "protected-provenance-matrix";
const ACTOR_ID = "protected-human";
const CREATED_AT = "2026-07-12T08:00:00.000Z";
const RESOLVED_AT = "2026-07-12T08:10:00.000Z";
const EXPORTED_AT = "2026-07-12T09:00:00.000Z";
const indexedDBFactory = new IDBFactory();
const databaseNames: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseNames.map((databaseName) =>
      deleteV2Database({
        databaseName,
        indexedDB: indexedDBFactory,
      }).catch(() => undefined),
    ),
  );
  databaseNames.length = 0;
});

function json(value: unknown): JsonValue {
  return structuredClone(value) as JsonValue;
}

async function receipt(input: {
  commandId: string;
  commandType: string;
  baseRevision: number;
  revision: number;
  createdAt: string;
  diff: AuditDiff[];
}): Promise<CommandReceipt> {
  const withoutHash = {
    id: input.commandId,
    commandId: input.commandId,
    commandType: input.commandType,
    baseRevision: input.baseRevision,
    revision: input.revision,
    payloadHash: await sha256Hex(
      canonicalJson({ commandId: input.commandId, type: input.commandType }),
    ),
    actorId: ACTOR_ID,
    actorKind: "human" as const,
    origin: "ui" as const,
    source: {
      sourceId: "verified-protected-session",
      verified: true,
      capabilities: ["human_decision" as const],
    },
    status: "applied" as const,
    createdAt: input.createdAt,
    diff: structuredClone(input.diff),
  };
  return {
    ...withoutHash,
    receiptHash: await sha256Hex(canonicalJson(withoutHash)),
  };
}

async function rehashReceipt(value: CommandReceipt): Promise<void> {
  const { receiptHash: _receiptHash, ...withoutHash } = value;
  value.receiptHash = await sha256Hex(canonicalJson(withoutHash));
}

async function resignBackup(
  value: WorkspaceBackupV2,
): Promise<WorkspaceBackupV2> {
  const backup = structuredClone(value);
  backup.workspaceHash = await sha256Hex(canonicalJson(backup.workspace));
  backup.receiptLedgerHash = await sha256Hex(
    canonicalJson(backup.rejectedReceipts),
  );
  const { backupChecksum: _backupChecksum, ...withoutChecksum } = backup;
  backup.backupChecksum = await sha256Hex(canonicalJson(withoutChecksum));
  return backup;
}

async function backupFor(
  workspace: WorkspaceV2,
  receipts: CommandReceipt[],
): Promise<WorkspaceBackupV2> {
  return buildWorkspaceBackupV2({
    snapshot: {
      workspace: {
        ...structuredClone(workspace),
        revision: receipts.length,
        commandReceipts: structuredClone(receipts),
      },
      rejectedReceipts: [],
    },
    exportedAt: EXPORTED_AT,
  });
}

function repository(suffix: string): BrowserWorkspaceRepository {
  const databaseName = `omni-plan-v2-provenance-${suffix}`;
  databaseNames.push(databaseName);
  return new BrowserWorkspaceRepository({
    databaseName,
    indexedDB: indexedDBFactory,
  });
}

async function initializedRepository(
  suffix: string,
): Promise<BrowserWorkspaceRepository> {
  const result = repository(suffix);
  await result.initialize(buildWorkspaceV2(WORKSPACE_ID));
  return result;
}

async function rawPersistence(repo: BrowserWorkspaceRepository) {
  const database = await openV2Database({
    databaseName: repo.databaseName,
    indexedDB: indexedDBFactory,
  });
  try {
    const transaction = database.transaction(
      [
        V2_OBJECT_STORES.workspace,
        V2_OBJECT_STORES.receipts,
        V2_OBJECT_STORES.outbox,
        V2_OBJECT_STORES.backups,
        V2_OBJECT_STORES.migrationRuns,
      ],
      "readonly",
    );
    const completion = transactionComplete(transaction);
    const state = await Promise.all(
      [
        V2_OBJECT_STORES.workspace,
        V2_OBJECT_STORES.receipts,
        V2_OBJECT_STORES.outbox,
        V2_OBJECT_STORES.backups,
        V2_OBJECT_STORES.migrationRuns,
      ].map((store) =>
        requestResult(transaction.objectStore(store).getAll()),
      ),
    );
    await completion;
    return structuredClone(state);
  } finally {
    database.close();
  }
}

interface ProvenanceFixture {
  name: string;
  proofCommandId: string;
  proofEntity: string;
  proofEntityId: string;
  proofField: string;
  backup: WorkspaceBackupV2;
  mutateRecord: (workspace: WorkspaceV2) => void;
}

async function dailyCommitmentFixture(): Promise<ProvenanceFixture> {
  const capacity: CapacityProfile = {
    timeZone: "UTC",
    weeklyWindows: [],
    dailyBudgets: [],
    unavailableBlocks: [],
    updatedAt: "2026-07-12T07:00:00.000Z",
    updatedBy: ACTOR_ID,
  };
  const commitment: DailyCommitment = {
    id: "protected-commitment",
    localDate: "2026-07-12",
    version: 1,
    proposalHash: "protected-proposal-hash",
    capacitySnapshot: structuredClone(capacity),
    slots: [],
    actorId: ACTOR_ID,
    committedAt: CREATED_AT,
  };
  const proof = await receipt({
    commandId: "proof-commit-today",
    commandType: "commit_today",
    baseRevision: 0,
    revision: 1,
    createdAt: CREATED_AT,
    diff: [
      {
        entity: "DailyCommitment",
        entityId: commitment.id,
        field: "created",
        before: null,
        after: json(commitment),
      },
    ],
  });
  return {
    name: "DailyCommitment",
    proofCommandId: proof.commandId,
    proofEntity: "DailyCommitment",
    proofEntityId: commitment.id,
    proofField: "created",
    backup: await backupFor(
      buildWorkspaceV2(WORKSPACE_ID, {
        capacityProfile: capacity,
        dailyCommitments: [commitment],
      }),
      [proof],
    ),
    mutateRecord(workspace) {
      workspace.dailyCommitments[0]!.actorId = "forged-record-actor";
    },
  };
}

async function exceptionFixture(): Promise<ProvenanceFixture> {
  const brief = buildDirectionBrief({
    id: "exception-brief",
    projectId: "exception-project",
    createdAt: "2026-07-12T07:00:00.000Z",
    updatedAt: "2026-07-12T07:00:00.000Z",
  });
  const project = buildProjectV2({
    id: "exception-project",
    activeDirectionBriefId: brief.id,
    createdAt: "2026-07-12T07:00:00.000Z",
    updatedAt: "2026-07-12T07:00:00.000Z",
  });
  const requirement: ProjectWorkItem = {
    id: "exception-requirement",
    projectId: project.id,
    kind: "milestone",
    title: "Evidence milestone",
    outline: "Requires exact evidence.",
    durationSeconds: 0,
    estimate: { mostLikelySeconds: 0 },
    assignmentIds: [],
    percentComplete: 0,
    revision: 1,
    betScopeId: "exception-scope",
    evidenceRequired: true,
  };
  const creation: ExceptionRecord = {
    id: "protected-exception",
    projectId: project.id,
    requirementId: requirement.id,
    rationale: "A bounded dependency delays evidence.",
    knownConsequence: "Validation cannot rely on it after expiry.",
    reviewAt: "2026-07-12T10:00:00.000Z",
    expiresAt: "2026-07-12T11:00:00.000Z",
    approvedBy: ACTOR_ID,
    createdAt: CREATED_AT,
    history: [
      {
        action: "created",
        actorId: ACTOR_ID,
        at: CREATED_AT,
        note: "A bounded dependency delays evidence.",
      },
    ],
  };
  const resolved: ExceptionRecord = {
    ...structuredClone(creation),
    resolvedAt: RESOLVED_AT,
    history: [
      ...structuredClone(creation.history),
      {
        action: "resolved",
        actorId: ACTOR_ID,
        at: RESOLVED_AT,
        note: "Evidence attached.",
      },
    ],
  };
  const approvalProof = await receipt({
    commandId: "proof-approve-exception",
    commandType: "approve_evidence_exception",
    baseRevision: 0,
    revision: 1,
    createdAt: CREATED_AT,
    diff: [
      {
        entity: "ExceptionRecord",
        entityId: creation.id,
        field: "created",
        before: null,
        after: json(creation),
      },
    ],
  });
  const resolutionProof = await receipt({
    commandId: "proof-resolve-exception",
    commandType: "resolve_evidence_exception",
    baseRevision: 1,
    revision: 2,
    createdAt: RESOLVED_AT,
    diff: [
      {
        entity: "ExceptionRecord",
        entityId: creation.id,
        field: "history",
        before: json(creation.history),
        after: json(resolved.history),
      },
      {
        entity: "ExceptionRecord",
        entityId: creation.id,
        field: "resolvedAt",
        before: null,
        after: RESOLVED_AT,
      },
    ],
  });
  return {
    name: "ExceptionRecord",
    proofCommandId: approvalProof.commandId,
    proofEntity: "ExceptionRecord",
    proofEntityId: creation.id,
    proofField: "created",
    backup: await backupFor(
      buildWorkspaceV2(WORKSPACE_ID, {
        projects: [project],
        directionBriefs: [brief],
        workItems: [requirement],
        exceptions: [resolved],
      }),
      [approvalProof, resolutionProof],
    ),
    mutateRecord(workspace) {
      workspace.exceptions[0]!.approvedBy = "forged-record-actor";
    },
  };
}

async function unresolvedExceptionFixture(): Promise<ProvenanceFixture> {
  const resolvedFixture = await exceptionFixture();
  const workspace = structuredClone(resolvedFixture.backup.workspace);
  const exception = workspace.exceptions[0];
  const approvalProof = workspace.commandReceipts.find(
    ({ commandId }) => commandId === resolvedFixture.proofCommandId,
  );
  if (exception === undefined || approvalProof === undefined) {
    throw new Error("Expected Exception approval fixture");
  }
  delete exception.resolvedAt;
  exception.history = exception.history.filter(
    ({ action }) => action === "created",
  );
  return {
    name: "unresolved ExceptionRecord",
    proofCommandId: approvalProof.commandId,
    proofEntity: "ExceptionRecord",
    proofEntityId: exception.id,
    proofField: "created",
    backup: await backupFor(workspace, [approvalProof]),
    mutateRecord(candidate) {
      candidate.exceptions[0]!.approvedBy = "forged-record-actor";
    },
  };
}

async function closeDecisionFixture(): Promise<ProvenanceFixture> {
  const brief = buildDirectionBrief({
    id: "close-brief",
    projectId: "close-project",
    successEvidence: "The bounded outcome is visible.",
    createdAt: "2026-07-12T07:00:00.000Z",
    updatedAt: "2026-07-12T07:00:00.000Z",
  });
  const project = buildProjectV2({
    id: "close-project",
    activeDirectionBriefId: brief.id,
    stage: "closed",
    createdAt: "2026-07-12T07:00:00.000Z",
    updatedAt: CREATED_AT,
  });
  const decision: CloseDecision = {
    id: "protected-close",
    projectId: project.id,
    successComparison: "The target outcome was met.",
    outcome: "achieved",
    keyLearning: "Keep the decision auditable.",
    unfinishedDisposition: "discard",
    actorId: ACTOR_ID,
    closedAt: CREATED_AT,
  };
  const proof = await receipt({
    commandId: "proof-close-project",
    commandType: "close_project",
    baseRevision: 0,
    revision: 1,
    createdAt: CREATED_AT,
    diff: [
      {
        entity: "CloseDecision",
        entityId: decision.id,
        field: "created",
        before: null,
        after: json(decision),
      },
    ],
  });
  return {
    name: "CloseDecision",
    proofCommandId: proof.commandId,
    proofEntity: "CloseDecision",
    proofEntityId: decision.id,
    proofField: "created",
    backup: await backupFor(
      buildWorkspaceV2(WORKSPACE_ID, {
        projects: [project],
        directionBriefs: [brief],
        closeDecisions: [decision],
      }),
      [proof],
    ),
    mutateRecord(workspace) {
      workspace.closeDecisions[0]!.actorId = "forged-record-actor";
    },
  };
}

function completedReview(input: {
  id: string;
  triggerType: ReviewRecord["triggerType"];
  triggerKey: string;
  actorId?: string;
  completedAt?: string;
}): ReviewRecord {
  return {
    id: input.id,
    kind: "event",
    triggerKey: input.triggerKey,
    triggerType: input.triggerType,
    status: "completed",
    affectedProjectIds: [],
    affectedRecordIds: [],
    dueAt: "2026-07-12T10:00:00.000Z",
    createdAt: "2026-07-12T07:00:00.000Z",
    conclusion: {
      summary: "The bounded review is complete.",
      decisionCodes: ["continue"],
      followUpCommandIds: [],
      actorId: input.actorId ?? ACTOR_ID,
      completedAt: input.completedAt ?? CREATED_AT,
    },
  };
}

async function completedReviewFixture(): Promise<ProvenanceFixture> {
  const review = completedReview({
    id: "protected-review",
    triggerType: "hard_gate",
    triggerKey: "hard-gate:protected-review",
  });
  const proof = await receipt({
    commandId: "proof-complete-review",
    commandType: "complete_review",
    baseRevision: 0,
    revision: 1,
    createdAt: CREATED_AT,
    diff: [
      {
        entity: "ReviewRecord",
        entityId: review.id,
        field: "conclusion",
        before: null,
        after: json(review.conclusion),
      },
      {
        entity: "ReviewRecord",
        entityId: review.id,
        field: "status",
        before: "open",
        after: "completed",
      },
    ],
  });
  return {
    name: "completed ReviewRecord",
    proofCommandId: proof.commandId,
    proofEntity: "ReviewRecord",
    proofEntityId: review.id,
    proofField: "conclusion",
    backup: await backupFor(
      buildWorkspaceV2(WORKSPACE_ID, { reviews: [review] }),
      [proof],
    ),
    mutateRecord(workspace) {
      workspace.reviews[0]!.conclusion!.actorId = "forged-record-actor";
    },
  };
}

async function resolvedSyncConflictFixture(): Promise<ProvenanceFixture> {
  const retainedReview: ReviewRecord = {
    id: "retained-review",
    kind: "event",
    triggerKey: "retained-review",
    triggerType: "hard_gate",
    status: "open",
    affectedProjectIds: [],
    affectedRecordIds: [],
    dueAt: "2026-07-12T10:00:00.000Z",
    createdAt: "2026-07-12T07:00:00.000Z",
  };
  const conflictId = "protected-conflict";
  const resolutionReview = completedReview({
    id: `review:sync_conflict:${conflictId}`,
    triggerType: "sync_conflict",
    triggerKey: `sync_conflict:${conflictId}`,
    completedAt: RESOLVED_AT,
  });
  resolutionReview.conclusion = {
    ...resolutionReview.conclusion!,
    decisionCodes: ["sync_conflict_retained_local"],
  };
  const conflict: SyncConflictRecord = {
    id: conflictId,
    recordType: "review",
    recordId: retainedReview.id,
    commonAncestorHash: "protected-common-ancestor",
    localValue: json(retainedReview),
    remoteValue: json({ ...retainedReview, id: "remote-review" }),
    openedAt: "2026-07-12T07:30:00.000Z",
    resolvedAt: RESOLVED_AT,
    retainedVersion: "local",
  };
  const proof = await receipt({
    commandId: "proof-resolve-conflict",
    commandType: "resolve_sync_conflict",
    baseRevision: 0,
    revision: 1,
    createdAt: RESOLVED_AT,
    diff: [
      {
        entity: "ReviewRecord",
        entityId: resolutionReview.id,
        field: "conclusion",
        before: null,
        after: json(resolutionReview.conclusion),
      },
      {
        entity: "ReviewRecord",
        entityId: resolutionReview.id,
        field: "status",
        before: "open",
        after: "completed",
      },
      {
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        field: "resolvedAt",
        before: null,
        after: RESOLVED_AT,
      },
      {
        entity: "SyncConflictRecord",
        entityId: conflict.id,
        field: "retainedVersion",
        before: null,
        after: "local",
      },
    ],
  });
  return {
    name: "resolved SyncConflictRecord",
    proofCommandId: proof.commandId,
    proofEntity: "SyncConflictRecord",
    proofEntityId: conflict.id,
    proofField: "resolvedAt",
    backup: await backupFor(
      buildWorkspaceV2(WORKSPACE_ID, {
        reviews: [retainedReview, resolutionReview],
        syncConflicts: [conflict],
      }),
      [proof],
    ),
    mutateRecord(workspace) {
      workspace.syncConflicts[0]!.resolvedAt =
        "2026-07-12T08:11:00.000Z";
    },
  };
}

async function tamperedVariants(
  fixture: ProvenanceFixture,
): Promise<Array<[string, WorkspaceBackupV2]>> {
  let actor = structuredClone(fixture.backup);
  const actorReceipt = actor.workspace.commandReceipts.find(
    ({ commandId }) => commandId === fixture.proofCommandId,
  );
  if (actorReceipt === undefined) throw new Error("Expected proof receipt");
  actorReceipt.actorId = "forged-receipt-actor";
  await rehashReceipt(actorReceipt);
  actor = await resignBackup(actor);

  let time = structuredClone(fixture.backup);
  const timeReceipt = time.workspace.commandReceipts.find(
    ({ commandId }) => commandId === fixture.proofCommandId,
  );
  if (timeReceipt === undefined) throw new Error("Expected proof receipt");
  timeReceipt.createdAt = "2026-07-12T08:05:00.000Z";
  await rehashReceipt(timeReceipt);
  time = await resignBackup(time);

  let diff = structuredClone(fixture.backup);
  const diffReceipt = diff.workspace.commandReceipts.find(
    ({ commandId }) => commandId === fixture.proofCommandId,
  );
  const requiredDiff = diffReceipt?.diff.find(
    ({ entity, entityId, field }) =>
      entity === fixture.proofEntity &&
      entityId === fixture.proofEntityId &&
      field === fixture.proofField,
  );
  if (diffReceipt === undefined || requiredDiff === undefined) {
    throw new Error("Expected required proof diff");
  }
  requiredDiff.after = "forged-diff";
  await rehashReceipt(diffReceipt);
  diff = await resignBackup(diff);

  let record = structuredClone(fixture.backup);
  fixture.mutateRecord(record.workspace);
  record = await resignBackup(record);

  return [
    ["receipt actor", actor],
    ["receipt time", time],
    ["required diff", diff],
    ["protected record", record],
  ];
}

describe("V2 protected restore provenance matrix", () => {
  it("rejects duplicate immutable identities instead of reusing one human proof", async () => {
    const fixture = await closeDecisionFixture();
    const workspace = structuredClone(fixture.backup.workspace);
    workspace.closeDecisions.push(structuredClone(workspace.closeDecisions[0]!));

    await expect(
      buildWorkspaceBackupV2({
        snapshot: {
          workspace,
          rejectedReceipts: fixture.backup.rejectedReceipts,
        },
        exportedAt: EXPORTED_AT,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
  });

  it.each([
    ["DailyCommitment", dailyCommitmentFixture],
    ["ExceptionRecord", exceptionFixture],
    ["unresolved ExceptionRecord", unresolvedExceptionFixture],
    ["CloseDecision", closeDecisionFixture],
    ["completed ReviewRecord", completedReviewFixture],
    ["resolved SyncConflictRecord", resolvedSyncConflictFixture],
  ] as const)(
    "roundtrips %s and rejects independently rehashed provenance mismatches",
    async (_name, createFixture) => {
      const fixture = await createFixture();
      const validTarget = await initializedRepository(`${fixture.name}-valid`);
      await expect(
        restoreVerifiedBackup({
          repository: validTarget,
          backup: fixture.backup,
          validationNow: EXPORTED_AT,
        }),
      ).resolves.toMatchObject({ status: "restored" });

      for (const [tamperName, candidate] of await tamperedVariants(fixture)) {
        const target = await initializedRepository(
          `${fixture.name}-${tamperName}`,
        );
        const before = await rawPersistence(target);
        await expect(
          restoreVerifiedBackup({
            repository: target,
            backup: candidate,
            validationNow: EXPORTED_AT,
          }),
        ).rejects.toMatchObject({ code: "BACKUP_INVALID" });
        expect(await rawPersistence(target)).toEqual(before);
      }
    },
  );
});
