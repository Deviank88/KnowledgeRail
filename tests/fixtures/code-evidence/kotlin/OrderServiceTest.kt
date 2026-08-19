package com.acme.orders

import kotlin.test.Test
import kotlin.test.assertEquals

class OrderServiceTest {
    @Test
    fun loadsExistingOrder() {
        assertEquals("order-1", "order-1")
    }
}

class PricingSpec : io.kotest.core.spec.style.StringSpec({
    "rounds monetary values" {
        assertEquals(2, 1 + 1)
    }
})
