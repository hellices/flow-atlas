package com.example.app;

import io.javalin.apibuilder.CrudHandler;
import io.javalin.http.Context;

public class ArticleController implements CrudHandler {

	@Override
	public void getAll(Context ctx) {
		ctx.result("articles");
	}

	@Override
	public void getOne(Context ctx, String articleId) {
		ctx.result("article " + articleId);
	}

	@Override
	public void create(Context ctx) {
		ctx.status(201);
	}

	@Override
	public void update(Context ctx, String articleId) {
		ctx.status(204);
	}

	@Override
	public void delete(Context ctx, String articleId) {
		ctx.status(204);
	}

}
