#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    uint64_t id;
    char sku[32];
    int quantity;
} order_record;

typedef struct {
    order_record *records;
    size_t length;
    size_t capacity;
} order_store;

static int ensure_capacity(order_store *store, size_t required) {
    if (required <= store->capacity) {
        return 0;
    }

    size_t next = store->capacity == 0 ? 16 : store->capacity * 2;
    while (next < required) {
        next *= 2;
    }

    order_record *records = realloc(store->records, next * sizeof(*records));
    if (records == NULL) {
        return -1;
    }

    store->records = records;
    store->capacity = next;
    return 0;
}

/** Initialize an empty in-memory order store. */
int order_store_init(order_store *store) {
    if (store == NULL) {
        return -1;
    }
    memset(store, 0, sizeof(*store));
    return 0;
}

/** Append a record, growing the backing allocation when necessary. */
int order_store_append(order_store *store, const order_record *record) {
    if (store == NULL || record == NULL) {
        return -1;
    }
    if (ensure_capacity(store, store->length + 1) != 0) {
        return -1;
    }

    store->records[store->length++] = *record;
    return 0;
}

const order_record *order_store_find(const order_store *store, uint64_t id) {
    if (store == NULL) {
        return NULL;
    }
    for (size_t index = 0; index < store->length; index++) {
        if (store->records[index].id == id) {
            return &store->records[index];
        }
    }
    return NULL;
}

void order_store_dispose(order_store *store) {
    if (store == NULL) {
        return;
    }
    free(store->records);
    memset(store, 0, sizeof(*store));
}

int order_store_declared_only(const order_store *store);
