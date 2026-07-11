import { describe, expect, it } from "vitest";

import {
  REJECTION_DETAILS,
  type RejectionCode,
} from "./errors";
import type {
  ActorKind,
  CommandOrigin,
  CommandSource,
  ProjectHold,
  ProjectHoldState,
  SourceCapability,
} from "./types";
import {
  authorizeCommand,
  findBlockingHold,
  type AuthorizationContext,
} from "./policy";

const allCapabilities = [
  "human_decision",
  "capture_inbox",
  "record_actual",
  "attach_evidence",
  "submit_proposal",
  "import_portable",
  "replay_receipt",
  "system_time",
  "open_conflict",
] as const satisfies readonly SourceCapability[];

function buildSource(
  capabilities: readonly SourceCapability[] = allCapabilities,
  verified = true,
): CommandSource {
  return {
    sourceId: "source-1",
    verified,
    capabilities: [...capabilities],
  };
}

function buildContext(
  actorKind: ActorKind,
  overrides: Partial<AuthorizationContext> = {},
): AuthorizationContext {
  const defaultOrigin: Record<ActorKind, CommandOrigin> = {
    human: "ui",
    agent: "agent",
    system: "agent",
  };

  return {
    actorKind,
    origin: defaultOrigin[actorKind],
    source: buildSource(),
    workspaceRevision: 41,
    projectHolds: [],
    deterministicTriggerKey: "trigger-1",
    ...overrides,
  };
}

function buildHold(
  type: ProjectHold,
  affectedRecordIds: string[] = ["project-1"],
): ProjectHoldState {
  return {
    type,
    sourceId: `${type}-source`,
    affectedRecordIds,
    createdAt: "2026-07-10T09:00:00.000Z",
  };
}

describe("authorizeCommand source authorization precedence", () => {
  it("rejects every unverified source before considering actor authority", () => {
    const rejection = authorizeCommand(
      "place_bet",
      buildContext("agent", {
        source: buildSource(["submit_proposal"], false),
      }),
    );

    expect(rejection).toEqual({
      code: "SOURCE_NOT_AUTHORIZED",
      reason: "Command source must be verified.",
      gate: "verified_source",
      permittedNextCommand: "retry_with_verified_source",
      actorKind: "agent",
      origin: "agent",
      workspaceRevision: 41,
    });
  });

  it.each([
    ["capture_inbox", "capture_inbox"],
    ["record_actual", "record_actual"],
    ["attach_evidence", "attach_evidence"],
    ["submit_command_proposal", "submit_proposal"],
    ["update_direction", "submit_proposal"],
    ["place_bet", "submit_proposal"],
  ] as const)(
    "rejects Agent %s when the source lacks %s before actor checks",
    (commandType, capability) => {
      const rejection = authorizeCommand(
        commandType,
        buildContext("agent", { source: buildSource([]) }),
      );

      expect(rejection).toMatchObject({
        code: "SOURCE_NOT_AUTHORIZED",
        reason: `Source lacks required capability: ${capability}.`,
        gate: `source_capability:${capability}`,
        permittedNextCommand: "retry_with_authorized_source",
      });
      expect(rejection?.workspaceRevision).toBe(41);
    },
  );

  it("requires a replay receipt for sync before the replayed actor is checked", () => {
    const rejection = authorizeCommand(
      "place_bet",
      buildContext("agent", {
        origin: "sync",
        source: buildSource(["submit_proposal"]),
      }),
    );

    expect(rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      reason: "Sync commands require a verified replay receipt.",
      gate: "source_capability:replay_receipt",
      permittedNextCommand: "replay_with_receipt",
    });
  });

  it("requires portable-import authority before imported actor checks", () => {
    const rejection = authorizeCommand(
      "place_bet",
      buildContext("human", {
        origin: "import",
        source: buildSource(["human_decision"]),
      }),
    );

    expect(rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      reason: "Import commands require a verified portable import source.",
      gate: "source_capability:import_portable",
      permittedNextCommand: "import_portable_workspace",
    });
  });

  it("does not require a UI decision capability from a portable import adapter", () => {
    expect(
      authorizeCommand(
        "place_bet",
        buildContext("human", {
          origin: "import",
          source: buildSource(["import_portable"]),
        }),
      ),
    ).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "Only a human can place or replace a Bet.",
      permittedNextCommand: "place_bet",
    });
  });

  it("requires a human-decision capability for a human non-sync session", () => {
    const rejection = authorizeCommand(
      "record_actual",
      buildContext("human", { source: buildSource([]) }),
    );

    expect(rejection).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      reason: "Human session commands require a verified decision source.",
      gate: "source_capability:human_decision",
      permittedNextCommand: "retry_from_human_session",
    });
  });

  it.each([
    ["record_bet_boundary", "system_time"],
    ["mark_review_overdue", "system_time"],
    ["create_review", "system_time_or_open_conflict"],
    ["open_sync_conflict", "open_conflict"],
  ] as const)(
    "checks the narrow source for %s before rejecting a non-system actor",
    (commandType, gateCapability) => {
      const rejection = authorizeCommand(
        commandType,
        buildContext("human", {
          source: buildSource(["human_decision"]),
        }),
      );

      expect(rejection).toMatchObject({
        code: "SOURCE_NOT_AUTHORIZED",
        gate: `source_capability:${gateCapability}`,
      });
    },
  );

  it("rejects normal mutation commands from migration origin with stable guidance", () => {
    expect(
      authorizeCommand(
        "capture_inbox",
        buildContext("human", { origin: "migration" }),
      ),
    ).toEqual({
      code: "SOURCE_NOT_AUTHORIZED",
      reason:
        "Migration-origin commands must use the validated migration pipeline.",
      gate: "validated_migration",
      permittedNextCommand: "run_validated_migration",
      actorKind: "human",
      origin: "migration",
      workspaceRevision: 41,
    });
  });

  it.each([
    ["record_bet_boundary", ["system_time"]],
    ["mark_review_overdue", ["system_time"]],
    ["create_review", ["system_time"]],
    ["open_sync_conflict", ["open_conflict"]],
  ] as const)(
    "requires a nonblank deterministic trigger key for %s after actor checks",
    (commandType, capabilities) => {
      const rejection = authorizeCommand(
        commandType,
        buildContext("system", {
          source: buildSource(capabilities),
          deterministicTriggerKey: "   ",
        }),
      );

      expect(rejection).toMatchObject({
        code: "SOURCE_NOT_AUTHORIZED",
        reason: "System commands require a deterministic trigger key.",
        gate: "deterministic_trigger_key",
        permittedNextCommand: commandType,
      });
    },
  );

  it("returns actor failure before a missing system trigger key", () => {
    expect(
      authorizeCommand(
        "record_bet_boundary",
        buildContext("human", { deterministicTriggerKey: undefined }),
      ),
    ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });
});

