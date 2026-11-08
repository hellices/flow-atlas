package com.example.app.data

import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

/** The analytics service, at its own base URL (`analyticsBaseUrl`). */
interface AnalyticsApi {
    @GET("reports/{year}")
    suspend fun report(@Path("year") year: Int): Report

    @POST("events")
    suspend fun track(@Body event: Event): Report
}
