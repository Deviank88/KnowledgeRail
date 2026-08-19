package com.acme.orders.api

import com.acme.orders.domain.Order
import com.acme.orders.domain.OrderId
import org.springframework.beans.factory.annotation.Value
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

interface OrderRepository {
    fun find(id: OrderId): Order?
    fun save(order: Order): Order
}

/** HTTP boundary for order queries and creation. */
@RestController
@RequestMapping("/orders")
class OrderController(
    private val repository: OrderRepository,
    @Value("${orders.region:eu-west-1}") private val region: String,
) {
    companion object {
        const val API_VERSION = "v1"
    }

    val deploymentRegion: String
        get() = region

    /** Load one order for the current tenant. */
    @GetMapping("/{id}")
    fun load(id: String): Order? {
        return repository.find(OrderId(id))
    }

    /** Store a validated order. */
    @PostMapping
    fun create(order: Order): Order {
        return repository.save(order)
    }
}

fun configuredRegion(): String = System.getenv("ORDERS_REGION") ?: "local"
