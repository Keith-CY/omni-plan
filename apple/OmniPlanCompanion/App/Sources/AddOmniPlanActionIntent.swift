import AppIntents
import Foundation
import OmniPlanCompanionCore

struct AddOmniPlanActionIntent: AppIntent {
  static let title: LocalizedStringResource = "Add OmniPlan Action"
  static let description = IntentDescription(
    "Captures a standalone OmniPlan Action in the background. An optional plan time schedules it into Today."
  )
  static var openAppWhenRun = false

  @Parameter(
    title: "Title",
    description: "The Action title.",
    requestValueDialog: "What do you want to capture?"
  )
  var actionTitle: String

  @Parameter(
    title: "Note",
    description: "Optional context, link, or next step."
  )
  var note: String?

  @Parameter(
    title: "Plan Time",
    description: "Optional date and time when the Action should enter Today.",
    kind: .dateTime
  )
  var scheduledAt: Date?

  static var parameterSummary: some ParameterSummary {
    Summary(
      "Add \(\.$actionTitle) to OmniPlan with note \(\.$note) at \(\.$scheduledAt)"
    )
  }

  init() {}

  init(actionTitle: String, note: String? = nil, scheduledAt: Date? = nil) {
    self.actionTitle = actionTitle
    self.note = note
    self.scheduledAt = scheduledAt
  }

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let command = CaptureCommand(
      title: actionTitle,
      note: note,
      scheduledAt: scheduledAt
    )
    let outcome = await AppServices.shared.captureService.capture(command)
    await CaptureNotifications.shared.post(outcome: outcome)
    switch outcome.delivery {
    case .synced:
      return .result(dialog: IntentDialog(stringLiteral: "Added and synced: \(command.title)"))
    case let .queued(reason):
      BackgroundRetryCoordinator.shared.schedule()
      return .result(
        dialog: IntentDialog(
          stringLiteral: "Captured and waiting to sync: \(command.title). \(reason)"
        )
      )
    case let .failed(reason):
      return .result(
        dialog: IntentDialog(
          stringLiteral: "添加失败：\(reason)"
        )
      )
    }
  }
}

struct OmniPlanAppShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddOmniPlanActionIntent(),
      phrases: [
        "Add an action in \(.applicationName)",
        "Capture an action in \(.applicationName)",
        "在\(.applicationName)添加 Action"
      ],
      shortTitle: "Add Action",
      systemImageName: "checkmark.circle"
    )
  }
}
