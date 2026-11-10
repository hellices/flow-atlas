package com.example.app;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Mappings narrowed by media type, parameter and header: one path and method each, as far as the route goes. */
@RestController
@RequestMapping("/pets")
public class PetController {

	@PostMapping(path = "", consumes = "application/json")
	public void addPet(@RequestBody Map<String, Object> pet) {
	}

	@GetMapping(path = "/{petId}", produces = "application/json")
	public Map<String, Object> getPet(@PathVariable String petId) {
		return Map.of("id", petId);
	}

	@GetMapping(path = "/{petId}", params = "myParam=myValue")
	public Map<String, Object> findPetWithParam(@PathVariable String petId) {
		return Map.of("id", petId);
	}

	@GetMapping(path = "/{petId}", headers = "myHeader=myValue")
	public Map<String, Object> findPetWithHeader(@PathVariable String petId) {
		return Map.of("id", petId);
	}
}
