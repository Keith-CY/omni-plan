import { useEffect, useMemo, useState } from "react";
import {
  applyAgentCommandInput,
  buildAgentManualText,
  buildAgentProjectJson,
  buildAgentProjectText,
  buildAgentWorkspaceJson,
  buildAgentWorkspaceText,
  previewAgentCommandInput,
  type AgentCommandReceipt
} from "./domain/agent";
import { BrowserWorkspaceRepository } from "./domain/storage";
import type { WorkspaceSnapshot } from "./domain/types";
import { createEmptyWorkspace } from "./domain/workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const receiptStorageKey = "omni-plan-personal.agent.receipt.last.v1";

type AgentRoute =
  | { kind: "manual-text" }
  | { kind: "projects-text" }
  | { kind: "projects-json" }
  | { kind: "project-text"; projectId: string }
  | { kind: "project-json"; projectId: string }
  | { kind: "commands" }
  | { kind: "not-found" };

export function isAgentPath(pathname = window.location.pathname) {
  return pathname === "/agent" || pathname.startsWith("/agent/");
}

export function AgentApp() {
  const route = parseAgentRoute(window.location.pathname);
  useNoIndex();
  if (route.kind === "commands") return <AgentCommandsPage />;
  return <AgentDocumentPage route={route} />;
}

function AgentDocumentPage({ route }: { route: AgentRoute }) {
  const repository = useMemo(() => new BrowserWorkspaceRepository(), []);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => createEmptyWorkspace());
  const generatedAt = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    let active = true;
    void repository.load().then((stored) => {
      if (!active) return;
      setWorkspace(stored ?? createEmptyWorkspace());
    }).catch(() => {
      if (!active) return;
      setWorkspace(createEmptyWorkspace());
    });
    return () => {
      active = false;
    };
  }, [repository]);

  const content = useMemo(() => {
    if (route.kind === "manual-text") return buildAgentManualText(generatedAt);
    if (route.kind === "projects-text") return buildAgentWorkspaceText(workspace, generatedAt);
    if (route.kind === "projects-json") return JSON.stringify(buildAgentWorkspaceJson(workspace, generatedAt), null, 2);
    if (route.kind === "project-text") return buildAgentProjectText(workspace, route.projectId, generatedAt);
    if (route.kind === "project-json") return JSON.stringify(buildAgentProjectJson(workspace, route.projectId, generatedAt), null, 2);
    return [
      "OmniPlan Personal Agent Endpoint Not Found",
      "",
      "Available endpoints:",
      "- /agent/manual.txt",
      "- /agent/projects.txt",
      "- /agent/projects.json",
      "- /agent/projects/:id.txt",
      "- /agent/projects/:id.json",
      "- /agent/commands"
    ].join("\n");
  }, [generatedAt, route, workspace]);

  useEffect(() => {
    document.title = route.kind === "not-found" ? "Agent endpoint not found" : "OmniPlan Agent";
  }, [route.kind]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <pre className="m-0 min-h-screen whitespace-pre-wrap bg-background p-4 font-mono text-sm leading-6 text-foreground">{content}</pre>
    </main>
  );
}

