package com.example.app;

import io.micronaut.core.annotation.Nullable;
import io.micronaut.http.HttpStatus;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Controller;
import io.micronaut.http.annotation.Delete;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Patch;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Put;
import io.micronaut.http.annotation.Status;

/** Several methods on one path, and the URI template forms of the guide's matching table. */
@Controller(value = "/books", produces = MediaType.TEXT_PLAIN)
public class BookController {

	@Get
	public String list() {
		return "books";
	}

	@Post(consumes = MediaType.TEXT_PLAIN)
	@Status(HttpStatus.CREATED)
	public String add(@Body String book) {
		return book;
	}

	@Get("/{id}")
	public String show(Long id) {
		return "book " + id;
	}

	@Put(value = "/{id}", consumes = MediaType.TEXT_PLAIN)
	public String replace(Long id, @Body String book) {
		return book;
	}

	@Patch(value = "/{id}", consumes = MediaType.TEXT_PLAIN)
	public String update(Long id, @Body String book) {
		return book;
	}

	@Delete("/{id}")
	@Status(HttpStatus.NO_CONTENT)
	public void remove(Long id) {
	}

	/** At most two characters. */
	@Get("/shelf/{code:2}")
	public String shelf(String code) {
		return "shelf " + code;
	}

	/** An optional variable with a regular expression. */
	@Get("/genre{/name:[a-zA-Z]+}")
	public String genre(@Nullable String name) {
		return "genre " + name;
	}

	/** Query parameters are not part of the path. */
	@Get("/page{?max,offset}")
	public String page(@Nullable Integer max, @Nullable Integer offset) {
		return "page " + max + " " + offset;
	}
}
