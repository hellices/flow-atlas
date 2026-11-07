package com.example.app;

import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Get;

/** Reserved expansion (`+`): the variable takes `/` too, so the rest of the path. */
@Controller(value = "/files", produces = MediaType.TEXT_PLAIN)
public class FileController {

	@Get("/{+path}")
	public String file(String path) {
		return "file " + path;
	}
}
