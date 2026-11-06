package com.example.app

class BffApi(private val client: HttpClient) {
    suspend fun attach(bytes: ByteArray) = client.post("/uploads") { setBody(bytes) }

    suspend fun ask(text: String): HttpResponse {
        val response = client.post("/messages") { setBody(text) }
        if (response.status == HttpStatusCode.ServiceUnavailable) throw BffUnavailable("/messages")
        check(response.status.isSuccess()) { "POST /messages answered ${response.status}" }
        return response
    }
}

/** A BFF request the BFF answered 503 for: temporarily unavailable, worth a retry. */
class BffUnavailable(path: String) : Exception("POST $path is temporarily unavailable")
