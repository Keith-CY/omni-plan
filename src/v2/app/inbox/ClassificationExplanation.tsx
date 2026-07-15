import {
  actionRules,
  evaluateActionEligibility,
} from "../../domain/actionPolicy";
import type { ActionEligibilityFacts } from "../../domain/types";

const RULE_LABELS: Record<(typeof actionRules)[number]["code"], string> = {
  ONE_SESSION: "One working session",
  TWO_HOUR_LIMIT: "Two-hour limit",
  NO_DEPENDENCY: "No dependencies",
  NO_MILESTONE_EVIDENCE: "No milestone evidence",
  ONE_OUTCOME: "One outcome",
  KNOWN_SOLUTION: "Known solution",
};

export function ClassificationExplanation({
  facts,
  inputError,
}: {
  facts?: ActionEligibilityFacts;
  inputError?: string;
}) {
  const recommendation =
    facts === undefined ? undefined : evaluateActionEligibility(facts);
  const failedRules = new Set(recommendation?.ruleCodes ?? []);

  return (
    <section
      className="v2-classification-explanation"
      aria-label="Deterministic Action rules"
    >
      <div className="v2-classification-explanation__summary" role="status">
        <span>Recommendation</span>
        <strong>
          {facts === undefined
            ? "Complete required facts"
            : recommendation?.kind === "action"
            ? "Action recommended"
            : "Project recommended"}
        </strong>
        <p>
          {inputError ??
            recommendation?.explanation ??
            "Answer every boundary question before classification."}
        </p>
      </div>
      <ol className="v2-rule-list">
        {actionRules.map((rule) => {
          const failed = failedRules.has(rule.code);
          const pending = facts === undefined;
          return (
            <li
              className="v2-rule-item"
              data-status={pending ? "pending" : failed ? "project" : "action"}
              key={rule.code}
            >
              <code>{rule.code}</code>
              <strong>{RULE_LABELS[rule.code]}</strong>
              <span>
                {pending
                  ? "Awaiting your answer."
                  : failed
                    ? rule.reason
                    : "Fits the Action boundary."}
              </span>
              <small>
                {pending ? "Required" : failed ? "Needs Project" : "Pass"}
              </small>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
