package com.example.app.data

import okhttp3.Interceptor
import okhttp3.Response

/** An application interceptor that adds the headers every request carries. */
class AuthInterceptor(private val token: () -> String?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request().newBuilder().header("Accept", "application/json")
        token()?.let { request.header("Authorization", "Bearer $it") }
        return chain.proceed(request.build())
    }
}
