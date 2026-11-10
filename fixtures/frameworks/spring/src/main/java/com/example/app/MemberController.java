package com.example.app;

import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/** Served at the `@HttpExchange` mappings of the interface it implements. */
@RestController
public class MemberController implements MemberService {

	@Override
	public Map<String, Object> getMember(@PathVariable Long id) {
		return Map.of("id", id);
	}

	@Override
	@ResponseStatus(HttpStatus.CREATED)
	public void add(@RequestBody Map<String, Object> member) {
	}
}
