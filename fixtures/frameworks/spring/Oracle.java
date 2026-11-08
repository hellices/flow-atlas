import java.io.PrintStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.function.Function;

import com.example.app.Application;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.server.PathContainer;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.converter.StringHttpMessageConverter;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.servlet.DispatcherServlet;
import org.springframework.web.servlet.HandlerMapping;
import org.springframework.web.servlet.function.HandlerFunction;
import org.springframework.web.servlet.function.RequestPredicate;
import org.springframework.web.servlet.function.RequestPredicates;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.RouterFunctions;
import org.springframework.web.servlet.function.ServerRequest;
import org.springframework.web.servlet.function.ServerResponse;
import org.springframework.web.servlet.function.support.RouterFunctionMapping;
import org.springframework.web.servlet.handler.AbstractHandlerMethodMapping;
import org.springframework.web.servlet.handler.AbstractUrlHandlerMapping;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.support.WebContentGenerator;
import org.springframework.web.util.ServletRequestPathUtils;
import org.springframework.web.util.pattern.PathPattern;
import org.springframework.web.util.pattern.PathPatternParser;

/**
 * Asks Spring MVC which routes the application serves: it starts the application (on a random port), takes the
 * DispatcherServlet's handler mappings, the table it dispatches every request through, and reads each one through its
 * public API: the RequestMappingInfo of each handler method (annotated controllers, explicit registrations, the error
 * controller, the actuator's endpoints), the URL patterns of the URL handler mappings (static resources), and the
 * router function of WebMvc.fn through RouterFunctions.Visitor, each route of which is then confirmed by a request the
 * router function answers with a handler. A mapping of another kind fails the oracle rather than being left out.
 * Last, sample requests are sent through the DispatcherServlet, each recorded with the route it dispatched it to.
 *
 *   java -cp "target/classes:$(cat target/classpath.txt)" Oracle.java
 */
public class Oracle {

	record Route(String method, String raw) {
	}

	record Request(String method, String path, String route) {
	}

	/** The resource lookups of router functions (`RouterFunctions.resources`), by the pattern each serves. */
	static final Map<String, Function<ServerRequest, Optional<Resource>>> LOOKUPS = new java.util.LinkedHashMap<>();

