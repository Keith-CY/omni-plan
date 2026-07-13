import type { ReactNode } from "react";

export function TopActionCard({
  eyebrow = "Recommended next action",
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <aside className="v2-top-action-card" aria-label={eyebrow}>
      <p className="v2-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{description}</p>
      {action === undefined ? null : (
        <div className="v2-top-action-card__action">{action}</div>
      )}
    </aside>
  );
}
