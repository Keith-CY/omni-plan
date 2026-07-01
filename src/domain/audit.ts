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

  for (const item of items.filter((candidate) => candidate.projectId === project.id)) {
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

  for (const changeSet of changeSets.filter((candidate) => candidate.projectId === project.id)) {
    const touchesBaseline = changeSet.diffs.some((diff) => diff.entity === "Baseline");
    if (touchesBaseline && changeSet.status !== "approved") {
      gates.push({
        id: `gate-baseline-${changeSet.id}`,
        projectId: project.id,
        targetType: "baseline",
        targetId: changeSet.id,
        severity: "hard",
        reason: "Baseline change is not approved.",
        requiredAction: "Attach a Decision Log entry and approve the Change Set after review.",
        status: changeSet.status === "queued-audit" ? "queued" : "open"
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
