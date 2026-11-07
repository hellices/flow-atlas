package com.example.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** API versions (the `API-Version` header, see WebConfiguration) select among the methods of one route. */
@RestController
@RequestMapping("/account/{id}")
public class AccountController {

	@GetMapping
	public String getAccount(@PathVariable String id) {
		return "any";
	}

	@GetMapping(version = "1.1")
	public String getAccount1_1(@PathVariable String id) {
		return "1.1";
	}

	@GetMapping(version = "1.2+")
	public String getAccount1_2(@PathVariable String id) {
		return "1.2+";
	}

	@GetMapping(version = "1.5")
	public String getAccount1_5(@PathVariable String id) {
		return "1.5";
	}
}
