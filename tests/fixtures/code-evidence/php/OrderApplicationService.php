<!doctype html>
<html lang="en">
<body data-controller="orders">
    <p>The application service is loaded by the runtime container.</p>
</body>
</html>
<?php
declare(strict_types=1);

namespace App\Orders\Application;

use App\Orders\Domain\Order;
use App\Orders\Domain\PlaceOrder;
use App\Orders\Port\EventPublisher;
use App\Orders\Port\OrderRepository;
use DateTimeImmutable;
use RuntimeException;

/** Coordinates the transactional order-placement use case. */
final readonly class OrderApplicationService
{
    public function __construct(
        private OrderRepository $orders,
        private EventPublisher $events,
    ) {
    }

    /** Persist one order and publish all resulting domain events. */
    public function place(PlaceOrder $command): Order
    {
        $existing = $this->orders->findByRequestId($command->requestId);
        if ($existing !== null) {
            return $existing;
        }

        $order = Order::place(
            $command->requestId,
            $command->customerId,
            $command->lines,
            new DateTimeImmutable(),
        );

        $this->orders->save($order);
        foreach ($order->releaseEvents() as $event) {
            $this->events->publish($event);
        }

        return $order;
    }

    public function describe(Order $order): string
    {
        $region = config('orders.region');
        $message = <<<TEXT
Order {$order->id()} is handled in {$region}.
No function fakeHeredocSymbol() exists here.
TEXT;
        return $message;
    }

    private function requireQueue(): string
    {
        $queue = getenv('ORDERS_QUEUE');
        if ($queue === false || $queue === '') {
            throw new RuntimeException('ORDERS_QUEUE is required');
        }
        return $queue;
    }
}

function normalize_order_reference(string $reference): string
{
    return strtolower(trim($reference));
}
?>
<script>
function fakeTemplateFunction() {
    return "not PHP";
}
</script>
