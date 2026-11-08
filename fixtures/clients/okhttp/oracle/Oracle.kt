import com.example.app.ApiConfig
import com.example.app.data.UserRemoteDataSource
import java.lang.reflect.Modifier
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.system.exitProcess
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttp

/**
 * Makes every request the app's OkHttp data source makes, once. The app takes its base URL from its configuration
 * (`ApiConfig`); the oracle keeps that URL's path and points its origin at the recording server (RECORD_URL), as a build
 * for another host configures it, and shares one client built as the app builds it. It calls each public method with
 * ARG for a string and ARG_NUMBER for a number, waits for the asynchronous call's callback, and fails unless it called
 * every public method the data source declares.
 *
 *   java -cp "target/classes:target/test-classes:$(cat target/classpath.txt)" OracleKt
 */
fun main() {
    val record = System.getenv("RECORD_URL").toHttpUrl()
    val arg = System.getenv("ARG")
    val number = System.getenv("ARG_NUMBER")
    val base = ApiConfig().apiBaseUrl.toHttpUrl().newBuilder().scheme(record.scheme).host(record.host).port(record.port).build()
    val config = ApiConfig(apiBaseUrl = base.toString())
    val client = UserRemoteDataSource.client { arg }
    val users = UserRemoteDataSource(client, config)

    val calls: Map<String, () -> Any> = mapOf(
        "user" to { users.user(arg) },
        "users" to { users.users(number.toInt(), arg) },
        "createUser" to { users.createUser("""{"name":"$arg"}""") },
        "replaceUser" to { users.replaceUser(arg, """{"name":"$arg"}""") },
        "renameUser" to { users.renameUser(arg, """{"name":"$arg"}""") },
        "deleteUser" to { users.deleteUser(arg) },
        "userExists" to { check(users.userExists(arg)) },
        "uploadAvatar" to { users.uploadAvatar(arg, arg.toByteArray()) },
        "login" to { users.login(arg, arg) },
        "orderItems" to { users.orderItems(number.toLong()) },
        "health" to { users.health() },
        "search" to { users.search(arg) },
        "refreshUser" to {
            val done = CompletableFuture<String>()
            users.refreshUser(arg) { result -> result.fold(done::complete, done::completeExceptionally) }
            done.get(30, TimeUnit.SECONDS)
        },
    )

    val declared = UserRemoteDataSource::class.java.declaredMethods
        .filter { Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) && !it.isSynthetic }
        .map { it.name }
        .toSet()
    if (declared != calls.keys) {
        System.err.println("UserRemoteDataSource declares ${declared.sorted()}, the oracle calls ${calls.keys.sorted()}")
        exitProcess(1)
    }
    for ((name, call) in calls) {
        try {
            call()
        } catch (e: Exception) {
            System.err.println("UserRemoteDataSource.$name: $e")
            exitProcess(1)
        }
    }
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
    println("""{"library":"OkHttp","version":"${OkHttp.VERSION}"}""")
}