describe("authorizeCommand authority matrix", () => {
  const humanOnly = [
    "confirm_action_triage",
    "confirm_project_triage",
    "promote_action_to_project",
    "place_bet",
    "commit_today",
    "accept_replan",
    "approve_evidence_exception",
    "complete_review",
    "resolve_sync_conflict",
    "accept_command_proposal",
    "dismiss_command_proposal",
    "close_project",
    "abandon_project",
  ] as const;
  const agentAutomatic = [
    "capture_inbox",
    "record_actual",
    "attach_evidence",
  ] as const;
  const projectDrafts = [
    "update_direction",
    "create_work_item",
    "update_work_item",
    "propose_replan",
    "upsert_dependency",
    "remove_dependency",
  ] as const;
  const systemOnly = [
    "record_bet_boundary",
    "mark_review_overdue",
    "create_review",
    "open_sync_conflict",
  ] as const;
  const ordinaryHumanCommands = [
    "configure_capacity",
    "update_project_metadata",
    "update_action",
    "complete_action",
    "resolve_evidence_exception",
    "request_validation",
    "satisfy_validation",
    "archive_project",
  ] as const;

  it.each(humanOnly)("allows a human to apply %s", (commandType) => {
    expect(authorizeCommand(commandType, buildContext("human"))).toBeUndefined();
  });

  it.each(humanOnly)(
    "requires human confirmation when an Agent requests %s",
    (commandType) => {
      expect(
        authorizeCommand(commandType, buildContext("agent")),
      ).toMatchObject({
        code: "HUMAN_CONFIRMATION_REQUIRED",
        permittedNextCommand: commandType,
      });
    },
  );

  it.each(humanOnly)("rejects system actor %s", (commandType) => {
    expect(authorizeCommand(commandType, buildContext("system"))).toMatchObject({
      code: "ACTOR_NOT_AUTHORIZED",
    });
  });

  it.each(agentAutomatic)(
    "allows human and capability-authorized Agent actors to apply %s",
    (commandType) => {
      expect(authorizeCommand(commandType, buildContext("human"))).toBeUndefined();
      expect(authorizeCommand(commandType, buildContext("agent"))).toBeUndefined();
      expect(
        authorizeCommand(commandType, buildContext("system")),
      ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    },
  );

  it.each(projectDrafts)(
    "allows human %s but forces Agents through a proposal",
    (commandType) => {
      expect(authorizeCommand(commandType, buildContext("human"))).toBeUndefined();
      expect(authorizeCommand(commandType, buildContext("agent"))).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
        reason:
          "Agents must submit a command proposal instead of mutating project plans directly.",
        permittedNextCommand: "submit_command_proposal",
      });
      expect(
        authorizeCommand(commandType, buildContext("system")),
      ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    },
  );

  it("allows only an Agent with proposal capability to submit a command proposal", () => {
    expect(
      authorizeCommand("submit_command_proposal", buildContext("agent")),
    ).toBeUndefined();
    expect(
      authorizeCommand("submit_command_proposal", buildContext("human")),
    ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    expect(
      authorizeCommand("submit_command_proposal", buildContext("system")),
    ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });

  it.each(systemOnly)(
    "allows only a system actor with a narrow source to apply %s",
    (commandType) => {
      expect(authorizeCommand(commandType, buildContext("system"))).toBeUndefined();
      expect(authorizeCommand(commandType, buildContext("human"))).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
      });
      expect(authorizeCommand(commandType, buildContext("agent"))).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
      });
    },
  );

  it("accepts either narrow create-review source", () => {
    expect(
      authorizeCommand(
        "create_review",
        buildContext("system", {
          source: buildSource(["system_time"]),
        }),
      ),
    ).toBeUndefined();
    expect(
      authorizeCommand(
        "create_review",
        buildContext("system", {
          source: buildSource(["open_conflict"]),
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps actor kind independent from sync origin", () => {
    expect(
      authorizeCommand(
        "record_actual",
        buildContext("agent", {
          origin: "sync",
          source: buildSource(["replay_receipt", "record_actual"]),
        }),
      ),
    ).toBeUndefined();
    expect(
      authorizeCommand(
        "record_actual",
        buildContext("system", {
          origin: "sync",
          source: buildSource(["replay_receipt"]),
        }),
      ),
    ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
  });

  it("replays an original human decision but never imports one as confirmed", () => {
    expect(
      authorizeCommand(
        "place_bet",
        buildContext("human", {
          origin: "sync",
          source: buildSource(["replay_receipt"]),
        }),
      ),
    ).toBeUndefined();

    expect(
      authorizeCommand(
        "place_bet",
        buildContext("human", {
          origin: "import",
          source: buildSource(["import_portable", "human_decision"]),
        }),
      ),
    ).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      permittedNextCommand: "place_bet",
    });
  });

  it("replays a human Action promotion but never imports one as confirmed", () => {
    expect(
      authorizeCommand(
        "promote_action_to_project",
        buildContext("human", {
          origin: "sync",
          source: buildSource(["replay_receipt"]),
        }),
      ),
    ).toBeUndefined();
    expect(
      authorizeCommand(
        "promote_action_to_project",
        buildContext("human", {
          origin: "import",
          source: buildSource(["import_portable", "human_decision"]),
        }),
      ),
    ).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      permittedNextCommand: "promote_action_to_project",
    });
  });

  it("returns the exact stable human-only Bet rejection", () => {
    const rejection = authorizeCommand(
      "place_bet",
      buildContext("agent", {
        source: buildSource(["submit_proposal"]),
      }),
    );

    expect(rejection).toMatchObject({
      code: "HUMAN_CONFIRMATION_REQUIRED",
      reason: "Only a human can place or replace a Bet.",
      permittedNextCommand: "place_bet",
      actorKind: "agent",
      origin: "agent",
    });
    expect(rejection?.workspaceRevision).toBe(41);
  });

  it("does not let a system actor use a non-system command through sync or import", () => {
    for (const origin of ["sync", "import"] as const) {
      expect(
        authorizeCommand(
          "record_actual",
          buildContext("system", {
            origin,
            source: buildSource(
              origin === "sync" ? ["replay_receipt"] : ["import_portable"],
            ),
          }),
        ),
      ).toMatchObject({ code: "ACTOR_NOT_AUTHORIZED" });
    }
  });

  it.each(ordinaryHumanCommands)(
    "classifies ordinary Task-5 command %s as human-applied",
    (commandType) => {
      expect(authorizeCommand(commandType, buildContext("human"))).toBeUndefined();
      expect(authorizeCommand(commandType, buildContext("agent"))).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
        permittedNextCommand: "submit_command_proposal",
      });
      expect(authorizeCommand(commandType, buildContext("system"))).toMatchObject({
        code: "ACTOR_NOT_AUTHORIZED",
      });
    },
  );
});

