package com.example.app;

import static io.javalin.apibuilder.ApiBuilder.crud;
import static io.javalin.apibuilder.ApiBuilder.delete;
import static io.javalin.apibuilder.ApiBuilder.get;
import static io.javalin.apibuilder.ApiBuilder.patch;
import static io.javalin.apibuilder.ApiBuilder.path;
import static io.javalin.apibuilder.ApiBuilder.post;
import static io.javalin.apibuilder.ApiBuilder.put;
import static io.javalin.apibuilder.ApiBuilder.sse;

import io.javalin.Javalin;
import io.javalin.config.JavalinConfig;
import io.javalin.http.HandlerType;
import io.javalin.http.staticfiles.Location;

public final class App {

	private App() {
	}

	public static void main(String[] args) {
		Javalin.create(App::configure).start(7070);
	}

	public static void configure(JavalinConfig config) {
		config.staticFiles.add(staticFiles -> {
			staticFiles.hostedPath = "/assets";
			staticFiles.directory = "/public";
			staticFiles.location = Location.CLASSPATH;
		});
		config.bundledPlugins.enableRouteOverview("/routes");

		config.routes.get("/", ctx -> ctx.result("Hello World"));
		config.routes.get("/output", ctx -> ctx.result("output"));
		config.routes.post("/input", ctx -> ctx.status(201));
		config.routes.get("/hello/{name}", ctx -> ctx.result("Hello " + ctx.pathParam("name")));
		config.routes.get("/files/<path>", ctx -> ctx.result("file " + ctx.pathParam("path")));
		config.routes.get("/reports/{year}-{month}.csv", ctx -> ctx.result(ctx.pathParam("year") + "-" + ctx.pathParam("month")));
		config.routes.get("/path/*", ctx -> ctx.result(ctx.path() + " matches " + ctx.endpoint().path));
		config.routes.addHttpHandler(HandlerType.findOrCreate("PROPFIND"), "/webdav/{resource}", ctx -> ctx.status(207));
		config.routes.query("/search", ctx -> ctx.result("results"));
		config.routes.sse("/sse", client -> client.sendEvent("hello"));

		config.routes.apiBuilder(() -> {
			path("/users", () -> {
				get(UserController::getAllUsers);
				post(UserController::createUser);
				// Endpoints match in the order they are added: before `/{id}`, which would take `/users/events` too.
				sse("/events", UserController::events);
				path("/{id}", () -> {
					get(UserController::getUser);
					patch(UserController::updateUser);
					delete(UserController::deleteUser);
				});
			});
			path("api", () -> {
				path("v1", () -> {
					crud("articles/{article-id}", new ArticleController());
					put("settings/{key}", ctx -> ctx.status(204));
				});
			});
		});
	}

}
