// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "MacNativeShell",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .library(
      name: "MacNativeShell",
      type: .static,
      targets: ["MacNativeShell"])
  ],
  targets: [
    .target(
      name: "MacNativeShell",
      path: "Sources")
  ]
)
