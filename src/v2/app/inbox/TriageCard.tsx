import { useCallback, useRef, useState } from "react";

import { evaluateActionEligibility } from "../../domain/actionPolicy";
import type {
  ActionEligibilityFacts,
  InboxItem,
} from "../../domain/types";
import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { HumanConfirmationDialog } from "../components/HumanConfirmationDialog";
import { useCommandForm } from "../state/useCommandForm";
import { ClassificationExplanation } from "./ClassificationExplanation";

type ClassificationKind = "action" | "project";
type BooleanAnswer = "" | "yes" | "no";
type DependencyAnswer = "" | "none" | "has";

interface EligibilityDraft {
  singleSession: BooleanAnswer;
  estimateMinutes: string;
  dependencyAnswer: DependencyAnswer;
  dependencyIds: string;
  requiresMilestoneEvidence: BooleanAnswer;
  outcomeCount: string;
  solutionKnown: BooleanAnswer;
}

interface ClassificationSubmission {
  kind: ClassificationKind;
  entityId: string;
  eligibility: ActionEligibilityFacts;
}

let classificationIdSequence = 0;

function createClassificationId(kind: ClassificationKind): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${kind}:${uuid}`;
  classificationIdSequence += 1;
  return `${kind}:${Date.now()}:${classificationIdSequence}`;
}

function emptyEligibilityDraft(): EligibilityDraft {
  return {
    singleSession: "",
    estimateMinutes: "",
    dependencyAnswer: "",
    dependencyIds: "",
    requiresMilestoneEvidence: "",
    outcomeCount: "",
    solutionKnown: "",
  };
}

function parseEligibilityDraft(draft: EligibilityDraft): {
  facts?: ActionEligibilityFacts;
  error?: string;
} {
  const estimateSeconds = Number(draft.estimateMinutes) * 60;
  const outcomeCount = Number(draft.outcomeCount);
  const dependencyIds = [
    ...new Set(
      draft.dependencyIds
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const incomplete =
    draft.singleSession === "" ||
    draft.estimateMinutes.trim() === "" ||
    draft.dependencyAnswer === "" ||
    draft.requiresMilestoneEvidence === "" ||
    draft.outcomeCount.trim() === "" ||
    draft.solutionKnown === "" ||
    (draft.dependencyAnswer === "has" && dependencyIds.length === 0);
  const invalidNumbers =
    !Number.isSafeInteger(estimateSeconds) ||
    estimateSeconds <= 0 ||
    !Number.isSafeInteger(outcomeCount) ||
    outcomeCount <= 0;
  if (incomplete) {
    return { error: "Answer every boundary question before classification." };
  }
  if (invalidNumbers) {
    return {
      error:
        "Estimate and outcome count must resolve to positive whole numbers.",
    };
  }
  return {
    facts: {
      singleSession: draft.singleSession === "yes",
      estimateSeconds,
      dependencyIds:
        draft.dependencyAnswer === "none" ? [] : dependencyIds,
      requiresMilestoneEvidence:
        draft.requiresMilestoneEvidence === "yes",
      outcomeCount,
      solutionKnown: draft.solutionKnown === "yes",
    },
  };
}

export interface TriageCardProps {
  item: InboxItem;
  recordRef(node: HTMLElement | null): void;
  onClassified(inboxItemId: string): void;
}

export function TriageCard({
  item,
  recordRef,
  onClassified,
}: TriageCardProps) {
  const [draft, setDraft] = useState<EligibilityDraft>(emptyEligibilityDraft);
  const [dialogKind, setDialogKind] = useState<ClassificationKind>();
  const actionTriggerRef = useRef<HTMLButtonElement>(null);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const buildCommand = useCallback(
    (submission: ClassificationSubmission) => {
      if (submission.kind === "action") {
        return {
          type: "confirm_action_triage",
          inboxItemId: item.id,
          action: {
            id: submission.entityId,
            title: item.originalText,
            eligibility: submission.eligibility,
            attention: "medium",
          },
        } as const;
      }
      return {
        type: "confirm_project_triage",
        inboxItemId: item.id,
        eligibility: submission.eligibility,
        project: {
          id: submission.entityId,
          name: item.originalText,
          priority: 0,
          notes: "Captured and classified in Inbox.",
        },
      } as const;
    },
    [item.id, item.originalText],
  );
  const form = useCommandForm(buildCommand);
  const parsedDraft = parseEligibilityDraft(draft);
  const recommendation =
    parsedDraft.facts === undefined
      ? undefined
      : evaluateActionEligibility(parsedDraft.facts);

  const confirm = async () => {
    if (dialogKind === undefined || parsedDraft.facts === undefined) return;
    const result = await form.submit({
      kind: dialogKind,
      entityId: createClassificationId(dialogKind),
      eligibility: structuredClone(parsedDraft.facts),
    });
    setDialogKind(undefined);
    if (result.ok) onClassified(item.id);
  };

  if (item.triageStatus !== "untriaged") {
    const kind = item.triageStatus === "action" ? "Action" : "Project";
    return (
      <article
        className="v2-classified-record"
        aria-label={`${kind}: ${item.originalText}`}
        ref={recordRef}
        tabIndex={-1}
      >
        <div>
          <p className="v2-eyebrow">Classified as {kind}</p>
          <h3>{item.originalText}</h3>
        </div>
        <p>
          The capture remains here as history. Continue work in the {kind}
          record.
        </p>
      </article>
    );
  }

  const dialogReturnRef =
    dialogKind === "action" ? actionTriggerRef : projectTriggerRef;

  return (
    <article
      className="v2-triage-card"
      aria-label={`Triage: ${item.originalText}`}
      ref={recordRef}
      tabIndex={-1}
    >
      <header className="v2-triage-card__header">
        <div>
          <p className="v2-eyebrow">Untriaged capture</p>
          <h3>{item.originalText}</h3>
        </div>
        <span>Captured {item.capturedAt.slice(0, 10)}</span>
      </header>

      <fieldset className="v2-triage-facts">
        <legend>Check the lightweight Action boundary</legend>
        <label className="v2-triage-field">
          <span>One session</span>
          <select
            value={draft.singleSession}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                singleSession: event.target.value as BooleanAnswer,
              }))
            }
          >
            <option value="">Choose…</option>
            <option value="yes">Yes, one session</option>
            <option value="no">No, more than one session</option>
          </select>
        </label>
        <label className="v2-triage-field">
          <span>Estimate minutes</span>
          <input
            type="number"
            min="1"
            step="0.01"
            value={draft.estimateMinutes}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                estimateMinutes: event.target.value,
              }))
            }
          />
        </label>
        <label className="v2-triage-field">
          <span>Dependency state</span>
          <select
            value={draft.dependencyAnswer}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dependencyAnswer: event.target.value as DependencyAnswer,
              }))
            }
          >
            <option value="">Choose…</option>
            <option value="none">No dependencies</option>
            <option value="has">Has dependencies</option>
          </select>
        </label>
        <label className="v2-triage-field">
          <span>Dependency IDs</span>
          <input
            type="text"
            value={draft.dependencyIds}
            disabled={draft.dependencyAnswer !== "has"}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                dependencyIds: event.target.value,
              }))
            }
            placeholder="Comma-separated IDs"
          />
        </label>
        <label className="v2-triage-field">
          <span>Requires milestone evidence</span>
          <select
            value={draft.requiresMilestoneEvidence}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                requiresMilestoneEvidence: event.target.value as BooleanAnswer,
              }))
            }
          >
            <option value="">Choose…</option>
            <option value="no">No evidence milestone</option>
            <option value="yes">Yes, evidence required</option>
          </select>
        </label>
        <label className="v2-triage-field">
          <span>Outcome count</span>
          <input
            type="number"
            min="1"
            step="1"
            value={draft.outcomeCount}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                outcomeCount: event.target.value,
              }))
            }
          />
        </label>
        <label className="v2-triage-field">
          <span>Solution known</span>
          <select
            value={draft.solutionKnown}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                solutionKnown: event.target.value as BooleanAnswer,
              }))
            }
          >
            <option value="">Choose…</option>
            <option value="yes">Yes, solution known</option>
            <option value="no">No, solution uncertain</option>
          </select>
        </label>
      </fieldset>

      <ClassificationExplanation
        facts={parsedDraft.facts}
        inputError={parsedDraft.error}
      />

      <div className="v2-triage-actions">
        <p>
          Recommendation is policy guidance. Project structure is always an
          explicit human choice; an ineligible Action is never available.
        </p>
        <div>
          {recommendation === undefined || recommendation.kind === "action" ? (
            <button
              ref={actionTriggerRef}
              type="button"
              disabled={parsedDraft.facts === undefined || form.pending}
              onClick={() => setDialogKind("action")}
            >
              Review as Action
            </button>
          ) : null}
          <button
            ref={projectTriggerRef}
            className="v2-button--primary"
            type="button"
            disabled={parsedDraft.facts === undefined || form.pending}
            onClick={() => setDialogKind("project")}
          >
            Review as Project
          </button>
        </div>
      </div>

      <HumanConfirmationDialog
        kind={dialogKind === "project" ? "Project" : "Action"}
        itemTitle={item.originalText}
        open={dialogKind !== undefined}
        pending={form.pending}
        returnFocusRef={dialogReturnRef}
        onCancel={() => setDialogKind(undefined)}
        onConfirm={() => void confirm()}
      />

      <CommandRejectionCard
        result={form.result}
        onResolve={(command) => {
          if (command === "confirm_project_triage") {
            projectTriggerRef.current?.focus();
          } else {
            actionTriggerRef.current?.focus();
          }
        }}
      />
    </article>
  );
}
