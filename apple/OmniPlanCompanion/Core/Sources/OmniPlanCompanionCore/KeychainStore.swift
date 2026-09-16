import Foundation
import Security

public protocol CompanionCredentialStoring: Sendable {
  func loadConfiguration() throws -> CompanionConfiguration?
  func saveConfiguration(_ configuration: CompanionConfiguration) throws
  func loadPassphrase() throws -> String?
  func savePassphrase(_ passphrase: String) throws
  func clearSynchronizedCredentials() throws
  func loadOrCreateOutboxKey() throws -> Data
}

public final class KeychainCredentialStore: CompanionCredentialStoring, @unchecked Sendable {
  private let service: String
  public let synchronizesAcrossDevices: Bool
  private let configurationAccount = "sync-configuration-v1"
  private let passphraseAccount = "workspace-passphrase-v1"
  private let outboxKeyAccount = "outbox-key-v1"

  public init(
    service: String = "jp.random-walk.omniplan.companion",
    synchronizesAcrossDevices: Bool? = nil
  ) {
    self.service = service
    self.synchronizesAcrossDevices =
      synchronizesAcrossDevices ?? Self.hasApplicationIdentifierEntitlement
  }

  public func loadConfiguration() throws -> CompanionConfiguration? {
    guard let data = try read(account: configurationAccount, synchronizable: true) else {
      return nil
    }
    return try JSONDecoder().decode(CompanionConfiguration.self, from: data)
  }

  public func saveConfiguration(_ configuration: CompanionConfiguration) throws {
    try write(
      try JSONEncoder().encode(configuration.normalized),
      account: configurationAccount,
      synchronizable: true
    )
  }

  public func loadPassphrase() throws -> String? {
    guard let data = try read(account: passphraseAccount, synchronizable: true) else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  public func savePassphrase(_ passphrase: String) throws {
    let trimmed = passphrase.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      throw CompanionError.missingPassphrase
    }
    try write(Data(trimmed.utf8), account: passphraseAccount, synchronizable: true)
  }

  public func clearSynchronizedCredentials() throws {
    try delete(account: configurationAccount, synchronizable: nil)
    try delete(account: passphraseAccount, synchronizable: nil)
  }

  public func loadOrCreateOutboxKey() throws -> Data {
    if let existing = try read(account: outboxKeyAccount, synchronizable: false) {
      guard existing.count == 32 else {
        throw CompanionError.invalidRemoteData("The local outbox key is invalid.")
      }
      return existing
    }
    let key = try SyncCrypto.randomData(count: 32)
    try write(key, account: outboxKeyAccount, synchronizable: false)
    return key
  }

  private func read(account: String, synchronizable: Bool) throws -> Data? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    if synchronizesAcrossDevices {
      query[kSecAttrSynchronizable as String] =
        synchronizable ? kCFBooleanTrue : kCFBooleanFalse
    }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw CompanionError.transport("Keychain read failed (\(status)).")
    }
    return data
  }

  private func write(_ data: Data, account: String, synchronizable: Bool) throws {
    try delete(account: account, synchronizable: nil)
    var attributes = baseQuery(account: account)
    attributes[kSecValueData as String] = data
    #if os(macOS)
    if synchronizesAcrossDevices {
      attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    }
    #else
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    #endif
    if synchronizesAcrossDevices {
      attributes[kSecAttrSynchronizable as String] =
        synchronizable ? kCFBooleanTrue : kCFBooleanFalse
    }
    let status = SecItemAdd(attributes as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw CompanionError.transport("Keychain write failed (\(status)).")
    }
  }

  private func delete(account: String, synchronizable: Bool?) throws {
    var query = baseQuery(account: account)
    if synchronizesAcrossDevices {
      query[kSecAttrSynchronizable as String] = synchronizable.map {
        $0 ? kCFBooleanTrue : kCFBooleanFalse
      } ?? kSecAttrSynchronizableAny
    }
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw CompanionError.transport("Keychain delete failed (\(status)).")
    }
  }

  private func baseQuery(account: String) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account
    ]
    #if os(macOS)
    if synchronizesAcrossDevices {
      query[kSecUseDataProtectionKeychain as String] = true
    }
    #endif
    return query
  }

  private static var hasApplicationIdentifierEntitlement: Bool {
    #if os(macOS)
    guard let task = SecTaskCreateFromSelf(nil),
          let identifier = SecTaskCopyValueForEntitlement(
            task,
            "com.apple.application-identifier" as CFString,
            nil
          ) as? String
    else {
      return false
    }
    return !identifier.isEmpty
    #else
    return true
    #endif
  }
}

public final class DeviceIdentifierStore: @unchecked Sendable {
  private let defaults: UserDefaults
  private let key: String
  private let lock = NSLock()

  public init(
    defaults: UserDefaults = .standard,
    key: String = "omniplan.companion.device-id.v1"
  ) {
    self.defaults = defaults
    self.key = key
  }

  public func value() -> String {
    lock.lock()
    defer { lock.unlock() }
    if let existing = defaults.string(forKey: key), !existing.isEmpty {
      return existing
    }
    let generated = "apple-\(UUID().uuidString.lowercased())"
    defaults.set(generated, forKey: key)
    return generated
  }
}
