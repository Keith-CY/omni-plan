import type { AuditGate, Evidence, Project, ScheduleResult } from "./types";
import { secondsBetween } from "./time";

export interface ProjectHealth {
  projectId: string;
  momentumScore: number;
  riskScore: number;
  evidenceFreshnessDays: number;
  openHardGates: number;
  criticalItems: number;
  recommendedFocus: number;
}

export function calculateProjectHealth(
  project: Project,
  schedule: ScheduleResult,
  evidence: Evidence[],
  gates: AuditGate[],
  now: string
): ProjectHealth {
  const latestEvidence = evidence
    .filter((item) => item.projectId === project.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const evidenceFreshnessDays = latestEvidence ? Math.max(0, secondsBetween(latestEvidence.createdAt, now) / 86400) : 999;
  const openHardGates = gates.filter((gate) => gate.projectId === project.id && gate.severity === "hard" && gate.status !== "cleared").length;
  const criticalItems = schedule.items.filter((item) => item.isCritical).length;
  const completedRatio =
    schedule.items.length === 0
      ? 0
      : schedule.items.reduce((sum, item) => sum + item.workItem.percentComplete, 0) / (schedule.items.length * 100);
  const momentumScore = Math.round(Math.min(100, completedRatio * 60 + Math.max(0, 40 - evidenceFreshnessDays * 3)));
  const riskScore = Math.round(Math.min(100, openHardGates * 28 + criticalItems * 4 + Math.min(30, evidenceFreshnessDays)));
  const recommendedFocus = Math.round(project.priority * 18 + riskScore * 0.6 + Math.max(0, 20 - evidenceFreshnessDays));

  return {
    projectId: project.id,
    momentumScore,
    riskScore,
    evidenceFreshnessDays,
    openHardGates,
    criticalItems,
    recommendedFocus
  };
}
