import { Navigate, Route, Routes } from "react-router-dom";

import type { WorkspaceV2 } from "../domain/types";
import { ActionsPage } from "./actions/ActionsPage";
import { InboxPage } from "./inbox/InboxPage";
import { ProjectWorkspacePage } from "./project/ProjectWorkspacePage";
import { ProjectsPage } from "./projects/ProjectsPage";
import { CapacitySetupPage } from "./setup/CapacitySetupPage";
import { AppShell } from "./shell/AppShell";
import { useV2Workspace } from "./state/V2WorkspaceProvider";

export const APP_ROUTE_PATHS = [
  "/setup",
  "/migration",
  "/inbox",
  "/inbox/actions",
  "/today",
  "/today/calendar",
  "/projects",
  "/projects/:projectId/:stage",
  "/review",
  "/settings",
  "/settings/automation",
] as const;

interface MetricProps {
  label: string;
  value: string | number;
  detail?: string;
}

function Metric({ label, value, detail }: MetricProps) {
  return (
    <div className="v2-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail === undefined ? null : <p>{detail}</p>}
    </div>
  );
}

interface ReadOnlyRoutePageProps {
  eyebrow: string;
  title: string;
  summary: string;
  children: React.ReactNode;
}

function ReadOnlyRoutePage({
  eyebrow,
  title,
  summary,
  children,
}: ReadOnlyRoutePageProps) {
  return (
    <article className="v2-route-page" aria-labelledby="v2-route-title">
      <header className="v2-page-heading">
        <p className="v2-eyebrow">{eyebrow}</p>
        <h1 id="v2-route-title">{title}</h1>
        <p className="v2-page-summary">{summary}</p>
      </header>
      <section
        className="v2-readonly-summary"
        aria-label={`${title} workspace summary`}
        data-readonly="true"
      >
        {children}
      </section>
      <p className="v2-slice-note">
        Read-only shell view <span aria-hidden="true">·</span> Commands arrive
        in the next feature slice.
      </p>
    </article>
  );
}

function RevisionMetric({ workspace }: { workspace: WorkspaceV2 }) {
  return (
    <Metric
      label="Workspace revision"
      value={workspace.revision}
      detail="All later writes must target this exact revision."
    />
  );
}

function TodayRoute() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const latest = [...state.workspace.dailyCommitments].sort((left, right) =>
    right.committedAt.localeCompare(left.committedAt)
  )[0];
  return (
    <ReadOnlyRoutePage
      eyebrow="Capacity before urgency"
      title="Today"
      summary="One human-approved daily commitment, generated inside your configured capacity."
    >
      <dl className="v2-metric-grid">
        <Metric
          label="Latest commitment"
          value={latest?.localDate ?? "Not committed"}
          detail={latest === undefined
            ? "A proposal never becomes a commitment automatically."
            : `${latest.slots.length} committed slot${latest.slots.length === 1 ? "" : "s"}.`}
        />
        <Metric label="Actuals recorded" value={state.workspace.actuals.length} />
        <Metric
          label="Capacity profile"
          value={state.workspace.capacityProfile?.timeZone ?? "Required"}
        />
      </dl>
    </ReadOnlyRoutePage>
  );
}

function CalendarRoute() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const slots = state.workspace.dailyCommitments.reduce(
    (count, commitment) => count + commitment.slots.length,
    0,
  );
  return (
    <ReadOnlyRoutePage
      eyebrow="Today view"
      title="Calendar"
      summary="Calendar is a view of accepted commitments—not a second planning system."
    >
      <dl className="v2-metric-grid">
        <Metric label="Commitment versions" value={state.workspace.dailyCommitments.length} />
        <Metric label="Committed slots" value={slots} />
        <Metric label="Open replans" value={state.workspace.replanProposals.filter(({ status }) => status === "open").length} />
      </dl>
    </ReadOnlyRoutePage>
  );
}

function ReviewRoute() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  const open = state.workspace.reviews.filter(({ status }) => status === "open").length;
  const conflicts = state.workspace.syncConflicts.filter(
    ({ resolvedAt }) => resolvedAt === undefined,
  ).length;
  return (
    <ReadOnlyRoutePage
      eyebrow="Inspect · Decide · Learn"
      title="Review"
      summary="Overdue reviews, exceptions, and conflicts stay explicit until a human resolves them."
    >
      <dl className="v2-metric-grid">
        <Metric label="Open reviews" value={open} />
        <Metric label="Unresolved conflicts" value={conflicts} />
        <Metric label="Evidence exceptions" value={state.workspace.exceptions.length} />
      </dl>
    </ReadOnlyRoutePage>
  );
}

