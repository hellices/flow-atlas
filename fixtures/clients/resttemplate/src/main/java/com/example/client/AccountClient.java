package com.example.client;

import java.net.URI;
import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.restclient.RestTemplateBuilder;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class AccountClient {

	private final RestTemplate restTemplate;

	public AccountClient(RestTemplateBuilder builder, @Value("${api.base-url}") String baseUrl) {
		this.restTemplate = builder.rootUri(baseUrl).defaultHeader("X-Client", "accounts").build();
	}

	public Account getAccount(long id) {
		return this.restTemplate.getForObject("/accounts/{id}", Account.class, id);
	}

	public ResponseEntity<Account> findAccount(String email) {
		return this.restTemplate.getForEntity("/accounts/search?email={email}", Account.class, email);
	}

	public Account createAccount(AccountForm form) {
		return this.restTemplate.postForObject("/accounts", form, Account.class);
	}

	public URI registerAccount(AccountForm form) {
		return this.restTemplate.postForLocation("/accounts/registrations", form);
	}

	public void updateAccount(long id, AccountForm form) {
		this.restTemplate.put("/accounts/{id}", form, id);
	}

	public Account changePlan(long id, String plan) {
		return this.restTemplate.patchForObject("/accounts/{id}", Map.of("plan", plan), Account.class, id);
	}

	public void deleteAccount(long id) {
		this.restTemplate.delete("/accounts/{id}", id);
	}

	public void endSessions(long id) {
		this.restTemplate.exchange("/accounts/{id}/sessions", HttpMethod.DELETE, null, Void.class, id);
	}

	public Map<String, Object> accountRoles(long id, String token) {
		HttpHeaders headers = new HttpHeaders();
		headers.setBearerAuth(token);
		return this.restTemplate
			.exchange("/accounts/{id}/roles", HttpMethod.GET, new HttpEntity<>(headers),
					new ParameterizedTypeReference<Map<String, Object>>() {
					}, id)
			.getBody();
	}

	public HttpHeaders accountHeaders(long id) {
		return this.restTemplate.headForHeaders("/accounts/{id}", id);
	}

	public Map<?, ?> accountLimit(long id, String kind) {
		return this.restTemplate.getForObject("/accounts/{id}/limits/{kind}", Map.class, Map.of("id", id, "kind", kind));
	}

}
