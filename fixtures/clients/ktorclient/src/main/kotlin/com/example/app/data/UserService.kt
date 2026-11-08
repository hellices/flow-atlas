package com.example.app.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.submitForm
import io.ktor.client.request.get
import io.ktor.client.request.head
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.appendPathSegments
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.http.parameters

/** The users API, through the app's client: each request's path is relative to the client's base URL. */
class UserService(private val client: HttpClient) {
    suspend fun user(id: String): User = client.get("users/$id").body()

    suspend fun users(page: Int, query: String): UserPage =
        client.get("users") {
            url {
                parameters.append("page", page.toString())
                parameters.append("q", query)
            }
        }.body()

    suspend fun createUser(user: NewUser): User =
        client.post {
            url {
                appendPathSegments("users")
            }
            contentType(ContentType.Application.Json)
            setBody(user)
        }.body()

    suspend fun replaceUser(id: String, user: NewUser): User =
        client.put("users/$id") {
            contentType(ContentType.Application.Json)
            setBody(user)
        }.body()

    suspend fun renameUser(id: String, patch: UserPatch): User =
        client.request("users/${id}") {
            method = HttpMethod.Patch
            contentType(ContentType.Application.Json)
            setBody(patch)
        }.body()

    suspend fun deleteUser(id: String): HttpResponse = client.delete("users/" + id)

    suspend fun userExists(id: String): Boolean = client.head("users/$id").status.isSuccess()

    suspend fun uploadAvatar(id: String, image: ByteArray): HttpResponse =
        client.post("users/$id/avatar") {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append("description", "avatar")
                        append(
                            "image",
                            image,
                            Headers.build {
                                append(HttpHeaders.ContentType, "image/png")
                                append(HttpHeaders.ContentDisposition, "filename=\"avatar.png\"")
                            },
                        )
                    },
                ),
            )
        }

    suspend fun login(username: String, password: String): Token =
        client.submitForm(
            url = "auth/token",
            formParameters = parameters {
                append("username", username)
                append("password", password)
            },
        ).body()

    suspend fun orderItems(orderId: Long): HttpResponse =
        client.get {
            url {
                appendPathSegments("orders", orderId.toString(), "items")
            }
        }

    /** The server's health check, at the root of its host whatever the base URL's path. */
    suspend fun health(): HttpResponse = client.get("/health")
}
