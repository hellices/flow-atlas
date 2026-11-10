package com.example.app;

import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.PathVariable;

/** URI path variables of the guide: required, renamed, and optional with a default. */
@Controller(value = "/issues", produces = MediaType.TEXT_PLAIN)
public class IssuesController {

	@Get("/{number}")
	public String issue(Integer number) {
		return "Issue # " + number + "!";
	}

	@Get("/issue/{number}")
	public String issueFromId(@PathVariable("number") Integer id) {
		return "Issue # " + id + "!";
	}

	@Get("/default{/number}")
	public String issueFromIdOrDefault(@PathVariable(defaultValue = "0") Integer number) {
		return "Issue # " + number + "!";
	}
}
