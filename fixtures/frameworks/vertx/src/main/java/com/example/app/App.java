package com.example.app;

import io.vertx.core.Future;
import io.vertx.core.Vertx;
import io.vertx.core.http.HttpMethod;
import io.vertx.core.json.JsonObject;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.handler.BodyHandler;
import io.vertx.ext.web.handler.StaticHandler;

public final class App {

	private App() {
	}

	public static void main(String[] args) {
		Vertx vertx = Vertx.vertx();
		vertx.createHttpServer().requestHandler(router(vertx)).listen(8080);
	}

	public static Router router(Vertx vertx) {
		Router router = Router.router(vertx);
		router.route().handler(BodyHandler.create());

		router.get("/").handler(ctx -> ctx.end("Hello World"));
		router.route().path("/some/path").handler(ctx -> ctx.end("any method"));
		router.route("/some/prefix/*").handler(ctx -> ctx.end("starts with /some/prefix/"));
		router.route(HttpMethod.POST, "/catalogue/products/:productType/:productID/")
				.handler(ctx -> ctx.end(ctx.pathParam("productType") + " " + ctx.pathParam("productID")));
		router.get("/flights/:from-:to").handler(ctx -> ctx.end(ctx.pathParam("from") + " to " + ctx.pathParam("to")));
		router.get("/items/:id::integer").handler(ctx -> ctx.end("item " + ctx.pathParam("id")));
		router.route("/orders").method(HttpMethod.POST).method(HttpMethod.PUT).handler(ctx -> ctx.end("order"));
		router.route().path("/dav/:resource").method(HttpMethod.valueOf("MKCOL")).handler(ctx -> ctx.response().setStatusCode(201).end());

		router.get("/users").respond(ctx -> Future.succeededFuture(new JsonObject().put("users", 0)));
		router.post("/users").handler(ctx -> ctx.response().setStatusCode(201).end());
		router.get("/users/:id").respond(ctx -> Future.succeededFuture(new JsonObject().put("id", ctx.pathParam("id"))));
		router.patch("/users/:id").handler(ctx -> ctx.end("updated"));
		router.delete("/users/:id").handler(ctx -> ctx.response().setStatusCode(204).end());

		router.route("/static/*").handler(StaticHandler.create("webroot"));

		router.route("/productsAPI/*").subRouter(ProductsApi.router(vertx));
		router.route("/tenants/:tenant/*").subRouter(TenantApi.router(vertx));
		return router;
	}

}
