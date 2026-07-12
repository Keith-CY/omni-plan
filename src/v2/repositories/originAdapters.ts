import type {
  CommandContext,
  CommandResult,
  V2Command,
} from "../domain/commands";
import type { CommandOrigin } from "../domain/types";
import type { AuthorizedSyncReplay } from "./syncProtocol";

export interface OriginCommandInput
  extends Omit<CommandContext, "origin"> {
  command: V2Command;
}

export interface OriginCommandServicePort {
  dispatch(
    command: V2Command,
    context: CommandContext,
  ): Promise<CommandResult>;
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

export class ImportOriginAdapter extends LocalOriginAdapter {
  constructor(service: OriginCommandServicePort) {
    super(service, "import");
  }
}

export class SyncOriginAdapter {
  constructor(private readonly service: OriginCommandServicePort) {}

  dispatch(replay: AuthorizedSyncReplay): Promise<CommandResult> {
    return this.service.dispatchVerifiedReplay(replay);
  }
}
