package com.example.app

import io.ktor.http.HttpMethod
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.http.content.staticResources
import io.ktor.server.resources.Resources
import io.ktor.server.response.respondText
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.method
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

fun main() {
    embeddedServer(CIO, port = 8080, module = Application::module).start(wait = true)
}

fun Application.module() {
    install(Resources)
    routing {
        get("/") { call.respondText("Hello, world!") }
        route("/hello", HttpMethod.Get) {
            handle { call.respondText("Hello") }
        }
        get("/user/{login}") { call.respondText("user ${call.parameters["login"]}") }
        get("/profile/{login?}") { call.respondText("profile ${call.parameters["login"]}") }
        get("/wild/*") { call.respondText("wild") }
        get("/tail/{...}") { call.respondText("tail") }
        get("/files/{path...}") { call.respondText(call.parameters.getAll("path").orEmpty().joinToString("/")) }
        get("/reports/{year}.csv") { call.respondText("report ${call.parameters["year"]}") }
        route("/customer") {
            get { call.respondText("customers") }
            post { call.respondText("created") }
            route("/{id}") {
                get { call.respondText("customer ${call.parameters["id"]}") }
                put { call.respondText("replaced") }
                patch { call.respondText("updated") }
                delete { call.respondText("deleted") }
            }
        }
        route("/order") {
            route("/shipment") {
                get { call.respondText("shipments") }
                post { call.respondText("shipped") }
            }
        }
        route("/webhook") {
            handle { call.respondText("any method") }
        }
        route("/items/{id}") {
            method(HttpMethod.Put) {
                handle { call.respondText("item") }
            }
        }
        listOrdersRoute()
        getOrderRoute()
        totalizeOrderRoute()
        articleRoutes()
        staticResources("/static", "static")
    }
    // A second `routing` block adds to the same routing tree.
    routing {
        route("/api/v1") {
            customerRouting()
        }
    }
}
