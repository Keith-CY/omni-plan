import Foundation
import OmniPlanCompanionCore
#if os(macOS)
import AppKit
#endif

final class AppServices: @unchecked Sendable {
  static let shared = AppServices()

  let credentials: KeychainCredentialStore
  let outbox: EncryptedCaptureOutbox
  let captureService: CaptureService

  private init() {
    let credentials = KeychainCredentialStore()
    self.credentials = credentials
    self.outbox = EncryptedCaptureOutbox(credentials: credentials)
    self.captureService = CaptureService(credentials: credentials, outbox: outbox)
  }

  func handleCaptureURL(_ url: URL) {
    guard url.scheme == "omniplan-companion" else {
      return
    }
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let source = components?.queryItems?.first(where: { $0.name == "source" })?.value
    if url.host == "health" {
      Task {
        do {
          _ = try credentials.loadOrCreateOutboxKey()
          if source == "alfred" {
            await postAlfredFeedback("OmniPlan 本地加密队列可用")
          }
        } catch {
          if source == "alfred" {
            await postAlfredFeedback("本地加密队列不可用：\(error.localizedDescription)")
          }
        }
      }
      return
    }
    guard url.host == "capture" else {
      return
    }
    let query = components?.queryItems?.first(where: { $0.name == "q" })?.value ?? ""
    Task {
      do {
        let command = try CaptureQueryParser.parse(query)
        let outcome = await captureService.capture(command)
        await CaptureNotifications.shared.post(outcome: outcome)
        if case .queued = outcome.delivery {
          BackgroundRetryCoordinator.shared.schedule()
        }
        if source == "alfred" {
          let message = switch outcome.delivery {
          case .synced:
            "已同步到 OmniPlan：\(command.title)"
          case .queued:
            "已加密排队，等待同步：\(command.title)"
          case let .failed(reason):
            "添加失败：\(reason)"
          }
          await postAlfredFeedback(message)
        }
      } catch {
        await CaptureNotifications.shared.postFailure(error.localizedDescription)
        if source == "alfred" {
          await postAlfredFeedback("添加失败：\(error.localizedDescription)")
        }
      }
    }
  }

  @MainActor
  private func postAlfredFeedback(_ message: String) {
    #if os(macOS)
    var components = URLComponents()
    components.scheme = "alfred"
    components.host = "runtrigger"
    components.path = "/jp.random-walk.omniplan.alfred.add-action/capture-feedback/"
    components.queryItems = [URLQueryItem(name: "argument", value: message)]
    if let url = components.url {
      NSWorkspace.shared.open(url)
    }
    #endif
  }
}
