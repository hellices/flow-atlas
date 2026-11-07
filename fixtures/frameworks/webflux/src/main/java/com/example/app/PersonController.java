package com.example.app;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

@RestController
@RequestMapping("/persons")
public class PersonController {

	@GetMapping
	public Flux<Map<String, Object>> list() {
		return Flux.empty();
	}

	@GetMapping("/{id}")
	public Mono<Map<String, Object>> getPerson(@PathVariable Long id) {
		return Mono.just(Map.of("id", id));
	}

	@PostMapping
	@ResponseStatus(HttpStatus.CREATED)
	public Mono<Void> add(@RequestBody Mono<Map<String, Object>> person) {
		return Mono.empty();
	}

	@PutMapping("/{id}")
	public Mono<Void> replace(@PathVariable Long id) {
		return Mono.empty();
	}

	@PatchMapping("/{id}")
	public Mono<Void> update(@PathVariable Long id) {
		return Mono.empty();
	}

	@DeleteMapping("/{id}")
	@ResponseStatus(HttpStatus.NO_CONTENT)
	public Mono<Void> remove(@PathVariable Long id) {
		return Mono.empty();
	}
}
