import Foundation
import Testing
@testable import OmniPlanCompanionCore

@Test
func captureReportsOutboxFailureInsteadOfEscapingToShortcuts() async {
  let service = CaptureService(
    credentials: UnusedCredentialStore(),
    outbox: FailingCaptureOutbox()
  )

  let outcome = await service.capture(
    CaptureCommand(id: "keychain-failure", title: "Capture safely")
  )

  guard case let .failed(reason) = outcome.delivery else {
    Issue.record("An unavailable encrypted outbox must produce an explicit failure outcome.")
    return
  }
  #expect(reason.contains("Keychain write failed"))
}

@Test
func locallySignedMacBuildCanSelectTraditionalKeychainFallback() {
  let store = KeychainCredentialStore(
    service: "jp.random-walk.omniplan.companion.test",
    synchronizesAcrossDevices: false
  )

  #expect(!store.synchronizesAcrossDevices)
}

private final class FailingCaptureOutbox: CaptureOutboxStoring, @unchecked Sendable {
  func commands() throws -> [CaptureCommand] { [] }

  func append(_ command: CaptureCommand) throws {
    throw CompanionError.transport("Keychain write failed (-34018).")
  }

  func remove(ids: Set<String>) throws {}
}

private final class UnusedCredentialStore: CompanionCredentialStoring, @unchecked Sendable {
  func loadConfiguration() throws -> CompanionConfiguration? { nil }
  func saveConfiguration(_ configuration: CompanionConfiguration) throws {}
  func loadPassphrase() throws -> String? { nil }
  func savePassphrase(_ passphrase: String) throws {}
  func clearSynchronizedCredentials() throws {}
  func loadOrCreateOutboxKey() throws -> Data { Data(repeating: 1, count: 32) }
}
