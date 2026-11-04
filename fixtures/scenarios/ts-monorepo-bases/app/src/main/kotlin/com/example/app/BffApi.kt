package com.example.app

class BffApi(private val client: HttpClient) {
    suspend fun attach(bytes: ByteArray) = client.post("/uploads") { setBody(bytes) }

    suspend fun ask(text: String) = client.post("/messages") { setBody(text) }
}
