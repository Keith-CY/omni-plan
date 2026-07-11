import type { Id, ISODate } from "@/domain/types";

import type { CommandRejection, RejectionCode } from "./errors";
import {
  overlappingWeeklyReviewCoverage,
  storedReviewSemanticsAreValid,
} from "./review";
import type {
  AttentionKind,
  BetVersion,
  CommitmentSlot,
  ProjectV2,
  ProjectHold,
  Weekday,
  WorkspaceV2,
} from "./types";

export type InvariantViolation = Pick<
  CommandRejection,
  "code" | "reason" | "gate" | "hold" | "permittedNextCommand"
>;

interface CollectedViolation {
  value: InvariantViolation;
  identity: string;
}

const invariantCodeOrder: Partial<Record<RejectionCode, number>> = {
  BET_REQUIRED: 0,
  BET_EXPIRED: 1,
  CAPACITY_EXCEEDED: 2,
  SCOPE_OUTSIDE_BET: 3,
  EXCEPTION_EXPIRED: 4,
  PROJECT_CLOSED: 5,
  ENTITY_NOT_FOUND: 6,
};

const activeBetStages = new Set([
  "planning",
  "executing",
  "validating",
  "closing",
]);

const weekdayNames: Record<Weekday, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

const attentionOrder = [
  "deep",
  "medium",
  "shallow",
] as const satisfies readonly AttentionKind[];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedById<T extends { id: Id }>(values: readonly T[]): T[] {
  return [...values].sort(
    (left, right) =>
      compareText(left.id, right.id) ||
      compareText(canonicalString(left), canonicalString(right)),
  );
}

function indexById<T extends { id: Id }>(values: readonly T[]): Map<Id, T> {
  const index = new Map<Id, T>();
  for (const value of sortedById(values)) {
    if (!index.has(value.id)) {
      index.set(value.id, value);
    }
  }
  return index;
}

const setLikePrimitiveArrayKeys = new Set([
  "affectedProjectIds",
  "affectedRecordIds",
]);

function isProjectHoldState(value: unknown): value is {
  type: string;
  sourceId: string;
  createdAt: string;
  affectedRecordIds: unknown[];
} {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    typeof (value as { sourceId?: unknown }).sourceId === "string" &&
    typeof (value as { createdAt?: unknown }).createdAt === "string" &&
    Array.isArray((value as { affectedRecordIds?: unknown }).affectedRecordIds)
  );
}

function canonicalValue(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => ({
      source: item,
      canonical: canonicalValue(item),
    }));
    if (
      parentKey !== undefined &&
      setLikePrimitiveArrayKeys.has(parentKey) &&
      items.every(({ source }) => typeof source === "string")
    ) {
      items.sort((left, right) =>
        compareText(left.source as string, right.source as string),
      );
    } else if (
      parentKey === "holds" &&
      items.every(({ source }) => isProjectHoldState(source))
    ) {
      items.sort((left, right) => {
        const leftHold = left.source as {
          type: string;
          sourceId: string;
          createdAt: string;
        };
        const rightHold = right.source as {
          type: string;
          sourceId: string;
          createdAt: string;
        };
        return (
          compareText(leftHold.type, rightHold.type) ||
          compareText(leftHold.sourceId, rightHold.sourceId) ||
          compareText(leftHold.createdAt, rightHold.createdAt) ||
          compareText(
            JSON.stringify(left.canonical),
            JSON.stringify(right.canonical),
          )
        );
      });
    } else if (
      items.every(
        ({ source }) =>
          source !== null &&
          typeof source === "object" &&
          typeof (source as { id?: unknown }).id === "string",
      )
    ) {
      items.sort(
        (left, right) =>
          compareText(
            (left.source as { id: string }).id,
            (right.source as { id: string }).id,
          ) ||
          compareText(
            JSON.stringify(left.canonical),
            JSON.stringify(right.canonical),
          ),
      );
    }
    return items.map(({ canonical }) => canonical);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) {
        result[key] = canonicalValue(item, key);
      }
    }
    return result;
  }
  return value;
}

function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sameStructure(left: unknown, right: unknown): boolean {
  return canonicalString(left) === canonicalString(right);
}

function parseTimestamp(value: ISODate): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isCanonicalTimestamp(value: ISODate): boolean {
  const timestamp = parseTimestamp(value);
  return (
    timestamp !== undefined && new Date(timestamp).toISOString() === value
  );
}

function isAtOrBefore(value: ISODate, boundary: ISODate): boolean {
  const valueTimestamp = parseTimestamp(value);
  const boundaryTimestamp = parseTimestamp(boundary);
  return (
    valueTimestamp !== undefined &&
    boundaryTimestamp !== undefined &&
    valueTimestamp <= boundaryTimestamp
  );
}

function weekdayFromLocalDate(localDate: string): Weekday | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (match === null) {
    return undefined;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return date.getUTCDay() as Weekday;
}

function createCollector() {
  const violations = new Map<string, CollectedViolation>();

  function add(
    code: RejectionCode,
    reason: string,
    gate: string,
    permittedNextCommand: string,
    hold?: ProjectHold,
  ): void {
    const identity = `${code}\u0000${gate}\u0000${reason}\u0000${
      hold ?? ""
    }`;
    if (violations.has(identity)) {
      return;
    }

    const value: InvariantViolation = {
      code,
      reason,
      gate,
      permittedNextCommand,
    };
    if (hold !== undefined) {
      value.hold = hold;
    }
    violations.set(identity, { value, identity });
  }

  function result(): InvariantViolation[] {
    return [...violations.values()]
      .sort(
        (left, right) =>
          (invariantCodeOrder[left.value.code] ?? Number.MAX_SAFE_INTEGER) -
            (invariantCodeOrder[right.value.code] ?? Number.MAX_SAFE_INTEGER) ||
          compareText(left.value.gate ?? "", right.value.gate ?? "") ||
          compareText(left.value.reason, right.value.reason) ||
          compareText(left.identity, right.identity),
      )
      .map(({ value }) => value);
  }

  return { add, result };
}

type AddViolation = ReturnType<typeof createCollector>["add"];

function findValidCurrentBet(
  project: ProjectV2,
  betsById: ReadonlyMap<Id, BetVersion>,
): BetVersion | undefined {
  if (project.activeBetId === undefined) {
    return undefined;
  }
  const bet = betsById.get(project.activeBetId);
  return bet !== undefined &&
    bet.projectId === project.id &&
    bet.invalidatedAt === undefined
    ? bet
    : undefined;
}

function betDataWithoutInvalidation(
  bet: BetVersion,
): Omit<BetVersion, "invalidatedAt" | "invalidationReason"> {
  const comparable = { ...bet };
  delete comparable.invalidatedAt;
  delete comparable.invalidationReason;
  return comparable;
}

