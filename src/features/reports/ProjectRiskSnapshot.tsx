import { useMemo } from "react";
import { Archive, FileDown, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { runMonteCarlo } from "@/domain/monteCarlo";
import { zonedDateKey } from "@/domain/time";
import type { Baseline, Dependency, Project, WorkItem } from "@/domain/types";

export function ProjectRiskSnapshot({
  project,
  items,
  dependencies,
  baseline,
  baselineApproved,
  evidenceFreshnessDays,
  timeZone
}: {
  project: Project;
  items: WorkItem[];
  dependencies: Dependency[];
  baseline?: Baseline;
  baselineApproved: boolean;
  evidenceFreshnessDays?: number;
  timeZone: string;
}) {
  const simulation = useMemo(
    () => runMonteCarlo(project, items, dependencies, 120, 3),
    [project, items, dependencies]
  );
  const freshness = evidenceFreshnessDays === undefined || evidenceFreshnessDays >= 900
    ? "No evidence"
    : evidenceFreshnessDays < 1 ? "Today" : `${Math.round(evidenceFreshnessDays)}d old`;

  return (
    <Card>
      <CardHeader className="compactCardHeader">
        <div className="cardHeaderLine">
          <CardTitle>Project Report Snapshot</CardTitle>
          <Badge variant="outline" className="iconBadge" title="Project report"><FileDown />local</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-3">
        <SnapshotValue icon={<Timer />} label="Finish p50" value={zonedDateKey(simulation.p50Finish, timeZone)} detail="Seeded local simulation" />
        <SnapshotValue icon={<Archive />} label="Baseline" value={baseline ? baseline.name : "Missing"} detail={baseline ? `${baselineApproved ? "approved" : "pending"} / ${zonedDateKey(baseline.capturedAt, timeZone)}` : "EVM blocked"} warning={Boolean(baseline && !baselineApproved)} />
        <SnapshotValue label="Evidence freshness" value={freshness} detail="Latest linked evidence" />
      </CardContent>
    </Card>
  );
}

function SnapshotValue({
  icon,
  label,
  value,
  detail,
  warning = false
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <div className={`summaryTile ${warning ? "warning" : ""}`}>
      <span>{icon}{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}
