package com.example.app;

import java.util.Map;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.PostExchange;
import reactor.core.publisher.Mono;

@HttpExchange("/members")
public interface MemberService {

	@GetExchange("/{id}")
	Mono<Map<String, Object>> getMember(@PathVariable Long id);

	@PostExchange
	Mono<Void> add(@RequestBody Map<String, Object> member);
}
