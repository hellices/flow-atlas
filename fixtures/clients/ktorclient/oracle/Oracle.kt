import com.example.app.ApiConfig
import com.example.app.data.Article
import com.example.app.data.ArticleService
import com.example.app.data.NewUser
import com.example.app.data.UserPatch
import com.example.app.data.UserService
import com.example.app.data.apiClient
import io.ktor.client.HttpClient
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import java.lang.reflect.Modifier
import kotlin.system.exitProcess
import kotlinx.coroutines.runBlocking

/**
 * Makes every request the app's Ktor client services make, once. The app takes its base URL from its configuration
 * (`ApiConfig`); the oracle keeps that URL's path and points its origin at the recording server (RECORD_URL), as a build
 * for another host configures it, and builds the client as the app does (`apiClient`). It calls each public method of
 * each service with ARG for a string and ARG_NUMBER for a number, and fails unless it called every public method the
 * services declare.
 *
 *   java -cp "target/classes:target/test-classes:$(cat target/classpath.txt)" OracleKt
 */
fun main() {
    val record = Url(System.getenv("RECORD_URL"))
    val arg = System.getenv("ARG")
    val number = System.getenv("ARG_NUMBER")
    val base = URLBuilder(ApiConfig().apiBaseUrl).apply {
        protocol = record.protocol
        host = record.host
        port = record.port
    }.buildString()
    val client = apiClient(ApiConfig(apiBaseUrl = base))
    val users = UserService(client)
    val articles = ArticleService(client)

    val calls: Map<Class<*>, Map<String, suspend () -> Any>> = mapOf(
        UserService::class.java to mapOf(
            "user" to { users.user(arg) },
            "users" to { users.users(number.toInt(), arg) },
            "createUser" to { users.createUser(NewUser(arg, arg)) },
            "replaceUser" to { users.replaceUser(arg, NewUser(arg, arg)) },
            "renameUser" to { users.renameUser(arg, UserPatch(arg)) },
            "deleteUser" to { users.deleteUser(arg) },
            "userExists" to { check(users.userExists(arg)) },
            "uploadAvatar" to { users.uploadAvatar(arg, arg.toByteArray()) },
            "login" to { users.login(arg, arg) },
            "orderItems" to { users.orderItems(number.toLong()) },
            "health" to { users.health() },
        ),
        ArticleService::class.java to mapOf(
            "articles" to { articles.articles() },
            "article" to { articles.article(number.toLong()) },
            "newArticle" to { articles.newArticle(Article(arg, arg)) },
            "editArticle" to { articles.editArticle(number.toLong(), Article(arg, arg)) },
            "deleteArticle" to { articles.deleteArticle(number.toLong()) },
        ),
    )

    for ((service, methods) in calls) {
        val declared = service.declaredMethods
            .filter { Modifier.isPublic(it.modifiers) && !Modifier.isStatic(it.modifiers) && !it.isSynthetic }
            .map { it.name }
            .toSet()
        if (declared != methods.keys) {
            System.err.println("${service.simpleName} declares ${declared.sorted()}, the oracle calls ${methods.keys.sorted()}")
            exitProcess(1)
        }
        for ((name, call) in methods) {
            try {
                runBlocking { call() }
            } catch (e: Exception) {
                System.err.println("${service.simpleName}.$name: $e")
                exitProcess(1)
            }
        }
    }
    client.close()

    val jar = HttpClient::class.java.protectionDomain.codeSource.location.path.substringAfterLast('/')
    val version = jar.removePrefix("ktor-client-core-jvm-").removeSuffix(".jar")
    println("""{"library":"Ktor client","version":"$version"}""")
}
