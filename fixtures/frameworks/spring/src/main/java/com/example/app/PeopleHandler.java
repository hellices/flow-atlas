package com.example.app;

import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.function.ServerRequest;
import org.springframework.web.servlet.function.ServerResponse;

@Component
public class PeopleHandler {

	public ServerResponse listPeople(ServerRequest request) {
		return ServerResponse.ok().body(List.of());
	}

	public ServerResponse createPerson(ServerRequest request) {
		return ServerResponse.ok().build();
	}

	public ServerResponse getPerson(ServerRequest request) {
		return ServerResponse.ok().body(Map.of("id", request.pathVariable("id")));
	}
}
