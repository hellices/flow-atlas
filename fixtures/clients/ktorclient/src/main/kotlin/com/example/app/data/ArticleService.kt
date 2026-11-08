package com.example.app.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.plugins.resources.delete
import io.ktor.client.plugins.resources.get
import io.ktor.client.plugins.resources.post
import io.ktor.client.plugins.resources.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.resources.Resource

/** The articles API as typed resources (Ktor's Resources plugin): each class names a path, nested ones under it. */
@Resource("/articles")
class Articles(val sort: String? = "new") {
    @Resource("new")
    class New(val parent: Articles = Articles())

    @Resource("{id}")
    class Id(val parent: Articles = Articles(), val id: Long) {
        @Resource("edit")
        class Edit(val parent: Id)
    }
}

class ArticleService(private val client: HttpClient) {
    suspend fun articles(): ArticlePage = client.get(Articles()).body()

    suspend fun article(id: Long): Article = client.get(Articles.Id(id = id)).body()

    suspend fun newArticle(article: Article): Article =
        client.post(Articles.New()) {
            contentType(ContentType.Application.Json)
            setBody(article)
        }.body()

    suspend fun editArticle(id: Long, article: Article): Article =
        client.put(Articles.Id.Edit(Articles.Id(id = id))) {
            contentType(ContentType.Application.Json)
            setBody(article)
        }.body()

    suspend fun deleteArticle(id: Long): HttpResponse = client.delete(Articles.Id(id = id))
}