function isIntentionallyPausedForRebet(
  workspace: WorkspaceV2,
  previousWorkspace: WorkspaceV2 | undefined,
  project: ProjectV2,
  betsById: ReadonlyMap<Id, BetVersion>,
): boolean {
  if (
    previousWorkspace === undefined ||
    !project.holds.some(({ type }) => type === "rebet_required") ||
    project.activeBetId === undefined
  ) {
    return false;
  }

  const previousProject = indexById(previousWorkspace.projects).get(project.id);
  if (
    previousProject === undefined ||
    previousProject.stage !== project.stage ||
    previousProject.activeBetId !== project.activeBetId ||
    previousProject.activePlanVersionId !== project.activePlanVersionId
  ) {
    return false;
  }

  const previousBet = indexById(previousWorkspace.bets).get(project.activeBetId);
  const candidateBet = betsById.get(project.activeBetId);
  if (
    previousBet === undefined ||
    previousBet.projectId !== project.id ||
    candidateBet === undefined ||
    candidateBet.projectId !== project.id ||
    candidateBet.invalidatedAt === undefined ||
    workspace.bets.some(
      (bet) => bet.projectId === project.id && bet.invalidatedAt === undefined,
    )
  ) {
    return false;
  }

  const atomicPauseEntry =
    previousBet.invalidatedAt === undefined &&
    sameStructure(
      betDataWithoutInvalidation(candidateBet),
      betDataWithoutInvalidation(previousBet),
    );
  const previousRebetHolds = previousProject.holds.filter(
    ({ type }) => type === "rebet_required",
  );
  const candidateRebetHolds = project.holds.filter(
    ({ type }) => type === "rebet_required",
  );
  const persistedPauseContinuation =
    previousBet.invalidatedAt !== undefined &&
    sameStructure(candidateBet, previousBet) &&
    previousRebetHolds.length > 0 &&
    sameStructure(candidateRebetHolds, previousRebetHolds);

  return atomicPauseEntry || persistedPauseContinuation;
}

function planScopeIsStructurallyValid(
  workspace: WorkspaceV2,
  plan: WorkspaceV2["planVersions"][number],
): boolean {
  const bet = indexById(workspace.bets).get(plan.betId);
  if (bet === undefined || bet.projectId !== plan.projectId) {
    return false;
  }
  const workItemsById = indexById(workspace.workItems);
  const committedScopeIds = new Set(bet.committedScope.map(({ id }) => id));
  const workItemScopeIsValid = Object.keys(plan.workItemRevisions).every(
    (workItemId) => {
      const workItem = workItemsById.get(workItemId);
      return (
        workItem !== undefined &&
        workItem.projectId === plan.projectId &&
        Object.prototype.hasOwnProperty.call(plan.scopeMapping, workItemId) &&
        plan.scopeMapping[workItemId] === workItem.betScopeId &&
        committedScopeIds.has(workItem.betScopeId)
      );
    },
  );
  if (!workItemScopeIsValid) {
    return false;
  }

  const dependenciesById = indexById(workspace.dependencies);
  return Object.keys(plan.dependencyRevisions).every((dependencyId) => {
    const dependency = dependenciesById.get(dependencyId);
    return (
      dependency !== undefined &&
      dependency.projectId === plan.projectId
    );
  });
}

function isFrozenHistoricalPlan(
  workspace: WorkspaceV2,
  previousWorkspace: WorkspaceV2 | undefined,
  project: ProjectV2,
  plan: WorkspaceV2["planVersions"][number],
  betsById: ReadonlyMap<Id, BetVersion>,
): boolean {
  if (
    previousWorkspace === undefined ||
    !isIntentionallyPausedForRebet(
      workspace,
      previousWorkspace,
      project,
      betsById,
    )
  ) {
    return false;
  }

  const previousProject = indexById(previousWorkspace.projects).get(project.id);
  const previousPlan = indexById(previousWorkspace.planVersions).get(plan.id);
  if (
    previousProject?.activePlanVersionId !== plan.id ||
    previousPlan === undefined ||
    plan.betId !== project.activeBetId ||
    previousPlan.betId !== previousProject.activeBetId ||
    !sameStructure(plan, previousPlan) ||
    !planScopeIsStructurallyValid(previousWorkspace, previousPlan)
  ) {
    return false;
  }

  const currentWorkItemsById = indexById(workspace.workItems);
  const previousWorkItemsById = indexById(previousWorkspace.workItems);
  const referencedWorkItemsAreFrozen = Object.keys(plan.workItemRevisions).every(
    (workItemId) => {
      const currentWorkItem = currentWorkItemsById.get(workItemId);
      const previousWorkItem = previousWorkItemsById.get(workItemId);
      return (
        currentWorkItem !== undefined &&
        previousWorkItem !== undefined &&
        sameStructure(currentWorkItem, previousWorkItem)
      );
    },
  );
  if (!referencedWorkItemsAreFrozen) {
    return false;
  }

  const currentDependenciesById = indexById(workspace.dependencies);
  const previousDependenciesById = indexById(previousWorkspace.dependencies);
  return Object.keys(plan.dependencyRevisions).every((dependencyId) => {
    const currentDependency = currentDependenciesById.get(dependencyId);
    const previousDependency = previousDependenciesById.get(dependencyId);
    return (
      currentDependency !== undefined &&
      previousDependency !== undefined &&
      sameStructure(currentDependency, previousDependency)
    );
  });
}

