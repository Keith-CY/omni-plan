import type {
  AuditDecision,
  AuditGate,
  ChangeSet,
  DirectionCard,
  Evidence,
  Project,
  ScheduledItem,
  WorkItem
} from "./types";
import { isShapeUpBet, isShapeUpCycleExpired, isShapeUpPitchComplete, shapeUpMissingBetRequirements } from "./shapeUp";
import { isExecutionWorkItem } from "./recurring";

function hasCompleteDirectionCard(card?: DirectionCard): boolean {
  if (!card) return false;
  const required = [
    card.targetUser,
    card.userProblem,
    card.businessGoal,
    card.coreHypothesis,
    card.successMetric,
    card.failureCondition,
    card.validationMethod,
    card.opportunityCost
  ];
  return required.every((value) => value.trim().length > 0) && card.timeboxDays > 0;
}

export function evaluateAuditGates(
  project: Project,
  items: WorkItem[],
  schedule: ScheduledItem[],
  evidence: Evidence[],
  changeSets: ChangeSet[],
  now: string
): AuditGate[] {
  const gates: AuditGate[] = [];
  const shapeUpPitch = project.shapeUpPitch;
  void changeSets; // ChangeSets stay visible in Audit; baseline review is optional and no longer blocks project completion.

  if (shapeUpPitch) {
    const missing = shapeUpMissingBetRequirements(project);
    if (project.status === "waiting" && missing.length > 0) {
      gates.push({
        id: `gate-shapeup-pitch-${project.id}`,
        projectId: project.id,
        targetType: "project",
        targetId: project.id,
        severity: "hard",
        reason: `Shape Up pitch is incomplete: ${missing.join(", ")}.`,
        requiredAction: "Complete Problem, Appetite, Solution Sketch, Rabbit Holes, No-gos, Success Baseline, and at least one confirmed scope before betting.",
        status: "open"
      });
    }

    if (project.status === "waiting" && isShapeUpPitchComplete(shapeUpPitch) && !shapeUpPitch.bet) {
      gates.push({
        id: `gate-shapeup-bet-${project.id}`,
        projectId: project.id,
        targetType: "project",
        targetId: project.id,
        severity: "hard",
        reason: "Shape Up pitch is ready but has not been approved at the Betting Gate.",
        requiredAction: "Human owner must approve the bet before this project can enter Today or the Gantt execution plan.",
        status: "open"
      });
    }

    if (project.status === "active" && !isShapeUpBet(project)) {
      gates.push({
        id: `gate-shapeup-unrecorded-bet-${project.id}`,
        projectId: project.id,
        targetType: "project",
        targetId: project.id,
        severity: "hard",
        reason: "Project is active without a recorded Shape Up bet.",
        requiredAction: "Record a human-approved Betting Gate decision or move the project back to waiting.",
        status: "open"
      });
    }

    if (isShapeUpCycleExpired(project, now)) {
      gates.push({
        id: `gate-shapeup-circuit-${project.id}`,
        projectId: project.id,
        targetType: "project",
        targetId: project.id,
        severity: "hard",
        reason: "Shape Up circuit breaker expired before the project shipped.",
        requiredAction: "Choose Ship as-is, Cut scope, Kill, or Re-bet. Do not silently extend the cycle.",
        status: "open"
      });
    }
  }

  if (!hasCompleteDirectionCard(project.directionCard)) {
    gates.push({
      id: `gate-direction-${project.id}`,
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      severity: "hard",
      reason: "Project does not have a complete Direction Card.",
      requiredAction: "Define target user, problem, hypothesis, success metric, failure condition, validation method, and opportunity cost.",
      status: "open"
    });
  }

  for (const item of items.filter((candidate) => candidate.projectId === project.id && isExecutionWorkItem(candidate))) {
    const linkedEvidence = evidence.filter((candidate) => candidate.workItemId === item.id);
    if (item.kind === "milestone" && item.evidenceRequired && item.percentComplete >= 100 && linkedEvidence.length === 0) {
      gates.push({
        id: `gate-evidence-${item.id}`,
        projectId: project.id,
        targetType: "milestone",
        targetId: item.id,
        severity: "hard",
        reason: `${item.title} is complete but has no linked evidence.`,
        requiredAction: "Attach structured evidence or explicitly record that no external evidence exists.",
        status: "open"
      });
    }

    if (item.isScopeExpansion) {
      gates.push({
        id: `gate-scope-${item.id}`,
        projectId: project.id,
        targetType: "scope",
        targetId: item.id,
        severity: "hard",
        reason: `${item.title} expands project scope.`,
        requiredAction: "Run contrarian audit before adding scope to the committed plan.",
        status: "open"
      });
    }

    if (item.isFastDelivery && linkedEvidence.length === 0) {
      gates.push({
        id: `gate-fast-${item.id}`,
        projectId: project.id,
        targetType: "delivery",
        targetId: item.id,
        severity: "warning",
        reason: `${item.title} moved quickly but lacks value evidence.`,
        requiredAction: "Record what was learned, not only what was shipped.",
        status: "open"
      });
    }
  }

  const criticalWithoutEvidence = schedule.filter(
    (item) => item.isCritical && item.workItem.percentComplete > 0 && !evidence.some((candidate) => candidate.workItemId === item.workItem.id)
  );
  if (criticalWithoutEvidence.length >= 2) {
    gates.push({
      id: `gate-critical-evidence-${project.id}-${now.slice(0, 10)}`,
      projectId: project.id,
      targetType: "project",
      targetId: project.id,
      severity: "warning",
      reason: "Critical-path progress is being reported without fresh evidence.",
      requiredAction: "Add evidence or run a direction review before expanding scope.",
      status: "open"
    });
  }

  return gates;
}

export function recommendAuditDecision(
  project: Project,
  gates: AuditGate[],
  evidence: Evidence[],
  now: string
): AuditDecision {
  const openGates = gates.filter((gate) => gate.status !== "cleared");
  const sortedGates = [...openGates].sort((a, b) => {
    const severityRank = { hard: 0, warning: 1, info: 2 };
    const statusRank = { blocked: 0, open: 1, queued: 2, cleared: 3 };
    return (
      severityRank[a.severity] - severityRank[b.severity] ||
      statusRank[a.status] - statusRank[b.status]
    );
  });
  const hardGateCount = sortedGates.filter((gate) => gate.severity === "hard").length;
  const strongestGate = sortedGates[0];
  const recentEvidence = evidence.filter((item) => item.projectId === project.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const action = hardGateCount > 2 ? "Pivot" : hardGateCount > 0 ? "Narrow" : recentEvidence.length >= 3 ? "Continue" : "Narrow";

  return {
    id: `decision-${project.id}-${now}`,
    projectId: project.id,
    action,
    strongestContinueEvidence: recentEvidence[0]?.summary ?? "No recent evidence has been attached.",
    strongestStopReason:
      strongestGate?.reason ??
      "The project may still be wrong if leading indicators do not move after the next milestone.",
    rationale:
      hardGateCount > 0
        ? "Hard audit gates are open, so the safest next action is to reduce scope until evidence improves."
        : "No hard gates are open; continue while checking evidence freshness.",
    createdAt: now,
    sourceGateIds: sortedGates.map((gate) => gate.id)
  };
}