function SettingsRoute() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  return (
    <ReadOnlyRoutePage
      eyebrow="Workspace utility"
      title="Settings"
      summary="Capacity, portability, recovery, and automation live outside primary navigation."
    >
      <dl className="v2-metric-grid">
        <Metric label="Workspace" value={state.workspace.workspaceId} />
        <Metric label="Time zone" value={state.workspace.capacityProfile?.timeZone ?? "Not configured"} />
        <RevisionMetric workspace={state.workspace} />
      </dl>
    </ReadOnlyRoutePage>
  );
}

function AutomationRoute() {
  const state = useV2Workspace();
  if (state.status !== "ready") return null;
  return (
    <ReadOnlyRoutePage
      eyebrow="Settings utility"
      title="Automation"
      summary="Agents may capture facts or submit proposals; protected decisions remain human-only."
    >
      <dl className="v2-metric-grid">
        <Metric label="Open proposals" value={state.workspace.commandProposals.filter(({ status }) => status === "open").length} />
        <Metric label="Command receipts" value={state.workspace.commandReceipts.length} />
        <Metric label="Sync conflicts" value={state.workspace.syncConflicts.filter(({ resolvedAt }) => resolvedAt === undefined).length} />
      </dl>
    </ReadOnlyRoutePage>
  );
}

function BootstrapFrame({
  eyebrow,
  title,
  summary,
  children,
}: ReadOnlyRoutePageProps) {
  return (
    <div className="v2-app v2-bootstrap-shell">
      <main className="v2-bootstrap-card">
        <ReadOnlyRoutePage eyebrow={eyebrow} title={title} summary={summary}>
          {children}
        </ReadOnlyRoutePage>
      </main>
    </div>
  );
}

function BootingRoute() {
  return (
    <BootstrapFrame
      eyebrow="Local-first bootstrap"
      title="Opening workspace"
      summary="Checking the durable Workspace and recovery record before enabling any command."
    >
      <div className="v2-boot-progress" role="progressbar" aria-label="Opening workspace">
        <span />
      </div>
    </BootstrapFrame>
  );
}

function MigrationRoute() {
  const state = useV2Workspace();
  if (state.status !== "migration_required") return null;
  return (
    <BootstrapFrame
      eyebrow="Guided cutover"
      title="Migration required"
      summary="A V1 Workspace was found. Review its conversion before V2 writes are enabled."
    >
      <p className="v2-inline-notice">
        Source data remains untouched until the atomic migration is reviewed and committed.
      </p>
    </BootstrapFrame>
  );
}

function RecoveryRoute() {
  const state = useV2Workspace();
  if (state.status !== "recovery_error") return null;
  return (
    <BootstrapFrame
      eyebrow="Writes paused"
      title="Migration recovery"
      summary="The last migration attempt needs human review before work can continue."
    >
      <dl className="v2-metric-grid">
        <Metric label="Recovery code" value={state.recovery.code} />
        <Metric label="Backup" value={state.recovery.backupId} />
        <Metric label="Recorded" value={state.recovery.occurredAt} />
      </dl>
      <p className="v2-inline-notice">{state.recovery.message}</p>
    </BootstrapFrame>
  );
}

function ReadyRoutes() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/today" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/inbox/actions" element={<ActionsPage />} />
        <Route path="/today" element={<TodayRoute />} />
        <Route path="/today/calendar" element={<CalendarRoute />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId/:stage" element={<ProjectWorkspacePage />} />
        <Route path="/review" element={<ReviewRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="/settings/automation" element={<AutomationRoute />} />
        <Route path="/setup" element={<Navigate to="/today" replace />} />
        <Route path="/migration" element={<Navigate to="/today" replace />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Route>
    </Routes>
  );
}

export function V2Routes() {
  const state = useV2Workspace();
  switch (state.status) {
    case "booting":
      return <BootingRoute />;
    case "migration_required":
      return (
        <Routes>
          <Route path="/migration" element={<MigrationRoute />} />
          <Route path="*" element={<Navigate to="/migration" replace />} />
        </Routes>
      );
    case "recovery_error":
      return (
        <Routes>
          <Route path="/migration" element={<RecoveryRoute />} />
          <Route path="*" element={<Navigate to="/migration" replace />} />
        </Routes>
      );
    case "setup_required":
      return (
        <Routes>
          <Route path="/setup" element={<CapacitySetupPage />} />
          <Route path="*" element={<Navigate to="/setup" replace />} />
        </Routes>
      );
    case "ready":
      return <ReadyRoutes />;
  }
}
