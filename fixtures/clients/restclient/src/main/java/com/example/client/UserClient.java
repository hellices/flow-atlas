package com.example.client;

import java.util.Map;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

@Component
public class UserClient {

	private final RestClient restClient;

	public UserClient(RestClient.Builder builder, @Value("${api.base-url}") String baseUrl) {
		this.restClient = builder
			.baseUrl(baseUrl)
			.defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
			.requestInterceptor((request, body, execution) -> {
				request.getHeaders().set("X-Client", "users");
				return execution.execute(request, body);
			})
			.build();
	}

	public User getUser(long id) {
		return this.restClient.get()
			.uri("/users/{id}", id)
			.retrieve()
			.body(User.class);
	}

	public UserPage listUsers(String role, int page) {
		return this.restClient.get()
			.uri(builder -> builder.path("/users").queryParam("role", role).queryParam("page", page).build())
			.retrieve()
			.body(UserPage.class);
	}

	public User createUser(UserForm form) {
		return this.restClient.post()
			.uri("/users")
			.contentType(MediaType.APPLICATION_JSON)
			.body(form)
			.retrieve()
			.body(User.class);
	}

	public void replaceUser(long id, UserForm form) {
		this.restClient.put()
			.uri("/users/{id}", id)
			.contentType(MediaType.APPLICATION_JSON)
			.body(form)
			.retrieve()
			.toBodilessEntity();
	}

	public User renameUser(long id, String name) {
		return this.restClient.patch()
			.uri("/users/{id}", id)
			.contentType(MediaType.APPLICATION_JSON)
			.body(Map.of("name", name))
			.retrieve()
			.body(User.class);
	}

	public void deleteUser(long id) {
		this.restClient.delete()
			.uri("/users/{id}", id)
			.retrieve()
			.toBodilessEntity();
	}

	public boolean emailTaken(String email) {
		return this.restClient.head()
			.uri("/users/emails/{email}", email)
			.exchange((request, response) -> response.getStatusCode().is2xxSuccessful());
	}

	public String userPosts(String userId) {
		return this.restClient.get()
			.uri("/users/" + userId + "/posts")
			.retrieve()
			.body(String.class);
	}

	public String userAvatar(long id, int size) {
		return this.restClient.get()
			.uri(builder -> builder.path("/users/{id}/avatar").queryParam("size", size).build(id))
			.accept(MediaType.ALL)
			.retrieve()
			.body(String.class);
	}

	public Map<?, ?> userSettings(long id) {
		return this.restClient.get()
			.uri("/users/{id}/settings", id)
			.exchange((request, response) -> {
				if (response.getStatusCode().isError()) {
					throw new IllegalStateException("settings unavailable: " + response.getStatusCode());
				}
				return response.bodyTo(Map.class);
			});
	}

}
