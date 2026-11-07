package com.example.app;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.server.ServerRequest;
import org.springframework.web.reactive.function.server.ServerResponse;
import reactor.core.publisher.Mono;

@Component
public class PersonHandler {

	public Mono<ServerResponse> listPeople(ServerRequest request) {
		return ServerResponse.ok().bodyValue(List.of());
	}

	public Mono<ServerResponse> createPerson(ServerRequest request) {
		return ServerResponse.ok().build();
	}

	public Mono<ServerResponse> getPerson(ServerRequest request) {
		return ServerResponse.ok().bodyValue(Map.of("id", request.pathVariable("id")));
	}
}
