import Foundation

public typealias WorkspaceSyncFactory = @Sendable (
  _ configuration: CompanionConfiguration,
  _ deviceId: String
) -> WorkspaceSyncing

public actor CaptureService {
  private let credentials: CompanionCredentialStoring
  private let outbox: CaptureOutboxStoring
  private let deviceIdentifier: DeviceIdentifierStore
  private let syncFactory: WorkspaceSyncFactory
  private let maximumConflictRetries: Int

  public init(
    credentials: CompanionCredentialStoring,
    outbox: CaptureOutboxStoring,
    deviceIdentifier: DeviceIdentifierStore = DeviceIdentifierStore(),
    maximumConflictRetries: Int = 3,
    syncFactory: @escaping WorkspaceSyncFactory = { configuration, deviceId in
      FirebaseWorkspaceSyncClient(configuration: configuration, deviceId: deviceId)
    }
  ) {
    self.credentials = credentials
    self.outbox = outbox
    self.deviceIdentifier = deviceIdentifier
    self.maximumConflictRetries = max(1, maximumConflictRetries)
    self.syncFactory = syncFactory
  }

  public func capture(_ command: CaptureCommand) async -> CaptureOutcome {
    guard !command.title.isEmpty else {
      return CaptureOutcome(
        command: command,
        delivery: .failed(reason: CompanionError.invalidTitle.localizedDescription)
      )
    }
    do {
      try outbox.append(command)
    } catch {
      return CaptureOutcome(
        command: command,
        delivery: .failed(reason: error.localizedDescription)
      )
    }
    do {
      _ = try await flush()
      let remainsQueued = try outbox.commands().contains(where: { $0.id == command.id })
      return CaptureOutcome(
        command: command,
        delivery: remainsQueued
          ? .queued(reason: "The Action is stored locally and waiting to sync.")
          : .synced
      )
    } catch {
      return CaptureOutcome(
        command: command,
        delivery: .queued(reason: error.localizedDescription)
      )
    }
  }

  @discardableResult
  public func flush() async throws -> Int {
    let commands = try outbox.commands()
    guard !commands.isEmpty else {
      return 0
    }
    guard let configuration = try credentials.loadConfiguration(), configuration.isComplete else {
      throw CompanionError.missingConfiguration
    }
    guard let passphrase = try credentials.loadPassphrase(), !passphrase.isEmpty else {
      throw CompanionError.missingPassphrase
    }
    let client = syncFactory(configuration.normalized, deviceIdentifier.value())

    for attempt in 0..<maximumConflictRetries {
      do {
        let pulled = try await client.pull(passphrase: passphrase)
        let alreadyApplied = WorkspaceMutation.alreadyAppliedCommandIds(commands, in: pulled.json)
        let pending = commands.filter { !alreadyApplied.contains($0.id) }
        if pending.isEmpty {
          try outbox.remove(ids: alreadyApplied)
          return alreadyApplied.count
        }

        var workspace = pulled.json
        let applied = try WorkspaceMutation.add(commands: pending, to: &workspace)
        _ = try await client.push(
          workspace: workspace,
          previousManifest: pulled.manifest,
          passphrase: passphrase
        )
        let completed = alreadyApplied.union(applied)
        try outbox.remove(ids: completed)
        return completed.count
      } catch CompanionError.syncConflict where attempt + 1 < maximumConflictRetries {
        continue
      }
    }
    throw CompanionError.syncConflict
  }

  public func pendingCount() throws -> Int {
    try outbox.commands().count
  }

  public func testConnection() async throws -> String {
    guard let configuration = try credentials.loadConfiguration(), configuration.isComplete else {
      throw CompanionError.missingConfiguration
    }
    guard let passphrase = try credentials.loadPassphrase(), !passphrase.isEmpty else {
      throw CompanionError.missingPassphrase
    }
    let client = syncFactory(configuration.normalized, deviceIdentifier.value())
    let pulled = try await client.pull(passphrase: passphrase)
    return pulled.manifest.latestRevision
  }
}
