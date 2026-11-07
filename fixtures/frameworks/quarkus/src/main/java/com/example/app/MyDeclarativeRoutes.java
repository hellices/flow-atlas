package com.example.app;

import io.quarkus.vertx.web.Param;
import io.quarkus.vertx.web.Route;
import io.quarkus.vertx.web.Route.HttpMethod;
import io.quarkus.vertx.web.RoutingExchange;
import io.vertx.ext.web.RoutingContext;
import jakarta.enterprise.context.ApplicationScoped;

/** Reactive routes: Vert.x Web paths, not under the REST root. */
@ApplicationScoped
public class MyDeclarativeRoutes {

	// neither path nor regex is set - match a path derived from the method name
	@Route(methods = HttpMethod.GET)
	void hello(RoutingContext rc) {
		rc.response().end("hello");
	}

	// no methods: any method
	@Route(path = "/world")
	String helloWorld() {
		return "Hello world!";
	}

	@Route(path = "/greetings", methods = HttpMethod.GET)
	void greetingsQueryParam(RoutingExchange ex) {
		ex.ok("hello " + ex.getParam("name").orElse("world"));
	}

	@Route(path = "/greetings/:name", methods = HttpMethod.GET)
	void greetingsPathParam(@Param String name, RoutingExchange ex) {
		ex.ok("hello " + name);
	}

	@Route(path = "/first", methods = HttpMethod.POST)
	@Route(path = "/second", methods = {HttpMethod.PUT, HttpMethod.DELETE})
	void route(RoutingContext rc) {
		rc.response().end("routed");
	}

	@Route(path = "/accounts/:id", methods = HttpMethod.GET, order = 2)
	void getAccount(RoutingContext rc) {
		rc.response().end("account " + rc.pathParam("id"));
	}

	@Route(path = "/accounts/me", methods = HttpMethod.GET, order = 1)
	void getCurrentUserAccount(RoutingContext rc) {
		rc.response().end("me");
	}

	/** Vert.x's trailing `*`: the path and everything under it. */
	@Route(path = "/assets/*", methods = HttpMethod.GET)
	void assets(RoutingContext rc) {
		rc.response().end("asset " + rc.pathParam("*"));
	}
}
