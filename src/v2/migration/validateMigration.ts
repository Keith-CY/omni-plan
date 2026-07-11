import type { ISODate, Id, WorkspaceSnapshot } from "@/domain/types";
import { validateWorkspaceInvariants } from "@/v2/domain/invariants";
import type {
  LegacyAuditRecord,
  MigrationRecord,
  WorkspaceV2,
} from "@/v2/domain/types";

import {
  MigrationSourceError,
  migrateV1Workspace,
  type MigrationOptions,
} from "./migrateV1";

export type MigrationViolationCode =
  | "SOURCE_CHECKSUM_MISMATCH"
  | "MIGRATION_RECORD_MISMATCH"
  | "ENTITY_PRESERVATION_FAILED"
  | "INVALID_REFERENCE"
  | "INVALID_MIGRATION_HOLD"
  | "INVALID_LEGACY_CLOSURE"
  | "UNAUTHORIZED_V2_AUTHORITY"
  | "WORKSPACE_INVARIANT";

export interface MigrationViolation {
  code: MigrationViolationCode;
  path: string;
  message: string;
}

export interface MigrationValidationExpectations {
  sourceChecksum: string;
  workspaceId: Id;
  backupId: Id;
  backupChecksum: string;
  migratedAt: ISODate;
  now: ISODate;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function sourceCounts(source: WorkspaceSnapshot): Record<string, number> {
  return {
    projects: source.projects.length,
    workItems: source.workItems.length,
    dependencies: source.dependencies.length,
    resources: source.resources.length,
    capacities: source.capacities.length,
    baselines: source.baselines.length,
    actuals: source.actuals.length,
    evidence: source.evidence.length,
    decisions: source.decisions.length,
    changeSets: source.changeSets.length,
    auditGates: source.auditGates.length,
    auditDecisions: source.auditDecisions.length,
  };
}

function indexLegacyRecords(
  records: readonly LegacyAuditRecord[],
): Map<string, LegacyAuditRecord[]> {
  const result = new Map<string, LegacyAuditRecord[]>();
  for (const record of records) {
    const matches = result.get(record.id) ?? [];
    matches.push(record);
    result.set(record.id, matches);
  }
  return result;
}

export function validateMigratedWorkspace(
  sourceInput: WorkspaceSnapshot,
  workspaceInput: WorkspaceV2,
  migrationInput: MigrationRecord,
  expectationsInput: MigrationValidationExpectations,
): MigrationViolation[] {
  const source = structuredClone(sourceInput);
  const workspace = structuredClone(workspaceInput);
  const migration = structuredClone(migrationInput);
  const expectations = structuredClone(expectationsInput);
  const violations = new Map<string, MigrationViolation>();

  function add(
    code: MigrationViolationCode,
    path: string,
    message: string,
  ): void {
    const key = `${code}\u0000${path}\u0000${message}`;
    if (!violations.has(key)) {
      violations.set(key, { code, path, message });
    }
  }

  if (
    migration.sourceChecksum !== expectations.sourceChecksum ||
    workspace.migration?.sourceChecksum !== expectations.sourceChecksum
  ) {
    add(
      "SOURCE_CHECKSUM_MISMATCH",
      "migration.sourceChecksum",
      "The candidate and embedded MigrationRecord source checksums must match the trusted normalized V1 source checksum.",
    );
  }
  if (
    migration.migratedAt !== expectations.migratedAt ||
    workspace.migration?.migratedAt !== expectations.migratedAt
  ) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "migration.migratedAt",
      "MigrationRecord migratedAt must equal the validated migration time and embedded Workspace record.",
    );
  }
  if (
    migration.backupId !== expectations.backupId ||
    workspace.migration?.backupId !== expectations.backupId ||
    expectations.backupId !== `v1-backup-${expectations.backupChecksum}`
  ) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "migration.backupId",
      "MigrationRecord backupId must be derived from its verified backup checksum and match the embedded Workspace record.",
    );
  }
  if (
    migration.backupChecksum !== expectations.backupChecksum ||
    workspace.migration?.backupChecksum !== expectations.backupChecksum
  ) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "migration.backupChecksum",
      "MigrationRecord backupChecksum must match the embedded verified-backup checksum.",
    );
  }
  if (migration.sourceSchemaVersion !== 1) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "migration.sourceSchemaVersion",
      "MigrationRecord must identify V1 as source schema version 1.",
    );
  }
  if (!sameValue(migration.entityCounts, sourceCounts(source))) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "migration.entityCounts",
      "MigrationRecord entityCounts must exactly match the twelve V1 source collection counts.",
    );
  }
  if (!sameValue(workspace.migration, migration)) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "workspace.migration",
      "The embedded Workspace MigrationRecord must exactly match the record being committed.",
    );
  }
  if (workspace.schemaVersion !== 2) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "workspace.schemaVersion",
      "A migrated Workspace must use schema version 2.",
    );
  }
  if (workspace.workspaceId !== expectations.workspaceId) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "workspace.workspaceId",
      "The migrated Workspace ID must match the trusted migration target.",
    );
  }
  if (workspace.revision !== 0) {
    add(
      "MIGRATION_RECORD_MISMATCH",
      "workspace.revision",
      "Migration direct construction must start at Workspace revision 0.",
    );
  }

  const expectedOptions: MigrationOptions = {
    workspaceId: expectations.workspaceId,
    sourceChecksum: expectations.sourceChecksum,
    backupId: expectations.backupId,
    backupChecksum: expectations.backupChecksum,
    actorId: "migration-validator",
    now: expectations.migratedAt,
  };

  let expected: ReturnType<typeof migrateV1Workspace> | undefined;
  try {
    expected = migrateV1Workspace(source, expectedOptions);
  } catch (error) {
    const messages =
      error instanceof MigrationSourceError
        ? error.issues
        : [error instanceof Error ? error.message : String(error)];
    for (const message of messages) {
      add(
        "INVALID_REFERENCE",
        "source",
        `The V1 source cannot be migrated safely: ${message}`,
      );
    }
  }

  if (expected !== undefined) {
    if (!sameValue(migration, expected.migration)) {
      if (!sameValue(migration.deterministicIdMap, expected.migration.deterministicIdMap)) {
        add(
          "MIGRATION_RECORD_MISMATCH",
          "migration.deterministicIdMap",
          "MigrationRecord deterministic IDs do not match the canonical V1 derivations.",
        );
      }
    }

    const forbiddenCollections = [
      "inboxItems",
      "actions",
      "bets",
      "planVersions",
      "dailyCommitments",
      "replanProposals",
      "reviews",
      "exceptions",
      "closeDecisions",
      "commandProposals",
      "syncConflicts",
      "commandReceipts",
    ] as const;
    for (const collection of forbiddenCollections) {
      if (workspace[collection].length > 0) {
        add(
          "UNAUTHORIZED_V2_AUTHORITY",
          `workspace.${collection}`,
          `V1 migration must not fabricate V2 ${collection}.`,
        );
      }
    }
    if (workspace.capacityProfile !== undefined) {
      add(
        "UNAUTHORIZED_V2_AUTHORITY",
        "workspace.capacityProfile",
        "V1 migration must not fabricate a V2 CapacityProfile.",
      );
    }

    const expectedProjectsById = new Map(
      expected.workspace.projects.map((project) => [project.id, project]),
    );
    const candidateProjectsById = new Map(
      workspace.projects.map((project) => [project.id, project]),
    );
    const expectedLegacyById = indexLegacyRecords(
      expected.workspace.legacyAuditRecords,
    );
    const candidateLegacyById = indexLegacyRecords(workspace.legacyAuditRecords);

    for (const sourceProject of source.projects) {
      const expectedProject = expectedProjectsById.get(sourceProject.id);
      const candidateProject = candidateProjectsById.get(sourceProject.id);
      if (expectedProject === undefined || candidateProject === undefined) {
        add(
          "ENTITY_PRESERVATION_FAILED",
          "workspace.projects",
          `Project ${sourceProject.id} was not preserved by migration.`,
        );
        continue;
      }

      if (!sameValue(candidateProject.holds, expectedProject.holds)) {
        add(
          "INVALID_MIGRATION_HOLD",
          `projects.${sourceProject.id}.holds`,
          `Project ${sourceProject.id} does not have the exact canonical migration-review hold state.`,
        );
      }

      const sourceClosed =
        sourceProject.status === "done" || sourceProject.status === "archived";
      const expectedClosure = expectedProject.legacyClosure;
      const candidateClosure = candidateProject.legacyClosure;
      let closureValid =
        sourceClosed &&
        candidateProject.stage === "closed" &&
        expectedClosure !== undefined &&
        sameValue(candidateClosure, expectedClosure);
      if (!sourceClosed) {
        closureValid =
          candidateProject.stage !== "closed" && candidateClosure === undefined;
      }
      if (sourceClosed && expectedClosure !== undefined) {
        const expectedRecords =
          expectedLegacyById.get(expectedClosure.legacyRecordId) ?? [];
        const candidateRecords =
          candidateLegacyById.get(expectedClosure.legacyRecordId) ?? [];
        closureValid =
          closureValid &&
          expectedRecords.length === 1 &&
          candidateRecords.length === 1 &&
          sameValue(candidateRecords[0], expectedRecords[0]);
      }
      if (!closureValid) {
        add(
          "INVALID_LEGACY_CLOSURE",
          `projects.${sourceProject.id}.legacyClosure`,
          `Project ${sourceProject.id} closure provenance does not exactly match its normalized V1 status, source checksum, project payload, and LegacyAuditRecord.`,
        );
      }

      const { holds: _expectedHolds, legacyClosure: _expectedClosure, ...expectedCore } =
        expectedProject;
      const { holds: _candidateHolds, legacyClosure: _candidateClosure, ...candidateCore } =
        candidateProject;
      if (!sameValue(candidateCore, expectedCore)) {
        add(
          "ENTITY_PRESERVATION_FAILED",
          "workspace.projects",
          `Project ${sourceProject.id} does not match the canonical V1 mapping.`,
        );
      }
    }
    if (workspace.projects.length !== expected.workspace.projects.length) {
      add(
        "ENTITY_PRESERVATION_FAILED",
        "workspace.projects",
        "The migrated Project set does not exactly match the V1 Project set.",
      );
    }

    const exactMappedCollections = [
      "directionBriefs",
      "workItems",
      "dependencies",
      "resources",
      "capacities",
      "baselines",
      "evidence",
      "actuals",
    ] as const;
    for (const collection of exactMappedCollections) {
      if (!sameValue(workspace[collection], expected.workspace[collection])) {
        add(
          "ENTITY_PRESERVATION_FAILED",
          `workspace.${collection}`,
          `The migrated ${collection} do not exactly match the canonical V1 mapping.`,
        );
      }
    }
    if (!sameValue(workspace.visibility, expected.workspace.visibility)) {
      add(
        "ENTITY_PRESERVATION_FAILED",
        "workspace.visibility",
        "Archived visibility does not exactly match normalized V1 archive state.",
      );
    }

    for (const [id, expectedRecords] of expectedLegacyById) {
      if (expectedRecords[0]?.recordType === "legacy_closure") {
        continue;
      }
      const candidateRecords = candidateLegacyById.get(id) ?? [];
      if (
        expectedRecords.length !== 1 ||
        candidateRecords.length !== 1 ||
        !sameValue(candidateRecords[0], expectedRecords[0])
      ) {
        add(
          "ENTITY_PRESERVATION_FAILED",
          `workspace.legacyAuditRecords.${id}`,
          `LegacyAuditRecord ${id} is missing, duplicated, or rewritten.`,
        );
      }
    }
    const expectedLegacyIds = new Set(expectedLegacyById.keys());
    if (
      workspace.legacyAuditRecords.some(
        ({ id }) => !expectedLegacyIds.has(id),
      )
    ) {
      add(
        "ENTITY_PRESERVATION_FAILED",
        "workspace.legacyAuditRecords",
        "Migration introduced a LegacyAuditRecord not derived from V1 source history.",
      );
    }

    const expectedActualIds = new Set(
      expected.workspace.actuals.map(({ id }) => id),
    );
    try {
      for (const invariant of validateWorkspaceInvariants(
        workspace,
        expectations.now,
      )) {
        const isAllowedHistoricalActualWithoutBet =
          invariant.code === "BET_REQUIRED" &&
          invariant.gate !== undefined &&
          [...expectedActualIds].some(
            (id) => invariant.gate === `actual:${id}:current_bet`,
          );
        if (isAllowedHistoricalActualWithoutBet) {
          continue;
        }
        add(
          "WORKSPACE_INVARIANT",
          invariant.gate ?? "workspace",
          `${invariant.code}: ${invariant.reason}`,
        );
      }
    } catch (error) {
      add(
        "WORKSPACE_INVARIANT",
        "workspace",
        `Workspace invariant evaluation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return [...violations.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.path.localeCompare(right.path) ||
      left.message.localeCompare(right.message),
  );
}
