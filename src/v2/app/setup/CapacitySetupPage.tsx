import { useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";

import type { CapacityProfile } from "../../domain/types";
import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { useCommandForm } from "../state/useCommandForm";
import { CapacityEditor } from "./CapacityEditor";

export function CapacitySetupPage({
  calibrationSuggestion,
}: {
  calibrationSuggestion?: CapacityProfile;
}) {
  const navigate = useNavigate();
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const buildCommand = useCallback(
    (profile: CapacityProfile) =>
      ({ type: "configure_capacity", profile }) as const,
    [],
  );
  const form = useCommandForm(buildCommand);

  const save = async (profile: CapacityProfile) => {
    const result = await form.submit(profile);
    if (result.ok) navigate("/today", { replace: true });
  };

  return (
    <div className="v2-app v2-bootstrap-shell v2-setup-shell">
      <main className="v2-bootstrap-card v2-setup-card">
        <article
          className="v2-route-page"
          aria-labelledby="capacity-setup-title"
        >
          <header className="v2-page-heading">
            <p className="v2-eyebrow">Required once · editable later</p>
            <h1 id="capacity-setup-title">Set your capacity</h1>
            <p className="v2-page-summary">
              Define the limits OmniPlan must respect before it can recommend
              or commit work. A smaller honest plan beats a larger fictional
              one.
            </p>
          </header>

          <CapacityEditor
            calibrationSuggestion={calibrationSuggestion}
            pending={form.pending}
            saveButtonRef={saveButtonRef}
            onSave={save}
          />

          <CommandRejectionCard
            result={form.result}
            onResolve={() => saveButtonRef.current?.focus()}
          />
        </article>
      </main>
    </div>
  );
}
