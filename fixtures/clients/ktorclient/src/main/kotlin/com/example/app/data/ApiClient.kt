package com.example.app.data

import com.example.app.ApiConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.resources.Resources
import io.ktor.client.request.header
import io.ktor.http.HttpHeaders
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * The app's one HttpClient. Its default request carries the configured base URL, which ends in `/` as Ktor's guide
 * says it must: a request's relative path (`users/1`) is resolved after the base's path, and one starting with `/`
 * replaces it.
 */
fun apiClient(config: ApiConfig): HttpClient =
    HttpClient(OkHttp) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
        install(Resources)
        defaultRequest {
            url(config.apiBaseUrl)
            header(HttpHeaders.Accept, "application/json")
        }
    }
