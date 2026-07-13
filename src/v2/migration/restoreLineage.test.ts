import { describe, expect, it } from "vitest";

import type {
  AuditDiff,
  CommandReceipt,
  JsonValue,
  WorkspaceV2,
} from "../domain/types";
import { createEmptyWorkspaceV2 } from "../domain/workspace";
import { migratedWorkspaceDescendsFromBaseline } from "./restoreLineage";

function inboxItem(id: string): WorkspaceV2["inboxItems"][number] {
  return {
    id,
    originalText: `Captured ${id}`,
    sourceId: "restore-lineage-test",
    actorId: "restore-lineage-human",
    capturedAt: "2026-07-12T00:00:00.000Z",
    triageStatus: "untriaged",
  };
}

function appliedReceipt(revision: number, diff: AuditDiff[]): CommandReceipt {
  const commandId = `restore-lineage-command-${revision}`;
  return {
    id: commandId,
    commandId,
    commandType: "capture_inbox",
    baseRevision: revision - 1,
    revision,
    payloadHash: "a".repeat(64),
    receiptHash: revision.toString(16).repeat(64),
    actorId: "restore-lineage-human",
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: "restore-lineage-test",
      verified: true,
      capabilities: ["human_decision"],
    },
    status: "applied",
    createdAt: `2026-07-12T00:0${revision}:00.000Z`,
    diff,
  };
}

function targetWithReceipts(
  baseline: Readonly<WorkspaceV2>,
  receipts: CommandReceipt[],
): WorkspaceV2 {
  const target = structuredClone(baseline) as WorkspaceV2;
  target.revision = receipts.length;
  target.commandReceipts = structuredClone(receipts);
  return target;
}

describe("migrated restore receipt lineage", () => {
  it("rejects a schema-invalid intermediate revision even when a later receipt deletes it", () => {
    const baseline = createEmptyWorkspaceV2(
      "workspace-lineage-invalid-intermediate",
    );
    const malformed = { id: "temporary-invalid-inbox" } as unknown as JsonValue;
    const receipts = [
      appliedReceipt(1, [
        {
          entity: "InboxItem",
          entityId: "temporary-invalid-inbox",
          field: "created",
          before: null,
          after: malformed,
        },
      ]),
      appliedReceipt(2, [
        {
          entity: "InboxItem",
          entityId: "temporary-invalid-inbox",
          field: "deleted",
          before: malformed,
          after: null,
        },
      ]),
    ];

    expect(
      migratedWorkspaceDescendsFromBaseline(
        baseline,
        targetWithReceipts(baseline, receipts),
      ),
    ).toBe(false);
  });

  it("rejects an unrelated collection reorder hidden behind an empty receipt diff", () => {
    const baseline = createEmptyWorkspaceV2("workspace-lineage-empty-diff");
    baseline.inboxItems.push(inboxItem("inbox-a"), inboxItem("inbox-b"));
    const receipt = appliedReceipt(1, []);
    const target = targetWithReceipts(baseline, [receipt]);
    target.inboxItems = [target.inboxItems[1]!, target.inboxItems[0]!];

    expect(migratedWorkspaceDescendsFromBaseline(baseline, target)).toBe(false);
  });

  it("allows an entity created by the ledger to occupy a different unrecorded insertion position", () => {
    const baseline = createEmptyWorkspaceV2(
      "workspace-lineage-created-position",
    );
    baseline.inboxItems.push(inboxItem("inbox-a"), inboxItem("inbox-b"));
    const created = inboxItem("inbox-created");
    const receipt = appliedReceipt(1, [
      {
        entity: "InboxItem",
        entityId: created.id,
        field: "created",
        before: null,
        after: structuredClone(created) as unknown as JsonValue,
      },
    ]);
    const target = targetWithReceipts(baseline, [receipt]);
    target.inboxItems = [created, ...target.inboxItems];

    expect(migratedWorkspaceDescendsFromBaseline(baseline, target)).toBe(true);
  });

  it("allows two ledger-created identities to exchange their unrecorded relative order", () => {
    const baseline = createEmptyWorkspaceV2(
      "workspace-lineage-created-relative-order",
    );
    baseline.inboxItems.push(inboxItem("inbox-a"), inboxItem("inbox-b"));
    const createdA = inboxItem("inbox-created-a");
    const createdB = inboxItem("inbox-created-b");
    const receipt = appliedReceipt(
      1,
      [createdA, createdB].map((created) => ({
        entity: "InboxItem",
        entityId: created.id,
        field: "created",
        before: null,
        after: structuredClone(created) as unknown as JsonValue,
      })),
    );
    const target = targetWithReceipts(baseline, [receipt]);
    target.inboxItems = [
      createdB,
      target.inboxItems[0]!,
      createdA,
      target.inboxItems[1]!,
    ];

    expect(migratedWorkspaceDescendsFromBaseline(baseline, target)).toBe(true);
  });

  it("rejects swapping survivor order even when the collection also has a created entity", () => {
    const baseline = createEmptyWorkspaceV2("workspace-lineage-survivor-order");
    baseline.inboxItems.push(inboxItem("inbox-a"), inboxItem("inbox-b"));
    const created = inboxItem("inbox-created");
    const receipt = appliedReceipt(1, [
      {
        entity: "InboxItem",
        entityId: created.id,
        field: "created",
        before: null,
        after: structuredClone(created) as unknown as JsonValue,
      },
    ]);
    const target = targetWithReceipts(baseline, [receipt]);
    target.inboxItems = [target.inboxItems[1]!, created, target.inboxItems[0]!];

    expect(migratedWorkspaceDescendsFromBaseline(baseline, target)).toBe(false);
  });
});
