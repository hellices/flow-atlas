package com.example.app;

import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.ResponseBody;
import reactor.core.publisher.Mono;

/** Not a controller: HandlerRegistrationConfiguration registers its method with the handler mapping. */
@Component
public class UserHandler {

	@ResponseBody
	public Mono<String> getUser(@PathVariable Long id) {
		return Mono.just("user " + id);
	}
}
