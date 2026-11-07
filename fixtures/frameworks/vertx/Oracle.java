import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.example.app.App;

import io.vertx.core.Vertx;
import io.vertx.core.http.HttpMethod;
import io.vertx.core.http.HttpServer;
import io.vertx.ext.web.Route;
import io.vertx.ext.web.Router;
import io.vertx.ext.web.RoutingContext;

/**
 * Asks Vert.x Web which routes the application serves. It builds the application's router as its main does and reads
 * the routes the router dispatches with, `Router.getRoutes()`, through Route's public API (`getPath()`, `methods()`,
 * `isExactPath()`, `isRegexPath()`), descending into each sub-router (`getSubRouter()`) under the path it is mounted at.
 * Each route is then confirmed by a request: a handler the oracle adds first to every router remembers the routing
 * context, and when the response's headers are written it names the route that was handling the request; a request the
 * router answers with its own 404 or 405 names none. Routes whose handlers only pass the request on (a body handler on
 * every path) are thus left out; a route that takes any method is written as `*` where it answers every method it is
 * requested with, else as the methods it answers (a static handler answers GET and HEAD); and a route ending in `*` is
 * written as the paths Vert.x dispatches to it: the path before the `*` with one segment and with several, and the path
 * before its last `/`, requested with that `/`.
 *
 *   java -cp "target/classes:$(cat target/classpath.txt)" Oracle.java
 */
public class Oracle {

	static final String ROUTE_HEADER = "X-Oracle-Route";

	static final String CONTEXT_KEY = "oracle.context";

	/** A `:name` parameter of a route path, optionally typed (`:id::integer`), as Vert.x Web documents them. */
	static final Pattern PARAM = Pattern.compile(":([A-Za-z0-9_]+)(?:::([A-Za-z0-9_]+))?");

	record Out(String method, String path, String raw) {
	}

	/** A route as the router reached it: its full path from the root router (null for any), and its methods. */
	record Found(Route route, String path, String raw, Set<HttpMethod> methods) {
	}

	static final Map<Route, String> IDS = new IdentityHashMap<>();