describe("findBlockingHold", () => {
  it.each(["update_direction", "place_bet"])(
    "allows %s during migration review",
    (commandType) => {
      expect(
        findBlockingHold(commandType, [buildHold("migration_review")]),
      ).toBeUndefined();
    },
  );

  it.each([
    "create_work_item",
    "record_actual",
    "close_project",
    "update_project_metadata",
    "resolve_evidence_exception",
    "request_validation",
    "satisfy_validation",
    "archive_project",
  ])(
    "blocks project mutation %s during migration review",
    (commandType) => {
      expect(
        findBlockingHold(commandType, [buildHold("migration_review")])?.type,
      ).toBe("migration_review");
    },
  );

  it.each(["configure_capacity", "capture_inbox"])(
    "allows global command %s when callers supply no project holds",
    (commandType) => {
      expect(
        authorizeCommand(
          commandType,
          buildContext("human", { projectHolds: [] }),
        ),
      ).toBeUndefined();
    },
  );

  it.each(["update_direction", "place_bet"])(
    "allows %s while a replacement Bet is required",
    (commandType) => {
      expect(
        findBlockingHold(commandType, [buildHold("rebet_required")]),
      ).toBeUndefined();
    },
  );

  it.each([
    "create_work_item",
    "update_work_item",
    "upsert_dependency",
    "remove_dependency",
    "propose_replan",
    "commit_today",
    "accept_replan",
    "record_actual",
    "attach_evidence",
  ])("blocks plan or execution write %s while re-betting", (commandType) => {
    expect(
      findBlockingHold(commandType, [buildHold("rebet_required")])?.type,
    ).toBe("rebet_required");
  });

  it.each(["record_actual", "attach_evidence"])(
    "allows existing committed work to %s while review is overdue",
    (commandType) => {
      expect(
        findBlockingHold(
          commandType,
          [buildHold("review_overdue")],
          undefined,
          true,
        ),
      ).toBeUndefined();
    },
  );

  it.each(["record_actual", "attach_evidence"])(
    "blocks %s while review is overdue unless the target was committed",
    (commandType) => {
      expect(
        findBlockingHold(commandType, [buildHold("review_overdue")])?.type,
      ).toBe("review_overdue");
      expect(
        findBlockingHold(
          commandType,
          [buildHold("review_overdue")],
          undefined,
          false,
        )?.type,
      ).toBe("review_overdue");
    },
  );

  it.each([
    "place_bet",
    "create_work_item",
    "update_work_item",
    "upsert_dependency",
    "remove_dependency",
    "commit_today",
    "accept_replan",
  ])("blocks new or expanded work %s while review is overdue", (commandType) => {
    expect(
      findBlockingHold(commandType, [buildHold("review_overdue")])?.type,
    ).toBe("review_overdue");
  });

  it("allows conflict resolution and only blocks affected records", () => {
    const hold = buildHold("sync_conflict", ["record-1", "record-2"]);

    expect(findBlockingHold("resolve_sync_conflict", [hold])).toBeUndefined();
    expect(findBlockingHold("update_work_item", [hold], ["record-2"])?.type).toBe(
      "sync_conflict",
    );
    expect(findBlockingHold("update_work_item", [hold])).toBe(hold);
    expect(
      findBlockingHold("update_work_item", [hold], ["record-unrelated"]),
    ).toBeUndefined();
  });

  it("uses fixed hold priority independent of array order", () => {
    const holds = [
      buildHold("sync_conflict"),
      buildHold("review_overdue"),
      buildHold("rebet_required"),
      buildHold("migration_review"),
    ];

    expect(findBlockingHold("commit_today", holds)?.type).toBe(
      "migration_review",
    );
    expect(findBlockingHold("commit_today", [...holds].reverse())?.type).toBe(
      "migration_review",
    );
  });

  it("orders canonically equivalent Unicode hold sources by raw code units", () => {
    const composed = buildHold("migration_review");
    composed.sourceId = "é";
    const decomposed = buildHold("migration_review");
    decomposed.sourceId = "e\u0301";

    expect(
      findBlockingHold("close_project", [composed, decomposed])?.sourceId,
    ).toBe("e\u0301");
    expect(
      findBlockingHold("close_project", [decomposed, composed])?.sourceId,
    ).toBe("e\u0301");
  });
});