function validateBetRules(
  workspace: WorkspaceV2,
  now: ISODate,
  previousWorkspace: WorkspaceV2 | undefined,
  add: AddViolation,
): void {
  const betsById = indexById(workspace.bets);
  const plansById = indexById(workspace.planVersions);
  const projectsById = indexById(workspace.projects);
  const workItemsById = indexById(workspace.workItems);
  const actualsById = indexById(workspace.actuals);
  const commitmentsById = indexById(workspace.dailyCommitments);
  const previousActualsById = indexById(previousWorkspace?.actuals ?? []);
  const previousWorkItemsById = indexById(
    previousWorkspace?.workItems ?? [],
  );
  const previousCommitmentsById = indexById(
    previousWorkspace?.dailyCommitments ?? [],
  );

  for (const project of sortedById(workspace.projects)) {
    const currentBets = sortedById(
      workspace.bets.filter(
        (bet) =>
          bet.projectId === project.id && bet.invalidatedAt === undefined,
      ),
    );

    if (activeBetStages.has(project.stage) && currentBets.length > 1) {
      add(
        "BET_REQUIRED",
        `Active project ${project.id} has multiple current Bets: ${currentBets
          .map(({ id }) => id)
          .join(", ")}.`,
        `project:${project.id}:single_current_bet`,
        "place_bet",
      );
    }

    const validActiveBet = findValidCurrentBet(project, betsById);
    const rebetPaused = isIntentionallyPausedForRebet(
      workspace,
      previousWorkspace,
      project,
      betsById,
    );
    if (
      activeBetStages.has(project.stage) &&
      validActiveBet === undefined &&
      !rebetPaused
    ) {
      add(
        "BET_REQUIRED",
        project.stage === "executing"
          ? `Executing project ${project.id} has no valid current Bet.`
          : `Active project ${project.id} has no valid current Bet while ${project.stage}.`,
        `project:${project.id}:current_bet`,
        "place_bet",
      );
    }

    if (
      project.activePlanVersionId !== undefined &&
      plansById.has(project.activePlanVersionId)
    ) {
      const plan = plansById.get(project.activePlanVersionId)!;
      const planBet = betsById.get(plan.betId);
      const frozenHistoricalPlan = isFrozenHistoricalPlan(
        workspace,
        previousWorkspace,
        project,
        plan,
        betsById,
      );
      if (
        !frozenHistoricalPlan &&
        (validActiveBet === undefined ||
          plan.betId !== validActiveBet.id ||
          planBet === undefined ||
          planBet.invalidatedAt !== undefined ||
          planBet.projectId !== project.id)
      ) {
        add(
          "BET_REQUIRED",
          `Active Plan ${plan.id} must use current Bet ${
            validActiveBet?.id ?? project.activeBetId ?? "none"
          }, not historical or mismatched Bet ${plan.betId}.`,
          `plan:${plan.id}:current_bet`,
          "place_bet",
        );
      }
    }

    if (
      project.stage === "executing" &&
      validActiveBet !== undefined &&
      isAtOrBefore(validActiveBet.appetiteEnd, now)
    ) {
      add(
        "BET_EXPIRED",
        `Current Bet ${validActiveBet.id} for executing project ${project.id} expired at ${validActiveBet.appetiteEnd}.`,
        `bet:${validActiveBet.id}:appetite_end`,
        "record_bet_boundary",
      );
    }
  }

  for (const actual of sortedById(workspace.actuals)) {
    if (actual.target.kind !== "work_item") {
      continue;
    }
    const workItem = workItemsById.get(actual.target.workItemId);
    const project =
      workItem === undefined ? undefined : projectsById.get(workItem.projectId);
    if (
      workItem !== undefined &&
      project !== undefined &&
      findValidCurrentBet(project, betsById) === undefined
    ) {
      const previousActual = previousActualsById.get(actual.id);
      if (
        isIntentionallyPausedForRebet(
          workspace,
          previousWorkspace,
          project,
          betsById,
        ) &&
        previousActual !== undefined &&
        sameStructure(actual, previousActual)
      ) {
        continue;
      }
      add(
        "BET_REQUIRED",
        `Actual ${actual.id} targets Work Item ${workItem.id} without a valid current Bet for Project ${project.id}.`,
        `actual:${actual.id}:current_bet`,
        "place_bet",
      );
    }
  }

  for (const commitment of sortedById(workspace.dailyCommitments)) {
    for (const slot of sortedById(commitment.slots)) {
      if (slot.target.kind !== "work_item") {
        continue;
      }
      const workItem = workItemsById.get(slot.target.workItemId);
      const project =
        workItem === undefined ? undefined : projectsById.get(workItem.projectId);
      if (
        workItem !== undefined &&
        project !== undefined &&
        findValidCurrentBet(project, betsById) === undefined
      ) {
        const previousCommitment = previousCommitmentsById.get(commitment.id);
        const previousSlot = indexById(previousCommitment?.slots ?? []).get(
          slot.id,
        );
        if (
          isIntentionallyPausedForRebet(
            workspace,
            previousWorkspace,
            project,
            betsById,
          ) &&
          previousSlot !== undefined &&
          sameStructure(slot, previousSlot)
        ) {
          continue;
        }
        add(
          "BET_REQUIRED",
          `Daily Commitment ${commitment.id} slot ${slot.id} targets Work Item ${workItem.id} without a valid current Bet for Project ${project.id}.`,
          `daily_commitment:${commitment.id}:slot:${slot.id}:current_bet`,
          "place_bet",
        );
      }
    }
  }

  if (previousWorkspace === undefined) {
    return;
  }

  for (const previousActual of sortedById(previousWorkspace.actuals)) {
    if (previousActual.target.kind !== "work_item") {
      continue;
    }
    const previousWorkItem = previousWorkItemsById.get(
      previousActual.target.workItemId,
    );
    if (previousWorkItem === undefined) {
      continue;
    }
    const project = projectsById.get(previousWorkItem.projectId);
    if (
      project === undefined ||
      !isIntentionallyPausedForRebet(
        workspace,
        previousWorkspace,
        project,
        betsById,
      )
    ) {
      continue;
    }
    const candidateActual = actualsById.get(previousActual.id);
    if (
      candidateActual !== undefined &&
      sameStructure(candidateActual, previousActual)
    ) {
      continue;
    }
    add(
      "BET_REQUIRED",
      `Actual ${previousActual.id} targets Work Item ${previousWorkItem.id} without a valid current Bet for Project ${project.id}.`,
      `actual:${previousActual.id}:current_bet`,
      "place_bet",
    );
  }

  for (const previousCommitment of sortedById(
    previousWorkspace.dailyCommitments,
  )) {
    const candidateCommitment = commitmentsById.get(previousCommitment.id);
    const candidateSlotsById = indexById(candidateCommitment?.slots ?? []);
    for (const previousSlot of sortedById(previousCommitment.slots)) {
      if (previousSlot.target.kind !== "work_item") {
        continue;
      }
      const previousWorkItem = previousWorkItemsById.get(
        previousSlot.target.workItemId,
      );
      if (previousWorkItem === undefined) {
        continue;
      }
      const project = projectsById.get(previousWorkItem.projectId);
      if (
        project === undefined ||
        !isIntentionallyPausedForRebet(
          workspace,
          previousWorkspace,
          project,
          betsById,
        )
      ) {
        continue;
      }
      const candidateSlot = candidateSlotsById.get(previousSlot.id);
      if (
        candidateSlot !== undefined &&
        sameStructure(candidateSlot, previousSlot)
      ) {
        continue;
      }
      add(
        "BET_REQUIRED",
        `Daily Commitment ${previousCommitment.id} slot ${previousSlot.id} targets Work Item ${previousWorkItem.id} without a valid current Bet for Project ${project.id}.`,
        `daily_commitment:${previousCommitment.id}:slot:${previousSlot.id}:current_bet`,
        "place_bet",
      );
    }
  }
}

