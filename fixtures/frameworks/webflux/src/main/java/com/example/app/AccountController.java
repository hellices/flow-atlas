package com.example.app;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** API versions (the `API-Version` header, see WebConfiguration) select among the methods of one route. */
@RestController
@RequestMapping("/account/{id}")
public class AccountController {

	@GetMapping
	public Mono<String> getAccount(@PathVariable String id) {
		return Mono.just("any");
	}

	@GetMapping(version = "1.1")
	public Mono<String> getAccount1_1(@PathVariable String id) {
		return Mono.just("1.1");
	}

	@GetMapping(version = "1.2+")
	public Mono<String> getAccount1_2(@PathVariable String id) {
		return Mono.just("1.2+");
	}
}
