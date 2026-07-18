import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  executeCommand,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import type { ReviewRecord, WorkspaceV2 } from "../domain/types";
import {
  buildBetVersion,
  buildCapacityProfile,
  buildDirectionBrief,
  buildExceptionRecord,
  buildProjectV2,
  buildProjectWorkItem,
  buildWorkspaceV2,
} from "../tests/builders";
import { BrowserWorkspaceRepository } from "./browserWorkspaceRepository";
import { CommandService } from "./commandService";
import {
  deleteV2Database,
  openV2Database,
  requestResult,
  transactionComplete,
  V2_OBJECT_STORES,
} from "./indexedDb";
import {
  nextWakeAt,
  SystemEventCoordinator,
  type SystemEventCommandDispatcher,
  type SystemEventWorkspaceRepository,
} from "./systemEventCoordinator";

const APPROVED_AT = "2026-07-12T08:00:00.000Z";
const MIDPOINT = "2026-07-12T09:00:00.000Z";
const APPETITE_END = "2026-07-12T10:00:00.000Z";

async function seedWorkspaceFixture(
  databaseName: string,
  indexedDB: IDBFactory,
  workspace: WorkspaceV2,
): Promise<void> {
  const database = await openV2Database({ databaseName, indexedDB });
  try {
    const transaction = database.transaction(
      V2_OBJECT_STORES.workspace,
      "readwrite",
    );
    const completion = transactionComplete(transaction);
    await requestResult(
      transaction
        .objectStore(V2_OBJECT_STORES.workspace)
        .add(structuredClone(workspace), "current"),
    );
    await completion;
  } finally {
    database.close();
  }
}

function activeBetWorkspace(idSuffix = "1"): WorkspaceV2 {
  const projectId = `project-${idSuffix}`;
  const briefId = `brief-${idSuffix}`;
  const betId = `bet-${idSuffix}`;
  const scopeId = `scope-${idSuffix}`;
  const workItemId = `work-${idSuffix}`;
  const planId = `plan-${idSuffix}`;
  const brief = buildDirectionBrief({
    id: briefId,
    projectId,
    audienceAndProblem: "Operators lose the next bounded action.",
    successEvidence: "An operator completes the guided flow.",
    appetiteSeconds: 7_200,
    validationMethod: "Observe the guided flow.",
    firstScope: [
      {
        id: scopeId,
        title: "Guided flow",
        description: "One bounded result.",
      },
    ],
    noGoOrKill: "Stop if the flow requires manual coaching.",
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
  });
  const bet = buildBetVersion({
    id: betId,
    projectId,
    briefId: brief.id,
    briefSnapshot: structuredClone(brief),
    committedScope: structuredClone(brief.firstScope),
    appetiteStart: APPROVED_AT,
    appetiteEnd: APPETITE_END,
    actorId: "human-1",
    approvedAt: APPROVED_AT,
  });
  const workItem = buildProjectWorkItem({
    id: workItemId,
    projectId,
    betScopeId: scopeId,
    kind: "milestone",
    evidenceRequired: true,
  });
  return buildWorkspaceV2(`workspace-system-events-${idSuffix}`, {
    projects: [
      buildProjectV2({
        id: projectId,
        stage: "executing",
        activeDirectionBriefId: brief.id,
        activeBetId: bet.id,
        activePlanVersionId: planId,
        createdAt: APPROVED_AT,
        updatedAt: APPROVED_AT,
      }),
    ],
    directionBriefs: [brief],
    bets: [bet],
    workItems: [workItem],
    planVersions: [
      {
        id: planId,
        projectId,
        version: 1,
        betId: bet.id,
        workItemRevisions: { [workItem.id]: workItem.revision },
        dependencyRevisions: {},
        scopeMapping: { [workItem.id]: workItem.betScopeId },
        scheduleHash: "plan-hash",
        capacityIndependentDates: {
          [workItem.id]: { start: APPROVED_AT, finish: MIDPOINT },
        },
        actorId: "human-1",
        createdAt: APPROVED_AT,
      },
    ],
  });
}

function weeklyWorkspace(timeZone = "UTC"): WorkspaceV2 {
  return buildWorkspaceV2(`workspace-weekly-${timeZone}`, {
    capacityProfile: buildCapacityProfile({
      timeZone,
      weeklyWindows: [
        { weekday: 1, startMinute: 540, finishMinute: 1_020 },
      ],
      dailyBudgets: [
        {
          weekday: 1,
          deepSeconds: 3_600,
          mediumSeconds: 1_800,
          shallowSeconds: 900,
        },
      ],
      updatedAt: "2026-07-01T00:00:00.000Z",
      updatedBy: "human-1",
    }),
  });
}

