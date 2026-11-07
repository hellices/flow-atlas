package com.example.app;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.method.HandlerTypePredicate;
import org.springframework.web.reactive.config.ApiVersionConfigurer;
import org.springframework.web.reactive.config.PathMatchConfigurer;
import org.springframework.web.reactive.config.WebFluxConfigurer;

@Configuration
public class WebConfiguration implements WebFluxConfigurer {

	@Override
	public void configurePathMatching(PathMatchConfigurer configurer) {
		configurer.addPathPrefix("/api", HandlerTypePredicate.forAnnotation(RestController.class));
	}

	@Override
	public void configureApiVersioning(ApiVersionConfigurer configurer) {
		configurer.useRequestHeader("API-Version").setVersionRequired(false);
	}
}
