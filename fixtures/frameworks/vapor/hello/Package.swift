// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "Hello",
    platforms: [
        .macOS(.v13)
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.122.3"),
    ],
    targets: [
        .target(
            name: "App",
            dependencies: [.product(name: "Vapor", package: "vapor")]
        ),
        .executableTarget(name: "Run", dependencies: [.target(name: "App")]),
        // Prints the routes Vapor serves: see Sources/Oracle/main.swift.
        .executableTarget(
            name: "Oracle",
            dependencies: [.target(name: "App"), .product(name: "Vapor", package: "vapor")]
        ),
    ]
)
