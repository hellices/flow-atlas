package com.example.app;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

/** The guide's endpoint: a parameter and a constrained one, beside a method with no path of its own. */
@Path("hello")
public class HelloResource {

	@Path("{name}/{age:\\d+}")
	@GET
	public String personalisedHello(String name, int age) {
		return "Hello " + name + " is your age really " + age + "?";
	}

	@GET
	public String genericHello() {
		return "Hello stranger";
	}
}
