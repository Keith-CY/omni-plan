import Foundation
import OmniPlanCompanionCore
import UserNotifications

actor CaptureNotifications {
  static let shared = CaptureNotifications()

  func requestAuthorization() async {
    _ = try? await UNUserNotificationCenter.current().requestAuthorization(
      options: [.alert, .badge, .sound]
    )
  }

  func post(outcome: CaptureOutcome) async {
    let title: String
    let body: String
    switch outcome.delivery {
    case .synced:
      title = "OmniPlan Action synced"
      body = outcome.command.title
    case let .queued(reason):
      title = "OmniPlan Action captured"
      body = "\(outcome.command.title) — waiting to sync. \(reason)"
    case let .failed(reason):
      title = "OmniPlan capture failed"
      body = "\(outcome.command.title) — \(reason)"
    }
    await post(title: title, body: body, identifier: "capture-\(outcome.command.id)")
  }

  func postSyncedCount(_ count: Int) async {
    guard count > 0 else {
      return
    }
    await post(
      title: "OmniPlan Actions synced",
      body: "\(count) queued \(count == 1 ? "Action is" : "Actions are") now in the workspace.",
      identifier: "outbox-synced-\(UUID().uuidString)"
    )
  }

  func postFailure(_ message: String) async {
    await post(
      title: "OmniPlan capture failed",
      body: message,
      identifier: "capture-error-\(UUID().uuidString)"
    )
  }

  private func post(title: String, body: String, identifier: String) async {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized ||
            settings.authorizationStatus == .provisional
    else {
      return
    }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    try? await center.add(UNNotificationRequest(
      identifier: identifier,
      content: content,
      trigger: nil
    ))
  }
}