	public static void main(String[] args) throws Exception {
		PrintStream stdout = System.out;
		System.setOut(System.err);
		ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class).run(
				"--server.port=0", "--spring.main.banner-mode=off", "--logging.level.root=WARN",
				"--logging.level.org.springframework.web.servlet.mvc.support=ERROR",
				"--spring.mvc.servlet.load-on-startup=1");
		List<Route> routes = new ArrayList<>();
		List<Request> requests;
		try {
			DispatcherServlet servlet = context.getBean(DispatcherServlet.class);
			List<HandlerMapping> mappings = servlet.getHandlerMappings();
			if (mappings == null) throw new IllegalStateException("the DispatcherServlet has not been initialized");
			for (HandlerMapping mapping : mappings) read(mapping, routes);
			requests = dispatch(servlet, routes);
		}
		finally {
			SpringApplication.exit(context);
		}
		StringBuilder json = new StringBuilder();
		json.append("{\"framework\":\"spring-boot\",\"version\":").append(quote(SpringBootVersion.getVersion())).append(",\"routes\":[");
		for (int i = 0; i < routes.size(); i++) {
			Route r = routes.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(canonical(r.raw())))
					.append(",\"raw\":").append(quote(r.raw())).append('}');
		}
		json.append("],\"requests\":[");
		for (int i = 0; i < requests.size(); i++) {
			Request r = requests.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(r.path()))
					.append(",\"route\":").append(r.route() == null ? "null" : quote(r.route())).append('}');
		}
		stdout.println(json.append("]}"));
		System.exit(0);
	}

	static void read(HandlerMapping mapping, List<Route> routes) {
		if (mapping instanceof AbstractHandlerMethodMapping<?> methods) {
			for (Object key : methods.getHandlerMethods().keySet()) {
				if (!(key instanceof RequestMappingInfo info)) throw new IllegalStateException("unknown mapping " + key);
				if (info.getPathPatternsCondition() == null) throw new IllegalStateException("not a PathPattern mapping: " + info);
				Set<RequestMethod> verbs = info.getMethodsCondition().getMethods();
				for (PathPattern pattern : info.getPathPatternsCondition().getPatterns()) {
					if (verbs.isEmpty()) add(routes, "*", pattern);
					else for (RequestMethod verb : verbs) add(routes, verb.name(), pattern);
				}
			}
		}
		else if (mapping instanceof AbstractUrlHandlerMapping urls) {
			if (!urls.getHandlerMap().isEmpty() && urls.getPathPatternHandlerMap().isEmpty()) {
				throw new IllegalStateException("not a PathPattern mapping: " + urls.getClass().getName());
			}
			if (urls.getRootHandler() != null) add(routes, PathPatternParser.defaultInstance.parse("/"), urls.getRootHandler());
			urls.getPathPatternHandlerMap().forEach((pattern, handler) -> add(routes, pattern, handler));
		}
		else if (mapping instanceof RouterFunctionMapping functions) {
			RouterFunction<?> function = functions.getRouterFunction();
			if (function != null) routes.addAll(new FunctionRoutes(function).read());
		}
		else if (!mapping.getClass().getName().endsWith("WelcomePageNotAcceptableHandlerMapping")) {
			throw new IllegalStateException("no reading for the handler mapping " + mapping.getClass().getName());
		}
	}

	/**
	 * Sample requests, and the route Spring MVC dispatches each to: every route's sample path, also with a trailing `/`,
	 * and a path no route takes, each with every method a route registers (see `methodsAt`), sent through the DispatcherServlet. The route
	 * is told by the pattern the handler mapping that took the request exposes (BEST_MATCHING_PATTERN_ATTRIBUTE: the
	 * handler method's mapping, the URL handler's pattern, the router function's matching pattern). No handler, a 405 from
	 * the handler chosen, or a route that does not serve the method (see `route`), is no route.
	 */
	static List<Request> dispatch(DispatcherServlet servlet, List<Route> routes) throws Exception {
		// HEAD and OPTIONS only where a route registers them on their own: the compared form leaves out the HEAD beside a
		// GET and the OPTIONS beside another method of the same path, which the framework answers by itself.
		Map<String, Set<String>> methodsAt = new java.util.HashMap<>();
		for (Route r : routes) methodsAt.computeIfAbsent(canonical(r.raw()), p -> new TreeSet<>()).add(r.method());
		Set<String> methods = new TreeSet<>();
		Set<String> samples = new TreeSet<>();
		for (Route r : routes) {
			Set<String> beside = methodsAt.get(canonical(r.raw()));
			boolean answered = (r.method().equals("HEAD") && beside.contains("GET")) || (r.method().equals("OPTIONS") && beside.size() > 1);
			if (!r.method().equals("*") && !answered) methods.add(r.method());
			String path = sample(r.raw()).replaceAll("/+$", "");
			samples.add(path.isEmpty() ? "/" : path);
		}
		Set<String> probes = new TreeSet<>(samples);
		for (String path : samples) if (!path.equals("/")) probes.add(path + "/");
		probes.add("/nowhere/value1");
		List<Request> out = new ArrayList<>();
		for (String path : probes) {
			for (String method : methods) {
				MockHttpServletRequest request = new MockHttpServletRequest(servlet.getServletContext(), method, path);
				if (!method.equals("GET") && !method.equals("DELETE")) {
					request.setContentType("application/json");
					request.setContent("{}".getBytes());
				}
				MockHttpServletResponse response = new MockHttpServletResponse();
				try {
					servlet.service(request, response);
				}
				catch (jakarta.servlet.ServletException ex) {
					// An exception no resolver handled: the route was still the one that took the request.
				}
				Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
				// A router function's resources expose no pattern: theirs is the lookup that finds the resource served.
				Object handler = request.getAttribute(HandlerMapping.BEST_MATCHING_HANDLER_ATTRIBUTE);
				if (pattern == null && handler != null && handler.getClass().getSimpleName().equals("ResourceHandlerFunction")) {
					ServerRequest serverRequest = (ServerRequest) request.getAttribute(RouterFunctions.REQUEST_ATTRIBUTE);
					List<String> found = new ArrayList<>();
					LOOKUPS.forEach((raw, lookup) -> {
						if (lookup.apply(serverRequest).isPresent()) found.add(raw);
					});
					if (found.size() != 1) throw new IllegalStateException(method + " " + path + " is served by the resources of " + found);
					pattern = found.get(0);
				}
				String route = pattern == null || response.getStatus() == 405 ? null : route(routes, method, path, pattern.toString());
				out.add(new Request(method, path, route));
			}
		}
		return out;
	}

	/**
	 * The route of `routes` the pattern that took a request stands for: the pattern, or, where it ends in a segment that
	 * takes the rest of the path and the request has nothing after its last `/`, its parent; a router function's nest
	 * route with no path of its own takes what its nest's pattern leaves (`/teams/**`).
	 */
	static String route(List<Route> routes, String method, String path, String raw) {
		PathPattern pattern = PathPatternParser.defaultInstance.parse(raw);
		String trimmed = path.replaceAll("/+$", "");
		String parent = parent(raw);
		String taken;
		if (pattern.matches(PathContainer.parsePath(path))) {
			boolean bare = parent != null && PathPatternParser.defaultInstance.parse(parent.isEmpty() ? "/" : parent)
					.matches(PathContainer.parsePath(trimmed.isEmpty() ? "/" : trimmed));
			taken = bare ? (parent.isEmpty() ? "/" : parent) : raw;
		}
		else {
			PathPattern.PathRemainingMatchInfo start = pattern.matchStartOfPath(PathContainer.parsePath(path));
			if (start == null) throw new IllegalStateException(method + " " + path + " is dispatched to " + raw + ", which does not match it");
			taken = start.getPathRemaining().value().replaceAll("/+$", "").isEmpty() ? raw : raw.replaceAll("/+$", "") + "/**";
		}
		boolean any = false;
		boolean own = false;
		for (Route r : routes) {
			if (!r.raw().equals(taken)) continue;
			any |= r.method().equals("*");
			own |= r.method().equals(method);
		}
		// A URL handler mapping chooses its handler by path alone: a resource handler that took a method it does not
		// serve answers it with an error (404 for a missing file before 405), so no route took the request.
		if (!any && !own) return null;
		return (any ? "*" : method) + " " + canonical(taken);
	}

	/** A URL handler's methods: those a WebContentGenerator (a resource handler, a view controller) supports, else any. */
	static void add(List<Route> routes, PathPattern pattern, Object handler) {
		String[] verbs = handler instanceof WebContentGenerator generator ? generator.getSupportedMethods() : null;
		if (verbs == null) add(routes, "*", pattern);
		else for (String verb : verbs) add(routes, verb, pattern);
	}

	/**
	 * A route at a pattern; and at its parent too, where the pattern ends in `**` or `{*name}` and the PathPattern
	 * matches the path with nothing after that last `/` (`/files/**` matches `/files` and `/files/`).
	 */
	static void add(List<Route> routes, String method, PathPattern pattern) {
		String raw = pattern.getPatternString();
		routes.add(new Route(method, raw));
		String parent = parent(raw);
		if (parent != null && (pattern.matches(PathContainer.parsePath(sample(parent)))
				|| pattern.matches(PathContainer.parsePath(sample(parent) + "/")))) {
			routes.add(new Route(method, parent.isEmpty() ? "/" : parent));
		}
	}

	/** The path before the last `/` of a pattern that ends in a segment taking the rest of the path, else null. */
	static String parent(String raw) {
		int slash = raw.lastIndexOf('/');
		String last = raw.substring(slash + 1);
		return last.equals("**") || (last.startsWith("{*") && last.endsWith("}")) ? raw.substring(0, slash) : null;
	}

	/**
	 * One way through a predicate: the methods it takes (null for any), the path pattern it matches (null for any), and
	 * the headers and query parameters a request needs to match it, which narrow the requests a route takes, not its path.
	 */
	record Way(Set<String> methods, String path, Map<String, String> headers, Map<String, String> params) {

		static final Way ANY = new Way(null, null, Map.of(), Map.of());

		static Way methods(Set<String> methods) {
			return new Way(methods, null, Map.of(), Map.of());
		}

		static Way path(String path) {
			return new Way(null, path, Map.of(), Map.of());
		}

		static Way header(String name, String value) {
			return new Way(null, null, Map.of(name, value), Map.of());
		}

		static Way param(String name, String value) {
			return new Way(null, null, Map.of(), Map.of(name, value));
		}

		Way and(Way other) {
			Set<String> m = methods;
			if (m == null) m = other.methods;
			else if (other.methods != null) {
				m = new TreeSet<>(m);
				m.retainAll(other.methods);
			}
			if (path != null && other.path != null) throw new IllegalStateException("two paths in one predicate: " + path + ", " + other.path);
			return new Way(m, path != null ? path : other.path, merged(headers, other.headers), merged(params, other.params));
		}

		/** Within a nest, the nested predicate's path is matched against the rest of the path its parent matched. */
		Way nest(Way inner) {
			Way joined = new Way(methods, null, headers, params).and(new Way(inner.methods, null, inner.headers, inner.params));
			String p = path == null ? inner.path : inner.path == null ? path : path + inner.path;
			return new Way(joined.methods, p, joined.headers, joined.params);
		}

		static Map<String, String> merged(Map<String, String> a, Map<String, String> b) {
			Map<String, String> out = new TreeMap<>(a);
			b.forEach((name, value) -> {
				String before = out.putIfAbsent(name, value);
				if (before != null && !before.equals(value)) throw new IllegalStateException("two values of " + name + ": " + before + ", " + value);
			});
			return out;
		}
	}

	/** The ways through a request predicate, as RequestPredicates.Visitor tells its structure. */
	static List<Way> ways(RequestPredicate predicate) {
		Deque<List<List<Way>>> stack = new ArrayDeque<>();
		stack.push(new ArrayList<>());
		Deque<String> kinds = new ArrayDeque<>();
		predicate.accept(new RequestPredicates.Visitor() {
			void leaf(Way way) {
				stack.peek().add(List.of(way));
			}

			public void method(Set<HttpMethod> methods) {
				Set<String> names = new TreeSet<>();
				for (HttpMethod m : methods) names.add(m.name());
				leaf(Way.methods(names));
			}

			public void path(String pattern) {
				leaf(Way.path(pattern));
			}

			// Media types and parameters narrow which requests match, not the route; the confirming request carries them.
			// A list of media types (`[a, b]`) is met by its first. Versions and extensions are left to the request.
			@SuppressWarnings("removal")
			public void pathExtension(String extension) {
				leaf(Way.ANY);
			}

			public void header(String name, String value) {
				leaf(Way.header(name, value.startsWith("[") ? value.substring(1, value.length() - 1).split(", ")[0] : value));
			}

			public void param(String name, String value) {
				leaf(Way.param(name, value));
			}

			public void version(String version) {
				leaf(Way.ANY);
			}

			public void startAnd() {
				kinds.push("and");
				stack.push(new ArrayList<>());
			}

			public void and() {
			}

			public void endAnd() {
				kinds.pop();
				List<Way> result = List.of(Way.ANY);
				for (List<Way> part : stack.pop()) {
					List<Way> next = new ArrayList<>();
					for (Way a : result) for (Way b : part) next.add(a.and(b));
					result = next;
				}
				stack.peek().add(result);
			}

			public void startOr() {
				kinds.push("or");
				stack.push(new ArrayList<>());
			}

			public void or() {
			}

			public void endOr() {
				kinds.pop();
				List<Way> result = new ArrayList<>();
				for (List<Way> part : stack.pop()) result.addAll(part);
				stack.peek().add(result);
			}

			public void startNegate() {
				throw new IllegalStateException("no reading for a negated predicate: " + predicate);
			}

			public void endNegate() {
			}

			public void unknown(RequestPredicate unknown) {
				throw new IllegalStateException("no reading for the predicate " + unknown);
			}
		});
		List<List<Way>> top = stack.pop();
		if (top.size() != 1) throw new IllegalStateException("unexpected predicate structure: " + predicate);
		return top.get(0);
	}

	/** The routes of a router function, each confirmed by a request it routes to a handler. */
	static final class FunctionRoutes implements RouterFunctions.Visitor {

		private final RouterFunction<?> function;
		private final Deque<List<Way>> nests = new ArrayDeque<>();
		private final List<Route> routes = new ArrayList<>();

		FunctionRoutes(RouterFunction<?> function) {
			this.function = function;
		}

		List<Route> read() {
			function.accept(this);
			return routes;
		}

		public void startNested(RequestPredicate predicate) {
			nests.addLast(ways(predicate));
		}

		public void endNested(RequestPredicate predicate) {
			nests.removeLast();
		}

		public void route(RequestPredicate predicate, HandlerFunction<?> handler) {
			List<Way> outers = List.of(Way.ANY);
			for (List<Way> level : nests) {
				List<Way> next = new ArrayList<>();
				for (Way outer : outers) for (Way inner : level) next.add(outer.nest(inner));
				outers = next;
			}
			// A route with no path predicate of its own within a path nest takes whatever rest of the path the nest's
			// pattern leaves (PathPatternPredicate.nest matches the start of the path): `.path("/teams", b -> b.GET(h))`
			// serves GET /teams and GET /teams/1/2 alike.
			List<Way> result = new ArrayList<>();
			for (Way outer : outers) {
				for (Way inner : ways(predicate)) {
					result.add(inner.path() == null && outer.path() != null ? outer.nest(new Way(inner.methods(), "/**", inner.headers(), inner.params())) : outer.nest(inner));
				}
			}
			for (Way way : result) {
				String raw = way.path() == null ? "/**" : way.path();
				Set<String> methods = way.methods() == null ? Set.of("*") : way.methods();
				String parent = parent(raw);
				for (String method : methods) {
					if (!confirm(method, raw, way)) throw new IllegalStateException("the router function routes no " + method + " " + raw);
					routes.add(new Route(method, raw));
					if (parent != null && (confirm(method, parent, way) || confirm(method, parent + "/", way))) {
						routes.add(new Route(method, parent.isEmpty() ? "/" : parent));
					}
				}
			}
		}

		/**
		 * RouterFunctions.resources(pattern, location) looks a resource up for any request whose path the pattern
		 * matches, and its ResourceHandlerFunction serves GET and HEAD and answers other methods 405. The lookup tells its
		 * pattern only by its description (`pattern -> location`); each method is confirmed by a request.
		 */
		public void resources(Function<ServerRequest, Optional<Resource>> lookup) {
			String description = lookup.toString();
			int arrow = description.indexOf(" -> ");
			if (arrow < 0) throw new IllegalStateException("no reading for the resource lookup " + description);
			String raw = description.substring(0, arrow);
			LOOKUPS.put(raw, lookup);
			String parent = parent(raw);
			for (String method : List.of("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE")) {
				if (!confirm(method, raw, null)) continue;
				routes.add(new Route(method, raw));
				if (parent != null && (confirm(method, parent, null) || confirm(method, parent + "/", null))) {
					routes.add(new Route(method, parent.isEmpty() ? "/" : parent));
				}
			}
		}

		public void attributes(Map<String, Object> attributes) {
		}

		public void unknown(RouterFunction<?> unknown) {
			throw new IllegalStateException("no reading for the router function " + unknown);
		}

		/**
		 * Routes a request for the pattern, with the headers and parameters of the way through the route's predicate,
		 * through the whole router function: true when it is routed to a handler (for a resource, way null, one that
		 * serves the method rather than answering 405).
		 */
		private boolean confirm(String method, String raw, Way way) {
			boolean resource = way == null;
			MockHttpServletRequest servlet = new MockHttpServletRequest(method.equals("*") ? "GET" : method, sample(raw));
			if (way != null) {
				way.headers().forEach(servlet::addHeader);
				way.params().forEach(servlet::addParameter);
				if (way.headers().containsKey(HttpHeaders.CONTENT_TYPE)) servlet.setContentType(way.headers().get(HttpHeaders.CONTENT_TYPE));
			}
			ServletRequestPathUtils.parseAndCache(servlet);
			List<HttpMessageConverter<?>> converters = List.of(new StringHttpMessageConverter());
			ServerRequest request = ServerRequest.create(servlet, converters);
			@SuppressWarnings("unchecked")
			Optional<HandlerFunction<ServerResponse>> handler = ((RouterFunction<ServerResponse>) function).route(request);
			if (handler.isEmpty()) return false;
			if (!resource) return true;
			try {
				return handler.get().handle(request).statusCode().value() != 405;
			}
			catch (Exception ex) {
				throw new IllegalStateException(ex);
			}
		}
	}

	static final List<String> VALUES = List.of("1", "abc", "a-b", "value1", "00000000-0000-0000-0000-000000000001", "1.0.0", ".txt");

	/**
	 * A request path a pattern matches: for a variable `1`, or the first of a few values its regex takes, and
	 * `hello.txt` (a file the fixture ships) for the rest.
	 */
	static String sample(String raw) {
		List<String> segments = new ArrayList<>();
		for (String seg : raw.split("/", -1)) {
			if (seg.equals("**") || (seg.startsWith("{*") && seg.endsWith("}"))) segments.add("hello.txt");
			else segments.add(replaceVariables(seg, Oracle::value, "1"));
		}
		String path = String.join("/", segments);
		return path.startsWith("/") ? path : "/" + path;
	}

	/**
	 * A path pattern in the canonical form of fixtures/frameworks/README.md: `**` and `{*name}` take the rest of the
	 * path (`{**}`, one segment or more: where they take none as well, `add` records the parent path too); a variable (`{name}`, `{name:regex}`), and a `*` or `?` wildcard, take part of one segment (`{}`).
	 */
	static String canonical(String raw) {
		List<String> segments = new ArrayList<>();
		for (String seg : raw.split("/", -1)) {
			if (seg.equals("**") || (seg.startsWith("{*") && seg.endsWith("}"))) segments.add("{**}");
			else segments.add(replaceVariables(seg, variable -> "{}", "{}"));
		}
		String path = String.join("/", segments).replaceAll("/+$", "");
		if (!path.startsWith("/")) path = "/" + path;
		return path;
	}

	/** A value for a variable (`name` or `name:regex`, as written between its braces) that its regex takes, if any. */
	static String value(String variable) {
		int colon = variable.indexOf(':');
		if (colon < 0) return VALUES.get(0);
		String regex = variable.substring(colon + 1);
		return VALUES.stream().filter(v -> v.matches(regex)).findFirst()
				.orElseThrow(() -> new IllegalStateException("none of " + VALUES + " is a value of {" + variable + "}"));
	}

	/**
	 * A segment with each `{...}` variable (braces in its regex balanced) replaced by what `variable` makes of the text
	 * between its braces, and each `*` or `?` wildcard by `wildcard`.
	 */
	static String replaceVariables(String segment, Function<String, String> variable, String wildcard) {
		StringBuilder out = new StringBuilder();
		for (int i = 0; i < segment.length(); i++) {
			char c = segment.charAt(i);
			if (c == '{') {
				int depth = 0;
				int j = i;
				for (; j < segment.length(); j++) {
					if (segment.charAt(j) == '{') depth++;
					else if (segment.charAt(j) == '}' && --depth == 0) break;
				}
				out.append(variable.apply(segment.substring(i + 1, Math.min(j, segment.length()))));
				i = j;
			}
			else if (c == '*' || c == '?') out.append(wildcard);
			else out.append(c);
		}
		return out.toString();
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
