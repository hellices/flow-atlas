package com.example.app

/** The settings a build gives the app, as an Android build's `BuildConfig` fields do: the API's base URL. */
data class ApiConfig(val apiBaseUrl: String = "https://api.example.com/api/v1/")
