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
import { sampleWorkspace } from "./domain/sampleData";
import { BrowserWorkspaceRepository } from "./domain/storage";
import type { WorkspaceSnapshot } from "./domain/types";
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(sampleWorkspace);
  const generatedAt = useMemo(() => new Date().toISOString(), []);

  useEffect(() => {
    let active = true;
    void repository.load().then((stored) => {
      if (!active) return;
      setWorkspace(stored ?? sampleWorkspace);
    }).catch(() => {
      if (!active) return;
      setWorkspace(sampleWorkspace);
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
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(sampleWorkspace);
  const [loaded, setLoaded] = useState(false);
  const [commandInput, setCommandInput] = useState(() => initialCommandInput());
  const [receipt, setReceipt] = useState<AgentCommandReceipt | undefined>(() => lastReceipt());
  const [notice, setNotice] = useState("Dry-run a command before applying it.");

  useNoIndex();

  useEffect(() => {
    document.title = "Agent Command Inbox";
    let active = true;
    void repository.load().then((stored) => {
      if (!active) return;
      setWorkspace(stored ?? sampleWorkspace);
      setLoaded(true);
    }).catch((error: unknown) => {
      if (!active) return;
      setLoaded(true);
      setNotice(`Workspace load failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
    return () => {
      active = false;
    };
  }, [repository]);

  const runDryRun = () => {
    const result = previewAgentCommandInput(workspace, commandInput);
    setReceipt(result.receipt);
    saveReceipt(result.receipt);
    setNotice(result.receipt.risk === "invalid" ? "Command rejected during dry-run." : "Dry-run receipt generated.");
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
      ? "Command applied and saved to the browser workspace."
      : result.receipt.status === "queued"
        ? "Guarded command queued as a ChangeSet and Audit Gate."
        : "Command rejected.");
  };

  const sampleJson = JSON.stringify({
    command_type: "create_task",
    project_id: workspace.projects[0]?.id ?? "p-omni",
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
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Agent write boundary</p>
              <h1 className="text-2xl font-semibold">Command Inbox</h1>
              <p className="text-sm text-muted-foreground">Paste a Shortcut or AI Agent command. Dry-run first; guarded changes queue for review.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant={loaded ? "success" : "warning"}>{loaded ? "local workspace" : "loading"}</Badge>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/manual.txt">Manual</a>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/agent/projects.txt">Projects</a>
              <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href="/">App</a>
            </div>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Command Input</CardTitle>
              <CardDescription>Accepts plain text or JSON. Natural language uses local rules only in this version.</CardDescription>
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
                <Button type="button" onClick={runDryRun} disabled={!commandInput.trim()}>Dry run</Button>
                <Button type="button" variant="outline" onClick={() => void applyCommand()} disabled={!commandInput.trim()}>Apply or queue</Button>
                <Button type="button" variant="ghost" onClick={() => setCommandInput(sampleJson)}>Use JSON sample</Button>
                <Button type="button" variant="ghost" onClick={() => setCommandInput("")}>Clear</Button>
              </div>
              <p className="rounded-lg border bg-muted/40 p-3 text-sm">{notice}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Shortcut Pattern</CardTitle>
              <CardDescription>First-version iPhone flow: dictate or build text, then share or paste it here.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>1. Shortcut action: Ask for Text or Dictate Text.</p>
              <p>2. Optional: build JSON text with project_id and command_type.</p>
              <p>3. Open URL: /agent/commands?text=&lt;encoded command&gt; or share text into the installed PWA.</p>
              <p>4. Review the Command Receipt; low-risk commands apply, guarded commands queue.</p>
            </CardContent>
          </Card>
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Command Receipt</CardTitle>
              <CardDescription>Machine-readable result for the last dry-run or apply action.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {receipt ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <ReceiptTile label="Status" value={receipt.status} />
                    <ReceiptTile label="Risk" value={receipt.risk} />
                    <ReceiptTile label="Dry run" value={receipt.dry_run ? "true" : "false"} />
                    <ReceiptTile label="Diffs" value={String(receipt.diffs.length)} />
                  </div>
                  <pre className="max-h-[56vh] overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">{JSON.stringify(receipt, null, 2)}</pre>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyText(JSON.stringify(receipt, null, 2))}>Copy receipt</Button>
                    {receipt.project_id && <a className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent" href={`/agent/projects/${encodeURIComponent(receipt.project_id)}.txt`}>Project status</a>}
                  </div>
                </>
              ) : (
                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">No receipt yet.</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Rules</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>Low-risk: ordinary task, progress, actuals, evidence, notes.</p>
              <p>Guarded: dependencies, baselines, scope expansion, milestone completion without evidence, completion, archive.</p>
              <p>Secrets are never read from agent pages.</p>
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
