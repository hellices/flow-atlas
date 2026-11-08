import com.example.app.ApiConfig
import com.example.app.data.AnalyticsApi
import com.example.app.data.Event
import com.example.app.data.NetworkModule
import com.example.app.data.NewUser
import com.example.app.data.RevokeSessions
import com.example.app.data.UserApi
import com.example.app.data.UserPatch
import java.lang.reflect.Modifier
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.Retrofit

/**
 * Makes every request the app's Retrofit services make, once. The app takes each service's base URL from its
 * configuration (`ApiConfig`); the oracle keeps each base URL's path and points its origin at the recording server
 * (RECORD_URL), as a build for another host configures it, and builds the services as the app does (`NetworkModule`).
 * It calls each method of each service interface with ARG for a string and ARG_NUMBER for a number, and fails unless
 * it called every method the interfaces declare.
 *
 *   java -cp "target/classes:target/test-classes:$(cat target/classpath.txt)" OracleKt
 */
fun main() {
    val record = System.getenv("RECORD_URL").toHttpUrl()
    val arg = System.getenv("ARG")
    val number = System.getenv("ARG_NUMBER")
    fun recorded(url: String) =
        url.toHttpUrl().newBuilder().scheme(record.scheme).host(record.host).port(record.port).build().toString()

    val defaults = ApiConfig()
    val config = ApiConfig(apiBaseUrl = recorded(defaults.apiBaseUrl), analyticsBaseUrl = recorded(defaults.analyticsBaseUrl))
    val client = NetworkModule.okHttpClient { arg }
    val users = NetworkModule.userApi(config, client)
    val analytics = NetworkModule.analyticsApi(config, client)
    val text = "text/plain".toMediaType()

    val calls: Map<Class<*>, Map<String, suspend () -> Unit>> = mapOf(
        UserApi::class.java to mapOf(
            "users" to { users.users(number.toInt(), arg) },
            "user" to { users.user(arg) },
            "createUser" to { users.createUser(NewUser(arg, arg)) },
            "replaceUser" to { users.replaceUser(arg, NewUser(arg, arg)) },
            "renameUser" to { users.renameUser(arg, UserPatch(arg)) },
            "deleteUser" to { users.deleteUser(arg) },
            "userExists" to { users.userExists(arg) },
            "revokeSessions" to { users.revokeSessions(arg, RevokeSessions(arg)) },
            "groupUsers" to { users.groupUsers(number.toLong()) },
            "page" to { users.page(arg) },
            "health" to { users.health() },
            "token" to { users.token(arg, arg) },
            "uploadPhoto" to {
                users.uploadPhoto(arg, MultipartBody.Part.createFormData("photo", arg, arg.toRequestBody(text)), arg.toRequestBody(text))
            },
            "repos" to { users.repos(arg, arg).execute() },
        ),
        AnalyticsApi::class.java to mapOf(
            "report" to { analytics.report(number.toInt()) },
            "track" to { analytics.track(Event(arg)) },
        ),
    )

    for ((api, methods) in calls) {
        val declared = api.declaredMethods.filter { !Modifier.isStatic(it.modifiers) && !it.isSynthetic }.map { it.name }.toSet()
        if (declared != methods.keys) {
            System.err.println("${api.simpleName} declares ${declared.sorted()}, the oracle calls ${methods.keys.sorted()}")
            exitProcess(1)
        }
        for ((name, call) in methods) {
            try {
                runBlocking { call() }
            } catch (e: Exception) {
                System.err.println("${api.simpleName}.$name: $e")
                exitProcess(1)
            }
        }
    }
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()

    val jar = Retrofit::class.java.protectionDomain.codeSource.location.path.substringAfterLast('/')
    val version = jar.removePrefix("retrofit-").removeSuffix(".jar")
    println("""{"library":"Retrofit","version":"$version"}""")
}
