package com.example.client;

import feign.Feign;
import feign.gson.GsonDecoder;
import feign.gson.GsonEncoder;
import feign.http2client.Http2Client;

/** The application's API clients, each bound to the base URL its settings name. */
public final class Clients {

	private Clients() {
	}

	public static RepoApi repoApi(Settings settings) {
		return Feign.builder()
			.client(new Http2Client())
			.encoder(new GsonEncoder())
			.decoder(new GsonDecoder())
			.requestInterceptor((template) -> template.header("X-Client", "repos"))
			.target(RepoApi.class, settings.baseUrl());
	}

	public static AdminApi adminApi(Settings settings) {
		return Feign.builder()
			.client(new Http2Client())
			.decoder(new GsonDecoder())
			.target(AdminApi.class, settings.baseUrl() + "/admin");
	}

}
