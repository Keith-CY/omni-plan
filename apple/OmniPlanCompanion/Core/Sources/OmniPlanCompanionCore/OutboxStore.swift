import Foundation

public protocol CaptureOutboxStoring: Sendable {
  func commands() throws -> [CaptureCommand]
  func append(_ command: CaptureCommand) throws
  func remove(ids: Set<String>) throws
}

public final class EncryptedCaptureOutbox: CaptureOutboxStoring, @unchecked Sendable {
  private struct QueueEnvelope: Codable {
    let version: Int
    var commands: [CaptureCommand]
  }

  private let credentials: CompanionCredentialStoring
  private let defaults: UserDefaults
  private let storageKey: String
  private let lock = NSLock()

  public init(
    credentials: CompanionCredentialStoring,
    defaults: UserDefaults = .standard,
    storageKey: String = "omniplan.companion.encrypted-outbox.v1"
  ) {
    self.credentials = credentials
    self.defaults = defaults
    self.storageKey = storageKey
  }

  public func commands() throws -> [CaptureCommand] {
    lock.lock()
    defer { lock.unlock() }
    return try loadUnlocked().commands
  }

  public func append(_ command: CaptureCommand) throws {
    lock.lock()
    defer { lock.unlock() }
    var queue = try loadUnlocked()
    guard !queue.commands.contains(where: { $0.id == command.id }) else {
      return
    }
    queue.commands.append(command)
    try saveUnlocked(queue)
  }

  public func remove(ids: Set<String>) throws {
    guard !ids.isEmpty else {
      return
    }
    lock.lock()
    defer { lock.unlock() }
    var queue = try loadUnlocked()
    queue.commands.removeAll { ids.contains($0.id) }
    try saveUnlocked(queue)
  }

  private func loadUnlocked() throws -> QueueEnvelope {
    guard let encrypted = defaults.data(forKey: storageKey) else {
      return QueueEnvelope(version: 1, commands: [])
    }
    let plaintext = try SyncCrypto.openLocalData(
      encrypted,
      keyData: credentials.loadOrCreateOutboxKey()
    )
    let queue = try OmniPlanDateCoding.decoder().decode(QueueEnvelope.self, from: plaintext)
    guard queue.version == 1 else {
      throw CompanionError.invalidRemoteData("The local capture queue version is unsupported.")
    }
    return queue
  }

  private func saveUnlocked(_ queue: QueueEnvelope) throws {
    if queue.commands.isEmpty {
      defaults.removeObject(forKey: storageKey)
      return
    }
    let plaintext = try OmniPlanDateCoding.encoder().encode(queue)
    let encrypted = try SyncCrypto.sealLocalData(
      plaintext,
      keyData: credentials.loadOrCreateOutboxKey()
    )
    defaults.set(encrypted, forKey: storageKey)
  }
}