function validateCapacityRules(
  workspace: WorkspaceV2,
  add: AddViolation,
): void {
  for (const commitment of sortedById(workspace.dailyCommitments)) {
    const weekday = weekdayFromLocalDate(commitment.localDate);
    if (weekday === undefined) {
      add(
        "CAPACITY_EXCEEDED",
        `Daily Commitment ${commitment.id} has invalid local date ${commitment.localDate}.`,
        `daily_commitment:${commitment.id}:local_date`,
        "commit_today",
      );
      continue;
    }

    const totals: Record<AttentionKind, number> = {
      deep: 0,
      medium: 0,
      shallow: 0,
    };
    const invalidSlotIds: Id[] = [];

    for (const slot of sortedById(commitment.slots)) {
      const start = parseTimestamp(slot.start);
      const finish = parseTimestamp(slot.finish);
      const durationSeconds =
        start === undefined || finish === undefined
          ? undefined
          : (finish - start) / 1_000;
      if (
        durationSeconds === undefined ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0
      ) {
        invalidSlotIds.push(slot.id);
        continue;
      }
      totals[slot.attention] += durationSeconds;
    }

    if (invalidSlotIds.length > 0) {
      add(
        "CAPACITY_EXCEEDED",
        `Daily Commitment ${commitment.id} has invalid or nonpositive slot ranges: ${invalidSlotIds.join(
          ", ",
        )}.`,
        `daily_commitment:${commitment.id}:slot_ranges`,
        "commit_today",
      );
    }

    const budget = [...commitment.capacitySnapshot.dailyBudgets]
      .filter((candidate) => candidate.weekday === weekday)
      .sort(
        (left, right) =>
          left.deepSeconds - right.deepSeconds ||
          left.mediumSeconds - right.mediumSeconds ||
          left.shallowSeconds - right.shallowSeconds,
      )[0];

    for (const attention of attentionOrder) {
      const budgetKey = `${attention}Seconds` as const;
      const allowedSeconds = budget?.[budgetKey] ?? 0;
      if (totals[attention] <= allowedSeconds) {
        continue;
      }
      add(
        "CAPACITY_EXCEEDED",
        `Daily Commitment ${commitment.id} exceeds ${weekdayNames[weekday]} ${attention} capacity: ${totals[attention]} seconds scheduled for a ${allowedSeconds} second budget.`,
        `daily_commitment:${commitment.id}:capacity:${attention}`,
        "commit_today",
      );
    }
  }
}

function validateScopeRules(
  workspace: WorkspaceV2,
  previousWorkspace: WorkspaceV2 | undefined,
  add: AddViolation,
): void {
  const plansById = indexById(workspace.planVersions);
  const betsById = indexById(workspace.bets);
  const workItemsById = indexById(workspace.workItems);

  for (const project of sortedById(workspace.projects)) {
    if (project.activePlanVersionId === undefined) {
      continue;
    }
    const plan = plansById.get(project.activePlanVersionId);
    if (plan === undefined) {
      continue;
    }
    if (
      isFrozenHistoricalPlan(
        workspace,
        previousWorkspace,
        project,
        plan,
        betsById,
      )
    ) {
      continue;
    }
    const candidateBet = betsById.get(plan.betId);
    const bet =
      candidateBet !== undefined &&
      project.activeBetId === plan.betId &&
      candidateBet.projectId === project.id &&
      candidateBet.invalidatedAt === undefined
        ? candidateBet
        : undefined;
    const committedScopeIds = new Set(
      bet?.committedScope.map(({ id }) => id) ?? [],
    );

    for (const workItemId of Object.keys(plan.workItemRevisions).sort(compareText)) {
      const gate = `plan:${plan.id}:work_item:${workItemId}:bet_scope`;
      const workItem = workItemsById.get(workItemId);
      if (workItem === undefined) {
        add(
          "SCOPE_OUTSIDE_BET",
          `Active Plan ${plan.id} references missing Work Item ${workItemId}, so its Bet scope cannot be validated.`,
          gate,
          "update_work_item",
        );
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(plan.scopeMapping, workItemId)) {
        add(
          "SCOPE_OUTSIDE_BET",
          `Active Plan ${plan.id} has no scope mapping for Work Item ${workItemId}.`,
          gate,
          "update_work_item",
        );
        continue;
      }

      const mappedScopeId = plan.scopeMapping[workItemId];
      if (mappedScopeId !== workItem.betScopeId) {
        add(
          "SCOPE_OUTSIDE_BET",
          `Active Plan ${plan.id} maps Work Item ${workItemId} to scope ${mappedScopeId}, but the Work Item declares ${workItem.betScopeId}.`,
          gate,
          "update_work_item",
        );
        continue;
      }

      if (bet === undefined || !committedScopeIds.has(mappedScopeId)) {
        add(
          "SCOPE_OUTSIDE_BET",
          `Active Plan ${plan.id} maps Work Item ${workItemId} to scope ${mappedScopeId}, which is not committed by Bet ${plan.betId}.`,
          gate,
          "update_work_item",
        );
      }
    }
  }
}

function closedProjectSnapshot(workspace: WorkspaceV2, projectId: Id): unknown {
  const projects = sortedById(
    workspace.projects.filter((project) => project.id === projectId),
  );
  const workItems = sortedById(
    workspace.workItems.filter((workItem) => workItem.projectId === projectId),
  );
  const workItemIds = new Set(workItems.map(({ id }) => id));
  const promotedActions = sortedById(
    workspace.actions.filter(
      ({ promotedProjectId }) => promotedProjectId === projectId,
    ),
  );
  const promotedActionIds = new Set(promotedActions.map(({ id }) => id));
  const slotTargetsProject = (slot: CommitmentSlot): boolean =>
    slot.target.kind === "work_item" &&
    (slot.target.projectId === projectId ||
      workItemIds.has(slot.target.workItemId));
  const dailyCommitments = sortedById(
    workspace.dailyCommitments.filter((commitment) =>
      commitment.slots.some(slotTargetsProject),
    ),
  );
  const dailyCommitmentIds = new Set(
    dailyCommitments.map(({ id }) => id),
  );
  const bets = sortedById(
    workspace.bets.filter((bet) => bet.projectId === projectId),
  );
  const exceptions = sortedById(
    workspace.exceptions.filter(
      (exception) => exception.projectId === projectId,
    ),
  );
  const closeDecisions = sortedById(
    workspace.closeDecisions.filter(
      (decision) => decision.projectId === projectId,
    ),
  );
  const actuals = sortedById(
    workspace.actuals.filter(
      (actual) =>
        (actual.target.kind === "work_item" &&
          workItemIds.has(actual.target.workItemId)) ||
        (actual.target.kind === "action" &&
          promotedActionIds.has(actual.target.actionId)),
    ),
  );
  const replanProposals = sortedById(
    workspace.replanProposals.filter(
      (replan) =>
        dailyCommitmentIds.has(replan.baseCommitmentId) ||
        replan.proposedSlots.some(slotTargetsProject),
    ),
  );
  const protectedProjectRecordIds = new Set<Id>([
    projectId,
    ...promotedActionIds,
    ...workItemIds,
    ...dailyCommitmentIds,
    ...bets.map(({ id }) => id),
    ...exceptions.map(({ id }) => id),
    ...closeDecisions.map(({ id }) => id),
    ...actuals.map(({ id }) => id),
    ...replanProposals.map(({ id }) => id),
    ...workspace.directionBriefs
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
    ...workspace.planVersions
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
    ...workspace.dependencies
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
    ...workspace.baselines
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
    ...workspace.evidence
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
    ...workspace.legacyAuditRecords
      .filter((record) => record.projectId === projectId)
      .map(({ id }) => id),
  ]);
  const reviews = sortedById(
    workspace.reviews.filter(
      (review) =>
        review.affectedProjectIds.includes(projectId) ||
        review.affectedRecordIds.some((recordId) =>
          protectedProjectRecordIds.has(recordId),
        ),
    ),
  );
  const protectedRecordIdsByType = {
    bet: new Set(bets.map(({ id }) => id)),
    daily_commitment: dailyCommitmentIds,
    review: new Set(reviews.map(({ id }) => id)),
    exception: new Set(exceptions.map(({ id }) => id)),
    close: new Set(closeDecisions.map(({ id }) => id)),
  };

  return {
    project: projects[0] ?? null,
    promotedActions,
    directionBriefs: sortedById(
      workspace.directionBriefs.filter(
        (brief) => brief.projectId === projectId,
      ),
    ),
    bets,
    planVersions: sortedById(
      workspace.planVersions.filter((plan) => plan.projectId === projectId),
    ),
    workItems,
    dependencies: sortedById(
      workspace.dependencies.filter(
        (dependency) => dependency.projectId === projectId,
      ),
    ),
    baselines: sortedById(
      workspace.baselines.filter(
        (baseline) => baseline.projectId === projectId,
      ),
    ),
    evidence: sortedById(
      workspace.evidence.filter(
        (evidence) => evidence.projectId === projectId,
      ),
    ),
    exceptions,
    closeDecisions,
    legacyAuditRecords: sortedById(
      workspace.legacyAuditRecords.filter(
        (record) => record.projectId === projectId,
      ),
    ),
    actuals,
    dailyCommitments,
    replanProposals,
    reviews,
    syncConflicts: sortedById(
      workspace.syncConflicts.filter(
        (conflict) =>
          conflict.projectId === projectId ||
          protectedRecordIdsByType[conflict.recordType].has(conflict.recordId),
      ),
    ),
  };
}

