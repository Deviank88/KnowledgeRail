package com.acme.orders.http

import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing

/** Install deterministic health and order endpoints. */
fun Application.configureRouting() {
    routing {
        get("/health") {
            call.respondText("ok")
        }

        get("/orders/{id}") {
            call.respondText("order")
        }
    }
}
