package com.example.app;

import io.vertx.core.Vertx;
import io.vertx.ext.web.Router;

/** A sub-router: the REST API the main router mounts under `/productsAPI`. */
public final class ProductsApi {

	private ProductsApi() {
	}

	public static Router router(Vertx vertx) {
		Router restAPI = Router.router(vertx);
		restAPI.get("/products").handler(ctx -> ctx.end("products"));
		restAPI.get("/products/:productID").handler(ctx -> ctx.end("product " + ctx.pathParam("productID")));
		restAPI.put("/products/:productID").handler(ctx -> ctx.end());
		restAPI.delete("/products/:productID").handler(ctx -> ctx.end());
		restAPI.route("/admin/*").subRouter(AdminApi.router(vertx));
		return restAPI;
	}

}