describe("authorizeCommand hold ordering", () => {
  it("returns a stable typed hold rejection after source and actor authorization", () => {
    const rejection = authorizeCommand(
      "commit_today",
      buildContext("human", {
        projectHolds: [buildHold("review_overdue")],
        affectedRecordIds: ["project-1"],
      }),
    );

    expect(rejection).toEqual({
      code: "HOLD_BLOCKS_COMMAND",
      reason: "Project hold review_overdue blocks command commit_today.",
      gate: "project_hold:review_overdue",
      hold: "review_overdue",
      permittedNextCommand: "complete_review",
      actorKind: "human",
      origin: "ui",
      workspaceRevision: 41,
    });
  });

  it("returns source failure before a blocking hold", () => {
    expect(
      authorizeCommand(
        "record_actual",
        buildContext("agent", {
          source: buildSource([], false),
          projectHolds: [buildHold("rebet_required")],
        }),
      ),
    ).toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
  });

  it("returns actor failure before a blocking hold", () => {
    expect(
      authorizeCommand(
        "place_bet",
        buildContext("agent", {
          source: buildSource(["submit_proposal"]),
          projectHolds: [buildHold("review_overdue")],
        }),
      ),
    ).toMatchObject({ code: "HUMAN_CONFIRMATION_REQUIRED" });
  });

  it("fails closed when callers omit required hold facts", () => {
    const context = buildContext("human") as Partial<AuthorizationContext>;
    delete context.projectHolds;

    expect(
      authorizeCommand("record_actual", context as AuthorizationContext),
    ).toMatchObject({
      code: "SOURCE_NOT_AUTHORIZED",
      reason: "Authorization context must include project hold facts.",
      gate: "policy_context:project_holds",
      permittedNextCommand: "load_project_holds",
    });
  });

  it.each([true, false, undefined] as const)(
    "applies the committed-target review hold fact %s after source and actor checks",
    (targetWasCommitted) => {
      const result = authorizeCommand(
        "record_actual",
        buildContext("human", {
          projectHolds: [buildHold("review_overdue")],
          targetWasCommitted,
        }),
      );

      if (targetWasCommitted) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({
          code: "HOLD_BLOCKS_COMMAND",
          hold: "review_overdue",
        });
      }
    },
  );
});

