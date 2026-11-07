package com.example.app;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;

/** Not a root resource: FruitResource's locator returns it for `/fruits/{id}/seeds`. */
public class SeedResource {

	private final long fruit;

	public SeedResource(long fruit) {
		this.fruit = fruit;
	}

	@GET
	public String list() {
		return "seeds of " + fruit;
	}

	@POST
	public String add(String seed) {
		return seed;
	}

	@GET
	@Path("{seed}")
	public String get(String seed) {
		return "seed " + seed + " of " + fruit;
	}
}