	public static void main(String[] args) throws Exception {
		PrintStream stdout = System.out;
		System.setOut(System.err);
		Vertx vertx = Vertx.vertx();
		Router router = App.router(vertx);
		List<Found> found = new ArrayList<>();
		List<Router> routers = new ArrayList<>();
		read(router, "", found, routers);
		for (int i = 0; i < found.size(); i++) IDS.put(found.get(i).route(), Integer.toString(i));
		router.route().order(Integer.MIN_VALUE).handler(Oracle::outermost);
		for (Router sub : routers.subList(1, routers.size())) sub.route().order(Integer.MIN_VALUE).handler(Oracle::inner);
		HttpServer server = vertx.createHttpServer().requestHandler(router).listen(0).toCompletionStage().toCompletableFuture().get();
		List<Out> routes = new ArrayList<>();
		try {
			HttpClient client = HttpClient.newHttpClient();
			String base = "http://127.0.0.1:" + server.actualPort();
			for (Found f : found) routes.addAll(confirmed(client, base, f));
		}
		finally {
			vertx.close().toCompletionStage().toCompletableFuture().get();
		}
		StringBuilder json = new StringBuilder();
		json.append("{\"framework\":\"vertx-web\",\"version\":").append(quote(version())).append(",\"routes\":[");
		for (int i = 0; i < routes.size(); i++) {
			Out r = routes.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(r.path()))
					.append(",\"raw\":").append(quote(r.raw())).append('}');
		}
		stdout.println(json.append("]}"));
		stdout.flush();
		System.exit(0);
	}

	/** The routes of a router and of the sub-routers it mounts, each sub-router's under its mount path. */
	static void read(Router router, String mount, List<Found> found, List<Router> routers) {
		routers.add(router);
		for (Route route : router.getRoutes()) {
			String path = route.getPath();
			if (path == null && route.isRegexPath()) throw new IllegalStateException("a regex route has no canonical form: " + route);
			String full = path == null ? null : mount + path;
			String raw = full == null ? null : full + (route.isExactPath() ? "" : "*");
			if (route.getSubRouter() != null) {
				if (full == null || route.isExactPath()) throw new IllegalStateException("a sub-router mounted without a path ending in *: " + route);
				read(route.getSubRouter(), full.substring(0, full.length() - 1), found, routers);
				continue;
			}
			found.add(new Found(route, full, raw, route.methods()));
		}
	}

	/** First on the root router: names the route handling the request when the response's headers are written. */
	static void outermost(RoutingContext ctx) {
		ctx.put(CONTEXT_KEY, ctx);
		ctx.addHeadersEndHandler(v -> {
			RoutingContext current = ctx.get(CONTEXT_KEY);
			Route route = current.currentRoute();
			String id = ctx.failed() || current.failed() || route == null ? null : IDS.get(route);
			if (id != null) ctx.response().putHeader(ROUTE_HEADER, id);
		});
		ctx.next();
	}

	/** First on each sub-router: the context its routes are handled in. */
	static void inner(RoutingContext ctx) {
		ctx.put(CONTEXT_KEY, ctx);
		ctx.next();
	}

	/** The methods a request is made with to find which ones a route that takes any method handles. */
	static final List<String> PROBES = List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS");

	/** The canonical routes of one route, each path requested and handled by that route. */
	static List<Out> confirmed(HttpClient client, String base, Found f) throws Exception {
		boolean exact = f.path() == null || f.route().isExactPath();
		String declared = f.path() == null ? "" : exact ? f.path() : f.path().substring(0, f.path().lastIndexOf('/'));
		String canonical = canonical(declared);
		String sample = sample(declared);
		// The requests that stand for the route: its path; or, after a `*` (or on any path), one segment and several,
		// named after the files the application serves statically, since the static handler passes on any other path.
		List<String> paths = exact && f.path() != null ? List.of(sample.isEmpty() ? "/" : sample) : List.of(sample + "/index.html", sample + "/css/site.css");
		List<String> methods = new ArrayList<>();
		if (f.methods() == null || f.methods().isEmpty()) {
			// A route that takes any method handles those its handler answers: all of them, or some (a static handler
			// answers GET and HEAD and passes on the others).
			for (String m : PROBES) if (handles(client, base, m, paths.get(0), f)) methods.add(m);
			if (methods.size() == PROBES.size()) methods = List.of("*");
		}
		else for (HttpMethod m : f.methods()) methods.add(m.name());
		List<Out> out = new ArrayList<>();
		if (methods.isEmpty()) {
			// A handler that passes every request on (a body handler) answers none: middleware, not a route.
			if (f.path() == null) return out;
			throw new IllegalStateException(paths.get(0) + " is not handled by the route " + f.raw());
		}
		String raw = f.raw() == null ? "(any path)" : f.raw();
		for (String method : methods) {
			for (String path : paths) expect(client, base, method, path, f);
			if (exact && f.path() != null) {
				out.add(new Out(method, canonical.isEmpty() ? "/" : canonical, raw));
				continue;
			}
			out.add(new Out(method, canonical + "/{**}", raw));
			// The path before the `*`'s `/`, requested with that `/`.
			if (handles(client, base, method, sample + "/", f)) out.add(new Out(method, canonical.isEmpty() ? "/" : canonical, raw));
		}
		return out;
	}

	/** A declared path in the canonical form: each `:name` (`:name::type`) is `{}`, no trailing `/` but on the root. */
	static String canonical(String path) {
		String s = PARAM.matcher(path).replaceAll("{}");
		while (s.length() > 1 && s.endsWith("/")) s = s.substring(0, s.length() - 1);
		return s;
	}

	/** A request path the declared path matches: each parameter is `1`, which every documented type but uuid takes. */
	static String sample(String path) {
		Matcher m = PARAM.matcher(path);
		StringBuilder s = new StringBuilder();
		while (m.find()) {
			if (m.group(2) != null && !m.group(2).equals("integer") && !m.group(2).equals("number")) {
				throw new IllegalStateException(path + ": no sample for a parameter of type " + m.group(2));
			}
			m.appendReplacement(s, "1");
		}
		m.appendTail(s);
		return s.toString();
	}

	static void expect(HttpClient client, String base, String method, String path, Found f) throws Exception {
		if (!handles(client, base, method, path, f)) {
			throw new IllegalStateException(method + " " + path + " is not handled by the route " + f.raw());
		}
	}

	/** Whether Vert.x Web hands the request to the route and the route answers it. */
	static boolean handles(HttpClient client, String base, String method, String path, Found f) throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create(base + path)).method(method, HttpRequest.BodyPublishers.noBody()).build();
		Optional<String> id = client.send(request, HttpResponse.BodyHandlers.ofString()).headers().firstValue(ROUTE_HEADER);
		return id.isPresent() && id.get().equals(IDS.get(f.route()));
	}

	static String version() {
		Package p = Router.class.getPackage();
		if (p.getImplementationVersion() != null) return p.getImplementationVersion();
		Matcher m = Pattern.compile("vertx-web-([^/]+)\\.jar$").matcher(Router.class.getProtectionDomain().getCodeSource().getLocation().getPath());
		if (!m.find()) throw new IllegalStateException("no Vert.x Web version");
		return m.group(1);
	}

	static String quote(String s) {
		StringBuilder out = new StringBuilder("\"");
		for (char c : s.toCharArray()) {
			switch (c) {
				case '"' -> out.append("\\\"");
				case '\\' -> out.append("\\\\");
				default -> {
					if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
					else out.append(c);
				}
			}
		}
		return out.append('"').toString();
	}

}
