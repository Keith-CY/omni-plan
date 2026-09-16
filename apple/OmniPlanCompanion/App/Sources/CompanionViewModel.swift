import Foundation
import OmniPlanCompanionCore
import SwiftUI

@MainActor
final class CompanionViewModel: ObservableObject {
  @Published var projectId = ""
  @Published var apiKey = ""
  @Published var databaseId = "(default)"
  @Published var collectionPath = "omniPlanSync"
  @Published var workspaceId = "personal"
  @Published var passphrase = ""
  @Published var hasStoredPassphrase = false
  @Published var pendingCount = 0
  @Published var status = "Configure encrypted Firebase sync once, then capture from Shortcuts."
  @Published var isBusy = false
  @Published var testTitle = ""
  @Published var testNote = ""
  @Published var testHasPlanTime = false
  @Published var testPlanTime = Date()

  private let services = AppServices.shared

  var credentialStorageDescription: String {
    if services.credentials.synchronizesAcrossDevices {
      return "Configuration and passphrase are stored as synchronizable app-scoped Keychain items. Firebase continues to receive ciphertext only."
    }
    return "This locally signed build stores configuration and passphrase in this Mac’s login Keychain. A provisioned Apple build enables iCloud Keychain sync. Firebase continues to receive ciphertext only."
  }

  func load() {
    do {
      if let configuration = try services.credentials.loadConfiguration() {
        projectId = configuration.projectId
        apiKey = configuration.apiKey
        databaseId = configuration.databaseId
        collectionPath = configuration.collectionPath
        workspaceId = configuration.workspaceId
      }
      hasStoredPassphrase = try services.credentials.loadPassphrase() != nil
      pendingCount = try services.outbox.commands().count
    } catch {
      status = error.localizedDescription
    }
  }

  func saveAndTest() {
    guard !isBusy else {
      return
    }
    isBusy = true
    Task {
      defer { isBusy = false }
      do {
        let configuration = CompanionConfiguration(
          projectId: projectId,
          apiKey: apiKey,
          databaseId: databaseId,
          collectionPath: collectionPath,
          workspaceId: workspaceId
        ).normalized
        guard configuration.isComplete else {
          throw CompanionError.missingConfiguration
        }
        try services.credentials.saveConfiguration(configuration)
        if !passphrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          try services.credentials.savePassphrase(passphrase)
          passphrase = ""
        }
        hasStoredPassphrase = try services.credentials.loadPassphrase() != nil
        await CaptureNotifications.shared.requestAuthorization()
        let revision = try await services.captureService.testConnection()
        let flushed = try await services.captureService.flush()
        pendingCount = try services.outbox.commands().count
        status = "Connected to encrypted workspace \(revision.prefix(12)). Synced \(flushed) queued Action\(flushed == 1 ? "" : "s")."
      } catch {
        pendingCount = (try? services.outbox.commands().count) ?? pendingCount
        status = error.localizedDescription
      }
    }
  }

  func flush() {
    guard !isBusy else {
      return
    }
    isBusy = true
    Task {
      defer { isBusy = false }
      do {
        let count = try await services.captureService.flush()
        pendingCount = try services.outbox.commands().count
        status = count > 0 ? "Synced \(count) queued Action\(count == 1 ? "" : "s")." : "Nothing is waiting to sync."
      } catch {
        status = error.localizedDescription
      }
    }
  }

  func captureTestAction() {
    guard !isBusy else {
      return
    }
    isBusy = true
    Task {
      defer { isBusy = false }
      do {
        let command = CaptureCommand(
          title: testTitle,
          note: testNote,
          scheduledAt: testHasPlanTime ? testPlanTime : nil
        )
        let outcome = await services.captureService.capture(command)
        pendingCount = try services.outbox.commands().count
        switch outcome.delivery {
        case .synced:
          status = "Added and synced “\(command.title)”."
        case let .queued(reason):
          status = "Captured “\(command.title)” locally. \(reason)"
          BackgroundRetryCoordinator.shared.schedule()
        case let .failed(reason):
          status = "Could not capture “\(command.title)”. \(reason)"
        }
        testTitle = ""
        testNote = ""
        testHasPlanTime = false
      } catch {
        status = error.localizedDescription
      }
    }
  }
}
