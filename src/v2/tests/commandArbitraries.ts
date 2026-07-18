import fc from "fast-check";

import type { Evidence } from "@/domain/types";

import {
  type CommandContext,
  type DirectionBriefDraft,
  type V2Command,
} from "../domain/commands";
import type { RejectionCode } from "../domain/errors";
import { generateTodayProposal } from "../domain/today";
import type {
  ActorKind,
  CommandOrigin,
  LifecycleStage,
  ProjectHoldState,
  ProjectWorkItem,
  JsonValue,
  SourceCapability,
  WorkspaceV2,
} from "../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildCloseDecision,
  buildDirectionBrief,
  buildExceptionRecord,
  buildInboxItem,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "./builders";

export const actorKindArbitrary = fc.constantFrom<ActorKind>(
  "human",
  "agent",
  "system",
);

export const commandOriginArbitrary = fc.constantFrom<CommandOrigin>(
  "ui",
  "agent",
  "import",
  "sync",
  "migration",
);

export const lifecycleStageArbitrary = fc.constantFrom(
  "direction" as const,
  "awaiting_bet" as const,
  "planning" as const,
  "executing" as const,
  "validating" as const,
  "closing" as const,
  "closed" as const,
);

export const directionCompletenessArbitrary = fc.boolean();
export const actionEstimateSecondsArbitrary = fc.oneof(
  fc.integer({ min: 1, max: 7_200 }),
  fc.integer({ min: 7_201, max: 86_400 }),
);
export const capacitySecondsArbitrary = fc.integer({ min: 0, max: 86_400 });
export const appetiteOffsetSecondsArbitrary = fc.oneof(
  fc.integer({ min: -86_400, max: -1 }),
  fc.constant(0),
  fc.integer({ min: 1, max: 604_800 }),
);
export const evidenceStateArbitrary = fc.constantFrom(
  "none" as const,
  "evidence" as const,
  "active_exception" as const,
  "expired_exception" as const,
);
export const projectHoldArbitrary: fc.Arbitrary<ProjectHoldState> = fc.record({
  type: fc.constantFrom(
    "migration_review" as const,
    "rebet_required" as const,
    "review_overdue" as const,
    "sync_conflict" as const,
  ),
  sourceId: fc.nat({ max: 1_000_000 }).map((value) => `hold-source:${value}`),
  affectedRecordIds: fc.uniqueArray(
    fc.nat({ max: 1_000_000 }).map((value) => `affected:${value}`),
    { maxLength: 4 },
  ),
  createdAt: fc.integer({ min: 0, max: 86_400 }).map(
    (seconds) =>
      new Date(Date.parse("2026-07-10T00:00:00.000Z") + seconds * 1_000)
        .toISOString(),
  ),
});

export const invalidCommandArbitrary: fc.Arbitrary<V2Command> = fc
  .nat({ max: 1_000_000 })
  .map(
    (value) =>
      ({
        type: `unsupported_property_command:${value}`,
        payload: value,
      }) as unknown as V2Command,
  );

type ContextProfile =
  | "authorized"
  | "agent"
  | "system"
  | "sync"
  | "import"
  | "migration"
  | "unverified";

const publicCommandTypeRecord = {
  configure_capacity: true,
  capture_inbox: true,
  confirm_action_triage: true,
  confirm_project_triage: true,
  update_project_metadata: true,
  update_action: true,
  complete_action: true,
  promote_action_to_project: true,
  update_direction: true,
  place_bet: true,
  create_work_item: true,
  update_work_item: true,
  upsert_dependency: true,
  remove_dependency: true,
  remove_work_item: true,
  capture_baseline: true,
  record_actual: true,
  complete_work_item: true,
  propose_replan: true,
  commit_today: true,
  accept_replan: true,
  attach_evidence: true,
  approve_evidence_exception: true,
  resolve_evidence_exception: true,
  request_validation: true,
  satisfy_validation: true,
  record_bet_boundary: true,
  mark_review_overdue: true,
  create_review: true,
  complete_review: true,
  open_sync_conflict: true,
  resolve_sync_conflict: true,
  close_project: true,
  abandon_project: true,
  archive_project: true,
  submit_command_proposal: true,
  accept_command_proposal: true,
  dismiss_command_proposal: true,
} as const satisfies Record<V2Command["type"], true>;

export const publicCommandTypes = Object.keys(
  publicCommandTypeRecord,
) as V2Command["type"][];

export type CommandStepKind =
  | V2Command["type"]
  | "complete_direction"
  | "invalid_command";

export type StepExpectation =
  | "must_apply"
  | "must_reject_invalid"
  | "state_dependent";

export interface CommandStepDescriptor {
  kind: CommandStepKind;
  value: number;
  intendedValid: boolean;
  target: "workflow" | LifecycleStage;
  generation: "guaranteed" | "coverage" | "fuzz";
  expectation: StepExpectation;
  expectedRejectionCodes?: readonly RejectionCode[];
  contextProfile: ContextProfile;
  origin: CommandOrigin;
  revisionMode: "current" | "stale";
  payloadValid: boolean;
  timeJitterSeconds: number;
}

export interface CommandSequenceCase {
  seed: number;
  baseTime: string;
  initial: WorkspaceV2;
  invalidCommand: V2Command;
  actionEstimateSeconds: number;
  appetiteOffsetSeconds: number;
  steps: CommandStepDescriptor[];
}

export interface MaterializedCommandEnvelope {
  command: V2Command;
  context: CommandContext;
}

const fuzzCommandKindArbitrary = fc.constantFrom<CommandStepKind>(
  ...publicCommandTypes,
  "invalid_command",
);

const contextProfileArbitrary = fc.constantFrom<ContextProfile>(
  "authorized",
  "authorized",
  "authorized",
  "authorized",
  "agent",
  "system",
  "sync",
  "import",
  "migration",
  "unverified",
);

