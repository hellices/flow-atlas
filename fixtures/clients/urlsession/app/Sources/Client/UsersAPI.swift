import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct NewUser: Codable {
    let name: String
}

/// Users, with Foundation's URL loading system as Apple's guides show it: a `URLRequest` for the API's base URL with a
/// path appended, the value in it, its method in `httpMethod`, headers and a JSON body; `URLSession.shared` sends it.
public struct UsersAPI: Sendable {
    let baseURL: URL

    public init(server: URL) {
        baseURL = server.appendingPathComponent("api/v1")
    }

    public func user(id: String) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent("users/\(id)"))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, _) = try await URLSession.shared.data(for: request)
        return data
    }

    public func createUser(name: String) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent("users"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = try JSONEncoder().encode(NewUser(name: name))
        let (data, _) = try await URLSession.shared.upload(for: request, from: body)
        return data
    }

    public func replaceUser(id: String, name: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("users/\(id)"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(NewUser(name: name))
        _ = try await URLSession.shared.data(for: request)
    }

    public func renameUser(id: String, name: String) async throws {
        var request = URLRequest(url: baseURL.appending(path: "users/\(id)"))
        request.httpMethod = "PATCH"
        request.httpBody = try JSONEncoder().encode(NewUser(name: name))
        _ = try await URLSession.shared.data(for: request)
    }

    public func deleteUser(id: String) async throws {
        var request = URLRequest(url: baseURL.appendingPathComponent("users").appendingPathComponent(id))
        request.httpMethod = "DELETE"
        _ = try await URLSession.shared.data(for: request)
    }

    public func avatar(id: String) async throws -> Data {
        let (data, _) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("users/\(id)/avatar"))
        return data
    }
}
