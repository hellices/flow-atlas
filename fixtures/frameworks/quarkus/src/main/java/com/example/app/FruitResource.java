package com.example.app;

import jakarta.ws.rs.DELETE;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.PATCH;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.PUT;
import jakarta.ws.rs.Path;

/** Several methods on one path, and URI parameters constrained by regular expressions. */
@Path("/fruits")
public class FruitResource {

	@GET
	public String list() {
		return "fruits";
	}

	@POST
	public String add(String fruit) {
		return fruit;
	}

	@GET
	@Path("{id: \\d+}")
	public String get(long id) {
		return "fruit " + id;
	}

	@PUT
	@Path("{id: \\d+}")
	public String replace(long id, String fruit) {
		return fruit;
	}

	@PATCH
	@Path("{id: \\d+}")
	public String update(long id, String fruit) {
		return fruit;
	}

	@DELETE
	@Path("{id: \\d+}")
	public void remove(long id) {
	}

	@GET
	@Path("{name: [a-z]+}-{version}.json")
	public String release(String name, String version) {
		return name + " " + version;
	}

	/** A sub-resource locator: SeedResource serves the rest of the path. */
	@Path("{id: \\d+}/seeds")
	public SeedResource seeds(long id) {
		return new SeedResource(id);
	}
}
