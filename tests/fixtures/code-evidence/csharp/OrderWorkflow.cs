namespace Acme.Orders.Application;

using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

/// Coordinates validation, persistence, and publication for one order.
public sealed class OrderWorkflow {
    private readonly OrderRepository repository;
    private readonly EventPublisher publisher;

    public OrderWorkflow(OrderRepository repository, EventPublisher publisher) {
        this.repository = repository;
        this.publisher = publisher;
    }

    public string Region { get; init; }

    /// Place an order and publish its domain events atomically.
    public async Task<Order> ExecuteAsync(
        PlaceOrder command,
        CancellationToken cancellationToken
    ) {
        EnsureCommand(command);
        var existing = await repository.FindByRequestAsync(command.RequestId, cancellationToken);
        if (existing is not null) {
            return existing;
        }

        var order = Order.Place(command.CustomerId, command.Lines);
        await repository.SaveAsync(order, cancellationToken);

        foreach (var domainEvent in order.DequeueEvents()) {
            await publisher.PublishAsync(domainEvent, cancellationToken);
        }

        var label = $"{Lookup("priority")}:{order.Id}";
        Audit.Write(label);
        return order;
    }

    private static void EnsureCommand(PlaceOrder command) {
        ArgumentNullException.ThrowIfNull(command);
        if (command.Lines.Count == 0) {
            throw new ArgumentException("At least one line is required", nameof(command));
        }
    }

    private static string Lookup(string key) {
        return key switch {
            "priority" => "normal",
            "region" => "eu-west",
            _ => "unknown",
        };
    }

    public IReadOnlyList<string> Describe(Order order) {
        return new[] {
            $"order:{order.Id}",
            $"region:{Region}",
            $"label:{Lookup("region")}",
        };
    }
}
