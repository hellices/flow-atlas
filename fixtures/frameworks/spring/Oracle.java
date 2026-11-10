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
 *
 *   java -cp "target/classes:$(cat target/classpath.txt)" Oracle.java
 */
public class Oracle {

	record Route(String method, String raw) {
	}

	public static void main(String[] args) throws Exception {
		PrintStream stdout = System.out;
		System.setOut(System.err);
		ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class).run(
				"--server.port=0", "--spring.main.banner-mode=off", "--logging.level.root=WARN",
				"--spring.mvc.servlet.load-on-startup=1");
		List<Route> routes = new ArrayList<>();
		try {
			List<HandlerMapping> mappings = context.getBean(DispatcherServlet.class).getHandlerMappings();
			if (mappings == null) throw new IllegalStateException("the DispatcherServlet has not been initialized");
			for (HandlerMapping mapping : mappings) read(mapping, routes);
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
			List<Way> result = List.of(Way.ANY);
			List<List<Way>> levels = new ArrayList<>(nests);
			levels.add(ways(predicate));
			for (List<Way> level : levels) {
				List<Way> next = new ArrayList<>();
				for (Way outer : result) for (Way inner : level) next.add(outer.nest(inner));
				result = next;
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

	static final List<String> VALUES = List.of("1", "abc", "a-b", "value1", "00000000-0000-0000-0000-000000000001");

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
