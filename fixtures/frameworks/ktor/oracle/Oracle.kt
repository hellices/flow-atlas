import com.example.app.module
import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.plugin
import io.ktor.server.routing.ConstantParameterRouteSelector
import io.ktor.server.routing.HttpAcceptRouteSelector
import io.ktor.server.routing.HttpHeaderRouteSelector
import io.ktor.server.routing.HttpMethodRouteSelector
import io.ktor.server.routing.OptionalParameterRouteSelector
import io.ktor.server.routing.ParameterRouteSelector
import io.ktor.server.routing.PathSegmentConstantRouteSelector
import io.ktor.server.routing.PathSegmentOptionalParameterRouteSelector
import io.ktor.server.routing.PathSegmentParameterRouteSelector
import io.ktor.server.routing.PathSegmentRegexRouteSelector
import io.ktor.server.routing.PathSegmentTailcardRouteSelector
import io.ktor.server.routing.PathSegmentWildcardRouteSelector
import io.ktor.server.routing.RootRouteSelector
import io.ktor.server.routing.RoutePathComponent
import io.ktor.server.routing.RoutingNode
import io.ktor.server.routing.RoutingRoot
import io.ktor.server.routing.TrailingSlashRouteSelector
import io.ktor.server.routing.getAllRoutes
import io.ktor.server.testing.testApplication
import kotlin.system.exitProcess

/**
 * Asks Ktor which routes the application serves. It starts the application's module in Ktor's test engine
 * (`testApplication`), takes the routing tree Ktor dispatches with, `application.plugin(RoutingRoot)`, and its
 * `getAllRoutes()`, every node with a handler, and reads each node's selector chain from the root: path segments
 * (constants, `{param}` with its prefix and suffix, `{param?}`, `*`, `{...}`), the HTTP method, and the query parameters
 * and headers the route requires. Each path the chain stands for is then requested, and Ktor names the node it routed
 * the call to (`RoutingRoot.RoutingCallStarted`): a route is written only as the paths Ktor dispatches to that node. An
 * optional parameter or a tailcard, which may be missing, is requested with and without its segment.
 *
 *   java -cp "target/classes:target/test-classes:$(cat target/classpath.txt)" OracleKt
 */

data class Route(val method: String, val path: String, val raw: String)

/** One way a path component can stand: its canonical segments and the segments of a request it takes. */
data class Way(val canonical: List<String>, val sample: List<String>)

/** What a node's selector chain asks of a request: the ways each path component stands, the method, query, headers. */
class Chain(val raw: String) {
    val components = mutableListOf<List<Way>>()
    var method: String = "*"
    val query = mutableListOf<Pair<String, String>>()
    val headers = mutableListOf<Pair<String, String>>()
}

const val NODE_HEADER = "X-Oracle-Node"

fun nodeId(node: RoutingNode): String = Integer.toHexString(System.identityHashCode(node))

fun main() {
    val stdout = System.out
    System.setOut(System.err)
    val routes = mutableListOf<Route>()
    testApplication {
        lateinit var app: Application
        application {
            module()
            app = this
            monitor.subscribe(RoutingRoot.RoutingCallStarted) { call -> call.response.headers.append(NODE_HEADER, nodeId(call.route)) }
        }
        startApplication()
        for (node in app.plugin(RoutingRoot).getAllRoutes()) routes += confirmed(client, node, chain(node))
    }
    val core = RoutingRoot::class.java
    val version = core.`package`.implementationVersion
        ?: Regex("""ktor-server-core-jvm-([^/]+)\.jar$""").find(core.protectionDomain.codeSource.location.path)?.groupValues?.get(1)
        ?: error("no Ktor version")
    val json = StringBuilder("{\"framework\":\"ktor\",\"version\":").append(quote(version)).append(",\"routes\":[")
    routes.forEachIndexed { i, r ->
        if (i > 0) json.append(',')
        json.append("{\"method\":").append(quote(r.method)).append(",\"path\":").append(quote(r.path))
            .append(",\"raw\":").append(quote(r.raw)).append('}')
    }
    stdout.println(json.append("]}"))
    stdout.flush()
    exitProcess(0)
}

