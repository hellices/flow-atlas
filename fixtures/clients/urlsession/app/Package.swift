// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "App",
    platforms: [.macOS(.v13)],
    targets: [
        // The app's networking code, on Foundation's URL loading system.
        .target(name: "Client"),
        // Makes every request the client makes: see Sources/Oracle/main.swift.
        .executableTarget(name: "Oracle", dependencies: ["Client"]),
    ]
)
