// Asks Vapor which routes the application serves: `app.routes.all` is the route table Vapor's responder builds the
// router it dispatches with from, each route with its method and path components (docs.vapor.codes/basics/routing/,
// "Viewing Routes"). Each route is then requested through the application's responder, and the route Vapor matched
// (`req.route`) must be that route; a catchall `**` is also requested with nothing after its `/`, to learn whether
// Vapor dispatches that path to it as well.
import App
import Foundation
import Vapor

func canonical(_ path: [PathComponent]) -> String {
    let segments = path.map { component -> String in
        switch component {
        case .constant(let value): return value
        case .parameter, .anything: return "{}"
        case .catchall: return "{**}"
        }
    }
    return "/" + segments.joined(separator: "/")
}

func sample(_ path: [PathComponent]) -> String {
    let segments = path.map { component -> String in
        switch component {
        case .constant(let value): return value
        case .parameter, .anything: return "1"
        case .catchall: return "rest/of/it"
        }
    }
    return "/" + segments.joined(separator: "/")
}

LoggingSystem.bootstrap { label in
    var handler = StreamLogHandler.standardError(label: label)
    handler.logLevel = .error
    return handler
}
let app = try await Application.make(.testing)
do {
    try configure(app)
    try await app.asyncBoot()

    /// The route Vapor dispatches the request to: its responder sets `req.route` to the route it matched.
    func answers(_ method: HTTPMethod, _ path: String) async throws -> Route? {
        let request = Request(application: app, method: method, url: URI(path: path), on: app.eventLoopGroup.any())
        _ = try await app.responder.respond(to: request).get()
        return request.route
    }

    var routes: [[String: String]] = []
    for route in app.routes.all {
        let method = route.method
        let raw = "/" + route.path.map(\.description).joined(separator: "/")
        guard try await answers(method, sample(route.path)) === route else {
            fatalError("\(method.rawValue) \(sample(route.path)) is not answered by \(raw) that registers it")
        }
        routes.append(["method": method.rawValue, "path": canonical(route.path), "raw": raw])
        // A catchall Vapor also dispatches with nothing after its `/` serves the path before that `/` as well.
        if case .catchall = route.path.last {
            let parent = Array(route.path.dropLast())
            let path = sample(parent)
            if try await answers(method, path.hasSuffix("/") ? path : path + "/") === route {
                routes.append(["method": method.rawValue, "path": canonical(parent), "raw": raw])
            }
        }
    }

    // The version SwiftPM resolved and built: Vapor reports none at run time.
    let resolved = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "Package.resolved"))) as! [String: Any]
    let pins = resolved["pins"] as! [[String: Any]]
    let vapor = pins.first { ($0["identity"] as? String) == "vapor" }!
    let version = (vapor["state"] as! [String: Any])["version"] as! String

    let out: [String: Any] = ["framework": "vapor", "version": version, "routes": routes]
    let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
} catch {
    try? await app.asyncShutdown()
    throw error
}
try await app.asyncShutdown()