function exceptionWorkspace(): WorkspaceV2 {
  const workspace = activeBetWorkspace();
  workspace.exceptions = [
    buildExceptionRecord({
      id: "exception-1",
      projectId: "project-1",
      requirementId: "work-1",
      approvedBy: "human-1",
      createdAt: APPROVED_AT,
      reviewAt: "2026-07-12T08:15:00.000Z",
      expiresAt: "2026-07-12T08:45:00.000Z",
    }),
  ];
  return workspace;
}

function twoExpiredProjectsWorkspace(): WorkspaceV2 {
  const left = activeBetWorkspace("a");
  const right = activeBetWorkspace("b");
  return buildWorkspaceV2("workspace-two-expired", {
    projects: [...left.projects, ...right.projects],
    directionBriefs: [...left.directionBriefs, ...right.directionBriefs],
    bets: [...left.bets, ...right.bets],
    planVersions: [...left.planVersions, ...right.planVersions],
    workItems: [...left.workItems, ...right.workItems],
  });
}

function openOverdueWorkspace(): WorkspaceV2 {
  return buildWorkspaceV2("workspace-open-overdue", {
    reviews: [
      {
        id: "review:open-overdue",
        kind: "event",
        triggerKey: "open-overdue",
        triggerType: "hard_gate",
        status: "open",
        affectedProjectIds: [],
        affectedRecordIds: [],
        createdAt: APPROVED_AT,
        dueAt: "2026-07-12T08:10:00.000Z",
      },
    ],
  });
}

function twoOpenOverdueReviewsWorkspace(): WorkspaceV2 {
  const workspace = openOverdueWorkspace();
  workspace.reviews = [
    {
      ...structuredClone(workspace.reviews[0]),
      id: "review:a-overdue",
      triggerKey: "a-overdue",
    },
    {
      ...structuredClone(workspace.reviews[0]),
      id: "review:b-overdue",
      triggerKey: "b-overdue",
    },
  ];
  return workspace;
}

class MemoryRepository implements SystemEventWorkspaceRepository {
  constructor(public workspace: WorkspaceV2 | undefined) {}

  async load(): Promise<WorkspaceV2 | undefined> {
    return this.workspace;
  }
}

class RecordingDispatcher implements SystemEventCommandDispatcher {
  readonly calls: Array<{ command: V2Command; context: CommandContext }> = [];
  readonly results: CommandResult[] = [];

  constructor(private readonly repository: MemoryRepository) {}

  async dispatch(
    command: V2Command,
    context: CommandContext,
  ): Promise<CommandResult> {
    this.calls.push({
      command: structuredClone(command),
      context: structuredClone(context),
    });
    const workspace = this.repository.workspace;
    if (workspace === undefined) throw new Error("Missing test Workspace");
    const result = await executeCommand(workspace, command, context);
    this.results.push(result);
    if (result.ok) this.repository.workspace = result.workspace;
    return result;
  }
}

class ControlledRejectionDispatcher implements SystemEventCommandDispatcher {
  readonly calls: Array<{ command: V2Command; context: CommandContext }> = [];

  constructor(
    private readonly repository: MemoryRepository,
    private remainingCasConflicts: number,
    private readonly rejectNonCas = false,
  ) {}

  async dispatch(
    command: V2Command,
    context: CommandContext,
  ): Promise<CommandResult> {
    this.calls.push({
      command: structuredClone(command),
      context: structuredClone(context),
    });
    const workspace = this.repository.workspace;
    if (workspace === undefined) throw new Error("Missing test Workspace");
    if (this.remainingCasConflicts > 0) {
      this.remainingCasConflicts -= 1;
      return executeCommand(workspace, command, {
        ...context,
        expectedRevision: context.expectedRevision + 1,
      });
    }
    if (this.rejectNonCas) {
      return executeCommand(workspace, command, {
        ...context,
        source: { ...context.source, verified: false },
      });
    }
    const result = await executeCommand(workspace, command, context);
    if (result.ok) this.repository.workspace = result.workspace;
    return result;
  }
}

