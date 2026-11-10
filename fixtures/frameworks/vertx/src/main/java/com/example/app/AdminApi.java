package com.example.app;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;

/** A sub-router mounted in another sub-router. */
public final class AdminApi {

	private AdminApi() {
	}

	public static Router router(Vertx vertx) {
		Router admin = Router.router(vertx);
		admin.get("/stats").handler(ctx -> ctx.end("stats"));
		admin.post("/reindex").handler(ctx -> ctx.response().setStatusCode(202).end());
		return admin;
	}

}
