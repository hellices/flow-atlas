import java.io.PrintStream;
import java.lang.reflect.Field;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse.BodyHandlers;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;

import io.micronaut.context.ApplicationContext;
import io.micronaut.core.version.VersionUtils;
import io.micronaut.http.HttpMethod;
import io.micronaut.http.HttpRequest;
import io.micronaut.http.HttpRequestWrapper;
import io.micronaut.runtime.server.EmbeddedServer;
import io.micronaut.web.router.DefaultRouter;
import io.micronaut.web.router.Router;
import io.micronaut.web.router.UriRouteInfo;
import io.micronaut.web.router.UriRouteMatch;
import io.micronaut.web.router.resource.StaticResourceConfiguration;

/**
 * Asks Micronaut which routes the application serves: it starts the application's embedded server (on a random port)
 * and reads the routes of its Router bean, the table the server dispatches every request with (`uriRoutes()`:
 * controllers' annotated methods, routes built with a RouteBuilder, the management endpoints). Each URI template
 * (RFC 6570) is written out as the paths it takes, each path checked against the route's own matcher, routed by the
 * Router to that route (`findAllClosest`) and confirmed by a request the server answers with neither 404 nor 405. The
 * static resources the server serves where no route matches (`micronaut.router.static-resources.*`) are read from
 * their configuration, each method confirmed by a request for a file the fixture ships.
 *
 *   java -cp "target/classes:$(cat target/classpath.txt)" Oracle.java
 */
public class Oracle {

	record Route(String method, String path, String raw) {
	}

	/** A path a template takes: in the canonical form, and a request path for it. */
	record Variant(String path, String sample) {
	}

	static final HttpClient HTTP = HttpClient.newHttpClient();

