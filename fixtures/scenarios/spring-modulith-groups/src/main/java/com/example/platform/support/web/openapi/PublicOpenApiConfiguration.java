package com.example.platform.support.web.openapi;

import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class PublicOpenApiConfiguration {
    @Bean
    OpenAPI apiDescription() {
        return new OpenAPI().info(new Info().title("Platform").version("2.0.0"));
    }

    @Bean
    GroupedOpenApi publicApi(HeaderParameterCustomizer customizer) {
        return GroupedOpenApi.builder().group("public").pathsToMatch("/api/**", "/v1/enrollment/**")
                .addOpenApiCustomizer(customizer).build();
    }
}
