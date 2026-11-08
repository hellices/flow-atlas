package com.example.client;

import java.util.Map;

import feign.Body;
import feign.Headers;
import feign.Param;
import feign.QueryMap;
import feign.RequestLine;

@Headers("Accept: application/json")
public interface RepoApi {

	@RequestLine("GET /repos/{owner}/{repo}")
	Repo getRepo(@Param("owner") String owner, @Param("repo") String repo);

	@RequestLine("GET /users/{owner}/repos?sort={sort}&page={page}")
	RepoPage listRepos(@Param("owner") String owner, @Param("sort") String sort, @Param("page") int page);

	@RequestLine("GET /search/repositories")
	RepoPage searchRepos(@QueryMap Map<String, Object> query);

	@RequestLine("POST /user/repos")
	@Headers("Content-Type: application/json")
	Repo createRepo(RepoForm form);

	@RequestLine("PATCH /repos/{owner}/{repo}")
	@Headers("Content-Type: application/json")
	Repo updateRepo(@Param("owner") String owner, @Param("repo") String repo, RepoForm form);

	@RequestLine("PUT /repos/{owner}/{repo}/topics")
	@Headers("Content-Type: application/json")
	@Body("%7B\"names\": [\"{topic}\"]%7D")
	void setTopic(@Param("owner") String owner, @Param("repo") String repo, @Param("topic") String topic);

	@RequestLine("DELETE /repos/{owner}/{repo}")
	@Headers("X-Request-Id: {requestId}")
	void deleteRepo(@Param("owner") String owner, @Param("repo") String repo, @Param("requestId") String requestId);

	@RequestLine("HEAD /repos/{owner}/{repo}/collaborators/{username}")
	void checkCollaborator(@Param("owner") String owner, @Param("repo") String repo, @Param("username") String username);

}