class OneCasConflictForTypeDispatcher
  implements SystemEventCommandDispatcher
{
  readonly calls: Array<{ command: V2Command; context: CommandContext }> = [];
  private injected = false;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly targetType:
      | "record_bet_boundary"
      | "create_review"
      | "mark_review_overdue",
  ) {}

  async dispatch(
    command: V2Command,
    context: CommandContext,
  ): Promise<CommandResult> {
    this.calls.push({
      command: structuredClone(command),
      context: structuredClone(context),
    });
    const workspace = this.repository.workspace;
    if (workspace === undefined) throw new Error("Missing test Workspace");
    if (!this.injected && command.type === this.targetType) {
      this.injected = true;
      return executeCommand(workspace, command, {
        ...context,
        expectedRevision: context.expectedRevision + 1,
      });
    }
    const result = await executeCommand(workspace, command, context);
    if (result.ok) this.repository.workspace = result.workspace;
    return result;
  }
}

class RejectOneReviewDispatcher implements SystemEventCommandDispatcher {
  readonly calls: Array<{ command: V2Command; context: CommandContext }> = [];

  constructor(
    private readonly repository: MemoryRepository,
    private readonly rejection: "non_cas" | "cas" = "non_cas",
  ) {}

  async dispatch(
    command: V2Command,
    context: CommandContext,
  ): Promise<CommandResult> {
    this.calls.push({
      command: structuredClone(command),
      context: structuredClone(context),
    });
    const workspace = this.repository.workspace;
    if (workspace === undefined) throw new Error("Missing test Workspace");
    const effectiveContext: CommandContext =
      command.type === "mark_review_overdue" &&
        command.reviewId === "review:a-overdue"
        ? this.rejection === "cas"
          ? { ...context, expectedRevision: context.expectedRevision + 1 }
          : {
              ...context,
              source: { ...context.source, verified: false },
            }
        : context;
    const result = await executeCommand(workspace, command, effectiveContext);
    if (result.ok) this.repository.workspace = result.workspace;
    return result;
  }
}

