package com.example.app;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseBody;

/** A plain `@Controller`: the `/api` prefix, which only `@RestController` types take, does not apply. */
@Controller
@RequestMapping("/owners/{ownerId}")
public class OwnerController {

	@GetMapping("/pets/{petId}")
	@ResponseBody
	public String findPet(@PathVariable Long ownerId, @PathVariable Long petId) {
		return ownerId + "/" + petId;
	}
}
