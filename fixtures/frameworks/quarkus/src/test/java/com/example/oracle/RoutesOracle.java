package com.example.oracle;

import java.io.InputStream;
import java.lang.reflect.Field;
import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpRequest.BodyPublishers;
import java.net.http.HttpResponse;
import java.net.http.HttpResponse.BodyHandlers;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.function.Predicate;

import io.quarkus.resteasy.reactive.server.runtime.ResteasyReactiveRecorder;
import io.quarkus.runtime.Quarkus;
import io.quarkus.test.common.http.TestHTTPResource;
import io.quarkus.test.junit.QuarkusTest;
import io.vertx.ext.web.Route;
import org.jboss.resteasy.reactive.server.core.Deployment;
import org.jboss.resteasy.reactive.server.handlers.ClassRoutingHandler;
import org.jboss.resteasy.reactive.server.handlers.ResourceLocatorHandler;
import org.jboss.resteasy.reactive.server.handlers.RestInitialHandler.InitialMatch;
import org.jboss.resteasy.reactive.server.mapping.RequestMapper;
import org.jboss.resteasy.reactive.server.mapping.RequestMapper.RequestMatch;
import org.jboss.resteasy.reactive.server.mapping.RequestMapper.RequestPath;
import org.jboss.resteasy.reactive.server.mapping.RuntimeResource;
import org.jboss.resteasy.reactive.server.spi.ServerRestHandler;
import org.junit.jupiter.api.Test;

/**
 * Asks Quarkus which routes the application serves. It starts the application as a Quarkus test (the application as
 * built, on a free port) and reads the two tables the HTTP server dispatches with:
 *
 * - the Vert.x Web router (reactive routes `@Route`, routes registered on the `Router` at startup): each route's path
 *   and methods, a prefix route (`/assets/*`) as the rest of the path, each confirmed by a request the router answers
 *   with that route (RouterCapture names it on the response); a route with no path is a filter or a fallback, and a
 *   request no route takes must be answered 404;
 * - the Quarkus REST deployment the router hands its root path to: the class mappers, each resource class's method
 *   mappers (ClassRoutingHandler), and for a sub-resource locator the resource class it returns, as its
 *   ResourceLocatorHandler maps it; each endpoint matched by the deployment's own RequestMapper and confirmed by a
 *   request its resource method answers (EndpointStamp names it on the response).
 *
 * It writes `{"framework","version","routes"}` to target/routes.json.
 *
 *   mvn -q -B surefire:test -Dtest=RoutesOracle
 */
@QuarkusTest
class RoutesOracle {

	record Found(String method, String path, String raw) {
	}

	static final HttpClient HTTP = HttpClient.newHttpClient();

	static final List<String> SAMPLES = List.of("1", "a", "ab");

	@TestHTTPResource("/")
	URL base;

	final List<Found> routes = new ArrayList<>();

	@Test
	void routes() throws Exception {
		Deployment deployment = ResteasyReactiveRecorder.getCurrentDeployment();
		String prefix = deployment.getPrefix();
		for (Route route : RouterCapture.router.getRoutes()) {
			if (route == RouterCapture.stamp) continue;
			// A path with parameters is matched by a pattern too; a route given a regular expression has no path.
			if (route.getPath() == null && route.isRegexPath()) throw new IllegalStateException("a regular expression route is not in the form: " + route);
			if (route.getPath() == null) continue;
			// The REST deployment's mount (its root path, and everything under it), read through the deployment below.
			if (route.getPath().equals(prefix) || route.getPath().equals(prefix + "/")) continue;
			readVertx(route);
		}
		if (request("GET", "/oracle/no/route/takes/this").statusCode() != 404) {
			throw new IllegalStateException("a route with no path answers a request no route takes");
		}
		readRest(deployment);
		write();
	}

	/** A Vert.x Web route: `:name` a parameter; a path that is no exact path (`/assets/*`) also takes the rest. */
	void readVertx(Route route) throws Exception {
		String path = route.getPath();
		Set<io.vertx.core.http.HttpMethod> verbs = route.methods();
		List<String> methods = new ArrayList<>();
		if (verbs == null || verbs.isEmpty()) methods.add("*");
		else for (io.vertx.core.http.HttpMethod verb : verbs) methods.add(verb.name());
		String stamp = Integer.toString(System.identityHashCode(route));
		String raw = route.isExactPath() ? path : path + "*";
		String head = route.isExactPath() ? path : path.replaceAll("/$", "");
		if (head.contains("*")) throw new IllegalStateException("no reading for the path " + path);
		String canonical = head.replaceAll(":[A-Za-z0-9_]+", "{}");
		String sample = head.replaceAll(":[A-Za-z0-9_]+", "1");
		for (String method : methods) {
			String verb = method.equals("*") ? "GET" : method;
			if (route.isExactPath()) {
				confirmRoute(verb, sample, stamp);
				routes.add(new Found(method, canonical(canonical), raw));
				continue;
			}
			confirmRoute(verb, sample + "/a/b", stamp);
			routes.add(new Found(method, canonical(canonical + "/{**}"), raw));
			if (answers(verb, sample.isEmpty() ? "/" : sample, stamp) || answers(verb, sample + "/", stamp)) {
				routes.add(new Found(method, canonical(canonical), raw));
			}
		}
	}

