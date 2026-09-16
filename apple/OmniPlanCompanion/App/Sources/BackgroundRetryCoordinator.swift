import Foundation
import Network
#if !os(macOS)
import BackgroundTasks
#endif

final class BackgroundRetryCoordinator: @unchecked Sendable {
  static let shared = BackgroundRetryCoordinator()
  static let taskIdentifier = "jp.random-walk.omniplan.companion.sync-outbox"

  private let monitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(label: "jp.random-walk.omniplan.companion.network")
  private let lock = NSLock()
  private var started = false
  #if os(macOS)
  private var macScheduler: NSBackgroundActivityScheduler?
  #endif

  private init() {}

  func start() {
    lock.lock()
    guard !started else {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()

    #if !os(macOS)
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: Self.taskIdentifier,
      using: nil
    ) { task in
      self.handle(task)
    }
    #endif
    monitor.pathUpdateHandler = { path in
      guard path.status == .satisfied else {
        return
      }
      Task {
        await self.flushAndNotify()
      }
    }
    monitor.start(queue: monitorQueue)
    schedule()
  }

  func schedule() {
    #if os(macOS)
    lock.lock()
    defer { lock.unlock() }
    guard macScheduler == nil else {
      return
    }
    let scheduler = NSBackgroundActivityScheduler(identifier: Self.taskIdentifier)
    scheduler.repeats = true
    scheduler.interval = 5 * 60
    scheduler.tolerance = 60
    scheduler.qualityOfService = .utility
    scheduler.schedule { completion in
      Task {
        _ = await self.flushAndNotify()
        completion(.finished)
      }
    }
    macScheduler = scheduler
    #else
    let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
    request.requiresNetworkConnectivity = true
    request.earliestBeginDate = Date(timeIntervalSinceNow: 60)
    try? BGTaskScheduler.shared.submit(request)
    #endif
  }

  #if !os(macOS)
  private func handle(_ task: BGTask) {
    schedule()
    let work = Task {
      let success = await flushAndNotify()
      task.setTaskCompleted(success: success)
    }
    task.expirationHandler = {
      work.cancel()
    }
  }
  #endif

  @discardableResult
  private func flushAndNotify() async -> Bool {
    do {
      let count = try await AppServices.shared.captureService.flush()
      await CaptureNotifications.shared.postSyncedCount(count)
      return true
    } catch {
      schedule()
      return false
    }
  }
}
