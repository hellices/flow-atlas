package com.example.app;

import io.micronaut.http.HttpResponse;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.CustomHttpMethod;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Head;
import io.micronaut.http.annotation.Trace;

/** A controller with no path of its own (`/`), the remaining method annotations, and a non-standard method. */
@Controller(produces = MediaType.TEXT_PLAIN)
public class RootController {

	@Get
	public String index() {
		return "index";
	}

	@Head("/ping")
	public HttpResponse<?> ping() {
		return HttpResponse.ok();
	}

	@Trace("/trace")
	public String trace() {
		return "trace";
	}

	@CustomHttpMethod(method = "LOCK", value = "/locks/{name}")
	public String lock(String name) {
		return "locked " + name;
	}
}
