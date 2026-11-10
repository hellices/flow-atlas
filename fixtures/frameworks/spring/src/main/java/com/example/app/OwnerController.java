package com.example.app;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;

/**
 * A plain `@Controller`: the `/api` prefix, which only `@RestController` types take, does not apply. `/pets/new` beside
 * `/pets/{petId}`: the more specific pattern wins, whatever the order of the methods.
 */
@Controller
@RequestMapping("/owners/{ownerId}")
public class OwnerController {

	@GetMapping("/pets/{petId}")
	@ResponseBody
	public String findPet(@PathVariable Long ownerId, @PathVariable Long petId) {
		return ownerId + "/" + petId;
	}

	@GetMapping("/pets/new")
	@ResponseBody
	public String newPet(@PathVariable Long ownerId) {
		return ownerId + "/new";
	}
}
