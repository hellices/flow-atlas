package com.example.app

import io.ktor.server.response.respondText
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route

fun Route.customerRouting() {
    route("/customers") {
        get { call.respondText("customers") }
        get("{id?}") { call.respondText("customer ${call.parameters["id"]}") }
        post { call.respondText("created") }
        delete("{id?}") { call.respondText("deleted") }
    }
}
