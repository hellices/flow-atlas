package com.example.app.data

import com.example.app.ApiConfig
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import retrofit2.create

/** Builds the app's services, one Retrofit instance per base URL, as a dependency-injection module provides them. */
object NetworkModule {
    private val json = Json { ignoreUnknownKeys = true }

    /** Headers every request carries are set by an OkHttp interceptor, as Retrofit's guide says. */
    fun okHttpClient(token: () -> String?): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request().newBuilder().header("Accept", "application/json")
                token()?.let { request.header("Authorization", "Bearer $it") }
                chain.proceed(request.build())
            }
            .build()

    private fun retrofit(baseUrl: String, client: OkHttpClient): Retrofit =
        Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()

    fun userApi(config: ApiConfig, client: OkHttpClient): UserApi =
        retrofit(config.apiBaseUrl, client).create(UserApi::class.java)

    fun analyticsApi(config: ApiConfig, client: OkHttpClient): AnalyticsApi =
        retrofit(config.analyticsBaseUrl, client).create()
}