function validateClosedProjectRules(
  workspace: WorkspaceV2,
  previousWorkspace: WorkspaceV2 | undefined,
  add: AddViolation,
): void {
  if (previousWorkspace === undefined) {
    return;
  }

  for (const previousProject of sortedById(previousWorkspace.projects)) {
    if (previousProject.stage !== "closed") {
      continue;
    }

    const previousSnapshot = closedProjectSnapshot(
      previousWorkspace,
      previousProject.id,
    );
    const candidateSnapshot = closedProjectSnapshot(workspace, previousProject.id);
    if (sameStructure(previousSnapshot, candidateSnapshot)) {
      continue;
    }

    add(
      "PROJECT_CLOSED",
      `Closed project ${previousProject.id} and its project-linked records are immutable.`,
      `project:${previousProject.id}:closed_snapshot`,
      "create_follow_up_project",
    );
  }
}

interface ReferenceTarget {
  id: Id;
  projectId?: Id;
}

function validateReferenceRules(
  workspace: WorkspaceV2,
  add: AddViolation,
): void {
  const projectsById = indexById(workspace.projects);
  const briefsById = indexById(workspace.directionBriefs);
  const betsById = indexById(workspace.bets);
  const plansById = indexById(workspace.planVersions);
  const inboxById = indexById(workspace.inboxItems);
  const actionsById = indexById(workspace.actions);
  const workItemsById = indexById(workspace.workItems);
  const dependenciesById = indexById(workspace.dependencies);
  const commitmentsById = indexById(workspace.dailyCommitments);
  const reviewsById = indexById(workspace.reviews);
  const exceptionsById = indexById(workspace.exceptions);
  const closeDecisionsById = indexById(workspace.closeDecisions);
  const syncConflictsById = indexById(workspace.syncConflicts);
  const legacyAuditRecordsById = indexById(workspace.legacyAuditRecords);
  const resourcesById = indexById(workspace.resources);
  const knownRecordsById = new Map<Id, ReferenceTarget>();
  for (const records of [
    workspace.inboxItems,
    workspace.actions,
    workspace.projects,
    workspace.directionBriefs,
    workspace.bets,
    workspace.planVersions,
    workspace.dailyCommitments,
    workspace.replanProposals,
    workspace.reviews,
    workspace.exceptions,
    workspace.closeDecisions,
    workspace.commandProposals,
    workspace.syncConflicts,
    workspace.commandReceipts,
    workspace.workItems,
    workspace.dependencies,
    workspace.resources,
    workspace.baselines,
    workspace.evidence,
    workspace.actuals,
    workspace.legacyAuditRecords,
  ] as const) {
    for (const record of sortedById<ReferenceTarget>(records)) {
      if (!knownRecordsById.has(record.id)) {
        knownRecordsById.set(record.id, record);
      }
    }
  }
  const nestedReferenceTargets: ReferenceTarget[] = [
    ...workspace.directionBriefs.flatMap(({ firstScope }) => firstScope),
    ...workspace.bets.flatMap((bet) => [
      ...bet.committedScope,
      ...bet.briefSnapshot.firstScope,
    ]),
    ...workspace.dailyCommitments.flatMap(({ slots, capacitySnapshot }) => [
      ...slots,
      ...capacitySnapshot.unavailableBlocks,
    ]),
    ...workspace.replanProposals.flatMap(({ proposedSlots }) => proposedSlots),
    ...(workspace.capacityProfile?.unavailableBlocks ?? []),
  ];
  for (const record of sortedById(nestedReferenceTargets)) {
    if (!knownRecordsById.has(record.id)) {
      knownRecordsById.set(record.id, record);
    }
  }
  if (workspace.migration !== undefined) {
    knownRecordsById.set(workspace.migration.backupId, {
      id: workspace.migration.backupId,
    });
  }

  function requireReference(
    ownerType: string,
    ownerId: Id,
    field: string,
    targetType: string,
    targetId: Id,
    target: ReferenceTarget | undefined,
    expectedProjectId?: Id,
  ): void {
    const gate = `reference:${ownerType}:${ownerId}:${field}`;
    if (target === undefined) {
      add(
        "ENTITY_NOT_FOUND",
        `${ownerType} ${ownerId} references missing ${targetType} ${targetId} through ${field}.`,
        gate,
        "repair_workspace_reference",
      );
      return;
    }

    if (
      expectedProjectId !== undefined &&
      target.projectId !== expectedProjectId
    ) {
      add(
        "ENTITY_NOT_FOUND",
        `${ownerType} ${ownerId} references ${targetType} ${targetId} through ${field}, but it does not belong to Project ${expectedProjectId}.`,
        gate,
        "repair_workspace_reference",
      );
    }
  }

  function validateSlot(
    ownerType: string,
    ownerId: Id,
    fieldPrefix: string,
    slot: CommitmentSlot,
  ): void {
    if (slot.target.kind === "action") {
      requireReference(
        ownerType,
        ownerId,
        `${fieldPrefix}:${slot.id}:actionId`,
        "Action",
        slot.target.actionId,
        actionsById.get(slot.target.actionId),
      );
      return;
    }

    requireReference(
      ownerType,
      ownerId,
      `${fieldPrefix}:${slot.id}:projectId`,
      "ProjectV2",
      slot.target.projectId,
      projectsById.get(slot.target.projectId),
    );
    requireReference(
      ownerType,
      ownerId,
      `${fieldPrefix}:${slot.id}:workItemId`,
      "ProjectWorkItem",
      slot.target.workItemId,
      workItemsById.get(slot.target.workItemId),
      slot.target.projectId,
    );
  }

  function holdSourceTarget(
    type: ProjectHold,
    sourceId: Id,
  ): ReferenceTarget | undefined {
    switch (type) {
      case "migration_review":
        return (
          legacyAuditRecordsById.get(sourceId) ??
          (workspace.migration?.backupId === sourceId
            ? { id: sourceId }
            : undefined)
        );
      case "rebet_required":
        return betsById.get(sourceId) ?? reviewsById.get(sourceId);
      case "review_overdue":
        return reviewsById.get(sourceId);
      case "sync_conflict":
        return syncConflictsById.get(sourceId);
    }
  }

  for (const project of sortedById(workspace.projects)) {
    requireReference(
      "ProjectV2",
      project.id,
      "activeDirectionBriefId",
      "DirectionBrief",
      project.activeDirectionBriefId,
      briefsById.get(project.activeDirectionBriefId),
      project.id,
    );
    if (project.activeBetId !== undefined) {
      requireReference(
        "ProjectV2",
        project.id,
        "activeBetId",
        "BetVersion",
        project.activeBetId,
        betsById.get(project.activeBetId),
        project.id,
      );
    }
    if (project.activePlanVersionId !== undefined) {
      requireReference(
        "ProjectV2",
        project.id,
        "activePlanVersionId",
        "PlanVersion",
        project.activePlanVersionId,
        plansById.get(project.activePlanVersionId),
        project.id,
      );
    }
    if (project.legacyClosure !== undefined) {
      const legacyRecord = legacyAuditRecordsById.get(
        project.legacyClosure.legacyRecordId,
      );
      const gate = `reference:ProjectV2:${project.id}:legacyClosure.legacyRecordId`;
      if (
        legacyRecord === undefined ||
        legacyRecord.projectId !== project.id ||
        legacyRecord.recordType !== "legacy_closure" ||
        legacyRecord.sourceChecksum !== project.legacyClosure.sourceChecksum
      ) {
        add(
          "ENTITY_NOT_FOUND",
          `ProjectV2 ${project.id} references missing matching legacy closure record ${project.legacyClosure.legacyRecordId}.`,
          gate,
          "repair_workspace_reference",
        );
      }
    }
    for (const hold of [...project.holds].sort(
      (left, right) =>
        compareText(left.type, right.type) ||
        compareText(left.sourceId, right.sourceId) ||
        compareText(left.createdAt, right.createdAt),
    )) {
      requireReference(
        "ProjectHold",
        project.id,
        `${hold.type}:sourceId`,
        `${hold.type} hold source`,
        hold.sourceId,
        holdSourceTarget(hold.type, hold.sourceId),
      );
      for (const recordId of [...hold.affectedRecordIds].sort(compareText)) {
        requireReference(
          "ProjectHold",
          project.id,
          `${hold.type}:affectedRecordIds:${recordId}`,
          "WorkspaceEntity",
          recordId,
          knownRecordsById.get(recordId),
        );
      }
    }
  }

  for (const inboxItem of sortedById(workspace.inboxItems)) {
    if (inboxItem.actionId !== undefined) {
      requireReference(
        "InboxItem",
        inboxItem.id,
        "actionId",
        "Action",
        inboxItem.actionId,
        actionsById.get(inboxItem.actionId),
      );
    }
    if (inboxItem.projectId !== undefined) {
      requireReference(
        "InboxItem",
        inboxItem.id,
        "projectId",
        "ProjectV2",
        inboxItem.projectId,
        projectsById.get(inboxItem.projectId),
      );
    }
  }

  for (const action of sortedById(workspace.actions)) {
    requireReference(
      "Action",
      action.id,
      "inboxItemId",
      "InboxItem",
      action.inboxItemId,
      inboxById.get(action.inboxItemId),
    );
    if (action.promotedProjectId !== undefined) {
      requireReference(
        "Action",
        action.id,
        "promotedProjectId",
        "ProjectV2",
        action.promotedProjectId,
        projectsById.get(action.promotedProjectId),
      );
    }
  }

  for (const brief of sortedById(workspace.directionBriefs)) {
    requireReference(
      "DirectionBrief",
      brief.id,
      "projectId",
      "ProjectV2",
      brief.projectId,
      projectsById.get(brief.projectId),
    );
  }

  for (const bet of sortedById(workspace.bets)) {
    requireReference(
      "BetVersion",
      bet.id,
      "projectId",
      "ProjectV2",
      bet.projectId,
      projectsById.get(bet.projectId),
    );
    requireReference(
      "BetVersion",
      bet.id,
      "briefId",
      "DirectionBrief",
      bet.briefId,
      briefsById.get(bet.briefId),
      bet.projectId,
    );
    if (bet.supersedesId !== undefined) {
      requireReference(
        "BetVersion",
        bet.id,
        "supersedesId",
        "BetVersion",
        bet.supersedesId,
        betsById.get(bet.supersedesId),
        bet.projectId,
      );
    }
    if (bet.sourceReviewId !== undefined) {
      requireReference(
        "BetVersion",
        bet.id,
        "sourceReviewId",
        "ReviewRecord",
        bet.sourceReviewId,
        reviewsById.get(bet.sourceReviewId),
      );
    }
  }

  for (const plan of sortedById(workspace.planVersions)) {
    requireReference(
      "PlanVersion",
      plan.id,
      "projectId",
      "ProjectV2",
      plan.projectId,
      projectsById.get(plan.projectId),
    );
    requireReference(
      "PlanVersion",
      plan.id,
      "betId",
      "BetVersion",
      plan.betId,
      betsById.get(plan.betId),
      plan.projectId,
    );
    const referencedWorkItemIds = new Set(
      Object.keys(plan.workItemRevisions).sort(compareText),
    );
    for (const workItemId of referencedWorkItemIds) {
      requireReference(
        "PlanVersion",
        plan.id,
        `workItemRevisions:${workItemId}`,
        "ProjectWorkItem",
        workItemId,
        workItemsById.get(workItemId),
        plan.projectId,
      );
    }
    for (const workItemId of Object.keys(plan.scopeMapping).sort(compareText)) {
      if (referencedWorkItemIds.has(workItemId)) {
        continue;
      }
      referencedWorkItemIds.add(workItemId);
      requireReference(
        "PlanVersion",
        plan.id,
        `scopeMapping:${workItemId}`,
        "ProjectWorkItem",
        workItemId,
        workItemsById.get(workItemId),
        plan.projectId,
      );
    }
    for (const workItemId of Object.keys(plan.capacityIndependentDates).sort(
      compareText,
    )) {
      if (referencedWorkItemIds.has(workItemId)) {
        continue;
      }
      referencedWorkItemIds.add(workItemId);
      requireReference(
        "PlanVersion",
        plan.id,
        `capacityIndependentDates:${workItemId}`,
        "ProjectWorkItem",
        workItemId,
        workItemsById.get(workItemId),
        plan.projectId,
      );
    }
    for (const dependencyId of Object.keys(plan.dependencyRevisions).sort(
      compareText,
    )) {
      requireReference(
        "PlanVersion",
        plan.id,
        `dependencyRevisions:${dependencyId}`,
        "ProjectDependency",
        dependencyId,
        dependenciesById.get(dependencyId),
        plan.projectId,
      );
    }
    if (plan.supersedesId !== undefined) {
      requireReference(
        "PlanVersion",
        plan.id,
        "supersedesId",
        "PlanVersion",
        plan.supersedesId,
        plansById.get(plan.supersedesId),
        plan.projectId,
      );
    }
  }

  for (const workItem of sortedById(workspace.workItems)) {
    requireReference(
      "ProjectWorkItem",
      workItem.id,
      "projectId",
      "ProjectV2",
      workItem.projectId,
      projectsById.get(workItem.projectId),
    );
    if (workItem.parentId !== undefined) {
      requireReference(
        "ProjectWorkItem",
        workItem.id,
        "parentId",
        "ProjectWorkItem",
        workItem.parentId,
        workItemsById.get(workItem.parentId),
        workItem.projectId,
      );
    }
    if (workItem.hammockStartId !== undefined) {
      requireReference(
        "ProjectWorkItem",
        workItem.id,
        "hammockStartId",
        "ProjectWorkItem",
        workItem.hammockStartId,
        workItemsById.get(workItem.hammockStartId),
        workItem.projectId,
      );
    }
    if (workItem.hammockFinishId !== undefined) {
      requireReference(
        "ProjectWorkItem",
        workItem.id,
        "hammockFinishId",
        "ProjectWorkItem",
        workItem.hammockFinishId,
        workItemsById.get(workItem.hammockFinishId),
        workItem.projectId,
      );
    }
    for (const assignment of [...workItem.assignmentIds].sort((left, right) =>
      compareText(left.resourceId, right.resourceId),
    )) {
      requireReference(
        "ProjectWorkItem",
        workItem.id,
        `assignmentIds:${assignment.resourceId}`,
        "Resource",
        assignment.resourceId,
        resourcesById.get(assignment.resourceId),
      );
    }
  }

  for (const dependency of sortedById(workspace.dependencies)) {
    requireReference(
      "ProjectDependency",
      dependency.id,
      "projectId",
      "ProjectV2",
      dependency.projectId,
      projectsById.get(dependency.projectId),
    );
    requireReference(
      "ProjectDependency",
      dependency.id,
      "fromId",
      "ProjectWorkItem",
      dependency.fromId,
      workItemsById.get(dependency.fromId),
      dependency.projectId,
    );
    requireReference(
      "ProjectDependency",
      dependency.id,
      "toId",
      "ProjectWorkItem",
      dependency.toId,
      workItemsById.get(dependency.toId),
      dependency.projectId,
    );
  }

  for (const actual of sortedById(workspace.actuals)) {
    if (actual.target.kind === "action") {
      requireReference(
        "ActualV2",
        actual.id,
        "target.actionId",
        "Action",
        actual.target.actionId,
        actionsById.get(actual.target.actionId),
      );
    } else {
      requireReference(
        "ActualV2",
        actual.id,
        "target.workItemId",
        "ProjectWorkItem",
        actual.target.workItemId,
        workItemsById.get(actual.target.workItemId),
      );
    }
  }

  for (const commitment of sortedById(workspace.dailyCommitments)) {
    for (const slot of sortedById(commitment.slots)) {
      validateSlot("DailyCommitment", commitment.id, "slots", slot);
    }
    if (commitment.supersedesId !== undefined) {
      requireReference(
        "DailyCommitment",
        commitment.id,
        "supersedesId",
        "DailyCommitment",
        commitment.supersedesId,
        commitmentsById.get(commitment.supersedesId),
      );
    }
  }

  for (const replan of sortedById(workspace.replanProposals)) {
    requireReference(
      "ReplanProposal",
      replan.id,
      "baseCommitmentId",
      "DailyCommitment",
      replan.baseCommitmentId,
      commitmentsById.get(replan.baseCommitmentId),
    );
    for (const slot of sortedById(replan.proposedSlots)) {
      validateSlot("ReplanProposal", replan.id, "proposedSlots", slot);
    }
  }

  for (const review of sortedById(workspace.reviews)) {
    for (const projectId of [...review.affectedProjectIds].sort(compareText)) {
      requireReference(
        "ReviewRecord",
        review.id,
        `affectedProjectIds:${projectId}`,
        "ProjectV2",
        projectId,
        projectsById.get(projectId),
      );
    }
    for (const recordId of [...review.affectedRecordIds].sort(compareText)) {
      requireReference(
        "ReviewRecord",
        review.id,
        `affectedRecordIds:${recordId}`,
        "WorkspaceEntity",
        recordId,
        knownRecordsById.get(recordId),
      );
    }
  }

  for (const conflict of sortedById(workspace.syncConflicts)) {
    if (conflict.projectId !== undefined) {
      requireReference(
        "SyncConflictRecord",
        conflict.id,
        "projectId",
        "ProjectV2",
        conflict.projectId,
        projectsById.get(conflict.projectId),
      );
    }
    const targetByType = {
      bet: betsById,
      daily_commitment: commitmentsById,
      review: reviewsById,
      exception: exceptionsById,
      close: closeDecisionsById,
    }[conflict.recordType];
    requireReference(
      "SyncConflictRecord",
      conflict.id,
      "recordId",
      conflict.recordType,
      conflict.recordId,
      targetByType.get(conflict.recordId),
    );
  }

  for (const evidence of sortedById(workspace.evidence)) {
    requireReference(
      "Evidence",
      evidence.id,
      "projectId",
      "ProjectV2",
      evidence.projectId,
      projectsById.get(evidence.projectId),
    );
    if (evidence.workItemId !== undefined) {
      requireReference(
        "Evidence",
        evidence.id,
        "workItemId",
        "ProjectWorkItem",
        evidence.workItemId,
        workItemsById.get(evidence.workItemId),
        evidence.projectId,
      );
    }
  }

  for (const baseline of sortedById(workspace.baselines)) {
    requireReference(
      "Baseline",
      baseline.id,
      "projectId",
      "ProjectV2",
      baseline.projectId,
      projectsById.get(baseline.projectId),
    );
    const plannedWorkItemIds = new Set([
      ...Object.keys(baseline.plannedStartByItem),
      ...Object.keys(baseline.plannedFinishByItem),
      ...Object.keys(baseline.plannedWorkSecondsByItem),
    ]);
    for (const workItemId of [...plannedWorkItemIds].sort(compareText)) {
      requireReference(
        "Baseline",
        baseline.id,
        `plannedItems:${workItemId}`,
        "ProjectWorkItem",
        workItemId,
        workItemsById.get(workItemId),
        baseline.projectId,
      );
    }
    if (baseline.approvedByDecisionId !== undefined) {
      const approval = legacyAuditRecordsById.get(
        baseline.approvedByDecisionId,
      );
      if (
        approval === undefined ||
        approval.projectId !== baseline.projectId ||
        (approval.recordType !== "decision" &&
          approval.recordType !== "audit_decision")
      ) {
        add(
          "ENTITY_NOT_FOUND",
          `Baseline ${baseline.id} approval must reference a same-project legacy Decision or Audit Decision ${baseline.approvedByDecisionId}.`,
          `reference:Baseline:${baseline.id}:approvedByDecisionId:${baseline.approvedByDecisionId}`,
          "repair_workspace_reference",
        );
      }
    }
  }

  for (const decision of sortedById(workspace.closeDecisions)) {
    requireReference(
      "CloseDecision",
      decision.id,
      "projectId",
      "ProjectV2",
      decision.projectId,
      projectsById.get(decision.projectId),
    );
    if (decision.followUpProjectId !== undefined) {
      requireReference(
        "CloseDecision",
        decision.id,
        "followUpProjectId",
        "ProjectV2",
        decision.followUpProjectId,
        projectsById.get(decision.followUpProjectId),
      );
    }
  }

  for (const exception of sortedById(workspace.exceptions)) {
    requireReference(
      "ExceptionRecord",
      exception.id,
      "projectId",
      "ProjectV2",
      exception.projectId,
      projectsById.get(exception.projectId),
    );
    const requirement = workItemsById.get(exception.requirementId);
    const gate = `reference:ExceptionRecord:${exception.id}:requirementId`;
    if (
      requirement === undefined ||
      requirement.projectId !== exception.projectId ||
      requirement.kind !== "milestone" ||
      requirement.evidenceRequired !== true
    ) {
      add(
        "ENTITY_NOT_FOUND",
        `ExceptionRecord ${exception.id} must reference an evidence-required milestone ${exception.requirementId} in Project ${exception.projectId}.`,
        gate,
        "repair_workspace_reference",
      );
    }
  }

  for (const record of sortedById(workspace.legacyAuditRecords)) {
    requireReference(
      "LegacyAuditRecord",
      record.id,
      "projectId",
      "ProjectV2",
      record.projectId,
      projectsById.get(record.projectId),
    );
  }

  for (const projectId of [...workspace.visibility.archivedProjectIds].sort(
    compareText,
  )) {
    requireReference(
      "VisibilityPreferences",
      "visibility",
      `archivedProjectIds:${projectId}`,
      "ProjectV2",
      projectId,
      projectsById.get(projectId),
    );
  }
}

