import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The store's requests, on a session of its own configured with the headers every request carries; each URL built with
/// `URLComponents` from the server's scheme, host and port, a path and query items.
public final class StoreAPI: Sendable {
    let server: URL
    let session: URLSession

    public init(server: URL) {
        self.server = server
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpAdditionalHeaders = ["Accept": "application/json"]
        session = URLSession(configuration: configuration)
    }

    private func components(path: String) -> URLComponents {
        var components = URLComponents()
        components.scheme = server.scheme
        components.host = server.host
        components.port = server.port
        components.path = path
        return components
    }

    public func search(term: String, page: Int) async throws -> Data {
        var components = components(path: "/store/products")
        components.queryItems = [
            URLQueryItem(name: "q", value: term),
            URLQueryItem(name: "page", value: String(page)),
        ]
        let (data, _) = try await session.data(from: components.url!)
        return data
    }

    public func order(number: Int) async throws -> Data {
        let (data, _) = try await session.data(for: URLRequest(url: components(path: "/store/orders/\(number)").url!))
        return data
    }

    public func cancelOrder(number: Int) async throws {
        var request = URLRequest(url: components(path: "/store/orders/\(number)/cancel").url!)
        request.httpMethod = "POST"
        _ = try await session.data(for: request)
    }
}
