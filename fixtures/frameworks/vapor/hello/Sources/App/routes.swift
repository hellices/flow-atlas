// The routes of Vapor's routing guide (docs.vapor.codes/basics/routing/) and controllers (docs.vapor.codes/basics/controllers/):
// method helpers and `on`, constant, parameter, anything (`*`) and catchall (`**`) path components, groups by path
// prefix in the builder and the closure syntax, nested groups, middleware groups, and route collections registered
// on the application and on a group.
import Vapor

func routes(_ app: Application) throws {
    app.get { req in
        "It works!"
    }

    app.get("hello", "vapor") { req in
        "Hello, vapor!"
    }
    app.on(.POST, "hello", "vapor") { req in
        "posted"
    }
    app.get("hello", ":name") { req -> String in
        let name = req.parameters.get("name")!
        return "Hello, \(name)!"
    }

    app.on(.OPTIONS, "foo", "bar", "baz") { req in
        HTTPStatus.noContent
    }
    app.get("foo", ":bar", "baz") { req in
        req.parameters.get("bar")!
    }
    app.get("anything", "*", "baz") { req in
        "anything"
    }
    app.get("files", "**") { req -> String in
        req.parameters.getCatchall().joined(separator: "/")
    }
    app.get("number", ":x") { req -> String in
        guard let int = req.parameters.get("x", as: Int.self) else {
            throw Abort(.badRequest)
        }
        return "\(int) is a great number"
    }

    app.on(.POST, "listings", body: .collect(maxSize: "1mb")) { req in
        HTTPStatus.created
    }
    app.on(.POST, "upload", body: .stream) { req in
        HTTPStatus.accepted
    }

    let users = app.grouped("users")
    users.get { req in
        "users"
    }
    users.post { req in
        HTTPStatus.created
    }
    users.get(":id") { req in
        req.parameters.get("id")!
    }

    app.group("accounts") { accounts in
        accounts.get { req in
            "accounts"
        }
        accounts.group(":id") { account in
            account.get { req in
                req.parameters.get("id")!
            }
            account.patch { req in
                HTTPStatus.ok
            }
            account.put { req in
                HTTPStatus.ok
            }
            account.delete { req in
                HTTPStatus.noContent
            }
        }
    }

    app.get("fast-thing") { req in
        "fast"
    }
    app.group(HeaderMiddleware()) { tagged in
        tagged.get("slow-thing") { req in
            "slow"
        }
    }
    app.post("login") { req in
        "logged in"
    }
    let auth = app.grouped(HeaderMiddleware())
    auth.get("dashboard") { req in
        "dashboard"
    }
    auth.get("logout") { req in
        "logged out"
    }

    try app.register(collection: TodosController())
    try app.grouped("api", "v1").register(collection: TodosController())
}

/// A middleware a group of routes runs through.
struct HeaderMiddleware: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        let response = try await next.respond(to: request)
        response.headers.add(name: "X-Group", value: "tagged")
        return response
    }
}
