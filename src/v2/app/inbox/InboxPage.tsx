import { useCallback, useEffect, useRef, useState } from "react";

import { EmptyState } from "../components/EmptyState";
import { useOperationalV2Workspace } from "../state/V2WorkspaceProvider";
import { CaptureForm } from "./CaptureForm";
import { TriageCard } from "./TriageCard";

export function InboxPage() {
  const state = useOperationalV2Workspace();
  const recordRefs = useRef(new Map<string, HTMLElement>());
  const [pendingFocusId, setPendingFocusId] = useState<string>();
  const registerRecord = useCallback(
    (id: string, node: HTMLElement | null) => {
      if (node === null) recordRefs.current.delete(id);
      else recordRefs.current.set(id, node);
    },
    [],
  );

  useEffect(() => {
    if (pendingFocusId === undefined) return;
    const target = recordRefs.current.get(pendingFocusId);
    if (target === undefined) return;
    target.focus();
    setPendingFocusId(undefined);
  }, [pendingFocusId, state.workspace.revision]);

  const untriagedCount = state.workspace.inboxItems.filter(
    ({ triageStatus }) => triageStatus === "untriaged",
  ).length;

  return (
    <article
      className="v2-route-page v2-inbox-page"
      aria-labelledby="v2-inbox-title"
    >
      <header className="v2-page-heading">
        <p className="v2-eyebrow">Capture · Clarify · Confirm</p>
        <h1 id="v2-inbox-title">Inbox</h1>
        <p className="v2-page-summary">
          Capture first, then test the thought against six deterministic
          boundaries. Nothing becomes committed work without your explicit
          confirmation.
        </p>
      </header>

      <CaptureForm onCaptured={setPendingFocusId} />

      <section className="v2-inbox-queue" aria-labelledby="inbox-queue-title">
        <header className="v2-inbox-queue__header">
          <div>
            <p className="v2-eyebrow">Step 02 · Clarify deliberately</p>
            <h2 id="inbox-queue-title">Triage the queue</h2>
          </div>
          <p>
            <strong>{untriagedCount}</strong> awaiting decision ·{" "}
            {state.workspace.inboxItems.length} total captures
          </p>
        </header>

        {state.workspace.inboxItems.length === 0 ? (
          <EmptyState
            title="The Inbox is clear"
            description="Capture one thought above. It will remain inert until you classify it."
          />
        ) : (
          <div className="v2-triage-list">
            {state.workspace.inboxItems.map((item) => (
              <TriageCard
                key={item.id}
                item={item}
                recordRef={(node) => registerRecord(item.id, node)}
                onClassified={setPendingFocusId}
              />
            ))}
          </div>
        )}
      </section>
    </article>
  );
}
