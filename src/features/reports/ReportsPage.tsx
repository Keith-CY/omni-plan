import { useMemo, useState } from "react";
import { AlertTriangle, Archive, CalendarClock, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardCheck, FileDown, Lock, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { exportProjectMarkdown, exportScheduleCsv } from "@/domain/exports";
import { runMonteCarlo } from "@/domain/monteCarlo";
import { zonedDateKey, zonedTimeKey } from "@/domain/time";
import type { AuditDecision, AuditGate, Baseline, Dependency, Evidence, EvmResult, Project, ScheduleResult, WorkItem } from "@/domain/types";
import { cn } from "@/lib/utils";

export function ReportsPage({
  project,
  schedule,
  workItems,
  dependencies,
  evidence,
  decision,
  evm,
  gates,
  baseline,
  timeZone
}: {
  project: Project;
  schedule: ScheduleResult;
  workItems: WorkItem[];
  dependencies: Dependency[];
  evidence: Evidence[];
  decision: AuditDecision;
  evm?: EvmResult;
  gates: AuditGate[];
  baseline?: Baseline;
  timeZone: string;
}) {
  const [page, setPage] = useState(0);
  const monteCarlo = useMemo(() => runMonteCarlo(project, workItems, dependencies, 300, 7), [project, workItems, dependencies]);
  const markdown = useMemo(
    () => exportProjectMarkdown(project, schedule, evidence, decision, evm, monteCarlo, gates, baseline),
    [project, schedule, evidence, decision, evm, monteCarlo, gates, baseline]
  );
  const csv = useMemo(() => exportScheduleCsv(schedule), [schedule]);
  const openHardGates = gates.filter((gate) => gate.severity === "hard" && gate.status !== "cleared");
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(schedule.items.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const rows = schedule.items.slice(safePage * pageSize, safePage * pageSize + pageSize);

  return (
    <section className="productPage reportsHome">
      <div className="portfolioHeader productPageHeader">
        <div className="min-w-0">
          <p className="productPageKicker">项目报告</p>
          <h2>先看结论，需要时再看明细。</h2>
          <p className="productPageLead">这里只显示结论和需处理的异常；完整模型和导出放在下方。</p>
        </div>
      </div>
      <Card>
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> 报告状态</CardTitle>
            <Badge variant={openHardGates.length ? "destructive" : "success"} className="iconBadge" title={openHardGates[0]?.reason ?? "没有阻断项"}>{openHardGates.length ? <Lock /> : <CheckCircle2 />}{openHardGates.length ? `阻断 ${openHardGates.length} 项` : "正常"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Summary label="计划基线" value={baseline ? baseline.name : "尚未建立"} detail={baseline ? `记录于 ${zonedDateKey(baseline.capturedAt, timeZone)}` : "建立后才会计算进度偏差。"} />
          <Summary label="保守完成日期" value={zonedDateKey(monteCarlo.p90Finish, timeZone)} detail="基于当前计划的本地模拟" />
        </CardContent>
      </Card>
      <Card id="scheduler-diagnostics">
        <CardHeader className="compactCardHeader">
          <div className="cardHeaderLine">
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> 排期提醒</CardTitle>
            <Badge variant={schedule.diagnostics.length ? "warning" : "success"} className="iconBadge" title="Scheduler diagnostics"><AlertTriangle />{schedule.diagnostics.length}</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {schedule.diagnostics.length ? (
            <div className="grid gap-1.5">
              {schedule.diagnostics.map((diagnostic, index) => (
                <article className={cn("diagnosticCompactRow", diagnostic.severity === "error" && "danger", diagnostic.severity === "warning" && "warning")} key={`${diagnostic.itemId ?? "portfolio"}-${diagnostic.message}-${index}`}>
                  <div className="diagnosticMeta"><Badge variant={diagnostic.severity === "error" ? "destructive" : diagnostic.severity === "warning" ? "warning" : "secondary"}>{diagnosticSeverityLabel(diagnostic.severity)}</Badge></div>
                  <p>{schedulerDiagnosticLabel(diagnostic.message)}</p>
                </article>
              ))}
            </div>
          ) : <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground"><CheckCircle2 size={16} />没有排期异常。</div>}
        </CardContent>
      </Card>
      <details className="optionalSurface reportsDetails">
        <summary><span><FileDown /> 导出与完整明细</span><small>Markdown、CSV 和全部排期行</small><ChevronDown aria-hidden="true" /></summary>
        <div className="optionalSurfaceBody reportsDetailsBody">
          <div className="grid gap-4 lg:grid-cols-2">
            <ExportCard title={`${project.name} Markdown`} filename={`${project.name}-plan.md`} content={markdown} type="text/markdown" />
            <ExportCard title="排期 CSV" filename={`${project.name}-schedule.csv`} content={csv} type="text/csv" archive />
          </div>
      <Card>
        <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4" /> 排期明细</CardTitle></CardHeader>
        <CardContent className="grid gap-3">
          <Table>
            <caption className="srOnly">Scheduled report rows for {project.name}</caption>
            <TableHeader><TableRow><TableHead>层级</TableHead><TableHead>任务</TableHead><TableHead>开始</TableHead><TableHead>完成</TableHead><TableHead>浮动时间</TableHead></TableRow></TableHeader>
            <TableBody>{rows.map((item) => <TableRow key={item.workItem.id}><TableCell>{item.workItem.outline}</TableCell><TableCell className="font-medium">{item.workItem.title}</TableCell><TableCell>{shortDateTime(item.start, timeZone)}</TableCell><TableCell>{shortDateTime(item.finish, timeZone)}</TableCell><TableCell>{Math.round(item.totalFloatSeconds / 3600)}h</TableCell></TableRow>)}</TableBody>
          </Table>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>共 {schedule.items.length} 项 · 第 {safePage + 1}/{pageCount} 页</span>
            <div className="flex gap-1"><Button type="button" size="icon" variant="outline" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} aria-label="Previous report rows"><ChevronLeft /></Button><Button type="button" size="icon" variant="outline" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} aria-label="Next report rows"><ChevronRight /></Button></div>
          </div>
        </CardContent>
      </Card>
        </div>
      </details>
    </section>
  );
}

function Summary({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="summaryTile"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function ExportCard({ title, filename, content, type, archive = false }: { title: string; filename: string; content: string; type: string; archive?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle className="flex items-center gap-2">{archive ? <Archive className="h-4 w-4" /> : <FileDown className="h-4 w-4" />}{title}</CardTitle></CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(content)}><ClipboardCheck size={15} />复制</Button><Button variant="outline" size="sm" onClick={() => download(filename, content, type)}><FileDown size={15} />下载</Button></div>
        <pre className="max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-relaxed text-slate-50">{content}</pre>
      </CardContent>
    </Card>
  );
}

function shortDateTime(iso: string, timeZone: string) {
  return `${zonedDateKey(iso, timeZone).slice(5)} ${zonedTimeKey(iso, timeZone)}`;
}

function diagnosticSeverityLabel(severity: "info" | "warning" | "error") {
  if (severity === "error") return "错误";
  if (severity === "warning") return "提醒";
  return "信息";
}

function schedulerDiagnosticLabel(message: string) {
  if (message === "Circular dependency prevents a safe schedule.") return "存在循环依赖，无法安全排期。";
  const fixedStart = message.match(/^(.*) fixed start is earlier than its dependency or no-earlier-than bound\.$/);
  if (fixedStart) return `${fixedStart[1]} 的固定开始时间早于依赖或最早开始限制。`;
  const lateFinish = message.match(/^(.*) finishes after its no-later-than constraint\.$/);
  if (lateFinish) return `${lateFinish[1]} 的完成时间晚于最晚完成限制。`;
  return message;
}

function download(filename: string, content: string, type: string) {
  const safe = filename.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safe;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
