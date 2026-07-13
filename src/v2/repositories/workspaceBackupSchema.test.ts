import { describe, expect, it } from "vitest";

import { createEmptyWorkspaceV2 } from "../domain/workspace";
import {
  assertWorkspaceV2Schema,
  WorkspaceBackupSchemaError,
} from "./workspaceBackupSchema";

function jsonWorkspace(): unknown {
  return JSON.parse(JSON.stringify(createEmptyWorkspaceV2("workspace-schema")));
}

function workspaceRecord(): Record<string, unknown> {
  return jsonWorkspace() as Record<string, unknown>;
}

const NOW = "2026-07-12T00:00:00.000Z";
const LATER = "2026-07-12T01:00:00.000Z";

function populatedWorkspace(): Record<string, any> {
  const capacityProfile = {
    timeZone: "Asia/Tokyo",
    weeklyWindows: [{ weekday: 1, startMinute: 540, finishMinute: 1020 }],
    dailyBudgets: [
      {
        weekday: 1,
        deepSeconds: 3600,
        mediumSeconds: 1800,
        shallowSeconds: 900,
      },
    ],
    unavailableBlocks: [{ id: "block-1", start: NOW, finish: LATER }],
    updatedAt: NOW,
    updatedBy: "human-1",
  };
  const scope = { id: "scope-1", title: "Scope", description: "Bounded" };
  const brief = {
    id: "brief-1",
    projectId: "project-1",
    version: 1,
    audienceAndProblem: "Audience and problem",
    successEvidence: "Observable success",
    appetiteSeconds: 3600,
    validationMethod: "Interview",
    firstScope: [scope],
    noGoOrKill: "No-go",
    advancedNotes: "Notes",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const slot = {
    id: "slot-1",
    target: { kind: "work_item", workItemId: "work-1", projectId: "project-1" },
    targetRevision: 1,
    start: NOW,
    finish: LATER,
    attention: "deep",
  };
  const plan = {
    id: "plan-1",
    projectId: "project-1",
    version: 1,
    betId: "bet-1",
    workItemRevisions: { "work-1": 1 },
    dependencyRevisions: { "dependency-1": 1 },
    scopeMapping: { "work-1": "scope-1" },
    scheduleHash: "schedule-hash",
    capacityIndependentDates: { "work-1": { start: NOW, finish: LATER } },
    actorId: "human-1",
    createdAt: NOW,
    supersedesId: "plan-0",
  };
  const daily = {
    id: "daily-1",
    localDate: "2026-07-12",
    version: 1,
    proposalHash: "proposal-hash",
    capacitySnapshot: capacityProfile,
    slots: [slot],
    actorId: "human-1",
    committedAt: NOW,
    supersedesId: "daily-0",
  };
  const replan = {
    id: "replan-1",
    localDate: "2026-07-12",
    baseCommitmentId: "daily-1",
    baseRevision: 1,
    reasonCodes: ["capacity-change"],
    proposedSlots: [slot],
    proposalHash: "replan-hash",
    createdAt: NOW,
    createdBy: "human-1",
    status: "open",
  };
  const review = {
    id: "review-1",
    kind: "weekly",
    triggerKey: "weekly:2026-07-12",
    triggerType: "weekly",
    status: "completed",
    affectedProjectIds: ["project-1"],
    affectedRecordIds: ["bet-1"],
    dueAt: NOW,
    cadenceTimeZone: "Asia/Tokyo",
    createdAt: NOW,
    overdueMarkedAt: LATER,
    conclusion: {
      summary: "Reviewed",
      decisionCodes: ["continue"],
      followUpCommandIds: ["command-2"],
      actorId: "human-1",
      completedAt: LATER,
    },
  };
  const exception = {
    id: "exception-1",
    projectId: "project-1",
    requirementId: "requirement-1",
    rationale: "Bounded exception",
    knownConsequence: "Known consequence",
    reviewAt: NOW,
    expiresAt: LATER,
    approvedBy: "human-1",
    createdAt: NOW,
    resolvedAt: LATER,
    history: [
      { action: "created", actorId: "human-1", at: NOW, note: "Created" },
      { action: "resolved", actorId: "human-1", at: LATER, note: "Resolved" },
    ],
  };
  const close = {
    id: "close-1",
    projectId: "project-1",
    successComparison: "Compared",
    outcome: "partial",
    keyLearning: "Learning",
    unfinishedDisposition: "follow_up_project",
    followUpProjectId: "project-2",
    actorId: "human-1",
    closedAt: LATER,
  };
  const inbox = {
    id: "inbox-1",
    originalText: "Captured",
    sourceId: "source-1",
    actorId: "human-1",
    capturedAt: NOW,
    desiredDate: LATER,
    recommendation: {
      kind: "action",
      ruleCodes: ["single-session"],
      explanation: "Bounded",
    },
    triageStatus: "action",
    actionId: "action-1",
    projectId: "project-1",
  };
  const project = {
    id: "project-1",
    name: "Project",
    priority: 1,
    notes: "Notes",
    stage: "executing",
    holds: [
      {
        type: "migration_review",
        sourceId: "migration-1",
        affectedRecordIds: ["legacy-1"],
        createdAt: NOW,
      },
    ],
    activeDirectionBriefId: "brief-1",
    activeBetId: "bet-1",
    activePlanVersionId: "plan-1",
    legacyClosure: {
      sourceStatus: "done",
      legacyRecordId: "legacy-1",
      sourceChecksum: "source-checksum",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const bet = {
    id: "bet-1",
    projectId: "project-1",
    version: 1,
    briefId: "brief-1",
    briefHash: "brief-hash",
    briefSnapshot: brief,
    committedScope: [scope],
    appetiteStart: NOW,
    appetiteEnd: LATER,
    actorId: "human-1",
    approvedAt: NOW,
    supersedesId: "bet-0",
    sourceReviewId: "review-1",
    invalidatedAt: LATER,
    invalidationReason: "Changed",
  };
  const workItem = {
    id: "work-1",
    projectId: "project-1",
    parentId: "work-0",
    kind: "task",
    title: "Task",
    outline: "Outline",
    durationSeconds: 1800,
    estimate: {
      optimisticSeconds: 1200,
      mostLikelySeconds: 1800,
      pessimisticSeconds: 2400,
    },
    constraint: {
      noEarlierThan: NOW,
      noLaterThan: LATER,
      fixedStart: NOW,
      fixedFinish: LATER,
    },
    assignmentIds: [
      { resourceId: "resource-1", attention: "deep", effortSeconds: 1800 },
    ],
    percentComplete: 50.5,
    isKeyTask: true,
    isScopeExpansion: false,
    isFastDelivery: true,
    splitSegments: [{ offsetSeconds: 0, durationSeconds: 900 }],
    repeatRule: {
      cadence: "weekly",
      everyDays: 7,
      count: 2,
      startMode: "fixed-time",
      startAt: NOW,
    },
    hammockStartId: "work-start",
    hammockFinishId: "work-finish",
    evidenceRequired: true,
    revision: 1,
    betScopeId: "scope-1",
    resultStatus: "learned",
    outcomeNote: "Learned",
  };
  const dependency = {
    id: "dependency-1",
    projectId: "project-1",
    fromId: "work-0",
    toId: "work-1",
    type: "FS",
    lagSeconds: 0,
    revision: 1,
  };

  const closeDraft = (({ actorId: _actorId, closedAt: _closedAt, ...value }) =>
    value)(close);
  const briefDraft = (({
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...value
  }) => value)(brief);
  const reviewDraft = (({
    status: _status,
    createdAt: _createdAt,
    overdueMarkedAt: _overdue,
    conclusion: _conclusion,
    ...value
  }) => value)(review);
  const exceptionDraft = (({
    approvedBy: _approvedBy,
    createdAt: _createdAt,
    resolvedAt: _resolvedAt,
    history: _history,
    ...value
  }) => value)(exception);
  const protectedCommands = [
    { type: "place_bet", projectId: "project-1", betId: "bet-1", start: NOW },
    { type: "update_direction", projectId: "project-1", brief: briefDraft },
    {
      type: "record_bet_boundary",
      projectId: "project-1",
      boundary: "midpoint",
      triggerKey: "boundary-1",
    },
    {
      type: "commit_today",
      commitment: {
        id: "daily-1",
        localDate: "2026-07-12",
        workspaceRevision: 1,
        generatedAt: NOW,
        proposalHash: "proposal-hash",
        slots: [slot],
      },
    },
    { type: "propose_replan", proposal: replan },
    { type: "accept_replan", proposalId: "replan-1", commitmentId: "daily-2" },
    { type: "create_review", review: reviewDraft },
    { type: "mark_review_overdue", reviewId: "review-1", triggerKey: "weekly" },
    {
      type: "complete_review",
      reviewId: "review-1",
      conclusion: {
        summary: "Done",
        decisionCodes: ["continue"],
        followUpCommandIds: [],
      },
    },
    { type: "approve_evidence_exception", exception: exceptionDraft },
    {
      type: "resolve_evidence_exception",
      exceptionId: "exception-1",
      resolution: "Resolved",
    },
    { type: "close_project", projectId: "project-1", decision: closeDraft },
    {
      type: "abandon_project",
      projectId: "project-1",
      decision: { ...closeDraft, outcome: "abandoned" },
    },
  ];
  const createdValues: Record<string, object> = {
    BetVersion: bet,
    DailyCommitment: daily,
    PlanVersion: plan,
    ReplanProposal: replan,
    ReviewRecord: review,
    ExceptionRecord: exception,
    CloseDecision: close,
    InboxItem: inbox,
    ProjectV2: project,
    DirectionBrief: brief,
  };
  const cells = [
    ...Object.entries(createdValues).map(([entity, value], index) => ({
      kind: "create",
      entity,
      entityId: `created-${index}`,
      value,
    })),
    {
      kind: "scalar",
      entity: "ProjectV2",
      entityId: "project-1",
      ownerProjectId: "project-1",
      field: "stage",
      before: "planning",
      after: "executing",
    },
    {
      kind: "project_hold_delta",
      projectId: "project-1",
      holdKey: "migration_review:migration-1",
      before: null,
      after: { index: 0, value: project.holds[0] },
    },
    {
      kind: "exception_history_append",
      exceptionId: "exception-1",
      index: 1,
      entry: exception.history[1],
    },
  ];
  const operations = protectedCommands.map((command, index) => ({
    commandType: command.type,
    commandId: `protected-${index}`,
    command,
    authorityRootOperationHash: `authority-${index}`,
    sourceOperationHash: `operation-${index}`,
    receiptHash: `receipt-${index}`,
    payloadHash: `payload-${index}`,
    createdAt: NOW,
    cells: index === 0 ? cells : [],
  }));
  const bundle = {
    schemaVersion: 1,
    logicalKey: '["bet","project-1"]',
    operations,
    hash: "bundle-hash",
  };

  const workspace = workspaceRecord() as Record<string, any>;
  Object.assign(workspace, {
    revision: 1,
    capacityProfile,
    inboxItems: [inbox],
    actions: [
      {
        id: "action-1",
        inboxItemId: "inbox-1",
        title: "Action",
        revision: 1,
        status: "completed",
        eligibility: {
          singleSession: true,
          estimateSeconds: 1800,
          dependencyIds: ["action-0"],
          requiresMilestoneEvidence: false,
          outcomeCount: 1,
          solutionKnown: true,
        },
        attention: "deep",
        desiredDate: NOW,
        fixedStart: NOW,
        resultStatus: "learned",
        outcomeNote: "Learned",
        promotedProjectId: "project-1",
        createdAt: NOW,
        updatedAt: LATER,
      },
    ],
    projects: [project],
    directionBriefs: [brief],
    bets: [bet],
    planVersions: [plan],
    dailyCommitments: [daily],
    replanProposals: [replan],
    reviews: [review],
    exceptions: [exception],
    closeDecisions: [close],
    commandProposals: [
      {
        id: "proposal-1",
        commandType: "update_direction",
        payload: { nested: [null, true, 1.5, "value"] },
        baseRevision: 1,
        rationale: "Rationale",
        agentActorId: "agent-1",
        createdAt: NOW,
        status: "open",
      },
    ],
    syncConflicts: [
      {
        id: "conflict-1",
        recordType: "bet",
        recordId: "bet-1",
        remoteRecordId: "bet-remote",
        projectId: "project-1",
        logicalKey: "bet:project-1",
        affectedProjectIds: ["project-1"],
        affectedRecordIds: ["bet-1"],
        commonAncestorHash: "ancestor-hash",
        localValue: { version: 1 },
        remoteValue: { version: 2 },
        localBundle: bundle,
        remoteBundle: structuredClone(bundle),
        openedAt: NOW,
        resolvedAt: LATER,
        retainedVersion: "local",
        retainedBundleHash: "bundle-hash",
      },
    ],
    commandReceipts: [
      {
        id: "command-1",
        commandId: "command-1",
        commandType: "capture_inbox",
        baseRevision: 0,
        revision: 1,
        payloadHash: "payload-hash",
        receiptHash: "receipt-hash",
        actorId: "human-1",
        actorKind: "human",
        origin: "ui",
        source: {
          sourceId: "session-1",
          verified: true,
          capabilities: ["capture_inbox", "human_decision"],
        },
        status: "applied",
        createdAt: NOW,
        diff: [
          {
            entity: "InboxItem",
            entityId: "inbox-1",
            field: "created",
            before: null,
            after: { id: "inbox-1" },
          },
        ],
        rejectionCode: "none",
      },
    ],
    workItems: [workItem],
    dependencies: [dependency],
    resources: [
      {
        id: "resource-1",
        name: "Resource",
        role: "Maker",
        capacityByAttention: { deep: 3600, medium: 1800, shallow: 900 },
        hourlyRate: 100.5,
      },
    ],
    capacities: [
      {
        date: NOW,
        deepSeconds: 3600,
        mediumSeconds: 1800,
        shallowSeconds: 900,
        unavailableBlocks: [{ start: NOW, finish: LATER }],
      },
    ],
    baselines: [
      {
        id: "baseline-1",
        projectId: "project-1",
        name: "Baseline",
        capturedAt: NOW,
        plannedStartByItem: { "work-1": NOW },
        plannedFinishByItem: { "work-1": LATER },
        plannedWorkSecondsByItem: { "work-1": 1800 },
        approvedByDecisionId: "decision-1",
      },
    ],
    evidence: [
      {
        id: "evidence-1",
        kind: "metric",
        summary: "Evidence",
        url: "https://example.test",
        localFileRef: "/tmp/evidence",
        projectId: "project-1",
        workItemId: "work-1",
        createdAt: NOW,
        confidence: 0.75,
        tags: ["validated"],
      },
    ],
    actuals: [
      {
        id: "actual-1",
        revision: 1,
        target: { kind: "work_item", workItemId: "work-1" },
        actualStart: NOW,
        actualFinish: LATER,
        actualWorkSeconds: 1800,
        remainingWorkSeconds: 0,
        actualCost: 50.25,
        recordedAt: LATER,
      },
    ],
    legacyAuditRecords: [
      {
        id: "legacy-1",
        projectId: "project-1",
        recordType: "change_set",
        sourcePayload: { nested: [1, "two", false] },
        sourceChecksum: "source-checksum",
      },
    ],
    visibility: { archivedProjectIds: ["project-2"] },
    migration: {
      sourceSchemaVersion: 1,
      sourceChecksum: "source-checksum",
      backupId: "backup-1",
      backupChecksum: "backup-checksum",
      migratedAt: NOW,
      entityCounts: { projects: 1 },
      deterministicIdMap: { old: "new" },
    },
  });
  return JSON.parse(JSON.stringify(workspace)) as Record<string, any>;
}

function valueAtPath(root: any, path: readonly (string | number)[]): any {
  return path.reduce((value, segment) => value[segment], root);
}

const collectionNames = [
  "inboxItems",
  "actions",
  "projects",
  "directionBriefs",
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
  "workItems",
  "dependencies",
  "resources",
  "capacities",
  "baselines",
  "evidence",
  "actuals",
  "legacyAuditRecords",
] as const;

const nestedExactShapeCases: Array<{
  label: string;
  path: Array<string | number>;
  errorPath: string;
}> = [
  {
    label: "CapacityProfile",
    path: ["capacityProfile"],
    errorPath: "workspace.capacityProfile.unexpected",
  },
  {
    label: "CapacityProfile.weeklyWindows",
    path: ["capacityProfile", "weeklyWindows", 0],
    errorPath: "workspace.capacityProfile.weeklyWindows[0].unexpected",
  },
  {
    label: "CapacityProfile.dailyBudgets",
    path: ["capacityProfile", "dailyBudgets", 0],
    errorPath: "workspace.capacityProfile.dailyBudgets[0].unexpected",
  },
  {
    label: "CapacityProfile.unavailableBlocks",
    path: ["capacityProfile", "unavailableBlocks", 0],
    errorPath: "workspace.capacityProfile.unavailableBlocks[0].unexpected",
  },
  {
    label: "InboxItem.recommendation",
    path: ["inboxItems", 0, "recommendation"],
    errorPath: "workspace.inboxItems[0].recommendation.unexpected",
  },
  {
    label: "Action.eligibility",
    path: ["actions", 0, "eligibility"],
    errorPath: "workspace.actions[0].eligibility.unexpected",
  },
  {
    label: "ProjectV2.holds",
    path: ["projects", 0, "holds", 0],
    errorPath: "workspace.projects[0].holds[0].unexpected",
  },
  {
    label: "ProjectV2.legacyClosure",
    path: ["projects", 0, "legacyClosure"],
    errorPath: "workspace.projects[0].legacyClosure.unexpected",
  },
  {
    label: "DirectionBrief.firstScope",
    path: ["directionBriefs", 0, "firstScope", 0],
    errorPath: "workspace.directionBriefs[0].firstScope[0].unexpected",
  },
  {
    label: "BetVersion.briefSnapshot",
    path: ["bets", 0, "briefSnapshot"],
    errorPath: "workspace.bets[0].briefSnapshot.unexpected",
  },
  {
    label: "BetVersion.committedScope",
    path: ["bets", 0, "committedScope", 0],
    errorPath: "workspace.bets[0].committedScope[0].unexpected",
  },
  {
    label: "PlanVersion.capacityIndependentDates",
    path: ["planVersions", 0, "capacityIndependentDates", "work-1"],
    errorPath:
      "workspace.planVersions[0].capacityIndependentDates.work-1.unexpected",
  },
  {
    label: "DailyCommitment.capacitySnapshot",
    path: ["dailyCommitments", 0, "capacitySnapshot"],
    errorPath: "workspace.dailyCommitments[0].capacitySnapshot.unexpected",
  },
  {
    label: "DailyCommitment.slot",
    path: ["dailyCommitments", 0, "slots", 0],
    errorPath: "workspace.dailyCommitments[0].slots[0].unexpected",
  },
  {
    label: "DailyCommitment.slot.target",
    path: ["dailyCommitments", 0, "slots", 0, "target"],
    errorPath: "workspace.dailyCommitments[0].slots[0].target.unexpected",
  },
  {
    label: "ReplanProposal.proposedSlot",
    path: ["replanProposals", 0, "proposedSlots", 0],
    errorPath: "workspace.replanProposals[0].proposedSlots[0].unexpected",
  },
  {
    label: "ReviewRecord.conclusion",
    path: ["reviews", 0, "conclusion"],
    errorPath: "workspace.reviews[0].conclusion.unexpected",
  },
  {
    label: "ExceptionRecord.history",
    path: ["exceptions", 0, "history", 0],
    errorPath: "workspace.exceptions[0].history[0].unexpected",
  },
  {
    label: "CommandReceipt.source",
    path: ["commandReceipts", 0, "source"],
    errorPath: "workspace.commandReceipts[0].source.unexpected",
  },
  {
    label: "CommandReceipt.diff",
    path: ["commandReceipts", 0, "diff", 0],
    errorPath: "workspace.commandReceipts[0].diff[0].unexpected",
  },
  {
    label: "ProjectWorkItem.estimate",
    path: ["workItems", 0, "estimate"],
    errorPath: "workspace.workItems[0].estimate.unexpected",
  },
  {
    label: "ProjectWorkItem.constraint",
    path: ["workItems", 0, "constraint"],
    errorPath: "workspace.workItems[0].constraint.unexpected",
  },
  {
    label: "ProjectWorkItem.assignment",
    path: ["workItems", 0, "assignmentIds", 0],
    errorPath: "workspace.workItems[0].assignmentIds[0].unexpected",
  },
  {
    label: "ProjectWorkItem.splitSegment",
    path: ["workItems", 0, "splitSegments", 0],
    errorPath: "workspace.workItems[0].splitSegments[0].unexpected",
  },
  {
    label: "ProjectWorkItem.repeatRule",
    path: ["workItems", 0, "repeatRule"],
    errorPath: "workspace.workItems[0].repeatRule.unexpected",
  },
  {
    label: "Resource.capacityByAttention",
    path: ["resources", 0, "capacityByAttention"],
    errorPath: "workspace.resources[0].capacityByAttention.unexpected",
  },
  {
    label: "AttentionCapacity.unavailableBlock",
    path: ["capacities", 0, "unavailableBlocks", 0],
    errorPath: "workspace.capacities[0].unavailableBlocks[0].unexpected",
  },
  {
    label: "ActualV2.target",
    path: ["actuals", 0, "target"],
    errorPath: "workspace.actuals[0].target.unexpected",
  },
  {
    label: "SyncConflictRecord.localBundle",
    path: ["syncConflicts", 0, "localBundle"],
    errorPath: "workspace.syncConflicts[0].localBundle.unexpected",
  },
  {
    label: "ProtectedOperationProjection",
    path: ["syncConflicts", 0, "localBundle", "operations", 0],
    errorPath:
      "workspace.syncConflicts[0].localBundle.operations[0].unexpected",
  },
  {
    label: "protected command",
    path: ["syncConflicts", 0, "localBundle", "operations", 0, "command"],
    errorPath:
      "workspace.syncConflicts[0].localBundle.operations[0].command.unexpected",
  },
  {
    label: "ProtectedEffectCell",
    path: ["syncConflicts", 0, "localBundle", "operations", 0, "cells", 10],
    errorPath:
      "workspace.syncConflicts[0].localBundle.operations[0].cells[10].unexpected",
  },
  {
    label: "VisibilityPreferences",
    path: ["visibility"],
    errorPath: "workspace.visibility.unexpected",
  },
  {
    label: "MigrationRecord",
    path: ["migration"],
    errorPath: "workspace.migration.unexpected",
  },
];

describe("WorkspaceV2 backup runtime schema", () => {
  it("accepts the exact JSON shape of an empty WorkspaceV2", () => {
    expect(() => assertWorkspaceV2Schema(jsonWorkspace())).not.toThrow();
  });

  it("accepts only the two explicit undefined optionals owned by a runtime empty Workspace", () => {
    const workspace = createEmptyWorkspaceV2("workspace-runtime-schema");

    expect(
      Object.prototype.hasOwnProperty.call(workspace, "capacityProfile"),
    ).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(workspace, "migration")).toBe(
      true,
    );
    expect(() => assertWorkspaceV2Schema(workspace)).not.toThrow();
  });

  it.each([
    {
      label: "a sparse identity collection",
      mutate(workspace: Record<string, any>) {
        workspace.projects = new Array(1);
      },
    },
    {
      label: "a huge sparse identity collection",
      mutate(workspace: Record<string, any>) {
        workspace.projects = new Array(1_000_000_000);
      },
    },
    {
      label: "an identity collection with a custom own key",
      mutate(workspace: Record<string, any>) {
        workspace.projects.extra = "not-json";
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const workspace = jsonWorkspace() as Record<string, any>;
    mutate(workspace);

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.projects",
      }),
    );
  });

  it("accepts every WorkspaceV2 entity and nested protected-bundle shape", () => {
    expect(() => assertWorkspaceV2Schema(populatedWorkspace())).not.toThrow();
  });

  it("rejects duplicate identities inside one top-level collection", () => {
    const workspace = populatedWorkspace();
    workspace.closeDecisions.push(structuredClone(workspace.closeDecisions[0]));

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.closeDecisions",
      }),
    );
  });

  it("accepts finite values and opaque time strings preserved by V2 commands and V1 migration", () => {
    const workspace = populatedWorkspace();

    workspace.actions[0].eligibility.estimateSeconds = -0.25;
    workspace.actions[0].eligibility.outcomeCount = 1.5;
    workspace.actions[0].fixedStart = "2026-07-12";
    workspace.directionBriefs[0].appetiteSeconds = -0.5;

    const workItem = workspace.workItems[0];
    workItem.durationSeconds = -1.25;
    workItem.estimate = {
      optimisticSeconds: -1.5,
      mostLikelySeconds: 2.5,
      pessimisticSeconds: -3.5,
    };
    workItem.constraint = {
      noEarlierThan: "legacy-no-earlier-than",
      noLaterThan: "legacy-no-later-than",
      fixedStart: "legacy-fixed-start",
      fixedFinish: "legacy-fixed-finish",
    };
    workItem.assignmentIds[0].effortSeconds = -4.5;
    workItem.splitSegments[0] = {
      offsetSeconds: -5.5,
      durationSeconds: 6.5,
    };
    workItem.repeatRule = {
      cadence: "every-n-days",
      everyDays: 0.5,
      count: -2.5,
      startMode: "fixed-time",
      startAt: "legacy-repeat-start",
    };

    workspace.resources[0].capacityByAttention = {
      deep: -7.5,
      medium: 8.5,
      shallow: -9.5,
    };
    workspace.capacities[0] = {
      date: "legacy-capacity-date",
      deepSeconds: -10.5,
      mediumSeconds: 11.5,
      shallowSeconds: -12.5,
      unavailableBlocks: [
        { start: "legacy-block-start", finish: "legacy-block-finish" },
      ],
    };
    workspace.baselines[0] = {
      ...workspace.baselines[0],
      capturedAt: "legacy-baseline-captured-at",
      plannedStartByItem: { "work-1": "legacy-planned-start" },
      plannedFinishByItem: { "work-1": "legacy-planned-finish" },
      plannedWorkSecondsByItem: { "work-1": -13.5 },
    };
    workspace.evidence[0].createdAt = "legacy-evidence-created-at";
    workspace.actuals[0] = {
      ...workspace.actuals[0],
      actualStart: "legacy-actual-start",
      actualFinish: "legacy-actual-finish",
      actualWorkSeconds: -14.5,
      remainingWorkSeconds: 15.5,
      actualCost: -16.5,
      recordedAt: "legacy-actual-recorded-at",
    };

    expect(() => assertWorkspaceV2Schema(workspace)).not.toThrow();
  });

  it.each([
    {
      label: "a non-object root",
      value: null,
      path: "workspace",
    },
    {
      label: "an unknown root field",
      value: (() => {
        const workspace = populatedWorkspace();
        workspace.unexpected = true;
        return workspace;
      })(),
      path: "workspace.unexpected",
    },
    {
      label: "a missing required root field",
      value: (() => {
        const workspace = populatedWorkspace();
        delete workspace.visibility;
        return workspace;
      })(),
      path: "workspace.visibility",
    },
    {
      label: "a non-array collection",
      value: (() => {
        const workspace = populatedWorkspace();
        workspace.projects = {};
        return workspace;
      })(),
      path: "workspace.projects",
    },
  ])("rejects $label", ({ value, path }) => {
    expect(() => assertWorkspaceV2Schema(value)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({ path }),
    );
  });

  it.each(collectionNames)(
    "rejects unknown fields on %s entities",
    (collection) => {
      const workspace = populatedWorkspace();
      workspace[collection][0].unexpected = true;

      expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
        expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
          path: `workspace.${collection}[0].unexpected`,
        }),
      );
    },
  );

  it.each(nestedExactShapeCases)(
    "rejects unknown fields in $label",
    ({ path, errorPath }) => {
      const workspace = populatedWorkspace();
      valueAtPath(workspace, path).unexpected = true;

      expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
        expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
          path: errorPath,
        }),
      );
    },
  );

  it.each(Array.from({ length: 13 }, (_, index) => index))(
    "strictly validates protected command variant %i",
    (index) => {
      const workspace = populatedWorkspace();
      const command =
        workspace.syncConflicts[0].localBundle.operations[index].command;
      command.unexpected = true;

      expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
        expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
          path: `workspace.syncConflicts[0].localBundle.operations[${index}].command.unexpected`,
        }),
      );
    },
  );

  it.each(Array.from({ length: 10 }, (_, index) => index))(
    "strictly validates protected created-entity variant %i",
    (index) => {
      const workspace = populatedWorkspace();
      const value =
        workspace.syncConflicts[0].localBundle.operations[0].cells[index].value;
      value.unexpected = true;

      expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
        expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
          path: `workspace.syncConflicts[0].localBundle.operations[0].cells[${index}].value.unexpected`,
        }),
      );
    },
  );

  it.each([
    {
      label: "fractional workspace revision",
      mutate: (workspace: Record<string, any>) => {
        workspace.revision = 1.5;
      },
      path: "workspace.revision",
    },
    {
      label: "unsafe entity revision",
      mutate: (workspace: Record<string, any>) => {
        workspace.actions[0].revision = Number.MAX_SAFE_INTEGER + 1;
      },
      path: "workspace.actions[0].revision",
    },
    {
      label: "non-finite semantic seconds",
      mutate: (workspace: Record<string, any>) => {
        workspace.actuals[0].actualWorkSeconds = Number.POSITIVE_INFINITY;
      },
      path: "workspace.actuals[0].actualWorkSeconds",
    },
    {
      label: "fractional entity version",
      mutate: (workspace: Record<string, any>) => {
        workspace.directionBriefs[0].version = 1.5;
      },
      path: "workspace.directionBriefs[0].version",
    },
    {
      label: "fractional protected-effect index",
      mutate: (workspace: Record<string, any>) => {
        workspace.syncConflicts[0].localBundle.operations[0].cells[12].index = 1.5;
      },
      path: "workspace.syncConflicts[0].localBundle.operations[0].cells[12].index",
    },
    {
      label: "fractional weekday",
      mutate: (workspace: Record<string, any>) => {
        workspace.capacityProfile.weeklyWindows[0].weekday = 1.5;
      },
      path: "workspace.capacityProfile.weeklyWindows[0].weekday",
    },
    {
      label: "noncanonical ISO timestamp",
      mutate: (workspace: Record<string, any>) => {
        workspace.actions[0].createdAt = "2026-07-12T00:00:00Z";
      },
      path: "workspace.actions[0].createdAt",
    },
    {
      label: "unknown enum member",
      mutate: (workspace: Record<string, any>) => {
        workspace.projects[0].stage = "paused";
      },
      path: "workspace.projects[0].stage",
    },
    {
      label: "wrong array primitive",
      mutate: (workspace: Record<string, any>) => {
        workspace.reviews[0].affectedProjectIds = "project-1";
      },
      path: "workspace.reviews[0].affectedProjectIds",
    },
    {
      label: "wrong record primitive",
      mutate: (workspace: Record<string, any>) => {
        workspace.visibility = [];
      },
      path: "workspace.visibility",
    },
    {
      label: "explicit undefined optional field",
      mutate: (workspace: Record<string, any>) => {
        workspace.projects[0].activeBetId = undefined;
      },
      path: "workspace.projects[0].activeBetId",
    },
    {
      label: "non-finite JsonValue",
      mutate: (workspace: Record<string, any>) => {
        workspace.commandProposals[0].payload.invalid = Number.NaN;
      },
      path: "workspace.commandProposals[0].payload.invalid",
    },
    {
      label: "unsafe integer JsonValue",
      mutate: (workspace: Record<string, any>) => {
        workspace.legacyAuditRecords[0].sourcePayload.invalid =
          Number.MAX_SAFE_INTEGER + 1;
      },
      path: "workspace.legacyAuditRecords[0].sourcePayload.invalid",
    },
    {
      label: "undefined JsonValue",
      mutate: (workspace: Record<string, any>) => {
        workspace.commandReceipts[0].diff[0].after.invalid = undefined;
      },
      path: "workspace.commandReceipts[0].diff[0].after.invalid",
    },
    {
      label: "non-plain JsonValue record",
      mutate: (workspace: Record<string, any>) => {
        workspace.commandProposals[0].payload = new Date(NOW);
      },
      path: "workspace.commandProposals[0].payload",
    },
    {
      label: "null-prototype JsonValue record",
      mutate: (workspace: Record<string, any>) => {
        workspace.commandProposals[0].payload = Object.assign(
          Object.create(null),
          { value: "not-a-JSON-runtime-object" },
        );
      },
      path: "workspace.commandProposals[0].payload",
    },
  ])("rejects $label", ({ mutate, path }) => {
    const workspace = populatedWorkspace();
    mutate(workspace);

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({ path }),
    );
  });

  it.each([
    { cellIndex: 0, suffix: "", label: "create" },
    { cellIndex: 10, suffix: "", label: "scalar" },
    { cellIndex: 11, suffix: "", label: "project hold delta" },
    { cellIndex: 11, suffix: ".after", label: "indexed project hold" },
    { cellIndex: 11, suffix: ".after.value", label: "project hold value" },
    { cellIndex: 12, suffix: "", label: "exception history append" },
    { cellIndex: 12, suffix: ".entry", label: "exception history entry" },
  ])("strictly validates $label effect shape", ({ cellIndex, suffix }) => {
    const workspace = populatedWorkspace();
    const path = [
      "syncConflicts",
      0,
      "localBundle",
      "operations",
      0,
      "cells",
      cellIndex,
      ...suffix.split(".").filter(Boolean),
    ];
    valueAtPath(workspace, path).unexpected = true;
    const schemaPath =
      `workspace.syncConflicts[0].localBundle.operations[0].cells[${cellIndex}]` +
      suffix +
      ".unexpected";

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: schemaPath,
      }),
    );
  });

  it("rejects unknown fields inside a capacity profile", () => {
    const workspace = workspaceRecord();
    workspace.capacityProfile = {
      timeZone: "UTC",
      weeklyWindows: [
        { weekday: 1, startMinute: 540, finishMinute: 1020, extra: true },
      ],
      dailyBudgets: [
        {
          weekday: 1,
          deepSeconds: 3600,
          mediumSeconds: 1800,
          shallowSeconds: 900,
        },
      ],
      unavailableBlocks: [
        {
          id: "unavailable-1",
          start: "2026-07-12T00:00:00.000Z",
          finish: "2026-07-12T01:00:00.000Z",
        },
      ],
      updatedAt: "2026-07-12T00:00:00.000Z",
      updatedBy: "human-1",
    };

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.capacityProfile.weeklyWindows[0].extra",
      }),
    );
  });

  it("rejects unknown fields inside Inbox recommendations", () => {
    const workspace = workspaceRecord();
    workspace.inboxItems = [
      {
        id: "inbox-1",
        originalText: "Capture this",
        sourceId: "source-1",
        actorId: "human-1",
        capturedAt: NOW,
        desiredDate: NOW,
        recommendation: {
          kind: "action",
          ruleCodes: ["single-session"],
          explanation: "Bounded work",
          confidence: 1,
        },
        triageStatus: "action",
        actionId: "action-1",
        projectId: "project-1",
      },
    ];

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.inboxItems[0].recommendation.confidence",
      }),
    );
  });

  it("rejects unknown fields inside Action eligibility facts", () => {
    const workspace = workspaceRecord();
    workspace.actions = [
      {
        id: "action-1",
        inboxItemId: "inbox-1",
        title: "Ship it",
        revision: 1,
        status: "completed",
        eligibility: {
          singleSession: true,
          estimateSeconds: 1800,
          dependencyIds: ["action-0"],
          requiresMilestoneEvidence: false,
          outcomeCount: 1,
          solutionKnown: true,
          extra: "forged",
        },
        attention: "deep",
        desiredDate: NOW,
        fixedStart: NOW,
        resultStatus: "learned",
        outcomeNote: "Learned",
        promotedProjectId: "project-1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.actions[0].eligibility.extra",
      }),
    );
  });

  it("rejects unknown fields inside Project hold and legacy provenance records", () => {
    const workspace = workspaceRecord();
    workspace.projects = [
      {
        id: "project-1",
        name: "Project",
        priority: 1,
        notes: "Notes",
        stage: "executing",
        holds: [
          {
            type: "migration_review",
            sourceId: "migration-1",
            affectedRecordIds: ["legacy-1"],
            createdAt: NOW,
          },
        ],
        activeDirectionBriefId: "brief-1",
        activeBetId: "bet-1",
        activePlanVersionId: "plan-1",
        legacyClosure: {
          sourceStatus: "done",
          legacyRecordId: "legacy-1",
          sourceChecksum: "checksum",
          extra: false,
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.projects[0].legacyClosure.extra",
      }),
    );
  });

  it("rejects unknown fields inside Direction Brief scope", () => {
    const workspace = workspaceRecord();
    workspace.directionBriefs = [
      {
        id: "brief-1",
        projectId: "project-1",
        version: 1,
        audienceAndProblem: "Audience",
        successEvidence: "Evidence",
        appetiteSeconds: 3600,
        validationMethod: "Interview",
        firstScope: [
          { id: "scope-1", title: "Scope", description: "Bounded", extra: 1 },
        ],
        noGoOrKill: "No-go",
        advancedNotes: "Notes",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];

    expect(() => assertWorkspaceV2Schema(workspace)).toThrowError(
      expect.objectContaining<Partial<WorkspaceBackupSchemaError>>({
        path: "workspace.directionBriefs[0].firstScope[0].extra",
      }),
    );
  });
});
