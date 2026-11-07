import java.io.PrintStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;

import com.example.app.App;

import io.javalin.Javalin;
import io.javalin.compression.CompressionStrategy;
import io.javalin.config.RouterConfig;
import io.javalin.http.Context;
import io.javalin.http.staticfiles.Location;
import io.javalin.http.staticfiles.ResourceHandler;
import io.javalin.http.staticfiles.StaticFileConfig;
import io.javalin.jetty.JettyResourceHandler;
import io.javalin.router.ParsedEndpoint;
import io.javalin.router.matcher.PathParser;
import io.javalin.router.matcher.PathSegment;
import io.javalin.security.RouteRole;

/**
 * Asks Javalin which routes the application serves. It creates the application as its main does, then reads the
 * endpoints Javalin's router dispatches HTTP requests with (`InternalRouter.allHttpHandlers()`, the list the bundled
 * RouteOverviewPlugin prints), each endpoint's path split by Javalin's own PathParser. Each route is then confirmed by a
 * request: the handler wrapper Javalin calls around every endpoint names the endpoint that answered. A `<param>` or `*`
 * segment, which may take slashes or nothing, is requested with one segment, with two and with none, and is written as
 * what Javalin dispatched to that endpoint. Static files are served by the resource handler, not by an endpoint: the
 * oracle records the static file configurations Javalin hands its resource handler and requests a file under each.
 *
 *   java -cp "target/classes:$(cat target/classpath.txt)" Oracle.java
 */
public class Oracle {

	static final String ENDPOINT_HEADER = "X-Oracle-Endpoint";

	record Route(String method, String path, String raw) {
	}

	/** Javalin's default resource handler, recording each static file configuration Javalin hands it. */
	static final class RecordingResourceHandler implements ResourceHandler {

		final ResourceHandler delegate = new JettyResourceHandler();

		final List<StaticFileConfig> configs = new ArrayList<>();

		@Override
		public void init(CompressionStrategy strategy) {
			delegate.init(strategy);
		}

		@Override
		public boolean canHandle(Context ctx) {
			return delegate.canHandle(ctx);
		}

		@Override
		public boolean handle(Context ctx) {
			return delegate.handle(ctx);
		}

		@Override
		public boolean addStaticFileConfig(StaticFileConfig config) {
			configs.add(config);
			return delegate.addStaticFileConfig(config);
		}

		@Override
		public Set<RouteRole> resourceRouteRoles(Context ctx) {
			return delegate.resourceRouteRoles(ctx);
		}

	}

