import type {
  CommandContext,
  V2Command,
} from "../../domain/commands";
import { selectCommandPolicyAvailability } from "../../domain/selectors";
import type { WorkspaceV2 } from "../../domain/types";
import {
  V2_UI_ACTOR_ID,
  V2_UI_SOURCE_ID,
} from "../state/V2WorkspaceProvider";

export function selectUiCommandPolicyAvailability(
  workspace: WorkspaceV2,
  command: V2Command,
  now: string,
) {
  const context: CommandContext = {
    commandId: `availability:${command.type}`,
    expectedRevision: workspace.revision,
    actorId: V2_UI_ACTOR_ID,
    actorKind: "human",
    origin: "ui",
    source: {
      sourceId: V2_UI_SOURCE_ID,
      verified: true,
      capabilities: ["human_decision"],
    },
    now,
  };
  const availability = selectCommandPolicyAvailability(
    workspace,
    command,
    context,
  );
  if (availability.available || availability.hold === undefined) {
    return availability;
  }
  const reasonByHold = {
    migration_review: "Complete migration review before continuing this Project.",
    rebet_required: "Place the required new Bet before continuing.",
    review_overdue: "Complete the overdue Review before continuing.",
    sync_conflict: "Resolve the affected sync conflict before continuing.",
  } as const;
  return { ...availability, reason: reasonByHold[availability.hold] };
}