describe("typed rejection stability", () => {
  const expectedNextCommands = {
    REVISION_CONFLICT: "retry_at_current_revision",
    DUPLICATE_COMMAND: "read_existing_command_receipt",
    INVALID_COMMAND: "repair_command_payload",
    SOURCE_NOT_AUTHORIZED: "retry_with_authorized_source",
    ACTOR_NOT_AUTHORIZED: "retry_with_authorized_actor",
    HUMAN_CONFIRMATION_REQUIRED: "request_human_confirmation",
    ILLEGAL_LIFECYCLE_TRANSITION: "use_legal_lifecycle_command",
    HOLD_BLOCKS_COMMAND: "resolve_project_hold",
    BRIEF_INCOMPLETE: "update_direction",
    BET_REQUIRED: "place_bet",
    BET_EXPIRED: "record_bet_boundary",
    SCOPE_OUTSIDE_BET: "update_work_item",
    ACTION_INELIGIBLE: "confirm_project_triage",
    ACTION_PROMOTION_REQUIRED: "confirm_project_triage",
    CAPACITY_EXCEEDED: "commit_today",
    EVIDENCE_REQUIRED: "attach_evidence",
    EXCEPTION_EXPIRED: "approve_evidence_exception",
    REVIEW_OVERDUE: "complete_review",
    SYNC_CONFLICT: "resolve_sync_conflict",
    PROJECT_CLOSED: "create_follow_up_project",
    ENTITY_NOT_FOUND: "repair_workspace_reference",
    ENTITY_ALREADY_EXISTS: "use_unique_entity_id",
    COMMAND_NOT_IMPLEMENTED: "use_supported_command",
  } as const satisfies Record<RejectionCode, string>;

  it("defines a deliberate nonempty fallback for every rejection code", () => {
    expect(Object.keys(REJECTION_DETAILS).sort()).toEqual(
      Object.keys(expectedNextCommands).sort(),
    );
    for (const code of Object.keys(expectedNextCommands) as RejectionCode[]) {
      expect(REJECTION_DETAILS[code]).toEqual({
        reason: expect.stringMatching(/\S/),
        permittedNextCommand: expectedNextCommands[code],
      });
    }
  });

  it("round-trips optional hold details and caller identity through JSON", () => {
    const rejection = authorizeCommand(
      "commit_today",
      buildContext("human", {
        projectHolds: [buildHold("review_overdue")],
      }),
    );

    expect(rejection).toBeDefined();
    expect(JSON.parse(JSON.stringify(rejection))).toEqual(rejection);
    expect(rejection).toMatchObject({
      hold: "review_overdue",
      actorKind: "human",
      origin: "ui",
      workspaceRevision: 41,
    });
  });
});
