package com.example.app

import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.get

fun Route.listOrdersRoute() {
    get("/order") { call.respondText("orders") }
}

fun Route.getOrderRoute() {
    get("/order/{id}") { call.respondText("order ${call.parameters["id"]}") }
}

fun Route.totalizeOrderRoute() {
    get("/order/{id}/total") { call.respondText("total") }
}
