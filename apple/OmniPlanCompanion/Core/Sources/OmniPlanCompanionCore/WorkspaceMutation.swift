import Foundation

public enum WorkspaceMutation {
  public static let supportedSchemaVersion = 3

  public static func validate(_ workspace: [String: Any]) throws {
    let schemaVersion = (workspace["schemaVersion"] as? NSNumber)?.intValue ?? 1
    if schemaVersion > supportedSchemaVersion {
      throw CompanionError.futureWorkspaceSchema(schemaVersion)
    }
    guard workspace["todos"] is [Any] else {
      throw CompanionError.invalidRemoteData("Workspace has no Todo collection.")
    }
  }

  public static func alreadyAppliedCommandIds(
    _ commands: [CaptureCommand],
    in workspace: [String: Any]
  ) -> Set<String> {
    let ids = Set(
      ((workspace["todos"] as? [Any]) ?? [])
        .compactMap { ($0 as? [String: Any])?["id"] as? String }
    )
    return Set(commands.filter { ids.contains($0.todoId) }.map(\.id))
  }

  @discardableResult
  public static func add(
    commands: [CaptureCommand],
    to workspace: inout [String: Any]
  ) throws -> Set<String> {
    try validate(workspace)
    var todos = workspace["todos"] as? [Any] ?? []
    let existingIds = Set(todos.compactMap { ($0 as? [String: Any])?["id"] as? String })
    var applied = Set<String>()

    for command in commands {
      guard !command.title.isEmpty else {
        continue
      }
      if existingIds.contains(command.todoId) ||
          todos.contains(where: { ($0 as? [String: Any])?["id"] as? String == command.todoId }) {
        applied.insert(command.id)
        continue
      }

      let createdAt = OmniPlanDateCoding.string(from: command.createdAt)
      var todo: [String: Any] = [
        "id": command.todoId,
        "title": command.title,
        "tags": [String](),
        "flagged": false,
        "checklist": [Any](),
        "status": "open",
        "capturedAt": createdAt,
        "updatedAt": createdAt,
        "inbox": command.scheduledAt == nil
      ]
      if let note = command.note {
        todo["note"] = note
      }
      if let scheduledAt = command.scheduledAt {
        todo["scheduledAt"] = OmniPlanDateCoding.string(from: scheduledAt)
      }
      todos.insert(todo, at: 0)
      applied.insert(command.id)
    }

    workspace["schemaVersion"] = supportedSchemaVersion
    workspace["todos"] = todos
    return applied
  }
}
