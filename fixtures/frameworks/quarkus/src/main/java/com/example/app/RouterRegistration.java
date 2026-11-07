package com.example.app;

import io.vertx.ext.web.Router;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

/** Routes registered on the Vert.x Web router at startup. */
@ApplicationScoped
public class RouterRegistration {

	public void init(@Observes Router router) {
		router.get("/my-route").handler(rc -> rc.response().end("Hello from my route"));
		router.route("/my-route/:id").handler(rc -> rc.response().end("Hello from " + rc.pathParam("id")));
	}
}
