#pragma once

#include <cstddef>
#include <optional>
#include <string>
#include <unordered_map>

namespace commerce {

struct Reservation {
    std::string sku;
    std::size_t quantity;
};

/** Coordinates inventory reservations for order placement. */
class OrderService {
public:
    explicit OrderService(std::unordered_map<std::string, std::size_t> inventory);

    /// Return the currently available quantity for a SKU.
    std::size_t available(const std::string& sku) const {
        const auto found = inventory_.find(sku);
        if (found == inventory_.end()) {
            return 0;
        }
        return found->second;
    }

    std::optional<Reservation> reserve(const std::string& sku, std::size_t quantity);
    void release(const Reservation& reservation) noexcept;

    explicit operator bool() const {
        return !inventory_.empty();
    }

private:
    bool valid_quantity(std::size_t quantity) const {
        return quantity > 0 && quantity < 10'000;
    }

    std::unordered_map<std::string, std::size_t> inventory_;
};

std::size_t normalize_quantity(std::size_t requested);

}  // namespace commerce
