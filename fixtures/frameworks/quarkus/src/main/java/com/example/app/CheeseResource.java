package com.example.app;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("cheeses/{cheese}")
public class CheeseResource {

	@CHEESE
	public String hello(String cheese) {
		return "Hello, " + cheese;
	}

	@GET
	@Path("/")
	public String get(String cheese) {
		return cheese;
	}
}