describe("SystemEventCoordinator", () => {
  it("reports the exact unresolved Bet midpoint as the next wake", () => {
    expect(
      nextWakeAt(activeBetWorkspace(), "2026-07-12T08:30:00.000Z"),
    ).toBe(MIDPOINT);
  });

  it("records a due boundary before deriving, creating, and marking its Review", async () => {
    const repository = new MemoryRepository(activeBetWorkspace());
    const dispatcher = new RecordingDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);

    await coordinator.run(MIDPOINT);

    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "record_bet_boundary",
      "create_review",
      "mark_review_overdue",
    ]);
    expect(dispatcher.calls.map(({ context }) => context)).toEqual(
      dispatcher.calls.map(({ command, context }, index) => ({
        commandId: `system-event:${command.type}:${
          command.type === "create_review"
            ? "bet-1:midpoint"
            : command.type === "mark_review_overdue"
              ? "review:bet-1:midpoint:overdue"
              : "bet-1:midpoint"
        }`,
        expectedRevision: index,
        actorId: "system-event-coordinator",
        actorKind: "system",
        origin: "agent",
        source: {
          sourceId: "system-clock",
          verified: true,
          capabilities: ["system_time"],
        },
        now: MIDPOINT,
      })),
    );
    expect(repository.workspace?.reviews).toEqual([
      expect.objectContaining({
        triggerKey: "bet-1:midpoint",
        status: "open",
        overdueMarkedAt: MIDPOINT,
      }),
    ]);

    await coordinator.run(MIDPOINT);
    expect(dispatcher.calls).toHaveLength(3);
  });

  it("rederives after bounded CAS conflicts and succeeds without changing identity", async () => {
    const repository = new MemoryRepository(activeBetWorkspace());
    const dispatcher = new ControlledRejectionDispatcher(repository, 2);

    await new SystemEventCoordinator(repository, dispatcher, {
      maxCasRetries: 2,
    }).run(MIDPOINT);

    expect(dispatcher.calls).toHaveLength(5);
    expect(
      dispatcher.calls.slice(0, 3).map(({ context }) => context.commandId),
    ).toEqual([
      "system-event:record_bet_boundary:bet-1:midpoint",
      "system-event:record_bet_boundary:bet-1:midpoint",
      "system-event:record_bet_boundary:bet-1:midpoint",
    ]);
    expect(repository.workspace?.reviews).toHaveLength(1);
    expect(repository.workspace?.revision).toBe(3);
  });

  it.each([
    "record_bet_boundary",
    "create_review",
    "mark_review_overdue",
  ] as const)("retries the idempotent %s command after one CAS loss", async (type) => {
    const repository = new MemoryRepository(activeBetWorkspace());
    const dispatcher = new OneCasConflictForTypeDispatcher(repository, type);

    await new SystemEventCoordinator(repository, dispatcher).run(MIDPOINT);

    const targetCalls = dispatcher.calls.filter(
      ({ command }) => command.type === type,
    );
    expect(targetCalls).toHaveLength(2);
    expect(targetCalls[1].context.commandId).toBe(
      targetCalls[0].context.commandId,
    );
    expect(repository.workspace?.revision).toBe(3);
    expect(repository.workspace?.reviews[0]).toMatchObject({
      triggerKey: "bet-1:midpoint",
      overdueMarkedAt: MIDPOINT,
    });
  });

  it("backs off deterministically after exhausting the CAS budget", async () => {
    const casRepository = new MemoryRepository(activeBetWorkspace());
    const alwaysConflicts = new ControlledRejectionDispatcher(
      casRepository,
      Number.POSITIVE_INFINITY,
    );
    const coordinator = new SystemEventCoordinator(
      casRepository,
      alwaysConflicts,
      {
        maxCasRetries: 2,
      },
    );
    await coordinator.run(MIDPOINT, { reason: "boot" });
    expect(alwaysConflicts.calls).toHaveLength(3);
    expect(casRepository.workspace?.revision).toBe(0);
    expect(
      coordinator.nextScheduledWakeAt(casRepository.workspace!, MIDPOINT),
    ).toBe("2026-07-12T09:00:01.000Z");

    await coordinator.run(MIDPOINT, { reason: "timer" });
    await coordinator.run("2026-07-12T09:00:00.999Z", { reason: "timer" });
    expect(alwaysConflicts.calls).toHaveLength(3);

    await coordinator.run("2026-07-12T09:00:01.000Z", { reason: "timer" });
    expect(alwaysConflicts.calls).toHaveLength(6);
    expect(
      coordinator.nextScheduledWakeAt(
        casRepository.workspace!,
        "2026-07-12T09:00:01.000Z",
      ),
    ).toBe("2026-07-12T09:00:02.000Z");
  });

  it("suppresses a non-CAS failure for timer runs at the same revision", async () => {
    const rejectedRepository = new MemoryRepository(activeBetWorkspace());
    const nonCas = new ControlledRejectionDispatcher(
      rejectedRepository,
      0,
      true,
    );
    const coordinator = new SystemEventCoordinator(rejectedRepository, nonCas);

    await coordinator.run(MIDPOINT, { reason: "boot" });
    expect(nonCas.calls).toHaveLength(1);
    expect(rejectedRepository.workspace?.revision).toBe(0);
    expect(
      coordinator.nextScheduledWakeAt(rejectedRepository.workspace!, MIDPOINT),
    ).toBe(APPETITE_END);

    await coordinator.run(MIDPOINT, { reason: "timer" });
    expect(nonCas.calls).toHaveLength(1);

    await coordinator.run(MIDPOINT, { reason: "visibility" });
    expect(nonCas.calls).toHaveLength(2);

    rejectedRepository.workspace = {
      ...rejectedRepository.workspace!,
      revision: 1,
    };
    expect(
      coordinator.nextScheduledWakeAt(rejectedRepository.workspace, MIDPOINT),
    ).toBe(MIDPOINT);
    await coordinator.run(MIDPOINT, { reason: "timer" });
    expect(nonCas.calls).toHaveLength(3);

    const loneRepository = new MemoryRepository(openOverdueWorkspace());
    const loneDispatcher = new ControlledRejectionDispatcher(
      loneRepository,
      0,
      true,
    );
    const loneCoordinator = new SystemEventCoordinator(
      loneRepository,
      loneDispatcher,
    );
    await loneCoordinator.run("2026-07-12T08:10:00.000Z", {
      reason: "boot",
    });
    expect(
      loneCoordinator.nextScheduledWakeAt(
        loneRepository.workspace!,
        "2026-07-12T08:10:00.000Z",
      ),
    ).toBeUndefined();
  });

  it("does not let one suppressed command starve another due command", async () => {
    const repository = new MemoryRepository(twoOpenOverdueReviewsWorkspace());
    const dispatcher = new RejectOneReviewDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);
    const dueAt = "2026-07-12T08:10:00.000Z";

    await coordinator.run(dueAt, { reason: "boot" });

    expect(
      dispatcher.calls.map(({ command }) =>
        command.type === "mark_review_overdue" ? command.reviewId : command.type,
      ),
    ).toEqual(["review:a-overdue", "review:b-overdue"]);
    expect(repository.workspace?.reviews[0].id).toBe("review:a-overdue");
    expect(repository.workspace?.reviews[0].overdueMarkedAt).toBeUndefined();
    expect(repository.workspace?.reviews[1]).toMatchObject({
      id: "review:b-overdue",
      overdueMarkedAt: dueAt,
    });
  });

  it("continues to other due commands after one command exhausts CAS retries", async () => {
    const repository = new MemoryRepository(twoOpenOverdueReviewsWorkspace());
    const dispatcher = new RejectOneReviewDispatcher(repository, "cas");
    const dueAt = "2026-07-12T08:10:00.000Z";

    await new SystemEventCoordinator(repository, dispatcher, {
      maxCasRetries: 1,
    }).run(dueAt, { reason: "boot" });

    expect(
      dispatcher.calls.map(({ command }) =>
        command.type === "mark_review_overdue" ? command.reviewId : command.type,
      ),
    ).toEqual([
      "review:a-overdue",
      "review:a-overdue",
      "review:b-overdue",
    ]);
    expect(repository.workspace?.reviews[1]).toMatchObject({
      id: "review:b-overdue",
      overdueMarkedAt: dueAt,
    });
  });

  it("canonicalizes stale expiry before catching up midpoint and leaves no busy-loop wake", async () => {
    const repository = new MemoryRepository(activeBetWorkspace());
    const dispatcher = new RecordingDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);

    await coordinator.run(APPETITE_END);

    expect(
      dispatcher.calls.map(({ command }) =>
        command.type === "record_bet_boundary"
          ? `${command.type}:${command.boundary}`
          : command.type === "create_review"
            ? `${command.type}:${command.review.triggerKey}`
            : command.type === "mark_review_overdue"
              ? `${command.type}:${command.reviewId}`
              : command.type,
      ),
      JSON.stringify(
        dispatcher.results.map((result) =>
          result.ok ? "ok" : result.rejection.code,
        ),
      ),
    ).toEqual([
      "record_bet_boundary:expired",
      "record_bet_boundary:midpoint",
      "create_review:bet-1:midpoint",
      "mark_review_overdue:review:bet-1:midpoint",
      "create_review:bet-1:expired",
      "mark_review_overdue:review:bet-1:expired",
      'create_review:hard_gate:["project-1","rebet_required","bet-1","2026-07-12T10:00:00.000Z"]',
      'mark_review_overdue:review:hard_gate:["project-1","rebet_required","bet-1","2026-07-12T10:00:00.000Z"]',
    ]);
    expect(dispatcher.results.every((result) => result.ok)).toBe(true);
    expect(repository.workspace?.projects[0].stage).toBe("validating");
    expect(repository.workspace?.projects[0].holds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "rebet_required" }),
      ]),
    );
    expect(nextWakeAt(repository.workspace!, APPETITE_END)).toBeUndefined();

    await coordinator.run("2026-07-12T12:00:00.000Z");
    expect(dispatcher.calls).toHaveLength(8);
  });

  it("canonicalizes every expired Project before any cross-project midpoint", async () => {
    const repository = new MemoryRepository(twoExpiredProjectsWorkspace());
    const dispatcher = new RecordingDispatcher(repository);

    await new SystemEventCoordinator(repository, dispatcher).run(APPETITE_END);

    expect(
      dispatcher.calls.slice(0, 4).map(({ command }) =>
        command.type === "record_bet_boundary"
          ? `${command.projectId}:${command.boundary}`
          : command.type,
      ),
    ).toEqual([
      "project-a:expired",
      "project-b:expired",
      "project-a:midpoint",
      "project-b:midpoint",
    ]);
    expect(
      dispatcher.results.slice(0, 4).every((result) => result.ok),
      JSON.stringify(
        dispatcher.results.slice(0, 4).map((result) =>
          result.ok ? "ok" : result.rejection.code,
        ),
      ),
    ).toBe(true);
  });

  it("advances from midpoint to expiry after the midpoint run", async () => {
    const repository = new MemoryRepository(activeBetWorkspace());
    const coordinator = new SystemEventCoordinator(
      repository,
      new RecordingDispatcher(repository),
    );

    await coordinator.run(MIDPOINT);

    expect(nextWakeAt(repository.workspace!, MIDPOINT)).toBe(APPETITE_END);
  });

  it("creates the weekly Review on a midweek boot but marks it overdue only at the deadline", async () => {
    const repository = new MemoryRepository(weeklyWorkspace("UTC"));
    const dispatcher = new RecordingDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);
    const bootAt = "2026-07-08T12:00:00.000Z";
    const dueAt = "2026-07-12T18:00:00.000Z";

    expect(nextWakeAt(repository.workspace!, bootAt)).toBe(bootAt);
    expect(coordinator.nextScheduledWakeAt(repository.workspace!, bootAt)).toBe(
      bootAt,
    );
    await coordinator.run(bootAt, { reason: "boot" });
    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "create_review",
    ]);
    expect(repository.workspace?.reviews[0]).toMatchObject({
      triggerKey: "weekly:2026-07-06",
      status: "open",
      dueAt,
    });
    expect(repository.workspace?.reviews[0].overdueMarkedAt).toBeUndefined();
    expect(coordinator.nextScheduledWakeAt(repository.workspace!, bootAt)).toBe(
      dueAt,
    );

    await coordinator.run("2026-07-12T17:59:59.999Z", { reason: "timer" });
    expect(dispatcher.calls).toHaveLength(1);

    await coordinator.run(dueAt, { reason: "timer" });
    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "create_review",
      "mark_review_overdue",
    ]);
    expect(repository.workspace?.reviews[0]).toMatchObject({
      triggerKey: "weekly:2026-07-06",
      dueAt,
      overdueMarkedAt: dueAt,
    });
    expect(repository.workspace?.reviews).toHaveLength(1);
    const nextWeekOpensAt = "2026-07-13T00:00:00.000Z";
    expect(nextWakeAt(repository.workspace!, dueAt)).toBe(nextWeekOpensAt);
    expect(coordinator.nextScheduledWakeAt(repository.workspace!, dueAt)).toBe(
      nextWeekOpensAt,
    );

    await coordinator.run(nextWeekOpensAt, { reason: "timer" });
    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "create_review",
      "mark_review_overdue",
      "create_review",
    ]);
    expect(repository.workspace?.reviews[1]).toMatchObject({
      triggerKey: "weekly:2026-07-13",
      status: "open",
      dueAt: "2026-07-19T18:00:00.000Z",
    });
    expect(repository.workspace?.reviews[1].overdueMarkedAt).toBeUndefined();
    expect(
      coordinator.nextScheduledWakeAt(repository.workspace!, nextWeekOpensAt),
    ).toBe("2026-07-19T18:00:00.000Z");
  }, 15_000);

  it("keeps weekly opening and deadline wakes DST-aware", () => {
    const now = "2026-03-04T12:00:00.000Z";
    const currentDueAt = "2026-03-08T22:00:00.000Z";
    const workspace = weeklyWorkspace("America/New_York");
    workspace.capacityProfile!.updatedAt = "2026-03-01T00:00:00.000Z";

    expect(nextWakeAt(workspace, now)).toBe(now);

    const currentReview: ReviewRecord = {
      id: "review:weekly:2026-03-02",
      kind: "weekly",
      triggerKey: "weekly:2026-03-02",
      triggerType: "weekly",
      cadenceTimeZone: "America/New_York",
      status: "open",
      affectedProjectIds: [],
      affectedRecordIds: [],
      dueAt: currentDueAt,
      createdAt: now,
    };
    workspace.reviews = [structuredClone(currentReview)];
    expect(nextWakeAt(workspace, now)).toBe(currentDueAt);

    workspace.reviews = [
      {
        ...structuredClone(currentReview),
        status: "completed",
        conclusion: {
          summary: "The current weekly Review is complete.",
          decisionCodes: ["reviewed"],
          followUpCommandIds: [],
          actorId: "human-1",
          completedAt: now,
        },
      },
    ];
    expect(nextWakeAt(workspace, now)).toBe("2026-03-09T04:00:00.000Z");
  });

  it("excludes any Bet tombstone immediately but keeps Exception resolution as-of", async () => {
    const betWorkspace = activeBetWorkspace();
    betWorkspace.bets[0].invalidatedAt = "2026-07-12T09:30:00.000Z";
    betWorkspace.bets[0].invalidationReason = "A future imported decision.";
    expect(
      nextWakeAt(betWorkspace, "2026-07-12T08:30:00.000Z"),
    ).toBeUndefined();
    expect(nextWakeAt(betWorkspace, "2026-07-12T09:30:00.000Z")).toBeUndefined();
    const tombstoneRepository = new MemoryRepository(betWorkspace);
    const tombstoneDispatcher = new RecordingDispatcher(tombstoneRepository);
    await new SystemEventCoordinator(
      tombstoneRepository,
      tombstoneDispatcher,
    ).run("2026-07-12T08:30:00.000Z", { reason: "visibility" });
    expect(tombstoneDispatcher.calls).toEqual([]);

    const withFutureResolution = exceptionWorkspace();
    const exception = withFutureResolution.exceptions[0];
    exception.resolvedAt = "2026-07-12T08:30:00.000Z";
    exception.history.push({
      action: "resolved",
      actorId: "human-1",
      at: exception.resolvedAt,
      note: "Resolution becomes effective at the recorded instant.",
    });
    expect(nextWakeAt(withFutureResolution, APPROVED_AT)).toBe(
      "2026-07-12T08:15:00.000Z",
    );
    expect(
      nextWakeAt(withFutureResolution, "2026-07-12T08:30:00.000Z"),
    ).toBe(MIDPOINT);
  });

  it("excludes closed, ambiguous, resolved, completed, and persisted occurrences", () => {
    expect(
      nextWakeAt(
        buildWorkspaceV2("workspace-no-events"),
        "2026-07-12T08:30:00.000Z",
      ),
    ).toBeUndefined();

    const closed = activeBetWorkspace();
    closed.projects[0].stage = "closed";
    expect(nextWakeAt(closed, "2026-07-12T08:30:00.000Z")).toBeUndefined();

    const ambiguousBet = activeBetWorkspace();
    ambiguousBet.bets.push(structuredClone(ambiguousBet.bets[0]));
    expect(
      nextWakeAt(ambiguousBet, "2026-07-12T08:30:00.000Z"),
    ).toBeUndefined();

    const malformedBet = activeBetWorkspace();
    malformedBet.bets[0].invalidatedAt = "not-a-timestamp";
    malformedBet.bets[0].invalidationReason = "Malformed imported state.";
    expect(
      nextWakeAt(malformedBet, "2026-07-12T08:30:00.000Z"),
    ).toBeUndefined();

    const completed = openOverdueWorkspace();
    completed.reviews[0] = {
      ...completed.reviews[0],
      status: "completed",
      conclusion: {
        summary: "The occurrence was reviewed.",
        decisionCodes: ["reviewed"],
        followUpCommandIds: [],
        actorId: "human-1",
        completedAt: "2026-07-12T08:05:00.000Z",
      },
    };
    expect(
      nextWakeAt(completed, "2026-07-12T08:10:00.000Z"),
    ).toBeUndefined();

    const persistedMidpoint = activeBetWorkspace();
    persistedMidpoint.reviews = [
      {
        id: "review:bet-1:midpoint",
        kind: "event",
        triggerKey: "bet-1:midpoint",
        triggerType: "bet_midpoint",
        status: "open",
        affectedProjectIds: ["project-1"],
        affectedRecordIds: ["bet-1"],
        dueAt: MIDPOINT,
        createdAt: MIDPOINT,
        overdueMarkedAt: MIDPOINT,
      },
    ];
    expect(nextWakeAt(persistedMidpoint, MIDPOINT)).toBe(APPETITE_END);

    const resolved = exceptionWorkspace();
    const record = resolved.exceptions[0];
    record.resolvedAt = record.reviewAt;
    record.history.push({
      action: "resolved",
      actorId: "human-1",
      at: record.reviewAt,
      note: "The controlled exception was resolved.",
    });
    expect(nextWakeAt(resolved, record.reviewAt)).toBe(MIDPOINT);
  });

  it("catches up exception reviewAt and expiry independently", async () => {
    const repository = new MemoryRepository(exceptionWorkspace());
    const dispatcher = new RecordingDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);

    expect(nextWakeAt(repository.workspace!, APPROVED_AT)).toBe(
      "2026-07-12T08:15:00.000Z",
    );
    await coordinator.run("2026-07-12T08:15:00.000Z");
    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "create_review",
      "mark_review_overdue",
    ]);
    expect(repository.workspace?.reviews[0].triggerKey).toBe(
      "exception:exception-1:review:2026-07-12T08:15:00.000Z",
    );
    expect(
      nextWakeAt(repository.workspace!, "2026-07-12T08:15:00.000Z"),
    ).toBe("2026-07-12T08:45:00.000Z");

    await coordinator.run("2026-07-12T08:45:00.000Z");
    expect(dispatcher.calls.slice(2).map(({ command }) => command.type)).toEqual([
      "create_review",
      "mark_review_overdue",
    ]);
    expect(repository.workspace?.reviews[1].triggerKey).toBe(
      "exception:exception-1:expired",
    );
  });

  it("lets expiry supersede a missed exception reviewAt on boot", async () => {
    const repository = new MemoryRepository(exceptionWorkspace());
    const dispatcher = new RecordingDispatcher(repository);
    const expiresAt = "2026-07-12T08:45:00.000Z";

    await new SystemEventCoordinator(repository, dispatcher).run(expiresAt);

    expect(
      repository.workspace?.reviews.map(({ triggerKey }) => triggerKey),
    ).toEqual(["exception:exception-1:expired"]);
    expect(nextWakeAt(repository.workspace!, expiresAt)).toBe(MIDPOINT);
    await new SystemEventCoordinator(repository, dispatcher).run(expiresAt);
    expect(dispatcher.calls).toHaveLength(2);
  });

  it("marks an already-open Review overdue at equality without recreating it", async () => {
    const repository = new MemoryRepository(openOverdueWorkspace());
    const dispatcher = new RecordingDispatcher(repository);
    const coordinator = new SystemEventCoordinator(repository, dispatcher);
    const dueAt = "2026-07-12T08:10:00.000Z";

    expect(nextWakeAt(repository.workspace!, dueAt)).toBe(dueAt);
    await coordinator.run(dueAt);

    expect(dispatcher.calls.map(({ command }) => command.type)).toEqual([
      "mark_review_overdue",
    ]);
    expect(repository.workspace?.reviews[0].overdueMarkedAt).toBe(dueAt);
    expect(nextWakeAt(repository.workspace!, dueAt)).toBeUndefined();
  });

  it("is deterministic when source entity arrays arrive in a different order", async () => {
    const ordered = twoExpiredProjectsWorkspace();
    const reversed = structuredClone(ordered);
    reversed.projects.reverse();
    reversed.directionBriefs.reverse();
    reversed.bets.reverse();
    reversed.planVersions.reverse();
    reversed.workItems.reverse();

    const leftRepository = new MemoryRepository(ordered);
    const leftDispatcher = new RecordingDispatcher(leftRepository);
    const rightRepository = new MemoryRepository(reversed);
    const rightDispatcher = new RecordingDispatcher(rightRepository);
    await new SystemEventCoordinator(leftRepository, leftDispatcher).run(
      APPETITE_END,
    );
    await new SystemEventCoordinator(rightRepository, rightDispatcher).run(
      APPETITE_END,
    );

    expect(
      rightDispatcher.calls.map(({ context }) => context.commandId),
    ).toEqual(leftDispatcher.calls.map(({ context }) => context.commandId));
  });

  it("persists one accepted occurrence across two real IndexedDB tabs", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "omni-plan-system-event-two-tabs";
    const leftRepository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    const rightRepository = new BrowserWorkspaceRepository({
      databaseName,
      indexedDB,
    });
    try {
      const initial = activeBetWorkspace();
      // Production initialization is intentionally empty-only. This raw write
      // is scoped to integration fixture setup so the test can exercise a due
      // boundary through two real repository tabs.
      await seedWorkspaceFixture(databaseName, indexedDB, initial);
      const left = new SystemEventCoordinator(
        leftRepository,
        new CommandService(leftRepository, initial.workspaceId),
      );
      const right = new SystemEventCoordinator(
        rightRepository,
        new CommandService(rightRepository, initial.workspaceId),
      );

      await Promise.all([left.run(MIDPOINT), right.run(MIDPOINT)]);

      const stored = await leftRepository.load();
      expect(
        stored?.reviews.filter(({ triggerKey }) => triggerKey === "bet-1:midpoint"),
      ).toHaveLength(1);
      for (const commandType of [
        "record_bet_boundary",
        "create_review",
        "mark_review_overdue",
      ]) {
        expect(
          stored?.commandReceipts.filter(
            (receipt) =>
              receipt.commandType === commandType &&
              receipt.status === "applied",
          ),
        ).toHaveLength(1);
      }
      expect(await leftRepository.listPendingOutbox()).toHaveLength(3);
    } finally {
      await deleteV2Database({ databaseName, indexedDB });
    }
  });
});
