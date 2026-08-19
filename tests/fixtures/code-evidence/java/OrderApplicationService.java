package com.acme.orders.application;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Coordinates the order aggregate and its transactional ports. */
@Service
public final class OrderApplicationService {
    private final OrderRepository repository;
    private final DomainEventPublisher publisher;
    private final Clock clock;

    @Value("${orders.region:eu-west}")
    private String region;

    public OrderApplicationService(
        OrderRepository repository,
        DomainEventPublisher publisher,
        Clock clock
    ) {
        this.repository = repository;
        this.publisher = publisher;
        this.clock = clock;
    }

    /** Place an order exactly once for a client request identifier. */
    @Transactional
    public Order place(PlaceOrder command) {
        validate(command);
        Optional<Order> existing = repository.findByRequestId(command.requestId());
        if (existing.isPresent()) {
            return existing.get();
        }

        Instant now = clock.instant();
        Order order = Order.place(
            command.requestId(),
            command.customerId(),
            List.copyOf(command.lines()),
            region,
            now
        );
        repository.save(order);
        publish(order);
        return order;
    }

    public Optional<Order> find(String id) {
        if (id == null || id.isBlank()) {
            return Optional.empty();
        }
        return repository.findById(id);
    }

    private void validate(PlaceOrder command) {
        if (command == null) {
            throw new IllegalArgumentException("command is required");
        }
        if (command.lines().isEmpty()) {
            throw new IllegalArgumentException("at least one line is required");
        }
    }

    private void publish(Order order) {
        for (DomainEvent event : order.releaseEvents()) {
            publisher.publish(event);
        }
    }
}

enum OrderState {
    DRAFT,
    PLACED,
    CANCELLED;

    public boolean terminal() {
        return this == CANCELLED;
    }
}
