import type { WorkspaceSnapshot } from "@/domain/types";
import { sampleWorkspace } from "@/domain/sampleData";
import { describe, expect, it } from "vitest";
import { stableHash } from "@/v2/domain/stableHash";
import type {
  JsonValue,
  LegacyAuditRecord,
  MigrationRecord,
  WorkspaceV2,
} from "@/v2/domain/types";

import activeIncompleteFixture from "../tests/fixtures/v1/active-incomplete.json";
import completedArchivedFixture from "../tests/fixtures/v1/completed-archived.json";
import currentSampleFixture from "../tests/fixtures/v1/current-sample.json";
import emptyFixture from "../tests/fixtures/v1/empty.json";
import {
  expectedV1FixtureManifest,
  v1EntityKeys,
  v1FixtureNames,
  type V1FixtureName,
} from "../tests/fixtures/v1/expected-manifest";
import legacyArchivedStatusFixture from "../tests/fixtures/v1/legacy-archived-status.json";
import malformedOptionalFieldsFixture from "../tests/fixtures/v1/malformed-optional-fields.json";
import shapeUpBetFixture from "../tests/fixtures/v1/shape-up-bet.json";
import { buildWorkspaceBackupV2 } from "../repositories/workspaceTransfer";
import {
  MigrationSourceError,
  migrateV1Workspace,
  type MigrationOptions,
} from "./migrateV1";
import { validateMigratedWorkspace } from "./validateMigration";

interface V1Fixture {
  schemaVersion: 1;
  exportedAt: string;
  snapshot: WorkspaceSnapshot;
}

const fixtures: Record<V1FixtureName, V1Fixture> = {
  empty: emptyFixture as V1Fixture,
  "current-sample": currentSampleFixture as V1Fixture,
  "active-incomplete": activeIncompleteFixture as V1Fixture,
  "shape-up-bet": shapeUpBetFixture as V1Fixture,
  "completed-archived": completedArchivedFixture as V1Fixture,
  "legacy-archived-status": legacyArchivedStatusFixture as V1Fixture,
  "malformed-optional-fields": malformedOptionalFieldsFixture as unknown as V1Fixture,
};

const NOW = "2026-07-12T00:00:00.000Z";
const options: MigrationOptions = {
  workspaceId: "workspace-migrated",
  sourceChecksum: "source-checksum-v1",
  backupId: "v1-backup-raw-backup-checksum-v1",
  backupChecksum: "raw-backup-checksum-v1",
  actorId: "migration-operator",
  now: NOW,
};
const validationExpectations = {
  sourceChecksum: options.sourceChecksum,
  workspaceId: options.workspaceId,
  backupId: options.backupId,
  backupChecksum: options.backupChecksum,
  migratedAt: options.now,
  now: NOW,
};

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sourceActualKey(
  actual: WorkspaceSnapshot["actuals"][number],
  sourceIndex: number,
): string {
  return `${actual.workItemId}+${actual.recordedAt}+${sourceIndex}`;
}

function ids(records: readonly { id: string }[]): string[] {
  return sorted(records.map(({ id }) => id));
}

function auditById(
  workspace: WorkspaceV2,
  id: string,
): LegacyAuditRecord {
  const record = workspace.legacyAuditRecords.find(
    (candidate) => candidate.id === id,
  );
  expect(record, `missing LegacyAuditRecord ${id}`).toBeDefined();
  return record!;
}

describe("frozen V1 migration fixtures", () => {
  it("lists exactly the seven immutable fixtures", () => {
    expect(Object.keys(fixtures).sort()).toEqual(sorted(v1FixtureNames));
  });

  it("freezes current-sample from the exported sampleWorkspace", () => {
    expect(currentSampleFixture.schemaVersion).toBe(1);
    expect(currentSampleFixture.snapshot).toEqual(sampleWorkspace);
  });

  it.each(v1FixtureNames)(
    "%s matches its exact ID, count, capacity, and Actual-key manifest",
    (name) => {
      const snapshot = fixtures[name].snapshot;
      const expected = expectedV1FixtureManifest[name];

      expect(
        Object.fromEntries(
          v1EntityKeys.map((key) => [key, snapshot[key].length]),
        ),
      ).toEqual(expected.counts);
      expect({
        projects: ids(snapshot.projects),
        workItems: ids(snapshot.workItems),
        dependencies: ids(snapshot.dependencies),
        resources: ids(snapshot.resources),
        baselines: ids(snapshot.baselines),
        evidence: ids(snapshot.evidence),
        decisions: ids(snapshot.decisions),
        changeSets: ids(snapshot.changeSets),
        auditGates: ids(snapshot.auditGates),
        auditDecisions: ids(snapshot.auditDecisions),
      }).toEqual(expected.ids);
      expect(sorted(snapshot.capacities.map(({ date }) => date))).toEqual(
        expected.capacityKeys,
      );
      expect(
        snapshot.actuals.map((actual, index) => sourceActualKey(actual, index)),
      ).toEqual(expected.actualKeys);
    },
  );
});

