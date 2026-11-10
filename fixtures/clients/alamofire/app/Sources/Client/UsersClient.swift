import Alamofire
import Foundation

struct UserBody: Encodable, Sendable {
    let name: String
}

/// Users, with Alamofire's request API as its usage guide shows it: a URL string with the value interpolated after the
/// API's base URL, the method, `Encodable` parameters with their encoder (a query for GET, JSON for a body), headers;
/// and a `URL`, which is `URLConvertible` as a string is.
public struct UsersClient: Sendable {
    let baseURL: String

    public init(server: String) {
        baseURL = "\(server)/api/v1"
    }

    public func users(page: Int) async throws -> Data {
        try await AF.request("\(baseURL)/users", parameters: ["page": page], encoder: URLEncodedFormParameterEncoder.default)
            .validate()
            .serializingData()
            .value
    }

    public func user(id: String) async throws -> Data {
        try await AF.request("\(baseURL)/users/\(id)").validate().serializingData().value
    }

    public func createUser(name: String) async throws -> Data {
        try await AF.request(
            "\(baseURL)/users",
            method: .post,
            parameters: UserBody(name: name),
            encoder: JSONParameterEncoder.default,
            headers: [.accept("application/json")]
        ).validate().serializingData().value
    }

    public func replaceUser(id: String, name: String) async throws -> Data {
        try await AF.request("\(baseURL)/users/\(id)", method: .put, parameters: UserBody(name: name), encoder: JSONParameterEncoder.default)
            .serializingData()
            .value
    }

    public func renameUser(id: String, name: String) async throws -> Data {
        try await AF.request("\(baseURL)/users/\(id)", method: .patch, parameters: UserBody(name: name), encoder: JSONParameterEncoder.default)
            .serializingData()
            .value
    }

    public func deleteUser(id: String) async throws -> Data {
        try await AF.request(baseURL + "/users/" + id, method: .delete).serializingData().value
    }

    public func avatar(id: String) async throws -> Data {
        let url = URL(string: baseURL)!.appendingPathComponent("users/\(id)/avatar")
        return try await AF.request(url).serializingData().value
    }
}
