package com.example.app;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;

/** A sub-router mounted at a path with a parameter, which its routes read. */
public final class TenantApi {

	private TenantApi() {
	}

	public static Router router(Vertx vertx) {
		Router tenant = Router.router(vertx);
		tenant.get("/settings").handler(ctx -> ctx.end("settings of " + ctx.pathParam("tenant")));
		tenant.put("/settings/:key").handler(ctx -> ctx.end());
		return tenant;
	}

}
