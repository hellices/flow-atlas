package com.example.app;

import io.micronaut.http.annotation.Controller;

@Controller("/pets")
public class PetController implements PetOperations {

	@Override
	public String find(String slug) {
		return "pet " + slug;
	}

	@Override
	public String save(String name) {
		return name;
	}
}
