package com.example.app;

import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

/** Multiple URIs: one route for each template. */
@Controller(value = "/hello", produces = MediaType.TEXT_PLAIN)
public class GreetingController {

	@Get(uris = {"/{name}", "/person/{name}"})
	public String hello(String name) {
		return "Hello, " + name;
	}
}
