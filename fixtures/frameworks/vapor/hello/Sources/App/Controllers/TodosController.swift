import Vapor

struct Todo: Content {
    var id: Int?
    var title: String
}

struct TodosController: RouteCollection {
    func boot(routes: any RoutesBuilder) throws {
        let todos = routes.grouped("todos")
        todos.get(use: index)
        todos.post(use: create)

        todos.group(":id") { todo in
            todo.get(use: show)
            todo.put(use: update)
            todo.delete(use: delete)
        }
    }

    @Sendable
    func index(req: Request) async throws -> [Todo] {
        []
    }

    @Sendable
    func create(req: Request) async throws -> Todo {
        try req.content.decode(Todo.self)
    }

    @Sendable
    func show(req: Request) async throws -> Todo {
        Todo(id: req.parameters.get("id", as: Int.self), title: "a todo")
    }

    @Sendable
    func update(req: Request) async throws -> Todo {
        try req.content.decode(Todo.self)
    }

    @Sendable
    func delete(req: Request) async throws -> HTTPStatus {
        .noContent
    }
}
