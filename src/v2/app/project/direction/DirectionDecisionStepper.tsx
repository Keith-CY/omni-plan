import type { DirectionBriefDraft } from "../../../domain/commands";
import { directionCompleteness } from "../../../domain/direction";

export const DIRECTION_DECISIONS = [
  { key: "audienceAndProblem", label: "Audience and problem" },
  { key: "successEvidence", label: "Success evidence" },
  { key: "appetite", label: "Appetite" },
  { key: "validationMethod", label: "Validation method" },
  { key: "firstScope", label: "First scope" },
  { key: "noGoOrKill", label: "No-go or kill criteria" },
] as const;

export type DirectionDecisionKey = (typeof DIRECTION_DECISIONS)[number]["key"];

export function firstIncompleteDecision(brief: DirectionBriefDraft): number {
  const completeness = directionCompleteness(brief);
  const index = DIRECTION_DECISIONS.findIndex(({ key }) => !completeness[key]);
  return index < 0 ? DIRECTION_DECISIONS.length - 1 : index;
}

export interface DirectionDecisionStepperProps {
  draft: DirectionBriefDraft;
  activeIndex: number;
  disabled: boolean;
  lockOtherSteps: boolean;
  onSelect(index: number): void;
}

export function DirectionDecisionStepper({
  draft,
  activeIndex,
  disabled,
  lockOtherSteps,
  onSelect,
}: DirectionDecisionStepperProps) {
  const completeness = directionCompleteness(draft);
  const firstIncomplete = DIRECTION_DECISIONS.findIndex(
    ({ key }) => !completeness[key],
  );
  const furthestReachable = firstIncomplete < 0
    ? DIRECTION_DECISIONS.length - 1
    : firstIncomplete;

  return (
    <nav className="v2-direction-stepper" aria-label="Direction decisions">
      <ol>
        {DIRECTION_DECISIONS.map((decision, index) => {
          const complete = completeness[decision.key];
          const future = index > furthestReachable;
          const lockedByUnsavedChanges = lockOtherSteps && index !== activeIndex;
          return (
            <li key={decision.key}>
              <button
                type="button"
                aria-label={decision.label}
                aria-current={index === activeIndex ? "step" : undefined}
                data-complete={complete ? "true" : "false"}
                disabled={disabled || future || lockedByUnsavedChanges}
                onClick={() => onSelect(index)}
              >
                <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <strong>{decision.label}</strong>
                <small>{complete ? "Complete" : future ? "Later" : "Required"}</small>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
