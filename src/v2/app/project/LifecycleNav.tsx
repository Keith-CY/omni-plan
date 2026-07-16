import { Link } from "react-router-dom";

import type {
  ProjectLifecycleStep,
  UserLifecycleStage,
} from "../../domain/selectors";
import type { LifecycleStage } from "../../domain/types";

export const USER_LIFECYCLE_STAGES = [
  "direction",
  "bet",
  "plan",
  "execute",
  "evidence",
  "close",
] as const satisfies readonly UserLifecycleStage[];

export const USER_STAGE_LABELS: Record<UserLifecycleStage, string> = {
  direction: "Direction",
  bet: "Bet",
  plan: "Plan",
  execute: "Execute",
  evidence: "Evidence",
  close: "Close",
};

export function projectStageSegment(stage: LifecycleStage): UserLifecycleStage {
  switch (stage) {
    case "direction":
      return "direction";
    case "awaiting_bet":
      return "bet";
    case "planning":
      return "plan";
    case "executing":
      return "execute";
    case "validating":
      return "evidence";
    case "closing":
    case "closed":
      return "close";
  }
}

export function lifecycleStageLabel(stage: LifecycleStage): string {
  return stage === "closed" ? "Closed" : USER_STAGE_LABELS[projectStageSegment(stage)];
}

export interface LifecycleNavProps {
  projectId: string;
  steps: readonly ProjectLifecycleStep[];
}

export function LifecycleNav({ projectId, steps }: LifecycleNavProps) {
  return (
    <nav className="v2-lifecycle-nav" aria-label="Project lifecycle">
      <p className="v2-lifecycle-sequence">
        Direction -&gt; Bet -&gt; Plan -&gt; Execute -&gt; Evidence -&gt; Close
      </p>
      <ol>
        {steps.map((step) => (
          <li
            key={step.stage}
            className={`v2-lifecycle-step v2-lifecycle-step--${step.status}`}
          >
            {step.status === "completed" ? (
              <Link
                to={`/projects/${projectId}/${step.stage}?view=history`}
                aria-label={`View ${step.label} history`}
              >
                <span>{step.label}</span>
                <small>History</small>
              </Link>
            ) : step.status === "current" ? (
              <Link
                to={`/projects/${projectId}/${step.stage}`}
                aria-current="step"
                aria-label={step.label}
              >
                <span>{step.label}</span>
                <small>Current</small>
              </Link>
            ) : (
              <div aria-disabled="true">
                <span>{step.label}</span>
                <small>Locked</small>
              </div>
            )}
            {step.status === "locked" && step.reason !== undefined ? (
              <p>{step.reason}</p>
            ) : null}
            {step.status === "locked" && step.permittedNextCommand !== undefined ? (
              <details>
                <summary>Unlock command</summary>
                <code>{step.permittedNextCommand}</code>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
    </nav>
  );
}
