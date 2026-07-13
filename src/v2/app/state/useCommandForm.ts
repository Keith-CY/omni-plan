import {
  useCallback,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { CommandResult, V2Command } from "../../domain/commands";
import { useOperationalV2Workspace } from "./V2WorkspaceProvider";

export interface CommandFormFocusTargets {
  rejectionFocusRef?: RefObject<HTMLElement>;
  successFocusRef?: RefObject<HTMLElement>;
}

export interface CommandFormState<T> {
  pending: boolean;
  result: CommandResult | undefined;
  submit(values: T): Promise<CommandResult>;
}

function focusAfterRender(target: RefObject<HTMLElement> | undefined): void {
  if (target === undefined) return;
  queueMicrotask(() => target.current?.focus());
}

export function useCommandForm<T>(
  buildCommand: (values: T) => V2Command,
  focusTargets: CommandFormFocusTargets = {},
): CommandFormState<T> {
  const { dispatch } = useOperationalV2Workspace();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CommandResult>();
  const inFlight = useRef<Promise<CommandResult> | null>(null);

  const submit = useCallback(
    (values: T): Promise<CommandResult> => {
      if (inFlight.current !== null) return inFlight.current;
      setPending(true);
      const operation = dispatch(buildCommand(values))
        .then((next) => {
          setResult(next);
          focusAfterRender(
            next.ok
              ? focusTargets.successFocusRef
              : focusTargets.rejectionFocusRef,
          );
          return next;
        })
        .finally(() => {
          inFlight.current = null;
          setPending(false);
        });
      inFlight.current = operation;
      return operation;
    },
    [buildCommand, dispatch, focusTargets.rejectionFocusRef, focusTargets.successFocusRef],
  );

  return { pending, result, submit };
}
