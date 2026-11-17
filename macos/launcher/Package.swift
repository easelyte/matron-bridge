// swift-tools-version:5.9
import PackageDescription

// The launcher behind "Matron Bridge.app". build-sign-notarize.sh builds this
// package and wraps the binary in the app bundle; see README.md.
let package = Package(
  name: "MatronBridgeLauncher",
  platforms: [.macOS(.v12)],
  targets: [
    .executableTarget(
      name: "matron-bridge-launcher",
      path: "Sources/MatronBridgeLauncher"
    ),
  ]
)
