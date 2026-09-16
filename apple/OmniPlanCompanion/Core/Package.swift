// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "OmniPlanCompanionCore",
  defaultLocalization: "en",
  platforms: [
    .macOS(.v14),
    .iOS(.v17)
  ],
  products: [
    .library(name: "OmniPlanCompanionCore", targets: ["OmniPlanCompanionCore"])
  ],
  targets: [
    .target(
      name: "OmniPlanCompanionCore",
      linkerSettings: [
        .linkedFramework("CryptoKit"),
        .linkedFramework("Security")
      ]
    ),
    .testTarget(
      name: "OmniPlanCompanionCoreTests",
      dependencies: ["OmniPlanCompanionCore"]
    )
  ],
  swiftLanguageModes: [.v5]
)