function validateReviewRules(
  workspace: WorkspaceV2,
  now: ISODate,
  previousWorkspace: WorkspaceV2 | undefined,
  add: AddViolation,
): void {
  const ids = new Map<Id, number>();
  const triggerKeys = new Map<string, number>();
  for (const review of workspace.reviews) {
    ids.set(review.id, (ids.get(review.id) ?? 0) + 1);
    triggerKeys.set(
      review.triggerKey,
      (triggerKeys.get(review.triggerKey) ?? 0) + 1,
    );
  }
  for (const [id, count] of [...ids].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (count > 1) {
      add(
        "SYNC_CONFLICT",
        `Review identity ${id} has ${count} stored records.`,
        `review:${id}:identity`,
        "resolve_sync_conflict",
      );
    }
  }
  for (const [triggerKey, count] of [...triggerKeys].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    if (count > 1) {
      add(
        "SYNC_CONFLICT",
        `Review occurrence ${triggerKey} has ${count} stored records.`,
        `review_trigger:${triggerKey}`,
        "resolve_sync_conflict",
      );
    }
  }
  if (previousWorkspace !== undefined) {
    const previousById = new Map<Id, WorkspaceV2["reviews"]>();
    const candidateById = new Map<Id, WorkspaceV2["reviews"]>();
    for (const review of previousWorkspace.reviews) {
      const matches = previousById.get(review.id) ?? [];
      matches.push(review);
      previousById.set(review.id, matches);
    }
    for (const review of workspace.reviews) {
      const matches = candidateById.get(review.id) ?? [];
      matches.push(review);
      candidateById.set(review.id, matches);
    }
    for (const [id, previousMatches] of [...previousById].sort(
      ([left], [right]) => compareText(left, right),
    )) {
      const candidateMatches = candidateById.get(id) ?? [];
      if (
        previousMatches.length === 1 &&
        candidateMatches.length === 1 &&
        previousMatches[0].cadenceTimeZone !==
          candidateMatches[0].cadenceTimeZone
      ) {
        add(
          "INVALID_COMMAND",
          `Review ${id} cadence timezone snapshot is immutable.`,
          `review:${id}:cadence_timezone`,
          "read_existing_review",
        );
      }
    }
  }

  const evaluatedAt = parseTimestamp(now);
  const weeklyCoverageConflicts = overlappingWeeklyReviewCoverage(workspace);
  for (const conflict of weeklyCoverageConflicts) {
    add(
      "SYNC_CONFLICT",
      `Weekly Review coverage ${conflict.leftReviewId} and ${conflict.rightReviewId} overlap at ${conflict.overlapStart}.`,
      `weekly_coverage:${conflict.overlapStart}`,
      "resolve_sync_conflict",
    );
  }
  for (const review of sortedById(workspace.reviews)) {
    if (!storedReviewSemanticsAreValid(workspace, review, evaluatedAt)) {
      add(
        "INVALID_COMMAND",
        `Review ${review.id} has invalid identity, occurrence, time, affected records, status, or conclusion semantics.`,
        `review:${review.id}:semantics`,
        "repair_workspace_reference",
      );
    }
  }

  const completedReviewIds = new Set(
    workspace.reviews
      .filter(({ status }) => status === "completed")
      .map(({ id }) => id),
  );
  for (const project of sortedById(workspace.projects)) {
    for (const hold of project.holds) {
      if (
        hold.type === "review_overdue" &&
        completedReviewIds.has(hold.sourceId)
      ) {
        add(
          "SYNC_CONFLICT",
          `Completed Review ${hold.sourceId} still owns an overdue hold on Project ${project.id}.`,
          `review:${hold.sourceId}:completed_hold`,
          "resolve_sync_conflict",
        );
      }
    }
  }
}

export function validateWorkspaceInvariants(
  workspace: WorkspaceV2,
  now: ISODate,
  previousWorkspace?: WorkspaceV2,
): InvariantViolation[] {
  const collector = createCollector();

  validateBetRules(workspace, now, previousWorkspace, collector.add);
  validateCapacityRules(workspace, collector.add);
  validateScopeRules(workspace, previousWorkspace, collector.add);
  validateClosedProjectRules(workspace, previousWorkspace, collector.add);
  validateReferenceRules(workspace, collector.add);
  validateReviewRules(workspace, now, previousWorkspace, collector.add);

  return collector.result();
}
