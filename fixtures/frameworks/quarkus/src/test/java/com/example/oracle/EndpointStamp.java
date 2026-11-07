package com.example.oracle;

import jakarta.ws.rs.container.ContainerResponseContext;
import org.jboss.resteasy.reactive.server.ServerResponseFilter;
import org.jboss.resteasy.reactive.server.SimpleResourceInfo;

/** Names, on each response of a REST endpoint, the resource method that answered it. */
public class EndpointStamp {

	static final String HEADER = "X-Oracle-Endpoint";

	@ServerResponseFilter
	public void stamp(ContainerResponseContext response, SimpleResourceInfo info) {
		if (info != null) response.getHeaders().putSingle(HEADER, info.getResourceClass().getName() + "#" + info.getMethodName());
	}
}
