package com.example.app;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

/** The annotations of a resource on the interface it implements. */
@Path("/greetings")
public interface GreetingApi {

	@GET
	@Path("{name}")
	String greet(String name);

	@POST
	String create(String greeting);
}