	void confirmRoute(String method, String path, String stamp) throws Exception {
		if (!answers(method, path, stamp)) throw new IllegalStateException("the router answers " + method + " " + path + " with another route");
	}

	boolean answers(String method, String path, String stamp) throws Exception {
		return request(method, path).headers().firstValue(RouterCapture.HEADER).map(stamp::equals).orElse(false);
	}

	/** The endpoints of the REST deployment, under its root path. */
	void readRest(Deployment deployment) throws Exception {
		RequestMapper<InitialMatch> classes = new RequestMapper<>(deployment.getClassMappers());
		for (RequestPath<InitialMatch> type : deployment.getClassMappers()) {
			ClassRoutingHandler routing = null;
			for (ServerRestHandler handler : type.value.handlers) if (handler instanceof ClassRoutingHandler c) routing = c;
			if (routing == null) throw new IllegalStateException("no class routing for " + type.template.template);
			Map<RuntimeResource, Boolean> seen = new IdentityHashMap<>();
			for (Map.Entry<String, RequestMapper<RuntimeResource>> entry : routing.getMappers().entrySet()) {
				for (RequestPath<RuntimeResource> endpoint : entry.getValue().getTemplates()) {
					RuntimeResource resource = endpoint.value;
					if (seen.put(resource, true) != null) continue;
					String path = type.template.template + endpoint.template.template;
					Map<String, RequestMapper<RuntimeResource>> mappers = routing.getMappers();
					if (resource.getHttpMethod() == null) {
						readLocator(deployment, classes, mappers, resource, path);
						continue;
					}
					String method = resource.getHttpMethod();
					String sample = sample(path, p -> {
						RequestMatch<RuntimeResource> match = dispatch(classes, mappers, method, p);
						return match != null && match.value == resource;
					});
					confirmEndpoint(method, deployment.getPrefix() + sample, resource);
					routes.add(new Found(method, canonical(templateForm(deployment.getPrefix() + path)), deployment.getPrefix() + path));
				}
			}
		}
	}

	/**
	 * A sub-resource locator: the resource class it returns serves the rest of the path, mapped by the
	 * ResourceLocatorHandler of the locator's handler chain, which tells its mappers by no public method.
	 */
	void readLocator(Deployment deployment, RequestMapper<InitialMatch> classes, Map<String, RequestMapper<RuntimeResource>> mappers,
			RuntimeResource locator, String path) throws Exception {
		ResourceLocatorHandler handler = null;
		for (ServerRestHandler h : locator.getHandlerChain()) if (h instanceof ResourceLocatorHandler l) handler = l;
		if (handler == null) throw new IllegalStateException("no locator handler for " + path);
		Field field = ResourceLocatorHandler.class.getDeclaredField("resourceLocatorHandlers");
		field.setAccessible(true);
		@SuppressWarnings("unchecked")
		Map<Class<?>, Map<String, RequestMapper<RuntimeResource>>> targets = (Map<Class<?>, Map<String, RequestMapper<RuntimeResource>>>) field.get(handler);
		Map<String, RequestMapper<RuntimeResource>> target = targets.get((Class<?>) locator.getReturnType());
		if (target == null) throw new IllegalStateException("no sub-resource mapped for " + path + " (" + locator.getReturnType() + ")");
		for (Map.Entry<String, RequestMapper<RuntimeResource>> entry : target.entrySet()) {
			for (RequestPath<RuntimeResource> endpoint : entry.getValue().getTemplates()) {
				RuntimeResource resource = endpoint.value;
				if (resource.getHttpMethod() == null) throw new IllegalStateException("no reading for a locator within a sub-resource: " + path);
				String method = resource.getHttpMethod();
				String full = path + endpoint.template.template;
				String sample = sample(full, p -> {
					RequestMatch<RuntimeResource> outer = dispatch(classes, mappers, method, p);
					if (outer == null || outer.value != locator) return false;
					RequestMapper<RuntimeResource> mapper = target.get(method);
					RequestMatch<RuntimeResource> sub = mapper.map(outer.remaining.isEmpty() ? "/" : outer.remaining);
					return sub != null && sub.value == resource;
				});
				confirmEndpoint(method, deployment.getPrefix() + sample, resource);
				routes.add(new Found(method, canonical(templateForm(deployment.getPrefix() + full)), deployment.getPrefix() + full));
			}
		}
	}

