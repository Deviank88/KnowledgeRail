#include "order_service.hpp"

#include <algorithm>
#include <utility>

namespace commerce {

OrderService::OrderService(std::unordered_map<std::string, std::size_t> inventory)
    : inventory_(std::move(inventory)) {
}

/** Reserve inventory only when the complete quantity is available. */
std::optional<Reservation> OrderService::reserve(
    const std::string& sku,
    std::size_t quantity
) {
    if (!valid_quantity(quantity)) {
        return std::nullopt;
    }

    auto found = inventory_.find(sku);
    if (found == inventory_.end() || found->second < quantity) {
        return std::nullopt;
    }

    found->second -= quantity;
    return Reservation{sku, quantity};
}

void OrderService::release(const Reservation& reservation) noexcept {
    if (!valid_quantity(reservation.quantity)) {
        return;
    }
    inventory_[reservation.sku] += reservation.quantity;
}

std::size_t normalize_quantity(std::size_t requested) {
    constexpr std::size_t maximum = 100;
    return std::clamp(requested, std::size_t{1}, maximum);
}

}  // namespace commerce
