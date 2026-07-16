import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  executeCommand,
  type V2Command,
} from "../domain/commands";
import { applyCommandHandler } from "../domain/commandHandlers";
import { validateWorkspaceInvariants } from "../domain/invariants";
import {
  actionEstimateSecondsArbitrary,
  actorKindArbitrary,
  capacitySecondsArbitrary,
  commandSequenceArbitrary,
  materializeCommandEnvelope,
  projectHoldArbitrary,
  publicCommandTypes,
} from "./commandArbitraries";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildCloseDecision,
  buildCommandContext,
  buildDirectionBrief,
  buildExceptionRecord,
  buildInboxItem,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "./builders";
import { buildReplanProposal, generateTodayProposal } from "../domain/today";
import type {
  ActorKind,
  LifecycleStage,
  ProjectHoldState,
  WorkspaceV2,
} from "../domain/types";

const PROPERTY_RUNS = 500;
const COMMANDS_PER_RUN = 100;

type PropertyKey =
  | "main"
  | "handler_freeze"
  | "action_boundary"
  | "no_bet"
  | "capacity"
  | "closed"
  | "authority"
  | "exception"
  | "hold";

// Replay one failure without applying its shrink path to unrelated properties:
// FC_TEST=main FC_SEED=123 FC_PATH='0:1' bunx vitest run ... -t 'keeps every accepted state'
function replayParameters(
  testKey: PropertyKey,
  numRuns = PROPERTY_RUNS,
): fc.Parameters<unknown> {
  const seed = process.env.FC_SEED;
  const path = process.env.FC_TEST === testKey ? process.env.FC_PATH : undefined;
  return {
    numRuns,
    ...(seed === undefined ? {} : { seed: Number(seed) }),
    ...(path === undefined ? {} : { path }),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function archiveImmutableWorkspaceContent(workspace: WorkspaceV2) {
  const snapshot = structuredClone(workspace);
  const {
    revision: _revision,
    commandReceipts: _commandReceipts,
    visibility: _visibility,
    ...immutableContent
  } = snapshot;
  return immutableContent;
}

function expectValidAppliedState(
  result: Awaited<ReturnType<typeof executeCommand>>,
  before: WorkspaceV2,
  now: string,
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(validateWorkspaceInvariants(result.workspace, now, before)).toEqual(
    [],
  );
}

function activeProjectWorkspace(
  seed: number,
  options: {
    stage?: LifecycleStage;
    durationSeconds?: number;
    evidenceRequired?: boolean;
    capacitySeconds?: number;
    holds?: ProjectHoldState[];
    exceptions?: WorkspaceV2["exceptions"];
    evidence?: WorkspaceV2["evidence"];
  } = {},
): WorkspaceV2 {
  const projectId = `active-project:${seed}`;
  const scopeId = `active-scope:${seed}`;
  const brief = buildDirectionBrief({
    id: `active-brief:${seed}`,
    projectId,
    appetiteSeconds: 864_000,
    firstScope: [
      { id: scopeId, title: "Bounded", description: "Exact scope" },
    ],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  const bet = buildBetVersion({
    id: `active-bet:${seed}`,
    projectId,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: "2026-07-10T00:00:00.000Z",
    appetiteEnd: "2026-07-20T00:00:00.000Z",
    actorId: "property-human",
    approvedAt: "2026-07-10T00:00:00.000Z",
  });
  const workItem = buildProjectWorkItem({
    id: `active-work:${seed}`,
    projectId,
    betScopeId: scopeId,
    durationSeconds: options.durationSeconds ?? 1_800,
    estimate: {
      mostLikelySeconds: options.durationSeconds ?? 1_800,
    },
    ...(options.evidenceRequired
      ? { kind: "milestone" as const, evidenceRequired: true }
      : {}),
  });
  const planId = `active-plan:${seed}`;
  const stage = options.stage ?? "planning";
  const hasExistingPlan = ["executing", "validating", "closing", "closed"]
    .includes(stage);
  const project = buildProjectV2({
    id: projectId,
    stage,
    activeDirectionBriefId: brief.id,
    activeBetId: bet.id,
    ...(hasExistingPlan ? { activePlanVersionId: planId } : {}),
    holds: options.holds ?? [],
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  return buildWorkspaceV2(`active-workspace:${seed}`, {
    capacityProfile:
      options.capacitySeconds === undefined
        ? undefined
        : buildCapacityProfile({
            timeZone: "UTC",
            weeklyWindows: [
              { weekday: 6, startMinute: 0, finishMinute: 1_440 },
            ],
            dailyBudgets: [
              {
                weekday: 6,
                deepSeconds: options.capacitySeconds,
                mediumSeconds: options.capacitySeconds,
                shallowSeconds: options.capacitySeconds,
              },
            ],
            updatedAt: "2026-07-10T00:00:00.000Z",
            updatedBy: "property-human",
          }),
    projects: [project],
    directionBriefs: [brief],
    bets: [bet],
    planVersions: hasExistingPlan
      ? [{
        id: planId,
        projectId,
        version: 1,
        betId: bet.id,
        workItemRevisions: { [workItem.id]: workItem.revision },
        dependencyRevisions: {},
        scopeMapping: { [workItem.id]: scopeId },
        scheduleHash: `active-schedule-hash:${seed}`,
        capacityIndependentDates: {
          [workItem.id]: {
            start: "2026-07-10T00:00:00.000Z",
            finish: "2026-07-10T00:30:00.000Z",
          },
        },
        actorId: "property-human",
        createdAt: "2026-07-10T00:00:00.000Z",
        },
      ]
      : [],
    workItems: [workItem],
    exceptions: options.exceptions ?? [],
    evidence: options.evidence ?? [],
    closeDecisions:
      stage === "closed"
        ? [
            buildCloseDecision({
              id: `active-close:${seed}`,
              projectId,
              actorId: "property-human",
              closedAt: "2026-07-11T00:00:00.000Z",
            }),
          ]
        : [],
  });
}

type HumanOnlyApproval =
  | "place_bet"
  | "commit_today"
  | "accept_replan"
  | "approve_evidence_exception"
  | "complete_review"
  | "close_project"
  | "abandon_project";

async function appliedWorkspace(
  workspace: WorkspaceV2,
  command: V2Command,
  context: ReturnType<typeof buildCommandContext>,
): Promise<WorkspaceV2> {
  const result = await executeCommand(workspace, command, context);
  if (!result.ok) {
    throw new Error(
      `Fixture command ${command.type} rejected: ${result.rejection.code}`,
    );
  }
  return result.workspace;
}

async function humanOnlyApprovalFixture(
  seed: number,
  approval: HumanOnlyApproval,
): Promise<{ workspace: WorkspaceV2; command: V2Command; now: string }> {
  const now = "2026-07-11T01:00:00.000Z";
  const projectId = `active-project:${seed}`;
  if (approval === "place_bet") {
    const workspace = activeProjectWorkspace(seed);
    workspace.projects[0].stage = "awaiting_bet";
    delete workspace.projects[0].activeBetId;
    delete workspace.projects[0].activePlanVersionId;
    workspace.bets = [];
    workspace.planVersions = [];
    return {
      workspace,
      command: {
        type: "place_bet",
        projectId,
        betId: `human-only-bet:${seed}`,
        start: now,
      },
      now,
    };
  }
  if (approval === "commit_today") {
    const workspace = activeProjectWorkspace(seed, { capacitySeconds: 3_600 });
    const proposal = await generateTodayProposal(workspace, "2026-07-11", now);
    return {
      workspace,
      command: {
        type: "commit_today",
        commitment: {
          id: `human-only-commitment:${seed}`,
          localDate: proposal.localDate,
          workspaceRevision: proposal.workspaceRevision,
          generatedAt: proposal.generatedAt,
          proposalHash: proposal.proposalHash,
          slots: structuredClone(proposal.slots),
        },
      },
      now,
    };
  }
  if (approval === "accept_replan") {
    let workspace = activeProjectWorkspace(seed, { capacitySeconds: 3_600 });
    const proposal = await generateTodayProposal(workspace, "2026-07-11", now);
    workspace = await appliedWorkspace(
      workspace,
      {
        type: "commit_today",
        commitment: {
          id: `replan-base-commitment:${seed}`,
          localDate: proposal.localDate,
          workspaceRevision: proposal.workspaceRevision,
          generatedAt: proposal.generatedAt,
          proposalHash: proposal.proposalHash,
          slots: structuredClone(proposal.slots),
        },
      },
      buildCommandContext({
        commandId: `replan-base-command:${seed}`,
        expectedRevision: workspace.revision,
        now,
      }),
    );
    const actualAt = "2026-07-11T01:01:00.000Z";
    workspace = await appliedWorkspace(
      workspace,
      {
        type: "record_actual",
        actual: {
          id: `replan-actual:${seed}`,
          revision: 1,
          target: { kind: "work_item", workItemId: `active-work:${seed}` },
          actualWorkSeconds: 60,
          remainingWorkSeconds: 900,
          actualCost: 0,
          recordedAt: actualAt,
        },
      },
      buildCommandContext({
        commandId: `replan-actual-command:${seed}`,
        expectedRevision: workspace.revision,
        now: actualAt,
      }),
    );
    const proposedAt = "2026-07-11T01:02:00.000Z";
    const replan = await buildReplanProposal(workspace, {
      id: `replan-proposal:${seed}`,
      localDate: "2026-07-11",
      reasonCodes: ["ACTUAL_CHANGED"],
      createdAt: proposedAt,
      createdBy: "property-human",
    });
    workspace = await appliedWorkspace(
      workspace,
      { type: "propose_replan", proposal: replan },
      buildCommandContext({
        commandId: `replan-propose-command:${seed}`,
        expectedRevision: workspace.revision,
        now: proposedAt,
      }),
    );
    return {
      workspace,
      command: {
        type: "accept_replan",
        proposalId: replan.id,
        commitmentId: `replan-accepted-commitment:${seed}`,
      },
      now: "2026-07-11T01:03:00.000Z",
    };
  }
  if (approval === "approve_evidence_exception") {
    const workspace = activeProjectWorkspace(seed, {
      stage: "validating",
      evidenceRequired: true,
    });
    return {
      workspace,
      command: {
        type: "approve_evidence_exception",
        exception: {
          id: `human-only-exception:${seed}`,
          projectId,
          requirementId: `active-work:${seed}`,
          rationale: "A bounded external dependency delays Evidence.",
          knownConsequence: "Validation must be revisited before expiry.",
          reviewAt: "2026-07-11T02:00:00.000Z",
          expiresAt: "2026-07-11T03:00:00.000Z",
        },
      },
      now,
    };
  }
  if (approval === "complete_review") {
    const workspace = activeProjectWorkspace(seed);
    workspace.reviews.push({
      id: `human-only-review:${seed}`,
      kind: "event",
      triggerKey: `hard_gate:human-only-review:${seed}`,
      triggerType: "hard_gate",
      status: "open",
      affectedProjectIds: [projectId],
      affectedRecordIds: [projectId],
      dueAt: "2026-07-11T02:00:00.000Z",
      createdAt: "2026-07-11T00:00:00.000Z",
    });
    return {
      workspace,
      command: {
        type: "complete_review",
        reviewId: `human-only-review:${seed}`,
        conclusion: {
          summary: "The explicit Review decision is human-owned.",
          decisionCodes: ["continue"],
          followUpCommandIds: [],
        },
      },
      now,
    };
  }
  if (approval === "close_project") {
    return {
      workspace: activeProjectWorkspace(seed, { stage: "closing" }),
      command: {
        type: "close_project",
        projectId,
        decision: {
          id: `human-only-close:${seed}`,
          projectId,
          successComparison: "Compared with the Direction success evidence.",
          outcome: "achieved",
          keyLearning: "Human approval stays explicit.",
          unfinishedDisposition: "historical_incomplete",
        },
      },
      now,
    };
  }

  let workspace = activeProjectWorkspace(seed, { stage: "executing" });
  const boundaryAt = workspace.bets[0].appetiteEnd;
  workspace = await appliedWorkspace(
    workspace,
    {
      type: "record_bet_boundary",
      projectId,
      boundary: "expired",
      triggerKey: `${workspace.bets[0].id}:expired`,
    },
    buildCommandContext({
      commandId: `human-only-boundary:${seed}`,
      expectedRevision: workspace.revision,
      actorId: "property-system",
      actorKind: "system",
      origin: "agent",
      source: {
        sourceId: `property-clock:${seed}`,
        verified: true,
        capabilities: ["system_time"],
      },
      now: boundaryAt,
    }),
  );
  return {
    workspace,
    command: {
      type: "abandon_project",
      projectId,
      decision: {
        id: `human-only-abandon:${seed}`,
        projectId,
        successComparison: "The target Evidence was not achieved.",
        outcome: "abandoned",
        keyLearning: "The premise was weaker than expected.",
        unfinishedDisposition: "historical_incomplete",
      },
    },
    now: boundaryAt,
  };
}

describe("arbitrary V2 command sequences", () => {
  it(
    "keeps every accepted state valid and every rejection atomic across 50k commands",
    async () => {
      const appetiteSigns = new Set<"negative" | "zero" | "positive">();
      await fc.assert(
        fc.asyncProperty(commandSequenceArbitrary, async (sequence) => {
          expect(sequence.steps).toHaveLength(COMMANDS_PER_RUN);
          let workspace = deepFreeze(structuredClone(sequence.initial));
          expect(
            validateWorkspaceInvariants(workspace, sequence.baseTime),
          ).toEqual([]);
          let previousTime = Date.parse(sequence.baseTime);
          let intendedValidApplied = 0;
          const appliedKinds = new Set<string>();
          const fuzzStagesBefore = new Set<LifecycleStage>();
          const coveredCommandKinds = new Set<V2Command["type"]>();
          let invalidAttempts = 0;
          let invalidRejections = 0;
          let randomizedFuzzApplied = 0;
          let randomizedFuzzRejected = 0;
          appetiteSigns.add(
            sequence.appetiteOffsetSeconds < 0
              ? "negative"
              : sequence.appetiteOffsetSeconds > 0
                ? "positive"
                : "zero",
          );
          const planningBet = workspace.bets.find(
            ({ projectId }) =>
              projectId === `property-scenario:planning:${sequence.seed}`,
          );
          expect(planningBet?.appetiteEnd).toBe(
            new Date(
              Date.parse(sequence.baseTime) +
                sequence.appetiteOffsetSeconds * 1_000,
            ).toISOString(),
          );

          for (const [index, step] of sequence.steps.entries()) {
            if (step.generation === "coverage" && step.kind !== "invalid_command" && step.kind !== "complete_direction") {
              coveredCommandKinds.add(step.kind);
            }
            if (step.target !== "workflow") {
              const target = workspace.projects.find(
                ({ id }) =>
                  id === `property-scenario:${step.target}:${sequence.seed}`,
              );
              expect(target).toBeDefined();
              if (target !== undefined) fuzzStagesBefore.add(target.stage);
            }
            if (step.kind === "invalid_command") invalidAttempts += 1;
            const envelope = await materializeCommandEnvelope(
              sequence,
              workspace,
              step,
              index,
            );
            const command = deepFreeze(envelope.command);
            const context = deepFreeze(envelope.context);
            const before = workspace;
            const beforeSnapshot = structuredClone(before);
            const beforeReceipts = before.commandReceipts;
            const now = Date.parse(context.now);
            expect(now).toBeGreaterThan(previousTime);
            previousTime = now;

            const result = await executeCommand(before, command, context);

            if (step.expectation === "must_apply") {
              expect(
                result.ok,
                result.ok
                  ? undefined
                  : `${index}:${step.kind}:${result.rejection.code}:${result.rejection.reason}`,
              ).toBe(true);
            } else if (step.expectation === "must_reject_invalid") {
              expect(result.ok).toBe(false);
              if (!result.ok) expect(result.rejection.code).toBe("INVALID_COMMAND");
            }
            if (!result.ok && step.expectedRejectionCodes !== undefined) {
              expect(
                step.expectedRejectionCodes,
                `${index}:${step.kind}:${result.rejection.code}:${result.rejection.reason}`,
              ).toContain(result.rejection.code);
            }

            expect(before).toEqual(beforeSnapshot);
            if (result.ok) {
              if (step.generation === "fuzz") randomizedFuzzApplied += 1;
              expect(Object.isFrozen(result.workspace)).toBe(false);
              expect(Object.isFrozen(result.workspace.projects)).toBe(false);
              expect(result.receipt).toEqual({
                id: context.commandId,
                commandId: context.commandId,
                commandType: command.type,
                baseRevision: before.revision,
                revision: before.revision + 1,
                payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                actorId: context.actorId,
                actorKind: context.actorKind,
                origin: context.origin,
                source: context.source,
                status: "applied",
                createdAt: context.now,
                diff: result.receipt.diff,
              });
              expect(result.workspace).not.toBe(before);
              expect(result.workspace.revision).toBe(before.revision + 1);
              expect(result.workspace.commandReceipts).toHaveLength(
                beforeReceipts.length + 1,
              );
              expect(
                result.workspace.commandReceipts[
                  result.workspace.commandReceipts.length - 1
                ],
              ).toEqual(result.receipt);
              expect(
                validateWorkspaceInvariants(
                  result.workspace,
                  context.now,
                  before,
                ),
              ).toEqual([]);
              if (step.intendedValid) {
                intendedValidApplied += 1;
                appliedKinds.add(command.type);
              }
              workspace = deepFreeze(result.workspace);
            } else {
              if (step.generation === "fuzz") randomizedFuzzRejected += 1;
              expect(result.receipt).toEqual({
                id: context.commandId,
                commandId: context.commandId,
                commandType: command.type,
                baseRevision: before.revision,
                revision: before.revision,
                payloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                actorId: context.actorId,
                actorKind: context.actorKind,
                origin: context.origin,
                source: context.source,
                status: "rejected",
                createdAt: context.now,
                diff: [],
                rejectionCode: result.rejection.code,
              });
              if (step.kind === "invalid_command") invalidRejections += 1;
              expect(result.workspace).toBe(before);
              expect(result.workspace.revision).toBe(before.revision);
              expect(result.workspace.commandReceipts).toBe(beforeReceipts);
              expect(result.workspace.commandReceipts).toEqual(
                beforeSnapshot.commandReceipts,
              );
              expect(result.receipt.diff).toEqual([]);
            }
          }

          expect(intendedValidApplied).toBeGreaterThanOrEqual(20);
          expect(appliedKinds.size).toBeGreaterThanOrEqual(5);
          expect(fuzzStagesBefore).toEqual(
            new Set<LifecycleStage>([
              "direction",
              "awaiting_bet",
              "planning",
              "executing",
              "validating",
              "closing",
              "closed",
            ]),
          );
          expect(invalidAttempts).toBeGreaterThanOrEqual(1);
          expect(invalidRejections).toBe(invalidAttempts);
          expect(coveredCommandKinds).toEqual(new Set(publicCommandTypes));
          expect(randomizedFuzzApplied).toBeGreaterThanOrEqual(1);
          expect(randomizedFuzzRejected).toBeGreaterThanOrEqual(1);
        }),
        replayParameters("main"),
      );
      if (process.env.FC_PATH === undefined) {
        expect(appetiteSigns).toEqual(
          new Set(["negative", "zero", "positive"]),
        );
      }
    },
    240_000,
  );

  it(
    "keeps every public command handler pure when its input graph is frozen",
    async () => {
      await fc.assert(
        fc.asyncProperty(commandSequenceArbitrary, async (sequence) => {
          let workspace = structuredClone(sequence.initial);
          const coveredHandlers = new Set<V2Command["type"]>();

          for (const [index, step] of sequence.steps.entries()) {
            const { command, context } = await materializeCommandEnvelope(
              sequence,
              workspace,
              step,
              index,
            );
            if (
              step.kind !== "invalid_command" &&
              step.kind !== "complete_direction"
            ) {
              coveredHandlers.add(step.kind);
              const frozenWorkspace = deepFreeze(structuredClone(workspace));
              const frozenCommand = deepFreeze(structuredClone(command));
              const frozenContext = deepFreeze(structuredClone(context));
              const before = structuredClone(frozenWorkspace);

              await applyCommandHandler(
                frozenWorkspace,
                frozenCommand,
                frozenContext,
              );

              expect(frozenWorkspace).toEqual(before);
            }

            const result = await executeCommand(workspace, command, context);
            if (result.ok) workspace = result.workspace;
          }

          expect(coveredHandlers).toEqual(new Set(publicCommandTypes));
        }),
        replayParameters("handler_freeze", 50),
      );
    },
    180_000,
  );
});

describe("explicit lifecycle invariant properties", () => {
  it("keeps 7200 seconds as Action and routes 7201 seconds to Project promotion", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          estimateSeconds: fc.constantFrom(7_200, 7_201),
        }),
        async ({ seed, estimateSeconds }) => {
          const now = "2026-07-11T01:00:00.000Z";
          const inboxId = `boundary-inbox:${seed}`;
          const workspace = deepFreeze(
            buildWorkspaceV2(`boundary-workspace:${seed}`, {
              inboxItems: [
                buildInboxItem({
                  id: inboxId,
                  sourceId: "property-source",
                  actorId: "property-human",
                  capturedAt: now,
                }),
              ],
            }),
          );
          const eligibility = {
            singleSession: true,
            estimateSeconds,
            dependencyIds: [],
            requiresMilestoneEvidence: false,
            outcomeCount: 1,
            solutionKnown: true,
          };
          const result = await executeCommand(
            workspace,
            {
              type: "confirm_action_triage",
              inboxItemId: inboxId,
              action: {
                id: `boundary-action:${seed}`,
                title: "Two-hour boundary",
                eligibility,
                attention: "medium",
              },
            },
            buildCommandContext({
              commandId: `boundary-action-command:${seed}`,
              expectedRevision: workspace.revision,
              now,
            }),
          );

          if (estimateSeconds === 7_200) {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expectValidAppliedState(result, workspace, now);
              expect(result.workspace.actions[0].eligibility.estimateSeconds)
                .toBe(7_200);
            }
            return;
          }

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.rejection).toMatchObject({
            code: "ACTION_INELIGIBLE",
            gate: `action_eligibility:boundary-action:${seed}`,
            permittedNextCommand: "confirm_project_triage",
          });
          const promoted = await executeCommand(
            workspace,
            {
              type: "confirm_project_triage",
              inboxItemId: inboxId,
              eligibility,
              project: {
                id: `boundary-project:${seed}`,
                name: "Boundary Project",
                priority: 1,
                notes: "Exceeded the Action boundary by one second.",
              },
            },
            buildCommandContext({
              commandId: `boundary-project-command:${seed}`,
              expectedRevision: workspace.revision,
              now,
            }),
          );
          expect(promoted.ok).toBe(true);
          expectValidAppliedState(promoted, workspace, now);
        },
      ),
      replayParameters("action_boundary"),
    );
  }, 60_000);

  it("never records project execution without one sole current Bet", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          estimateSeconds: actionEstimateSecondsArbitrary,
          attempt: fc.constantFrom("record_actual" as const, "commit_today" as const),
          betState: fc.constantFrom(
            "missing" as const,
            "dangling" as const,
            "invalidated" as const,
            "multiple" as const,
            "sole_current" as const,
          ),
        }),
        async ({ seed, estimateSeconds, attempt, betState }) => {
          const now = "2026-07-11T01:00:00.000Z";
          const executionSeconds =
            attempt === "commit_today"
              ? Math.min(estimateSeconds, 3_600)
              : estimateSeconds;
          const mutable = activeProjectWorkspace(seed, {
            durationSeconds: executionSeconds,
            capacitySeconds: Math.max(executionSeconds, 3_600),
          });
          const proposal = await generateTodayProposal(
            mutable,
            "2026-07-11",
            now,
          );
          const project = mutable.projects[0];
          const bet = mutable.bets[0];
          if (betState === "missing") {
            delete project.activeBetId;
            mutable.bets = [];
            delete project.activePlanVersionId;
            mutable.planVersions = [];
          } else if (betState === "dangling") {
            project.activeBetId = `missing-bet:${seed}`;
          } else if (betState === "invalidated") {
            bet.invalidatedAt = "2026-07-11T00:00:00.000Z";
            bet.invalidationReason = "Explicitly invalidated for property test.";
          } else if (betState === "multiple") {
            mutable.bets.push({
              ...structuredClone(bet),
              id: `second-current-bet:${seed}`,
            });
          }
          const workspace = deepFreeze(mutable);
          const initialViolations = validateWorkspaceInvariants(workspace, now);
          if (betState === "sole_current") {
            expect(initialViolations).toEqual([]);
          } else {
            expect(
              initialViolations.some(({ code }) => code === "BET_REQUIRED"),
            ).toBe(true);
          }
          const command: V2Command = attempt === "record_actual"
            ? {
                type: "record_actual",
                actual: {
                  id: `bet-state-actual:${seed}`,
                  revision: 1,
                  target: {
                    kind: "work_item",
                    workItemId: `active-work:${seed}`,
                  },
                  actualWorkSeconds: 60,
                  remainingWorkSeconds: Math.max(0, executionSeconds - 60),
                  actualCost: 0,
                  recordedAt: now,
                },
              }
            : {
                type: "commit_today",
                commitment: {
                  id: `bet-state-commitment:${seed}`,
                  localDate: proposal.localDate,
                  workspaceRevision: proposal.workspaceRevision,
                  generatedAt: proposal.generatedAt,
                  proposalHash: proposal.proposalHash,
                  slots: structuredClone(proposal.slots),
                },
              };
          const result = await executeCommand(
            workspace,
            deepFreeze(command),
            deepFreeze(
              buildCommandContext({
                commandId: `bet-state-command:${seed}`,
                expectedRevision: workspace.revision,
                now,
              }),
            ),
          );
          if (betState === "sole_current") {
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(validateWorkspaceInvariants(result.workspace, now, workspace))
                .toEqual([]);
            }
          } else {
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.rejection.code).toBe("BET_REQUIRED");
            expect(result.workspace).toBe(workspace);
            expect(result.receipt.diff).toEqual([]);
          }
        },
      ),
      replayParameters("no_bet"),
    );
  }, 60_000);

  it("never commits Today above its captured attention capacity", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          budget: capacitySecondsArbitrary.map(
            (seconds) => 300 + (seconds % 3_301),
          ),
          overage: fc.integer({ min: 1, max: 300 }),
        }),
        async ({ seed, budget, overage }) => {
          const now = "2026-07-11T01:00:00.000Z";
          const workspace = deepFreeze(
            activeProjectWorkspace(seed, {
              durationSeconds: budget,
              capacitySeconds: budget,
            }),
          );
          const proposal = await generateTodayProposal(
            workspace,
            "2026-07-11",
            now,
          );
          expect(proposal.slots.length).toBeGreaterThan(0);
          const overCapacitySlots = structuredClone(proposal.slots);
          const last = overCapacitySlots[overCapacitySlots.length - 1];
          last.finish = new Date(Date.parse(last.finish) + overage * 1_000)
            .toISOString();
          const blocked = await executeCommand(
            workspace,
            deepFreeze({
              type: "commit_today",
              commitment: {
                id: `over-capacity:${seed}`,
                localDate: proposal.localDate,
                workspaceRevision: proposal.workspaceRevision,
                generatedAt: proposal.generatedAt,
                proposalHash: proposal.proposalHash,
                slots: overCapacitySlots,
              },
            }),
            deepFreeze(
              buildCommandContext({
                commandId: `over-capacity-command:${seed}`,
                expectedRevision: workspace.revision,
                now,
              }),
            ),
          );
          expect(blocked.ok).toBe(false);
          if (blocked.ok) return;
          expect(blocked.rejection.code).toBe("CAPACITY_EXCEEDED");
          expect(blocked.workspace).toBe(workspace);

          const legal = await executeCommand(
            workspace,
            {
              type: "commit_today",
              commitment: {
                id: `at-capacity:${seed}`,
                localDate: proposal.localDate,
                workspaceRevision: proposal.workspaceRevision,
                generatedAt: proposal.generatedAt,
                proposalHash: proposal.proposalHash,
                slots: structuredClone(proposal.slots),
              },
            },
            buildCommandContext({
              commandId: `at-capacity-command:${seed}`,
              expectedRevision: workspace.revision,
              now,
            }),
          );
          expect(legal.ok).toBe(true);
          expectValidAppliedState(legal, workspace, now);
        },
      ),
      replayParameters("capacity"),
    );
  }, 60_000);

  it("never mutates a closed Project while archive remains visibility-only", async () => {
    const humanOriginCase = fc.record({
      origin: fc.constantFrom("ui" as const, "sync" as const, "import" as const),
      mutation: fc.constantFrom(
        "metadata" as const,
        "direction" as const,
        "work_item" as const,
        "actual" as const,
        "evidence" as const,
        "promoted_actual" as const,
      ),
    });
    const agentOriginCase = fc.record({
      origin: fc.constant("agent" as const),
      mutation: fc.constantFrom(
        "actual" as const,
        "evidence" as const,
        "promoted_actual" as const,
      ),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          closedCase: fc.oneof(humanOriginCase, agentOriginCase),
        }),
        async ({ seed, closedCase: { origin, mutation } }) => {
          const mutable = activeProjectWorkspace(seed, { stage: "closed" });
          const promotedActionId = `closed-promoted-action:${seed}`;
          if (mutation === "promoted_actual") {
            const inboxId = `closed-promoted-inbox:${seed}`;
            mutable.inboxItems.push({
              id: inboxId,
              originalText: "Promoted property work",
              sourceId: "property-ui",
              actorId: "property-human",
              capturedAt: "2026-07-10T00:00:00.000Z",
              triageStatus: "action",
              actionId: promotedActionId,
            });
            mutable.actions.push({
              id: promotedActionId,
              inboxItemId: inboxId,
              title: "Promoted property work",
              revision: 2,
              status: "promoted",
              eligibility: {
                singleSession: false,
                estimateSeconds: 10_800,
                dependencyIds: [],
                requiresMilestoneEvidence: false,
                outcomeCount: 1,
                solutionKnown: true,
              },
              attention: "deep",
              promotedProjectId: `active-project:${seed}`,
              createdAt: "2026-07-10T00:00:00.000Z",
              updatedAt: "2026-07-10T00:00:00.000Z",
            });
          }
          const workspace = deepFreeze(mutable);
          expect(
            validateWorkspaceInvariants(
              workspace,
              "2026-07-11T01:00:00.000Z",
            ),
          ).toEqual([]);
          const project = workspace.projects[0];
          const brief = workspace.directionBriefs[0];
          const workItem = workspace.workItems[0];
          const command: V2Command = mutation === "metadata"
            ? {
                type: "update_project_metadata",
                projectId: project.id,
                name: "Forbidden closed mutation",
              }
            : mutation === "direction"
              ? {
                  type: "update_direction",
                  projectId: project.id,
                  brief: {
                    id: brief.id,
                    projectId: project.id,
                    audienceAndProblem: brief.audienceAndProblem,
                    successEvidence: brief.successEvidence,
                    appetiteSeconds: brief.appetiteSeconds,
                    validationMethod: brief.validationMethod,
                    firstScope: structuredClone(brief.firstScope),
                    noGoOrKill: brief.noGoOrKill,
                    advancedNotes: "Forbidden",
                  },
                }
              : mutation === "work_item"
                ? {
                    type: "create_work_item",
                    projectId: project.id,
                    workItem: buildProjectWorkItem({
                      id: `closed-new-work:${seed}`,
                      projectId: project.id,
                      betScopeId: workspace.bets[0].committedScope[0].id,
                    }),
                  }
                : mutation === "actual" || mutation === "promoted_actual"
                  ? {
                      type: "record_actual",
                      actual: {
                        id: `closed-actual:${seed}`,
                        revision: 1,
                        target: mutation === "promoted_actual"
                          ? { kind: "action" as const, actionId: promotedActionId }
                          : { kind: "work_item" as const, workItemId: workItem.id },
                        actualWorkSeconds: 60,
                        remainingWorkSeconds: 0,
                        actualCost: 0,
                        recordedAt: "2026-07-11T01:00:00.000Z",
                      },
                    }
                  : {
                      type: "attach_evidence",
                      evidence: {
                        id: `closed-evidence:${seed}`,
                        kind: "note",
                        summary: "Forbidden",
                        projectId: project.id,
                        workItemId: workItem.id,
                        createdAt: "2026-07-11T01:00:00.000Z",
                        confidence: 1,
                        tags: [],
                      },
                    };
          const blocked = await executeCommand(
            workspace,
            deepFreeze(command),
            deepFreeze(
              buildCommandContext({
                commandId: `closed-blocked:${seed}`,
                expectedRevision: workspace.revision,
                actorId: origin === "agent" ? "property-agent" : "property-human",
                actorKind: origin === "agent" ? "agent" : "human",
                origin,
                source: {
                  sourceId: `closed-${origin}-source:${seed}`,
                  verified: true,
                  capabilities: origin === "sync"
                    ? ["replay_receipt"]
                    : origin === "import"
                      ? ["import_portable"]
                      : origin === "agent"
                        ? [mutation === "evidence" ? "attach_evidence" : "record_actual"]
                        : ["human_decision"],
                },
                now: "2026-07-11T01:00:00.000Z",
              }),
            ),
          );
          expect(blocked.ok).toBe(false);
          if (blocked.ok) return;
          expect(blocked.rejection.code).toBe("PROJECT_CLOSED");
          expect(blocked.workspace).toBe(workspace);

          const archived = await executeCommand(
            workspace,
            { type: "archive_project", projectId: project.id, archived: true },
            buildCommandContext({
              commandId: `closed-archive:${seed}`,
              expectedRevision: workspace.revision,
              now: "2026-07-11T01:00:00.000Z",
            }),
          );
          expect(archived.ok).toBe(true);
          if (!archived.ok) return;
          expectValidAppliedState(
            archived,
            workspace,
            "2026-07-11T01:00:00.000Z",
          );
          expect(
            archiveImmutableWorkspaceContent(archived.workspace),
          ).toEqual(
            archiveImmutableWorkspaceContent(workspace),
          );
          expect(archived.workspace.visibility.archivedProjectIds).toEqual([
            project.id,
          ]);
        },
      ),
      replayParameters("closed"),
    );
  }, 60_000);

  it("never accepts a non-human commitment or lifecycle approval", async () => {
    const nonHumanActorArbitrary = actorKindArbitrary.map(
      (actor): Exclude<ActorKind, "human"> =>
        actor === "human" ? "agent" : actor,
    );
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          actorKind: nonHumanActorArbitrary,
          approval: fc.constantFrom(
            "place_bet" as const,
            "commit_today" as const,
            "accept_replan" as const,
            "approve_evidence_exception" as const,
            "complete_review" as const,
            "close_project" as const,
            "abandon_project" as const,
          ),
        }),
        async ({ seed, actorKind, approval }) => {
          const { workspace, command, now } = await humanOnlyApprovalFixture(
            seed,
            approval,
          );
          expect(validateWorkspaceInvariants(workspace, now)).toEqual([]);
          const frozen = deepFreeze(workspace);
          const rejected = await executeCommand(
            frozen,
            deepFreeze(command),
            deepFreeze(
              buildCommandContext({
                commandId: `non-human:${seed}`,
                expectedRevision: frozen.revision,
                actorId: `property-${actorKind}`,
                actorKind,
                origin: "agent",
                source: {
                  sourceId: `non-human-source:${seed}`,
                  verified: true,
                  capabilities:
                    actorKind === "agent"
                      ? ["submit_proposal"]
                      : ["system_time"],
                },
                now,
              }),
            ),
          );
          expect(rejected.ok).toBe(false);
          if (rejected.ok) return;
          expect(rejected.rejection.code).toBe(
            actorKind === "agent" || approval === "place_bet"
              ? "HUMAN_CONFIRMATION_REQUIRED"
              : "ACTOR_NOT_AUTHORIZED",
          );
          expect(rejected.workspace).toBe(frozen);

          const humanControl = await executeCommand(
            frozen,
            command,
            buildCommandContext({
              commandId: `human-control:${seed}`,
              expectedRevision: frozen.revision,
              now,
            }),
          );
          expect(
            humanControl.ok,
            humanControl.ok
              ? undefined
              : `${approval}: ${JSON.stringify(humanControl.rejection)}`,
          ).toBe(true);
          expectValidAppliedState(humanControl, frozen, now);
        },
      ),
      replayParameters("authority"),
    );
  }, 90_000);

  it("never treats an expired evidence exception as active", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          gateState: fc.constantFrom(
            "none" as const,
            "evidence" as const,
            "exception_before_expiry" as const,
            "exception_at_expiry" as const,
            "exception_after_expiry" as const,
          ),
          offsetSeconds: fc.integer({ min: 1, max: 3_600 }),
        }),
        async ({ seed, gateState, offsetSeconds }) => {
          const now = "2026-07-11T01:00:00.000Z";
          const requirementId = `active-work:${seed}`;
          const projectId = `active-project:${seed}`;
          const expiresAt = new Date(
            Date.parse(now) +
              (gateState === "exception_before_expiry"
                ? offsetSeconds * 1_000
                : gateState === "exception_at_expiry"
                  ? 0
                  : -offsetSeconds * 1_000),
          ).toISOString();
          const evidence = {
            id: `gate-evidence:${seed}`,
            kind: "note" as const,
            summary: "Exact linked evidence",
            projectId,
            workItemId: requirementId,
            createdAt: "2026-07-11T00:00:00.000Z",
            confidence: 1,
            tags: [] as string[],
          };
          const exception = buildExceptionRecord({
            id: `gate-exception:${seed}`,
            projectId,
            requirementId,
            approvedBy: "property-human",
            createdAt: "2026-07-09T00:00:00.000Z",
            reviewAt: "2026-07-10T00:00:00.000Z",
            expiresAt,
          });
          const workspace = deepFreeze(
            activeProjectWorkspace(seed, {
              stage: "validating",
              evidenceRequired: true,
              evidence: gateState === "evidence" ? [evidence] : [],
              exceptions: gateState.startsWith("exception_")
                ? [exception]
                : [],
            }),
          );
          expect(validateWorkspaceInvariants(workspace, now)).toEqual([]);
          const result = await executeCommand(
            workspace,
            { type: "satisfy_validation", projectId },
            buildCommandContext({
              commandId: `gate-satisfy:${seed}`,
              expectedRevision: workspace.revision,
              now,
            }),
          );
          if (
            gateState === "evidence" ||
            gateState === "exception_before_expiry"
          ) {
            expect(result.ok).toBe(true);
            expectValidAppliedState(result, workspace, now);
            return;
          }
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.rejection.code).toBe(
            gateState === "none" ? "EVIDENCE_REQUIRED" : "EXCEPTION_EXPIRED",
          );
          const attached = await executeCommand(
            workspace,
            { type: "attach_evidence", evidence },
            buildCommandContext({
              commandId: `gate-attach:${seed}`,
              expectedRevision: workspace.revision,
              now,
            }),
          );
          expect(attached.ok).toBe(true);
          if (!attached.ok) return;
          expectValidAppliedState(attached, workspace, now);
          const legal = await executeCommand(
            attached.workspace,
            { type: "satisfy_validation", projectId },
            buildCommandContext({
              commandId: `gate-control:${seed}`,
              expectedRevision: attached.workspace.revision,
              now: "2026-07-11T01:01:00.000Z",
            }),
          );
          expect(legal.ok).toBe(true);
          expectValidAppliedState(
            legal,
            attached.workspace,
            "2026-07-11T01:01:00.000Z",
          );
        },
      ),
      replayParameters("exception"),
    );
  }, 60_000);

  it("never bypasses a hard project hold", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          seed: fc.nat({ max: 1_000_000 }),
          generatedHold: projectHoldArbitrary,
        }),
        async ({ seed, generatedHold }) => {
          const projectId = `active-project:${seed}`;
          const workItemId = `held-new-work:${seed}`;
          const sourceId = `hold-source:${seed}`;
          const hold: ProjectHoldState = {
            ...generatedHold,
            sourceId,
            affectedRecordIds: [projectId, `active-work:${seed}`],
            createdAt: "2026-07-11T00:00:00.000Z",
          };
          const mutable = activeProjectWorkspace(seed, { holds: [hold] });
          if (hold.type === "migration_review") {
            mutable.legacyAuditRecords.push({
              id: sourceId,
              projectId,
              recordType: "audit_gate",
              sourcePayload: { reason: "migration_review" },
              sourceChecksum: `checksum:${seed}`,
            });
          } else if (hold.type === "rebet_required") {
            const activeBet = mutable.bets[0];
            hold.sourceId = activeBet.id;
            hold.affectedRecordIds = [projectId, activeBet.id];
            mutable.projects[0].holds[0].sourceId = activeBet.id;
            mutable.projects[0].holds[0].affectedRecordIds = [
              projectId,
              activeBet.id,
            ];
          } else if (hold.type === "review_overdue") {
            mutable.reviews.push({
              id: sourceId,
              kind: "event",
              triggerKey: `hard_gate:${sourceId}`,
              triggerType: "hard_gate",
              status: "open",
              affectedProjectIds: [projectId],
              affectedRecordIds: [projectId],
              dueAt: "2026-07-10T00:00:00.000Z",
              createdAt: "2026-07-10T00:00:00.000Z",
              overdueMarkedAt: "2026-07-11T00:00:00.000Z",
            });
          } else {
            hold.affectedRecordIds = [
              mutable.bets[0].id,
              `active-work:${seed}`,
            ];
            mutable.projects[0].holds[0].affectedRecordIds = [
              mutable.bets[0].id,
              `active-work:${seed}`,
            ];
            mutable.syncConflicts.push({
              id: sourceId,
              recordType: "bet",
              recordId: mutable.bets[0].id,
              projectId,
              commonAncestorHash: `ancestor:${seed}`,
              localValue: { side: "local" },
              remoteValue: { side: "remote" },
              openedAt: "2026-07-11T00:00:00.000Z",
            });
          }
          const workspace = deepFreeze(mutable);
          expect(
            validateWorkspaceInvariants(
              workspace,
              "2026-07-11T01:00:00.000Z",
            ),
          ).toEqual([]);
          const command: V2Command = hold.type === "sync_conflict"
            ? {
                type: "update_work_item",
                projectId,
                workItemId: `active-work:${seed}`,
                patch: { title: "Blocked conflicted update" },
              }
            : {
                type: "create_work_item",
                projectId,
                workItem: buildProjectWorkItem({
                  id: workItemId,
                  projectId,
                  betScopeId: workspace.bets[0].committedScope[0].id,
                }),
              };
          const blocked = await executeCommand(
            workspace,
            deepFreeze(command),
            buildCommandContext({
              commandId: `hold-blocked:${seed}`,
              expectedRevision: workspace.revision,
              now: "2026-07-11T01:00:00.000Z",
            }),
          );
          expect(blocked.ok).toBe(false);
          if (blocked.ok) return;
          expect(blocked.rejection.code).toBe("HOLD_BLOCKS_COMMAND");
          expect(blocked.rejection.hold).toBe(hold.type);
          expect(blocked.workspace).toBe(workspace);

          if (hold.type === "migration_review") {
            const brief = workspace.directionBriefs[0];
            const legal = await executeCommand(
              workspace,
              {
                type: "update_direction",
                projectId,
                brief: {
                  id: brief.id,
                  projectId,
                  audienceAndProblem: brief.audienceAndProblem,
                  successEvidence: brief.successEvidence,
                  appetiteSeconds: brief.appetiteSeconds,
                  validationMethod: brief.validationMethod,
                  firstScope: structuredClone(brief.firstScope),
                  noGoOrKill: brief.noGoOrKill,
                  advancedNotes: "The permitted migration-review correction.",
                },
              },
              buildCommandContext({
                commandId: `migration-hold-control:${seed}`,
                expectedRevision: workspace.revision,
                now: "2026-07-11T01:00:00.000Z",
              }),
            );
            expect(
              legal.ok,
              legal.ok ? undefined : JSON.stringify(legal.rejection),
            ).toBe(true);
            expectValidAppliedState(
              legal,
              workspace,
              "2026-07-11T01:00:00.000Z",
            );
          } else if (hold.type === "rebet_required") {
            const recoveryWorkspace = structuredClone(workspace);
            const invalidatedAt = "2026-07-11T00:00:00.000Z";
            recoveryWorkspace.bets[0].invalidatedAt = invalidatedAt;
            recoveryWorkspace.bets[0].invalidationReason =
              "Material Direction change requires Re-bet.";
            const previousBrief = recoveryWorkspace.directionBriefs[0];
            const replacementBrief = {
              ...structuredClone(previousBrief),
              id: `${projectId}:material-direction`,
              version: previousBrief.version + 1,
              audienceAndProblem: `${previousBrief.audienceAndProblem} revised`,
              createdAt: invalidatedAt,
              updatedAt: invalidatedAt,
            };
            recoveryWorkspace.directionBriefs.push(replacementBrief);
            recoveryWorkspace.projects[0].activeDirectionBriefId =
              replacementBrief.id;
            recoveryWorkspace.projects[0].updatedAt = invalidatedAt;
            const legal = await executeCommand(
              recoveryWorkspace,
              {
                type: "place_bet",
                projectId,
                betId: `replacement-bet:${seed}`,
                start: "2026-07-11T01:00:00.000Z",
              },
              buildCommandContext({
                commandId: `rebet-hold-control:${seed}`,
                expectedRevision: recoveryWorkspace.revision,
                now: "2026-07-11T01:00:00.000Z",
              }),
            );
            expect(
              legal.ok,
              legal.ok ? undefined : JSON.stringify(legal.rejection),
            ).toBe(true);
            expectValidAppliedState(
              legal,
              recoveryWorkspace,
              "2026-07-11T01:00:00.000Z",
            );
          } else if (hold.type === "review_overdue") {
            const legal = await executeCommand(
              workspace,
              {
                type: "complete_review",
                reviewId: sourceId,
                conclusion: {
                  summary: "The overdue gate received an explicit decision.",
                  decisionCodes: ["continue"],
                  followUpCommandIds: [],
                },
              },
              buildCommandContext({
                commandId: `review-hold-control:${seed}`,
                expectedRevision: workspace.revision,
                now: "2026-07-11T01:00:00.000Z",
              }),
            );
            expect(
              legal.ok,
              legal.ok ? undefined : JSON.stringify(legal.rejection),
            ).toBe(true);
            expectValidAppliedState(
              legal,
              workspace,
              "2026-07-11T01:00:00.000Z",
            );
          } else {
            const legal = await executeCommand(
              workspace,
              {
                type: "update_project_metadata",
                projectId,
                name: "Unrelated metadata remains writable",
              },
              buildCommandContext({
                commandId: `sync-hold-control:${seed}`,
                expectedRevision: workspace.revision,
                now: "2026-07-11T01:00:00.000Z",
              }),
            );
            expect(
              legal.ok,
              legal.ok ? undefined : JSON.stringify(legal.rejection),
            ).toBe(true);
            expectValidAppliedState(
              legal,
              workspace,
              "2026-07-11T01:00:00.000Z",
            );
          }
        },
      ),
      replayParameters("hold"),
    );
  }, 60_000);
});
