import { useCallback, useRef, useState } from "react";

import { CommandRejectionCard } from "../components/CommandRejectionCard";
import { useCommandForm } from "../state/useCommandForm";

interface CaptureSubmission {
  id: string;
  text: string;
}

let captureIdSequence = 0;

function createCaptureId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `inbox:${uuid}`;
  captureIdSequence += 1;
  return `inbox:${Date.now()}:${captureIdSequence}`;
}

export function CaptureForm({
  onCaptured,
}: {
  onCaptured(inboxItemId: string): void;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const buildCommand = useCallback(
    ({ id, text: captureText }: CaptureSubmission) =>
      ({ type: "capture_inbox", id, text: captureText }) as const,
    [],
  );
  const form = useCommandForm(buildCommand);

  const capture = async () => {
    const captureText = text.trim();
    if (captureText === "") {
      inputRef.current?.focus();
      return;
    }
    const id = createCaptureId();
    const result = await form.submit({ id, text: captureText });
    if (!result.ok) return;
    setText("");
    onCaptured(id);
  };

  return (
    <section className="v2-capture-panel" aria-labelledby="inbox-capture-title">
      <div className="v2-capture-panel__intro">
        <p className="v2-eyebrow">Step 01 · Capture only</p>
        <h2 id="inbox-capture-title">Get it out of your head</h2>
        <p>
          Capture the thought as written. OmniPlan will not turn it into work
          until you classify it below.
        </p>
      </div>
      <form
        className="v2-capture-form"
        onSubmit={(event) => {
          event.preventDefault();
          void capture();
        }}
      >
        <label htmlFor="v2-inbox-capture">
          <span>Capture one thought</span>
          <input
            id="v2-inbox-capture"
            ref={inputRef}
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <button
          className="v2-button--primary"
          type="submit"
          disabled={form.pending || text.trim() === ""}
        >
          {form.pending ? "Capturing…" : "Capture"}
        </button>
      </form>
      <CommandRejectionCard
        result={form.result}
        onResolve={() => inputRef.current?.focus()}
      />
    </section>
  );
}
