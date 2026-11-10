package com.example.app;

import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.web.servlet.function.RequestPredicates.GET;
import static org.springframework.web.servlet.function.RequestPredicates.accept;
import static org.springframework.web.servlet.function.RequestPredicates.contentType;
import static org.springframework.web.servlet.function.RequestPredicates.param;
import static org.springframework.web.servlet.function.RouterFunctions.route;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.RouterFunctions;
import org.springframework.web.servlet.function.ServerResponse;

/** Functional endpoints (WebMvc.fn): router function beans the RouterFunctionMapping dispatches to. */
@Configuration
public class RouterConfiguration {

	@Bean
	public RouterFunction<ServerResponse> peopleRoutes(PeopleHandler handler) {
		RouterFunction<ServerResponse> otherRoute = route(GET("/hello-world"), request -> ServerResponse.ok().body("Hello World"));
		return route()
				.GET("/people/{id}", accept(APPLICATION_JSON), handler::getPerson)
				.GET("/people", accept(APPLICATION_JSON), handler::listPeople)
				.POST("/people", handler::createPerson)
				.add(otherRoute)
				.build();
	}

	@Bean
	public RouterFunction<ServerResponse> teamRoutes(PeopleHandler handler) {
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

	/** Routes a request reaches only with a query parameter, with a Content-Type, or with a variable its regex takes. */
	@Bean
	public RouterFunction<ServerResponse> searchRoutes(PeopleHandler handler) {
		return route()
				.GET("/search", param("type", "person"), handler::listPeople)
				.POST("/imports", contentType(APPLICATION_JSON), handler::createPerson)
				.GET("/tags/{tag:[a-z]+}", request -> ServerResponse.ok().body(request.pathVariable("tag")))
				.build();
	}

	@Bean
	public RouterFunction<ServerResponse> fileRoutes() {
		return RouterFunctions.resources("/files/**", new ClassPathResource("files/"));
	}
}