describe("migrateV1Workspace", () => {
  it.each(v1FixtureNames)(
    "preserves exact source IDs and Resource/AttentionCapacity values for %s",
    (name) => {
      const source = fixtures[name].snapshot;
      const { workspace, migration } = migrateV1Workspace(source, options);

      expect(ids(workspace.projects)).toEqual(ids(source.projects));
      expect(ids(workspace.workItems)).toEqual(ids(source.workItems));
      expect(ids(workspace.dependencies)).toEqual(ids(source.dependencies));
      expect(ids(workspace.baselines)).toEqual(ids(source.baselines));
      expect(ids(workspace.evidence)).toEqual(ids(source.evidence));
      expect(workspace.resources).toEqual(source.resources);
      expect(workspace.capacities).toEqual(source.capacities);
      expect(migration.entityCounts).toEqual(
        expectedV1FixtureManifest[name].counts,
      );
      expect(workspace.migration?.entityCounts).toEqual(
        expectedV1FixtureManifest[name].counts,
      );
    },
  );

  it("creates deterministic Actual IDs from workItemId + recordedAt + sourceIndex and reports every derivation", () => {
    const source = fixtures["current-sample"].snapshot;
    const first = migrateV1Workspace(source, options);
    const second = migrateV1Workspace(structuredClone(source), options);

    const expectedKeys = source.actuals.map(sourceActualKey);
    const expectedIds = source.actuals.map(
      (actual, sourceIndex) =>
        `migration:actual:${encodeURIComponent(actual.workItemId)}:${encodeURIComponent(actual.recordedAt)}:${sourceIndex}`,
    );
    expect(first.workspace.actuals.map(({ id }) => id)).toEqual(expectedIds);
    expect(first.report.actualIdDerivations).toEqual(
      source.actuals.map((actual, sourceIndex) => ({
        sourceIndex,
        workItemId: actual.workItemId,
        recordedAt: actual.recordedAt,
        derivationKey: expectedKeys[sourceIndex],
        actualId: expectedIds[sourceIndex],
      })),
    );
    expect(first.migration.deterministicIdMap).toMatchObject(
      Object.fromEntries(expectedKeys.map((key, index) => [key, expectedIds[index]])),
    );
    expect(second.workspace.actuals).toEqual(first.workspace.actuals);
    expect(first.workspace.actuals[0]).toMatchObject({
      revision: 1,
      target: { kind: "work_item", workItemId: "w-domain" },
      actualWorkSeconds: source.actuals[0].actualWorkSeconds,
      remainingWorkSeconds: source.actuals[0].remainingWorkSeconds,
      actualCost: source.actuals[0].actualCost,
      recordedAt: source.actuals[0].recordedAt,
    });
  });

  it("component-encodes delimiter-like Work Item IDs without deterministic Actual ID collisions", () => {
    const source = structuredClone(fixtures.empty.snapshot);
    source.projects.push({
      id: "p-encoded-actuals",
      name: "Encoded actual IDs",
      status: "active",
      mode: "build",
      priority: 1,
      northStar: "Keep generated identities unambiguous.",
      currentOutcome: "Two legal IDs contain delimiter-like text.",
      horizon: "2026-08-01T00:00:00.000Z",
      start: "2026-07-01T00:00:00.000Z",
      reviewCadenceDays: 7,
    });
    const workItemIds = ["work:item+one", "work%3Aitem%2Bone"];
    source.workItems.push(
      ...workItemIds.map((id, index) => ({
        id,
        projectId: "p-encoded-actuals",
        kind: "task" as const,
        title: `Encoded ${index}`,
        outline: String(index + 1),
        durationSeconds: 600,
        estimate: { mostLikelySeconds: 600 },
        assignmentIds: [],
        percentComplete: 0,
      })),
    );
    source.actuals.push(
      ...workItemIds.map((workItemId) => ({
        workItemId,
        actualWorkSeconds: 60,
        remainingWorkSeconds: 540,
        actualCost: 0,
        recordedAt: "2026-07-01T01:02:03.000Z",
      })),
    );

    const { workspace } = migrateV1Workspace(source, options);
    const actualIds = workspace.actuals.map(({ id }) => id);
    expect(actualIds).toEqual([
      "migration:actual:work%3Aitem%2Bone:2026-07-01T01%3A02%3A03.000Z:0",
      "migration:actual:work%253Aitem%252Bone:2026-07-01T01%3A02%3A03.000Z:1",
    ]);
    expect(new Set(actualIds).size).toBe(2);
  });

  it("prefills the six Direction decisions without treating advanced notes as completeness", () => {
    const shapeSource = fixtures["shape-up-bet"].snapshot;
    const { workspace } = migrateV1Workspace(shapeSource, options);
    const sourceProject = shapeSource.projects[0];
    const sourcePitch = sourceProject.shapeUpPitch!;
    const brief = workspace.directionBriefs[0];

    expect(brief).toMatchObject({
      id: "migration:direction:p-shape-up",
      projectId: "p-shape-up",
      version: 1,
      audienceAndProblem:
        "Audience: Operations leads\nProblem: Weekly reports hide delivery risk.",
      successEvidence:
        "Success metric: Three teams act on the same risk signal.\nLegacy Shape Up baseline: Three consecutive reports are reviewed before planning.",
      appetiteSeconds: 288000,
      validationMethod: "Observe three weekly planning sessions.",
      firstScope: sourcePitch.scopes.map(({ id, title, description }) => ({
        id,
        title,
        description,
      })),
      noGoOrKill:
        "No-go: No forecasting engine and no custom workflow builder.\nKill condition: Teams keep separate shadow reports.",
      createdAt: sourcePitch.createdAt,
      updatedAt: sourcePitch.updatedAt,
    });
    expect(brief.advancedNotes).toContain(sourceProject.northStar);
    expect(brief.advancedNotes).toContain(sourcePitch.problem);
    expect(brief.advancedNotes).toContain(sourcePitch.solutionSketch);

    expect(workspace.projects[0]).toMatchObject({
      stage: "awaiting_bet",
      activeDirectionBriefId: brief.id,
      holds: [
        {
          type: "migration_review",
          sourceId: options.backupId,
          affectedRecordIds: ["p-shape-up", brief.id],
          createdAt: NOW,
        },
      ],
    });

    const currentSample = migrateV1Workspace(
      fixtures["current-sample"].snapshot,
      options,
    ).workspace;
    expect(currentSample.projects.map(({ stage }) => stage)).toEqual([
      "direction",
      "direction",
      "direction",
    ]);
    expect(currentSample.directionBriefs[0].firstScope).toEqual([]);
    expect(currentSample.directionBriefs[2]).toMatchObject({
      audienceAndProblem: "",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [],
      noGoOrKill: "",
    });
  });

  it("adds migration_review only to active, waiting, and paused Projects and never creates a Bet", () => {
    const { workspace } = migrateV1Workspace(
      fixtures["active-incomplete"].snapshot,
      options,
    );

    expect(workspace.projects.map(({ id, stage, holds }) => ({ id, stage, holds }))).toEqual(
      workspace.projects.map((project) => ({
        id: project.id,
        stage: "direction",
        holds: [
          {
            type: "migration_review",
            sourceId: options.backupId,
            affectedRecordIds: [project.id, project.activeDirectionBriefId],
            createdAt: NOW,
          },
        ],
      })),
    );
    expect(workspace.bets).toEqual([]);
    expect(workspace.planVersions).toEqual([]);
  });

  it("preserves the complete legacy Shape Up Pitch, scopes, Bet, and cycle only as immutable history", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const { workspace } = migrateV1Workspace(source, options);
    const pitchRecord = auditById(
      workspace,
      "migration:shape-up-pitch:p-shape-up",
    );

    expect(pitchRecord).toEqual({
      id: "migration:shape-up-pitch:p-shape-up",
      projectId: "p-shape-up",
      recordType: "shape_up_pitch",
      sourcePayload: source.projects[0].shapeUpPitch,
      sourceChecksum: options.sourceChecksum,
    });
    expect(workspace.directionBriefs[0].firstScope).toEqual(
      source.projects[0].shapeUpPitch!.scopes.map(
        ({ id, title, description }) => ({ id, title, description }),
      ),
    );
    expect(workspace.workItems.map(({ id, betScopeId }) => ({ id, betScopeId }))).toEqual([
      { id: "w-shape-core", betScopeId: "scope-report-core" },
      { id: "w-shape-export", betScopeId: "scope-report-export" },
    ]);
    expect(workspace.workItems[0]).not.toHaveProperty("shapeUpScopeId");
    expect(workspace.workItems[0]).not.toHaveProperty("isShapeUpCycleMarker");
    expect(workspace.bets).toEqual([]);
    expect(workspace.closeDecisions).toEqual([]);
  });

  it("converts every Decision, AuditDecision, AuditGate, and ChangeSet with its original ID and payload", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const { workspace } = migrateV1Workspace(source, options);
    const cases = [
      [source.decisions[0], "decision"],
      [source.auditDecisions[0], "audit_decision"],
      [source.auditGates[0], "audit_gate"],
      [source.changeSets[0], "change_set"],
    ] as const;

    for (const [sourceRecord, recordType] of cases) {
      expect(auditById(workspace, sourceRecord.id)).toEqual({
        id: sourceRecord.id,
        projectId: sourceRecord.projectId,
        recordType,
        sourcePayload: sourceRecord,
        sourceChecksum: options.sourceChecksum,
      });
    }
  });

  it("maps explicit done and archived Projects to closed provenance without a V2 Bet, human, or CloseDecision", () => {
    const source = fixtures["completed-archived"].snapshot;
    const { workspace } = migrateV1Workspace(source, options);

    expect(workspace.projects.map(({ id, stage, holds, legacyClosure }) => ({
      id,
      stage,
      holds,
      legacyClosure,
    }))).toEqual([
      {
        id: "p-completed",
        stage: "closed",
        holds: [],
        legacyClosure: {
          sourceStatus: "done",
          legacyRecordId: "migration:legacy-closure:p-completed",
          sourceChecksum: options.sourceChecksum,
        },
      },
      {
        id: "p-completed-archived",
        stage: "closed",
        holds: [],
        legacyClosure: {
          sourceStatus: "archived",
          legacyRecordId: "migration:legacy-closure:p-completed-archived",
          sourceChecksum: options.sourceChecksum,
        },
      },
    ]);
    for (const project of source.projects) {
      const sourceStatus = project.archived === true ? "archived" : "done";
      expect(
        auditById(workspace, `migration:legacy-closure:${project.id}`),
      ).toEqual({
        id: `migration:legacy-closure:${project.id}`,
        projectId: project.id,
        recordType: "legacy_closure",
        sourcePayload: {
          projectId: project.id,
          sourceStatus,
          project,
        },
        sourceChecksum: options.sourceChecksum,
      });
    }
    expect(workspace.visibility.archivedProjectIds).toEqual([
      "p-completed-archived",
    ]);
    expect(workspace.bets).toEqual([]);
    expect(workspace.closeDecisions).toEqual([]);
    expect(workspace.projects.every(({ activeBetId }) => activeBetId === undefined)).toBe(true);
  });

  it("preserves raw legacy archived status as closure provenance and visibility", () => {
    const source = fixtures["legacy-archived-status"].snapshot;
    const { workspace } = migrateV1Workspace(source, options);

    expect(workspace.projects[0]).toMatchObject({
      id: "p-legacy-archived-status",
      stage: "closed",
      legacyClosure: {
        sourceStatus: "archived",
        sourceChecksum: options.sourceChecksum,
      },
    });
    expect(workspace.visibility.archivedProjectIds).toEqual([
      "p-legacy-archived-status",
    ]);
  });

  it("sanitizes malformed optional values without dropping required records", () => {
    const { workspace } = migrateV1Workspace(
      fixtures["malformed-optional-fields"].snapshot,
      options,
    );

    expect(workspace.projects).toHaveLength(1);
    expect(workspace.projects[0].stage).toBe("direction");
    expect(workspace.directionBriefs[0]).toMatchObject({
      audienceAndProblem:
        "Problem: The optional export fields were corrupted.",
      successEvidence: "",
      appetiteSeconds: 0,
      validationMethod: "",
      firstScope: [
        {
          id: "scope-valid-malformed",
          title: "Still valid",
          description: "",
        },
      ],
      noGoOrKill: "",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: NOW,
    });
    expect(workspace.workItems[0]).not.toHaveProperty("parentId");
    expect(workspace.workItems[0]).not.toHaveProperty("constraint");
    expect(workspace.workItems[0]).not.toHaveProperty("splitSegments");
    expect(workspace.workItems[0]).not.toHaveProperty("repeatRule");
    expect(workspace.actuals[0]).not.toHaveProperty("actualStart");
    expect(workspace.actuals[0]).not.toHaveProperty("actualFinish");
    expect(workspace.evidence[0]).not.toHaveProperty("url");
    expect(workspace.evidence[0]).not.toHaveProperty("localFileRef");
    expect(workspace.evidence[0]).not.toHaveProperty("workItemId");
    expect(workspace.baselines).toHaveLength(1);
    expect(workspace.baselines[0].id).toBe("b-malformed-optionals");
    expect(workspace.baselines[0]).not.toHaveProperty("approvedByDecisionId");
  });

  it("is deterministic and idempotent for the same source checksum", async () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const first = migrateV1Workspace(source, options);
    const second = migrateV1Workspace(structuredClone(source), {
      ...options,
      actorId: "another-migration-operator",
    });

    expect(second.migration).toEqual(first.migration);
    expect(second.workspace).toEqual(first.workspace);
    expect(second.workspace.projects).toHaveLength(source.projects.length);
    expect(new Set(second.workspace.legacyAuditRecords.map(({ id }) => id)).size).toBe(
      second.workspace.legacyAuditRecords.length,
    );
    expect(
      await stableHash(second.workspace as unknown as JsonValue),
    ).toBe(await stableHash(first.workspace as unknown as JsonValue));
  });

  it("rejects malformed required source references before constructing V2", () => {
    const source = structuredClone(fixtures["current-sample"].snapshot);
    source.workItems[0].projectId = "missing-project";

    expect(() => migrateV1Workspace(source, options)).toThrowError(
      MigrationSourceError,
    );
    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Work Item w-core references missing Project missing-project/,
    );
  });

  it.each(v1FixtureNames)("passes migration-specific validation for %s", (name) => {
    const source = fixtures[name].snapshot;
    const candidate = migrateV1Workspace(source, options);

    expect(
      validateMigratedWorkspace(
        source,
        candidate.workspace,
        candidate.migration,
        validationExpectations,
      ),
    ).toEqual([]);
  });

  it.each(v1FixtureNames)(
    "%s produces a strict export-safe schema-2 Workspace",
    async (name) => {
      const source = fixtures[name].snapshot;
      const candidate = migrateV1Workspace(source, options);

      expect(
        validateMigratedWorkspace(
          source,
          candidate.workspace,
          candidate.migration,
          validationExpectations,
        ),
      ).toEqual([]);
      await expect(
        buildWorkspaceBackupV2({
          snapshot: {
            workspace: candidate.workspace,
            rejectedReceipts: [],
          },
          exportedAt: NOW,
        }),
      ).resolves.toMatchObject({ schemaVersion: 2 });
    },
  );
});

