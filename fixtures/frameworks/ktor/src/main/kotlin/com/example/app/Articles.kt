package com.example.app

import io.ktor.resources.Resource
import io.ktor.server.resources.delete
import io.ktor.server.resources.get
import io.ktor.server.resources.put
import io.ktor.server.resources.post
import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import kotlinx.serialization.Serializable

@Serializable
@Resource("/articles")
class Articles(val sort: String? = "new") {

    @Serializable
    @Resource("new")
    class New(val parent: Articles = Articles())

    @Serializable
    @Resource("{id}")
    class Id(val parent: Articles = Articles(), val id: Long) {

        @Serializable
        @Resource("edit")
        class Edit(val parent: Id)
    }
}

@Serializable
@Resource("/search")
class Search(val q: String, val page: Int = 1)

fun Route.articleRoutes() {
    get<Articles> { articles -> call.respondText("articles sorted by ${articles.sort}") }
    get<Articles.New> { call.respondText("new article form") }
    post<Articles> { call.respondText("created") }
    get<Articles.Id> { article -> call.respondText("article ${article.id}") }
    put<Articles.Id> { article -> call.respondText("updated ${article.id}") }
    delete<Articles.Id> { article -> call.respondText("deleted ${article.id}") }
    get<Articles.Id.Edit> { edit -> call.respondText("edit ${edit.parent.id}") }
    get<Search> { search -> call.respondText("results for ${search.q}") }
}