	public static void main(String[] args) throws Exception {
		PrintStream stdout = System.out;
		System.setOut(System.err);
		RecordingResourceHandler resources = new RecordingResourceHandler();
		Javalin app = Javalin.create(config -> {
			config.resourceHandler(resources);
			config.startup.showJavalinBanner = false;
			App.configure(config);
			config.router.handlerWrapper(endpoint -> ctx -> {
				ctx.header(ENDPOINT_HEADER, endpoint.method.name() + " " + endpoint.path);
				endpoint.handler.handle(ctx);
			});
		});
		List<Route> routes = new ArrayList<>();
		app.start("127.0.0.1", 0);
		try {
			HttpClient client = HttpClient.newHttpClient();
			String base = "http://127.0.0.1:" + app.port();
			RouterConfig router = app.unsafe.router;
			List<ParsedEndpoint> endpoints = app.unsafe.internalRouter.allHttpHandlers();
			for (ParsedEndpoint parsed : endpoints) {
				String method = parsed.endpoint.method.name();
				String raw = parsed.endpoint.path;
				routes.addAll(confirmed(client, base, method, raw, new PathParser(raw, router).getSegments()));
			}
			for (StaticFileConfig config : resources.configs) routes.add(staticRoute(client, base, config));
		}
		finally {
			app.stop();
		}
		StringBuilder json = new StringBuilder();
		json.append("{\"framework\":\"javalin\",\"version\":").append(quote(Javalin.class.getPackage().getImplementationVersion()))
				.append(",\"routes\":[");
		for (int i = 0; i < routes.size(); i++) {
			Route r = routes.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(r.path()))
					.append(",\"raw\":").append(quote(r.raw())).append('}');
		}
		json.append("]}");
		stdout.println(json);
		stdout.flush();
		System.exit(0);
	}

	/**
	 * The canonical paths of one endpoint, each requested and answered by that endpoint. A segment that may take slashes
	 * (`<param>`, `*`) is only expressible as the last one; anywhere else the oracle fails rather than guess.
	 */
	static List<Route> confirmed(HttpClient client, String base, String method, String raw, List<PathSegment> segments)
			throws Exception {
		List<String> request = new ArrayList<>();
		List<String> canonical = new ArrayList<>();
		for (int i = 0; i < segments.size(); i++) {
			PathSegment segment = segments.get(i);
			boolean last = i == segments.size() - 1;
			if (slashAccepting(segment)) {
				if (!last) throw new IllegalStateException(raw + ": a segment that takes slashes before the last one has no canonical form");
				return lastSegment(client, base, method, raw, request, canonical);
			}
			request.add(sample(segment, raw));
			canonical.add(form(segment, raw));
		}
		String path = join(canonical);
		String url = join(request);
		expect(client, base, method, url, raw);
		return List.of(new Route(method, path, raw));
	}

	/** A last segment that may take slashes: written as what Javalin dispatches to this endpoint. */
	static List<Route> lastSegment(HttpClient client, String base, String method, String raw, List<String> request,
			List<String> canonical) throws Exception {
		String one = join(append(request, "seg1"));
		String two = join(append(request, "seg1/seg2"));
		String none = join(request);
		expect(client, base, method, one, raw);
		List<Route> out = new ArrayList<>();
		boolean many = answers(client, base, method, two, raw);
		out.add(new Route(method, join(append(canonical, many ? "{**}" : "{}")), raw));
		// The parent, and the parent with its last `/`, which Javalin may take as the same path.
		String slashed = none.equals("/") ? none : none + "/";
		if (answers(client, base, method, none, raw) || answers(client, base, method, slashed, raw)) {
			out.add(new Route(method, join(canonical), raw));
		}
		return out;
	}

	static Route staticRoute(HttpClient client, String base, StaticFileConfig config) throws Exception {
		if (config.location != Location.CLASSPATH) throw new IllegalStateException("only classpath static files are requested: " + config.directory);
		String hosted = config.hostedPath.equals("/") ? "" : config.hostedPath;
		// A file in a subdirectory, so the static route takes more than one segment.
		HttpResponse<String> response = send(client, base, "GET", hosted + "/css/site.css");
		if (response.statusCode() != 200 || response.headers().firstValue(ENDPOINT_HEADER).isPresent()) {
			throw new IllegalStateException("GET " + hosted + "/css/site.css is not served from " + config.directory + ": " + response.statusCode());
		}
		return new Route("GET", (hosted.isEmpty() ? "" : hosted) + "/{**}", config.hostedPath + " -> " + config.directory);
	}

	static boolean slashAccepting(PathSegment segment) {
		return segment instanceof PathSegment.Wildcard || segment instanceof PathSegment.Parameter.SlashAcceptingParameter;
	}

	/** A value Javalin's matcher takes for the segment. */
	static String sample(PathSegment segment, String raw) {
		if (segment instanceof PathSegment.Normal normal) return normal.getContent();
		if (segment instanceof PathSegment.Parameter.SlashIgnoringParameter) return "p1";
		if (segment instanceof PathSegment.MultipleSegments multiple) {
			StringBuilder s = new StringBuilder();
			int n = 0;
			for (PathSegment inner : multiple.getInnerSegments()) {
				if (inner instanceof PathSegment.Normal normal) s.append(normal.getContent());
				else if (inner instanceof PathSegment.Parameter.SlashIgnoringParameter) s.append("p").append(++n);
				else throw new IllegalStateException(raw + ": a segment part " + inner + " has no canonical form");
			}
			return s.toString();
		}
		throw new IllegalStateException(raw + ": unknown path segment " + segment);
	}

	/** The segment in the canonical form: a parameter, wherever it stands in the segment, is `{}`. */
	static String form(PathSegment segment, String raw) {
		if (segment instanceof PathSegment.Normal normal) return normal.getContent();
		if (segment instanceof PathSegment.Parameter.SlashIgnoringParameter) return "{}";
		if (segment instanceof PathSegment.MultipleSegments multiple) {
			StringBuilder s = new StringBuilder();
			for (PathSegment inner : multiple.getInnerSegments()) {
				s.append(inner instanceof PathSegment.Normal normal ? normal.getContent() : "{}");
			}
			return s.toString();
		}
		throw new IllegalStateException(raw + ": unknown path segment " + segment);
	}

	static List<String> append(List<String> list, String last) {
		List<String> out = new ArrayList<>(list);
		out.add(last);
		return out;
	}

	static String join(List<String> segments) {
		return segments.isEmpty() ? "/" : "/" + String.join("/", segments);
	}

	static void expect(HttpClient client, String base, String method, String path, String raw) throws Exception {
		if (!answers(client, base, method, path, raw)) {
			throw new IllegalStateException(method + " " + path + " is not answered by the endpoint " + method + " " + raw);
		}
	}

	/** Whether Javalin dispatches the request to the endpoint `method raw`. */
	static boolean answers(HttpClient client, String base, String method, String path, String raw) throws Exception {
		Optional<String> endpoint = send(client, base, method, path).headers().firstValue(ENDPOINT_HEADER);
		return endpoint.isPresent() && endpoint.get().equals(method + " " + raw);
	}

	static HttpResponse<String> send(HttpClient client, String base, String method, String path) throws Exception {
		HttpRequest request = HttpRequest.newBuilder(URI.create(base + path)).method(method, HttpRequest.BodyPublishers.noBody()).build();
		return client.send(request, HttpResponse.BodyHandlers.ofString());
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