describe("migration source reference validation", () => {
  type SourceReferenceCase = {
    name: string;
    fixture: V1FixtureName;
    expected: string;
    mutate: (source: WorkspaceSnapshot) => void;
  };

  const sourceReferenceCases: SourceReferenceCase[] = [
    {
      name: "Work Item parent",
      fixture: "current-sample",
      expected: "Work Item w-domain references missing parent Work Item missing-parent.",
      mutate: (source) => {
        source.workItems.find(({ id }) => id === "w-domain")!.parentId =
          "missing-parent";
      },
    },
    {
      name: "Work Item Resource assignment",
      fixture: "current-sample",
      expected: "Work Item w-domain references missing Resource missing-resource.",
      mutate: (source) => {
        source.workItems.find(({ id }) => id === "w-domain")!.assignmentIds[0].resourceId =
          "missing-resource";
      },
    },
    {
      name: "Work Item Shape Up scope",
      fixture: "shape-up-bet",
      expected: "Work Item w-shape-core references missing Shape Up scope missing-scope.",
      mutate: (source) => {
        source.workItems[0].shapeUpScopeId = "missing-scope";
      },
    },
    {
      name: "Dependency Project",
      fixture: "current-sample",
      expected: "Dependency d-domain-scheduler references missing Project missing-project.",
      mutate: (source) => {
        source.dependencies[0].projectId = "missing-project";
      },
    },
    {
      name: "Dependency endpoint",
      fixture: "current-sample",
      expected: "Dependency d-domain-scheduler references missing from Work Item missing-work.",
      mutate: (source) => {
        source.dependencies[0].fromId = "missing-work";
      },
    },
    {
      name: "Baseline Project",
      fixture: "current-sample",
      expected: "Baseline b-initial references missing Project missing-project.",
      mutate: (source) => {
        source.baselines[0].projectId = "missing-project";
      },
    },
    {
      name: "Baseline planned Work Item",
      fixture: "current-sample",
      expected: "Baseline b-initial references missing planned Work Item missing-work.",
      mutate: (source) => {
        source.baselines[0].plannedWorkSecondsByItem["missing-work"] = 1;
      },
    },
    {
      name: "Baseline approval",
      fixture: "shape-up-bet",
      expected: "Baseline b-shape-up references missing approval Decision missing-decision.",
      mutate: (source) => {
        source.baselines[0].approvedByDecisionId = "missing-decision";
      },
    },
    {
      name: "Actual Work Item",
      fixture: "current-sample",
      expected: "Actual at source index 0 references missing Work Item missing-work.",
      mutate: (source) => {
        source.actuals[0].workItemId = "missing-work";
      },
    },
    {
      name: "Evidence Project",
      fixture: "current-sample",
      expected: "Evidence e-domain references missing Project missing-project.",
      mutate: (source) => {
        source.evidence[0].projectId = "missing-project";
      },
    },
    {
      name: "Evidence Work Item",
      fixture: "current-sample",
      expected: "Evidence e-domain references missing Work Item missing-work.",
      mutate: (source) => {
        source.evidence[0].workItemId = "missing-work";
      },
    },
    {
      name: "Decision Project",
      fixture: "shape-up-bet",
      expected: "Decision decision-shape-up references missing Project missing-project.",
      mutate: (source) => {
        source.decisions[0].projectId = "missing-project";
      },
    },
    {
      name: "Decision Evidence",
      fixture: "shape-up-bet",
      expected: "Decision decision-shape-up references missing Evidence missing-evidence.",
      mutate: (source) => {
        source.decisions[0].linkedEvidenceIds = ["missing-evidence"];
      },
    },
    {
      name: "ChangeSet Project",
      fixture: "shape-up-bet",
      expected: "ChangeSet cs-shape-up references missing Project missing-project.",
      mutate: (source) => {
        source.changeSets[0].projectId = "missing-project";
      },
    },
    {
      name: "ChangeSet Audit Gate",
      fixture: "shape-up-bet",
      expected: "ChangeSet cs-shape-up references missing Audit Gate missing-gate.",
      mutate: (source) => {
        source.changeSets[0].auditGateIds = ["missing-gate"];
      },
    },
    {
      name: "Audit Gate Project",
      fixture: "shape-up-bet",
      expected: "Audit Gate gate-shape-up references missing Project missing-project.",
      mutate: (source) => {
        source.auditGates[0].projectId = "missing-project";
      },
    },
    {
      name: "Audit Gate target",
      fixture: "shape-up-bet",
      expected: "Audit Gate gate-shape-up references missing same-project scope target missing-target.",
      mutate: (source) => {
        source.auditGates[0].targetId = "missing-target";
      },
    },
    {
      name: "Audit Decision Project",
      fixture: "shape-up-bet",
      expected: "Audit Decision ad-shape-up references missing Project missing-project.",
      mutate: (source) => {
        source.auditDecisions[0].projectId = "missing-project";
      },
    },
    {
      name: "Audit Decision source Gate",
      fixture: "shape-up-bet",
      expected: "Audit Decision ad-shape-up references missing Audit Gate missing-gate.",
      mutate: (source) => {
        source.auditDecisions[0].sourceGateIds = ["missing-gate"];
      },
    },
  ];

  it.each(sourceReferenceCases)("rejects malformed required $name", ({
    fixture,
    expected,
    mutate,
  }) => {
    const source = structuredClone(fixtures[fixture].snapshot);
    mutate(source);

    try {
      migrateV1Workspace(source, options);
      expect.fail("migration unexpectedly accepted malformed references");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationSourceError);
      expect((error as MigrationSourceError).issues).toContain(expected);
    }
  });

  it("rejects duplicate IDs before deterministic mapping", () => {
    const source = structuredClone(fixtures["current-sample"].snapshot);
    source.projects.push(structuredClone(source.projects[0]));

    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Duplicate Project ID p-omni/,
    );
  });

  it("rejects duplicate Shape Up scope IDs within one Project", () => {
    const source = structuredClone(fixtures["shape-up-bet"].snapshot);
    source.projects[0].shapeUpPitch!.scopes[1].id =
      source.projects[0].shapeUpPitch!.scopes[0].id;
    source.workItems[1].shapeUpScopeId =
      source.projects[0].shapeUpPitch!.scopes[0].id;

    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Duplicate Shape Up scope ID scope-report-core in Project p-shape-up/,
    );
  });

  it("rejects a legacy scope ID colliding with the generated unscoped migration scope", () => {
    const source = structuredClone(fixtures["shape-up-bet"].snapshot);
    const collision = "migration:unscoped:p-shape-up";
    source.projects[0].shapeUpPitch!.scopes[0].id = collision;
    source.workItems[0].shapeUpScopeId = collision;

    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Shape Up scope ID migration:unscoped:p-shape-up collides with generated unscoped migration scope for Project p-shape-up/,
    );
  });

  it("rejects a Shape Up Bet that references another project's AuditDecision", () => {
    const source = structuredClone(fixtures["shape-up-bet"].snapshot);
    const otherProject = structuredClone(source.projects[0]);
    otherProject.id = "p-other";
    otherProject.name = "Other project";
    delete otherProject.shapeUpPitch;
    source.projects.push(otherProject);
    source.auditDecisions[0].projectId = otherProject.id;
    source.auditDecisions[0].sourceGateIds = [];
    delete source.baselines[0].approvedByDecisionId;

    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Shape Up Bet for Project p-shape-up references missing same-project Audit Decision ad-shape-up/,
    );
  });

  it("rejects LegacyAuditRecord ID collisions across V1 audit collections", () => {
    const source = structuredClone(fixtures["shape-up-bet"].snapshot);
    source.auditGates[0].id = source.decisions[0].id;
    source.changeSets[0].auditGateIds = [source.decisions[0].id];
    source.auditDecisions[0].sourceGateIds = [source.decisions[0].id];

    expect(() => migrateV1Workspace(source, options)).toThrow(
      /Duplicate LegacyAuditRecord ID decision-shape-up/,
    );
  });

  it.each([
    ["shape-up", "shape-up-bet", "migration:shape-up-pitch:p-shape-up"],
    ["closure", "completed-archived", "migration:legacy-closure:p-completed"],
  ] as const)(
    "rejects a source LegacyAuditRecord ID colliding with generated %s history",
    (_kind, fixture, generatedId) => {
      const source = structuredClone(fixtures[fixture].snapshot);
      source.decisions[0].id = generatedId;
      if (fixture === "shape-up-bet") {
        source.baselines[0].approvedByDecisionId = generatedId;
      }

      expect(() => migrateV1Workspace(source, options)).toThrow(
        new RegExp(`LegacyAuditRecord ID ${generatedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} collides with generated`),
      );
    },
  );
});

