package com.example.app

/** The settings a build gives the app, as an Android build's `BuildConfig` fields do: each service's base URL. */
data class ApiConfig(
    val apiBaseUrl: String = "https://api.example.com/api/v1/",
    val analyticsBaseUrl: String = "https://api.example.com/analytics/v2/",
)
