import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../domain/commands";
import type { CommandOrigin } from "../domain/types";
import type { AuthorizedSyncReplay } from "./syncProtocol";

export const PORTABLE_IMPORT_COMMAND_TYPES = [
  "capture_inbox",
  "update_project_metadata",
  "archive_project",
] as const;

export type PortableImportCommand = Extract<
  V2Command,
  { type: (typeof PORTABLE_IMPORT_COMMAND_TYPES)[number] }
>;

export function isPortableImportCommandType(
  value: unknown,
): value is PortableImportCommand["type"] {
  return (
    typeof value === "string" &&
    (PORTABLE_IMPORT_COMMAND_TYPES as readonly string[]).includes(value)
  );
}

export interface OriginCommandInput extends Omit<CommandContext, "origin"> {
  command: V2Command;
}

export interface OriginCommandServicePort {
  dispatch(command: V2Command, context: CommandContext): Promise<CommandResult>;
  dispatchVerifiedReplay(replay: AuthorizedSyncReplay): Promise<CommandResult>;
}

abstract class LocalOriginAdapter {
  constructor(
    private readonly service: OriginCommandServicePort,
    private readonly origin: Exclude<CommandOrigin, "sync" | "migration">,
  ) {}

  dispatch(inputValue: OriginCommandInput): Promise<CommandResult> {
    const input = structuredClone(inputValue);
    const { command, ...context } = input;
    return this.service.dispatch(command, {
      ...context,
      origin: this.origin,
    });
  }
}

export class UiOriginAdapter extends LocalOriginAdapter {
  constructor(service: OriginCommandServicePort) {
    super(service, "ui");
  }
}

export class AgentOriginAdapter extends LocalOriginAdapter {
  constructor(service: OriginCommandServicePort) {
    super(service, "agent");
  }
}

export class ImportOriginAdapter {
  constructor(private readonly service: OriginCommandServicePort) {}

  async dispatch(
    inputValue: OriginCommandInput & { sourceId?: string },
  ): Promise<CommandResult> {
    const input = structuredClone(inputValue);
    const { command, source, sourceId, ...context } = input;
    if (!isPortableImportCommandType(command.type)) {
      throw new Error(
        `Command ${command.type} is outside the portable import allowlist.`,
      );
    }
    const canonicalSourceId = sourceId ?? source.sourceId;
    return await this.service.dispatch(command, {
      ...context,
      origin: "import",
      source: {
        sourceId: canonicalSourceId,
        verified: true,
        capabilities: ["import_portable"],
      },
    });
  }
}

export class SyncOriginAdapter {
  constructor(private readonly service: OriginCommandServicePort) {}

  dispatch(replay: AuthorizedSyncReplay): Promise<CommandResult> {
    return this.service.dispatchVerifiedReplay(replay);
  }
}