describe("validateMigratedWorkspace tamper resistance", () => {
  function validated(
    source: WorkspaceSnapshot,
    workspace: WorkspaceV2,
    migration = workspace.migration!,
    expectations = validationExpectations,
  ) {
    return validateMigratedWorkspace(
      source,
      workspace,
      migration,
      expectations,
    );
  }

  function expectViolation(
    violations: ReturnType<typeof validateMigratedWorkspace>,
    code: string,
    path: string,
  ): void {
    expect(violations).toContainEqual(
      expect.objectContaining({ code, path }),
    );
  }

  it("requires the external and embedded MigrationRecord to match the exact source checksum and manifest", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    const migration = structuredClone(candidate.migration);
    migration.sourceChecksum = "tampered-source-checksum";
    migration.entityCounts.projects = 999;

    const violations = validated(source, candidate.workspace, migration);
    expectViolation(
      violations,
      "SOURCE_CHECKSUM_MISMATCH",
      "migration.sourceChecksum",
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "migration.entityCounts",
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "workspace.migration",
    );
  });

  it("rejects a source checksum rewritten consistently in both external and embedded candidate records", () => {
    const source = fixtures.empty.snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.migration.sourceChecksum = "jointly-tampered-checksum";
    candidate.workspace.migration!.sourceChecksum = "jointly-tampered-checksum";

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "SOURCE_CHECKSUM_MISMATCH",
      "migration.sourceChecksum",
    );
  });

  it("rejects candidate-controlled workspace identity and a consistently rewritten backup tuple", () => {
    const source = fixtures.empty.snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.workspaceId = "candidate-workspace";
    candidate.migration.backupChecksum = "candidate-backup-checksum";
    candidate.migration.backupId = "v1-backup-candidate-backup-checksum";
    candidate.workspace.migration = structuredClone(candidate.migration);

    const violations = validated(
      source,
      candidate.workspace,
      candidate.migration,
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "workspace.workspaceId",
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "migration.backupId",
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "migration.backupChecksum",
    );
  });

  it.each([
    ["migratedAt", "migration.migratedAt", (migration: MigrationRecord) => {
      migration.migratedAt = "2026-07-11T00:00:00.000Z";
    }],
    ["backupId", "migration.backupId", (migration: MigrationRecord) => {
      migration.backupId = "v1-backup-wrong";
    }],
    ["backupChecksum", "migration.backupChecksum", (migration: MigrationRecord) => {
      migration.backupChecksum = "wrong-backup-checksum";
    }],
    ["sourceSchemaVersion", "migration.sourceSchemaVersion", (migration: MigrationRecord) => {
      (migration as { sourceSchemaVersion: number }).sourceSchemaVersion = 2;
    }],
  ] as const)("rejects a tampered MigrationRecord %s", (_name, path, mutate) => {
    const source = fixtures["empty"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    const migration = structuredClone(candidate.migration);
    mutate(migration);

    expectViolation(
      validated(source, candidate.workspace, migration),
      "MIGRATION_RECORD_MISMATCH",
      path,
    );
  });

  it.each([
    ["source status", (workspace: WorkspaceV2) => {
      workspace.projects[0].legacyClosure!.sourceStatus = "archived";
    }],
    ["source checksum", (workspace: WorkspaceV2) => {
      workspace.projects[0].legacyClosure!.sourceChecksum = "wrong";
    }],
    ["legacy record ID", (workspace: WorkspaceV2) => {
      workspace.projects[0].legacyClosure!.legacyRecordId = "wrong-record";
    }],
    ["legacy record project", (workspace: WorkspaceV2) => {
      auditById(workspace, "migration:legacy-closure:p-completed").projectId =
        "p-completed-archived";
    }],
    ["legacy record type", (workspace: WorkspaceV2) => {
      auditById(workspace, "migration:legacy-closure:p-completed").recordType =
        "shape_up_pitch";
    }],
    ["legacy record checksum", (workspace: WorkspaceV2) => {
      auditById(workspace, "migration:legacy-closure:p-completed").sourceChecksum =
        "wrong";
    }],
    ["legacy payload project ID", (workspace: WorkspaceV2) => {
      const record = auditById(workspace, "migration:legacy-closure:p-completed");
      record.sourcePayload = {
        ...(record.sourcePayload as Record<string, JsonValue>),
        projectId: "p-completed-archived",
      };
    }],
    ["legacy payload status", (workspace: WorkspaceV2) => {
      const record = auditById(workspace, "migration:legacy-closure:p-completed");
      record.sourcePayload = {
        ...(record.sourcePayload as Record<string, JsonValue>),
        sourceStatus: "archived",
      };
    }],
    ["legacy payload Project", (workspace: WorkspaceV2) => {
      const record = auditById(workspace, "migration:legacy-closure:p-completed");
      const payload = record.sourcePayload as Record<string, JsonValue>;
      record.sourcePayload = {
        ...payload,
        project: {
          ...(payload.project as Record<string, JsonValue>),
          name: "Rewritten history",
        },
      };
    }],
  ] as const)("rejects a legacyClosure with a mismatched %s", (_name, mutate) => {
    const source = fixtures["completed-archived"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    mutate(candidate.workspace);

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "INVALID_LEGACY_CLOSURE",
      "projects.p-completed.legacyClosure",
    );
  });

  it("rejects a missing closure and a fabricated closure for a source Project that was not done/archived", () => {
    const closedSource = fixtures["completed-archived"].snapshot;
    const closed = migrateV1Workspace(closedSource, options);
    delete closed.workspace.projects[0].legacyClosure;

    expectViolation(
      validated(closedSource, closed.workspace, closed.migration),
      "INVALID_LEGACY_CLOSURE",
      "projects.p-completed.legacyClosure",
    );

    const activeSource = fixtures["current-sample"].snapshot;
    const active = migrateV1Workspace(activeSource, options);
    active.workspace.projects[0].stage = "closed";
    active.workspace.projects[0].legacyClosure = {
      sourceStatus: "done",
      sourceChecksum: options.sourceChecksum,
      legacyRecordId: "migration:legacy-closure:p-omni",
    };

    expectViolation(
      validated(activeSource, active.workspace, active.migration),
      "INVALID_LEGACY_CLOSURE",
      "projects.p-omni.legacyClosure",
    );
  });

  it("rejects any V2 Bet or CloseDecision fabricated by migration", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    const brief = candidate.workspace.directionBriefs[0];
    candidate.workspace.bets.push({
      id: "fabricated-bet",
      projectId: "p-shape-up",
      version: 1,
      briefId: brief.id,
      briefHash: "fabricated",
      briefSnapshot: structuredClone(brief),
      committedScope: structuredClone(brief.firstScope),
      appetiteStart: NOW,
      appetiteEnd: "2026-07-13T00:00:00.000Z",
      actorId: options.actorId,
      approvedAt: NOW,
    });
    candidate.workspace.closeDecisions.push({
      id: "fabricated-close",
      projectId: "p-shape-up",
      successComparison: "Fabricated",
      outcome: "achieved",
      keyLearning: "Fabricated",
      unfinishedDisposition: "discard",
      actorId: options.actorId,
      closedAt: NOW,
    });

    const violations = validated(source, candidate.workspace, candidate.migration);
    expectViolation(
      violations,
      "UNAUTHORIZED_V2_AUTHORITY",
      "workspace.bets",
    );
    expectViolation(
      violations,
      "UNAUTHORIZED_V2_AUTHORITY",
      "workspace.closeDecisions",
    );
  });

  it.each([
    "inboxItems",
    "actions",
    "planVersions",
    "dailyCommitments",
    "replanProposals",
    "reviews",
    "exceptions",
    "commandProposals",
    "syncConflicts",
    "commandReceipts",
  ] as const)("rejects migration-fabricated V2 %s", (collection) => {
    const source = fixtures["empty"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    (candidate.workspace[collection] as unknown[]).push({});

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "UNAUTHORIZED_V2_AUTHORITY",
      `workspace.${collection}`,
    );
  });

  it("rejects a fabricated CapacityProfile and nonzero migrated revision", () => {
    const source = fixtures["empty"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.revision = 1;
    candidate.workspace.capacityProfile = {
      timeZone: "UTC",
      weeklyWindows: [],
      dailyBudgets: [],
      unavailableBlocks: [],
      updatedAt: NOW,
      updatedBy: options.actorId,
    };

    const violations = validated(source, candidate.workspace, candidate.migration);
    expectViolation(
      violations,
      "UNAUTHORIZED_V2_AUTHORITY",
      "workspace.capacityProfile",
    );
    expectViolation(
      violations,
      "MIGRATION_RECORD_MISMATCH",
      "workspace.revision",
    );
  });

  it.each([
    ["missing", (workspace: WorkspaceV2) => {
      workspace.projects[0].holds = [];
    }],
    ["wrong source", (workspace: WorkspaceV2) => {
      workspace.projects[0].holds[0].sourceId = "wrong-backup";
    }],
    ["wrong affected IDs", (workspace: WorkspaceV2) => {
      workspace.projects[0].holds[0].affectedRecordIds = [
        workspace.projects[0].id,
      ];
    }],
    ["extra hold", (workspace: WorkspaceV2) => {
      workspace.projects[0].holds.push(structuredClone(workspace.projects[0].holds[0]));
    }],
  ] as const)("rejects %s migration_review semantics", (_name, mutate) => {
    const source = fixtures["active-incomplete"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    mutate(candidate.workspace);

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "INVALID_MIGRATION_HOLD",
      "projects.p-active-incomplete.holds",
    );
  });

  it("rejects preserved entity loss or value rewriting", () => {
    const source = fixtures["active-incomplete"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.resources[0].hourlyRate = 999;
    candidate.workspace.capacities.pop();
    candidate.workspace.workItems.pop();

    const violations = validated(source, candidate.workspace, candidate.migration);
    expectViolation(
      violations,
      "ENTITY_PRESERVATION_FAILED",
      "workspace.resources",
    );
    expectViolation(
      violations,
      "ENTITY_PRESERVATION_FAILED",
      "workspace.capacities",
    );
    expectViolation(
      violations,
      "ENTITY_PRESERVATION_FAILED",
      "workspace.workItems",
    );
  });

  it.each([
    ["Project stage", "workspace.projects", (workspace: WorkspaceV2) => {
      workspace.projects[0].stage = "awaiting_bet";
    }],
    ["Direction Brief", "workspace.directionBriefs", (workspace: WorkspaceV2) => {
      workspace.directionBriefs[0].successEvidence = "Rewritten";
    }],
    ["visibility", "workspace.visibility", (workspace: WorkspaceV2) => {
      workspace.visibility.archivedProjectIds = [];
    }],
    ["Actual derivation", "workspace.actuals", (workspace: WorkspaceV2) => {
      workspace.actuals[0].id = "rewritten-actual-id";
    }],
    ["Dependency", "workspace.dependencies", (workspace: WorkspaceV2) => {
      workspace.dependencies[0].lagSeconds += 1;
    }],
    ["Baseline", "workspace.baselines", (workspace: WorkspaceV2) => {
      workspace.baselines[0].name = "Rewritten";
    }],
    ["Evidence", "workspace.evidence", (workspace: WorkspaceV2) => {
      workspace.evidence[0].summary = "Rewritten";
    }],
  ] as const)("rejects rewritten canonical %s mapping", (_name, path, mutate) => {
    const fixture =
      path === "workspace.visibility"
        ? "completed-archived"
        : path === "workspace.dependencies" || path === "workspace.baselines"
          ? "shape-up-bet"
          : "current-sample";
    const source = fixtures[fixture].snapshot;
    const candidate = migrateV1Workspace(source, options);
    mutate(candidate.workspace);

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "ENTITY_PRESERVATION_FAILED",
      path,
    );
  });

  it("rejects missing or rewritten immutable legacy audit payloads", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.legacyAuditRecords = candidate.workspace.legacyAuditRecords.filter(
      ({ id }) => id !== "decision-shape-up",
    );
    auditById(candidate.workspace, "gate-shape-up").sourcePayload = {
      rewritten: true,
    };

    const violations = validated(source, candidate.workspace, candidate.migration);
    expectViolation(
      violations,
      "ENTITY_PRESERVATION_FAILED",
      "workspace.legacyAuditRecords.decision-shape-up",
    );
    expectViolation(
      violations,
      "ENTITY_PRESERVATION_FAILED",
      "workspace.legacyAuditRecords.gate-shape-up",
    );
  });

  it("merges non-migration Workspace invariant violations", () => {
    const source = fixtures["active-incomplete"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.projects[0].activeDirectionBriefId = "missing-brief";

    expectViolation(
      validated(source, candidate.workspace, candidate.migration),
      "WORKSPACE_INVARIANT",
      "reference:ProjectV2:p-active-incomplete:activeDirectionBriefId",
    );
  });

  it("accepts the normalized form of raw legacy archived status", () => {
    const raw = structuredClone(fixtures["legacy-archived-status"].snapshot);
    raw.projects[0] = {
      ...raw.projects[0],
      status: "done",
      archived: true,
    };
    const candidate = migrateV1Workspace(raw, options);

    expect(validated(raw, candidate.workspace, candidate.migration)).toEqual([]);
    expect(candidate.workspace.projects[0].legacyClosure?.sourceStatus).toBe(
      "archived",
    );
  });

  it("returns violations in deterministic code/path/message order", () => {
    const source = fixtures["shape-up-bet"].snapshot;
    const candidate = migrateV1Workspace(source, options);
    candidate.workspace.bets.push({} as WorkspaceV2["bets"][number]);
    candidate.workspace.resources = [];

    const first = validated(source, candidate.workspace, candidate.migration);
    const second = validated(source, candidate.workspace, candidate.migration);
    expect(first).toEqual(second);
    expect(first).toEqual(
      [...first].sort(
        (left, right) =>
          left.code.localeCompare(right.code) ||
          left.path.localeCompare(right.path) ||
          left.message.localeCompare(right.message),
      ),
    );
  });
});
