package com.example.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.WebClient;

@Configuration(proxyBeanMethods = false)
public class ClientConfig {

	@Bean
	WebClient orderWebClient(@Value("${api.base-url}") String baseUrl) {
		return WebClient.builder()
			.baseUrl(baseUrl)
			.defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
			.filter((request, next) -> next.exchange(ClientRequest.from(request).header("X-Client", "orders").build()))
			.build();
	}

}
