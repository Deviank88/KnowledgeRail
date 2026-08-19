package com.acme.orders.masking

/* Outer comment keeps /* fun fakeNested() { } */ balanced. */
val greeting = "hello $name and ${lookup("fun fakeTemplate() { }")}"
val raw = """
    raw ${format("fun fakeRaw() { }")}
    class FakeRawType { }
""".trimIndent()
val marker = '{'

fun visibleAfterTemplates(): String {
    return greeting + raw + marker
}

fun String.slugify(separator: String = defaultSeparator("-")): String = lowercase().replace(" ", separator)
fun standalone(x: Int) = x * 2
