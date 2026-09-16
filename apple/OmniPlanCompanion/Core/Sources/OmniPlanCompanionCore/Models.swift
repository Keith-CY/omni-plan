import Foundation

public struct CompanionConfiguration: Codable, Equatable, Sendable {
  public var projectId: String
  public var apiKey: String
  public var databaseId: String
  public var collectionPath: String
  public var workspaceId: String

  public init(
    projectId: String,
    apiKey: String,
    databaseId: String = "(default)",
    collectionPath: String = "omniPlanSync",
    workspaceId: String = "personal"
  ) {
    self.projectId = projectId
    self.apiKey = apiKey
    self.databaseId = databaseId
    self.collectionPath = collectionPath
    self.workspaceId = workspaceId
  }

  public var normalized: CompanionConfiguration {
    CompanionConfiguration(
      projectId: projectId.trimmingCharacters(in: .whitespacesAndNewlines),
      apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines),
      databaseId: nonempty(databaseId, fallback: "(default)"),
      collectionPath: nonempty(collectionPath, fallback: "omniPlanSync"),
      workspaceId: nonempty(workspaceId, fallback: "personal")
    )
  }

  public var isComplete: Bool {
    let value = normalized
    return !value.projectId.isEmpty && !value.apiKey.isEmpty && !value.workspaceId.isEmpty
  }

  private func nonempty(_ value: String, fallback: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? fallback : trimmed
  }
}

public struct CaptureCommand: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let title: String
  public let note: String?
  public let scheduledAt: Date?
  public let createdAt: Date

  public init(
    id: String = UUID().uuidString.lowercased(),
    title: String,
    note: String? = nil,
    scheduledAt: Date? = nil,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.title = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.note = trimmedNote.flatMap { $0.isEmpty ? nil : $0 }
    self.scheduledAt = scheduledAt.map(Self.millisecondDate)
    self.createdAt = Self.millisecondDate(createdAt)
  }

  public var todoId: String {
    "todo-shortcut-\(id.lowercased())"
  }

  private static func millisecondDate(_ date: Date) -> Date {
    Date(timeIntervalSince1970: (date.timeIntervalSince1970 * 1_000).rounded(.down) / 1_000)
  }
}

public enum CaptureDelivery: Equatable, Sendable {
  case synced
  case queued(reason: String)
  case failed(reason: String)
}

public struct CaptureOutcome: Equatable, Sendable {
  public let command: CaptureCommand
  public let delivery: CaptureDelivery

  public init(command: CaptureCommand, delivery: CaptureDelivery) {
    self.command = command
    self.delivery = delivery
  }
}

public enum CompanionError: LocalizedError, Equatable, Sendable {
  case invalidTitle
  case missingConfiguration
  case missingPassphrase
  case remoteWorkspaceMissing
  case futureWorkspaceSchema(Int)
  case invalidRemoteData(String)
  case encryptionFailed
  case decryptionFailed
  case checksumMismatch
  case syncConflict
  case transport(String)

  public var errorDescription: String? {
    switch self {
    case .invalidTitle:
      return "Give the Action a title."
    case .missingConfiguration:
      return "Finish Firebase setup in OmniPlan Companion."
    case .missingPassphrase:
      return "Save the workspace passphrase in OmniPlan Companion."
    case .remoteWorkspaceMissing:
      return "The encrypted OmniPlan workspace does not exist in Firebase yet."
    case let .futureWorkspaceSchema(version):
      return "The workspace uses unsupported schema \(version). Update OmniPlan Companion."
    case let .invalidRemoteData(message):
      return "Firebase returned invalid OmniPlan data: \(message)"
    case .encryptionFailed:
      return "The Action could not be encrypted."
    case .decryptionFailed:
      return "The workspace could not be decrypted. Check the passphrase."
    case .checksumMismatch:
      return "The decrypted workspace checksum did not match."
    case .syncConflict:
      return "The workspace changed during capture. It will be retried."
    case let .transport(message):
      return message
    }
  }
}

public struct FirebaseAnonymousSession: Codable, Equatable, Sendable {
  public let idToken: String
  public let refreshToken: String?
  public let localId: String
  public let expiresIn: Int?
}

public struct EncryptedSyncPayload: Codable, Equatable, Sendable {
  public let algorithm: String
  public let kdf: String
  public let iterations: Int
  public let salt: String
  public let iv: String
  public let ciphertext: String
}

public struct FirebaseWorkspaceSnapshotEnvelope: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let workspaceSchemaVersion: Int?
  public let workspaceId: String
  public let deviceId: String
  public let revision: String
  public let previousRevision: String?
  public let createdAt: String
  public let plaintextChecksum: String
  public let payload: EncryptedSyncPayload
}

public struct FirebaseManifestHead: Codable, Equatable, Sendable {
  public let revision: String
  public let updatedAt: String
}

public struct FirebaseE2EEManifest: Codable, Equatable, Sendable {
  public let schemaVersion: Int
  public let workspaceSchemaVersion: Int?
  public let minimumClientWorkspaceSchemaVersion: Int?
  public let provider: String
  public let workspaceId: String
  public let latestRevision: String
  public let updatedAt: String
  public let updatedByDeviceId: String
  public let snapshotDocumentPath: String
  public let heads: [String: FirebaseManifestHead]
  public var firestoreUpdateTime: String?

  enum CodingKeys: String, CodingKey {
    case schemaVersion
    case workspaceSchemaVersion
    case minimumClientWorkspaceSchemaVersion
    case provider
    case workspaceId
    case latestRevision
    case updatedAt
    case updatedByDeviceId
    case snapshotDocumentPath
    case heads
  }
}

public struct PulledWorkspace: @unchecked Sendable {
  public let manifest: FirebaseE2EEManifest
  public let envelope: FirebaseWorkspaceSnapshotEnvelope
  public let json: [String: Any]
}

public struct PushedWorkspace: Equatable, Sendable {
  public let manifest: FirebaseE2EEManifest
  public let envelope: FirebaseWorkspaceSnapshotEnvelope
  public let commitTime: String?
}