const fuzzStepArbitrary: fc.Arbitrary<CommandStepDescriptor> = fc.record({
  kind: fuzzCommandKindArbitrary,
  value: fc.nat({ max: 1_000_000 }),
  intendedValid: fc.constant(false),
  target: lifecycleStageArbitrary,
  generation: fc.constant("fuzz" as const),
  expectation: fc.constant("state_dependent" as const),
  contextProfile: contextProfileArbitrary,
  origin: commandOriginArbitrary,
  revisionMode: fc.constantFrom(
    "current" as const,
    "current" as const,
    "current" as const,
    "current" as const,
    "stale" as const,
  ),
  payloadValid: fc.boolean(),
  timeJitterSeconds: fc.integer({ min: 0, max: 59 }),
});

function guaranteedStep(
  kind: CommandStepKind,
  value: number,
): CommandStepDescriptor {
  return {
    kind,
    value,
    intendedValid: true,
    target: "workflow",
    generation: "guaranteed",
    expectation: "must_apply",
    contextProfile: "authorized",
    origin: "ui",
    revisionMode: "current",
    payloadValid: true,
    timeJitterSeconds: value % 60,
  };
}

interface ScenarioOptions {
  directionComplete: boolean;
  estimateSeconds: number;
  capacitySeconds: number;
  appetiteOffsetSeconds: number;
  evidenceState: "none" | "evidence" | "active_exception" | "expired_exception";
}

const scenarioStages: LifecycleStage[] = [
  "direction",
  "awaiting_bet",
  "planning",
  "executing",
  "validating",
  "closing",
  "closed",
];

