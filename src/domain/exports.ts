import type {
  AuditDecision,
  AuditGate,
  Baseline,
  EvmResult,
  Evidence,
  MonteCarloResult,
  Project,
  ScheduleResult
} from "./types";

export function exportProjectMarkdown(
  project: Project,
  schedule: ScheduleResult,
  evidence: Evidence[],
  auditDecision: AuditDecision,
  evm: EvmResult | undefined,
  monteCarlo: MonteCarloResult,
  gates: AuditGate[] = [],
  baseline?: Baseline
): string {
  const openGates = gates.filter((gate) => gate.status !== "cleared");
  const hardGates = openGates.filter((gate) => gate.severity === "hard");
  const lines = [
    `# ${project.name}`,
    "",
    `North Star: ${project.northStar}`,
    `Current Outcome: ${project.currentOutcome}`,
    `Audit Decision: ${auditDecision.action}`,
    `Open Hard Gates: ${hardGates.length}`,
    `Baseline: ${baseline ? `${baseline.name} (${baseline.capturedAt.slice(0, 10)})` : "No approved baseline for this project"}`,
    "",
    "## Direction",
    project.directionCard
      ? `- Hypothesis: ${project.directionCard.coreHypothesis}\n- Success: ${project.directionCard.successMetric}\n- Failure: ${project.directionCard.failureCondition}`
      : "- Missing Direction Card",
    "",
    "## Schedule",
    ...schedule.items.map(
      (item) =>
        `- ${item.workItem.outline} ${item.workItem.title}: ${item.start} -> ${item.finish}${item.isCritical ? " (critical)" : ""}`
    ),
    "",
    "## Scheduler Diagnostics",
    ...(schedule.diagnostics.length
      ? schedule.diagnostics.map((diagnostic) => `- [${diagnostic.severity}] ${diagnostic.message}${diagnostic.itemId ? ` (${diagnostic.itemId})` : ""}`)
      : ["- Clear"]),
    "",
    "## Audit Gates",
    ...(openGates.length
      ? openGates.map((gate) => `- [${gate.severity}/${gate.status}] ${gate.reason} Required: ${gate.requiredAction}`)
      : ["- Clear"]),
    "",
    "## Baseline Status",
    baseline
      ? `- Captured: ${baseline.capturedAt.slice(0, 10)}`
      : "- EVM is blocked until a project baseline exists.",
    "",
    "## Risk",
    `- Monte Carlo p50: ${monteCarlo.p50Finish.slice(0, 10)}`,
    `- Monte Carlo p75: ${monteCarlo.p75Finish.slice(0, 10)}`,
    `- Monte Carlo p90: ${monteCarlo.p90Finish.slice(0, 10)}`,
    `- SPI: ${evm ? evm.schedulePerformanceIndex.toFixed(2) : "blocked-no-baseline"}`,
    `- CPI: ${evm ? evm.costPerformanceIndex.toFixed(2) : "blocked-no-baseline"}`,
    "",
    "## Evidence",
    ...evidence.filter((item) => item.projectId === project.id).map((item) => `- [${item.kind}] ${item.summary}${item.url ? ` (${item.url})` : ""}`)
  ];

  return lines.join("\n");
}

export function exportScheduleCsv(schedule: ScheduleResult): string {
  const rows = [
    ["outline", "title", "start", "finish", "critical", "float_seconds"],
    ...schedule.items.map((item) => [
      item.workItem.outline,
      item.workItem.title,
      item.start,
      item.finish,
      String(item.isCritical),
      String(item.totalFloatSeconds)
    ])
  ];

  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
}

export function exportPdfHtml(
  project: Project,
  schedule: ScheduleResult,
  baseline: Baseline,
  auditDecision: AuditDecision
): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${project.name} Plan Report</title>
    <style>
      body { font-family: ui-serif, Georgia, serif; color: #20251f; margin: 40px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
      .critical { color: #b43d2f; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>${project.name}</h1>
    <p><strong>Baseline:</strong> ${baseline.name} captured ${baseline.capturedAt.slice(0, 10)}</p>
    <p><strong>Audit:</strong> ${auditDecision.action} - ${auditDecision.rationale}</p>
    <table>
      <thead><tr><th>Outline</th><th>Task</th><th>Start</th><th>Finish</th><th>Critical</th></tr></thead>
      <tbody>
        ${schedule.items
          .map(
            (item) =>
              `<tr><td>${item.workItem.outline}</td><td>${item.workItem.title}</td><td>${item.start.slice(0, 10)}</td><td>${item.finish.slice(0, 10)}</td><td class="${item.isCritical ? "critical" : ""}">${item.isCritical ? "Yes" : "No"}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
  </body>
</html>`;
}
