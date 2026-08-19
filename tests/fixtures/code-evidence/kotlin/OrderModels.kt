package com.acme.orders.domain

import java.math.BigDecimal
import java.math.RoundingMode

/** Stable identifier carried across service boundaries. */
@JvmInline
value class OrderId(val value: String)

/** Order aggregate stored by the fulfillment service. */
data class Order(val id: OrderId, val subtotal: BigDecimal, val customerId: String)

/** Lifecycle states accepted by the order workflow. */
sealed class OrderState {
    object Draft {
        fun displayName(): String = "Draft"
    }

    data class Accepted(val approvedBy: String)
}

/** Centralized pricing behavior shared by HTTP and batch entry points. */
object PricingRules {
    fun rounded(value: BigDecimal): BigDecimal {
        return value.setScale(2, RoundingMode.HALF_UP)
    }
}

/** Calculate the tax-inclusive total without mutating the aggregate. */
fun Order.totalWithTax(rate: BigDecimal): BigDecimal {
    val tax = subtotal.multiply(rate)
    return PricingRules.rounded(subtotal.add(tax))
}
