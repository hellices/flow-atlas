package com.example.app.data

import com.example.app.ApiConfig
import java.io.IOException
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * The users API, at the configured base URL, through one shared OkHttpClient: requests built with `Request.Builder`,
 * their URLs written as strings after the base or built with `HttpUrl.Builder`, in the shapes OkHttp's recipes show.
 */
class UserRemoteDataSource(private val client: OkHttpClient, config: ApiConfig) {
    private val base = config.apiBaseUrl
    private val baseUrl: HttpUrl = config.apiBaseUrl.toHttpUrl()

    fun user(id: String): String {
        val request = Request.Builder()
            .url("$base/users/$id")
            .build()
        return execute(request)
    }

    fun users(page: Int, query: String): String {
        val url = baseUrl.newBuilder()
            .addPathSegment("users")
            .addQueryParameter("page", page.toString())
            .addQueryParameter("q", query)
            .build()
        return execute(Request.Builder().url(url).build())
    }

    fun createUser(json: String): String {
        val request = Request.Builder()
            .url("$base/users")
            .post(json.toRequestBody(JSON))
            .build()
        return execute(request)
    }

    fun replaceUser(id: String, json: String): String {
        val request = Request.Builder()
            .url("$base/users/$id")
            .put(json.toRequestBody(JSON))
            .build()
        return execute(request)
    }

    fun renameUser(id: String, json: String): String {
        val request = Request.Builder()
            .url("${base}/users/${id}")
            .method("PATCH", json.toRequestBody(JSON))
            .build()
        return execute(request)
    }

    fun deleteUser(id: String): String {
        val request = Request.Builder()
            .url(base + "/users/" + id)
            .delete()
            .build()
        return execute(request)
    }

    fun userExists(id: String): Boolean {
        val request = Request.Builder()
            .url("$base/users/$id")
            .head()
            .build()
        return client.newCall(request).execute().use { it.isSuccessful }
    }

    fun uploadAvatar(id: String, image: ByteArray): String {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("title", "avatar")
            .addFormDataPart("image", "avatar.png", image.toRequestBody(PNG))
            .build()
        val url = baseUrl.newBuilder()
            .addPathSegment("users")
            .addPathSegment(id)
            .addPathSegment("avatar")
            .build()
        return execute(Request.Builder().url(url).post(body).build())
    }

    fun login(username: String, password: String): String {
        val form = FormBody.Builder()
            .add("username", username)
            .add("password", password)
            .build()
        return execute(Request.Builder().url("$base/auth/token").post(form).build())
    }

    fun orderItems(orderId: Long): String {
        val url = HttpUrl.Builder()
            .scheme(baseUrl.scheme)
            .host(baseUrl.host)
            .port(baseUrl.port)
            .addPathSegments("api/orders")
            .addPathSegment(orderId.toString())
            .addPathSegment("items")
            .build()
        return execute(Request.Builder().url(url).build())
    }

    /** The server's health check, at the root of its host whatever the base URL's path. */
    fun health(): String = execute(Request.Builder().url(baseUrl.resolve("/health")!!).build())

    fun search(term: String): String = execute(Request.Builder().url("$base/search?q=$term").build())

    /** Refreshes a user on OkHttp's dispatcher threads, calling back with the response body. */
    fun refreshUser(id: String, onResult: (Result<String>) -> Unit) {
        val request = Request.Builder()
            .url("$base/users/$id/refresh")
            .post(ByteArray(0).toRequestBody())
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = onResult(Result.failure(e))

            override fun onResponse(call: Call, response: Response) {
                response.use { onResult(Result.success(it.body.string())) }
            }
        })
    }

    private fun execute(request: Request): String =
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("Unexpected code $response")
            response.body.string()
        }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val PNG = "image/png".toMediaType()

        /** The one client the app shares, as OkHttp's guide advises. */
        fun client(token: () -> String?): OkHttpClient =
            OkHttpClient.Builder()
                .addInterceptor(AuthInterceptor(token))
                .build()
    }
}
