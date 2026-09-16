import SwiftUI

@main
struct OmniPlanCompanionApp: App {
  init() {
    BackgroundRetryCoordinator.shared.start()
    OmniPlanAppShortcuts.updateAppShortcutParameters()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .onOpenURL { url in
          AppServices.shared.handleCaptureURL(url)
        }
    }
  }
}
