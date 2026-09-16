import Foundation
import Testing
@testable import OmniPlanCompanionCore

@Test
func outboxEncryptsPendingCaptureAtRest() throws {
  let suiteName = "omniplan-companion-test-\(UUID().uuidString)"
  let defaults = try #require(UserDefaults(suiteName: suiteName))
  defer { defaults.removePersistentDomain(forName: suiteName) }
  let credentials = FixedCredentialStore()
  let outbox = EncryptedCaptureOutbox(credentials: credentials, defaults: defaults)
  let command = CaptureCommand(id: "queued-one", title: "Private capture")

  try outbox.append(command)

  let stored = try #require(defaults.data(forKey: "omniplan.companion.encrypted-outbox.v1"))
  #expect(!String(decoding: stored, as: UTF8.self).contains("Private capture"))
  #expect(try outbox.commands() == [command])

  try outbox.remove(ids: [command.id])
  #expect(try outbox.commands().isEmpty)
}

private final class FixedCredentialStore: CompanionCredentialStoring, @unchecked Sendable {
  func loadConfiguration() throws -> CompanionConfiguration? { nil }
  func saveConfiguration(_ configuration: CompanionConfiguration) throws {}
  func loadPassphrase() throws -> String? { nil }
  func savePassphrase(_ passphrase: String) throws {}
  func clearSynchronizedCredentials() throws {}
  func loadOrCreateOutboxKey() throws -> Data { Data(repeating: 7, count: 32) }
}
