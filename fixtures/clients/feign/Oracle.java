import java.io.InputStream;
import java.lang.reflect.Method;
import java.lang.reflect.RecordComponent;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Properties;

import com.example.client.AdminApi;
import com.example.client.Clients;
import com.example.client.RepoApi;
import com.example.client.Settings;

import feign.Feign;

/**
 * Builds the application's clients with its base URL set to the recording server (the `api.base-url` system property
 * holds RECORD_URL), and calls each method of each client once, with ARG for each string argument and ARG_NUMBER for
 * each number; a body is the record built from the same values, a query map names one parameter. Prints the library
 * and its version.
 */
public class Oracle {

	private static final String ARG = System.getenv("ARG");

	private static final long ARG_NUMBER = Long.parseLong(System.getenv("ARG_NUMBER"));

	public static void main(String[] args) throws Exception {
		Settings settings = new Settings();
		callEach(RepoApi.class, Clients.repoApi(settings));
		callEach(AdminApi.class, Clients.adminApi(settings));
		Properties pom = new Properties();
		try (InputStream in = Feign.class.getResourceAsStream("/META-INF/maven/io.github.openfeign/feign-core/pom.properties")) {
			pom.load(in);
		}
		System.out.println("{\"library\":\"OpenFeign\",\"version\":\"" + pom.getProperty("version") + "\"}");
	}

	static void callEach(Class<?> type, Object client) {
		List<Method> methods = Arrays.stream(type.getDeclaredMethods())
			.filter((m) -> !m.isDefault() && !m.isSynthetic())
			.sorted(Comparator.comparing(Method::getName))
			.toList();
		for (Method method : methods) {
			Object[] values = Arrays.stream(method.getParameterTypes()).map(Oracle::valueOf).toArray();
			try {
				method.invoke(client, values);
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
		if (type == Map.class) {
			return Map.of("q", ARG);
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