	/**
	 * The resource method the deployment routes a request to, as RestInitialHandler and ClassRoutingHandler map it: the
	 * resource class by its template, then the method's mapper (else the one for any method) on the rest of the path.
	 */
	@SuppressWarnings({"unchecked", "rawtypes"})
	static RequestMatch<RuntimeResource> dispatch(RequestMapper<InitialMatch> classes, Map<String, RequestMapper<RuntimeResource>> mappers, String method, String path) {
		RequestMatch<InitialMatch> match = classes.map(path);
		if (match == null) return null;
		String rest = match.remaining.isEmpty() ? "/" : match.remaining;
		RequestMatch<RuntimeResource> target = null;
		if (mappers.get(method) != null) target = mappers.get(method).map(rest);
		if (target == null && mappers.get(null) != null) target = mappers.get(null).map(rest);
		return target;
	}

	void confirmEndpoint(String method, String path, RuntimeResource resource) throws Exception {
		String expected = resource.getResourceClass().getName() + "#" + resource.getJavaMethodName();
		HttpResponse<Void> response = request(method, path);
		String answered = response.headers().firstValue(EndpointStamp.HEADER).orElse(null);
		if (!expected.equals(answered)) {
			throw new IllegalStateException(method + " " + path + " is answered " + response.statusCode() + " by " + answered + ", not " + expected);
		}
	}

	/** A request path for a JAX-RS template that the given matcher takes: each `{param}` `1`, else `a`, else `ab`. */
	static String sample(String template, Predicate<String> matches) {
		for (String value : SAMPLES) {
			String path = replaceParams(template, value);
			if (path.contains("//")) path = path.replaceAll("/+", "/");
			if (matches.test(path)) {
				for (String other : template.contains("{") ? SAMPLES : List.<String>of()) {
					if (matches.test(replaceParams(template, other + "/" + other))) {
						throw new IllegalStateException("a parameter of " + template + " takes a `/`: not in the form");
					}
				}
				return path;
			}
		}
		throw new IllegalStateException("no request path takes " + template);
	}

	/** A JAX-RS template with each `{name}` or `{name: regex}` (braces within the regex balanced) replaced. */
	static String replaceParams(String template, String value) {
		StringBuilder out = new StringBuilder();
		for (int i = 0; i < template.length(); i++) {
			char c = template.charAt(i);
			if (c != '{') {
				out.append(c);
				continue;
			}
			int depth = 0;
			int j = i;
			for (; j < template.length(); j++) {
				if (template.charAt(j) == '{') depth++;
				else if (template.charAt(j) == '}' && --depth == 0) break;
			}
			out.append(value);
			i = j;
		}
		return out.toString();
	}

	static String templateForm(String template) {
		return replaceParams(template, "{}");
	}

	static String canonical(String path) {
		path = path.replaceAll("/+", "/").replaceAll("/$", "");
		return path.isEmpty() ? "/" : path;
	}

	HttpResponse<Void> request(String method, String path) throws Exception {
		URI uri = base.toURI().resolve(path.startsWith("/") ? path.substring(1) : path);
		HttpRequest request = HttpRequest.newBuilder(uri).method(method, BodyPublishers.noBody()).build();
		return HTTP.send(request, BodyHandlers.discarding());
	}

	void write() throws Exception {
		Properties core = new Properties();
		try (InputStream in = Quarkus.class.getResourceAsStream("/META-INF/maven/io.quarkus/quarkus-core/pom.properties")) {
			core.load(in);
		}
		StringBuilder json = new StringBuilder();
		json.append("{\"framework\":\"quarkus\",\"version\":").append(quote(core.getProperty("version"))).append(",\"routes\":[");
		for (int i = 0; i < routes.size(); i++) {
			Found r = routes.get(i);
			if (i > 0) json.append(',');
			json.append("{\"method\":").append(quote(r.method())).append(",\"path\":").append(quote(r.path()))
					.append(",\"raw\":").append(quote(r.raw())).append('}');
		}
		Files.writeString(Path.of("target", "routes.json"), json.append("]}\n"), StandardCharsets.UTF_8);
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
