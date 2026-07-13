import {
  isStructurallyValidCommand,
  isStructurallyValidCommandContext,
  type CommandContext,
  type CommandResult,
  type V2Command,
} from "../domain/commands";
import type { ISODate } from "@/domain/types";
import type { CommandSource } from "../domain/types";

export interface AgentDispatchInput {
  command: V2Command;
  commandId: string;
  expectedRevision: number;
  actorId: string;
  sourceId: string;
  now: ISODate;
}

export interface AgentCommandServicePort {
  dispatch(command: V2Command, context: CommandContext): Promise<CommandResult>;
}

export interface AgentSourceResolutionKey {
  sourceId: string;
  actorId: string;
}

export interface AgentSourceResolver {
  resolve(
    key: AgentSourceResolutionKey,
  ): CommandSource | undefined | Promise<CommandSource | undefined>;
}

export type AgentAdapterBoundaryErrorCode = "INVALID_AGENT_DISPATCH_INPUT";

export class AgentAdapterBoundaryError extends Error {
  constructor(
    readonly code: AgentAdapterBoundaryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentAdapterBoundaryError";
  }
}

const dispatchKeys = [
  "command",
  "commandId",
  "expectedRevision",
  "actorId",
  "sourceId",
  "now",
] as const;

function invalidInput(message: string): never {
  throw new AgentAdapterBoundaryError("INVALID_AGENT_DISPATCH_INPUT", message);
}

function assertPlainCanonicalGraph(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalidInput(`${path} must contain finite numbers.`);
    }
    return;
  }
  if (typeof value !== "object") {
    invalidInput(`${path} must contain only canonical JSON values.`);
  }

  const objectValue = value as object;
  if (seen.has(objectValue)) invalidInput(`${path} must not contain cycles.`);
  seen.add(objectValue);
  try {
    const prototype = Object.getPrototypeOf(objectValue);
    if (
      prototype !== Object.prototype &&
      prototype !== Array.prototype
    ) {
      invalidInput(`${path} must contain only plain objects and dense arrays.`);
    }

    const descriptors = Object.getOwnPropertyDescriptors(objectValue);
    if (Object.getOwnPropertySymbols(objectValue).length > 0) {
      invalidInput(`${path} must not contain symbol keys.`);
    }

    if (Array.isArray(objectValue)) {
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== objectValue.length) {
        invalidInput(`${path} must contain only dense arrays.`);
      }
      for (let index = 0; index < objectValue.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable
        ) {
          invalidInput(`${path}[${index}] must be an enumerable data value.`);
        }
        assertPlainCanonicalGraph(
          descriptor.value,
          `${path}[${index}]`,
          seen,
        );
      }
      return;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        invalidInput(`${path}.${key} must be an enumerable data value.`);
      }
      assertPlainCanonicalGraph(descriptor.value, `${path}.${key}`, seen);
    }
  } catch (error) {
    if (error instanceof AgentAdapterBoundaryError) throw error;
    invalidInput(`${path} could not be inspected safely.`);
  } finally {
    seen.delete(objectValue);
  }
}

function hasExactDispatchKeys(
  value: unknown,
): value is Record<(typeof dispatchKeys)[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  const keys = Object.keys(value).sort();
  return (
    keys.length === dispatchKeys.length &&
    keys.every((key, index) => key === [...dispatchKeys].sort()[index])
  );
}

function snapshotAgentDispatchInput(value: unknown): AgentDispatchInput {
  assertPlainCanonicalGraph(value, "agentDispatch", new Set());
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    invalidInput("Agent dispatch input must be safely cloneable.");
  }
  if (!hasExactDispatchKeys(snapshot)) {
    invalidInput("Agent dispatch input must match the exact envelope schema.");
  }

  const context: CommandContext = {
    commandId: snapshot.commandId as string,
    expectedRevision: snapshot.expectedRevision as number,
    actorId: snapshot.actorId as string,
    actorKind: "agent",
    origin: "agent",
    source: {
      sourceId: snapshot.sourceId as string,
      verified: true,
      capabilities: [],
    },
    now: snapshot.now as ISODate,
  };
  if (
    !isStructurallyValidCommand(snapshot.command) ||
    !isStructurallyValidCommandContext(context)
  ) {
    invalidInput("Agent dispatch input must contain an exact V2 command and context.");
  }
  return {
    command: snapshot.command,
    commandId: context.commandId,
    expectedRevision: context.expectedRevision,
    actorId: context.actorId,
    sourceId: context.source.sourceId,
    now: context.now,
  };
}

function snapshotResolvedSource(
  value: unknown,
  input: AgentDispatchInput,
): CommandSource {
  if (value === undefined) {
    invalidInput("Agent source could not be resolved.");
  }
  assertPlainCanonicalGraph(value, "resolvedAgentSource", new Set());
  let snapshot: unknown;
  try {
    snapshot = structuredClone(value);
  } catch {
    invalidInput("Resolved Agent source must be safely cloneable.");
  }
  const context: CommandContext = {
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    actorId: input.actorId,
    actorKind: "agent",
    origin: "agent",
    source: snapshot as CommandSource,
    now: input.now,
  };
  if (!isStructurallyValidCommandContext(context)) {
    invalidInput("Resolved Agent source is not a valid trusted CommandSource.");
  }
  if (context.source.sourceId !== input.sourceId) {
    invalidInput("Resolved Agent source does not match the requested sourceId.");
  }
  if (!context.source.verified) {
    invalidInput("Resolved Agent source is not verified.");
  }
  return context.source;
}

/**
 * The only Agent write bridge. Callers cannot select another actor kind or
 * origin, and the service receives a stable validated snapshot of the input.
 */
export class AgentAdapter {
  constructor(
    private readonly service: AgentCommandServicePort,
    private readonly sourceResolver: AgentSourceResolver,
  ) {}

  async dispatch(inputValue: AgentDispatchInput): Promise<CommandResult> {
    const input = snapshotAgentDispatchInput(inputValue);
    let resolvedSource: CommandSource | undefined;
    try {
      resolvedSource = await this.sourceResolver.resolve({
        sourceId: input.sourceId,
        actorId: input.actorId,
      });
    } catch {
      invalidInput("Agent source verification failed.");
    }
    const source = snapshotResolvedSource(resolvedSource, input);
    return this.service.dispatch(input.command, {
      commandId: input.commandId,
      expectedRevision: input.expectedRevision,
      actorId: input.actorId,
      actorKind: "agent",
      origin: "agent",
      source,
      now: input.now,
    });
  }
}
