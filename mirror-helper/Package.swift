// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "mirror-helper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "mirror-helper", path: "Sources")
    ]
)
