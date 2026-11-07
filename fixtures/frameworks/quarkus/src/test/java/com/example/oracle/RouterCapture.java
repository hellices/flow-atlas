package com.example.oracle;

import io.vertx.ext.web.Route;
import io.vertx.ext.web.Router;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.enterprise.event.Observes;

/**
 * The oracle's view of the Vert.x Web router the HTTP server dispatches with: the router itself, and a route ahead of
 * all others that names, on each response, the route whose handler answered it.
 */
@ApplicationScoped
public class RouterCapture {

	static final String HEADER = "X-Oracle-Route";

	static volatile Router router;

	static volatile Route stamp;

	void capture(@Observes Router router) {
		RouterCapture.router = router;
		stamp = router.route().order(Integer.MIN_VALUE).handler(rc -> {
			rc.addHeadersEndHandler(v -> {
				if (rc.currentRoute() != null) rc.response().putHeader(HEADER, Integer.toString(System.identityHashCode(rc.currentRoute())));
			});
			rc.next();
		});
	}
}
