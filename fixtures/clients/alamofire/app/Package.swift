// swift-tools-version:6.0
import PackageDescription

// The package is in `app/`: a root package in a directory named `alamofire` would take the identity of the Alamofire
// package it depends on.
let package = Package(
    name: "App",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/Alamofire/Alamofire.git", from: "5.12.2"),
    ],
    targets: [
        // The app's networking code, on Alamofire.
        .target(name: "Client", dependencies: [.product(name: "Alamofire", package: "Alamofire")]),
        // Makes every request the client makes: see Sources/Oracle/main.swift.
        .executableTarget(name: "Oracle", dependencies: ["Client"]),
    ]
)
