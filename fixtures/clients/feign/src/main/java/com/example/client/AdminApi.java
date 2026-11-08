package com.example.client;

import feign.Param;
import feign.RequestLine;

public interface AdminApi {

	@RequestLine("GET /members/{id}")
	Member getMember(@Param("id") long id);

	@RequestLine("POST /members/{id}/suspension")
	void suspendMember(@Param("id") long id);

	@RequestLine("DELETE /members/{id}/sessions")
	void endSessions(@Param("id") long id);

}
