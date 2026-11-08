import Alamofire
import Foundation

enum APIEnvironment {
    /// The server's URL, from the app's settings: the environment in development, the production server otherwise.
    static let server = URL(string: ProcessInfo.processInfo.environment["API_SERVER_URL"] ?? "https://api.example.com")!
}

/// The orders API's routes, in the router pattern Alamofire's advanced usage guide documents: each case a request,
/// with its method, its path under the router's base URL and its parameters.
enum OrdersRouter: URLRequestConvertible {
    case orders(status: String)
    case order(number: Int)
    case addNote(number: Int, text: String)
    case cancel(number: Int)

    var baseURL: URL {
        APIEnvironment.server.appendingPathComponent("api/v2")
    }

    var method: HTTPMethod {
        switch self {
        case .orders, .order: .get
        case .addNote: .post
        case .cancel: .delete
        }
    }

    var path: String {
        switch self {
        case .orders: "orders"
        case let .order(number): "orders/\(number)"
        case let .addNote(number, _): "orders/\(number)/notes"
        case let .cancel(number): "orders/\(number)"
        }
    }

    func asURLRequest() throws -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.method = method
        switch self {
        case let .orders(status):
            request = try URLEncodedFormParameterEncoder().encode(["status": status], into: request)
        case let .addNote(_, text):
            request = try JSONParameterEncoder().encode(["text": text], into: request)
        case .order, .cancel:
            break
        }
        return request
    }
}

/// Adds the session's token to each request, as the guide's `RequestAdapter` does.
struct TokenAdapter: RequestInterceptor {
    let token: String

    func adapt(_ urlRequest: URLRequest, for session: Session, completion: @escaping (Result<URLRequest, any Error>) -> Void) {
        var urlRequest = urlRequest
        urlRequest.headers.add(.authorization(bearerToken: token))
        completion(.success(urlRequest))
    }
}

/// Orders, on a `Session` of the app's own with the token adapter, each request a route of `OrdersRouter`.
public struct OrdersAPI: Sendable {
    let session: Session

    public init(token: String) {
        session = Session(interceptor: TokenAdapter(token: token))
    }

    public func orders(status: String) async throws -> Data {
        try await session.request(OrdersRouter.orders(status: status)).validate().serializingData().value
    }

    public func order(number: Int) async throws -> Data {
        try await session.request(OrdersRouter.order(number: number)).validate().serializingData().value
    }

    public func addNote(number: Int, text: String) async throws -> Data {
        try await session.request(OrdersRouter.addNote(number: number, text: text)).validate().serializingData().value
    }

    public func cancel(number: Int) async throws -> Data {
        try await session.request(OrdersRouter.cancel(number: number)).validate().serializingData().value
    }
}
