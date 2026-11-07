package com.example.app;

import java.util.Map;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;

/** Served at the `@HttpExchange` mappings of the interface it implements. */
@RestController
public class MemberController implements MemberService {

	@Override
	public Mono<Map<String, Object>> getMember(@PathVariable Long id) {
		return Mono.just(Map.of("id", id));
	}

	@Override
	public Mono<Void> add(@RequestBody Map<String, Object> member) {
		return Mono.empty();
	}
}
