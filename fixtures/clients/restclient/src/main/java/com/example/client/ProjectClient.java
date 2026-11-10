package com.example.client;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.service.annotation.DeleteExchange;
import org.springframework.web.service.annotation.GetExchange;
import org.springframework.web.service.annotation.HttpExchange;
import org.springframework.web.service.annotation.PatchExchange;
import org.springframework.web.service.annotation.PostExchange;
import org.springframework.web.service.annotation.PutExchange;

@HttpExchange(url = "/projects", accept = "application/json")
public interface ProjectClient {

	@GetExchange
	ProjectPage listProjects(@RequestParam String owner);

	@GetExchange("/{id}")
	Project getProject(@PathVariable long id);

	@PostExchange(contentType = MediaType.APPLICATION_JSON_VALUE)
	Project createProject(@RequestBody ProjectForm form);

	@PutExchange("/{id}")
	Project updateProject(@PathVariable long id, @RequestBody ProjectForm form);

	@PatchExchange(url = "/{id}", contentType = MediaType.APPLICATION_FORM_URLENCODED_VALUE)
	void renameProject(@PathVariable long id, @RequestParam String name);

	@DeleteExchange("/{id}")
	void deleteProject(@PathVariable long id);

	@HttpExchange(method = "POST", url = "/{id}/members/{username}")
	void addMember(@PathVariable long id, @PathVariable String username, @RequestHeader("X-Request-Id") String requestId);

}