/** The selector chain from the root to a node, read selector by selector; a path selector of another kind fails. */
fun chain(node: RoutingNode): Chain {
    val selectors = generateSequence(node) { it.parent }.toList().reversed().map { it.selector }
    val chain = Chain(node.toString())
    for (selector in selectors) {
        if (chain.components.lastOrNull()?.any { it.canonical.lastOrNull() == "{**}" } == true && selector is RoutePathComponent) {
            error("${chain.raw}: a path segment after a tailcard has no canonical form")
        }
        when (selector) {
            is RootRouteSelector -> selector.toString().split('/').filter { it.isNotEmpty() }
                .forEach { chain.components += listOf(constant(it)) }
            is PathSegmentConstantRouteSelector -> chain.components += listOf(constant(selector.value))
            is PathSegmentParameterRouteSelector -> chain.components += listOf(param(selector.prefix, selector.suffix))
            is PathSegmentOptionalParameterRouteSelector -> chain.components += listOf(Way(emptyList(), emptyList()), param(selector.prefix, selector.suffix))
            PathSegmentWildcardRouteSelector -> chain.components += listOf(Way(listOf("{}"), listOf("w1")))
            is PathSegmentTailcardRouteSelector -> {
                if (selector.prefix.isNotEmpty()) error("${chain.raw}: a tailcard with a prefix has no canonical form")
                chain.components += listOf(Way(emptyList(), emptyList()), Way(listOf("{**}"), listOf("seg1", "seg2")))
            }
            // A path written with a trailing `/` (the root's `get("/")`) is requested with it and written without.
            TrailingSlashRouteSelector -> chain.components += listOf(Way(emptyList(), listOf("")))
            is PathSegmentRegexRouteSelector -> error("${chain.raw}: a regex route has no canonical form")
            is HttpMethodRouteSelector -> chain.method = selector.method.value
            is ParameterRouteSelector -> chain.query += selector.name to "1"
            is ConstantParameterRouteSelector -> chain.query += selector.name to selector.value
            is OptionalParameterRouteSelector -> Unit
            is HttpHeaderRouteSelector -> chain.headers += selector.name to selector.value
            is HttpAcceptRouteSelector -> chain.headers += "Accept" to selector.contentType.toString()
            // A path selector of a kind this oracle does not know fails it; other selectors (the static content's
            // fallback, authentication and the like) take no part of the path, as the requests below confirm.
            is RoutePathComponent -> error("${chain.raw}: unknown path selector $selector")
            else -> Unit
        }
    }
    return chain
}

fun constant(value: String): Way = Way(listOf(value), listOf(value))

fun param(prefix: String?, suffix: String?): Way =
    Way(listOf("${prefix.orEmpty()}{}${suffix.orEmpty()}"), listOf("${prefix.orEmpty()}p1${suffix.orEmpty()}"))

/**
 * The canonical paths of one node, each requested and routed by Ktor to that node. The path with every component
 * present must be; one without an optional component is written where Ktor routes it there too.
 */
suspend fun confirmed(client: HttpClient, node: RoutingNode, chain: Chain): List<Route> {
    val out = mutableListOf<Route>()
    val ways = chain.components.fold(listOf(emptyList<Way>())) { acc, options -> acc.flatMap { prefix -> options.map { prefix + it } } }
    val full = ways.last()
    for (way in ways) {
        val canonical = way.flatMap { it.canonical }
        val sample = way.flatMap { it.sample }
        val requests = mutableListOf(sample)
        // A tailcard is one segment or more: requested with one as well as two.
        if (canonical.lastOrNull() == "{**}") requests += sample.dropLast(1)
        val routed = requests.all { routes(client, node, chain, it) }
        if (way == full && !routed) error("${chain.method} /${sample.joinToString("/")} is not routed to ${chain.raw}")
        if (routed) out += Route(chain.method, "/" + canonical.joinToString("/"), chain.raw)
    }
    return out
}

/**
 * Whether Ktor routes a request for these segments, with the query and headers the chain asks for, to the node; for a
 * route that takes any method, requests of several methods.
 */
suspend fun routes(client: HttpClient, node: RoutingNode, chain: Chain, segments: List<String>): Boolean {
    val query = chain.query.joinToString("&") { (k, v) -> "$k=$v" }
    val url = "/" + segments.joinToString("/") + if (query.isEmpty()) "" else "?$query"
    val methods = if (chain.method == "*") listOf(HttpMethod.Get, HttpMethod.Post, HttpMethod.Delete) else listOf(HttpMethod.parse(chain.method))
    return methods.all { method ->
        val response = client.request(url) {
            this.method = method
            chain.headers.forEach { (k, v) -> header(k, v) }
        }
        response.headers[NODE_HEADER] == nodeId(node)
    }
}

fun quote(s: String): String {
    val out = StringBuilder("\"")
    for (c in s) {
        when {
            c == '"' -> out.append("\\\"")
            c == '\\' -> out.append("\\\\")
            c < ' ' -> out.append(String.format("\\u%04x", c.code))
            else -> out.append(c)
        }
    }
    return out.append('"').toString()
}
