package com.example.app;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.ResponseBody;
import reactor.core.publisher.Mono;

/**
 * A plain `@Controller`: the `/api` prefix, which only `@RestController` types take, does not apply. `/pets/new` beside
 * `/pets/{petId}`: the more specific pattern wins, whatever the order of the methods.
 */
@Controller
@RequestMapping("/owners/{ownerId}")
public class PageController {

	@GetMapping("/pets/{petId}")
	@ResponseBody
	public Mono<String> findPet(@PathVariable String ownerId, @PathVariable String petId) {
		return Mono.just(ownerId + "/" + petId);
	}

	@GetMapping("/pets/new")
	@ResponseBody
	public Mono<String> newPet(@PathVariable String ownerId) {
		return Mono.just(ownerId + "/new");
	}

	@RequestMapping(path = {"/help", "/faq"}, method = {RequestMethod.GET, RequestMethod.POST})
	@ResponseBody
	public Mono<String> help() {
		return Mono.just("help");
	}

	@RequestMapping("/ping")
	@ResponseBody
	public Mono<String> ping() {
		return Mono.just("pong");
	}
}
