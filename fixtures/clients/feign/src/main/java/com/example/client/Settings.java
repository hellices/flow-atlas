package com.example.client;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.Properties;

/** The application's settings: application.properties, each overridden by a system property of the same name. */
public final class Settings {

	private final Properties properties = new Properties();

	public Settings() {
		try (InputStream in = Settings.class.getResourceAsStream("/application.properties")) {
			this.properties.load(in);
		}
		catch (IOException ex) {
			throw new UncheckedIOException(ex);
		}
	}

	public String get(String name) {
		return System.getProperty(name, this.properties.getProperty(name));
	}

	public String baseUrl() {
		return get("api.base-url");
	}

}