function initialWorkspace(
  seed: number,
  options: ScenarioOptions,
): WorkspaceV2 {
  const workflowProjectId = `property-workflow:${seed}`;
  const workflowBrief = buildDirectionBrief({
    id: `property-workflow-brief:${seed}`,
    projectId: workflowProjectId,
    audienceAndProblem: "",
    successEvidence: "",
    appetiteSeconds: 0,
    validationMethod: "",
    firstScope: [],
    noGoOrKill: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  });

  const projects = [
    buildProjectV2({
      id: workflowProjectId,
      activeDirectionBriefId: workflowBrief.id,
      createdAt: workflowBrief.createdAt,
      updatedAt: workflowBrief.updatedAt,
    }),
  ];
  const directionBriefs = [workflowBrief];
  const bets: WorkspaceV2["bets"] = [];
  const planVersions: WorkspaceV2["planVersions"] = [];
  const workItems: WorkspaceV2["workItems"] = [];
  const dependencies: WorkspaceV2["dependencies"] = [];
  const evidence: WorkspaceV2["evidence"] = [];
  const exceptions: WorkspaceV2["exceptions"] = [];
  const closeDecisions: WorkspaceV2["closeDecisions"] = [];
  const appetiteStart = "2026-07-01T00:00:00.000Z";

  for (const stage of scenarioStages) {
    const projectId = `property-scenario:${stage}:${seed}`;
    const scopeId = `property-scenario-scope:${stage}:${seed}`;
    const appetiteEnd = new Date(
      Date.parse("2026-07-11T00:00:00.000Z") +
        (stage === "planning"
          ? options.appetiteOffsetSeconds
          : 864_000) * 1_000,
    ).toISOString();
    const appetiteSeconds =
      (Date.parse(appetiteEnd) - Date.parse(appetiteStart)) / 1_000;
    const briefIsComplete = stage !== "direction" || options.directionComplete;
    const brief = buildDirectionBrief({
      id: `property-scenario-brief:${stage}:${seed}`,
      projectId,
      audienceAndProblem: briefIsComplete ? "A bounded scenario problem." : "",
      successEvidence: briefIsComplete ? "An exact outcome is observed." : "",
      appetiteSeconds: briefIsComplete ? appetiteSeconds : 0,
      validationMethod: briefIsComplete ? "Inspect exact Evidence." : "",
      firstScope: briefIsComplete
        ? [{ id: scopeId, title: "Scenario scope", description: "Bounded." }]
        : [],
      noGoOrKill: briefIsComplete ? "Stop at the recorded boundary." : "",
      createdAt: appetiteStart,
      updatedAt: appetiteStart,
    });
    const hasBet = stage !== "direction" && stage !== "awaiting_bet";
    const bet = hasBet
      ? buildBetVersion({
          id: `property-scenario-bet:${stage}:${seed}`,
          projectId,
          briefId: brief.id,
          briefSnapshot: structuredClone(brief),
          committedScope: structuredClone(brief.firstScope),
          appetiteStart,
          appetiteEnd,
          actorId: "property-human",
          approvedAt: appetiteStart,
        })
      : undefined;
    const workItem = hasBet
      ? buildProjectWorkItem({
          id: `property-scenario-work:${stage}:${seed}`,
          projectId,
          betScopeId: scopeId,
          kind: "milestone",
          evidenceRequired: stage === "validating",
          durationSeconds: options.estimateSeconds,
          estimate: { mostLikelySeconds: options.estimateSeconds },
          percentComplete: 100,
          resultStatus: "completed",
          outcomeNote: "Historical scenario fixture is already complete.",
        })
      : undefined;
    const planId = `property-scenario-plan:${stage}:${seed}`;
    const hasPlan =
      workItem !== undefined &&
      ["executing", "validating", "closing", "closed"].includes(stage);
    projects.push(
      buildProjectV2({
        id: projectId,
        stage,
        activeDirectionBriefId: brief.id,
        ...(bet === undefined ? {} : { activeBetId: bet.id }),
        ...(hasPlan ? { activePlanVersionId: planId } : {}),
        createdAt: appetiteStart,
        updatedAt: appetiteStart,
      }),
    );
    directionBriefs.push(brief);
    if (bet !== undefined) bets.push(bet);
    if (workItem !== undefined) workItems.push(workItem);
    if (hasPlan && workItem !== undefined && bet !== undefined) {
      planVersions.push({
        id: planId,
        projectId,
        version: 1,
        betId: bet.id,
        workItemRevisions: { [workItem.id]: workItem.revision },
        dependencyRevisions: {},
        scopeMapping: { [workItem.id]: workItem.betScopeId },
        scheduleHash: `property-scenario-schedule:${stage}:${seed}`,
        capacityIndependentDates: {
          [workItem.id]: {
            start: appetiteStart,
            finish: new Date(
              Date.parse(appetiteStart) + options.estimateSeconds * 1_000,
            ).toISOString(),
          },
        },
        actorId: "property-human",
        createdAt: appetiteStart,
      });
    }
    if (stage === "planning" && workItem !== undefined) {
      const secondary = buildProjectWorkItem({
        id: `property-scenario-work-secondary:${seed}`,
        projectId,
        betScopeId: scopeId,
        title: "Secondary bounded work",
        durationSeconds: options.estimateSeconds,
        estimate: { mostLikelySeconds: options.estimateSeconds },
        percentComplete: 100,
        resultStatus: "completed",
        outcomeNote: "Historical secondary fixture is already complete.",
      });
      workItems.push(secondary);
      dependencies.push({
        id: `property-fixture-dependency:${seed}`,
        projectId,
        fromId: workItem.id,
        toId: secondary.id,
        type: "FS",
        lagSeconds: 0,
        revision: 1,
      });
    }
    if (stage === "validating" && workItem !== undefined) {
      if (options.evidenceState === "evidence") {
        evidence.push({
          id: `property-scenario-evidence:${seed}`,
          kind: "note",
          summary: "Exact scenario Evidence.",
          projectId,
          workItemId: workItem.id,
          createdAt: "2026-07-10T00:00:00.000Z",
          confidence: 1,
          tags: ["property"],
        });
      } else if (
        options.evidenceState === "active_exception" ||
        options.evidenceState === "expired_exception"
      ) {
        exceptions.push(
          buildExceptionRecord({
            id: `property-scenario-exception:${seed}`,
            projectId,
            requirementId: workItem.id,
            approvedBy: "property-human",
            createdAt: "2026-07-09T00:00:00.000Z",
            reviewAt: "2026-07-09T12:00:00.000Z",
            expiresAt:
              options.evidenceState === "active_exception"
                ? "2026-07-12T00:00:00.000Z"
                : "2026-07-10T23:59:59.000Z",
          }),
        );
      }
    }
    if (stage === "closed") {
      closeDecisions.push(
        buildCloseDecision({
          id: `property-scenario-close:${seed}`,
          projectId,
          actorId: "property-human",
          closedAt: "2026-07-10T00:00:00.000Z",
        }),
      );
    }
  }

  const actionEligibility = {
    singleSession: true,
    estimateSeconds: options.estimateSeconds,
    dependencyIds: [],
    requiresMilestoneEvidence: false,
    outcomeCount: 1,
    solutionKnown: true,
  };
  const linkedActionInboxIds = ["update", "complete", "promote"] as const;
  const inboxItems: WorkspaceV2["inboxItems"] = [
    buildInboxItem({
      id: `property-fixture-inbox-triage-action:${seed}`,
      sourceId: "property-source",
      actorId: "property-human",
      capturedAt: appetiteStart,
    }),
    buildInboxItem({
      id: `property-fixture-inbox-triage-project:${seed}`,
      sourceId: "property-source",
      actorId: "property-human",
      capturedAt: appetiteStart,
    }),
    ...linkedActionInboxIds.map((suffix) =>
      buildInboxItem({
        id: `property-fixture-inbox-${suffix}:${seed}`,
        sourceId: "property-source",
        actorId: "property-human",
        capturedAt: appetiteStart,
        triageStatus: "action",
        actionId: `property-fixture-action-${suffix}:${seed}`,
      }),
    ),
  ];
  const actions: WorkspaceV2["actions"] = linkedActionInboxIds.map(
    (suffix) => ({
      id: `property-fixture-action-${suffix}:${seed}`,
      inboxItemId: `property-fixture-inbox-${suffix}:${seed}`,
      title: `Property ${suffix} Action`,
      revision: 1,
      status: "open",
      eligibility: structuredClone(actionEligibility),
      attention: "medium",
      createdAt: appetiteStart,
      updatedAt: appetiteStart,
    }),
  );
  const planningProjectId = `property-scenario:planning:${seed}`;
  const planningWorkId = `property-scenario-work:planning:${seed}`;
  const validatingProjectId = `property-scenario:validating:${seed}`;
  const validatingWorkId = `property-scenario-work:validating:${seed}`;
  const fixtureReviewId = `property-fixture-review:${seed}`;
  const reviews: WorkspaceV2["reviews"] = [
    {
      id: fixtureReviewId,
      kind: "event",
      triggerKey: `hard_gate:${fixtureReviewId}`,
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [planningProjectId],
      affectedRecordIds: [planningWorkId],
      dueAt: "2026-07-11T00:44:00.000Z",
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ];
  exceptions.push(
    buildExceptionRecord({
      id: `property-fixture-exception:${seed}`,
      projectId: validatingProjectId,
      requirementId: validatingWorkId,
      approvedBy: "property-human",
      createdAt: "2026-07-10T00:00:00.000Z",
      reviewAt: "2026-07-11T12:00:00.000Z",
      expiresAt: "2026-07-12T00:00:00.000Z",
    }),
  );
  const capacityProfile = buildCapacityProfile({
    timeZone: "UTC",
    weeklyWindows: [{ weekday: 6, startMinute: 0, finishMinute: 1_440 }],
    dailyBudgets: [
      {
        weekday: 6,
        deepSeconds: options.capacitySeconds,
        mediumSeconds: options.capacitySeconds,
        shallowSeconds: options.capacitySeconds,
      },
    ],
    updatedAt: appetiteStart,
    updatedBy: "property-human",
  });
  const fixtureCommitmentId = `property-fixture-commitment:${seed}`;
  const dailyCommitments: WorkspaceV2["dailyCommitments"] = [
    {
      id: fixtureCommitmentId,
      localDate: "2026-07-10",
      version: 1,
      proposalHash: `property-fixture-proposal-hash:${seed}`,
      capacitySnapshot: structuredClone(capacityProfile),
      slots: [],
      actorId: "property-human",
      committedAt: "2026-07-10T00:00:00.000Z",
    },
  ];
  const replanProposals: WorkspaceV2["replanProposals"] = [
    {
      id: `property-fixture-replan:${seed}`,
      localDate: "2026-07-10",
      baseCommitmentId: fixtureCommitmentId,
      baseRevision: 0,
      reasonCodes: ["PROPERTY_STATE_CHANGE"],
      proposedSlots: [],
      proposalHash: `property-fixture-replan-hash:${seed}`,
      createdAt: "2026-07-10T00:01:00.000Z",
      createdBy: "property-human",
      status: "open",
    },
  ];
  const syncConflicts: WorkspaceV2["syncConflicts"] = [
    {
      id: `property-fixture-conflict:${seed}`,
      recordType: "review",
      recordId: fixtureReviewId,
      projectId: planningProjectId,
      commonAncestorHash: `property-ancestor:${seed}`,
      localValue: { side: "local" },
      remoteValue: { side: "remote" },
      openedAt: "2026-07-10T00:00:00.000Z",
    },
  ];

  return buildWorkspaceV2(`property-workspace:${seed}`, {
    capacityProfile,
    inboxItems,
    actions,
    projects,
    directionBriefs,
    bets,
    planVersions,
    workItems,
    dependencies,
    dailyCommitments,
    replanProposals,
    reviews,
    evidence,
    exceptions,
    syncConflicts,
    closeDecisions,
  });
}

const guaranteedPrefix = [
  guaranteedStep("capture_inbox", 1),
  guaranteedStep("configure_capacity", 2),
  guaranteedStep("update_project_metadata", 3),
  guaranteedStep("capture_inbox", 4),
  guaranteedStep("configure_capacity", 5),
  guaranteedStep("update_project_metadata", 6),
  guaranteedStep("capture_inbox", 7),
  guaranteedStep("configure_capacity", 8),
  guaranteedStep("update_project_metadata", 9),
] as const;

const guaranteedLifecycle = [
  guaranteedStep("complete_direction", 10),
  guaranteedStep("place_bet", 11),
  guaranteedStep("create_work_item", 12),
  guaranteedStep("commit_today", 13),
  guaranteedStep("request_validation", 14),
  guaranteedStep("satisfy_validation", 15),
  guaranteedStep("close_project", 16),
  guaranteedStep("archive_project", 17),
] as const;

const guaranteedSuffix = [
  guaranteedStep("capture_inbox", 18),
  guaranteedStep("configure_capacity", 19),
  guaranteedStep("capture_inbox", 20),
  guaranteedStep("configure_capacity", 21),
  guaranteedStep("capture_inbox", 22),
  guaranteedStep("configure_capacity", 23),
  guaranteedStep("capture_inbox", 24),
  guaranteedStep("configure_capacity", 25),
  guaranteedStep("capture_inbox", 26),
] as const;

const coverageTarget = {
  configure_capacity: "direction",
  capture_inbox: "direction",
  confirm_action_triage: "direction",
  confirm_project_triage: "direction",
  update_project_metadata: "planning",
  update_action: "direction",
  complete_action: "direction",
  promote_action_to_project: "direction",
  update_direction: "direction",
  place_bet: "awaiting_bet",
  create_work_item: "planning",
  update_work_item: "planning",
  upsert_dependency: "planning",
  remove_dependency: "planning",
  remove_work_item: "planning",
  capture_baseline: "planning",
  record_actual: "planning",
  complete_work_item: "planning",
  propose_replan: "planning",
  commit_today: "planning",
  accept_replan: "planning",
  attach_evidence: "validating",
  approve_evidence_exception: "validating",
  resolve_evidence_exception: "validating",
  request_validation: "executing",
  satisfy_validation: "validating",
  record_bet_boundary: "executing",
  mark_review_overdue: "planning",
  create_review: "planning",
  complete_review: "planning",
  open_sync_conflict: "planning",
  resolve_sync_conflict: "planning",
  close_project: "closing",
  abandon_project: "validating",
  archive_project: "closed",
  submit_command_proposal: "direction",
  accept_command_proposal: "direction",
  dismiss_command_proposal: "direction",
} as const satisfies Record<V2Command["type"], LifecycleStage>;

const coverageExpectedRejections = {
  configure_capacity: [],
  capture_inbox: [],
  confirm_action_triage: ["ACTION_INELIGIBLE"],
  confirm_project_triage: [],
  update_project_metadata: [],
  update_action: ["ACTION_PROMOTION_REQUIRED"],
  complete_action: [],
  promote_action_to_project: [],
  update_direction: [],
  place_bet: [],
  create_work_item: ["BET_EXPIRED"],
  update_work_item: ["BET_EXPIRED"],
  upsert_dependency: ["BET_EXPIRED"],
  remove_dependency: ["BET_EXPIRED"],
  remove_work_item: ["BET_EXPIRED"],
  capture_baseline: ["BET_EXPIRED"],
  record_actual: ["BET_EXPIRED"],
  complete_work_item: ["BET_EXPIRED"],
  propose_replan: ["INVALID_COMMAND", "REVISION_CONFLICT"],
  commit_today: ["INVALID_COMMAND", "BET_EXPIRED"],
  accept_replan: ["INVALID_COMMAND", "REVISION_CONFLICT"],
  attach_evidence: [],
  approve_evidence_exception: ["EVIDENCE_REQUIRED"],
  resolve_evidence_exception: [],
  // The stage-only scenario fixtures deliberately omit immutable lifecycle
  // receipts. Provenance-sensitive commands must fail closed there; the
  // guaranteed workflow above exercises their authoritative success path.
  request_validation: ["SYNC_CONFLICT"],
  satisfy_validation: [
    "EVIDENCE_REQUIRED",
    "EXCEPTION_EXPIRED",
    "SYNC_CONFLICT",
  ],
  record_bet_boundary: ["INVALID_COMMAND"],
  mark_review_overdue: ["HOLD_BLOCKS_COMMAND"],
  create_review: ["INVALID_COMMAND", "DUPLICATE_COMMAND"],
  complete_review: ["HOLD_BLOCKS_COMMAND"],
  // Raw property-generated opens cannot carry the opaque provenance token.
  // An incomplete draft fails shape validation; a complete raw draft must
  // still fail the conflict-authority gate.
  open_sync_conflict: ["INVALID_COMMAND", "SOURCE_NOT_AUTHORIZED"],
  resolve_sync_conflict: ["INVALID_COMMAND", "ENTITY_NOT_FOUND"],
  close_project: ["SYNC_CONFLICT"],
  abandon_project: ["ILLEGAL_LIFECYCLE_TRANSITION"],
  archive_project: [],
  submit_command_proposal: [],
  accept_command_proposal: [
    "INVALID_COMMAND",
    "REVISION_CONFLICT",
    "ILLEGAL_LIFECYCLE_TRANSITION",
    "HOLD_BLOCKS_COMMAND",
    "PROJECT_CLOSED",
    "ENTITY_NOT_FOUND",
  ],
  dismiss_command_proposal: ["REVISION_CONFLICT", "ENTITY_NOT_FOUND"],
} as const satisfies Record<V2Command["type"], readonly RejectionCode[]>;

function coverageStep(
  kind: V2Command["type"],
  value: number,
): CommandStepDescriptor {
  const expectedRejectionCodes = coverageExpectedRejections[kind];
  const systemCommand =
    kind === "record_bet_boundary" ||
    kind === "mark_review_overdue" ||
    kind === "create_review" ||
    kind === "open_sync_conflict";
  const agentProposalCommand = kind === "submit_command_proposal";
  return {
    kind,
    value,
    intendedValid: expectedRejectionCodes.length === 0,
    target: coverageTarget[kind],
    generation: "coverage",
    expectation:
      expectedRejectionCodes.length === 0 ? "must_apply" : "state_dependent",
    expectedRejectionCodes,
    contextProfile: systemCommand
      ? "system"
      : agentProposalCommand
        ? "agent"
        : "authorized",
    origin: systemCommand || agentProposalCommand ? "agent" : "ui",
    revisionMode: "current",
    payloadValid: true,
    timeJitterSeconds: value % 60,
  };
}

const publicCommandCoverage = publicCommandTypes.map((kind, index) =>
  coverageStep(kind, 100 + index),
);

export const commandSequenceArbitrary: fc.Arbitrary<CommandSequenceCase> =
  fc.record({
    seed: fc.nat({ max: 1_000_000 }),
    directionComplete: directionCompletenessArbitrary,
    estimateSeconds: actionEstimateSecondsArbitrary,
    capacitySeconds: capacitySecondsArbitrary,
    appetiteOffsetSeconds: appetiteOffsetSecondsArbitrary,
    evidenceState: evidenceStateArbitrary,
    invalidCommand: invalidCommandArbitrary,
    randomizedAcceptedValue: fc.nat({ max: 1_000_000 }),
    randomizedRejectedValue: fc.nat({ max: 1_000_000 }),
    fuzzSteps: fc.array(fuzzStepArbitrary, {
      minLength: 34,
      maxLength: 34,
    }),
  }).map(({
    seed,
    directionComplete,
    estimateSeconds,
    capacitySeconds,
    appetiteOffsetSeconds,
    evidenceState,
    invalidCommand,
    randomizedAcceptedValue,
    randomizedRejectedValue,
    fuzzSteps,
  }) => ({
    seed,
    baseTime: "2026-07-11T00:00:00.000Z",
    invalidCommand,
    actionEstimateSeconds: estimateSeconds,
    appetiteOffsetSeconds,
    initial: initialWorkspace(seed, {
      directionComplete,
      estimateSeconds,
      capacitySeconds,
      appetiteOffsetSeconds,
      evidenceState,
    }),
    steps: [
      ...guaranteedPrefix,
      ...guaranteedLifecycle,
      ...publicCommandCoverage,
      {
        kind: "capture_inbox",
        value: randomizedAcceptedValue,
        intendedValid: true,
        target: "direction",
        generation: "fuzz",
        expectation: "must_apply",
        contextProfile: "authorized",
        origin: "ui",
        revisionMode: "current",
        payloadValid: true,
        timeJitterSeconds: randomizedAcceptedValue % 60,
      },
      {
        kind: "invalid_command",
        value: randomizedRejectedValue,
        intendedValid: false,
        target: "direction",
        generation: "fuzz",
        expectation: "must_reject_invalid",
        expectedRejectionCodes: ["INVALID_COMMAND"],
        contextProfile: "authorized",
        origin: "ui",
        revisionMode: "current",
        payloadValid: false,
        timeJitterSeconds: randomizedRejectedValue % 60,
      },
      ...fuzzSteps,
      ...guaranteedSuffix,
    ],
  }));

function sourceForProfile(profile: ContextProfile): {
  actorKind: ActorKind;
  origin: CommandOrigin;
  verified: boolean;
  capabilities: SourceCapability[];
} {
  switch (profile) {
    case "authorized":
      return {
        actorKind: "human",
        origin: "ui",
        verified: true,
        capabilities: ["human_decision", "capture_inbox"],
      };
    case "agent":
      return {
        actorKind: "agent",
        origin: "agent",
        verified: true,
        capabilities: [
          "capture_inbox",
          "record_actual",
          "attach_evidence",
          "submit_proposal",
        ],
      };
    case "system":
      return {
        actorKind: "system",
        origin: "agent",
        verified: true,
        capabilities: ["system_time", "open_conflict"],
      };
    case "sync":
      return {
        actorKind: "human",
        origin: "sync",
        verified: true,
        capabilities: ["replay_receipt"],
      };
    case "import":
      return {
        actorKind: "human",
        origin: "import",
        verified: true,
        capabilities: ["import_portable"],
      };
    case "migration":
      return {
        actorKind: "human",
        origin: "migration",
        verified: true,
        capabilities: ["human_decision"],
      };
    case "unverified":
      return {
        actorKind: "human",
        origin: "ui",
        verified: false,
        capabilities: ["human_decision"],
      };
  }
}

function completeDirection(
  workspace: WorkspaceV2,
  projectId: string,
): DirectionBriefDraft {
  const project = workspace.projects.find(({ id }) => id === projectId)!;
  return {
    id: project.activeDirectionBriefId,
    projectId,
    audienceAndProblem: "A defined user has one bounded problem.",
    successEvidence: "The agreed outcome is observed.",
    appetiteSeconds: 86_400,
    validationMethod: "Inspect exact linked evidence.",
    firstScope: [
      {
        id: `property-scope:${projectId}`,
        title: "Committed property scope",
        description: "One bounded result.",
      },
    ],
    noGoOrKill: "Stop at the appetite boundary.",
    advancedNotes: "",
  };
}

function capacityCommand(
  now: string,
  valid: boolean,
): Extract<V2Command, { type: "configure_capacity" }> {
  return {
    type: "configure_capacity",
    profile: buildCapacityProfile({
      timeZone: valid ? "UTC" : "Not/A_Time_Zone",
      weeklyWindows: [{ weekday: 6, startMinute: 0, finishMinute: 1_440 }],
      dailyBudgets: [
        {
          weekday: 6,
          deepSeconds: 86_400,
          mediumSeconds: 86_400,
          shallowSeconds: 86_400,
        },
      ],
      updatedAt: now,
      updatedBy: "property-human",
    }),
  };
}

function propertyWorkItem(
  projectId: string,
  betScopeId: string,
  id: string,
): ProjectWorkItem {
  return {
    id,
    projectId,
    kind: "task",
    title: "Exercise the property command path",
    outline: "Keep the generated work bounded.",
    durationSeconds: 1_800,
    estimate: { mostLikelySeconds: 1_800 },
    assignmentIds: [],
    percentComplete: 0,
    revision: 1,
    betScopeId,
  };
}

interface MaterializerArgs {
  sequence: CommandSequenceCase;
  workspace: WorkspaceV2;
  step: CommandStepDescriptor;
  index: number;
  now: string;
  projectId: string;
  entityId: string;
  workItem: ProjectWorkItem | undefined;
  scopeId: string;
}

type CommandMaterializer<K extends V2Command["type"]> = (
  args: MaterializerArgs,
) => Extract<V2Command, { type: K }> | Promise<Extract<V2Command, { type: K }>>;

function actionEligibility(estimateSeconds: number) {
  return {
    singleSession: true,
    estimateSeconds,
    dependencyIds: [],
    requiresMilestoneEvidence: false,
    outcomeCount: 1,
    solutionKnown: true,
  };
}

const commandMaterializers = {
  configure_capacity: ({ now, step }: MaterializerArgs) =>
    capacityCommand(now, step.payloadValid),
  capture_inbox: ({ entityId, step }: MaterializerArgs) => ({
    type: "capture_inbox" as const,
    id: `inbox:${entityId}`,
    text: step.payloadValid ? "Captured property input" : "",
  }),
  confirm_action_triage: ({ sequence, entityId }: MaterializerArgs) => ({
    type: "confirm_action_triage" as const,
    inboxItemId: `property-fixture-inbox-triage-action:${sequence.seed}`,
    action: {
      id: `triaged-action:${entityId}`,
      title: "One bounded Action",
      eligibility: actionEligibility(sequence.actionEstimateSeconds),
      attention: "medium" as const,
    },
  }),
  confirm_project_triage: ({ sequence, entityId }: MaterializerArgs) => ({
    type: "confirm_project_triage" as const,
    inboxItemId: `property-fixture-inbox-triage-project:${sequence.seed}`,
    eligibility: actionEligibility(sequence.actionEstimateSeconds),
    project: {
      id: `triaged-project:${entityId}`,
      name: "Triaged Property Project",
      priority: 1,
      notes: "Created through deterministic Project triage.",
    },
  }),
  update_project_metadata: ({ projectId, step }: MaterializerArgs) => ({
    type: "update_project_metadata" as const,
    projectId,
    name: `Property Project ${step.value}`,
    priority: step.value % 10,
  }),
  update_action: ({ sequence, step }: MaterializerArgs) => ({
    type: "update_action" as const,
    actionId: `property-fixture-action-update:${sequence.seed}`,
    patch: { title: `Updated Action ${step.value}` },
  }),
  complete_action: ({ sequence }: MaterializerArgs) => ({
    type: "complete_action" as const,
    actionId: `property-fixture-action-complete:${sequence.seed}`,
    actualSeconds: 300,
    resultStatus: "completed" as const,
    outcomeNote: "The bounded Action outcome was observed.",
  }),
  promote_action_to_project: ({ sequence, entityId }: MaterializerArgs) => ({
    type: "promote_action_to_project" as const,
    actionId: `property-fixture-action-promote:${sequence.seed}`,
    eligibility: actionEligibility(7_201),
    project: {
      id: `promoted-project:${entityId}`,
      name: "Promoted Property Project",
      priority: 1,
      notes: "Crossed the deterministic two-hour boundary.",
    },
  }),
  update_direction: ({ workspace, projectId, step }: MaterializerArgs) => {
    const brief = completeDirection(workspace, projectId);
    if (!step.payloadValid) brief.successEvidence = "";
    return { type: "update_direction" as const, projectId, brief };
  },
  place_bet: ({ sequence, projectId, entityId, now, step }: MaterializerArgs) => ({
    type: "place_bet" as const,
    projectId,
    betId: `bet:${entityId}`,
    start: step.payloadValid ? now : sequence.baseTime,
  }),
  create_work_item: ({ projectId, entityId, scopeId, step }: MaterializerArgs) => ({
    type: "create_work_item" as const,
    projectId,
    workItem: propertyWorkItem(
      projectId,
      step.payloadValid ? scopeId : `outside:${scopeId}`,
      `work:${entityId}`,
    ),
  }),
  update_work_item: ({ projectId, entityId, workItem, scopeId, step }: MaterializerArgs) => ({
    type: "update_work_item" as const,
    projectId,
    workItemId: workItem?.id ?? `missing-work:${entityId}`,
    patch: {
      title: `Updated ${step.value}`,
      ...(step.payloadValid ? {} : { betScopeId: `outside:${scopeId}` }),
    },
  }),
  upsert_dependency: ({ sequence, workspace, projectId }: MaterializerArgs) => {
    const existing = workspace.dependencies.find(
      ({ id }) => id === `property-fixture-dependency:${sequence.seed}`,
    );
    const projectItems = workspace.workItems.filter(
      ({ projectId: ownerId }) => ownerId === projectId,
    );
    return {
      type: "upsert_dependency" as const,
      dependency: existing === undefined
        ? {
            id: `property-fixture-dependency:${sequence.seed}`,
            projectId,
            fromId: projectItems[0]?.id ?? `missing-from:${sequence.seed}`,
            toId: projectItems[1]?.id ?? `missing-to:${sequence.seed}`,
            type: "FS" as const,
            lagSeconds: 0,
            revision: 1,
          }
        : { ...structuredClone(existing), revision: existing.revision },
    };
  },
  remove_dependency: ({ sequence }: MaterializerArgs) => ({
    type: "remove_dependency" as const,
    dependencyId: `property-fixture-dependency:${sequence.seed}`,
  }),
  remove_work_item: ({ sequence, projectId }: MaterializerArgs) => ({
    type: "remove_work_item" as const,
    projectId,
    workItemId: `property-scenario-work-secondary:${sequence.seed}`,
  }),
  capture_baseline: ({ projectId, entityId, workItem, now }: MaterializerArgs) => ({
    type: "capture_baseline" as const,
    baseline: {
      id: `baseline:${entityId}`,
      projectId,
      name: "Property planning baseline",
      capturedAt: now,
      plannedStartByItem: workItem === undefined ? {} : { [workItem.id]: now },
      plannedFinishByItem: workItem === undefined
        ? {}
        : {
            [workItem.id]: new Date(Date.parse(now) + 1_800_000).toISOString(),
          },
      plannedWorkSecondsByItem: workItem === undefined
        ? {}
        : { [workItem.id]: 1_800 },
    },
  }),
  complete_work_item: ({ projectId, entityId, workItem, step }: MaterializerArgs) => ({
    type: "complete_work_item" as const,
    projectId,
    workItemId: workItem?.id ?? `missing-work:${entityId}`,
    resultStatus: "completed" as const,
    outcomeNote: step.payloadValid ? "Observed result" : "",
  }),
  propose_replan: ({ sequence, workspace, entityId, now }: MaterializerArgs) => ({
    type: "propose_replan" as const,
    proposal: {
      id: `replan:${entityId}`,
      localDate: now.slice(0, 10),
      baseCommitmentId: `property-fixture-commitment:${sequence.seed}`,
      baseRevision: workspace.revision,
      reasonCodes: ["PROPERTY_STATE_CHANGE"],
      proposedSlots: [],
      proposalHash: `replan-hash:${entityId}`,
      createdAt: now,
      createdBy: "property-human",
      status: "open" as const,
    },
  }),
  commit_today: async ({ workspace, entityId, now }: MaterializerArgs) => {
    const localDate = now.slice(0, 10);
    let proposal: Awaited<ReturnType<typeof generateTodayProposal>> | undefined;
    try {
      proposal = await generateTodayProposal(workspace, localDate, now);
    } catch {
      proposal = undefined;
    }
    return {
      type: "commit_today" as const,
      commitment: {
        id: `commitment:${entityId}`,
        localDate,
        workspaceRevision: workspace.revision,
        generatedAt: proposal?.generatedAt ?? now,
        proposalHash: proposal?.proposalHash ?? `unavailable-proposal:${entityId}`,
        slots: structuredClone(proposal?.slots ?? []),
      },
    };
  },
  accept_replan: ({ sequence, entityId }: MaterializerArgs) => ({
    type: "accept_replan" as const,
    proposalId: `property-fixture-replan:${sequence.seed}`,
    commitmentId: `accepted-commitment:${entityId}`,
  }),
  record_actual: ({ entityId, workItem, step, now }: MaterializerArgs) => ({
    type: "record_actual" as const,
    actual: {
      id: `actual:${entityId}`,
      revision: 1,
      target: {
        kind: "work_item" as const,
        workItemId: workItem?.id ?? `missing-work:${entityId}`,
      },
      actualWorkSeconds: step.payloadValid ? 300 : -1,
      remainingWorkSeconds: 1_500,
      actualCost: 0,
      recordedAt: now,
    },
  }),
  attach_evidence: ({ entityId, projectId, workItem, step, now }: MaterializerArgs) => {
    const evidence: Evidence = {
      id: `evidence:${entityId}`,
      kind: "note",
      summary: step.payloadValid ? "Property evidence" : "",
      projectId,
      ...(workItem === undefined ? {} : { workItemId: workItem.id }),
      createdAt: now,
      confidence: step.payloadValid ? 1 : 2,
      tags: ["property"],
    };
    return { type: "attach_evidence" as const, evidence };
  },
  approve_evidence_exception: ({ entityId, projectId, workItem, step, now }: MaterializerArgs) => ({
    type: "approve_evidence_exception" as const,
    exception: {
      id: `exception:${entityId}`,
      projectId,
      requirementId: workItem?.id ?? `missing-work:${entityId}`,
      rationale: step.payloadValid ? "External dependency" : "",
      knownConsequence: "Evidence will arrive later.",
      reviewAt: new Date(Date.parse(now) + 60_000).toISOString(),
      expiresAt: new Date(Date.parse(now) + 120_000).toISOString(),
    },
  }),
  resolve_evidence_exception: ({ sequence }: MaterializerArgs) => ({
    type: "resolve_evidence_exception" as const,
    exceptionId: `property-fixture-exception:${sequence.seed}`,
    resolution: "The bounded exception received exact Evidence.",
  }),
  request_validation: ({ projectId }: MaterializerArgs) => ({
    type: "request_validation" as const,
    projectId,
  }),
  satisfy_validation: ({ projectId }: MaterializerArgs) => ({
    type: "satisfy_validation" as const,
    projectId,
  }),
  record_bet_boundary: ({ workspace, projectId }: MaterializerArgs) => {
    const project = workspace.projects.find(({ id }) => id === projectId);
    const bet = workspace.bets.find(({ id }) => id === project?.activeBetId);
    return {
      type: "record_bet_boundary" as const,
      projectId,
      boundary: "midpoint" as const,
      triggerKey: `${bet?.id ?? `missing-bet:${projectId}`}:midpoint`,
    };
  },
  mark_review_overdue: ({ sequence }: MaterializerArgs) => ({
    type: "mark_review_overdue" as const,
    reviewId: `property-fixture-review:${sequence.seed}`,
    triggerKey: `property-fixture-review:${sequence.seed}:overdue`,
  }),
  create_review: ({ projectId, entityId, workItem, now }: MaterializerArgs) => ({
    type: "create_review" as const,
    review: {
      id: `review:${entityId}`,
      kind: "event" as const,
      triggerKey: `hard_gate:${entityId}`,
      triggerType: "hard_gate" as const,
      affectedProjectIds: [projectId],
      affectedRecordIds: workItem === undefined ? [projectId] : [workItem.id],
      dueAt: now,
    },
  }),
  complete_review: ({ sequence }: MaterializerArgs) => ({
    type: "complete_review" as const,
    reviewId: `property-fixture-review:${sequence.seed}`,
    conclusion: {
      summary: "The generated Review reached an explicit human conclusion.",
      decisionCodes: ["continue"],
      followUpCommandIds: [],
    },
  }),
  open_sync_conflict: ({ workspace, projectId, entityId }: MaterializerArgs) => {
    const project = workspace.projects.find(({ id }) => id === projectId);
    const bet = workspace.bets.find(({ id }) => id === project?.activeBetId);
    return {
      type: "open_sync_conflict" as const,
      conflict: {
        id: `conflict:${entityId}`,
        recordType: "bet" as const,
        recordId: bet?.id ?? `missing-bet:${projectId}`,
        commonAncestorHash: `ancestor:${entityId}`,
        remoteValue: structuredClone(
          bet ?? { id: `missing-bet:${projectId}` },
        ) as unknown as JsonValue,
      },
    };
  },
  resolve_sync_conflict: ({ sequence }: MaterializerArgs) => ({
    type: "resolve_sync_conflict" as const,
    reviewId: `property-fixture-review:${sequence.seed}`,
    resolution: {
      conflictId: `property-fixture-conflict:${sequence.seed}`,
      retainedVersion: "local" as const,
      retainedValue: { id: `property-fixture-record:${sequence.seed}` },
      rationale: "The local Review is the authoritative branch.",
    },
  }),
  close_project: ({ entityId, projectId, step }: MaterializerArgs) => ({
    type: "close_project" as const,
    projectId,
    decision: {
      id: `close:${entityId}`,
      projectId,
      successComparison: step.payloadValid ? "Compared with success." : "",
      outcome: "achieved" as const,
      keyLearning: "The lifecycle remained enforceable.",
      unfinishedDisposition: "historical_incomplete" as const,
    },
  }),
  abandon_project: ({ entityId, projectId }: MaterializerArgs) => ({
    type: "abandon_project" as const,
    projectId,
    decision: {
      id: `abandon:${entityId}`,
      projectId,
      successComparison: "The target Evidence was not achieved.",
      outcome: "abandoned" as const,
      keyLearning: "The premise did not survive the bounded appetite.",
      unfinishedDisposition: "historical_incomplete" as const,
    },
  }),
  archive_project: ({ projectId, step }: MaterializerArgs) => ({
    type: "archive_project" as const,
    projectId,
    archived: step.value % 2 === 1,
  }),
  submit_command_proposal: ({
    workspace,
    projectId,
    entityId,
    step,
  }: MaterializerArgs) => ({
    type: "submit_command_proposal" as const,
    proposalId: `command-proposal:${entityId}`,
    command: {
      type: "update_direction" as const,
      projectId,
      brief: completeDirection(workspace, projectId),
    },
    rationale: step.payloadValid
      ? "The Agent found a bounded Direction update for human review."
      : "",
  }),
  accept_command_proposal: ({ workspace, entityId }: MaterializerArgs) => ({
    type: "accept_command_proposal" as const,
    proposalId:
      workspace.commandProposals.find(({ status }) => status === "open")?.id ??
      workspace.commandProposals[0]?.id ??
      `missing-command-proposal:${entityId}`,
  }),
  dismiss_command_proposal: ({ workspace, entityId }: MaterializerArgs) => ({
    type: "dismiss_command_proposal" as const,
    proposalId:
      workspace.commandProposals.find(({ status }) => status === "open")?.id ??
      workspace.commandProposals[0]?.id ??
      `missing-command-proposal:${entityId}`,
  }),
} satisfies {
  [K in V2Command["type"]]: CommandMaterializer<K>;
};

async function commandForStep(
  sequence: CommandSequenceCase,
  workspace: WorkspaceV2,
  step: CommandStepDescriptor,
  index: number,
  now: string,
): Promise<V2Command> {
  const targetProjectId =
    step.target === "workflow"
      ? `property-workflow:${sequence.seed}`
      : `property-scenario:${step.target}:${sequence.seed}`;
  const project = workspace.projects.find(({ id }) => id === targetProjectId)!;
  const projectId = project.id;
  const entityId = `property:${sequence.seed}:${index}:${step.value}`;
  const projectWorkItems = workspace.workItems.filter(
    ({ projectId: ownerId }) => ownerId === projectId,
  );
  const workItem =
    projectWorkItems.find(({ resultStatus }) => resultStatus === undefined) ??
    projectWorkItems[0];
  const activeBet = workspace.bets.find(({ id }) => id === project.activeBetId);
  const scopeId = activeBet?.committedScope[0]?.id ?? `missing-scope:${entityId}`;

  if (step.kind === "complete_direction") {
    return {
      type: "update_direction",
      projectId,
      brief: completeDirection(workspace, projectId),
    };
  }
  if (step.kind === "invalid_command") {
    return structuredClone(sequence.invalidCommand);
  }
  const args: MaterializerArgs = {
    sequence,
    workspace,
    step,
    index,
    now,
    projectId,
    entityId,
    workItem,
    scopeId,
  };
  const materializer = commandMaterializers[step.kind] as CommandMaterializer<
    V2Command["type"]
  >;
  return materializer(args);
}

export async function materializeCommandEnvelope(
  sequence: CommandSequenceCase,
  workspace: WorkspaceV2,
  step: CommandStepDescriptor,
  index: number,
): Promise<MaterializedCommandEnvelope> {
  const now = new Date(
    Date.parse(sequence.baseTime) +
      (index + 1) * 60_000 +
      step.timeJitterSeconds * 1_000,
  ).toISOString();
  const source = sourceForProfile(step.contextProfile);
  const command = await commandForStep(sequence, workspace, step, index, now);
  return {
    command,
    context: {
      commandId: `property-command:${sequence.seed}:${index}`,
      expectedRevision:
        step.revisionMode === "current"
          ? workspace.revision
          : workspace.revision + 1,
      actorId: `property-${source.actorKind}`,
      actorKind: source.actorKind,
      origin: step.origin,
      source: {
        sourceId: `property-source:${step.contextProfile}`,
        verified: source.verified,
        capabilities: source.capabilities,
      },
      now,
    },
  };
}
