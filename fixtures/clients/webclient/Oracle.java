import java.io.PrintStream;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

import com.example.client.Application;
import com.example.client.OrderClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

import org.springframework.boot.Banner;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.SpringVersion;

/**
 * Starts the application with its base URL set to the recording server (RECORD_URL), and calls each public method of
 * its client once, blocking on the Mono or Flux it returns, with ARG for each string argument and ARG_NUMBER for each
 * number; a body is the record built from the same values. Prints the library and its version.
 */
public class Oracle {

	private static final String ARG = System.getenv("ARG");

	private static final long ARG_NUMBER = Long.parseLong(System.getenv("ARG_NUMBER"));

	public static void main(String[] args) throws Exception {
		PrintStream out = System.out;
		// Spring Boot logs to the console; only the result goes to stdout.
		System.setOut(System.err);
		try (ConfigurableApplicationContext context = new SpringApplicationBuilder(Application.class)
			.web(WebApplicationType.NONE)
			.bannerMode(Banner.Mode.OFF)
			.logStartupInfo(false)
			.run("--api.base-url=" + System.getenv("RECORD_URL"))) {
			callEach(OrderClient.class, context.getBean(OrderClient.class));
		}
		out.println("{\"library\":\"Spring WebClient\",\"version\":\"" + SpringVersion.getVersion() + "\"}");
	}

	static void callEach(Class<?> type, Object client) throws Exception {
		List<Method> methods = Arrays.stream(type.getDeclaredMethods())
			.filter((m) -> Modifier.isPublic(m.getModifiers()) && !Modifier.isStatic(m.getModifiers()) && !m.isSynthetic())
			.sorted(Comparator.comparing(Method::getName))
			.toList();
		for (Method method : methods) {
			Object[] values = Arrays.stream(method.getParameterTypes()).map(Oracle::valueOf).toArray();
			try {
				// Each method returns the request as a Mono or a Flux; subscribing sends it.
				Object result = method.invoke(client, values);
				if (result instanceof Mono<?> mono) {
					mono.block();
				}
				else if (result instanceof Flux<?> flux) {
					flux.collectList().block();
				}
				else {
					throw new IllegalStateException(method.getName() + " returns no Mono or Flux");
				}
			}
			catch (Exception ex) {
				throw new IllegalStateException(type.getSimpleName() + "." + method.getName() + " failed", ex);
			}
		}
	}

	static Object valueOf(Class<?> type) {
		if (type == String.class) {
			return ARG;
		}
		if (type == long.class || type == Long.class) {
			return ARG_NUMBER;
		}
		if (type == int.class || type == Integer.class) {
			return (int) ARG_NUMBER;
		}
		if (type.isRecord()) {
			RecordComponent[] components = type.getRecordComponents();
			Class<?>[] types = Arrays.stream(components).map(RecordComponent::getType).toArray(Class<?>[]::new);
			try {
				return type.getDeclaredConstructor(types).newInstance(Arrays.stream(types).map(Oracle::valueOf).toArray());
			}
			catch (ReflectiveOperationException ex) {
				throw new IllegalStateException(ex);
			}
		}
		throw new IllegalArgumentException("no value for a " + type.getName());
	}

}
