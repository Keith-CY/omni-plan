// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "OmniPlanCompanion",
  defaultLocalization: "en",
  platforms: [
    .macOS(.v14),
    .iOS(.v17)
  ],
  dependencies: [
    .package(path: "Core")
  ],
  targets: [
    .executableTarget(
      name: "OmniPlanCompanion",
      dependencies: [
        .product(name: "OmniPlanCompanionCore", package: "Core")
      ],
      path: "App/Sources",
      linkerSettings: [
        .linkedFramework("AppIntents"),
        .linkedFramework("BackgroundTasks"),
        .linkedFramework("Network"),
        .linkedFramework("SwiftUI"),
        .linkedFramework("UserNotifications")
      ]
    )
  ],
  swiftLanguageModes: [.v5]
)
