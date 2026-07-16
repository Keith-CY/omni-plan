import type { ActiveHold } from "../../domain/selectors";
import type { ProjectHold } from "../../domain/types";

const holdLabels: Record<ProjectHold, string> = {
  migration_review: "Migration review",
  rebet_required: "Re-bet required",
  review_overdue: "Review overdue",
  sync_conflict: "Sync conflict",
};

export interface HoldBannerProps {
  holds: readonly ActiveHold[];
  compact?: boolean;
}

export function HoldBanner({ holds, compact = false }: HoldBannerProps) {
  if (holds.length === 0) return null;

  return (
    <aside
      className={`v2-hold-banner${compact ? " v2-hold-banner--compact" : ""}`}
      aria-label="Active project holds"
    >
      <div className="v2-hold-banner__heading">
        <p className="v2-eyebrow">Active policy holds</p>
        <h2>{holds.length} active {holds.length === 1 ? "hold" : "holds"}</h2>
      </div>
      <ul className="v2-hold-list">
        {holds.map((hold) => (
          <li key={`${hold.type}:${hold.sourceId}`}>
            <strong>{holdLabels[hold.type]}</strong>
            <p>{hold.reason}</p>
            <p className="v2-hold-list__command">
              Permitted next command: <code>{hold.permittedNextCommand}</code>
            </p>
            <details>
              <summary>Hold record</summary>
              <dl>
                <div>
                  <dt>Source</dt>
                  <dd><code>{hold.sourceId}</code></dd>
                </div>
                <div>
                  <dt>Affected records</dt>
                  <dd>{hold.affectedRecordIds.join(", ")}</dd>
                </div>
              </dl>
            </details>
          </li>
        ))}
      </ul>
    </aside>
  );
}