function AgentCommandsPage() {
  const repository = useMemo(() => new BrowserWorkspaceRepository(), []);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(() => createEmptyWorkspace());
  const [loaded, setLoaded] = useState(false);
  const [commandInput, setCommandInput] = useState(() => initialCommandInput());
  const [receipt, setReceipt] = useState<AgentCommandReceipt | undefined>(() => lastReceipt());
  const [notice, setNotice] = useState("先预览变更，确认后再执行。");

  useNoIndex();

  useEffect(() => {
    document.title = "OmniPlan 指令收件箱";
    let active = true;
    void repository.load().then((stored) => {
      if (!active) return;
      setWorkspace(stored ?? createEmptyWorkspace());
      setLoaded(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoaded(true);
      setNotice(`工作区加载失败：${error instanceof Error ? error.message : "未知错误"}`);
    });
    return () => {
      active = false;
    };
  }, [repository]);

  const runDryRun = () => {
    const result = previewAgentCommandInput(workspace, commandInput);
    setReceipt(result.receipt);
    saveReceipt(result.receipt);
    setNotice(result.receipt.risk === "invalid" ? "预览时已拒绝这条指令。" : "预览已生成，尚未修改数据。");
  };

  const applyCommand = async () => {
    const result = applyAgentCommandInput(workspace, commandInput);
    setWorkspace(result.workspace);
    setReceipt(result.receipt);
    saveReceipt(result.receipt);
    if (result.receipt.status === "applied" || result.receipt.status === "queued") {
      await repository.save(result.workspace);
    }
    setNotice(result.receipt.status === "applied"
      ? "指令已执行并保存到本地工作区。"
      : result.receipt.status === "queued"
        ? "这是敏感变更，已放入审查队列。"
        : "指令已被拒绝。");
  };

  const sampleJson = JSON.stringify({
    command_type: "create_task",
    project_id: workspace.projects[0]?.id ?? "workspace",
    title: "Review Shortcut import",
    effort_hours: 1,
    duration_days: 1,
    tags: ["shortcut"]
  }, null, 2);

  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">自动化写入</p>
              <h1 className="text-2xl font-semibold">指令收件箱</h1>
              <p className="text-sm text-muted-foreground">粘贴 Shortcut、Alfred 或 AI 指令。先预览，敏感变更会自动进入审查。</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={loaded ? "success" : "warning"}>{loaded ? "本地工作区" : "加载中"}</Badge>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/manual.txt">使用说明</a>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/projects.txt">项目数据</a>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/">返回应用</a>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>输入指令</CardTitle>
              <CardDescription>支持普通文本或 JSON；这一版自然语言只使用本地规则解析。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <textarea
                className="min-h-56 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={commandInput}
                onChange={(event) => setCommandInput(event.target.value)}
                placeholder="Give OmniPlan Personal project add task Review Shortcut import, 1 hour"
                aria-label="Agent command input"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" onClick={runDryRun} disabled={!commandInput.trim()}>预览</Button>
                <Button type="button" variant="outline" onClick={() => void applyCommand()} disabled={!commandInput.trim()}>执行或送审</Button>
                <Button type="button" variant="ghost" onClick={() => setCommandInput(sampleJson)}>使用 JSON 示例</Button>
                <Button type="button" variant="ghost" onClick={() => setCommandInput("")}>清空</Button>
              </div>
              <p className="rounded-lg border bg-muted/40 p-3 text-sm">{notice}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Shortcut 接入方式</CardTitle>
              <CardDescription>iPhone 上可以口述或组合文本，然后分享或粘贴到这里。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>1. 在 Shortcut 中使用“询问文本”或“听写文本”。</p>
              <p>2. 可选：组合包含 project_id 和 command_type 的 JSON。</p>
              <p>3. 打开 /agent/commands?text=&lt;编码后的指令&gt;，或将文本分享到已安装的 PWA。</p>
              <p>4. 确认预览结果；普通指令可执行，敏感指令进入审查。</p>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>执行回执</CardTitle>
              <CardDescription>最近一次预览或执行的结果。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {receipt ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <ReceiptTile label="状态" value={receipt.status} />
                    <ReceiptTile label="风险" value={receipt.risk} />
                    <ReceiptTile label="仅预览" value={receipt.dry_run ? "是" : "否"} />
                    <ReceiptTile label="变更" value={String(receipt.diffs.length)} />
                  </div>
                  <pre className="max-h-[56vh] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">{JSON.stringify(receipt, null, 2)}</pre>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyText(JSON.stringify(receipt, null, 2))}>复制回执</Button>
                    {receipt.project_id && <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href={`/agent/projects/${encodeURIComponent(receipt.project_id)}.txt`}>项目状态</a>}
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">还没有回执。</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>执行规则</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>普通变更：任务、进度、实际工时、证据和备注。</p>
              <p>需审查：依赖、基线、范围扩张、无证据的里程碑完成、项目完成和归档。</p>
              <p>Agent 页面不会读取密钥。</p>
            </CardContent>
          </Card>
        </aside>
      </div>
    </main>
  );
}

function ReceiptTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-semibold">{value}</div>
    </div>
  );
}

function parseAgentRoute(pathname: string): AgentRoute {
  if (pathname === "/agent" || pathname === "/agent/manual.txt") return { kind: "manual-text" };
  if (pathname === "/agent/projects.txt") return { kind: "projects-text" };
  if (pathname === "/agent/projects.json") return { kind: "projects-json" };
  if (pathname === "/agent/commands") return { kind: "commands" };
  const projectMatch = pathname.match(/^\/agent\/projects\/([^/]+)\.(txt|json)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    return projectMatch[2] === "txt" ? { kind: "project-text", projectId } : { kind: "project-json", projectId };
  }
  return { kind: "not-found" };
}

function initialCommandInput() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("command") ?? params.get("text");
  if (explicit) return explicit;
  const title = params.get("title");
  const text = params.get("text");
  const url = params.get("url");
  return [title, text, url].filter(Boolean).join("\n");
}

function lastReceipt() {
  try {
    const raw = localStorage.getItem(receiptStorageKey);
    return raw ? JSON.parse(raw) as AgentCommandReceipt : undefined;
  } catch {
    return undefined;
  }
}

function saveReceipt(receipt: AgentCommandReceipt) {
  localStorage.setItem(receiptStorageKey, JSON.stringify(receipt, null, 2));
}

async function copyText(text: string) {
  await navigator.clipboard?.writeText(text);
}

function useNoIndex() {
  useEffect(() => {
    let meta = document.querySelector('meta[name="robots"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "robots");
      document.head.append(meta);
    }
    meta.setAttribute("content", "noindex,nofollow");
  }, []);
}
