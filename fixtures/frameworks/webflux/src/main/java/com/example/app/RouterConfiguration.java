package com.example.app;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.web.reactive.function.server.RequestPredicates.GET;
import static org.springframework.web.reactive.function.server.RequestPredicates.POST;
import static org.springframework.web.reactive.function.server.RequestPredicates.accept;
import static org.springframework.web.reactive.function.server.RequestPredicates.path;
import static org.springframework.web.reactive.function.server.RouterFunctions.nest;
import static org.springframework.web.reactive.function.server.RouterFunctions.route;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.web.reactive.function.server.RouterFunction;
import org.springframework.web.reactive.function.server.RouterFunctions;
import org.springframework.web.reactive.function.server.ServerResponse;

/** Functional endpoints (WebFlux.fn): router function beans the RouterFunctionMapping dispatches to. */
@Configuration
public class RouterConfiguration {

	@Bean
	public RouterFunction<ServerResponse> peopleRoutes(PersonHandler handler) {
		RouterFunction<ServerResponse> otherRoute = route(GET("/hello-world"), request -> ServerResponse.ok().bodyValue("Hello World"));
		return route()
				.GET("/people/{id}", accept(APPLICATION_JSON), handler::getPerson)
				.GET("/people", accept(APPLICATION_JSON), handler::listPeople)
				.POST("/people", handler::createPerson)
				.add(otherRoute)
				.build();
	}

	@Bean
	public RouterFunction<ServerResponse> teamRoutes(PersonHandler handler) {
		return route()
				.path("/teams", b1 -> b1
						.nest(accept(APPLICATION_JSON), b2 -> b2
								.GET("/{id}", handler::getPerson)
								.GET(handler::listPeople))
						.POST(handler::createPerson)
						.PUT("/{id}", handler::createPerson)
						.DELETE("/{id}", handler::createPerson))
				.filter((request, next) -> next.handle(request))
				.build();
	}

	/** The static composition: `nest` on a path predicate, `andRoute`, and predicates combined with `and` and `or`. */
	@Bean
	public RouterFunction<ServerResponse> orderRoutes(PersonHandler handler) {
		return nest(path("/orders"),
				route(GET("/{id}"), handler::getPerson)
						.andRoute(GET("/{id}/items").or(GET("/{id}/lines")), handler::listPeople)
						.andRoute(POST("").and(accept(APPLICATION_JSON)), handler::createPerson));
	}

	@Bean
	public RouterFunction<ServerResponse> fileRoutes() {
		return RouterFunctions.resources("/files/**", new ClassPathResource("files/"));
	}
}
