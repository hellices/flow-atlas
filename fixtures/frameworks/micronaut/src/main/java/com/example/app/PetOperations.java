package com.example.app;

import io.micronaut.http.HttpStatus;
import io.micronaut.http.MediaType;
import io.micronaut.http.annotation.Body;
import io.micronaut.http.annotation.Get;
import io.micronaut.http.annotation.Post;
import io.micronaut.http.annotation.Status;

/** The routes of PetController, declared on the interface a declarative client could share. */
public interface PetOperations {

	@Get(value = "/{slug}", produces = MediaType.TEXT_PLAIN)
	String find(String slug);

	@Post(consumes = MediaType.TEXT_PLAIN, produces = MediaType.TEXT_PLAIN)
	@Status(HttpStatus.CREATED)
	String save(@Body String name);
}
