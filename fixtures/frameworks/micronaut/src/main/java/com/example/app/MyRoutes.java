package com.example.app;

import io.micronaut.context.ExecutionHandleLocator;
import io.micronaut.web.router.DefaultRouteBuilder;
import jakarta.inject.Inject;
import jakarta.inject.Singleton;

/** Routes built programmatically: the full path, as the route knows nothing of the controller's `@Controller`. */
@Singleton
public class MyRoutes extends DefaultRouteBuilder {

	public MyRoutes(ExecutionHandleLocator executionHandleLocator, UriNamingStrategy uriNamingStrategy) {
		super(executionHandleLocator, uriNamingStrategy);
	}

	@Inject
	void issuesRoutes(IssuesController issuesController) {
		GET("/issues/show/{number}", issuesController, "issue", Integer.class);
	}
}
