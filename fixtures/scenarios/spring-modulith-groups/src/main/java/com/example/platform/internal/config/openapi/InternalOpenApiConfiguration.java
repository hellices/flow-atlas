package com.example.platform.internal.config.openapi;

import org.springdoc.core.models.GroupedOpenApi;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
class InternalOpenApiConfiguration {
    @Bean
    GroupedOpenApi internalApi(InternalGroupCustomizer customizer) {
        return GroupedOpenApi.builder().group("internal").pathsToMatch("/v1/internal/**")
                .addOpenApiCustomizer(customizer).build();
    }
}