	public static void main(String[] args) throws Exception {
		PrintStream stdout = System.out;
		System.setOut(System.err);
		List<Route> routes = new ArrayList<>();
		try (EmbeddedServer server = ApplicationContext.run(EmbeddedServer.class, Map.of("micronaut.server.port", -1))) {
			Router router = server.getApplicationContext().getBean(Router.class);
			// uriRoutes() streams a route once for each table the router files it in.
			for (UriRouteInfo<?, ?> route : router.uriRoutes().distinct().toList()) read(server, router, route, routes);
			for (StaticResourceConfiguration statics : server.getApplicationContext().getBeansOfType(StaticResourceConfiguration.class)) {
				if (statics.isEnabled()) readStatic(server, statics.getMapping(), routes);
			}
		}
		StringBuilder json = new StringBuilder();
		json.append("{\"framework\":\"micronaut\",\"version\":").append(quote(VersionUtils.MICRONAUT_VERSION)).append(",\"routes\":[");
		for (int i = 0; i < routes.size(); i++) {
			Route r = routes.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(r.path()))
					.append(",\"raw\":").append(quote(r.raw())).append('}');
		}
		stdout.println(json.append("]}"));
		System.exit(0);
	}

	static void read(EmbeddedServer server, Router router, UriRouteInfo<?, ?> route, List<Route> routes) throws Exception {
		if (route.getPort() != null) throw new IllegalStateException("a route bound to a port is not in the form: " + route);
		String method = route.getHttpMethod() == HttpMethod.CUSTOM ? customName(router, route) : route.getHttpMethodName();
		String raw = route.getUriMatchTemplate().toString();
		for (Variant variant : variants(raw, sample -> route.match(sample).isPresent())) {
			if (route.match(variant.sample()).isEmpty()) throw new IllegalStateException(raw + " does not match " + variant.sample());
			HttpRequest<Object> created = HttpRequest.create(HttpMethod.parse(method), variant.sample());
			// A request of a non-standard method by its name, as the server's requests tell it.
			HttpRequest<?> request = new HttpRequestWrapper<>(created) {
				@Override
				public String getMethodName() {
					return method;
				}
			};
			List<UriRouteMatch<Object, Object>> matched = router.findAllClosest(request);
			if (matched.stream().noneMatch(m -> m.getRouteInfo() == route)) {
				throw new IllegalStateException("the router routes " + method + " " + variant.sample() + " elsewhere than " + raw + ": " + matched);
			}
			int status = request(server, method, variant.sample());
			if (status == 404 || status == 405) throw new IllegalStateException(method + " " + variant.sample() + " answers " + status);
			routes.add(new Route(method, variant.path(), raw));
		}
	}

	/**
	 * The name of a non-standard method (`@CustomHttpMethod`): a route keeps only HttpMethod.CUSTOM, and the
	 * DefaultRouter dispatches by the name it files the route under (`allRoutesByMethod`), which it tells by no public
	 * method.
	 */
	static String customName(Router router, UriRouteInfo<?, ?> route) throws ReflectiveOperationException {
		Field field = DefaultRouter.class.getDeclaredField("allRoutesByMethod");
		field.setAccessible(true);
		for (Map.Entry<?, ?> entry : ((Map<?, ?>) field.get(router)).entrySet()) {
			for (Object filed : (Object[]) entry.getValue()) if (filed == route) return (String) entry.getKey();
		}
		throw new IllegalStateException("the router files no " + route);
	}

	/**
	 * The paths a URI template takes, as UriMatchTemplate reads RFC 6570: `{name}` (`{name:2}` at most two characters,
	 * `{name:regex}`) a part of one segment; `{/name}` an optional segment, so the path without it and with it;
	 * `{+name}` reserved expansion, the rest of the path, slashes included, where it stands for whole segments at the
	 * end (the path before it too where the route's matcher takes that); `{?a,b}` and `{&a}` query parameters, no part
	 * of the path. Another form fails the oracle rather than being guessed. A sample value is found for each variable
	 * that the route's own matcher accepts, and a variable whose matcher takes a `/` fails the oracle too.
	 */
	static List<Variant> variants(String raw, Predicate<String> matches) {
		List<List<Variant>> parts = new ArrayList<>();
		int i = 0;
		while (i < raw.length()) {
			int open = raw.indexOf('{', i);
			if (open < 0) open = raw.length();
			if (open > i) parts.add(List.of(new Variant(raw.substring(i, open), raw.substring(i, open))));
			if (open == raw.length()) break;
			int close = raw.indexOf('}', open);
			String expr = raw.substring(open + 1, close);
			char op = expr.charAt(0);
			String rest = raw.substring(close + 1);
			boolean wholeSegment = open > 0 && raw.charAt(open - 1) == '/' && (rest.isEmpty() || rest.startsWith("/"));
			switch (op) {
				case '?', '&' -> {
				}
				case '/' -> parts.add(List.of(new Variant("", ""), new Variant("/{}", "/\0")));
				case '+' -> {
					if (!wholeSegment || !rest.isEmpty()) throw new IllegalStateException("reserved expansion other than at the end: " + raw);
					parts.add(List.of(new Variant("{**}", "\0/\0")));
				}
				default -> {
					if (!Character.isLetterOrDigit(op) && op != '_') throw new IllegalStateException("no reading for {" + expr + "} in " + raw);
					if (expr.contains(",")) throw new IllegalStateException("no reading for {" + expr + "} in " + raw);
					parts.add(List.of(new Variant("{}", "\0")));
				}
			}
			i = close + 1;
		}
		List<Variant> out = List.of(new Variant("", ""));
		for (List<Variant> part : parts) {
			List<Variant> next = new ArrayList<>();
			for (Variant a : out) for (Variant b : part) next.add(new Variant(a.path() + b.path(), a.sample() + b.sample()));
			out = next;
		}
		List<Variant> result = new ArrayList<>();
		for (Variant v : out) {
			String path = canonical(v.path());
			String sample = sample(v.sample(), matches).orElseThrow(() -> new IllegalStateException("no request path " + raw + " takes as " + path));
			if (v.sample().contains("\0") && !v.path().contains("{**}") && sample(v.sample().replace("\0", "\0/\0"), matches).isPresent()) {
				throw new IllegalStateException("a variable of " + raw + " takes a `/`: not in the form");
			}
			result.add(new Variant(path, sample));
			if (path.endsWith("/{**}")) {
				String parent = path.substring(0, path.length() - "/{**}".length());
				String head = v.sample().substring(0, v.sample().length() - "/\0/\0".length());
				if (matches.test(head.isEmpty() ? "/" : head) || matches.test(head + "/")) {
					result.add(new Variant(parent.isEmpty() ? "/" : parent, head.isEmpty() ? "/" : head));
				}
			}
		}
		return result;
	}

	/** The sample with each variable (`\0`) a value the route's matcher accepts: `1`, else `a`, else `ab`. */
	static Optional<String> sample(String sample, Predicate<String> matches) {
		for (String value : List.of("1", "a", "ab")) {
			String path = sample.replace("\0", value);
			if (path.isEmpty()) path = "/";
			if (matches.test(path)) return Optional.of(path);
		}
		return Optional.empty();
	}

	static String canonical(String path) {
		path = path.replaceAll("/+$", "");
		return path.isEmpty() ? "/" : path.startsWith("/") ? path : "/" + path;
	}

	/**
	 * Static resources: the mapping is an Ant-style pattern (`/static/**`), its `**` the rest of the path. The server
	 * looks a file up for a request no route takes, whatever its method; each method is confirmed by a request for
	 * site.css, which the fixture ships (`*` where the standard ones and a made-up one all are), and the path before
	 * `/**` by a request for it.
	 */
	static void readStatic(EmbeddedServer server, String mapping, List<Route> routes) throws Exception {
		if (!mapping.endsWith("/**") || mapping.substring(0, mapping.length() - 3).matches(".*[*?{].*")) {
			throw new IllegalStateException("no reading for the static resource mapping " + mapping);
		}
		String head = mapping.substring(0, mapping.length() - 3);
		List<String> methods = new ArrayList<>();
		List<String> all = List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "FETCH");
		for (String method : all) if (request(server, method, head + "/site.css") == 200) methods.add(method);
		if (methods.size() == all.size()) methods = List.of("*");
		for (String method : methods) {
			routes.add(new Route(method, canonical(head + "/{**}"), mapping));
			String probe = method.equals("*") ? "GET" : method;
			if (request(server, probe, head.isEmpty() ? "/" : head) == 200) routes.add(new Route(method, canonical(head), mapping));
		}
	}

	static int request(EmbeddedServer server, String method, String path) throws Exception {
		java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(URI.create(server.getURL() + path))
				.method(method, BodyPublishers.noBody()).build();
		return HTTP.send(request, BodyHandlers.discarding()).statusCode();
	}

	static String quote(String s) {
		StringBuilder out = new StringBuilder("\"");
		for (char c : s.toCharArray()) {
			if (c == '"' || c == '\\') out.append('\\').append(c);
			else if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
			else out.append(c);
		}
		return out.append('"').toString();
	}
}
