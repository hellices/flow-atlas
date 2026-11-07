package com.example.app;

import io.javalin.http.Context;
import io.javalin.http.sse.SseClient;

public final class UserController {

	private UserController() {
	}

	public static void getAllUsers(Context ctx) {
		ctx.result("users");
	}

	public static void createUser(Context ctx) {
		ctx.status(201);
	}

	public static void getUser(Context ctx) {
		ctx.result("user " + ctx.pathParam("id"));
	}

	public static void updateUser(Context ctx) {
		ctx.status(204);
	}

	public static void deleteUser(Context ctx) {
		ctx.status(204);
	}

	public static void events(SseClient client) {
		client.sendEvent("users");
	}

}
