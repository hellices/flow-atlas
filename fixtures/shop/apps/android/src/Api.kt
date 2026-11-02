package shop.android

class Api(private val http: HttpClient, private val baseUrl: String) {
    suspend fun create() = http.post("$baseUrl/orders") { }
    suspend fun home() = http.get("$baseUrl/screens/home")
}
