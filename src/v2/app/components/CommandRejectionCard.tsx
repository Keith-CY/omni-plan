import { useEffect, useRef } from "react";

import type { CommandResult } from "../../domain/commands";

export interface CommandRejectionCardProps {
  result?: CommandResult;
  onResolve(command: string): void;
}

export function CommandRejectionCard({
  result,
  onResolve,
}: CommandRejectionCardProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (result?.ok === false) headingRef.current?.focus();
  }, [result]);

  if (result === undefined || result.ok) return null;
  const { rejection } = result;
  return (
    <section
      className="v2-command-rejection"
      role="alert"
      aria-labelledby="command-rejection-title"
    >
      <p className="v2-eyebrow">Policy boundary</p>
      <h2 id="command-rejection-title" ref={headingRef} tabIndex={-1}>
        This change is blocked
      </h2>
      <p>{rejection.reason}</p>
      {rejection.hold === undefined ? null : (
        <p>
          <strong>Hold:</strong> {rejection.hold.replace(/_/g, " ")}
        </p>
      )}
      {rejection.gate === undefined ? null : (
        <p>
          <strong>Gate:</strong> <code>{rejection.gate}</code>
        </p>
      )}
      <button
        type="button"
        onClick={() => onResolve(rejection.permittedNextCommand)}
      >
        Resolve: {rejection.permittedNextCommand.replace(/_/g, " ")}
      </button>
    </section>
  );
}
