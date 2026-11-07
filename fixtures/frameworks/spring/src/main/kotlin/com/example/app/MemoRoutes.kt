package com.example.app

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.servlet.function.ServerResponse
import org.springframework.web.servlet.function.router

/** The Kotlin router DSL of WebMvc.fn. */
@Configuration(proxyBeanMethods = false)
class MemoRoutes {

	@Bean
	fun memoRouter() = router {
		"/memos".nest {
			GET("/{id}") { request -> ServerResponse.ok().body("memo " + request.pathVariable("id")) }
			GET { ServerResponse.ok().body(listOf<String>()) }
		}
	}
}
