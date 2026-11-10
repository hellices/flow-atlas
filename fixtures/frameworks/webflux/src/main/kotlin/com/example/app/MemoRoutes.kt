package com.example.app

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.reactive.function.server.ServerResponse
import org.springframework.web.reactive.function.server.bodyValueAndAwait
import org.springframework.web.reactive.function.server.coRouter

/** The Kotlin coroutines router DSL of WebFlux.fn. */
@Configuration(proxyBeanMethods = false)
class MemoRoutes {

	@Bean
	fun memoRouter() = coRouter {
		"/memos".nest {
			GET("/{id}") { request -> ServerResponse.ok().bodyValueAndAwait("memo " + request.pathVariable("id")) }
			GET("") { ServerResponse.ok().bodyValueAndAwait(listOf<String>()) }
			POST("") { ServerResponse.ok().bodyValueAndAwait("created") }
		}
	}
}
